// Persistent worker — survives component mount/unmount so the model stays loaded.
let worker = null
const pending = new Map()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('../workers/embeddingWorker.js', import.meta.url), { type: 'module' })
  // Without this, a worker that fails to load leaves every embed() promise
  // pending forever and the semantic map spins indefinitely.
  worker.addEventListener('error', (event) => {
    const failure = new Error(event.message || 'Embedding worker failed to load')
    for (const [id, entry] of pending) {
      pending.delete(id)
      entry.reject(failure)
    }
    worker = null
  })
  worker.addEventListener('message', ({ data }) => {
    const entry = pending.get(data.id)
    if (!entry) return
    if (data.type === 'status') {
      entry.onStatus?.(data.text)
    } else if (data.type === 'done') {
      pending.delete(data.id)
      entry.resolve(data.vecs)
    } else if (data.type === 'error') {
      pending.delete(data.id)
      entry.reject(new Error(data.msg))
    }
  })
  return worker
}

export function embed(texts, onStatus) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random()}`
    pending.set(id, { resolve, reject, onStatus })
    getWorker().postMessage({ id, texts })
  })
}
