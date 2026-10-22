# Canary pipeline

Pulls new rows from the Canary sheet, fetches each article, extracts the entity types you choose locally with GLiNER,
optionally asks your own questions with an LLM (local LM Studio or Claude), and pushes everything
to a results Google Sheet.

## Start

```bash
python3 app.py
```

Open http://127.0.0.1:8765. Needs [uv](https://docs.astral.sh/uv/); dependencies install on first run.
The first extraction also downloads the GLiNER model (~1.5 GB, once).

## Set it up for your research

Nothing is tied to one topic. In the panel's **What to extract** box, list the entity types your
research cares about, one per line, in plain words: GLiNER takes them as written, no training.
For example, a land-rights project might use `person, company, community, river, mining concession,
court, law or policy, money amount, date`. Specific types work better than vague ones: with a
catch-all "organization", companies get absorbed into it.

After changing the types, tick **Re-extract every article** and press **Extract entities (GLiNER)**
once. That reprocesses everything from cached text, about an hour for 2,000 articles; normal runs
only process new rows. Then push, and the viewer picks up the new types on its own.

## Connect the results sheet (once)

1. Create a Google Sheet for results → Extensions → Apps Script → paste `apps_script.gs`.
2. Project Settings → Script properties → add `TOKEN` = a long random string.
3. Deploy → New deployment → Web app, Execute as **Me**, access **Anyone** → copy the `/exec` URL.
4. Paste URL and token into the panel. "Push to sheet" fills these tabs:

| Tab | One row per |
|---|---|
| `articles` | article: who saved it, project, tags, language, whether full text was fetched |
| `mentions` | entity found: `label` (company, person, government agency, money amount…), text, `norm` (grouping key), score, surrounding text |
| `answers_<set>` | article × question: answer, supporting quote, `evidence_found` (quote really is in the article) |

## Haiku extraction and the explorer

An alternative to GLiNER that also finds relations (who did what to whom, with amounts and places).
Everything lands in `out/haiku/`, so it can be compared with the GLiNER output. Needs `ANTHROPIC_API_KEY`.

```bash
uv run extract.py --batch            # entities + relations for every article, as one Batch API job (half price)
uv run extract.py --collect          # later, from any session: fetch the finished batch (id kept in out/haiku/batch.json)
python3 normalize.py                 # merge name variants with rules (ICE = Immigration and Customs Enforcement...)
uv run llm_merge.py                  # optional: Haiku groups what rules can't see (translations), Sonnet reviews; see llm_review.csv
python3 normalize.py                 # rebuild canonical.csv with those merges
python3 build_data.py                # write data/data.js for the explorer
```

Every merge is listed in `out/haiku/merges.csv` with the rule that made it. To force or fix one, add a row to
`aliases.csv` (`variant,canonical`); `entities.csv` works the same way and also sets the type.

**Explorer: `index.html`.** Open it by double-clicking (it reads `data/data.js` next to it), at
http://127.0.0.1:8765/explorer while the panel runs, or host the folder anywhere static (GitHub Pages).
It shows how the database grows, the most-mentioned entities of any type, a network connecting up to five
types through the articles that mention them, a world map, and a searchable table. Selecting a name opens its
source sentences first (with the actions it took part in, and a link to the exact sentence in the original article),
then every other entity that appears in the same articles.

## Automatic runs (GitHub Actions)

A workflow (`.github/workflows/pipeline.yml`) runs `run.py` every 30 minutes, on demand (Actions tab, "Run workflow"; tick *force_merge* to run `llm_merge.py` anyway) and when something sends a `saved` repository_dispatch event.

**One-time setup**

1. Settings, Secrets and variables, Actions: add `PIPELINE_TEAM_CODE` (the team join code) and `ANTHROPIC_API_KEY`.
2. Settings, Pages, Source: **GitHub Actions**. Make sure Actions are enabled.
3. Optional, to keep the Haiku work you already did locally instead of re-extracting everything, seed the `data` branch once:

```bash
python3 build_data.py            # so data/data.js exists
d=$(mktemp -d) && mkdir -p $d/out $d/data
cp -r out/haiku out/texts $d/out/ && cp data/data.js $d/data/
# the bridge ids are not known locally: skip out/haiku/processed.txt, the first tick creates it
cd $d && git init -q -b data && git add -A && git commit -qm "pipeline state"
git push -f <your repo url> data
```

Without seeding, the first tick starts from scratch: it submits every saved item as one batch.

**What a tick does**: pull saved items from the bridge, then `extract.py --auto` either submits a Haiku batch for new items, reports `pending`, or collects a finished batch. Only when articles were collected does it run `amounts.py`, `llm_merge.py`, `normalize.py`, `build_data.py`, push the results tabs to the sheet, mark the items "Processed At", and deploy the explorer to Pages. Every tick writes a `pipeline_status` tab (when it ran, what happened, counts, errors).

**State** lives on the orphan `data` branch: one commit, force-pushed after every tick (even a failed one, so a submitted batch id is never lost), holding `out/haiku`, `out/texts` and `data/data.js`. `data/` is gitignored on the main branch because `data.js` is a build artifact.

**Timing and cost**: Batch API jobs take minutes to hours; the tick after they finish collects them, so new items show up in the explorer one or more ticks after they are saved. Batches are half price, and `llm_merge.py` (the expensive step) only runs after new articles arrive, or when forced.

**Caveats**: scheduled workflows can start late (sometimes many minutes at busy hours). In public repos GitHub disables scheduled workflows after 60 days without repository activity; pushes to the `data` branch are pushes, but GitHub's exact definition of activity is not guaranteed, so if the schedule stops, re-enable it in the Actions tab. The Pages explorer is public: it carries entities, relations and article links, never `saved_by` or project names.

## Curating entities: `entities.csv`

GLiNER finds names reliably but labels the same organization inconsistently from article to article
(CoreCivic came out as "armed group" more often than "company"). `entities.csv` fixes that:
one row per entity with its canonical `name`, `type`, and `|`-separated `aliases`. It's applied at
push time, adding `entity` and `type` columns to the `mentions` tab, so editing it only needs a re-push,
never a re-extraction. Group by `entity`/`type` in dashboards, not by the raw `text`/`label`.

## How article text is cleaned

- **Precision mode:** trafilatura runs in its stricter mode, which drops more page furniture.
- **Same-site boilerplate:** any line that recurs in 3+ different articles from the same site
  (newsletter prompts, copyright lines, "related stories" lists) is removed before GLiNER sees the text.
  The count of removed lines is in the `boilerplate_lines` column. A story saved several times from one
  site is left whole, and copies of one story on different sites are never touched.
- **Paywall flag:** an article that is little more than a subscription prompt is marked
  `text_source = paywall`.

The raw text stays cached in `out/texts/`; cleaning happens at extraction time, so it improves as more
articles from each site arrive. Use `--refetch` to download article text again, for example after changing
the extraction settings.

## How runs work

- **Extract** only processes Canary rows not already in `out/articles.csv`. Delete `out/articles.csv` and `out/mentions.csv` to reprocess everything (article text stays cached in `out/texts/`).
- **Ask** only asks questions an article hasn't been asked yet by that model. Add a question and re-run: only the new one is asked.
- **Push** replaces each tab with the current local CSV.

## Files

`pipeline.py` GLiNER extraction · `extract.py` Haiku extraction · `normalize.py` + `llm_merge.py` name merging · `build_data.py` explorer data · `ask.py` LLM questions · `push.py` upload · `app.py` + `ui.html` control panel ·
`apps_script.gs` sheet receiver · `entities.csv` curated names/types · `test_pipeline.py` self-check (`python3 test_pipeline.py`)

All three scripts also run from the command line; see the docstring at the top of each.
