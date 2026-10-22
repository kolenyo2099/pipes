"""Export the normalized Haiku data for the explorer: data/data.js (a script tag works from a double-click, no server needed).

    python3 build_data.py        # run normalize.py / llm_merge.py first if the merges changed
"""
import json
from collections import defaultdict

from normalize import HAIKU, ROOT, build, canonical, fold, load

OUT = ROOT / "data"


def main():
    articles = load(HAIKU / "articles.csv")
    mentions, relations = load(HAIKU / "mentions.csv"), load(HAIKU / "relations.csv")
    if (HAIKU / "relations_amounts.csv").exists():  # amounts.py: who paid/received amounts the first pass left out
        relations += load(HAIKU / "relations_amounts.csv")
    mg, st = build(mentions)
    canon = canonical(mg, st)
    ents = sorted(canon.values(), key=lambda c: -len(c["arts"]))
    eidx = {c["key"]: i for i, c in enumerate(ents)}
    root_idx = {root: eidx[c["key"]] for root, c in canon.items()}
    aidx = {a["id"]: i for i, a in enumerate(articles)}

    def resolve(text):  # relation endpoints use the same folding as mentions
        for label in ("", "person", "government agency"):
            k = fold(text, label)
            if k in st:
                return root_idx[mg.find(k)]
        return -1

    ms = []
    for m in mentions:
        k = fold(m["text"], m["label"])
        if m["article_id"] in aidx and k in st:
            ms.append([aidx[m["article_id"]], root_idx[mg.find(k)], m["text"], m["context"].strip()])
    squash = lambda t: " ".join(t.casefold().split())
    money = defaultdict(list)  # article -> [(amount text, entity)]
    for row in ms:
        if ents[row[1]]["type"] == "money amount":
            money[row[0]].append((squash(row[2]), row[1]))

    def money_entity(ai, amount):
        t = squash(amount)
        return next((e for mt, e in money[ai] if t and (mt in t or t in mt)), -1) if t else -1

    rs = [[aidx[r["article_id"]], resolve(r["actor"]), r["actor"], r["action"], resolve(r["target"]), r["target"],
           r["amount"], r["place"], r["quote"], r["quote_found"] == "True", money_entity(aidx[r["article_id"]], r["amount"])]
          for r in relations if r["article_id"] in aidx and r["action"]]

    # Links between two entities that are closer than "same article": [article, e1, e2, kind, ref]
    # kind 1 = within about 120 characters of each other (ref = index into mentions), kind 2 = a verified relation (ref = index into relations)
    pairs, seen = [], set()
    add = lambda ai, a, b, kind, ref: (a >= 0 and b >= 0 and a != b and (ai, min(a, b), max(a, b), kind) not in seen
                                      and not seen.add((ai, min(a, b), max(a, b), kind)) and pairs.append([ai, a, b, kind, ref]))
    for ri, r in enumerate(rs):
        if r[9]:
            for x, y in ((r[1], r[4]), (r[1], r[10]), (r[4], r[10])):
                add(r[0], x, y, 2, ri)
    by_art = defaultdict(list)
    for mi, row in enumerate(ms):
        by_art[row[0]].append(mi)
    for ai, idxs in by_art.items():
        for i in idxs:
            for j in idxs:
                if i != j and len(ms[j][2]) >= 3 and ms[j][2] in ms[i][3]:
                    add(ai, ms[i][1], ms[j][1], 1, i)
    data = {"articles": [[a["id"], a["title"], a["url"], a["saved_at"], a["language"]] for a in articles],  # public: no saved_by / project_id
            "entities": [[c["name"], c["type"]] for c in ents], "mentions": ms, "relations": rs, "pairs": pairs}
    OUT.mkdir(exist_ok=True)
    (OUT / "data.js").write_text("window.DATA=" + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";", "utf-8")
    print(f"{len(articles)} articles, {len(ents)} entities, {len(ms)} mentions, {len(rs)} relations, {len(pairs)} links -> data/data.js "
          f"({(OUT / 'data.js').stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
