import { describe, it, expect, vi, beforeEach } from 'vitest'
import { archiveOne, archiveAll, listQueue, reasonOf, releaseStaleLocks } from './evidenceQueue.js'

let store
beforeEach(() => {
  store = {}
  vi.stubGlobal('chrome', { storage: { local: { get: async key => ({ [key]: store[key] }), set: async values => Object.assign(store, values) } } })
})

const ITEM = { id: 'a1', url: 'https://e.com/x', title: 'T', has_text: false }
const GOOD = { status: 'done', evidence_hash: 'h', evidence_files: [{ name: 'screenshot.png', sha256: 's' }], timestamp_token: 'tok', text: 'body text', issues: [] }

// A fake sheet that records every call; `lockCount` is what `lock` answers.
function deps({ lockCount = 1, archive = async () => GOOD, fail = {} } = {}) {
  const calls = []
  const bridge = vi.fn(async (action, body) => {
    calls.push([action, body])
    if (fail[action]) throw new Error(fail[action])
    return action === 'lock' ? { ok: true, count: lockCount } : { ok: true }
  })
  return { calls, bridge, archive: vi.fn(archive), team: async () => ({ name: 'Ana' }) }
}
const actions = d => d.calls.map(c => c[0])

describe('archive queue', () => {
  it('a capture cancelled by closing its tab writes nothing to the sheet and releases the lock', async () => {
    const d = deps({ archive: async () => ({ status: 'cancelled', error: 'closed' }) })
    expect((await archiveOne(ITEM, d)).status).toBe('cancelled')
    expect(actions(d)).toEqual(['lock', 'unlock'])
  })

  it('locks, captures, writes the evidence, puts the text, then unlocks', async () => {
    const d = deps()
    const result = await archiveOne(ITEM, d)
    expect(result.status).toBe('done')
    expect(actions(d)).toEqual(['lock', 'updateMany', 'putText', 'unlock'])
    const lock = d.calls[0][1]
    expect(lock.ids).toEqual(['a1'])
    expect(lock.locked_by).toMatch(/^install-/)
    const update = d.calls[1][1].updates[0]
    expect(update).toMatchObject({ id: 'a1', status: 'done', evidence_hash: 'h', captured_by: 'Ana', timestamp_token: 'tok' })
    expect(update.evidence_files).toEqual(GOOD.evidence_files)
    expect(update.captured_at).toBeTruthy()
    expect(d.calls[2][1]).toEqual({ id: 'a1', text: 'body text' })
    expect(d.calls[3][1].locked_by).toBe(lock.locked_by)
  })

  it('skips an item somebody else holds (lock count 0)', async () => {
    const d = deps({ lockCount: 0 })
    expect((await archiveOne(ITEM, d)).skipped).toBe(true)
    expect(actions(d)).toEqual(['lock'])
    expect(d.archive).not.toHaveBeenCalled()
  })

  it('does not send text the sheet already has', async () => {
    const d = deps()
    await archiveOne({ ...ITEM, has_text: true }, d)
    expect(actions(d)).toEqual(['lock', 'updateMany', 'unlock'])
  })

  it('records needs_review with its issues', async () => {
    const d = deps({ archive: async () => ({ ...GOOD, status: 'needs_review', issues: [{ code: 'http_404', message: 'Server returned HTTP 404' }], error: 'Server returned HTTP 404' }) })
    await archiveOne(ITEM, d)
    expect(d.calls[1][1].updates[0]).toMatchObject({ status: 'needs_review', evidence_hash: 'h', result_metadata: { error: 'Server returned HTTP 404' } })
  })

  it('records a failed capture without evidence fields, and still unlocks', async () => {
    const d = deps({ archive: async () => ({ status: 'failed', error: 'Navigation failed: net::ERR_NAME_NOT_RESOLVED' }) })
    const result = await archiveOne(ITEM, d)
    expect(result.status).toBe('failed')
    const update = d.calls[1][1].updates[0]
    expect(update.status).toBe('failed')
    expect(update).not.toHaveProperty('evidence_hash')
    expect(actions(d).at(-1)).toBe('unlock')
  })

  it('a throwing archive is recorded as failed and unlocked', async () => {
    const d = deps({ archive: async () => { throw new Error('boom') } })
    const result = await archiveOne(ITEM, d)
    expect(result).toMatchObject({ status: 'failed', error: 'boom' })
    expect(actions(d)).toEqual(['lock', 'updateMany', 'unlock'])
    expect(d.calls[1][1].updates[0]).toMatchObject({ status: 'failed', result_metadata: { error: 'boom' } })
  })

  it('a text upload failure does not undo the capture', async () => {
    const d = deps({ fail: { putText: 'too big' } })
    expect((await archiveOne(ITEM, d)).status).toBe('done')
  })

  it('archiveAll runs one item at a time and honours stop', async () => {
    const d = deps()
    let active = 0, peak = 0, stop = false
    d.archive = vi.fn(async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; stop = true; return GOOD })
    const seen = []
    await archiveAll([ITEM, { ...ITEM, id: 'a2' }, { ...ITEM, id: 'a3' }], { deps: d, shouldStop: () => stop, onItem: (item, r) => r !== 'start' && seen.push(item.id) })
    expect(peak).toBe(1)
    expect(seen).toEqual(['a1'])
  })

  it('lists pending items without evidence, plus review and failed', async () => {
    const items = { pending: [{ id: '1' }, { id: '2', evidence_hash: 'x' }], needs_review: [{ id: '3' }], failed: [{ id: '4' }] }
    const d = { bridge: async (_a, body) => ({ ok: true, items: items[body.status] }) }
    const q = await listQueue(d)
    expect(q.pending.map(i => i.id)).toEqual(['1'])
    expect(q.review).toHaveLength(1)
    expect(q.failed).toHaveLength(1)
  })

  it('releases only this install locks on open', async () => {
    const d = deps()
    await releaseStaleLocks(d)
    expect(d.calls[0][0]).toBe('unlock')
    expect(d.calls[0][1]).toEqual({ locked_by: expect.stringMatching(/^install-/) })
  })

  it('explains a stored reason', () => {
    expect(reasonOf({ result_metadata: { error: 'bad' } })).toBe('bad')
    expect(reasonOf({ result_metadata: { capture_issues: [{ message: 'a' }, { message: 'b' }] } })).toBe('a; b')
    expect(reasonOf({})).toBe('')
  })
})
