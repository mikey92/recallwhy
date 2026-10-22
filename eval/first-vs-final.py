# Judge's first answer per pair (from the eval trace) vs the final decision after the Auditor loop.
import json, sys, re
tag = sys.argv[1]
res = json.load(open(f"eval/results/{tag}.json"))
first = {}
for line in open(f"logs/eval/trace-eval-{tag}.jsonl"):
    e = json.loads(line)
    if e["t"] < res.get("startedAt", "0"): continue
    if e["kind"] == "llm" and e["purpose"].startswith("judge "):
        m = re.match(r"judge (\S+) vs (\S+)", e["purpose"]); key = (m[2], m[1])
        if key in first: continue
        o = e["output"].upper()
        first[key] = "same" if re.search(r"\bSAME\b", o) else "not-this" if "DIFFERENT" in o else "unsure"
rows = [r for r in res["rows"] if r["basis"] == "text"]
def score(get):
    tp = sum(1 for r in rows if r["label"] == "same" and get(r) == "same")
    fp = sum(1 for r in rows if r["label"] == "not-this" and get(r) == "same")
    fn = sum(1 for r in rows if r["label"] == "same" and get(r) == "not-this")
    un = sum(1 for r in rows if get(r) == "unsure")
    return dict(caught=tp, falseAlarms=fp, wronglyDismissed=fn, toHuman=un)
print("text pairs", len(rows), "positives", sum(r["label"] == "same" for r in rows))
print("judge first answer:", score(lambda r: first.get((r["recall"], r["sku"]), "missing")))
print("after Auditor loop:", score(lambda r: r["final"]))
