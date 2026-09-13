# EIA Power Plants

US operating power plants from EIA-860 / EIA-860M, as published on the
EIA Atlas "Power Plants" layer.

Source: public ArcGIS mirror of the EIA Atlas layer
`https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Power_Plants_in_the_US/FeatureServer/0`
(EIA Atlas item `bf5c5110b1b944d299bb683cdbd02d2a`).

Script: `tools/energy/fetch_plants.py`

Feature count: 13446

Pulled: 2026-09-13

Data period: 202502

Runtime output: `plants.geojsonl` (one Point feature per plant)

Fields: `name`, `plant_code` (EIA plant id), `fuel` (short key used for
colour: gas, coal, nuclear, wind, solar, hydro, storage, oil, geothermal,
biomass, other), `prim_source` (EIA primary energy source text), `tech`,
`total_mw` (nameplate, all generators at the site), `state`, `utility`,
`period` (EIA-860M vintage, YYYYMM).

License: public domain (work of the United States Government). No
attribution is legally required; the app credits EIA as a courtesy.
