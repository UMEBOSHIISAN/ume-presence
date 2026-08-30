export interface BackgroundAlphaOptions {
  transparentDistance?: number;
  featherDistance?: number;
}

function colorDistance(
  source: Uint8ClampedArray,
  pixel: number,
  background: readonly [number, number, number],
) {
  const offset = pixel * 4;
  return Math.hypot(
    source[offset] - background[0],
    source[offset + 1] - background[1],
    source[offset + 2] - background[2],
  );
}

export function removeEdgeConnectedBackground(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  options: BackgroundAlphaOptions = {},
): Uint8ClampedArray {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    source.length !== width * height * 4
  ) {
    throw new Error('RGBA buffer length does not match width and height.');
  }

  const transparentDistance = options.transparentDistance ?? 24;
  const featherDistance = options.featherDistance ?? 56;
  if (transparentDistance < 0 || featherDistance <= transparentDistance) {
    throw new Error('Background alpha distances are invalid.');
  }

  const cornerPixels = [0, width - 1, (height - 1) * width, width * height - 1];
  const background: [number, number, number] = [0, 0, 0];
  for (const pixel of cornerPixels) {
    const offset = pixel * 4;
    background[0] += source[offset] / cornerPixels.length;
    background[1] += source[offset + 1] / cornerPixels.length;
    background[2] += source[offset + 2] / cornerPixels.length;
  }

  const result = new Uint8ClampedArray(source);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const enqueue = (pixel: number) => {
    if (visited[pixel] || colorDistance(source, pixel, background) > featherDistance) {
      return;
    }
    visited[pixel] = 1;
    queue[tail] = pixel;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixel = queue[head];
    head += 1;
    const distance = colorDistance(source, pixel, background);
    const offset = pixel * 4;
    if (distance <= transparentDistance) {
      result[offset + 3] = 0;
    } else {
      const feather =
        (distance - transparentDistance) /
        (featherDistance - transparentDistance);
      result[offset + 3] = Math.round(source[offset + 3] * feather);
    }

    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (y > 0) enqueue(pixel - width);
    if (y + 1 < height) enqueue(pixel + width);
  }

  return result;
}
