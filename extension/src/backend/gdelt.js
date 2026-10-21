// Ports of desktop fetchers/events.rs, fetchers/gkg.rs and normalize.rs. Runs inside the parse worker.
import { ISO_TO_CAMEO, ISO_TO_FIPS, CAMEO_TO_FIPS, CAMEO_TO_ISO, FIPS_TO_ISO, fipsFor, hash } from './ontology.js'

export const EVENT_COLUMNS = ['GLOBALEVENTID', 'SQLDATE', 'MonthYear', 'Year', 'FractionDate', 'Actor1Code', 'Actor1Name',
  'Actor1CountryCode', 'Actor1KnownGroupCode', 'Actor1EthnicCode', 'Actor1Religion1Code', 'Actor1Religion2Code', 'Actor1Type1Code',
  'Actor1Type2Code', 'Actor1Type3Code', 'Actor2Code', 'Actor2Name', 'Actor2CountryCode', 'Actor2KnownGroupCode', 'Actor2EthnicCode',
  'Actor2Religion1Code', 'Actor2Religion2Code', 'Actor2Type1Code', 'Actor2Type2Code', 'Actor2Type3Code', 'IsRootEvent', 'EventCode',
  'EventBaseCode', 'EventRootCode', 'QuadClass', 'GoldsteinScale', 'NumMentions', 'NumSources', 'NumArticles', 'AvgTone',
  'Actor1Geo_Type', 'Actor1Geo_FullName', 'Actor1Geo_CountryCode', 'Actor1Geo_ADM1Code', 'Actor1Geo_ADM2Code', 'Actor1Geo_Lat',
  'Actor1Geo_Long', 'Actor1Geo_FeatureID', 'Actor2Geo_Type', 'Actor2Geo_FullName', 'Actor2Geo_CountryCode', 'Actor2Geo_ADM1Code',
  'Actor2Geo_ADM2Code', 'Actor2Geo_Lat', 'Actor2Geo_Long', 'Actor2Geo_FeatureID', 'ActionGeo_Type', 'ActionGeo_FullName',
  'ActionGeo_CountryCode', 'ActionGeo_ADM1Code', 'ActionGeo_ADM2Code', 'ActionGeo_Lat', 'ActionGeo_Long', 'ActionGeo_FeatureID',
  'DATEADDED', 'SOURCEURL']
const G = { DATE: 1, DOMAIN: 3, URL: 4, COUNTS: 6, THEMES: 7, ENHANCED_THEMES: 8, LOCATIONS: 9, ENHANCED_LOCATIONS: 10,
  PERSONS: 12, ORGANIZATIONS: 14, TONE: 15, SHARING_IMAGE: 18, TRANSLATION: 25, EXTRAS: 26 }

const strings = (logic, key) => Array.isArray(logic?.[key]) ? logic[key].map(v => String(v).trim()).filter(Boolean) : []
const blank = s => !s || /^(nan|none)$/i.test(s)
const safeStr = s => { const v = String(s ?? '').trim(); return !v || v === 'nan' || v === 'None' || v === 'NaN' ? null : v }
const safeFloat = s => { const v = Number.parseFloat(s); return Number.isFinite(v) ? v : null }
const safeInt = s => { const v = Number.parseInt(s, 10); return Number.isFinite(v) ? v : null }
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export const decodeEntities = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] !== '#' ? entities[e.toLowerCase()] ?? m
  : String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))))

export function gdeltDate(dateadded, sqldate = '') {
  if (/^\d{14}$/.test(dateadded || '')) {
    const d = dateadded
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}Z`
  }
  if (/^\d{8}$/.test(sqldate || '')) return `${sqldate.slice(0, 4)}-${sqldate.slice(4, 6)}-${sqldate.slice(6, 8)}T00:00:00Z`
  return null
}

// ── Events ───────────────────────────────────────────────────────────────────
export function eventRuleMatches(row, rule, actorCodes, geoCodes) {
  const logic = rule.logic || {}
  const up = key => String(row[key] || '').trim().toUpperCase()
  const a1 = up('Actor1CountryCode'), a2 = up('Actor2CountryCode'), action = up('ActionGeo_CountryCode')
  const actorMatch = (!blank(a1) && actorCodes.has(a1)) || (!blank(a2) && actorCodes.has(a2))
  const geoMatch = !blank(action) && geoCodes.has(action)
  if (!actorMatch && !geoMatch) return false

  let required = strings(logic, 'required_actor_countries').map(s => s.toUpperCase())
  if (!required.length && logic.require_us_actor === true) required = ['USA']
  const mode = logic.required_countries_mode || 'actor'
  const actors = new Set([a1, a2].filter(s => !blank(s)))
  const geos = new Set(['ActionGeo_CountryCode', 'Actor1Geo_CountryCode', 'Actor2Geo_CountryCode'].map(up).filter(s => !blank(s)))
  for (const cameo of required) {
    const byActor = (mode === 'actor' || mode === 'any') && actors.has(cameo)
    const fips = CAMEO_TO_FIPS.get(cameo)
    const byGeo = (mode === 'geo' || mode === 'any') && fips && geos.has(fips)
    if (!byActor && !byGeo) return false
  }

  const prefixes = strings(logic, 'event_code_prefix')
  const code = String(row.EventCode || '').trim()
  if (prefixes.length && !prefixes.some(p => code.startsWith(p))) return false

  const types = new Set(strings(logic, 'actor_type_filter').map(s => s.toUpperCase()))
  if (types.size) {
    const present = ['Actor1Type1Code', 'Actor1Type2Code', 'Actor1Type3Code', 'Actor2Type1Code', 'Actor2Type2Code', 'Actor2Type3Code'].map(up)
    if (!present.some(t => !blank(t) && types.has(t))) return false
  }
  return true
}

function codeToIso(code) {
  if (code.length === 3) return CAMEO_TO_ISO.get(code)?.toLowerCase() || null
  if (code.length === 2) return (FIPS_TO_ISO.get(code) || code).toLowerCase()
  return null
}

function eventTitle(actor1, actor2, code, geo) {
  const parts = [actor1, code && `[${code}]`, actor2, geo && `@ ${geo}`].filter(Boolean)
  return parts.length ? parts.join(' ') : 'GDELT Event'
}

const QUAD = { 1: 'Verbal Cooperation', 2: 'Material Cooperation', 3: 'Verbal Conflict', 4: 'Material Conflict' }

export function normalizeEvent(row, projectId, bucket, stream) {
  const s = key => safeStr(row[key])
  const countries = []
  for (const key of ['Actor1CountryCode', 'Actor2CountryCode', 'ActionGeo_CountryCode', 'Actor1Geo_CountryCode', 'Actor2Geo_CountryCode']) {
    const iso = s(key) && codeToIso(s(key))
    if (iso && !countries.includes(iso)) countries.push(iso)
  }
  const root = safeInt(row.IsRootEvent)
  return {
    item_id: hash([projectId, 'events', row.GLOBALEVENTID]),
    project_id: projectId,
    source_type: 'events',
    gdelt_primary_id: row.GLOBALEVENTID,
    datetime_utc: gdeltDate(row.DATEADDED, row.SQLDATE),
    countries_focus: countries,
    query_bucket: bucket,
    title_or_summary: eventTitle(s('Actor1Name') || s('Actor1CountryCode'), s('Actor2Name') || s('Actor2CountryCode'), s('EventCode'), s('ActionGeo_FullName')),
    url: s('SOURCEURL'),
    snippet_or_context: null,
    normalized: {
      actor1_code: s('Actor1Code'), actor1_name: s('Actor1Name'), actor1_country: s('Actor1CountryCode'), actor1_type1: s('Actor1Type1Code'),
      actor2_code: s('Actor2Code'), actor2_name: s('Actor2Name'), actor2_country: s('Actor2CountryCode'), actor2_type1: s('Actor2Type1Code'),
      event_code: s('EventCode'), event_base_code: s('EventBaseCode'), event_root_code: s('EventRootCode'),
      quad_class: s('QuadClass'), quad_class_label: QUAD[row.QuadClass] || '',
      goldstein_scale: safeFloat(row.GoldsteinScale), avg_tone: safeFloat(row.AvgTone),
      num_mentions: safeInt(row.NumMentions), num_sources: safeInt(row.NumSources),
      action_geo_fullname: s('ActionGeo_FullName'), action_geo_country: s('ActionGeo_CountryCode'),
      action_geo_lat: safeFloat(row.ActionGeo_Lat), action_geo_long: safeFloat(row.ActionGeo_Long),
      is_root_event: root === null ? null : root !== 0, sqldate: s('SQLDATE'), dateadded: s('DATEADDED'),
      source_stream: stream,
    },
    gdelt_raw: { ...row },
  }
}

export function codeSets(isoCodes) {
  const actor = new Set(), geo = new Set()
  for (const code of isoCodes) {
    const iso = String(code).toUpperCase()
    actor.add((ISO_TO_CAMEO.get(iso) || iso).toUpperCase())
    geo.add((ISO_TO_FIPS.get(iso) || iso).toUpperCase())
  }
  return { actor, geo }
}

// Parses an Events CSV and returns normalized items for rows inside [start, end).
export function eventItems(text, project, start, end, stream) {
  const rules = project.watchlists.filter(r => r.lane === 'events' && r.enabled)
  if (!rules.length) return []
  const { actor, geo } = codeSets(project.countries_focus)
  const items = [], seen = new Set()
  for (const line of text.split('\n')) {
    const cols = line.split('\t')
    if (cols.length < EVENT_COLUMNS.length) continue
    const row = Object.fromEntries(EVENT_COLUMNS.map((name, i) => [name, cols[i].trim()]))
    const date = gdeltDate(row.DATEADDED, row.SQLDATE)
    if (!inWindow(date, start, end)) continue
    for (const rule of rules) {
      const key = `${row.GLOBALEVENTID}|${rule.bucket_name}`
      if (seen.has(key) || !eventRuleMatches(row, rule, actor, geo)) continue
      seen.add(key)
      items.push(normalizeEvent(row, project.project_id, rule.bucket_name, stream))
    }
  }
  return items
}

export function inWindow(date, start, end) {
  const ms = Date.parse(date)
  return Number.isFinite(ms) && ms >= Date.parse(start) && ms < Date.parse(end)
}

// ── GKG ──────────────────────────────────────────────────────────────────────
function mentionsFips(locations, fips) {
  return !!locations && !!fips && locations.split(';').some(e => (e.split('#')[2] || '').trim().toUpperCase() === fips)
}
function countriesOk(locations, names, mode) {
  const codes = names.map(fipsFor)
  if (codes.some(c => !c)) return false // an unresolvable country means the rule cannot match, as on desktop
  if (!codes.length) return true
  return mode === 'any' ? codes.some(c => mentionsFips(locations, c)) : codes.every(c => mentionsFips(locations, c))
}
const namesOk = (field, wanted) => !wanted.length || (!!field && wanted.some(n => field.toLowerCase().includes(n)))

export function gkgRuleMatches(row, rule) {
  const logic = rule.logic || {}
  const get = i => (row[i] || '').trim()
  if (!countriesOk(get(G.LOCATIONS), strings(logic, 'required_countries'), logic.required_countries_mode || 'all')) return false
  if (!countriesOk(get(G.LOCATIONS), strings(logic, 'also_countries'), logic.also_countries_mode || 'all')) return false
  const themes = strings(logic, 'themes').length ? strings(logic, 'themes') : strings(logic._builder_state, 'themes')
  if (themes.length) {
    const present = new Set([...get(G.THEMES).split(';'), ...get(G.ENHANCED_THEMES).split(';').map(e => e.split(',')[0])].map(t => t.trim()).filter(Boolean))
    if (!themes.some(t => present.has(t))) return false
  }
  // Desktop lower-cases rule names on load and compares against the lower-cased field.
  if (!namesOk(get(G.PERSONS), strings(logic, 'persons').map(s => s.toLowerCase()))) return false
  if (!namesOk(get(G.ORGANIZATIONS), strings(logic, 'organizations').map(s => s.toLowerCase()))) return false
  const adm1 = strings(logic, 'adm1_codes').map(s => s.toUpperCase())
  if (adm1.length && !adm1.some(code => get(G.ENHANCED_LOCATIONS).split(';').some(e => (e.split('#')[3] || '').trim().toUpperCase() === code))) return false
  return true
}

function parseTone(s) {
  if (!s) return null
  const f = s.split(',').map(p => { const v = Number.parseFloat(p); return Number.isFinite(v) ? v : null })
  if (f.length < 6) return null
  return { tone: f[0], pos: f[1], neg: f[2], polarity: f[3], activity: f[4], word_count: f[6] == null ? null : Math.trunc(f[6]) }
}
function parseCounts(s) {
  return s ? s.split(';').filter(Boolean).flatMap(block => {
    const [type, count, object] = block.split('#')
    const n = Number.parseInt(count, 10)
    return type?.trim() && Number.isFinite(n) ? [{ type: type.trim(), count: n, object: object?.trim() || null }] : []
  }) : []
}
export function parseNames(s) {
  return [...new Set((s || '').split(';').filter(Boolean).map(e => e.lastIndexOf(',') >= 0 ? e.slice(0, e.lastIndexOf(',')).trim() : '').filter(Boolean))].sort()
}
function parseLocations(s) {
  const seen = new Set(), locs = []
  for (const entry of (s || '').split(';').filter(Boolean)) {
    const p = entry.split('#')
    const type = Number.parseInt(p[0], 10) || 0, fips = (p[2] || '').trim(), adm1 = (p[3] || '').trim()
    if (!fips || seen.has(`${type}|${fips}|${adm1}`)) continue
    seen.add(`${type}|${fips}|${adm1}`)
    locs.push({ type, name: (p[1] || '').trim(), country_fips: fips, adm1, lat: safeFloat(p[5]), lon: safeFloat(p[6]) })
  }
  return locs
}

export function normalizeGkg(row, projectId, bucket, stream) {
  const get = i => (row[i] || '').trim()
  const url = get(G.URL)
  const pageTitle = decodeEntities(get(G.EXTRAS).match(/<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/)?.[1]?.trim() || '')
  const translation = get(G.TRANSLATION)
  const locations = parseLocations(get(G.ENHANCED_LOCATIONS))
  return {
    item_id: hash([projectId, 'gkg', url]),
    project_id: projectId,
    source_type: 'gkg',
    gdelt_primary_id: hash([url]),
    datetime_utc: gdeltDate(get(G.DATE)),
    // Desktop leaves this empty; filling it from mentioned locations lets the country filter work on GKG items.
    countries_focus: [...new Set(locations.map(l => (FIPS_TO_ISO.get(l.country_fips) || l.country_fips).toLowerCase()))],
    query_bucket: bucket,
    title_or_summary: pageTitle || url || 'GKG Article',
    url,
    snippet_or_context: null,
    normalized: {
      title: pageTitle || null, domain: get(G.DOMAIN) || null,
      language: translation ? translation.split(';').find(p => p.startsWith('srclc:'))?.slice(6) ?? null : 'eng',
      themes: get(G.THEMES).split(';').filter(Boolean), sharing_image: get(G.SHARING_IMAGE) || null,
      translation_info: translation || null, date: get(G.DATE), tone: parseTone(get(G.TONE)), counts: parseCounts(get(G.COUNTS)),
      persons: parseNames(get(G.PERSONS)), organizations: parseNames(get(G.ORGANIZATIONS)), locations, source_stream: stream,
    },
    gdelt_raw: {},
  }
}

export function gkgItems(text, project, start, end, stream) {
  const rules = project.watchlists.filter(r => (r.lane === 'doc' || r.lane === 'context') && r.enabled)
  const focus = project.countries_focus.map(c => ISO_TO_FIPS.get(String(c).toUpperCase())?.toUpperCase()).filter(Boolean)
  if (!rules.length || !focus.length) return []
  const items = [], seen = new Set()
  for (const line of text.split('\n')) {
    const row = line.split('\t')
    const url = (row[G.URL] || '').trim()
    if (row.length < 10 || !url) continue
    if (!inWindow(gdeltDate((row[G.DATE] || '').trim()), start, end)) continue
    if (!focus.some(f => mentionsFips((row[G.LOCATIONS] || '').trim(), f))) continue
    for (const rule of rules) {
      const key = `${url}|${rule.bucket_name}`
      if (seen.has(key) || !gkgRuleMatches(row, rule)) continue
      seen.add(key)
      items.push(normalizeGkg(row, project.project_id, rule.bucket_name, stream))
    }
  }
  return items
}
