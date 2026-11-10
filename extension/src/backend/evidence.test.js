// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildManifest } from './evidence.js'
import { timestampRequest, granted } from '../engine/timestamp.js'
import { sha256Hex } from '../engine/util.js'

describe('evidence manifest', () => {
  const files = [{ name: 'b.txt', sha256: '22', bytes: 2 }, { name: 'a.png', sha256: '11', bytes: 1 }]
  const args = { id: 'x1', url: 'https://e.com', title: 'T', capturedAt: '2026-01-01T00:00:00.000Z', status: 'done', files }

  it('evidence_hash is the SHA-256 of the manifest text, files sorted by name', async () => {
    const m = await buildManifest(args)
    expect(m.sha256).toBe(await sha256Hex(m.text))
    expect(JSON.parse(m.text).files.map(f => f.name)).toEqual(['a.png', 'b.txt'])
  })

  it('is deterministic regardless of file order, and changes when a file hash changes', async () => {
    const a = await buildManifest(args)
    expect((await buildManifest({ ...args, files: [...files].reverse() })).sha256).toBe(a.sha256)
    expect((await buildManifest({ ...args, files: [{ ...files[0], sha256: '99' }, files[1]] })).sha256).not.toBe(a.sha256)
  })
})

describe('RFC 3161', () => {
  it('builds a well-formed SHA-256 request', () => {
    const request = timestampRequest(new Uint8Array(32).fill(7), new Uint8Array(8).fill(0xff))
    expect(request[0]).toBe(0x30)
    expect(request[1]).toBe(request.length - 2)
    expect([...request.slice(2, 5)]).toEqual([0x02, 0x01, 0x01]) // version 1
  })
  it('reads the status of a reply', () => {
    expect(granted(Uint8Array.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x00]))).toBe(true)
    expect(granted(Uint8Array.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02]))).toBe(false)
  })
})

// jsdom has no layout, so innerText is textContent; the function's behaviour does not depend on the difference.
Object.defineProperty(globalThis.HTMLElement?.prototype ?? {}, 'innerText', { configurable: true, get() { return this.textContent } })
describe('page text', () => {
  const load = () => new Function(`${readFileSync('public/capture/page-text.js', 'utf8')}\nreturn pipelinePageText`)()
  const page = html => { document.body.innerHTML = html }
  it('prefers main, then article, then body; collapses whitespace', () => {
    const text = load()
    page('<p>nav</p><main>  Main \n\n text </main><article>art</article>')
    expect(text()).toBe('Main text')
    page('<p>nav</p><article>art  icle</article>')
    expect(text()).toBe('art icle')
    page('<p>just   body</p>')
    expect(text()).toBe('just body')
  })

  it('caps at 90,000 characters', () => {
    page(`<main>${'word '.repeat(40000)}</main>`)
    expect(load()().length).toBe(90000)
  })
})
