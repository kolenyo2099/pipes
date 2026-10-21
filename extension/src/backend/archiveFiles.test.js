import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeArchiveFiles } from './archiveFiles.js'

afterEach(() => vi.unstubAllGlobals())

describe('archive download cleanup', () => {
  it('removes only matching archive files created by this extension', async () => {
    const removeFile = vi.fn()
    vi.stubGlobal('chrome', { runtime: { id: 'canary' }, downloads: { removeFile,
      search: vi.fn(async ({ id }) => [{ byExtensionId: id === 3 ? 'other' : 'canary', exists: true, state: 'complete',
        filename: id === 2 ? '/Downloads/other.mhtml' : '/Downloads/Canary/project/archive.mhtml' }]) } })
    await removeArchiveFiles([1, 2, 3].map(download_id => ({ download_id, archive_id: 'archive' })))
    expect(removeFile.mock.calls).toEqual([[1]])
  })
  it('keeps metadata deletion from proceeding silently on file removal failure', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'canary' }, downloads: {
      search: vi.fn(async () => [{ byExtensionId: 'canary', exists: true, filename: '/Downloads/Canary/archive.mhtml' }]),
      removeFile: vi.fn(async () => { throw new Error('File is locked') }),
    } })
    await expect(removeArchiveFiles([{ download_id: 1, archive_id: 'archive' }])).rejects.toThrow('File is locked')
  })
})
