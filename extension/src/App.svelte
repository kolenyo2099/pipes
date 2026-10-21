<script>
  import { onMount } from 'svelte'
  import { api } from './api.js'
  import Sidebar from './components/Sidebar.svelte'
  import TutorialTour from './components/TutorialTour.svelte'
  import GdeltGuide from './components/GdeltGuide.svelte'
  import About from './components/About.svelte'
  import Inbox from './views/Inbox.svelte'
  import Saved from './views/Saved.svelte'
  import NewProject from './views/NewProject.svelte'
  import ProjectSettings from './views/ProjectSettings.svelte'
  import Logs from './views/Logs.svelte'
  import Timeline from './views/Timeline.svelte'
  import {
    currentView, currentProjectId, currentProject,
    projects, isLoading, ontology, notification, filters, clearFilters,
  } from './stores/app.js'

  // Keep shared filters visible and reversible even when their originating
  // control lives in another view (for example, an entity-graph selection).
  $: activeFilterSummary = (() => {
    const f = $filters
    const labels = []
    if (f.vizFilterLabel || f.vizItemIds?.length) labels.push(f.vizFilterLabel || 'visual selection')
    if (f.person) labels.push(`person: ${f.person}`)
    if (f.organization) labels.push(`organisation: ${f.organization}`)
    if (f.locationText) labels.push(`location: ${f.locationText}`)
    if (f.titleSearch) labels.push(`title: ${f.titleSearch}`)
    if (f.tagFilter) labels.push(`tag: ${f.tagFilter}`)
    if (f.sheetStatus) labels.push(`sheet: ${f.sheetStatus}`)
    if (f.sourceType) labels.push(`source: ${f.sourceType}`)
    if (f.queryBucket) labels.push(`watchlist: ${f.queryBucket}`)
    if (f.countries) labels.push(`countries: ${f.countries}`)
    if (f.since) labels.push('date range')
    if (f.toneMin || f.toneMax) labels.push('tone')
    if (f.countType) labels.push(`counts: ${f.countType}`)
    return labels
  })()

  async function boot() {
    isLoading.set(true)
    // Load projects and ontology in parallel
    const [projectsResult, ontologyResult] = await Promise.all([
      api.listProjects(),
      api.getOntology(),
    ])
    isLoading.set(false)
    if (projectsResult.ok) {
      projects.set(projectsResult.data)
      if (projectsResult.data.length > 0 && !$currentProjectId) {
        currentProjectId.set(projectsResult.data[0].project_id)
      }
    }
    if (ontologyResult.ok) {
      ontology.set(ontologyResult.data)
    }
  }

  // Load current project when projectId changes
  $: if ($currentProjectId) {
    api.getProject($currentProjectId).then(r => {
      if (r.ok) currentProject.set(r.data)
    })
  } else {
    currentProject.set(null)
  }

  onMount(() => {
    boot()
  })
</script>

<div class="app">
  <Sidebar />

  <main class="main-content">
    {#if activeFilterSummary.length > 0}
      <div class="active-filter-notice" role="status">
        <span class="active-filter-copy">
          <strong>Filters active</strong>
          <span title={activeFilterSummary.join(' · ')}>{activeFilterSummary.join(' · ')}</span>
        </span>
        <button on:click={clearFilters} aria-label="Clear all active filters">Clear all</button>
      </div>
    {/if}
    {#if $isLoading}
      <div class="app-loading">
        <div class="spinner">◈</div>
        <p>Loading Canary…</p>
      </div>
    {:else if $currentView === 'new-project'}
      <NewProject />
    {:else if !$currentProjectId}
      <div class="no-project">
        <div class="welcome-icon">◈</div>
        <h2>Welcome to Canary</h2>
        <p>
          A monitoring and triage dashboard for tracking
          events and news across any topic or region.
        </p>
        <button class="btn-start" on:click={() => currentView.set('new-project')}>
          + Create your first project
        </button>
      </div>
    {:else if $currentView === 'inbox'}
      <Inbox status="inbox" />
    {:else if $currentView === 'saved'}
      <Saved />
    {:else if $currentView === 'dismissed'}
      <Inbox status="dismissed" />
    {:else if $currentView === 'settings'}
      <ProjectSettings />
    {:else if $currentView === 'logs'}
      <Logs />
    {:else if $currentView === 'timeline'}
      <Timeline />
    {/if}
  </main>
</div>

<!-- Notification toast -->
{#if $notification}
  <div class="toast toast--{$notification.type}">
    {$notification.message}
  </div>
{/if}

<!-- Onboarding tour (portal-style, fixed position, above everything) -->
<TutorialTour />

<!-- GDELT Reference guide modal -->
<GdeltGuide />

<!-- About modal -->
<About />

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }

  /* Canary Lite palette. Desktop's variable names stay as aliases so every component picks it up. */
  :global(:root) {
    --paper: #edefea;
    --paper-2: #e4e8e2;
    --surface: #fafbf8;
    --ink: #1a1d1b;
    --ink-2: #343a36;
    --muted: #5e6862;
    --muted-2: #8a938c;
    --line: #d3d8d1;
    --line-strong: #b9c0b7;
    --canary: #f5c518;
    --canary-deep: #dcae05;
    --canary-ink: #2a2410;
    --moss: #2f5d4a;
    --moss-deep: #234737;
    --moss-soft: #dfe8e1;
    --moss-line: #a9c3b3;
    --signal: #b8402a;
    --signal-soft: #f7e3dd;
    --display: "Archivo", system-ui, sans-serif;
    --body: "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;

    --sidebar-bg: var(--canary);
    --sidebar-text: var(--canary-ink);
    --sidebar-text-muted: rgba(42, 36, 16, 0.7);
    --bg: var(--paper);
    --bg-card: var(--surface);
    --bg-hover: var(--paper-2);
    --bg-code: var(--paper-2);
    --bg-code-dark: var(--ink);
    --text: var(--ink);
    --text-muted: var(--muted);
    --text-code: var(--ink);
    --border: var(--line);
    --border-light: var(--paper-2);
    --accent: var(--moss);
    --accent-strong: var(--moss-deep);
    --accent-soft: var(--moss-soft);
    --accent-light: var(--moss-line);
    color-scheme: light;
  }

  :global(body) {
    background: var(--bg);
    color: var(--text);
    font-family: var(--body);
    font-size: 14px;
    line-height: 1.5;
    margin: 0;
    padding: 0;
    -webkit-font-smoothing: antialiased;
  }
  :global(button), :global(input), :global(select), :global(textarea) { font-family: inherit; }
  :global(h1), :global(h2) { font-family: var(--display); letter-spacing: -0.01em; }
  :global(code), :global(pre), :global(kbd) { font-family: var(--mono); }
  :global(:focus-visible) { outline: 2px solid var(--ink); outline-offset: 2px; }

  :global(h1, h2, h3) { color: var(--text); }
  :global(a) { color: var(--accent); }

  .app {
    display: flex;
    height: 100vh;
  }

  .main-content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }

  .active-filter-notice {
    align-items: center;
    background: var(--accent-soft);
    border-bottom: 1px solid var(--accent-light);
    color: var(--accent-strong);
    display: flex;
    font-size: 0.8rem;
    gap: 0.75rem;
    justify-content: space-between;
    padding: 0.5rem 2rem;
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .active-filter-copy {
    align-items: baseline;
    display: flex;
    gap: 0.45rem;
    min-width: 0;
  }
  .active-filter-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .active-filter-notice button {
    background: transparent;
    border: 1px solid var(--accent-light);
    border-radius: 4px;
    color: var(--accent-strong);
    cursor: pointer;
    flex: 0 0 auto;
    font: inherit;
    font-weight: 600;
    padding: 0.22rem 0.55rem;
  }
  .active-filter-notice button:hover { background: var(--accent-soft); }
  .active-filter-notice button:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }
  @media (max-width: 700px) {
    .active-filter-notice { padding-inline: 1rem; }
  }

  .app-loading {
    align-items: center;
    color: var(--text-muted);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    justify-content: center;
    min-height: 100vh;
  }
  .spinner {
    animation: spin 2s linear infinite;
    color: var(--accent);
    font-size: 2rem;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .no-project {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
    text-align: center;
  }
  .welcome-icon {
    color: var(--accent-light);
    font-size: 3rem;
  }
  .no-project h2 {
    font-size: 1.5rem;
    margin: 0;
  }
  .no-project p {
    color: var(--text-muted);
    font-size: 0.9rem;
    max-width: 440px;
    margin: 0;
  }
  .btn-start {
    background: var(--accent);
    border: none;
    border-radius: 6px;
    color: white;
    cursor: pointer;
    font-size: 0.95rem;
    font-weight: 600;
    padding: 0.65rem 1.5rem;
  }
  .btn-start:hover { background: var(--accent-strong); }

  /* Toast notifications */
  .toast {
    animation: slide-in 0.2s ease;
    border-radius: 6px;
    bottom: 1.5rem;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    font-size: 0.85rem;
    font-weight: 500;
    max-width: 380px;
    padding: 0.75rem 1.1rem;
    position: fixed;
    right: 1.5rem;
    z-index: 9999;
  }
  .toast--success { background: #dcfce7; border: 1px solid #86efac; color: #166534; }
  .toast--error { background: #fee2e2; border: 1px solid #fca5a5; color: #991b1b; }
  .toast--info { background: var(--accent-soft); border: 1px solid var(--accent-light); color: var(--accent-strong); }
  @keyframes slide-in { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
</style>
