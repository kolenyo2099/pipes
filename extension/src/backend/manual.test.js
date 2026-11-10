import { describe, it, expect, vi, beforeEach } from 'vitest'
import { archiveManual, archiveOne, listManualTabs, openForManualCapture, registerManualTab } from './evidenceQueue.js'

let local, session, openTabs
beforeEach(() => {
  local = {}
  session = {}
  openTabs = new Set([7, 8])
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async (key) => ({ [key]: local[key] }), set: async (v) => Object.assign(local, v) },
      session: { get: async (key) => ({ [key]: session[key] }), set: async (v) => Object.assign(session, v) }
    },
    tabs: {
      create: vi.fn(async ({ url }) => ({ id: 9, url })),
      get: async (id) => { if (!openTabs.has(id)) throw new Error('No tab'); return { id, url: 'https://e.com/after-login' } }
    }
  })
})

const ITEM = { id: 'a1', url: 'https://e.com/wall', title: 'Walled', has_text: false }
const MANUAL = { status: 'done', evidence_hash: 'h', evidence_files: [{ name: 'screenshot.png', sha256: 's' }], text: 'page text', issues: [], capture_mode: 'manual' }
function deps(archive = async () => MANUAL) {
  const calls = []
  const bridge = vi.fn(async (action, body) => { calls.push([action, body]); return action === 'lock' ? { ok: true, count: 1 } : { ok: true } })
  return { calls, bridge, archive: vi.fn(archive), team: async () => ({ name: 'Ana' }) }
}

describe('manual capture', () => {
  it('captures the given tab and writes back through lock → updateMany → putText → unlock with capture_mode manual', async () => {
    const d = deps()
    const result = await archiveOne(ITEM, d, { tabId: 7 })
    expect(d.archive).toHaveBeenCalledWith({ id: 'a1', url: 'https://e.com/wall', title: 'Walled', tabId: 7 })
    expect(d.calls.map((c) => c[0])).toEqual(['lock', 'updateMany', 'putText', 'unlock'])
    expect(d.calls[1][1].updates[0]).toMatchObject({ id: 'a1', status: 'done', evidence_hash: 'h', result_metadata: { capture_mode: 'manual' } })
    expect(result.status).toBe('done')
  })

  it('an automatic capture does not pass a tab or claim manual mode', async () => {
    const d = deps(async () => ({ ...MANUAL, capture_mode: undefined }))
    await archiveOne(ITEM, d)
    expect(d.archive).toHaveBeenCalledWith({ id: 'a1', url: 'https://e.com/wall', title: 'Walled' })
    expect(d.calls[1][1].updates[0].result_metadata).not.toHaveProperty('capture_mode')
  })

  it('a failed manual capture still says manual, and unlocks', async () => {
    const d = deps(async () => ({ status: 'failed', error: 'tab closed' }))
    await archiveOne(ITEM, d, { tabId: 7 })
    expect(d.calls[1][1].updates[0]).toMatchObject({ status: 'failed', result_metadata: { error: 'tab closed', capture_mode: 'manual' } })
    expect(d.calls.at(-1)[0]).toBe('unlock')
  })

  it('opens the page in a normal tab and remembers it; the list pairs open tabs with queue items and drops closed ones', async () => {
    expect(await openForManualCapture(ITEM)).toBe(9)
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://e.com/wall', active: true })
    openTabs.add(9)
    await registerManualTab({ tabId: 8, url: 'https://e.com/other', title: 'Other' })
    await registerManualTab({ tabId: 5, url: 'https://e.com/closed' }) // tab 5 is gone
    const listed = await listManualTabs({ pending: [ITEM], review: [], failed: [] })
    expect(listed.map((e) => [e.tabId, e.item?.id ?? null, e.currentUrl])).toEqual([
      [9, 'a1', 'https://e.com/after-login'], [8, null, 'https://e.com/after-login']
    ])
    expect(session.pipelineManualTabs.map((e) => e.tabId)).toEqual([9, 8])
  })

  it('archiveManual forgets the tab after a capture, keeps it after a failure', async () => {
    await registerManualTab({ tabId: 7, url: ITEM.url })
    const failed = await archiveManual({ item: ITEM, tabId: 7 }, deps(async () => ({ status: 'failed', error: 'x' })))
    expect(failed.status).toBe('failed')
    expect(session.pipelineManualTabs).toHaveLength(1)
    await archiveManual({ item: ITEM, tabId: 7 }, deps())
    expect(session.pipelineManualTabs).toEqual([])
  })
})
