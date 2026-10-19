"""Merge the two independent BAD report readings into bad-labels.json.

Page-level results must agree exactly (the script fails otherwise); element mappings are
unioned and tagged with the readers that proposed them, because the reports are often not
specific enough to pin elements and the harness resolves selectors to real DOM nodes.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
readers = {r: json.loads((HERE / f"bad-labels.reader{r}.json").read_text()) for r in ("A", "B")}


def result_key(entry):
    return (str(entry.get("result", "")).strip().lower(), tuple(sorted(entry.get("techniques") or [])))


pages = {}
conflicts = []
for page in sorted(readers["A"]["pages"]):
    ca = readers["A"]["pages"][page]["criteria"]
    cb = readers["B"]["pages"][page]["criteria"]
    if set(ca) != set(cb):
        conflicts.append(f"{page}: criterion sets differ: {sorted(set(ca) ^ set(cb))}")
    criteria = {}
    for sc in sorted(set(ca) & set(cb)):
        if result_key(ca[sc]) != result_key(cb[sc]):
            conflicts.append(f"{page} {sc}: A={result_key(ca[sc])} B={result_key(cb[sc])}")
            continue
        elements = {}
        for r, entry in (("A", ca[sc]), ("B", cb[sc])):
            for el in entry.get("elements") or []:
                sel = (el.get("selector") if isinstance(el, dict) else str(el)).strip()
                if not sel or sel.lower().startswith("not specific"):
                    continue
                slot = elements.setdefault(sel, {"selector": sel, "readers": [], "snippet": el.get("snippet") if isinstance(el, dict) else None})
                slot["readers"].append(r)
        criteria[sc] = {
            "result": ca[sc].get("result"),
            "techniques": sorted(ca[sc].get("techniques") or []),
            "quoteA": ca[sc].get("quote"),
            "quoteB": cb[sc].get("quote"),
            "elements": sorted(elements.values(), key=lambda e: e["selector"]),
        }
    pages[page] = {"report": readers["A"]["pages"][page]["report"], "criteria": criteria}

if conflicts:
    print("PAGE-LEVEL CONFLICTS — resolve by hand before using these labels:")
    print("\n".join(conflicts))
    sys.exit(1)

out = {
    "schemaVersion": 1,
    "method": "two independent readers read each WCAG report (no regex extraction); page-level results agree exactly; element mappings are the union, tagged by reader",
    "sources": ["bad-labels.readerA.json", "bad-labels.readerB.json"],
    "pages": pages,
}
(HERE / "bad-labels.json").write_text(json.dumps(out, indent=2) + "\n")
n_sc = sum(len(p["criteria"]) for p in pages.values())
n_el = sum(len(c["elements"]) for p in pages.values() for c in p["criteria"].values())
n_both = sum(1 for p in pages.values() for c in p["criteria"].values() for e in c["elements"] if len(e["readers"]) == 2)
print(f"pages={len(pages)} criteria={n_sc} elements={n_el} agreedByBoth={n_both}")
