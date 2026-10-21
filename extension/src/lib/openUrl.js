import { api } from '../api.js'
import { notify } from '../stores/app.js'

export async function openUrl(url) {
  if (!url) return
  notify('info', '↗ Opening link…', 3000)
  const result = await api.openUrl(url)
  if (!result.ok || !result.data?.ok) {
    notify('error', 'Could not open link: ' + (result.error || result.data?.error || 'unknown error'), 5000)
  }
}
