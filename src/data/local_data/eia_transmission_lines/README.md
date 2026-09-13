# EIA Transmission Lines (HIFLD archive)

US electric transmission line geometry with voltage, owner and substation
endpoints. Originally the HIFLD Open "Electric Power Transmission Lines"
dataset; HIFLD Open closed in August 2025 and EIA Atlas serves this frozen
archive (snapshot 30 Sep 2024). No newer free line geometry exists.

Source: `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer/0`
(EIA Atlas item `d4090758322c4d32a4cd002ffaa0aa12_0`).

Script: `tools/energy/fetch_lines.py`

Pulled: 2026-09-13

Backbone count: 3467 (`lines_backbone.geojson`, VOLTAGE >= 345 kV, nationwide)

Regional count: 19846 (`lines_regional.geojson`, 100 to 230 kV inside the
SPP and NYISO bounding boxes; shown only below 1,800 km camera height)

Fields: `kv`, `volt_class`, `owner`, `status`, `type` (AC/DC, overhead or
underground), `sub_1`, `sub_2`. Coordinates rounded to 4 decimals and
thinned to about 150 m vertex spacing.

License: US Government work redistributed by EIA under the Esri open data
terms of the Atlas portal. No attribution is legally required; the app
credits EIA and HIFLD as a courtesy.
