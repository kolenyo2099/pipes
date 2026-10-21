<script>
  import { onMount, onDestroy } from 'svelte'
  import { api } from '../api.js'
  import { currentProjectId, currentProject, notify } from '../stores/app.js'

  export let projectId = null

  let logs = []
  let lastEventsLog = null
  let lastGkgLog = null
  let lastRssLog = null
  let lastMediaCloudLog = null
  let lastXLog = null
  let lastBlueskyLog = null
  let lastTelegramLog = null
  let isTriggering = false
  let isPausing = false
  let interval = null

  $: paused = $currentProject?.polling_config?.paused ?? false

  function gdeltCursorDate(url) {
    const match = url?.match(/\/(\d{14})\./)
    if (!match) return null
    const stamp = match[1]
    return new Date(Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
      Number(stamp.slice(12, 14)),
    ))
  }

  function oldestDate(values) {
    const dates = values.filter(d => d && !Number.isNaN(d.getTime()))
    return dates.length ? new Date(Math.min(...dates.map(d => d.getTime()))) : null
  }

  function catchUpState(lane) {
    const project = $currentProject
    if (!project || project.polling_config?.paused) return null

    const isEvents = lane === 'events'
    const enabled = isEvents
      ? project.polling_config?.events_enabled
      : project.polling_config?.doc_enabled
    if (!enabled) return null

    const cursor = isEvents
      ? oldestDate([
          gdeltCursorDate(project.last_events_url),
          gdeltCursorDate(project.last_events_translation_url),
        ])
      : oldestDate([
          project.last_doc_collected_at ? new Date(project.last_doc_collected_at) : null,
          project.last_doc_translation_collected_at
            ? new Date(project.last_doc_translation_collected_at)
            : null,
        ])
    const fallback = project.collecting_since ? new Date(project.collecting_since) : null
    const through = cursor || fallback
    if (!through || Number.isNaN(through.getTime())) return null

    const interval = isEvents
      ? project.polling_config?.events_interval_minutes
      : project.polling_config?.doc_interval_minutes
    const freshnessMinutes = Math.max(Number(interval) || 30, 30)
    if (Date.now() - through.getTime() <= freshnessMinutes * 60_000) return null

    return {
      label: `Catching up through ${through.toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })}`,
      title: `Canary is processing historical ${isEvents ? 'Events' : 'GKG'} data. Newer windows will follow automatically.`,
    }
  }

  // X, Bluesky and Telegram: a pause, the oldest stretch not collected yet, and the request budget shared by all projects.
  let socialBudgets = {}
  function socialState(lane, project, budgets) {
    if (!project?.polling_config?.[`${lane}_enabled`]) return null
    const budget = budgets[lane]
    const paused = budget?.paused_until && Date.parse(budget.paused_until) > Date.now()
    const oldest = Object.values(project[`${lane}_cursors`] || {}).flatMap(cursor => cursor.holes || []).map(hole => hole.from).sort()[0]
    const behind = oldest && Date.now() - Date.parse(oldest) > 2 * Math.max(project.polling_config[`${lane}_interval_minutes`] || 60, 15) * 60_000
    const label = [
      paused && `Paused until ${new Date(budget.paused_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      behind && `Catching up from ${new Date(oldest).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      budget && `${budget.used}/${budget.per} requests per ${budget.minutes} min`,
    ].filter(Boolean).join(' · ')
    return label && { label, title: 'The request budget is shared by all projects. Past it, collection slows down instead of sending more requests.' }
  }
  $: xSocial = socialState('x', $currentProject, socialBudgets)
  $: blueskySocial = socialState('bluesky', $currentProject, socialBudgets)
  $: telegramSocial = socialState('telegram', $currentProject, socialBudgets)

  // A lane whose source changed its format: the user can email the error to the developers, who need to update Canary.
  let brokenLanes = {}
  const LANE_NAMES = { x: 'X', bluesky: 'Bluesky', telegram: 'Telegram' }
  function reportLink(lane, { error, at }) {
    const body = [`Lane: ${LANE_NAMES[lane] || lane}`, `Error: ${error}`, `First seen: ${at}`,
      `Canary version: ${globalThis.chrome?.runtime?.getManifest?.().version || 'dev'}`, `Browser: ${navigator.userAgent}`].join('\n')
    return `mailto:info@osinv.org?subject=${encodeURIComponent(`Canary: the ${LANE_NAMES[lane] || lane} lane broke`)}&body=${encodeURIComponent(body)}`
  }

  $: eventsCatchUp = catchUpState('events')
  $: gkgCatchUp = catchUpState('gkg')

  async function load() {
    if (!projectId) return
    const requestedProjectId = projectId
    const [result, projectResult, budgetResult, brokenResult] = await Promise.all([
      api.getLogs(projectId, 20),
      api.getProject(projectId),
      api.getSocialBudgets(),
      api.getBrokenLanes(),
    ])
    if (requestedProjectId !== projectId) return
    if (budgetResult.ok) socialBudgets = budgetResult.data
    if (brokenResult.ok) brokenLanes = brokenResult.data
    if (result.ok) {
      logs = result.data
      lastEventsLog = logs.find(l => l.lane === 'events')
      lastGkgLog    = logs.find(l => l.lane === 'gkg')
      lastRssLog    = logs.find(l => l.lane === 'rss')
      lastMediaCloudLog = logs.find(l => l.lane === 'mediacloud')
      lastXLog = logs.find(l => l.lane === 'x')
      lastBlueskyLog = logs.find(l => l.lane === 'bluesky')
      lastTelegramLog = logs.find(l => l.lane === 'telegram')
    }
    if (projectResult.ok) currentProject.set(projectResult.data)
  }

  async function triggerNow() {
    isTriggering = true
    const result = await api.triggerCollect(projectId)
    isTriggering = false
    if (result.ok) {
      notify('info', 'Collection triggered – results will appear in ~30 s')
      setTimeout(load, 5000)
    } else {
      notify('error', `Trigger failed: ${result.error}`)
    }
  }

  async function togglePause() {
    if (!$currentProject) return
    isPausing = true
    const newConfig = { ...$currentProject.polling_config, paused: !paused }
    const result = await api.updateProject(projectId, { polling_config: newConfig })
    isPausing = false
    if (result.ok) {
      currentProject.set(result.data)
      notify('info', paused ? 'Collection resumed' : 'Collection paused')
    } else {
      notify('error', `Update failed: ${result.error}`)
    }
  }

  function fmt(iso) {
    if (!iso) return 'never'
    const d = new Date(iso)
    return d.toLocaleString()
  }

  function relativeTime(iso) {
    if (!iso) return ''
    const diff = (Date.now() - new Date(iso)) / 1000
    if (diff < 60) return `${Math.round(diff)}s ago`
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
    return `${Math.round(diff / 86400)}d ago`
  }

  onMount(() => {
    load()
    interval = setInterval(load, 30_000)
  })
  onDestroy(() => clearInterval(interval))

  $: if (projectId) load()
</script>

<div class="collector-status" class:is-paused={paused}>
  <div class="status-header">
    <span class="label">Collector</span>
    <div class="header-btns">
      <button
        class="btn-pause"
        class:btn-resume={paused}
        on:click={togglePause}
        disabled={isPausing}
        title={paused ? 'Resume automatic collection' : 'Pause automatic collection'}
      >
        {#if isPausing}…{:else if paused}▶ Resume{:else}⏸ Pause{/if}
      </button>
      {#if !paused}
        <button class="btn-trigger" on:click={triggerNow} disabled={isTriggering} title="Trigger immediate collection">
          {isTriggering ? '…' : '▶ Run now'}
        </button>
      {/if}
    </div>
  </div>

  {#each Object.entries(brokenLanes) as [lane, report] (lane)}
    <div class="broken" role="alert">
      Something broke in the {LANE_NAMES[lane] || lane} lane. Here's what triggered the error: <code>{report.error}</code>
      <a href={reportLink(lane, report)}>Email info@osinv.org</a>
    </div>
  {/each}

  <div class="lane-row">
    <span class="lane-name">Events</span>
    {#if lastEventsLog}
      <span class="lane-time" title={fmt(lastEventsLog.finished_at)}>
        {relativeTime(lastEventsLog.finished_at)}
      </span>
      <span class="lane-counts">+{lastEventsLog.new_count} new</span>
      {#if lastEventsLog.error}
        <span class="lane-error" title={lastEventsLog.error}>⚠</span>
      {:else}
        <span class="lane-ok">✓</span>
      {/if}
    {:else}
      <span class="lane-time muted">no runs yet</span>
    {/if}
  </div>
  {#if eventsCatchUp}
    <div class="catch-up" title={eventsCatchUp.title}>{eventsCatchUp.label}</div>
  {/if}

  <div class="lane-row">
    <span class="lane-name">GKG</span>
    {#if lastGkgLog}
      <span class="lane-time" title={fmt(lastGkgLog.finished_at)}>
        {relativeTime(lastGkgLog.finished_at)}
      </span>
      <span class="lane-counts">+{lastGkgLog.new_count} new</span>
      {#if lastGkgLog.error}
        <span class="lane-error" title={lastGkgLog.error}>⚠</span>
      {:else}
        <span class="lane-ok">✓</span>
      {/if}
    {:else}
      <span class="lane-time muted">{$currentProject?.polling_config?.doc_enabled ? 'no runs yet' : 'disabled'}</span>
    {/if}
  </div>
  {#if gkgCatchUp}
    <div class="catch-up" title={gkgCatchUp.title}>{gkgCatchUp.label}</div>
  {/if}

  <div class="lane-row">
    <span class="lane-name">RSS</span>
    {#if lastRssLog}
      <span class="lane-time" title={fmt(lastRssLog.finished_at)}>
        {relativeTime(lastRssLog.finished_at)}
      </span>
      <span class="lane-counts">+{lastRssLog.new_count} new</span>
      {#if lastRssLog.error}
        <span class="lane-error" title={lastRssLog.error}>⚠</span>
      {:else}
        <span class="lane-ok">✓</span>
      {/if}
    {:else}
      <span class="lane-time muted">{$currentProject?.polling_config?.rss_enabled ? 'no runs yet' : 'disabled'}</span>
    {/if}
  </div>
  <div class="lane-row">
    <span class="lane-name">Media Cloud</span>
    {#if lastMediaCloudLog}
      <span class="lane-time" title={fmt(lastMediaCloudLog.finished_at)}>
        {relativeTime(lastMediaCloudLog.finished_at)}
      </span>
      <span class="lane-counts">+{lastMediaCloudLog.new_count} new</span>
      {#if lastMediaCloudLog.error}
        <span class="lane-error" title={lastMediaCloudLog.error}>⚠</span>
      {:else}
        <span class="lane-ok">✓</span>
      {/if}
    {:else}
      <span class="lane-time muted">{$currentProject?.polling_config?.mediacloud_enabled ? 'no runs yet' : 'disabled'}</span>
    {/if}
  </div>
  <div class="lane-row">
    <span class="lane-name">X</span>
    {#if lastXLog}
      <span class="lane-time" title={fmt(lastXLog.finished_at)}>
        {relativeTime(lastXLog.finished_at)}
      </span>
      <span class="lane-counts">+{lastXLog.new_count} new</span>
      {#if lastXLog.error}
        <span class="lane-error" title={lastXLog.error}>⚠</span>
      {:else}
        <span class="lane-ok">✓</span>
      {/if}
    {:else}
      <span class="lane-time muted">{$currentProject?.polling_config?.x_enabled ? 'no runs yet' : 'disabled'}</span>
    {/if}
  </div>
  {#if xSocial}
    <div class="catch-up" title={xSocial.title}>{xSocial.label}</div>
  {/if}
  <div class="lane-row">
    <span class="lane-name">Bluesky</span>
    {#if lastBlueskyLog}
      <span class="lane-time" title={fmt(lastBlueskyLog.finished_at)}>
        {relativeTime(lastBlueskyLog.finished_at)}
      </span>
      <span class="lane-counts">+{lastBlueskyLog.new_count} new</span>
      {#if lastBlueskyLog.error}
        <span class="lane-error" title={lastBlueskyLog.error}>⚠</span>
      {:else}
        <span class="lane-ok">✓</span>
      {/if}
    {:else}
      <span class="lane-time muted">{$currentProject?.polling_config?.bluesky_enabled ? 'no runs yet' : 'disabled'}</span>
    {/if}
  </div>
  {#if blueskySocial}
    <div class="catch-up" title={blueskySocial.title}>{blueskySocial.label}</div>
  {/if}
  <div class="lane-row">
    <span class="lane-name">Telegram</span>
    {#if lastTelegramLog}
      <span class="lane-time" title={fmt(lastTelegramLog.finished_at)}>
        {relativeTime(lastTelegramLog.finished_at)}
      </span>
      <span class="lane-counts">+{lastTelegramLog.new_count} new</span>
      {#if lastTelegramLog.error}
        <span class="lane-error" title={lastTelegramLog.error}>⚠</span>
      {:else}
        <span class="lane-ok">✓</span>
      {/if}
    {:else}
      <span class="lane-time muted">{$currentProject?.polling_config?.telegram_enabled ? 'no runs yet' : 'disabled'}</span>
    {/if}
  </div>
  {#if telegramSocial}
    <div class="catch-up" title={telegramSocial.title}>{telegramSocial.label}</div>
  {/if}
</div>

<style>
  .collector-status {
    background: rgba(255, 255, 255, 0.35);
    border: 1.5px solid rgba(42, 36, 16, 0.2);
    border-radius: 8px;
    margin: 0.75rem 0.5rem;
    padding: 0.6rem 0.7rem;
  }
  .collector-status.is-paused { border-style: dashed; }
  .status-header { align-items: center; display: flex; gap: 0.4rem; flex-wrap: wrap; justify-content: space-between; margin-bottom: 0.45rem; }
  .label {
    align-items: center;
    color: var(--sidebar-text-muted);
    display: flex;
    font: 500 0.66rem var(--mono);
    gap: 0.35rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .header-btns { display: flex; gap: 0.3rem; }
  .btn-trigger,
  .btn-pause {
    border: 1.5px solid var(--canary-ink);
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.68rem;
    font-weight: 600;
    padding: 0.15rem 0.45rem;
    white-space: nowrap;
  }
  .btn-trigger { background: var(--canary-ink); color: var(--canary); }
  .btn-trigger:hover:not(:disabled) { background: var(--ink-2); }
  .btn-trigger:disabled { opacity: 0.4; cursor: default; }
  .btn-pause { background: transparent; color: var(--canary-ink); }
  .btn-pause:hover:not(:disabled) { background: rgba(42, 36, 16, 0.1); }
  .btn-pause:disabled { opacity: 0.5; cursor: default; }
  .btn-resume { background: var(--moss); border-color: var(--moss); color: #fff; }
  .btn-resume:hover:not(:disabled) { background: var(--moss-deep); }

  .lane-row { align-items: center; display: flex; font-size: 0.74rem; gap: 0.4rem; padding: 0.1rem 0; }
  .lane-name { font-weight: 600; min-width: 48px; }
  .lane-time { font-family: var(--mono); font-size: 0.68rem; opacity: 0.75; }
  .lane-counts { font-family: var(--mono); font-size: 0.68rem; }
  .lane-ok { color: var(--moss); font-size: 0.7rem; font-weight: 700; }
  .lane-error { color: var(--signal); cursor: help; font-weight: 700; }
  .muted { opacity: 0.55; }
  .broken { border-left: 3px solid var(--signal); font-size: 0.7rem; line-height: 1.4; margin: 0 0 0.45rem; padding: 0.2rem 0 0.2rem 0.45rem; }
  .broken code { font-family: var(--mono); font-size: 0.66rem; overflow-wrap: anywhere; }
  .broken a { color: inherit; display: block; font-weight: 600; margin-top: 0.15rem; }
  .catch-up { font-size: 0.68rem; line-height: 1.35; margin: 0 0 0.2rem 48px; opacity: 0.85; }
</style>
