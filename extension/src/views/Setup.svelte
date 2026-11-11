<!-- Everything needed to set Pipeline up, in the order you do it. The bridge script is bundled so it can be copied from here. -->
<script>
  import bridge from '../../../bridge/Code.gs?raw'
  import { currentView, teamState } from '../stores/app.js'

  const REPO = 'https://github.com/kolenyo2099/pipes'
  let copied = ''
  async function copy(what, text) {
    await navigator.clipboard.writeText(text)
    copied = what
    setTimeout(() => { if (copied === what) copied = '' }, 2000)
  }
</script>

<div class="page setup">
  <h1>Set up Pipeline</h1>
  <p class="lead">
    Pipeline has three parts: this <b>extension</b> (everyone installs it), a <b>Google Sheet</b> with a small script
    (one per project; it is where the team's saves live), and optionally a <b>GitHub repository</b> that processes the
    saves on a schedule and publishes the Explore page.
  </p>
  <nav class="toc" aria-label="Setup sections">
    <a href="#setup-join">1 · Join a project</a>
    <a href="#setup-sheet">2 · Create a project (sheet)</a>
    <a href="#setup-github">3 · Explore (GitHub)</a>
    <a href="#setup-use">4 · Daily use</a>
  </nav>

  <section id="setup-join">
    <h2><span class="num">1</span> Join a project <span class="who">everyone</span></h2>
    <p>If a teammate already created the project, this is all you need.</p>
    <ol>
      <li>Ask them for the project's <b>join code</b> (a long line of letters and numbers).</li>
      <li>Open <button class="link" on:click={() => currentView.set('team')}>Join or manage projects</button>, paste the code, give the project a name and type your own name. Your name is what teammates see next to your saves.</li>
      <li>Pin Pipeline to Chrome's toolbar (puzzle icon → pin) so the badge with waiting saves stays visible.</li>
    </ol>
    <p class="state">{$teamState ? `You are in “${$teamState.label}”.` : 'You have not joined a project yet.'}</p>
  </section>

  <section id="setup-sheet">
    <h2><span class="num">2</span> Create a project <span class="who">once per project, by one person</span></h2>
    <p>A project is one Google Sheet. A script inside the sheet (the “bridge”) receives what the team saves.</p>
    <ol>
      <li>Create a new Google Sheet in the account that should own the project. Name it after the project.</li>
      <li>In the sheet: <b>Extensions → Apps Script</b>. Delete the sample code in the editor.</li>
      <li>
        Paste the bridge script and press save (the disk icon).
        <button class="primary" on:click={() => copy('bridge', bridge)}>{copied === 'bridge' ? 'Copied ✓' : 'Copy the bridge script'}</button>
      </li>
      <li>Go back to the sheet and reload it. A <b>Pipeline</b> menu appears after a few seconds.</li>
      <li><b>Pipeline → Team setup</b>. Google asks you to authorise the script the first time: choose your account, then “Advanced” → “Go to … (unsafe)” → Allow. That warning appears because the script is your own and not reviewed by Google.</li>
      <li>In the Apps Script editor: <b>Deploy → New deployment</b>, type <b>Web app</b>. Set <i>Execute as</i> <b>Me</b> and <i>Who has access</i> <b>Anyone</b>, then Deploy.</li>
      <li>Copy the <b>Web app URL</b> from the dialog. It ends in <code>/exec</code>.</li>
      <li>Back in the sheet: <b>Pipeline → Show join code</b>, paste that URL. The dialog shows the join code.</li>
      <li>Join with that code yourself (step 1), then send it to your team. Treat it like a password: anyone who has it can write to the sheet.</li>
    </ol>
    <details>
      <summary>Updating the bridge later</summary>
      <p>Paste the new script over the old one, save, then <b>Deploy → Manage deployments → pencil → Version: New version → Deploy</b>. The URL and the join code stay the same. A <i>new</i> deployment would change the URL and everyone would have to join again.</p>
    </details>
    <details>
      <summary>Someone left, or the join code leaked</summary>
      <p><b>Pipeline → Rotate join code</b> in the sheet. The old code stops working at once; send the new one to the team (everyone joins again under the same project name) and, if you use GitHub, replace the <code>PIPELINE_TEAM_CODE</code> secret.</p>
    </details>
    <details>
      <summary>What appears in the sheet</summary>
      <ul>
        <li><code>Archive</code>: one row per saved item, with who saved it, its archive status and evidence hashes.</li>
        <li><code>Texts</code>: the page text sent with each save, used for processing.</li>
        <li><code>Queries</code>: every query saved or run in Queries.</li>
        <li><code>Searches</code>: monitors shared under Team searches. <code>Config</code>: settings you can edit by hand.</li>
        <li><code>pipeline_status</code>: written by GitHub (step 3); it tells Explore where the explorer is.</li>
      </ul>
    </details>
  </section>

  <section id="setup-github">
    <h2><span class="num">3</span> Explore and automatic processing <span class="who">optional, once per project</span></h2>
    <p>
      A GitHub repository reads the sheet every 30 minutes, extracts people, organisations, places and how they relate,
      and publishes the explorer you see under Explore. Without it, saving, archiving and queries all still work.
    </p>
    <ol>
      <li>Sign in to GitHub and make your own copy of <a href={REPO} target="_blank" rel="noreferrer">the Pipeline repository</a> with <b>Fork</b>. Use one copy per project.</li>
      <li>
        In your copy: <b>Settings → Secrets and variables → Actions → New repository secret</b>. Add two:
        <ul>
          <li><button class="chip" on:click={() => copy('code', 'PIPELINE_TEAM_CODE')}>{copied === 'code' ? 'Copied ✓' : 'PIPELINE_TEAM_CODE'}</button> — the project's join code from step 2.</li>
          <li><button class="chip" on:click={() => copy('key', 'ANTHROPIC_API_KEY')}>{copied === 'key' ? 'Copied ✓' : 'ANTHROPIC_API_KEY'}</button> — a key from console.anthropic.com. Extraction is billed to that account.</li>
        </ul>
      </li>
      <li><b>Settings → Pages → Source: GitHub Actions</b>.</li>
      <li>Open the <b>Actions</b> tab. On a fork GitHub asks you to enable workflows: confirm, then select <b>pipeline</b> and, if it shows “This workflow is disabled”, press <b>Enable workflow</b>.</li>
      <li>Press <b>Run workflow</b> once. After it finishes (a first run can take a while, and results arrive one or two runs later), Explore shows the explorer and the time of the last run.</li>
    </ol>
    <details>
      <summary>Start a run right after each save</summary>
      <ol>
        <li>GitHub: <b>Settings (your profile) → Developer settings → Fine-grained tokens → Generate new token</b>. Limit it to your copy of the repository, with <b>Contents: Read and write</b>.</li>
        <li>In the sheet: <b>Pipeline → Connect GitHub</b>. Enter the repository as <code>owner/name</code>, then the token.</li>
      </ol>
      <p>The sheet then nudges GitHub after a save, at most once every 5 minutes.</p>
    </details>
    <p class="warn">
      The Explore page is a public web page: anyone with its address can read the extracted names and the titles and
      links of saved items. GitHub also pauses scheduled runs in a repository with no activity for 60 days;
      re-enable the workflow in the Actions tab if that happens.
    </p>
  </section>

  <section id="setup-use">
    <h2><span class="num">4</span> Daily use</h2>
    <ul>
      <li><b>Save</b>: buttons appear on Google results, X, YouTube and Facebook; anywhere else, right-click the page, a link, an image or a PDF and choose Pipeline. Saves go to the active project.</li>
      <li><b>Archive</b>: the first time, press “Allow access to all sites”. Evidence files stay on your computer, in <code>Downloads/Pipeline</code> or a folder you choose there; the sheet gets only the hashes.</li>
      <li><b>Queries</b>: build and run Google searches; each one is kept in your local ledger and added to the sheet.</li>
      <li><b>Monitor</b>: optional, private to this browser. “+ New monitor” watches news and social sources for you; share a monitor with the team from its settings.</li>
      <li><b>Several projects</b>: join each with its own join code and switch with the menu at the top of the sidebar.</li>
      <li><b>Something not arriving?</b> A red badge on the toolbar icon means saves are waiting; open <button class="link" on:click={() => currentView.set('team')}>Join or manage projects</button> and press Retry.</li>
    </ul>
  </section>
</div>

<style>
  .lead { color: var(--ink-2); font-size: 0.95rem; max-width: 46rem; }
  .toc { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0 0.5rem; }
  .toc a { background: var(--accent-soft); border: 1px solid var(--accent-light); border-radius: 999px; color: var(--accent-strong); font-size: 0.78rem; font-weight: 600; padding: 0.25rem 0.75rem; text-decoration: none; }
  .toc a:hover { background: var(--accent-light); }
  section { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); margin-top: 1rem; padding: 0.25rem 1.5rem 1.1rem; scroll-margin-top: 1rem; }
  h2 { align-items: center; display: flex; flex-wrap: wrap; gap: 0.6rem; }
  .num { background: var(--pipe-deep); border-bottom: 3px solid var(--pipe-ink); border-radius: 6px; color: #fff; display: inline-grid; font: 800 0.9rem var(--display); height: 1.7rem; place-items: center; width: 1.7rem; }
  .who { color: var(--text-muted); font: 500 0.68rem var(--mono); letter-spacing: 0.05em; text-transform: uppercase; }
  p, li { font-size: 0.88rem; line-height: 1.6; }
  p { margin: 0.4rem 0; max-width: 46rem; }
  ol, ul { margin: 0.4rem 0; max-width: 46rem; padding-left: 1.3rem; }
  li { margin: 0.35rem 0; }
  li .primary { margin-left: 0.4rem; }
  .state { color: var(--accent-strong); font-weight: 600; }
  details { border-top: 1px solid var(--line); margin-top: 0.75rem; padding-top: 0.6rem; }
  summary { cursor: pointer; font-size: 0.85rem; font-weight: 600; }
  code { background: var(--paper-2); border-radius: 4px; font-size: 0.8rem; padding: 0.05rem 0.3rem; }
  .setup :global(button.link) { font-size: inherit; color: var(--accent); font-weight: 600; }
  .setup .chip { font: 500 0.76rem var(--mono); padding: 0.15rem 0.5rem; }
</style>
