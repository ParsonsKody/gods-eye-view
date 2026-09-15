# Private data fixture

A synthetic `series.json` in the private data seam's format
(`src/data/privateData.js` documents the schema). The ISO Congestion layer
loads it when `GEV_PRIVATE_DATA_DIR` is not set, so the time cursor and the
forecast-error colour mode have something to show. Every number in it is
invented; the layer panel says DEMO while it is in use.

Nodes: the 51 SPP hub, DC-tie and interface points the live price contour
map publishes (real keys and coordinates, pulled 2026-09-15). Hours: seven
days back and two days ahead of `demo_now_index`; the loader shifts the
stamps so that index lands on the current hour.

Built by a one-off script from the live `/api/lmp?iso=spp` payload with a
seeded generator; regenerate the same way if the node list changes.

License: the coordinates are SPP public price contour map data; the values
are not data.
