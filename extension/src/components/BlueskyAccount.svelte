<script>
  // The Bluesky account the lane searches as. Search needs a signed-in account, so this takes an app password,
  // which Bluesky makes for third-party apps and which cannot change the account itself.
  import { onMount } from 'svelte'
  import { api } from '../api.js'
  import { notify } from '../stores/app.js'

  let handle = null
  let checking = true
  let identifier = ''
  let password = ''
  let saving = false

  onMount(async () => {
    const result = await api.getBlueskyStatus()
    checking = false
    if (result.ok) handle = result.data.handle
  })

  async function connect() {
    if (!identifier.trim() || !password.trim()) return
    saving = true
    const result = await api.setBlueskyAccount(identifier, password)
    saving = false
    if (!result.ok) return notify('error', result.error)
    handle = result.data.handle
    password = ''
    notify('success', `Bluesky connected as @${handle}`)
  }

  async function disconnect() {
    const result = await api.clearBlueskyAccount()
    if (result.ok) handle = null
    else notify('error', result.error)
  }
</script>

<section class="bsky-account">
  <div class="heading">
    <h3>Bluesky account</h3>
    {#if handle}
      <span class="status connected">@{handle}</span>
    {:else}
      <span class="status">{checking ? 'Checking…' : 'Not connected'}</span>
    {/if}
  </div>
  {#if handle}
    <p>Searches run as this account. <button type="button" class="link" on:click={disconnect}>Remove saved account</button></p>
  {:else if !checking}
    <p>
      Bluesky only answers searches from a signed-in account. Create an
      <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener noreferrer">app password</a>
      and connect it here. It is stored in this browser only and left out of backups.
    </p>
    <div class="row">
      <input class="form-input" placeholder="you.bsky.social" autocomplete="username" aria-label="Bluesky handle" bind:value={identifier} />
      <input
        class="form-input"
        type="password"
        placeholder="xxxx-xxxx-xxxx-xxxx"
        autocomplete="off"
        aria-label="Bluesky app password"
        bind:value={password}
        on:keydown={event => event.key === 'Enter' && connect()}
      />
      <button type="button" class="connect" disabled={saving || !identifier.trim() || !password.trim()} on:click={connect}>
        {saving ? 'Checking…' : 'Connect'}
      </button>
    </div>
  {/if}
</section>

<style>
  .bsky-account { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1.25rem; padding: 0.8rem 1rem; }
  .heading { align-items: center; display: flex; gap: 1rem; justify-content: space-between; }
  h3 { font-size: 0.9rem; margin: 0; }
  p { color: var(--text-muted); font-size: 0.78rem; margin: 0.4rem 0 0; }
  .status { background: var(--bg-hover); border-radius: 999px; color: var(--text-muted); font-size: 0.72rem; padding: 0.2rem 0.55rem; white-space: nowrap; }
  .status.connected { background: #dbeafe; color: #1d4ed8; }
  .row { display: flex; gap: 0.5rem; margin-top: 0.7rem; }
  .form-input { background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--text); flex: 1; font: inherit; font-size: 0.85rem; min-width: 0; padding: 0.45rem 0.6rem; }
  .connect { background: var(--accent); border: 1px solid var(--accent); border-radius: 5px; color: white; cursor: pointer; padding: 0.42rem 0.8rem; }
  .connect:disabled { cursor: default; opacity: 0.55; }
  .link { background: none; border: 0; color: var(--text-muted); cursor: pointer; font-size: inherit; padding: 0; text-decoration: underline; }
  @media (max-width: 680px) { .row { flex-direction: column; } }
</style>
