import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSkinQuery } from '../src/lib/skin-search';

test('full weapon names do not leak into the pattern search', () => {
  for (const weapon of ['Desert Eagle', 'Dual Berettas', 'Galil AR', 'SG 553', 'SSG 08', 'R8 Revolver', 'Butterfly Knife']) {
    assert.deepEqual(parseSkinQuery(weapon), { weapons: [weapon], patternWords: [] });
    assert.deepEqual(parseSkinQuery(`${weapon} | Fade`), { weapons: [weapon], patternWords: ['fade'] });
  }
});

test('pasted skin names, shorthand, and reversed queries find the same skin', () => {
  for (const query of ['AK-47 | Redline', 'ak redline', 'redline ak', '  AK47   redline  ']) {
    assert.deepEqual(parseSkinQuery(query), { weapons: ['AK-47'], patternWords: ['redline'] });
  }
  assert.deepEqual(parseSkinQuery('★ Butterfly Knife | Doppler'), { weapons: ['Butterfly Knife'], patternWords: ['doppler'] });
  assert.deepEqual(parseSkinQuery('m4 asiimov'), { weapons: ['M4A4', 'M4A1-S'], patternWords: ['asiimov'] });
});

test('pattern-only and special object-property words remain ordinary search terms', () => {
  for (const query of ['asiimov', 'constructor', '__proto__']) {
    assert.deepEqual(parseSkinQuery(query), { weapons: null, patternWords: [query] });
  }
  assert.deepEqual(parseSkinQuery(' | ★ '), { weapons: null, patternWords: [] });
});
