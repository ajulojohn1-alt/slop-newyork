// tests/london-geodata.test.mjs — contract tests for the London baker output (window.LDN), mirroring the checks
// tests/geodata.test.mjs runs against window.NYC.GEO: blocks and roadGraph must exist, be well-formed, and match
// the engine's NYC-shaped schema so the simulation can consume Inner London without a translation layer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL('../', import.meta.url));
const baked = fs.readFileSync(path.join(root, 'js/london-geodata.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(baked, context);
const L = context.window.LDN;

test('london geodata loads as window.LDN with all required fields', () => {
  for (const k of ['meta', 'bounds', 'stats', 'buildings', 'lots', 'roads', 'blocks', 'roadGraph', 'water', 'parks', 'landmarks', 'bridges']) {
    assert.ok(k in L, `missing field ${k}`);
  }
});

test('blocks match the NYC GEO.blocks contract', () => {
  assert.ok(L.blocks.length > 100, `expected many blocks, got ${L.blocks.length}`);
  let withRects = 0;
  for (const b of L.blocks) {
    assert.equal(b.length, 6, 'block tuple must have 6 fields');
    const [outline, rects] = b;
    assert.ok(Array.isArray(outline) && outline.length >= 6 && outline.length % 2 === 0, 'flat even-length outline');
    assert.ok(outline.every((v) => Number.isFinite(v)), 'numeric outline coords');
    assert.ok(Array.isArray(rects), 'rects array');
    for (const r of rects) {
      assert.equal(r.length, 4, 'rect is [x0, z0, x1, z1]');
      assert.ok(r.every((v) => Number.isFinite(v)));
    }
    if (rects.length) withRects++;
    assert.ok(b[2] === 0 || b[2] === 1, 'park share flag');
  }
  assert.ok(withRects > L.blocks.length * 0.5, 'most blocks carry building footprints');
});

test('roadGraph matches the NYC GEO.roadGraph contract', () => {
  const rg = L.roadGraph;
  assert.ok(Array.isArray(rg.nodes) && rg.nodes.length % 2 === 0 && rg.nodes.length > 0, 'flat node pairs');
  const N = rg.nodes.length / 2;
  assert.ok(rg.links.length > 1000, `expected a drivable-size graph, got ${rg.links.length} links`);
  assert.ok(rg.names.length > 0 && Array.isArray(rg.names), 'street name table');
  let oneWay = 0;
  for (const l of rg.links) {
    assert.equal(l.length, 7, 'link tuple has 7 fields');
    const [a, b, nameIdx, w, lanes, dir, inner] = l;
    assert.ok(Number.isInteger(a) && a >= 0 && a < N, 'link start node in range');
    assert.ok(Number.isInteger(b) && b >= 0 && b < N, 'link end node in range');
    assert.notEqual(a, b, 'no self loops');
    assert.ok(nameIdx >= 0 && nameIdx < rg.names.length, 'name index in range');
    assert.ok(w > 0 && w < 60, 'plausible curb-to-curb width');
    assert.ok(lanes >= 1 && lanes <= 6, 'plausible lane count');
    assert.ok([1, -1, 0].includes(dir), 'direction is 1/-1/0');
    if (dir !== 0) oneWay++;
    assert.ok(Array.isArray(inner) && inner.length % 2 === 0, 'inner shape points flat pairs');
  }
  assert.ok(oneWay > rg.links.length * 0.3, 'London central one-way network is reflected in the graph');
});

test('geometry normalisation survives malformed GeoJSON (regression: TypeError on area calc)', () => {
  const result = spawnSelftest();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

function spawnSelftest() {
  const { spawnSync } = require('node:child_process');
  return spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(root, 'tools/build-london-geodata.mjs'), '--selftest'], { encoding: 'utf8', timeout: 120000 });
}
