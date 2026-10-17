'use strict';

/** Native drawing/input region matching the floating-ball surface in desktop.css. */
function ballShape({ width = 76, height = 80, snap = 'none', confirming = false } = {}) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1)
    throw new RangeError('Ball viewport dimensions must be positive integers.');
  if (!['none', 'left', 'right'].includes(snap) || typeof confirming !== 'boolean')
    throw new TypeError('Invalid floating-ball shape state.');

  const docked = snap !== 'none';
  const desiredWidth = confirming ? (docked ? 342 : 336) : (docked ? 70 : 64);
  const availableWidth = Math.max(0, width - (docked ? 6 : 12));
  const surfaceWidth = Math.min(desiredWidth, availableWidth);
  const surfaceX = snap === 'left' ? 0 : snap === 'right' ? width - surfaceWidth : 6;
  const surfaceY = (height - 64) / 2;
  const roundedLeft = snap !== 'left', roundedRight = snap !== 'right';
  // CSS scales all corner radii together if their sum exceeds a short edge.
  const radius = Math.min(32, surfaceWidth / (docked ? 1 : 2));
  const rects = [];

  for (let y = 0; y < height && surfaceWidth > 0; y++) {
    const sampleY = y + .5;
    if (sampleY < surfaceY || sampleY >= surfaceY + 64) continue;
    const edgeDistance = Math.max(surfaceY + radius - sampleY, sampleY - (surfaceY + 64 - radius), 0);
    const inset = radius - Math.sqrt(Math.max(0, radius * radius - edgeDistance * edgeDistance));
    const left = surfaceX + (roundedLeft ? inset : 0);
    const right = surfaceX + surfaceWidth - (roundedRight ? inset : 0);
    const x = Math.max(0, Math.ceil(left - .5));
    const end = Math.min(width, Math.ceil(right - .5));
    if (end <= x) continue;
    const previous = rects[rects.length - 1];
    if (previous && previous.x === x && previous.width === end - x && previous.y + previous.height === y)
      previous.height++;
    else rects.push({ x, y, width: end - x, height: 1 });
  }

  // setShape([]) resets to a full rectangular window. Preserve an empty native
  // region instead when a very small viewport clips away the entire surface.
  return rects.length ? rects : [{ x: 0, y: 0, width: 0, height: 0 }];
}

module.exports = { ballShape };
