// Offline parity check: our extractSourceDates against what HRC desktop produced for the same saved DOM.
// Data-free: reads a desktop archive root (argument) and writes its report OUTSIDE the repo (second argument).
//   node scripts/parity-offline.mjs ~/.archivekit/collections /path/to/report-dir [/path/to/HRCARchiver]
// For each browser_capture item with a rendered DOM it compares published_at / updated_at / method with
//   (a) the source_dates the desktop recorded in the manifest, when present, and
//   (b) desktop's own utils/source_dates.py re-run over the same DOM (needs uv and the HRC checkout).
// The report names items by hash only, never by URL or title.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { JSDOM } from 'jsdom'
import { createHash } from 'node:crypto'

const [root, out = '.', hrc = '/Users/guillen/Documents/experiments/HRCARchiver'] = process.argv.slice(2)
if (!root) { console.error('usage: parity-offline.mjs <archive-root> [report-dir] [hrc-checkout]'); process.exit(2) }

const dom = new JSDOM('')
for (const k of ['DOMParser', 'Node', 'Element']) globalThis[k] = dom.window[k]
const { extractSourceDates, extractDatesFull } = await import('../src/engine/source-dates.js')

const manifests = []
const walk = (dir, depth = 0) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'manifest.json' && dir.endsWith('chain-of-custody')) manifests.push(p)
    else if (depth < 3 && statSync(p).isDirectory()) walk(p, depth + 1)
  }
}
walk(root)

const items = []
for (const m of manifests) {
  const manifest = JSON.parse(readFileSync(m, 'utf8'))
  if (manifest.extractor !== 'browser_capture') continue
  const entry = manifest.files.find((f) => f.media_id === 'rendered_dom')
  if (!entry) continue
  const item = dirname(dirname(m))
  const candidates = [entry.stored_as && join(item, entry.stored_as), join(item, `${entry.sha256.slice(0, 24)}.html`), join(item, 'chain-of-custody', entry.filename), join(item, entry.filename)].filter(Boolean)
  const path = candidates.find(existsSync)
  if (!path) continue
  items.push({ id: createHash('sha256').update(m).digest('hex').slice(0, 10), path, url: manifest.final_url || manifest.url, recorded: manifest.source_dates?.selected ?? null, card: (() => { const c = manifest.files.find((f) => f.media_id === 'linkedin_job_search'); return c && [join(item, `${c.sha256.slice(0, 24)}.html`), join(item, 'chain-of-custody', c.filename)].find(existsSync) })() })
}

// desktop's extractor over the same DOMs, in one Python process
const py = `
import json, sys, importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('sd', sys.argv[1] + '/engine/src/auto_archiver/utils/source_dates.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
res = {}
for it in json.load(sys.stdin):
    try:
        obs, errs = m.extract(Path(it['path']).read_text(encoding='utf-8', errors='replace'), it['url'])
        s = m.summarize(obs, errs)
        src = lambda kind: next((o['source'] for o in obs if o['kind'] == kind and o['scope'] == 'page' and o.get('normalized') == s['selected'].get(kind)), None)
        res[it['id']] = {'selected': s['selected'], 'disagreements': s['disagreements'], 'published_source': src('published'), 'errors': len(errs)}
    except Exception as e:
        res[it['id']] = {'error': type(e).__name__}
print(json.dumps(res))
`
let desktop = {}
try {
  desktop = JSON.parse(execFileSync('uv', ['run', '--project', join(hrc, 'backend'), 'python', '-c', py, hrc], { input: JSON.stringify(items), maxBuffer: 1 << 28, encoding: 'utf8' }))
} catch (error) {
  console.error('desktop re-run unavailable:', error.message.split('\n')[0])
}

const instant = (s) => {
  if (s == null) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : s + 'Z').getTime()
}
const same = (a, b) => instant(a) === instant(b)
const tally = { items: items.length, compared: 0, published: 0, updated: 0, method: 0, recorded_compared: 0, recorded_match: 0, with_published: 0, all: 0, errors: 0 }
const mismatches = []
for (const it of items) {
  const d = desktop[it.id]
  if (!d || d.error) { tally.errors++; continue }
  const html = readFileSync(it.path, 'utf8')
  const mine = extractSourceDates({ html, url: it.url })
  tally.compared++; tally.with_published += mine.published_at ? 1 : 0
  const pub = same(mine.published_at, d.selected.published ?? null)
  const upd = same(mine.updated_at, d.selected.updated ?? null)
  const meth = mine.published_at == null || mine.method === d.published_source
  tally.published += pub; tally.updated += upd; tally.method += meth; tally.all += pub && upd && meth
  if (it.recorded) {
    tally.recorded_compared++
    // a date desktop took from the saved LinkedIn public job card (a network lookup) is not in the DOM: judge the card file instead
    const fromCard = it.card ? extractDatesFull(readFileSync(it.card, 'utf8'), it.url).selected : {}
    const published = mine.published_at ?? fromCard.published ?? null
    const ok = same(published, it.recorded.published ?? null) && same(mine.updated_at, it.recorded.updated ?? null)
    tally.recorded_match += ok
    if (!ok) mismatches.push({ id: it.id, against: 'recorded', mine: [mine.published_at, mine.updated_at], want: it.recorded })
  }
  if (!(pub && upd && meth)) mismatches.push({ id: it.id, host: (() => { try { return new URL(it.url).hostname } catch { return '' } })(), against: 'desktop-rerun', mine: [mine.published_at, mine.updated_at, mine.method], want: [d.selected.published ?? null, d.selected.updated ?? null, d.published_source], disagreements: d.disagreements })
}
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'parity-report.json'), JSON.stringify({ tally, mismatches }, null, 1))
console.log(JSON.stringify(tally), `mismatches: ${mismatches.length} (details in ${resolve(out, 'parity-report.json')})`)
