// The archive queue: the team sheet is the queue. Items without evidence are locked, captured here (evidence.js),
// written back with hashes, then unlocked. Runs in the app page, one capture at a time. Contract: docs/product-contract.md.
import { bridge as sheet } from './bridge.js'
import { archiveUrl } from './evidence.js'
import { getTeam } from './team.js'

const real = { bridge: sheet, archive: archiveUrl, team: getTeam }

export async function installId() {
  const { pipelineInstallId } = await chrome.storage.local.get('pipelineInstallId')
  if (pipelineInstallId) return pipelineInstallId
  const id = `install-${crypto.randomUUID()}`
  await chrome.storage.local.set({ pipelineInstallId: id })
  return id
}

export const getAutoArchive = async () => !!(await chrome.storage.local.get('pipelineAutoArchive')).pipelineAutoArchive
export const setAutoArchive = (on) => chrome.storage.local.set({ pipelineAutoArchive: !!on })

/** A crashed or closed tab leaves this install's locks behind; release them (no ids = all of ours). */
export async function releaseStaleLocks(deps = real) {
  return deps.bridge('unlock', { locked_by: await installId() })
}

/** Sheet items still to capture, and those that need a human look. */
export async function listQueue(deps = real) {
  const page = async (status) => (await deps.bridge('list', { status, limit: 500 })).items || []
  const [pending, review, failed] = await Promise.all([page('pending'), page('needs_review'), page('failed')])
  return { pending: pending.filter((item) => !item.evidence_hash), review, failed }
}

/** Why an item needs attention: the stored error or the quality issues. */
export const reasonOf = (item) => {
  const meta = item.result_metadata || {}
  return meta.error || (meta.capture_issues || []).map((i) => i.message).join('; ') || ''
}

/** Lock, capture, write back, unlock. Never throws: returns the capture result plus { skipped } when someone else holds it. */
export async function archiveOne(item, deps = real) {
  const by = await installId()
  const { bridge } = deps
  const lock = await bridge('lock', { ids: [item.id], locked_by: by }).catch((error) => ({ error }))
  if (lock.error) return { status: 'failed', error: lock.error.message }
  if (!lock.count) return { skipped: true, status: 'skipped', error: 'Locked by someone else' }
  let result
  try {
    result = await deps.archive({ id: item.id, url: item.url, title: item.title })
    const update = { id: item.id, status: result.status, result_metadata: { capture_issues: result.issues || [], ...(result.error && { error: result.error }) } }
    if (result.status !== 'failed') Object.assign(update, {
      evidence_hash: result.evidence_hash, evidence_files: result.evidence_files, captured_by: (await deps.team())?.name || '',
      captured_at: new Date().toISOString(), ...(result.timestamp_token && { timestamp_token: result.timestamp_token })
    })
    await bridge('updateMany', { updates: [update] })
    // Page text is a bonus: a failed upload must not undo a good capture.
    if (result.text && !item.has_text) await bridge('putText', { id: item.id, text: result.text }).catch(() => {})
  } catch (error) {
    result = { status: 'failed', error: error?.message || String(error) }
    await bridge('updateMany', { updates: [{ id: item.id, status: 'failed', result_metadata: { error: result.error } }] }).catch(() => {})
  } finally {
    await bridge('unlock', { ids: [item.id], locked_by: by }).catch(() => {})
  }
  return result
}

/** Items in order, one at a time. `onItem(item, 'start'|result)` reports progress; `shouldStop()` ends the run early. */
export async function archiveAll(items, { deps = real, onItem = () => {}, shouldStop = () => false } = {}) {
  for (const item of items) {
    if (shouldStop()) break
    onItem(item, 'start')
    onItem(item, await archiveOne(item, deps))
  }
}
