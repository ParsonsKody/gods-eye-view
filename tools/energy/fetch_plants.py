"""Pull US power plants (EIA-860/860M) into the bundled GeoJSONL layer.

Source: the public ArcGIS mirror of EIA Atlas "Power Plants" (fedmaps).
The EIA-owned FeatureServer needs a token and the Hub download URL answers
403 to scripts, so the mirror is the primary source.

The balancing authority of each plant comes from the EIA-860M monthly
generator inventory (column "Balancing Authority Code"), which the Atlas
layer does not carry. Pass the 860M file stem to join it.

Run from the repo root with any Python 3.10+ (stdlib only):

    python tools/energy/fetch_plants.py --eia860m july_generator2026

Writes src/data/local_data/eia_power_plants/plants.geojsonl and refreshes
the feature count, pull date and 860M vintage in that folder's README.
"""

from __future__ import annotations

import io
import json
import re
import sys
import zipfile
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

from fetch_capacity_factors import iter_rows, norm_header, shared_strings, sheet_path

MIRROR = (
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/"
    "Power_Plants_in_the_US/FeatureServer/0/query"
)
PAGE = 2000
EIA860M = "https://www.eia.gov/electricity/data/eia860m/xls/{stem}.xlsx"
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


def balancing_authorities(stem: str) -> dict[int, str]:
    """EIA plant id -> balancing authority code from the 860M Operating sheet."""
    url = EIA860M.format(stem=stem)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    print(f"  downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(req, timeout=300) as resp:
        book = zipfile.ZipFile(io.BytesIO(resp.read()))
    strings = shared_strings(book)
    rows = iter_rows(book, sheet_path(book, "Operating"), strings)
    plant_col = ba_col = None
    out: dict[int, str] = {}
    for row in rows:
        if plant_col is None:
            headers = {norm_header(v): i for i, v in row.items()}
            if "plant id" in headers and "balancing authority code" in headers:
                plant_col = headers["plant id"]
                ba_col = headers["balancing authority code"]
            continue
        try:
            code = int(row.get(plant_col))
        except (TypeError, ValueError):
            continue
        ba = str(row.get(ba_col) or "").strip()
        if ba and code not in out:
            out[code] = ba
    if len(out) < 5000:
        raise SystemExit(f"only {len(out)} plants carry a balancing authority in {stem}")
    return out


def main() -> int:
    args = sys.argv[1:]
    stem = args[args.index("--eia860m") + 1] if "--eia860m" in args else None
    bas = balancing_authorities(stem) if stem else {}
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

    with_ba = 0
    for f in features:
        ba = bas.get(f["properties"]["plant_code"], "")
        f["properties"]["ba"] = ba
        with_ba += bool(ba)
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
    print(f"  balancing authority on {with_ba} plants" + (f" (EIA-860M {stem})" if stem else " (no 860M join)"), file=sys.stderr)

    if README.exists():
        text = README.read_text(encoding="utf-8")
        text = re.sub(r"Feature count: \d+", f"Feature count: {len(features)}", text)
        text = re.sub(r"Pulled: \d{4}-\d{2}-\d{2}", f"Pulled: {date.today().isoformat()}", text)
        text = re.sub(r"Data period: \S+", f"Data period: {periods[-1] if periods else 'unknown'}", text)
        if stem:
            text = re.sub(
                r"Balancing authority: .*",
                f"Balancing authority: {with_ba} plants from EIA-860M `{stem}.xlsx`",
                text,
            )
        README.write_text(text, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
