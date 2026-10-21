<script>
  import { onMount } from 'svelte'
  import { api } from '../api.js'
  import { notify } from '../stores/app.js'

  export let selectedCountries = []
  export let countryOptions = []
  export let collections = []
  export let title = 'Media Cloud collections'
  export let description = 'Search curated source collections and choose which ones this rule should probe daily.'
  export let embedded = false
  export let onCollectionsChange = () => {}

  let configured = false
  let checkingStatus = true
  let credentialSource = 'local'
  let token = ''
  let savingToken = false
  let searchText = ''
  let searching = false
  let results = []
  let error = ''
  let searchCompleted = false
  let searchSequence = 0
  const numberFormat = new Intl.NumberFormat()

  $: countryNames = selectedCountries.map(code =>
    countryOptions.find(country => country.code === code)?.name || code
  )
  $: selectedIds = new Set(collections.map(collection => collection.id))

  onMount(refreshStatus)

  async function refreshStatus() {
    const result = await api.getMediaCloudStatus()
    checkingStatus = false
    if (result.ok) {
      configured = result.data.configured
      credentialSource = result.data.source || 'local'
    } else {
      error = 'Could not read Media Cloud settings. Try reopening project settings.'
    }
  }

  async function saveToken() {
    if (!token.trim()) return
    savingToken = true
    const result = await api.setMediaCloudToken(token.trim())
    savingToken = false
    if (result.ok) {
      configured = true
      credentialSource = 'local'
      token = ''
      notify('success', 'Media Cloud connected')
      if (countryNames[0]) search(countryNames[0])
    } else {
      notify('error', result.error)
    }
  }

  async function disconnect() {
    if (credentialSource === 'environment') return
    const result = await api.clearMediaCloudToken()
    if (result.ok) {
      configured = false
      results = []
      notify('info', 'Media Cloud disconnected')
    } else {
      notify('error', result.error)
    }
  }

  async function search(value = searchText) {
    const query = value.trim()
    if (!query || !configured) return
    searchText = query
    searching = true
    searchCompleted = false
    error = ''
    const sequence = ++searchSequence
    const result = await api.searchMediaCloudCollections(query)
    if (sequence !== searchSequence) return
    searching = false
    searchCompleted = true
    if (result.ok) {
      results = result.data.collections || []
    } else {
      error = `${result.error}. Check the connection and try again.`
    }
  }

  function toggleCollection(collection) {
    if (selectedIds.has(collection.id)) {
      collections = collections.filter(row => row.id !== collection.id)
    } else {
      collections = [...collections, collection]
    }
    onCollectionsChange(collections)
  }
</script>

<section class="mc-config" class:embedded>
  <div class="mc-heading">
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
    {#if configured}
      <span class="status connected">Connected</span>
    {:else if checkingStatus}
      <span class="status">Checking…</span>
    {:else}
      <span class="status">Not connected</span>
    {/if}
  </div>

  {#if !configured}
    <div class="credential-row">
      <input
        type="password"
        class="form-input token-input"
        placeholder="Media Cloud API token"
        autocomplete="off"
        aria-label="Media Cloud API token"
        maxlength="512"
        bind:value={token}
        on:keydown={event => event.key === 'Enter' && saveToken()}
      />
      <button type="button" class="mc-button primary" disabled={savingToken || !token.trim()} on:click={saveToken}>
        {savingToken ? 'Checking…' : 'Connect'}
      </button>
    </div>
    <p class="hint">The token is stored once in Canary's local application database, not in individual projects.</p>
  {:else}
    <div class="country-shortcuts">
      {#each countryNames as name}
        <button type="button" class="mc-button" on:click={() => search(name)}>{name}</button>
      {/each}
      {#if countryNames.length === 0}<span class="hint">Select project countries first.</span>{/if}
    </div>

    <div class="search-row">
      <input
        type="search"
        class="form-input"
        placeholder="Search collections by country or topic…"
        aria-label="Search Media Cloud collections"
        maxlength="120"
        bind:value={searchText}
        on:keydown={event => event.key === 'Enter' && search()}
      />
      <button type="button" class="mc-button primary" disabled={searching || !searchText.trim()} on:click={() => search()}>
        {searching ? 'Searching…' : 'Search'}
      </button>
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if collections.length > 0}
      <div class="selected-list" aria-label="Selected Media Cloud collections">
        {#each collections as collection}
          <button type="button" class="selected-chip" on:click={() => toggleCollection(collection)} title="Remove collection">
            {collection.name}<span>×</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if results.length > 0}
      <div class="results">
        {#each results as collection}
          <label class:legacy={!collection.monitored}>
            <input
              type="checkbox"
              checked={selectedIds.has(collection.id)}
              on:change={() => toggleCollection(collection)}
            />
            <span class="collection-name">{collection.name}</span>
            {#if collection.source_count != null}<span class="source-count">{numberFormat.format(collection.source_count)} sources</span>{/if}
            {#if !collection.monitored}<span class="legacy-label">not monitored</span>{/if}
          </label>
        {/each}
      </div>
    {:else if searchCompleted && !error}
      <div class="empty-result" role="status">
        No collections matched “{searchText}”. Try the full country name or a broader topic.
      </div>
    {/if}

    {#if credentialSource !== 'environment'}
      <button type="button" class="disconnect" on:click={disconnect}>Remove saved Media Cloud token</button>
    {/if}
  {/if}
</section>

<style>
  .mc-config { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-top: 1rem; }
  .mc-config.embedded { margin-top: 0; }
  .mc-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
  h3 { margin: 0 0 0.25rem; font-size: 0.95rem; }
  p { margin: 0; color: var(--text-muted); font-size: 0.8rem; }
  .status { border-radius: 999px; padding: 0.2rem 0.55rem; background: var(--bg-hover); color: var(--text-muted); font-size: 0.72rem; white-space: nowrap; }
  .status.connected { color: #047857; background: #d1fae5; }
  .credential-row, .search-row { display: flex; gap: 0.5rem; margin-top: 0.8rem; }
  .credential-row input, .search-row input { flex: 1; }
  .form-input { min-width: 0; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-card); color: var(--text); font: inherit; font-size: 0.85rem; padding: 0.48rem 0.6rem; }
  .token-input { font-family: monospace; }
  .hint { display: inline-block; margin-top: 0.45rem; color: var(--text-muted); font-size: 0.72rem; }
  .mc-button { border: 1px solid var(--border); border-radius: 5px; background: var(--bg-hover); color: var(--text); padding: 0.42rem 0.7rem; cursor: pointer; }
  .mc-button.primary { background: var(--accent); border-color: var(--accent); color: white; }
  .mc-button:disabled { cursor: default; opacity: 0.55; }
  .country-shortcuts { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.8rem; }
  .selected-list { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.75rem; }
  .selected-chip { max-width: 100%; overflow-wrap: anywhere; border: 1px solid rgba(99,102,241,0.45); border-radius: 999px; background: rgba(99,102,241,0.12); color: var(--text); padding: 0.25rem 0.55rem; cursor: pointer; }
  .selected-chip span { margin-left: 0.35rem; color: var(--text-muted); }
  .results { max-height: 16rem; overflow: auto; border: 1px solid var(--border); border-radius: 6px; margin-top: 0.75rem; }
  .results label { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 0.5rem; padding: 0.52rem 0.6rem; border-bottom: 1px solid var(--border); cursor: pointer; }
  .results label:last-child { border-bottom: 0; }
  .results label.legacy { opacity: 0.58; }
  .collection-name { min-width: 0; overflow-wrap: anywhere; }
  .source-count, .legacy-label { color: var(--text-muted); font-size: 0.7rem; }
  .legacy-label { color: #fbbf24; }
  .error { color: #b91c1c; margin-top: 0.5rem; }
  .empty-result { margin-top: 0.75rem; border: 1px dashed var(--border); border-radius: 6px; color: var(--text-muted); padding: 0.75rem; }
  .disconnect { margin-top: 0.8rem; border: 0; background: transparent; color: var(--text-muted); text-decoration: underline; cursor: pointer; font-size: 0.72rem; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 680px) {
    .mc-heading, .credential-row, .search-row { align-items: stretch; flex-direction: column; }
    .status { align-self: flex-start; }
    .results label { grid-template-columns: auto minmax(0, 1fr); }
    .source-count, .legacy-label { grid-column: 2; }
  }
</style>
