<script>
  import { guideOpen } from '../stores/app.js'

  const tabs = ['Overview', 'Event Codes', 'Actors & Countries', 'Query Tips']
  let activeTab = 0

  function close() { guideOpen.set(false) }

  function handleKeydown(e) {
    if (!$guideOpen) return
    if (e.key === 'Escape') { e.preventDefault(); close() }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if $guideOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="guide-backdrop" on:click={close}></div>

  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="guide-modal" role="dialog" aria-modal="true" aria-label="GDELT Reference Guide" tabindex="-1" on:click|stopPropagation>

    <!-- Header -->
    <div class="guide-header">
      <div>
        <h1 class="guide-title">GDELT Reference Guide</h1>
        <p class="guide-subtitle">How to read GDELT data and build effective watchlist queries</p>
      </div>
      <button class="guide-close" on:click={close} aria-label="Close guide">✕</button>
    </div>

    <!-- Tabs -->
    <div class="guide-tabs">
      {#each tabs as tab, i}
        <button
          class="guide-tab"
          class:active={activeTab === i}
          on:click={() => activeTab = i}
        >{tab}</button>
      {/each}
    </div>

    <!-- Tab content -->
    <div class="guide-body">

      <!-- ── Tab 0: Overview ────────────────────────────────────────────────── -->
      {#if activeTab === 0}
        <section class="g-section">
          <h2>What is GDELT?</h2>
          <p>
            GDELT (Global Database of Events, Language and Tone) monitors the world's broadcast,
            print, and online news in over 100 languages, 24 hours a day. Every 15 minutes it
            processes new articles and extracts two kinds of data — <strong>Events</strong> and
            <strong>GKG records</strong> (Global Knowledge Graph) — that Canary uses to populate your inbox.
          </p>
        </section>

        <div class="g-two-col">
          <div class="g-card g-card--blue">
            <div class="g-card-icon">⚡</div>
            <h3>Events lane</h3>
            <p>
              Structured records coded with the CAMEO framework. Each event captures
              <em>who</em> did <em>what</em> to <em>whom</em>, <em>where</em>, and <em>when</em>.
              Best for tracking concrete political and social actions — protests, arrests,
              negotiations, attacks.
            </p>
            <ul>
              <li>Updated every 15 minutes</li>
              <li>60+ fields per event (actors, codes, geo, tone)</li>
              <li>Covers English &amp; translated sources</li>
              <li>Filtered by: event code, actor type, country</li>
            </ul>
          </div>
          <div class="g-card g-card--purple">
            <div class="g-card-icon">🌐</div>
            <h3>GKG lane</h3>
            <p>
              Article-level monitoring via GDELT's Global Knowledge Graph. Each GKG record
              links a news article to extracted themes, locations, and tone — without
              requiring a specific actor-action structure.
            </p>
            <ul>
              <li>Updated every 15 minutes</li>
              <li>Matched by: GKG theme tags (e.g., IMMIGRATION, HUMAN_RIGHTS)</li>
              <li>Location-filtered via FIPS codes in V1LOCATIONS</li>
              <li>Complements Events — use both lanes for full coverage</li>
            </ul>
          </div>
        </div>

        <section class="g-section">
          <h2>The 15-minute cycle</h2>
          <p>
            GDELT publishes a new data file every 15 minutes. Canary fetches those files,
            filters them against your watchlist rules, and adds matching items to your inbox.
            A typical project sees anywhere from a handful to hundreds of items per collection
            run, depending on how specific the rules are and how active the topic is in the news.
          </p>
          <div class="g-tip">
            <strong>Tip:</strong> Start with broad rules (country only, or a high-level event
            code) and tighten them once you see what volume you get. It is easier to narrow
            than to realise you missed everything.
          </div>
        </section>

        <section class="g-section">
          <h2>The Goldstein scale</h2>
          <p>
            Every CAMEO event carries a <strong>Goldstein score</strong> from −10 to +10 that
            captures whether the event is conflictual or cooperative:
          </p>
          <div class="g-scale">
            <div class="g-scale-bar">
              <div class="g-scale-neg">−10 · Fight, mass violence</div>
              <div class="g-scale-mid">0 · Neutral</div>
              <div class="g-scale-pos">+10 · Peace deal, formal cooperation</div>
            </div>
            <div class="g-scale-examples">
              <span class="gbadge gbadge--red">−8.8  Use of chemical weapons</span>
              <span class="gbadge gbadge--orange">−5  Impose sanctions</span>
              <span class="gbadge gbadge--yellow">−2  Verbal attack / criticism</span>
              <span class="gbadge gbadge--green">+3  Express intent to cooperate</span>
              <span class="gbadge gbadge--teal">+7  Ease sanctions</span>
            </div>
          </div>
          <p>
            Canary shows the Goldstein score on each event card. A string of highly negative
            scores in your inbox is a signal that a situation is escalating.
          </p>
        </section>

      <!-- ── Tab 1: Event Codes ──────────────────────────────────────────────── -->
      {:else if activeTab === 1}
        <section class="g-section">
          <h2>CAMEO event codes</h2>
          <p>
            CAMEO (Conflict and Mediation Event Observations) is the coding framework GDELT uses.
            Every event gets a <strong>3-digit code</strong> that describes the action.
            Codes are organised into 20 top-level categories. Subcodes add more specificity —
            for example, code <code>14</code> is "Protest", <code>141</code> is "Demonstrate",
            and <code>1411</code> is "Demonstrate for rights".
          </p>
          <div class="g-tip">
            <strong>In your watchlist:</strong> entering code <code>14</code> captures all
            protest sub-types. Entering <code>1411</code> narrows to that exact action.
            When in doubt, start with the 2-digit root.
          </div>
        </section>

        <section class="g-section">
          <h2>The 20 root categories</h2>
          <div class="g-code-table">
            {#each [
              { code:'01', label:'Make public statement',      gold:'+1',   tip:'Press conferences, speeches, communiqués' },
              { code:'02', label:'Appeal',                     gold:'+3',   tip:'Requests for help, calls for action, demands for information' },
              { code:'03', label:'Express intent to cooperate',gold:'+4',   tip:'Pledges, promises, announced intentions' },
              { code:'04', label:'Consult',                    gold:'+3',   tip:'Meetings, visits, negotiations between parties' },
              { code:'05', label:'Diplomatic cooperation',     gold:'+5',   tip:'Treaties, formal agreements, recognise government' },
              { code:'06', label:'Material cooperation',       gold:'+6',   tip:'Aid delivery, troop deployment for peace, share resources' },
              { code:'07', label:'Provide aid',                gold:'+6',   tip:'Humanitarian relief, food, medical assistance' },
              { code:'08', label:'Yield / concede',            gold:'+4',   tip:'Retreat, ceasefires, release prisoners' },
              { code:'09', label:'Investigate',                gold:'−2',   tip:'Inquiry, fact-finding, inspect, monitor' },
              { code:'10', label:'Demand',                     gold:'−3',   tip:'Ultimatums, orders, insist, pressure to act' },
              { code:'11', label:'Disapprove',                 gold:'−3',   tip:'Criticise, blame, condemn, accuse' },
              { code:'12', label:'Reject',                     gold:'−4',   tip:'Refuse, oppose, obstruct' },
              { code:'13', label:'Threaten',                   gold:'−5',   tip:'Warn of consequences, mobilise, give ultimatum' },
              { code:'14', label:'Protest',                    gold:'−6',   tip:'Demonstrations, strikes, boycotts, hunger strikes' },
              { code:'15', label:'Exhibit force posture',      gold:'−5',   tip:'Military exercises, show of arms, alert troops' },
              { code:'16', label:'Reduce relations',           gold:'−6',   tip:'Expel ambassador, cut off trade, impose sanctions' },
              { code:'17', label:'Coerce',                     gold:'−7',   tip:'Impose blockade, arrest, seize assets' },
              { code:'18', label:'Assault',                    gold:'−8',   tip:'Attack people physically, torture, abduct' },
              { code:'19', label:'Fight',                      gold:'−9',   tip:'Armed engagement, air strikes, artillery' },
              { code:'20', label:'Mass violence',              gold:'−10',  tip:'Genocide, use of chemical/biological weapons' },
            ] as row}
              <div class="g-code-row">
                <span class="g-code-num">{row.code}</span>
                <div class="g-code-info">
                  <span class="g-code-label">{row.label}</span>
                  <span class="g-code-tip">{row.tip}</span>
                </div>
                <span class="g-code-gold" class:neg={row.gold.startsWith('-')} class:pos={row.gold.startsWith('+')}>{row.gold}</span>
              </div>
            {/each}
          </div>
        </section>

        <section class="g-section">
          <h2>Useful code ranges by topic</h2>
          <div class="g-topic-grid">
            <div class="g-topic">
              <h4>⚠ Conflict &amp; violence</h4>
              <div class="g-tags">
                <span class="gtag">13</span><span class="gtag">14</span>
                <span class="gtag">15</span><span class="gtag">16</span>
                <span class="gtag">17</span><span class="gtag">18</span>
                <span class="gtag">19</span><span class="gtag">20</span>
              </div>
            </div>
            <div class="g-topic">
              <h4>🤝 Diplomacy &amp; talks</h4>
              <div class="g-tags">
                <span class="gtag">03</span><span class="gtag">04</span>
                <span class="gtag">05</span><span class="gtag">08</span>
              </div>
            </div>
            <div class="g-topic">
              <h4>📢 Advocacy &amp; pressure</h4>
              <div class="g-tags">
                <span class="gtag">01</span><span class="gtag">02</span>
                <span class="gtag">10</span><span class="gtag">11</span>
                <span class="gtag">12</span><span class="gtag">14</span>
              </div>
            </div>
            <div class="g-topic">
              <h4>🏛 Human rights monitoring</h4>
              <div class="g-tags">
                <span class="gtag">09</span><span class="gtag">11</span>
                <span class="gtag">13</span><span class="gtag">17</span>
                <span class="gtag">18</span>
              </div>
            </div>
            <div class="g-topic">
              <h4>🚶 Displacement &amp; migration</h4>
              <div class="g-tags">
                <span class="gtag">02</span><span class="gtag">07</span>
                <span class="gtag">08</span><span class="gtag">17</span>
              </div>
            </div>
            <div class="g-topic">
              <h4>💰 Sanctions &amp; pressure</h4>
              <div class="g-tags">
                <span class="gtag">10</span><span class="gtag">12</span>
                <span class="gtag">13</span><span class="gtag">16</span>
              </div>
            </div>
          </div>
        </section>

      <!-- ── Tab 2: Actors & Countries ─────────────────────────────────────── -->
      {:else if activeTab === 2}
        <section class="g-section">
          <h2>How actors work</h2>
          <p>
            Every GDELT event has two actor slots: <strong>Actor 1</strong> (who initiated the
            action) and <strong>Actor 2</strong> (who it was directed at). Each actor is
            described by up to three parts: a <strong>country code</strong>, a
            <strong>known-group code</strong>, and up to three <strong>type codes</strong>.
          </p>
          <div class="g-example-box">
            <div class="g-actor-example">
              <span class="g-actor-label">Actor 1</span>
              <span class="gbadge gbadge--blue">USA</span>
              <span class="gbadge gbadge--purple">GOV</span>
              <span class="g-arrow">→ action (code 17: Coerce) →</span>
              <span class="g-actor-label">Actor 2</span>
              <span class="gbadge gbadge--blue">VEN</span>
              <span class="gbadge gbadge--purple">GOV</span>
            </div>
            <p class="g-example-caption">
              Example: "US government imposes sanctions on Venezuelan government"
            </p>
          </div>
          <p>
            In your watchlist rules you can filter by actor type — for example, specifying
            <code>REF</code> will only match events where a refugee group is one of the actors.
          </p>
        </section>

        <section class="g-section">
          <h2>Actor type codes</h2>
          <div class="g-two-col-codes">
            {#each [
              { code:'GOV', label:'Government / state authority' },
              { code:'MIL', label:'Military or armed forces' },
              { code:'REB', label:'Rebel / opposition armed group' },
              { code:'OPP', label:'Political opposition' },
              { code:'PTY', label:'Political party' },
              { code:'CVL', label:'Civilian population' },
              { code:'REF', label:'Refugee or displaced person' },
              { code:'MED', label:'News media' },
              { code:'IGO', label:'Intergovernmental org (UN, AU…)' },
              { code:'NGO', label:'Non-governmental organisation' },
              { code:'BUS', label:'Business / corporation' },
              { code:'CRM', label:'Criminal / organised crime' },
              { code:'ETH', label:'Ethnic or cultural group' },
              { code:'REL', label:'Religious group or institution' },
              { code:'SPY', label:'Intelligence / secret service' },
              { code:'LEG', label:'Legislature / parliament' },
              { code:'JUD', label:'Judiciary / courts' },
              { code:'HLT', label:'Health sector / medical' },
              { code:'EDU', label:'Education sector' },
              { code:'INT', label:'International / multinational' },
            ] as a}
              <div class="g-actor-row">
                <code class="g-acode">{a.code}</code>
                <span>{a.label}</span>
              </div>
            {/each}
          </div>
        </section>

        <section class="g-section">
          <h2>Country codes</h2>
          <p>
            GDELT uses <strong>CAMEO 3-letter country codes</strong>, which are different from
            the ISO 2-letter codes you might know (e.g. "US" → <code>USA</code>,
            "CN" → <code>CHN</code>). The country code in a watchlist rule is matched against
            the <em>action geography</em> (where the event happened) and/or the actor country.
          </p>
          <div class="g-tip">
            <strong>In Canary:</strong> the Countries filter accepts comma-separated ISO 2-letter
            codes (e.g. <code>VE,CO,EC</code>) — Canary converts them automatically. In the
            Query Builder, use the country picker which handles the conversion for you.
          </div>
          <h3 class="g-sub">Quick reference — frequently monitored regions</h3>
          <div class="g-country-grid">
            {#each [
              { iso:'US', cameo:'USA', name:'United States' },
              { iso:'RU', cameo:'RUS', name:'Russia' },
              { iso:'CN', cameo:'CHN', name:'China' },
              { iso:'UA', cameo:'UKR', name:'Ukraine' },
              { iso:'SY', cameo:'SYR', name:'Syria' },
              { iso:'IQ', cameo:'IRQ', name:'Iraq' },
              { iso:'AF', cameo:'AFG', name:'Afghanistan' },
              { iso:'VE', cameo:'VEN', name:'Venezuela' },
              { iso:'CO', cameo:'COL', name:'Colombia' },
              { iso:'MX', cameo:'MEX', name:'Mexico' },
              { iso:'ET', cameo:'ETH', name:'Ethiopia' },
              { iso:'SD', cameo:'SDN', name:'Sudan' },
              { iso:'SS', cameo:'SSD', name:'South Sudan' },
              { iso:'SO', cameo:'SOM', name:'Somalia' },
              { iso:'MM', cameo:'MMR', name:'Myanmar' },
              { iso:'YE', cameo:'YEM', name:'Yemen' },
              { iso:'NG', cameo:'NGA', name:'Nigeria' },
              { iso:'CD', cameo:'COD', name:'DR Congo' },
              { iso:'LY', cameo:'LBA', name:'Libya' },
              { iso:'HT', cameo:'HTI', name:'Haiti' },
            ] as c}
              <div class="g-country-row">
                <span class="g-country-iso">{c.iso}</span>
                <span class="g-country-cameo">{c.cameo}</span>
                <span class="g-country-name">{c.name}</span>
              </div>
            {/each}
          </div>
        </section>

      <!-- ── Tab 3: Query Tips ──────────────────────────────────────────────── -->
      {:else if activeTab === 3}
        <section class="g-section">
          <h2>Events vs GKG — when to use each</h2>
          <div class="g-two-col">
            <div class="g-card g-card--blue">
              <h3>Use Events when you want…</h3>
              <ul>
                <li>Specific actions: arrests, protests, attacks, negotiations</li>
                <li>Country-level filtering (ActionGeo matches where events happen)</li>
                <li>Actor-type precision (e.g., only events involving <code>REF</code> actors)</li>
                <li>Volume and frequency tracking over time (Timeline view)</li>
                <li>Goldstein trend monitoring (escalation / de-escalation)</li>
              </ul>
            </div>
            <div class="g-card g-card--purple">
              <h3>Use GKG when you want…</h3>
              <ul>
                <li>Thematic coverage: articles tagged <code>MIGRATION</code>, <code>HUMAN_RIGHTS</code>, <code>REFUGEES</code></li>
                <li>Stories that don't fit a neat actor-action structure</li>
                <li>Broad, editorial-style monitoring by topic rather than event type</li>
                <li>Volume tracking across all articles touching a theme</li>
                <li>Cross-country patterns using the <em>Also mentions</em> filter</li>
              </ul>
            </div>
          </div>
        </section>

        <section class="g-section">
          <h2>Building your first rule — step by step</h2>

          <div class="g-steps">
            <div class="g-step">
              <div class="g-step-num">1</div>
              <div class="g-step-body">
                <h4>Pick your lane</h4>
                <p>Start with <strong>Events</strong> if you want structured action data.
                Add a second <strong>GKG</strong> rule for thematic article coverage. Enabling both
                gives the most complete picture.</p>
              </div>
            </div>
            <div class="g-step">
              <div class="g-step-num">2</div>
              <div class="g-step-body">
                <h4>Choose a country (optional but powerful)</h4>
                <p>Narrowing by country cuts volume dramatically. Use the country picker in
                the Query Builder — it handles ISO→CAMEO conversion for you. Leave blank to
                monitor globally.</p>
              </div>
            </div>
            <div class="g-step">
              <div class="g-step-num">3</div>
              <div class="g-step-body">
                <h4>Add event codes (Events lane)</h4>
                <p>Pick 2–4 root codes that match your topic. Use the <em>Event Codes</em>
                tab above as a reference. A good starting set for human rights work:
                <code>09</code> <code>11</code> <code>13</code> <code>17</code> <code>18</code>.</p>
              </div>
            </div>
            <div class="g-step">
              <div class="g-step-num">4</div>
              <div class="g-step-body">
                <h4>Add actor types (optional)</h4>
                <p>If you only care about events involving refugees, add <code>REF</code>.
                If you want government-on-civilian events, add <code>GOV</code> as Actor 1
                and <code>CVL</code> as Actor 2. Leave blank to match any actor.</p>
              </div>
            </div>
            <div class="g-step">
              <div class="g-step-num">5</div>
              <div class="g-step-body">
                <h4>Add GKG themes (GKG lane)</h4>
                <p>Pick theme tags that match your topic. GKG themes are uppercase codes —
                for example <code>IMMIGRATION</code>, <code>HUMAN_RIGHTS</code>,
                <code>REFUGEES</code>. You can also require additional countries to appear
                in the article's location data via the <em>Also mentions</em> field.</p>
              </div>
            </div>
            <div class="g-step">
              <div class="g-step-num">6</div>
              <div class="g-step-body">
                <h4>Wait one collection cycle, then calibrate</h4>
                <p>After 15 minutes check your inbox. Too much noise? Add more actor-type
                constraints or narrow the code range. Too little? Broaden codes or add
                synonymous keywords. It usually takes 2–3 adjustments to land on the right
                volume.</p>
              </div>
            </div>
          </div>
        </section>

        <section class="g-section">
          <h2>Common patterns</h2>
          <div class="g-patterns">
            <div class="g-pattern">
              <h4>Immigration enforcement monitoring</h4>
              <div class="g-pattern-rules">
                <div class="g-rule"><span class="g-rule-lane events">Events</span>Codes <code>17</code> <code>18</code> · Actor2 <code>REF</code> · Country: target</div>
                <div class="g-rule"><span class="g-rule-lane gkg">GKG</span>Themes: <code>IMMIGRATION</code> <code>HUMAN_RIGHTS</code> <code>REFUGEES</code></div>
              </div>
            </div>
            <div class="g-pattern">
              <h4>Conflict escalation watch</h4>
              <div class="g-pattern-rules">
                <div class="g-rule"><span class="g-rule-lane events">Events</span>Codes <code>15</code> <code>18</code> <code>19</code> <code>20</code> · Country: target</div>
                <div class="g-rule"><span class="g-rule-lane gkg">GKG</span>Themes: <code>MILITARY_FORCE</code> <code>ARMED_CONFLICT</code></div>
              </div>
            </div>
            <div class="g-pattern">
              <h4>Diplomatic process tracking</h4>
              <div class="g-pattern-rules">
                <div class="g-rule"><span class="g-rule-lane events">Events</span>Codes <code>03</code> <code>04</code> <code>05</code> <code>08</code> · Countries: both parties</div>
                <div class="g-rule"><span class="g-rule-lane gkg">GKG</span>Themes: <code>PEACE</code> <code>DIPLOMACY</code> <code>NEGOTIATIONS</code></div>
              </div>
            </div>
            <div class="g-pattern">
              <h4>Civil society &amp; protest</h4>
              <div class="g-pattern-rules">
                <div class="g-rule"><span class="g-rule-lane events">Events</span>Codes <code>11</code> <code>14</code> · Actor1 <code>CVL</code> or <code>OPP</code></div>
                <div class="g-rule"><span class="g-rule-lane gkg">GKG</span>Themes: <code>PROTEST</code> <code>CIVIL_UNREST</code> <code>DEMONSTRATION</code></div>
              </div>
            </div>
          </div>
        </section>

        <section class="g-section">
          <h2>Gotchas to avoid</h2>
          <ul class="g-gotchas">
            <li>
              <strong>GDELT codes events from a reporter's perspective,</strong> not ground truth.
              A government calling protests "riots" and an NGO calling them "demonstrations" may
              produce different codes. Cross-check with GKG themes for fuller coverage.
            </li>
            <li>
              <strong>Geo-coding follows the article,</strong> not necessarily the event location.
              An article published in the US about events in Venezuela is coded to Venezuela, but
              edge cases exist. Filter noise by checking source domains in your inbox.
            </li>
            <li>
              <strong>High-volume codes (01, 02, 04)</strong> are statements and consultations —
              diplomatic chatter. They produce a lot of events. Add actor-type or country
              constraints before enabling them on a global query.
            </li>
            <li>
              <strong>The translation stream</strong> adds significant volume. If your inbox is
              overwhelming, use the Source filter (Events / GKG) or the multilingual indicator
              in the Inbox header to assess whether translated sources are adding signal or noise.
            </li>
          </ul>
        </section>
      {/if}

    </div><!-- /guide-body -->
  </div><!-- /guide-modal -->
{/if}

<style>
  /* ── Backdrop ──────────────────────────────────────────────────────────────── */
  .guide-backdrop {
    background: rgba(0,0,0,0.5);
    inset: 0;
    position: fixed;
    z-index: 10000;
  }

  /* ── Modal shell ───────────────────────────────────────────────────────────── */
  .guide-modal {
    background: #f8fafc;
    border-radius: 12px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.35);
    color: #1e293b;
    display: flex;
    flex-direction: column;
    height: 82vh;
    left: 50%;
    max-width: 780px;
    overflow: hidden;
    position: fixed;
    top: 50%;
    transform: translate(-50%, -50%);
    width: calc(100vw - 3rem);
    z-index: 10001;
    animation: guide-in 0.2s ease;
  }
  @keyframes guide-in {
    from { opacity: 0; transform: translate(-50%, calc(-50% + 12px)); }
    to   { opacity: 1; transform: translate(-50%, -50%); }
  }

  /* ── Header ────────────────────────────────────────────────────────────────── */
  .guide-header {
    align-items: flex-start;
    background: #0f172a;
    color: #e2e8f0;
    display: flex;
    flex-shrink: 0;
    gap: 1rem;
    justify-content: space-between;
    padding: 1.25rem 1.5rem 1rem;
  }
  .guide-title {
    color: #f1f5f9;
    font-size: 1.1rem;
    font-weight: 700;
    margin: 0;
  }
  .guide-subtitle {
    color: #64748b;
    font-size: 0.78rem;
    margin: 0.2rem 0 0;
  }
  .guide-close {
    background: rgba(255,255,255,0.08);
    border: none;
    border-radius: 6px;
    color: #94a3b8;
    cursor: pointer;
    flex-shrink: 0;
    font-size: 0.9rem;
    line-height: 1;
    padding: 0.35rem 0.55rem;
    transition: background 0.12s;
  }
  .guide-close:hover { background: rgba(255,255,255,0.16); color: #e2e8f0; }

  /* ── Tabs ──────────────────────────────────────────────────────────────────── */
  .guide-tabs {
    background: #1e293b;
    border-bottom: 1px solid #334155;
    display: flex;
    flex-shrink: 0;
    gap: 0;
    padding: 0 1.5rem;
  }
  .guide-tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.7rem 1rem;
    transition: color 0.12s, border-color 0.12s;
  }
  .guide-tab:hover { color: #94a3b8; }
  .guide-tab.active { border-bottom-color: #3b82f6; color: #93c5fd; }

  /* ── Scrollable body ───────────────────────────────────────────────────────── */
  .guide-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem;
  }

  /* ── Shared section styles ─────────────────────────────────────────────────── */
  .g-section { margin-bottom: 2rem; }
  .g-section h2 {
    border-bottom: 1px solid #e2e8f0;
    color: #0f172a;
    font-size: 0.95rem;
    font-weight: 700;
    margin: 0 0 0.75rem;
    padding-bottom: 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .g-sub {
    color: #475569;
    font-size: 0.8rem;
    font-weight: 600;
    margin: 1.25rem 0 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .g-section p, .g-section li {
    color: #334155;
    font-size: 0.83rem;
    line-height: 1.65;
  }
  .g-section ul {
    margin: 0.5rem 0;
    padding-left: 1.2rem;
  }
  .g-section li { margin-bottom: 0.25rem; }
  .g-section code {
    background: #e2e8f0;
    border-radius: 3px;
    font-size: 0.78rem;
    padding: 0.1rem 0.35rem;
    color: #0f172a;
  }

  /* ── Two-column cards ──────────────────────────────────────────────────────── */
  .g-two-col {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: 1fr 1fr;
    margin-bottom: 1.5rem;
  }
  .g-card {
    border-radius: 8px;
    font-size: 0.8rem;
    line-height: 1.6;
    padding: 1rem 1.1rem;
  }
  .g-card h3 {
    font-size: 0.85rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
  }
  .g-card p { margin: 0 0 0.5rem; color: inherit; font-size: 0.8rem; }
  .g-card ul { margin: 0; padding-left: 1.1rem; color: inherit; }
  .g-card li { margin-bottom: 0.2rem; font-size: 0.78rem; }
  .g-card-icon { font-size: 1.4rem; margin-bottom: 0.4rem; }
  .g-card--blue  { background: #dbeafe; border: 1px solid #93c5fd; color: #1e3a5f; }
  .g-card--blue h3 { color: #1e40af; }
  .g-card--purple { background: #ede9fe; border: 1px solid #c4b5fd; color: #3b1f6e; }
  .g-card--purple h3 { color: #6d28d9; }

  /* ── Tip box ───────────────────────────────────────────────────────────────── */
  .g-tip {
    background: #fef9c3;
    border: 1px solid #fde047;
    border-radius: 6px;
    color: #713f12;
    font-size: 0.8rem;
    line-height: 1.55;
    margin: 0.75rem 0;
    padding: 0.65rem 0.9rem;
  }
  .g-tip strong { color: #92400e; }

  /* ── Goldstein scale ───────────────────────────────────────────────────────── */
  .g-scale { margin: 0.75rem 0 1rem; }
  .g-scale-bar {
    border-radius: 6px;
    display: flex;
    font-size: 0.7rem;
    font-weight: 500;
    overflow: hidden;
    margin-bottom: 0.6rem;
  }
  .g-scale-neg { background: #ef4444; color: #fff; flex: 1; padding: 0.4rem 0.6rem; }
  .g-scale-mid { background: #94a3b8; color: #fff; padding: 0.4rem 0.6rem; text-align: center; }
  .g-scale-pos { background: #22c55e; color: #fff; flex: 1; padding: 0.4rem 0.6rem; text-align: right; }
  .g-scale-examples { display: flex; flex-wrap: wrap; gap: 0.4rem; }

  /* ── Generic badges ────────────────────────────────────────────────────────── */
  .gbadge {
    border-radius: 4px;
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.2rem 0.5rem;
  }
  .gbadge--red    { background: #fecaca; color: #991b1b; }
  .gbadge--orange { background: #fed7aa; color: #9a3412; }
  .gbadge--yellow { background: #fef08a; color: #713f12; }
  .gbadge--green  { background: #bbf7d0; color: #166534; }
  .gbadge--teal   { background: #99f6e4; color: #134e4a; }
  .gbadge--blue   { background: #bfdbfe; color: #1e3a5f; }
  .gbadge--purple { background: #ddd6fe; color: #3b1f6e; }

  /* ── Code table ────────────────────────────────────────────────────────────── */
  .g-code-table {
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    overflow: hidden;
  }
  .g-code-row {
    align-items: center;
    border-bottom: 1px solid #f1f5f9;
    display: flex;
    gap: 0.75rem;
    padding: 0.45rem 0.75rem;
  }
  .g-code-row:last-child { border-bottom: none; }
  .g-code-row:hover { background: #f8fafc; }
  .g-code-num {
    background: #1e293b;
    border-radius: 4px;
    color: #93c5fd;
    font-family: monospace;
    font-size: 0.78rem;
    font-weight: 700;
    min-width: 28px;
    padding: 0.15rem 0.4rem;
    text-align: center;
  }
  .g-code-info { display: flex; flex: 1; flex-direction: column; min-width: 0; }
  .g-code-label { color: #0f172a; font-size: 0.8rem; font-weight: 600; }
  .g-code-tip { color: #64748b; font-size: 0.72rem; }
  .g-code-gold {
    font-family: monospace;
    font-size: 0.78rem;
    font-weight: 700;
    min-width: 34px;
    text-align: right;
  }
  .g-code-gold.neg { color: #dc2626; }
  .g-code-gold.pos { color: #16a34a; }

  /* ── Topic grid ────────────────────────────────────────────────────────────── */
  .g-topic-grid {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: 1fr 1fr;
  }
  .g-topic {
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 7px;
    padding: 0.7rem 0.9rem;
  }
  .g-topic h4 { color: #0f172a; font-size: 0.78rem; font-weight: 700; margin: 0 0 0.4rem; }
  .g-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .gtag {
    background: #1e293b;
    border-radius: 4px;
    color: #93c5fd;
    font-family: monospace;
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.15rem 0.4rem;
  }

  /* ── Actor two-column codes ────────────────────────────────────────────────── */
  .g-two-col-codes {
    columns: 2;
    gap: 1rem;
  }
  .g-actor-row {
    align-items: center;
    break-inside: avoid;
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.3rem;
    font-size: 0.8rem;
    color: #334155;
  }
  .g-acode {
    background: #1e293b;
    border-radius: 4px;
    color: #a78bfa;
    font-size: 0.73rem;
    font-weight: 700;
    min-width: 42px;
    padding: 0.15rem 0.4rem;
    text-align: center;
  }

  /* ── Actor example ─────────────────────────────────────────────────────────── */
  .g-example-box {
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    margin: 0.75rem 0;
    padding: 0.9rem 1.1rem;
  }
  .g-actor-example {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }
  .g-actor-label { color: #64748b; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; }
  .g-arrow { color: #94a3b8; font-size: 0.75rem; font-style: italic; }
  .g-example-caption { color: #475569; font-size: 0.75rem; font-style: italic; margin: 0; }

  /* ── Country grid ──────────────────────────────────────────────────────────── */
  .g-country-grid {
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    columns: 2;
    gap: 0;
    overflow: hidden;
  }
  .g-country-row {
    align-items: center;
    border-bottom: 1px solid #f1f5f9;
    break-inside: avoid;
    display: flex;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    font-size: 0.78rem;
  }
  .g-country-row:last-child { border-bottom: none; }
  .g-country-iso  { background: #e0f2fe; border-radius: 3px; color: #0369a1; font-family: monospace; font-size: 0.72rem; font-weight: 700; padding: 0.1rem 0.3rem; min-width: 24px; text-align: center; }
  .g-country-cameo { color: #475569; font-family: monospace; font-size: 0.72rem; min-width: 34px; }
  .g-country-name { color: #334155; }

  /* ── Steps ─────────────────────────────────────────────────────────────────── */
  .g-steps { display: flex; flex-direction: column; gap: 0.6rem; }
  .g-step {
    align-items: flex-start;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    display: flex;
    gap: 0.9rem;
    padding: 0.85rem 1rem;
  }
  .g-step-num {
    align-items: center;
    background: #2563eb;
    border-radius: 50%;
    color: #fff;
    display: flex;
    flex-shrink: 0;
    font-size: 0.78rem;
    font-weight: 700;
    height: 22px;
    justify-content: center;
    width: 22px;
  }
  .g-step-body h4 { color: #0f172a; font-size: 0.83rem; font-weight: 700; margin: 0 0 0.25rem; }
  .g-step-body p  { color: #475569; font-size: 0.78rem; line-height: 1.55; margin: 0; }
  .g-step-body p code { background: #e2e8f0; border-radius: 3px; font-size: 0.74rem; padding: 0.1rem 0.3rem; }

  /* ── Patterns ──────────────────────────────────────────────────────────────── */
  .g-patterns { display: flex; flex-direction: column; gap: 0.75rem; }
  .g-pattern {
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    overflow: hidden;
  }
  .g-pattern h4 {
    background: #f1f5f9;
    color: #0f172a;
    font-size: 0.8rem;
    font-weight: 700;
    margin: 0;
    padding: 0.5rem 0.85rem;
    border-bottom: 1px solid #e2e8f0;
  }
  .g-pattern-rules { display: flex; flex-direction: column; gap: 0; }
  .g-rule {
    align-items: center;
    border-bottom: 1px solid #f1f5f9;
    color: #334155;
    display: flex;
    font-size: 0.78rem;
    gap: 0.6rem;
    padding: 0.4rem 0.85rem;
  }
  .g-rule:last-child { border-bottom: none; }
  .g-rule code { background: #e2e8f0; border-radius: 3px; font-size: 0.73rem; padding: 0.1rem 0.3rem; }
  .g-rule-lane {
    border-radius: 3px;
    font-size: 0.68rem;
    font-weight: 700;
    padding: 0.15rem 0.45rem;
    text-transform: uppercase;
  }
  .g-rule-lane.events { background: #dbeafe; color: #1e40af; }
  .g-rule-lane.gkg    { background: #ede9fe; color: #6d28d9; }

  /* ── Gotchas ───────────────────────────────────────────────────────────────── */
  .g-gotchas {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .g-gotchas li {
    background: #fff7ed;
    border: 1px solid #fed7aa;
    border-left: 3px solid #f97316;
    border-radius: 6px;
    color: #431407;
    font-size: 0.8rem;
    line-height: 1.55;
    padding: 0.6rem 0.9rem;
  }
  .g-gotchas li strong { color: #9a3412; }
</style>
