import countries from './data/countries.json'
import eventCategories from './data/cameo_event_categories.json'
import actorTypes from './data/cameo_actor_types.json'
import gkgThemes from './data/gkg_themes.json'

export { countries }
export const ontology = { event_categories: eventCategories, actor_types: actorTypes, gkg_themes: gkgThemes, countries }

const map = (from, to) => new Map(countries.filter(c => c[from] && c[to]).map(c => [c[from].toUpperCase(), c[to]]))
export const ISO_TO_CAMEO = map('code', 'cameo')
export const ISO_TO_FIPS = map('code', 'fips')
export const CAMEO_TO_FIPS = map('cameo', 'fips')
export const CAMEO_TO_ISO = map('cameo', 'code')
export const FIPS_TO_ISO = map('fips', 'code')
export const countryName = code => countries.find(c => c.code.toUpperCase() === String(code).toUpperCase())?.name || code

// Resolves a country name or ISO code to FIPS, like desktop's fips_for_bucket.
export function fipsFor(value) {
  const raw = String(value || '').trim()
  if (ISO_TO_FIPS.has(raw.toUpperCase())) return ISO_TO_FIPS.get(raw.toUpperCase()).toUpperCase()
  const needle = raw.replaceAll('-', ' ').toLowerCase()
  const match = countries.find(c => c.fips && c.name.toLowerCase() === needle)
    || countries.find(c => c.fips && c.name.toLowerCase().startsWith(needle))
  return match?.fips.toUpperCase() || null
}

// Stable 64-bit id (two independent 32-bit FNV-1a lanes). Desktop uses a SHA-256 prefix;
// ids only need to be stable within this browser, so a synchronous hash is enough.
export function hash(parts) {
  const text = parts.join('|')
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

// ── GKG theme search (port of routers/ontology.rs) ──────────────────────────
const PREFIXES = [/^WB_\d+_/, /^EPU_CATS_/, /^EPU_POLICY_CAT_/, /^EPU_/, /^TAX_FNCACT_/, /^TAX_ETHNICITY_/, /^TAX_WORLDLANGUAGES_/,
  /^TAX_/, /^CRISISLEX_C\d+_/, /^CRISISLEX_/, /^UNGP_/, /^USPEC_/, /^SOC_/, /^MEDIA_/, /^GENERAL_/, /^WB_/]
export function tagToLabel(tag) {
  let s = tag
  const prefix = PREFIXES.find(p => p.test(s))
  if (prefix) {
    s = s.replace(prefix, '')
    const crisis = tag.match(/^CRISISLEX_C(\d+)_/)
    if (crisis && String(prefix) === String(/^CRISISLEX_C\d+_/)) s = `${s.replace(/_+$/, '')} (C${crisis[1]})`
  }
  s = s.replace(/(\D)\d+$/, '$1').replace(/^_+|_+$/g, '').replaceAll('_', ' ')
  s = s.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ')
  return s || tag
}

let entries
async function themeEntries() {
  entries ||= fetch(new URL('gkg-themes.txt', document.baseURI)).then(r => r.text()).then(text => text.split('\n').filter(Boolean).map(line => {
    const [tag, freq] = line.split('\t')
    const label = tagToLabel(tag.trim())
    return { tag: tag.trim(), label, freq: Number(freq) || 0, tagLower: tag.trim().toLowerCase(), labelLower: label.toLowerCase(), bonus: Math.log10(Math.max(Number(freq) || 0, 1) + 2) }
  }))
  return entries
}

export async function searchThemes(q, limit = 25) {
  const query = q.trim().toLowerCase()
  if (!query) return []
  const scored = []
  for (const e of await themeEntries()) {
    const base = e.tagLower === query ? 10 : e.tagLower.startsWith(query) ? 5 : e.labelLower.startsWith(query) ? 4
      : e.tagLower.includes(`_${query}`) ? 3 : e.labelLower.includes(query) ? 2 : e.tagLower.includes(query) ? 1 : 0
    if (base) scored.push([base + e.bonus, e])
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, Math.min(Math.max(limit, 1), 100)).map(([, e]) => ({ tag: e.tag, label: e.label, freq: e.freq }))
}
