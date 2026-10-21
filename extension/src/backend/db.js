// IndexedDB replacement for desktop Canary's SQLite store. Every extension page
// (the app tab and the offscreen collector) shares this one database.
const NAME = 'canary'
const STORES = {
  projects: { keyPath: 'project_id' },
  items: { keyPath: 'item_id', indexes: ['project_id', ['project_status', ['project_id', 'status']]] },
  logs: { keyPath: 'log_id', indexes: ['project_id'] },
  presets: { keyPath: 'preset_id' },
  settings: { keyPath: 'key' },
  // Per-project grouping decisions: source preferences and pinned story primaries.
  meta: { keyPath: 'project_id' },
  archives: { keyPath: 'archive_id', indexes: ['project_id', 'item_id'] },
}

let connection
export function openDb() {
  connection ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1)
    request.onupgradeneeded = () => {
      for (const [name, { keyPath, indexes = [] }] of Object.entries(STORES)) {
        const store = request.result.createObjectStore(name, { keyPath })
        for (const index of indexes) {
          const [name, keyPath] = Array.isArray(index) ? index : [index, index]
          store.createIndex(name, keyPath)
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return connection
}

// Runs `action(store)` in one transaction and resolves with its request's result
// once the transaction commits.
export async function tx(name, mode, action) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode)
    let result
    const request = action(transaction.objectStore(name))
    if (request) request.onsuccess = () => { result = request.result }
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'))
  })
}

export const get = (name, key) => tx(name, 'readonly', s => s.get(key))
export const all = name => tx(name, 'readonly', s => s.getAll())
export const byIndex = (name, index, value) => tx(name, 'readonly', s => s.index(index).getAll(value))
export const put = (name, value) => tx(name, 'readwrite', s => s.put(value))
export const del = (name, key) => tx(name, 'readwrite', s => s.delete(key))
export const putMany = (name, values) => tx(name, 'readwrite', s => { for (const v of values) s.put(v) })
export const delMany = (name, keys) => tx(name, 'readwrite', s => { for (const k of keys) s.delete(k) })

export const projectItems = projectId => byIndex('items', 'project_id', projectId)
export async function getSetting(key) { return (await get('settings', key))?.value }
export const setSetting = (key, value) => put('settings', { key, value })
export const deleteSetting = key => del('settings', key)

export async function getMeta(projectId) {
  return (await get('meta', projectId)) || { project_id: projectId, source_prefs: {}, pinned: {} }
}
export const putMeta = meta => put('meta', meta)
