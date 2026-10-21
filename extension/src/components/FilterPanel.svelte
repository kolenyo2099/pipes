<script>
  import { onMount } from 'svelte'
  import { filters, clearFilters, currentProject, currentProjectId } from '../stores/app.js'
  import { api } from '../api.js'

  // 'inbox' | 'dismissed' | 'saved'
  export let view = 'inbox'
  // Unique tags from loaded saved items (for pill display)
  export let allTags = []

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function updateFilter(key, value) {
    filters.update(f => ({ ...f, [key]: value, offset: 0 }))
  }

  function setSince(preset) {
    const now = new Date()
    let since = ''
    if (preset === '24h') {
      now.setHours(now.getHours() - 24)
      since = now.toISOString()
    } else if (preset === '72h') {
      now.setHours(now.getHours() - 72)
      since = now.toISOString()
    } else if (preset === '7d') {
      now.setDate(now.getDate() - 7)
      since = now.toISOString()
    }
    filters.update(f => ({ ...f, since, offset: 0 }))
  }

  // Which date preset button is active
  function activeDatePreset(since) {
    if (!since) return ''
    const now = Date.now()
    const diff = now - new Date(since).getTime()
    const hrs = diff / 3_600_000
    if (hrs <= 25) return '24h'
    if (hrs <= 73) return '72h'
    if (hrs <= 169) return '7d'
    return ''
  }

  function clearAll() {
    clearFilters()
  }

  $: buckets = ($currentProject?.watchlists || []).map(w => w.bucket_name)
  $: datePreset = activeDatePreset($filters.since)

  // Countries input — debounce to avoid a fetch on every keystroke
  let countriesInput = $filters.countries
  let _countriesTimer = null
  function onCountriesInput(e) {
    countriesInput = e.target.value
    clearTimeout(_countriesTimer)
    _countriesTimer = setTimeout(() => {
      updateFilter('countries', countriesInput.trim())
    }, 400)
  }

  // Keep local input in sync when filters are cleared externally
  $: countriesInput = $filters.countries

  // ── GKG filter helpers ───────────────────────────────────────────────────────

  // Tone presets: set toneMin and toneMax together
  function setTonePreset(preset) {
    if (preset === 'very_neg') {
      filters.update(f => ({ ...f, toneMin: '', toneMax: '-5', offset: 0 }))
    } else if (preset === 'neg') {
      filters.update(f => ({ ...f, toneMin: '', toneMax: '0', offset: 0 }))
    } else {
      filters.update(f => ({ ...f, toneMin: '', toneMax: '', offset: 0 }))
    }
  }

  function activeTonePreset(min, max) {
    if (max === '-5' && !min) return 'very_neg'
    if (max === '0' && !min) return 'neg'
    return ''
  }

  // Count type toggle: comma-joined multi-select.
  // Types are loaded dynamically from the project's actual GKG data via the API.
  let availableCountTypes = []
  async function loadCountTypes(projectId) {
    if (!projectId) { availableCountTypes = []; return }
    const result = await api.getGkgCountTypes(projectId)
    availableCountTypes = result.ok ? (result.data?.count_types ?? []) : []
  }
  onMount(() => loadCountTypes($currentProjectId))
  $: loadCountTypes($currentProjectId)
  function toggleCountType(type) {
    filters.update(f => {
      const current = f.countType ? f.countType.split(',').map(s => s.trim()).filter(Boolean) : []
      const idx = current.indexOf(type)
      let next
      if (idx >= 0) {
        next = current.filter(t => t !== type)
      } else {
        next = [...current, type]
      }
      return { ...f, countType: next.join(','), offset: 0 }
    })
  }
  function isCountTypeActive(countType, type) {
    return countType ? countType.split(',').map(s => s.trim()).includes(type) : false
  }

  // Debounced text inputs for person, organization, location
  let personInput = $filters.person
  let organizationInput = $filters.organization
  let locationInput = $filters.locationText
  let _personTimer = null
  let _orgTimer = null
  let _locationTimer = null

  function onPersonInput(e) {
    personInput = e.target.value
    clearTimeout(_personTimer)
    _personTimer = setTimeout(() => updateFilter('person', personInput.trim()), 400)
  }
  function onOrgInput(e) {
    organizationInput = e.target.value
    clearTimeout(_orgTimer)
    _orgTimer = setTimeout(() => updateFilter('organization', organizationInput.trim()), 400)
  }
  function onLocationInput(e) {
    locationInput = e.target.value
    clearTimeout(_locationTimer)
    _locationTimer = setTimeout(() => updateFilter('locationText', locationInput.trim()), 400)
  }

  // Keep in sync when filters are cleared externally
  $: personInput = $filters.person
  $: organizationInput = $filters.organization
  $: locationInput = $filters.locationText
</script>

<aside class="filter-panel">
  <div class="panel-title">Filters</div>

  <!-- Title search (Inbox / Dismissed views) -->
  {#if view !== 'saved'}
    <div class="panel-section">
      <div class="panel-label">Title search</div>
      <input
        class="panel-input"
        type="search"
        placeholder="Search titles…"
        value={$filters.titleSearch}
        on:input={e => updateFilter('titleSearch', e.target.value)}
      />
    </div>
  {/if}

  <!-- Date Range -->
  <div class="panel-section">
    <div class="panel-label">Date range</div>
    <div class="btn-group">
      {#each [['24h','24h'], ['72h','3d'], ['7d','7d'], ['','All']] as [preset, label]}
        <button
          class="btn-toggle"
          class:active={preset === '' ? $filters.since === '' : datePreset === preset}
          on:click={() => setSince(preset)}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Source -->
  <div class="panel-section">
    <div class="panel-label">Source</div>
    <div class="btn-group">
      {#each [['', 'All'], ['events', 'Events'], ['gkg', 'GKG'], ['rss', 'RSS'], ['mediacloud', 'Media Cloud'], ['x', 'X'], ['bluesky', 'Bluesky'], ['telegram', 'Telegram']] as [val, label]}
        <button
          class="btn-toggle"
          class:active={$filters.sourceType === val}
          on:click={() => updateFilter('sourceType', val)}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Watchlist -->
  {#if buckets.length > 0}
    <div class="panel-section">
      <div class="panel-label">Watchlist</div>
      <select
        class="panel-select"
        value={$filters.queryBucket}
        on:change={e => updateFilter('queryBucket', e.target.value)}
      >
        <option value="">All watchlists</option>
        {#each buckets as b}
          <option value={b}>{b}</option>
        {/each}
      </select>
    </div>
  {/if}

  <!-- Countries -->
  <div class="panel-section">
    <div class="panel-label">Countries</div>
    <input
      class="panel-input"
      type="text"
      placeholder="e.g. US, MX, VE"
      value={countriesInput}
      on:input={onCountriesInput}
    />
    <div class="panel-hint">ISO codes, comma-separated</div>
  </div>

  <!-- GKG enhanced filters — shown when source is GKG or mixed -->
  {#if $filters.sourceType === '' || $filters.sourceType === 'gkg'}
    <!-- Tone -->
    <div class="panel-section">
      <div class="panel-label">Tone</div>
      <div class="btn-group">
        {#each [['very_neg','Very neg'], ['neg','Negative'], ['','Any']] as [preset, label]}
          <button
            class="btn-toggle"
            class:active={activeTonePreset($filters.toneMin, $filters.toneMax) === preset}
            on:click={() => setTonePreset(preset)}
          >
            {label}
          </button>
        {/each}
      </div>
    </div>

    <!-- Count types — only shown if this project has GKG items with counts -->
    {#if availableCountTypes.length > 0}
      <div class="panel-section">
        <div class="panel-label">Counts</div>
        <div class="btn-group btn-group--wrap">
          {#each availableCountTypes as ct}
            <button
              class="btn-toggle"
              class:active={isCountTypeActive($filters.countType, ct)}
              on:click={() => toggleCountType(ct)}
            >
              {ct}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Person name -->
    <div class="panel-section">
      <div class="panel-label">Person</div>
      <input
        class="panel-input"
        type="search"
        placeholder="e.g. Zelensky"
        value={personInput}
        on:input={onPersonInput}
      />
    </div>

    <!-- Organization name -->
    <div class="panel-section">
      <div class="panel-label">Organization</div>
      <input
        class="panel-input"
        type="search"
        placeholder="e.g. UNHCR"
        value={organizationInput}
        on:input={onOrgInput}
      />
    </div>

    <!-- Location text -->
    <div class="panel-section">
      <div class="panel-label">Location</div>
      <input
        class="panel-input"
        type="search"
        placeholder="e.g. Aleppo"
        value={locationInput}
        on:input={onLocationInput}
      />
      <div class="panel-hint">
        City or region name · <button class="ref-link" on:click={() => api.openUrl('http://data.gdeltproject.org/documentation/GDELT-Global_Knowledge_Graph_Codebook-V2.1.pdf')}>ADM1 codes ↗</button>
      </div>
    </div>
  {/if}

  <!-- Tags (Saved view only) -->
  {#if view === 'saved'}
    <div class="panel-section">
      <div class="panel-label">Tags</div>
      <input
        class="panel-input"
        type="text"
        placeholder="Filter by tag…"
        value={$filters.tagFilter}
        on:input={e => updateFilter('tagFilter', e.target.value)}
      />
      {#if allTags.length > 0}
        <div class="tag-pills">
          {#each allTags as tag}
            <button
              class="tag-pill"
              class:active={$filters.tagFilter === tag}
              on:click={() => updateFilter('tagFilter', $filters.tagFilter === tag ? '' : tag)}
            >
              {tag}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Sheet Status -->
    <div class="panel-section">
      <div class="panel-label">Sheet status</div>
      <div class="btn-group btn-group--wrap">
        {#each [['', 'All'], ['pending', 'Pending'], ['sent', 'Sent'], ['failed', 'Failed']] as [val, label]}
          <button
            class="btn-toggle"
            class:active={$filters.sheetStatus === val}
            on:click={() => updateFilter('sheetStatus', val)}
          >
            {label}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Clear all -->
  <button class="btn-clear" on:click={clearAll}>Clear all filters</button>
</aside>

<style>
  .filter-panel {
    width: 210px;
    flex-shrink: 0;
    padding: 1.25rem 1rem 1.5rem;
    position: sticky;
    top: 0;
    max-height: 100vh;
    overflow-y: auto;
    border-left: 1px solid var(--border);
    background: var(--bg);
  }

  .panel-title {
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 700;
    margin-bottom: 1rem;
  }

  .panel-section {
    margin-bottom: 1.25rem;
  }

  .panel-label {
    color: var(--text-muted);
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.07em;
    margin-bottom: 0.35rem;
    text-transform: uppercase;
  }

  .btn-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .btn-toggle {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0.2rem 0.45rem;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .btn-toggle:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .btn-toggle.active {
    background: var(--accent-soft);
    border-color: var(--accent-light);
    color: var(--accent-strong);
    font-weight: 500;
  }

  .panel-select {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-size: 0.78rem;
    padding: 0.3rem 0.5rem;
    width: 100%;
  }
  .panel-select:focus { border-color: var(--accent); outline: none; }

  .panel-input {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-size: 0.78rem;
    padding: 0.3rem 0.5rem;
    width: 100%;
  }
  .panel-input:focus { border-color: var(--accent); outline: none; }

  .panel-hint {
    color: var(--text-muted);
    font-size: 0.65rem;
    margin-top: 0.25rem;
  }
  .ref-link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    text-decoration: underline;
  }
  .ref-link:hover { opacity: 0.75; }

  .tag-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }
  .tag-pill {
    background: var(--paper-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.68rem;
    padding: 0.15rem 0.5rem;
    transition: background 0.12s;
  }
  .tag-pill:hover { background: var(--line); color: var(--text); }
  .tag-pill.active { background: var(--accent-soft); border-color: var(--accent-light); color: var(--accent-strong); }

  .btn-clear {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .btn-clear:hover { color: var(--text); }
</style>
