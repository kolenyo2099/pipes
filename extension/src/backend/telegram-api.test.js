import { describe, expect, it } from 'vitest'
import { telegramApiItems } from './telegram-api.js'

const project = { project_id: 'project-1', countries_focus: ['MEX'] }
const rule = { bucket_name: 'Border monitoring' }

describe('Telegram API items', () => {
  it('normalizes API messages into Canary items without exposing account data', () => {
    const [item] = telegramApiItems([{
      id: 73, date: new Date('2026-10-16T12:00:00Z'), message: 'Bridge closed', views: 91,
      fwdFrom: { fromName: 'Source channel' }, postAuthor: 'Channel editor',
    }], project, rule, 'newsroom')

    expect(item).toMatchObject({
      project_id: 'project-1', source_type: 'telegram', gdelt_primary_id: 'newsroom/73',
      url: 'https://t.me/newsroom/73', datetime_utc: '2026-10-16T12:00:00.000Z',
      title_or_summary: 'Bridge closed', snippet_or_context: 'Forwarded from Source channel',
      normalized: { source_name: '@newsroom', author_name: 'Channel editor', view_count: 91 },
    })
    expect(JSON.stringify(item)).not.toContain('api_hash')
  })

  it('keeps media-only messages and skips API placeholders without IDs', () => {
    const items = telegramApiItems([{ id: 4, date: 1, message: '' }, { date: 1, message: 'placeholder' }], project, rule, 'newsroom')
    expect(items).toHaveLength(1)
    expect(items[0].title_or_summary).toBe('(media without text)')
  })

  it('accepts the browser client’s snake-case Unix-second fields', () => {
    const [item] = telegramApiItems([{
      id: 8, date: 1792152000, message: 'New update', views: 12, post_author: 'Editor',
      fwd_from: { from_name: 'Wire service' },
    }], project, rule, 'newsroom')

    expect(item).toMatchObject({
      datetime_utc: '2026-10-16T12:00:00.000Z', snippet_or_context: 'Forwarded from Wire service',
      normalized: { author_name: 'Editor', view_count: 12 },
    })
  })
})
