<script>
  import { onMount } from 'svelte'
  import { api } from '../api.js'
  import ItemCard from '../components/ItemCard.svelte'
  import FilterPanel from '../components/FilterPanel.svelte'
  import SaveModal from '../components/SaveModal.svelte'
  import SemanticMap from '../components/SemanticMap.svelte'
  import EntityGraph from '../components/EntityGraph.svelte'
  import {
    currentProjectId, notify, stats, filters, saveModalItem,
  } from '../stores/app.js'

  let lens = 'list'
  let savedItems = []
  let total = 0
  let hasMore = false
  let loading = false
  let filtersOpen = false

  // Unique tags from loaded items — passed to FilterPanel for pill display
  $: allTags = [...new Set(savedItems.flatMap(i => i.tags || []))]

  // Active filter count (for badge on toggle button)
  $: activeFilterCount = [
    $filters.sourceType,
    $filters.queryBucket,
    $filters.since,
    $filters.tagFilter,
    $filters.sheetStatus,
    $filters.person,
    $filters.organization,
    $filters.locationText,
    $filters.vizFilterLabel,
  ].filter(Boolean).length

  async function load(append = false) {
    if (!$currentProjectId) return
    loading = true

    const f = $filters
    const params = {
      status: 'saved',
      limit: 100,
      offset: append ? savedItems.length : 0,
    }
    if (f.sourceType) params.source_type = f.sourceType
    if (f.queryBucket) params.query_bucket = f.queryBucket
    if (f.since) params.since = f.since
    if (f.person) params.person = f.person
    if (f.organization) params.organization = f.organization
    if (f.locationText) params.location_text = f.locationText
    if (f.vizItemIds?.length) params.item_ids = f.vizItemIds.join(',')

    const result = await api.listItems($currentProjectId, params)
    loading = false
    if (result.ok) {
      const all = append ? [...savedItems, ...result.data.items] : result.data.items
      // Apply client-side filters
      let filtered = all
      if (f.tagFilter) {
        const q = f.tagFilter.toLowerCase()
        filtered = filtered.filter(i => i.tags?.some(t => t.toLowerCase().includes(q)))
      }
      if (f.sheetStatus) {
        filtered = filtered.filter(i => i.sheet_send_status === f.sheetStatus)
      }
      savedItems = filtered
      total = result.data.total
      hasMore = result.data.has_more
    }
  }

  function clearVisualFilter() {
    filters.update(f => ({ ...f, vizItemIds: [], vizFilterLabel: '', offset: 0 }))
    load()
  }

  let preserveVisualFilterOnNextFilterChange = false

  function applyVisualFilter(event) {
    const itemIds = event.detail?.itemIds || []
    const label = event.detail?.label || 'Visual selection'
    preserveVisualFilterOnNextFilterChange = true
    filters.update(f => ({
      ...f,
      person: '',
      organization: '',
      locationText: '',
      vizItemIds: itemIds,
      vizFilterLabel: label,
      offset: 0,
    }))
    load()
  }

  function onGraphFilter(event) {
    if (event.detail?.itemIds) {
      applyVisualFilter(event)
    }
  }

  async function retryAll() {
    const result = await api.retryFailedSheets($currentProjectId)
    if (result.ok) {
      const ok = result.data.results.filter(r => r.success).length
      notify('success', `Retried ${result.data.retried} – ${ok} succeeded`)
      load()
    } else {
      notify('error', `Retry failed: ${result.error}`)
    }
  }

  function exportCsv() {
    if (savedItems.length === 0) return
    const cols = ['item_id','datetime_utc','source_type','query_bucket','title_or_summary','url','countries_focus','tags','notes','sheet_send_status']
    const rows = [cols.join(',')]
    for (const item of savedItems) {
      rows.push(cols.map(c => {
        let v = item[c]
        if (Array.isArray(v)) v = v.join('|')
        if (v == null) v = ''
        return `"${String(v).replace(/"/g, '""')}"`
      }).join(','))
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `canary-saved-${new Date().toISOString().slice(0,10)}.csv`
    a.click()
  }

  function onItemUpdated(event) {
    const updated = event.detail
    savedItems = savedItems.map(i => i.item_id === updated.item_id ? updated : i)
  }

  function onItemDeleted(event) {
    const deletedId = event.detail
    savedItems = savedItems.filter(i => i.item_id !== deletedId)
    total = Math.max(0, total - 1)
    stats.update(s => ({ ...s, saved_count: Math.max(0, (s?.saved_count || 0) - 1) }))
  }

  function onItemDismissed(event) {
    const dismissedId = event.detail
    savedItems = savedItems.filter(i => i.item_id !== dismissedId)
    total = Math.max(0, total - 1)
    stats.update(s => s ? ({
      ...s,
      saved_count: Math.max(0, (s.saved_count || 0) - 1),
      dismissed_count: (s.dismissed_count || 0) + 1,
    }) : s)
  }

  // SaveModal handlers (for Edit button on saved items)
  function onModalSaved(event) {
    onItemUpdated({ detail: event.detail })
    saveModalItem.set(null)
  }

  function closeSaveModal() {
    saveModalItem.set(null)
  }

  $: failedCount = savedItems.filter(i => i.sheet_send_status === 'failed').length

  let archivingAll = false

  async function archiveAll() {
    if (savedItems.length === 0) return
    archivingAll = true
    const itemIds = savedItems.map(i => i.item_id)
    const result = await api.archiveBatch($currentProjectId, itemIds)
    archivingAll = false
    if (result.ok) {
      const results = result.data.results || []
      const ok = results.filter(r => !r.error).length
      const failed = results.length - ok
      if (failed === 0) {
        notify('success', `Archived ${ok} item${ok !== 1 ? 's' : ''}`)
      } else {
        notify('error', `Archived ${ok}, failed ${failed}`)
      }
    } else {
      notify('error', `Archive failed: ${result.error}`)
    }
  }

  onMount(() => load())
  $: if ($currentProjectId) load()

  // Reload when any filter changes
  let prevFilters = null
  $: {
    const f = JSON.stringify({
      sourceType: $filters.sourceType,
      queryBucket: $filters.queryBucket,
      since: $filters.since,
      tagFilter: $filters.tagFilter,
      sheetStatus: $filters.sheetStatus,
      person: $filters.person,
      organization: $filters.organization,
      locationText: $filters.locationText,
    })
    if (prevFilters !== null && prevFilters !== f) {
      if (preserveVisualFilterOnNextFilterChange) {
        preserveVisualFilterOnNextFilterChange = false
      } else {
        filters.update(cur => (
          cur.vizItemIds?.length ? { ...cur, vizItemIds: [], vizFilterLabel: '' } : cur
        ))
      }
      load()
    }
    prevFilters = f
  }
</script>

<div class="saved-outer">
  <!-- Header -->
  <div class="saved-header">
    <div class="header-left">
      <h1 class="view-title">Saved</h1>
      {#if $filters.vizFilterLabel}
        <span class="item-count">{savedItems.length} item{savedItems.length !== 1 ? 's' : ''} in {$filters.vizFilterLabel}</span>
      {:else}
        <span class="item-count">{total} item{total !== 1 ? 's' : ''}</span>
      {/if}
    </div>
    <div class="header-actions">
      <div class="lens-toggle" role="group" aria-label="View mode">
        <button class="lens-btn" class:active={lens === 'list'} on:click={() => lens = 'list'} title="List view">≡ List</button>
        <button class="lens-btn" class:active={lens === 'map'} on:click={() => lens = 'map'} title="Semantic map">◎ Map</button>
        <button class="lens-btn" class:active={lens === 'graph'} on:click={() => lens = 'graph'} title="Entity graph">⬡ Graph</button>
      </div>
      {#if failedCount > 0}
        <button class="btn-retry" on:click={retryAll}>
          ↻ Retry {failedCount} failed
        </button>
      {/if}
      <button class="btn-archive-all" on:click={archiveAll} disabled={archivingAll || savedItems.length === 0}>
        {archivingAll ? 'Archiving…' : `⬇ Archive all (${savedItems.length})`}
      </button>
      <button class="btn-export" on:click={exportCsv} disabled={savedItems.length === 0}>
        ↓ Export CSV
      </button>
      <button
        class="btn-filters"
        class:active={filtersOpen || activeFilterCount > 0}
        on:click={() => filtersOpen = !filtersOpen}
      >
        ⚙ Filters{#if activeFilterCount > 0}&nbsp;({activeFilterCount}){/if}
      </button>
    </div>
  </div>

  <section class="archive-privacy" aria-labelledby="archive-privacy-title">
    <div class="privacy-copy">
      <strong id="archive-privacy-title">How archiving works here</strong>
      <p>
        Canary opens each page in a background tab of this browser, with your own cookies and logins,
        and saves a single-file MHTML copy to Downloads/Canary. Publishers see an ordinary visit from you.
      </p>
    </div>
  </section>

  {#if $filters.vizFilterLabel}
    <div class="visual-filter-bar">
      <span>Filtered by {$filters.vizFilterLabel}</span>
      <button on:click={clearVisualFilter}>Clear</button>
    </div>
  {/if}

  {#if lens === 'map'}
    <div class="viz-pane">
      <SemanticMap status="saved" on:filter={applyVisualFilter} on:dismissed={onItemDismissed} />
    </div>
  {:else if lens === 'graph'}
    <div class="viz-pane">
      <EntityGraph status="saved" on:filter={onGraphFilter} on:dismissed={onItemDismissed} />
    </div>
  {/if}

  <!-- Layout: cards + optional filter panel -->
  <div class="view-layout" class:hidden={lens !== 'list'}>
    <div class="items-column">
      {#if loading && savedItems.length === 0}
        <div class="loading">Loading saved items…</div>
      {:else if savedItems.length === 0}
        <div class="empty-state">
          <div class="empty-icon">🔖</div>
          <p>No saved items yet. Use the Inbox to triage and save relevant items.</p>
        </div>
      {:else}
        <!-- Quick-click tag cloud -->
        {#if allTags.length > 0}
          <div class="stats-bar">
            {#each allTags as tag}
              <button
                class="stat-tag"
                class:active={$filters.tagFilter === tag}
                on:click={() => filters.update(f => ({ ...f, tagFilter: f.tagFilter === tag ? '' : tag, offset: 0 }))}
              >
                {tag} ({savedItems.filter(i => i.tags?.includes(tag)).length})
              </button>
            {/each}
          </div>
        {/if}

        <div class="item-list">
          {#each savedItems as item (item.item_id)}
            <ItemCard {item} showActions={true} on:updated={onItemUpdated} on:deleted={onItemDeleted} />
          {/each}
        </div>

        {#if hasMore}
          <button class="btn-load-more" on:click={() => load(true)} disabled={loading}>
            Load more
          </button>
        {/if}
      {/if}
    </div>

    {#if filtersOpen}
      <FilterPanel view="saved" {allTags} />
    {/if}
  </div>
</div>

<!-- Edit tags/notes modal for saved items -->
{#if $saveModalItem}
  <SaveModal
    item={$saveModalItem}
    on:saved={onModalSaved}
    on:close={closeSaveModal}
  />
{/if}

<style>
  .saved-outer {
    padding: 1.5rem 2rem 1.5rem 2rem;
    min-height: 100%;
    display: flex;
    flex-direction: column;
  }

  .saved-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
    margin-bottom: 1rem;
    flex-shrink: 0;
  }
  .header-left { align-items: baseline; display: flex; gap: 0.75rem; }
  .view-title { font-size: 1.3rem; font-weight: 700; margin: 0; }
  .item-count { color: var(--text-muted); font-size: 0.85rem; }
  .header-actions { display: flex; gap: 0.5rem; align-items: center; }

  .archive-privacy {
    align-items: center;
    background: #fffbeb;
    border: 1px solid #f4d58d;
    border-radius: 8px;
    color: #713f12;
    display: flex;
    gap: 1.5rem;
    justify-content: space-between;
    margin: -0.25rem 0 1rem;
    max-width: 920px;
    padding: 0.7rem 0.85rem;
  }
  .privacy-copy { min-width: 0; }
  .privacy-copy strong { display: block; font-size: 0.82rem; margin-bottom: 0.15rem; }
  .privacy-copy p {
    color: #854d0e;
    font-size: 0.76rem;
    line-height: 1.4;
    margin: 0;
    max-width: 72ch;
  }
  @media (max-width: 900px) {
    .archive-privacy { align-items: flex-start; flex-direction: column; gap: 0.65rem; }
  }

  .btn-retry {
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-radius: 4px;
    color: #92400e;
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
  }
  .btn-retry:hover { background: #fef3c7; }

  .btn-archive-all {
    background: #ede9fe;
    border: 1px solid #c4b5fd;
    border-radius: 4px;
    color: #4c1d95;
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
  }
  .btn-archive-all:hover { background: #ddd6fe; }
  .btn-archive-all:disabled { opacity: 0.5; cursor: default; }

  .btn-export {
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
  }
  .btn-export:hover { background: var(--border); }
  .btn-export:disabled { opacity: 0.5; cursor: default; }

  .btn-filters {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .btn-filters:hover { background: var(--bg-hover); }
  .btn-filters.active {
    background: var(--accent-soft);
    border-color: var(--accent-light);
    color: var(--accent-strong);
  }

  .lens-toggle {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .lens-btn {
    padding: 4px 10px;
    font-size: 12px;
    background: var(--bg-card);
    color: var(--text-muted);
    border: none;
    cursor: pointer;
    border-right: 1px solid var(--border);
    transition: background 0.15s, color 0.15s;
  }
  .lens-btn:last-child { border-right: none; }
  .lens-btn:hover { background: var(--bg-hover); color: var(--text); }
  .lens-btn.active { background: var(--accent); color: #fff; }

  .visual-filter-bar {
    align-items: center;
    background: var(--accent-soft);
    border: 1px solid var(--accent-light);
    border-radius: 6px;
    color: var(--accent-strong);
    display: flex;
    font-size: 0.78rem;
    gap: 0.6rem;
    justify-content: space-between;
    margin: -0.35rem 0 0.75rem;
    padding: 0.4rem 0.7rem;
  }
  .visual-filter-bar button {
    background: var(--accent-soft);
    border: 1px solid var(--accent-light);
    border-radius: 4px;
    color: var(--accent-strong);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0.18rem 0.5rem;
  }
  .visual-filter-bar button:hover { background: var(--accent-light); }

  .viz-pane {
    flex: 1;
    min-height: 0;
    height: calc(100vh - 140px);
    padding: 0 16px 16px;
    display: flex;
    flex-direction: column;
  }

  /* Cards + filter panel side-by-side */
  .view-layout {
    display: flex;
    align-items: flex-start;
    gap: 0;
    flex: 1;
    margin-right: -2rem;
  }
  .view-layout.hidden { display: none; }

  .items-column {
    flex: 1;
    min-width: 0;
    max-width: 700px;
    padding-right: 1.5rem;
  }

  .stats-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 1rem;
  }
  .stat-tag {
    background: var(--paper-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0.2rem 0.6rem;
  }
  .stat-tag:hover { background: var(--line); }
  .stat-tag.active { background: var(--accent-soft); border-color: var(--accent-light); color: var(--accent-strong); }

  .loading { color: var(--text-muted); font-size: 0.9rem; padding: 2rem 0; }
  .empty-state {
    align-items: center;
    color: var(--text-muted);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 4rem 0;
    text-align: center;
  }
  .empty-icon { font-size: 2.5rem; }
  .empty-state p { font-size: 0.9rem; margin: 0; }

  .item-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .btn-load-more {
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.85rem;
    margin-top: 1rem;
    padding: 0.6rem 1.5rem;
    width: 100%;
  }
</style>
