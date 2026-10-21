<script>
  import { onMount, onDestroy } from 'svelte'
  import { api } from '../api.js'
  import ItemCard from '../components/ItemCard.svelte'
  import SaveModal from '../components/SaveModal.svelte'
  import FilterPanel from '../components/FilterPanel.svelte'
  import { groupRelatedItems } from '../lib/itemGrouping.js'
  import {
    items, itemsTotal, isLoading, loadingItems,
    currentProjectId, currentProject, filters, stats, saveModalItem, notify,
  } from '../stores/app.js'

  export let status = 'inbox'  // 'inbox' | 'dismissed'

  let localItems = []
  let localGroups = []
  let serverGrouping = false
  let total = 0
  let hasMore = false
  let refreshInterval = null
  let checkingForNew = false
  let lastNewItemsCheckAt = 0
  let filtersOpen = false
  let dismissingAll = false
  let reviewCutoff = ''
  let nextCursor = null
  let newItemsCount = 0
  let loadGeneration = 0
  let activeProjectId = null
  let sourcePreferencesOpen = false
  let sourcePreferences = []
  let sourcePreferenceDomain = ''
  let savingSourcePreference = false

  function visibleServerGroups(sourceGroups, sourceItems) {
    const visibleIds = new Set(sourceItems.map(item => item.item_id))
    return sourceGroups.flatMap(group => {
      const members = [group.primary, ...(group.siblings || [])]
        .filter(item => visibleIds.has(item.item_id))
      if (members.length === 0) return []
      return [{ ...group, primary: members[0], siblings: members.slice(1) }]
    })
  }

  $: groups = serverGrouping
    ? visibleServerGroups(localGroups, localItems)
    : groupRelatedItems(localItems)

  // Client-side title filter — driven by the titleSearch field in the shared filters store.
  // Matches against title_or_summary (the field the card actually displays).
  $: filteredGroups = $filters.titleSearch
    ? groups.filter(g =>
        [g.primary, ...g.siblings].some(item =>
          item.title_or_summary?.toLowerCase().includes($filters.titleSearch.toLowerCase())
        )
      )
    : groups
  $: reviewedItemCount = new Set(
    filteredGroups.flatMap(group => [group.primary, ...group.siblings]).map(item => item.item_id)
  ).size

  // Count of active filters (backend + client-side title search)
  $: activeFilterCount = [
    $filters.sourceType,
    $filters.queryBucket,
    $filters.countries,
    $filters.since,
    $filters.titleSearch,
    $filters.toneMin,
    $filters.toneMax,
    $filters.countType,
    $filters.person,
    $filters.organization,
    $filters.locationText,
  ].filter(Boolean).length

  function backendParams(f = $filters, grouped = true) {
    return {
      status,
      group_stories: grouped || undefined,
      source_type: f.sourceType || undefined,
      query_bucket: f.queryBucket || undefined,
      countries: f.countries || undefined,
      since: f.since || undefined,
      tone_min: f.toneMin || undefined,
      tone_max: f.toneMax || undefined,
      count_type: f.countType || undefined,
      person: f.person || undefined,
      organization: f.organization || undefined,
      location_text: f.locationText || undefined,
    }
  }

  async function loadSourcePreferences() {
    if (!$currentProjectId) return
    const result = await api.listSourcePreferences($currentProjectId)
    if (!result.ok) return notify('error', result.error || 'Could not load preferred sources')
    sourcePreferences = result.data.preferences || []
  }

  async function toggleSourcePreferences() {
    sourcePreferencesOpen = !sourcePreferencesOpen
    if (sourcePreferencesOpen) await loadSourcePreferences()
  }

  async function saveSourcePreference() {
    const sourceDomain = sourcePreferenceDomain.trim()
    if (!sourceDomain || savingSourcePreference || !$currentProjectId) return
    savingSourcePreference = true
    const result = await api.setSourcePreference($currentProjectId, { source_domain: sourceDomain })
    savingSourcePreference = false
    if (!result.ok) return notify('error', result.error || 'Could not save preferred source')
    sourcePreferenceDomain = ''
    await loadSourcePreferences()
    notify('success', 'Preferred source saved')
  }

  async function removeSourcePreference(sourceDomain) {
    const result = await api.removeSourcePreference($currentProjectId, sourceDomain)
    if (!result.ok) return notify('error', result.error || 'Could not remove preferred source')
    sourcePreferences = sourcePreferences.filter(preference => preference.source_domain !== sourceDomain)
    notify('info', 'Preferred source removed')
  }

  function cursorFor(item) {
    if (!item) return null
    return {
      cursor_sort_at: item.datetime_utc || item.created_at,
      cursor_created_at: item.created_at,
      cursor_item_id: item.item_id,
    }
  }

  async function startReviewSession(scrollToTop = false) {
    if (!$currentProjectId) return
    const projectId = $currentProjectId
    const cutoff = new Date().toISOString()
    const generation = ++loadGeneration
    loadingItems.set(true)

    const f = $filters
    const result = await api.listItems(projectId, {
      ...backendParams(f),
      created_before: cutoff,
      limit: f.limit,
      offset: 0,
    })

    if (generation !== loadGeneration || projectId !== $currentProjectId) return
    loadingItems.set(false)
    if (result.ok) {
      reviewCutoff = cutoff
      localItems = result.data.items
      localGroups = result.data.groups || []
      serverGrouping = Array.isArray(result.data.groups)
      total = result.data.total
      hasMore = result.data.has_more
      nextCursor = cursorFor(localItems.at(-1))
      newItemsCount = 0
      items.set(localItems)
      itemsTotal.set(total)
      if (scrollToTop) {
        document.querySelector('.main-content')?.scrollTo?.({ top: 0, behavior: 'smooth' })
      }
    } else {
      notify('error', result.error || 'Could not load the inbox')
    }
  }

  async function loadItems(append = false) {
    if (!append) return startReviewSession()
    if (!$currentProjectId || !reviewCutoff || $loadingItems) return

    const projectId = $currentProjectId
    const generation = loadGeneration
    loadingItems.set(true)
    const result = await api.listItems(projectId, {
      ...backendParams(),
      created_before: reviewCutoff,
      offset: groups.length,
      limit: $filters.limit,
    })

    if (generation !== loadGeneration || projectId !== $currentProjectId) return
    loadingItems.set(false)
    if (result.ok) {
      const existingIds = new Set(localItems.map(item => item.item_id))
      const added = result.data.items.filter(item => !existingIds.has(item.item_id))
      localItems = [...localItems, ...added]
      if (Array.isArray(result.data.groups)) {
        const existingClusters = new Set(localGroups.map(group => group.cluster_id))
        localGroups = [
          ...localGroups,
          ...result.data.groups.filter(group => !existingClusters.has(group.cluster_id)),
        ]
        serverGrouping = true
      }
      total = result.data.total
      hasMore = result.data.has_more
      nextCursor = cursorFor(result.data.items.at(-1)) || nextCursor
      items.set(localItems)
      itemsTotal.set(total)
    } else {
      notify('error', result.error || 'Could not load more items')
    }
  }

  const BACKGROUND_CHECK_INTERVAL_MS = 5 * 60_000
  const RESUME_CHECK_COOLDOWN_MS = 60_000

  async function checkForNewItems(announce = false) {
    if (!$currentProjectId || !reviewCutoff || checkingForNew) return
    const projectId = $currentProjectId
    const cutoff = reviewCutoff
    const generation = loadGeneration
    checkingForNew = true
    const result = await api.listItems(projectId, {
      ...backendParams($filters, false),
      created_after: cutoff,
      limit: 1,
    })
    checkingForNew = false
    if (
      !result.ok || generation !== loadGeneration || projectId !== $currentProjectId ||
      cutoff !== reviewCutoff
    ) {
      if (announce && !result.ok) notify('error', result.error || 'Could not check for inbox updates')
      return
    }
    lastNewItemsCheckAt = Date.now()
    newItemsCount = result.data.total
    if (announce && newItemsCount === 0) notify('info', 'Inbox is up to date')
  }

  function checkWhenActive() {
    if (status !== 'inbox' || document.visibilityState === 'hidden') return
    if (Date.now() - lastNewItemsCheckAt < RESUME_CHECK_COOLDOWN_MS) return
    checkForNewItems()
  }

  async function loadStats() {
    if (!$currentProjectId) return
    const r = await api.getProjectStats($currentProjectId)
    if (r.ok) stats.set(r.data)
  }

  function onSaved(event) {
    const savedItem = event.detail
    localItems = localItems.filter(i => i.item_id !== savedItem.item_id)
    items.set(localItems)
    total -= 1
    loadStats()
  }

  function onDismissed(event) {
    const id = event.detail
    localItems = localItems.filter(i => i.item_id !== id)
    items.set(localItems)
    total -= 1
    loadStats()
  }

  // Fired when a grouped dismiss removes the primary + siblings in one action.
  function onDismissedGroup(event) {
    const ids = new Set(event.detail)
    const removedCount = localItems.filter(i => ids.has(i.item_id)).length
    localItems = localItems.filter(i => !ids.has(i.item_id))
    items.set(localItems)
    total -= removedCount
    loadStats()
  }

  function onUndismissed(event) {
    const id = event.detail
    localItems = localItems.filter(i => i.item_id !== id)
    items.set(localItems)
    total -= 1
    loadStats()
  }

  function onItemUpdated(event) {
    const updated = event.detail
    localItems = localItems.map(i => i.item_id === updated.item_id ? updated : i)
    items.set(localItems)
  }

  function onPrimarySelected() {
    startReviewSession()
  }

  function onModalSaved(event) {
    onSaved({ detail: event.detail })
    saveModalItem.set(null)
  }

  function closeSaveModal() {
    saveModalItem.set(null)
  }

  // Reload when backend-relevant filters change
  let prevFilters = null
  $: {
    const f = JSON.stringify({
      sourceType: $filters.sourceType,
      queryBucket: $filters.queryBucket,
      countries: $filters.countries,
      since: $filters.since,
      toneMin: $filters.toneMin,
      toneMax: $filters.toneMax,
      countType: $filters.countType,
      person: $filters.person,
      organization: $filters.organization,
      locationText: $filters.locationText,
    })
    if (prevFilters !== null && prevFilters !== f) startReviewSession()
    prevFilters = f
  }

  async function dismissAllFiltered() {
    if (!$currentProjectId || dismissingAll || filteredGroups.length === 0) return
    dismissingAll = true

    // A review session is a frozen cohort. Dismiss only IDs the user actually
    // loaded; newly collected or not-yet-loaded items are never swept up.
    const ids = [...new Set(
      filteredGroups.flatMap(group => [group.primary, ...group.siblings]).map(item => item.item_id)
    )]

    const completedIds = []
    let dismissed = 0
    let failure = null
    for (let offset = 0; offset < ids.length; offset += 5000) {
      const chunk = ids.slice(offset, offset + 5000)
      const result = await api.bulkDismissFiltered($currentProjectId, { item_ids: chunk })
      if (!result.ok) {
        failure = result.error || 'Bulk dismiss failed'
        break
      }
      dismissed += result.data.dismissed
      completedIds.push(...chunk)
    }
    dismissingAll = false
    if (completedIds.length > 0) {
      filters.update(f => ({ ...f, titleSearch: '' }))
      const dismissedIds = new Set(completedIds)
      localItems = localItems.filter(item => !dismissedIds.has(item.item_id))
      total = Math.max(0, total - dismissed)
      items.set(localItems)
      itemsTotal.set(total)
      if (localItems.length === 0 && hasMore) await loadItems(true)
      loadStats()
    }
    if (failure) {
      notify('error', dismissed > 0 ? `Dismissed ${dismissed} items, then stopped: ${failure}` : failure)
    } else {
      notify('info', `Dismissed ${dismissed} item${dismissed !== 1 ? 's' : ''}`)
    }
  }

  onMount(() => {
    if (status !== 'inbox') return
    // Collection is comparatively infrequent, so avoid querying once a minute.
    // Check quietly while the inbox is visible and once when the user returns
    // after the app has been in the background.
    refreshInterval = setInterval(checkWhenActive, BACKGROUND_CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', checkWhenActive)
    window.addEventListener('focus', checkWhenActive)
  })

  onDestroy(() => {
    loadGeneration += 1
    loadingItems.set(false)
    clearInterval(refreshInterval)
    document.removeEventListener('visibilitychange', checkWhenActive)
    window.removeEventListener('focus', checkWhenActive)
  })

  $: if ($currentProjectId && $currentProjectId !== activeProjectId) {
    activeProjectId = $currentProjectId
    sourcePreferences = []
    sourcePreferencesOpen = false
    startReviewSession()
    loadStats()
  }
</script>

<div class="inbox-outer">
  <!-- Review context and actions are intentionally separated so neither loses space. -->
  <div class="inbox-header">
    <div class="header-summary">
      <h1 class="view-title">
        {status === 'inbox' ? 'Inbox' : 'Dismissed'}
      </h1>
      <span class="item-count">
        {#if $filters.titleSearch}
          {filteredGroups.length} of {total} item{total !== 1 ? 's' : ''}
        {:else if groups.length < localItems.length}
          {groups.length} article{groups.length !== 1 ? 's' : ''} · {total} signal{total !== 1 ? 's' : ''}
        {:else}
          {total} item{total !== 1 ? 's' : ''}
        {/if}
      </span>
    </div>
    <div class="header-controls">
      <div class="header-view-tools">
        {#if status === 'inbox'}
          <button
            class="btn-filters"
            class:active={sourcePreferencesOpen}
            on:click={toggleSourcePreferences}
            aria-expanded={sourcePreferencesOpen}
          >
            Preferred sources
          </button>
        {/if}
        <button
          class="btn-filters"
          class:active={filtersOpen || activeFilterCount > 0}
          on:click={() => filtersOpen = !filtersOpen}
        >
          ⚙ Filters{#if activeFilterCount > 0}&nbsp;({activeFilterCount}){/if}
        </button>
      </div>
      {#if status === 'inbox'}
        <div class="header-live-actions">
          <button class="btn-refresh" on:click={() => checkForNewItems(true)} disabled={$loadingItems || checkingForNew}>↻ Check for new</button>
        </div>
      {:else}
        <div class="header-live-actions">
          <button class="btn-refresh" on:click={() => startReviewSession()} disabled={$loadingItems}>↻ Refresh</button>
        </div>
      {/if}
      {#if status === 'inbox' && localItems.length > 0}
        <button
          class="btn-dismiss-all"
          on:click={dismissAllFiltered}
          disabled={dismissingAll || filteredGroups.length === 0}
          title={`Dismiss the ${reviewedItemCount} loaded item${reviewedItemCount !== 1 ? 's' : ''} in this review session`}
        >
          {#if dismissingAll}
            Dismissing…
          {:else}
            🗑 Dismiss reviewed ({reviewedItemCount})
          {/if}
        </button>
      {/if}
    </div>
  </div>

  {#if status === 'inbox' && sourcePreferencesOpen}
    <section class="source-preferences" aria-label="Preferred sources">
      <div class="source-preferences-heading">
        <div>
          <h2>Preferred sources</h2>
          <p>Canary chooses these sources first when several related article versions cover the same story.</p>
        </div>
        <button class="source-panel-close" on:click={() => sourcePreferencesOpen = false} aria-label="Close preferred sources">Close</button>
      </div>
      <form class="source-preference-form" on:submit|preventDefault={saveSourcePreference}>
        <label for="source-domain">Add a source domain</label>
        <div>
          <input id="source-domain" bind:value={sourcePreferenceDomain} placeholder="reuters.com" autocomplete="off" />
          <button class="btn-add-source" disabled={savingSourcePreference || !sourcePreferenceDomain.trim()}>
            {savingSourcePreference ? 'Adding…' : 'Add source'}
          </button>
        </div>
      </form>
      {#if sourcePreferences.length === 0}
        <p class="source-preference-empty">No preferred sources yet. Add a domain here, or choose “Prefer outlet” after expanding a related-articles group.</p>
      {:else}
        <ul class="source-preference-list">
          {#each sourcePreferences as preference (preference.source_domain)}
            <li>
              <span>{preference.source_domain}</span>
              <button on:click={() => removeSourcePreference(preference.source_domain)}>Remove</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if status === 'inbox' && newItemsCount > 0}
    <div class="new-items-bar" aria-live="polite">
      <span>{newItemsCount} new item{newItemsCount !== 1 ? 's are' : ' is'} ready</span>
      <button on:click={() => startReviewSession(true)}>Review new items</button>
    </div>
  {/if}

  <!-- Multilingual coverage nudge -->
  {#if $stats?.multilingual_pct !== null && $stats?.multilingual_pct !== undefined && $stats?.tracked_events_count >= 20}
    <div class="coverage-bar" class:coverage-low={$stats.multilingual_pct < 5}>
      <span class="coverage-stat">
        🌐 {$stats.multilingual_pct}% multilingual coverage
        ({$stats.tracked_events_count} events tracked)
      </span>
      {#if $stats.multilingual_pct < 5}
        <span class="coverage-nudge">
          · Low non-English results — consider switching required actors to
          <strong>Any field</strong> in your rule settings for broader coverage.
        </span>
      {/if}
    </div>
  {/if}

  <!-- Layout: cards + optional filter panel -->
  <div class="view-layout">
    <div class="items-column">
      {#if !$currentProjectId}
        <div class="empty-state">
          <div class="empty-icon">◈</div>
          <p>Select or create a project to start monitoring.</p>
        </div>
      {:else if $loadingItems && localItems.length === 0}
        <div class="loading">Loading items…</div>
      {:else if localItems.length === 0}
        <div class="empty-state">
          <div class="empty-icon">{status === 'inbox' ? '📥' : '🗑'}</div>
          <p>
            {status === 'inbox'
              ? 'No items are waiting for review. Canary adds results after the next collection.'
              : 'No dismissed items.'}
          </p>
          {#if status === 'inbox'}
            <button
              class="btn-trigger-collect"
              on:click={async () => {
                await api.triggerCollect($currentProjectId)
                notify('info', 'Collection triggered')
                setTimeout(loadItems, 5000)
              }}
            >
              ▶ Trigger collection now
            </button>
          {/if}
        </div>
      {:else if filteredGroups.length === 0 && $filters.titleSearch}
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <p>No items match "<strong>{$filters.titleSearch}</strong>".</p>
        </div>
      {:else}
        <div class="item-list">
          {#each filteredGroups as group (group.primary.item_id)}
            <ItemCard
              item={group.primary}
              siblings={group.siblings}
              clusterId={group.cluster_id}
              primaryReason={group.primary_reason}
              showActions={true}
              on:saved={onSaved}
              on:dismissed={onDismissed}
              on:dismissedGroup={onDismissedGroup}
              on:undismissed={onUndismissed}
              on:updated={onItemUpdated}
              on:primarySelected={onPrimarySelected}
            />
          {/each}
        </div>

        {#if hasMore}
          <button
            class="btn-load-more"
            on:click={() => loadItems(true)}
            disabled={$loadingItems}
          >
            {$loadingItems ? 'Loading…' : `Load more (${total - localItems.length} remaining)`}
          </button>
        {/if}
      {/if}
    </div>

    {#if filtersOpen}
      <FilterPanel view={status} />
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
  .inbox-outer {
    padding: 1.5rem 2rem 1.5rem 2rem;
    min-height: 100%;
    display: flex;
    flex-direction: column;
  }
  /* ── Multilingual coverage nudge ─────────────────────────────────────────── */
  .coverage-bar {
    align-items: baseline;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 6px;
    color: #166534;
    display: flex;
    flex-wrap: wrap;
    font-size: 0.75rem;
    gap: 0.25rem;
    margin-bottom: 0.75rem;
    padding: 0.35rem 0.7rem;
  }
  .coverage-bar.coverage-low {
    background: #fffbeb;
    border-color: #fde68a;
    color: #92400e;
  }
  .coverage-stat { font-weight: 600; white-space: nowrap; }
  .coverage-nudge { color: inherit; opacity: 0.85; }

  .new-items-bar {
    align-items: center;
    background: var(--accent-soft);
    border: 1px solid var(--accent-light);
    border-radius: 6px;
    color: var(--accent-strong);
    display: flex;
    font-size: 0.8rem;
    font-weight: 600;
    justify-content: space-between;
    margin: -0.5rem 0 0.75rem;
    padding: 0.45rem 0.7rem;
  }
  .new-items-bar button {
    background: var(--accent);
    border: 0;
    border-radius: 4px;
    color: white;
    cursor: pointer;
    font: inherit;
    padding: 0.25rem 0.6rem;
  }
  .new-items-bar button:hover { background: var(--accent-strong); }
  .new-items-bar button:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }

  .inbox-header {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    margin-bottom: 1.25rem;
    flex-shrink: 0;
  }
  .header-summary {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem 0.85rem;
    min-width: 0;
  }
  .view-title { font-size: 1.3rem; font-weight: 700; margin: 0; }
  .item-count { color: var(--text-muted); font-size: 0.82rem; white-space: nowrap; }

  .header-controls {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
  }
  .header-view-tools, .header-live-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .header-live-actions { margin-left: auto; }

  .btn-refresh {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
  }
  .btn-refresh:hover { background: var(--bg-hover); }
  .btn-refresh:disabled { opacity: 0.5; cursor: default; }
  .source-preference-form .btn-add-source {
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    color: white;
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
  }
  .source-preference-form .btn-add-source:hover:not(:disabled) { filter: brightness(0.94); }
  .source-preference-form .btn-add-source:disabled { cursor: default; opacity: 0.5; }

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

  .source-preferences {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    display: grid;
    gap: 0.75rem;
    margin: -0.5rem 0 0.75rem;
    max-width: 760px;
    padding: 0.85rem 1rem;
  }
  .source-preferences-heading { align-items: flex-start; display: flex; gap: 1rem; justify-content: space-between; }
  .source-preferences h2 { font-size: 0.9rem; margin: 0 0 0.2rem; }
  .source-preferences p { color: var(--text-muted); font-size: 0.76rem; line-height: 1.45; margin: 0; }
  .source-panel-close {
    background: none;
    border: 0;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.76rem;
    padding: 0.15rem 0;
  }
  .source-panel-close:hover { color: var(--text); text-decoration: underline; }
  .source-preference-form { display: grid; gap: 0.35rem; }
  .source-preference-form label { color: var(--text); font-size: 0.75rem; font-weight: 600; }
  .source-preference-form > div { display: flex; gap: 0.45rem; }
  .source-preference-form input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    flex: 1;
    font: inherit;
    font-size: 0.8rem;
    min-width: 0;
    padding: 0.32rem 0.5rem;
  }
  .source-preference-form input:focus { border-color: var(--accent); outline: none; }
  .source-preference-empty { max-width: 620px; }
  .source-preference-list { display: grid; gap: 0.3rem; list-style: none; margin: 0; padding: 0; }
  .source-preference-list li {
    align-items: center;
    border-top: 1px solid var(--border);
    display: flex;
    font-size: 0.78rem;
    justify-content: space-between;
    padding-top: 0.45rem;
  }
  .source-preference-list button {
    background: none;
    border: 0;
    color: #b91c1c;
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0.15rem 0;
  }
  .source-preference-list button:hover { text-decoration: underline; }

  /* Cards + filter panel side-by-side */
  .view-layout {
    display: flex;
    align-items: flex-start;
    gap: 0;
    flex: 1;
    /* pull padding back — panel handles its own */
    margin-right: -2rem;
  }

  .items-column {
    flex: 1;
    min-width: 0;
    max-width: 700px;
    padding-right: 1.5rem;
  }

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

  .btn-trigger-collect {
    background: var(--accent);
    border: none;
    border-radius: 5px;
    color: white;
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0.5rem 1.2rem;
  }
  .btn-trigger-collect:hover { background: var(--accent-strong); }

  .loading { color: var(--text-muted); font-size: 0.9rem; padding: 2rem 0; }

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
  .btn-load-more:hover { background: var(--border); }

  /* ── Dismiss-all button (header actions) ─────────────────────────────────── */
  .btn-dismiss-all {
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: 5px;
    color: #b91c1c;
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.35rem 0.75rem;
    transition: background 0.12s, border-color 0.12s;
    white-space: nowrap;
  }
  .btn-dismiss-all:hover:not(:disabled) {
    background: #fee2e2;
    border-color: #f87171;
  }
  .btn-dismiss-all:disabled {
    cursor: default;
    opacity: 0.45;
  }

  @media (max-width: 1100px) {
    .header-live-actions { margin-left: 0; }
  }
  @media (max-width: 640px) {
    .header-controls { align-items: stretch; }
    .header-view-tools, .header-live-actions { align-items: stretch; width: 100%; }
    .header-live-actions { margin-left: 0; }
    .btn-refresh, .btn-dismiss-all { flex: 1; }
  }

</style>
