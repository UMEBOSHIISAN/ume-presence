import { describe, expect, test } from 'vitest';

import { removeEdgeConnectedBackground } from './edge-background-alpha';

const WARM = [248, 242, 232, 255] as const;
const DARK = [24, 42, 34, 255] as const;

function solidPixels(
  width: number,
  height: number,
  color: readonly [number, number, number, number],
) {
  return new Uint8ClampedArray(
    Array.from({ length: width * height }, () => color).flat(),
  );
}

function setPixel(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
) {
  pixels.set(color, (y * width + x) * 4);
}

function alphaAt(pixels: Uint8ClampedArray, width: number, x: number, y: number) {
  return pixels[(y * width + x) * 4 + 3];
}

describe('removeEdgeConnectedBackground', () => {
  test('makes the warm edge transparent without changing RGB', () => {
    const source = solidPixels(3, 3, WARM);
    setPixel(source, 3, 1, 1, DARK);

    const result = removeEdgeConnectedBackground(source, 3, 3);

    for (let index = 0; index < source.length; index += 4) {
      expect(Array.from(result.slice(index, index + 3))).toEqual(
        Array.from(source.slice(index, index + 3)),
      );
    }
    expect(alphaAt(result, 3, 0, 0)).toBe(0);
    expect(alphaAt(result, 3, 2, 2)).toBe(0);
    expect(alphaAt(result, 3, 1, 1)).toBe(255);
    expect(alphaAt(source, 3, 0, 0)).toBe(255);
  });

  test('preserves a similar interior color when a dark outline disconnects it', () => {
    const source = solidPixels(5, 5, WARM);
    for (let offset = 1; offset <= 3; offset += 1) {
      setPixel(source, 5, offset, 1, DARK);
      setPixel(source, 5, offset, 3, DARK);
      setPixel(source, 5, 1, offset, DARK);
      setPixel(source, 5, 3, offset, DARK);
    }

    const result = removeEdgeConnectedBackground(source, 5, 5);

    expect(alphaAt(result, 5, 0, 2)).toBe(0);
    expect(alphaAt(result, 5, 1, 2)).toBe(255);
    expect(alphaAt(result, 5, 2, 2)).toBe(255);
  });

  test('rejects inconsistent dimensions', () => {
    expect(() =>
      removeEdgeConnectedBackground(new Uint8ClampedArray(4), 2, 2),
    ).toThrow('RGBA buffer length does not match width and height.');
  });
});
