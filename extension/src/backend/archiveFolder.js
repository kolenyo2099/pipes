// Where evidence files are written. Either a folder the user picked (File System Access; the handle is kept in
// IndexedDB, and Chrome may ask again for permission in a new browser session) or, with none picked,
// Downloads/Pipeline through chrome.downloads, which cannot write anywhere else.
import { getSetting, setSetting, deleteSetting } from './db.js'

const KEY = 'archiveFolder'
const RW = { mode: 'readwrite' }

/** { name, granted } for the picked folder, or null when files go to Downloads/Pipeline. */
export async function folderState() {
  const handle = await getSetting(KEY).catch(() => null)
  return handle ? { name: handle.name, granted: (await handle.queryPermission(RW)) === 'granted' } : null
}

/** Must run from a click. Returns the new state, or null when the picker was dismissed. */
export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'pipeline-archive', ...RW }).catch(() => null)
  if (!handle) return null
  await setSetting(KEY, handle)
  return folderState()
}

/** Must run from a click: Chrome asks again for a folder picked in an earlier session. */
export async function grantFolder() {
  const handle = await getSetting(KEY)
  return (await handle.requestPermission(RW)) === 'granted'
}

export const useDownloads = () => deleteSetting(KEY)

/** A writer for one capture: write(blob, [...folders, name]). Throws now if the picked folder is not usable. */
export async function openStore(download) {
  const root = await getSetting(KEY).catch(() => null)
  if (!root) return (blob, path) => download(blob, ['Pipeline', ...path].join('/'))
  // `cancel`: not a capture failure, the item must stay as it was.
  if ((await root.queryPermission(RW)) !== 'granted') throw Object.assign(new Error(`Pipeline may no longer write to the folder "${root.name}": open Archive and press "Allow access"`), { cancel: true })
  return async (blob, path) => {
    let dir = root
    for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true })
    const writable = await (await dir.getFileHandle(path.at(-1), { create: true })).createWritable()
    await writable.write(blob)
    await writable.close()
  }
}
