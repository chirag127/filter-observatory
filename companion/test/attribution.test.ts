import assert from 'node:assert/strict';
import test from 'node:test';
import { AttributionGuard } from '../utils/attribution.ts';

test('activation away and back invalidates the original gesture', () => {
  const guard = new AttributionGuard();
  guard.setTarget({ id: 10, windowId: 2 });
  guard.observe({ kind: 'activated', tabId: 11, windowId: 2 });
  guard.observe({ kind: 'activated', tabId: 10, windowId: 2 });
  assert.throws(() => guard.assertUnchanged(), /changed/i);
});

test('focus loss and return stays invalid even with identical final IDs', () => {
  const guard = new AttributionGuard();
  guard.setTarget({ id: 10, windowId: 2 });
  guard.observe({ kind: 'focused', windowId: -1 });
  guard.observe({ kind: 'focused', windowId: 2 });
  assert.throws(() => guard.assertUnchanged(), /changed/i);
});

test('navigation while resolving an optional command tab cannot be forgotten', () => {
  const guard = new AttributionGuard();
  guard.observe({ kind: 'updated', tabId: 10, navigated: true });
  guard.setTarget({ id: 10, windowId: 2 });
  assert.throws(() => guard.assertUnchanged(), /changed/i);
});

test('an activation before optional target resolution cannot silently retarget the gesture', () => {
  const guard = new AttributionGuard();
  guard.observe({ kind: 'activated', tabId: 11, windowId: 2 });
  guard.setTarget({ id: 11, windowId: 2 });
  assert.throws(() => guard.assertUnchanged(), /changed/i);
});

test('background tab updates and activations in another window are irrelevant', () => {
  const guard = new AttributionGuard();
  guard.setTarget({ id: 10, windowId: 2 });
  guard.observe({ kind: 'updated', tabId: 11, navigated: true });
  guard.observe({ kind: 'updated', tabId: 10, navigated: false });
  guard.observe({ kind: 'activated', tabId: 12, windowId: 3 });
  guard.observe({ kind: 'focused', windowId: 2 });
  assert.doesNotThrow(() => guard.assertUnchanged());
});
