import test from "node:test";
import assert from "node:assert/strict";
import { closeGlassOverlay, closeGlassDialog, glassReducedMotion } from "../site/curator/glass-dialogs.js";

// These fakes expose only the browser lifecycle used by the close helpers. An
// animation stays pending until the test finishes or interrupts it explicitly.
function browser(t, { reduced = false, systemReduced = false } = {}) {
  const values = {
    document: { documentElement: { dataset: { reduceMotion: String(reduced) } } },
    matchMedia: () => ({ matches: systemReduced }),
    getComputedStyle: () => ({ opacity: "1", transform: "none" }),
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  return values.document;
}

function element({ surface = null, open = false } = {}) {
  return {
    isConnected: true,
    open,
    dataset: {},
    animations: [],
    closeCalls: 0,
    removeCalls: 0,
    querySelector() { return surface; },
    animate() {
      let finish, interrupt;
      const animation = {
        finished: new Promise((resolve, reject) => { finish = resolve; interrupt = reject; }),
        finish() { finish(); },
        interrupt() { interrupt(new DOMException("Animation was interrupted", "AbortError")); },
        cancelCalls: 0,
        cancel() { this.cancelCalls += 1; },
      };
      this.animations.push(animation);
      return animation;
    },
    close() { this.open = false; this.closeCalls += 1; },
    remove() { this.isConnected = false; this.removeCalls += 1; },
  };
}

test("overlay commits business changes only after its panel and backdrop both exit", async t => {
  browser(t);
  const panel = element();
  const overlay = element({ surface: panel });
  let commits = 0;
  const done = closeGlassOverlay(overlay, () => { commits += 1; overlay.remove(); });

  assert.equal(commits, 0, "Starting an exit must not submit or remove the current content");
  assert.equal(overlay.isConnected, true);
  assert.equal(overlay.dataset.glassClosing, "true");
  assert.equal(panel.animations.length, 1);
  assert.equal(overlay.animations.length, 1);

  panel.animations[0].finish();
  await Promise.resolve();
  assert.equal(commits, 0, "The still-visible backdrop must finish before the change commits");
  overlay.animations[0].finish();
  await done;

  assert.equal(commits, 1);
  assert.equal(overlay.isConnected, false);
  assert.equal(overlay.removeCalls, 1);
  assert.equal(Object.hasOwn(overlay.dataset, "glassClosing"), false);
  assert.equal(panel.animations[0].cancelCalls, 1);
  assert.equal(overlay.animations[0].cancelCalls, 1);
});

test("repeated close requests reuse the in-flight promise and commit only once", async t => {
  browser(t);
  const overlay = element();
  let firstCommits = 0, duplicateCommits = 0;
  const first = closeGlassOverlay(overlay, () => { firstCommits += 1; overlay.remove(); });
  const second = closeGlassOverlay(overlay, () => { duplicateCommits += 1; });

  assert.strictEqual(first, second);
  assert.equal(overlay.animations.length, 1, "Repeated Escape/click must not start a second exit");
  assert.equal(firstCommits, 0);
  overlay.animations[0].finish();
  await Promise.all([first, second]);

  assert.equal(firstCommits, 1);
  assert.equal(duplicateCommits, 0);
  assert.equal(overlay.removeCalls, 1);
});

test("an interrupted exit still commits once and clears all animation state", async t => {
  browser(t);
  const panel = element();
  const overlay = element({ surface: panel });
  let commits = 0;
  const done = closeGlassOverlay(overlay, () => { commits += 1; overlay.remove(); });

  panel.animations[0].interrupt();
  await Promise.resolve();
  assert.equal(commits, 0, "Cancelling the panel must still wait for the backdrop");
  overlay.animations[0].interrupt();
  await assert.doesNotReject(done);

  assert.equal(commits, 1);
  assert.equal(Object.hasOwn(overlay.dataset, "glassClosing"), false);
  assert.equal(panel.animations[0].cancelCalls, 1);
  assert.equal(overlay.animations[0].cancelCalls, 1);
});

test("a render that detaches an exiting overlay does not discard its pending close", async t => {
  browser(t);
  const overlay = element();
  let openCollection = "collection-one";
  let commits = 0;
  const done = closeGlassOverlay(overlay, () => {
    commits += 1;
    if (openCollection === "collection-one") openCollection = null;
  });
  const repeated = closeGlassOverlay(overlay, () => { throw new Error("Duplicate close committed"); });
  assert.strictEqual(repeated, done);

  // An editing/refresh render can replace this DOM node while business state
  // still considers the collection open. The scheduled close remains valid.
  overlay.remove();
  assert.equal(overlay.isConnected, false);
  assert.strictEqual(closeGlassOverlay(overlay, () => { throw new Error("Detached duplicate close committed"); }), done);
  assert.equal(openCollection, "collection-one");
  assert.equal(commits, 0);
  overlay.animations[0].finish();
  await Promise.all([done, repeated]);

  assert.equal(commits, 1);
  assert.equal(openCollection, null);
  assert.equal(Object.hasOwn(overlay.dataset, "glassClosing"), false);
  assert.equal(overlay.animations[0].cancelCalls, 1);
});

test("native dialogs stay open until their exit completes and close once", async t => {
  browser(t);
  const dialog = element({ open: true });
  const first = closeGlassDialog(dialog);
  const second = closeGlassDialog(dialog);
  assert.strictEqual(first, second);
  assert.equal(dialog.open, true);
  assert.equal(dialog.closeCalls, 0);

  dialog.animations[0].finish();
  await first;
  assert.equal(dialog.open, false);
  assert.equal(dialog.closeCalls, 1);
  assert.equal(Object.hasOwn(dialog.dataset, "glassClosing"), false);
});

test("the native accessibility preference closes immediately without animation", async t => {
  browser(t, { reduced: true });
  const dialog = element({ open: true });
  assert.equal(glassReducedMotion(), true);
  const done = closeGlassDialog(dialog);
  assert.equal(dialog.open, false, "Reduced motion must not delay closing by an animation frame");
  assert.equal(dialog.closeCalls, 1);
  assert.equal(dialog.animations.length, 0);
  assert.equal(Object.hasOwn(dialog.dataset, "glassClosing"), false);
  await done;
});

test("the browser reduced-motion preference also commits immediately", async t => {
  browser(t, { systemReduced: true });
  const overlay = element();
  let commits = 0;
  assert.equal(glassReducedMotion(), true);
  const done = closeGlassOverlay(overlay, () => { commits += 1; overlay.remove(); });
  assert.equal(commits, 1);
  assert.equal(overlay.animations.length, 0);
  await done;
});

test("an inactive or missing native dialog is a no-op", async t => {
  browser(t);
  const dialog = element({ open: false });
  await closeGlassDialog(dialog);
  await closeGlassDialog(null);
  await closeGlassDialog(undefined);
  assert.equal(dialog.closeCalls, 0);
  assert.equal(dialog.removeCalls, 0);
  assert.equal(dialog.animations.length, 0);
  assert.deepEqual(dialog.dataset, {});
});

test("a browser without the animation API still closes usable dialogs", async t => {
  browser(t);
  const dialog = element({ open: true });
  delete dialog.animate;
  await closeGlassDialog(dialog);
  assert.equal(dialog.open, false);
  assert.equal(dialog.closeCalls, 1);
  assert.deepEqual(dialog.dataset, {});
});
