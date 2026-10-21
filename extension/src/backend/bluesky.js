// Bluesky lane. Bluesky's API filters searches by date and returns up to 100 posts a page, so no browser tab is
// needed. Since 2026 its search answers only signed-in requests, so Canary signs in with an app password the user
// creates in Bluesky (Settings → Privacy and security → App passwords), which cannot change the account itself.
import { hash } from './ontology.js'

export const BLUESKY_ACCOUNT = 'bluesky_account' // { identifier, password }: stored in this browser, left out of backups
const ENTRYWAY = 'https://bsky.social'
const strings = (logic, key) => Array.isArray(logic?.[key]) ? logic[key].map(v => String(v).trim()).filter(Boolean) : []

// A list link (bsky.app/profile/<owner>/lists/<id>) brings every post by the list's members in one feed.
export const BLUESKY_LIST = /^https?:\/\/(?:www\.)?bsky\.app\/profile\/([^/]+)\/lists\/([^/?#]+)/i

// Bluesky search has no OR across accounts, so each account is its own search; `*` with an author matches all its
// posts. Each list is one feed, which a search cannot narrow (the rule editor keeps the two apart).
export function blueskySearches(logic) {
  const q = String(logic?.bluesky_query || '').trim()
  const entries = strings(logic, 'bluesky_accounts')
  const lists = entries.filter(entry => BLUESKY_LIST.test(entry)).map(list => ({ list }))
  const accounts = entries.filter(entry => !BLUESKY_LIST.test(entry)).map(handle => ({ q: q || '*', author: handle.replace(/^@/, '') }))
  return [...lists, ...(accounts.length ? accounts : q && !lists.length ? [{ q, author: null }] : [])]
}
// The same search as typed into bsky.app, or the list it reads.
export const blueskyLabel = ({ q, author, list }) => list ? `every post from list ${list}` : [q !== '*' && q, author && `from:${author}`].filter(Boolean).join(' ')
export const blueskyWebUrl = search => search.list || `https://bsky.app/search?q=${encodeURIComponent(blueskyLabel(search))}`

// The account's server reports its own rate limit on each response; the collector paces itself by it.
let lastRate = null
export const blueskyRate = () => lastRate

async function xrpc(base, method, { params, body, token } = {}) {
  const response = await fetch(`${base}/xrpc/${method}${params ? `?${new URLSearchParams(params)}` : ''}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  })
  const remaining = response.headers.get('ratelimit-remaining')
  if (remaining !== null) lastRate = { remaining: Number(remaining), reset: Number(response.headers.get('ratelimit-reset')) * 1000 }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.message || `Bluesky answered HTTP ${response.status}`), { status: response.status, code: data.error, reset: lastRate?.reset })
  return data
}

export async function blueskySignIn({ identifier, password }) {
  const session = await xrpc(ENTRYWAY, 'com.atproto.server.createSession', { body: { identifier, password } })
  // Accounts live on different servers; the session names the one to ask.
  const pds = session.didDoc?.service?.find(service => service.id === '#atproto_pds')?.serviceEndpoint || ENTRYWAY
  return { identifier, pds, token: session.accessJwt, handle: session.handle }
}

// Sessions expire after a few hours; then this signs in again, once.
let session = null
async function blueskyCall(account, method, params) {
  for (let retried = false; ; retried = true) {
    if (session?.identifier !== account.identifier) session = await blueskySignIn(account)
    try {
      return await xrpc(session.pds, method, { params, token: session.token })
    } catch (error) {
      if (retried || !(error.status === 401 || error.code === 'ExpiredToken')) throw error
      session = null
    }
  }
}
export const blueskySearch = (account, params) => blueskyCall(account, 'app.bsky.feed.searchPosts', params)

// List links name their owner by handle or DID; the API wants a DID.
const listUris = new Map()
export async function blueskyListFeed(account, link, cursor) {
  if (!listUris.has(link)) {
    const [, owner, id] = link.match(BLUESKY_LIST)
    const did = owner.startsWith('did:') ? owner : (await blueskyCall(account, 'com.atproto.identity.resolveHandle', { handle: owner })).did
    listUris.set(link, `at://${did}/app.bsky.graph.list/${id}`)
  }
  return blueskyCall(account, 'app.bsky.feed.getListFeed', { list: listUris.get(link), limit: 100, ...(cursor && { cursor }) })
}

export function blueskyItems(posts, project, rule, query) {
  return posts.flatMap(post => {
    const handle = post.author?.handle
    if (!post.uri || !handle) return []
    const created = new Date(post.record?.createdAt)
    // A quote embeds the quoted post directly, or inside a record-with-media embed.
    const quoted = post.embed?.record?.record || post.embed?.record
    const links = [...(post.record?.facets || []).flatMap(facet => facet.features || []).map(feature => feature.uri), post.embed?.external?.uri]
    return [{
      item_id: hash([project.project_id, 'bluesky', post.uri]), project_id: project.project_id, source_type: 'bluesky',
      gdelt_primary_id: post.uri, datetime_utc: Number.isNaN(created.getTime()) ? null : created.toISOString(),
      countries_focus: project.countries_focus, query_bucket: rule.bucket_name,
      title_or_summary: post.record?.text || '', url: `https://bsky.app/profile/${handle}/post/${post.uri.split('/').pop()}`,
      snippet_or_context: quoted?.value?.text ? `Quoting @${quoted.author?.handle || 'unknown'}: ${quoted.value.text}` : null,
      normalized: {
        lane: 'bluesky', source_name: `@${handle}`, author_name: post.author.displayName || null, query_text: query,
        links: [...new Set(links.filter(Boolean))],
        reply_count: post.replyCount, repost_count: post.repostCount, quote_count: post.quoteCount, like_count: post.likeCount,
      },
      gdelt_raw: null,
    }]
  })
}
