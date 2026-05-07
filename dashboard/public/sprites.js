/**
 * NanoClaw Dashboard — Sprite Engine (PNG-based)
 *
 * Uses pixel-agents assets (MIT, Pablo De Lucca 2026).
 * Character sheets: 112×96 (7 cols × 3 rows of 16×32 frames)
 *   Cols: walk1, walk2, walk3, type1, type2, read1, read2
 *   Rows: front (down), back (up), side (right — flip for left)
 */

const TILE = 16;
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const ZOOM = 3;

const PALETTE = {
  woodLight: '#C4956A', woodMid: '#A67B52', woodDark: '#8B6239', woodLine: '#755030',
  wallTop: '#8899AA', wallFace: '#6B7B8D', wallDark: '#556677', wallTrim: '#4A5A6A',
  skin: '#FFDBB4', skinShade: '#E8C49B',
  deskTop: '#D4A574', deskFront: '#A67B52', deskLeg: '#8B6239',
  monitorBez: '#2D3748', monitorScr: '#1A2332',
  plantGreen: '#22C55E', plantDark: '#15803D', potBrown: '#92400E',
};

// ===================================================================
// IMAGE LOADER
// ===================================================================

const imageCache = new Map();
const loadPromises = new Map();

function getImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  if (loadPromises.has(url)) return null;
  const img = new Image();
  const p = new Promise((resolve) => {
    img.onload = () => { imageCache.set(url, img); resolve(img); };
    img.onerror = () => { imageCache.set(url, false); resolve(false); };
  });
  loadPromises.set(url, p);
  img.src = url;
  return null;
}

function getCachedImage(url) {
  if (imageCache.has(url)) {
    const v = imageCache.get(url);
    return v === false ? null : v;
  }
  getImage(url);
  return null;
}

// Pre-load character sprites
for (let i = 0; i < 6; i++) getImage(`assets/characters/char_${i}.png`);
// Pre-load floor tiles
for (let i = 0; i < 9; i++) getImage(`assets/floors/floor_${i}.png`);
// Pre-load wall
getImage('assets/walls/wall_0.png');

// Furniture definitions
const FURNITURE_ITEMS = {
  desk:            { dir: 'DESK', file: 'DESK_FRONT.png', w: 48, h: 32 },
  chair:           { dir: 'CUSHIONED_CHAIR', file: 'CUSHIONED_CHAIR_BACK.png', w: 16, h: 16 },
  pcOn1:           { dir: 'PC', file: 'PC_FRONT_ON_1.png', w: 16, h: 32 },
  pcOn2:           { dir: 'PC', file: 'PC_FRONT_ON_2.png', w: 16, h: 32 },
  pcOn3:           { dir: 'PC', file: 'PC_FRONT_ON_3.png', w: 16, h: 32 },
  pcOff:           { dir: 'PC', file: 'PC_FRONT_OFF.png', w: 16, h: 32 },
  plant:           { dir: 'PLANT', file: 'PLANT.png', w: 16, h: 32 },
  plant2:          { dir: 'PLANT_2', file: 'PLANT_2.png', w: 16, h: 32 },
  largePlant:      { dir: 'LARGE_PLANT', file: 'LARGE_PLANT.png', w: 16, h: 48 },
  coffee:          { dir: 'COFFEE', file: 'COFFEE.png', w: 16, h: 16 },
  bookshelf:       { dir: 'BOOKSHELF', file: 'BOOKSHELF.png', w: 16, h: 48 },
  clock:           { dir: 'CLOCK', file: 'CLOCK.png', w: 16, h: 32 },
  cactus:          { dir: 'CACTUS', file: 'CACTUS.png', w: 16, h: 32 },
  whiteboard:      { dir: 'WHITEBOARD', file: 'WHITEBOARD.png', w: 48, h: 48 },
  smallPainting:   { dir: 'SMALL_PAINTING', file: 'SMALL_PAINTING.png', w: 16, h: 16 },
  smallPainting2:  { dir: 'SMALL_PAINTING_2', file: 'SMALL_PAINTING_2.png', w: 16, h: 16 },
  largePainting:   { dir: 'LARGE_PAINTING', file: 'LARGE_PAINTING.png', w: 32, h: 32 },
  pot:             { dir: 'POT', file: 'POT.png', w: 16, h: 16 },
  bin:             { dir: 'BIN', file: 'BIN.png', w: 16, h: 16 },
  doubleBookshelf: { dir: 'DOUBLE_BOOKSHELF', file: 'DOUBLE_BOOKSHELF.png', w: 32, h: 48 },
  hangingPlant:    { dir: 'HANGING_PLANT', file: 'HANGING_PLANT.png', w: 16, h: 16 },
  coffeeTable:     { dir: 'COFFEE_TABLE', file: 'COFFEE_TABLE.png', w: 16, h: 16 },
  smallTable:      { dir: 'SMALL_TABLE', file: 'SMALL_TABLE_FRONT.png', w: 32, h: 16 },
  tableFront:      { dir: 'TABLE_FRONT', file: 'TABLE_FRONT.png', w: 48, h: 32 },
  sofa:            { dir: 'SOFA', file: 'SOFA_FRONT.png', w: 32, h: 16 },
  sofaBack:        { dir: 'SOFA', file: 'SOFA_BACK.png', w: 32, h: 16 },
  sofaSide:        { dir: 'SOFA', file: 'SOFA_SIDE.png', w: 16, h: 32 },
  cushionedBench:  { dir: 'CUSHIONED_BENCH', file: 'CUSHIONED_BENCH.png', w: 32, h: 16 },
  woodenBench:     { dir: 'WOODEN_BENCH', file: 'WOODEN_BENCH.png', w: 32, h: 16 },
  woodenChairSide: { dir: 'WOODEN_CHAIR', file: 'WOODEN_CHAIR_SIDE.png', w: 16, h: 16 },
  pcSide:          { dir: 'PC', file: 'PC_SIDE.png', w: 16, h: 32 },
  pcBack:          { dir: 'PC', file: 'PC_BACK.png', w: 16, h: 32 },
  smallTableSide:  { dir: 'SMALL_TABLE', file: 'SMALL_TABLE_SIDE.png', w: 16, h: 16 },
};

// Pre-load all furniture
for (const info of Object.values(FURNITURE_ITEMS)) {
  getImage(`assets/furniture/${info.dir}/${info.file}`);
}

// ===================================================================
// CHARACTER SPRITES
// ===================================================================

// Coworker type → character palette index (0-5)
const TYPE_CHAR_INDEX = {
  'slang-base': 0, 'slang-ir': 1, 'slang-frontend': 2,
  'slang-cuda': 3, 'slang-optix': 4, 'slang-langfeat': 5,
  'slang-docs': 0, 'slang-coverage': 1, 'slang-test': 2,
  'main': 3, 'unknown': 0,
};

// Frame column indices per animation state
const ANIM_FRAMES = {
  idle:     [1],            // standing
  sitting:  [3],            // static seated (type1)
  walking:  [0, 1, 2, 1],  // walk cycle
  working:  [3, 4],         // typing
  thinking: [5, 6],         // reading
  reading:  [5, 6],
  error:    [1],
};

// Row indices: front=0, back=1, side=2
const DIRECTION_ROW = { front: 0, back: 1, side: 2 };

// Palettes for type identification
const TYPE_PALETTES = {
  'slang-base':     { shirt: '#5B8DEF', pants: '#3B5998', hair: '#4A3728' },
  'slang-ir':       { shirt: '#3B82F6', pants: '#1E40AF', hair: '#1a1a2e' },
  'slang-frontend': { shirt: '#10B981', pants: '#065F46', hair: '#92400E' },
  'slang-cuda':     { shirt: '#F59E0B', pants: '#92400E', hair: '#1a1a2e' },
  'slang-optix':    { shirt: '#EF4444', pants: '#991B1B', hair: '#4A3728' },
  'slang-langfeat': { shirt: '#8B5CF6', pants: '#5B21B6', hair: '#78350F' },
  'slang-docs':     { shirt: '#EC4899', pants: '#9D174D', hair: '#F59E0B' },
  'slang-coverage': { shirt: '#14B8A6', pants: '#115E59', hair: '#4A3728' },
  'slang-test':     { shirt: '#F97316', pants: '#9A3412', hair: '#1a1a2e' },
  'main':           { shirt: '#6366F1', pants: '#3730A3', hair: '#78350F' },
  'unknown':        { shirt: '#6B7280', pants: '#374151', hair: '#4A3728' },
};

// Extract a single frame from a character sprite sheet
const charFrameCache = new Map();
function extractCharFrame(sheet, col, row) {
  const key = `${sheet.src}-${col}-${row}`;
  if (charFrameCache.has(key)) return charFrameCache.get(key);
  const c = document.createElement('canvas');
  c.width = CHAR_FRAME_W; c.height = CHAR_FRAME_H;
  const ctx = c.getContext('2d');
  ctx.drawImage(sheet, col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H, 0, 0, CHAR_FRAME_W, CHAR_FRAME_H);
  charFrameCache.set(key, c);
  return c;
}

/**
 * Get character frame by type/status.
 * Returns canvas or null if sheet not loaded.
 */
function getCharacterFrame(type, frame, status, direction) {
  const charIdx = TYPE_CHAR_INDEX[type] ?? 0;
  const sheet = getCachedImage(`assets/characters/char_${charIdx}.png`);
  if (!sheet) return null;
  const frames = ANIM_FRAMES[status] || ANIM_FRAMES.idle;
  const animIdx = Math.floor(frame / 8) % frames.length;
  const col = frames[animIdx];
  const dirKey = direction === 'left' || direction === 'right' ? 'side' : direction;
  const row = DIRECTION_ROW[dirKey] ?? 0;
  return extractCharFrame(sheet, col, row);
}

/**
 * Get character frame by index/status/frameNum directly.
 */
function getCharFrame(charIndex, status, direction, frameNum) {
  const sheet = getCachedImage(`assets/characters/char_${charIndex % 6}.png`);
  if (!sheet) return null;
  const frames = ANIM_FRAMES[status] || ANIM_FRAMES.idle;
  const col = frames[frameNum % frames.length];
  const dirKey = direction === 'left' || direction === 'right' ? 'side' : direction;
  const row = DIRECTION_ROW[dirKey] ?? 0;
  return extractCharFrame(sheet, col, row);
}

// ===================================================================
// ZOOM CACHE
// ===================================================================

const zoomCache = new Map();

/** Draw a sprite at zoom level, caching the result. */
function getCached(source, zoom) {
  if (!source) return null;
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  if (!sw || !sh) return source;
  const key = `${source.src || ''}-${sw}x${sh}-${zoom}`;
  if (zoomCache.has(key)) return zoomCache.get(key);
  const c = document.createElement('canvas');
  c.width = sw * zoom; c.height = sh * zoom;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, c.width, c.height);
  zoomCache.set(key, c);
  return c;
}

// ===================================================================
// OUTLINE SPRITE (hover highlight)
// ===================================================================

const outlineCache = new Map();

/** Generate a 1px white outline around opaque pixels. */
function getOutlineSprite(source, zoom) {
  if (!source) return null;
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  if (!sw || !sh) return null;
  const key = `outline-${source.src || ''}-${sw}x${sh}-${zoom}`;
  if (outlineCache.has(key)) return outlineCache.get(key);

  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(source, 0, 0);
  const data = tctx.getImageData(0, 0, sw, sh).data;

  const ow = sw + 2, oh = sh + 2;
  const c = document.createElement('canvas');
  c.width = ow * zoom; c.height = oh * zoom;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (data[(y * sw + x) * 4 + 3] > 16) continue;
      const chk = (cx, cy) => cx >= 0 && cy >= 0 && cx < sw && cy < sh && data[(cy * sw + cx) * 4 + 3] > 16;
      if (chk(x - 1, y) || chk(x + 1, y) || chk(x, y - 1) || chk(x, y + 1)) {
        ctx.fillRect((x + 1) * zoom, (y + 1) * zoom, zoom, zoom);
      }
    }
  }
  outlineCache.set(key, c);
  return c;
}

// ===================================================================
// PUBLIC API
// ===================================================================

function getFloorTile(v) { return getCachedImage(`assets/floors/floor_${v % 9}.png`); }
function getWallImage() { return getCachedImage('assets/walls/wall_0.png'); }

function getFurniture(key) {
  const info = FURNITURE_ITEMS[key];
  return info ? getCachedImage(`assets/furniture/${info.dir}/${info.file}`) : null;
}

function getFurnitureInfo(key) { return FURNITURE_ITEMS[key] || null; }

function getPcFrame(frame) {
  const idx = Math.floor(frame / 12) % 3;
  return getCachedImage(`assets/furniture/PC/PC_FRONT_ON_${idx + 1}.png`);
}

function getCharacterSprite(type, color, frame, status, direction) {
  return getCharacterFrame(type, frame, status, direction || 'front');
}

function shadeColor(hex, amt) {
  hex = hex.replace('#', '');
  let [r, g, b] = [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function assetsReady() {
  return getCachedImage('assets/characters/char_0.png') !== null &&
         getCachedImage('assets/floors/floor_0.png') !== null;
}

// ===================================================================
// FLOOR TILE COLORIZATION (pixel-agents style HSL colorization)
// ===================================================================

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

const colorizedCache = new Map();

/** Colorize a floor tile PNG using HSL params {h, s, b, c}. Returns canvas or null. */
function colorizeTile(tileType, hsbc) {
  if (!hsbc) return null;
  const { h, s, b, c } = hsbc;
  const key = `ct-${tileType}-${h}-${s}-${b}-${c}`;
  if (colorizedCache.has(key)) return colorizedCache.get(key);

  const floorImg = getFloorTile(tileType);
  if (!floorImg) return null;
  const sw = floorImg.naturalWidth || floorImg.width;
  const sh = floorImg.naturalHeight || floorImg.height;
  if (!sw || !sh) return null;

  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(floorImg, 0, 0);
  const imgData = tctx.getImageData(0, 0, sw, sh);
  const data = imgData.data;

  // First pass: average luminance of opaque pixels (for filling transparent gaps)
  let totalLum = 0, opaqueN = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 32) {
      totalLum += 0.299 * data[i] / 255 + 0.587 * data[i + 1] / 255 + 0.114 * data[i + 2] / 255;
      opaqueN++;
    }
  }
  const avgLum = opaqueN > 0 ? totalLum / opaqueN : 0.5;

  // Second pass: colorize all pixels
  for (let i = 0; i < data.length; i += 4) {
    let lum;
    if (data[i + 3] > 32) {
      lum = 0.299 * data[i] / 255 + 0.587 * data[i + 1] / 255 + 0.114 * data[i + 2] / 255;
    } else {
      lum = avgLum; // transparent → use average so it blends seamlessly
    }
    lum = 0.5 + (lum - 0.5) * ((100 + c) / 100);
    lum = lum + b / 200;
    lum = Math.max(0, Math.min(1, lum));
    const [nr, ng, nb] = hslToRgb(h / 360, s / 100, lum);
    data[i] = nr; data[i + 1] = ng; data[i + 2] = nb; data[i + 3] = 255;
  }

  tctx.putImageData(imgData, 0, 0);
  colorizedCache.set(key, tmp);
  return tmp;
}

window.PixelSprites = {
  TILE, CHAR_FRAME_W, CHAR_FRAME_H, ZOOM,
  PALETTE, TYPE_PALETTES, TYPE_CHAR_INDEX,
  FURNITURE_ITEMS, ANIM_FRAMES, DIRECTION_ROW,

  getCharacterSprite,
  getCharacterFrame,
  getCharFrame,
  getFloorSprite: getFloorTile,
  getFloorTile,
  getFurniture,
  getFurnitureInfo,
  getPcFrame,
  getWallImage,
  getCached,
  getOutlineSprite,

  shadeColor,
  assetsReady,
  colorizeTile,
};
