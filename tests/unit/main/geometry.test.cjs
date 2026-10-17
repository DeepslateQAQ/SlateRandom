const test = require('node:test'), assert = require('node:assert/strict');
const G = require('../../../src/main/geometry.cjs');
test('main window stays centered with margins in high DPI and negative-coordinate displays', () => {
  for (const area of [{x:0,y:0,width:768,height:400},{x:-1920,y:48,width:1920,height:1032}]) {
    const b=G.mainBounds(area); assert.ok(b.width < area.width && b.height < area.height);
    assert.equal(b.x+ b.width/2, area.x+area.width/2); assert.equal(b.y+b.height/2,area.y+area.height/2);
  }
});
test('snap preserves the actual left/right screen edge and clamps top/bottom', () => {
  const area={x:-1280,y:0,width:1280,height:720};
  const left=G.snapBall({x:-1260,y:-40,width:76,height:76},area); assert.equal(left.snap,'left');assert.equal(left.bounds.x,-1280);assert.equal(left.bounds.y,0);
  const right=G.snapBall({x:-90,y:900,width:76,height:76},area);assert.equal(right.snap,'right');assert.equal(right.bounds.x,-76);assert.equal(right.bounds.y,644);
  assert.equal(G.snapBall({x:-600,y:220,width:76,height:76},area).snap,'none');
});
test('right-docked confirmation grows leftwards without moving the circle edge', () => {
  const area={x:20,y:40,width:768,height:432}; const b={x:712,y:120,width:76,height:76};
  const expanded=G.confirmBounds(b,area,'right',true); assert.equal(expanded.width,348);assert.equal(expanded.x+expanded.width,b.x+b.width);assert.equal(expanded.y,b.y);
  assert.deepEqual(G.confirmBounds(expanded,area,'right',false),b);
});
test('confirmation normalizes rounded native sizes on every expansion, collapse and reflow', () => {
  for (const area of [{ x: -1280, y: -40, width: 1280, height: 720 }, { x: 20, y: 40, width: 200, height: 120 }]) {
    for (const snap of ['left', 'right', 'none']) {
      let bounds = { x: area.x + 30, y: area.y + 100, width: 77, height: 79 };
      for (let iteration = 0; iteration < 10; iteration++) {
        for (const expanded of [true, false]) {
          bounds = G.confirmBounds(bounds, area, snap, expanded);
          assert.equal(bounds.height, 76);
          assert.equal(bounds.width, expanded ? Math.min(348, area.width) : 76);
          assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
          if (snap === 'left') assert.equal(bounds.x, area.x);
          if (snap === 'right') assert.equal(bounds.x + bounds.width, area.x + area.width);
          bounds = { ...bounds, width: bounds.width + 1, height: bounds.height - 1 };
        }
      }
    }
  }
});
