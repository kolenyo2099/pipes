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
  <div class="about-modal" role="dialog" aria-modal="true" aria-label="About Canary" tabindex="-1" on:click|stopPropagation>
    <button class="about-close" on:click={close} aria-label="Close">✕</button>

    <div class="about-icon">◈</div>
    <h2 class="about-title">About Canary</h2>

    <p class="about-body">
      Canary was vibecoded with care by Guillen Torres, Investigations Lab,
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
    background: #1e293b;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.45);
    color: #e2e8f0;
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
    background: rgba(255,255,255,0.07);
    border: none;
    border-radius: 6px;
    color: #64748b;
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
    padding: 0.3rem 0.5rem;
    position: absolute;
    right: 1rem;
    top: 1rem;
    transition: background 0.12s, color 0.12s;
  }
  .about-close:hover { background: rgba(255,255,255,0.14); color: #e2e8f0; }

  .about-icon {
    color: #60a5fa;
    font-size: 2.2rem;
    margin-bottom: 0.5rem;
  }

  .about-title {
    color: #f1f5f9;
    font-size: 1.05rem;
    font-weight: 700;
    margin: 0 0 1.25rem;
  }

  .about-body {
    color: #94a3b8;
    font-size: 0.83rem;
    line-height: 1.65;
    margin: 0 0 0.75rem;
  }
  .about-email {
    background: rgba(96,165,250,0.12);
    border: 1px solid rgba(96,165,250,0.25);
    border-radius: 6px;
    color: #60a5fa;
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
