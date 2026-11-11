#!/usr/bin/env python3
"""One tick of the pipeline (what the GitHub Actions cron runs). `python3 run.py --dry-run` prints the plan.

bridge pull -> extract --auto -> (if articles were collected) amounts, llm_merge, normalize, build_data,
bridge push + mark-processed -> bridge status. Env: PIPELINE_TEAM_CODE, ANTHROPIC_API_KEY, FORCE_MERGE=1.
"""
import csv, json, os, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent
os.chdir(ROOT)
def explorer_url(repo):
    """GITHUB_REPOSITORY "owner/name" -> its GitHub Pages address; empty when not on GitHub."""
    owner, _, name = repo.partition("/")
    return f"https://{owner}.github.io/{name}/" if owner and name else ""


DRY = "--dry-run" in sys.argv
now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
st = dict(started_at=now(), finished_at="", action="", collected=0, submitted=0, articles_total=0, pulled=0, ok=True, error="",
          explorer_url=explorer_url(os.environ.get("GITHUB_REPOSITORY", "")))


def stage(*cmd):
    """Run a stage, stream its output, return the text; raise on failure."""
    print(f"\n$ {' '.join(cmd)}", flush=True)
    if DRY:
        return ""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = ""
    for line in p.stdout:
        print(line, end="", flush=True)
        out += line
    if p.wait():
        raise RuntimeError(f"{' '.join(cmd[:3])} failed (exit {p.returncode})")
    return out


def count(text, word):
    for line in text.splitlines():
        if line.startswith(word + " "):
            return int(line.split()[1])
    return 0


def tick():
    st["pulled"] = count(stage("uv", "run", "bridge.py", "pull", "--out", "out/source.csv"), "pulled")
    stage("uv", "run", "extract.py", "--auto", "--source", "out/source.csv")
    if not DRY:
        last = json.loads(Path("out/haiku/last_auto.json").read_text())
        st["action"], st["collected"] = last["action"], last["count"] if last["action"] == "collected" else 0
        st["submitted"] = last["count"] if last["action"] == "submitted" else 0
    new = st["collected"] > 0 or DRY
    if new:
        stage("uv", "run", "amounts.py")
    if new or os.environ.get("FORCE_MERGE") == "1":
        stage("uv", "run", "llm_merge.py")
        stage("python3", "normalize.py")
    # Nothing collected yet (first ticks): no articles.csv, nothing to build.
    rebuilt = new or (not Path("data/data.js").exists() and Path("out/haiku/articles.csv").exists())
    if rebuilt:
        stage("python3", "build_data.py")
    if new:
        stage("uv", "run", "bridge.py", "push")
        stage("uv", "run", "bridge.py", "mark-processed")
    return rebuilt


def main():
    rebuilt = False
    try:
        rebuilt = tick()
    except Exception as e:  # keep going to the status call below
        st.update(ok=False, error=str(e))
        print(f"ERROR: {e}", file=sys.stderr)
    if not DRY:
        p = Path("out/haiku/articles.csv")
        st["articles_total"] = sum(1 for _ in csv.DictReader(p.open(encoding="utf-8"))) if p.exists() else 0
    st["finished_at"] = now()
    if not DRY:
        Path("out").mkdir(exist_ok=True)  # a tick that fails before the pull has not created it yet
        Path("out/run_status.json").write_text(json.dumps(st, indent=2))
    try:
        stage("uv", "run", "bridge.py", "status", "--file", "out/run_status.json")
    except Exception as e:
        print(f"status not written: {e}", file=sys.stderr)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"rebuilt={'true' if rebuilt and st['ok'] else 'false'}\n")
    print("\n" + json.dumps(st))
    sys.exit(0 if st["ok"] else 1)


if __name__ == "__main__":
    main()
