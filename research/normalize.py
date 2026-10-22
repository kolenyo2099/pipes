"""Merge name variants of the same entity in out/haiku/, locally, with rules (no API calls).

    python3 normalize.py            # writes out/haiku/canonical.csv + merges.csv, prints what is still unmerged

Rules, in order: entities.csv + aliases.csv (curated) -> accents/case/punctuation/legal suffixes/titles/leading
articles -> acronyms (ICE = Immigration and Customs Enforcement) -> surnames (Trump = Donald Trump, when unambiguous).
llm_merge.py adds a second source of merges (out/haiku/llm_merges.json) for what rules cannot see, such as
translations. Every merge is listed in merges.csv with the rule that made it, so it can be checked and undone.
"""
import csv, json, re, unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path

from pipeline import norm

ROOT = Path(__file__).parent
HAIKU = ROOT / "out" / "haiku"
STOP = {"of", "the", "and", "for", "de", "del", "la", "las", "los", "el", "y", "et", "du", "des", "le", "les", "da", "do", "e", "a", "in", "on"}
ARTICLES = {"the", "le", "la", "les", "el", "los", "las", "l"}
TITLES = {"president", "presidente", "mr", "mrs", "ms", "dr", "dra", "sen", "senator", "rep", "gov", "governor",
          "judge", "secretary", "secretaria", "sr", "sra", "sec", "gen", "vice"}
SKIP_TYPES = {"date", "money amount"}  # nothing for an LLM to merge: the text is the identity
DROP_TYPES = {"date"}  # too noisy to browse; money amounts stay as entities


def fold(text, label=""):
    """Grouping key: no accents/case/punctuation/parentheticals, no legal suffix, no leading article,
    no title or middle initial on a person, and agencies written "X Department" / "US Department of X" become "department of x"."""
    s = re.sub(r"\([^)]*\)", " ", re.sub(r"['’]s\b", "", text))  # possessive, "(ICE)"
    s = unicodedata.normalize("NFKD", s)
    s = norm("".join(c for c in s if not unicodedata.combining(c)))
    t = s.split()
    t = re.sub(r"\b(\w) (?=\w\b)", r"\1", " ".join(t)).split()  # "u s", "d c" -> "us", "dc"
    while len(t) > 1 and t[0] in ARTICLES:
        t.pop(0)
    if label == "person":
        while len(t) > 1 and t[0] in TITLES:
            t.pop(0)
        t = [w for i, w in enumerate(t) if len(w) > 1 or i in (0, len(t) - 1)]  # middle initial
    s = " ".join(t)
    if label == "government agency":
        s = re.sub(r"^(united states|us|u s) ", "", s)
        s = re.sub(r" (de estados unidos|of the united states|of america|of us)$", "", s)
        m = re.match(r"^(.+) department$", s)
        if m and not s.startswith("department "):
            s = "department of " + m.group(1)
    return s


def load(path):
    with path.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def curated():
    """variant fold -> (canonical name, type or '') from entities.csv and aliases.csv (columns: variant,canonical)."""
    out = {}
    if (ROOT / "entities.csv").exists():
        for e in load(ROOT / "entities.csv"):
            for a in [e["name"], *filter(None, e["aliases"].split("|"))]:
                out[fold(a)] = (e["name"], e["type"])
    if (ROOT / "aliases.csv").exists():
        for e in load(ROOT / "aliases.csv"):
            out.setdefault(fold(e["variant"]), (e["canonical"], ""))
    return out


class Merger:
    def __init__(self):
        self.parent, self.rule = {}, {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, child, root, rule):
        a, b = self.find(child), self.find(root)
        if a != b:
            self.parent[a] = b
            self.rule[a] = rule


def initials(key):
    return "".join(w[0] for w in key.split() if w not in STOP)


def build(mentions, use_llm=True):
    """Returns (merger, stats) where stats[key] = dict(raws, labels, arts, n)."""
    st = defaultdict(lambda: {"raws": Counter(), "labels": Counter(), "arts": set(), "n": 0})
    for m in mentions:
        if m["label"] in DROP_TYPES:
            continue
        k = fold(m["text"], m["label"])
        if not k:
            continue
        s = st[k]
        s["raws"][m["text"]] += 1; s["labels"][m["label"]] += 1; s["arts"].add(m["article_id"]); s["n"] += 1
    mg = Merger()
    top = lambda s, f: (s[f].most_common(1) or [("",)])[0][0]

    # 1. curated names
    cur = curated()
    for k in list(st):
        if k in cur:
            mg.union(k, fold(cur[k][0]), "curated")
            st.setdefault(fold(cur[k][0]), {"raws": Counter({cur[k][0]: 0}), "labels": Counter(), "arts": set(), "n": 0})

    # 2. acronyms: ICE -> immigration and customs enforcement
    longs = {k: v for k, v in st.items() if len(k.split()) >= 2 and v["n"] >= 2}
    for k, v in list(st.items()):
        if " " in k or mg.find(k) != k or not (2 <= len(k) <= 6) or not any(r.isupper() for r in v["raws"]):
            continue
        if k in STOP or k in TITLES:
            continue
        # evidence the short form means this expansion: they share at least two articles, and no other
        # expansion is nearly as common (EU is "European Union" far more often than "Estados Unidos")
        every = sorted(((kk, vv["n"]) for kk, vv in longs.items() if initials(kk) == k), key=lambda x: -x[1])
        cands = [c for c in every if len(longs[c[0]]["arts"] & v["arts"]) >= 2]
        if len(every) > 1 and every[1][1] >= 0.3 * every[0][1]:
            continue
        if cands and (len(cands) == 1 or cands[1][1] < 0.3 * cands[0][1]):
            mg.union(k, cands[0][0], "acronym")

    # 3. surnames: "trump" -> "donald trump" if, wherever they co-occur, one full name is the clear winner
    persons = {k for k, v in st.items() if top(v, "labels") == "person"}
    arts_of = {k: st[k]["arts"] for k in persons}
    for k in persons:
        if " " in k or mg.find(k) != k:
            continue
        full = Counter()
        for kk in persons:
            t = kk.split()
            if len(t) >= 2 and t[-1] == k and mg.find(kk) == kk:
                full[kk] = len(arts_of[kk] & arts_of[k])
        if full:
            best, n = full.most_common(1)[0]
            if n >= 2 and (len(full) == 1 or full.most_common(2)[1][1] < 0.3 * n):
                mg.union(k, best, "surname")

    # 4. merges decided by an LLM (llm_merge.py), kept in a file so they can be reviewed
    f = HAIKU / "llm_merges.json"
    if use_llm and f.exists():
        for g in json.loads(f.read_text("utf-8"))["merges"]:
            if g["child"] in st and g["root"] in st:
                mg.union(g["child"], g["root"], g["rule"])
    return mg, st


def canonical(mg, st):
    """component root -> dict(key, name, type, ...). The most frequent key is the identity; curated names win."""
    comp = defaultdict(list)
    for k in st:
        comp[mg.find(k)].append(k)
    cur = {fold(v[0]): v for v in curated().values()}
    out = {}
    for root, keys in comp.items():
        lab, raws, arts, n = Counter(), Counter(), set(), 0
        for k in keys:
            lab.update(st[k]["labels"]); raws.update(st[k]["raws"]); arts |= st[k]["arts"]; n += st[k]["n"]
        key = max(keys, key=lambda k: st[k]["n"])
        name = cur[root][0] if root in cur else raws.most_common(1)[0][0]
        typ = cur[root][1] if root in cur and cur[root][1] else lab.most_common(1)[0][0]
        out[root] = {"key": key, "name": name, "type": typ, "keys": keys, "arts": arts, "n": n}
    return out


def residual(canon, limit=60):
    """Pairs that still look alike but were not merged (same type, token subset or near-identical string)."""
    by_type = defaultdict(list)
    for c in canon.values():
        if len(c["arts"]) >= 3:
            by_type[c["type"]].append(c)
    pairs = []
    for typ, cs in by_type.items():
        cs.sort(key=lambda c: -len(c["arts"]))
        cs = cs[:600]
        for i, a in enumerate(cs):
            ta = set(a["key"].split())
            for b in cs[i + 1:]:
                tb = set(b["key"].split())
                sub = (ta < tb or tb < ta) and min(len(ta), len(tb)) >= 1 and max(len(ta), len(tb)) - min(len(ta), len(tb)) <= 2
                if sub or SequenceMatcher(None, a["key"], b["key"]).ratio() >= 0.88:
                    pairs.append((len(a["arts"]) + len(b["arts"]), typ, a["name"], b["name"]))
    return sorted(pairs, reverse=True)[:limit]


def main():
    mentions = load(HAIKU / "mentions.csv")
    mg, st = build(mentions)
    canon = canonical(mg, st)
    with (HAIKU / "canonical.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["key", "name", "type", "articles", "mentions", "variants"])
        for c in sorted(canon.values(), key=lambda c: -len(c["arts"])):
            w.writerow([c["key"], c["name"], c["type"], len(c["arts"]), c["n"], "|".join(sorted(c["keys"]))])
    with (HAIKU / "merges.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["variant", "merged_into", "rule", "mentions"])
        for k, rule in mg.rule.items():
            w.writerow([k, canon[mg.find(k)]["key"], rule, st[k]["n"]])
    rules = Counter(mg.rule.values())
    print(f"{len(st)} distinct keys -> {len(canon)} entities; merges by rule: {dict(rules)}")
    print("\nstill unmerged but similar (articles, type, a | b):")
    for n, typ, a, b in residual(canon):
        print(f"  {n:4} {typ:22} {a} | {b}")


if __name__ == "__main__":
    main()
