import test from 'node:test';
import assert from 'node:assert/strict';
import { isForcedRefresh } from '../site/prototype/immersive-exhibition/refresh-mode.js';
test('normal reload keeps position while forced reload bypasses the known controller', () => {
  const prior = { type: 'reload', previouslyControlled: true, registered: true };
  assert.equal(isForcedRefresh({ ...prior, controlled: true }), false);
  assert.equal(isForcedRefresh({ ...prior, controlled: false }), true);
});
test('first visit, back navigation, or removed worker must not be mistaken for hard refresh', () => {
  const prior = { type: 'reload', previouslyControlled: true, registered: true, controlled: false };
  assert.equal(isForcedRefresh({ ...prior, previouslyControlled: false }), false);
  assert.equal(isForcedRefresh({ ...prior, registered: false }), false);
  assert.equal(isForcedRefresh({ ...prior, type: 'navigate' }), false);
  assert.equal(isForcedRefresh({ ...prior, type: 'back_forward' }), false);
});
