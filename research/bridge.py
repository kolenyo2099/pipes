# /// script
# requires-python = ">=3.10"
# ///
"""Team bridge client for the CI pipeline: pull saved items, push results, mark items processed.

    PIPELINE_TEAM_CODE=<join code> uv run bridge.py pull --out out/source.csv
    uv run bridge.py push | mark-processed | status --file out/run_status.json
"""
import argparse, base64, csv, json, os, sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

HERE = Path(__file__).parent
HAIKU = HERE / "out" / "haiku"
CHUNK = 5000
LEGACY = ["l", "url", "title_or_summary", "snippet_or_context", "project_id", "saved_at", "saved_by",
          "source_type", "datetime_utc", "doc_language", "tags"]


def decode_code(code):
    """Join code = base64url(JSON {url, token}); padding may have been stripped."""
    d = json.loads(base64.urlsafe_b64decode(code.strip() + "=" * (-len(code.strip()) % 4)))
    return d["url"], d["token"]


def post(action_body):
    code = os.environ.get("PIPELINE_TEAM_CODE")
    if not code:
        sys.exit("PIPELINE_TEAM_CODE is not set")
    url, token = decode_code(code)
    req = Request(url, json.dumps({"token": token, **action_body}).encode(), {"Content-Type": "text/plain"})
    for attempt in (0, 1):
        try:
            with urlopen(req, timeout=120) as r:  # Apps Script answers via a redirect, which urlopen follows
                reply = json.loads(r.read())
            break
        except URLError as e:  # HTTPError is a URLError; only 5xx and network errors are retried
            if attempt or getattr(e, "code", 500) < 500:
                raise
    if not reply.get("ok"):
        raise RuntimeError(f"bridge: {reply.get('error', reply)}")
    return reply


def to_legacy(item):
    return {"l": item.get("canary_item_id") or item["id"], "url": item["url"],
            "title_or_summary": item.get("title", ""), "snippet_or_context": item.get("snippet", ""),
            "project_id": item.get("project", ""), "saved_at": item.get("saved_at") or item.get("added_at", ""),
            "saved_by": item.get("saved_by", ""), "source_type": item.get("source_type", ""),
            "datetime_utc": item.get("published_at", ""), "doc_language": item.get("language", ""),
            "tags": "; ".join(item.get("tags") or []), "bridge_id": item["id"]}


def source_rows(items):
    return [to_legacy(i) for i in items if i.get("url")]


def pending_ids(done, processed, bridge_ids):
    """Bridge ids of articles extracted (done) but not yet marked (processed); l without a bridge id is skipped."""
    return [(l, bridge_ids[l]) for l in sorted(set(done) - set(processed)) if l in bridge_ids]


def read_csv(path):
    with Path(path).open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def pull(a):
    items, offset = [], 0
    while True:
        r = post({"action": "list", "status": "all", "include_locked": "true", "limit": 5000, "offset": offset})
        items += r["items"]
        offset += len(r["items"])
        if not r["items"] or offset >= r["total"]:
            break
    rows = source_rows(items)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    with open(a.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, [*LEGACY, "bridge_id"])
        w.writeheader()
        w.writerows(rows)
    print(f"pulled {len(rows)}")


def put_tab(tab, rows):
    """rows[0] is the header; the first chunk resets the tab, later chunks append."""
    for i, n in enumerate(range(0, len(rows), CHUNK)):
        post({"action": "putTab", "tab": tab, "rows": rows[n:n + CHUNK], "reset": i == 0})
    print(f"{tab}: {len(rows) - 1} rows")


def push(a):
    arts, rels = read_csv(HAIKU / "articles.csv"), read_csv(HAIKU / "relations.csv") if (HAIKU / "relations.csv").exists() else []
    url_of, n_rel = {x["id"]: x["url"] for x in arts}, Counter(r["article_id"] for r in rels)
    put_tab("results_articles", [["id", "title", "url", "language", "n_entities", "n_relations"]] +
            [[x["id"], x["title"], x["url"], x["language"], x["n_entities"], n_rel[x["id"]]] for x in arts])
    put_tab("results_relations", [["actor", "action", "target", "amount", "place", "quote", "article id", "url"]] +
            [[r["actor"], r["action"], r["target"], r["amount"], r["place"], r["quote"], r["article_id"],
              url_of.get(r["article_id"], "")] for r in rels])


def mark_processed(a):
    processed_file = HAIKU / "processed.txt"
    processed = set(processed_file.read_text("utf-8").split()) if processed_file.exists() else set()
    done = {x["id"] for x in read_csv(HAIKU / "articles.csv")}
    bridge_ids = {r["l"]: r["bridge_id"] for r in read_csv(HERE / "out" / "source.csv")}
    todo = pending_ids(done, processed, bridge_ids)
    if todo:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        post({"action": "updateMany", "updates": [{"id": b, "fields": {"Processed At": now}} for _, b in todo]})
        with processed_file.open("a", encoding="utf-8") as f:
            f.writelines(l + "\n" for l, _ in todo)
    print(f"marked {len(todo)}")


def status(a):
    put_tab("pipeline_status", [["key", "value"]] + [[k, str(v)] for k, v in json.loads(Path(a.file).read_text("utf-8")).items()])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pull").add_argument("--out", default="out/source.csv")
    sub.add_parser("push")
    sub.add_parser("mark-processed")
    sub.add_parser("status").add_argument("--file", default="out/run_status.json")
    a = ap.parse_args()
    try:
        {"pull": pull, "push": push, "mark-processed": mark_processed, "status": status}[a.cmd](a)
    except Exception as e:
        sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
