"""Build the bundled ISO pricing-node coordinate file for the LMP layer.

NYISO publishes generator PTIDs with latitude and longitude at
http://mis.nyiso.com/public/csv/generator/generator.csv (about 830 rows,
roughly 560 with coordinates). The real-time LBMP feed keys on the same
PTID, so this file is the join table the /api/lmp proxy uses.

SPP needs no node file: its price-contour ArcGIS layers return hub, DC-tie,
interface and binding-constraint points with coordinates in the same call.

Run from the repo root with any Python 3.10+ (stdlib only):

    python tools/energy/build_nodes.py

Writes src/data/local_data/iso_nodes/nyiso.geojsonl and refreshes the count
and pull date in that folder's README.
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

NYISO_GENERATORS = "http://mis.nyiso.com/public/csv/generator/generator.csv"
UA = "gods-eye-view energy layer fetch (github.com/ParsonsKody/gods-eye-view)"

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "src" / "data" / "local_data" / "iso_nodes"
OUT = OUT_DIR / "nyiso.geojsonl"
README = OUT_DIR / "README.md"


def main() -> int:
    req = urllib.request.Request(NYISO_GENERATORS, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        text = resp.read().decode("utf-8", "replace")
    rows = list(csv.DictReader(io.StringIO(text)))

    features = []
    for r in rows:
        try:
            lat = float(r.get("Latitude", "").strip())
            lon = float(r.get("Longitude", "").strip())
        except ValueError:
            continue
        if not (-80 <= lon <= -71 and 40 <= lat <= 46):
            continue
        ptid = (r.get("Generator PTID") or "").strip()
        if not ptid:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
                "properties": {
                    "iso": "nyiso",
                    "id": ptid,
                    "name": (r.get("Generator Name") or "").strip(),
                    "zone": (r.get("Zone") or "").strip(),
                    "subzone": (r.get("Subzone") or "").strip(),
                    "active": (r.get("Active") or "").strip() == "Y",
                },
            }
        )

    if len(features) < 300:
        print(f"only {len(features)} located NYISO generators; refusing to overwrite", file=sys.stderr)
        return 1

    features.sort(key=lambda f: int(f["properties"]["id"]))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="\n") as fh:
        for f in features:
            fh.write(json.dumps(f, separators=(",", ":"), ensure_ascii=False))
            fh.write("\n")
    print(f"wrote {len(features)} NYISO nodes (of {len(rows)} rows) to {OUT}", file=sys.stderr)

    if README.exists():
        t = README.read_text(encoding="utf-8")
        t = re.sub(r"NYISO count: \d+", f"NYISO count: {len(features)}", t)
        t = re.sub(r"Pulled: \d{4}-\d{2}-\d{2}", f"Pulled: {date.today().isoformat()}", t)
        README.write_text(t, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
