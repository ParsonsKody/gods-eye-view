# ISO pricing nodes

Coordinates for the pricing nodes the ISO Congestion (LMP) layer draws.

## NYISO

Source: `http://mis.nyiso.com/public/csv/generator/generator.csv`
(Generator Name, Generator PTID, Zone, Subzone, Latitude, Longitude, Active).

Script: `tools/energy/build_nodes.py`

Pulled: 2026-09-13

NYISO count: 563 (`nyiso.geojsonl`; rows without coordinates are dropped)

Fields: `iso`, `id` (generator PTID, the join key to the real-time LBMP
feed), `name`, `zone`, `subzone`, `active`.

License: NYISO public MIS data. No attribution is legally required; the app
credits NYISO as a courtesy.

## SPP

No bundled file. The price-contour ArcGIS layers
(`pricecontourmap.spp.org/arcgis/rest/services/PCM/RTBM_Features`) return
hub, DC-tie, interface and constraint points with coordinates and the
current LMP components in one call, so the `/api/lmp` proxy passes them
through. SPP does not publish coordinates for generator or load settlement
locations.
