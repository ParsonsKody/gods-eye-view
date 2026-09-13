"""Pull US power plants (EIA-860/860M) into the bundled GeoJSONL layer.

Source: the public ArcGIS mirror of EIA Atlas "Power Plants" (fedmaps).
The EIA-owned FeatureServer needs a token and the Hub download URL answers
403 to scripts, so the mirror is the primary source.

Run from the repo root with any Python 3.10+ (stdlib only):

    python tools/energy/fetch_plants.py

Writes src/data/local_data/eia_power_plants/plants.geojsonl and refreshes
the feature count and pull date in that folder's README.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

MIRROR = (
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/"
    "Power_Plants_in_the_US/FeatureServer/0/query"
)
PAGE = 2000
UA = "gods-eye-view energy layer fetch (github.com/ParsonsKody/gods-eye-view)"

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "src" / "data" / "local_data" / "eia_power_plants"
OUT = OUT_DIR / "plants.geojsonl"
README = OUT_DIR / "README.md"

# EIA PrimSource text -> short fuel key used by the layer for colour.
FUEL_KEY = {
    "natural gas": "gas",
    "coal": "coal",
    "nuclear": "nuclear",
    "wind": "wind",
    "solar": "solar",
    "hydroelectric": "hydro",
    "pumped storage": "hydro",
    "batteries": "storage",
    "petroleum": "oil",
    "geothermal": "geothermal",
    "biomass": "biomass",
    "other": "other",
}


def fetch_page(offset: int) -> dict:
    params = {
        "where": "1=1",
        "outFields": (
            "Plant_Code,Plant_Name,Utility_Na,State,PrimSource,tech_desc,"
            "Total_MW,Period"
        ),
        "outSR": "4326",
        "returnGeometry": "true",
        "resultOffset": str(offset),
        "resultRecordCount": str(PAGE),
        "f": "geojson",
    }
    url = f"{MIRROR}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def to_feature(raw: dict) -> dict | None:
    geom = raw.get("geometry") or {}
    coords = geom.get("coordinates")
    if geom.get("type") != "Point" or not coords:
        return None
    lon, lat = coords[0], coords[1]
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return None
    p = raw.get("properties") or {}
    name = (p.get("Plant_Name") or "").strip()
    if not name:
        return None
    prim = (p.get("PrimSource") or "").strip()
    total_mw = p.get("Total_MW")
    try:
        total_mw = round(float(total_mw), 1) if total_mw is not None else None
    except (TypeError, ValueError):
        total_mw = None
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
        "properties": {
            "name": name,
            "plant_code": p.get("Plant_Code"),
            "fuel": FUEL_KEY.get(prim.lower(), "other"),
            "prim_source": prim,
            "tech": (p.get("tech_desc") or "").strip(),
            "total_mw": total_mw,
            "state": (p.get("State") or "").strip(),
            "utility": (p.get("Utility_Na") or "").strip(),
            "period": p.get("Period"),
        },
    }


def main() -> int:
    features: list[dict] = []
    offset = 0
    while True:
        page = fetch_page(offset)
        raw = page.get("features") or []
        if not raw:
            break
        features.extend(f for f in (to_feature(r) for r in raw) if f)
        print(f"  offset {offset}: {len(raw)} rows", file=sys.stderr)
        if len(raw) < PAGE and not page.get("properties", {}).get("exceededTransferLimit"):
            break
        offset += len(raw)

    if len(features) < 5000:
        print(f"only {len(features)} plants; refusing to overwrite", file=sys.stderr)
        return 1

    features.sort(key=lambda f: (f["properties"]["plant_code"] or 0))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="\n") as fh:
        for f in features:
            fh.write(json.dumps(f, separators=(",", ":"), ensure_ascii=False))
            fh.write("\n")

    periods = sorted({str(f["properties"]["period"]) for f in features if f["properties"]["period"]})
    fuels: dict[str, int] = {}
    for f in features:
        fuels[f["properties"]["fuel"]] = fuels.get(f["properties"]["fuel"], 0) + 1
    print(f"wrote {len(features)} plants to {OUT}", file=sys.stderr)
    print(f"  data period(s): {periods[-1] if periods else 'unknown'}", file=sys.stderr)
    print("  fuels: " + ", ".join(f"{k}={v}" for k, v in sorted(fuels.items(), key=lambda kv: -kv[1])), file=sys.stderr)

    if README.exists():
        text = README.read_text(encoding="utf-8")
        text = re.sub(r"Feature count: \d+", f"Feature count: {len(features)}", text)
        text = re.sub(r"Pulled: \d{4}-\d{2}-\d{2}", f"Pulled: {date.today().isoformat()}", text)
        text = re.sub(r"Data period: \S+", f"Data period: {periods[-1] if periods else 'unknown'}", text)
        README.write_text(text, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
