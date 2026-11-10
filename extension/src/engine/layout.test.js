import { describe, it, expect } from 'vitest'
import { expandScrollContainer } from './layout.js'
import { applyVerdict, assessBrowserCapture, hiddenContentReason, verifyArchive } from './quality.js'

describe('hidden content verdict', () => {
  it('needs 200+ hidden characters and more hidden than visible text', () => {
    expect(hiddenContentReason({ hidden: 4000, visible: 100 })).toMatch(/4000 hidden text characters but only 100 visible/)
    for (const m of [null, {}, { hidden: 100, visible: 0 }, { hidden: 200, visible: 200 }, { hidden: 200, visible: 3000 }, { hidden: '4000', visible: 1 }]) {
      expect(hiddenContentReason(m)).toBeNull()
    }
  })

  const page = (visibility) => ({ url: 'https://e.com/a', finalUrl: 'https://e.com/a', statusCode: 200, title: 'Story', domSignals: { text_visibility: visibility } })
  it('raises a hidden_content issue (needs_review) when the text stays hidden', () => {
    const verdict = assessBrowserCapture(page({ hidden: 4000, visible: 100 }))
    expect(verdict.quality).toBe('needs_review')
    expect(verdict.issues.map((i) => i.code)).toEqual(['hidden_content'])
  })

  it('is verified when the text was revealed', () => {
    expect(assessBrowserCapture(page({ hidden: 0, visible: 4000 })).quality).toBe('verified')
  })

  it('a stored hidden_content issue clears on re-audit once the metadata no longer shows hidden text', () => {
    const stored = (metadata) => ({ status: 'browser_capture: success', media: [{ filename: 'screenshot.png', properties: { id: 'screenshot' } }], metadata: {
      status_code: 200, final_url: 'https://e.com/a', title: 'Story', javascript_enabled: true, ...metadata } })
    const issue = { code: 'hidden_content', message: 'page has 4000 hidden text characters but only 100 visible characters' }
    // The old desktop bug: the stored issue was carried forward forever. Here it is derived, so the stored copy is ignored.
    const revealed = stored({ dom_signals: { text_visibility: { hidden: 0, visible: 4000 } }, capture_issues: [issue] })
    expect(verifyArchive(revealed, { url: 'https://e.com/a' })).toEqual([])
    const stillHidden = stored({ dom_signals: { text_visibility: { hidden: 4000, visible: 100 } }, capture_issues: [] })
    expect(verifyArchive(stillHidden, { url: 'https://e.com/a' }).map((i) => i.code)).toEqual(['hidden_content'])
    applyVerdict(revealed.metadata, verifyArchive(revealed, { url: 'https://e.com/a' }))
    expect(revealed.metadata.capture_quality).toBe('verified')
  })

  it('a recorded media failure is an issue; "no media" is not', () => {
    const result = (error) => ({ status: 'x', media: [{ filename: 'screenshot.png', properties: { id: 'screenshot' } }], metadata: { status_code: 200, final_url: 'https://e.com/a', title: 'T', media_extraction_error: error } })
    expect(verifyArchive(result('DASH stream is DRM-protected'), { url: 'https://e.com/a' }).map((i) => i.code)).toEqual(['media_extraction_failed'])
    expect(verifyArchive(result('no media found'), { url: 'https://e.com/a' })).toEqual([])
  })
})

// A stub page: `extra` is how much the panel holds beyond the viewport; setHeight(h) reveals min(extra, h - 900).
function page({ extra, original = 900, fixed = false }) {
  let height = original
  const log = []
  return {
    log,
    opts: {
      originalHeight: original,
      wait: async () => {},
      setHeight: async (h) => { height = h; log.push(h) },
      probe: async () => ({ extra: fixed ? extra : Math.max(0, extra - (height - original)), height: height + (fixed ? extra : Math.max(0, extra - (height - original))) })
    }
  }
}

describe('scroll-container expansion decision', () => {
  it('ignores pages whose panel barely overflows', async () => {
    const p = page({ extra: 80 })
    expect(await expandScrollContainer(p.opts)).toBeNull()
    expect(p.log).toEqual([])
  })

  it('grows the viewport to cover a tall inner panel and keeps it', async () => {
    const p = page({ extra: 2100 })
    expect(await expandScrollContainer(p.opts)).toBe(3002)
    expect(p.log.at(-1)).toBe(3002)
  })

  it('restores the original viewport when growing cannot help (panel taller than the cap)', async () => {
    const p = page({ extra: 60000 })
    expect(await expandScrollContainer({ ...p.opts, max: 30000 })).toBeNull()
    expect(p.log.at(-1)).toBe(900)
  })

  it('restores the viewport and rethrows when a probe fails', async () => {
    const p = page({ extra: 2100 })
    let calls = 0
    const probe = async (...args) => { if (++calls > 1) throw new Error('page gone'); return p.opts.probe(...args) }
    await expect(expandScrollContainer({ ...p.opts, probe })).rejects.toThrow('page gone')
    expect(p.log.at(-1)).toBe(900)
  })
})
