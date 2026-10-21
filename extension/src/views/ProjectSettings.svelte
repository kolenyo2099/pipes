<script>
  import NlpSettings from '../components/NlpSettings.svelte'
  import { onMount } from 'svelte'
  import { api } from '../api.js'
  import {
    currentProjectId, currentProject, projects, currentView, notify,
  } from '../stores/app.js'
  import QueryBuilder from '../components/QueryBuilder.svelte'
  import {
    cloneMediaCloudCollections,
    enabledMediaCloudRulesAreConfigured,
    mediaCloudCollectionsForRules,
  } from '../lib/mediacloudRules.js'

  let name = ''
  let sheetUrl = ''
  let sheetToken = ''
  let sheetPageUrl = ''
  let autoSend = true
  let eventsEnabled = true
  let docEnabled = false
  let rssEnabled = false
  let mediacloudEnabled = false
  let xEnabled = false
  let blueskyEnabled = false
  let telegramEnabled = false
  let mediacloudCollections = []
  let legacyMediaCloudCollections = []
  let eventsInterval = 30
  let docInterval = 60
  let rssInterval = 60
  let xInterval = 60
  let blueskyInterval = 60
  let telegramInterval = 60
  let xBudget = 20
  let blueskyBudget = 300
  let telegramBudget = 60
  let scriptCopied = false

  // Apps Script that users paste into their Google Sheet's bound script editor.
  // Uses getActiveSpreadsheet() — works automatically when created from
  // Extensions → Apps Script inside the sheet (container-bound, no ID needed).
  const APPS_SCRIPT = `// canary-script-version: 4
var CANARY_VERSION = '4';

// Visit the web app URL in a browser to confirm which version is deployed.
function doGet() {
  return ContentService.createTextOutput('canary-script-version: ' + CANARY_VERSION)
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var SHEET_NAME = 'canary'; // tab name — created automatically if missing
  var step = 'init';

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    step = 'read-body';
    var raw = e.postData.contents;
    Logger.log('canary v' + CANARY_VERSION + ' | step=' + step + ' | raw=' + raw.substring(0, 300));

    step = 'parse-json';
    var data = JSON.parse(raw);

    step = 'check-token';
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (token && data.token !== token) {
      return ContentService.createTextOutput('Unauthorized')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    step = 'extract-arrays';
    var headers = data.headers; // ordered column names sent by Canary
    var values  = data.values;  // ordered values — same index as headers
    if (!headers || !values || headers.length !== values.length) {
      return ContentService.createTextOutput(
        'ERROR: malformed payload — headers(' + (headers ? headers.length : 'null') +
        ') values(' + (values ? values.length : 'null') + ')'
      ).setMimeType(ContentService.MimeType.TEXT);
    }

    step = 'get-sheet';
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

    step = 'append-header';
    if (sheet.getLastRow() === 0) sheet.appendRow(headers);

    step = 'append-values';
    // Coerce any residual null/undefined cells to empty string to be safe.
    var safeValues = values.map(function(v) { return v == null ? '' : v; });
    sheet.appendRow(safeValues);

    return ContentService.createTextOutput('OK')
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    Logger.log('canary v' + CANARY_VERSION + ' | FAILED at step=' + step + ' | ' + err.message);
    return ContentService.createTextOutput('ERROR: [' + step + '] ' + err.message)
      .setMimeType(ContentService.MimeType.TEXT);
  } finally {
    lock.releaseLock();
  }
}`

  async function copyScript() {
    await navigator.clipboard.writeText(APPS_SCRIPT)
    scriptCopied = true
    setTimeout(() => scriptCopied = false, 2000)
  }

  let saving = false
  let deleting = false
  let showDeleteConfirm = false
  let allCountries = []
  let selectedCountries = []
  let countrySearch = ''
  let watchlists = []
  let ontology = {}
  let savingRules = false
  let rulesSaveRequested = 0
  let rulesSaveCompleted = 0
  let rulesSaveInFlight = false
  let rulesSaveTask = null
  let pendingRulePollingOverrides = {}

  // QueryBuilder state
  let showQueryBuilder = false
  let editingRuleIdx = null

  // ── Ruleset export / import ───────────────────────────────────────────────
  let importFileInput

  function recomputeMediaCloudCollections(previousFallback = legacyMediaCloudCollections) {
    mediacloudCollections = mediaCloudCollectionsForRules(watchlists, previousFallback)
  }

  function reconcileMediaCloudLaneAfterRuleMutation(affected, enableWhenConfigured = false) {
    if (!affected) return false
    const configured = enabledMediaCloudRulesAreConfigured(watchlists, mediacloudCollections)
    if (!configured) {
      mediacloudEnabled = false
      return false
    }
    if (enableWhenConfigured) mediacloudEnabled = true
    return enableWhenConfigured
  }

  function exportRuleset() {
    const slug = name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'ruleset'
    const envelope = {
      foresight_ruleset: '1.0',
      name: name.trim(),
      exported_at: new Date().toISOString(),
      rules: watchlists,
    }
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${slug}_rules.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleImportFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''
    const reader = new FileReader()
    reader.onload = (e) => {
      let parsed
      try { parsed = JSON.parse(e.target.result) } catch {
        notify('error', 'Invalid file — could not parse JSON')
        return
      }
      if (parsed?.foresight_ruleset !== '1.0') {
        notify('error', 'Not a valid Foresight ruleset file')
        return
      }
      const incoming = parsed.rules
      if (!Array.isArray(incoming) || incoming.length === 0) {
        notify('error', 'No rules found in file')
        return
      }
      const valid = incoming.filter(r => r?.bucket_name && r?.lane && r?.logic)
      if (valid.length === 0) {
        notify('error', 'No valid rules found in file')
        return
      }
      const skipped = incoming.length - valid.length
      const previousFallback = mediacloudCollections
      const hadLegacyMediaCloudRule = watchlists.some(r => (
        r.lane === 'mediacloud' && !Array.isArray(r.logic?.mediacloud_collections)
      ))
      if (!hadLegacyMediaCloudRule && valid.some(r => (
        r.lane === 'mediacloud' && !Array.isArray(r.logic?.mediacloud_collections)
      ))) {
        legacyMediaCloudCollections = cloneMediaCloudCollections(previousFallback)
      }
      watchlists = [...watchlists, ...valid]
      recomputeMediaCloudCollections(legacyMediaCloudCollections)
      if (valid.some(r => r.lane === 'rss')) rssEnabled = true
      const enableMediaCloud = reconcileMediaCloudLaneAfterRuleMutation(
        valid.some(r => r.lane === 'mediacloud'),
        true,
      )
      saveRulesNow({
        enableLanes: [
          ...(valid.some(r => r.lane === 'rss') ? ['rss'] : []),
          ...(enableMediaCloud ? ['mediacloud'] : []),
        ],
      })
      const label = parsed.name ? `"${parsed.name}"` : file.name
      const msg = skipped > 0
        ? `Added ${valid.length} rule(s) from ${label} — ${skipped} skipped (invalid)`
        : `Added ${valid.length} rule(s) from ${label}`
      notify('success', msg)
    }
    reader.readAsText(file)
  }

  async function loadOntology() {
    const r = await api.getOntology()
    if (r.ok) {
      ontology = r.data
      allCountries = r.data.countries || []
    }
  }

  function populateForm(project) {
    if (!project) return
    name = project.name
    selectedCountries = [...(project.countries_focus || [])]
    watchlists = JSON.parse(JSON.stringify(project.watchlists || []))
    eventsEnabled = project.polling_config?.events_enabled ?? true
    docEnabled = project.polling_config?.doc_enabled ?? false
    rssEnabled = project.polling_config?.rss_enabled ?? false
    mediacloudEnabled = project.polling_config?.mediacloud_enabled ?? false
    xEnabled = project.polling_config?.x_enabled ?? false
    blueskyEnabled = project.polling_config?.bluesky_enabled ?? false
    telegramEnabled = project.polling_config?.telegram_enabled ?? false
    legacyMediaCloudCollections = cloneMediaCloudCollections(project.mediacloud_collections || [])
    recomputeMediaCloudCollections(legacyMediaCloudCollections)
    eventsInterval = project.polling_config?.events_interval_minutes ?? 30
    docInterval = project.polling_config?.doc_interval_minutes ?? 60
    rssInterval = project.polling_config?.rss_interval_minutes ?? 60
    xInterval = project.polling_config?.x_interval_minutes ?? 60
    blueskyInterval = project.polling_config?.bluesky_interval_minutes ?? 60
    telegramInterval = project.polling_config?.telegram_interval_minutes ?? 60
    sheetUrl = project.sheet_sink?.url || ''
    sheetToken = project.sheet_sink?.token || ''
    sheetPageUrl = project.sheet_sink?.sheet_url || ''
    autoSend = project.sheet_sink?.auto_send_on_save ?? true
  }

  // ── Headline enrichment (GDELT events carry generated titles) ─────────────
  let titleEnrichment = false
  let savingTitleEnrichment = false

  async function toggleTitleEnrichment(event) {
    const wanted = event.currentTarget.checked
    savingTitleEnrichment = true
    const res = await api.setTitleEnrichment(wanted)
    savingTitleEnrichment = false
    if (res.ok) titleEnrichment = res.data
    else {
      titleEnrichment = !wanted
      notify('error', res.error)
    }
  }

  // X rules read x.com and Telegram rules t.me, so turning the lane on asks Chrome for access (again, if it was removed).
  function allowOnEnable(event, origin, turnOff) {
    if (!event.currentTarget.checked) return
    api.allowSites([origin]).then(result => {
      if (result.ok) return
      turnOff()
      notify('error', result.error)
    })
  }

  // X and Bluesky budgets are shared by all projects, so they save as they change rather than with the project.
  async function saveBudget(lane, per) {
    const result = await api.setSocialBudget(lane, per)
    if (!result.ok) notify('error', result.error)
  }

  onMount(async () => {
    await loadOntology()
    populateForm($currentProject)
    const res = await api.getTitleEnrichment()
    if (res.ok) titleEnrichment = res.data
    const budgets = await api.getSocialBudgets()
    if (budgets.ok) {
      xBudget = budgets.data.x.per
      blueskyBudget = budgets.data.bluesky.per
      telegramBudget = budgets.data.telegram?.per ?? telegramBudget
    }
  })

  // NOTE: No reactive $: populateForm here — that would reset local edits
  // whenever the store updates (e.g. after save()). Populate only on mount
  // and explicitly after the user's own saves.

  $: filteredCountries = countrySearch
    ? allCountries.filter(c =>
        c.name.toLowerCase().includes(countrySearch.toLowerCase()) ||
        c.code.toLowerCase().includes(countrySearch.toLowerCase())
      )
    : allCountries

  // Group rules by bucket_name so rules with multiple lanes appear as one row.
  $: groupedRules = (() => {
    const seen = new Map()
    watchlists.forEach((rule, idx) => {
      if (!seen.has(rule.bucket_name)) {
        seen.set(rule.bucket_name, { bucket_name: rule.bucket_name, rules: [] })
      }
      seen.get(rule.bucket_name).rules.push({ rule, idx })
    })
    return [...seen.values()]
  })()

  function toggleCountry(code) {
    if (selectedCountries.includes(code)) {
      selectedCountries = selectedCountries.filter(c => c !== code)
    } else {
      selectedCountries = [...selectedCountries, code]
    }
  }

  function toggleWatchlist(idx) {
    const affectsMediaCloud = watchlists[idx]?.lane === 'mediacloud'
    watchlists = watchlists.map((w, i) =>
      i === idx ? { ...w, enabled: !w.enabled } : w
    )
    recomputeMediaCloudCollections()
    reconcileMediaCloudLaneAfterRuleMutation(affectsMediaCloud)
    saveRulesNow()
  }

  function openNewRule() {
    editingRuleIdx = null
    showQueryBuilder = true
  }

  function openEditRule(idx) {
    editingRuleIdx = idx
    showQueryBuilder = true
  }

  function savedLaneWasAddedOrChanged(newRules, lane, editedBucket) {
    const savedRule = newRules.find(candidate => candidate.lane === lane)
    if (!savedRule) return false
    const existingRule = watchlists.find(candidate => (
      candidate.bucket_name === editedBucket && candidate.lane === lane
    ))
    if (!existingRule) return true
    return JSON.stringify({ logic: savedRule.logic, enabled: savedRule.enabled })
      !== JSON.stringify({ logic: existingRule.logic, enabled: existingRule.enabled })
  }

  function handleRuleSaved(saved) {
    const newRules = Array.isArray(saved) ? saved : [saved]
    const editedBucket = editingRuleIdx !== null ? watchlists[editingRuleIdx]?.bucket_name : null
    const rssChanged = savedLaneWasAddedOrChanged(newRules, 'rss', editedBucket)
    const mediaCloudChanged = savedLaneWasAddedOrChanged(newRules, 'mediacloud', editedBucket)
    const xChanged = savedLaneWasAddedOrChanged(newRules, 'x', editedBucket)
    const blueskyChanged = savedLaneWasAddedOrChanged(newRules, 'bluesky', editedBucket)
    const telegramChanged = savedLaneWasAddedOrChanged(newRules, 'telegram', editedBucket)
    const savedLanes = new Set(newRules.map(rule => rule.lane))
    watchlists = [
      ...watchlists.filter((rule, idx) => {
        if (editingRuleIdx !== null && rule.bucket_name === editedBucket && savedLanes.has(rule.lane)) {
          return false
        }
        return !newRules.some(newRule => (
          idx !== editingRuleIdx &&
          rule.bucket_name === newRule.bucket_name &&
          rule.lane === newRule.lane
        ))
      }),
      ...newRules,
    ]
    recomputeMediaCloudCollections()
    if (rssChanged) rssEnabled = true
    if (xChanged) xEnabled = true
    if (blueskyChanged) blueskyEnabled = true
    if (telegramChanged) telegramEnabled = true
    const enableMediaCloud = reconcileMediaCloudLaneAfterRuleMutation(
      mediaCloudChanged,
      true,
    )
    showQueryBuilder = false
    editingRuleIdx = null
    // Auto-persist so rules are never lost even without hitting "Save Changes"
    saveRulesNow({
      enableLanes: [
        ...(rssChanged ? ['rss'] : []),
        ...(enableMediaCloud ? ['mediacloud'] : []),
        ...(xChanged ? ['x'] : []),
        ...(blueskyChanged ? ['bluesky'] : []),
        ...(telegramChanged ? ['telegram'] : []),
      ],
    })
  }

  function removeRule(idx) {
    const affectsMediaCloud = watchlists[idx]?.lane === 'mediacloud'
    watchlists = watchlists.filter((_, i) => i !== idx)
    recomputeMediaCloudCollections()
    reconcileMediaCloudLaneAfterRuleMutation(affectsMediaCloud)
    saveRulesNow()
  }

  // ── Grouped-rule helpers (one row per bucket_name) ────────────────────────

  function toggleGroupWatchlist(group) {
    const allEnabled = group.rules.every(r => r.rule.enabled)
    const affectsMediaCloud = group.rules.some(r => r.rule.lane === 'mediacloud')
    const idxSet = new Set(group.rules.map(r => r.idx))
    watchlists = watchlists.map((w, i) =>
      idxSet.has(i) ? { ...w, enabled: !allEnabled } : w
    )
    recomputeMediaCloudCollections()
    reconcileMediaCloudLaneAfterRuleMutation(affectsMediaCloud)
    saveRulesNow()
  }

  function openEditGroupRule(group) {
    const eventsEntry = group.rules.find(r => r.rule.lane === 'events')
    const docEntry = group.rules.find(r => r.rule.lane === 'doc' || r.rule.lane === 'context')
    const rssEntry = group.rules.find(r => r.rule.lane === 'rss')
    const mediacloudEntry = group.rules.find(r => r.rule.lane === 'mediacloud')
    const primary = eventsEntry || docEntry || rssEntry || mediacloudEntry || group.rules[0]
    editingRuleIdx = primary.idx
    showQueryBuilder = true
  }

  function removeGroupRule(group) {
    const affectsMediaCloud = group.rules.some(r => r.rule.lane === 'mediacloud')
    const idxSet = new Set(group.rules.map(r => r.idx))
    watchlists = watchlists.filter((_, i) => !idxSet.has(i))
    recomputeMediaCloudCollections()
    reconcileMediaCloudLaneAfterRuleMutation(affectsMediaCloud)
    saveRulesNow()
  }

  // ── Data helpers ─────────────────────────────────────────────────────────────

  function buildSaveData() {
    const data = {
      name: name.trim(),
      countries_focus: selectedCountries,
      watchlists: watchlists,
      polling_config: {
        events_enabled: eventsEnabled,
        doc_enabled: docEnabled,
        rss_enabled: rssEnabled,
        mediacloud_enabled: mediacloudEnabled,
        x_enabled: xEnabled,
        bluesky_enabled: blueskyEnabled,
        telegram_enabled: telegramEnabled,
        events_interval_minutes: eventsInterval,
        doc_interval_minutes: docInterval,
        rss_interval_minutes: rssInterval,
        mediacloud_interval_minutes: 1440,
        x_interval_minutes: xInterval,
        bluesky_interval_minutes: blueskyInterval,
        telegram_interval_minutes: telegramInterval,
        overlap_minutes: 15,
      },
      mediacloud_collections: mediacloudCollections,
    }
    if (sheetUrl.trim()) {
      data.sheet_sink = {
        url: sheetUrl.trim(),
        token: sheetToken.trim() || null,
        auto_send_on_save: autoSend,
        sheet_url: sheetPageUrl.trim() || null,
      }
    } else {
      // Explicitly clear the sink — sending null would be indistinguishable
      // from "omit / no change" due to how serde deserialises Option<T>.
      data.clear_sheet_sink = true
    }
    return data
  }

  // Queue rule saves so responses arrive in mutation order. Only the newest
  // response may sync local rule state; form fields outside this rules section
  // are intentionally omitted so their unsaved edits remain unsaved.
  function saveRulesNow({ enableLanes = [] } = {}) {
    if (!$currentProjectId) return Promise.resolve()
    for (const lane of enableLanes) {
      if (lane === 'rss') pendingRulePollingOverrides.rss_enabled = true
      if (lane === 'mediacloud') pendingRulePollingOverrides.mediacloud_enabled = true
      if (lane === 'x') pendingRulePollingOverrides.x_enabled = true
      if (lane === 'bluesky') pendingRulePollingOverrides.bluesky_enabled = true
      if (lane === 'telegram') pendingRulePollingOverrides.telegram_enabled = true
    }
    rulesSaveRequested += 1
    if (!rulesSaveTask) {
      rulesSaveTask = flushRuleSaves().finally(() => {
        rulesSaveTask = null
      })
    }
    return rulesSaveTask
  }

  async function flushRuleSaves() {
    if (rulesSaveInFlight) return
    rulesSaveInFlight = true
    savingRules = true
    try {
      while (rulesSaveCompleted < rulesSaveRequested) {
        const requestSequence = rulesSaveRequested
        const rulesSnapshot = JSON.parse(JSON.stringify(watchlists))
        const collectionsSnapshot = mediaCloudCollectionsForRules(
          rulesSnapshot,
          legacyMediaCloudCollections,
        )
        const pollingOverrides = { ...pendingRulePollingOverrides }
        const mediaCloudConfigured = enabledMediaCloudRulesAreConfigured(
          rulesSnapshot,
          collectionsSnapshot,
        )

        // A rule edit can remove or disable the final configured Media Cloud
        // rule. Keep the stored lane safely off while leaving the user's local
        // checkbox choice untouched so the inline guidance remains visible.
        if (!mediaCloudConfigured && (
          $currentProject?.polling_config?.mediacloud_enabled
          || mediacloudEnabled
          || pollingOverrides.mediacloud_enabled
        )) {
          pollingOverrides.mediacloud_enabled = false
        }

        const data = {
          watchlists: rulesSnapshot,
          mediacloud_collections: collectionsSnapshot,
        }
        if (Object.keys(pollingOverrides).length > 0) {
          data.polling_config = {
            ...($currentProject?.polling_config || {}),
            ...pollingOverrides,
          }
        }

        const result = await api.updateProject($currentProjectId, data)
        rulesSaveCompleted = requestSequence
        if (!result.ok) {
          if (requestSequence === rulesSaveRequested) {
            notify('error', `Failed to save rule: ${result.error}`)
          }
          continue
        }

        if (requestSequence === rulesSaveRequested) {
          currentProject.set(result.data)
          projects.update(ps => ps.map(p => p.project_id === result.data.project_id ? result.data : p))
          watchlists = JSON.parse(JSON.stringify(result.data.watchlists || []))
          recomputeMediaCloudCollections()
          pendingRulePollingOverrides = {}
        }
      }
    } finally {
      savingRules = false
      rulesSaveInFlight = false
    }
  }

  async function save() {
    if (!name.trim()) return
    if (mediacloudEnabled && !enabledMediaCloudRulesAreConfigured(watchlists, mediacloudCollections)) {
      notify('error', 'Add or edit an enabled Media Cloud rule and choose at least one collection.')
      return
    }
    if (rulesSaveTask) await rulesSaveTask
    saving = true
    const result = await api.updateProject($currentProjectId, buildSaveData())
    saving = false
    if (result.ok) {
      currentProject.set(result.data)
      projects.update(ps => ps.map(p => p.project_id === result.data.project_id ? result.data : p))
      notify('success', 'Project settings saved')
    } else {
      notify('error', `Save failed: ${result.error}`)
    }
  }

  async function deleteProject() {
    deleting = true
    const result = await api.deleteProject($currentProjectId)
    deleting = false
    if (result.ok) {
      projects.update(ps => ps.filter(p => p.project_id !== $currentProjectId))
      currentProjectId.set(null)
      currentProject.set(null)
      currentView.set('new-project')
      notify('info', 'Project deleted')
    } else {
      notify('error', `Delete failed: ${result.error}`)
    }
  }
</script>

<div class="settings-view">
  <div class="page-header">
    <h1 class="view-title">Project Settings</h1>
    <div class="header-meta">
      {#if $currentProject?.collecting_since}
        <span class="collecting-since">
          Collecting since {new Date($currentProject.collecting_since).toLocaleString()}
        </span>
      {/if}
    </div>
  </div>

  <!-- Name -->
  <section class="step">
    <h2 class="step-title">Name</h2>
    <input type="text" class="form-input form-input--wide" bind:value={name} />
  </section>

  <!-- Countries -->
  <section class="step">
    <h2 class="step-title">Countries of interest</h2>
    <p class="step-hint">Used to filter GDELT events to relevant actors and locations.</p>
    {#if selectedCountries.length > 0}
      <div class="selected-countries">
        {#each selectedCountries as code}
          {@const country = allCountries.find(c => c.code === code)}
          <span class="country-chip">
            {country ? country.name : code}
            <button class="chip-remove" on:click={() => toggleCountry(code)}>✕</button>
          </span>
        {/each}
      </div>
    {/if}
    <input
      type="text"
      class="form-input country-search"
      placeholder="Search countries…"
      bind:value={countrySearch}
    />
    <div class="country-list">
      {#each filteredCountries.slice(0, 80) as c}
        <button
          class="country-option"
          class:selected={selectedCountries.includes(c.code)}
          on:click={() => toggleCountry(c.code)}
        >
          {c.name} ({c.code})
        </button>
      {/each}
      {#if filteredCountries.length > 80}
        <span class="country-overflow">+{filteredCountries.length - 80} more — refine search</span>
      {/if}
    </div>
  </section>

  <!-- Watchlist rules -->
  <section class="step">
    <h2 class="step-title">
      Monitoring rules
      {#if savingRules}<span class="saving-badge">saving…</span>{/if}
      <span class="ruleset-actions">
        <button class="btn-ruleset" on:click={exportRuleset} disabled={watchlists.length === 0} title="Export rules to .json file">Export</button>
        <button class="btn-ruleset" on:click={() => importFileInput.click()} title="Load rules from .json file">Load</button>
      </span>
    </h2>
    <input type="file" accept=".json" bind:this={importFileInput} style="display:none" on:change={handleImportFile} />
    <p class="step-hint">Toggle rules on/off, edit existing rules, or add new ones. Changes are saved automatically.</p>
    <div class="rule-list">
      {#each groupedRules as group}
        {@const allEnabled = group.rules.every(r => r.rule.enabled)}
        {@const anyEnabled = group.rules.some(r => r.rule.enabled)}
        {@const primaryRule = (group.rules.find(r => r.rule.lane === 'events') || group.rules.find(r => r.rule.lane === 'doc' || r.rule.lane === 'context') || group.rules.find(r => r.rule.lane === 'rss') || group.rules.find(r => r.rule.lane === 'mediacloud') || group.rules[0]).rule}
        <div class="rule-item" class:rule-disabled={!anyEnabled}>
          <div class="rule-main">
            <label class="rule-check">
              <input
                type="checkbox"
                checked={allEnabled}
                on:change={() => toggleGroupWatchlist(group)}
              />
              <span class="rule-name">{group.bucket_name}</span>
            </label>
            <div class="lane-badges">
              {#each group.rules as { rule }}
                <span class="lane-badge lane-badge--{rule.lane}">{rule.lane}</span>
              {/each}
            </div>
            <div class="rule-actions">
              <button class="btn-rule-edit" on:click={() => openEditGroupRule(group)}>Edit</button>
              <button class="btn-rule-remove" on:click={() => removeGroupRule(group)}>✕</button>
            </div>
          </div>
          <div class="rule-desc">{primaryRule.logic?.description || ''}</div>
          <details class="rule-logic-details">
            <summary class="rule-summary">View rule logic</summary>
            {#each group.rules as { rule }}
              {#if group.rules.length > 1}
                <div class="rule-lane-header">{rule.lane}</div>
              {/if}
              <pre class="rule-pre">{JSON.stringify(rule.logic, null, 2)}</pre>
            {/each}
          </details>
        </div>
      {/each}
    </div>
    <button class="btn-add-rule" on:click={openNewRule}>
      + Add custom rule
    </button>
  </section>

  <!-- Polling -->
  <section class="step">
    <h2 class="step-title">Collection config</h2>
    <div class="config-grid">
      <div class="toggle-row">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={eventsEnabled} />
          Events lane
        </label>
      </div>
      <div class="form-group">
        <label for="events-interval">Events interval (minutes)</label>
        <input id="events-interval" type="number" class="form-input form-input--sm" bind:value={eventsInterval} min="15" max="120" />
      </div>
      <div class="toggle-row">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={docEnabled} />
          GKG lane
        </label>
      </div>
      <div class="form-group">
        <label for="gkg-interval">GKG interval (minutes)</label>
        <input id="gkg-interval" type="number" class="form-input form-input--sm" bind:value={docInterval} min="15" max="240" />
        <p class="form-hint">GKG flat files are published every 15 min. Both English and translated sources are covered automatically.</p>
      </div>
      <div class="toggle-row">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={rssEnabled} />
          Google News RSS lane
        </label>
      </div>
      <div class="form-group">
        <label for="rss-interval">RSS interval (minutes)</label>
        <input id="rss-interval" type="number" class="form-input form-input--sm" bind:value={rssInterval} min="15" max="240" />
        <p class="form-hint">RSS rules are compiled into multiple Google News searches, then re-filtered locally against the saved wizard answers.</p>
      </div>
      <div class="toggle-row toggle-row--stacked">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={mediacloudEnabled} />
          Media Cloud lane
        </label>
        {#if mediacloudEnabled && !enabledMediaCloudRulesAreConfigured(watchlists, mediacloudCollections)}
          <p class="lane-hint">Add or edit a Media Cloud rule to choose its collections.</p>
        {/if}
      </div>
      <div class="form-group">
        <div class="form-label">Media Cloud interval</div>
        <div class="form-hint">Once daily (1,440 minutes), with a one-day overlap.</div>
      </div>
      <div class="toggle-row">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={xEnabled} on:change={event => allowOnEnable(event, 'https://x.com/*', () => { xEnabled = false })} />
          X lane
        </label>
      </div>
      <div class="form-group">
        <label for="x-interval">X interval (minutes)</label>
        <input id="x-interval" type="number" class="form-input form-input--sm" bind:value={xInterval} min="15" max="1440" />
        <label for="x-budget">X searches per 15 minutes, all projects</label>
        <input id="x-budget" type="number" class="form-input form-input--sm" bind:value={xBudget} min="1" max="50" on:change={() => saveBudget('x', xBudget)} />
        <p class="form-hint">X rules search x.com in a background tab of this browser, signed in as you, and collect every post since the last run; quiet searches are checked less often. X allows about 50 searches per 15 minutes per account, and staying well under that keeps your account safe. Past the budget, collection slows down instead of searching more.</p>
      </div>
      <div class="toggle-row">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={blueskyEnabled} />
          Bluesky lane
        </label>
      </div>
      <div class="form-group">
        <label for="bluesky-interval">Bluesky interval (minutes)</label>
        <input id="bluesky-interval" type="number" class="form-input form-input--sm" bind:value={blueskyInterval} min="15" max="1440" />
        <label for="bluesky-budget">Bluesky requests per 5 minutes, all projects</label>
        <input id="bluesky-budget" type="number" class="form-input form-input--sm" bind:value={blueskyBudget} min="1" max="3000" on:change={() => saveBudget('bluesky', blueskyBudget)} />
        <p class="form-hint">Bluesky rules search Bluesky's API as the account connected in the Bluesky rule editor and collect every post since the last run; quiet searches are checked less often. Bluesky allows 3,000 requests per 5 minutes per internet connection, shared with your own use.</p>
      </div>
      <div class="toggle-row">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={telegramEnabled} on:change={event => allowOnEnable(event, 'https://t.me/*', () => { telegramEnabled = false })} />
          Telegram lane
        </label>
      </div>
      <div class="form-group">
        <label for="telegram-interval">Telegram interval (minutes)</label>
        <input id="telegram-interval" type="number" class="form-input form-input--sm" bind:value={telegramInterval} min="15" max="1440" />
        <label for="telegram-budget">Telegram pages per 5 minutes, all projects</label>
        <input id="telegram-budget" type="number" class="form-input form-input--sm" bind:value={telegramBudget} min="1" max="120" on:change={() => saveBudget('telegram', telegramBudget)} />
        <p class="form-hint">Telegram rules read public channels through their web preview on t.me, without signing in, and collect every post since the last run; a new channel goes back at most 30 days. Telegram publishes no limit for the preview, so pages are spaced a few seconds apart.</p>
      </div>
    </div>
  </section>

  <!-- Sheets -->
  <section class="step">
    <h2 class="step-title">Google Sheets sink</h2>
    <p class="step-hint">Push saved items to a Google Sheet automatically. Takes 2 minutes to set up — no spreadsheet ID needed.</p>

    <!-- Setup steps (collapsed once URL is filled in) -->
    {#if !sheetUrl.trim()}
      <div class="sheet-setup">
        <div class="setup-step">
          <span class="step-num">1</span>
          <div class="step-body">
            <strong>Open your Google Sheet</strong>, then go to
            <strong>Extensions → Apps Script</strong>.
            This creates a script that is automatically linked to that sheet —
            no IDs to copy.
          </div>
        </div>
        <div class="setup-step">
          <span class="step-num">2</span>
          <div class="step-body">
            <strong>Replace any existing code</strong> with the script below, then save (⌘S / Ctrl+S).
            <div class="script-block">
              <pre class="script-pre">{APPS_SCRIPT}</pre>
              <button class="btn-copy-script" on:click={copyScript}>
                {scriptCopied ? '✓ Copied!' : 'Copy script'}
              </button>
            </div>
          </div>
        </div>
        <div class="setup-step">
          <span class="step-num">3</span>
          <div class="step-body">
            Click <strong>Deploy → New deployment</strong>.
            Set type to <em>Web app</em>, execute as <em>Me</em>,
            and access to <strong>Anyone</strong> (not "Anyone with a Google account").
            Click <strong>Deploy</strong> and authorise when prompted.
          </div>
        </div>
        <div class="setup-step">
          <span class="step-num">4</span>
          <div class="step-body">
            Copy the <strong>Web app URL</strong> and paste it below.
            A new tab named <em>canary</em> will be created in your sheet automatically.
          </div>
        </div>
      </div>
    {/if}

    <div class="form-group">
      <label for="s-url">Web app URL</label>
      <input id="s-url" type="url" class="form-input form-input--wide"
        placeholder="https://script.google.com/macros/s/…/exec"
        bind:value={sheetUrl} />
    </div>
    <div class="form-group">
      <label for="s-token">
        Token <span class="hint">(optional — set via Script Properties in Apps Script)</span>
      </label>
      <input id="s-token" type="text" class="form-input" placeholder="shared-secret" bind:value={sheetToken} />
    </div>
    <div class="form-group">
      <label for="s-page-url">
        Spreadsheet URL <span class="hint">(optional — enables the "Open spreadsheet" button)</span>
      </label>
      <input id="s-page-url" type="url" class="form-input form-input--wide"
        placeholder="https://docs.google.com/spreadsheets/d/…/edit"
        bind:value={sheetPageUrl} />
    </div>
    <label class="toggle-label">
      <input type="checkbox" bind:checked={autoSend} />
      Auto-send on save
    </label>
  </section>

  <NlpSettings />

  <!-- Headline enrichment (browser-wide setting) -->
  <section class="step">
    <h2 class="step-title">Event headlines</h2>
    <p class="step-help">
      GDELT events arrive with generated titles such as “Mexico [190] United States @ Tijuana”.
      Canary can read the start of each new event’s article to use its real headline instead (up to 20 per run).
      Chrome asks once for access to article pages; turn this off to remove that access.
    </p>
    <label class="toggle-label">
      <input type="checkbox" checked={titleEnrichment} disabled={savingTitleEnrichment} on:change={toggleTitleEnrichment} />
      Fetch article headlines for new events
    </label>
  </section>

  <!-- Actions -->
  <div class="settings-actions">
    <button class="btn-save" on:click={save} disabled={saving}>
      {saving ? 'Saving…' : 'Save Changes'}
    </button>
  </div>

  <!-- Danger zone -->
  <section class="danger-zone">
    <h2 class="step-title danger-title">Danger Zone</h2>
    {#if !showDeleteConfirm}
      <button class="btn-delete" on:click={() => showDeleteConfirm = true}>
        Delete this project
      </button>
    {:else}
      <div class="confirm-delete">
        <p>This will permanently delete the project, all its items, and its archive files tracked by this browser. Are you sure?</p>
        <div class="confirm-actions">
          <button class="btn-cancel" on:click={() => showDeleteConfirm = false}>Cancel</button>
          <button class="btn-confirm-delete" on:click={deleteProject} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Yes, delete permanently'}
          </button>
        </div>
      </div>
    {/if}
  </section>
</div>

<!-- QueryBuilder slide-in -->
{#if showQueryBuilder}
  <QueryBuilder
    rule={editingRuleIdx !== null ? watchlists[editingRuleIdx] : null}
    relatedRules={editingRuleIdx !== null
      ? watchlists.filter((_, i) => i !== editingRuleIdx && watchlists[i].bucket_name === watchlists[editingRuleIdx]?.bucket_name)
      : []}
    projectCountries={selectedCountries}
    mediaCloudCollections={mediacloudCollections}
    {ontology}
    onSave={handleRuleSaved}
    onCancel={() => { showQueryBuilder = false; editingRuleIdx = null }}
  />
{/if}

<style>
  .settings-view { max-width: 680px; padding: 1.5rem 2rem; }

  .page-header { align-items: baseline; display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .view-title { font-size: 1.3rem; font-weight: 700; margin: 0; }
  .collecting-since { color: var(--text-muted); font-size: 0.78rem; }

  .step { border-bottom: 1px solid var(--border-light); margin-bottom: 1.5rem; padding-bottom: 1.5rem; }
  .step-title { align-items: center; display: flex; font-size: 1rem; font-weight: 600; gap: 0.5rem; margin: 0 0 0.6rem; }
  .step-hint { color: var(--text-muted); font-size: 0.82rem; margin: 0 0 0.75rem; }
  .step-help { color: var(--text-muted); font-size: 0.82rem; line-height: 1.45; margin: 0 0 0.75rem; }

  .btn-secondary { background: var(--bg-hover); border: 1px solid var(--border); border-radius: 5px; color: var(--text); cursor: pointer; font-size: 0.82rem; padding: 0.35rem 0.85rem; }
  .btn-secondary:hover:not(:disabled) { background: var(--line); }
  .btn-secondary:disabled { cursor: default; opacity: 0.55; }
  .link-btn { background: none; border: none; color: var(--accent, var(--accent)); cursor: pointer; font: inherit; padding: 0; text-decoration: underline; }
  .saving-badge {
    background: var(--accent-soft);
    border-radius: 10px;
    color: var(--accent-strong);
    font-size: 0.68rem;
    font-weight: 500;
    padding: 0.1rem 0.5rem;
  }

  .form-input { border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: var(--bg-card); font-size: 0.85rem; padding: 0.45rem 0.6rem; }
  .form-input:focus { border-color: var(--accent); outline: none; }
  .form-input--wide { width: 100%; box-sizing: border-box; }
  .form-input--sm { width: 100px; }

  .country-search { margin-bottom: 0.5rem; width: 280px; }
  .selected-countries { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.6rem; }
  .country-chip {
    align-items: center; background: var(--accent-soft); border-radius: 4px; color: var(--accent-strong);
    display: flex; font-size: 0.78rem; gap: 0.3rem; padding: 0.2rem 0.5rem;
  }
  .chip-remove { background: none; border: none; color: var(--accent-light); cursor: pointer; font-size: 0.7rem; padding: 0; }
  .chip-remove:hover { color: var(--accent-strong); }
  .country-list { display: flex; flex-wrap: wrap; gap: 0.3rem; max-height: 140px; overflow-y: auto; }
  .country-option {
    background: var(--bg-hover); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); cursor: pointer; font-size: 0.75rem; padding: 0.2rem 0.5rem;
  }
  .country-option:hover { background: var(--line); }
  .country-option.selected { background: var(--accent-soft); border-color: var(--accent-light); color: var(--accent-strong); }
  .country-overflow { color: var(--text-muted); font-size: 0.72rem; font-style: italic; padding: 0.3rem; }

  .rule-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.75rem; }
  .rule-item { border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.8rem; }
  .rule-disabled { opacity: 0.55; }
  .rule-main { align-items: center; display: flex; gap: 0.5rem; margin-bottom: 0.2rem; }
  .rule-check { align-items: center; cursor: pointer; display: flex; flex: 1; gap: 0.5rem; font-size: 0.85rem; font-weight: 500; min-width: 0; }
  .rule-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lane-badges { display: flex; gap: 0.25rem; flex-shrink: 0; }
  .lane-badge { border-radius: 3px; font-size: 0.68rem; font-weight: 600; padding: 0.1rem 0.4rem; white-space: nowrap; }
  .lane-badge--events { background: var(--accent-soft); color: var(--accent-strong); }
  .lane-badge--doc { background: #d1fae5; color: #065f46; }
  .lane-badge--rss { background: var(--accent-soft); color: var(--accent-strong); }
  .lane-badge--mediacloud { background: #ede9fe; color: #5b21b6; }
  .lane-badge--x { background: #e5e7eb; color: #111827; }
  .lane-badge--bluesky { background: #dbeafe; color: #1d4ed8; }
  .lane-badge--telegram { background: #e0f2fe; color: #0369a1; }
  .lane-badge--context { background: #fef3c7; color: #92400e; }
  .rule-lane-header {
    color: var(--text-muted); font-size: 0.68rem; font-weight: 700;
    letter-spacing: 0.06em; margin-top: 0.5rem; text-transform: uppercase;
  }
  .rule-actions { display: flex; gap: 0.25rem; }
  .btn-rule-edit {
    background: none; border: 1px solid var(--border); border-radius: 3px;
    color: var(--text-muted); cursor: pointer; font-size: 0.72rem; padding: 0.15rem 0.5rem;
  }
  .btn-rule-edit:hover { background: var(--bg-hover); color: var(--text); }
  .btn-rule-remove {
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    font-size: 0.8rem; padding: 0.15rem 0.3rem;
  }
  .btn-rule-remove:hover { color: #dc2626; }
  .rule-desc { color: var(--text-muted); font-size: 0.75rem; margin-bottom: 0.3rem; }
  .rule-logic-details { margin-top: 0.2rem; }
  .rule-summary { color: var(--text-muted); cursor: pointer; font-size: 0.75rem; }
  .rule-pre {
    background: var(--bg-code); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text-code); font-size: 0.7rem; margin-top: 0.4rem;
    padding: 0.5rem; white-space: pre-wrap;
  }

  .btn-add-rule {
    background: none; border: 1px dashed var(--border); border-radius: 7px;
    color: var(--accent); cursor: pointer; font-size: 0.82rem; font-weight: 600;
    padding: 0.5rem 1rem; width: 100%;
  }
  .btn-add-rule:hover { background: var(--bg-hover); border-color: var(--accent); }

  .ruleset-actions { display: flex; gap: 0.3rem; margin-left: auto; }
  .btn-ruleset {
    background: none; border: 1px solid var(--border); border-radius: 4px;
    color: var(--text-muted); cursor: pointer; font-size: 0.7rem; font-weight: 500;
    padding: 0.1rem 0.55rem;
  }
  .btn-ruleset:hover { background: var(--bg-hover); color: var(--text); }
  .btn-ruleset:disabled { opacity: 0.4; cursor: default; }

  .form-hint { color: var(--text-muted); font-size: 0.78rem; margin: 0.25rem 0 0; }

  .config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem 1.5rem; }
  .toggle-row { align-items: center; display: flex; }
  .toggle-row--stacked { align-items: flex-start; flex-direction: column; }
  .toggle-label { align-items: center; cursor: pointer; display: flex; font-size: 0.85rem; gap: 0.5rem; }
  .lane-hint { color: #b45309; font-size: 0.76rem; margin: 0.3rem 0 0 1.5rem; }
  .form-group label { display: block; font-size: 0.8rem; font-weight: 500; margin-bottom: 0.3rem; }
  .hint { color: var(--text-muted); font-weight: normal; }

  .settings-actions { display: flex; justify-content: flex-end; margin-bottom: 2rem; }
  .btn-save { background: var(--accent); border: none; border-radius: 5px; color: white; cursor: pointer; font-size: 0.9rem; font-weight: 600; padding: 0.5rem 1.5rem; }
  .btn-save:hover { background: var(--accent-strong); }
  .btn-save:disabled { background: var(--accent-light); cursor: default; }

  .danger-zone { border: 1px solid #fca5a5; border-radius: 6px; padding: 1rem; }
  .danger-title { color: #dc2626; }
  .btn-delete { background: none; border: 1px solid #fca5a5; border-radius: 4px; color: #dc2626; cursor: pointer; font-size: 0.85rem; padding: 0.4rem 1rem; }
  .btn-delete:hover { background: #fee2e2; }
  .confirm-delete p { color: var(--text); font-size: 0.85rem; margin: 0 0 0.75rem; }
  .confirm-actions { display: flex; gap: 0.5rem; }
  .btn-cancel { background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-muted); cursor: pointer; font-size: 0.85rem; padding: 0.4rem 0.9rem; }
  .btn-confirm-delete { background: #dc2626; border: none; border-radius: 4px; color: white; cursor: pointer; font-size: 0.85rem; padding: 0.4rem 1rem; }
  .btn-confirm-delete:hover { background: #b91c1c; }
  .btn-confirm-delete:disabled { opacity: 0.6; cursor: default; }

  /* ── Sheet setup guide ────────────────────────────────────────────────────── */
  .sheet-setup {
    border: 1px solid var(--border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 0;
    margin-bottom: 1.25rem;
    overflow: hidden;
  }
  .setup-step {
    align-items: flex-start;
    border-bottom: 1px solid var(--border-light, var(--paper-2));
    display: flex;
    gap: 0.85rem;
    padding: 0.85rem 1rem;
  }
  .setup-step:last-child { border-bottom: none; }
  .step-num {
    align-items: center;
    background: var(--accent);
    border-radius: 50%;
    color: white;
    display: flex;
    flex-shrink: 0;
    font-size: 0.7rem;
    font-weight: 700;
    height: 20px;
    justify-content: center;
    margin-top: 1px;
    width: 20px;
  }
  .step-body {
    color: var(--text);
    font-size: 0.82rem;
    line-height: 1.5;
  }
  .step-body strong { color: var(--text); }
  .step-body em { font-style: normal; color: var(--text-muted); }

  .script-block {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-top: 0.6rem;
    overflow: hidden;
    position: relative;
  }
  .script-pre {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.68rem;
    line-height: 1.5;
    margin: 0;
    max-height: 180px;
    overflow-y: auto;
    padding: 0.75rem 1rem;
    scrollbar-width: thin;
    white-space: pre;
  }
  .btn-copy-script {
    background: rgba(255,255,255,0.08);
    border: none;
    border-top: 1px solid rgba(255,255,255,0.1);
    color: var(--muted-2);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0.35rem 0.75rem;
    text-align: right;
    transition: background 0.12s, color 0.12s;
    width: 100%;
  }
  .btn-copy-script:hover { background: rgba(255,255,255,0.14); color: var(--line); }
</style>
