<script>
  import { onMount, onDestroy } from 'svelte'
  import { getTeam } from '../backend/team.js'
  import { listQueue, archiveAll, releaseStaleLocks, reasonOf, getAutoArchive, setAutoArchive, openForManualCapture, listManualTabs, archiveManual, mediaLine } from '../backend/evidenceQueue.js'
  import { getArchiveOptions, setArchiveOptions } from '../backend/evidence.js'
  import { notify } from '../stores/app.js'

  const ORIGINS = { origins: ['<all_urls>'] }
  let team = null, queue = { pending: [], review: [], failed: [], done: [] }, loading = true, error = ''
  let allowed = true, auto = false, running = false, stop = false, current = null, done = 0, total = 0
  let results = {}, timer, tabs = []
  let options = { fallback: true, wayback: false, fallbackWayback: false }
  const mediaOf = (item) => mediaLine(item) || 'page only: no video, audio or images saved'

  async function load() {
    loading = true; error = ''
    try {
      team = await getTeam()
      allowed = await chrome.permissions.contains(ORIGINS)
      if (team) { queue = await listQueue(); tabs = await listManualTabs(queue) }
    } catch (e) { error = e.message }
    loading = false
  }

  // Must run from the click: Chrome only shows the prompt for a user gesture.
  async function allow() { allowed = await chrome.permissions.request(ORIGINS) }

  async function run(items) {
    if (running || !items.length) return
    running = true; stop = false; done = 0; total = items.length
    await archiveAll(items, {
      shouldStop: () => stop,
      onItem: (item, outcome) => {
        if (outcome === 'start') return (current = item)
        done += 1
        results = { ...results, [item.id]: outcome }
      }
    })
    current = null; running = false
    await load()
  }

  async function retry(item) { await run([item]) }

  // Manual capture: open the page in a normal tab, let the user get past the wall or log in, then capture that tab.
  async function openTab(item) {
    try { await openForManualCapture(item); tabs = await listManualTabs(queue) } catch (e) { error = e.message }
  }

  async function captureTab(entry) {
    if (running || !entry.item) return
    running = true; total = 0; current = entry.item
    const outcome = await archiveManual(entry)
    results = { ...results, [entry.item.id]: outcome }
    current = null; running = false
    await load()
  }

  async function toggleAuto() {
    await setAutoArchive(auto)
    if (auto && allowed) run(queue.pending)
  }

  const label = r => r.skipped ? 'Skipped: someone else is capturing it' : r.status === 'done' ? 'Archived' : r.status === 'needs_review' ? `Needs review: ${r.error || ''}` : `Failed: ${r.error || ''}`

  onMount(async () => {
    auto = await getAutoArchive()
    options = await getArchiveOptions()
    try { await releaseStaleLocks() } catch { /* not joined yet: load() explains */ }
    await load()
    if (auto && allowed) run(queue.pending)
    timer = setInterval(async () => { if (auto && allowed && !running) { await load(); run(queue.pending) } }, 60000)
  })
  onDestroy(() => { clearInterval(timer); stop = true })
</script>

<div class="archive">
  <h1>Archive</h1>
  {#if loading && !team}
    <p class="hint">Loading…</p>
  {:else if !team}
    <p class="hint">Join your team first (Team sheet in the sidebar) to archive its saved items.</p>
  {:else}
    <p class="hint">Each page is captured in a real browser tab on this computer (screenshot, PDF, MHTML, HAR, DOM, any audio or video it plays, hashes and an RFC 3161 timestamp) and saved to Downloads/Pipeline/&lt;id&gt;/. The team sheet gets only the hashes. Capturing runs only while this tab is open, one page at a time. Pages behind a bot check or a login: use Capture from my tab.</p>
    {#if !allowed}
      <p class="warn">Archiving needs permission to open and inspect any site. <button on:click={allow}>Allow access to all sites</button></p>
    {/if}
    {#if error}<p class="err">{error} <button on:click={load}>Retry</button></p>{/if}
    <div class="bar">
      <button disabled={!allowed || running || !queue.pending.length} on:click={() => run(queue.pending)}>Archive all pending ({queue.pending.length})</button>
      {#if running}<button on:click={() => (stop = true)}>Stop after this one</button>{/if}
      <label><input type="checkbox" bind:checked={auto} on:change={toggleAuto} /> Auto-archive while this tab is open</label>
      <button on:click={load} disabled={running}>Refresh</button>
    </div>
    <div class="bar hint">
      <label><input type="checkbox" bind:checked={options.fallback} on:change={() => setArchiveOptions(options)} /> When a page is blocked, save an alternate version (AMP, print, PDF) as a marked substitute</label>
      <label><input type="checkbox" bind:checked={options.fallbackWayback} disabled={!options.fallback} on:change={() => setArchiveOptions(options)} /> …and a Wayback Machine copy if no live version works</label>
      <label><input type="checkbox" bind:checked={options.wayback} on:change={() => setArchiveOptions(options)} /> Ask the Wayback Machine to save each page (sends the URL to archive.org)</label>
    </div>
    {#if running}<p class="hint">{total ? `Archiving ${done + 1} of ${total}: ` : 'Capturing tab: '}{current?.title || current?.url}</p>{/if}

    {#if tabs.length}
      <h2>Tabs waiting for capture</h2>
      <p class="hint">Solve the bot check or log in in the tab, then capture it as it stands (the tab is not reloaded).</p>
      {#each tabs as entry (entry.tabId)}
        <div class="card">
          <div><strong>{entry.title || entry.url}</strong><div class="hint">{entry.currentUrl}</div>
            {#if !entry.item}<div class="hint">Not in the team sheet yet (or already archived). Save it first, then refresh.</div>{/if}
            {#if entry.item && results[entry.item.id]}<div class:err={results[entry.item.id].status === 'failed'} class="hint">{label(results[entry.item.id])}</div>{/if}</div>
          <button disabled={!allowed || running || !entry.item} on:click={() => captureTab(entry)}>Capture this tab now</button>
        </div>
      {/each}
    {/if}

    <h2>Pending</h2>
    {#if !queue.pending.length}<p class="hint">Nothing waiting.</p>{/if}
    {#each queue.pending as item (item.id)}
      <div class="card">
        <div><strong>{item.title || item.url}</strong><div class="hint">{item.url}</div>{#if results[item.id]}<div class:err={results[item.id].status === 'failed'} class="hint">{label(results[item.id])}</div>{/if}</div>
        <div class="actions"><button disabled={!allowed || running} on:click={() => run([item])}>Archive</button>
          <button disabled={!allowed || running} title="For pages behind a bot check or a login: opens the page in a normal tab" on:click={() => openTab(item)}>Capture from my tab</button></div>
      </div>
    {/each}

    {#if queue.done?.length}
      <h2>Archived</h2>
      {#each queue.done as item (item.id)}
        <div class="card"><div><strong>{item.title || item.url}</strong><div class="hint">{item.url}</div><div class="hint">{mediaOf(item)}</div></div></div>
      {/each}
    {/if}

    {#if queue.review.length || queue.failed.length}
      <h2>Needs attention</h2>
      {#each [...queue.review, ...queue.failed] as item (item.id)}
        <div class="card">
          <div><strong>{item.title || item.url}</strong> <span class="hint">{item.status === 'failed' ? 'failed' : 'needs review'}</span><div class="hint">{item.url}</div><div class="hint">{reasonOf(item) || 'No reason recorded'}</div><div class="hint">{mediaOf(item)}</div></div>
          <div class="actions"><button disabled={!allowed || running} on:click={() => retry(item)}>Retry</button>
            <button disabled={!allowed || running} title="For pages behind a bot check or a login: opens the page in a normal tab" on:click={() => openTab(item)}>Capture from my tab</button></div>
        </div>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .archive { padding: 1.5rem 2rem; max-width: 900px }
  h1 { font-size: 1.2rem; margin: 0 0 0.75rem }
  h2 { font-size: 0.95rem; margin: 1.25rem 0 0.5rem }
  button { background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--text); cursor: pointer; font: inherit; font-size: 0.8rem; padding: 0.3rem 0.7rem }
  button:disabled { cursor: default; opacity: 0.6 }
  .card { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 12px; margin: 8px 0; border: 1px solid var(--border, #ddd); border-radius: 8px }
  .actions { display: flex; flex-direction: column; gap: 6px }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 12px 0 }
  .hint { color: var(--text-muted, #666); font-size: 13px; overflow-wrap: anywhere }
  .warn { background: #fffbeb; border: 1px solid #f4d58d; border-radius: 8px; padding: 8px 12px }
  .err { color: var(--danger, #b00020) }
</style>
