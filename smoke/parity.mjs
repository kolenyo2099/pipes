// Parity run: capture live pages and media with the built extension and compare with what the HRC desktop app archived.
//   node parity.mjs <archive-root> --out <report-dir> [--pages 25] [--media-per-platform 3] [--only pages|media]
// <archive-root> is read-only (desktop's collections folder). Nothing from it is copied anywhere except the reports
// written to --out; this file holds no URLs or data. Needs ffprobe on PATH for the media section.
// Requests are polite: one page at a time, each URL once per run.
import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const root = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const out = flag('out')
if (!root || !out) { console.error('usage: node parity.mjs <archive-root> --out <report-dir> [--pages 25] [--media-per-platform 3] [--only pages|media]'); process.exit(2) }
fs.mkdirSync(out, { recursive: true })
const PAGES = Number(flag('pages', 25)), PER_PLATFORM = Number(flag('media-per-platform', 3)), ONLY = flag('only', '')
const TIMEOUT_MIN = Number(flag('timeout-min', 90))

// ── reading the desktop archive ──────────────────────────────────────────────
const SOCIAL = /(^|\.)(facebook|instagram|twitter|x|linkedin|tiktok|reddit|t)\.(com|me)$|(^|\.)youtu\.?be(\.com)?$/
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }

function listItems() {
  const items = []
  for (const collection of fs.readdirSync(root)) {
    const cdir = path.join(root, collection)
    if (!fs.statSync(cdir).isDirectory()) continue
    for (const item of fs.readdirSync(cdir)) {
      const dir = path.join(cdir, item)
      if (!fs.statSync(dir).isDirectory()) continue
      const json = fs.readdirSync(dir).find(f => f.endsWith('.json') && f !== 'metadata.json')
      if (!json) continue
      let j
      try { j = JSON.parse(fs.readFileSync(path.join(dir, json), 'utf8')) } catch { continue }
      const files = []
      if (Array.isArray(j.files)) {
        for (const f of j.files) files.push({ name: f.filename, id: f.media_id || '', mime: f.mimetype || '', file: path.join(dir, String(f.sha256).slice(0, 24) + path.extname(f.filename)) })
      } else if (Array.isArray(j.media)) {
        for (const m of j.media) {
          const hash = /SHA-256:([0-9a-f]+)/.exec(m.properties?.hash || '')?.[1]
          if (hash) files.push({ name: path.basename(m.filename), id: m.properties?.id || '', mime: '', file: path.join(dir, hash.slice(0, 24) + path.extname(m.filename)) })
        }
      }
      const meta = j.capture_metadata && typeof j.capture_metadata === 'object' ? j.capture_metadata : {}
      const url = j.url || j.metadata?.url || ''
      items.push({ dir, url, host: hostOf(url), engine: j.extractor || j.metadata?.extractor || '', quality: meta.capture_quality ?? null, issues: (meta.capture_issues || []).map(i => i.code), status: meta.status_code ?? null, files: files.filter(f => fs.existsSync(f.file)), meta })
    }
  }
  return items
}
const isAV = f => /^(video|audio)\//.test(f.mime) || /\.(mp4|webm|mkv|mov|m4v|mp3|m4a)$/i.test(f.name)
const isImage = f => (/^image\/(jpeg|webp|png|gif)/.test(f.mime) || /\.(jpe?g|webp)$/i.test(f.name)) && !/^(screenshot|preview|thumbnail)/.test(f.id) && !/^(screenshot|preview)\./.test(f.name)
const byHash = (a, b) => crypto.createHash('md5').update(a.url).digest('hex').localeCompare(crypto.createHash('md5').update(b.url).digest('hex'))

function pickPages(all) {
  const seen = new Set(), picked = []
  for (const it of all.filter(i => i.engine === 'browser_capture' && i.quality === 'verified' && /^https?:/.test(i.url) && !SOCIAL.test(i.host) && !isOwnHost(i.host)).sort(byHash)) {
    if (seen.has(it.host) || !it.files.some(f => f.id === 'screenshot') || !it.files.some(f => f.id === 'rendered_dom')) continue
    seen.add(it.host); picked.push(it)
    if (picked.length >= PAGES) break
  }
  return picked
}
const isOwnHost = h => /^(localhost|127\.|example\.)/.test(h)
const platformOf = h => /youtu/.test(h) ? 'youtube' : /vimeo/.test(h) ? 'vimeo' : /facebook|fb\./.test(h) ? 'facebook' : /instagram/.test(h) ? 'instagram' : /(^|\.)(x|twitter)\.com$/.test(h) ? 'x' : /tiktok/.test(h) ? 'tiktok' : /dailymotion/.test(h) ? 'dailymotion' : 'news/other'
function pickMedia(all) {
  const count = {}, picked = [], seen = new Set()
  for (const it of all.filter(i => /^https?:/.test(i.url) && i.files.some(isAV)).sort(byHash)) {
    const platform = platformOf(it.host)
    // News/other sites are many different players: sample distinct hosts, more of them.
    const key = platform === 'news/other' ? it.host : platform
    if (seen.has(it.url) || (platform === 'news/other' && seen.has(it.host)) || (count[platform] = (count[platform] || 0) + 1) > (platform === 'news/other' ? PER_PLATFORM * 3 : PER_PLATFORM)) continue
    seen.add(it.url); seen.add(key); picked.push({ ...it, platform })
  }
  return picked
}

// ── measuring files ──────────────────────────────────────────────────────────
const pngSize = file => { const b = fs.readFileSync(file); return b.length > 24 && b.toString('latin1', 1, 4) === 'PNG' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null }
const visibleText = file => fs.readFileSync(file, 'utf8').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length
const pdfInfo = file => { const b = fs.readFileSync(file); return { pages: (b.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length, bytes: b.length } }
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const j = JSON.parse(r.stdout)
  const v = (j.streams || []).find(s => s.codec_type === 'video')
  return { duration: Number(j.format?.duration) || null, width: v?.width || null, height: v?.height || null, audio: (j.streams || []).some(s => s.codec_type === 'audio') }
}
const within = (a, b, tolerance = 0.2) => a != null && b != null && Math.abs(a - b) <= tolerance * Math.max(b, 1)

// ── running the extension ────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url))
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-parity-'))
fs.cpSync(path.join(here, '..', 'extension', 'dist'), dist, { recursive: true })
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'))
manifest.host_permissions.push('<all_urls>')
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-parity-files-'))
process.on('exit', () => { if (flag('keep')) for (const [u, d] of keepRows) fs.cpSync(d, path.join(flag('keep'), hostOf(u)), { recursive: true }); fs.rmSync(scratch, { recursive: true, force: true }) })
const keepRows = []
const PORT = 8788, BRIDGE = `http://127.0.0.1:${PORT}/`

async function captureAll(urls) {
  if (!urls.length) return {}
  const server = spawn('node', [path.join(here, 'fake-bridge.js'), String(PORT)], { stdio: 'ignore' })
  await sleep(500)
  const sheet = async () => (await (await fetch(BRIDGE + '_sheet')).json()).Archive || []
  const rows = async () => { const r = await sheet(); return r.slice(1).map(x => Object.fromEntries(r[0].map((h, i) => [h, x[i]]))) }
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] })
  try {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
    const id = sw.url().split('/')[2]
    await sw.evaluate(u => chrome.storage.local.set({ pipelineTeam: { url: u, token: 'smoke-token', name: 'Parity' } }), BRIDGE)
    for (const u of urls) await sw.evaluate(u => pipelineEnqueue({ kind: 'capture', capture: { url: u, title: u, sourceType: 'page' } }), u)
    for (let i = 0; i < 40 && (await rows()).length < urls.length; i += 1) await sleep(500)
    const app = await context.newPage()
    if (args.includes('--verbose')) app.on('console', m => /\[archive\]/.test(m.text()) && console.error(m.text().slice(0, 240)))
    await app.goto(`chrome-extension://${id}/index.html`)
    await app.waitForTimeout(1500)
    if (await app.getByText('Skip tour').count()) await app.getByText('Skip tour').click()
    await app.getByRole('button', { name: /^.{0,3}Archive$/ }).first().click()
    const all = app.getByRole('button', { name: /Archive all pending/ })
    await all.waitFor()
    await sleep(1000)
    await all.click()
    const end = Date.now() + TIMEOUT_MIN * 60_000
    let done
    while (Date.now() < end) {
      await app.bringToFront().catch(() => {}) // headless: a hidden app page stops running the capture
      done = await rows()
      process.stdout.write(`\r${done.filter(r => r.Status !== 'pending').length}/${urls.length} captured `)
      if (done.length >= urls.length && done.every(r => r.Status !== 'pending')) break
      await sleep(3000)
    }
    console.log()
    // Playwright renames downloads to GUIDs: match them to names by the SHA-256 the sheet recorded.
    const onDisk = await sw.evaluate(() => chrome.downloads.search({}).then(d => d.filter(x => x.exists).map(x => x.filename)))
    const cache = new Map()
    const sha = f => cache.get(f) ?? (cache.set(f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')), cache.get(f))
    const result = {}
    for (const r of done || []) {
      const evidence = JSON.parse(r['Evidence Files'] || '[]')
      const found = {}
      // Playwright deletes its download folder when the context closes: copy what we measure.
      const keep = fs.mkdtempSync(path.join(scratch, 'row-'))
      keepRows.push([r.URL, keep])
      for (const f of onDisk) { const h = sha(f); const hit = evidence.find(e => e.sha256 === h); if (hit) { found[hit.name] = path.join(keep, hit.name); fs.copyFileSync(f, found[hit.name]) } }
      result[r.URL] = { status: r.Status, files: found, meta: JSON.parse(r['Result Metadata'] || '{}'), evidence: JSON.parse(r['Evidence Files'] || '[]') }
    }
    return result
  } finally {
    await context.close()
    server.kill()
  }
}

// ── comparing ────────────────────────────────────────────────────────────────
const lines = []
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s) }
const pad = (v, n) => String(v ?? '-').slice(0, n).padEnd(n)
const report = { pages: [], media: [] }
const all = listItems()
log(`desktop items read: ${all.length}`)
if (args.includes('--dry')) { // selection only, no browser
  log(`pages: ${pickPages(all).length} hosts; media: ${JSON.stringify(Object.entries(pickMedia(all).reduce((c, m) => (c[m.platform] = (c[m.platform] || 0) + 1, c), {})))}`)
  process.exit(0)
}

if (ONLY !== 'media') {
  const hosts = flag('host', '')
  const picked = pickPages(all).filter(i => !hosts || hosts.split(',').includes(i.host))
  log(`\n== PAGES: ${picked.length} distinct hosts ==`)
  const live = await captureAll(picked.map(i => i.url))
  log(pad('host', 28), pad('H desk/ext', 14), pad('W d/e', 11), pad('text d/e', 15), pad('pdf pg d/e', 11), pad('verdict d/e', 20), 'result')
  for (const it of picked) {
    const ext = live[it.url]
    const d = {}
    const df = id => it.files.find(f => f.id === id)?.file
    d.png = df('screenshot') && pngSize(df('screenshot')); d.text = df('rendered_dom') && visibleText(df('rendered_dom')); d.pdf = df('page_pdf') && pdfInfo(df('page_pdf'))
    const e = {}
    if (ext) { e.png = ext.files['screenshot.png'] && pngSize(ext.files['screenshot.png']); e.text = ext.files['dom.html'] && visibleText(ext.files['dom.html']); e.pdf = ext.files['page.pdf'] && pdfInfo(ext.files['page.pdf']) }
    const missing = ['screenshot.png', 'page.pdf', 'snapshot.mhtml', 'network.har', 'dom.html'].filter(n => !ext?.files[n])
    const verdict = ext ? (ext.status === 'done' ? 'verified' : ext.status) : 'not captured'
    const issues = (ext?.meta.capture_issues || []).map(i => i.code)
    const ok = !!ext && within(e.png?.h, d.png?.h) && within(e.text, d.text) && verdict === 'verified' && !missing.length
    const why = []
    if (!within(e.png?.h, d.png?.h)) why.push('height')
    if (!within(e.text, d.text)) why.push('text')
    if (verdict !== 'verified') why.push(`verdict ${verdict} ${issues}`)
    if (missing.length) why.push(`missing ${missing}`)
    log(pad(it.host, 28), pad(`${d.png?.h}/${e.png?.h}`, 14), pad(`${d.png?.w}/${e.png?.w}`, 11), pad(`${d.text}/${e.text}`, 15), pad(`${d.pdf?.pages}/${e.pdf?.pages}`, 11), pad(`verified/${verdict}`, 20), ok ? 'PARITY' : `MISS: ${why.join('; ')}`)
    report.pages.push({ host: it.host, ok, why, desktop: { png: d.png, text: d.text, pdf: d.pdf }, extension: { png: e.png, text: e.text, pdf: e.pdf, verdict, issues, files: Object.keys(ext?.files || {}) } })
  }
  log(`\nPAGES at parity: ${report.pages.filter(p => p.ok).length} / ${report.pages.length}`)
}

if (ONLY !== 'pages') {
  const picked = pickMedia(all)
  log(`\n== MEDIA: ${picked.length} items with desktop audio/video ==`)
  const live = await captureAll(picked.map(i => i.url))
  log(pad('platform', 12), pad('host', 24), pad('video', 6), pad('dur d/e', 14), pad('height d/e', 12), pad('audio d/e', 10), pad('images d/e', 11), 'result')
  for (const it of picked) {
    const ext = live[it.url]
    const dv = it.files.filter(isAV).map(f => ({ f, p: probe(f.file) })).filter(x => x.p).sort((a, b) => (b.p.duration || 0) - (a.p.duration || 0))[0]?.p
    const names = Object.keys(ext?.files || {})
    const ev = names.filter(n => /\.(mp4|webm|mkv|mov|ts|m4v|m4a|mp3|ogg|weba)$/i.test(n) && !/^(screenshot|preview)/.test(n)).map(n => ({ n, p: probe(ext.files[n]) })).filter(x => x.p).sort((a, b) => (b.p.duration || 0) - (a.p.duration || 0))[0]
    const ep = ev?.p
    const dImages = it.files.filter(isImage).length, eImages = names.filter(n => /^media_image_/.test(n)).length
    const hasVideo = !!ep
    const durOk = hasVideo && dv?.duration != null && Math.abs((ep.duration ?? 0) - dv.duration) <= 2
    const heightOk = hasVideo && (ep.height || 0) >= (dv?.height || 0)
    const audioOk = hasVideo && (!dv?.audio || ep.audio)
    const ok = hasVideo && durOk && heightOk && audioOk
    const why = []
    if (!hasVideo) why.push(`no video (${(ext?.meta.capture_issues || []).map(i => i.message).join('; ') || ext?.status || 'not captured'})`.slice(0, 200))
    else { if (!durOk) why.push('duration'); if (!heightOk) why.push('resolution'); if (!audioOk) why.push('audio') }
    log(pad(it.platform, 12), pad(it.host, 24), pad(hasVideo ? 'yes' : 'NO', 6), pad(`${dv?.duration?.toFixed(1)}/${ep?.duration?.toFixed(1)}`, 14), pad(`${dv?.height}/${ep?.height}`, 12), pad(`${dv?.audio}/${ep?.audio}`, 10), pad(`${dImages}/${eImages}`, 11), ok ? 'PARITY' : `MISS: ${why.join('; ')}`)
    report.media.push({ platform: it.platform, host: it.host, ok, why, desktop: { ...dv, images: dImages }, extension: { ...ep, images: eImages, method: (ext?.meta.media || []).map(m => m.method), status: ext?.status } })
  }
  const platforms = [...new Set(report.media.map(m => m.platform))]
  log('\nMEDIA at parity per platform:')
  for (const p of platforms) log(`  ${pad(p, 14)} ${report.media.filter(m => m.platform === p && m.ok).length} / ${report.media.filter(m => m.platform === p).length}`)
  log(`MEDIA at parity: ${report.media.filter(m => m.ok).length} / ${report.media.length}`)
}
fs.writeFileSync(path.join(out, 'parity-report.json'), JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(out, 'parity-report.txt'), lines.join('\n') + '\n')
