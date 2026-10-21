<script>
  import { onMount, onDestroy } from 'svelte'
  import { api } from '../api.js'
  import { currentProjectId } from '../stores/app.js'

  let logs = []
  let loading = false
  let cancelling = {}
  let pollTimer = null

  async function load() {
    if (!$currentProjectId) return
    loading = true
    const result = await api.getLogs($currentProjectId, 100)
    loading = false
    if (result.ok) logs = result.data
    schedulePoll()
  }

  /** Silently refresh without showing spinner — used by the live poll. */
  async function silentRefresh() {
    if (!$currentProjectId) return
    const result = await api.getLogs($currentProjectId, 100)
    if (result.ok) logs = result.data
    schedulePoll()
  }

  /** Start a 3 s poll if any log is still running; clear it otherwise. */
  function schedulePoll() {
    clearTimeout(pollTimer)
    pollTimer = null
    const hasRunning = logs.some(l => !l.finished_at)
    if (hasRunning) {
      pollTimer = setTimeout(silentRefresh, 3000)
    }
  }

  async function cancelLog(logId) {
    cancelling = { ...cancelling, [logId]: true }
    await api.cancelLog($currentProjectId, logId)
    cancelling = { ...cancelling, [logId]: false }
    await load()
  }

  function fmt(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString()
  }

  function duration(start, end) {
    if (!start || !end) return ''
    const secs = Math.round((new Date(end) - new Date(start)) / 1000)
    return secs < 60 ? `${secs}s` : `${Math.round(secs/60)}m`
  }

  onMount(load)
  onDestroy(() => clearTimeout(pollTimer))
  $: if ($currentProjectId) load()
</script>

<div class="logs-view">
  <div class="page-header">
    <h1 class="view-title">Collector Logs</h1>
    <button class="btn-refresh" on:click={load} disabled={loading}>
      {loading ? '…' : '↻ Refresh'}
    </button>
  </div>

  {#if loading && logs.length === 0}
    <div class="loading">Loading logs…</div>
  {:else if logs.length === 0}
    <div class="empty-state">No collector logs yet. Trigger a collection run to get started.</div>
  {:else}
    <table class="log-table">
      <thead>
        <tr>
          <th>Lane</th>
          <th>Started</th>
          <th>Duration</th>
          <th title="GDELT files, Google News searches, or Media Cloud runs completed">Checked</th>
          <th title="Items that matched the project's monitoring rules">Matched</th>
          <th>New</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {#each logs as log}
          <tr class:error-row={!!log.error}>
            <td><span class="lane-badge lane-badge--{log.lane}">{log.lane}</span></td>
            <td class="mono">{fmt(log.started_at)}</td>
            <td class="mono">{duration(log.started_at, log.finished_at)}</td>
            <td>{log.checked_count ?? '—'}</td>
            <td>{log.fetch_count}</td>
            <td class:highlight-new={log.new_count > 0}>{log.new_count}</td>
            <td>
              {#if log.error}
                <span class="status-error" title={log.error}>⚠ Error</span>
              {:else if log.finished_at}
                <span class="status-ok">✓ OK</span>
              {:else}
                <span class="status-running">⟳ Running</span>
                <button
                  class="btn-cancel"
                  disabled={cancelling[log.log_id]}
                  on:click={() => cancelLog(log.log_id)}
                  title="Cancel collection"
                >{cancelling[log.log_id] ? '…' : '✕'}</button>
              {/if}
            </td>
          </tr>
          {#if log.error}
            <tr class="error-detail-row">
              <td colspan="6">
                <code class="error-text">{log.error}</code>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .logs-view { max-width: 900px; padding: 1.5rem 2rem; }
  .page-header { align-items: center; display: flex; gap: 1rem; justify-content: space-between; margin-bottom: 1.25rem; }
  .view-title { font-size: 1.3rem; font-weight: 700; margin: 0; }
  .btn-refresh { background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-muted); cursor: pointer; font-size: 0.78rem; padding: 0.3rem 0.7rem; }
  .btn-refresh:hover { background: var(--bg-hover); }
  .loading, .empty-state { color: var(--text-muted); font-size: 0.9rem; padding: 2rem; }
  .log-table { border-collapse: collapse; font-size: 0.82rem; width: 100%; }
  .log-table th { border-bottom: 2px solid var(--border); color: var(--text-muted); font-size: 0.72rem; font-weight: 600; padding: 0.5rem 0.7rem; text-align: left; text-transform: uppercase; }
  .log-table td { border-bottom: 1px solid var(--border-light); padding: 0.5rem 0.7rem; vertical-align: top; }
  .log-table tr:hover td { background: var(--bg-hover); }
  .error-row td { background: #fff5f5; }
  .error-detail-row td { background: #fff5f5; padding: 0 0.7rem 0.5rem; }
  .error-text { color: #dc2626; font-size: 0.72rem; word-break: break-all; }
  .lane-badge { border-radius: 3px; font-size: 0.68rem; font-weight: 600; padding: 0.15rem 0.4rem; }
  .lane-badge--events { background: var(--accent-soft); color: var(--accent-strong); }
  .lane-badge--doc { background: #d1fae5; color: #065f46; }
  .lane-badge--gkg { background: #ede9fe; color: #5b21b6; }
  .lane-badge--rss { background: var(--accent-soft); color: var(--accent-strong); }
  .lane-badge--mediacloud { background: #ede9fe; color: #5b21b6; }
  .lane-badge--x { background: #e5e7eb; color: #111827; }
  .lane-badge--bluesky { background: #dbeafe; color: #1d4ed8; }
  .lane-badge--telegram { background: #e0f2fe; color: #0369a1; }
  .mono { font-family: monospace; font-size: 0.78rem; }
  .highlight-new { color: #16a34a; font-weight: 600; }
  .status-ok { color: #16a34a; font-size: 0.8rem; }
  .status-error { color: #dc2626; cursor: help; font-size: 0.8rem; }
  .status-running { color: #f59e0b; font-size: 0.8rem; }
  .btn-cancel { background: none; border: 1px solid #f59e0b; border-radius: 3px; color: #f59e0b; cursor: pointer; font-size: 0.65rem; line-height: 1; margin-left: 0.4rem; padding: 0.1rem 0.35rem; vertical-align: middle; }
  .btn-cancel:hover:not(:disabled) { background: #fff7ed; }
  .btn-cancel:disabled { cursor: default; opacity: 0.5; }
</style>
