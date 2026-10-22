# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["anthropic", "trafilatura"]
# ///
"""Second and third pass of entity merging, for what normalize.py's rules cannot see (translations, abbreviations,
"Homeland Security" = "Department of Homeland Security"). Needs ANTHROPIC_API_KEY.

    uv run llm_merge.py             # Haiku proposes groups, Sonnet reviews them; writes out/haiku/llm_merges.json + llm_review.csv
    python3 normalize.py            # then rebuilds canonical.csv with those merges applied

Per entity type, Haiku sees the TOP entities (name, article count, one sample sentence) and groups the ones that are the
same real-world thing. Sonnet then reviews each Haiku group and may split it. llm_review.csv records both, so you can see
where Haiku over-merged and what Sonnet changed. Countries and dates are skipped (the explorer resolves countries itself).
"""
import argparse, csv, json, sys
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict

import anthropic

from normalize import HAIKU, SKIP_TYPES, build, canonical, fold, load

HAIKU_MODEL, SONNET_MODEL = "claude-haiku-5-5", "claude-sonnet-5-5"
TOP = 400  # entities per type shown to the model; the long tail is left to the rules

RULES = """Two names are the SAME entity only if they are the same real-world person, organization, place or thing,
whatever the language, spelling, abbreviation or level of detail. Different things are NOT the same: a country and its
neighbour (Sudan / South Sudan), a state and its city (Washington / Washington, D.C.), a body and its parent or branch
(Homeland Security Investigations / Department of Homeland Security), the same name in different countries
(U.S. Supreme Court / U.K. Supreme Court: use the sample sentences), a person and their relative or namesake.
When unsure, leave them apart."""
GROUPS = {"type": "object", "additionalProperties": False, "required": ["groups"], "properties": {"groups": {
    "type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["ids", "root"],
                               "properties": {"ids": {"type": "array", "items": {"type": "integer"}}, "root": {"type": "integer"}}}}}}
REVIEW = {"type": "object", "additionalProperties": False, "required": ["verdicts"], "properties": {"verdicts": {
    "type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["group", "subgroups", "note"],
                               "properties": {"group": {"type": "integer"}, "note": {"type": "string"}, "subgroups": {"type": "array", "items": GROUPS["properties"]["groups"]["items"]}}}}}}


def ask(client, model, system, user, schema, effort):
    r = client.messages.create(model=model, max_tokens=16000, system=system, messages=[{"role": "user", "content": user}],
                               output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}})
    if r.stop_reason != "end_turn":
        raise RuntimeError(f"stop_reason={r.stop_reason}")
    return json.loads(next(b.text for b in r.content if b.type == "text"))


def listing(ents, ctx):
    return "\n".join(f"{i}. {e['name']} [{len(e['arts'])} articles] {ctx.get(e['key'], '')[:140]!r}" for i, e in enumerate(ents))


def run_type(client, typ, ents, ctx):
    names = listing(ents, ctx)
    h = ask(client, HAIKU_MODEL, f"You merge duplicate entities in a list of {typ} names from news articles.\n{RULES}\n"
            "Return only groups of two or more ids that are the same entity, and for each the id of its fullest, most standard name as root. "
            "Each id may be in at most one group.", names, GROUPS, "low")["groups"]
    h = [g for g in h if len(set(g["ids"])) >= 2 and g["root"] in g["ids"] and all(0 <= i < len(ents) for i in g["ids"])]
    if not h:
        return typ, [], []
    shown = "\n\n".join(f"Group {n}: " + "; ".join(f"{i}. {ents[i]['name']} [{len(ents[i]['arts'])}] {ctx.get(ents[i]['key'], '')[:140]!r}" for i in g["ids"])
                        for n, g in enumerate(h))
    s = ask(client, SONNET_MODEL, f"You review proposed merges of duplicate {typ} entities from news articles.\n{RULES}\n"
            "For each group, return subgroups: keep the whole group as one subgroup if every member is the same entity; otherwise split it "
            "into the subgroups that are (singletons may be omitted). Give each subgroup a root id. Add a short note when you changed anything.",
            shown, REVIEW, "medium")["verdicts"]
    verdict = {v["group"]: v for v in s}
    final, review = [], []
    for n, g in enumerate(h):
        v = verdict.get(n)
        subs = [x for x in (v["subgroups"] if v else []) if len(set(x["ids"])) >= 2 and x["root"] in x["ids"] and set(x["ids"]) <= set(g["ids"])]
        for x in subs:
            final.append(x)
        same = len(subs) == 1 and set(subs[0]["ids"]) == set(g["ids"])
        review.append([typ, " | ".join(ents[i]["name"] for i in g["ids"]), "kept whole" if same else "changed by Sonnet",
                       " || ".join(" | ".join(ents[i]["name"] for i in x["ids"]) for x in subs) if not same else "", v["note"] if v else "no verdict"])
    return typ, final, review


def main():
    argparse.ArgumentParser().parse_args()
    mentions = load(HAIKU / "mentions.csv")
    mg, st = build(mentions, use_llm=False)  # start from the rules alone so this is reproducible
    canon = canonical(mg, st)
    keyctx = {}
    for m in mentions:
        keyctx.setdefault(fold(m["text"], m["label"]), m["context"].strip())
    by_type = defaultdict(list)
    for c in canon.values():
        if c["type"] not in SKIP_TYPES | {"country"}:
            by_type[c["type"]].append(c)
    jobs = {t: sorted(cs, key=lambda c: -len(c["arts"]))[:TOP] for t, cs in by_type.items() if len(cs) >= 2}
    client = anthropic.Anthropic()
    merges, review = [], []
    with ThreadPoolExecutor(6) as ex:
        for res in ex.map(lambda kv: run_type(client, kv[0], kv[1], keyctx), jobs.items()):
            typ, final, rev = res[:3]
            ents = jobs[typ]
            for g in final:
                for i in set(g["ids"]) - {g["root"]}:
                    merges.append({"child": ents[i]["key"], "root": ents[g["root"]]["key"], "rule": "llm", "type": typ})
            review += rev
            print(f"{typ}: {len(final)} groups kept of {len(rev)} proposed", flush=True)
    (HAIKU / "llm_merges.json").write_text(json.dumps({"models": [HAIKU_MODEL, SONNET_MODEL], "merges": merges}, ensure_ascii=False, indent=1), "utf-8")
    with (HAIKU / "llm_review.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["type", "haiku_group", "sonnet", "sonnet_split_into", "note"]); w.writerows(review)
    print(f"{len(merges)} merges; {sum(r[2] != 'kept whole' for r in review)} of {len(review)} Haiku groups changed by Sonnet. See llm_review.csv")


if __name__ == "__main__":
    main()
