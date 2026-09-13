import { createLocalGeoJsonLayer } from './localGeojsonCore.js';

// Resolved by Vite in builds and relative to this module in other consumers.
const datacentersUrl = new URL(
  './local_data/datacenters/datacenters.geojsonl',
  import.meta.url,
).href;
const damsUrl = new URL('./local_data/dams/dams.geojsonl', import.meta.url)
  .href;
const powerPlantsUrl = new URL(
  './local_data/eia_power_plants/plants.geojsonl',
  import.meta.url,
).href;

/** Anchor colour per EIA primary fuel (`fuel` property from fetch_plants.py). */
export const POWER_PLANT_FUEL_COLORS = Object.freeze({
  gas: '#ff9f1c',
  coal: '#8d6e63',
  nuclear: '#d81b60',
  wind: '#4fc3f7',
  solar: '#ffe600',
  hydro: '#2979ff',
  storage: '#00e5a0',
  oil: '#b0bec5',
  geothermal: '#ff5722',
  biomass: '#7cb342',
  other: '#9e9e9e',
});

/**
 * Anchor style for one plant: colour by fuel, size by nameplate MW
 * (6 px under 10 MW up to 16 px at 2,000 MW and above).
 * @param {object} props Plant feature properties.
 * @returns {{color:string,pixelSize:number}}
 */
export function powerPlantStyle(props) {
  const color =
    POWER_PLANT_FUEL_COLORS[props?.fuel] || POWER_PLANT_FUEL_COLORS.other;
  const mw = Number(props?.total_mw);
  const scaled = Number.isFinite(mw) && mw > 0 ? Math.log10(mw) : 0;
  const pixelSize = Math.round(
    6 + 10 * Math.min(1, Math.max(0, (scaled - 1) / 2.3)),
  );
  return { color, pixelSize };
}

/**
 * Create fresh datacenter, dam and power-plant layers without starting or
 * loading them.
 * @param {object} services Caller-owned context, overlay and render operations.
 * @returns {object[]} Datacenters, dams, then power plants, with stable
 *   standalone identities.
 */
export function createInfrastructureLayers(services) {
  const datacenters = createLocalGeoJsonLayer(
    {
      id: 'local-datacenters',
      url: datacentersUrl,
      name: 'Datacenters',
      color: '#00ffff', // Cyan
      icon: '▣',
      source: 'Local',
      labels: true,
      labelMax: 700,
      labelGridPx: 138,
    },
    services,
  );

  const dams = createLocalGeoJsonLayer(
    {
      id: 'local-dams',
      url: damsUrl,
      name: 'Dams',
      color: '#0088ff', // Blue
      icon: '▰',
      source: 'USACE',
      labels: true,
      labelMax: 900,
      labelGridPx: 132,
    },
    services,
  );

  const powerPlants = createLocalGeoJsonLayer(
    {
      id: 'local-power-plants',
      url: powerPlantsUrl,
      name: 'Power Plants',
      color: '#ffb300', // Amber label accent; anchors take the fuel colour
      icon: '⚡',
      source: 'EIA-860',
      labels: true,
      labelMax: 600,
      labelGridPx: 140,
      styleForFeature: powerPlantStyle,
    },
    services,
  );

  return [datacenters, dams, powerPlants];
}
