/**
 * Human-friendly labels for NanoClaw session ids.
 *
 * ESM module shipped as `<script type="module" src="session-slug.js">`.
 * Also attaches the helpers to `window.*` on load so legacy non-module
 * callers in app.js keep working; the module export path is what
 * vitest uses.
 *
 * Determinism contract: same session id always renders as the same slug.
 * Wordlists are exactly 64 entries each (6-bit indices from a single
 * 32-bit FNV-1a hash). Namespace 64^3 = 262,144 — plenty for any single
 * instance's lifetime. Entries are curated for neutrality (no political
 * / cultural / loaded terms), readability (no homophones), brevity.
 */

// prettier-ignore
export const ADJ = [
  'amber','ancient','azure','bold','brassy','brisk','bright','burnt',
  'calm','chalky','clear','coral','cozy','crimson','daring','dusky',
  'dusty','earthy','fleet','foggy','fresh','frosty','gentle','hollow',
  'icy','ivory','jade','lively','mossy','misty','nimble','olive',
  'pale','plush','quiet','ruddy','rugged','russet','rustic','sable',
  'sandy','silver','sleek','slow','smoky','snowy','soft','starry',
  'steady','still','stormy','sturdy','sunny','swift','tangled','teal',
  'tender','vivid','warm','wild','windy','winding','wooded','zesty',
];
// prettier-ignore
export const NOUN = [
  'anvil','atoll','bluff','bog','brook','canyon','cedar','copse',
  'cove','delta','dune','ember','estuary','fell','firth','fjord',
  'ford','forest','glade','glen','gorge','gulch','grove','harbor',
  'heath','henge','hollow','isle','knoll','lagoon','lake','marsh',
  'meadow','mesa','mire','moor','oasis','orchard','pass','plain',
  'pond','prairie','quarry','ravine','reach','reef','ridge','river',
  'slope','sound','spring','steppe','strait','strand','summit','swale',
  'thicket','tundra','valley','wadi','wash','willow','wold','yard',
];
// prettier-ignore
export const VERB = [
  'arches','bends','breathes','carves','cascades','chimes','circles','climbs',
  'coasts','coils','crests','dances','dives','drifts','drums','eddies',
  'echoes','flickers','floats','flows','flutters','gathers','glides','glimmers',
  'glows','hovers','hums','kindles','leaps','lifts','lingers','listens',
  'meanders','mends','murmurs','nestles','pauses','pulses','rambles','reaches',
  'rests','ripples','rolls','rustles','scatters','settles','shifts','shimmers',
  'shines','sings','skims','slides','spins','spirals','sprouts','stills',
  'sways','tends','turns','wakes','waits','weaves','whispers','winds',
];

/** FNV-1a 32-bit hash. Deterministic; ~2 ns/call on modern hardware. */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Three-word slug from any string id — "dusky-meadow-drifts" style.
 * Same input → same output, forever.
 */
export function sessionSlug(id) {
  if (!id) return 'unknown';
  const h = fnv1a(String(id));
  return `${ADJ[h & 63]}-${NOUN[(h >>> 6) & 63]}-${VERB[(h >>> 12) & 63]}`;
}

/**
 * Full label with the session kind prefix. Pass the NanoClaw session id
 * as the first arg; the second controls the prefix:
 *
 *   sessionLabel('sess-abc', null)  → "main · dusky-meadow-drifts"
 *   sessionLabel('sess-abc', 'msg-xyz') → "thread · dusky-meadow-drifts"
 *
 * The second argument is used ONLY to decide main vs thread. The slug
 * itself is always derived from the session id so it matches the same
 * session wherever it appears in the UI (Timeline dropdown, detail
 * panel, thread header).
 */
export function sessionLabel(sessionId, threadId) {
  const slug = sessionSlug(sessionId);
  const kind = threadId == null || threadId === '' ? 'main' : 'thread';
  return `${kind} · ${slug}`;
}

// Attach to window for legacy (non-module) call sites. Safe no-op in
// Node — vitest imports the ESM exports directly.
if (typeof window !== 'undefined') {
  window.sessionSlug = sessionSlug;
  window.sessionLabel = sessionLabel;
  window.sessionSlugFnv1a = fnv1a;
}
