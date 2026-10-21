import { describe, expect, it } from 'vitest'
import { BUDGETS, budgetStep, budgetUsed, fillHole, openHole } from './collect.js'

const HOUR = 3_600_000
const at = iso => Date.parse(iso)
const post = iso => ({ datetime_utc: iso })

describe('X and Bluesky gaps', () => {
  const start = { since: '2026-09-30T10:00:00.000Z', high: '2026-09-30T10:00:00.000Z', holes: [], quiet: 0 }

  it('opens the stretch since the last run as the newest gap and fills it from the newest end down', () => {
    let cursor = openHole(start, at('2026-09-30T11:05:00.000Z'), HOUR)
    expect(cursor.holes).toEqual([{ from: '2026-09-30T10:00:00.000Z', to: '2026-09-30T11:00:00.000Z', first: true }])
    expect(openHole(cursor, at('2026-09-30T11:30:00.000Z'), HOUR)).toBe(cursor) // not due again before the interval
    cursor = fillHole(cursor, [post('2026-09-30T10:50:00.000Z'), post('2026-09-30T10:20:00.000Z')])
    expect(cursor.holes).toEqual([{ from: '2026-09-30T10:00:00.000Z', to: '2026-09-30T10:20:01.000Z' }]) // ties at 10:20:00 stay in
    // The next run's gap goes ahead of what is left of the older one.
    cursor = openHole(cursor, at('2026-09-30T12:05:00.000Z'), HOUR)
    expect(cursor.holes.map(hole => hole.from)).toEqual(['2026-09-30T11:00:00.000Z', '2026-09-30T10:00:00.000Z'])
    cursor = fillHole(cursor, []) // the new gap was empty
    expect(cursor).toMatchObject({ quiet: 1, holes: [{ from: '2026-09-30T10:00:00.000Z' }] })
    cursor = fillHole(cursor, [post('2026-09-30T10:10:00.000Z')], { done: true }) // a page reached the gap's start
    expect(cursor.holes).toEqual([])
  })

  it('polls a quiet search less often, up to four intervals apart', () => {
    const quiet = { ...start, quiet: 3, polled_at: '2026-09-30T10:00:00.000Z' }
    expect(openHole(quiet, at('2026-09-30T13:00:00.000Z'), HOUR)).toBe(quiet)
    expect(openHole(quiet, at('2026-09-30T14:00:00.000Z'), HOUR).holes).toHaveLength(1)
  })

  it('keeps a feed cursor while a gap is being filled', () => {
    const cursor = { ...start, holes: [{ from: '2026-09-30T10:00:00.000Z', to: '2026-09-30T11:00:00.000Z' }] }
    expect(fillHole(cursor, [post('2026-09-30T10:30:00.000Z')], { next: 'page-2' }).holes[0].next).toBe('page-2')
  })
})

describe('request budgets', () => {
  const x = BUDGETS.x // 20 per 15 minutes, 15 s apart plus up to 10 s of jitter, 400 a day
  const t0 = at('2026-09-30T10:00:00.000Z')

  it('spaces requests out and refills evenly', () => {
    const first = budgetStep(undefined, x, t0, 0)
    expect(first.wait).toBe(0)
    const state = { ...first.next, last: t0 }
    expect(budgetStep(state, x, t0 + 5_000, 0).wait).toBe(10_000)
    expect(budgetStep(state, x, t0 + 5_000, 1).wait).toBe(20_000)
    expect(budgetUsed(state, x, t0)).toBe(1)
    const spent = { tokens: 0, at: t0, day: new Date(t0).toDateString(), used: 20 }
    expect(budgetStep(spent, x, t0, 0).wait).toBe(45_000) // one request every 45 s once the bucket is empty
  })

  it('stops at the daily ceiling and keeps back what the service reports as remaining', () => {
    expect(budgetStep({ day: new Date(t0).toDateString(), used: 400 }, x, t0, 0).wait).toBe(Infinity)
    expect(budgetStep({ server: { remaining: 5, reset: t0 + 60_000 } }, x, t0, 0).wait).toBe(60_000)
    expect(budgetStep({ server: { remaining: 40, reset: t0 + 60_000 } }, x, t0, 0).wait).toBe(0)
  })
})
