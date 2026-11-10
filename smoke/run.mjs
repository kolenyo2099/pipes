// End-to-end smoke test: real built extension in Chromium + real bridge/Code.gs behind a local HTTP server.
//   cd extension && npm run build && cd ../smoke && npm install && node run.mjs
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const built = path.join(here, '..', 'extension', 'dist')
// Headless Chromium cannot click Chrome's permission prompt, so load a copy with all-sites access already granted.
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-dist-'))
fs.cpSync(built, dist, { recursive: true })
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'))
manifest.host_permissions.push('<all_urls>')
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest))
const shots = process.env.SMOKE_SHOTS  // optional folder for screenshots of each view
const PORT = 8787, BRIDGE = `http://127.0.0.1:${PORT}/`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

const server = spawn('node', [path.join(here, 'fake-bridge.js'), String(PORT)], { stdio: 'inherit' })
process.on('exit', () => server.kill())
await sleep(500)
const sheet = async () => (await fetch(BRIDGE + '_sheet')).json()
const archive = async () => { const rows = (await sheet()).Archive || []; return rows.slice(1).map(r => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))) }
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250) } return null }

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
})
const errors = []
try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
  const id = sw.url().split('/')[2]
  check('service worker starts', !!id, sw.url())
  check('outbox and capture loaded', await sw.evaluate(() => typeof pipelineEnqueue === 'function'))
  const status = () => sw.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ type: 'pipeline:status' }, r)).catch(() => null))
  const swStatus = () => sw.evaluate(async () => {
    const s = await chrome.storage.local.get(['pipelineOutbox', 'pipelineLastError'])
    const q = s.pipelineOutbox || []
    return { pending: q.filter(i => !i.parked).length, parked: q.filter(i => i.parked).length, lastError: s.pipelineLastError || '' }
  })
  const setTeam = token => sw.evaluate(t => chrome.storage.local.set({ pipelineTeam: { url: t.url, token: t.token, name: 'Smoke Tester' } }), { url: BRIDGE, token })

  // Not configured: saves are refused with a clear message.
  const refused = await sw.evaluate(() => pipelineEnqueue({ kind: 'capture', capture: { url: 'https://e.test/x' } }))
  check('save refused without a team', refused.ok === false, refused.error)

  // App page renders without errors.
  const app = await context.newPage()
  app.on('pageerror', e => errors.push('app: ' + e.message))
  await app.goto(`chrome-extension://${id}/index.html`)
  await app.waitForTimeout(1500)
  check('app page renders', (await app.locator('body').innerText()).length > 20)
  // A fresh install (no Canary project yet) must still be able to join a team.
  const skip = app.getByText('Skip tour')
  if (await skip.count()) await skip.click()  // first-run tour covers the page
  await app.getByRole('button', { name: /Team sheet/ }).click()
  const teamCard = await until(async () => (await app.getByRole('heading', { name: 'Team' }).count()) > 0, 4000)
  check('Team card reachable on a fresh install', !!teamCard, teamCard ? '' : (await app.locator('body').innerText()).slice(0, 200).replace(/\s+/g, ' '))
  if (teamCard) {
    await app.getByLabel('Join code').fill(Buffer.from(JSON.stringify({ url: 'https://script.google.com/macros/s/x/exec', token: 't' })).toString('base64url'))
    await app.getByLabel('Your name').fill('UI Tester')
    await app.getByRole('button', { name: 'Save' }).click()
    const saved = await until(() => sw.evaluate(async () => (await chrome.storage.local.get('pipelineTeam')).pipelineTeam?.name === 'UI Tester'))
    check('  join code saves from the Team card', !!saved)
  }

  // Google results page: per-row save and "Save all" through the content script.
  await setTeam('smoke-token')
  const google = await context.newPage()
  google.on('pageerror', e => errors.push('google: ' + e.message))
  await google.route('https://www.google.com/search**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="search">
    ${[1, 2, 3].map(n => `<div class="g"><a href="https://news.test/story-${n}"><h3>Story ${n}</h3></a><div class="VwiC3b">Snippet ${n}</div></div>`).join('')}
  </div></body></html>` }))
  await google.goto('https://www.google.com/search?q=smoke+test')
  const rowButton = await until(async () => (await google.locator('div.g button, div.g [role=button]').count()) > 0, 8000)
  check('content script adds save buttons on Google', !!rowButton)
  if (rowButton) {
    await google.locator('div.g button, div.g [role=button]').first().click()
    const first = await until(async () => (await archive()).length === 1 && (await archive())[0])
    check('per-row save reaches the sheet', !!first, first && `${first.ID} ${first.URL}`)
    if (first) {
      check('  saved by / query / source type', first['Saved By'] === 'Smoke Tester' && first.Query === 'smoke test' && first['Source Type'] === 'google',
        `${first['Saved By']} | ${first.Query} | ${first['Source Type']}`)
      check('  server-assigned id', /^ITEM-\d{4}-\d{5}$/.test(first.ID), first.ID)
    }
    const saveAll = google.getByText(/save all/i).first()
    if (await saveAll.count()) {
      await saveAll.click()
      const all = await until(async () => (await archive()).length === 3)
      check('"Save all" adds the other two, no duplicate', !!all, `${(await archive()).length} rows`)
    } else check('"Save all" control present', false)
  }

  // Canary save path (plain-text bridge reply).
  const canary = await sw.evaluate(() => pipelineEnqueue({ kind: 'canary', ref: 'canary-1',
    headers: ['canary_item_id', 'url', 'title_or_summary', 'source_type', 'goldstein_scale'],
    values: ['canary-1', 'https://gdelt.test/event', 'An event', 'events', -5] }))
  const canaryRow = await until(async () => (await archive()).find(r => r['Canary Item ID'] === 'canary-1'))
  check('canary save reaches the sheet', canary.ok && !!canaryRow, canaryRow && `${canaryRow['Source Type']} extra=${canaryRow.Extra}`)
  const canaryResult = await until(() => sw.evaluate(async () => (await chrome.storage.local.get('pipelineResults')).pipelineResults?.['canary-1']))
  check('  canary result recorded for the app', canaryResult?.ok === true)

  // Bridge down: retries with backoff, then parks; Retry delivers once it is back.
  await fetch(BRIDGE + '_fail', { method: 'POST', body: '{"on":true}' })
  await sw.evaluate(() => pipelineEnqueue({ kind: 'capture', capture: { url: 'https://down.test/1', title: 'While down', sourceType: 'page' } }))
  const parked = await until(async () => (await swStatus()).parked === 1, 30000)
  check('bridge down: parks after retries', !!parked, JSON.stringify(await swStatus()))
  check('  badge shows a count', (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '1')
  await fetch(BRIDGE + '_fail', { method: 'POST', body: '{"on":false}' })
  await sw.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ type: 'pipeline:retry' }, r)).catch(() => null))
  await sw.evaluate(() => retry())
  const recovered = await until(async () => (await archive()).some(r => r.URL === 'https://down.test/1'))
  check('retry delivers after the bridge recovers', !!recovered)
  check('  badge clears', !!(await until(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '')))

  // The product views, against the same sheet: Library, Archive (real capture of a local page), Explore.
  const shot = async name => { if (shots) await app.screenshot({ path: path.join(shots, name + '.png') }) }
  const article = BRIDGE + '_article'
  await sw.evaluate(u => pipelineEnqueue({ kind: 'capture', capture: { url: u, title: 'Smoke article', sourceType: 'page', text: 'Page text sent at save time.' } }), article)
  const saved = await until(async () => (await archive()).find(r => r.URL === article))
  check('page save with text reaches the sheet', !!saved && ((await sheet()).Texts || []).some(r => r[0] === saved.ID && /save time/.test(r[1])), saved && saved.ID)
  await fetch(BRIDGE, { method: 'POST', body: JSON.stringify({ token: 'smoke-token', action: 'putTab', tab: 'pipeline_status', reset: true,
    rows: [['key', 'value'], ['explorer_url', article], ['finished_at', new Date().toISOString()], ['articles_total', '42'], ['ok', 'True']] }) })
  await app.reload()
  await app.waitForTimeout(1500)
  if (await app.getByText('Skip tour').count()) await app.getByText('Skip tour').click()
  await app.getByRole('button', { name: /Library/ }).first().click()
  check('Library lists the team\'s saves', !!(await until(async () => (await app.getByText('Smoke article').count()) > 0 && (await app.getByText('Story 1').count()) > 0, 8000)))
  await shot('library')
  await app.getByRole('button', { name: /^.{0,3}Archive$/ }).first().click()
  const card = app.locator('.card', { hasText: 'Smoke article' })
  check('Archive view lists pending items', !!(await until(async () => (await card.count()) > 0, 8000)))
  await shot('archive')
  if (await card.count()) {
    await card.getByRole('button', { name: 'Archive' }).click()
    const done = await until(async () => { const r = (await archive()).find(r => r.URL === article); return r && r.Status !== 'pending' && r }, 90000)
    check('evidence capture completes', !!done && !!done['Evidence Hash'], done ? `${done.Status} by ${done['Captured By']} · ${done['Result Metadata']}`.slice(0, 300) : 'timed out')
    if (done) {
      const files = JSON.parse(done['Evidence Files'] || '[]').map(f => f.name)
      check('  screenshot, PDF, MHTML, HAR, DOM, hashes, manifest', ['screenshot.png', 'page.pdf', 'snapshot.mhtml', 'network.har', 'dom.html', 'hashes.txt', 'manifest.json'].every(n => files.includes(n)), files.join(', '))
      check('  row unlocked and stamped', !done['Locked By'] && !!done['Captured At'] && !!done['Archived At'])
    }
    await shot('archive-done')
  }
  await app.getByRole('button', { name: /Explore/ }).first().click()
  check('Explore embeds the explorer', !!(await until(async () => (await app.locator(`iframe[src="${article}"]`).count()) > 0, 8000)), (await app.locator('main').innerText()).slice(0, 120).replace(/\s+/g, ' '))
  await shot('explore')
  await app.getByRole('button', { name: /Team searches/ }).first().click()
  await app.waitForTimeout(800)
  await shot('team-searches')

  // Wrong token: parked immediately, no retries.
  await setTeam('wrong')
  await sw.evaluate(() => pipelineEnqueue({ kind: 'capture', capture: { url: 'https://e.test/wrong', sourceType: 'page' } }))
  const wrong = await until(async () => { const s = await swStatus(); return s.parked === 1 && s })
  check('wrong token parks immediately', !!wrong, wrong && wrong.lastError)
  void status
} catch (e) {
  check('smoke run', false, e.stack)
} finally {
  check('no page errors', errors.length === 0, errors.join(' | '))
  await context.close()
  server.kill()
}
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
