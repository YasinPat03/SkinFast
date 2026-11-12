import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  intersect,
  normalizeFloat,
  outputFloat,
  splitAt,
  wearBreakpoints,
  wearFloatRange,
  wearForFloat,
  wearNormalizedRange,
} from '../src/lib/tradeup/float';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('wear boundaries are closed at the bottom and open at the top', () => {
  assert.equal(wearForFloat(0), 'Factory New');
  assert.equal(wearForFloat(0.0699), 'Factory New');
  assert.equal(wearForFloat(0.07), 'Minimal Wear');
  assert.equal(wearForFloat(0.15), 'Field-Tested');
  assert.equal(wearForFloat(0.38), 'Well-Worn');
  assert.equal(wearForFloat(0.45), 'Battle-Scarred');
  assert.equal(wearForFloat(1), 'Battle-Scarred');
});

test('normalized float formula matches the documented example', () => {
  // 10 identical inputs at float 0.35 with range 0.00-0.60, output range 0.00-0.67.
  const t = normalizeFloat(0.35, 0, 0.6);
  close(t, 0.35 / 0.6);
  const out = outputFloat(t, 0, 0.67);
  close(out, 0.390833333333);
  assert.equal(wearForFloat(out), 'Well-Worn');
});

test('an input with a high minimum float normalizes low', () => {
  // AWP | Asiimov has range 0.18-1.00: a 0.18 float is the best it can be.
  assert.equal(normalizeFloat(0.18, 0.18, 1), 0);
  assert.equal(normalizeFloat(1, 0.18, 1), 1);
  assert.equal(normalizeFloat(5, 0.18, 1), 1);
  assert.equal(normalizeFloat(0.3, 0.3, 0.3), 0);
});

test('a wear range is clipped to what the skin can have', () => {
  assert.deepEqual(wearFloatRange('Field-Tested', 0.1, 0.7), { lo: 0.15, hi: 0.38 });
  assert.deepEqual(wearFloatRange('Minimal Wear', 0.1, 0.7), { lo: 0.1, hi: 0.15 });
  assert.deepEqual(wearFloatRange('Battle-Scarred', 0.02, 0.46), { lo: 0.45, hi: 0.46 });
  assert.equal(wearFloatRange('Factory New', 0.1, 0.7), null);
  assert.equal(wearFloatRange('Battle-Scarred', 0, 0.08), null);
  assert.equal(wearFloatRange('Vanilla', 0, 1), null);

  const range = wearNormalizedRange('Field-Tested', 0, 0.5);
  assert.ok(range);
  close(range.lo, 0.3);
  close(range.hi, 0.76);
});

test('ranges that only touch do not overlap, exact floats respect open tops', () => {
  assert.equal(intersect({ lo: 0, hi: 0.15 }, { lo: 0.15, hi: 0.38 }), null);
  assert.deepEqual(intersect({ lo: 0.1, hi: 0.3 }, { lo: 0.15, hi: 0.38 }), { lo: 0.15, hi: 0.3 });
  assert.deepEqual(intersect({ lo: 0.2, hi: 0.2 }, { lo: 0.15, hi: 0.38 }), { lo: 0.2, hi: 0.2 });
  assert.deepEqual(intersect({ lo: 0.15, hi: 0.15 }, { lo: 0.15, hi: 0.38 }), { lo: 0.15, hi: 0.15 });
  assert.equal(intersect({ lo: 0.38, hi: 0.38 }, { lo: 0.15, hi: 0.38 }), null);
  // Nothing lies above a normalized float of 1, so the top of the scale is included.
  assert.deepEqual(intersect({ lo: 1, hi: 1 }, { lo: 0.9, hi: 1 }), { lo: 1, hi: 1 });
});

test('breakpoints mark where an outcome changes wear', () => {
  const points = wearBreakpoints(0.1, 0.6);
  assert.equal(points.length, 3);
  close(points[0], 0.1); // 0.15
  close(points[1], 0.56); // 0.38
  close(points[2], 0.7); // 0.45
  assert.deepEqual(wearBreakpoints(0.3, 0.3), []);

  const pieces = splitAt({ lo: 0.3, hi: 0.76 }, [0.38, 0.45, 0.56, 0.7, 0.9, 0.38]);
  assert.deepEqual(
    pieces.map((piece) => [piece.lo, piece.hi]),
    [
      [0.3, 0.38],
      [0.38, 0.45],
      [0.45, 0.56],
      [0.56, 0.7],
      [0.7, 0.76],
    ],
  );
  assert.deepEqual(splitAt({ lo: 0.2, hi: 0.2 }, [0.2]), [{ lo: 0.2, hi: 0.2 }]);
});
