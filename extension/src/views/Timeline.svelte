<script>
  import { onMount, onDestroy } from 'svelte'
  import { api } from '../api.js'
  import ItemCard from '../components/ItemCard.svelte'
  import SaveModal from '../components/SaveModal.svelte'
  import FilterPanel from '../components/FilterPanel.svelte'
  import { groupRelatedItems } from '../lib/itemGrouping.js'
  import {
    currentProjectId, filters, saveModalItem, notify, ontology,
  } from '../stores/app.js'

  // ── State ─────────────────────────────────────────────────────────────────────
  let localItems = []
  let total = 0
  let hasMore = false
  let loading = false
  let filtersOpen = false
  let expandedId = null   // item_id of currently expanded row
  let refreshInterval = null

  // ── Country name lookup (mirrors ItemCard logic) ──────────────────────────────
  $: anyCodeToName = (() => {
    const map = {}
    for (const c of ($ontology.countries || [])) {
      map[c.code]  = c.name
      map[c.cameo] = c.name
      map[c.fips]  = c.name
    }
    return map
  })()

  function displayCountries(codes) {
    const seen = new Set()
    const names = []
    for (const code of (codes || [])) {
      const name = anyCodeToName[code] || code
      if (!seen.has(name)) { seen.add(name); names.push(name) }
    }
    return names.slice(0, 3).join(' · ')
  }

  // ── Day grouping ──────────────────────────────────────────────────────────────
  $: days = (() => {
    const dayMap = new Map()
    for (const item of localItems) {
      const day = item.datetime_utc?.slice(0, 10) ?? 'unknown'
      if (!dayMap.has(day)) dayMap.set(day, [])
      dayMap.get(day).push(item)
    }
    const result = []
    for (const [date, items] of dayMap) {
      const groups = groupRelatedItems(items)
      const eventsCount = items.filter(i => i.source_type === 'events').length
      const gkgCount    = items.filter(i => i.source_type === 'gkg' || i.source_type === 'doc').length
      const rssCount    = items.filter(i => i.source_type === 'rss').length
      const mediacloudCount = items.filter(i => i.source_type === 'mediacloud').length
      result.push({ date, groups, total: items.length, eventsCount, gkgCount, rssCount, mediacloudCount })
    }
    return result.sort((a, b) => a.date.localeCompare(b.date))
  })()

  $: maxDayCount = Math.max(1, ...days.map(d => d.total))

  // ── Active filter count ───────────────────────────────────────────────────────
  $: activeFilterCount = [
    $filters.sourceType, $filters.queryBucket, $filters.countries, $filters.since,
  ].filter(Boolean).length

  // ── Fetch ─────────────────────────────────────────────────────────────────────
  async function loadItems(append = false) {
    if (!$currentProjectId) return
    loading = true
    const f = $filters
    const result = await api.listItems($currentProjectId, {
      status:        'saved',
      source_type:   f.sourceType   || undefined,
      query_bucket:  f.queryBucket  || undefined,
      countries:     f.countries    || undefined,
      since:         f.since        || undefined,
      sort:          'asc',
      limit:         500,
      offset:        append ? localItems.length : 0,
    })
    loading = false
    if (result.ok) {
      localItems = append
        ? [...localItems, ...result.data.items]
        : result.data.items
      total   = result.data.total
      hasMore = result.data.has_more
    }
  }

  // ── Filter reactivity ─────────────────────────────────────────────────────────
  let prevFilters = null
  $: {
    const f = JSON.stringify({
      sourceType: $filters.sourceType, queryBucket: $filters.queryBucket,
      countries: $filters.countries,  since: $filters.since,
    })
    if (prevFilters !== null && prevFilters !== f) loadItems()
    prevFilters = f
  }

  onMount(() => {
    loadItems()
    refreshInterval = setInterval(loadItems, 60_000)
  })
  onDestroy(() => clearInterval(refreshInterval))

  $: if ($currentProjectId) loadItems()

  // ── Expand / collapse ─────────────────────────────────────────────────────────
  function toggle(id) {
    expandedId = expandedId === id ? null : id
  }

  // ── Item event handlers (status updates in-place — items stay on timeline) ────
  function updateItem(updated) {
    localItems = localItems.map(i => i.item_id === updated.item_id ? updated : i)
  }

  function setStatus(itemId, status) {
    localItems = localItems.map(i => i.item_id === itemId ? { ...i, status } : i)
  }

  function onItemUpdated(e)  { updateItem(e.detail) }

  function onSaved(e) {
    updateItem(e.detail)
    saveModalItem.set(null)
  }

  function onDismissed(e) { setStatus(e.detail, 'dismissed') }

  function onDismissedGroup(e) {
    const ids = new Set(e.detail)
    localItems = localItems.map(i => ids.has(i.item_id) ? { ...i, status: 'dismissed' } : i)
  }

  function onUndismissed(e) { setStatus(e.detail, 'inbox') }

  function onModalSaved(e)  { onSaved(e); saveModalItem.set(null) }
  function closeSaveModal() { saveModalItem.set(null) }

  // ── Day label helpers ─────────────────────────────────────────────────────────
  const TODAY     = new Date().toISOString().slice(0, 10)
  const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

  function dayLabel(date) {
    if (date === TODAY)     return 'Today'
    if (date === YESTERDAY) return 'Yesterday'
    const d = new Date(date + 'T12:00:00Z')
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  function shortDate(date) {
    const d = new Date(date + 'T12:00:00Z')
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  function timeStr(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  // ── Scroll to day ─────────────────────────────────────────────────────────────
  function scrollToDay(date) {
    const el = document.getElementById(`day-${date}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ── Tag colors (deterministic hash → palette) ─────────────────────────────────
  const TAG_PALETTE = [
    { bg: '#fee2e2', text: '#991b1b' },  // red
    { bg: '#fed7aa', text: '#9a3412' },  // orange
    { bg: '#fef3c7', text: '#92400e' },  // amber
    { bg: '#d1fae5', text: '#065f46' },  // green
    { bg: '#ccfbf1', text: '#115e59' },  // teal
    { bg: '#dbeafe', text: '#1e40af' },  // blue
    { bg: '#e0e7ff', text: '#3730a3' },  // indigo
    { bg: '#ede9fe', text: '#5b21b6' },  // purple
    { bg: '#fce7f3', text: '#9d174d' },  // pink
  ]

  function tagColor(tag) {
    let h = 0
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) & 0xffff
    return TAG_PALETTE[h % TAG_PALETTE.length]
  }
</script>

<div class="tl-outer">
  <!-- Header -->
  <div class="tl-header">
    <div class="header-left">
      <h1 class="view-title">Timeline</h1>
      <span class="item-count">
        {total} signal{total !== 1 ? 's' : ''}
        {#if days.length > 0}· {days.length} day{days.length !== 1 ? 's' : ''}{/if}
      </span>
    </div>
    <div class="header-actions">
      <button class="btn-refresh" on:click={() => loadItems()} disabled={loading}>
        {loading ? '…' : '↻ Refresh'}
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

  <!-- Layout wrapper (cards + optional filter panel) -->
  <div class="view-layout">
    <div class="tl-column">

      {#if !$currentProjectId}
        <div class="empty-state">
          <div class="empty-icon">🕐</div>
          <p>Select or create a project to view a timeline.</p>
        </div>
      {:else if loading && localItems.length === 0}
        <div class="loading">Loading timeline…</div>
      {:else if days.length === 0}
        <div class="empty-state">
          <div class="empty-icon">🕐</div>
          <p>No saved items yet. Save items from the Inbox to build your timeline.</p>
        </div>
      {:else}

        <!-- ── Density strip ──────────────────────────────────────────────────── -->
        <div class="density-strip" aria-label="Activity by day">
          {#each days as day}
            <button
              class="density-col"
              on:click={() => scrollToDay(day.date)}
              title="{shortDate(day.date)}: {day.total} signal{day.total !== 1 ? 's' : ''}"
            >
              <div class="density-bars">
                <div
                  class="bar-events"
                  style="height: {Math.round((day.eventsCount / maxDayCount) * 40)}px"
                ></div>
                <div
                  class="bar-doc"
                  style="height: {Math.round((day.gkgCount / maxDayCount) * 40)}px"
                ></div>
                <div
                  class="bar-rss"
                  style="height: {Math.round((day.rssCount / maxDayCount) * 40)}px"
                ></div>
                <div
                  class="bar-mediacloud"
                  style="height: {Math.round((day.mediacloudCount / maxDayCount) * 40)}px"
                ></div>
              </div>
              <span class="bar-label">{shortDate(day.date)}</span>
            </button>
          {/each}
        </div>

        <!-- ── Day sections ───────────────────────────────────────────────────── -->
        {#each days as day}
          <div class="day-section" id="day-{day.date}">

            <!-- Sticky day header -->
            <div class="day-header">
              <span class="day-name">{dayLabel(day.date)}</span>
              <span class="day-rule"></span>
              <span class="day-count">
                {day.groups.length} article{day.groups.length !== 1 ? 's' : ''}
                {#if day.groups.length < day.total}· {day.total} signals{/if}
              </span>
            </div>

            <!-- Timeline rows -->
            <div class="day-items">
              {#each day.groups as group (group.primary.item_id)}
                {@const item = group.primary}
                {@const isExpanded = expandedId === item.item_id}

                <div class="tl-item" class:is-expanded={isExpanded}>
                  <!-- Compact row -->
                  <button class="tl-row" on:click={() => toggle(item.item_id)}>
                    <span class="tl-time">{timeStr(item.datetime_utc)}</span>
                    <span class="badge badge--{item.source_type}">{item.source_type.toUpperCase()}</span>
                    {#if item.tags?.length > 0}
                      {#each item.tags.slice(0, 2) as tag}
                        {@const c = tagColor(tag)}
                        <span class="tl-tag" style="background:{c.bg};color:{c.text}">{tag}</span>
                      {/each}
                    {/if}
                    <span class="tl-title">
                      {item.title_or_summary || '(no title)'}
                    </span>
                    {#if group.siblings.length > 0}
                      <span class="tl-signals">{1 + group.siblings.length}×</span>
                    {/if}
                    {#if item.countries_focus?.length > 0}
                      <span class="tl-countries">{displayCountries(item.countries_focus)}</span>
                    {/if}
                    <span class="tl-chevron">{isExpanded ? '▴' : '▾'}</span>
                  </button>

                  <!-- Expanded full card -->
                  {#if isExpanded}
                    <div class="tl-card">
                      <ItemCard
                        {item}
                        siblings={group.siblings}
                        showActions={true}
                        on:saved={onSaved}
                        on:dismissed={onDismissed}
                        on:dismissedGroup={onDismissedGroup}
                        on:undismissed={onUndismissed}
                        on:updated={onItemUpdated}
                      />
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/each}

        {#if hasMore}
          <button class="btn-load-more" on:click={() => loadItems(true)} disabled={loading}>
            {loading ? 'Loading…' : `Load more (${total - localItems.length} remaining)`}
          </button>
        {/if}

      {/if}
    </div>

    {#if filtersOpen}
      <FilterPanel view="timeline" />
    {/if}
  </div>
</div>

<!-- Save modal -->
{#if $saveModalItem}
  <SaveModal
    item={$saveModalItem}
    on:saved={onModalSaved}
    on:close={closeSaveModal}
  />
{/if}

<style>
  .tl-outer {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    padding: 1.5rem 2rem;
  }

  /* ── Header ──────────────────────────────────────────────────────────────── */
  .tl-header {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    justify-content: space-between;
    margin-bottom: 1.25rem;
  }
  .header-left { align-items: baseline; display: flex; gap: 0.75rem; }
  .view-title  { font-size: 1.3rem; font-weight: 700; margin: 0; }
  .item-count  { color: var(--text-muted); font-size: 0.85rem; }
  .header-actions { align-items: center; display: flex; gap: 0.5rem; }

  .btn-refresh, .btn-filters {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
    transition: background 0.12s;
  }
  .btn-refresh:hover, .btn-filters:hover { background: var(--bg-hover); }
  .btn-refresh:disabled { cursor: default; opacity: 0.5; }
  .btn-filters.active {
    background: var(--accent-soft);
    border-color: var(--accent-light);
    color: var(--accent-strong);
  }

  /* ── Layout ──────────────────────────────────────────────────────────────── */
  .view-layout {
    align-items: flex-start;
    display: flex;
    flex: 1;
    gap: 0;
    margin-right: -2rem;
  }
  .tl-column {
    flex: 1;
    max-width: 760px;
    min-width: 0;
    padding-right: 1.5rem;
  }

  /* ── Empty / loading ─────────────────────────────────────────────────────── */
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
  .loading { color: var(--text-muted); font-size: 0.9rem; padding: 2rem 0; }

  /* ── Density strip ───────────────────────────────────────────────────────── */
  .density-strip {
    align-items: flex-end;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    display: flex;
    gap: 3px;
    margin-bottom: 1.5rem;
    overflow-x: auto;
    padding: 0.6rem 0.75rem 0.4rem;
    scrollbar-width: thin;
  }
  .density-col {
    align-items: center;
    background: none;
    border: none;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 3px;
    min-width: 32px;
    padding: 2px 1px;
    border-radius: 4px;
    transition: background 0.12s;
  }
  .density-col:hover { background: var(--bg-hover); }
  .density-bars {
    align-items: flex-end;
    display: flex;
    flex-direction: column;
    gap: 1px;
    height: 40px;
    justify-content: flex-end;
    width: 24px;
  }
  .bar-events {
    background: var(--accent);
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    width: 100%;
    opacity: 0.85;
  }
  .bar-doc {
    background: #10b981;
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    width: 100%;
    opacity: 0.85;
  }
  .bar-rss {
    background: #0ea5e9;
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    width: 100%;
    opacity: 0.85;
  }
  .bar-mediacloud {
    background: #8b5cf6;
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    width: 100%;
    opacity: 0.85;
  }
  .bar-label {
    color: var(--text-muted);
    font-size: 0.6rem;
    text-align: center;
    white-space: nowrap;
  }

  /* ── Day section ─────────────────────────────────────────────────────────── */
  .day-section { margin-bottom: 1.5rem; }

  .day-header {
    align-items: center;
    display: flex;
    gap: 0.6rem;
    margin-bottom: 0.4rem;
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    padding: 0.35rem 0;
  }
  .day-name {
    color: var(--text);
    font-size: 0.8rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .day-rule {
    background: var(--border);
    flex: 1;
    height: 1px;
  }
  .day-count {
    color: var(--text-muted);
    font-size: 0.72rem;
    white-space: nowrap;
  }

  /* ── Day items list ──────────────────────────────────────────────────────── */
  .day-items {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .tl-item + .tl-item {
    border-top: 1px solid var(--border-light);
  }

  /* ── Compact row ─────────────────────────────────────────────────────────── */
  .tl-row {
    align-items: center;
    background: none;
    border: none;
    cursor: pointer;
    display: flex;
    font-size: 0.82rem;
    gap: 0.5rem;
    padding: 0.55rem 0.75rem;
    text-align: left;
    transition: background 0.1s;
    width: 100%;
  }
  .tl-item.is-expanded .tl-row,
  .tl-row:hover { background: var(--bg-hover); }

  .tl-time {
    color: var(--text-muted);
    flex-shrink: 0;
    font-family: monospace;
    font-size: 0.72rem;
    width: 36px;
  }

  /* Tag pills */
  .tl-tag {
    border-radius: 3px;
    flex-shrink: 0;
    font-size: 0.62rem;
    font-weight: 600;
    max-width: 80px;
    overflow: hidden;
    padding: 0.1rem 0.35rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Source badge */
  .badge {
    border-radius: 3px;
    flex-shrink: 0;
    font-size: 0.6rem;
    font-weight: 700;
    padding: 0.1rem 0.35rem;
  }
  .badge--events { background: var(--accent-soft); color: var(--accent-strong); }
  .badge--doc    { background: #d1fae5; color: #065f46; }
  .badge--gkg    { background: #ede9fe; color: #5b21b6; }
  .badge--rss    { background: var(--accent-soft); color: var(--accent-strong); }
  .badge--mediacloud { background: #ede9fe; color: #5b21b6; }
  .badge--x { background: #e5e7eb; color: #111827; }
  .badge--bluesky { background: #dbeafe; color: #1d4ed8; }
  .badge--telegram { background: #e0f2fe; color: #0369a1; }

  .tl-title {
    color: var(--text);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tl-signals {
    background: #fef3c7;
    border-radius: 3px;
    color: #92400e;
    flex-shrink: 0;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0.1rem 0.35rem;
  }

  .tl-countries {
    color: var(--text-muted);
    flex-shrink: 0;
    font-size: 0.7rem;
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tl-chevron {
    color: var(--text-muted);
    flex-shrink: 0;
    font-size: 0.65rem;
  }

  /* ── Expanded card ───────────────────────────────────────────────────────── */
  .tl-card {
    border-top: 1px solid var(--border-light);
    padding: 0.75rem;
  }

  /* ── Load more ───────────────────────────────────────────────────────────── */
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
  .btn-load-more:hover { background: var(--border); }
</style>
