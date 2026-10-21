// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
vi.mock('../api.js', () => import('../test/httpApi.js'))
import Saved from './Saved.svelte'
import { currentProjectId } from '../stores/app.js'

describe('archiving in the extension', () => {
  let component

  beforeEach(() => {
    document.body.innerHTML = '<div id="saved"></div>'
    currentProjectId.set('project-1')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0, has_more: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
  })

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    currentProjectId.set(null)
    vi.unstubAllGlobals()
  })

  it('explains that captures use this browser session', async () => {
    component = mount(Saved, { target: document.getElementById('saved') })
    await tick()
    expect(document.body.textContent).toContain('with your own cookies and logins')
    expect(document.querySelector('.cookie-toggle')).toBeNull()
  })
})
