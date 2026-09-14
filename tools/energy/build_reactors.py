"""Map NRC power reactor unit names to bundled EIA plants.

Source: the NRC daily "Power Reactor Status" file
(PowerReactorStatusForLast365Days.txt, columns ReportDt|Unit|Power). The
unit names are the NRC's (`FitzPatrick`, `D.C. Cook 1`), the bundle has
EIA's (`James A Fitzpatrick`, `Donald C Cook`), so the join is a name match
with a short override table. The /api/reactors proxy serves the live
percentages; this sidecar tells the layers which plant each unit belongs
to and where it sits.

Run from the repo root with any Python 3.10+ (stdlib only), after
fetch_plants.py:

    python tools/energy/build_reactors.py

Writes src/data/local_data/eia_power_plants/reactor_units.json. Exits 1
when an NRC unit has no plant and is not on the SKIP list.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

NRC_URL = (
    "https://www.nrc.gov/reading-rm/doc-collections/event-status/"
    "reactor-status/PowerReactorStatusForLast365Days.txt"
)
UA = "gods-eye-view energy layer fetch (github.com/ParsonsKody/gods-eye-view)"

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "src" / "data" / "local_data" / "eia_power_plants"
PLANTS = DATA_DIR / "plants.geojsonl"
OUT = DATA_DIR / "reactor_units.json"
README = DATA_DIR / "README.md"

# NRC site name (unit number stripped) -> EIA plant code, where the EIA
# name does not start with the NRC name.
OVERRIDES = {
    "arkansas nuclear": 8055,
    "columbia generating station": 371,
    "d.c. cook": 6000,
    "davis-besse": 6149,
    "farley": 6001,
    "fitzpatrick": 6110,
    "ginna": 6122,
    "harris": 6015,
    "hatch": 6051,
    "hope creek": 6118,
    "river bend station": 6462,
    "robinson": 3251,
    "saint lucie": 6045,
    "salem": 2410,
    "south texas": 6251,
    "summer": 6127,
    "susquehanna": 6103,
}
# NRC units with no operating plant in the EIA-860M bundle yet.
SKIP = {"palisades"}


def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).strip()


def site_name(unit: str) -> str:
    return re.sub(r"\s+\d+$", "", unit).strip()


def nrc_units() -> list[str]:
    req = urllib.request.Request(NRC_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        text = resp.read().decode("utf-8-sig")
    rows = [line.split("|") for line in text.splitlines() if "|" in line][1:]
    latest = rows[0][0]
    return sorted({r[1].strip() for r in rows if r[0] == latest and len(r) >= 3})


def nuclear_plants() -> list[dict]:
    out = []
    with PLANTS.open(encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            f = json.loads(line)
            p = f["properties"]
            if p.get("fuel") != "nuclear":
                continue
            lon, lat = f["geometry"]["coordinates"]
            out.append(
                {"code": p["plant_code"], "name": p["name"], "lon": lon, "lat": lat, "ba": p.get("ba") or ""}
            )
    return out


def main() -> int:
    plants = nuclear_plants()
    by_code = {p["code"]: p for p in plants}
    units = nrc_units()
    rows = []
    missing = []
    for unit in units:
        site = site_name(unit)
        key = site.lower()
        if key in SKIP:
            continue
        code = OVERRIDES.get(key)
        if code is None:
            hits = [p for p in plants if norm(p["name"]).startswith(norm(site))]
            if len(hits) == 1:
                code = hits[0]["code"]
        plant = by_code.get(code)
        if not plant:
            missing.append(unit)
            continue
        rows.append(
            {
                "unit": unit,
                "plant_code": plant["code"],
                "ba": plant["ba"],
                "lon": plant["lon"],
                "lat": plant["lat"],
            }
        )
    for unit in missing:
        print(f"  no plant for NRC unit {unit!r}", file=sys.stderr)
    if missing:
        return 1
    OUT.write_text(
        json.dumps(
            {"source": "NRC power reactor status", "pulled": date.today().isoformat(), "units": rows},
            indent=1,
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {len(rows)} units over {len({r['plant_code'] for r in rows})} plants to {OUT}", file=sys.stderr)
    if README.exists():
        text = README.read_text(encoding="utf-8")
        text = re.sub(
            r"Reactor units: \d+ NRC units over \d+ plants, pulled \d{4}-\d{2}-\d{2}",
            f"Reactor units: {len(rows)} NRC units over {len({r['plant_code'] for r in rows})} plants, pulled {date.today().isoformat()}",
            text,
        )
        README.write_text(text, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
