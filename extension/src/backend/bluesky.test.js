import { afterEach, describe, expect, it, vi } from 'vitest'
import { blueskyItems, blueskyLabel, blueskyListFeed, blueskyRate, blueskySearch, blueskySearches, blueskyWebUrl } from './bluesky.js'

const quoted = { uri: 'at://did:plc:q/app.bsky.feed.post/q1', author: { handle: 'apnews.com' }, value: { text: 'Quoted report' } }
const post = (rkey, text, extra = {}) => ({
  uri: `at://did:plc:abc/app.bsky.feed.post/${rkey}`, author: { handle: 'reuters.com', displayName: 'Reuters' }, likeCount: 3,
  record: { text, createdAt: '2026-09-29T05:40:22.055455375Z', facets: [{ features: [{ uri: 'https://news.example/a' }, { did: 'did:plc:mentioned' }] }] },
  ...extra,
})
const project = { project_id: 'p', countries_focus: ['MX'] }
const rule = { bucket_name: 'Border', lane: 'bluesky', enabled: true, logic: {} }
const reply = (status, body, headers = {}) => ({ ok: status < 400, status, json: async () => body, headers: new Headers(headers) })
afterEach(() => vi.unstubAllGlobals())

describe('Bluesky lane', () => {
  it('searches each account separately', () => {
    expect(blueskySearches({ bluesky_query: ' frontera ' })).toEqual([{ q: 'frontera', author: null }])
    expect(blueskySearches({ bluesky_accounts: ['@reuters.com', 'apnews.com'] })).toEqual([{ q: '*', author: 'reuters.com' }, { q: '*', author: 'apnews.com' }])
    expect(blueskySearches({ bluesky_query: 'frontera', bluesky_accounts: ['reuters.com'] })).toEqual([{ q: 'frontera', author: 'reuters.com' }])
    expect(blueskySearches({})).toEqual([])
    expect(blueskyLabel({ q: '*', author: 'reuters.com' })).toBe('from:reuters.com')
    expect(blueskyWebUrl({ q: 'frontera', author: 'reuters.com' })).toBe('https://bsky.app/search?q=frontera%20from%3Areuters.com')
    const list = 'https://bsky.app/profile/pfrazee.com/lists/3ldlyatgm572h'
    expect(blueskySearches({ bluesky_accounts: [list, '@reuters.com'] })).toEqual([{ list }, { q: '*', author: 'reuters.com' }])
    expect(blueskyWebUrl({ list })).toBe(list)
  })

  it('turns posts into items with their quotes and links', () => {
    const items = blueskyItems([
      post('p1', 'Border reopens', { embed: { $type: 'app.bsky.embed.record#view', record: quoted } }),
      post('p2', 'With photos', { embed: { $type: 'app.bsky.embed.recordWithMedia#view', record: { record: quoted }, media: {} } }),
      post('p3', 'Link card', { embed: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://news.example/a' } } }),
      { uri: 'at://did:plc:x/app.bsky.feed.post/p4', record: { text: 'No author' } },
    ], project, rule, 'frontera')
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({
      source_type: 'bluesky', url: 'https://bsky.app/profile/reuters.com/post/p1', datetime_utc: '2026-09-29T05:40:22.055Z',
      title_or_summary: 'Border reopens', snippet_or_context: 'Quoting @apnews.com: Quoted report', query_bucket: 'Border',
      normalized: { source_name: '@reuters.com', author_name: 'Reuters', like_count: 3, links: ['https://news.example/a'], query_text: 'frontera' },
    })
    expect(items[1].snippet_or_context).toBe('Quoting @apnews.com: Quoted report')
    expect(items[2].normalized.links).toEqual(['https://news.example/a'])
  })

  it('signs in with the app password, and again once when the session expires', async () => {
    const queue = [
      reply(200, { accessJwt: 'a1', handle: 'me.bsky.social', didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example' }] } }),
      reply(200, { posts: ['first'] }),
      reply(400, { error: 'ExpiredToken', message: 'Token has expired' }),
      reply(200, { accessJwt: 'a2', handle: 'me.bsky.social' }),
      reply(200, { posts: ['second'] }),
      reply(401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' }),
    ]
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { calls.push(`${url.split('?')[0]} ${init.headers.Authorization || ''}`.trim()); return queue.shift() }))
    const account = { identifier: 'me.bsky.social', password: 'app-password' }
    expect(await blueskySearch(account, { q: 'a' })).toEqual({ posts: ['first'] })
    expect(await blueskySearch(account, { q: 'b' })).toEqual({ posts: ['second'] })
    await expect(blueskySearch({ identifier: 'other.bsky.social', password: 'wrong' }, { q: 'c' })).rejects.toMatchObject({ status: 401 })
    expect(calls).toEqual([
      'https://bsky.social/xrpc/com.atproto.server.createSession',
      'https://pds.example/xrpc/app.bsky.feed.searchPosts Bearer a1',
      'https://pds.example/xrpc/app.bsky.feed.searchPosts Bearer a1',
      'https://bsky.social/xrpc/com.atproto.server.createSession',
      'https://bsky.social/xrpc/app.bsky.feed.searchPosts Bearer a2', // that session named no server, so the entryway answers
      'https://bsky.social/xrpc/com.atproto.server.createSession',
    ])
  })

  it('reads a list feed, finding its owner by handle once, and keeps the rate limit the server reports', async () => {
    const queue = [
      reply(200, { accessJwt: 't', handle: 'lists.bsky.social' }),
      reply(200, { did: 'did:plc:owner' }),
      reply(200, { feed: [], cursor: '2026-09-30T18:30:18.203Z' }, { 'ratelimit-remaining': '2999', 'ratelimit-reset': '1790822686' }),
      reply(200, { feed: [] }),
    ]
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async url => { calls.push(decodeURIComponent(url.split('/xrpc/')[1])); return queue.shift() }))
    const account = { identifier: 'lists.bsky.social', password: 'app-password' }
    const list = 'https://bsky.app/profile/pfrazee.com/lists/3ldlyatgm572h'
    expect(await blueskyListFeed(account, list)).toEqual({ feed: [], cursor: '2026-09-30T18:30:18.203Z' })
    expect(blueskyRate()).toEqual({ remaining: 2999, reset: 1790822686000 })
    await blueskyListFeed(account, list, '2026-09-30T18:30:18.203Z')
    expect(calls).toEqual([
      'com.atproto.server.createSession',
      'com.atproto.identity.resolveHandle?handle=pfrazee.com',
      'app.bsky.feed.getListFeed?list=at://did:plc:owner/app.bsky.graph.list/3ldlyatgm572h&limit=100',
      'app.bsky.feed.getListFeed?list=at://did:plc:owner/app.bsky.graph.list/3ldlyatgm572h&limit=100&cursor=2026-09-30T18:30:18.203Z',
    ])
  })
})
