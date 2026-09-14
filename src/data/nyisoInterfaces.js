/**
 * Where to draw each NYISO interface and which way its positive flow runs.
 *
 * NYISO's interface flows CSV names the interface but carries no geometry.
 * Each row here sits at the interface's main substation or cable terminal
 * (hand-placed, not the exact tie line). `bearingDeg` is the compass
 * direction of a POSITIVE flow: into New York on the scheduled ties, west
 * to east or north to south on the internal interfaces (checked against
 * two days of data: Moses South runs negative while HQ-NY exports, which
 * is consistent). `forward` and `reverse` are the card wording for a
 * positive and a negative flow.
 *
 * `SCH - HQ_IMPORT_EXPORT` is an aggregate of the three HQ ties and is
 * left out so it is not drawn twice.
 */

export const NYISO_INTERFACES = Object.freeze(
  [
    ['SCH - PJ - NY', 'PJM to NY', 41.1, -74.15, 45, 'into NY', 'out to PJM', 'external'],
    ['SCH - PJM_HTP', 'Hudson (HTP)', 40.76, -74.01, 80, 'into NYC', 'out to PJM', 'external'],
    ['SCH - PJM_NEPTUNE', 'Neptune', 40.55, -73.9, 60, 'into Long Island', 'out to PJM', 'external'],
    ['SCH - PJM_VFT', 'Linden VFT', 40.63, -74.19, 70, 'into NYC', 'out to PJM', 'external'],
    ['SCH - NE - NY', 'New England to NY', 41.7, -73.55, 270, 'into NY', 'out to New England', 'external'],
    ['SCH - NPX_1385', 'Northport cable', 40.95, -73.35, 190, 'into Long Island', 'out to Connecticut', 'external'],
    ['SCH - NPX_CSC', 'Cross Sound Cable', 41.05, -72.87, 170, 'into Long Island', 'out to Connecticut', 'external'],
    ['SCH - OH - NY', 'Ontario to NY', 43.1, -79.05, 90, 'into NY', 'out to Ontario', 'external'],
    ['SCH - HQ - NY', 'Quebec to NY', 45.0, -74.75, 180, 'into NY', 'out to Quebec', 'external'],
    ['SCH - HQ_CEDARS', 'Cedars tie', 44.98, -74.95, 180, 'into NY', 'out to Quebec', 'external'],
    ['SCH - HQ_CHPE', 'CHPE', 40.78, -73.91, 190, 'into NYC', 'out to Quebec', 'external'],
    ['CENTRAL EAST - VC', 'Central East', 42.95, -74.9, 100, 'eastbound', 'westbound', 'internal'],
    ['TOTAL EAST', 'Total East', 42.8, -74.4, 100, 'eastbound', 'westbound', 'internal'],
    ['DYSINGER EAST', 'Dysinger East', 43.0, -78.3, 90, 'eastbound', 'westbound', 'internal'],
    ['WEST CENTRAL', 'West Central', 42.9, -78.85, 90, 'eastbound', 'westbound', 'internal'],
    ['MOSES SOUTH', 'Moses South', 44.7, -74.9, 180, 'southbound', 'northbound', 'internal'],
    ['UPNY CONED', 'UPNY to ConEd', 41.45, -73.8, 180, 'southbound', 'northbound', 'internal'],
    ['SPR/DUN-SOUTH', 'Sprain / Dunwoodie South', 40.93, -73.85, 180, 'southbound', 'northbound', 'internal'],
  ].map(([name, label, lat, lon, bearingDeg, forward, reverse, kind]) =>
    Object.freeze({ name, label, lat, lon, bearingDeg, forward, reverse, kind }),
  ),
);

const BY_NAME = new Map(NYISO_INTERFACES.map((row) => [row.name, row]));

/**
 * @param {string} name Interface name as the feed spells it.
 * @returns {object|null}
 */
export function nyisoInterface(name) {
  return BY_NAME.get(String(name || '').trim()) || null;
}
