"""Pull US transmission line geometry into the bundled GeoJSON layer files.

Source: EIA Atlas "U.S. Electric Power Transmission Lines (Archive)", the
public ArcGIS FeatureServer. HIFLD Open (the original publisher) closed in
August 2025; this archive is frozen at 30 Sep 2024 and is the only free,
still-served line geometry with voltage and owner attributes.

Run from the repo root with any Python 3.10+ (stdlib only):

    python tools/energy/fetch_lines.py

Writes two files under src/data/local_data/eia_transmission_lines/:

  lines_backbone.geojson   every line with VOLTAGE >= 345 kV, nationwide
  lines_regional.geojson   100 kV <= VOLTAGE < 345 kV inside the SPP + NY
                           bounding boxes (the regions the LMP layer covers)

Coordinates are rounded to 4 decimals (about 11 m) and each part is
simplified with Douglas-Peucker at SIMPLIFY_DEG. The lines draw 1 to 3 px
wide at continental camera heights, where 1 px covers well over 300 m, so
the tolerance is invisible and cuts the vertex count several-fold. Fewer
vertices means fewer ground-clamped wall segments for Cesium to build.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

SERVICE = (
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/"
    "US_Electric_Power_Transmission_Lines/FeatureServer/0/query"
)
PAGE = 2000
UA = "gods-eye-view energy layer fetch (github.com/ParsonsKody/gods-eye-view)"

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "src" / "data" / "local_data" / "eia_transmission_lines"
BACKBONE = OUT_DIR / "lines_backbone.geojson"
REGIONAL = OUT_DIR / "lines_regional.geojson"
README = OUT_DIR / "README.md"

BACKBONE_MIN_KV = 345
REGIONAL_MIN_KV = 100
SIMPLIFY_DEG = 0.003  # Douglas-Peucker tolerance, about 300 m

# lon_min, lat_min, lon_max, lat_max
REGIONS = {
    "spp": (-106.7, 25.8, -88.0, 49.0),
    "nyiso": (-80.0, 40.4, -71.5, 45.1),
}


def fetch_page(offset: int) -> dict:
    params = {
        "where": f"VOLTAGE >= {REGIONAL_MIN_KV}",
        "outFields": "ID,TYPE,STATUS,VOLTAGE,VOLT_CLASS,OWNER,SUB_1,SUB_2",
        "outSR": "4326",
        "returnGeometry": "true",
        "geometryPrecision": "4",
        "resultOffset": str(offset),
        "resultRecordCount": str(PAGE),
        "f": "geojson",
    }
    url = f"{SERVICE}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.load(resp)


def _point_segment_distance(p: list[float], a: list[float], b: list[float]) -> float:
    """Distance from p to segment ab in degrees (planar; fine at this tolerance)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    if dx == 0 and dy == 0:
        return ((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2) ** 0.5
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    qx, qy = a[0] + t * dx, a[1] + t * dy
    return ((p[0] - qx) ** 2 + (p[1] - qy) ** 2) ** 0.5


def douglas_peucker(coords: list[list[float]], tol: float) -> list[list[float]]:
    """Iterative Douglas-Peucker; keeps the first and last vertex."""
    n = len(coords)
    if n < 3:
        return list(coords)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        best, best_d = -1, tol
        for i in range(lo + 1, hi):
            d = _point_segment_distance(coords[i], coords[lo], coords[hi])
            if d > best_d:
                best, best_d = i, d
        if best >= 0:
            keep[best] = True
            stack.append((lo, best))
            stack.append((best, hi))
    return [c for c, k in zip(coords, keep) if k]


def simplify(coords: list[list[float]]) -> list[list[float]]:
    rounded = [[round(c[0], 4), round(c[1], 4)] for c in coords]
    out: list[list[float]] = []
    for c in rounded:
        if not out or out[-1] != c:
            out.append(c)
    out = douglas_peucker(out, SIMPLIFY_DEG)
    if len(out) < 2 and rounded:
        out = [rounded[0], rounded[-1]]
    return out


def in_region(vertex: list[float]) -> bool:
    lon, lat = vertex
    for lon0, lat0, lon1, lat1 in REGIONS.values():
        if lon0 <= lon <= lon1 and lat0 <= lat <= lat1:
            return True
    return False


def to_feature(raw: dict) -> dict | None:
    geom = raw.get("geometry") or {}
    gtype = geom.get("type")
    if gtype == "LineString":
        parts = [geom.get("coordinates") or []]
    elif gtype == "MultiLineString":
        parts = geom.get("coordinates") or []
    else:
        return None
    parts = [simplify(p) for p in parts if len(p) >= 2]
    parts = [p for p in parts if len(p) >= 2]
    if not parts:
        return None
    p = raw.get("properties") or {}
    try:
        kv = float(p.get("VOLTAGE"))
    except (TypeError, ValueError):
        return None
    if kv < REGIONAL_MIN_KV:
        return None
    geometry = (
        {"type": "LineString", "coordinates": parts[0]}
        if len(parts) == 1
        else {"type": "MultiLineString", "coordinates": parts}
    )
    return {
        "type": "Feature",
        "id": p.get("ID"),
        "geometry": geometry,
        "properties": {
            "kv": int(kv) if kv.is_integer() else kv,
            "volt_class": (p.get("VOLT_CLASS") or "").strip(),
            "owner": (p.get("OWNER") or "").strip(),
            "status": (p.get("STATUS") or "").strip(),
            "type": (p.get("TYPE") or "").strip(),
            "sub_1": (p.get("SUB_1") or "").strip(),
            "sub_2": (p.get("SUB_2") or "").strip(),
        },
    }


def first_vertex(feature: dict) -> list[float]:
    g = feature["geometry"]
    return g["coordinates"][0] if g["type"] == "LineString" else g["coordinates"][0][0]


def write_collection(path: Path, features: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write('{"type":"FeatureCollection","features":[\n')
        for i, f in enumerate(features):
            fh.write(json.dumps(f, separators=(",", ":"), ensure_ascii=False))
            fh.write(",\n" if i < len(features) - 1 else "\n")
        fh.write("]}\n")


def main() -> int:
    backbone: list[dict] = []
    regional: list[dict] = []
    offset = 0
    total_raw = 0
    while True:
        page = fetch_page(offset)
        raw = page.get("features") or []
        if not raw:
            break
        total_raw += len(raw)
        for r in raw:
            f = to_feature(r)
            if not f:
                continue
            if f["properties"]["kv"] >= BACKBONE_MIN_KV:
                backbone.append(f)
            elif in_region(first_vertex(f)):
                regional.append(f)
        print(f"  offset {offset}: {len(raw)} rows (backbone {len(backbone)}, regional {len(regional)})", file=sys.stderr)
        more = page.get("properties", {}).get("exceededTransferLimit") or len(raw) == PAGE
        if not more:
            break
        offset += len(raw)

    if len(backbone) < 3000:
        print(f"only {len(backbone)} backbone lines; refusing to overwrite", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    backbone.sort(key=lambda f: (-(f["properties"]["kv"]), str(f["id"])))
    regional.sort(key=lambda f: (-(f["properties"]["kv"]), str(f["id"])))
    write_collection(BACKBONE, backbone)
    write_collection(REGIONAL, regional)
    kb = lambda p: p.stat().st_size // 1024
    print(f"rows read: {total_raw}", file=sys.stderr)
    print(f"wrote {len(backbone)} backbone lines ({kb(BACKBONE)} KB) to {BACKBONE}", file=sys.stderr)
    print(f"wrote {len(regional)} regional lines ({kb(REGIONAL)} KB) to {REGIONAL}", file=sys.stderr)

    if README.exists():
        text = README.read_text(encoding="utf-8")
        text = re.sub(r"Backbone count: \d+", f"Backbone count: {len(backbone)}", text)
        text = re.sub(r"Regional count: \d+", f"Regional count: {len(regional)}", text)
        text = re.sub(r"Pulled: \d{4}-\d{2}-\d{2}", f"Pulled: {date.today().isoformat()}", text)
        README.write_text(text, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
