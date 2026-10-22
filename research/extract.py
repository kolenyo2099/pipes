# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["anthropic", "trafilatura"]
# ///
"""Canary -> Claude Haiku entity extraction (the GLiNER step, via the Batch API).

Same inputs, labels and output columns as pipeline.py, but written to out/haiku/ so the two
can be compared side by side. Haiku returns each distinct entity once per article, and
anything it cites that is not literally in the article text is dropped. It also returns
relations (who did what to whom, amounts, places, with a supporting quote) to out/haiku/relations.csv.

    uv run extract.py --batch [--limit 20]    # submit one batch (half price), saves out/haiku/batch.json; then close the laptop
    uv run extract.py --collect               # later: fetch the finished batch into out/haiku/{articles,mentions}.csv
    uv run extract.py --auto                  # CI: submit new articles, or report pending, or collect the ended batch (one step per run)
"""
import argparse, csv, json, re, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from urllib.request import urlopen

from pipeline import (ARTICLE_COLS, CANARY_CSV, LABELS, MAX_CHARS, MENTION_COLS, PAYWALL, PAYWALL_MAX_CHARS,
                      append, clean, get_text, keep, label, norm, read_ids, site_boilerplate)

HAIKU = "claude-haiku-5-5"
OUT = Path(__file__).parent / "out" / "haiku"
STATE = OUT / "batch.json"
RELATION_KEYS = ["actor", "action", "target", "amount", "place", "quote"]
RELATION_COLS = ["article_id", *RELATION_KEYS, "actor_norm", "target_norm", "quote_found"]

SYSTEM = """You extract named entities from a single news article for an investigative journalism team.
List each distinct entity once, with its type, copying its name exactly as written in the article.
Only named entities: proper names, plus dates and money amounts. Skip generic nouns ("lawyers", "the company").
Use only the types provided; if an entity fits none, omit it. Pick the most specific type that fits.

Also list the relations the article reports: concrete actions where an actor does something, usually to or with a target
(contracts awarded, payments, flights operated, deportations, arrests, detentions, agreements, lawsuits, statements).
For each give actor, action (a short verb phrase), target, amount (money or quantity, as written), place, and quote:
the sentence that supports it, copied word for word. Use an empty string for any part the article does not state.
Actor, target and place must be named as in the article, matching an entity you listed where there is one.
Skip vague or purely descriptive statements; only what is journalistically relevant."""


def params(model, title, text, labels):
    strs = lambda *keys: {"type": "object", "additionalProperties": False, "required": list(keys),
                          "properties": {k: {"type": "string"} for k in keys}}
    schema = {"type": "object", "additionalProperties": False, "required": ["entities", "relations"],
              "properties": {"entities": {"type": "array", "items": {
                  "type": "object", "additionalProperties": False, "required": ["text", "label"],
                  "properties": {"text": {"type": "string"}, "label": {"type": "string", "enum": labels}}}},
                             "relations": {"type": "array", "items": strs(*RELATION_KEYS)}}}
    user = f"Types: {', '.join(labels)}\n\n<article>\n<title>{title}</title>\n{text}\n</article>"
    return dict(model=model, max_tokens=16000, system=SYSTEM, messages=[{"role": "user", "content": user}],
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}})


def load(source):
    raw = urlopen(source).read().decode("utf-8") if source.startswith("http") else Path(source).read_text("utf-8")
    return list(csv.DictReader(StringIO(raw)))


def prepare(rows, ids):
    """Rows whose id is in ids, with cleaned text, as pipeline.py sees them. Returns [(row, src, text, boilerplate_lines_removed)]."""
    boiler = site_boilerplate({r["l"]: r["url"] for r in rows})
    seen, want = set(), []
    for r in rows:  # also dedupes repeated ids within the sheet
        if r["l"] in ids and r["l"] not in seen:
            seen.add(r["l"]); want.append(r)
    with ThreadPoolExecutor(8) as ex:
        texts = list(ex.map(lambda r: get_text(r["l"], r["url"], r["title_or_summary"], r["snippet_or_context"]), want))
    out = []
    for r, (src, raw_text) in zip(want, texts):
        text, removed = clean(raw_text, r["url"], boiler)
        if src == "article" and PAYWALL.search(raw_text) and len(text) < PAYWALL_MAX_CHARS:
            src = "paywall"
        out.append((r, src, text[:MAX_CHARS], removed))
    return out


def collect(client, auto=False):
    """Returns the number of articles collected, or None when the batch has not ended (auto only)."""
    if not STATE.exists():
        sys.exit(f"no pending batch ({STATE} not found)")
    s = json.loads(STATE.read_text("utf-8"))
    b = client.messages.batches.retrieve(s["batch_id"])
    if b.processing_status != "ended":
        if auto:
            return None
        sys.exit(f"{s['batch_id']} still {b.processing_status}: {b.request_counts}. Try again later.")
    results = list(client.messages.batches.results(s["batch_id"]))
    done = read_ids(OUT / "articles.csv")  # a crashed collect re-run must not duplicate rows
    todo = {x.custom_id for x in results} - done
    by_id = {r["l"]: (r, src, text, removed) for r, src, text, removed in prepare(load(s["source"]), todo)}
    labels, ok, bad, dropped = s["labels"], 0, 0, 0
    for res in results:
        if res.custom_id in done:
            continue
        try:
            if res.result.type != "succeeded" or res.result.message.stop_reason != "end_turn":
                raise RuntimeError(res.result.type)
            r, src, text, removed = by_id[res.custom_id]
            got = json.loads(next(x.text for x in res.result.message.content if x.type == "text"))
            ents = got["entities"]
        except Exception as e:  # an article with no row in articles.csv is picked up by the next --batch
            bad += 1
            print(f"FAILED {res.custom_id}: {e}", file=sys.stderr)
            continue
        mentions, seen = [], set()
        for e in ents:
            e = {"text": e["text"].strip(), "label": e["label"]}
            m = re.search(re.escape(e["text"]), text, re.I) if e["text"] else None
            if not m:  # not in the article: invented or paraphrased
                dropped += 1
                continue
            if not keep(e):
                continue
            e["label"] = label(e, labels)
            key = (norm(e["text"]), e["label"])
            if key in seen:
                continue
            seen.add(key)
            mentions.append({"article_id": r["l"], "label": e["label"], "text": e["text"], "norm": key[0],
                             "score": "",  # Haiku gives no confidence
                             "context": text[max(0, m.start() - 120):m.end() + 120]})
        squash = lambda t: " ".join(t.casefold().split())
        rels = [{"article_id": r["l"], **{k: v.strip() for k, v in x.items()},
                 "actor_norm": norm(x["actor"]), "target_norm": norm(x["target"]),
                 # flags quotes the model paraphrased or invented
                 "quote_found": bool(x["quote"].strip()) and squash(x["quote"]) in squash(text)}
                for x in got["relations"]]
        append(OUT / "mentions.csv", MENTION_COLS, mentions)
        append(OUT / "relations.csv", RELATION_COLS, rels)
        append(OUT / "articles.csv", ARTICLE_COLS, [{
            "id": r["l"], "project_id": r["project_id"], "saved_at": r["saved_at"], "saved_by": r["saved_by"],
            "source_type": r["source_type"], "datetime_utc": r["datetime_utc"], "language": r["doc_language"],
            "title": r["title_or_summary"], "url": r["url"], "tags": r["tags"], "text_source": src,
            "text_chars": len(text), "boilerplate_lines": removed, "n_entities": len(mentions),
            "processed_at": s["created"]}])
        ok += 1
    STATE.rename(STATE.with_suffix(".done"))
    print(f"collected {ok} articles into {OUT}; {bad} failed, {dropped} entities dropped as not in the text")
    return ok


def submit(client, a):
    """Submit the ids not yet in articles.csv as one batch. Returns the number submitted."""
    labels = [x.strip() for x in a.labels.split(",") if x.strip()] if a.labels else LABELS
    OUT.mkdir(parents=True, exist_ok=True)
    done = read_ids(OUT / "articles.csv")
    rows = load(a.source)
    new = list(dict.fromkeys(r["l"] for r in rows if r["l"] not in done))
    if a.limit:
        new = new[:a.limit]
    todo = prepare(rows, set(new))
    print(f"{len(done)} already processed, {len(todo)} to submit. Looking for: {', '.join(labels)}")
    if not todo:
        return 0
    b = client.messages.batches.create(requests=[
        {"custom_id": r["l"], "params": params(a.model, r["title_or_summary"], text, labels)} for r, _, text, _ in todo])
    STATE.write_text(json.dumps({"batch_id": b.id, "source": a.source, "labels": labels, "model": a.model,
                                 "created": datetime.now(timezone.utc).isoformat(timespec="seconds")}), "utf-8")
    print(f"submitted {len(todo)} articles as {b.id}; saved to {STATE}")
    return len(todo)


def auto(client, a):
    """One CI step: collect an ended batch, leave a running one, or submit the new ids."""
    if STATE.exists():
        n = collect(client, auto=True)
        action, n = ("pending", 0) if n is None else ("collected", n)
        if action == "pending":
            print("pending")
    else:
        n = submit(client, a)
        action = "submitted" if n else "nothing"
        if not n:
            print("nothing to do")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "last_auto.json").write_text(json.dumps({"action": action, "count": n,
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}), "utf-8")


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--batch", action="store_true", help="submit new articles as one Batch API job and exit")
    g.add_argument("--collect", action="store_true", help="fetch the finished batch")
    g.add_argument("--auto", action="store_true", help="CI: collect if ended, say pending if running, else submit new articles")
    ap.add_argument("--limit", type=int, default=0, help="at most N new articles (0 = all)")
    ap.add_argument("--source", default=CANARY_CSV, help="Canary CSV url or path")
    ap.add_argument("--labels", help="comma-separated entity types (default: pipeline.py's LABELS)")
    ap.add_argument("--model", default=HAIKU)
    a = ap.parse_args()
    import anthropic
    client = anthropic.Anthropic()
    if a.auto:
        return auto(client, a)
    if a.collect:
        return collect(client)
    if STATE.exists():
        sys.exit(f"{STATE} is a batch still pending: run --collect first")
    if submit(client, a):
        print("close the laptop, then: uv run extract.py --collect")


if __name__ == "__main__":
    main()
