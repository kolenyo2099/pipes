// X (Twitter) lane. X has no feeds and rejects search requests that its own web app did not sign, so the service
// worker opens each rule's search on x.com in a background tab of this browser, where the user is signed in, and
// public/x-hook.js keeps the SearchTimeline responses the page receives. This module turns rules into searches and
// those responses into items.
import { hash } from './ontology.js'

const strings = (logic, key) => Array.isArray(logic?.[key]) ? logic[key].map(v => String(v).trim()).filter(Boolean) : []

// An X list link searches all of its members' posts at once, which keeps the search short.
export const X_LIST = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/lists\/(\d+)/i

// One search per rule: the typed search (X's own syntax) narrowed to the listed accounts and lists, if any. X evaluates
// AND before OR, so each part is grouped, or "a OR b" would escape the accounts and the dates added later.
export function xQuery(logic) {
  const typed = String(logic?.x_query || '').trim()
  const members = strings(logic, 'x_accounts').map(entry => X_LIST.test(entry) ? `list:${entry.match(X_LIST)[1]}` : `from:${entry.replace(/^@/, '')}`)
  return [typed && `(${typed})`, members.length && `(${members.join(' OR ')})`].filter(Boolean).join(' ')
}

// f=live is the Latest tab. #canary turns on x-hook.js in this tab only, and X's servers never see the fragment.
export const xSearchUrl = query => `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live#canary`

// The time bounds of a hole (see openHole in collect.js), in X's search syntax.
const unix = iso => Math.floor(Date.parse(iso) / 1000)
export const xWindowSearch = (query, { from, to }) => `${query} since_time:${unix(from)} until_time:${unix(to)}`

// Timeline entries keep their post at itemContent.tweet_results; a quoted post sits deeper, inside its post.
function* timelinePosts(node) {
  if (!node || typeof node !== 'object') return
  const content = node.itemContent
  if (content?.tweet_results?.result && !content.promotedMetadata) yield content.tweet_results.result
  for (const value of Object.values(node)) yield* timelinePosts(value)
}
// TweetWithVisibilityResults wraps the post in `tweet`.
const unwrap = result => result?.tweet || result
// A response Canary cannot read means X changed its format: the lane stops and asks the user to tell the developers.
const formatChanged = message => Object.assign(new Error(message), { formatChanged: true })
const instructionsOf = json => json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions
const handleOf = post => post?.core?.user_results?.result?.core?.screen_name || post?.core?.user_results?.result?.legacy?.screen_name || null

export function xItems(responses, project, rule, query) {
  const items = new Map()
  for (const { body } of responses) {
    let json
    try { json = JSON.parse(body) } catch { throw formatChanged('X sent a search response that is not JSON') }
    // An empty search still has its timeline; only the field names are reported, never posts or the search.
    if (!Array.isArray(instructionsOf(json))) {
      if (json?.errors?.length && !json.data) throw new Error(`X: ${json.errors[0].message}`)
      throw formatChanged(`X search response has no timeline (top-level fields: ${Object.keys(json?.data ?? json ?? {}).join(', ') || 'none'})`)
    }
    for (const result of timelinePosts(json)) {
      const post = unwrap(result), legacy = post?.legacy
      if (!post?.rest_id || !legacy) {
        if (post?.__typename === 'Tweet') throw formatChanged(`X sent a post without ${post.rest_id ? 'legacy' : 'rest_id'}`)
        continue // tombstones and prompts
      }
      const handle = handleOf(post), user = post.core?.user_results?.result
      const created = new Date(legacy.created_at)
      const quoted = unwrap(post.quoted_status_result?.result)
      items.set(post.rest_id, {
        item_id: hash([project.project_id, 'x', post.rest_id]), project_id: project.project_id, source_type: 'x',
        gdelt_primary_id: post.rest_id, datetime_utc: Number.isNaN(created.getTime()) ? null : created.toISOString(),
        countries_focus: project.countries_focus, query_bucket: rule.bucket_name,
        // Long posts keep their full text in note_tweet; legacy.full_text holds the first part.
        title_or_summary: post.note_tweet?.note_tweet_results?.result?.text || legacy.full_text,
        url: `https://x.com/${handle || 'i/web'}/status/${post.rest_id}`,
        snippet_or_context: quoted?.legacy ? `Quoting @${handleOf(quoted) || 'unknown'}: ${quoted.legacy.full_text}` : null,
        normalized: {
          lane: 'x', source_name: handle && `@${handle}`, author_name: user?.core?.name || user?.legacy?.name || null, query_text: query,
          links: (legacy.entities?.urls || []).map(link => link.expanded_url).filter(Boolean),
          reply_count: legacy.reply_count, repost_count: legacy.retweet_count, quote_count: legacy.quote_count,
          like_count: legacy.favorite_count, view_count: Number(post.views?.count) || null,
        },
        gdelt_raw: null,
      })
    }
  }
  return [...items.values()]
}
