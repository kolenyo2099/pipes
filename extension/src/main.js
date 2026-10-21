import { mount } from 'svelte'
import App from './App.svelte'
import { inExtension } from './api.js'
import { collectDue } from './backend/collect.js'

const target = document.getElementById('app')

if (!target) {
  throw new Error('Canary application root was not found')
}

const app = mount(App, { target })

// Outside the extension (vite dev), collect on a timer while this tab is open.
if (!inExtension) {
  collectDue()
  setInterval(collectDue, 60_000)
}

export default app
