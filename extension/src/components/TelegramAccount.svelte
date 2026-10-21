<script>
  // The Telegram user API is optional. Canary creates the session locally in its offscreen document;
  // only the account holder enters the one-time code and any 2-step verification password.
  import { onMount } from 'svelte'
  import { api, inExtension } from '../api.js'
  import { notify } from '../stores/app.js'

  let status = { connected: false, handle: null, pending: null, error: null }
  let checking = true
  let stage = 'details'
  let apiId = ''
  let apiHash = ''
  let phone = ''
  let code = ''
  let password = ''
  let delivery = ''
  let saving = false

  async function load() {
    const result = await api.getTelegramStatus()
    checking = false
    // The standalone Vite preview has no offscreen extension document. Keep its
    // setup screen usable; an actual extension failure should still be visible.
    if (!result.ok) {
      if (inExtension) notify('error', result.error)
      return
    }
    status = result.data
    if (status.connected) stage = 'connected'
    else if (status.pending === 'code') stage = 'code'
    else if (status.pending === 'password') stage = 'password'
  }

  onMount(load)

  async function begin() {
    saving = true
    const result = await api.beginTelegramConnect({ apiId, apiHash, phone })
    saving = false
    if (!result.ok) return notify('error', result.error)
    stage = result.data.stage
    delivery = result.data.delivery
  }

  async function submitCode() {
    saving = true
    const result = await api.finishTelegramCode(code)
    saving = false
    if (!result.ok) return notify('error', result.error)
    if (result.data.stage === 'password') { stage = 'password'; code = ''; return }
    connected(result.data)
  }

  async function submitPassword() {
    saving = true
    const result = await api.finishTelegramPassword(password)
    saving = false
    if (!result.ok) return notify('error', result.error)
    connected(result.data)
  }

  function connected(data) {
    status = { connected: true, handle: data.handle, pending: null, error: null }
    stage = 'connected'
    apiHash = ''
    code = ''
    password = ''
    notify('success', `Telegram connected as ${data.handle}`)
  }

  async function cancel() {
    const result = await api.cancelTelegramConnect()
    if (!result.ok) return notify('error', result.error)
    stage = 'details'
    code = ''
    password = ''
  }

  async function disconnect() {
    const result = await api.clearTelegramAccount()
    if (!result.ok) return notify('error', result.error)
    status = { connected: false, handle: null, pending: null, error: null }
    stage = 'details'
  }
</script>

<section class="telegram-account" aria-busy={checking || saving}>
  <div class="heading">
    <div>
      <h3>Telegram API account</h3>
      <p class="subhead">Optional, local-only access for reliable channel monitoring.</p>
    </div>
    {#if status.connected}
      <span class="status connected">{status.handle}</span>
    {:else}
      <span class="status">{checking ? 'Checking…' : 'Not connected'}</span>
    {/if}
  </div>

  {#if stage === 'connected'}
    <p class="explanation">Canary reads Telegram directly from this Chrome profile. It stops when Chrome is closed; the next run catches up from each rule’s start time.</p>
    <button type="button" class="link" on:click={disconnect}>Remove saved Telegram account</button>
  {:else if !checking}
    <p class="explanation">Create an API ID and hash in Telegram’s <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer">API development tools</a>. They and the signed-in session stay in this browser and are excluded from Canary backups.</p>

    {#if stage === 'details'}
      <div class="fields">
        <label>
          <span>API ID</span>
          <input class="form-input" inputmode="numeric" autocomplete="off" placeholder="e.g. 123456" bind:value={apiId} />
        </label>
        <label>
          <span>API hash</span>
          <input class="form-input" type="password" autocomplete="off" placeholder="Telegram API hash" bind:value={apiHash} />
        </label>
        <label class="wide">
          <span>Phone number</span>
          <input class="form-input" type="tel" autocomplete="tel" placeholder="+31 6 1234 5678" bind:value={phone} on:keydown={event => event.key === 'Enter' && begin()} />
        </label>
      </div>
      <button type="button" class="connect" disabled={saving || !apiId.trim() || !apiHash.trim() || !phone.trim()} on:click={begin}>
        {saving ? 'Contacting Telegram…' : 'Send sign-in code'}
      </button>
    {:else if stage === 'code'}
      <div class="step">
        <label for="telegram-code">Telegram sign-in code</label>
        <p>Telegram sent a code to {delivery || 'your account'}. Enter it here; never paste it into chat or save it elsewhere.</p>
        <div class="row">
          <input id="telegram-code" class="form-input" inputmode="numeric" autocomplete="one-time-code" placeholder="Code" bind:value={code} on:keydown={event => event.key === 'Enter' && submitCode()} />
          <button type="button" class="connect" disabled={saving || !code.trim()} on:click={submitCode}>{saving ? 'Checking…' : 'Continue'}</button>
        </div>
        <button type="button" class="link" on:click={cancel}>Use different details</button>
      </div>
    {:else if stage === 'password'}
      <div class="step">
        <label for="telegram-password">2-step verification password</label>
        <p>Your Telegram account requires its extra password.</p>
        <div class="row">
          <input id="telegram-password" class="form-input" type="password" autocomplete="current-password" placeholder="Password" bind:value={password} on:keydown={event => event.key === 'Enter' && submitPassword()} />
          <button type="button" class="connect" disabled={saving || !password} on:click={submitPassword}>{saving ? 'Checking…' : 'Connect'}</button>
        </div>
        <button type="button" class="link" on:click={cancel}>Cancel connection</button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .telegram-account { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1.25rem; padding: 0.9rem 1rem; }
  .heading { align-items: flex-start; display: flex; gap: 1rem; justify-content: space-between; }
  h3 { font-size: 0.9rem; margin: 0; }
  .subhead { color: var(--text-muted); font-size: 0.72rem; margin: 0.18rem 0 0; }
  .explanation, .step p { color: var(--text-muted); font-size: 0.78rem; line-height: 1.45; margin: 0.65rem 0 0; max-width: 72ch; }
  .status { background: var(--bg-hover); border-radius: 999px; color: var(--text-muted); flex: 0 0 auto; font-size: 0.72rem; padding: 0.2rem 0.55rem; white-space: nowrap; }
  .status.connected { background: #e0f2fe; color: #0369a1; }
  .fields { display: grid; gap: 0.55rem; grid-template-columns: 0.8fr 1.2fr; margin-top: 0.8rem; }
  label { color: var(--text-muted); display: grid; font-size: 0.72rem; gap: 0.25rem; }
  .wide { grid-column: 1 / -1; }
  .form-input { background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font: inherit; font-size: 0.85rem; min-width: 0; padding: 0.45rem 0.6rem; }
  .form-input:focus { border-color: var(--accent); outline: 2px solid color-mix(in srgb, var(--accent) 25%, transparent); outline-offset: 1px; }
  .connect { background: var(--accent); border: 1px solid var(--accent); border-radius: 5px; color: white; cursor: pointer; margin-top: 0.7rem; padding: 0.42rem 0.8rem; }
  .connect:disabled { cursor: default; opacity: 0.55; }
  .step { margin-top: 0.8rem; }
  .row { align-items: end; display: flex; gap: 0.5rem; }
  .row .form-input { flex: 1; }
  .row .connect { margin-top: 0; }
  .link { background: none; border: 0; color: var(--text-muted); cursor: pointer; display: inline; font: inherit; font-size: 0.78rem; margin-top: 0.6rem; padding: 0; text-decoration: underline; }
  @media (max-width: 680px) { .fields { grid-template-columns: 1fr; } .wide { grid-column: auto; } .row { align-items: stretch; flex-direction: column; } }
</style>
