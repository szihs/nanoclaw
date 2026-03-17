/**
 * Pixel Art Sprite Engine — RPG-style warm office aesthetic
 *
 * Inspired by Pixel Agents (pablodelucca/pixel-agents).
 * Procedural generation — no external sprite sheets needed.
 *
 * Characters: 16x24 (16 wide, 24 tall for body+head proportion)
 * Tiles: 16x16 floor/wall tiles
 * Furniture: multi-tile pieces
 *
 * All rendered at integer zoom for pixel-perfect display.
 */

const TILE = 16;
const CHAR_W = 16;
const CHAR_H = 24; // taller characters for RPG proportions
const ZOOM = 3;    // 3x zoom → 48x72 rendered characters

// --- Color palette (warm RPG office) ---
const PALETTE = {
  // Floor
  woodLight:  '#C4956A',
  woodMid:    '#A67B52',
  woodDark:   '#8B6239',
  woodLine:   '#755030',
  // Walls
  wallTop:    '#8899AA',
  wallFace:   '#6B7B8D',
  wallDark:   '#556677',
  wallTrim:   '#4A5A6A',
  // Skin
  skin:       '#FFDBB4',
  skinShade:  '#E8C49B',
  // Furniture
  deskTop:    '#D4A574',
  deskFront:  '#A67B52',
  deskLeg:    '#8B6239',
  chairBack:  '#5B6B7B',
  chairSeat:  '#6B7B8B',
  monitorBez: '#2D3748',
  monitorScr: '#1A2332',
  screenGlow: '#4ADE80',
  // Misc
  plantGreen: '#22C55E',
  plantDark:  '#15803D',
  potBrown:   '#92400E',
  mugWhite:   '#E2E8F0',
  mugCoffee:  '#78350F',
  bookRed:    '#DC2626',
  bookBlue:   '#2563EB',
  paperWhite: '#F1F5F9',
};

// --- Offscreen canvas helper ---
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function px(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// --- Color manipulation ---
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  return [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

function shadeColor(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + amt, g + amt, b + amt);
}

function hueShift(hex, degrees) {
  let [r, g, b] = hexToRgb(hex);
  // Simple hue rotation via HSL
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  h = (h + degrees / 360) % 1;
  if (h < 0) h += 1;
  // HSL to RGB
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return rgbToHex(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

// ===================================================================
// TILE GENERATION
// ===================================================================

const tileCache = new Map();

function generateFloorTile(variant = 0) {
  const key = `floor-${variant}`;
  if (tileCache.has(key)) return tileCache.get(key);

  const c = makeCanvas(TILE, TILE);
  const ctx = c.getContext('2d');

  // Wooden planks
  rect(ctx, 0, 0, TILE, TILE, PALETTE.woodMid);

  // Plank lines (horizontal)
  for (let y = 0; y < TILE; y += 4) {
    rect(ctx, 0, y, TILE, 1, PALETTE.woodLine + '40');
  }

  // Plank variation
  if (variant % 3 === 0) {
    rect(ctx, 7, 0, 1, TILE, PALETTE.woodLine + '30');
  } else if (variant % 3 === 1) {
    rect(ctx, 4, 0, 1, TILE, PALETTE.woodLine + '30');
    rect(ctx, 11, 0, 1, TILE, PALETTE.woodLine + '30');
  }

  // Subtle grain
  for (let i = 0; i < 6; i++) {
    const gx = (variant * 7 + i * 3) % TILE;
    const gy = (variant * 5 + i * 4) % TILE;
    px(ctx, gx, gy, PALETTE.woodLight + '30');
  }

  tileCache.set(key, c);
  return c;
}

function generateWallTile(hasTop = true) {
  const key = `wall-${hasTop}`;
  if (tileCache.has(key)) return tileCache.get(key);

  const c = makeCanvas(TILE, TILE + 8); // wall extends 8px above
  const ctx = c.getContext('2d');

  // Wall face (3D depth)
  rect(ctx, 0, 0, TILE, 8, PALETTE.wallTop);
  rect(ctx, 0, 8, TILE, TILE, PALETTE.wallFace);

  // Trim line
  rect(ctx, 0, 7, TILE, 2, PALETTE.wallTrim);

  // Brick-like pattern
  for (let y = 10; y < TILE + 8; y += 4) {
    const offset = ((y / 4) % 2) * 5;
    for (let x = offset; x < TILE; x += 10) {
      rect(ctx, x, y, 8, 3, PALETTE.wallDark + '30');
    }
  }

  // Baseboard
  rect(ctx, 0, TILE + 6, TILE, 2, PALETTE.wallDark);

  tileCache.set(key, c);
  return c;
}

// ===================================================================
// FURNITURE GENERATION
// ===================================================================

function generateDesk() {
  const key = 'desk';
  if (tileCache.has(key)) return tileCache.get(key);

  // 2 tiles wide, 1 tile tall
  const c = makeCanvas(32, 20);
  const ctx = c.getContext('2d');

  // Desktop surface (top-down perspective with slight 3D)
  rect(ctx, 0, 4, 32, 3, PALETTE.deskTop);
  rect(ctx, 0, 2, 32, 2, shadeColor(PALETTE.deskTop, 20));

  // Front face
  rect(ctx, 0, 7, 32, 10, PALETTE.deskFront);
  rect(ctx, 1, 8, 30, 8, shadeColor(PALETTE.deskFront, -10));

  // Drawer
  rect(ctx, 20, 9, 9, 6, shadeColor(PALETTE.deskFront, 10));
  px(ctx, 24, 12, PALETTE.deskLeg);

  // Legs
  rect(ctx, 1, 17, 2, 3, PALETTE.deskLeg);
  rect(ctx, 29, 17, 2, 3, PALETTE.deskLeg);

  tileCache.set(key, c);
  return c;
}

function generateChair(color) {
  const key = `chair-${color}`;
  if (tileCache.has(key)) return tileCache.get(key);

  const c = makeCanvas(12, 18);
  const ctx = c.getContext('2d');

  // Chair back
  rect(ctx, 1, 0, 10, 8, color);
  rect(ctx, 2, 1, 8, 6, shadeColor(color, 20));

  // Seat
  rect(ctx, 0, 8, 12, 4, shadeColor(color, -10));

  // Legs
  rect(ctx, 1, 12, 2, 6, '#4A5568');
  rect(ctx, 9, 12, 2, 6, '#4A5568');

  // Wheels
  px(ctx, 0, 17, '#374151');
  px(ctx, 11, 17, '#374151');

  tileCache.set(key, c);
  return c;
}

function generateMonitor(glowColor) {
  const key = `monitor-${glowColor}`;
  if (tileCache.has(key)) return tileCache.get(key);

  const c = makeCanvas(14, 14);
  const ctx = c.getContext('2d');

  // Bezel
  rect(ctx, 0, 0, 14, 10, PALETTE.monitorBez);
  // Screen
  rect(ctx, 1, 1, 12, 8, PALETTE.monitorScr);
  // Stand
  rect(ctx, 5, 10, 4, 2, '#4A5568');
  rect(ctx, 3, 12, 8, 2, '#4A5568');

  // Screen glow
  rect(ctx, 2, 2, 10, 6, glowColor + '20');

  tileCache.set(key, c);
  return c;
}

function generatePlant() {
  const key = 'plant';
  if (tileCache.has(key)) return tileCache.get(key);

  const c = makeCanvas(12, 18);
  const ctx = c.getContext('2d');

  // Pot
  rect(ctx, 2, 11, 8, 7, PALETTE.potBrown);
  rect(ctx, 3, 10, 6, 1, shadeColor(PALETTE.potBrown, 20));

  // Leaves
  rect(ctx, 3, 6, 6, 5, PALETTE.plantGreen);
  rect(ctx, 1, 4, 10, 3, PALETTE.plantGreen);
  rect(ctx, 4, 2, 4, 3, PALETTE.plantDark);
  px(ctx, 5, 1, PALETTE.plantGreen);
  px(ctx, 7, 0, PALETTE.plantGreen);
  // Leaf highlights
  px(ctx, 4, 4, shadeColor(PALETTE.plantGreen, 30));
  px(ctx, 8, 5, shadeColor(PALETTE.plantGreen, 30));

  tileCache.set(key, c);
  return c;
}

function generateCoffeeMug() {
  const key = 'mug';
  if (tileCache.has(key)) return tileCache.get(key);

  const c = makeCanvas(6, 6);
  const ctx = c.getContext('2d');

  rect(ctx, 0, 1, 4, 5, PALETTE.mugWhite);
  rect(ctx, 1, 2, 2, 2, PALETTE.mugCoffee);
  // Handle
  px(ctx, 4, 2, PALETTE.mugWhite);
  px(ctx, 5, 3, PALETTE.mugWhite);
  px(ctx, 4, 4, PALETTE.mugWhite);
  // Steam
  px(ctx, 1, 0, '#ffffff40');

  tileCache.set(key, c);
  return c;
}

function generateBookStack() {
  const key = 'books';
  if (tileCache.has(key)) return tileCache.get(key);

  const c = makeCanvas(8, 8);
  const ctx = c.getContext('2d');

  rect(ctx, 0, 5, 7, 3, PALETTE.bookRed);
  rect(ctx, 1, 2, 6, 3, PALETTE.bookBlue);
  rect(ctx, 0, 0, 7, 2, '#F59E0B');

  tileCache.set(key, c);
  return c;
}

function generatePapers() {
  const key = 'papers';
  if (tileCache.has(key)) return tileCache.get(key);

  const c = makeCanvas(8, 6);
  const ctx = c.getContext('2d');

  rect(ctx, 1, 1, 6, 5, PALETTE.paperWhite);
  rect(ctx, 0, 0, 6, 5, PALETTE.paperWhite);
  // Text lines
  rect(ctx, 1, 1, 4, 1, '#CBD5E1');
  rect(ctx, 1, 3, 3, 1, '#CBD5E1');

  tileCache.set(key, c);
  return c;
}

// ===================================================================
// CHARACTER GENERATION
// ===================================================================

// Type-to-color mapping with warm, distinct palettes
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

const ACCESSORY_MAP = {
  'slang-ir': 'glasses',
  'slang-frontend': 'headphones',
  'slang-cuda': 'lightning',
  'slang-optix': 'goggles',
  'slang-langfeat': 'pencil',
  'slang-docs': 'book',
  'slang-coverage': 'chart',
  'slang-test': 'flask',
  'main': 'crown',
};

/**
 * Generate character frame.
 * States: idle, walk (frame 0-3), typing (frame 0-1), reading
 */
function generateCharacter(type, color, frame, status) {
  const c = makeCanvas(CHAR_W, CHAR_H);
  const ctx = c.getContext('2d');

  const pal = TYPE_PALETTES[type] || TYPE_PALETTES['unknown'];
  const isWalking = status === 'walking';
  const isWorking = status === 'working';
  const isThinking = status === 'thinking';
  const isSitting = isWorking || isThinking || status === 'reading';

  // Animation offsets
  const walkBob = isWalking ? Math.sin(frame * 0.4) * 1 : 0;
  const typeBob = isWorking ? Math.sin(frame * 0.6) * 0.5 : 0;
  const armFrame = isWorking ? Math.floor(frame / 4) % 2 : 0;
  const legFrame = isWalking ? Math.floor(frame / 3) % 4 : 0;
  const breathe = Math.sin(frame * 0.08) * 0.3;

  const baseY = isSitting ? 2 : 0; // shift down when sitting
  const y0 = Math.round(baseY + walkBob);

  // --- Hair / Head top ---
  rect(ctx, 5, y0 + 0, 6, 3, pal.hair);
  px(ctx, 4, y0 + 1, pal.hair);
  px(ctx, 11, y0 + 1, pal.hair);

  // --- Face ---
  rect(ctx, 5, y0 + 3, 6, 5, PALETTE.skin);
  rect(ctx, 4, y0 + 3, 1, 4, PALETTE.skin);
  rect(ctx, 11, y0 + 3, 1, 4, PALETTE.skin);

  // Eyes
  const blink = frame % 40 < 2;
  if (!blink) {
    px(ctx, 6, y0 + 5, '#1a1a2e');
    px(ctx, 9, y0 + 5, '#1a1a2e');
    // Eye whites
    px(ctx, 6, y0 + 4, '#ffffff80');
    px(ctx, 9, y0 + 4, '#ffffff80');
  }

  // Mouth
  if (status === 'error') {
    px(ctx, 7, y0 + 7, '#DC2626');
    px(ctx, 8, y0 + 7, '#DC2626');
  } else if (isWorking) {
    px(ctx, 7, y0 + 7, PALETTE.skinShade);
  } else {
    px(ctx, 7, y0 + 7, '#C0846A');
    px(ctx, 8, y0 + 7, '#C0846A');
  }

  // --- Torso ---
  const torsoY = y0 + 8;
  rect(ctx, 4, torsoY, 8, 5, pal.shirt);
  // Collar
  px(ctx, 6, torsoY, shadeColor(pal.shirt, 30));
  px(ctx, 7, torsoY, PALETTE.skin);
  px(ctx, 8, torsoY, PALETTE.skin);
  px(ctx, 9, torsoY, shadeColor(pal.shirt, 30));
  // Shirt shading
  rect(ctx, 4, torsoY + 3, 2, 2, shadeColor(pal.shirt, -20));
  rect(ctx, 10, torsoY + 3, 2, 2, shadeColor(pal.shirt, -20));

  // --- Arms ---
  if (isWorking && armFrame === 0) {
    // Typing pose — arms forward
    rect(ctx, 2, torsoY + 1, 2, 4, pal.shirt);
    rect(ctx, 12, torsoY + 1, 2, 4, pal.shirt);
    // Hands forward
    px(ctx, 2, torsoY + 5, PALETTE.skin);
    px(ctx, 13, torsoY + 5, PALETTE.skin);
  } else if (isWorking && armFrame === 1) {
    // Typing pose — arms slightly moved
    rect(ctx, 2, torsoY + 2, 2, 3, pal.shirt);
    rect(ctx, 12, torsoY + 2, 2, 3, pal.shirt);
    px(ctx, 2, torsoY + 5, PALETTE.skin);
    px(ctx, 13, torsoY + 5, PALETTE.skin);
  } else {
    // Normal arms
    rect(ctx, 3, torsoY + 1, 1, 4, pal.shirt);
    rect(ctx, 12, torsoY + 1, 1, 4, pal.shirt);
    // Hands
    px(ctx, 3, torsoY + 5, PALETTE.skin);
    px(ctx, 12, torsoY + 5, PALETTE.skin);
  }

  // --- Legs ---
  const legY = torsoY + 5;
  if (isSitting) {
    // Sitting legs (bent forward)
    rect(ctx, 5, legY, 2, 3, pal.pants);
    rect(ctx, 9, legY, 2, 3, pal.pants);
    // Feet forward
    rect(ctx, 5, legY + 3, 2, 1, '#4A3728');
    rect(ctx, 9, legY + 3, 2, 1, '#4A3728');
  } else if (isWalking) {
    // Walk animation (4 frames)
    const offsets = [[0, 0], [1, -1], [0, 0], [-1, 1]];
    const [oL, oR] = offsets[legFrame];
    rect(ctx, 5 + oL, legY, 2, 5, pal.pants);
    rect(ctx, 9 + oR, legY, 2, 5, pal.pants);
    // Shoes
    rect(ctx, 5 + oL, legY + 5, 2, 1, '#4A3728');
    rect(ctx, 9 + oR, legY + 5, 2, 1, '#4A3728');
  } else {
    // Standing
    rect(ctx, 5, legY, 2, 5, pal.pants);
    rect(ctx, 9, legY, 2, 5, pal.pants);
    rect(ctx, 5, legY + 5, 2, 1, '#4A3728');
    rect(ctx, 9, legY + 5, 2, 1, '#4A3728');
  }

  // --- Accessory ---
  const acc = ACCESSORY_MAP[type];
  if (acc) drawCharAccessory(ctx, acc, y0, pal, frame);

  // --- Status effects ---
  if (status === 'error' && frame % 10 < 5) {
    // Red exclamation
    px(ctx, 14, y0, '#EF4444');
    px(ctx, 14, y0 + 1, '#EF4444');
    px(ctx, 14, y0 + 3, '#EF4444');
  }

  if (isThinking) {
    // Thinking dots
    const phase = Math.floor(frame / 10) % 4;
    for (let i = 0; i < phase && i < 3; i++) {
      px(ctx, 13 + i, y0 + 1, '#F59E0B');
    }
  }

  if (isWorking) {
    // Sparkle particles near hands
    if (frame % 6 < 3) {
      const sx = 1 + (frame % 4);
      px(ctx, sx, torsoY + 4, color + '80');
    }
  }

  return c;
}

function drawCharAccessory(ctx, acc, y0, pal, frame) {
  switch (acc) {
    case 'glasses':
      rect(ctx, 5, y0 + 4, 3, 2, '#333333');
      rect(ctx, 8, y0 + 4, 3, 2, '#333333');
      px(ctx, 7, y0 + 4, '#333333');
      break;
    case 'headphones':
      px(ctx, 3, y0 + 3, '#333333');
      px(ctx, 3, y0 + 4, '#EF4444');
      px(ctx, 12, y0 + 3, '#333333');
      px(ctx, 12, y0 + 4, '#EF4444');
      rect(ctx, 4, y0, 8, 1, '#333333');
      break;
    case 'lightning':
      px(ctx, 14, y0 + 5, '#FCD34D');
      px(ctx, 13, y0 + 6, '#FCD34D');
      px(ctx, 14, y0 + 6, '#FCD34D');
      px(ctx, 14, y0 + 7, '#FCD34D');
      px(ctx, 15, y0 + 7, '#FCD34D');
      break;
    case 'goggles':
      rect(ctx, 4, y0 + 4, 4, 2, '#DC2626');
      rect(ctx, 8, y0 + 4, 4, 2, '#DC2626');
      px(ctx, 5, y0 + 4, '#FCA5A5');
      px(ctx, 9, y0 + 4, '#FCA5A5');
      break;
    case 'pencil':
      px(ctx, 13, y0 + 3, '#FCD34D');
      px(ctx, 14, y0 + 4, '#FCD34D');
      px(ctx, 15, y0 + 5, '#1a1a2e');
      break;
    case 'book':
      rect(ctx, 0, y0 + 9, 3, 4, '#8B5CF6');
      break;
    case 'chart':
      px(ctx, 14, y0 + 8, '#10B981');
      px(ctx, 14, y0 + 7, '#10B981');
      px(ctx, 15, y0 + 7, '#F59E0B');
      px(ctx, 15, y0 + 6, '#F59E0B');
      break;
    case 'flask':
      px(ctx, 14, y0 + 7, '#E2E8F0');
      px(ctx, 13, y0 + 8, '#10B981');
      px(ctx, 14, y0 + 8, '#10B981');
      px(ctx, 15, y0 + 8, '#10B981');
      break;
    case 'crown':
      px(ctx, 5, y0 - 1, '#FCD34D');
      px(ctx, 7, y0 - 1, '#FCD34D');
      px(ctx, 9, y0 - 1, '#FCD34D');
      rect(ctx, 5, y0, 5, 1, '#FCD34D');
      break;
  }
}

// ===================================================================
// SCREEN CONTENT ANIMATION (for monitors)
// ===================================================================

function generateScreenContent(ctx, x, y, w, h, frame, type) {
  // Code-like lines scrolling
  ctx.fillStyle = '#22C55E30';
  const lineH = 2;
  const numLines = Math.floor(h / (lineH + 1));
  for (let i = 0; i < numLines; i++) {
    const lineW = (3 + ((frame * 0.5 + i * 7) % (w - 4))) | 0;
    const lineY = y + i * (lineH + 1);
    const color = i % 3 === 0 ? '#22C55E40' : i % 3 === 1 ? '#3B82F640' : '#F59E0B30';
    ctx.fillStyle = color;
    ctx.fillRect(x + 1, lineY, lineW, lineH);
  }
}

// ===================================================================
// EXPORT
// ===================================================================

window.PixelSprites = {
  TILE,
  CHAR_W,
  CHAR_H,
  ZOOM,
  PALETTE,
  TYPE_PALETTES,
  ACCESSORY_MAP,
  generateFloorTile,
  generateWallTile,
  generateDesk,
  generateChair,
  generateMonitor,
  generatePlant,
  generateCoffeeMug,
  generateBookStack,
  generatePapers,
  generateCharacter,
  generateScreenContent,
  shadeColor,
  hueShift,
};
