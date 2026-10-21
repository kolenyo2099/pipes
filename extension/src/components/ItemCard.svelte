<script>
  import { createEventDispatcher } from 'svelte'
  import { api } from '../api.js'
  import {
    currentProjectId, notify, ontology, saveModalItem,
  } from '../stores/app.js'
  import { openUrl } from '../lib/openUrl.js'
  import RawJsonViewer from './RawJsonViewer.svelte'

  export let item
  export let siblings = []      // related items grouped by URL or article title
  export let clusterId = null
  export let primaryReason = ''
  export let showActions = true

  const dispatch = createEventDispatcher()

  // Open external URLs in the system browser via our axum /api/open-browser
  // endpoint.  Called directly on the <a> elements so we don't rely on
  // document-level event delegation (which can be unreliable in Tauri WebViews).
  function openExternalLink(e) {
    e.preventDefault()
    const href = e.currentTarget.href
    if (!href) return
    openUrl(href)
  }

  let sendingSheet = false
  let dismissing = false
  let archiving = false
  let latestArchiveId = null
  let deleting = false
  let siblingsOpen = false
  let choosingPrimaryId = null

  // All signals = primary item + siblings, deduplicated by (a1, a2, code, geo)
  $: allSignals = (() => {
    const seen = new Set()
    const out = []
    for (const it of [item, ...siblings]) {
      const n = it.normalized || {}
      const key = `${n.actor1_name||''}|${n.actor2_name||''}|${n.event_code||''}|${n.action_geo_fullname||''}`
      if (!seen.has(key)) { seen.add(key); out.push(n) }
    }
    return out
  })()

  $: uniqueCodes = [...new Set(allSignals.map(s => s.event_code).filter(Boolean))]

  $: inboxSiblingCount = siblings.filter(s => s.status === 'inbox').length
  $: groupedItemCount = 1 + siblings.length
  $: groupLabel = item.source_type === 'events' ? 'Signals' : 'Related items'
  $: groupCountLabel = item.source_type === 'events'
    ? `${allSignals.length} signal${allSignals.length !== 1 ? 's' : ''}`
    : `${groupedItemCount} item${groupedItemCount !== 1 ? 's' : ''}`
  $: isRss = item.source_type === 'rss' || item.source_type === 'mediacloud'
  $: rssSourceName = item.normalized?.source_name || null
  $: rssQueryLabel = item.normalized?.query_label
    || (item.source_type === 'mediacloud' ? item.normalized?.collection_names?.join(', ') : null)

  // ── Ontology-derived lookups ──────────────────────────────────────────────────

  // CAMEO 3-digit code → human label  (e.g. "071" → "Provide economic aid")
  $: cameoCodeToLabel = (() => {
    const map = {}
    for (const cat of ($ontology.event_categories || [])) {
      for (const sub of (cat.subcodes || [])) {
        map[sub.code] = sub.label
      }
    }
    return map
  })()

  // Any country code (ISO2, CAMEO 3-letter, FIPS) → country name
  $: anyCodeToName = (() => {
    const map = {}
    for (const c of ($ontology.countries || [])) {
      map[c.code]  = c.name   // ISO2 alpha-2
      map[c.cameo] = c.name   // CAMEO 3-letter
      map[c.fips]  = c.name   // FIPS 2-letter
    }
    return map
  })()

  // Display a CAMEO event code with its label: "Provide economic aid (071)"
  function displayCode(code) {
    if (!code) return ''
    const label = cameoCodeToLabel[code]
    return label ? `${label} (${code})` : code
  }

  // Deduplicate and humanise the countries_focus array (which mixes CAMEO + FIPS)
  function displayCountries(codes) {
    const seen = new Set()
    const names = []
    for (const code of (codes || [])) {
      const name = anyCodeToName[code] || code
      if (!seen.has(name)) { seen.add(name); names.push(name) }
    }
    return names.join(' · ')
  }

  // Replace raw [XXX] codes in generated event titles with their labels
  function humanizeTitle(title) {
    if (!title || !Object.keys(cameoCodeToLabel).length) return title
    return title.replace(/\[(\d{3,4})\]/g, (_, code) => {
      const label = cameoCodeToLabel[code]
      return label ? `[${label}]` : `[${code}]`
    })
  }

  function formatDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  function sourceDomainFor(related) {
    try {
      return new URL(related.url).hostname.replace(/^www\./, '')
    } catch (_) {
      return related.normalized?.source_name || related.source_type
    }
  }

  function sourceLabelFor(related) {
    return related.normalized?.source_name || sourceDomainFor(related)
  }

  function openSave() {
    saveModalItem.set(item)
  }

  async function dismiss() {
    dismissing = true
    const toDismiss = [item, ...siblings.filter(s => s.status === 'inbox')]
    const results = await Promise.all(
      toDismiss.map(it => api.dismissItem($currentProjectId, it.item_id))
    )
    dismissing = false
    const failed = results.filter(r => !r.ok)
    if (failed.length === 0) {
      const n = toDismiss.length
      notify('info', n > 1 ? `${n} items dismissed` : 'Item dismissed')
      if (n > 1) {
        dispatch('dismissedGroup', toDismiss.map(it => it.item_id))
      } else {
        dispatch('dismissed', item.item_id)
      }
    } else {
      notify('error', `Dismiss failed for ${failed.length} item(s)`)
    }
  }

  async function undismiss() {
    const result = await api.undismissItem($currentProjectId, item.item_id)
    if (result.ok) {
      notify('info', 'Moved back to Inbox')
      dispatch('undismissed', item.item_id)
    }
  }

  async function archiveItem() {
    archiving = true
    const result = await api.archiveItem($currentProjectId, item.item_id)
    archiving = false
    if (result.ok) {
      if (result.data.error) {
        if (result.data.snapshot_path) latestArchiveId = result.data.archive_id
        notify('error', `Archive needs review: ${result.data.error}`, 8000)
      } else {
        latestArchiveId = result.data.archive_id
        const resources = result.data.resource_count || 0
        notify('success', `Page archived with ${resources} resource${resources === 1 ? '' : 's'}`)
      }
    } else {
      notify('error', `Archive failed: ${result.error}`)
    }
  }

  async function openLatestSnapshot() {
    if (!latestArchiveId) return
    const result = await api.openArchiveSnapshot($currentProjectId, latestArchiveId)
    if (!result.ok) notify('error', `Could not open snapshot: ${result.error}`)
  }

  async function deleteItem() {
    if (!confirm('Permanently delete this item and any archived copies?')) return
    deleting = true
    const result = await api.deleteItem($currentProjectId, item.item_id)
    deleting = false
    if (result.ok) {
      notify('info', 'Item deleted')
      dispatch('deleted', item.item_id)
    } else {
      notify('error', `Delete failed: ${result.error}`)
    }
  }

  async function sendToSheet() {
    sendingSheet = true
    const result = await api.sendToSheet($currentProjectId, item.item_id)
    sendingSheet = false
    if (result.ok) {
      const status = result.data.sheet_send_status
      if (status === 'sent') {
        notify('success', 'Sent to Google Sheet')
      } else {
        notify('error', `Sheet send failed: ${result.data.sheet_last_error || 'unknown'}`)
      }
      dispatch('updated', result.data)
    } else {
      notify('error', `Send failed: ${result.error}`)
    }
  }

  async function choosePrimary(related, preferSource = false) {
    if (!clusterId || choosingPrimaryId) return
    choosingPrimaryId = related.item_id
    const result = await api.preferPrimary($currentProjectId, related.item_id, {
      story_key: clusterId,
      prefer_source: preferSource,
    })
    choosingPrimaryId = null
    if (result.ok) {
      notify('success', preferSource ? 'Source preference learned' : 'Primary version updated')
      dispatch('primarySelected')
    } else {
      notify('error', result.error || 'Could not update the primary version')
    }
  }
</script>

<article class="card" class:saved={item.status === 'saved'} class:dismissed={item.status === 'dismissed'}>
  <!-- Header row -->
  <div class="card-header">
    <div class="card-meta-left">
      <span class="badge badge--{item.source_type}">{item.source_type.toUpperCase()}</span>
      {#if item.source_type !== 'events'}
        <span class="source-stamp" title="Article source">{sourceLabelFor(item)}</span>
      {/if}
      {#if item.datetime_utc}
        <span class="card-date">{formatDate(item.datetime_utc)}</span>
      {/if}
    </div>
    <div class="card-meta-right">
      {#if item.countries_focus?.length > 0}
        <span class="countries">{displayCountries(item.countries_focus)}</span>
      {/if}
      {#if item.sheet_send_status === 'sent'}
        <span class="sheet-badge sheet-badge--sent" title="Sent to Google Sheet">📊✓</span>
      {:else if item.sheet_send_status === 'failed'}
        <span class="sheet-badge sheet-badge--failed" title={item.sheet_last_error}>📊✗</span>
      {:else if item.sheet_send_status === 'pending'}
        <span class="sheet-badge sheet-badge--pending" title="Pending sheet send">📊…</span>
      {/if}
    </div>
  </div>

  <!-- Match reason – always shown, never hidden -->
  <div class="match-reason">
    <span class="match-label">Matched because:</span>
    <span class="match-buckets">
      {#each item.matched_buckets as bucket, i}
        <span class="bucket-chip">{bucket}</span>
      {/each}
    </span>
    {#if item.source_type === 'gkg' && item.normalized?.also_countries?.length > 0}
      <span class="also-countries-hint">
        + also mentions {item.normalized.also_countries.join(' & ')}
      </span>
    {/if}
  </div>

  <!-- Title -->
  <div class="card-title">
    {#if item.url}
      <a href={item.url} target="_blank" rel="noopener noreferrer" class="title-link" on:click={openExternalLink}>
        {humanizeTitle(item.title_or_summary) || '(no title)'}
      </a>
    {:else}
      {humanizeTitle(item.title_or_summary) || '(no title)'}
    {/if}
  </div>

  <!-- Snippet / context -->
  {#if item.snippet_or_context && item.snippet_or_context !== item.title_or_summary}
    <div class="card-snippet">{item.snippet_or_context}</div>
  {/if}

  {#if siblings.length > 0}
    <div class="signals-bar">
      <span class="signals-label">{groupLabel}</span>
      {#if item.source_type === 'events' && uniqueCodes.length > 0}
        <span class="signal-codes">
          {#each uniqueCodes.slice(0, 6) as code}
            <span class="signal-code-chip" title={displayCode(code)}>{code}</span>
          {/each}
          {#if uniqueCodes.length > 6}
            <span class="signal-code-more">+{uniqueCodes.length - 6} more</span>
          {/if}
        </span>
      {/if}
      <button
        class="signals-toggle"
        on:click={() => siblingsOpen = !siblingsOpen}
        title={siblingsOpen ? 'Collapse related items' : 'Expand related items'}
      >
        {groupCountLabel} {siblingsOpen ? '▴' : '▾'}
      </button>
    </div>

    {#if siblingsOpen}
      <div class="signals-list">
        {#if item.source_type !== 'events' && primaryReason}
          <p class="primary-reason">{primaryReason}</p>
        {/if}
        {#if item.source_type === 'events'}
          {#each allSignals as sig}
            <div class="signal-row">
              <span class="sig-actors">
                {#if sig.actor1_name && sig.actor2_name}
                  {sig.actor1_name} → {sig.actor2_name}
                {:else if sig.actor1_name}
                  {sig.actor1_name}
                {:else if sig.actor2_name}
                  {sig.actor2_name}
                {/if}
              </span>
              {#if sig.event_code}<span class="sig-code">{displayCode(sig.event_code)}</span>{/if}
              {#if sig.action_geo_fullname}<span class="sig-geo">{sig.action_geo_fullname}</span>{/if}
            </div>
          {/each}
        {:else}
          <p class="primary-help">Compare the outlets below. Pick a lead version, or prefer an outlet for future versions of related stories.</p>
          {#each [item, ...siblings] as related}
            <div class="related-row">
              <span class="badge badge--{related.source_type}">{related.source_type.toUpperCase()}</span>
              <span class="related-source" title="Article source">{sourceLabelFor(related)}</span>
              {#if related.url}
                <a href={related.url} target="_blank" rel="noopener noreferrer" on:click={openExternalLink}>
                  {related.title_or_summary || related.url}
                </a>
              {:else}
                <span>{related.title_or_summary || '(no title)'}</span>
              {/if}
              {#if related.datetime_utc}<time>{formatDate(related.datetime_utc)}</time>{/if}
              <div class="primary-actions">
                {#if related.item_id === item.item_id}
                  <span class="primary-label">Primary</span>
                  <button
                    on:click={() => choosePrimary(related, true)}
                    disabled={choosingPrimaryId !== null}
                    title="Prefer this outlet in future related-story groups"
                  >
                    Prefer outlet
                  </button>
                {:else}
                  <button on:click={() => choosePrimary(related)} disabled={choosingPrimaryId !== null}>
                    Make primary
                  </button>
                  <button
                    on:click={() => choosePrimary(related, true)}
                    disabled={choosingPrimaryId !== null}
                    title="Prefer this outlet in future related-story groups"
                  >
                    Prefer outlet
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  {/if}

  <!-- Key fields / signals for events -->
  {#if item.source_type === 'events' && item.normalized}
    {@const n = item.normalized}
    <div class="key-fields">
      {#if n.actor1_name}<span class="kf"><em>Actor1:</em> {n.actor1_name}</span>{/if}
      {#if n.actor2_name}<span class="kf"><em>Actor2:</em> {n.actor2_name}</span>{/if}
      {#if n.event_code}<span class="kf"><em>Code:</em> {displayCode(n.event_code)}</span>{/if}
      {#if n.quad_class_label}<span class="kf"><em>Type:</em> {n.quad_class_label}</span>{/if}
      {#if n.goldstein_scale != null}<span class="kf"><em>Goldstein:</em> {n.goldstein_scale}</span>{/if}
      {#if n.action_geo_fullname}<span class="kf"><em>Geo:</em> {n.action_geo_fullname}</span>{/if}
    </div>
  {/if}

  <!-- GKG enhanced signals: tone, counts, persons, organizations, locations -->
  {#if item.source_type === 'gkg' && item.normalized}
    {@const n = item.normalized}
    {@const hasTone = n.tone != null && n.tone.tone != null}
    {@const topCounts = (n.counts || []).slice().sort((a, b) => b.count - a.count).slice(0, 3)}
    {@const topPersons = (n.persons || []).slice(0, 4)}
    {@const topOrgs = (n.organizations || []).slice(0, 3)}
    {@const topLocs = (n.locations || []).filter(l => l.type >= 4).slice(0, 2).concat(
      (n.locations || []).filter(l => l.type < 4).slice(0, 1)
    ).slice(0, 2)}
    {#if hasTone || topCounts.length > 0 || topPersons.length > 0 || topOrgs.length > 0 || topLocs.length > 0}
      <div class="gkg-signals">
        <!-- Tone badge -->
        {#if hasTone}
          {@const t = n.tone.tone}
          <span
            class="gkg-tone"
            class:gkg-tone--neg={t < -5}
            class:gkg-tone--mild={t >= -5 && t <= 0}
            class:gkg-tone--pos={t > 0}
            title="Tone score: {t.toFixed(1)} (pos {n.tone.pos?.toFixed(1)}, neg {n.tone.neg?.toFixed(1)})"
          >
            {t > 0 ? '+' : ''}{t.toFixed(1)}
          </span>
        {/if}

        <!-- Counts -->
        {#each topCounts as c}
          <span class="gkg-count" title="{c.type}{c.object ? ': ' + c.object : ''}">
            {c.count} {c.type.toLowerCase()}{c.object ? ' ' + c.object.toLowerCase() : ''}
          </span>
        {/each}

        <!-- Persons -->
        {#each topPersons as p}
          <span class="gkg-person" title="Person mentioned">{p}</span>
        {/each}
        {#if (n.persons || []).length > 4}
          <span class="gkg-overflow">+{n.persons.length - 4}</span>
        {/if}

        <!-- Organizations -->
        {#each topOrgs as o}
          <span class="gkg-org" title="Organization mentioned">{o}</span>
        {/each}
        {#if (n.organizations || []).length > 3}
          <span class="gkg-overflow">+{n.organizations.length - 3}</span>
        {/if}

        <!-- Most specific locations -->
        {#each topLocs as loc}
          <span class="gkg-loc" title="Location (type {loc.type})">{loc.name}</span>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- Saved tags/notes -->
  {#if item.status === 'saved'}
    <div class="saved-meta">
      {#if item.tags?.length > 0}
        <div class="tags">
          {#each item.tags as tag}
            <span class="tag">{tag}</span>
          {/each}
        </div>
      {/if}
      {#if item.notes}
        <div class="notes">"{item.notes}"</div>
      {/if}
    </div>
  {/if}

  <!-- Provenance -->
  <div class="card-provenance">
    <span class="prov-id" title="Stable item ID">{item.item_id.slice(0, 12)}…</span>
    {#if isRss && rssSourceName}
      <span class="prov-sep">·</span>
      <span class="prov-rss-source">{rssSourceName}</span>
    {:else if item.gdelt_primary_id}
      <span class="prov-sep">·</span>
      <span class="prov-gdelt">GDELT #{item.gdelt_primary_id}</span>
    {/if}
    {#if isRss && rssQueryLabel}
      <span class="prov-sep">·</span>
      <span class="prov-rss-query">{rssQueryLabel} query</span>
    {/if}
    {#if item.url}
      <span class="prov-sep">·</span>
      <a href={item.url} target="_blank" rel="noopener noreferrer" class="prov-source" on:click={openExternalLink}>source ↗</a>
    {/if}
  </div>

  <!-- Raw JSON viewer — only shown when gdelt_raw has actual data (Events items).
       GKG items store an empty object {} so we skip the viewer for those. -->
  {#if item.gdelt_raw && typeof item.gdelt_raw === 'object' && Object.keys(item.gdelt_raw).length > 0}
    <RawJsonViewer data={item.gdelt_raw} label="View raw payload" />
  {/if}

  <!-- Actions -->
  {#if showActions}
    <div class="card-actions">
      {#if item.status === 'inbox'}
        <button class="btn-save" on:click={openSave}>Save</button>
        <button class="btn-dismiss" on:click={dismiss} disabled={dismissing}>
          {#if dismissing}
            Dismissing…
          {:else if inboxSiblingCount > 0}
            Dismiss all ({1 + inboxSiblingCount})
          {:else}
            Dismiss
          {/if}
        </button>
      {:else if item.status === 'saved'}
        <button class="btn-edit" on:click={openSave} title="Edit tags and notes">✏ Edit</button>
        <button class="btn-archive" on:click={archiveItem} disabled={archiving} title="Save the rendered page as MHTML in Downloads/Canary">
          {archiving ? 'Archiving…' : '⬇ Archive'}
        </button>
        {#if latestArchiveId}
          <button class="btn-archive" on:click={openLatestSnapshot} title="Open the rendered browser snapshot">
            ◉ View snapshot
          </button>
        {/if}
        {#if item.sheet_send_status === 'failed'}
          <button class="btn-sheet" on:click={sendToSheet} disabled={sendingSheet}>
            {sendingSheet ? 'Sending…' : '↻ Retry Sheet'}
          </button>
        {:else if item.sheet_send_status === 'sent'}
          <button class="btn-sheet btn-sheet--resend" on:click={sendToSheet} disabled={sendingSheet} title="Resend to Google Sheet">
            {sendingSheet ? 'Sending…' : '↻ Resend'}
          </button>
        {:else}
          <button class="btn-sheet" on:click={sendToSheet} disabled={sendingSheet}>
            {sendingSheet ? 'Sending…' : '→ Send to Sheet'}
          </button>
        {/if}
        <button class="btn-delete" on:click={deleteItem} disabled={deleting} title="Permanently delete this item">
          {deleting ? '…' : '🗑'}
        </button>
      {:else if item.status === 'dismissed'}
        <button class="btn-undismiss" on:click={undismiss}>Restore to Inbox</button>
      {/if}
    </div>
  {/if}
</article>

<style>
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.9rem 1rem;
    transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--accent-light); }
  .card.saved { border-color: #16a34a; }
  .card.dismissed { opacity: 0.55; }

  .card-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.4rem;
  }
  .card-meta-left, .card-meta-right { align-items: center; display: flex; gap: 0.5rem; }
  .card-date { color: var(--text-muted); font-size: 0.75rem; }
  .source-stamp {
    color: var(--text-muted);
    font-size: 0.72rem;
    max-width: 15rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .countries { color: var(--text-muted); font-size: 0.72rem; font-weight: 500; }

  .badge { border-radius: 3px; font-size: 0.68rem; font-weight: 600; padding: 0.15rem 0.45rem; }
  .badge--events  { background: var(--accent-soft); color: var(--accent-strong); }
  .badge--doc     { background: #d1fae5; color: #065f46; } /* legacy */
  .badge--gkg     { background: #ede9fe; color: #5b21b6; }
  .badge--rss     { background: var(--accent-soft); color: var(--accent-strong); }
  .badge--mediacloud { background: #ede9fe; color: #5b21b6; }
  .badge--x { background: #e5e7eb; color: #111827; }
  .badge--bluesky { background: #dbeafe; color: #1d4ed8; }
  .badge--telegram { background: #e0f2fe; color: #0369a1; }
  .badge--context { background: #ede9fe; color: #5b21b6; }

  .match-reason {
    align-items: flex-start;
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-radius: 3px;
    display: flex;
    flex-wrap: wrap;
    font-size: 0.75rem;
    gap: 0.3rem;
    margin-bottom: 0.55rem;
    padding: 0.3rem 0.5rem;
  }
  .match-label { color: #92400e; font-weight: 600; white-space: nowrap; }
  .match-buckets { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .bucket-chip {
    background: #fef3c7;
    border-radius: 3px;
    color: #78350f;
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
  }
  .also-countries-hint {
    color: #6b7280;
    font-size: 0.68rem;
    font-style: italic;
    align-self: center;
  }

  .card-title {
    font-size: 0.9rem;
    font-weight: 500;
    line-height: 1.4;
    margin-bottom: 0.4rem;
  }
  .title-link {
    color: var(--text);
    text-decoration: none;
  }
  .title-link:hover { color: var(--accent); text-decoration: underline; }

  .card-snippet {
    color: var(--text-muted);
    font-size: 0.8rem;
    line-height: 1.5;
    margin-bottom: 0.4rem;
  }

  .key-fields {
    display: flex;
    flex-wrap: wrap;
    font-size: 0.75rem;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .kf { color: var(--text-muted); }
  .kf em { color: var(--text); font-style: normal; font-weight: 500; }

  /* ── Multi-signal grouped view ─────────────────────────────── */
  .signals-bar {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.35rem;
  }
  .signals-label {
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .signal-codes { display: flex; flex-wrap: wrap; gap: 0.2rem; }
  .signal-code-chip {
    background: var(--accent-soft);
    border-radius: 3px;
    color: var(--accent);
    cursor: default;
    font-family: monospace;
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
  }
  .signal-code-more {
    color: var(--text-muted);
    font-size: 0.68rem;
    padding: 0.1rem 0.2rem;
  }
  .signals-toggle {
    background: none;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.7rem;
    margin-left: auto;
    padding: 0.1rem 0.45rem;
    white-space: nowrap;
  }
  .signals-toggle:hover { background: var(--bg-hover); color: var(--text); }

  .signals-list {
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin-bottom: 0.4rem;
    padding: 0.4rem 0.6rem;
  }
  .signal-row {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    font-size: 0.73rem;
    gap: 0.4rem;
    line-height: 1.5;
  }
  .related-row {
    align-items: center;
    display: grid;
    gap: 0.5rem;
    grid-template-columns: auto minmax(6rem, 10rem) minmax(0, 1fr) auto auto;
    padding: 0.38rem 0;
  }
  .related-row + .related-row { border-top: 1px solid var(--border); }
  .related-row a {
    color: var(--blue);
    min-width: 0;
    overflow: hidden;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .related-row a:hover { text-decoration: underline; }
  .related-source {
    color: var(--text-muted);
    font-size: 0.7rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .related-row time { color: var(--text-muted); font-size: 0.7rem; white-space: nowrap; }
  .primary-reason { color: var(--text-muted); font-size: 0.72rem; margin: 0 0 0.3rem; }
  .primary-help { color: var(--text-muted); font-size: 0.72rem; line-height: 1.4; margin: 0 0 0.3rem; }
  .primary-actions { display: flex; gap: 0.25rem; justify-content: flex-end; }
  .primary-actions button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.68rem;
    padding: 0.15rem 0.35rem;
    white-space: nowrap;
  }
  .primary-actions button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  .primary-actions button:disabled { cursor: default; opacity: 0.5; }
  .primary-label { color: #166534; font-size: 0.68rem; font-weight: 600; }
  @media (max-width: 760px) {
    .related-row { grid-template-columns: auto minmax(0, 1fr) auto; }
    .related-source { grid-column: 2; }
    .related-row time { grid-column: 2; }
    .primary-actions { grid-column: 2 / -1; justify-content: flex-start; }
  }
  .sig-actors {
    color: var(--text);
    font-weight: 500;
    min-width: 0;
  }
  .sig-code { color: var(--accent); }
  .sig-geo {
    color: var(--text-muted);
    font-size: 0.7rem;
  }
  .sig-geo::before { content: '·'; margin-right: 0.35rem; color: var(--border); }

  /* ── GKG enhanced signals row ──────────────────────────────── */
  .gkg-signals {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 0.4rem;
  }
  .gkg-tone {
    border-radius: 3px;
    font-family: monospace;
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.1rem 0.4rem;
  }
  .gkg-tone--neg  { background: #fee2e2; color: #b91c1c; }
  .gkg-tone--mild { background: #fef3c7; color: #92400e; }
  .gkg-tone--pos  { background: #d1fae5; color: #065f46; }
  .gkg-count {
    background: #fef2f2;
    border-radius: 3px;
    color: #9f1239;
    font-size: 0.7rem;
    font-weight: 500;
    padding: 0.1rem 0.4rem;
    white-space: nowrap;
  }
  .gkg-person {
    background: var(--accent-soft);
    border-radius: 3px;
    color: var(--accent-strong);
    font-size: 0.69rem;
    padding: 0.1rem 0.4rem;
    white-space: nowrap;
  }
  .gkg-org {
    background: #f5f3ff;
    border-radius: 3px;
    color: #5b21b6;
    font-size: 0.69rem;
    padding: 0.1rem 0.4rem;
    white-space: nowrap;
  }
  .gkg-loc {
    background: #f0fdf4;
    border-radius: 3px;
    color: #15803d;
    font-size: 0.69rem;
    padding: 0.1rem 0.4rem;
    white-space: nowrap;
  }
  .gkg-overflow {
    color: var(--text-muted);
    font-size: 0.68rem;
    padding: 0.1rem 0.2rem;
  }

  .saved-meta { margin-bottom: 0.4rem; }
  .tags { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.3rem; }
  .tag {
    background: var(--accent-soft);
    border-radius: 3px;
    color: var(--accent-strong);
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
  }
  .notes {
    color: var(--text-muted);
    font-size: 0.78rem;
    font-style: italic;
  }

  .card-provenance {
    align-items: center;
    color: #9ca3af;
    display: flex;
    flex-wrap: wrap;
    font-size: 0.7rem;
    gap: 0.3rem;
    margin-bottom: 0.35rem;
  }
  .prov-id, .prov-gdelt { font-family: monospace; }
  .prov-rss-source {
    color: var(--muted);
    font-weight: 600;
  }
  .prov-rss-query {
    color: var(--muted);
  }
  .prov-sep { color: #d1d5db; }
  .prov-source { color: #6b7280; }
  .prov-source:hover { color: var(--accent); }

  .sheet-badge { font-size: 0.8rem; cursor: help; }
  .sheet-badge--failed { filter: grayscale(0.3); }

  .card-actions {
    border-top: 1px solid var(--border-light);
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
    padding-top: 0.6rem;
  }
  .btn-save {
    background: var(--accent);
    border: none;
    border-radius: 4px;
    color: white;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.35rem 0.9rem;
  }
  .btn-save:hover { background: var(--accent-strong); }
  .btn-dismiss {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.35rem 0.8rem;
  }
  .btn-dismiss:hover { background: #f3f4f6; color: var(--text); }
  .btn-dismiss:disabled { opacity: 0.5; cursor: default; }
  .btn-edit {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
    transition: background 0.12s, color 0.12s;
  }
  .btn-edit:hover { background: #f3f4f6; color: var(--text); }

  .btn-sheet {
    background: #d1fae5;
    border: 1px solid #6ee7b7;
    border-radius: 4px;
    color: #065f46;
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
  }
  .btn-sheet:hover { background: #a7f3d0; }
  .btn-sheet:disabled { opacity: 0.5; cursor: default; }
  .btn-sheet--resend { background: var(--accent-soft); border-color: #7dd3fc; color: #075985; }
  .btn-sheet--resend:hover { background: var(--accent-light); }
  .btn-archive {
    background: #ede9fe;
    border: 1px solid #c4b5fd;
    border-radius: 4px;
    color: #4c1d95;
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
  }
  .btn-archive:hover { background: #ddd6fe; }
  .btn-archive:disabled { opacity: 0.5; cursor: default; }
  .btn-undismiss {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
  }
  .btn-undismiss:hover { background: #f3f4f6; }
  .btn-delete {
    background: none;
    border: 1px solid #fca5a5;
    border-radius: 4px;
    color: #dc2626;
    cursor: pointer;
    font-size: 0.78rem;
    margin-left: auto;
    padding: 0.3rem 0.5rem;
  }
  .btn-delete:hover { background: #fee2e2; }
  .btn-delete:disabled { opacity: 0.5; cursor: default; }
</style>
