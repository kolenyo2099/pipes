const TITLE_GROUP_SOURCE_TYPES = new Set(['doc', 'gkg', 'rss', 'mediacloud'])
const BOILERPLATE_TITLES = new Set([
  'home', 'homepage', 'latest news', 'breaking news', 'national news', 'world news',
  'news', 'untitled', 'page not found', 'access denied', 'privacy choices',
  'your privacy choices', 'jouw privacykeuzes',
])

function normalizedUrlKey(item) {
  const url = item?.url?.trim()
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase()
      if (lower.startsWith('utm_') || ['fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid', 'igshid'].includes(lower)) {
        parsed.searchParams.delete(key)
      }
    }
    parsed.searchParams.sort()
    const host = parsed.host.toLowerCase().replace(/^www\./, '')
    const path = parsed.pathname.replace(/\/+$/, '') || '/'
    return `url:${host}${path}${parsed.search}`
  } catch (_) {
    return `url:${url}`
  }
}

function normalizedTitleKey(item) {
  if (!TITLE_GROUP_SOURCE_TYPES.has(item?.source_type)) return null

  const title = item?.title_or_summary?.trim()
  if (!title || /^https?:\/\//i.test(title)) return null

  const normalized = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

  if (!normalized || BOILERPLATE_TITLES.has(normalized)) return null
  if (normalized.startsWith('404 ') || normalized.endsWith(' page not found') || normalized.includes('cookie preferences')) return null

  return `title:${normalized}`
}

function groupKeys(item) {
  return [normalizedUrlKey(item), normalizedTitleKey(item)].filter(Boolean)
}

function mergeGroups(target, source) {
  if (target === source || source.removed) return

  target.siblings.push(source.primary, ...source.siblings)
  for (const key of source.keys) target.keys.add(key)
  source.removed = true
}

// Groups exact URL matches plus exact normalized-title matches for article-title
// lanes. Events keep URL-only grouping because their display titles are synthetic.
export function groupRelatedItems(items) {
  const groups = []
  const keyToGroup = new Map()

  for (const item of items) {
    const keys = groupKeys(item)
    const matchedGroups = [
      ...new Set(keys.map(key => keyToGroup.get(key)).filter(Boolean)),
    ]

    let group
    if (matchedGroups.length === 0) {
      group = {
        primary: item,
        siblings: [],
        keys: new Set(keys),
        removed: false,
      }
      groups.push(group)
    } else {
      group = matchedGroups[0]
      for (const other of matchedGroups.slice(1)) {
        mergeGroups(group, other)
      }
      group.siblings.push(item)
      for (const key of keys) group.keys.add(key)
    }

    for (const key of group.keys) {
      keyToGroup.set(key, group)
    }
  }

  return groups
    .filter(group => !group.removed)
    .map(({ primary, siblings }) => ({ primary, siblings }))
}
