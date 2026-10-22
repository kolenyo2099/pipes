# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["anthropic", "trafilatura"]
# ///
"""Fill the gap in relations.csv: money amounts that no relation carries.

For every article with a money amount that no relation's `amount` mentions, ask Haiku who paid it, who received it, and for
what, with the sentence that says so. Rows go to out/haiku/relations_amounts.csv in the same columns as relations.csv
(build_data.py reads both). Needs ANTHROPIC_API_KEY; re-running skips articles already done.

    uv run amounts.py [--limit 20]
"""
import argparse, csv, json, sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import anthropic

from normalize import HAIKU, load
from pipeline import append, clean, get_text, norm, site_boilerplate

MODEL = "claude-haiku-5-5"
COLS = ["article_id", "actor", "action", "target", "amount", "place", "quote", "actor_norm", "target_norm", "quote_found"]
SYSTEM = """You read one news article and explain amounts of money it mentions, for an investigative journalism team.
For each numbered amount say who pays or spends it (payer), who receives it or is its subject (recipient), and what it is for (purpose,
a short verb phrase such as "paid for ImmigrationOS development"), and copy the sentence that says so word for word as quote.
Use only what the article says. If the article does not make it clear, leave payer, recipient and purpose empty.
Name people and organizations as the article does."""
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["amounts"], "properties": {"amounts": {
    "type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["id", "payer", "recipient", "purpose", "quote"],
                               "properties": {"id": {"type": "integer"}, **{k: {"type": "string"} for k in ("payer", "recipient", "purpose", "quote")}}}}}}


def squash(s):
    return " ".join(s.casefold().split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    arts = {x["id"]: x for x in load(HAIKU / "articles.csv")}
    boiler = site_boilerplate({i: x["url"] for i, x in arts.items()})
    covered = defaultdict(list)
    for r in load(HAIKU / "relations.csv"):
        if r["amount"].strip():
            covered[r["article_id"]].append(squash(r["amount"]))
    out = HAIKU / "relations_amounts.csv"
    done = {r["article_id"] for r in load(out)} if out.exists() else set()
    todo = defaultdict(dict)  # article -> {amount text: context}
    for m in load(HAIKU / "mentions.csv"):
        t = squash(m["text"])
        if m["label"] == "money amount" and m["article_id"] not in done and not any(t in c or c in t for c in covered[m["article_id"]]):
            todo[m["article_id"]].setdefault(m["text"], m["context"].strip())
    jobs = list(todo.items())[:a.limit or None]
    print(f"{len(jobs)} articles, {sum(len(v) for _, v in jobs)} uncovered amounts")
    client = anthropic.Anthropic()

    def run(aid, amounts):
        art = arts[aid]
        text, _ = clean(get_text(aid, art["url"], art["title"])[1], art["url"], boiler)
        items = list(amounts.items())
        listing = "\n".join(f"{i}. {t}  (near: {c[:160]!r})" for i, (t, c) in enumerate(items, 1))
        r = client.messages.create(model=MODEL, max_tokens=4000, system=SYSTEM,
                                   messages=[{"role": "user", "content": f"<article>\n<title>{art['title']}</title>\n{text}\n</article>\n\nAmounts:\n{listing}"}],
                                   output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}})
        if r.stop_reason != "end_turn":
            raise RuntimeError(f"stop_reason={r.stop_reason}")
        got = json.loads(next(b.text for b in r.content if b.type == "text"))["amounts"]
        rows = []
        for x in got:
            if not 1 <= x["id"] <= len(items) or not (x["payer"].strip() or x["recipient"].strip()):
                continue
            rows.append({"article_id": aid, "actor": x["payer"].strip(), "action": x["purpose"].strip() or "money for", "target": x["recipient"].strip(),
                         "amount": items[x["id"] - 1][0], "place": "", "quote": x["quote"].strip(),
                         "actor_norm": norm(x["payer"]), "target_norm": norm(x["recipient"]),
                         "quote_found": bool(x["quote"].strip()) and squash(x["quote"]) in squash(text)})
        return aid, rows

    n = 0
    with ThreadPoolExecutor(4) as ex:
        futs = [ex.submit(run, aid, am) for aid, am in jobs]
        for i, f in enumerate(as_completed(futs), 1):
            try:
                aid, rows = f.result()
            except Exception as e:  # not marked done: the next run retries it
                print(f"[{i}/{len(jobs)}] FAILED: {e}", file=sys.stderr)
                continue
            # an article with no usable row still has to be remembered, or it is asked again every run
            append(out, COLS, rows or [{"article_id": aid, "actor": "", "action": "", "target": "", "amount": "", "place": "", "quote": "",
                                         "actor_norm": "", "target_norm": "", "quote_found": False}])
            n += len(rows)
    print(f"{n} relations written to {out}")


if __name__ == "__main__":
    main()
