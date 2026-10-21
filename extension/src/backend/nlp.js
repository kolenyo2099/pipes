import { getSetting, setSetting } from './db.js'
import { requestNlp } from '../lib/nlpClient.js'
import { NLP_MODELS, NLP_SETTING, detectLanguage, mergeEnrichment } from './nlpShared.js'
const progressChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('canary-nlp')

export async function nlpStatus() {
  const models = await getSetting(NLP_SETTING) || {}
  return { models, ner_present: !!models.ner?.installed, sentiment_present: !!models.sentiment?.installed }
}

async function patchPack(pack, fields) {
  const save = async () => {
    const models = await getSetting(NLP_SETTING) || {}
    await setSetting(NLP_SETTING, { ...models, [pack]: { ...models[pack], ...fields } })
  }
  return navigator.locks ? navigator.locks.request('canary:nlp-settings', save) : save()
}

export async function configureNlp({ type, pack, enabled }) {
  if (!NLP_MODELS[pack]) throw new Error('Unknown NLP model pack')
  if (!['install', 'remove', 'enable'].includes(type)) throw new Error('Unknown NLP operation')
  const work = async () => {
    if (type === 'enable') {
      const status = await nlpStatus()
      if (enabled && !status.models[pack]?.installed) throw new Error('Download this model first')
      await patchPack(pack, { enabled: !!enabled })
      if (!enabled) await requestNlp({ type: 'unload', pack })
    } else if (type === 'remove') {
      await patchPack(pack, { enabled: false })
      await requestNlp({ type, pack })
      await patchPack(pack, { installed: false, error: null })
    } else {
      try {
        await requestNlp({ type, pack }, progress => progressChannel?.postMessage(progress))
        await patchPack(pack, { installed: true, enabled: true, revision: NLP_MODELS[pack].revision, error: null })
      } catch (error) {
        await patchPack(pack, { error: error.message || String(error) })
        throw error
      }
    }
    return nlpStatus()
  }
  return navigator.locks ? navigator.locks.request('canary:nlp-models', work) : work()
}

export async function enrichItems(items, signal) {
  const { models } = await nlpStatus()
  let packs = Object.keys(NLP_MODELS).filter(pack => models[pack]?.installed && models[pack]?.enabled)
  for (const item of items) {
    signal?.throwIfAborted()
    if (packs.length) {
      const current = await nlpStatus()
      packs = packs.filter(pack => current.models[pack]?.installed && current.models[pack]?.enabled)
    }
    const text = [item.title_or_summary, item.snippet_or_context].filter(Boolean).join('. ')
    const enrichment = { language: detectLanguage(text) }
    if (text.trim() && packs.length) {
      try {
        const result = await requestNlp({ type: 'enrich', text, packs })
        Object.assign(enrichment, result.enrichment)
        for (const pack of packs) {
          if (models[pack]?.error && !result.errors.some(error => error.startsWith(`${pack}:`))) {
            await patchPack(pack, { error: null })
            models[pack].error = null
          }
        }
        // Report failures once per batch and keep collecting with the available layers.
        for (const error of result.errors) {
          const pack = error.split(':')[0]
          await patchPack(pack, { error })
          packs = packs.filter(value => value !== pack)
        }
      } catch (error) {
        for (const pack of packs) await patchPack(pack, { error: error.message || String(error) })
        packs = []
      }
    }
    signal?.throwIfAborted()
    item.normalized = mergeEnrichment(item.normalized, enrichment)
  }
  return items
}
