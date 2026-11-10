<script>
  import { onMount } from 'svelte'
  import { bridge } from '../backend/bridge.js'
  import { archiveState, distinct, domain, filterItems, newestFirst, savedAt, sourceType, summarize } from '../lib/library.js'

  const PAGE = 500
  const CAP = 5000 // ponytail: the sheet has no search/sort API, so we page everything client-side; past 5000 rows add server-side filtering.

  let items = []
  let loading = true
  let error = ''
  let capped = false
  let outbox = null
  let q = ''
  let savedBy = ''
  let type = ''
  let archive = ''

  async function load() {
    loading = true
    error = ''
    try {
      const all = []
      let total = Infinity
      while (all.length < total && all.length < CAP) {
        const reply = await bridge('list', { status: 'all', include_locked: 'true', limit: PAGE, offset: all.length })
        total = reply.total
        if (!reply.items.length) break
        all.push(...reply.items)
      }
      capped = total > CAP
      items = newestFirst(all)
    } catch (e) {
      error = e.message
    }
    loading = false
    refreshOutbox()
  }
  async function refreshOutbox() {
    try { outbox = await chrome.runtime.sendMessage({ type: 'pipeline:status' }) } catch { outbox = null }
  }
  async function retry() {
    try { await chrome.runtime.sendMessage({ type: 'pipeline:retry' }) } catch {}
    refreshOutbox()
  }

  onMount(() => {
    load()
    const onMessage = message => { if (message?.type === 'pipeline:delivered') load() }
    globalThis.chrome?.runtime?.onMessage?.addListener(onMessage)
    return () => globalThis.chrome?.runtime?.onMessage?.removeListener(onMessage)
  })

  $: shown = filterItems(items, { q, savedBy, type, archive })
  $: counts = summarize(items)
  $: people = distinct(items, i => i.saved_by)
  $: types = distinct(items, sourceType)
  $: queued = (outbox?.pending || 0) + (outbox?.parked || 0)
  const day = value => String(value || '').slice(0, 10)
</script>

<section class="library">
  <header>
    <h2>Library</h2>
    <button on:click={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
  </header>

  {#if queued > 0}
    <p class="notice" role="status">
      {outbox.pending} waiting to reach the team sheet{outbox.parked ? ` · ${outbox.parked} stopped` : ''}{outbox.lastError ? ` · ${outbox.lastError}` : ''}
      <button on:click={retry}>Retry</button>
    </p>
  {/if}
  {#if error}
    <p class="notice notice--error" role="alert">{error} <button on:click={load}>Try again</button></p>
  {/if}

  {#if !loading && !error && items.length === 0}
    <p class="empty">Nothing saved yet — use the Save buttons on Google, X, YouTube, Facebook or right-click any page.</p>
  {:else if items.length}
    <p class="summary">{counts.total} items · {counts.archived} archived · {counts.processed} processed{#if shown.length !== items.length} · showing {shown.length}{/if}{#if capped} · first {CAP} only{/if}</p>
    <div class="controls">
      <input type="search" bind:value={q} placeholder="Search title, URL, snippet, query" aria-label="Search the library" />
      <select bind:value={savedBy} aria-label="Saved by"><option value="">Anyone</option>{#each people as p}<option>{p}</option>{/each}</select>
      <select bind:value={type} aria-label="Source type"><option value="">All sources</option>{#each types as t}<option>{t}</option>{/each}</select>
      <select bind:value={archive} aria-label="Archive state">
        <option value="">Any archive state</option><option value="archived">Archived</option><option value="none">Not archived</option>
        <option value="needs_review">Needs review</option><option value="failed">Failed</option>
      </select>
    </div>
    <ul>
      {#each shown as item (item.id)}
        {@const state = archiveState(item)}
        <li>
          <div class="main">
            <a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a>
            <div class="meta">
              <span class="badge">{sourceType(item)}</span>
              <span>{domain(item.url)}</span>
              {#if item.saved_by}<span>· {item.saved_by}</span>{/if}
              {#if savedAt(item)}<span>· {day(savedAt(item))}</span>{/if}
            </div>
          </div>
          <div class="chips">
            <span class="chip chip--on">Sent ✓</span>
            <span class="chip" class:chip--on={state === 'archived'} class:chip--warn={state === 'needs_review'} class:chip--bad={state === 'failed'}>
              {#if state === 'archived'}Archived{item.captured_by ? ` by ${item.captured_by}` : ''}{:else if state === 'needs_review'}Archive needs review{:else if state === 'failed'}Archive failed{:else}Not archived{/if}
            </span>
            <span class="chip" class:chip--on={item.processed_at}>{item.processed_at ? 'Processed' : 'Not processed'}</span>
          </div>
        </li>
      {:else}
        <li class="empty">No items match these filters.</li>
      {/each}
    </ul>
  {:else if loading}
    <p class="empty">Loading the team's saved items…</p>
  {/if}
</section>

<style>
  .library { padding: 1.5rem 2rem; }
  header { align-items: center; display: flex; gap: 1rem; justify-content: space-between; }
  h2 { font-size: 1.2rem; margin: 0; }
  button { background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--text); cursor: pointer; font: inherit; font-size: 0.8rem; padding: 0.3rem 0.7rem; }
  button:disabled { cursor: default; opacity: 0.6; }
  .notice { background: var(--accent-soft); border: 1px solid var(--accent-light); border-radius: 6px; color: var(--accent-strong); font-size: 0.8rem; margin: 0.75rem 0 0; padding: 0.5rem 0.75rem; }
  .notice--error { background: var(--signal-soft); border-color: var(--signal); color: var(--signal); }
  .summary { color: var(--text-muted); font: 500 0.78rem var(--mono); margin: 0.75rem 0 0.5rem; }
  .empty { color: var(--text-muted); font-size: 0.9rem; margin: 2rem 0; max-width: 32rem; }
  .controls { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }
  .controls input, .controls select { background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-size: 0.8rem; padding: 0.35rem 0.5rem; }
  .controls input { flex: 1 1 16rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { align-items: center; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; justify-content: space-between; padding: 0.55rem 0; }
  li.empty { display: block; }
  .main { flex: 1 1 22rem; min-width: 0; }
  .main a { display: block; font-size: 0.88rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--text-muted); display: flex; flex-wrap: wrap; font-size: 0.75rem; gap: 0.35rem; }
  .badge { background: var(--bg-hover); border-radius: 3px; font: 500 0.68rem var(--mono); padding: 0 0.35rem; text-transform: uppercase; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .chip { border: 1px solid var(--border); border-radius: 999px; color: var(--text-muted); font-size: 0.7rem; padding: 0.05rem 0.5rem; white-space: nowrap; }
  .chip--on { background: var(--accent-soft); border-color: var(--accent-light); color: var(--accent-strong); }
  .chip--warn { background: #fff3cd; border-color: var(--canary-deep); color: var(--canary-ink); }
  .chip--bad { background: var(--signal-soft); border-color: var(--signal); color: var(--signal); }
</style>
