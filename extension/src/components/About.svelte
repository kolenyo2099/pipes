<script>
  import { aboutOpen } from '../stores/app.js'

  function close() { aboutOpen.set(false) }

  function handleKeydown(e) {
    if (!$aboutOpen) return
    if (e.key === 'Escape') { e.preventDefault(); close() }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if $aboutOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="about-backdrop" on:click={close}></div>

  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="about-modal" role="dialog" aria-modal="true" aria-label="About Pipeline" tabindex="-1" on:click|stopPropagation>
    <button class="about-close" on:click={close} aria-label="Close">✕</button>

    <img class="about-icon" src="/pipe.svg" alt="" />
    <h2 class="about-title">About Pipeline</h2>

    <p class="about-body">
      Pipeline, with its Canary monitoring section, was vibecoded with care by Guillen Torres, Investigations Lab,
      Human Rights Center, Berkeley School of Law. For questions, suggestions,
      complaints and threats, you can reach him at:
    </p>
    <a class="about-email" href="mailto:info@osinv.org">info@osinv.org</a>.
  </div>
{/if}

<style>
  .about-backdrop {
    background: rgba(0,0,0,0.5);
    inset: 0;
    position: fixed;
    z-index: 10000;
  }

  .about-modal {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.45);
    color: var(--ink);
    left: 50%;
    max-width: 420px;
    padding: 2rem 2rem 1.75rem;
    position: fixed;
    text-align: center;
    top: 50%;
    transform: translate(-50%, -50%);
    width: calc(100vw - 3rem);
    z-index: 10001;
    animation: about-in 0.18s ease;
  }
  @keyframes about-in {
    from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)); }
    to   { opacity: 1; transform: translate(-50%, -50%); }
  }

  .about-close {
    background: var(--paper-2);
    border: none;
    border-radius: 6px;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
    padding: 0.3rem 0.5rem;
    position: absolute;
    right: 1rem;
    top: 1rem;
    transition: background 0.12s, color 0.12s;
  }
  .about-close:hover { background: var(--line); color: var(--ink); }

  .about-icon { border-radius: 12px; box-shadow: 0 0 0 3px var(--pipe-ink); height: 52px; margin-bottom: 0.75rem; width: 52px; }

  .about-title {
    color: var(--ink);
    font-size: 1.05rem;
    font-weight: 700;
    margin: 0 0 1.25rem;
  }

  .about-body {
    color: var(--ink-2);
    font-size: 0.83rem;
    line-height: 1.65;
    margin: 0 0 0.75rem;
  }
  .about-email {
    background: var(--accent-soft);
    border: 1px solid var(--accent-light);
    border-radius: 6px;
    color: var(--accent-strong);
    display: inline-block;
    font-family: monospace;
    font-size: 0.82rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    margin-top: 0.25rem;
    padding: 0.35rem 0.75rem;
    text-decoration: none;
  }
</style>
