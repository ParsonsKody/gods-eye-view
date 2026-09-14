/**
 * Legend glyphs for the power plant fuels, one 24-unit SVG path per fuel key
 * of POWER_PLANT_FUEL_COLORS. The panel tints each path with the fuel colour
 * (`fill: currentColor`), so the glyph names the fuel and the colour still
 * matches the dot on the map.
 */
export const POWER_PLANT_FUEL_ICONS = Object.freeze({
  // Hexagon: a lump of coal.
  coal: 'M12 2 21 7v10l-9 5-9-5V7z',
  // Cooling tower silhouette.
  nuclear: 'M7 2h10l-1.6 6c-.3 2 .3 4.2 1.6 6L19 22H5l2-8c1.3-1.8 1.9-4 1.6-6z',
  // Flame.
  gas: 'M13 2c0 4 5 6.5 5 11.5a6 6 0 0 1-12 0c0-2.2 1-4 2.6-5.3C8.8 10.5 9.6 12 11 12c1.8-2-2-6 2-10z',
  // Wave.
  hydro:
    'M2 9c2.5-2.8 5-2.8 7.5 0s5 2.8 7.5 0 3.5-2.3 5-1.2v3.4c-1.5-1.1-3-.6-5 1.2-2.5 2.8-5 2.8-7.5 0S4.5 9.6 2 12.4zm0 6c2.5-2.8 5-2.8 7.5 0s5 2.8 7.5 0 3.5-2.3 5-1.2v3.4c-1.5-1.1-3-.6-5 1.2-2.5 2.8-5 2.8-7.5 0S4.5 15.6 2 18.4z',
  // Three-blade turbine on a mast.
  wind: 'M11 10.5 6 3.8l1.8-1.1 4.6 7.2zm2.3.2 7.7-3 .6 2-7.9 2.4zm-2.1 2.6L7.4 21l1.9.9 3.6-7.4zM12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  // Sun with eight rays.
  solar:
    'M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z',
  // Derrick: a tall lattice tower on a base.
  oil: 'M10.5 2h3L19 22h-2.2l-1.3-5H8.5l-1.3 5H5zm-1.5 13h6l-.9-3.5H9.9zm1.4-5.5h3.2l-.8-3h-1.6zM3 22h18v-1.5H3z',
  // Battery with a charge bar.
  storage: 'M9 2h6v2h3v18H6V4h3zm-1 4v14h8V6zm2 6h4v6h-4z',
  // Leaf with a midrib.
  biomass:
    'M20 4c-9 0-15 4-16 12 0 0 1 4 4 4 8 0 12-6 12-16zm-11 13c2-5 5-8 8-10-3 3-5 7-7 10z',
  // Geothermal shares the leaf: a renewable with no glyph of its own.
  geothermal:
    'M20 4c-9 0-15 4-16 12 0 0 1 4 4 4 8 0 12-6 12-16zm-11 13c2-5 5-8 8-10-3 3-5 7-7 10z',
  // Lightning bolt.
  other: 'M13 2 4 14h6l-1 8 9-12h-6z',
});
