<script>
  import { onMount } from 'svelte'
  import { api } from '../api.js'
  import { notify, teamState, teams, syncTeams } from '../stores/app.js'

  let outbox = null
  let code = ''
  let name = ''
  let label = ''
  let check = ''
  let busy = false

  async function refresh() {
    const result = await api.getTeamStatus()
    if (!result.ok) return notify('error', result.error)
    outbox = result.data.outbox
    await syncTeams()
    name = name || $teamState?.name || ''
    check = ''
    if ($teamState) {
      const health = await api.checkTeam()
      check = health.ok ? `Connected · ${health.data.item_count} archived items` : `Not connected: ${health.error}`
    }
  }
  async function act(call, done) {
    busy = true
    const result = await call()
    busy = false
    if (!result.ok) return notify('error', result.error)
    if (done) notify('success', done)
    await refresh()
    return true
  }
  async function join() {
    if (await act(() => api.addTeam({ code, name, label }), `Joined ${label.trim()}`)) { code = ''; label = '' }
  }
  const leave = team => {
    if (confirm(`Leave "${team.label}"? This only removes it from this browser. Nothing in the sheet or on disk is deleted, and you can join again with the join code.`)) act(() => api.removeTeam(team.id), `Left ${team.label}`)
  }
  async function retry() {
    await api.retryOutbox()
    await refresh()
  }
  onMount(refresh)
</script>

<section class="team-settings">
  <h2>Team projects</h2>
  <p>Each project is one Google Sheet. Saves from Canary and browser capture go to the active project. Paste the join code from the sheet's Pipeline → Team setup menu.</p>
  {#each $teams as team (team.id)}
    <div class="project" class:active={team.id === $teamState?.id}>
      <div class="info">
        <strong>{team.label}</strong>{#if team.id === $teamState?.id} <span class="tag">active</span>{/if}
        <div class="status">{new URL(team.url).host} · {team.name || 'no name'}{team.id === $teamState?.id ? ` · ${check || 'checking…'}` : ''}</div>
      </div>
      {#if team.id !== $teamState?.id}<button disabled={busy} on:click={() => act(() => api.switchTeam(team.id))}>Switch</button>{/if}
      <button disabled={busy} on:click={() => leave(team)}>Leave</button>
    </div>
  {/each}
  <h3>{$teams.length ? 'Join another project' : 'Join a project'}</h3>
  <input type="text" bind:value={code} placeholder="Join code" aria-label="Join code" />
  <input type="text" bind:value={label} placeholder="Project name" aria-label="Project name" />
  <input type="text" bind:value={name} placeholder="Your name" aria-label="Your name" />
  <button class="primary" on:click={join} disabled={busy || !code.trim() || !label.trim() || !name.trim()}>Join</button>
  {#if outbox}
    <p class="status">
      {outbox.pending} waiting · {outbox.parked} stopped{outbox.lastError ? ` · ${outbox.lastError}` : ''}
      {#if outbox.parked || outbox.lastError}<button on:click={retry}>Retry</button>{/if}
    </p>
  {/if}
</section>

<style>
  .team-settings { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 1.5rem; padding: 1.25rem 1.5rem; }
  h2 { font-size: 1rem; margin: 0 0 0.75rem !important; }
  h3 { font-size: 0.85rem; margin: 1rem 0 0.5rem; }
  .project { align-items: center; border: 1px solid var(--border); border-radius: 6px; display: flex; gap: 0.5rem; margin-bottom: 0.5rem; padding: 0.5rem 0.75rem; }
  .project.active { background: var(--accent-soft); border-color: var(--accent-light); }
  .info { flex: 1; min-width: 0; }
  .info .status { margin: 0; }
  .tag { color: var(--accent-strong); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; }
  p { color: var(--text-muted); font-size: 0.82rem; line-height: 1.5; margin: 0 0 0.75rem; }
  .status { overflow-wrap: anywhere; }
  input { margin: 0 0.5rem 0.5rem 0; max-width: 100%; width: 18rem; }
</style>
