# Research pipeline CI contract (Phase 2)

The repo is `/Users/guillen/Documents/Research pipeline` (entityview), branch `actions-pipeline`. GitHub Actions runs a cron that reads saved items through the team bridge (`bridge/Code.gs` in the Pipeline repo), runs the Haiku extraction path, rebuilds the public explorer, and writes the results back to the sheet.

## Secrets / env

- `PIPELINE_TEAM_CODE`: the join code, `base64url(JSON {url, token})`.
- `ANTHROPIC_API_KEY`.

## CLIs (agent A builds them; agent B's runner calls them)

| command | does | exit |
|---|---|---|
| `uv run bridge.py pull --out out/source.csv` | Pages POST `{token, action:'list', status:'all', include_locked:'true', limit:5000, offset}` and writes a CSV with the legacy columns `l,url,title_or_summary,snippet_or_context,project_id,saved_at,saved_by,source_type,datetime_utc,doc_language,tags`. Field mapping: `l` = `canary_item_id` or `id`; title; snippet; project; `saved_at` or `added_at`; saved_by; source_type; published_at; language; tags joined with `"; "`. Rows without a url are skipped. Prints `pulled N`. | 0, or 1 on error |
| `uv run extract.py --auto --source out/source.csv` | No batch in flight: submit only new ids (`submitted N`) or print `nothing to do`. Batch in flight and not ended: print `pending`. Batch ended: collect it (`collected N`). Writes `out/haiku/last_auto.json` = `{action, count, at}`. | 0, or 1 on a real error |
| `uv run amounts.py` | unchanged (incremental) | |
| `uv run llm_merge.py` | unchanged (expensive; the runner decides when to run it) | |
| `python3 build_data.py` | writes `data/data.js`. **Public output must not contain saved_by or project_id.** | |
| `uv run bridge.py push` | `putTab`: tabs `results_articles` (id, title, url, language, n_entities, n_relations) and `results_relations` (actor, action, target, amount, place, quote, article id, url). Built from out/haiku. Reset on the first chunk, 5000 rows per chunk. | |
| `uv run bridge.py mark-processed` | `updateMany` with `{id, fields:{"Processed At": iso}}` for ids in `out/haiku/articles.csv` that are not yet in `out/haiku/processed.txt`, then appends them there. It maps `l` back to the bridge `id` through `out/source.csv` (columns `l` and `bridge_id`, so pull writes a `bridge_id` column too). | |
| `uv run bridge.py status --file out/run_status.json` | `putTab` `pipeline_status`: two columns, key and value. | |

## State that persists between runs (agent B)

Orphan branch `data`, holding one commit that is amended and force-pushed every run, so history doesn't grow. It contains `out/haiku/**` (except `batch.done` files older than the newest), `out/texts/**` and `out/haiku/processed.txt`. `data/data.js` is no longer tracked on main; it is deployed to Pages as an artifact.
