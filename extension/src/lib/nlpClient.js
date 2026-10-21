let worker, nextId = 0
const pending = new Map()

function failAll(error) {
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error) }
  pending.clear()
  worker?.terminate()
  worker = null
}

export function requestNlp(message, onProgress = () => {}) {
  if (!worker) {
    worker = new Worker(new URL('../workers/nlpWorker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id)
      if (!task) return
      if (data.progress) { task.onProgress(data.progress); return }
      clearTimeout(task.timer)
      pending.delete(data.id)
      data.error ? task.reject(new Error(data.error)) : task.resolve(data.result)
    }
    worker.onerror = event => failAll(new Error(event.message || 'NLP worker failed'))
  }
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failAll(new Error('NLP worker timed out')), message.type === 'install' ? 30 * 60_000 : 5 * 60_000)
    pending.set(id, { resolve, reject, onProgress, timer })
    worker.postMessage({ ...message, id })
  })
}
