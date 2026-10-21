// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../api.js', () => import('../test/httpApi.js'))
import { mount, tick, unmount } from 'svelte'
import QueryBuilder from './QueryBuilder.svelte'

const collectionA = {
  id: 101,
  name: 'Netherlands - National',
  source_count: 42,
  monitored: true,
}
const collectionB = {
  id: 202,
  name: 'Netherlands - Local',
  source_count: 84,
  monitored: true,
}

const ontology = {
  countries: [{ code: 'NL', name: 'Netherlands' }],
  event_categories: [],
  actor_types: [],
  gkg_themes: [],
}

function json(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function button(text) {
  return [...document.querySelectorAll('button')].find(candidate =>
    candidate.textContent.replace(/\s+/g, ' ').trim().includes(text)
  )
}

async function setInput(selector, value) {
  const input = document.querySelector(selector)
  expect(input).toBeTruthy()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  return input
}

describe('QueryBuilder Media Cloud flow', () => {
  let component

  beforeEach(() => {
    document.body.innerHTML = '<div id="target"></div>'
    vi.stubGlobal('fetch', vi.fn(async rawUrl => {
      const url = new URL(String(rawUrl), 'http://localhost')
      if (url.pathname === '/api/presets') return json([])
      if (url.pathname === '/api/mediacloud/status') {
        return json({ configured: true, source: 'local' })
      }
      if (url.pathname === '/api/mediacloud/collections') {
        return json({ collections: [collectionA, collectionB] })
      }
      return json({})
    }))
  })

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    vi.unstubAllGlobals()
  })

  it('makes collection choice the gated first step and saves only a Media Cloud rule', async () => {
    const onSave = vi.fn()
    component = mount(QueryBuilder, {
      target: document.getElementById('target'),
      props: {
        ontology,
        projectCountries: ['NL'],
        onSave,
      },
    })

    await setInput('#qb-name', 'Dutch monitoring')
    button('Media Cloud').click()
    await tick()
    expect(document.body.textContent).toContain('1. Choose collections')

    button('Next').click()
    await tick()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Choose at least one collection')
    expect(document.body.textContent).toContain('1. Choose collections')

    await vi.waitFor(() => expect(document.body.textContent).toContain('Connected'))
    button('Netherlands').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Netherlands - National'))
    document.querySelector('.results input[type="checkbox"]').click()
    await tick()

    button('Next').click()
    await tick()
    expect(document.body.textContent).toContain('1 selected')
    button('Simple (terms)').click()
    await tick()
    await setInput('input[placeholder="e.g. Sudan, Sahel, Gaza"]', 'elections')
    document.querySelector('.qb-section .qb-add-btn').click()
    await tick()
    button('Add Rule').click()

    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0]
    expect(saved.lane).toBe('mediacloud')
    expect(saved.logic.query_terms).toEqual(['elections'])
    expect(saved.logic.mediacloud_collections).toEqual([collectionA])
  })

  it('keeps RSS and Media Cloud modes, terms, inputs, and serialized logic isolated', async () => {
    const rssLogic = {
      query_terms: ['rss-only'],
      require_any: ['rss-filter'],
      locales: ['GB:en'],
      description: 'RSS original',
      future_field: { untouched: true },
    }
    const mediaCloudLogic = {
      query_terms: ['cloud-only'],
      require_any: [],
      mediacloud_collections: [collectionA],
      description: 'Media Cloud original',
      cloud_future_field: 7,
    }
    const onSave = vi.fn()
    component = mount(QueryBuilder, {
      target: document.getElementById('target'),
      props: {
        rule: { bucket_name: 'Separate drafts', lane: 'rss', enabled: true, logic: rssLogic },
        relatedRules: [{ bucket_name: 'Separate drafts', lane: 'mediacloud', enabled: true, logic: mediaCloudLogic }],
        ontology,
        projectCountries: ['NL'],
        onSave,
      },
    })

    await vi.waitFor(() => expect(document.body.textContent).toContain('rss-only'))
    await setInput('input[placeholder="e.g. Sudan, Sahel, Gaza"]', 'rss partial')

    button('Media Cloud').click()
    await tick()
    expect(document.body.textContent).toContain('1. Choose collections')
    button('Next').click()
    await tick()
    expect(document.body.textContent).toContain('cloud-only')
    await setInput('input[placeholder="e.g. Sudan, Sahel, Gaza"]', 'cloud partial')

    button('Google News RSS').click()
    await tick()
    expect(document.querySelector('input[placeholder="e.g. Sudan, Sahel, Gaza"]').value).toBe('rss partial')
    expect(document.body.textContent).toContain('rss-only')

    button('Media Cloud').click()
    await tick()
    expect(document.querySelector('input[placeholder="e.g. Sudan, Sahel, Gaza"]').value).toBe('cloud partial')
    document.querySelector('.qb-section .qb-add-btn').click()
    await tick()
    button('Save Changes').click()

    const savedRules = onSave.mock.calls[0][0]
    expect(Array.isArray(savedRules)).toBe(true)
    const savedRss = savedRules.find(saved => saved.lane === 'rss')
    const savedMediaCloud = savedRules.find(saved => saved.lane === 'mediacloud')
    expect(savedRss.logic).toEqual(rssLogic)
    expect(savedMediaCloud.logic.query_terms).toEqual(['cloud-only', 'cloud partial'])
    expect(savedMediaCloud.logic.mediacloud_collections).toEqual([collectionA])
    expect(savedMediaCloud.logic.cloud_future_field).toBe(7)
  })

  it('discards the collection draft on Cancel without mutating parent data', async () => {
    const originalCollections = [collectionA]
    const originalRule = {
      bucket_name: 'Cancel safely',
      lane: 'mediacloud',
      enabled: true,
      logic: { query_terms: ['original'], mediacloud_collections: originalCollections },
    }
    const onSave = vi.fn()
    const onCancel = vi.fn()
    component = mount(QueryBuilder, {
      target: document.getElementById('target'),
      props: { rule: originalRule, ontology, projectCountries: ['NL'], onSave, onCancel },
    })

    await vi.waitFor(() => expect(document.body.textContent).toContain('Netherlands - National'))
    document.querySelector('.selected-chip').click()
    await tick()
    expect(document.querySelector('.selected-chip')).toBeNull()
    button('Cancel').click()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
    expect(originalCollections).toEqual([collectionA])
    expect(originalRule.logic.mediacloud_collections).toEqual([collectionA])
  })
})
