/**
 * Map marker sprites for the power plant layer: one canvas per fuel, a dark
 * disc with a ring and the fuel glyph (POWER_PLANT_FUEL_ICONS) in the fuel
 * colour, so the marker itself names the fuel the way the Yes Energy map
 * does. The billboard collection scales the sprite per plant (nameplate
 * MW), so one texture per fuel serves every plant of that fuel.
 */

/** Sprite canvas edge in device pixels. */
export const PLANT_MARKER_SPRITE_PX = 48;
/** Glyph edge inside the sprite (the icon paths are 24-unit). */
const GLYPH_PX = 26;
const DISC_FILL = 'rgba(8, 12, 18, 0.82)';
const RING_WIDTH = 2.5;

/**
 * Build a per-fuel sprite cache.
 * @param {object} [options]
 * @param {() => HTMLCanvasElement} [options.createCanvas] Test seam.
 * @param {typeof Path2D} [options.path2d] Test seam.
 * @returns {{get:(fuel:string, color:string, icon:string)=>HTMLCanvasElement|null, size:()=>number}}
 */
export function createPlantMarkerSpriteCache({
  createCanvas = () => document.createElement('canvas'),
  path2d = globalThis.Path2D,
} = {}) {
  const cache = new Map();
  return {
    get(fuel, color, icon) {
      const key = String(fuel || 'other');
      const hit = cache.get(key);
      if (hit) return hit;
      const canvas = createCanvas();
      if (!canvas) return null;
      canvas.width = PLANT_MARKER_SPRITE_PX;
      canvas.height = PLANT_MARKER_SPRITE_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const c = PLANT_MARKER_SPRITE_PX / 2;
      const radius = c - RING_WIDTH;
      ctx.beginPath();
      ctx.arc(c, c, radius, 0, Math.PI * 2);
      ctx.fillStyle = DISC_FILL;
      ctx.fill();
      ctx.lineWidth = RING_WIDTH;
      ctx.strokeStyle = color;
      ctx.stroke();
      if (icon && typeof path2d === 'function') {
        ctx.save();
        ctx.translate(c - GLYPH_PX / 2, c - GLYPH_PX / 2);
        ctx.scale(GLYPH_PX / 24, GLYPH_PX / 24);
        ctx.fillStyle = color;
        ctx.fill(new path2d(icon));
        ctx.restore();
      }
      cache.set(key, canvas);
      return canvas;
    },
    size: () => cache.size,
  };
}
