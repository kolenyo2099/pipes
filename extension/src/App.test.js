// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./api.js', () => import('./test/httpApi.js'))
import { mount, unmount } from 'svelte'
import App from './App.svelte'
import About from './components/About.svelte'
import { aboutOpen, clearFilters, filters } from './stores/app.js'

describe('application bootstrap', () => {
  let app

  beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('fetch', vi.fn(async url => {
      const data = String(url).endsWith('/ontology') ? {} : []
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
  })

  afterEach(async () => {
    if (app) await unmount(app)
    app = undefined
    aboutOpen.set(false)
    clearFilters()
    vi.unstubAllGlobals()
  })

  it('mounts and renders the first-run screen', async () => {
    app = mount(App, { target: document.getElementById('app') })
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Welcome to Canary')
    })
  })

  it('keeps shared filters visible and clearable outside their source view', async () => {
    filters.update(f => ({ ...f, person: 'Ada Lovelace' }))
    app = mount(App, { target: document.getElementById('app') })

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Filters active')
    })
    document.querySelector('button[aria-label="Clear all active filters"]')?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain('Filters active')
    })
  })

  it('renders the current attribution and contact address', () => {
    aboutOpen.set(true)
    app = mount(About, { target: document.getElementById('app') })

    expect(document.body.textContent).toContain(
      'Canary was vibecoded with care by Guillen Torres, Investigations Lab,'
    )
    expect(document.querySelector('a[href="mailto:info@osinv.org"]')?.textContent)
      .toBe('info@osinv.org')
  })
})
