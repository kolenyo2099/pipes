import { env, pipeline } from '@huggingface/transformers'
import { NLP_MODELS, cacheName, entitiesFromTokens, sentimentTone } from '../backend/nlpShared.js'
import { isKnownNlpTransportWarning } from '../lib/nlpWarnings.js'
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url'

// This worker is only used for NLP. Hugging Face may stream model files without
// Content-Length; Transformers.js handles that correctly but logs a scary warning.
// Filter that exact upstream message while preserving every other warning/error.
const warn = console.warn.bind(console)
console.warn = (...args) => {
  if (!isKnownNlpTransportWarning(args)) warn(...args)
}

// All executable code, including ONNX's WASM loader, ships in the extension.
// A single WASM thread works without cross-origin isolation and avoids remote workers.
env.allowLocalModels = false
env.useBrowserCache = false
env.useFSCache = false
env.useCustomCache = true
env.backends.onnx.wasm.numThreads = 1
env.backends.onnx.wasm.proxy = false
const runtimeBase = new URL('/nlp-runtime/', self.location.href)
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('ort-wasm-simd-threaded.jsep.mjs', runtimeBase).href,
  wasm: wasmUrl,
}
const packForUrl = url => Object.keys(NLP_MODELS).find(pack => String(url).includes(`/${NLP_MODELS[pack].repo}/`))
env.customCache = {
  async match(url) {
    const pack = packForUrl(url)
    return pack ? (await caches.open(cacheName(pack))).match(url) : undefined
  },
  async put(url, response) {
    const pack = packForUrl(url)
    if (!pack) throw new Error('Unexpected NLP model cache URL')
    await (await caches.open(cacheName(pack))).put(url, response)
  },
}

const sessions = new Map()
async function load(pack, download, id) {
  if (!NLP_MODELS[pack]) throw new Error('Unknown NLP model pack')
  if (!sessions.has(pack)) {
    const spec = NLP_MODELS[pack]
    // Transformers requires local-model access to be enabled for cache-only
    // loads. Remote retrieval is enabled only by an explicit install request.
    env.allowLocalModels = !download
    env.allowRemoteModels = download
    const pending = pipeline(spec.task, spec.repo, { revision: spec.revision, dtype: 'q8', device: 'wasm', local_files_only: !download,
      progress_callback: progress => self.postMessage({ id, progress: { pack, ...progress } }),
    }).then(model => { model.tokenizer.model_max_length = 256; return model })
    sessions.set(pack, pending)
    try { await pending } catch (error) { sessions.delete(pack); throw error }
  }
  return sessions.get(pack)
}

async function handle({ id, type, pack, packs = [], text = '' }) {
  if (type === 'install') {
    await load(pack, true, id)
    // The library can swallow cache-quota errors. Do not promise offline
    // availability until every required file was actually cached.
    const spec = NLP_MODELS[pack]
    const cache = await caches.open(cacheName(pack))
    for (const file of ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']) {
      if (!await cache.match(`https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${file}`)) {
        await (await sessions.get(pack)).dispose()
        sessions.delete(pack)
        throw new Error('Model could not be cached. Free browser storage and retry the download.')
      }
    }
    return { installed: true }
  }
  if (type === 'remove' || type === 'unload') {
    if (!NLP_MODELS[pack]) throw new Error('Unknown NLP model pack')
    if (sessions.has(pack)) await (await sessions.get(pack)).dispose()
    sessions.delete(pack)
    if (type === 'remove') await caches.delete(cacheName(pack))
    return { removed: type === 'remove' }
  }
  if (type !== 'enrich') throw new Error('Unknown NLP operation')
  const enrichment = {}, errors = []
  for (const pack of packs) {
    try {
      const model = await load(pack, false, id)
      if (pack === 'ner') {
        const tokens = await model(text)
        const ids = model.tokenizer(text, { padding: true, truncation: true }).input_ids[0].data
        Object.assign(enrichment, entitiesFromTokens(tokens, indices => model.tokenizer.decode(indices.map(index => ids[index]), { skip_special_tokens: true })))
      } else if (pack === 'sentiment') enrichment.tone = sentimentTone(await model(text, { top_k: null }))
    } catch (error) { errors.push(`${pack}: ${error.message || error}`) }
  }
  return { enrichment, errors }
}

// Serialize inference and model changes so disposal cannot race a running model.
let queue = Promise.resolve()
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try { self.postMessage({ id: data.id, result: await handle(data) }) }
    catch (error) { self.postMessage({ id: data.id, error: error.message || String(error) }) }
  })
}
