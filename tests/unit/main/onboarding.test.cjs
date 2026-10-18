'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { needsOnboarding } = require('../../../src/main/onboarding.cjs');

const state = settings => ({ version: 1, students: [], settings });

test('a brand-new install starts the first-run flow', () => {
  assert.equal(needsOnboarding(null), true);
  assert.equal(needsOnboarding(null, { migrated: false }), true);
  assert.equal(needsOnboarding(undefined, {}), true);
});

test('a launch that just migrated an old profile leaves the decision to the renderer', () => {
  assert.equal(needsOnboarding(null, { migrated: true }), false);
});

test('only an explicit stored false asks for the first-run flow again', () => {
  assert.equal(needsOnboarding(state({ onboardingCompleted: false })), true);
  assert.equal(needsOnboarding(state({ onboardingCompleted: true })), false);
});

test('older saves, missing settings and interrupted writes never force the flow', () => {
  assert.equal(needsOnboarding(state({})), false);
  assert.equal(needsOnboarding({ version: 1, students: [] }), false);
  assert.equal(needsOnboarding({ version: 1, settings: null }), false);
  assert.equal(needsOnboarding({ version: 1, settings: 'broken' }), false);
  // A migrated profile with real data wins over a missing flag.
  assert.equal(needsOnboarding(state({ theme: 'dark' }), { migrated: true }), false);
});
