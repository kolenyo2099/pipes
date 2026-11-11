import { describe, expect, it, vi } from 'vitest'

const settings = {}
vi.mock('./db.js', () => ({ getSetting: async (k) => settings[k], setSetting: async (k, v) => { settings[k] = v }, deleteSetting: async (k) => { delete settings[k] } }))
const { openStore, folderState } = await import('./archiveFolder.js')

// A stand-in for a FileSystemDirectoryHandle that records what was written where.
const fakeDir = (written, permission = 'granted', at = '') => ({
  name: 'Evidence', queryPermission: async () => permission,
  getDirectoryHandle: async (name) => fakeDir(written, permission, `${at}${name}/`),
  getFileHandle: async (name) => ({ createWritable: async () => ({ write: async (blob) => { written[at + name] = blob }, close: async () => {} }) })
})

describe('archive folder', () => {
  it('writes to Downloads/Pipeline through the downloader when no folder is picked', async () => {
    const calls = []
    await (await openStore(async (blob, path) => calls.push(path)))('x', ['Project', 'ITEM-1', 'a.png'])
    expect(calls).toEqual(['Pipeline/Project/ITEM-1/a.png'])
    expect(await folderState()).toBeNull()
  })
  it('writes into the picked folder, creating project and item folders', async () => {
    const written = {}
    settings.archiveFolder = fakeDir(written)
    await (await openStore(() => { throw new Error('must not download') }))('x', ['Project', 'ITEM-1', 'a.png'])
    expect(written).toEqual({ 'Project/ITEM-1/a.png': 'x' })
    expect(await folderState()).toEqual({ name: 'Evidence', granted: true })
  })
  it('refuses to start a capture when Chrome has withdrawn access to the folder', async () => {
    settings.archiveFolder = fakeDir({}, 'prompt')
    await expect(openStore(() => {})).rejects.toThrow(/Allow access/)
  })
})
