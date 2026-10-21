import { describe, expect, it } from 'vitest'
import { xItems, xQuery, xSearchUrl, xWindowSearch } from './x.js'

const user = screen_name => ({ result: { __typename: 'User', core: { screen_name, name: screen_name.toUpperCase() } } })
const post = (id, text, extra = {}) => ({
  __typename: 'Tweet', rest_id: id, core: { user_results: user('reuters') }, views: { count: '120' },
  legacy: { full_text: text, created_at: 'Wed Sep 30 14:03:11 +0000 2026', favorite_count: 3, entities: { urls: [{ expanded_url: 'https://news.example/a' }] } },
  ...extra,
})
const entry = (result, itemContent = {}) => ({ content: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result }, ...itemContent } } })
const response = entries => ({ status: 200, body: JSON.stringify({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } }) })
const project = { project_id: 'p', countries_focus: ['MX'] }
const rule = { bucket_name: 'Border', lane: 'x', enabled: true, logic: {} }

describe('X lane', () => {
  it('compiles a search narrowed to accounts and lists', () => {
    expect(xQuery({ x_query: ' border OR frontera ', x_accounts: ['@Reuters', 'AP'] })).toBe('(border OR frontera) (from:Reuters OR from:AP)')
    expect(xQuery({ x_accounts: ['@AP'] })).toBe('(from:AP)')
    expect(xQuery({})).toBe('')
    expect(xSearchUrl('(from:AP)')).toBe('https://x.com/search?q=(from%3AAP)&src=typed_query&f=live#canary')
    expect(xQuery({ x_accounts: ['@AP', 'https://x.com/i/lists/1234567890'] })).toBe('(from:AP OR list:1234567890)')
    expect(xWindowSearch('(from:AP)', { from: '2026-09-30T10:00:00.000Z', to: '2026-09-30T12:00:00.000Z' })).toBe('(from:AP) since_time:1790762400 until_time:1790769600')
  })

  it('keeps timeline posts and skips ads, tombstones and quoted posts', () => {
    const legacyHandle = { ...post('2', 'Older user shape'), core: { user_results: { result: { legacy: { screen_name: 'ap', name: 'AP' } } } } }
    const quoting = post('1', 'Border reopens', { quoted_status_result: { result: post('9', 'Quoted report') } })
    const responses = [
      response([
        entry(quoting),
        entry({ __typename: 'TweetWithVisibilityResults', tweet: legacyHandle }),
        entry({ __typename: 'TweetTombstone' }),
        entry(post('3', 'Buy now'), { promotedMetadata: { advertiser_results: {} } }),
        entry(post('4', 'Truncated…', { note_tweet: { note_tweet_results: { result: { text: 'The whole long post' } } } })),
      ]),
      response([entry(quoting)]), // the same post in a later page
      response([]), // an empty page
    ]
    const items = xItems(responses, project, rule, 'border')
    expect(items.map(i => i.gdelt_primary_id)).toEqual(['1', '2', '4'])
    expect(items[0]).toMatchObject({
      source_type: 'x', url: 'https://x.com/reuters/status/1', datetime_utc: '2026-09-30T14:03:11.000Z', query_bucket: 'Border',
      title_or_summary: 'Border reopens', snippet_or_context: 'Quoting @reuters: Quoted report',
      normalized: { source_name: '@reuters', author_name: 'REUTERS', like_count: 3, view_count: 120, links: ['https://news.example/a'], query_text: 'border' },
    })
    expect(items[1]).toMatchObject({ url: 'https://x.com/ap/status/2', normalized: { source_name: '@ap', author_name: 'AP' } })
    expect(items[2].title_or_summary).toBe('The whole long post')
  })

  it('reports a changed format instead of an empty search', () => {
    const read = body => () => xItems([{ status: 200, body }], project, rule, 'border')
    expect(read('not json')).toThrow(expect.objectContaining({ formatChanged: true }))
    expect(read(JSON.stringify({ data: { search_by_raw_query: { search_timeline: {} } } })))
      .toThrow(expect.objectContaining({ formatChanged: true, message: 'X search response has no timeline (top-level fields: search_by_raw_query)' }))
    expect(read(response([entry({ __typename: 'Tweet', rest_id: '5', core: {} })]).body)).toThrow(expect.objectContaining({ formatChanged: true }))
    expect(read(JSON.stringify({ errors: [{ message: 'Rate limit exceeded' }] }))).toThrow(expect.not.objectContaining({ formatChanged: true }))
  })
})
