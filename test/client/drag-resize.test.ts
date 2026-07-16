import { describe, it, expect } from 'vitest';
import { clampSize, readPersistedSize, clampSplit, ratioToLeftPx } from '../../lib/client/drag-resize';

describe('clampSize', () => {
  it('returns proposed when in range', () => {
    expect(clampSize(50, 10, 100)).toBe(50);
  });

  it('clamps to min when below', () => {
    expect(clampSize(5, 10, 100)).toBe(10);
  });

  it('clamps to max when above', () => {
    expect(clampSize(150, 10, 100)).toBe(100);
  });

  it('min === max returns that value', () => {
    expect(clampSize(50, 30, 30)).toBe(30);
  });
});

describe('readPersistedSize', () => {
  it('null -> fallback', () => {
    expect(readPersistedSize(null, 10, 100, 42)).toBe(42);
  });

  it('empty string -> Number("") is 0, which is out of range, so it clamps to min (not fallback)', () => {
    // Number('') === 0. The source only falls back on NaN, so '' does NOT
    // hit the fallback path — it clamps like any other out-of-range number.
    expect(readPersistedSize('', 10, 100, 42)).toBe(10);
  });

  it('valid in-range numeric string -> that number', () => {
    expect(readPersistedSize('55', 10, 100, 42)).toBe(55);
  });

  it('out-of-range numeric string -> clamped', () => {
    expect(readPersistedSize('500', 10, 100, 42)).toBe(100);
  });

  it('"abc" (NaN) -> fallback', () => {
    expect(readPersistedSize('abc', 10, 100, 42)).toBe(42);
  });
});

describe('clampSplit', () => {
  it('proposed in valid band -> unchanged', () => {
    expect(clampSplit(500, 1000, 300, 300)).toBe(500);
  });

  it('proposed below leftMin -> leftMin', () => {
    expect(clampSplit(100, 1000, 300, 300)).toBe(300);
  });

  it('proposed above (containerWidth - rightMin) -> containerWidth - rightMin', () => {
    expect(clampSplit(900, 1000, 300, 300)).toBe(700);
  });

  it('container too small to honor both mins -> returns leftMin', () => {
    // containerWidth 400 < leftMin+rightMin (600): maxLeft = max(300, 400-300) = 300 = leftMin
    expect(clampSplit(1000, 400, 300, 300)).toBe(300);
  });
});

describe('ratioToLeftPx', () => {
  it('0.5 of 1000 with mins 300/300 -> 500', () => {
    expect(ratioToLeftPx(0.5, 1000, 300, 300)).toBe(500);
  });

  it('extreme ratio (0.95) clamps so right keeps rightMin', () => {
    // 0.95 * 1000 = 950, clamped to 1000 - 300 = 700
    expect(ratioToLeftPx(0.95, 1000, 300, 300)).toBe(700);
  });

  it('ratio 0 clamps up to leftMin', () => {
    expect(ratioToLeftPx(0, 1000, 300, 300)).toBe(300);
  });
});
