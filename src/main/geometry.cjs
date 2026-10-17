'use strict';
const BALL_SIZE = 76, CONFIRM_WIDTH = 348, SNAP_DISTANCE = 28;
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
function mainBounds(workArea) {
  // The renderer reserves a 24 px transparent frame for the CSS shadow.
  const inset = 2;
  return { x: workArea.x + inset, y: workArea.y + inset, width: Math.max(1, workArea.width - inset * 2), height: Math.max(1, workArea.height - inset * 2) };
}
function constrainBall(bounds, workArea) {
  return { ...bounds, x: Math.round(clamp(bounds.x, workArea.x, workArea.x + workArea.width - bounds.width)),
    y: Math.round(clamp(bounds.y, workArea.y, workArea.y + workArea.height - bounds.height)) };
}
function snapBall(bounds, workArea) {
  const constrained = constrainBall(bounds, workArea);
  const left = constrained.x - workArea.x, right = workArea.x + workArea.width - constrained.x - constrained.width;
  const snap = Math.min(left, right) <= SNAP_DISTANCE ? (left <= right ? 'left' : 'right') : 'none';
  return { bounds: { ...constrained, x: snap === 'left' ? workArea.x : snap === 'right' ? workArea.x + workArea.width - constrained.width : constrained.x }, snap };
}
function confirmBounds(bounds, workArea, snap, expanded) {
  const width = expanded ? Math.min(CONFIRM_WIDTH, workArea.width) : BALL_SIZE;
  let x = bounds.x;
  if (snap === 'right') x = workArea.x + workArea.width - width;
  else if (snap === 'left') x = workArea.x;
  return constrainBall({ ...bounds, x, width, height: BALL_SIZE }, workArea);
}
const eased = value => 1 - Math.pow(1 - value, 3);
module.exports = { BALL_SIZE, CONFIRM_WIDTH, SNAP_DISTANCE, mainBounds, constrainBall, snapBall, confirmBounds, eased };
