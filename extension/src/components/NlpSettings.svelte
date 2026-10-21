<script>
  import { onMount, onDestroy } from 'svelte'
  import { api } from '../api.js'
  import { notify } from '../stores/app.js'

  const packs = [
    { id: 'ner', label: 'People, organizations and places', detail: 'Multilingual BERT · about 180 MB' },
    { id: 'sentiment', label: 'Sentiment and tone', detail: 'Multilingual DistilBERT · about 140 MB' },
  ]
  let status = null
  let busy = null
  let progress = ''
  let channel
  const state = pack => status?.models?.[pack] || { installed: !!status?.[`${pack}_present`], enabled: false }

  async function refresh() {
    const result = await api.getNlpStatus()
    if (result.ok) status = result.data
    else notify('error', result.error)
  }
  async function change(pack, action, enabled) {
    busy = pack
    progress = action === 'install' ? 'Downloading model…' : ''
    try {
      const result = action === 'install' ? await api.installNlpModel(pack)
        : action === 'remove' ? await api.removeNlpModel(pack) : await api.setNlpEnabled(pack, enabled)
      if (result.ok) status = result.data
      else notify('error', result.error)
    } finally { busy = null; progress = ''; await refresh() }
  }
  onMount(() => {
    refresh()
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('canary-nlp')
      channel.onmessage = ({ data }) => {
        if (data.pack === busy && data.status === 'progress') {
          progress = `Downloading ${data.file || 'model'}${Number.isFinite(data.progress) ? ` · ${Math.round(data.progress)}%` : ''}`
        }
      }
    }
  })
  onDestroy(() => channel?.close())
</script>

<section class="nlp-settings" aria-labelledby="nlp-title">
  <h2 id="nlp-title">On-device language analysis</h2>
  <p>Language detection runs automatically. Optional models add entities and tone to new Google News and Media Cloud items. Models are shared across projects and run locally; article text stays in this browser.</p>
  <p>Download once from Hugging Face, then use offline. Downloads need additional browser storage. Models use CPU processing, which can slow collection on older computers.</p>
  {#if status}
    {#each packs as pack}
      <div class="model-row">
        <div class="model-copy">
          <strong>{pack.label}</strong>
          <span>{pack.detail}</span>
          {#if state(pack.id).error}<span class="model-error" role="status">{state(pack.id).error}</span>{/if}
        </div>
        {#if state(pack.id).installed}
          <label><input type="checkbox" checked={state(pack.id).enabled} disabled={busy !== null} on:change={event => change(pack.id, 'enable', event.currentTarget.checked)} /> Use model</label>
          <button disabled={busy !== null} on:click={() => change(pack.id, 'remove')}>Remove</button>
        {:else}
          <button disabled={busy !== null} on:click={() => change(pack.id, 'install')}>{busy === pack.id ? 'Downloading…' : 'Download and enable'}</button>
        {/if}
      </div>
    {/each}
    {#if progress}<p class="progress" role="status">{progress}</p>{/if}
  {:else}<p role="status">Checking models…</p>{/if}
</section>

<style>
  .nlp-settings { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1.5rem; padding: 1.25rem 1.5rem; }
  h2 { font-size: 1rem; margin: 0 0 0.75rem; }
  p { color: var(--text-muted); font-size: 0.82rem; line-height: 1.5; margin: 0 0 0.75rem; }
  .model-row { align-items: center; border-top: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 0.75rem; padding: 0.85rem 0; }
  .model-copy { flex: 1; min-width: 180px; }
  .model-copy span { color: var(--text-muted); display: block; font-size: 0.78rem; margin-top: 0.2rem; }
  .model-copy .model-error { color: var(--signal); overflow-wrap: anywhere; }
  label { align-items: center; display: flex; font-size: 0.82rem; gap: 0.4rem; }
  button { background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--text); cursor: pointer; font: inherit; font-size: 0.82rem; padding: 0.4rem 0.7rem; }
  button:hover:not(:disabled) { background: var(--bg-hover); }
  button:disabled { cursor: default; opacity: 0.6; }
  .progress { margin-bottom: 0; overflow-wrap: anywhere; }
</style>
