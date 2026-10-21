// Deterministic signed feature hashing for the local similarity map. This is
// intentionally dependency-free: it keeps all text on-device, starts quickly,
// and avoids shipping a second ONNX runtime in the WebView.
const DIMS = 384
const queue = []
let running = false

function hash(text) {
  let value = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function features(text) {
  const normalized = String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const words = normalized ? normalized.split(/\s+/) : []
  const result = [...words]
  for (let i = 0; i + 1 < words.length; i += 1) {
    result.push(`${words[i]}_${words[i + 1]}`)
  }
  const compact = words.join(' ')
  for (let i = 0; i + 2 < compact.length; i += 1) {
    result.push(compact.slice(i, i + 3))
  }
  return result
}

function embedText(text) {
  const vector = new Float32Array(DIMS)
  for (const feature of features(text)) {
    const value = hash(feature)
    const index = value % DIMS
    vector[index] += (value & 0x80000000) === 0 ? 1 : -1
  }
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  }
  return Array.from(vector)
}

async function runJob({ id, texts }) {
  try {
    const vectors = []
    for (let index = 0; index < texts.length; index += 1) {
      if (index % 50 === 0) {
        self.postMessage({
          id,
          type: 'status',
          text: `Computing local similarity features ${index}/${texts.length}`,
        })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      vectors.push(embedText(texts[index]))
    }
    self.postMessage({ id, type: 'done', vecs: vectors })
  } catch (error) {
    self.postMessage({ id, type: 'error', msg: String(error) })
  }
}

async function drain() {
  if (running) return
  running = true
  while (queue.length > 0) await runJob(queue.shift())
  running = false
}

self.addEventListener('message', ({ data }) => {
  queue.push(data)
  drain()
})
