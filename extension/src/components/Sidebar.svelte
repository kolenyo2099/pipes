<script>
  import { api } from '../api.js'
  import CollectorStatus from './CollectorStatus.svelte'
  import {
    currentView, currentProjectId, currentProject,
    projects, stats, notify, teamState, teams, syncTeams, tourOpen, guideOpen, aboutOpen,
  } from '../stores/app.js'

  export let onNavigate = () => {}

  let inboxCount = 0
  let savedCount = 0
  let failedSheets = 0
  $: if ($stats) {
    inboxCount = $stats.inbox_count || 0
    savedCount = $stats.saved_count || 0
    failedSheets = $stats.failed_sheet_sends || 0
  }

  function setView(view) {
    currentView.set(view)
    onNavigate()
  }

  function setProject(id) {
    currentProjectId.set(id)
    currentView.set('inbox')
  }

  async function switchProject(id) {
    const result = await api.switchTeam(id)
    if (!result.ok) return notify('error', result.error)
    await syncTeams()
    if (!['library', 'explore', 'archive', 'queries', 'team-searches'].includes($currentView)) setView('library')
  }

  let restoreInput

  function download(data, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: filename })
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const today = () => new Date().toISOString().slice(0, 10)

  async function exportSaved() {
    const saved = []
    for (let offset = 0; ;) {
      const result = await api.listItems($currentProjectId, { status: 'saved', limit: 500, offset })
      if (!result.ok) return notify('error', `Export failed: ${result.error}`)
      saved.push(...result.data.items)
      if (!result.data.has_more) break
      offset += result.data.items.length
    }
    download({ items: saved, total: saved.length }, `canary-saved-${today()}.json`)
  }

  async function downloadBackup() {
    const result = await api.exportBackup()
    if (result.ok) download(result.data, `canary-backup-${today()}.json`)
    else notify('error', `Backup failed: ${result.error}`)
  }

  async function restoreBackup(event) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    let data
    try { data = JSON.parse(await file.text()) } catch { return notify('error', 'That file is not valid JSON') }
    const result = await api.importBackup(data)
    if (!result.ok) return notify('error', `Restore failed: ${result.error}`)
    const list = await api.listProjects()
    if (list.ok) projects.set(list.data)
    if (!$currentProjectId && list.data?.length) currentProjectId.set(list.data[0].project_id)
    notify('success', `Restored ${result.data.projects} project${result.data.projects === 1 ? '' : 's'} and ${result.data.items} items`)
  }

  async function retrySheets() {
    const result = await api.retryFailedSheets($currentProjectId)
    if (result.ok) {
      notify('success', `Queued ${result.data.retried} for the team sheet`)
    } else {
      notify('error', `Retry failed: ${result.error}`)
    }
  }


</script>

<aside class="sidebar">
  <!-- Logo -->
  <div class="sidebar-logo">
    <img src="/canary.png" alt="Pipeline" class="logo-img" />
    <div class="logo-text-block">
      <span class="logo-text">Pipeline</span>
      <span class="logo-sub">Save · Archive · Explore</span>
    </div>
  </div>

  <!-- Collaborate: shared through the active team project's Google Sheet -->
  <section class="group group--team" aria-label="Collaborate">
    <div class="group-head">Collaborate</div>
    <p class="group-caption">Shared with your team through the project's Google Sheet</p>
    <div class="project-switcher" data-tour="team-area">
      {#if $teamState}
        <select class="project-select" aria-label="Team project" value={$teamState.id} on:change={e => switchProject(e.target.value)}>
          {#each $teams as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
        </select>
      {:else}
        <p class="empty-hint">No team project joined yet</p>
      {/if}
      <button class="btn-new-project" class:active={$currentView === 'team'} on:click={() => setView('team')}>Join or manage projects</button>
    </div>
    {#if $teamState}
      <nav class="nav">
        <button class="nav-item" class:active={$currentView === 'library'} data-tour="nav-library" on:click={() => setView('library')}><span class="nav-icon">📚</span>Library</button>
        <button class="nav-item" class:active={$currentView === 'explore'} on:click={() => setView('explore')}><span class="nav-icon">🧭</span>Explore</button>
        <button class="nav-item" class:active={$currentView === 'archive'} on:click={() => setView('archive')}><span class="nav-icon">🗄</span>Archive</button>
        <button class="nav-item" class:active={$currentView === 'queries'} on:click={() => setView('queries')}><span class="nav-icon">⌕</span>Queries</button>
        <button class="nav-item" class:active={$currentView === 'team-searches'} on:click={() => setView('team-searches')}><span class="nav-icon">🔎</span>Team searches</button>
      </nav>
    {/if}
  </section>

  <!-- Monitor: Canary, local to this browser -->
  <section class="group group--monitor" aria-label="Monitor">
    <div class="group-head">Monitor</div>
    <p class="group-caption">Private to this browser: your own Canary searches and inbox</p>
  <!-- GDELT Reference guide trigger -->
  <button class="btn-guide" on:click={() => guideOpen.set(true)} title="GDELT reference guide">
    📖 GDELT Reference
  </button>

  <div class="project-switcher" data-tour="project-area">
    {#if $projects.length === 0}
      <p class="empty-hint">No monitors yet</p>
    {:else}
      <select
        class="project-select"
        value={$currentProjectId || ''}
        on:change={e => setProject(e.target.value)}
      >
        <option value="" disabled>Select a monitor…</option>
        {#each $projects as p}
          <option value={p.project_id}>{p.name}</option>
        {/each}
      </select>
    {/if}
    <button class="btn-new-project" on:click={() => setView('new-project')}>
      + New monitor
    </button>
  </div>

  {#if $currentProjectId}
    <!-- Collector status -->
    <CollectorStatus projectId={$currentProjectId} />

    <!-- Nav -->
    <div class="section-label">Views</div>
    <nav class="nav">
      <button
        class="nav-item"
        class:active={$currentView === 'inbox'}
        data-tour="nav-inbox"
        on:click={() => setView('inbox')}
      >
        <span class="nav-icon">📥</span>
        Inbox
        {#if inboxCount > 0}
          <span class="nav-badge">{inboxCount}</span>
        {/if}
      </button>
      <button
        class="nav-item"
        class:active={$currentView === 'timeline'}
        data-tour="nav-timeline"
        on:click={() => setView('timeline')}
      >
        <span class="nav-icon">📅</span>
        Timeline
      </button>
      <button
        class="nav-item"
        class:active={$currentView === 'saved'}
        on:click={() => setView('saved')}
      >
        <span class="nav-icon">🔖</span>
        Saved
        {#if savedCount > 0}
          <span class="nav-badge nav-badge--green">{savedCount}</span>
        {/if}
      </button>
      <button
        class="nav-item"
        class:active={$currentView === 'dismissed'}
        on:click={() => setView('dismissed')}
      >
        <span class="nav-icon">🗑</span>
        Dismissed
      </button>
      <button
        class="nav-item"
        class:active={$currentView === 'logs'}
        on:click={() => setView('logs')}
      >
        <span class="nav-icon">📋</span>
        Collector Logs
      </button>
      <button
        class="nav-item"
        class:active={$currentView === 'settings'}
        data-tour="nav-settings"
        on:click={() => setView('settings')}
      >
        <span class="nav-icon">⚙</span>
        Monitor settings
      </button>
    </nav>

    <!-- Quick actions -->
    <div class="section-label">Actions</div>
    <div class="quick-actions">
      {#if failedSheets > 0}
        <button class="action-btn action-btn--warn" on:click={retrySheets}>
          ↻ Retry {failedSheets} failed sheet{failedSheets !== 1 ? 's' : ''}
        </button>
      {/if}
      <button class="action-btn" on:click={exportSaved}>
        ↓ Export saved (JSON)
      </button>
      <button class="action-btn" on:click={() => api.openArchivesFolder()}>
        📁 Open archives folder
      </button>
    </div>
  {/if}

  <!-- Backup: data lives only in this browser profile; removing the extension deletes it -->
  <div class="section-label">Backup</div>
  <div class="quick-actions">
    <button class="action-btn" on:click={downloadBackup}>⬇ Download backup</button>
    <button class="action-btn" on:click={() => restoreInput.click()}>⬆ Restore backup</button>
    <input hidden type="file" accept="application/json,.json" bind:this={restoreInput} on:change={restoreBackup} />
  </div>
  </section>

  <!-- Bottom bar: Tour + About — pinned to bottom -->
  <div class="bottom-bar">
    <button class="btn-tour" on:click={() => tourOpen.set(true)} title="Replay tour">
      ? Tour
    </button>
    <button class="btn-about" on:click={() => aboutOpen.set(true)} title="About Pipeline">
      ℹ About
    </button>
  </div>
</aside>

<style>
  /* Canary Lite sidebar: canary yellow, ink text, ink pill for the active view. */
  .sidebar {
    background: var(--sidebar-bg);
    color: var(--sidebar-text);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow-x: hidden;
    overflow-y: auto;
    position: sticky;
    top: 0;
    width: 220px;
    flex-shrink: 0;
  }
  .sidebar-logo {
    align-items: center;
    display: flex;
    gap: 0.6rem;
    padding: 1.1rem 1rem 0.7rem;
  }
  .logo-img { flex-shrink: 0; height: 30px; width: 30px; border-radius: 6px; object-fit: contain; }
  .logo-text-block { display: flex; flex-direction: column; min-width: 0; }
  .logo-text {
    font: 800 1.35rem/1 var(--display);
    font-stretch: 125%;
    letter-spacing: -0.02em;
    text-transform: uppercase;
  }
  .logo-sub { font: 500 0.6rem/1.3 var(--mono); letter-spacing: 0.04em; margin-top: 0.2rem; opacity: 0.75; text-transform: uppercase; }

  .section-label {
    font: 500 0.66rem/1.4 var(--mono);
    letter-spacing: 0.08em;
    opacity: 0.75;
    padding: 0.85rem 1rem 0.3rem;
    text-transform: uppercase;
  }
  .project-switcher { display: flex; flex-direction: column; gap: 0.4rem; padding: 0 1rem 0.5rem; }
  .project-select {
    background: rgba(255, 255, 255, 0.45);
    border: 1.5px solid var(--canary-ink);
    border-radius: 6px;
    color: var(--canary-ink);
    font-size: 0.82rem;
    font-weight: 600;
    padding: 0.45rem 0.5rem;
    width: 100%;
  }
  .project-select:focus-visible { outline-color: var(--canary-ink); }
  .btn-new-project {
    background: transparent;
    border: 1.5px dashed rgba(42, 36, 16, 0.45);
    border-radius: 6px;
    color: var(--canary-ink);
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.4rem;
    width: 100%;
  }
  .btn-new-project:hover { background: rgba(42, 36, 16, 0.1); }
  .empty-hint { font-size: 0.78rem; margin: 0; opacity: 0.75; }

  /* Two labelled groups: team (shared, lighter tint) and monitor (private, darker tint). */
  .group { border-radius: 8px; margin: 0.5rem 0.5rem 0; padding-bottom: 0.4rem; }
  .group--team { background: rgba(255, 255, 255, 0.4); border: 1.5px solid var(--canary-ink); }
  .group--monitor { background: rgba(42, 36, 16, 0.1); border: 1.5px dashed rgba(42, 36, 16, 0.45); }
  .group-head { font: 800 0.8rem/1.4 var(--display); letter-spacing: 0.06em; padding: 0.5rem 0.6rem 0; text-transform: uppercase; }
  .group-caption { font-size: 0.7rem; line-height: 1.35; margin: 0; opacity: 0.8; padding: 0.1rem 0.6rem 0.2rem; }
  .group .project-switcher { padding: 0.3rem 0.5rem 0.5rem; }
  .group .nav { padding: 0 0.25rem; }
  .group .section-label { padding-inline: 0.6rem; }
  .group .quick-actions { padding-inline: 0.25rem; }
  .btn-new-project.active { background: var(--canary-ink); border-style: solid; color: var(--canary); }
  .nav { display: flex; flex-direction: column; gap: 2px; padding: 0 0.5rem; }
  .nav-item {
    align-items: center;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--canary-ink);
    cursor: pointer;
    display: flex;
    font-size: 0.85rem;
    font-weight: 600;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    text-align: left;
    width: 100%;
  }
  .nav-item:hover { background: rgba(42, 36, 16, 0.1); }
  .nav-item.active { background: var(--canary-ink); color: var(--canary); }
  .nav-icon { font-size: 0.85rem; }
  .nav-badge { font: 500 0.72rem var(--mono); margin-left: auto; opacity: 0.8; }
  .nav-item.active .nav-badge { opacity: 1; }

  .quick-actions { display: flex; flex-direction: column; gap: 2px; padding: 0 0.5rem 0.5rem; }
  .action-btn {
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--canary-ink);
    cursor: pointer;
    display: block;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.4rem 0.6rem;
    text-align: left;
    text-decoration: none;
  }
  .action-btn:hover { background: rgba(42, 36, 16, 0.1); }
  .action-btn--warn { background: var(--canary-ink); color: var(--canary); }
  .action-btn--warn:hover { background: var(--ink-2); }

  .btn-guide {
    background: none;
    border: none;
    color: var(--canary-ink);
    cursor: pointer;
    font: 500 0.72rem var(--mono);
    letter-spacing: 0.02em;
    margin: 0 0.5rem;
    padding: 0.35rem 0.5rem;
    text-align: left;
    border-radius: 6px;
  }
  .btn-guide:hover { background: rgba(42, 36, 16, 0.1); }

  .bottom-bar { border-top: 1.5px solid rgba(42, 36, 16, 0.2); display: flex; margin-top: auto; }
  .btn-tour,
  .btn-about {
    background: none;
    border: none;
    color: var(--canary-ink);
    cursor: pointer;
    flex: 1;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.65rem 0.5rem 0.9rem;
  }
  .btn-tour { border-right: 1.5px solid rgba(42, 36, 16, 0.2); }
  .btn-tour:hover,
  .btn-about:hover { background: rgba(42, 36, 16, 0.1); }
</style>
