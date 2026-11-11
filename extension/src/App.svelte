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
  import TeamSettings from './components/TeamSettings.svelte'
  import Logs from './views/Logs.svelte'
  import Timeline from './views/Timeline.svelte'
  import Library from './views/Library.svelte'
  import Explore from './views/Explore.svelte'
  import Archive from './views/Archive.svelte'
  import TeamSearches from './components/TeamSearches.svelte'
  import Queries from './views/Queries.svelte'
  import Setup from './views/Setup.svelte'
  import {
    currentView, currentProjectId, currentProject,
    projects, stats, isLoading, teamState, syncTeams, ontology, notification, filters, clearFilters,
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
      syncTeams(),
    ])
    const team = $teamState
    isLoading.set(false)
    if (projectsResult.ok) {
      projects.set(projectsResult.data)
      if (projectsResult.data.length > 0 && !$currentProjectId) {
        currentProjectId.set(projectsResult.data[0].project_id)
      }
      // Canary-only users (projects, no team) land in their inbox; everyone else starts at the Library or the welcome screen.
      if (!team && projectsResult.data.length > 0) currentView.set('inbox')
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

  // The service worker delivers saves to the team sheet after the app page may have moved on; settle their status here.
  async function settleSheets() {
    if (!(await api.reconcileSheets()).data || !$currentProjectId) return
    const stat = await api.getProjectStats($currentProjectId)
    if (stat.ok) stats.set(stat.data)
    filters.update(f => ({ ...f }))
  }

  onMount(() => {
    boot().then(() => settleSheets())
    const onMessage = message => { if (message?.type === 'pipeline:delivered') settleSheets() }
    // Joining, switching or leaving a project (from any page) re-keys the team views below.
    const onStorage = (changes, area) => { if (area === 'local' && (changes.pipelineTeam || changes.pipelineTeams)) syncTeams() }
    globalThis.chrome?.runtime?.onMessage?.addListener(onMessage)
    globalThis.chrome?.storage?.onChanged?.addListener(onStorage)
    return () => {
      globalThis.chrome?.runtime?.onMessage?.removeListener(onMessage)
      globalThis.chrome?.storage?.onChanged?.removeListener(onStorage)
    }
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
        <p>Loading Pipeline…</p>
      </div>
    {:else if $currentView === 'new-project'}
      <NewProject />
    {:else if $currentView === 'setup'}
      <Setup />
    {:else if $currentView === 'team'}
      <div class="page"><h1>Projects</h1><TeamSettings /></div>
    {:else if $currentView === 'archive'}
      {#key $teamState?.id}<Archive />{/key}
    {:else if $currentView === 'queries'}
      {#key $teamState?.id}<Queries />{/key}
    {:else if $currentView === 'team-searches'}
      {#key $teamState?.id}<TeamSearches />{/key}
    {:else if !$teamState && ['library', 'explore'].includes($currentView)}
      <div class="no-project">
        <img class="welcome-logo" src="/pipe.svg" alt="" />
        <h2>Welcome to Pipeline</h2>
        <p>
          Save anything — a post, a video, a page — and it goes to your team's sheet, then gets
          archived automatically, mined for entities and made explorable. Canary monitoring is
          optional, and its inboxes stay private to this browser.
        </p>
        <div class="join page"><TeamSettings /></div>
        <button class="btn-link" on:click={() => currentView.set('setup')}>No join code yet? See how to set everything up</button>
        <button class="btn-link" on:click={() => currentView.set('new-project')}>Use Canary monitoring only</button>
      </div>
    {:else if $currentView === 'library'}
      {#key $teamState?.id}<Library />{/key}
    {:else if $currentView === 'explore'}
      {#key $teamState?.id}<Explore />{/key}
    {:else if !$currentProjectId}
      <div class="no-project">
        <div class="welcome-icon">◈</div>
        <h2>Canary monitoring</h2>
        <p>A monitoring and triage dashboard for tracking events and news across any topic or region.</p>
        <button class="btn-start" on:click={() => currentView.set('new-project')}>+ Create your first project</button>
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

  /* Pipe palette: warp-pipe green on quiet paper. The older variable names stay as aliases so every component picks it up. */
  :global(:root) {
    --paper: #f4f6f2;
    --paper-2: #e7ece5;
    --surface: #ffffff;
    --ink: #1a1d1b;
    --ink-2: #343a36;
    --muted: #5e6862;
    --muted-2: #8a938c;
    --line: #d5dcd3;
    --line-strong: #b9c0b7;
    --pipe: #2fa84f;
    --pipe-light: #8be29f;
    --pipe-deep: #1b7a3a;
    --pipe-dark: #115a2a;
    --pipe-ink: #0b2a14;
    --sky: #6fa8ff;
    --amber: #b7791f;
    --amber-soft: #fdf3d7;
    --moss: var(--pipe-deep);
    --moss-deep: var(--pipe-dark);
    --moss-soft: #e2f3e6;
    --moss-line: #a5d6b1;
    --signal: #b8402a;
    --signal-soft: #f7e3dd;
    --display: "Archivo", system-ui, sans-serif;
    --body: "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;

    --sidebar-bg: linear-gradient(90deg, #2c9a4b 0, #238a43 5%, #1b7a3a 20%, #17703a 70%, #115a2a 100%);
    --sidebar-text: #f3fbf4;
    --sidebar-text-muted: rgba(243, 251, 244, 0.75);
    --sidebar-active-bg: #ffffff;
    --sidebar-active-text: var(--pipe-dark);
    --radius: 8px;
    --shadow: 0 1px 2px rgba(11, 42, 20, 0.06), 0 2px 8px rgba(11, 42, 20, 0.05);
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

  /* Shared page furniture for the Collaborate views (Library, Archive, Team searches, projects, Setup). */
  :global(.page) { margin: 0 auto; max-width: 960px; padding: 2rem 2.25rem 3rem; }
  :global(.page h1) { font-size: 1.5rem; font-stretch: 110%; font-weight: 800; margin: 0 0 0.75rem; }
  :global(.page h2) { font-size: 1.02rem; margin: 1.5rem 0 0.5rem; }
  :global(.page button) { background: var(--surface); border: 1px solid var(--line-strong); border-radius: 6px; color: var(--text); cursor: pointer; font: 600 0.8rem var(--body); padding: 0.4rem 0.8rem; transition: background 0.12s, border-color 0.12s; }
  :global(.page button:hover:not(:disabled)) { background: var(--paper-2); border-color: var(--muted-2); }
  :global(.page button:disabled) { cursor: default; opacity: 0.55; }
  :global(.page button.primary) { background: var(--pipe-deep); border-color: var(--pipe-dark); border-bottom-width: 3px; color: #fff; }
  :global(.page button.primary:hover:not(:disabled)) { background: var(--pipe-dark); border-color: var(--pipe-ink); }
  :global(.page button.link) { background: none; border: 0; color: var(--text-muted); font-size: 0.76rem; font-weight: 500; padding: 0; text-decoration: underline; }
  :global(.page button.link:hover:not(:disabled)) { background: none; color: var(--accent); }
  :global(.page input:not([type=checkbox])), :global(.page select) { background: var(--surface); border: 1px solid var(--line-strong); border-radius: 6px; color: var(--text); font-size: 0.82rem; padding: 0.42rem 0.6rem; }
  :global(.page .card) { align-items: center; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); display: flex; gap: 12px; justify-content: space-between; margin: 8px 0; padding: 12px 14px; }
  :global(.page .hint) { color: var(--text-muted); font-size: 0.82rem; overflow-wrap: anywhere; }
  :global(.page .warn) { background: var(--amber-soft); border: 1px solid #ecd28a; border-radius: var(--radius); padding: 8px 12px; }
  :global(.page .err) { color: var(--signal); }

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
  .join { max-width: 440px; padding: 0; text-align: left; width: 100%; }
  .welcome-logo { border-radius: 14px; box-shadow: 0 0 0 3px var(--pipe-ink); height: 64px; margin-bottom: 1rem; width: 64px; }
  .btn-link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 0.85rem; text-decoration: underline; }

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
