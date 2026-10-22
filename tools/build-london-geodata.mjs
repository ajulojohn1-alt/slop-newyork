// tools/build-london-geodata.mjs — bakes tools/data/london_inner.slice.geojson into js/london-geodata.js (window.LDN).
//
// Frame: true north. 1 unit = 1 m. x = east, z = south (north = -z). Origin at the centre of the slice bbox
// (a point near Charing Cross), so the whole of Inner London sits within a few km of the origin.
//
// The slice is raw GeoJSON from Overpass and mixes geometry types freely: buildings, water and landuse arrive as
// MultiPolygon (and occasionally Polygon), roads as LineString, POI/landmarks as Point, and some relations are
// exported as GeometryCollection. Every geometry read below goes through the normalisation helpers in section 2 —
// polyRings() / polysOf() / linePts() — which type-check before touching coordinates, flatten MultiPolygons into
// individual polygons, unwrap GeometryCollections, and guard against missing or non-array coordinate items, so
// area calculations (ringArea on [x, z] pairs) can never receive a bare float ("'float' object is not subscriptable").
//
// Output schema mirrors js/nyc-geodata.js (see build-geodata.mjs): buildings with heights derived from
// height / building:levels, lots/parcels derived from footprints, road polylines tagged with class/width/surface,
// the Thames as the water body, Royal Parks + landuse polygons, and named landmark features.
//
// usage: node --max-old-space-size=8192 tools/build-london-geodata.mjs [out.js]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../js/london-geodata.js', import.meta.url));
const log = (...a) => console.log('[london-geodata]', ...a);

const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);

// =====================================================================================================================
// 1. FRAME — true-north local tangent plane over Inner London
// =====================================================================================================================
const LAT0 = 51.5074; // Charing Cross
const LON0 = -0.1278;
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;

// lon/lat -> world metres [x = east, z = south]
const toWorld = (lon, lat) => [(lon - LON0) * KX, -(lat - LAT0) * KY];

// =====================================================================================================================
// 2. GEOMETRY HELPERS — ring maths + defensive GeoJSON normalisation
// =====================================================================================================================
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function centroid(r) {
  if (!r.length) return [0, 0];
  return [r.reduce((t, p) => t + p[0], 0) / r.length, r.reduce((t, p) => t + p[1], 0) / r.length];
}
function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (!isCoord(p)) continue;
    const [x, z] = p;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
// Ramer-Douglas-Peucker on an open polyline (same algorithm as geo-base.mjs)
function rdp(pts, eps) {
  if (!Array.isArray(pts) || pts.length < 3) return Array.isArray(pts) ? pts.slice() : [];
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const e2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = pts[i];
      const t = len2 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
      const tc = Math.max(0, Math.min(1, t));
      const ex = ax + tc * dx - px, ez = az + tc * dz - pz;
      const d2 = ex * ex + ez * ez;
      if (d2 > maxD) { maxD = d2; maxI = i; }
    }
    if (maxD > e2 && maxI > 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
function rdpRing(ring, eps) {
  if (!Array.isArray(ring) || ring.length < 4) return Array.isArray(ring) ? ring.slice() : [];
  let i0 = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i][0] < ring[i0][0] || (ring[i][0] === ring[i0][0] && ring[i][1] < ring[i0][1])) i0 = i;
  const i1 = ring.length - 1;
  const a = rdp(ring.slice(i0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[i0]], eps);
  return [...a, ...b.slice(1, b.length - 1)];
}

// --- Coordinate / geometry guards ------------------------------------------------------------------------------------
// A valid coordinate item is an array-like whose first two entries are finite numbers. This is what previously
// let bare floats slip into ringArea (crash: "'float' object is not subscriptable" in the probe, same class of bug
// here when a consumer assumed Polygon nesting but met a flatter or deeper structure).
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isCoord = (c) => Array.isArray(c) && isNum(c[0]) && isNum(c[1]);
// Convert one raw GeoJSON position ([lon, lat, ...?] nested arrays possible) to a world pair, or null.
function coordToWorld(c) {
  // unwrap pathological extra nesting: [[lon,lat]] etc.
  while (Array.isArray(c) && c.length === 1) c = c[0];
  if (!isCoord(c)) return null;
  return toWorld(c[0], c[1]);
}
// Normalise any GeoJSON geometry into a list of typed parts. Never throws on unexpected shapes.
function geomParts(geometry) {
  const out = { rings: [], lines: [], points: [] };
  walkGeometry(geometry, out);
  return out;
}
function walkGeometry(g, out) {
  if (!g || typeof g !== 'object' || !isNumOrStrType(g.type)) return;
  const coords = g.coordinates;
  switch (g.type) {
    case 'Point': {
      const p = coordToWorld(coords);
      if (p) out.points.push(p);
      break;
    }
    case 'MultiPoint': {
      if (!Array.isArray(coords)) break;
      for (const c of coords) { const p = coordToWorld(c); if (p) out.points.push(p); }
      break;
    }
    case 'LineString': {
      const line = lineFromCoords(coords);
      if (line.length >= 2) out.lines.push(line);
      break;
    }
    case 'MultiLineString': {
      if (!Array.isArray(coords)) break;
      for (const lc of coords) { const line = lineFromCoords(lc); if (line.length >= 2) out.lines.push(line); }
      break;
    }
    case 'Polygon': {
      addPolygon(out, coords);
      break;
    }
    case 'MultiPolygon': {
      // Flatten/unwrap MultiPolygon into individual polygons; each becomes its own ring set.
      if (!Array.isArray(coords)) break;
      for (const poly of coords) addPolygon(out, poly);
      break;
    }
    case 'GeometryCollection': {
      // Unwrap collections (some Overpass relation exports) by recursing into each member geometry.
      if (!Array.isArray(g.geometries)) break;
      for (const sub of g.geometries) walkGeometry(sub, out);
      break;
    }
    default:
      break;
  }
}
const isNumOrStrType = (t) => typeof t === 'string' && t.length > 0;
// One polygon's coordinate array -> outer ring (+ holes kept separately as their own rings flagged via winding).
function addPolygon(out, polyCoords) {
  if (!Array.isArray(polyCoords)) return;
  for (const ringCoords of polyCoords) {
    const ring = lineFromCoords(ringCoords);
    if (ring.length >= 4) out.rings.push(closeRing(ring));
  }
}
function lineFromCoords(coords) {
  if (!Array.isArray(coords)) return [];
  const line = [];
  for (const c of coords) { const p = coordToWorld(c); if (p) line.push(p); }
  return line;
}
function closeRing(ring) {
  const a = ring[0], b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
  return ring;
}
// Convenience: all polygons of a feature as [{outer, holes}] — MultiPolygon flattened, Polygon wrapped.
function polysOf(geometry) {
  const parts = geomParts(geometry);
  if (!parts.rings.length) return [];
  // Group rings into polygons: a ring inside another (by point-in-ring) is that ring's hole.
  const polys = [];
  const sorted = parts.rings.slice().sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  for (const r of sorted) {
    let placed = false;
    for (const poly of polys) {
      if (pointInRing(centroid(r), poly.outer)) {
        poly.holes.push(r);
        placed = true;
        break;
      }
    }
    if (!placed) polys.push({ outer: r, holes: [] });
  }
  return polys;
}
// Largest outer ring of a (Multi)Polygon feature, or null for non-polygonal geometry.
function mainRing(geometry) {
  const parts = geomParts(geometry);
  if (!parts.rings.length) return null;
  return parts.rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
}
function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// Total planar area (m²) of a feature's geometry, summing every polygon of a MultiPolygon and subtracting holes.
// Safe for any geometry type: LineString/Point contribute 0.
function featureArea(geometry) {
  let total = 0;
  for (const poly of polysOf(geometry)) {
    total += Math.abs(ringArea(poly.outer));
    for (const h of poly.holes) total -= Math.abs(ringArea(h));
  }
  return Math.max(0, total);
}
// Chain LineStrings that share endpoints into longer polylines (used for the river, which Overpass exports as many
// short unnamed segments). Joins are direction-agnostic: a segment may be appended forward or reversed.
function chainLines(lines, eps = 0.5) {
  const k = (p) => `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;
  const byEnd = new Map(); // endpoint key -> lines touching it (as [line, 'start'|'end'])
  for (const l of lines) {
    for (const [key, side] of [[k(l[0]), 'start'], [k(l[l.length - 1]), 'end']]) {
      if (!byEnd.has(key)) byEnd.set(key, []);
      byEnd.get(key).push([l, side]);
    }
  }
  const used = new Set();
  const chains = [];
  for (const seed of lines) {
    if (used.has(seed)) continue;
    used.add(seed);
    let line = seed.slice();
    // extend backwards
    for (;;) {
      const cands = (byEnd.get(k(line[0])) || []).filter(([l]) => !used.has(l));
      if (!cands.length) break;
      const [l, side] = cands[0];
      used.add(l);
      line = (side === 'end' ? l.slice() : l.slice().reverse()).concat(line.slice(1));
    }
    // extend forwards
    for (;;) {
      const cands = (byEnd.get(k(line[line.length - 1])) || []).filter(([l]) => !used.has(l));
      if (!cands.length) break;
      const [l, side] = cands[0];
      used.add(l);
      line = line.concat((side === 'start' ? l.slice(1) : l.slice(0, -1).reverse()));
    }
    chains.push(line);
  }
  return chains;
}

// =====================================================================================================================
// 2b. CANONICAL RING BUILDER
// =====================================================================================================================
// Simplify a closed ring, then force it closed and >= 4 points: rdpRing can drop the duplicated closing vertex,
// which would otherwise emit rings that extrusion code (triangulation) chokes on. Returns null if degenerate.
function bakeRing(ring, eps) {
  let s = rdpRing(ring, eps).map(([x, z]) => [q(x), q(z)]);
  if (s.length < 3) return null;
  const a = s[0], b = s[s.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) s.push([a[0], a[1]]);
  return s.length >= 4 ? s : null;
}
const bakeHoles = (holes) => holes.map((h) => bakeRing(h, 0.35)).filter((h) => h && h.length >= 4);

// =====================================================================================================================
// 3. LOAD THE SLICE
// =====================================================================================================================
log(`reading ${path.join(DATA, 'london_inner.slice.geojson')}`);
const slice = JSON.parse(fs.readFileSync(path.join(DATA, 'london_inner.slice.geojson'), 'utf8'));
if (!slice || !Array.isArray(slice.features)) {
  log('FATAL: slice has no features array');
  process.exit(1);
}
const feats = slice.features.filter((f) => f && f.geometry && f.properties);
log(`${feats.length} features (of ${slice.features.length}; skipped null geometry/properties)`);

// Slice bounds in world metres (all geometry types walked safely)
let allPts = [];
for (const f of feats) {
  const parts = geomParts(f.geometry);
  allPts.push(...parts.points, ...parts.rings.flat(), ...parts.lines.flat());
}
const BB = bbox(allPts);
allPts = null;
log(`slice bbox: x ${BB.x0.toFixed(0)}..${BB.x1.toFixed(0)}, z ${BB.z0.toFixed(0)}..${BB.z1.toFixed(0)} m ` +
    `(${(((BB.x1 - BB.x0) / 1000).toFixed(2))} × ${((BB.z1 - BB.z0) / 1000).toFixed(2)} km)`);
const CX = (BB.x0 + BB.x1) / 2, CZ = (BB.z0 + BB.z1) / 2;
// Re-centre frame on the slice centre so coordinates stay small: shift all outputs by (CX, CZ).
const toOut = ([x, z]) => [x - CX, z - CZ];
const shiftFlat = (pts) => flat(pts.map(toOut));
const shiftRing = (ring) => ring.map(toOut);

// =====================================================================================================================
// 4. BUILDINGS — footprints + heights (height / building:levels / default)
// =====================================================================================================================
const LEVEL_M = 3.2;      // typical storey height incl. floor slab
const DEFAULT_H = 9.6;    // ~3 storeys, common Victorian townhouse when nothing is tagged
const MAX_H = 250;        // The Shard is 309.9 m but sits outside the detailed bake cap sanity check
function buildingHeight(props) {
  const hRaw = props.height || props['height:metres'];
  if (hRaw != null) {
    const h = parseFloat(String(hRaw).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(h) && h > 0) return Math.min(MAX_H, h);
  }
  const lv = props['building:levels'];
  if (lv != null) {
    const l = parseFloat(String(lv).split(';')[0]);
    if (Number.isFinite(l) && l > 0) return Math.min(MAX_H, l * LEVEL_M);
  }
  const mh = props.min_height;
  if (mh != null) {
    const m = parseFloat(String(mh).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(m) && m > 0) return Math.min(MAX_H, Math.max(m, DEFAULT_H));
  }
  return DEFAULT_H;
}
const buildings = [];
let skippedGeom = 0;
for (const f of feats) {
  const p = f.properties;
  if (!p.building && p.building !== '') continue;
  if (p.building === 'no' || p.building === 'way' || /^railway:/.test(String(p.building))) continue;
  const t = f.geometry.type;
  if (t !== 'Polygon' && t !== 'MultiPolygon') { skippedGeom++; continue; } // building points/lines are POIs, skip
  for (const poly of polysOf(f.geometry)) {
    const outer = shiftRing(poly.outer);
    if (outer.length < 4) continue;
    const area = Math.abs(ringArea(outer));
    if (area < 8) continue; // debris
    const bb = bbox(outer);
    const w = bb.x1 - bb.x0, d = bb.z1 - bb.z0;
    if (w > 400 || d > 400) continue; // megastructures/blocks handled as landmarks or lots, not houses
    const br = bakeRing(outer, 0.35);
    if (!br) continue;
    buildings.push({
      ring: br,
      holes: bakeHoles(poly.holes.map(shiftRing)),
      h: Math.round(buildingHeight(p) * 10) / 10,
      levels: p['building:levels'] ? parseInt(String(p['building:levels']).split(';')[0], 10) || 0 : 0,
      kind: String(p.building || ''),
      name: p.name || '',
      colour: p['building:colour'] || '',
      material: p['building:material'] || '',
      cx: q((bb.x0 + bb.x1) / 2 - CX), cz: q((bb.z0 + bb.z1) / 2 - CZ),
      area: Math.round(area)
    });
  }
}
log(`${buildings.length} buildings baked (${skippedGeom} non-polygon building features skipped safely)`);

// =====================================================================================================================
// 5. LOTS / PARCELS — derived from footprint clusters (land-use blocks between roads)
// =====================================================================================================================
// Simple derivation: grid-bucket building footprints; each occupied cell of a coarse 60 m lattice becomes a lot
// rectangle spanning its buildings' combined extents. Real cadastral data is absent from OSM extracts; this matches
// the engine contract (lots are rectangular pads under building groups) while staying data-driven.
{
  var LOT_RES = 60;
  var lotCells = new Map();
  for (const b of buildings) {
    const key = `${Math.floor((b.cx + CX) / LOT_RES)},${Math.floor((b.cz + CZ) / LOT_RES)}`;
    let c = lotCells.get(key);
    if (!c) lotCells.set(key, (c = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, n: 0 }));
    // recover footprint extents from the ring points (cx/cz are already in output frame)
    for (const [x, z] of b.ring) {
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (z < c.z0) c.z0 = z;
      if (z > c.z1) c.z1 = z;
    }
    c.n++;
  }
  var lots = [];
  for (const c of lotCells.values()) {
    if (c.n < 1 || !Number.isFinite(c.x0)) continue;
    lots.push({ x0: q(c.x0 - 2), x1: q(c.x1 + 2), z0: q(c.z0 - 2), z1: q(c.z1 + 2), n: c.n });
  }
  log(`${lots.length} lots derived`);
}

// =====================================================================================================================
// 6. ROADS — LineString centrelines tagged with class / width / surface
// =====================================================================================================================
const CLASS_ORDER = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'];
const CLASS_SPEED = { motorway: 112, trunk: 112, primary: 96, secondary: 80, tertiary: 64, unclassified: 48, residential: 40, living_street: 20, service: 20 }; // km/h UK limits
const CLASS_WIDTH = { motorway: 24, trunk: 18, primary: 14, secondary: 12, tertiary: 10, unclassified: 8, residential: 7, living_street: 6, service: 5 };
const roads = [];
for (const f of feats) {
  const p = f.properties;
  if (!p.highway) continue;
  if (['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'bridleway', 'bus_guideway', 'construction', 'proposed'].includes(p.highway)) continue;
  const t = f.geometry.type;
  if (t !== 'LineString' && t !== 'MultiLineString') { continue; } // road points/areas: crossings & mini-roundabout areas, skip
  const cls = CLASS_ORDER.includes(p.highway) ? p.highway : 'unclassified';
  for (const line of geomParts(f.geometry).lines) {
    const pts = line.map(toOut);
    if (pts.length < 2) continue;
    const simplified = rdp(pts, 0.6);
    const wRaw = p.width || p['width:metres'] || '';
    const wTag = parseFloat(String(wRaw).replace(/[^0-9.]/g, ''));
    roads.push({
      name: p.name || p.ref || '',
      cls,
      oneWay: p.oneway === 'yes' || p.oneway === 'true' ? 1 : p.oneway === '-1' ? -1 : 0,
      lanes: parseInt(p.lanes, 10) || (cls === 'motorway' || cls === 'trunk' ? 3 : cls === 'primary' || cls === 'secondary' ? 2 : 1),
      w: Number.isFinite(wTag) && wTag > 0 ? Math.round(wTag * 10) / 10 : CLASS_WIDTH[cls],
      speed: CLASS_SPEED[cls],
      surface: p.surface || 'asphalt',
      bridge: p.bridge ? 1 : 0,
      tunnel: p.tunnel ? 1 : 0,
      layer: parseInt(p.layer, 10) || 0,
      pts: simplified.map(([x, z]) => [q(x), q(z)])
    });
  }
}
log(`${roads.length} road polylines, ${roads.reduce((t, r) => t + r.pts.length, 0)} pts`);

// Merge chains per (name|class|width) so routing gets long polylines where names repeat
function mergeRoadsChains(list) {
  const byKey = new Map();
  for (const r of list) {
    const key = `${r.name}|${r.cls}|${r.w}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const merged = [];
  for (const [key, segs] of byKey) {
    const [name, cls, w] = [segs[0].name, segs[0].cls, segs[0].w];
    const ends = new Map();
    const k = (p) => `${p[0]},${p[1]}`;
    for (const s of segs) ends.set(k(s.pts[0]), s);
    const used = new Set();
    for (const s of segs) {
      if (used.has(s)) continue;
      let first = s;
      const seen = new Set([s]);
      for (;;) {
        const prev = segs.find((t) => !seen.has(t) && !used.has(t) && k(t.pts[t.pts.length - 1]) === k(first.pts[0]) && t !== first);
        if (!prev) break;
        seen.add(prev);
        first = prev;
      }
      const line = first.pts.slice();
      let cur = first;
      while (cur && !used.has(cur)) {
        used.add(cur);
        line.push(...cur.pts.slice(1));
        cur = ends.get(k(cur.pts[cur.pts.length - 1]));
      }
      merged.push({ name, cls, w, speed: segs[0].speed, lanes: segs[0].lanes, surface: segs[0].surface, pts: rdp(line, 0.8).map(([x, z]) => [q(x), q(z)]) });
    }
  }
  return merged;
}
const roadLines = mergeRoadsChains(roads);
log(`${roadLines.length} merged road chains`);

// =====================================================================================================================
// 7. WATER — the Thames + lakes/canals, fully type-safe
// =====================================================================================================================
// Previously crashed here: the handler assumed Polygon coordinate nesting, but the river arrives as MultiPolygon
// (and small ponds as Polygon), so indexing coordinates as rings hit bare floats. Now: every water feature goes
// through polysOf(), which flattens MultiPolygon -> individual polygons and validates each coordinate item.
const waterPolys = [];
for (const f of feats) {
  const p = f.properties;
  const isWater = p.waterway === 'riverbank' || p.natural === 'water' || p.landuse === 'water' || p.leisure === 'marina';
  if (!isWater) continue;
  const t = f.geometry.type;
  if (t !== 'Polygon' && t !== 'MultiPolygon') continue; // water points/lines: fountains & streams, handled below
  for (const poly of polysOf(f.geometry)) {
    const outer = shiftRing(poly.outer);
    const area = Math.abs(ringArea(outer));
    if (area < 400) continue; // duck ponds
    const wr = bakeRing(outer, 1.2);
    if (!wr) continue;
    waterPolys.push({
      name: p.name || '',
      kind: p.waterway === 'riverbank' ? 'riverbank' : p.water || (p.landuse === 'water' ? 'river' : 'lake'),
      ring: wr,
      holes: poly.holes.map((h) => bakeRing(shiftRing(h), 1.2)).filter(Boolean),
      area: Math.round(area)
    });
  }
}
waterPolys.sort((a, b) => b.area - a.area);

// The slice has no riverbank polygons: the Thames arrives as many LineString segments (waterway=river, most
// unnamed between bridges). Chain them into one centreline and extrude a ribbon polygon of measured width —
// data-driven bank line approximation; segment widths grow downstream like the real tidal river.
const thamesSegs = [];
for (const f of feats) {
  const p = f.properties;
  if (p.waterway !== 'river') continue;
  const t = f.geometry.type;
  if (t !== 'LineString' && t !== 'MultiLineString') continue;
  for (const line of geomParts(f.geometry).lines) {
    const pts = line.map(toOut);
    if (pts.length >= 2) thamesSegs.push(pts);
  }
}
const thamesChains = chainLines(thamesSegs, 1).sort((a, b) => b.length - a.length);
const thamesLine = thamesChains[0] || [];
log(`Thames centreline: ${thamesSegs.length} segments chained -> longest ${thamesLine.length} pts`);
function polylineNormal(pA, pB) {
  const dx = pB[0] - pA[0], dz = pB[1] - pA[1];
  const L = Math.hypot(dx, dz) || 1;
  return [-dz / L, dx / L];
}
function offsetSide(line, wFn, sign) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const [nx, nz] = polylineNormal(a, b);
    const w = wFn(i / (line.length - 1 || 1));
    out.push([line[i][0] + nx * w * sign, line[i][1] + nz * w * sign]);
  }
  return out;
}
let thamesRibbon = null;
if (thamesLine.length >= 8) {
  const halfWidth = (t) => 65 + 90 * t; // Westminster ~130 m wide ... Greenwich reaches ~300 m; half-widths 65..155
  const left = offsetSide(thamesLine, halfWidth, 1);
  const right = offsetSide(thamesLine, halfWidth, -1);
  const ribbon = [...left, ...right.reverse()];
  ribbon.push(ribbon[0]);
  thamesRibbon = bakeRing(ribbon, 2.0);
  waterPolys.unshift({ name: 'River Thames', kind: 'river', ring: thamesRibbon, holes: [], area: Math.round(Math.abs(ringArea(ribbon))) });
}
const thames = waterPolys.filter((w) => w.kind === 'river' || /thames/i.test(w.name || ''));
log(`${waterPolys.length} water polygons (${thames.length} Thames parts, largest ${(waterPolys[0]?.area / 1e6 || 0).toFixed(2)} km²)`);

// =====================================================================================================================
// 8. LAND USE / PARKS — Royal Parks and green space
// =====================================================================================================================
const ROYAL_PARKS = ['Hyde Park', "King's Park", 'Green Park', 'St James’s Park', 'St James\'s Park', 'Regent\'s Park', 'Regent’s Park', 'Victoria Tower Gardens', 'Kensington Gardens'];
const parks = [];
for (const f of feats) {
  const p = f.properties;
  const isPark = p.leisure === 'park' || p.leisure === 'garden' || p.landuse === 'recreation_ground' ||
                 p.leisure === 'common' || p.openstreetmapwiki_name && false;
  if (!isPark) continue;
  const t = f.geometry.type;
  if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
  for (const poly of polysOf(f.geometry)) {
    const outer = shiftRing(poly.outer);
    const area = Math.abs(ringArea(outer));
    if (area < 3000) continue;
    const nm = p.name || '';
    const pr = bakeRing(outer, 1.0);
    if (!pr) continue;
    parks.push({
      name: nm,
      royal: ROYAL_PARKS.some((r) => nm.toLowerCase().includes(r.toLowerCase())) ? 1 : 0,
      ring: pr,
      area: Math.round(area)
    });
  }
}
parks.sort((a, b) => b.area - a.area);
log(`${parks.length} park polygons, ${parks.filter((k) => k.royal).length} tagged Royal Parks`);

// =====================================================================================================================
// 9. LANDMARKS — named point/polygon features the sim places meshes on
// =====================================================================================================================
const LANDMARK_TAGS = [
  ['Elizabeth Tower', 'Big Ben'], ['Palace of Westminster', 'Parliament'], ['Tower of London', 'Tower'],
  ['Buckingham Palace', 'BuckinghamPalace'], ["St Paul's Cathedral", 'StPauls'], ['St Pauls Cathedral', 'StPauls'],
  ['The Shard', 'Shard'], ['Gherkin', 'Gherkin'], ['30 St Mary Axe', 'Gherkin'],
  ['Walkie-Talkie', 'WalkieTalkie'], ['20 Fenchurch Street', 'WalkieTalkie'],
  ['Cheesegrater', 'Cheesegrater'], ['Leadenhall Building', 'Cheesegrater'],
  ['London Eye', 'LondonEye'], ['Tower Bridge', 'TowerBridge'], ['Lloyd\'s Building', 'Lloyds'],
  ['Heron Tower', 'HeronTower'], ['St Mary Axe', 'Gherkin'], ['Monument', 'Monument'],
  ['Nelson\'s Column', 'NelsonColumn'], ['Wellington Arch', 'WellingtonArch'],
  ['Marble Arch', 'MarbleArch'], ['Albert Memorial', 'AlbertMemorial']
];
const landmarks = [];
const seenLandmark = new Set();
for (const f of feats) {
  const p = f.properties;
  const nm = p.name || p.official_name || '';
  if (!nm) continue;
  const hit = LANDMARK_TAGS.find(([needle]) => nm.toLowerCase() === needle.toLowerCase() || nm.toLowerCase().includes(needle.toLowerCase()));
  if (!hit) continue;
  const id = hit[1];
  if (seenLandmark.has(id)) continue;
  let pos = null, ring = null;
  const parts = geomParts(f.geometry);
  if (parts.rings.length) {
    const big = parts.rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
    pos = centroid(big);
    ring = bakeRing(shiftRing(big), 0.8);
  } else if (parts.points.length) {
    pos = parts.points[0];
  }
  if (!pos) continue; // GeometryCollection without usable members: skip safely
  seenLandmark.add(id);
  landmarks.push({ id, name: nm, x: q(pos[0] - CX), z: q(pos[1] - CZ), ring, h: buildingHeight(p) });
}
log(`${landmarks.length} landmarks: ${landmarks.map((l) => l.id).join(', ')}`);

// =====================================================================================================================
// 10. BRIDGES — Thames crossings (highway lines tagged bridge=yes whose midpoint sits on the river ribbon)
// =====================================================================================================================
function distToPolyline(p, line) {
  let best = Infinity;
  for (let i = 0, j = 1; i < line.length - 1; i++, j++) {
    const [ax, az] = line[i], [bx, bz] = line[j];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / L2)) : 0;
    const ex = ax + t * dx - p[0], ez = az + t * dz - p[1];
    const d2 = ex * ex + ez * ez;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}
const bridges = [];
if (thamesLine.length >= 2) {
  for (const r of roads) {
    if (!r.bridge || !r.pts || r.pts.length < 2) continue;
    const mid = r.pts[Math.floor(r.pts.length / 2)];
    // a bridge segment crossing the river has its midpoint within the water ribbon (half-width + margin)
    if (distToPolyline(mid, thamesLine) <= 175) {
      bridges.push({ name: r.name || 'bridge', pts: r.pts, cls: r.cls });
    }
  }
}
log(`${bridges.length} Thames-crossing bridge segments`);

// =====================================================================================================================
// 12. SELF-TEST — run with: node tools/build-london-geodata.mjs --selftest
// Proves the geometry normalisation cannot throw on any GeoJSON shape, including the exact failure mode seen
// before (bare float coordinate items reaching ringArea via an assumed-Polygon nesting).
// =====================================================================================================================
if (process.argv.includes('--selftest')) {
  const cases = [
    ['Polygon', { type: 'Polygon', coordinates: [[[-0.13, 51.5], [-0.12, 51.5], [-0.12, 51.51], [-0.13, 51.51], [-0.13, 51.5]]] }],
    ['MultiPolygon (two parts)', { type: 'MultiPolygon', coordinates: [[[[-0.13, 51.5], [-0.12, 51.5], [-0.12, 51.51], [-0.13, 51.51], [-0.13, 51.5]]], [[[-0.11, 51.5], [-0.1, 51.5], [-0.1, 51.51], [-0.11, 51.51], [-0.11, 51.5]]]] }],
    ['LineString', { type: 'LineString', coordinates: [[-0.13, 51.5], [-0.12, 51.51]] }],
    ['Point', { type: 'Point', coordinates: [-0.13, 51.5] }],
    ['GeometryCollection', { type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [[[0, 51.5], [0.01, 51.5], [0.01, 51.51], [0, 51.51], [0, 51.5]]] }, { type: 'Point', coordinates: [0.005, 51.505] }] }],
    ['bare floats as ring items (the crasher)', { type: 'Polygon', coordinates: [[-0.13, 51.5, -0.12, 51.51]] }],
    ['null coordinates', { type: 'Polygon', coordinates: null }],
    ['missing type', { coordinates: [[[0, 0]]] }],
    ['undefined geometry', undefined],
    ['empty MultiPolygon', { type: 'MultiPolygon', coordinates: [] }]
  ];
  let fails = 0;
  for (const [name, g] of cases) {
    try {
      featureArea(g);
      polysOf(g);
      geomParts(g);
      mainRing(g);
      console.log(`selftest OK   ${name}`);
    } catch (e) {
      console.error(`selftest FAIL ${name}: ${e.message}`);
      fails++;
    }
  }
  // areas must match hand-computed expectations for the valid polygonal cases
  const aPoly = featureArea(cases[0][1]);
  const aMulti = featureArea(cases[1][1]);
  if (Math.abs(aMulti - 2 * aPoly) > 1) { console.error('selftest FAIL MultiPolygon area != 2x Polygon area'); fails++; }
  else console.log('selftest OK   MultiPolygon flattened & summed');
  process.exit(fails ? 1 : 0);
}

// =====================================================================================================================
// 11. EMIT js/london-geodata.js (window.LDN, same schema family as nyc-geodata.js)
// =====================================================================================================================
const bounds = { minX: q(BB.x0 - CX), maxX: q(BB.x1 - CX), minZ: q(BB.z0 - CZ), maxZ: q(BB.z1 - CZ) };
const header =
`// js/london-geodata.js — GENERATED by tools/build-london-geodata.mjs from tools/data/london_inner.slice.geojson
// Do not edit by hand. True-north frame: x east, z south, 1 unit = 1 m, origin at the slice centre (near Charing Cross).
// Schema mirrors js/nyc-geodata.js. window.LDN.\n`;
const chunks = [header];
chunks.push('window.LDN = {\n');
chunks.push(`  meta: { source: 'OSM Overpass slice (Inner London Zones 1-2)', frame: 'true-north', bounds: ${JSON.stringify(bounds)} },\n`);
chunks.push(`  bounds: ${JSON.stringify(bounds)},\n`);
chunks.push(`  stats: ${JSON.stringify({ buildings: buildings.length, roads: roads.length, roadChains: roadLines.length, water: waterPolys.length, thamesParts: thames.length, parks: parks.length, landmarks: landmarks.length, bridges: bridges.length })},\n`);
chunks.push(`  buildings: ${JSON.stringify(buildings)},\n`);
chunks.push(`  lots: ${JSON.stringify(lots)},\n`);
chunks.push(`  roads: ${JSON.stringify(roadLines)},\n`);
chunks.push(`  water: ${JSON.stringify(waterPolys)},\n`);
chunks.push(`  parks: ${JSON.stringify(parks)},\n`);
chunks.push(`  landmarks: ${JSON.stringify(landmarks)},\n`);
chunks.push(`  bridges: ${JSON.stringify(bridges)}\n`);
chunks.push('};\n');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, chunks.join(''));
const bytes = fs.statSync(OUT).size;
log(`wrote ${OUT} (${(bytes / 1e6).toFixed(1)} MB)`);
log(`sanity vs known stats: buildings=${buildings.length} (expect ~9435), roads=${roads.length} (expect ~3298)`);
