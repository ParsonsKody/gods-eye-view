# EIA Power Plants

US operating power plants from EIA-860 / EIA-860M, as published on the
EIA Atlas "Power Plants" layer.

Source: public ArcGIS mirror of the EIA Atlas layer
`https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Power_Plants_in_the_US/FeatureServer/0`
(EIA Atlas item `bf5c5110b1b944d299bb683cdbd02d2a`).

Script: `tools/energy/fetch_plants.py`

Feature count: 13446

Pulled: 2026-09-14

Data period: 202502

Runtime output: `plants.geojsonl` (one Point feature per plant)

Fields: `name`, `plant_code` (EIA plant id), `fuel` (short key used for
colour: gas, coal, nuclear, wind, solar, hydro, storage, oil, geothermal,
biomass, other), `prim_source` (EIA primary energy source text), `tech`,
`total_mw` (nameplate, all generators at the site), `state`, `utility`,
`period` (EIA-860M vintage, YYYYMM), `ba` (balancing authority code from
EIA-860M, empty when the plant is not in that month's inventory).

Balancing authority: 13086 plants from EIA-860M `july_generator2026.xlsx`

Reactor units: 94 NRC units over 54 plants, pulled 2026-09-14

Sidecar `reactor_units.json` (script: `tools/energy/build_reactors.py`):
NRC power reactor unit name to EIA plant code and coordinates, so the live
NRC daily power percentages (`/api/reactors`) land on the right plant.
Palisades is skipped until it appears in the 860M inventory.

Capacity factors: 3571 plants, EIA-923 2026-01 to 2026-06 (4344 h), pulled 2026-09-14

Sidecar `capacity_factors.json` (script: `tools/energy/fetch_capacity_factors.py`):
`gen_mwh` per EIA plant code from the EIA-923 monthly release, sheet
"Page 1 Generation and Fuel Data", summed over the monthly Netgen columns
and over all prime movers at the site. The monthly release covers only the
plants on EIA's monthly survey (about 90% of US generation); annual-only
reporters have no row and show no capacity factor. The layer computes
`gen_mwh / (total_mw x hours)`. Rerun after each EIA monthly release.

License: public domain (work of the United States Government). No
attribution is legally required; the app credits EIA as a courtesy.
