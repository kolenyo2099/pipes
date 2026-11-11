<script>
  import { onMount, onDestroy } from 'svelte'
  import { getTeam } from '../backend/team.js'
  import { listQueue, archiveAll, releaseStaleLocks, reasonOf, getAutoArchive, setAutoArchive, openForManualCapture, listManualTabs, archiveManual, mediaLine } from '../backend/evidenceQueue.js'
  import { getArchiveOptions, setArchiveOptions } from '../backend/evidence.js'
  import { folderState, chooseFolder, grantFolder, useDownloads } from '../backend/archiveFolder.js'

  const ORIGINS = { origins: ['<all_urls>'] }
  let team = null, queue = { pending: [], review: [], failed: [], done: [] }, loading = true, error = ''
  let allowed = true, auto = false, running = false, stop = false, current = null, done = 0, total = 0
  let results = {}, timer, tabs = []
  let options = { fallback: true, wayback: false, fallbackWayback: false }
  let folder = null // { name, granted } when the user picked a folder; null = Downloads/Pipeline
  $: ready = allowed && (!folder || folder.granted)
  $: tabFor = Object.fromEntries(tabs.filter((t) => t.item).map((t) => [t.item.id, t]))
  $: where = `${folder ? folder.name : 'Downloads/Pipeline'}${team?.label ? `/${team.label}` : ''}`
  const mediaOf = (item) => mediaLine(item) || 'page only: no video, audio or images saved'

  async function load() {
    loading = true; error = ''
    try {
      team = await getTeam()
      allowed = await chrome.permissions.contains(ORIGINS)
      folder = await folderState()
      if (team) { queue = await listQueue(); tabs = await listManualTabs(queue) }
    } catch (e) { error = e.message }
    loading = false
  }

  // Must run from the click: Chrome only shows the prompt for a user gesture.
  async function allow() { allowed = await chrome.permissions.request(ORIGINS) }
  async function pickFolder() { folder = (await chooseFolder()) || folder }
  async function allowFolder() { await grantFolder(); folder = await folderState() }
  async function downloadsFolder() { await useDownloads(); folder = null }
  async function refreshTabs() { if (team && !loading) tabs = await listManualTabs(queue).catch(() => tabs) }

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
    if (auto && ready) run(queue.pending)
  }

  const label = r => r.skipped ? 'Skipped: someone else is capturing it' : r.status === 'cancelled' ? r.error : r.status === 'done' ? 'Archived' : r.status === 'needs_review' ? `Needs review: ${r.error || ''}` : `Failed: ${r.error || ''}`

  onMount(async () => {
    auto = await getAutoArchive()
    options = await getArchiveOptions()
    try { await releaseStaleLocks() } catch { /* not joined yet: load() explains */ }
    await load()
    if (auto && ready) run(queue.pending)
    timer = setInterval(async () => { if (auto && ready && !running) { await load(); run(queue.pending) } }, 60000)
  })
  onDestroy(() => { clearInterval(timer); stop = true })
</script>

<!-- Closing this page mid-capture loses the capture: ask first. Coming back from a tab: see which are still open. -->
<svelte:window on:beforeunload={(e) => { if (running) e.preventDefault() }} on:focus={refreshTabs} />

{#snippet actions(item, primary)}
  <div class="actions">
    {#if tabFor[item.id]}
      <span class="hint">Open in a tab. Log in or pass the check there, then:</span>
      <button class="primary" disabled={!ready || running} on:click={() => captureTab(tabFor[item.id])}>Capture that tab now</button>
    {:else}
      <button class="primary" disabled={!ready || running} on:click={() => run([item])}>{primary}</button>
      <button class="link" disabled={!ready || running} title="Opens the page in a normal tab so you can log in or pass a bot check; then you capture that tab as you see it" on:click={() => openTab(item)}>Blocked or needs a login? Capture from my tab</button>
    {/if}
  </div>
{/snippet}

<div class="page archive">
  <h1>Archive{team?.label ? `: ${team.label}` : ''}</h1>
  {#if loading && !team}
    <p class="hint">Loading…</p>
  {:else if !team}
    <p class="hint">Join a team project first (Collaborate in the sidebar) to archive its saved items.</p>
  {:else}
    <p class="hint">Evidence of each saved page (screenshot, PDF, MHTML, HAR, DOM, its video, audio and images, hashes and an RFC 3161 timestamp) is kept on this computer. The team sheet gets only the hashes.</p>
    <ul class="hint how">
      <li><strong>Archive</strong> is the normal way: the page opens in a separate window and is captured on its own. Leave that window open until it closes itself.</li>
      <li><strong>Capture from my tab</strong> is for pages that come out blocked (a bot check, a login or cookie wall): the page opens in a normal tab, you get past the wall, then you press "Capture that tab now" here. The tab is reloaded once only if a video has to be recorded.</li>
    </ul>
    <p class="hint">Files are saved to <strong>{where}/&lt;item id&gt;/</strong>
      <button on:click={pickFolder} disabled={running}>{folder ? 'Change folder' : 'Choose another folder'}</button>
      {#if folder}<button on:click={downloadsFolder} disabled={running}>Use Downloads/Pipeline</button>{/if}</p>
    {#if folder && !folder.granted}
      <p class="warn">Chrome needs you to confirm access to the folder "{folder.name}" again. <button on:click={allowFolder}>Allow access</button></p>
    {/if}
    {#if !allowed}
      <p class="warn">Archiving needs permission to open and inspect any site. <button on:click={allow}>Allow access to all sites</button></p>
    {/if}
    {#if error}<p class="err">{error} <button on:click={load}>Retry</button></p>{/if}
    <div class="bar">
      <button disabled={!ready || running || !queue.pending.length} on:click={() => run(queue.pending)}>Archive all pending ({queue.pending.length})</button>
      {#if running}<button on:click={() => (stop = true)}>Stop after this one</button>{/if}
      <label><input type="checkbox" bind:checked={auto} on:change={toggleAuto} /> Auto-archive while this page is open</label>
      <button on:click={load} disabled={running}>Refresh</button>
    </div>
    <details class="hint">
      <summary>Options for blocked pages and the Wayback Machine</summary>
      <div class="bar">
        <label><input type="checkbox" bind:checked={options.fallback} on:change={() => setArchiveOptions(options)} /> When a page is blocked, save an alternate version (AMP, print, PDF) as a marked substitute</label>
        <label><input type="checkbox" bind:checked={options.fallbackWayback} disabled={!options.fallback} on:change={() => setArchiveOptions(options)} /> …and a Wayback Machine copy if no live version works</label>
        <label><input type="checkbox" bind:checked={options.wayback} on:change={() => setArchiveOptions(options)} /> Ask the Wayback Machine to save each page (sends the URL to archive.org)</label>
      </div>
    </details>
    {#if running}<p class="now">{total ? `Archiving ${done + 1} of ${total}: ` : 'Capturing your tab: '}{current?.title || current?.url}. Keep this page and the capture window open.</p>{/if}

    {#if tabs.some((t) => !t.item)}
      <h2>Open tabs that are not in the sheet</h2>
      {#each tabs.filter((t) => !t.item) as entry (entry.tabId)}
        <div class="card"><div><strong>{entry.title || entry.url}</strong><div class="hint">{entry.currentUrl}</div>
          <div class="hint">Not in this project's sheet yet, or already archived. Save it first, then press Refresh.</div></div></div>
      {/each}
    {/if}

    <h2>Pending</h2>
    {#if !queue.pending.length}<p class="hint">Nothing waiting.</p>{/if}
    {#each queue.pending as item (item.id)}
      <div class="card">
        <div><strong>{item.title || item.url}</strong><div class="hint">{item.url}</div>{#if results[item.id]}<div class:err={results[item.id].status === 'failed'} class="hint">{label(results[item.id])}</div>{/if}</div>
        {@render actions(item, 'Archive')}
      </div>
    {/each}

    {#if queue.review.length || queue.failed.length}
      <h2>Needs attention</h2>
      {#each [...queue.review, ...queue.failed] as item (item.id)}
        <div class="card">
          <div><strong>{item.title || item.url}</strong> <span class="hint">{item.status === 'failed' ? 'failed' : 'needs review'}</span><div class="hint">{item.url}</div><div class="hint">{reasonOf(item) || 'No reason recorded'}</div><div class="hint">{mediaOf(item)}</div>
            {#if results[item.id]}<div class:err={results[item.id].status === 'failed'} class="hint">{label(results[item.id])}</div>{/if}</div>
          {@render actions(item, 'Archive again')}
        </div>
      {/each}
    {/if}

    {#if queue.done?.length}
      <h2>Archived</h2>
      {#each queue.done as item (item.id)}
        <div class="card"><div><strong>{item.title || item.url}</strong><div class="hint">{item.url}</div><div class="hint">{mediaOf(item)}</div></div></div>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .actions { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; max-width: 330px; text-align: right; flex-shrink: 0 }
  .link { text-align: right }
  .how { margin: 0.25rem 0 0.75rem; padding-left: 1.1rem }
  .how li { margin: 0.2rem 0 }
  .now { font-weight: 600; font-size: 13px }
  details .bar { flex-direction: column; align-items: flex-start; gap: 6px }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 12px 0 }
</style>
