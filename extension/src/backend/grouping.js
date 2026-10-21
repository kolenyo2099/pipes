// Story grouping ported from desktop Canary (src/grouping.rs + store.rs auto-grouping).
// Articles share a story when their normalized headlines match exactly, or when a fuzzy
// headline score reaches AUTO_GROUP_THRESHOLD. Otherwise the canonical URL decides.
import { detectLanguage } from './nlpShared.js'
const ARTICLE_TYPES = ['doc', 'gkg', 'rss', 'mediacloud']
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with', 'will', 'after', 'over', 'new'])
const BOILERPLATE = new Set(['home', 'homepage', 'latest news', 'breaking news', 'national news', 'world news', 'news', 'untitled', 'page not found', 'access denied', 'privacy choices', 'your privacy choices', 'jouw privacykeuzes'])
export const AUTO_GROUP_THRESHOLD = 0.92
const RECENT_LIMIT = 250

export function normalizeTitle(title) {
  const trimmed = String(title || '').trim()
  if (!trimmed || /^https?:\/\//.test(trimmed)) return null
  const normalized = trimmed.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!normalized || BOILERPLATE.has(normalized) || normalized.startsWith('404 ') || normalized.endsWith(' page not found') || normalized.includes('cookie preferences')) return null
  return normalized
}

export function canonicalUrl(url) {
  let parsed
  try { parsed = new URL(String(url || '').trim()) } catch { return null }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null
  const kept = [...parsed.searchParams].filter(([key]) => {
    const k = key.toLowerCase()
    return !k.startsWith('utm_') && !['fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid', 'igshid'].includes(k)
  }).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
  const query = kept.length ? `?${new URLSearchParams(kept)}` : ''
  const path = parsed.pathname.replace(/\/+$/, '') || '/'
  return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${parsed.port ? `:${parsed.port}` : ''}${path}${query}`
}

export function sourceDomain(url) {
  try { return new URL(String(url || '').trim()).hostname.replace(/^www\./, '').toLowerCase() || null } catch { return null }
}

// Google News appends " - Publisher" to every headline; compare the headline without it.
function headline(item) {
  const title = String(item.title_or_summary || '')
  const publisher = item.normalized?.source_name
  return publisher && title.endsWith(` - ${publisher}`) ? title.slice(0, -publisher.length - 3) : title
}

export function storyKey(item) {
  const title = ARTICLE_TYPES.includes(item.source_type) ? normalizeTitle(headline(item)) : null
  if (title) return `title:${title}`
  const url = canonicalUrl(item.url)
  return url ? `url:${url}` : `item:${item.item_id}`
}

export function fingerprint(title, language = null) {
  const normalized = normalizeTitle(title)
  if (!normalized) return null
  const raw = normalized.split(' ')
  const tokens = raw.filter(t => !STOP_WORDS.has(t) && !/^\d+$/.test(t))
  return {
    tokens: new Set(tokens),
    shingles: new Set(tokens.slice(1).map((t, i) => `${tokens[i]} ${t}`)),
    numbers: raw.filter(t => /^\d+$/.test(t)).join(' '),
    language: detectLanguage(title) || (language ? String(language).toLowerCase() : null),
  }
}

const jaccard = (a, b) => {
  const union = new Set([...a, ...b]).size
  return union ? [...a].filter(x => b.has(x)).length / union : 0
}

export function fuzzyScore(left, right) {
  let score = jaccard(left.tokens, right.tokens) * 0.8 + jaccard(left.shingles, right.shingles) * 0.2
  if (left.numbers && right.numbers && left.numbers !== right.numbers) score -= 0.2
  if (left.language && right.language && left.language !== right.language) score -= 0.08
  return Math.min(1, Math.max(0, score))
}

// Returns a function that assigns story_key to arriving items, matching against the most recent articles.
export function storyAssigner(existingItems, { constraints = [], onCandidate = () => {} } = {}) {
  const recent = existingItems.filter(i => ARTICLE_TYPES.includes(i.source_type))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, RECENT_LIMIT)
    .map(i => ({ id: i.item_id, key: i.story_key || storyKey(i), print: fingerprint(headline(i), i.normalized?.language) })).filter(r => r.print)
  return item => {
    const key = storyKey(item)
    const print = ARTICLE_TYPES.includes(item.source_type) ? fingerprint(headline(item), item.normalized?.language) : null
    if (!print) return key
    let best = null
    for (const r of recent) {
      if (constraints.some(c => c.constraint_type === 'not_duplicates' &&
        ((c.left_item_id === item.item_id && c.right_item_id === r.id) || (c.right_item_id === item.item_id && c.left_item_id === r.id)))) continue
      const score = fuzzyScore(print, r.print)
      if (score >= 0.78) {
        const [left_item_id, right_item_id] = [item.item_id, r.id].sort()
        onCandidate({ left_item_id, right_item_id, matching_method: score >= AUTO_GROUP_THRESHOLD ? 'fuzzy_auto' : 'fuzzy_shadow',
          fuzzy_score: score, final_confidence: score, reasons: { token_jaccard: jaccard(print.tokens, r.print.tokens),
            shingle_overlap: jaccard(print.shingles, r.print.shingles), classification: score >= AUTO_GROUP_THRESHOLD ? 'automatically_grouped' : 'probable' },
          algorithm_version: 'fuzzy-v1' })
      }
      if (score >= AUTO_GROUP_THRESHOLD && (!best || score > best.score)) best = { score, key: r.key }
    }
    const assigned = best ? best.key : key
    recent.unshift({ id: item.item_id, key: assigned, print })
    if (recent.length > RECENT_LIMIT) recent.pop()
    return assigned
  }
}
