// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../api.js', () => import('../test/httpApi.js'))
import { mount, tick, unmount } from 'svelte'
import NewProject from './NewProject.svelte'

function json(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('NewProject data-source controls', () => {
  let component

  beforeEach(() => {
    document.body.innerHTML = '<div id="target"></div>'
    vi.stubGlobal('fetch', vi.fn(async rawUrl => {
      const url = new URL(String(rawUrl), 'http://localhost')
      if (url.pathname === '/api/projects/presets/watchlists') return json([])
      if (url.pathname === '/api/ontology') {
        return json({ countries: [], event_categories: [], actor_types: [], gkg_themes: [] })
      }
      return json({})
    }))
  })

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    vi.unstubAllGlobals()
  })

  it('lets Media Cloud be toggled before a rule has collections', async () => {
    component = mount(NewProject, { target: document.getElementById('target') })
    await tick()

    const label = [...document.querySelectorAll('.toggle-label')].find(candidate =>
      candidate.textContent.includes('Media Cloud')
    )
    const checkbox = label.querySelector('input[type="checkbox"]')
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(false)

    checkbox.click()
    await tick()
    expect(checkbox.checked).toBe(true)
    expect(document.body.textContent).toContain('Add or edit a Media Cloud rule to choose its collections.')

    checkbox.click()
    await tick()
    expect(checkbox.checked).toBe(false)
  })
})
