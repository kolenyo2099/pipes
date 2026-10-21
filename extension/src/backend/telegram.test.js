// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { telegramChannels, telegramItems, telegramMatches, telegramUrl } from './telegram.js'

// The shape of t.me/s/<channel>, trimmed to what the lane reads.
const message = (post, time, body = '', extra = '') => `
<div class="tgme_widget_message_wrap"><div class="tgme_widget_message js-widget_message ${extra}" data-post="${post}">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_author"><a class="tgme_widget_message_owner_name" href="https://t.me/newsroom"><span>Newsroom</span></a></div>
    ${body}
    <div class="tgme_widget_message_footer"><div class="tgme_widget_message_info">
      <span class="tgme_widget_message_views">18.9K</span>
      <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${post}"><time datetime="${time}" class="time">12:00</time></a></span>
    </div></div>
  </div>
</div></div>`
const page = messages => `<html><body><div class="tgme_channel_info"></div><section class="tgme_channel_history">${messages.join('')}</section></body></html>`
const project = { project_id: 'p', countries_focus: ['UA'] }
const rule = { bucket_name: 'Front', lane: 'telegram', enabled: true, logic: {} }

describe('Telegram lane', () => {
  it('reads channel names from handles and links', () => {
    expect(telegramChannels({ telegram_accounts: ['@newsroom', 'https://t.me/s/Front_Line/', 't.me/newsroom', 'telegram.me/other_one', 'bad!', 'abc'] }))
      .toEqual(['newsroom', 'Front_Line', 'other_one'])
    expect(telegramUrl('newsroom', 41)).toBe('https://t.me/s/newsroom?before=41')
  })

  it('keeps posts with their text, forwards, links and views, and pages back from the oldest', () => {
    const html = page([
      message('newsroom/41', '2026-10-01T05:45:10+00:00', `
        <div class="tgme_widget_message_forwarded_from">Forwarded from <a class="tgme_widget_message_forwarded_from_name" href="https://t.me/source/9"><span>Source</span></a></div>
        <div class="tgme_widget_message_text">Bridge closed<br>near the border <a href="https://news.example/a">link</a> <a href="https://t.me/x">tg</a></div>`),
      message('newsroom/42', '2026-10-01T06:00:00+00:00'),
      message('newsroom/1', '2020-01-01T00:00:00+00:00', '', 'service_message'),
    ])
    const { items, next } = telegramItems(html, project, rule, 'newsroom')
    expect(next).toBeNull() // post 1 is the first
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      source_type: 'telegram', gdelt_primary_id: 'newsroom/41', url: 'https://t.me/newsroom/41', datetime_utc: '2026-10-01T05:45:10.000Z',
      title_or_summary: 'Bridge closed\nnear the border link tg', snippet_or_context: 'Forwarded from Source', query_bucket: 'Front',
      normalized: { source_name: '@newsroom', author_name: 'Newsroom', forwarded_from: 'https://t.me/source/9', links: ['https://news.example/a'], view_count: 18900 },
    })
    expect(items[1].title_or_summary).toBe('(media without text)')
    expect(telegramItems(page([message('newsroom/42', '2026-10-01T06:00:00+00:00')]), project, rule, 'newsroom').next).toBe(42)
    expect(telegramItems(page([]), project, rule, 'newsroom')).toEqual({ items: [], next: null })
  })

  it('filters by any keyword, ignoring case', () => {
    const item = { title_or_summary: 'Bridge CLOSED', snippet_or_context: null }
    expect(telegramMatches({}, item)).toBe(true)
    expect(telegramMatches({ telegram_query: 'flood, closed' }, item)).toBe(true)
    expect(telegramMatches({ telegram_query: 'flood' }, item)).toBe(false)
  })

  it('reports a changed format instead of an empty channel', () => {
    expect(() => telegramItems('<html><body>new layout</body></html>', project, rule, 'newsroom')).toThrow(expect.objectContaining({ formatChanged: true }))
    expect(() => telegramItems(page([message('newsroom/41', '')]), project, rule, 'newsroom')).toThrow(expect.objectContaining({ formatChanged: true }))
  })
})
