import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../public/outbox.js', import.meta.url), 'utf8')
const TEAM = { url: 'https://script.google.com/macros/s/x/exec', token: 'tok', name: 'Ana' }
const reply = body => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) })
let data, handler, sent, fetch

// Loads outbox.js against a fake chrome; returns a send(message) that goes through the registered onMessage listener.
function load(team = TEAM) {
  data = team ? { pipelineTeam: team } : {}
  sent = []
  const storage = {
    get: async key => ({ [key]: data[key] }),
    set: async values => Object.assign(data, JSON.parse(JSON.stringify(values))),
    remove: async key => { delete data[key] },
  }
  const chrome = {
    storage: { local: storage }, action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    runtime: { onMessage: { addListener: fn => { handler = fn } }, sendMessage: async message => { sent.push(message) } },
  }
  new Function('chrome', 'fetch', src)(chrome, (...args) => fetch(...args))
  return message => new Promise(resolve => handler(message, {}, resolve))
}
const capture = n => ({ kind: 'capture', key: 'k' + n, capture: { url: 'https://e.com/' + n, title: 't', sourceType: 'page', timestamp: 'now' } })
const settle = () => vi.advanceTimersByTimeAsync(60000)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('outbox', () => {
  it('rejects saves until the team is configured', async () => {
    const send = load(null)
    expect(await send({ type: 'pipeline:save', item: capture(1) })).toMatchObject({ ok: false })
  })

  it('batches captures, fills savedBy, and deduplicates by key', async () => {
    fetch = vi.fn(async () => reply(JSON.stringify({ ok: true, results: [{ ok: true, id: 'a' }, { ok: true, id: 'b' }] })))
    const send = load()
    await Promise.all([send({ type: 'pipeline:save', item: capture(1) }), send({ type: 'pipeline:save', item: capture(2) })])
    await settle()
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(fetch.mock.calls[0][1].headers['Content-Type']).toBe('text/plain')
    expect(body).toMatchObject({ token: 'tok', action: 'dataBatch', sheetName: 'Archive' })
    expect(body.items.map(i => i.capture.savedBy)).toEqual(['Ana', 'Ana'])
    expect(JSON.stringify(body)).not.toMatch(/uid|"id"/)
    expect(sent.at(-1).results.map(r => r.ok)).toEqual([true, true])
    expect(await send({ type: 'pipeline:save', item: capture(1) })).toEqual({ ok: true, queued: false })
    expect((await send({ type: 'pipeline:status' })).pending).toBe(0)
  })

  const query = n => ({ kind: 'query', key: 'q' + n, headers: ['Entry ID'], row: ['q' + n] })

  it('sends queries through addQueries', async () => {
    fetch = vi.fn(async () => reply(JSON.stringify({ ok: true, added: 2 })))
    const send = load()
    await Promise.all([send({ type: 'pipeline:save', item: query(1) }), send({ type: 'pipeline:save', item: query(2) })])
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ token: 'tok', action: 'addQueries', headers: ['Entry ID'], rows: [['q1'], ['q2']] })
    expect(await send({ type: 'pipeline:status' })).toMatchObject({ pending: 0, parked: 0 })
  })

  it('falls back to the tab push on a bridge without addQueries, with headers only when the tab is new', async () => {
    let sheets = ['Archive']
    const answer = { addQueries: { ok: false, error: 'Unknown action: addQueries' }, getSheets: { ok: true, get sheets() { return sheets } } }
    fetch = vi.fn(async (_url, init) => reply(JSON.stringify(answer[JSON.parse(init.body).action] || { ok: true })))
    const send = load()
    await send({ type: 'pipeline:save', item: query(1) })
    await settle()
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ token: 'tok', tab: 'Queries', rows: [['Entry ID'], ['q1']] })
    sheets = ['Archive', 'Queries']
    await send({ type: 'pipeline:save', item: query(2) })
    await settle()
    expect(JSON.parse(fetch.mock.calls[3][1].body).rows).toEqual([['q2']])
    expect((await send({ type: 'pipeline:status' })).pending).toBe(0)
  })

  it('reports per-item failures without retrying them', async () => {
    fetch = vi.fn(async () => reply(JSON.stringify({ ok: true, results: [{ ok: true }, { ok: false, error: 'URL is required' }] })))
    const send = load()
    await Promise.all([send({ type: 'pipeline:save', item: capture(1) }), send({ type: 'pipeline:save', item: capture(2) })])
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sent.at(-1).results.map(r => r.ok)).toEqual([true, false])
    expect(await send({ type: 'pipeline:status' })).toMatchObject({ pending: 0, parked: 1 })
  })

  it('handles canary text replies and records results by ref', async () => {
    const replies = ['OK', 'ERROR: boom', 'ERROR: boom', 'ERROR: boom', 'ERROR: boom']
    fetch = vi.fn(async () => reply(replies.shift()))
    const send = load()
    const item = ref => ({ kind: 'canary', ref, headers: ['a'], values: ['1'] })
    await send({ type: 'pipeline:save', item: item('r1') })
    await send({ type: 'pipeline:save', item: item('r2') })
    await settle()
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'tok', headers: ['a'], values: ['1'] })
    // r2 failed 4 times (backoff 2s, 4s, 8s) and then parked.
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(data.pipelineResults.r1).toMatchObject({ ok: true })
    expect(data.pipelineResults.r2).toMatchObject({ ok: false, error: 'ERROR: boom' })
    expect(await send({ type: 'pipeline:status' })).toMatchObject({ pending: 0, parked: 1, lastError: 'ERROR: boom' })
  })

  it('parks immediately on a wrong token and retries when asked', async () => {
    fetch = vi.fn(async () => reply('Unauthorized'))
    const send = load()
    await send({ type: 'pipeline:save', item: { kind: 'canary', ref: 'r', headers: ['a'], values: ['1'] } })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await send({ type: 'pipeline:status' })).toMatchObject({ parked: 1 })
    fetch = vi.fn(async () => reply('OK'))
    await send({ type: 'pipeline:retry' })
    await settle()
    expect(await send({ type: 'pipeline:status' })).toMatchObject({ pending: 0, parked: 0, lastError: '' })
    expect(data.pipelineResults.r.ok).toBe(true)
  })

  it('parks a capture batch after 4 network failures', async () => {
    fetch = vi.fn(async () => { throw new Error('offline') })
    const send = load()
    await send({ type: 'pipeline:save', item: capture(1) })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(await send({ type: 'pipeline:status' })).toMatchObject({ parked: 1, lastError: 'offline' })
  })

  it('delivers to the project that was active when it was saved, in one batch per project', async () => {
    fetch = vi.fn(async (_url, init) => reply(JSON.stringify({ ok: true, results: JSON.parse(init.body).items.map(() => ({ ok: true })) })))
    const send = load()
    const B = { url: 'https://script.google.com/macros/s/b/exec', token: 'tokB', name: 'Ana' }
    await send({ type: 'pipeline:save', item: capture(1) })
    data.pipelineTeam = B // switched before delivery
    await send({ type: 'pipeline:save', item: capture(2) })
    await settle()
    const calls = fetch.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)])
    expect(calls.map(([url, body]) => [url, body.token, body.items.length])).toEqual([[TEAM.url, 'tok', 1], [B.url, 'tokB', 1]])
    expect((await send({ type: 'pipeline:status' })).pending).toBe(0)
  })

  it('sends an unstamped (older) entry to the active team', async () => {
    fetch = vi.fn(async () => reply(JSON.stringify({ ok: true, results: [{ ok: true }] })))
    const send = load()
    data.pipelineOutbox = [{ ...capture(9), uid: 1, retries: 0 }]
    await send({ type: 'pipeline:drain' })
    await settle()
    expect(fetch.mock.calls[0][0]).toBe(TEAM.url)
  })
})
