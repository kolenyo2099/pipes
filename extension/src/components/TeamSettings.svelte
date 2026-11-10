<script>
  import { onMount } from 'svelte'
  import { api } from '../api.js'
  import { notify, teamState } from '../stores/app.js'

  let team = null
  let outbox = null
  let code = ''
  let name = ''
  let check = ''
  let busy = false

  async function refresh() {
    const result = await api.getTeamStatus()
    if (!result.ok) return notify('error', result.error)
    ;({ team, outbox } = result.data)
    teamState.set(team)
    name = team?.name || name
    check = ''
    if (team) {
      const health = await api.checkTeam()
      check = health.ok ? `Connected · ${health.data.item_count} archived items` : `Not connected: ${health.error}`
    }
  }
  async function save() {
    busy = true
    const result = await api.saveTeam({ code, name })
    busy = false
    if (!result.ok) return notify('error', result.error)
    code = ''
    notify('success', 'Team saved')
    await refresh()
  }
  async function retry() {
    await api.retryOutbox()
    await refresh()
  }
  onMount(refresh)
</script>

<section class="team-settings">
  <h2>Team</h2>
  <p>Saves from Canary and browser capture go to your team's Google Sheet. Paste the join code from the sheet's Pipeline → Team setup menu.</p>
  {#if team}
    <p class="status">{new URL(team.url).host} · {team.name || 'no name'} · {check || 'checking…'}</p>
  {/if}
  <input type="text" bind:value={code} placeholder={team ? 'Paste a new join code to change team' : 'Join code'} aria-label="Join code" />
  <input type="text" bind:value={name} placeholder="Your name" aria-label="Your name" />
  <button on:click={save} disabled={busy || !name.trim() || (!code.trim() && !team)}>Save</button>
  {#if outbox}
    <p class="status">
      {outbox.pending} waiting · {outbox.parked} stopped{outbox.lastError ? ` · ${outbox.lastError}` : ''}
      {#if outbox.parked || outbox.lastError}<button on:click={retry}>Retry</button>{/if}
    </p>
  {/if}
</section>

<style>
  .team-settings { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1.5rem; padding: 1.25rem 1.5rem; }
  h2 { font-size: 1rem; margin: 0 0 0.75rem; }
  p { color: var(--text-muted); font-size: 0.82rem; line-height: 1.5; margin: 0 0 0.75rem; }
  .status { overflow-wrap: anywhere; }
  input { background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font: inherit; font-size: 0.82rem; margin: 0 0.5rem 0.5rem 0; padding: 0.4rem 0.6rem; width: 18rem; max-width: 100%; }
  button { background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--text); cursor: pointer; font: inherit; font-size: 0.82rem; padding: 0.4rem 0.7rem; }
  button:disabled { cursor: default; opacity: 0.6; }
</style>
