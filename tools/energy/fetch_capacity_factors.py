"""Pull EIA-923 monthly net generation by plant into a bundled sidecar file.

Source: the EIA-923 monthly release (f923_<year>.zip on eia.gov), sheet
"Page 1 Generation and Fuel Data". The layer joins the sidecar to
plants.geojsonl by plant code and shows a capacity factor on the hover
card: the sum of the monthly "Netgen" columns over nameplate MW times
hours elapsed.

Run from the repo root with any Python 3.10+ (stdlib only; the xlsx is
read as zipped XML, no openpyxl):

    python tools/energy/fetch_capacity_factors.py [year]

Writes src/data/local_data/eia_power_plants/capacity_factors.json and
refreshes the capacity-factor line in that folder's README.
"""

from __future__ import annotations

import calendar
import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

UA = "gods-eye-view energy layer fetch (github.com/ParsonsKody/gods-eye-view)"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "src" / "data" / "local_data" / "eia_power_plants"
OUT = OUT_DIR / "capacity_factors.json"
README = OUT_DIR / "README.md"


def download(year: int) -> bytes:
    url = f"https://www.eia.gov/electricity/data/eia923/xls/f923_{year}.zip"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    print(f"  downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(req, timeout=300) as resp:
        return resp.read()


def col_index(ref: str) -> int:
    """'AB12' -> 27 (zero based column)."""
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n - 1


def shared_strings(book: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(book.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    out = []
    for si in root.findall("m:si", NS):
        out.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    return out


def sheet_path(book: zipfile.ZipFile, title: str) -> str:
    wb = ET.fromstring(book.read("xl/workbook.xml"))
    rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
    targets = {r.get("Id"): r.get("Target") for r in rels}
    for sheet in wb.find("m:sheets", NS):
        if sheet.get("name") == title:
            target = targets[sheet.get(f"{{{RELS_NS}}}id")]
            return target if target.startswith("xl/") else f"xl/{target}"
    raise SystemExit(f"sheet {title!r} not found")


def iter_rows(book: zipfile.ZipFile, path: str, strings: list[str]):
    """Yield each row as a dict {column index: value}."""
    with book.open(path) as fh:
        for _event, el in ET.iterparse(fh, events=("end",)):
            if el.tag != f"{{{NS['m']}}}row":
                continue
            row: dict[int, str | float] = {}
            for c in el.findall("m:c", NS):
                v = c.find("m:v", NS)
                if v is None or v.text is None:
                    continue
                kind = c.get("t")
                if kind == "s":
                    value: str | float = strings[int(v.text)]
                elif kind in ("str", "inlineStr"):
                    value = v.text
                else:
                    try:
                        value = float(v.text)
                    except ValueError:
                        value = v.text
                row[col_index(c.get("r", ""))] = value
            yield row
            el.clear()


def norm_header(text) -> str:
    return re.sub(r"\s+", " ", str(text)).strip().lower()


def main() -> int:
    year = int(sys.argv[1]) if len(sys.argv) > 1 else date.today().year
    raw = download(year)
    outer = zipfile.ZipFile(io.BytesIO(raw))
    members = [n for n in outer.namelist() if "Schedules_2_3_4_5" in n and n.endswith(".xlsx")]
    if not members:
        print("no Schedules_2_3_4_5 workbook in the zip", file=sys.stderr)
        return 1
    member = members[0]
    m = re.search(r"_M_(\d{2})_(\d{4})", member)
    if m:
        months = int(m.group(1))
        data_year = int(m.group(2))
        release = "monthly"
    else:
        months = 12
        data_year = year
        release = "final annual"
    book = zipfile.ZipFile(io.BytesIO(outer.read(member)))
    strings = shared_strings(book)
    path = sheet_path(book, "Page 1 Generation and Fuel Data")

    gen: dict[str, float] = {}
    header: dict[str, int] | None = None
    rows = 0
    for row in iter_rows(book, path, strings):
        if header is None:
            names = {norm_header(v): i for i, v in row.items() if isinstance(v, str)}
            monthly = [names.get(f"netgen {calendar.month_name[mth].lower()}") for mth in range(1, months + 1)]
            if "plant id" in names and all(i is not None for i in monthly):
                header = {"plant": names["plant id"], "months": monthly}
            continue
        plant = row.get(header["plant"])
        if plant is None:
            continue
        code = str(int(plant)) if isinstance(plant, float) else str(plant).strip()
        if not code.isdigit():
            continue
        values = [row.get(i) for i in header["months"]]
        if not any(isinstance(v, (int, float)) for v in values):
            continue
        gen[code] = gen.get(code, 0.0) + sum(float(v) for v in values if isinstance(v, (int, float)))
        rows += 1
    if header is None:
        print("header row with 'Plant Id' and the monthly 'Netgen' columns not found", file=sys.stderr)
        return 1
    # The monthly release carries the ~3.6K plants on the monthly survey
    # (about 90% of US generation); annual-only reporters have no row.
    if len(gen) < 3000:
        print(f"only {len(gen)} plants with generation; refusing to overwrite", file=sys.stderr)
        return 1

    hours = sum(calendar.monthrange(data_year, mth)[1] for mth in range(1, months + 1)) * 24
    period = f"{data_year}-01 to {data_year}-{months:02d}"
    payload = {
        "source": f"EIA-923 {release} release, {member}",
        "period": period,
        "months": months,
        "hours": hours,
        "gen_mwh": {code: round(value) for code, value in sorted(gen.items(), key=lambda kv: int(kv[0]))},
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8", newline="\n")
    print(f"wrote {len(gen)} plants ({rows} rows) to {OUT}; period {period}, {hours} h", file=sys.stderr)

    if README.exists():
        text = README.read_text(encoding="utf-8")
        text = re.sub(
            r"Capacity factors: .*",
            f"Capacity factors: {len(gen)} plants, EIA-923 {period} ({hours} h), pulled {date.today().isoformat()}",
            text,
        )
        README.write_text(text, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
