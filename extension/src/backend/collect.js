// Port of desktop scheduler.rs. Each lane (events, gkg, rss, mediacloud) runs under a Web Lock, so the
// offscreen collector and an open app tab never process the same lane twice at once.
import { getProject, listProjects, patchProject, itemUpserter, createLog, finishLog, now } from './store.js'
import { getSetting, setSetting, get, putMany } from './db.js'
import { compileQueries, rssWindows, rssUrl, simpleFilterPasses } from './rss.js'
import { fetchForProject, configuredToken } from './mediacloud.js'
import { xQuery, xSearchUrl, xItems, xWindowSearch } from './x.js'
import { BLUESKY_ACCOUNT, blueskySearch, blueskyListFeed, blueskySearches, blueskyItems, blueskyLabel, blueskyRate } from './bluesky.js'
import { telegramChannels, telegramItems, telegramMatches, telegramUrl } from './telegram.js'
import { telegramApiConfigured, telegramApiPage } from './telegram-api.js'
import { decodeEntities } from './gdelt.js'
import { enrichItems } from './nlp.js'

const GDELT = 'https://data.gdeltproject.org/gdeltv2'
const FILES_PER_RUN = 8
const MIN_FRESHNESS_MINUTES = 30
const RSS_SEARCHES_PER_RUN = 120
const RSS_PAUSE_MS = 60 * 60_000
const QUARTER = 900_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('canary')

// ── Parse worker ─────────────────────────────────────────────────────────────
let worker, nextId = 0
const pending = new Map()
function parse(message, buffer) {
  if (!worker) {
    worker = new Worker(new URL('./parseWorker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id)
      pending.delete(data.id)
      data.error ? task?.reject(new Error(data.error)) : task?.resolve(data.items)
    }
    worker.onerror = event => {
      for (const task of pending.values()) task.reject(new Error(event.message || 'Parser worker failed'))
      pending.clear(); worker.terminate(); worker = null
    }
  }
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ ...message, id, buffer }, [buffer])
  })
}

async function download(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal })
  if (response.status === 404) return null // not published yet; retry on the next run
  if (!response.ok) {
    const error = new Error(`${new URL(url).hostname}: HTTP ${response.status}`)
    error.status = response.status
    error.retryAfter = Number(response.headers.get('retry-after')) || 0
    throw error
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > 50_000_000) throw new Error(`${url} exceeds the 50 MB limit`)
  return buffer
}

// ── GDELT file cursors ───────────────────────────────────────────────────────
const stamp = ms => new Date(ms).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const quarterStart = ms => Math.floor(ms / QUARTER) * QUARTER
export function urlTime(url) {
  const s = String(url || '').match(/\/(\d{14})\./)?.[1]
  return s ? Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`) : null
}
// The next FILES_PER_RUN quarter-hour files after the cursor (or from the project start). One file past the
// local clock is included because clocks drift; an unpublished file answers 404 and ends the run.
export function nextFiles(cursorMs, sinceMs, suffix, nowMs = Date.now()) {
  const first = cursorMs != null ? cursorMs + QUARTER : quarterStart(sinceMs)
  const urls = []
  for (let ms = first; ms <= nowMs + QUARTER && urls.length < FILES_PER_RUN; ms += QUARTER) urls.push(`${GDELT}/${stamp(ms)}.${suffix}`)
  return urls
}

// GDELT stamps all rows in a quarter-hour export with the file's quarter-hour
// timestamp. A project created at 12:15:12 must include rows stamped 12:15:00.
// Older extension builds skipped that first file but advanced the cursor, so
// replay it once after upgrading if it is still the current cursor.
export function gdeltFilePlan(project, kind, stream, cursorMs, suffix, nowMs = Date.now()) {
  const sinceMs = Date.parse(project.collecting_since || project.created_at)
  const firstMs = quarterStart(sinceMs)
  const replayField = `initial_window_checked_${kind}_${stream}`
  const replay = !project[replayField] && cursorMs === firstMs && sinceMs > firstMs
  const urls = nextFiles(cursorMs, sinceMs, suffix, nowMs)
  if (replay) urls.unshift(`${GDELT}/${stamp(firstMs)}.${suffix}`)
  return { urls: urls.slice(0, FILES_PER_RUN), start: new Date(firstMs).toISOString(), replayField, firstMs }
}

const STREAMS = {
  events: [
    { stream: 'english', suffix: 'export.CSV.zip', cursor: p => urlTime(p.last_events_url), save: url => ({ last_events_url: url }) },
    { stream: 'translation', suffix: 'translation.export.CSV.zip', cursor: p => urlTime(p.last_events_translation_url), save: url => ({ last_events_translation_url: url }) },
  ],
  gkg: [
    { stream: 'english', suffix: 'gkg.csv.zip', cursor: p => p.last_doc_collected_at && Date.parse(p.last_doc_collected_at), save: url => ({ last_doc_collected_at: new Date(urlTime(url)).toISOString() }) },
    { stream: 'translation', suffix: 'translation.gkg.csv.zip', cursor: p => p.last_doc_translation_collected_at && Date.parse(p.last_doc_translation_collected_at), save: url => ({ last_doc_translation_collected_at: new Date(urlTime(url)).toISOString() }) },
  ],
}

async function collectGdelt(kind, project, log, signal) {
  const upsert = await itemUpserter(project.project_id)
  const errors = [], fresh = []
  for (const { stream, suffix, cursor, save } of STREAMS[kind]) {
    const plan = gdeltFilePlan(project, kind, stream, cursor(project) || null, suffix)
    for (const url of plan.urls) {
      if (signal.aborted) throw new DOMException('Collection stopped', 'AbortError')
      let buffer
      try { buffer = await download(url, signal) } catch (error) {
        if (error.name === 'AbortError') throw error
        errors.push(error.message); break
      }
      if (!buffer) break
      log.checked_count++
      // GDELT stamps rows with their export's quarter-hour time, so use the
      // floored project start while still excluding older exports.
      const items = await parse({ kind, project, start: plan.start, end: new Date(Date.now() + 86_400_000).toISOString(), stream }, buffer)
      fresh.push(...await upsert(items, !!project.sheet_sink))
      log.fetch_count += items.length
      log.new_count = fresh.length
      await patchProject(project.project_id, { ...save(url), ...(urlTime(url) === plan.firstMs ? { [plan.replayField]: true } : {}) })
      await saveLogProgress(log)
    }
  }
  await patchProject(project.project_id, kind === 'events' ? { last_events_collected_at: now() } : { last_doc_polled_at: now() })
  if (kind === 'events' && fresh.length) enrichTitles(fresh)
  return errors.length ? errors.join('; ') : null
}

// Logs are rewritten while a lane runs so the Activity view shows progress.
const saveLogProgress = log => putMany('logs', [log])

// ── Event title enrichment (optional all-sites permission) ───────────────────
const OG = [/<meta\b[^>]*property=["']og:title["'][^>]*content=["'](.*?)["']/i, /<meta\b[^>]*content=["'](.*?)["'][^>]*property=["']og:title["']/i]
export function pageTitle(html) {
  for (const re of OG) { const t = decodeEntities(html.match(re)?.[1] || '').trim(); if (t) return t.slice(0, 300) }
  const t = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 300) : null
}
async function fetchTitle(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' }, credentials: 'omit' })
    if (response.status !== 200 || !response.body) return null
    const reader = response.body.getReader(), chunks = []
    let size = 0
    while (size < 32_768) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length }
    reader.cancel().catch(() => {})
    return pageTitle(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()).slice(0, 32_768))
  } catch { return null }
}
async function enrichTitles(items) {
  if (!await getSetting('title_enrichment')) return
  const byUrl = new Map()
  for (const item of items) if (item.url && /( @ |^\[|^GDELT Event$)/.test(item.title_or_summary)) byUrl.set(item.url, [...(byUrl.get(item.url) || []), item.item_id])
  for (const [url, ids] of [...byUrl].slice(0, 20)) {
    const title = await fetchTitle(url)
    if (!title) continue
    const current = (await Promise.all(ids.map(id => get('items', id)))).filter(Boolean)
    await putMany('items', current.map(item => ({ ...item, title_or_summary: title })))
  }
}

// ── Google News RSS ──────────────────────────────────────────────────────────
// Google News blocks bursts: space searches out, cap each run, and stop without retrying once it pushes back.
const rssGap = () => sleep(2500 + Math.random() * 1500)
async function collectRss(project, log, signal) {
  const pausedUntil = await getSetting('rss_paused_until')
  if (pausedUntil && pausedUntil > now()) return `Google News paused until ${new Date(pausedUntil).toLocaleTimeString()} after it limited requests.`
  const upsert = await itemUpserter(project.project_id)
  const since = project.collecting_since || project.created_at
  const end = now()
  const cursors = { ...project.rss_cursors }
  const rules = project.watchlists.filter(r => r.lane === 'rss' && r.enabled)
    .sort((a, b) => (cursors[a.bucket_name] || since).localeCompare(cursors[b.bucket_name] || since)) // least recently collected first
  let searched = 0, note = null
  plan: for (const rule of rules) {
    const queries = compileQueries(project, rule)
    const start = cursors[rule.bucket_name] || since
    for (const window of rssWindows(start, end)) {
      if (searched + queries.length > RSS_SEARCHES_PER_RUN) { note = `Limited to ${searched} Google News searches to avoid being blocked; the rest continue next run.`; break plan }
      for (const query of queries) {
        if (signal.aborted) throw new DOMException('Collection stopped', 'AbortError')
        if (searched++) await rssGap()
        let buffer
        try { buffer = await download(rssUrl(query.query, query.locale, window.start, window.end), signal) } catch (error) {
          if (error.status !== 429 && error.status !== 503) throw error
          const until = new Date(Date.now() + (error.retryAfter ? error.retryAfter * 1000 : RSS_PAUSE_MS)).toISOString()
          await setSetting('rss_paused_until', until)
          note = `Google News is limiting requests. RSS is paused until ${new Date(until).toLocaleTimeString()}.`
          break plan
        }
        if (!buffer) continue
        log.checked_count++
        const candidates = await parse({ kind: 'rss', project, rule, query, start: window.start, end: window.end, deferSimpleFilter: true }, buffer)
        await enrichItems(candidates, signal)
        const items = candidates.filter(item => simpleFilterPasses(rule.logic, item.title_or_summary,
          [item.snippet_or_context, item.normalized?.description_text].filter(Boolean).join(' '), item.normalized))
        log.fetch_count += items.length
        log.new_count += (await upsert(items, !!project.sheet_sink)).length
        await saveLogProgress(log)
      }
      cursors[rule.bucket_name] = window.end
      await patchProject(project.project_id, { rss_cursors: cursors })
    }
  }
  await patchProject(project.project_id, { last_rss_collected_at: now() })
  return note
}

export async function collectMediaCloud(project, log, signal) {
  const token = await configuredToken()
  if (!token) return 'Configure a Media Cloud API token first'
  const [items, error] = await fetchForProject(project, token, signal)
  signal?.throwIfAborted()
  await enrichItems(items, signal)
  const rules = new Map(project.watchlists.filter(r => r.lane === 'mediacloud' && r.enabled).map(r => [r.bucket_name, r]))
  const accepted = items.filter(item => simpleFilterPasses(rules.get(item.query_bucket)?.logic, item.title_or_summary, '', item.normalized))
  const upsert = await itemUpserter(project.project_id)
  log.checked_count = 1
  log.fetch_count = items.length
  log.new_count = (await upsert(accepted, !!project.sheet_sink)).length
  // Preserve the search window on partial failures so the next run retries it.
  signal?.throwIfAborted()
  if (!error) await patchProject(project.project_id, { last_mediacloud_collected_at: now() })
  return error
}

// ── X and Bluesky ───────────────────────────────────────────────────────────
// Each search keeps a cursor: `high` is how far collection has reached since the rule's start (logic.x_since or
// logic.bluesky_since), and `holes` are the stretches not collected yet, newest first. Each run opens the stretch since
// the last one as the newest hole, and every page goes to the newest hole among the project's searches. So new posts
// never wait behind a backfill, which gets only the pages left over, and busy searches take turns. A hole is filled
// from its newest end down, as scrolling does, until a page brings nothing new.
const INDEX_LAG_MS = 5 * 60_000 // the newest minutes wait for the next run, so posts indexed late are not skipped

// A search whose recent holes came back empty is polled less often, up to 4× the lane's interval.
export function openHole(cursor, nowMs, intervalMs) {
  const backoff = intervalMs * Math.min(2 ** cursor.quiet, 4)
  const end = new Date(nowMs - INDEX_LAG_MS).toISOString()
  if (cursor.polled_at && nowMs - Date.parse(cursor.polled_at) < 0.9 * backoff || cursor.high >= end) return cursor
  return { ...cursor, polled_at: new Date(nowMs).toISOString(), high: end, holes: [{ from: cursor.high, to: end, first: true }, ...cursor.holes] }
}

// Fills the newest hole with one page. `fresh` are the page's posts in the hole not seen earlier this run, `next` is a
// feed's own cursor to the following page, and `done` says the page reached the hole's start. The hole then ends a
// second after its oldest post so far, so posts sharing that second are not skipped; repeats are dropped as seen.
export function fillHole(cursor, fresh, { next, done } = {}) {
  const [hole, ...older] = cursor.holes
  const quiet = hole.first ? (fresh.length ? 0 : cursor.quiet + 1) : cursor.quiet
  if (done || !fresh.length) return { ...cursor, quiet, holes: older }
  const oldest = Math.min(...fresh.map(item => Math.floor(Date.parse(item.datetime_utc) / 1000)))
  return { ...cursor, quiet, holes: [{ from: hole.from, to: new Date((oldest + 1) * 1000).toISOString(), ...(next && { next }) }, ...older] }
}

// One budget per service for this browser's account, shared by every project, so more projects or rules make
// collection slower rather than heavier. It sits well under each service's limit: X's web app allows about 50
// searches per 15 minutes per account, Bluesky 3000 requests per 5 minutes per IP address. `reserve` holds back what
// the service itself reports as remaining, for the user's own use. Users can change `per` in Project Settings.
export const BUDGETS = {
  x: { per: 20, windowMs: 15 * 60_000, gapMs: 15_000, jitterMs: 10_000, daily: 400, reserve: 10 },
  bluesky: { per: 300, windowMs: 5 * 60_000, gapMs: 0, jitterMs: 0, daily: 20_000, reserve: 300 },
  // Telegram publishes no limit for its web preview; this paces like a person paging back, 2.5 to 4 seconds apart.
  telegram: { per: 60, windowMs: 5 * 60_000, gapMs: 2_500, jitterMs: 1_500, daily: 5_000, reserve: 0 },
}
const MAX_WAIT_MS = 90_000 // a longer wait ends the run instead; collection continues next run

// A token bucket refilled evenly over the window.
const tokensAt = (state, budget, nowMs) => Math.min(budget.per, (state.tokens ?? budget.per) + (nowMs - (state.at ?? nowMs)) * budget.per / budget.windowMs)
export const budgetUsed = (state = {}, budget, nowMs) => Math.round(budget.per - tokensAt(state, budget, nowMs))

// The wait before the next request, and the budget after it: a free token, a gap with jitter after the last request,
// the daily ceiling, and the reserve of what the service reports as remaining until it resets.
export function budgetStep(state = {}, budget, nowMs, random = Math.random()) {
  const day = new Date(nowMs).toDateString()
  const used = state.day === day ? state.used : 0
  if (used >= budget.daily) return { wait: Infinity }
  const tokens = tokensAt(state, budget, nowMs)
  const { remaining, reset } = state.server || {}
  const wait = Math.max(0,
    tokens >= 1 ? 0 : (1 - tokens) * budget.windowMs / budget.per,
    (state.last ?? 0) + budget.gapMs + random * budget.jitterMs - nowMs,
    remaining <= budget.reserve && reset > nowMs ? reset - nowMs : 0)
  return { wait, next: { ...state, day, used: used + 1, tokens: Math.min(budget.per, tokens + wait * budget.per / budget.windowMs) - 1, at: nowMs + wait } }
}

// Runs one request under its lane's budget, one at a time across every project and app tab, and records the limit
// the service reported. Returns null instead of waiting long.
function withBudget(lane, request) {
  return navigator.locks.request(`canary:budget:${lane}`, async () => {
    const budget = { ...BUDGETS[lane], per: Number(await getSetting(`${lane}_budget_per`)) || BUDGETS[lane].per }
    const { wait, next } = budgetStep(await getSetting(`${lane}_budget`), budget, Date.now())
    if (wait > MAX_WAIT_MS) return null
    await sleep(wait)
    const result = await request()
    await setSetting(`${lane}_budget`, { ...next, last: Date.now(), server: result.rate || next.server })
    return result
  })
}

// X pages load in a background tab of this browser, signed in as the user (see x.js).
async function xPage(project, rule, { query }, hole) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return { error: 'X collection needs the Canary Chrome extension', stop: true }
  const result = await chrome.runtime.sendMessage({ type: 'x-read', url: xSearchUrl(xWindowSearch(query, hole)) }).catch(error => ({ error: error.message }))
  if (!result?.responses) return { error: result?.error || 'the background collector did not respond', stop: result?.stop, formatChanged: result?.formatChanged }
  const last = result.responses.at(-1)
  const rate = last?.remaining ? { remaining: Number(last.remaining), reset: Number(last.reset) * 1000 } : null
  const failed = result.responses.find(r => r.status !== 200)?.status
  if (failed === 429) return { limited: rate?.reset || true, rate }
  if (failed) return { error: `X answered HTTP ${failed}`, rate }
  try { return { items: xItems(result.responses, project, rule, query), rate } } catch (error) { return { error: error.message, formatChanged: error.formatChanged, rate } }
}

// Bluesky pages come from its API, signed in with the user's app password (see bluesky.js).
async function blueskyPage(project, rule, search, hole) {
  const account = await getSetting(BLUESKY_ACCOUNT)
  if (!account) return { error: 'connect a Bluesky account in the Bluesky rule editor', stop: true }
  try {
    if (search.list) {
      // A list feed has no date filter: it pages back by its own cursor until a page passes the hole's start.
      const { feed = [], cursor } = await blueskyListFeed(account, search.list, hole.next)
      return { items: blueskyItems(feed.filter(entry => !entry.reason).map(entry => entry.post), project, rule, blueskyLabel(search)), next: cursor, done: !cursor, rate: blueskyRate() }
    }
    const { posts = [] } = await blueskySearch(account, { q: search.q, ...(search.author && { author: search.author }), sort: 'latest', since: hole.from, until: hole.to, limit: 100 })
    return { items: blueskyItems(posts, project, rule, blueskyLabel(search)), rate: blueskyRate() }
  } catch (error) {
    if (error.status === 429) return { limited: error.reset || true, rate: blueskyRate() }
    if (error.status === 401) return { error: 'Bluesky rejected the saved account; connect it again in the Bluesky rule editor', stop: true }
    return { error: error.message }
  }
}

// Telegram pages come from a channel's public web preview, without cookies (see telegram.js). Like a Bluesky list, a
// channel has no date filter: it pages back by post number until a page passes the hole's start.
async function telegramPage(project, rule, { channel }, hole) {
  if (await telegramApiConfigured()) return telegramApiPage(project, rule, { channel }, hole)
  let response
  try { response = await fetch(telegramUrl(channel, hole.next), { cache: 'no-store', credentials: 'omit' }) } catch {
    return { error: 'Canary has no access to t.me. Save a Telegram rule again to allow it.', stop: true }
  }
  if (response.status === 429) return { limited: Date.now() + (Number(response.headers.get('retry-after')) || 0) * 1000 }
  if (!response.ok) return { error: `Telegram answered HTTP ${response.status}` }
  // Channels without a public preview, and names that do not exist, redirect to the t.me/<channel> landing page.
  if (!new URL(response.url).pathname.startsWith('/s/')) return { error: `@${channel} has no public web preview` }
  try {
    const { items, next } = telegramItems(await response.text(), project, rule, channel)
    return { items, next, done: !next }
  } catch (error) { return { error: error.message, formatChanged: error.formatChanged } }
}

const SOCIAL = {
  x: { name: 'X', pagesPerRun: 20, page: xPage,
    searches: rule => { const query = xQuery(rule.logic); return query ? [{ key: rule.bucket_name, query }] : [] } },
  // Each Bluesky account or list is its own search with its own cursor (see blueskySearches).
  bluesky: { name: 'Bluesky', pagesPerRun: 100, page: blueskyPage,
    searches: rule => blueskySearches(rule.logic).map(search => ({ ...search, key: [rule.bucket_name, search.author && `@${search.author}`, search.list].filter(Boolean).join(' ') })) },
  // Each channel is its own search. The preview fallback goes back at most 30 days; an API-connected
  // account honours the rule's full start time. Keywords filter after the fetch.
  telegram: { name: 'Telegram', pagesPerRun: 60, page: telegramPage, backfillDays: 30, keep: (rule, item) => telegramMatches(rule.logic, item),
    searches: rule => telegramChannels(rule.logic).map(channel => ({ channel, key: `${rule.bucket_name} @${channel}` })) },
}

// Lanes whose source changed its format, with the error, until a page reads fine again (see CollectorStatus).
export const BROKEN_LANES = 'broken_lanes'

async function collectSocial(lane, project, log, signal) {
  const { name, pagesPerRun, page, searches, backfillDays, keep } = SOCIAL[lane]
  const pausedUntil = await getSetting(`${lane}_paused_until`)
  if (pausedUntil && pausedUntil > now()) return `${name} paused until ${new Date(pausedUntil).toLocaleTimeString()} after it limited requests.`
  const upsert = await itemUpserter(project.project_id)
  const cursors = { ...project[`${lane}_cursors`] }
  const intervalMs = Math.max(project.polling_config[`${lane}_interval_minutes`] || 60, 15) * 60_000
  const errors = [], work = []
  for (const rule of project.watchlists.filter(r => r.lane === lane && r.enabled)) {
    const list = searches(rule)
    if (!list.length) errors.push(`${rule.bucket_name}: no search or accounts`)
    for (const search of list) {
      // Rules saved without a start begin on their first run. A new start date restarts the rule from there.
      const since = rule.logic[`${lane}_since`] || cursors[search.key]?.since || now()
      const floor = backfillDays && !(lane === 'telegram' && await telegramApiConfigured()) ? new Date(Date.now() - backfillDays * 86_400_000).toISOString() : since
      const cursor = cursors[search.key]?.since === since && cursors[search.key].holes ? cursors[search.key] : { since, high: since > floor ? since : floor, holes: [], quiet: 0 }
      cursors[search.key] = openHole(cursor, Date.now(), intervalMs)
      work.push({ rule, search, seen: new Set() })
    }
  }
  for (let pages = 0; pages < pagesPerRun; pages++) {
    if (signal.aborted) throw new DOMException('Collection stopped', 'AbortError')
    const next = work.filter(w => !w.failed && cursors[w.search.key].holes.length)
      .sort((a, b) => cursors[b.search.key].holes[0].to.localeCompare(cursors[a.search.key].holes[0].to))[0]
    if (!next) break
    const { rule, search, seen } = next
    const hole = cursors[search.key].holes[0]
    const result = await withBudget(lane, () => page(project, rule, search, hole))
    if (!result) { errors.push(`${name} budget is used up for now; collection continues next run.`); break }
    if (result.limited) {
      const until = result.limited > Date.now() ? result.limited : Date.now() + BUDGETS[lane].windowMs
      await setSetting(`${lane}_paused_until`, new Date(until).toISOString())
      errors.push(`${name} is limiting requests; the ${name} lane waits until ${new Date(until).toLocaleTimeString()}.`)
      break
    }
    if (result.error) {
      errors.push(`${rule.bucket_name}: ${result.error}`)
      // The message names only the lane and what changed, never the rule or its search; it is what the user can report.
      if (result.formatChanged) { await setSetting(BROKEN_LANES, { ...await getSetting(BROKEN_LANES), [lane]: { error: result.error, at: now() } }); break }
      if (result.stop) break
      next.failed = true // tried again next run
      continue
    }
    log.checked_count++
    const fresh = result.items.filter(item => item.datetime_utc >= hole.from && !seen.has(item.item_id))
    for (const item of fresh) seen.add(item.item_id)
    const done = result.done || result.items.some(item => item.datetime_utc < hole.from)
    cursors[search.key] = fillHole(cursors[search.key], fresh, { next: result.next, done })
    const kept = keep ? fresh.filter(item => keep(rule, item)) : fresh
    await enrichItems(kept, signal)
    log.fetch_count += kept.length
    log.new_count += (await upsert(kept, !!project.sheet_sink)).length
    await patchProject(project.project_id, { [`${lane}_cursors`]: cursors })
    await saveLogProgress(log)
  }
  await patchProject(project.project_id, { [`${lane}_cursors`]: cursors, [`last_${lane}_collected_at`]: now() })
  const broken = await getSetting(BROKEN_LANES)
  if (log.checked_count && broken?.[lane]) { delete broken[lane]; await setSetting(BROKEN_LANES, broken) } // read fine again
  return errors.length ? errors.join('; ') : null
}

// ── Runs ─────────────────────────────────────────────────────────────────────
const LANES = { events: p => collectGdelt('events', ...p), gkg: p => collectGdelt('gkg', ...p), rss: p => collectRss(...p), mediacloud: p => collectMediaCloud(...p),
  x: p => collectSocial('x', ...p), bluesky: p => collectSocial('bluesky', ...p), telegram: p => collectSocial('telegram', ...p) }
const running = new Map() // log_id → AbortController, for runs in this context

channel?.addEventListener('message', ({ data }) => { if (data?.type === 'cancel') running.get(data.logId)?.abort() })

// Runs one lane unless it is already running anywhere. Resolves when it finishes.
function runLane(projectId, lane) {
  const work = async () => {
    const project = await getProject(projectId)
    if (!project) return
    const log = await createLog(projectId, lane)
    const controller = new AbortController()
    running.set(log.log_id, controller)
    channel?.postMessage({ type: 'changed', projectId })
    try {
      const error = await LANES[lane]([project, log, controller.signal])
      await finishLog(log, { error })
    } catch (error) {
      await finishLog(log, { error: error.name === 'AbortError' ? 'Cancelled by user' : error.message || String(error) })
    } finally {
      running.delete(log.log_id)
      channel?.postMessage({ type: 'changed', projectId })
    }
  }
  return navigator.locks
    ? navigator.locks.request(`canary:${projectId}:${lane}`, { ifAvailable: true }, lock => lock && work())
    : work()
}

const enabledLanes = p => [['events', p.events_enabled], ['gkg', p.doc_enabled], ['rss', p.rss_enabled], ['mediacloud', p.mediacloud_enabled], ['x', p.x_enabled],
  ['bluesky', p.bluesky_enabled], ['telegram', p.telegram_enabled]]
  .filter(([, on]) => on).map(([lane]) => lane)

// "Run now": every enabled lane. Returns false when the project is paused or has no enabled lane.
export async function runProjectNow(projectId) {
  const project = await getProject(projectId)
  if (!project || project.polling_config.paused) return false
  const lanes = enabledLanes(project.polling_config)
  for (const lane of lanes) runLane(projectId, lane)
  return lanes.length > 0
}

// Scheduler tick: start lanes whose interval elapsed or whose GDELT cursor is behind.
export async function collectDue(nowMs = Date.now()) {
  for (const project of await listProjects()) {
    const pc = project.polling_config
    if (pc.paused) continue
    const since = Date.parse(project.collecting_since || project.created_at)
    const elapsed = (last, minutes) => !last || nowMs - Date.parse(last) >= minutes * 60_000
    const behind = (lane, minutes) => STREAMS[lane].some(s => nowMs - (s.cursor(project) || since) > Math.max(minutes, MIN_FRESHNESS_MINUTES) * 60_000)
    const due = {
      events: pc.events_enabled && (behind('events', pc.events_interval_minutes) || elapsed(project.last_events_collected_at, pc.events_interval_minutes)),
      gkg: pc.doc_enabled && (behind('gkg', pc.doc_interval_minutes) || elapsed(project.last_doc_polled_at, pc.doc_interval_minutes)),
      rss: pc.rss_enabled && elapsed(project.last_rss_collected_at, pc.rss_interval_minutes),
      mediacloud: pc.mediacloud_enabled && elapsed(project.last_mediacloud_collected_at, pc.mediacloud_interval_minutes),
      x: pc.x_enabled && elapsed(project.last_x_collected_at, Math.max(pc.x_interval_minutes, 15)),
      bluesky: pc.bluesky_enabled && elapsed(project.last_bluesky_collected_at, Math.max(pc.bluesky_interval_minutes, 15)),
      telegram: pc.telegram_enabled && elapsed(project.last_telegram_collected_at, Math.max(pc.telegram_interval_minutes, 15)),
    }
    for (const [lane, go] of Object.entries(due)) if (go) runLane(project.project_id, lane)
  }
}
