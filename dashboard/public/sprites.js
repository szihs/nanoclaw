/**
 * NanoClaw Dashboard — Sprite Engine
 *
 * Uses Pixel Agents open-source assets (MIT, Pablo De Lucca 2026) as primary
 * sprites, with procedural Canvas 2D fallback when PNGs aren't loaded yet.
 *
 * Character sprites: 112x96 PNG (7 frames x 16px, 3 rows x 32px)
 *   Frame order: walk1, walk2, walk3, type1, type2, read1, read2
 *   Row order: front (0), back (1), side (2) — left is side flipped
 *
 * Floor tiles: 16x16 PNG (9 variants)
 * Wall tiles: 64x128 PNG (4x4 auto-tile grid, 16x32 each)
 * Furniture: Per-item PNGs with manifest.json
 */

const TILE = 16;
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES = 7;
const CHAR_ROWS = 3;
const ZOOM = 3;

// --- Palette for procedural fallback & color tinting ---
const PALETTE = {
  woodLight: '#C4956A', woodMid: '#A67B52', woodDark: '#8B6239', woodLine: '#755030',
  wallTop: '#8899AA', wallFace: '#6B7B8D', wallDark: '#556677', wallTrim: '#4A5A6A',
  skin: '#FFDBB4', skinShade: '#E8C49B',
  deskTop: '#D4A574', deskFront: '#A67B52', deskLeg: '#8B6239',
  monitorBez: '#2D3748', monitorScr: '#1A2332',
  plantGreen: '#22C55E', plantDark: '#15803D', potBrown: '#92400E',
};

// ===================================================================
// IMAGE ASSET LOADER
// ===================================================================

const imageCache = new Map();
const loadPromises = new Map();

/**
 * Load an image from URL. Returns cached Image or kicks off async load.
 * Returns null if not yet loaded (caller should use fallback).
 */
function getImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  if (loadPromises.has(url)) return null; // loading in progress

  const img = new Image();
  const promise = new Promise((resolve) => {
    img.onload = () => {
      imageCache.set(url, img);
      resolve(img);
    };
    img.onerror = () => {
      imageCache.set(url, false); // mark as failed
      resolve(false);
    };
  });
  loadPromises.set(url, promise);
  img.src = url;
  return null;
}

/**
 * Get a loaded image, or false if load failed, or null if still loading.
 */
function getCachedImage(url) {
  if (imageCache.has(url)) {
    const v = imageCache.get(url);
    return v === false ? null : v;
  }
  getImage(url); // trigger load
  return null;
}

// Pre-load all character sprites
const CHAR_SPRITES = [];
for (let i = 0; i < 6; i++) {
  getImage(`assets/characters/char_${i}.png`);
}

// Pre-load floor tiles
for (let i = 0; i < 9; i++) {
  getImage(`assets/floors/floor_${i}.png`);
}

// Pre-load wall
getImage('assets/walls/wall_0.png');

// Pre-load key furniture
const FURNITURE_ITEMS = {
  desk: { dir: 'DESK', file: 'DESK_FRONT.png', w: 48, h: 32 },
  chair: { dir: 'CUSHIONED_CHAIR', file: 'CUSHIONED_CHAIR_BACK.png', w: 16, h: 16 },
  pcOn1: { dir: 'PC', file: 'PC_FRONT_ON_1.png', w: 16, h: 32 },
  pcOn2: { dir: 'PC', file: 'PC_FRONT_ON_2.png', w: 16, h: 32 },
  pcOn3: { dir: 'PC', file: 'PC_FRONT_ON_3.png', w: 16, h: 32 },
  pcOff: { dir: 'PC', file: 'PC_FRONT_OFF.png', w: 16, h: 32 },
  plant: { dir: 'PLANT', file: 'PLANT.png', w: 16, h: 32 },
  plant2: { dir: 'PLANT_2', file: 'PLANT_2.png', w: 16, h: 32 },
  largePlant: { dir: 'LARGE_PLANT', file: 'LARGE_PLANT.png', w: 16, h: 48 },
  coffee: { dir: 'COFFEE', file: 'COFFEE.png', w: 16, h: 16 },
  bookshelf: { dir: 'BOOKSHELF', file: 'BOOKSHELF.png', w: 16, h: 48 },
  clock: { dir: 'CLOCK', file: 'CLOCK.png', w: 16, h: 16 },
  cactus: { dir: 'CACTUS', file: 'CACTUS.png', w: 16, h: 32 },
  whiteboard: { dir: 'WHITEBOARD', file: 'WHITEBOARD.png', w: 48, h: 48 },
  smallPainting: { dir: 'SMALL_PAINTING', file: 'SMALL_PAINTING.png', w: 16, h: 16 },
  smallPainting2: { dir: 'SMALL_PAINTING_2', file: 'SMALL_PAINTING_2.png', w: 16, h: 16 },
  largePainting: { dir: 'LARGE_PAINTING', file: 'LARGE_PAINTING.png', w: 32, h: 32 },
  pot: { dir: 'POT', file: 'POT.png', w: 16, h: 16 },
  bin: { dir: 'BIN', file: 'BIN.png', w: 16, h: 16 },
};

// Pre-load all furniture
for (const [key, info] of Object.entries(FURNITURE_ITEMS)) {
  getImage(`assets/furniture/${info.dir}/${info.file}`);
}

// ===================================================================
// CHARACTER SPRITE EXTRACTION
// ===================================================================

// Coworker type → character palette index (0-5)
const TYPE_CHAR_INDEX = {
  'slang-base': 0,
  'slang-ir': 1,
  'slang-frontend': 2,
  'slang-cuda': 3,
  'slang-optix': 4,
  'slang-langfeat': 5,
  'slang-docs': 0,     // reuse with hue shift
  'slang-coverage': 1,
  'slang-test': 2,
  'main': 3,
  'unknown': 0,
};

// Frame indices: walk1=0, walk2=1, walk3=2, type1=3, type2=4, read1=5, read2=6
const ANIM_FRAMES = {
  idle: [1, 1, 1, 1, 0, 1, 1, 1], // subtle head bob (occasional walk1 frame)
  walking: [0, 1, 2, 1],       // walk cycle
  working: [3, 4],              // typing
  thinking: [5, 6],             // reading
  reading: [5, 6],
  error: [1],                   // standing
};

// Row indices: front=0, back=1, side=2
const DIRECTION_ROW = { front: 0, back: 1, side: 2 };

/**
 * Extract a single frame from a character sprite sheet.
 * Returns a cached offscreen canvas of size CHAR_FRAME_W x CHAR_FRAME_H.
 */
const charFrameCache = new Map();
function extractCharFrame(spriteSheet, frameIdx, rowIdx) {
  const key = `${spriteSheet.src}-${frameIdx}-${rowIdx}`;
  if (charFrameCache.has(key)) return charFrameCache.get(key);

  const c = document.createElement('canvas');
  c.width = CHAR_FRAME_W;
  c.height = CHAR_FRAME_H;
  const ctx = c.getContext('2d');
  ctx.drawImage(
    spriteSheet,
    frameIdx * CHAR_FRAME_W, rowIdx * CHAR_FRAME_H,
    CHAR_FRAME_W, CHAR_FRAME_H,
    0, 0,
    CHAR_FRAME_W, CHAR_FRAME_H
  );
  charFrameCache.set(key, c);
  return c;
}

/**
 * Get character frame for the given state.
 * Returns a canvas/image to draw, or null for procedural fallback.
 */
function getCharacterFrame(type, frame, status) {
  const charIdx = TYPE_CHAR_INDEX[type] ?? 0;
  const sheet = getCachedImage(`assets/characters/char_${charIdx}.png`);
  if (!sheet) return null;

  const animFrames = ANIM_FRAMES[status] || ANIM_FRAMES.idle;
  const animIdx = Math.floor(frame / 8) % animFrames.length;
  const frameIdx = animFrames[animIdx];
  const rowIdx = DIRECTION_ROW.front; // default front-facing

  return extractCharFrame(sheet, frameIdx, rowIdx);
}

// ===================================================================
// TILE GETTERS (PNG with procedural fallback)
// ===================================================================

function getFloorTile(variant) {
  const img = getCachedImage(`assets/floors/floor_${variant % 9}.png`);
  if (img) return img;
  return generateFloorTileFallback(variant);
}

function getWallImage() {
  return getCachedImage('assets/walls/wall_0.png');
}

function getFurniture(key) {
  const info = FURNITURE_ITEMS[key];
  if (!info) return null;
  return getCachedImage(`assets/furniture/${info.dir}/${info.file}`);
}

function getFurnitureInfo(key) {
  return FURNITURE_ITEMS[key] || null;
}

// PC animation (3 frames when on)
function getPcFrame(frame) {
  const frameIdx = Math.floor(frame / 12) % 3;
  const key = `pcOn${frameIdx + 1}`;
  return getCachedImage(`assets/furniture/PC/PC_FRONT_ON_${frameIdx + 1}.png`);
}

// ===================================================================
// PROCEDURAL FALLBACKS
// ===================================================================

const fallbackCache = new Map();

function px(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function generateFloorTileFallback(variant) {
  const key = `floor-fb-${variant}`;
  if (fallbackCache.has(key)) return fallbackCache.get(key);

  const c = document.createElement('canvas');
  c.width = TILE; c.height = TILE;
  const ctx = c.getContext('2d');

  rect(ctx, 0, 0, TILE, TILE, PALETTE.woodMid);
  for (let y = 0; y < TILE; y += 4) {
    rect(ctx, 0, y, TILE, 1, PALETTE.woodLine + '40');
  }
  if (variant % 3 === 0) rect(ctx, 7, 0, 1, TILE, PALETTE.woodLine + '30');
  else if (variant % 3 === 1) {
    rect(ctx, 4, 0, 1, TILE, PALETTE.woodLine + '30');
    rect(ctx, 11, 0, 1, TILE, PALETTE.woodLine + '30');
  }

  fallbackCache.set(key, c);
  return c;
}

function generateDeskFallback() {
  const key = 'desk-fb';
  if (fallbackCache.has(key)) return fallbackCache.get(key);

  const c = document.createElement('canvas');
  c.width = 48; c.height = 32;
  const ctx = c.getContext('2d');
  rect(ctx, 0, 6, 48, 4, PALETTE.deskTop);
  rect(ctx, 0, 4, 48, 2, shadeColor(PALETTE.deskTop, 20));
  rect(ctx, 0, 10, 48, 16, PALETTE.deskFront);
  rect(ctx, 2, 26, 3, 6, PALETTE.deskLeg);
  rect(ctx, 43, 26, 3, 6, PALETTE.deskLeg);

  fallbackCache.set(key, c);
  return c;
}

function generateCharacterFallback(type, color, frame, status) {
  const c = document.createElement('canvas');
  c.width = CHAR_FRAME_W; c.height = CHAR_FRAME_H;
  const ctx = c.getContext('2d');

  const pal = TYPE_PALETTES[type] || TYPE_PALETTES['unknown'];
  const y0 = (status === 'working' || status === 'thinking') ? 4 : 2;

  // Head
  rect(ctx, 5, y0, 6, 7, PALETTE.skin);
  rect(ctx, 5, y0 - 2, 6, 3, pal.hair);
  // Eyes
  if (frame % 40 >= 2) { px(ctx, 6, y0 + 3, '#1a1a2e'); px(ctx, 9, y0 + 3, '#1a1a2e'); }
  // Body
  rect(ctx, 4, y0 + 7, 8, 6, pal.shirt);
  // Arms
  rect(ctx, 3, y0 + 8, 1, 4, pal.shirt);
  rect(ctx, 12, y0 + 8, 1, 4, pal.shirt);
  // Legs
  rect(ctx, 5, y0 + 13, 2, 5, pal.pants);
  rect(ctx, 9, y0 + 13, 2, 5, pal.pants);
  // Shoes
  rect(ctx, 5, y0 + 18, 2, 1, '#4A3728');
  rect(ctx, 9, y0 + 18, 2, 1, '#4A3728');

  return c;
}

// Type palettes for procedural fallback
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

// ===================================================================
// PUBLIC API
// ===================================================================

function shadeColor(hex, amt) {
  hex = hex.replace('#', '');
  let [r, g, b] = [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Get the best available character sprite for a coworker.
 * Returns a drawable (Image or Canvas).
 */
function getCharacterSprite(type, color, frame, status) {
  const pngFrame = getCharacterFrame(type, frame, status);
  if (pngFrame) return pngFrame;
  return generateCharacterFallback(type, color, frame, status);
}

/**
 * Get a floor tile (PNG or fallback).
 */
function getFloorSprite(variant) {
  return getFloorTile(variant);
}

/**
 * Get desk sprite (PNG or fallback).
 */
function getDeskSprite() {
  return getFurniture('desk') || generateDeskFallback();
}

/**
 * Draw animated screen content on monitor.
 */
function generateScreenContent(ctx, x, y, w, h, frame) {
  const lineH = 2;
  const numLines = Math.floor(h / (lineH + 1));
  for (let i = 0; i < numLines; i++) {
    const lineW = (3 + ((frame * 0.5 + i * 7) % (w - 4))) | 0;
    const lineY = y + i * (lineH + 1);
    const colors = ['#22C55E40', '#3B82F640', '#F59E0B30'];
    ctx.fillStyle = colors[i % 3];
    ctx.fillRect(x + 1, lineY, lineW, lineH);
  }
}

/**
 * Check if all critical assets have loaded.
 */
function assetsReady() {
  return getCachedImage('assets/characters/char_0.png') !== null &&
         getCachedImage('assets/floors/floor_0.png') !== null;
}

window.PixelSprites = {
  TILE,
  CHAR_FRAME_W,
  CHAR_FRAME_H,
  ZOOM,
  PALETTE,
  TYPE_PALETTES,
  TYPE_CHAR_INDEX,
  FURNITURE_ITEMS,

  // Core getters
  getCharacterSprite,
  getCharacterFrame,
  getFloorSprite,
  getDeskSprite,
  getFurniture,
  getFurnitureInfo,
  getPcFrame,
  getWallImage,

  // Utilities
  generateScreenContent,
  shadeColor,
  assetsReady,

  // Procedural fallbacks (still available)
  generateCharacterFallback,
  generateFloorTileFallback,
  generateDeskFallback,
};
