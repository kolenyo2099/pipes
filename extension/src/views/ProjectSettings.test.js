// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../api.js', () => import('../test/httpApi.js'))
import { mount, tick, unmount } from 'svelte'
import ProjectSettings from './ProjectSettings.svelte'
import { currentProject, currentProjectId } from '../stores/app.js'

const collectionA = { id: 101, name: 'Netherlands - National', source_count: 42, monitored: true }
const collectionB = { id: 202, name: 'Netherlands - Local', source_count: 84, monitored: true }

const baseProject = {
  project_id: 'project-1',
  name: 'Media Cloud project',
  countries_focus: ['NL'],
  watchlists: [{
    bucket_name: 'Dutch coverage',
    lane: 'mediacloud',
    enabled: true,
    logic: {
      query_terms: ['elections'],
      mediacloud_collections: [collectionA],
      description: 'Media Cloud (simple): elections',
    },
  }],
  polling_config: {
    events_enabled: false,
    doc_enabled: false,
    rss_enabled: false,
    mediacloud_enabled: true,
    events_interval_minutes: 30,
    doc_interval_minutes: 60,
    rss_interval_minutes: 60,
    mediacloud_interval_minutes: 1440,
    overlap_minutes: 15,
  },
  mediacloud_collections: [collectionA],
  sheet_sink: null,
}

function json(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function button(text, root = document) {
  return [...root.querySelectorAll('button')].find(candidate =>
    candidate.textContent.replace(/\s+/g, ' ').trim().includes(text)
  )
}

describe('ProjectSettings Media Cloud rule transaction', () => {
  let component
  let updates

  beforeEach(() => {
    document.body.innerHTML = '<div id="target"></div>'
    currentProjectId.set(baseProject.project_id)
    currentProject.set(structuredClone(baseProject))
    updates = []
    vi.stubGlobal('fetch', vi.fn(async (rawUrl, options = {}) => {
      const url = new URL(String(rawUrl), 'http://localhost')
      if (url.pathname === '/api/ontology') {
        return json({
          countries: [{ code: 'NL', name: 'Netherlands' }],
          event_categories: [],
          actor_types: [],
          gkg_themes: [],
        })
      }
      if (url.pathname === '/api/nlp/status') return json({ ner_present: false, sentiment_present: false })
      if (url.pathname === '/api/presets') return json([])
      if (url.pathname === '/api/social-budgets') return json({ x: { per: 20 }, bluesky: { per: 300 } })
      if (url.pathname === '/api/mediacloud/status') return json({ configured: true, source: 'local' })
      if (url.pathname === '/api/mediacloud/collections') return json({ collections: [collectionB] })
      if (url.pathname === '/api/projects/project-1' && options.method === 'PUT') {
        const body = JSON.parse(options.body)
        updates.push(body)
        return json({
          ...structuredClone(baseProject),
          ...body,
          polling_config: body.polling_config || structuredClone(baseProject.polling_config),
        })
      }
      return json({})
    }))
  })

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    currentProjectId.set(null)
    currentProject.set(null)
    vi.unstubAllGlobals()
  })

  it('discards a cancelled draft, then atomically auto-saves a committed collection edit', async () => {
    component = mount(ProjectSettings, { target: document.getElementById('target') })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Dutch coverage'))

    button('Edit').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('1. Choose collections'))
    document.querySelector('.selected-chip').click()
    button('Cancel').click()
    await tick()
    expect(updates).toHaveLength(0)

    button('Save Changes').click()
    await vi.waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0].watchlists[0].logic.mediacloud_collections).toEqual([collectionA])
    expect(updates[0].mediacloud_collections).toEqual([collectionA])

    button('Edit').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('1. Choose collections'))
    document.querySelector('.selected-chip').click()
    const mediaCloudConfig = document.querySelector('.mc-config')
    await vi.waitFor(() => expect(mediaCloudConfig.textContent).toContain('Connected'))
    button('Netherlands', mediaCloudConfig).click()
    await vi.waitFor(() => expect(mediaCloudConfig.textContent).toContain('Netherlands - Local'))
    mediaCloudConfig.querySelector('.results input[type="checkbox"]').click()
    await tick()
    document.querySelector('.qb-footer .qb-btn-save').click()

    await vi.waitFor(() => expect(updates).toHaveLength(2))
    const committed = updates[1]
    const mediaCloudRule = committed.watchlists.find(rule => rule.lane === 'mediacloud')
    expect(mediaCloudRule.logic.mediacloud_collections).toEqual([collectionB])
    expect(committed.mediacloud_collections).toEqual([collectionB])
  })
})
