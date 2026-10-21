<script>
  import { onMount, tick } from 'svelte'
  import { tourOpen } from '../stores/app.js'

  const STORAGE_KEY = 'canary_tour_v1'

  // ── Step definitions ──────────────────────────────────────────────────────────
  // target: CSS selector for the element to spotlight (null → centered card)
  const steps = [
    {
      title: '👋 Welcome to Canary',
      body:  'This quick tour covers the core workflow — from creating a project to triaging your first events. Takes about 90 seconds.',
      target: null,
    },
    {
      title: '1 · Create a project',
      body:  'A <strong>project</strong> bundles your watchlist rules, collected items, and export settings. Hit <strong>"+ New Project"</strong> to get started.',
      target: '[data-tour="project-area"]',
    },
    {
      title: '2 · Define watchlist rules',
      body:  'Open <strong>Project Settings</strong> and use the <strong>Query Builder</strong> to combine keywords, CAMEO event codes, actor types, and country codes — this shapes exactly what GDELT collects for you.',
      target: '[data-tour="nav-settings"]',
    },
    {
      title: '3 · Monitor your inbox',
      body:  'Canary polls GDELT every 15 minutes. Matching articles appear in the <strong>Inbox</strong>. Each card shows the headline, actors, event code, location, and a link to the source article.',
      target: '[data-tour="nav-inbox"]',
    },
    {
      title: '4 · Triage what matters',
      body:  '<strong>Save</strong> items worth following up — add a tag and notes. <strong>Dismiss</strong> noise to keep the inbox clean. Saved items can be pushed to Google Sheets automatically or exported as JSON.',
      target: null,
    },
    {
      title: '5 · Filter & explore patterns',
      body:  'Use the <strong>filter panel</strong> (top-right of Inbox/Saved) to narrow by date range, source type, watchlist bucket, or country codes. The <strong>Timeline</strong> view plots events on a calendar to reveal spikes.',
      target: '[data-tour="nav-timeline"]',
    },
    {
      title: '✓ You\'re all set',
      body:  'Create your first project, add a watchlist rule, and come back in 15 minutes for your first events. Use <strong>? Tour</strong> at the bottom of the sidebar to replay anytime, or <strong>ℹ About</strong> for contact information.',
      target: null,
    },
  ]

  // ── State ─────────────────────────────────────────────────────────────────────
  let current = 0
  let highlightRect = null   // bounding rect of the spotlit element (+ padding)
  let cardWidth = 320        // approximate card width for edge clamping

  $: step    = steps[current]
  $: isFirst = current === 0
  $: isLast  = current === steps.length - 1
  $: pct     = Math.round(((current + 1) / steps.length) * 100)

  // ── Spotlight positioning ─────────────────────────────────────────────────────
  async function reposition() {
    highlightRect = null
    if (!step?.target) return
    await tick()
    const el = document.querySelector(step.target)
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    highlightRect = {
      top:    r.top    - pad,
      left:   r.left   - pad,
      width:  r.width  + pad * 2,
      height: r.height + pad * 2,
    }
  }

  // Reposition whenever the step changes or tour opens
  $: step, $tourOpen, reposition()

  // ── Card position (right of highlight, clamped to viewport) ──────────────────
  $: cardStyle = (() => {
    if (!highlightRect) return ''
    const margin = 16
    const left   = highlightRect.left + highlightRect.width + margin
    const top    = Math.max(8, Math.min(
      highlightRect.top,
      window.innerHeight - 260  // keep card on screen vertically
    ))
    return `top:${top}px; left:${left}px;`
  })()

  // ── Navigation ────────────────────────────────────────────────────────────────
  function next() { if (isLast) close(); else current++ }
  function prev() { if (!isFirst) current-- }

  function close() {
    tourOpen.set(false)
    localStorage.setItem(STORAGE_KEY, '1')
    current = 0
  }

  function handleKeydown(e) {
    if (!$tourOpen) return
    if (e.key === 'Escape')                            { e.preventDefault(); close() }
    if (e.key === 'ArrowRight' || e.key === 'Enter')   { e.preventDefault(); next()  }
    if (e.key === 'ArrowLeft')                         { e.preventDefault(); prev()  }
  }

  // ── Auto-show on first launch ─────────────────────────────────────────────────
  onMount(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setTimeout(() => tourOpen.set(true), 900)
    }
  })
</script>

<svelte:window on:keydown={handleKeydown} on:resize={reposition} />

{#if $tourOpen}
  <!-- ── Backdrop ── -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="tour-backdrop" on:click={close}></div>

  <!-- ── Spotlight cutout ── -->
  {#if highlightRect}
    <div
      class="tour-spotlight"
      style="top:{highlightRect.top}px; left:{highlightRect.left}px;
             width:{highlightRect.width}px; height:{highlightRect.height}px;"
    ></div>
  {/if}

  <!-- ── Callout card ── -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div
    class="tour-card"
    class:tour-card--centered={!highlightRect}
    style={highlightRect ? cardStyle : ''}
    role="dialog"
    aria-modal="true"
    aria-label="Tour: {step.title}"
    tabindex="-1"
    on:click|stopPropagation
  >
    <!-- Progress bar -->
    <div class="tour-progress-track">
      <div class="tour-progress-fill" style="width:{pct}%"></div>
    </div>

    <!-- Step counter -->
    <span class="tour-counter">{current + 1} of {steps.length}</span>

    <!-- Content -->
    <h2 class="tour-title">{step.title}</h2>
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <p class="tour-body">{@html step.body}</p>

    <!-- Controls -->
    <div class="tour-footer">
      <button class="tour-skip" on:click={close}>Skip tour</button>
      <div class="tour-nav">
        {#if !isFirst}
          <button class="tour-btn tour-btn--secondary" on:click={prev}>← Back</button>
        {/if}
        <button class="tour-btn tour-btn--primary" on:click={next}>
          {isLast ? 'Done ✓' : 'Next →'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Backdrop ──────────────────────────────────────────────────────────────── */
  .tour-backdrop {
    background: rgba(0, 0, 0, 0.55);
    inset: 0;
    position: fixed;
    z-index: 10000;
  }

  /* ── Spotlight ─────────────────────────────────────────────────────────────── */
  /* The spotlight div sits above the backdrop and uses a large box-shadow to
     re-darken everything EXCEPT the element's bounding rect.                   */
  .tour-spotlight {
    border-radius: 7px;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
    outline: 2px solid rgba(147, 197, 253, 0.5);
    pointer-events: none;
    position: fixed;
    transition: top 0.22s ease, left 0.22s ease,
                width 0.22s ease, height 0.22s ease;
    z-index: 10001;
  }

  /* ── Card ──────────────────────────────────────────────────────────────────── */
  .tour-card {
    animation: card-in 0.2s ease;
    background: #1e293b;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 12px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    color: #e2e8f0;
    max-width: 340px;
    min-width: 280px;
    overflow: hidden;
    position: fixed;
    z-index: 10002;
  }

  .tour-card--centered {
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    animation: card-in-center 0.2s ease;
  }

  @keyframes card-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes card-in-center {
    from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)); }
    to   { opacity: 1; transform: translate(-50%, -50%); }
  }

  /* ── Progress bar ──────────────────────────────────────────────────────────── */
  .tour-progress-track {
    background: rgba(255, 255, 255, 0.07);
    height: 3px;
    width: 100%;
  }
  .tour-progress-fill {
    background: #3b82f6;
    height: 100%;
    transition: width 0.3s ease;
  }

  /* ── Content ───────────────────────────────────────────────────────────────── */
  .tour-counter {
    color: #475569;
    display: block;
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    padding: 0.8rem 1.1rem 0;
    text-transform: uppercase;
  }

  .tour-title {
    color: #f1f5f9;
    font-size: 0.98rem;
    font-weight: 600;
    line-height: 1.3;
    margin: 0.3rem 0 0;
    padding: 0 1.1rem;
  }

  .tour-body {
    color: #94a3b8;
    font-size: 0.82rem;
    line-height: 1.65;
    margin: 0.55rem 0 0;
    padding: 0 1.1rem;
  }
  /* target the injected <strong> tags */
  .tour-body :global(strong) {
    color: #e2e8f0;
    font-weight: 600;
  }

  /* ── Footer controls ───────────────────────────────────────────────────────── */
  .tour-footer {
    align-items: center;
    border-top: 1px solid rgba(255, 255, 255, 0.07);
    display: flex;
    justify-content: space-between;
    margin-top: 0.85rem;
    padding: 0.8rem 1.1rem 1rem;
  }

  .tour-skip {
    background: none;
    border: none;
    color: #475569;
    cursor: pointer;
    font-size: 0.74rem;
    padding: 0;
    transition: color 0.12s;
  }
  .tour-skip:hover { color: #64748b; }

  .tour-nav { display: flex; gap: 0.5rem; }

  .tour-btn {
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.4rem 0.95rem;
    transition: background 0.15s;
  }
  .tour-btn--secondary {
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #94a3b8;
  }
  .tour-btn--secondary:hover { background: rgba(255, 255, 255, 0.13); color: #e2e8f0; }
  .tour-btn--primary {
    background: #2563eb;
    border: 1px solid transparent;
    color: #fff;
  }
  .tour-btn--primary:hover { background: #1d4ed8; }
</style>
