// Port of desktop fetchers/rss.rs. Differences: searches use explicit after:/before: windows instead of
// when:1d, so a collector that was off for days catches up; the 48-hour freshness cut is replaced by that window.
import { countryName, hash } from './ontology.js'
import { decodeEntities, inWindow } from './gdelt.js'

const MAX_QUERIES = 5
const MAX_QUERY_LEN = 1200
const strings = (logic, key) => Array.isArray(logic?.[key]) ? logic[key].map(v => String(v).trim()).filter(Boolean) : []
const quote = term => /\s/.test(term) ? `"${term.replaceAll('"', '')}"` : term
const orGroup = terms => terms.length > 1 ? `(${terms.map(quote).join(' OR ')})` : terms.length ? quote(terms[0]) : ''
const join = parts => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
const clamp = q => q.length > MAX_QUERY_LEN ? q.slice(0, MAX_QUERY_LEN) : q
const stripWhen = q => q.replace(/\b(?:when|after|before):\S+/gi, '').replace(/\s+/g, ' ').trim()
const simpleTerms = logic => strings(logic, 'query_terms').length ? strings(logic, 'query_terms') : strings(logic, 'focus_terms')

// Shared post-fetch filter for RSS and Media Cloud simple-mode rules.
export function simpleFilterPasses(logic, title, snippet = '', normalized = {}) {
  if (!simpleTerms(logic).length) return true
  const terms = strings(logic, 'require_any')
  const text = `${title || ''} ${snippet || ''}`.toLowerCase()
  const entities = ['persons', 'organizations', 'locations', 'miscellaneous']
    .flatMap(key => Array.isArray(normalized?.[key]) ? normalized[key] : [])
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.toLowerCase())
  return !terms.length || terms.some(term => {
    const lower = term.toLowerCase()
    return text.includes(lower) || entities.some(entity => entity.includes(lower) || lower.includes(entity))
  })
}

const projectCodes = project => project.countries_focus.map(c => String(c).toUpperCase())
const extraCodes = (project, logic) => strings(logic, 'countries').map(c => c.toUpperCase()).filter(c => !projectCodes(project).includes(c))

// Returns [{ label, query, locale }] for one rule; each entry is one Google News search per window.
export function compileQueries(project, rule) {
  const logic = rule.logic || {}
  const dedupe = list => list.filter((q, i) => q.query && list.findIndex(x => x.query === q.query && x.locale === q.locale) === i).slice(0, MAX_QUERIES)
  const simple = simpleTerms(logic)
  if (simple.length) {
    const query = clamp(simple.map(quote).join(' OR '))
    const locales = strings(logic, 'locales').slice(0, MAX_QUERIES)
    return dedupe((locales.length ? locales : ['US:en']).map(locale => ({ label: locale, query, locale })))
  }
  const labels = ['Strict', 'Balanced', 'Recall']
  const plan = strings(logic, 'query_plan').slice(0, MAX_QUERIES)
  if (plan.length) return dedupe(plan.map((q, i) => ({ label: labels[i] || `Variant ${i + 1}`, query: clamp(stripWhen(q)), locale: 'US:en' })))

  const names = codes => codes.map(countryName)
  const extras = names(extraCodes(project, logic))
  const country = join([orGroup(names(projectCodes(project))), logic.countries_mode === 'any' ? orGroup(extras) : extras.map(quote).join(' ')])
  const actors = orGroup([...strings(logic, 'people'), ...strings(logic, 'organizations')].slice(0, 4))
  const core = strings(logic, 'action_core'), alt = strings(logic, 'action_alt')
  const exclude = strings(logic, 'exclude').slice(0, 5).map(x => `-${quote(x)}`).join(' ')
  return dedupe([
    ['Strict', [country, actors, orGroup(core.slice(0, 4)), exclude]],
    ['Balanced', [country, orGroup([...core.slice(0, 2), ...alt.slice(0, 4)]), actors, exclude]],
    ['Recall', [country, orGroup([...core.slice(0, 2), ...alt.slice(0, 2)]), exclude]],
  ].map(([label, parts]) => ({ label, query: clamp(join(parts)), locale: 'US:en' })))
}

// One Google News search covers up to a week, so a long absence costs a few searches per query, not one per day.
// ponytail: a search returns at most 100 stories; shorten the window if a busy query needs more.
export function rssWindows(start, end, days = 7) {
  const day = 86_400_000, result = []
  for (let ms = Math.floor(Date.parse(start) / day) * day; ms < Date.parse(end); ms += days * day) {
    result.push({ start: new Date(Math.max(ms, Date.parse(start))).toISOString(), end: new Date(Math.min(ms + days * day, Date.parse(end))).toISOString() })
  }
  return result
}

export function rssUrl(query, locale, start, end) {
  const [country = 'US', lang = 'en'] = locale.split(':')
  const after = start.slice(0, 10)
  const before = new Date(Math.floor((Date.parse(end) - 1) / 86_400_000) * 86_400_000 + 86_400_000).toISOString().slice(0, 10)
  const q = `${stripWhen(query)} after:${after} before:${before}`
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(`${lang}-${country}`)}&gl=${encodeURIComponent(country)}&ceid=${encodeURIComponent(`${country}:${lang}`)}`
}

// ── Parsing (DOMParser doesn't exist in Web Workers; RSS items are flat, so tags are read as text) ──
const stripHtml = html => decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const compare = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function parseFeed(xml) {
  if (!/<rss[\s>]/.test(xml)) throw new Error('Invalid RSS document')
  const tag = (node, name) => {
    const inner = node.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1] ?? ''
    const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
    return (cdata ? cdata[1] : decodeEntities(inner)).trim()
  }
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].flatMap(([, node]) => {
    const title = tag(node, 'title'), link = tag(node, 'link')
    if (!title || !link) return []
    const descriptionHtml = tag(node, 'description')
    const titleKey = compare(title)
    const cluster = [...new Set([...descriptionHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(m => stripHtml(m[1])).filter(h => h && compare(h) !== titleKey))]
    const pubDate = tag(node, 'pubDate')
    const published = new Date(pubDate)
    return [{
      title, link, guid: tag(node, 'guid') || link, descriptionHtml, descriptionText: stripHtml(descriptionHtml), cluster,
      sourceName: tag(node, 'source') || null, sourceUrl: node.match(/<source\b[^>]*\burl="([^"]*)"/)?.[1] || null,
      publishedAt: Number.isNaN(published.getTime()) ? null : published.toISOString(), pubDateRaw: pubDate || null,
    }]
  })
}

// ── Matching ─────────────────────────────────────────────────────────────────
const ALIASES = {
  US: ['U.S.', 'US', 'USA', 'American'], GB: ['UK', 'U.K.', 'Britain', 'British'], AE: ['UAE', 'Emirati'], MX: ['Mexican', 'Mexicans'],
  BR: ['Brazilian', 'Brazilians'], CO: ['Colombian', 'Colombians'], VE: ['Venezuelan', 'Venezuelans'], AR: ['Argentine', 'Argentinian', 'Argentinians'],
  CL: ['Chilean', 'Chileans'], PE: ['Peruvian', 'Peruvians'], EC: ['Ecuadorian', 'Ecuadorians'], BO: ['Bolivian', 'Bolivians'],
  PY: ['Paraguayan', 'Paraguayans'], UY: ['Uruguayan', 'Uruguayans'], GT: ['Guatemalan', 'Guatemalans'], HN: ['Honduran', 'Hondurans'],
  SV: ['Salvadoran', 'Salvadorans'], NI: ['Nicaraguan', 'Nicaraguans'], CR: ['Costa Rican', 'Costa Ricans'], PA: ['Panamanian', 'Panamanians'],
  CU: ['Cuban', 'Cubans'], HT: ['Haitian', 'Haitians'], DO: ['Dominican'], FR: ['French'], DE: ['German', 'Germans'], IT: ['Italian', 'Italians'],
  ES: ['Spanish'], PL: ['Polish'], UA: ['Ukrainian', 'Ukrainians'], RU: ['Russian', 'Russians'], TR: ['Turkish'], GR: ['Greek'], SE: ['Swedish'],
  NO: ['Norwegian'], FI: ['Finnish'], NL: ['Dutch'], BE: ['Belgian', 'Belgians'], PT: ['Portuguese'], RO: ['Romanian', 'Romanians'],
  HU: ['Hungarian', 'Hungarians'], CZ: ['Czech'], RS: ['Serbian', 'Serbians'], SA: ['Saudi'], IR: ['Iranian', 'Iranians'], IL: ['Israeli', 'Israelis'],
  IQ: ['Iraqi', 'Iraqis'], SY: ['Syrian', 'Syrians'], LB: ['Lebanese'], JO: ['Jordanian', 'Jordanians'], YE: ['Yemeni', 'Yemenis'],
  EG: ['Egyptian', 'Egyptians'], LY: ['Libyan', 'Libyans'], TN: ['Tunisian', 'Tunisians'], MA: ['Moroccan', 'Moroccans'], DZ: ['Algerian', 'Algerians'],
  SD: ['Sudanese'], NG: ['Nigerian', 'Nigerians'], ET: ['Ethiopian', 'Ethiopians'], KE: ['Kenyan', 'Kenyans'], ZA: ['South African', 'South Africans'],
  GH: ['Ghanaian', 'Ghanaians'], TZ: ['Tanzanian', 'Tanzanians'], UG: ['Ugandan', 'Ugandans'], CD: ['Congolese'], ML: ['Malian', 'Malians'],
  BF: ['Burkinabe'], NE: ['Nigerien'], SO: ['Somali', 'Somalis'], CN: ['Chinese', 'Beijing'], IN: ['Indian', 'Indians'], PK: ['Pakistani', 'Pakistanis'],
  AF: ['Afghan', 'Afghans'], BD: ['Bangladeshi', 'Bangladeshis'], JP: ['Japanese'], KR: ['South Korean', 'South Koreans'],
  KP: ['North Korean', 'North Koreans'], ID: ['Indonesian', 'Indonesians'], TH: ['Thai'], VN: ['Vietnamese'], PH: ['Filipino', 'Filipinos'],
  MM: ['Myanmar', 'Burmese'], AU: ['Australian', 'Australians'], NZ: ['New Zealander', 'New Zealanders'],
}
const phraseIn = (haystack, needle) => { const n = compare(needle); return !!n && ` ${haystack} `.includes(` ${n} `) }
const countryIn = (code, haystack) => [countryName(code), ...(ALIASES[code] || [])].some(alias => phraseIn(haystack, alias))
const found = (terms, lower) => terms.filter(t => lower.includes(t.toLowerCase()))

export function matchItem(project, rule, item, { deferSimpleFilter = false } = {}) {
  const logic = rule.logic || {}
  if (simpleTerms(logic).length) {
    if (!deferSimpleFilter && !simpleFilterPasses(logic, item.title, item.descriptionText)) return null
    return { score: 1, core: [], alt: [], people: [], organizations: [], countries: [] }
  }
  const combined = [item.title, item.descriptionText, item.cluster.join(' '), item.sourceName || '', item.sourceUrl || ''].join(' ')
  const lower = combined.toLowerCase(), normalized = compare(combined), titleLower = item.title.toLowerCase()
  if (found(strings(logic, 'exclude'), lower).length) return null
  const coreTerms = strings(logic, 'action_core'), altTerms = strings(logic, 'action_alt')
  const core = found(coreTerms, lower), alt = found(altTerms, lower)
  if ((coreTerms.length || altTerms.length) && !core.length && !alt.length) return null
  const base = projectCodes(project), extra = extraCodes(project, logic)
  if (base.length && !base.some(c => countryIn(c, normalized))) return null
  const extraFound = extra.filter(c => countryIn(c, normalized))
  if (extra.length && (logic.countries_mode === 'any' ? !extraFound.length : extraFound.length !== extra.length)) return null
  const people = found(strings(logic, 'people'), lower), organizations = found(strings(logic, 'organizations'), lower)
  const countries = [...base, ...extra].filter(c => countryIn(c, normalized)).map(countryName)
  const score = Math.max(0, ...core.map(t => titleLower.includes(t.toLowerCase()) ? 4 : 3))
    + (alt.length ? 2 : 0) + (people.length ? 2 : 0) + (organizations.length ? 2 : 0) + (countries.length ? 1 : 0)
  return score > 0 ? { score, core, alt, people, organizations, countries } : null
}

function snippet(item) {
  if (item.cluster.length) return item.cluster.slice(0, 3).join(' | ')
  if (!item.descriptionText) return null
  return compare(item.descriptionText) === compare(item.title) ? (item.sourceName ? `From ${item.sourceName}` : null) : item.descriptionText
}

export function rssItems(xml, project, rule, query, start, end, options = {}) {
  const codes = [...new Set([...projectCodes(project), ...extraCodes(project, rule.logic)])]
  return parseFeed(xml).flatMap(item => {
    if (!inWindow(item.publishedAt, start, end)) return []
    const match = matchItem(project, rule, item, options)
    if (!match) return []
    return [{
      item_id: hash([project.project_id, 'rss', item.guid || item.link]),
      project_id: project.project_id, source_type: 'rss', gdelt_primary_id: item.guid || null,
      datetime_utc: item.publishedAt, countries_focus: codes, query_bucket: rule.bucket_name,
      title_or_summary: item.title, url: item.link, snippet_or_context: snippet(item),
      normalized: {
        lane: 'rss', source_name: item.sourceName, source_url: item.sourceUrl, published_at_rfc2822: item.pubDateRaw,
        description_text: item.descriptionText, cluster_headlines: item.cluster, selected_countries: codes.map(countryName),
        matched_countries: match.countries, matched_people: match.people, matched_organizations: match.organizations,
        matched_action_core: match.core, matched_action_alt: match.alt, score: match.score, query_label: query.label, query_text: query.query,
      },
      gdelt_raw: { guid: item.guid, title: item.title, link: item.link, pub_date: item.pubDateRaw, description_html: item.descriptionHtml, source_name: item.sourceName, source_url: item.sourceUrl },
    }]
  })
}
