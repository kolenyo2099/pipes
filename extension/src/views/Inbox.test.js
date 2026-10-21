// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../api.js', () => import('../test/httpApi.js'))
import { mount, unmount } from 'svelte'
import Inbox from './Inbox.svelte'
import { currentProjectId, filters } from '../stores/app.js'

function item(id, title, createdAt) {
  return {
    item_id: id,
    project_id: 'project-1',
    source_type: 'rss',
    datetime_utc: createdAt,
    created_at: createdAt,
    countries_focus: [],
    query_bucket: 'news',
    matched_buckets: ['news'],
    title_or_summary: title,
    url: `https://example.test/${id}`,
    snippet_or_context: '',
    normalized: {},
    gdelt_raw: {},
    status: 'inbox',
    tags: [],
    sheet_send_status: 'not_configured',
  }
}

function json(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('inbox review sessions', () => {
  let component
  let requests

  beforeEach(() => {
    document.body.innerHTML = '<main class="main-content"><div id="inbox"></div></main>'
    currentProjectId.set('project-1')
    filters.update(value => ({
      ...value,
      sourceType: '',
      queryBucket: '',
      countries: '',
      since: '',
      titleSearch: '',
      toneMin: '',
      toneMax: '',
      countType: '',
      person: '',
      organization: '',
      locationText: '',
      vizItemIds: [],
      vizFilterLabel: '',
      limit: 100,
    }))
    requests = []
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const parsed = new URL(String(url), 'http://localhost')
      requests.push({ url: parsed, options })
      if (parsed.pathname.endsWith('/stats')) return json({})
      if (parsed.pathname.endsWith('/dismiss-filtered')) return json({ dismissed: 2 })
      if (parsed.searchParams.has('created_after')) {
        return json({
          items: [item('new', 'New arrival', '2026-08-25T12:03:00Z')],
          total: 1,
          has_more: false,
        })
      }
      if (parsed.searchParams.get('offset') === '1') {
        return json({
          items: [item('second', 'Second reviewed item', '2026-08-25T12:01:00Z')],
          total: 2,
          has_more: false,
        })
      }
      return json({
        items: [item('first', 'First reviewed item', '2026-08-25T12:02:00Z')],
        total: 2,
        has_more: true,
      })
    }))
  })

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    currentProjectId.set(null)
    vi.unstubAllGlobals()
  })

  it('keeps loaded items in place, reports arrivals, and dismisses only reviewed IDs', async () => {
    component = mount(Inbox, { target: document.getElementById('inbox') })
    await vi.waitFor(() => expect(document.body.textContent).toContain('First reviewed item'))

    document.querySelector('.btn-load-more').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second reviewed item'))

    document.querySelector('.btn-refresh').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('1 new item is ready'))
    expect(document.body.textContent).toContain('First reviewed item')
    expect(document.body.textContent).toContain('Second reviewed item')
    expect(document.body.textContent).not.toContain('New arrival')

    document.querySelector('.btn-dismiss-all').click()
    await vi.waitFor(() => {
      expect(requests.some(request => request.url.pathname.endsWith('/dismiss-filtered'))).toBe(true)
    })
    const dismissRequest = requests.find(request => request.url.pathname.endsWith('/dismiss-filtered'))
    expect(JSON.parse(dismissRequest.options.body)).toEqual({ item_ids: ['first', 'second'] })

    const initialLoads = requests.filter(request =>
      request.url.searchParams.has('created_before') &&
      request.url.searchParams.get('offset') !== '1'
    )
    expect(initialLoads).toHaveLength(1)
  })

  it('checks for arrivals when the app regains focus without replacing the review session', async () => {
    component = mount(Inbox, { target: document.getElementById('inbox') })
    await vi.waitFor(() => expect(document.body.textContent).toContain('First reviewed item'))

    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => expect(document.body.textContent).toContain('1 new item is ready'))
    expect(document.body.textContent).toContain('First reviewed item')
    expect(document.body.textContent).not.toContain('New arrival')
  })

  it('makes preferred sources available from the Inbox toolbar', async () => {
    component = mount(Inbox, { target: document.getElementById('inbox') })
    await vi.waitFor(() => expect(document.body.textContent).toContain('First reviewed item'))

    Array.from(document.querySelectorAll('button'))
      .find(button => button.textContent.trim() === 'Preferred sources')
      .click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Add a source domain'))

    const input = document.querySelector('#source-domain')
    input.value = 'reuters.com'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.source-preference-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => {
      expect(requests.some(request => request.url.pathname.endsWith('/source-preferences') && request.options.method === 'POST')).toBe(true)
    })
    const request = requests.find(request => request.url.pathname.endsWith('/source-preferences') && request.options.method === 'POST')
    expect(JSON.parse(request.options.body)).toEqual({ source_domain: 'reuters.com' })
  })

  it('keeps visualisations exclusive to Saved items', async () => {
    component = mount(Inbox, { target: document.getElementById('inbox') })
    await vi.waitFor(() => expect(document.body.textContent).toContain('First reviewed item'))

    expect(document.querySelectorAll('.lens-btn')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Map')
    expect(document.body.textContent).not.toContain('Graph')
  })
})
