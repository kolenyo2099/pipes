<script>
  import { onMount } from 'svelte'
  import { bridge } from '../backend/bridge.js'
  import { trustedExplorerUrl } from './explorerUrl.js'

  let status = null
  let error = ''
  let loading = true

  onMount(async () => {
    try { status = (await bridge('getStatus')).status || {} } catch (e) { error = e.message }
    loading = false
  })

  // Values arrive from the sheet as strings.
  $: trusted = trustedExplorerUrl(status?.explorer_url)
  $: failed = status && (status.ok === false || String(status.ok).toLowerCase() === 'false')
  $: ago = (() => {
    const t = Date.parse(status?.finished_at)
    if (!t) return ''
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
    return mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`
  })()
</script>

<section class="explore">
  {#if loading}
    <p class="note">Loading the explorer…</p>
  {:else if error}
    <p class="note note--error" role="alert">{error}</p>
  {:else if !status?.explorer_url}
    <div class="note">
      <h2>Explore</h2>
      <p>The first automatic run has not finished yet, so there is no explorer to show. It starts after the first saves reach the team sheet, and needs the GitHub secrets set up (ask the team admin: Pipeline → Connect GitHub in the sheet).</p>
    </div>
  {:else if !trusted}
    <div class="note">
      <h2>Explore</h2>
      <p>The team sheet names an explorer address that Pipeline does not trust, so it is not shown. Only https addresses on github.io are used.</p>
      <p><code>{status.explorer_url}</code></p>
    </div>
  {:else}
    <header>
      <strong>Explore</strong>
      <span>{ago ? `Last run ${ago}` : 'Not run yet'}{status.articles_total ? ` · ${status.articles_total} articles` : ''}</span>
      <a href={status.explorer_url} target="_blank" rel="noreferrer">Open in new tab ↗</a>
    </header>
    {#if failed}
      <p class="banner" role="alert">The last pipeline run failed{status.error ? `: ${status.error}` : ''}. The explorer below may be out of date.</p>
    {/if}
    <!-- ponytail: the explorer is a public GitHub Pages site and the extension CSP forbids loading remote scripts directly, so it goes in a sandboxed iframe; if frames are ever blocked, fall back to the new-tab link. -->
    <iframe title="Pipeline explorer" src={status.explorer_url} sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
  {/if}
</section>

<style>
  .explore { display: flex; flex-direction: column; height: 100vh; }
  header { align-items: baseline; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; font-size: 0.82rem; gap: 1rem; padding: 0.6rem 1.25rem; }
  header span { color: var(--text-muted); flex: 1; }
  .banner { background: var(--signal-soft); border-bottom: 1px solid var(--signal); color: var(--signal); font-size: 0.8rem; margin: 0; padding: 0.5rem 1.25rem; }
  iframe { background: white; border: 0; flex: 1; width: 100%; }
  .note { color: var(--text-muted); font-size: 0.88rem; max-width: 34rem; padding: 1.5rem 2rem; }
  .note h2 { color: var(--text); font-size: 1.2rem; margin: 0 0 0.5rem; }
  .note--error { color: var(--signal); }
</style>
