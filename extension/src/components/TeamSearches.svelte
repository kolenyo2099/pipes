<script>
  import { onMount } from 'svelte'
  import { getTeam } from '../backend/team.js'
  import * as store from '../backend/store.js'
  import { listTeamSearches, subscribe, applyUpdate, unshare, activeLanes } from '../backend/searches.js'
  import { projects, notify } from '../stores/app.js'

  let searches = [], local = [], team = null, loading = true, error = '', busy = ''

  async function load() {
    loading = true; error = ''
    try {
      team = await getTeam()
      if (team) { searches = await listTeamSearches(); local = await store.listProjects() }
    } catch (e) { error = e.message }
    loading = false
  }
  onMount(load)

  const subscribed = s => local.find(p => p.subscribed_search?.id === s.id)
  const mine = s => local.some(p => p.shared_search_id === s.id)

  async function run(s, fn, done) {
    busy = s.id
    try { await fn(); projects.set(await store.listProjects()); notify('success', done); await load() } catch (e) { notify('error', e.message) }
    busy = ''
  }
</script>

<div class="searches">
  <h1>Team searches</h1>
  {#if loading}
    <p class="hint">Loading…</p>
  {:else if !team}
    <p class="hint">Join your team first (Team sheet in the sidebar) to see shared searches.</p>
  {:else if error}
    <p class="err">{error} <button on:click={load}>Retry</button></p>
  {:else}
    <p class="hint">Only the search setup is shared, never anyone's inbox. Each subscriber queries the sources from their own browser, so a subscription adds requests from your connection.</p>
    {#if !searches.length}<p class="hint">Nobody has shared a search yet. Share one from a project's settings.</p>{/if}
    {#each searches as s (s.id)}
      {@const sub = subscribed(s)}
      <div class="card">
        <div>
          <strong>{s.name}</strong> <span class="hint">by {s.owner || 'unknown'}</span>
          <div class="hint">{activeLanes(s.query).join(', ') || 'no lanes'} · every {s.interval_mins} min · {s.query.watchlists?.length || 0} rules · updated {new Date(s.updated_at).toLocaleString()}</div>
        </div>
        <div class="actions">
          {#if sub && sub.subscribed_search.updated_at !== s.updated_at}
            <button disabled={busy === s.id} on:click={() => run(s, () => applyUpdate(sub.project_id, s), 'Update applied')}>Update available: Apply</button>
          {:else if sub}
            <span class="hint">Subscribed</span>
          {:else if !mine(s)}
            <button disabled={busy === s.id} on:click={() => run(s, () => subscribe(s), 'Subscribed; collecting from now on')}>Subscribe</button>
          {/if}
          {#if mine(s)}
            <button disabled={busy === s.id} on:click={() => run(s, () => unshare(s), 'Stopped sharing')}>Stop sharing</button>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .searches { padding: 1.5rem 2rem; max-width: 800px }
  h1 { font-size: 1.2rem; margin: 0 0 0.75rem }
  button { background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--text); cursor: pointer; font: inherit; font-size: 0.8rem; padding: 0.3rem 0.7rem }
  button:disabled { cursor: default; opacity: 0.6 }
  .card { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 12px; margin: 8px 0; border: 1px solid var(--border, #ddd); border-radius: 8px }
  .hint { color: var(--text-muted, #666); font-size: 13px }
  .err { color: var(--danger, #b00020) }
  .actions { display: flex; gap: 8px; align-items: center }
</style>
