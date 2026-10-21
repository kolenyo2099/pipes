<script>
  /**
   * QueryBuilder – a human-readable wizard for creating Canary watchlist rules.
   *
   * Props:
   *   rule       – existing WatchlistRule to edit (null = new rule)
   *   ontology   – { event_categories, actor_types, gkg_themes, countries }
   *   onSave(rule)   – called with the finished rule object
   *   onCancel()     – called on dismiss
   */
  import { onMount, onDestroy } from 'svelte'
  import { api } from '../api.js'
  import MediaCloudConfig from './MediaCloudConfig.svelte'
  import { cloneMediaCloudCollections, mediaCloudCollectionsForRule } from '../lib/mediacloudRules.js'
  import BlueskyAccount from './BlueskyAccount.svelte'
  import TelegramAccount from './TelegramAccount.svelte'
  import { xQuery, xSearchUrl, X_LIST } from '../backend/x.js'
  import { blueskySearches, blueskyLabel, blueskyWebUrl, BLUESKY_LIST } from '../backend/bluesky.js'
  import { telegramChannels, telegramKeywords, telegramUrl } from '../backend/telegram.js'

  export let rule = null
  export let siblingRule = null  // legacy prop retained for compatibility
  export let relatedRules = []   // additional rules for the same bucket_name
  export let projectCountries = []
  export let mediaCloudCollections = []
  export let ontology = {}
  export let onSave = () => {}
  export let onCancel = () => {}

  // ── Shared state ─────────────────────────────────────────────────────────────
  let ruleName = rule?.bucket_name || ''
  let activeTab = ['rss', 'mediacloud', 'x', 'bluesky', 'telegram'].includes(rule?.lane)
    ? rule.lane
    : ((rule?.lane === 'doc' || rule?.lane === 'context') ? 'doc' : 'events')
  let nameError = ''
  let mediaCloudError = ''
  let touchedLanes = new Set()

  function markLane(lane = activeTab) {
    touchedLanes = new Set([...touchedLanes, lane])
  }

  function switchTab(lane) {
    activeTab = lane
    mediaCloudError = ''
  }

  // ── Determine which rule holds each lane's data ───────────────────────────────
  // Rules are grouped by bucket_name. When editing one lane, we still want to
  // show existing state for the sibling lanes in the other tabs.
  const _isGkgLane = (r) => r?.lane === 'doc' || r?.lane === 'context'
  const _bucketRules = [rule, siblingRule, ...(relatedRules || [])]
    .filter(Boolean)
    .reduce((acc, current) => {
      if (!acc.some(r => r.lane === current.lane)) acc.push(current)
      return acc
    }, [])

  const _eventsRule = _bucketRules.find(r => r.lane === 'events') || null
  const _docRule    = _bucketRules.find(r => _isGkgLane(r)) || null
  const _rssRule    = _bucketRules.find(r => r.lane === 'rss') || null
  const _mediacloudRule = _bucketRules.find(r => r.lane === 'mediacloud') || null
  const _xRule = _bucketRules.find(r => r.lane === 'x') || null
  const _blueskyRule = _bucketRules.find(r => r.lane === 'bluesky') || null
  const _telegramRule = _bucketRules.find(r => r.lane === 'telegram') || null
  let mediaCloudDraftCollections = cloneMediaCloudCollections(
    mediaCloudCollectionsForRule(_mediacloudRule, mediaCloudCollections)
  )

  function existingRuleForLane(lane) {
    if (lane === 'events') return _eventsRule
    if (lane === 'doc') return _docRule
    if (lane === 'rss') return _rssRule
    if (lane === 'mediacloud') return _mediacloudRule
    if (lane === 'x') return _xRule
    if (lane === 'bluesky') return _blueskyRule
    if (lane === 'telegram') return _telegramRule
    return null
  }

  // ── X, Bluesky and Telegram tab state ────────────────────────────────────────
  // Each takes a search (for Telegram, keywords), accounts (channels) and a start. datetime-local fields hold local wall time; the rule stores UTC.
  const SOCIAL_LANES = ['x', 'bluesky', 'telegram']
  const SOCIAL_NAMES = { x: 'X', bluesky: 'Bluesky', telegram: 'Telegram' }
  const SOCIAL_SITES = { x: 'x.com', bluesky: 'bsky.app', telegram: 't.me' }
  const localInput = iso => { const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }
  function socialForm(lane) {
    const logic = existingRuleForLane(lane)?.logic || {}
    return { search: logic[`${lane}_query`] || '', accounts: (logic[`${lane}_accounts`] || []).join(', '),
      savedSince: logic[`${lane}_since`], since: localInput(logic[`${lane}_since`] || Date.now()), error: '' }
  }
  let social = { x: socialForm('x'), bluesky: socialForm('bluesky'), telegram: socialForm('telegram') }
  // The field drops seconds; keep the saved start unless it was changed, since a new start restarts the rule's backfill.
  function socialLogic(lane, form = social[lane]) {
    const since = form.savedSince && form.since === localInput(form.savedSince) ? form.savedSince : form.since ? new Date(form.since).toISOString() : null
    return { [`${lane}_query`]: form.search.trim(), [`${lane}_accounts`]: form.accounts.split(/[\s,]+/).filter(Boolean), [`${lane}_since`]: since }
  }
  // What a rule will search, as typed on the service's own site.
  function socialSearches(lane, logic) {
    if (lane === 'bluesky') return blueskySearches(logic).map(search => ({ text: blueskyLabel(search), url: blueskyWebUrl(search) }))
    if (lane === 'telegram') {
      const keywords = telegramKeywords(logic)
      return telegramChannels(logic).map(channel => ({ text: `@${channel}${keywords.length ? `, posts with: ${keywords.join(' OR ')}` : ''}`, url: telegramUrl(channel) }))
    }
    const query = xQuery(logic)
    return query ? [{ text: query, url: xSearchUrl(query).split('#')[0] }] : []
  }
  $: socialPreview = SOCIAL_LANES.includes(activeTab) ? socialSearches(activeTab, socialLogic(activeTab, social[activeTab])) : []
  // What a rule costs each run, with a nudge toward a list when it follows many accounts.
  function socialCost(lane, logic) {
    if (lane === 'telegram') {
      const channels = telegramChannels(logic).length
      return `${channels} channel${channels === 1 ? '' : 's'}: a page each per run, more while catching up. A new channel goes back at most 30 days.`
    }
    const accounts = logic[`${lane}_accounts`].filter(entry => !(lane === 'x' ? X_LIST : BLUESKY_LIST).test(entry)).length
    const searches = socialSearches(lane, logic).length
    if (lane === 'bluesky' && accounts > 3) return `${searches} searches each run, one per account. A list does it in one: add these accounts to a list on bsky.app and paste its link here.`
    if (lane === 'x' && accounts > 8) return `${accounts} accounts make a long search. Add them to a list on x.com and paste its link here to keep it short.`
    return `${searches} search${searches === 1 ? '' : 'es'} each run, more while catching up.`
  }
  $: socialCostNote = SOCIAL_LANES.includes(activeTab) && socialPreview.length ? socialCost(activeTab, socialLogic(activeTab, social[activeTab])) : ''
  // A Bluesky list brings every post by its members; Bluesky cannot narrow it by a search.
  const mixesListAndSearch = logic => !!logic.bluesky_query && (logic.bluesky_accounts || []).some(entry => BLUESKY_LIST.test(entry))
  function editSocial() {
    markLane(activeTab)
    social[activeTab].error = ''
  }

  // ── Events tab state ─────────────────────────────────────────────────────────

  // Seed selectedCodes from the events-lane rule, falling back to legacy _categories.
  function initSelectedCodes() {
    const prefixes = _eventsRule?.logic?.event_code_prefix || []
    if (prefixes.length > 0) return new Set(prefixes)
    const legacyCats = _eventsRule?.logic?._categories || []
    if (legacyCats.length > 0) {
      const codes = new Set()
      for (const cat of (ontology.event_categories || [])) {
        if (legacyCats.includes(cat.key)) {
          for (const sub of (cat.subcodes || [])) codes.add(sub.code)
        }
      }
      return codes
    }
    return new Set()
  }

  let selectedCodes     = initSelectedCodes()   // Set<string> of 3-digit CAMEO codes
  let expandedCats      = new Set()             // Set<string> of category keys (UI expand)

  // Required actor countries: list of CAMEO 3-letter codes (e.g. ['USA', 'VEN']).
  // Migrate from legacy require_us_actor boolean if needed.
  let requiredActors = (() => {
    if (_eventsRule?.logic?.required_actor_countries?.length > 0)
      return [..._eventsRule.logic.required_actor_countries]
    if (_eventsRule?.logic?.require_us_actor)
      return ['USA']
    // Default for new rules: require USA (the most common investigator use-case)
    if (!rule) return ['USA']
    return []
  })()

  let selectedActorTypes = [...(_eventsRule?.logic?.actor_type_filter || [])]

  // required_countries_mode: which GDELT fields the required-country list is matched against.
  //   "actor" – Actor1/Actor2CountryCode (CAMEO 3-letter) — most precise, default
  //   "geo"   – ActionGeo / Actor1Geo / Actor2Geo CountryCode (FIPS 2-letter)
  //   "any"   – all five country fields — best recall for non-English sources
  let requiredCountriesMode = _eventsRule?.logic?.required_countries_mode || 'actor'

  // ── Country helpers for actor requirement (Events) ────────────────────────
  $: sortedCountries = (ontology.countries || [])
    .filter(c => c.cameo)
    .sort((a, b) => a.name.localeCompare(b.name))

  $: cameoToName = Object.fromEntries(
    (ontology.countries || [])
      .filter(c => c.cameo)
      .map(c => [c.cameo.toUpperCase(), c.name])
  )

  // ── Country helpers for GKG also_countries ────────────────────────────────
  // Countries with FIPS codes (resolvable by the Rust GKG matcher).
  $: alsoCountriesOptions = (ontology.countries || [])
    .filter(c => c.fips && c.name !== ruleName.trim() && !builderState.also_countries.includes(c.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  function addAlsoCountry(e) {
    const val = e.target.value
    if (val && !builderState.also_countries.includes(val)) {
      markLane('doc')
      builderState = { ...builderState, also_countries: [...builderState.also_countries, val] }
    }
    e.target.value = ''
  }

  function removeAlsoCountry(name) {
    markLane('doc')
    builderState = { ...builderState, also_countries: builderState.also_countries.filter(n => n !== name) }
  }

  function addRequiredActor(e) {
    const val = e.target.value
    if (val && !requiredActors.includes(val)) {
      markLane('events')
      requiredActors = [...requiredActors, val]
    }
    e.target.value = ''   // reset the select
  }

  function removeRequiredActor(cameo) {
    markLane('events')
    requiredActors = requiredActors.filter(c => c !== cameo)
  }

  // ── Category helpers ──────────────────────────────────────────────────────────
  function catSubcodes(cat) { return cat.subcodes || [] }

  function catState(cat) {
    const total = catSubcodes(cat).length
    if (total === 0) return 'unchecked'
    const n = catSubcodes(cat).filter(s => selectedCodes.has(s.code)).length
    if (n === 0) return 'unchecked'
    if (n === total) return 'checked'
    return 'partial'
  }

  function toggleCategoryAll(cat) {
    markLane('events')
    const next = new Set(selectedCodes)
    if (catState(cat) === 'checked') {
      catSubcodes(cat).forEach(s => next.delete(s.code))
    } else {
      catSubcodes(cat).forEach(s => next.add(s.code))
    }
    selectedCodes = next
  }

  function toggleCode(code) {
    markLane('events')
    const next = new Set(selectedCodes)
    if (next.has(code)) next.delete(code); else next.add(code)
    selectedCodes = next
  }

  function toggleExpand(key) {
    const next = new Set(expandedCats)
    if (next.has(key)) next.delete(key); else next.add(key)
    expandedCats = next
  }

  // ── DOC tab state ─────────────────────────────────────────────────────────────
  const defaultBuilderState = () => ({
    themes: [],
    required_countries: [],
    required_countries_mode: 'all',
    also_countries: [],
    also_countries_mode: 'all',
    persons: [],
    organizations: [],
    adm1_codes: [],
  })

  let builderState = (() => {
    const base = defaultBuilderState()
    if (_docRule) {
      // GKG rules store themes directly in logic.themes
      if (Array.isArray(_docRule.logic?.themes)) {
        base.themes = [..._docRule.logic.themes]
      } else if (_docRule.logic?._builder_state) {
        // Legacy DOC API builder state — extract themes only
        base.themes = [...(_docRule.logic._builder_state.themes || [])]
      }
      if (Array.isArray(_docRule.logic?.required_countries)) {
        base.required_countries = [..._docRule.logic.required_countries]
      }
      base.required_countries_mode = _docRule.logic?.required_countries_mode || 'all'
      // Load also_countries if present
      if (Array.isArray(_docRule.logic?.also_countries)) {
        base.also_countries = [..._docRule.logic.also_countries]
      }
      base.also_countries_mode = _docRule.logic?.also_countries_mode || 'all'
      // Load persons, organizations, adm1_codes if present
      if (Array.isArray(_docRule.logic?.persons)) {
        base.persons = [..._docRule.logic.persons]
      }
      if (Array.isArray(_docRule.logic?.organizations)) {
        base.organizations = [..._docRule.logic.organizations]
      }
      if (Array.isArray(_docRule.logic?.adm1_codes)) {
        base.adm1_codes = [..._docRule.logic.adm1_codes]
      }
    }
    return base
  })()

  // ── Person / Org / ADM1 helpers ───────────────────────────────────────────────
  let personInput = ''
  let orgInput = ''
  let adm1Input = ''

  $: gkgRequiredCountryOptions = (ontology.countries || [])
    .filter(c => c.fips && !builderState.required_countries.includes(c.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  function addRequiredGkgCountry(e) {
    const val = e.target.value
    if (val && !builderState.required_countries.includes(val)) {
      markLane('doc')
      builderState = { ...builderState, required_countries: [...builderState.required_countries, val] }
    }
    e.target.value = ''
  }

  function removeRequiredGkgCountry(name) {
    markLane('doc')
    builderState = {
      ...builderState,
      required_countries: builderState.required_countries.filter(n => n !== name),
    }
  }

  function addPerson() {
    const name = personInput.trim()
    if (name && !builderState.persons.includes(name)) {
      markLane('doc')
      builderState = { ...builderState, persons: [...builderState.persons, name] }
    }
    personInput = ''
  }
  function removePerson(name) {
    markLane('doc')
    builderState = { ...builderState, persons: builderState.persons.filter(p => p !== name) }
  }

  function addOrg() {
    const name = orgInput.trim()
    if (name && !builderState.organizations.includes(name)) {
      markLane('doc')
      builderState = { ...builderState, organizations: [...builderState.organizations, name] }
    }
    orgInput = ''
  }
  function removeOrg(name) {
    markLane('doc')
    builderState = { ...builderState, organizations: builderState.organizations.filter(o => o !== name) }
  }

  function addAdm1() {
    const code = adm1Input.trim().toUpperCase()
    if (code && !builderState.adm1_codes.includes(code)) {
      markLane('doc')
      builderState = { ...builderState, adm1_codes: [...builderState.adm1_codes, code] }
    }
    adm1Input = ''
  }
  function removeAdm1(code) {
    markLane('doc')
    builderState = { ...builderState, adm1_codes: builderState.adm1_codes.filter(c => c !== code) }
  }

  // ── Headline-search state (RSS and Media Cloud stay fully isolated) ───────────
  const defaultHeadlineState = () => ({
    countries: [],
    countries_mode: 'all',
    people: [],
    organizations: [],
    action_core: [],
    action_alt: [],
    exclude: [],
  })

  function headlineStateFromRule(sourceRule) {
    const base = defaultHeadlineState()
    const logic = sourceRule?.logic
    if (!logic) return base
    base.countries = [...(logic.countries || [])]
    base.countries_mode = logic.countries_mode || 'all'
    base.people = [...(logic.people || [])]
    base.organizations = [...(logic.organizations || [])]
    base.action_core = [...(logic.action_core || [])]
    base.action_alt = [...(logic.action_alt || [])]
    base.exclude = [...(logic.exclude || [])]
    return base
  }

  function simpleStateFromRule(sourceRule) {
    const logic = sourceRule?.logic || {}
    const legacyFocusTerms = Array.isArray(logic.focus_terms) ? logic.focus_terms : []
    const queryTerms = Array.isArray(logic.query_terms) ? logic.query_terms : legacyFocusTerms
    return {
      query_terms: [...queryTerms],
      require_any: Array.isArray(logic.require_any) ? [...logic.require_any] : [],
      locales: Array.isArray(logic.locales) && logic.locales.length > 0
        ? [...logic.locales]
        : ['US:en'],
    }
  }

  function simpleModeFromRule(sourceRule) {
    const logic = sourceRule?.logic || {}
    return Array.isArray(logic.query_terms)
      || Array.isArray(logic.focus_terms)
      || Array.isArray(logic.require_any)
  }

  let rssState = headlineStateFromRule(_rssRule)
  let mediaCloudState = headlineStateFromRule(_mediacloudRule)

  // ── Simple mode (query_terms + require_any + locales) ─────────────────────
  // Phase 1: query_terms cast a wide net (→ Google News q= param).
  // Phase 2: require_any filters results via NER + text match after fetch.
  // Legacy `focus_terms` field treated as query_terms for backward compat.
  let rssSimpleMode = simpleModeFromRule(_rssRule)
  let mediaCloudSimpleMode = simpleModeFromRule(_mediacloudRule)
  let rssSimpleState = simpleStateFromRule(_rssRule)
  let mediaCloudSimpleState = simpleStateFromRule(_mediacloudRule)
  const LOCALE_OPTIONS = [
    { ceid: 'US:en', label: 'US · English' },
    { ceid: 'GB:en', label: 'UK · English' },
    { ceid: 'CA:en', label: 'Canada · English' },
    { ceid: 'AU:en', label: 'Australia · English' },
    { ceid: 'IN:en', label: 'India · English' },
    { ceid: 'IN:hi', label: 'India · Hindi' },
    { ceid: 'ES:es', label: 'Spain · Spanish' },
    { ceid: 'MX:es', label: 'Mexico · Spanish' },
    { ceid: 'AR:es', label: 'Argentina · Spanish' },
    { ceid: 'CO:es', label: 'Colombia · Spanish' },
    { ceid: 'BR:pt-419', label: 'Brazil · Portuguese' },
    { ceid: 'PT:pt-150', label: 'Portugal · Portuguese' },
    { ceid: 'FR:fr', label: 'France · French' },
    { ceid: 'DE:de', label: 'Germany · German' },
    { ceid: 'IT:it', label: 'Italy · Italian' },
    { ceid: 'NL:nl', label: 'Netherlands · Dutch' },
    { ceid: 'PL:pl', label: 'Poland · Polish' },
    { ceid: 'RU:ru', label: 'Russia · Russian' },
    { ceid: 'UA:uk', label: 'Ukraine · Ukrainian' },
    { ceid: 'TR:tr', label: 'Türkiye · Turkish' },
    { ceid: 'IL:he', label: 'Israel · Hebrew' },
    { ceid: 'AE:ar', label: 'UAE · Arabic' },
    { ceid: 'EG:ar', label: 'Egypt · Arabic' },
    { ceid: 'SA:ar', label: 'Saudi Arabia · Arabic' },
    { ceid: 'JP:ja', label: 'Japan · Japanese' },
    { ceid: 'KR:ko', label: 'Korea · Korean' },
    { ceid: 'CN:zh-Hans', label: 'China · Chinese (Simplified)' },
    { ceid: 'TW:zh-Hant', label: 'Taiwan · Chinese (Traditional)' },
    { ceid: 'ID:id', label: 'Indonesia · Indonesian' },
    { ceid: 'TH:th', label: 'Thailand · Thai' },
  ]

  let rssStep = 0
  let mediaCloudStep = 0
  const defaultHeadlineInputs = () => ({
    query: '',
    require: '',
    person: '',
    organization: '',
    core: '',
    alternate: '',
    exclude: '',
  })
  let headlineInputs = {
    rss: defaultHeadlineInputs(),
    mediacloud: defaultHeadlineInputs(),
  }

  $: headlineLane = activeTab === 'mediacloud' ? 'mediacloud' : 'rss'
  $: headlineState = headlineLane === 'mediacloud' ? mediaCloudState : rssState
  $: headlineSimpleState = headlineLane === 'mediacloud' ? mediaCloudSimpleState : rssSimpleState
  $: headlineSimpleMode = headlineLane === 'mediacloud' ? mediaCloudSimpleMode : rssSimpleMode
  $: headlineStep = headlineLane === 'mediacloud' ? mediaCloudStep : rssStep
  $: headlineInput = headlineInputs[headlineLane]

  function replaceHeadlineState(lane, next, touched = true) {
    if (touched) markLane(lane)
    if (lane === 'mediacloud') mediaCloudState = next
    else rssState = next
  }

  function replaceHeadlineSimpleState(lane, next, touched = true) {
    if (touched) markLane(lane)
    if (lane === 'mediacloud') mediaCloudSimpleState = next
    else rssSimpleState = next
  }

  function setHeadlineInput(key, value, lane = headlineLane) {
    headlineInputs = {
      ...headlineInputs,
      [lane]: { ...headlineInputs[lane], [key]: value },
    }
  }

  function addHeadlineQueryTerm() {
    const next = pushUnique(headlineSimpleState.query_terms, headlineInput.query)
    if (next !== headlineSimpleState.query_terms) {
      replaceHeadlineSimpleState(headlineLane, { ...headlineSimpleState, query_terms: next })
    }
    setHeadlineInput('query', '')
  }
  function removeHeadlineQueryTerm(term) {
    replaceHeadlineSimpleState(headlineLane, {
      ...headlineSimpleState,
      query_terms: headlineSimpleState.query_terms.filter(value => value !== term),
    })
  }
  function addHeadlineRequire() {
    const next = pushUnique(headlineSimpleState.require_any, headlineInput.require)
    if (next !== headlineSimpleState.require_any) {
      replaceHeadlineSimpleState(headlineLane, { ...headlineSimpleState, require_any: next })
    }
    setHeadlineInput('require', '')
  }
  function removeHeadlineRequire(term) {
    replaceHeadlineSimpleState(headlineLane, {
      ...headlineSimpleState,
      require_any: headlineSimpleState.require_any.filter(value => value !== term),
    })
  }
  function addHeadlineLocale(e) {
    const ceid = e.target.value
    if (ceid && !headlineSimpleState.locales.includes(ceid)) {
      replaceHeadlineSimpleState(headlineLane, {
        ...headlineSimpleState,
        locales: [...headlineSimpleState.locales, ceid],
      })
    }
    e.target.value = ''
  }
  function removeHeadlineLocale(ceid) {
    replaceHeadlineSimpleState(headlineLane, {
      ...headlineSimpleState,
      locales: headlineSimpleState.locales.filter(value => value !== ceid),
    })
  }
  function toggleHeadlineSimpleMode() {
    markLane(headlineLane)
    if (headlineLane === 'mediacloud') mediaCloudSimpleMode = !mediaCloudSimpleMode
    else rssSimpleMode = !rssSimpleMode
  }
  function setHeadlineStep(step, lane = headlineLane) {
    if (lane === 'mediacloud') mediaCloudStep = step
    else rssStep = step
  }

  function goToHeadlineStep(step) {
    if (headlineLane === 'mediacloud' && step > 0 && mediaCloudDraftCollections.length === 0) {
      mediaCloudError = 'Choose at least one collection before defining the rule.'
      mediaCloudStep = 0
      return
    }
    mediaCloudError = ''
    setHeadlineStep(step)
  }

  function handleMediaCloudCollectionsChange() {
    markLane('mediacloud')
    mediaCloudError = ''
  }
  $: localeLabelByCeid = Object.fromEntries(LOCALE_OPTIONS.map(o => [o.ceid, o.label]))
  $: headlineLocaleOptions = LOCALE_OPTIONS.filter(option => !headlineSimpleState.locales.includes(option.ceid))

  const RSS_STEPS = [
    'Countries',
    'Actors',
    'Headline Language',
    'Preview',
  ]
  const MEDIA_CLOUD_STEPS = ['Collections', ...RSS_STEPS]
  $: headlineSteps = headlineLane === 'mediacloud' ? MEDIA_CLOUD_STEPS : RSS_STEPS
  $: headlineEditorStep = headlineLane === 'mediacloud' ? headlineStep - 1 : headlineStep
  $: headlineStepOffset = headlineLane === 'mediacloud' ? 1 : 0

  $: rssCountriesByCode = Object.fromEntries(
    (ontology.countries || []).map(c => [c.code, c.name])
  )

  $: rssProjectCountryNames = projectCountries
    .map(code => rssCountriesByCode[code] || code)
    .filter(Boolean)

  $: rssCountryOptions = (ontology.countries || [])
    .filter(c => c.code && !projectCountries.includes(c.code) && !headlineState.countries.includes(c.code))
    .sort((a, b) => a.name.localeCompare(b.name))

  function addHeadlineCountry(e) {
    const code = e.target.value
    if (code && !headlineState.countries.includes(code)) {
      replaceHeadlineState(headlineLane, {
        ...headlineState,
        countries: [...headlineState.countries, code],
      })
    }
    e.target.value = ''
  }

  function removeHeadlineCountry(code) {
    replaceHeadlineState(headlineLane, {
      ...headlineState,
      countries: headlineState.countries.filter(value => value !== code),
    })
  }

  function setHeadlineCountriesMode(mode) {
    replaceHeadlineState(headlineLane, { ...headlineState, countries_mode: mode })
  }

  function pushUnique(list, value) {
    const normalized = value.trim()
    if (!normalized || list.includes(normalized)) return list
    return [...list, normalized]
  }

  function addHeadlinePerson() {
    const next = pushUnique(headlineState.people, headlineInput.person)
    if (next !== headlineState.people) {
      replaceHeadlineState(headlineLane, { ...headlineState, people: next })
    }
    setHeadlineInput('person', '')
  }

  function removeHeadlinePerson(name) {
    replaceHeadlineState(headlineLane, {
      ...headlineState,
      people: headlineState.people.filter(value => value !== name),
    })
  }

  function addHeadlineOrganization() {
    const next = pushUnique(headlineState.organizations, headlineInput.organization)
    if (next !== headlineState.organizations) {
      replaceHeadlineState(headlineLane, { ...headlineState, organizations: next })
    }
    setHeadlineInput('organization', '')
  }

  function removeHeadlineOrganization(name) {
    replaceHeadlineState(headlineLane, {
      ...headlineState,
      organizations: headlineState.organizations.filter(value => value !== name),
    })
  }

  function addHeadlineCore() {
    const next = pushUnique(headlineState.action_core, headlineInput.core)
    if (next !== headlineState.action_core) {
      replaceHeadlineState(headlineLane, { ...headlineState, action_core: next })
    }
    setHeadlineInput('core', '')
  }

  function removeHeadlineCore(value) {
    replaceHeadlineState(headlineLane, {
      ...headlineState,
      action_core: headlineState.action_core.filter(item => item !== value),
    })
  }

  function addHeadlineAlternate() {
    const next = pushUnique(headlineState.action_alt, headlineInput.alternate)
    if (next !== headlineState.action_alt) {
      replaceHeadlineState(headlineLane, { ...headlineState, action_alt: next })
    }
    setHeadlineInput('alternate', '')
  }

  function removeHeadlineAlternate(value) {
    replaceHeadlineState(headlineLane, {
      ...headlineState,
      action_alt: headlineState.action_alt.filter(item => item !== value),
    })
  }

  function addHeadlineExclude() {
    const next = pushUnique(headlineState.exclude, headlineInput.exclude)
    if (next !== headlineState.exclude) {
      replaceHeadlineState(headlineLane, { ...headlineState, exclude: next })
    }
    setHeadlineInput('exclude', '')
  }

  function removeHeadlineExclude(value) {
    replaceHeadlineState(headlineLane, {
      ...headlineState,
      exclude: headlineState.exclude.filter(item => item !== value),
    })
  }

  function quoteTerm(term) {
    return /\s/.test(term) ? `"${term}"` : term
  }

  function groupedOr(terms) {
    const filtered = terms.filter(Boolean)
    if (filtered.length === 0) return ''
    if (filtered.length === 1) return quoteTerm(filtered[0])
    return `(${filtered.map(quoteTerm).join(' OR ')})`
  }

  function normalizeQueryParts(parts) {
    return parts
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function clampQuery(query, maxLen = 1200) {
    return query.length <= maxLen ? query : `${query.slice(0, maxLen - 1).trim()}…`
  }

  function compileRssQueries(state) {
    const extraCountryNames = state.countries
      .map(code => rssCountriesByCode[code] || code)
      .filter(Boolean)

    const projectCountryClause = rssProjectCountryNames.length > 0
      ? groupedOr(rssProjectCountryNames)
      : ''
    const extraCountryClause = state.countries_mode === 'all'
      ? extraCountryNames.map(quoteTerm).join(' ')
      : groupedOr(extraCountryNames)
    const countryClause = normalizeQueryParts([projectCountryClause, extraCountryClause])

    const actorTerms = [...state.people.slice(0, 2), ...state.organizations.slice(0, 2)]
    const actorClause = groupedOr(actorTerms)
    const coreClause = groupedOr(state.action_core.slice(0, 4))
    const balancedActionClause = groupedOr([
      ...state.action_core.slice(0, 2),
      ...state.action_alt.slice(0, 4),
    ])
    const recallActionClause = groupedOr([
      ...state.action_core.slice(0, 2),
      ...state.action_alt.slice(0, 2),
    ])
    const excludeClause = state.exclude
      .slice(0, 5)
      .map(term => `-${quoteTerm(term)}`)
      .join(' ')

    const queries = [
      {
        label: 'Strict',
        query: normalizeQueryParts([countryClause, actorClause, coreClause, excludeClause, 'when:1d']),
      },
      {
        label: 'Balanced',
        query: normalizeQueryParts([countryClause, balancedActionClause, actorClause, excludeClause, 'when:1d']),
      },
      {
        label: 'Recall',
        query: normalizeQueryParts([countryClause, recallActionClause, excludeClause, 'when:1d']),
      },
    ]

    return queries
      .map(q => ({ ...q, query: clampQuery(q.query) }))
      .filter(q => q.query)
      .filter((q, idx, all) => all.findIndex(other => other.query === q.query) === idx)
  }

  $: headlinePreviewQueries = compileRssQueries(headlineState)

  $: headlinePreviewSummary = [
    rssProjectCountryNames.length > 0
      ? `Project countries: ${rssProjectCountryNames.join(' OR ')}`
      : 'Project countries are not set yet',
    headlineState.countries.length > 0
      ? `Additional geographies: ${headlineState.countries.map(code => rssCountriesByCode[code] || code).join(headlineState.countries_mode === 'all' ? ' + ' : ' OR ')}`
      : 'No additional geography added',
    headlineState.people.length > 0 ? `People: ${headlineState.people.join(' OR ')}` : '',
    headlineState.organizations.length > 0 ? `Organizations: ${headlineState.organizations.join(' OR ')}` : '',
    headlineState.action_core.length > 0 ? `Core headline phrases: ${headlineState.action_core.join(' OR ')}` : '',
    headlineState.action_alt.length > 0 ? `Alternate wording: ${headlineState.action_alt.join(' OR ')}` : '',
    headlineState.exclude.length > 0 ? `Exclude: ${headlineState.exclude.join(', ')}` : '',
  ].filter(Boolean)

  let themeSearch = ''
  let themeResults = []       // [{tag, label, freq}] from async search
  let themeSearching = false
  let themeTagLabels = {}     // tag → label cache (populated as user selects)
  let themeTagFreqs  = {}     // tag → freq cache  (populated as user selects)
  let _themeTimer = null

  function onThemeInput() {
    clearTimeout(_themeTimer)
    _themeTimer = setTimeout(async () => {
      themeSearching = true
      const r = await api.searchGkgThemes(themeSearch, 30)
      themeSearching = false
      if (r.ok) themeResults = r.data
    }, 250)
  }

  onDestroy(() => clearTimeout(_themeTimer))

  // ── Derived: sorted list of selected codes (used in rule output) ─────────────
  $: eventCodePrefixes = [...selectedCodes].sort()

  // ── Actor type groups ─────────────────────────────────────────────────────
  $: actorTypeGroups = groupByKey(ontology.actor_types || [], 'group')

  function groupByKey(arr, key) {
    const groups = {}
    for (const item of arr) {
      const k = item[key]
      if (!groups[k]) groups[k] = []
      groups[k].push(item)
    }
    return Object.entries(groups).map(([label, items]) => ({ label, items }))
  }

  // ── Plain-English preview text ────────────────────────────────────────────
  $: eventsPreview = buildEventsPreview(selectedCodes, requiredActors, selectedActorTypes, cameoToName)

  function buildEventsPreview(codes, reqActors, actorTypes, codeToName) {
    const lines = []
    const activeCats = (ontology.event_categories || []).filter(cat =>
      catSubcodes(cat).some(s => codes.has(s.code))
    )

    if (codes.size === 0) {
      lines.push('Collect ALL event types (no event code filter)')
    } else {
      for (const cat of activeCats) {
        const sel = catSubcodes(cat).filter(s => codes.has(s.code))
        if (sel.length === catSubcodes(cat).length) {
          lines.push(`${cat.icon} All ${cat.label}`)
        } else {
          lines.push(`${cat.icon} ${cat.label}: ${sel.map(s => s.label).join(', ')}`)
        }
      }
    }
    if (reqActors.length > 0) {
      const names = reqActors.map(c => codeToName[c] || c).join(' AND ')
      lines.push(`Where ${names} ${reqActors.length === 1 ? 'is' : 'are'} explicit actors`)
    }
    const typeLabels = (ontology.actor_types || [])
      .filter(t => actorTypes.includes(t.code)).map(t => t.label)
    if (typeLabels.length > 0) lines.push(`Actor type(s): ${typeLabels.join(', ')}`)
    lines.push('For countries you select for the project')
    return lines
  }

  function toggleTheme(tag, label, freq) {
    markLane('doc')
    if (label) themeTagLabels = { ...themeTagLabels, [tag]: label }
    if (freq != null) themeTagFreqs = { ...themeTagFreqs, [tag]: freq }
    if (builderState.themes.includes(tag)) {
      builderState = { ...builderState, themes: builderState.themes.filter(t => t !== tag) }
    } else {
      builderState = { ...builderState, themes: [...builderState.themes, tag] }
    }
  }

  /** Format a raw article-count frequency as a compact string: 19316230 → "19.3M" */
  function fmtFreq(n) {
    if (!n) return ''
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
    if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'k'
    return String(n)
  }

  // No DOC API performance warning needed — GKG flat-file theme matching is
  // in-memory and has no query-size or timeout constraints.

  function toggleActorType(code) {
    markLane('events')
    if (selectedActorTypes.includes(code)) {
      selectedActorTypes = selectedActorTypes.filter(c => c !== code)
    } else {
      selectedActorTypes = [...selectedActorTypes, code]
    }
  }

  // ── Preset management (DB-backed) ─────────────────────────────────────────
  const PRESETS_LEGACY_KEY = 'canary_rule_presets_v1'

  let presets = []
  let showPresetSaveForm = false
  let presetNameInput = ''
  let presetsLoading = false

  async function loadPresets() {
    presetsLoading = true
    const r = await api.listPresets()
    presetsLoading = false
    if (r.ok) presets = r.data
  }

  onMount(async () => {
    await loadPresets()
    // One-time migration: move any localStorage presets into the DB
    try {
      const local = JSON.parse(localStorage.getItem(PRESETS_LEGACY_KEY) || '[]')
      if (local.length > 0) {
        for (const p of local) {
          await api.createPreset({ name: p.name, lane: p.lane, logic: p.logic })
        }
        localStorage.removeItem(PRESETS_LEGACY_KEY)
        await loadPresets()
      }
    } catch { /* ignore migration errors */ }
  })

  function applyPreset(preset) {
    if (preset.lane === 'ruleset' && Array.isArray(preset.logic?.rules)) {
      for (const presetRule of preset.logic.rules) {
        applyLaneLogic(presetRule.lane, presetRule.logic || {})
        markLane(presetRule.lane === 'context' ? 'doc' : presetRule.lane)
      }
      const firstLane = preset.logic.rules[0]?.lane
      activeTab = firstLane === 'context' ? 'doc' : (firstLane || activeTab)
      if (!ruleName.trim()) ruleName = preset.logic.rules[0]?.bucket_name || preset.name
      return
    }

    activeTab = preset.lane === 'context' ? 'doc' : preset.lane
    applyLaneLogic(preset.lane, preset.logic || {})
    markLane(activeTab)
    if (!ruleName.trim()) ruleName = preset.name
  }

  function applyLaneLogic(lane, logic) {
    if (lane === 'doc' || lane === 'context') {
      // GKG rule: load themes + also_countries from logic; fall back to legacy _builder_state
      if (Array.isArray(logic?.themes)) {
        builderState = {
          ...defaultBuilderState(),
          themes: [...logic.themes],
          required_countries: [...(logic.required_countries || [])],
          required_countries_mode: logic.required_countries_mode || 'all',
          also_countries: [...(logic.also_countries || [])],
          also_countries_mode: logic.also_countries_mode || 'all',
          persons: [...(logic.persons || [])],
          organizations: [...(logic.organizations || [])],
          adm1_codes: [...(logic.adm1_codes || [])],
        }
      } else {
        // Legacy preset — extract themes only
        builderState = { ...defaultBuilderState(), themes: [...(logic._builder_state?.themes || [])] }
      }
    } else if (lane === 'rss' || lane === 'mediacloud') {
      const normalizedLane = lane === 'mediacloud' ? 'mediacloud' : 'rss'
      const sourceRule = { logic }
      replaceHeadlineState(normalizedLane, headlineStateFromRule(sourceRule), false)
      replaceHeadlineSimpleState(normalizedLane, simpleStateFromRule(sourceRule), false)
      if (normalizedLane === 'mediacloud') {
        mediaCloudSimpleMode = simpleModeFromRule(sourceRule)
        mediaCloudStep = 0
        if (Array.isArray(logic.mediacloud_collections)) {
          mediaCloudDraftCollections = cloneMediaCloudCollections(logic.mediacloud_collections)
        }
      } else {
        rssSimpleMode = simpleModeFromRule(sourceRule)
        rssStep = 0
      }
    } else if (SOCIAL_LANES.includes(lane)) {
      social[lane] = { ...social[lane], search: logic[`${lane}_query`] || '', accounts: (logic[`${lane}_accounts`] || []).join(', ') }
    } else {
      selectedCodes = new Set(logic.event_code_prefix || [])
      requiredActors = [...(logic.required_actor_countries || [])]
      selectedActorTypes = [...(logic.actor_type_filter || [])]
      requiredCountriesMode = logic.required_countries_mode || 'actor'
    }
  }

  async function deletePreset(id) {
    const r = await api.deletePreset(id)
    if (r.ok) presets = presets.filter(p => p.preset_id !== id)
  }

  function buildEventsLogic() {
    const _categories = (ontology.event_categories || [])
      .filter(cat => catSubcodes(cat).some(s => selectedCodes.has(s.code)))
      .map(cat => cat.key)
    return {
      required_actor_countries: requiredActors,
      required_countries_mode: requiredCountriesMode,
      require_us_actor: requiredActors.includes('USA'),
      actor_country_filter: [],
      event_code_prefix: eventCodePrefixes,
      actor_type_filter: selectedActorTypes,
      description: eventsPreview.join('. '),
      _categories,
    }
  }

  function buildDocLogic() {
    const themeDesc = builderState.themes.length > 0
      ? builderState.themes.join(' + ')
      : 'all articles'
    const alsoDesc = builderState.also_countries.length > 0
      ? ` + also mentions: ${builderState.also_countries.join(builderState.also_countries_mode === 'any' ? ' OR ' : ' + ')}`
      : ''
    const requiredDesc = builderState.required_countries.length > 0
      ? ` + required countries: ${builderState.required_countries.join(builderState.required_countries_mode === 'any' ? ' OR ' : ' + ')}`
      : ''
    const personsDesc = builderState.persons.length > 0
      ? ` + persons: ${builderState.persons.join(', ')}`
      : ''
    const orgsDesc = builderState.organizations.length > 0
      ? ` + orgs: ${builderState.organizations.join(', ')}`
      : ''
    const adm1Desc = builderState.adm1_codes.length > 0
      ? ` + regions: ${builderState.adm1_codes.join(', ')}`
      : ''
    return {
      themes: [...builderState.themes],
      required_countries: [...builderState.required_countries],
      required_countries_mode: builderState.required_countries_mode,
      also_countries: [...builderState.also_countries],
      also_countries_mode: builderState.also_countries_mode,
      persons: [...builderState.persons],
      organizations: [...builderState.organizations],
      adm1_codes: [...builderState.adm1_codes],
      description: `GKG: ${themeDesc}${requiredDesc}${alsoDesc}${personsDesc}${orgsDesc}${adm1Desc}`,
    }
  }

  function buildHeadlineSimpleLogic(lane) {
    const state = lane === 'mediacloud' ? mediaCloudSimpleState : rssSimpleState
    const query_terms = state.query_terms.filter(t => t && t.trim())
    const require_any = state.require_any.filter(t => t && t.trim())
    const locales = state.locales.length > 0 ? state.locales : ['US:en']
    const localeLabels = locales.map(c => localeLabelByCeid[c] || c).join(', ')
    const filterDesc = require_any.length > 0 ? ` · must mention: ${require_any.join(' OR ')}` : ''
    if (lane === 'mediacloud') {
      return {
        query_terms,
        require_any,
        mediacloud_collections: cloneMediaCloudCollections(mediaCloudDraftCollections),
        description: `Media Cloud (simple): ${query_terms.join(' OR ') || '(no terms)'}${filterDesc} · ${mediaCloudDraftCollections.length} collection${mediaCloudDraftCollections.length === 1 ? '' : 's'}`,
      }
    }
    return {
      query_terms,
      require_any,
      locales: [...locales],
      description: `RSS (simple): ${query_terms.join(' OR ') || '(no terms)'}${filterDesc} · ${localeLabels}`,
    }
  }

  function buildHeadlineLogic(lane) {
    const state = lane === 'mediacloud' ? mediaCloudState : rssState
    const simpleMode = lane === 'mediacloud' ? mediaCloudSimpleMode : rssSimpleMode
    if (simpleMode) return buildHeadlineSimpleLogic(lane)
    const projectCountryDesc = rssProjectCountryNames.length > 0
      ? `project countries: ${rssProjectCountryNames.join(' OR ')}`
      : 'project countries not set'
    const countryDesc = state.countries.length > 0
      ? ` + extra geography: ${state.countries
          .map(code => rssCountriesByCode[code] || code)
          .join(state.countries_mode === 'all' ? ' + ' : ' OR ')}`
      : ''
    const actionDesc = state.action_core.length > 0
      ? state.action_core.join(' OR ')
      : 'headline keywords not set'
    const altDesc = state.action_alt.length > 0
      ? ` + alternates: ${state.action_alt.join(', ')}`
      : ''
    const actorDesc = [...state.people, ...state.organizations].length > 0
      ? ` + actors: ${[...state.people, ...state.organizations].join(', ')}`
      : ''
    const excludeDesc = state.exclude.length > 0
      ? ` + exclude: ${state.exclude.join(', ')}`
      : ''
    const sourceName = lane === 'mediacloud' ? 'Media Cloud' : 'RSS'
    const built = {
      countries: [...state.countries],
      countries_mode: state.countries_mode,
      people: [...state.people],
      organizations: [...state.organizations],
      action_core: [...state.action_core],
      action_alt: [...state.action_alt],
      exclude: [...state.exclude],
      description: `${sourceName}: ${projectCountryDesc}${countryDesc} + ${actionDesc}${altDesc}${actorDesc}${excludeDesc}`,
    }
    if (lane === 'mediacloud') {
      built.mediacloud_collections = cloneMediaCloudCollections(mediaCloudDraftCollections)
    } else {
      built.query_plan = compileRssQueries(state).map(query => query.query)
    }
    return built
  }

  const HEADLINE_LOGIC_KEYS = [
    'countries', 'countries_mode', 'people', 'organizations', 'action_core',
    'action_alt', 'exclude', 'query_plan', 'query_terms', 'focus_terms',
    'require_any', 'locales', 'mediacloud_collections', 'description',
  ]

  function preserveUnknownHeadlineLogic(lane, logic) {
    const preserved = { ...(existingRuleForLane(lane)?.logic || {}) }
    for (const key of HEADLINE_LOGIC_KEYS) delete preserved[key]
    return { ...preserved, ...logic }
  }

  function logicForLane(lane) {
    if (lane === 'doc') return buildDocLogic()
    if (SOCIAL_LANES.includes(lane)) {
      const logic = socialLogic(lane)
      return { ...logic, description: `${SOCIAL_NAMES[lane]}: ${socialSearches(lane, logic).map(search => search.text).join('; ')}` }
    }
    if (lane === 'rss' || lane === 'mediacloud') {
      return preserveUnknownHeadlineLogic(lane, buildHeadlineLogic(lane))
    }
    return buildEventsLogic()
  }

  function lanesToSave() {
    return ['events', 'doc', 'rss', 'mediacloud', 'x', 'bluesky', 'telegram'].filter(lane =>
      existingRuleForLane(lane) || touchedLanes.has(lane) || (lane === activeTab && !rule)
    )
  }

  function buildRulesToSave() {
    return lanesToSave().map(lane => {
      const existing = existingRuleForLane(lane)
      const shouldRebuild = touchedLanes.has(lane) || !existing
      return {
        bucket_name: ruleName.trim(),
        lane,
        logic: shouldRebuild ? logicForLane(lane) : existing.logic,
        enabled: existing?.enabled ?? true,
      }
    })
  }

  async function saveAsPreset() {
    const name = presetNameInput.trim()
    if (!name) return
    const rules = buildRulesToSave()
    const presetLane = rules.length > 1 ? 'ruleset' : activeTab
    let logic
    if (rules.length > 1) {
      logic = { rules }
    } else if (activeTab === 'doc') {
      // GKG preset: themes, also_countries, persons, organizations, adm1_codes, description
      logic = { ...buildDocLogic(), description: name }
    } else if (activeTab === 'rss' || activeTab === 'mediacloud' || SOCIAL_LANES.includes(activeTab)) {
      logic = { ...logicForLane(activeTab), description: name }
    } else {
      logic = buildEventsLogic()
    }
    const r = await api.createPreset({
      name,
      lane: presetLane,
      logic,
    })
    if (r.ok) {
      presets = [...presets, r.data]
      showPresetSaveForm = false
      presetNameInput = ''
    }
  }

  // toggleCategory removed — replaced by toggleCategoryAll / toggleCode / toggleExpand above

  // ── Save ──────────────────────────────────────────────────────────────────
  function save() {
    nameError = ''
    mediaCloudError = ''
    social.x.error = social.bluesky.error = social.telegram.error = ''
    if (!ruleName.trim()) {
      nameError = 'Rule name is required'
      return
    }

    const rules = buildRulesToSave()
    const enabledMediaCloudRule = rules.find(savedRule => savedRule.lane === 'mediacloud' && savedRule.enabled !== false)
    if (enabledMediaCloudRule && mediaCloudDraftCollections.length === 0) {
      activeTab = 'mediacloud'
      mediaCloudStep = 0
      mediaCloudError = 'Choose at least one Media Cloud collection before saving this rule.'
      return
    }
    const saved = rules.length === 1 ? rules[0] : rules
    const empty = rules.find(savedRule => SOCIAL_LANES.includes(savedRule.lane) && savedRule.enabled !== false && !socialSearches(savedRule.lane, savedRule.logic).length)
    if (empty) {
      activeTab = empty.lane
      social[empty.lane].error = empty.lane === 'telegram' ? 'Enter at least one public channel.' : 'Enter a search, at least one account, or both.'
      return
    }
    if (rules.some(savedRule => savedRule.lane === 'bluesky' && savedRule.enabled !== false && mixesListAndSearch(savedRule.logic))) {
      activeTab = 'bluesky'
      social.bluesky.error = 'A Bluesky list brings every post by its members and cannot be narrowed by a search. Put the list in a rule of its own.'
      return
    }
    // Chrome asks for access to x.com or t.me during this click; once granted it answers at once.
    const sites = rules.filter(savedRule => savedRule.enabled !== false && ['x', 'telegram'].includes(savedRule.lane)).map(savedRule => savedRule.lane)
    if (!sites.length) return onSave(saved)
    api.allowSites(sites.map(lane => `https://${SOCIAL_SITES[lane]}/*`)).then(response => {
      if (response.ok) onSave(saved)
      else { activeTab = sites[0]; social[sites[0]].error = response.error }
    })
  }
</script>

<!-- ── Modal overlay ────────────────────────────────────────────────────────── -->
<div class="qb-overlay">
  <button class="qb-backdrop" type="button" aria-label="Close rule builder" on:click={onCancel}></button>
  <div class="qb-panel" role="dialog" aria-modal="true">

    <!-- Header -->
    <div class="qb-header">
      <h2 class="qb-title">{rule ? 'Edit Rule' : 'Add Custom Rule'}</h2>
      <button class="qb-close" on:click={onCancel} aria-label="Close">✕</button>
    </div>

    <!-- Rule name -->
    <div class="qb-name-row">
      <label class="qb-label" for="qb-name">Rule name</label>
      <input
        id="qb-name"
        type="text"
        class="qb-input qb-input--wide"
        class:qb-input--error={!!nameError}
        placeholder="e.g. Deportation flights monitoring"
        bind:value={ruleName}
      />
      {#if nameError}<span class="qb-error">{nameError}</span>{/if}
    </div>

    <!-- Preset bar -->
    <div class="preset-bar">
      <span class="preset-bar-label">📂 Presets</span>
      {#if presets.length === 0}
        <span class="preset-empty">No presets yet — build a rule and use "Save as preset" below</span>
      {:else}
        <div class="preset-chips">
          {#each presets as preset}
            <span class="preset-chip">
              <button
                class="preset-chip-name"
                on:click={() => applyPreset(preset)}
                title="Load: {preset.name} ({preset.lane})"
              >
                {preset.lane === 'events' ? '📊' : preset.lane === 'rss' ? '🛰' : preset.lane === 'mediacloud' ? 'MC' : preset.lane === 'x' ? '𝕏' : preset.lane === 'bluesky' ? '🦋' : preset.lane === 'telegram' ? '✈' : preset.lane === 'ruleset' ? '📦' : '📰'} {preset.name}
              </button>
              <button
                class="preset-chip-del"
                on:click={() => deletePreset(preset.preset_id)}
                title="Delete preset"
              >×</button>
            </span>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Lane tabs — locked to existing lane when editing a saved rule -->
    <div class="qb-tabs">
      <button
        class="qb-tab"
        class:active={activeTab === 'events'}
        on:click={() => switchTab('events')}
      >
        <span class="tab-icon">📊</span>
        <span class="tab-label">
          GDELT Events
          <span class="tab-sub">Structured coded events data</span>
        </span>
      </button>
      <button
        class="qb-tab"
        class:active={activeTab === 'mediacloud'}
        on:click={() => switchTab('mediacloud')}
      >
        <span class="tab-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.24 8.8 4.6 4.6 0 0 0 7 18Z" />
          </svg>
        </span>
        <span class="tab-label">
          Media Cloud
          <span class="tab-sub">Curated collection search, checked daily</span>
        </span>
      </button>
      <button
        class="qb-tab"
        class:active={activeTab === 'doc'}
        on:click={() => switchTab('doc')}
      >
        <span class="tab-icon">📰</span>
        <span class="tab-label">
          News Articles (GKG)
          <span class="tab-sub">Location + theme filtering via GKG flat files</span>
        </span>
      </button>
      <button
        class="qb-tab"
        class:active={activeTab === 'rss'}
        on:click={() => switchTab('rss')}
      >
        <span class="tab-icon">🛰</span>
        <span class="tab-label">
          Google News RSS
          <span class="tab-sub">Interview wizard for headline-driven RSS searches</span>
        </span>
      </button>
      <button
        class="qb-tab"
        class:active={activeTab === 'x'}
        on:click={() => switchTab('x')}
      >
        <span class="tab-icon" aria-hidden="true">𝕏</span>
        <span class="tab-label">
          X (Twitter)
          <span class="tab-sub">Searches and accounts, read with your sign-in</span>
        </span>
      </button>
      <button
        class="qb-tab"
        class:active={activeTab === 'bluesky'}
        on:click={() => switchTab('bluesky')}
      >
        <span class="tab-icon" aria-hidden="true">🦋</span>
        <span class="tab-label">
          Bluesky
          <span class="tab-sub">Searches and accounts through Bluesky's API</span>
        </span>
      </button>
      <button
        class="qb-tab"
        class:active={activeTab === 'telegram'}
        on:click={() => switchTab('telegram')}
      >
        <span class="tab-icon" aria-hidden="true">✈</span>
        <span class="tab-label">
          Telegram
          <span class="tab-sub">Public channels, read without signing in</span>
        </span>
      </button>
    </div>

    <div class="qb-body">

      <!-- ── EVENTS TAB ─────────────────────────────────────────────────────── -->
      {#if activeTab === 'events'}
        <div class="events-tab">

          <!-- About GDELT Events -->
          <p class="qb-explainer">
            GDELT Events data codes real-world events from news: who did what to whom,
            where, and when. Each event has a code from the CAMEO taxonomy. Select which
            types of events you want to monitor.
          </p>

          <!-- Event code picker — accordion by category -->
          <div class="qb-section">
            <h3 class="qb-section-title">Event types to monitor</h3>
            <p class="qb-section-hint">
              Select whole categories or expand them to pick specific CAMEO codes.
              Leave everything unchecked to collect every event type.
            </p>

            {#each (ontology.event_categories || []) as cat}
              {@const state    = catState(cat)}
              {@const selCount = catSubcodes(cat).filter(s => selectedCodes.has(s.code)).length}
              {@const expanded = expandedCats.has(cat.key)}
              <div
                class="cat-accordion"
                class:has-selection={state !== 'unchecked'}
                class:expanded
              >
                <!-- Header row -->
                <div class="cat-accordion-header">
                  <!-- Checkbox: select/deselect whole category -->
                  <button
                    class="cat-check-btn"
                    class:checked={state === 'checked'}
                    class:partial={state === 'partial'}
                    on:click|stopPropagation={() => toggleCategoryAll(cat)}
                    title={state === 'checked' ? 'Deselect all' : 'Select all'}
                    aria-label="Toggle all codes in {cat.label}"
                  >
                    {#if state === 'checked'}✓{:else if state === 'partial'}−{:else}&nbsp;{/if}
                  </button>

                  <button
                    class="cat-title-btn"
                    type="button"
                    on:click={() => toggleExpand(cat.key)}
                    aria-expanded={expanded}
                  >
                    <span class="cat-icon">{cat.icon}</span>
                    <span class="cat-accordion-label">{cat.label}</span>

                    {#if state !== 'unchecked'}
                      <span class="cat-sel-badge">{selCount}/{catSubcodes(cat).length}</span>
                    {/if}
                  </button>

                  <button
                    class="cat-expand-btn"
                    type="button"
                    on:click|stopPropagation={() => toggleExpand(cat.key)}
                    title={expanded ? 'Collapse' : 'Browse codes'}
                  >
                    {expanded ? '▲' : '▼'} {catSubcodes(cat).length} codes
                  </button>
                </div>

                <!-- Expandable subcode list -->
                {#if expanded}
                  <div class="cat-subcodes">
                    <p class="cat-desc-text">{cat.description}</p>
                    {#each catSubcodes(cat) as sub}
                      <label class="subcode-row">
                        <input
                          type="checkbox"
                          checked={selectedCodes.has(sub.code)}
                          on:change={() => toggleCode(sub.code)}
                        />
                        <code class="subcode-badge">{sub.code}</code>
                        <span class="subcode-label">{sub.label}</span>
                      </label>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>

          <!-- Required actor countries -->
          <div class="qb-section">
            <h3 class="qb-section-title">Required actors <span class="optional">(optional)</span></h3>
            <p class="qb-section-hint">
              ALL listed countries must appear in the event. Leave empty to match by project-country or location only.
            </p>
            <div class="actor-req-row">
              {#each requiredActors as cameo}
                <span class="actor-req-chip">
                  {cameoToName[cameo] || cameo}
                  <button
                    class="chip-remove"
                    on:click={() => removeRequiredActor(cameo)}
                    title="Remove {cameoToName[cameo] || cameo}"
                  >×</button>
                </span>
              {/each}
              <select class="actor-req-add" on:change={addRequiredActor}>
                <option value="">+ Add country…</option>
                {#each sortedCountries as c}
                  {#if !requiredActors.includes(c.cameo.toUpperCase())}
                    <option value={c.cameo.toUpperCase()}>{c.name}</option>
                  {/if}
                {/each}
              </select>
            </div>

            {#if requiredActors.length > 0}
              <!-- Match mode: where in the GDELT row the required country must appear -->
              <div class="req-mode-row">
                <span class="req-mode-label">Match in</span>
                {#each [
                  { value: 'actor', label: 'Actor fields', tip: 'Actor1 / Actor2 country code — most precise, may miss non-English articles' },
                  { value: 'geo',   label: 'Geo fields',   tip: 'Action / Actor geo country code — catches events located in the country' },
                  { value: 'any',   label: 'Any field',    tip: 'Actor or geo — broadest recall, best for multilingual coverage' },
                ] as opt}
                  <button
                    class="req-mode-btn"
                    class:active={requiredCountriesMode === opt.value}
                    title={opt.tip}
                    on:click={() => { markLane('events'); requiredCountriesMode = opt.value }}
                  >{opt.label}</button>
                {/each}
              </div>
              {#if requiredCountriesMode === 'any'}
                <p class="req-mode-hint">
                  ℹ️ <strong>Any field</strong> gives the most results — useful when non-English sources are important —
                  but may include events where the country is only mentioned geographically, not as a participant.
                </p>
              {:else if requiredCountriesMode === 'geo'}
                <p class="req-mode-hint">
                  ℹ️ <strong>Geo fields</strong> match events that physically occurred in the required country,
                  even if that country isn't coded as an actor. Useful when the action takes place on a country's soil.
                </p>
              {/if}
            {/if}
          </div>

          <!-- Actor type filter (optional) -->
          <div class="qb-section">
            <h3 class="qb-section-title">Filter by actor type <span class="optional">(optional)</span></h3>
            <p class="qb-section-hint">Only include events where at least one actor has one of these roles. Leave blank to include all actors.</p>
            {#each actorTypeGroups as group}
              <div class="actor-group">
                <div class="actor-group-label">{group.label}</div>
                <div class="actor-chips">
                  {#each group.items as actorType}
                    <button
                      class="actor-chip"
                      class:selected={selectedActorTypes.includes(actorType.code)}
                      on:click={() => toggleActorType(actorType.code)}
                      title={actorType.description}
                    >
                      {actorType.label}
                    </button>
                  {/each}
                </div>
              </div>
            {/each}
          </div>

          <!-- Preview -->
          <div class="qb-preview">
            <div class="preview-label">📋 What this rule will collect:</div>
            <ul class="preview-list">
              {#each eventsPreview as line}
                <li>{line}</li>
              {/each}
            </ul>
            {#if eventCodePrefixes.length > 0}
              <div class="preview-codes">
                CAMEO codes matched: <code>{eventCodePrefixes.join(', ')}</code>
              </div>
            {:else}
              <div class="preview-codes" style="color:#6b7280">
                No code filter — all event types collected
              </div>
            {/if}
          </div>
        </div>

      <!-- ── GKG TAB ──────────────────────────────────────────────────────────── -->
      {:else if activeTab === 'doc'}
        <div class="doc-tab">

          <!-- About GKG -->
          <p class="qb-explainer">
            The GKG lane downloads GDELT's Global Knowledge Graph flat files every 15 minutes.
            Articles are matched by project scope, explicit rule countries, and optionally by
            <strong>topic tags</strong>.
            Both English and translated sources are covered with no extra configuration.
          </p>

          <!-- Project scope -->
          <div class="qb-section">
            <h3 class="qb-section-title">Project scope</h3>
            <p class="qb-section-hint">
              Articles are filtered to those that mention any of the project's focus countries
              via GDELT's FIPS country codes in the V1LOCATIONS column — the same primary gate
              used by the Events lane. Use <em>Required countries</em> below to bind this rule
              to a specific country or country set.
            </p>
          </div>

          <!-- Required countries -->
          <div class="qb-section">
            <h3 class="qb-section-title">Required countries <span class="optional">(optional)</span></h3>
            <p class="qb-section-hint">
              These countries must appear in the article for this rule to match. Use this for
              patterns like United States project scope + Ghana required country.
            </p>
            <div class="actor-req-row">
              {#each builderState.required_countries as name}
                <span class="actor-req-chip">
                  {name}
                  <button class="chip-remove" on:click={() => removeRequiredGkgCountry(name)} title="Remove {name}">×</button>
                </span>
              {/each}
              <select class="actor-req-add" on:change={addRequiredGkgCountry}>
                <option value="">+ Add country…</option>
                {#each gkgRequiredCountryOptions as c}
                  <option value={c.name}>{c.name}</option>
                {/each}
              </select>
            </div>
            {#if builderState.required_countries.length > 1}
              <div class="req-mode-row">
                <span class="req-mode-label">Require</span>
                {#each [
                  { value: 'all', label: 'All required', tip: 'Every listed country must appear' },
                  { value: 'any', label: 'Any one', tip: 'Any one listed country can satisfy this requirement' },
                ] as opt}
                  <button
                    class="req-mode-btn"
                    class:active={builderState.required_countries_mode === opt.value}
                    title={opt.tip}
                    on:click={() => { markLane('doc'); builderState = { ...builderState, required_countries_mode: opt.value } }}
                  >{opt.label}</button>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Theme tags (optional) -->
          <div class="qb-section">
            <h3 class="qb-section-title">Topic tags <span class="optional">(optional)</span></h3>
            <p class="qb-section-hint">
              Narrow results to articles tagged with specific GKG themes (e.g. IMMIGRATION,
              REFUGEES, HUMAN_RIGHTS).  Leave empty to collect <em>all</em> articles that
              mention this location.  Multiple tags are OR'd — an article needs only one to match.
            </p>
            {#if builderState.themes.length > 0}
              <div class="term-pills" style="margin-bottom:0.25rem">
                {#each builderState.themes as tag}
                  <span class="term-pill term-pill--theme">
                    {themeTagLabels[tag] || tag}
                    {#if themeTagFreqs[tag]}
                      <span class="theme-freq-badge">{fmtFreq(themeTagFreqs[tag])}</span>
                    {/if}
                    <button class="pill-remove" on:click={() => toggleTheme(tag)}>✕</button>
                  </span>
                {/each}
              </div>
            {/if}
            <div class="theme-search-row">
              <input
                type="text"
                class="qb-input theme-search-input"
                placeholder="Search 59,000+ topic tags…"
                bind:value={themeSearch}
                on:input={onThemeInput}
              />
              {#if themeSearching}
                <span class="theme-searching">searching…</span>
              {/if}
            </div>
            <div class="theme-list">
              {#if !themeSearch}
                <span class="theme-hint">Type above to search 59,000+ GKG topic tags</span>
              {:else if themeSearching}
                <!-- spinner shown inline -->
              {:else if themeResults.length === 0}
                <span class="theme-no-results">No matches for "{themeSearch}"</span>
              {:else}
                {#each themeResults as theme}
                  <button
                    class="theme-option"
                    class:selected={builderState.themes.includes(theme.tag)}
                    on:click={() => toggleTheme(theme.tag, theme.label, theme.freq)}
                    title={theme.tag}
                  >
                    <span class="theme-name">{theme.label}</span>
                    {#if theme.freq}
                      <span class="theme-freq">{fmtFreq(theme.freq)}</span>
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>
          </div>

          <!-- Also mentions (co-country filter) -->
          <div class="qb-section">
            <h3 class="qb-section-title">Also mentions <span class="optional">(optional)</span></h3>
            <p class="qb-section-hint">
              Article must also mention these countries according to the mode below —
              useful for tracking pair patterns like US + (Mexico OR Ghana).
            </p>
              <div class="actor-req-row">
                {#each builderState.also_countries as name}
                <span class="actor-req-chip">
                  {name}
                  <button class="chip-remove" on:click={() => removeAlsoCountry(name)} title="Remove {name}">×</button>
                </span>
              {/each}
              <select class="actor-req-add" on:change={addAlsoCountry}>
                <option value="">+ Add country…</option>
                {#each alsoCountriesOptions as c}
                  <option value={c.name}>{c.name}</option>
                {/each}
              </select>
            </div>
            {#if builderState.also_countries.length > 1}
              <div class="req-mode-row">
                <span class="req-mode-label">Require</span>
                {#each [
                  { value: 'all', label: 'All mentioned', tip: 'Every listed country must also appear' },
                  { value: 'any', label: 'Any one', tip: 'Any one listed country can satisfy the co-country requirement' },
                ] as opt}
                  <button
                    class="req-mode-btn"
                    class:active={builderState.also_countries_mode === opt.value}
                    title={opt.tip}
                    on:click={() => { markLane('doc'); builderState = { ...builderState, also_countries_mode: opt.value } }}
                  >{opt.label}</button>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Person names (optional) -->
          <div class="qb-section">
            <h3 class="qb-section-title">Person names <span class="optional">(optional)</span></h3>
            <p class="qb-section-hint">
              Article must mention at least one of these people (OR logic). Uses GDELT's named-entity extraction.
            </p>
            {#if builderState.persons.length > 0}
              <div class="term-pills" style="margin-bottom:0.4rem">
                {#each builderState.persons as p}
                  <span class="term-pill term-pill--person">
                    {p}
                    <button class="pill-remove" on:click={() => removePerson(p)}>✕</button>
                  </span>
                {/each}
              </div>
            {/if}
            <div class="name-input-row">
              <input
                type="text"
                class="qb-input"
                placeholder="e.g. Zelensky"
                bind:value={personInput}
                on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson() } }}
              />
              <button class="name-add-btn" on:click={addPerson}>Add</button>
            </div>
          </div>

          <!-- Organization names (optional) -->
          <div class="qb-section">
            <h3 class="qb-section-title">Organization names <span class="optional">(optional)</span></h3>
            <p class="qb-section-hint">
              Article must mention at least one of these organizations (OR logic).
            </p>
            {#if builderState.organizations.length > 0}
              <div class="term-pills" style="margin-bottom:0.4rem">
                {#each builderState.organizations as o}
                  <span class="term-pill term-pill--org">
                    {o}
                    <button class="pill-remove" on:click={() => removeOrg(o)}>✕</button>
                  </span>
                {/each}
              </div>
            {/if}
            <div class="name-input-row">
              <input
                type="text"
                class="qb-input"
                placeholder="e.g. UNHCR"
                bind:value={orgInput}
                on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOrg() } }}
              />
              <button class="name-add-btn" on:click={addOrg}>Add</button>
            </div>
          </div>

          <!-- Region / ADM1 codes (optional) -->
          <div class="qb-section">
            <h3 class="qb-section-title">Region codes <span class="optional">(optional)</span></h3>
            <p class="qb-section-hint">
              Filter to articles mentioning specific sub-national regions (ADM1 codes, e.g. <code>SY02</code> for Aleppo, <code>USTX</code> for Texas). At least one must match.
              <button class="qb-ref-link" on:click={() => api.openUrl('http://data.gdeltproject.org/documentation/GDELT-Global_Knowledge_Graph_Codebook-V2.1.pdf')}>GKG codebook ↗</button>
            </p>
            {#if builderState.adm1_codes.length > 0}
              <div class="term-pills" style="margin-bottom:0.4rem">
                {#each builderState.adm1_codes as code}
                  <span class="term-pill term-pill--adm1">
                    {code}
                    <button class="pill-remove" on:click={() => removeAdm1(code)}>✕</button>
                  </span>
                {/each}
              </div>
            {/if}
            <div class="name-input-row">
              <input
                type="text"
                class="qb-input"
                placeholder="e.g. SY02"
                bind:value={adm1Input}
                on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAdm1() } }}
              />
              <button class="name-add-btn" on:click={addAdm1}>Add</button>
            </div>
          </div>

          <!-- Rule preview -->
          <div class="qb-preview">
            <div class="preview-label">📋 What this rule will collect:</div>
            <ul class="preview-list">
              <li>
                Articles that mention any project scope country via GDELT location codes
              </li>
              {#if builderState.required_countries.length > 0}
                <li>
                  Required countries:
                  {#each builderState.required_countries as name, i}
                    <strong>{name}</strong>{i < builderState.required_countries.length - 1 ? (builderState.required_countries_mode === 'any' ? ' OR ' : ' AND ') : ''}
                  {/each}
                </li>
              {/if}
              {#if builderState.also_countries.length > 0}
                <li>
                  Also mentioning:
                  {#each builderState.also_countries as name, i}
                    <strong>{name}</strong>{i < builderState.also_countries.length - 1 ? (builderState.also_countries_mode === 'any' ? ' OR ' : ' AND ') : ''}
                  {/each}
                </li>
              {/if}
              {#if builderState.themes.length > 0}
                <li>
                  Tagged with:
                  {#each builderState.themes as tag, i}
                    <code class="theme-code">{tag}</code>{i < builderState.themes.length - 1 ? ' OR ' : ''}
                  {/each}
                </li>
              {:else}
                <li style="color:#6b7280">No theme filter — all location-matched articles are collected</li>
              {/if}
              {#if builderState.persons.length > 0}
                <li>Mentions person: {builderState.persons.join(' OR ')}</li>
              {/if}
              {#if builderState.organizations.length > 0}
                <li>Mentions org: {builderState.organizations.join(' OR ')}</li>
              {/if}
              {#if builderState.adm1_codes.length > 0}
                <li>In region: {builderState.adm1_codes.join(' OR ')}</li>
              {/if}
              <li>From both English and 65-language translated GDELT streams</li>
            </ul>
          </div>

        </div>
      {:else if SOCIAL_LANES.includes(activeTab)}
        <div class="x-tab">
          {#if activeTab === 'x'}
            <p class="qb-explainer">
              On each run Canary opens this search on x.com in a background tab of this browser, signed in as you,
              and collects every post since the last run, about 20 per page load. Sign in to x.com in this Chrome profile first.
            </p>
          {:else if activeTab === 'telegram'}
            <p class="qb-explainer">
              On each run Canary reads each channel directly through Telegram’s API when you connect an account below. Without one,
              it uses the public t.me preview instead. Telegram has no search across channels, so list the channels to follow.
            </p>
            <TelegramAccount />
          {:else}
            <p class="qb-explainer">
              On each run Canary searches Bluesky through its API and collects every post since the last run, up to 100 per request.
            </p>
            <BlueskyAccount />
          {/if}

          <div class="qb-section">
            <h3 class="qb-section-title">1. {activeTab === 'telegram' ? 'Keywords' : 'Search'} <span class="optional">{activeTab === 'telegram' ? 'optional' : `${SOCIAL_NAMES[activeTab]} search syntax`}</span></h3>
            <p class="qb-section-hint">
              {#if activeTab === 'telegram'}
                Separated by commas. Only posts containing any of them are kept, ignoring case. Leave empty to keep every post.
              {:else if activeTab === 'x'}
                Words, "exact phrases", OR, -exclusions and operators such as <code>lang:es</code>, <code>min_faves:10</code> or <code>filter:links</code>.
              {:else}
                Words, "exact phrases" and operators such as <code>lang:es</code>, <code>domain:apnews.com</code> or <code>#tag</code>.
              {/if}
            </p>
            <input
              type="text"
              class="qb-input qb-input--wide"
              placeholder={{ x: 'e.g. "border closure" OR deportation lang:es', bluesky: 'e.g. "border closure" lang:es', telegram: 'e.g. bridge, мост, міст' }[activeTab]}
              bind:value={social[activeTab].search}
              on:input={editSocial}
            />
          </div>

          <div class="qb-section">
            <h3 class="qb-section-title">2. {activeTab === 'telegram' ? 'Channels' : 'Accounts'} <span class="optional">{activeTab === 'telegram' ? 'required' : 'optional'}</span></h3>
            <p class="qb-section-hint">
              {#if activeTab === 'telegram'}
                Public channel names or <code>t.me/…</code> links, separated by commas or spaces. Each channel is read on its own.
              {:else if activeTab === 'x'}
                Handles or list links, separated by commas or spaces. With a search above, only their posts that match it are kept.
                A list (<code>x.com/i/lists/…</code>) follows all of its members in one search.
              {:else}
                Handles or list links, separated by commas or spaces. With a search above, only their posts that match it are kept.
                A list (<code>bsky.app/profile/…/lists/…</code>) brings every post by its members in one request, so give it a rule without a search.
              {/if}
            </p>
            <input
              type="text"
              class="qb-input qb-input--wide"
              placeholder={{ x: 'e.g. @Reuters, @AP', bluesky: 'e.g. @reuters.com, @apnews.com', telegram: 'e.g. @durov, t.me/telegram' }[activeTab]}
              bind:value={social[activeTab].accounts}
              on:input={editSocial}
            />
          </div>

          <div class="qb-section">
            <h3 class="qb-section-title">3. Start collecting from</h3>
            <p class="qb-section-hint">
              Posts before this moment are skipped. An earlier date backfills with the requests left after new posts, so a long backfill takes several runs.
            </p>
            <input type="datetime-local" class="qb-input" bind:value={social[activeTab].since} on:input={editSocial} />
          </div>

          <div class="qb-section">
            <h3 class="qb-section-title">4. Preview</h3>
            {#each socialPreview as search}
              <code class="rss-query-code">{search.text}</code>
              <a class="qb-ref-link" href={search.url} target="_blank" rel="noopener noreferrer">Open on {SOCIAL_SITES[activeTab]}</a>
            {:else}
              <p class="qb-section-hint">{activeTab === 'telegram' ? 'Enter at least one public channel.' : 'Enter a search, accounts, or both.'}</p>
            {/each}
            {#if socialCostNote}<p class="qb-section-hint qb-cost">{socialCostNote}</p>{/if}
            {#if social[activeTab].error}<p class="qb-error" role="alert">{social[activeTab].error}</p>{/if}
          </div>
        </div>
      {:else}
        <div class="rss-tab">
          {#if activeTab === 'mediacloud' && headlineStep === 0}
            <MediaCloudConfig
              selectedCountries={projectCountries}
              countryOptions={ontology.countries || []}
              bind:collections={mediaCloudDraftCollections}
              title="1. Choose collections"
              description="Search by a project country or topic, then choose the curated source collections this rule should probe once a day."
              embedded
              onCollectionsChange={handleMediaCloudCollectionsChange}
            />
            <p class="mc-scope-note">
              These collections belong to this Media Cloud rule. Other Media Cloud rules can use different collections.
            </p>
            {#if mediaCloudError}<p class="qb-error mc-step-error" role="alert">{mediaCloudError}</p>{/if}
            <div class="rss-nav">
              <button class="qb-btn-cancel" disabled>← Back</button>
              <button class="qb-btn-save-preset" on:click={() => goToHeadlineStep(1)}>Next →</button>
            </div>
          {:else}
            {#if activeTab === 'mediacloud'}
              <div class="mc-selection-summary">
                <div>
                  <strong>1. Collections</strong>
                  <span>{mediaCloudDraftCollections.length} selected</span>
                </div>
                <button type="button" class="qb-ref-link" on:click={() => goToHeadlineStep(0)}>Edit collections</button>
              </div>
            {/if}

            <div class="rss-mode-toggle">
              <button
                class="rss-mode-btn"
                class:active={!headlineSimpleMode}
                on:click={() => { if (headlineSimpleMode) toggleHeadlineSimpleMode() }}
              >Guided (interview)</button>
              <button
                class="rss-mode-btn"
                class:active={headlineSimpleMode}
                on:click={() => { if (!headlineSimpleMode) toggleHeadlineSimpleMode() }}
              >{activeTab === 'mediacloud' ? 'Simple (terms)' : 'Simple (terms + locales)'}</button>
            </div>

            {#if headlineSimpleMode}
              <p class="qb-explainer qb-explainer--rss">
                {#if activeTab === 'mediacloud'}
                  Add broad terms that Media Cloud will search across the selected collections each day. Multi-word terms are quoted automatically and terms are combined with OR.
                {:else}
                  Simple mode builds a broad Google News search per locale, then checks required terms against the headline, description and any on-device entity enrichment.
                {/if}
              </p>

              <div class="qb-section">
                <h3 class="qb-section-title">{headlineStepOffset + 1}. Query — broad reach</h3>
                <p class="qb-section-hint">
                  Geography, country names, or a key subject to search for. Keep these broad; terms are combined with OR.
                </p>
                {#if headlineSimpleState.query_terms.length > 0}
                  <div class="term-pills" style="margin-bottom:0.4rem">
                    {#each headlineSimpleState.query_terms as term}
                      <span class="term-pill term-pill--country">
                        {term}
                        <button class="pill-remove" aria-label="Remove {term}" on:click={() => removeHeadlineQueryTerm(term)}>✕</button>
                      </span>
                    {/each}
                  </div>
                {/if}
                <div class="name-input-row">
                  <input
                    type="text"
                    class="qb-input"
                    placeholder="e.g. Sudan, Sahel, Gaza"
                    value={headlineInput.query}
                    on:input={(e) => setHeadlineInput('query', e.currentTarget.value)}
                    on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHeadlineQueryTerm() } }}
                  />
                  <button class="qb-add-btn" on:click={addHeadlineQueryTerm}>Add</button>
                </div>
              </div>

              {#if activeTab === 'rss'}
                <div class="qb-section">
                  <h3 class="qb-section-title">2. Required — at least one must appear</h3>
                  <p class="qb-section-hint">
                    Persons, organisations, locations, or keywords that an article must mention to be kept. Leave empty to keep everything.
                  </p>
                  {#if headlineSimpleState.require_any.length > 0}
                    <div class="term-pills" style="margin-bottom:0.4rem">
                      {#each headlineSimpleState.require_any as term}
                        <span class="term-pill term-pill--action">
                          {term}
                          <button class="pill-remove" aria-label="Remove {term}" on:click={() => removeHeadlineRequire(term)}>✕</button>
                        </span>
                      {/each}
                    </div>
                  {:else}
                    <div class="qb-section-hint" style="font-style:italic">No filter — all fetched articles are kept.</div>
                  {/if}
                  <div class="name-input-row">
                    <input
                      type="text"
                      class="qb-input"
                      placeholder="e.g. RSF, Hemedti, Khartoum, ceasefire"
                      value={headlineInput.require}
                      on:input={(e) => setHeadlineInput('require', e.currentTarget.value)}
                      on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHeadlineRequire() } }}
                    />
                    <button class="qb-add-btn" on:click={addHeadlineRequire}>Add</button>
                  </div>
                </div>

                <div class="qb-section">
                  <h3 class="qb-section-title">3. Locales</h3>
                  <p class="qb-section-hint">
                    Each locale becomes a separate Google News RSS feed. Default is US English.
                  </p>
                  {#if headlineSimpleState.locales.length > 0}
                    <div class="term-pills" style="margin-bottom:0.4rem">
                      {#each headlineSimpleState.locales as ceid}
                        <span class="term-pill term-pill--country">
                          {localeLabelByCeid[ceid] || ceid}
                          <button class="pill-remove" aria-label="Remove {localeLabelByCeid[ceid] || ceid}" on:click={() => removeHeadlineLocale(ceid)}>✕</button>
                        </span>
                      {/each}
                    </div>
                  {/if}
                  <div class="actor-req-row">
                    <select class="actor-req-add" aria-label="Add locale" on:change={addHeadlineLocale}>
                      <option value="">+ Add locale…</option>
                      {#each headlineLocaleOptions as option}
                        <option value={option.ceid}>{option.label}</option>
                      {/each}
                    </select>
                  </div>
                </div>
              {/if}
            {:else}
              <p class="qb-explainer qb-explainer--rss">
                {#if activeTab === 'mediacloud'}
                  Build a daily Media Cloud search from geography, actors, and likely story language. Every selected collection is searched in all languages it contains.
                {:else}
                  Answer a few questions about likely headline language. Canary compiles the answers into several current-day Google News RSS searches and applies a second-pass filter after fetching.
                {/if}
              </p>

              <div class="rss-stepper">
                {#each headlineSteps as label, idx}
                  <button
                    class="rss-step"
                    class:active={headlineStep === idx}
                    on:click={() => goToHeadlineStep(idx)}
                  >
                    <span class="rss-step-num">{idx + 1}</span>
                    <span>{label}</span>
                  </button>
                {/each}
              </div>

              {#if headlineEditorStep === 0}
                <div class="qb-section">
                  <h3 class="qb-section-title">{headlineStepOffset + 1}. What other geography may be involved?</h3>
                  <p class="qb-section-hint">
                    The project's countries of interest are already part of this rule. Add only extra geography that may also appear in the story.
                  </p>
                  <div class="rss-project-countries">
                    <div class="rss-subtitle">Project countries</div>
                    {#if rssProjectCountryNames.length > 0}
                      <div class="term-pills" style="margin-bottom:0.5rem">
                        {#each rssProjectCountryNames as name}
                          <span class="term-pill term-pill--country term-pill--locked">{name}</span>
                        {/each}
                      </div>
                    {:else}
                      <div class="qb-section-hint">No project countries selected yet.</div>
                    {/if}
                  </div>
                  <div class="rss-subtitle">Additional geography</div>
                  {#if headlineState.countries.length > 0}
                    <div class="term-pills" style="margin-bottom:0.5rem">
                      {#each headlineState.countries as code}
                        <span class="term-pill term-pill--country">
                          {rssCountriesByCode[code] || code}
                          <button class="pill-remove" aria-label="Remove {rssCountriesByCode[code] || code}" on:click={() => removeHeadlineCountry(code)}>✕</button>
                        </span>
                      {/each}
                    </div>
                  {/if}
                  <div class="actor-req-row">
                    <select class="actor-req-add" aria-label="Add geography" on:change={addHeadlineCountry}>
                      <option value="">+ Add geography…</option>
                      {#each rssCountryOptions as country}
                        <option value={country.code}>{country.name}</option>
                      {/each}
                    </select>
                  </div>
                  <div class="req-mode-row">
                    <span class="req-mode-label">Require</span>
                    {#each [
                      { value: 'all', label: 'All extras', tip: 'All additional geographies must be part of the story' },
                      { value: 'any', label: 'Any extra', tip: 'Any one of the additional geographies can match' },
                    ] as option}
                      <button
                        class="req-mode-btn"
                        class:active={headlineState.countries_mode === option.value}
                        title={option.tip}
                        on:click={() => setHeadlineCountriesMode(option.value)}
                      >{option.label}</button>
                    {/each}
                  </div>
                </div>
              {:else if headlineEditorStep === 1}
                <div class="qb-section">
                  <h3 class="qb-section-title">{headlineStepOffset + 2}. Who is involved?</h3>
                  <p class="qb-section-hint">Add people and organizations if the story depends on them. These are optional.</p>
                  <div class="rss-grid">
                    <div>
                      <div class="rss-subtitle">People</div>
                      {#if headlineState.people.length > 0}
                        <div class="term-pills" style="margin-bottom:0.4rem">
                          {#each headlineState.people as value}
                            <span class="term-pill term-pill--person">
                              {value}
                              <button class="pill-remove" aria-label="Remove {value}" on:click={() => removeHeadlinePerson(value)}>✕</button>
                            </span>
                          {/each}
                        </div>
                      {/if}
                      <div class="name-input-row">
                        <input
                          type="text"
                          class="qb-input"
                          placeholder="e.g. Vance"
                          value={headlineInput.person}
                          on:input={(e) => setHeadlineInput('person', e.currentTarget.value)}
                          on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHeadlinePerson() } }}
                        />
                        <button class="name-add-btn" on:click={addHeadlinePerson}>Add</button>
                      </div>
                    </div>
                    <div>
                      <div class="rss-subtitle">Organizations</div>
                      {#if headlineState.organizations.length > 0}
                        <div class="term-pills" style="margin-bottom:0.4rem">
                          {#each headlineState.organizations as value}
                            <span class="term-pill term-pill--org">
                              {value}
                              <button class="pill-remove" aria-label="Remove {value}" on:click={() => removeHeadlineOrganization(value)}>✕</button>
                            </span>
                          {/each}
                        </div>
                      {/if}
                      <div class="name-input-row">
                        <input
                          type="text"
                          class="qb-input"
                          placeholder="e.g. IAEA"
                          value={headlineInput.organization}
                          on:input={(e) => setHeadlineInput('organization', e.currentTarget.value)}
                          on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHeadlineOrganization() } }}
                        />
                        <button class="name-add-btn" on:click={addHeadlineOrganization}>Add</button>
                      </div>
                    </div>
                  </div>
                </div>
              {:else if headlineEditorStep === 2}
                <div class="qb-section">
                  <h3 class="qb-section-title">{headlineStepOffset + 3}. What language would journalists use?</h3>
                  <p class="qb-section-hint">Add likely phrases, alternate wording, and exclusions.</p>
                  <div class="rss-grid">
                    <div>
                      <div class="rss-subtitle">Core headline phrases</div>
                      {#if headlineState.action_core.length > 0}
                        <div class="term-pills" style="margin-bottom:0.4rem">
                          {#each headlineState.action_core as value}
                            <span class="term-pill term-pill--theme">
                              {value}
                              <button class="pill-remove" aria-label="Remove {value}" on:click={() => removeHeadlineCore(value)}>✕</button>
                            </span>
                          {/each}
                        </div>
                      {/if}
                      <div class="name-input-row">
                        <input
                          type="text"
                          class="qb-input"
                          placeholder="e.g. hold talks"
                          value={headlineInput.core}
                          on:input={(e) => setHeadlineInput('core', e.currentTarget.value)}
                          on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHeadlineCore() } }}
                        />
                        <button class="name-add-btn" on:click={addHeadlineCore}>Add</button>
                      </div>
                    </div>
                    <div>
                      <div class="rss-subtitle">Alternate wording</div>
                      {#if headlineState.action_alt.length > 0}
                        <div class="term-pills" style="margin-bottom:0.4rem">
                          {#each headlineState.action_alt as value}
                            <span class="term-pill term-pill--adm1">
                              {value}
                              <button class="pill-remove" aria-label="Remove {value}" on:click={() => removeHeadlineAlternate(value)}>✕</button>
                            </span>
                          {/each}
                        </div>
                      {/if}
                      <div class="name-input-row">
                        <input
                          type="text"
                          class="qb-input"
                          placeholder="e.g. negotiations"
                          value={headlineInput.alternate}
                          on:input={(e) => setHeadlineInput('alternate', e.currentTarget.value)}
                          on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHeadlineAlternate() } }}
                        />
                        <button class="name-add-btn" on:click={addHeadlineAlternate}>Add</button>
                      </div>
                    </div>
                  </div>
                  <div class="rss-subtitle" style="margin-top:0.8rem">Exclude words</div>
                  {#if headlineState.exclude.length > 0}
                    <div class="term-pills" style="margin-bottom:0.4rem">
                      {#each headlineState.exclude as value}
                        <span class="term-pill term-pill--exclude">
                          {value}
                          <button class="pill-remove" aria-label="Remove {value}" on:click={() => removeHeadlineExclude(value)}>✕</button>
                        </span>
                      {/each}
                    </div>
                  {/if}
                  <div class="name-input-row">
                    <input
                      type="text"
                      class="qb-input"
                      placeholder="e.g. sports"
                      value={headlineInput.exclude}
                      on:input={(e) => setHeadlineInput('exclude', e.currentTarget.value)}
                      on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHeadlineExclude() } }}
                    />
                    <button class="name-add-btn" on:click={addHeadlineExclude}>Add</button>
                  </div>
                </div>
              {:else}
                <div class="qb-section">
                  <h3 class="qb-section-title">{headlineStepOffset + 4}. Preview {activeTab === 'mediacloud' ? 'Media Cloud rule' : 'compiled RSS searches'}</h3>
                  <div class="qb-preview">
                    <div class="preview-label">📋 What this {activeTab === 'mediacloud' ? 'Media Cloud' : 'RSS'} rule means:</div>
                    <ul class="preview-list">
                      {#if activeTab === 'mediacloud'}
                        <li>{mediaCloudDraftCollections.length} curated collection{mediaCloudDraftCollections.length === 1 ? '' : 's'} searched once daily</li>
                      {/if}
                      {#each headlinePreviewSummary as line}
                        <li>{line}</li>
                      {/each}
                      {#if activeTab === 'rss'}
                        <li>Google-side prefilter: <code>when:1d</code></li>
                        <li>Canary applies exact publication-time filtering after fetch</li>
                      {:else}
                        <li>Media Cloud collection languages are searched automatically</li>
                      {/if}
                    </ul>
                  </div>
                  {#if activeTab === 'rss'}
                    <div class="rss-query-list">
                      {#each headlinePreviewQueries as query}
                        <div class="rss-query-card">
                          <div class="rss-query-header">
                            <span class="rss-query-label">{query.label}</span>
                            <span class="rss-query-len">{query.query.length} chars</span>
                          </div>
                          <code class="rss-query-code">{query.query}</code>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}

              <div class="rss-nav">
                <button class="qb-btn-cancel" on:click={() => goToHeadlineStep(Math.max(0, headlineStep - 1))} disabled={headlineStep === 0}>← Back</button>
                {#if headlineStep < headlineSteps.length - 1}
                  <button class="qb-btn-save-preset" on:click={() => goToHeadlineStep(Math.min(headlineSteps.length - 1, headlineStep + 1))}>Next →</button>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      {/if}

    </div><!-- /qb-body -->

    <!-- Footer actions -->
    <div class="qb-footer">
      {#if showPresetSaveForm}
        <span class="preset-save-label">Preset name:</span>
        <input
          type="text"
          class="qb-input preset-name-input"
          placeholder="e.g. Mexico border events"
          bind:value={presetNameInput}
          on:keydown={(e) => {
            if (e.key === 'Enter') saveAsPreset()
            if (e.key === 'Escape') { showPresetSaveForm = false; presetNameInput = '' }
          }}
        />
        <button class="qb-btn-preset-ok" on:click={saveAsPreset}>Save preset</button>
        <button class="qb-btn-preset-cancel" on:click={() => { showPresetSaveForm = false; presetNameInput = '' }}>✕</button>
      {:else}
        <button class="qb-btn-cancel" on:click={onCancel}>Cancel</button>
        <button
          class="qb-btn-save-preset"
          on:click={() => { presetNameInput = ruleName.trim(); showPresetSaveForm = true }}
          title="Save current rule configuration as a reusable preset"
        >
          💾 Save as preset
        </button>
        <button class="qb-btn-save" on:click={save}>
          {rule ? 'Save Changes' : 'Add Rule'}
        </button>
      {/if}
    </div>

  </div><!-- /qb-panel -->
</div><!-- /qb-overlay -->

<style>
  /* ── Overlay + Panel ───────────────────────────────────────────────────────── */
  .qb-overlay {
    background: rgba(0, 0, 0, 0.45);
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    left: 0;
    position: fixed;
    right: 0;
    top: 0;
    z-index: 1000;
    animation: fade-in 0.15s ease;
  }
  .qb-backdrop {
    background: transparent;
    border: 0;
    bottom: 0;
    cursor: default;
    left: 0;
    padding: 0;
    position: absolute;
    right: 0;
    top: 0;
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

  .qb-panel {
    animation: slide-in 0.2s ease;
    background: var(--bg-card);
    border-left: 1px solid var(--border);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    max-width: 680px;
    overflow: hidden;
    position: relative;
    width: 100%;
    z-index: 1;
  }
  @keyframes slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

  /* ── Header ────────────────────────────────────────────────────────────────── */
  .qb-header {
    align-items: center;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    padding: 1rem 1.25rem;
  }
  .qb-title { font-size: 1.1rem; font-weight: 700; margin: 0; }
  .qb-close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    padding: 0.25rem;
  }
  .qb-close:hover { color: var(--text); }

  /* ── Name row ──────────────────────────────────────────────────────────────── */
  .qb-name-row {
    border-bottom: 1px solid var(--border-light);
    padding: 0.75rem 1.25rem;
  }
  .qb-label {
    display: block;
    font-size: 0.78rem;
    font-weight: 600;
    margin-bottom: 0.3rem;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.04em;
  }
  .qb-input {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font-size: 0.875rem;
    padding: 0.45rem 0.65rem;
  }
  .qb-input:focus { border-color: var(--accent); outline: none; }
  .qb-input--wide { width: 100%; box-sizing: border-box; }
  .qb-input--error { border-color: #f87171; }
  .qb-error { color: #dc2626; font-size: 0.75rem; margin-top: 0.25rem; display: block; }

  /* ── Tabs ──────────────────────────────────────────────────────────────────── */
  .qb-tabs {
    border-bottom: 1px solid var(--border);
    display: grid;
    grid-template-columns: repeat(3, 1fr);
  }
  .qb-tab {
    align-items: center;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    display: flex;
    flex: 1;
    gap: 0.6rem;
    padding: 0.7rem 1.25rem;
    text-align: left;
    transition: background 0.1s;
  }
  .qb-tab:hover:not(:disabled) { background: var(--bg-hover); }
  .qb-tab:disabled { cursor: default; opacity: 0.35; }
  .qb-tab.active {
    border-bottom-color: var(--accent);
    color: var(--accent);
  }
  .tab-icon { font-size: 1.2rem; }
  .tab-label { display: flex; flex-direction: column; }
  .tab-label { font-size: 0.85rem; font-weight: 600; }
  .tab-sub { color: var(--text-muted); font-size: 0.72rem; font-weight: 400; }

  /* ── Scrollable body ───────────────────────────────────────────────────────── */
  .qb-body {
    flex: 1;
    overflow-y: auto;
    padding: 0;
  }
  .events-tab, .doc-tab, .rss-tab, .x-tab { padding: 1rem 1.25rem 2rem; }
  .qb-cost { margin-top: 0.6rem; }

  /* ── Explainer ─────────────────────────────────────────────────────────────── */
  .qb-explainer {
    background: #f0f9ff;
    border: 1px solid var(--accent-light);
    border-radius: 6px;
    color: var(--accent);
    font-size: 0.8rem;
    line-height: 1.5;
    margin-bottom: 1.25rem;
    padding: 0.6rem 0.8rem;
  }
  .qb-explainer--rss {
    background: #fff7ed;
    border-color: #fed7aa;
    color: #9a3412;
  }

  /* ── Section ───────────────────────────────────────────────────────────────── */
  .qb-section {
    border-bottom: 1px solid var(--border-light);
    margin-bottom: 1.25rem;
    padding-bottom: 1.25rem;
  }
  .qb-section-title {
    align-items: center;
    display: flex;
    font-size: 0.9rem;
    font-weight: 600;
    gap: 0.5rem;
    margin: 0 0 0.35rem;
  }
  .qb-section-hint {
    color: var(--text-muted);
    font-size: 0.78rem;
    margin: 0 0 0.7rem;
  }
  .optional { color: var(--text-muted); font-size: 0.75rem; font-weight: 400; }
  .qb-ref-link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    text-decoration: underline;
  }

  .rss-mode-toggle {
    border: 1px solid var(--border);
    border-radius: 6px;
    display: inline-flex;
    margin-bottom: 1rem;
    overflow: hidden;
  }
  .rss-mode-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 500;
    padding: 0.4rem 0.9rem;
  }
  .rss-mode-btn.active {
    background: var(--accent);
    color: white;
  }

  .rss-stepper {
    display: grid;
    gap: 0.45rem;
    grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    margin-bottom: 1rem;
  }
  .rss-step {
    align-items: center;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    font-size: 0.76rem;
    font-weight: 500;
    gap: 0.45rem;
    justify-content: center;
    padding: 0.55rem 0.5rem;
  }
  .rss-step.active {
    background: #fff7ed;
    border-color: #fb923c;
    color: #9a3412;
  }
  .rss-step-num {
    align-items: center;
    background: rgba(255,255,255,0.8);
    border-radius: 999px;
    display: inline-flex;
    font-size: 0.7rem;
    height: 1.2rem;
    justify-content: center;
    width: 1.2rem;
  }
  .rss-grid {
    display: grid;
    gap: 0.9rem;
    grid-template-columns: 1fr 1fr;
  }
  .rss-subtitle {
    color: var(--text);
    font-size: 0.78rem;
    font-weight: 600;
    margin-bottom: 0.35rem;
  }
  .rss-query-list {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .rss-query-card {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.65rem 0.75rem;
  }
  .rss-query-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.4rem;
  }
  .rss-query-label {
    color: var(--text);
    font-size: 0.76rem;
    font-weight: 600;
  }
  .rss-query-len {
    color: var(--text-muted);
    font-size: 0.72rem;
  }
  .rss-query-code {
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-code);
    display: block;
    font-family: 'SFMono-Regular', Consolas, monospace;
    font-size: 0.72rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
    padding: 0.55rem 0.65rem;
    white-space: pre-wrap;
  }
  .rss-nav {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .mc-scope-note {
    color: var(--text-muted);
    font-size: 0.75rem;
    line-height: 1.45;
    margin: 0.65rem 0 0;
  }
  .mc-step-error { margin: 0.55rem 0 0; }
  .mc-selection-summary {
    align-items: center;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 6px;
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.75rem;
    padding: 0.55rem 0.7rem;
  }
  .mc-selection-summary div {
    align-items: baseline;
    display: flex;
    gap: 0.5rem;
  }
  .mc-selection-summary strong { font-size: 0.8rem; }
  .mc-selection-summary span { color: var(--text-muted); font-size: 0.75rem; }

  @media (max-width: 720px) {
    .rss-stepper,
    .rss-grid {
      grid-template-columns: 1fr;
    }
  }
  .qb-ref-link:hover { opacity: 0.75; }

  /* ── Category accordion ────────────────────────────────────────────────────── */
  .cat-accordion {
    border: 1px solid var(--border);
    border-radius: 7px;
    margin-bottom: 0.4rem;
    overflow: hidden;
    transition: border-color 0.12s;
  }
  .cat-accordion.has-selection { border-color: var(--accent-light); }
  .cat-accordion.expanded      { border-color: var(--accent); }

  .cat-accordion-header {
    align-items: center;
    background: var(--bg-hover);
    display: flex;
    gap: 0.45rem;
    padding: 0.5rem 0.65rem;
    transition: background 0.1s;
    user-select: none;
  }
  .cat-accordion-header:hover { background: var(--line); }
  .cat-accordion.has-selection .cat-accordion-header { background: var(--accent-soft); }

  .cat-title-btn {
    align-items: center;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    gap: 0.45rem;
    min-width: 0;
    padding: 0;
    text-align: left;
  }

  /* Checkbox-style toggle button */
  .cat-check-btn {
    align-items: center;
    background: var(--surface);
    border: 1.5px solid var(--border);
    border-radius: 4px;
    color: var(--accent);
    cursor: pointer;
    display: flex;
    flex-shrink: 0;
    font-size: 0.75rem;
    font-weight: 700;
    height: 16px;
    justify-content: center;
    line-height: 1;
    padding: 0;
    transition: background 0.1s, border-color 0.1s;
    width: 16px;
  }
  .cat-check-btn.checked  { background: var(--accent); border-color: var(--accent); color: white; }
  .cat-check-btn.partial  { background: var(--accent-soft); border-color: var(--accent-light); color: var(--accent-strong); }
  .cat-check-btn:hover    { border-color: var(--accent-light); }

  .cat-icon          { flex-shrink: 0; font-size: 1rem; }
  .cat-accordion-label { flex: 1; font-size: 0.8rem; font-weight: 500; }

  .cat-sel-badge {
    background: var(--accent);
    border-radius: 10px;
    color: white;
    flex-shrink: 0;
    font-size: 0.62rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
  }
  .cat-expand-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    font-size: 0.7rem;
    padding: 0.1rem 0.2rem;
    white-space: nowrap;
  }
  .cat-expand-btn:hover { color: var(--text); }

  /* Subcode list (expanded) */
  .cat-subcodes {
    background: var(--paper-2);
    border-top: 1px solid var(--border-light);
    padding: 0.5rem 0.75rem 0.6rem;
  }
  .cat-desc-text {
    color: var(--text-muted);
    font-size: 0.72rem;
    line-height: 1.45;
    margin: 0 0 0.5rem;
  }
  .subcode-row {
    align-items: center;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    gap: 0.5rem;
    padding: 0.2rem 0.3rem;
    margin: 0 -0.3rem;
    transition: background 0.08s;
  }
  .subcode-row:hover { background: #e9f0f8; }
  .subcode-row input[type=checkbox] { cursor: pointer; flex-shrink: 0; }
  .subcode-badge {
    background: var(--line);
    border-radius: 3px;
    color: var(--muted);
    flex-shrink: 0;
    font-family: monospace;
    font-size: 0.7rem;
    min-width: 2.6rem;
    padding: 0.1rem 0.35rem;
    text-align: center;
  }
  .subcode-label { color: var(--text); font-size: 0.78rem; }

  /* ── Required actor picker ─────────────────────────────────────────────────── */
  .actor-req-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
  }

  .actor-req-chip {
    align-items: center;
    background: var(--accent-soft);
    border: 1px solid var(--accent-light);
    border-radius: 14px;
    color: var(--accent-strong);
    display: inline-flex;
    font-size: 0.78rem;
    font-weight: 500;
    gap: 0.3rem;
    padding: 0.2rem 0.4rem 0.2rem 0.7rem;
  }

  .chip-remove {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0;
  }
  .chip-remove:hover { color: var(--accent-strong); }

  .actor-req-add {
    background: var(--bg-card);
    border: 1px dashed var(--border);
    border-radius: 14px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.2rem 0.55rem;
  }
  .actor-req-add:focus { border-color: var(--accent); outline: none; }

  /* Required-country match mode toggle */
  .req-mode-row {
    align-items: center;
    display: flex;
    gap: 0.35rem;
    margin-top: 0.6rem;
  }
  .req-mode-label {
    color: var(--text-muted);
    font-size: 0.75rem;
    margin-right: 0.2rem;
    white-space: nowrap;
  }
  .req-mode-btn {
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0.2rem 0.6rem;
    transition: background 0.1s, color 0.1s;
  }
  .req-mode-btn:hover { background: var(--border); }
  .req-mode-btn.active {
    background: var(--accent-soft);
    border-color: var(--accent-light);
    color: var(--accent-strong);
    font-weight: 600;
  }
  .req-mode-hint {
    color: var(--text-muted);
    font-size: 0.75rem;
    line-height: 1.4;
    margin: 0.4rem 0 0;
  }

  /* ── Actor type filter ─────────────────────────────────────────────────────── */
  .actor-group { margin-bottom: 0.75rem; }
  .actor-group-label {
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    margin-bottom: 0.35rem;
    text-transform: uppercase;
  }
  .actor-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .actor-chip {
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 20px;
    color: var(--text);
    cursor: pointer;
    font-size: 0.73rem;
    padding: 0.18rem 0.55rem;
    transition: all 0.1s;
  }
  .actor-chip:hover { background: var(--line); }
  .actor-chip.selected {
    background: var(--accent-soft);
    border-color: var(--accent-light);
    color: var(--accent-strong);
  }

  /* ── Preview ───────────────────────────────────────────────────────────────── */
  .qb-preview {
    background: #f0fdf4;
    border: 1px solid #86efac;
    border-radius: 7px;
    margin-top: 0.5rem;
    padding: 0.75rem;
  }
  .preview-label { color: #166534; font-size: 0.78rem; font-weight: 600; margin-bottom: 0.4rem; }
  .preview-list { color: #15803d; font-size: 0.78rem; margin: 0; padding-left: 1.2rem; }
  .preview-list li { margin-bottom: 0.2rem; }
  .theme-code { background: var(--accent-soft); border-radius: 3px; color: var(--accent-strong); font-size: 0.72rem; padding: 0.05rem 0.3rem; }
  .preview-codes { color: #166534; font-size: 0.72rem; margin-top: 0.4rem; }
  .preview-codes code { background: #dcfce7; border-radius: 3px; padding: 0.1rem 0.3rem; }

  /* ── Term pills + inputs ───────────────────────────────────────────────────── */
  .term-pills { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.5rem; }
  .term-pill {
    align-items: center;
    border-radius: 20px;
    display: flex;
    font-size: 0.75rem;
    font-weight: 500;
    gap: 0.3rem;
    padding: 0.2rem 0.6rem 0.2rem 0.7rem;
  }
  .term-pill--theme  { background: #ede9fe; border: 1px solid #c4b5fd; color: #5b21b6; }
  .term-pill--person { background: var(--accent-soft); border: 1px solid var(--accent-light); color: var(--accent-strong); }
  .term-pill--org    { background: #fce7f3; border: 1px solid #f9a8d4; color: #9d174d; }
  .term-pill--country {
    background: #ecfeff;
    border: 1px solid #67e8f9;
    color: #155e75;
  }
  .term-pill--adm1   { background: #d1fae5; border: 1px solid #6ee7b7; color: #065f46; }
  .term-pill--locked {
    background: var(--paper-2);
    border-style: dashed;
    color: var(--muted);
  }

  .name-input-row {
    display: flex;
    gap: 0.4rem;
  }
  .name-add-btn {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
    white-space: nowrap;
  }
  .name-add-btn:hover { background: var(--bg-hover); }

  .pill-remove {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 0.7rem;
    opacity: 0.6;
    padding: 0;
  }
  .pill-remove:hover { opacity: 1; }

  /* ── Theme picker ──────────────────────────────────────────────────────────── */
  .theme-search-row {
    align-items: center;
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .theme-search-input { flex: 1; margin-bottom: 0; }
  .theme-searching { color: var(--text-muted); font-size: 0.72rem; white-space: nowrap; }
  .theme-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    max-height: 180px;
    overflow-y: auto;
  }
  .theme-option {
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0.25rem 0.55rem;
  }
  .theme-option:hover { background: var(--line); }
  .theme-option.selected { background: #ede9fe; border-color: #c4b5fd; color: #5b21b6; }
  .theme-name { font-weight: 500; }
  .theme-freq { color: var(--text-muted); font-size: 0.68rem; margin-left: 0.3rem; }
  .theme-freq-badge {
    background: #ddd6fe; color: #5b21b6;
    border-radius: 3px; font-size: 0.62rem;
    padding: 0 0.3rem; margin: 0 0.15rem;
    font-weight: 600;
  }
  .theme-no-results { color: var(--text-muted); font-size: 0.75rem; padding: 0.25rem; }
  .theme-hint { color: var(--text-muted); font-size: 0.75rem; font-style: italic; padding: 0.25rem; }

  /* ── Footer ────────────────────────────────────────────────────────────────── */
  .qb-footer {
    border-top: 1px solid var(--border);
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    padding: 0.9rem 1.25rem;
  }
  .qb-btn-cancel {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.875rem;
    padding: 0.5rem 1.25rem;
  }
  .qb-btn-cancel:hover { background: var(--bg-hover); }
  .qb-btn-save {
    background: var(--accent);
    border: none;
    border-radius: 6px;
    color: white;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    padding: 0.5rem 1.5rem;
  }
  .qb-btn-save:hover { background: var(--accent-strong); }

  /* ── Preset bar ─────────────────────────────────────────────────────────── */
  .preset-bar {
    align-items: center;
    background: var(--paper-2);
    border-bottom: 1px solid var(--border-light);
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-height: 2.2rem;
    padding: 0.4rem 1.25rem;
  }
  .preset-bar-label {
    color: var(--text-muted);
    flex-shrink: 0;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .preset-empty { color: var(--text-muted); font-size: 0.72rem; font-style: italic; }
  .preset-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .preset-chip {
    align-items: center;
    background: var(--accent-soft);
    border: 1px solid var(--accent-light);
    border-radius: 14px;
    display: inline-flex;
    overflow: hidden;
  }
  .preset-chip-name {
    background: none;
    border: none;
    color: var(--accent-strong);
    cursor: pointer;
    font-size: 0.72rem;
    font-weight: 500;
    padding: 0.18rem 0.3rem 0.18rem 0.6rem;
    white-space: nowrap;
  }
  .preset-chip-name:hover { background: var(--accent-soft); }
  .preset-chip-del {
    background: none;
    border: none;
    border-left: 1px solid var(--accent-light);
    color: var(--accent-strong);
    cursor: pointer;
    font-size: 0.8rem;
    line-height: 1;
    opacity: 0.45;
    padding: 0.18rem 0.4rem;
    transition: background 0.1s, opacity 0.1s;
  }
  .preset-chip-del:hover { background: #fee2e2; border-color: #fca5a5; color: #991b1b; opacity: 1; }

  /* ── Preset save inline form (in footer) ──────────────────────────────── */
  .preset-save-label {
    color: var(--text-muted);
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .preset-name-input { flex: 1; min-width: 0; }
  .qb-btn-preset-ok {
    background: var(--accent-strong);
    border: none;
    border-radius: 6px;
    color: white;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.45rem 0.9rem;
    white-space: nowrap;
  }
  .qb-btn-preset-ok:hover { background: var(--accent-strong); }
  .qb-btn-preset-cancel {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0.3rem 0.55rem;
  }
  .qb-btn-preset-cancel:hover { background: var(--bg-hover); }

  /* ── Save-as-preset button (normal footer) ────────────────────────────── */
  .qb-btn-save-preset {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    padding: 0.5rem 0.9rem;
    white-space: nowrap;
  }
  .qb-btn-save-preset:hover { background: var(--bg-hover); color: var(--text); }
</style>
