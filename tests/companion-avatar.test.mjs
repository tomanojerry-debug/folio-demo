import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { eyeTarget, stepEye, blinkScale, mountEyeTracking, mountCompanionAvatar } from "../site/curator/companion-avatar.js";

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, detail = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener({ type, ...detail });
  }
  count() { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
}

function environment({ reduced = false, centerX = 100 } = {}) {
  let now = 0, serial = 0, maximumFrames = 0;
  const frames = new Map(), timers = new Map(), observers = [];
  const win = new Events(), doc = new Events(), media = new Events(), root = new Events();
  media.matches = reduced;
  root.dataset = {};
  doc.hidden = false; doc.documentElement = root; doc.defaultView = win;
  Object.assign(win, {
    innerWidth: 1000,
    innerHeight: 800,
    document: doc,
    performance: { now: () => now },
    matchMedia: () => media,
    requestAnimationFrame(callback) { const id = ++serial; frames.set(id, callback); maximumFrames = Math.max(maximumFrames, frames.size); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
  });
  const attributes = new Map();
  const host = {
    dataset: {}, ownerDocument: doc, isConnected: true, childNodes: [{ static: true }],
    getBoundingClientRect: () => ({ left: centerX - 20, width: 40, top: 20, height: 44 }),
    closest: () => null,
    replaceChildren(...nodes) { this.childNodes = nodes; },
  };
  const eyes = {
    ownerDocument: doc, ownerSVGElement: host,
    closest: selector => selector === "[data-companion-avatar]" ? host : null,
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
  };
  function advance(milliseconds, interval = 16) {
    const end = now + milliseconds;
    while (now < end) {
      now = Math.min(end, now + interval);
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(now);
    }
  }
  return {
    win, doc, media, root, host, eyes, frames, timers, observers, advance,
    maximumFrames: () => maximumFrames,
    pointer: (clientX, clientY = 42) => win.dispatch("pointermove", { clientX, clientY, pointerType: "mouse" }),
    listeners: () => win.count() + doc.count() + root.count() + media.count(),
    setReduced(value) { media.matches = value; media.dispatch("change", { matches: value }); },
    setNativeReduced(value) {
      root.dataset.reduceMotion = String(value);
      for (const observer of observers) if (observer.active) observer.callback();
    },
  };
}

function addBlinkParts(env) {
  const parts = [[], []].map(history => ({ history, setAttribute(name, value) { if (name === "transform") history.push(value); } }));
  env.eyes.querySelectorAll = selector => selector === "[data-companion-blink]" ? parts : [];
  return parts;
}

test("horizontal gaze uses the actual avatar center, including negative displays, and has a hard safe limit", () => {
  assert.equal(eyeTarget(100, 100), 0);
  assert.ok(eyeTarget(150, 100) > 0, "a sidebar avatar must look right even before the pointer reaches the viewport midpoint");
  assert.equal(eyeTarget(-740, -500), -2);
  assert.equal(eyeTarget(-260, -500), 2);
  assert.equal(eyeTarget(1e9, 100), 2);
  assert.equal(eyeTarget(-1e9, 100), -2);
  assert.equal(eyeTarget(1000, 100, 240, 100), 2);
  assert.equal(eyeTarget(1000, 100, 240, 0), 0);
  assert.equal(eyeTarget(1000, 100, 240, -10), 0);
  for (const distance of [1, 25, 120, 240, 1000]) {
    assert.equal(eyeTarget(100 + distance, 100), -eyeTarget(100 - distance, 100));
  }
  for (const args of [[NaN, 0], [0, Infinity], [0, 0, 0], [0, 0, -1], [0, 0, NaN]]) {
    assert.equal(eyeTarget(...args), 0);
  }
});

test("smoothing is refresh-rate independent and reverses from its current position without overshoot", () => {
  const whole = stepEye(0, 2, 96);
  let split = 0;
  for (let i = 0; i < 6; i++) split = stepEye(split, 2, 16);
  assert.ok(Math.abs(whole - split) < 1e-12);
  const before = stepEye(0, 2, 100);
  assert.equal(stepEye(before, -2, 0), before);
  assert.ok(Math.abs(stepEye(before, -2, .0001) - before) < .001);
  const after = stepEye(before, -2, 16);
  assert.ok(after < before && after > -2);
  for (const duration of [1, 16, 95, 300, 10000]) {
    const offset = stepEye(2, -2, duration);
    assert.ok(offset >= -2 && offset <= 2);
  }
  for (const args of [[NaN, 2, 16], [1, Infinity, 16], [1, -2, NaN], [1, -2, -1]]) {
    assert.ok(Number.isFinite(stepEye(...args)) && Math.abs(stepEye(...args)) <= 2);
  }
});

test("natural blinking preserves both design centers and shares the gaze frame instead of an idle loop", () => {
  assert.equal(blinkScale(0), 1);
  assert.equal(blinkScale(1), 1);
  assert.ok(blinkScale(.5) > 0 && blinkScale(.5) < .1);
  for (const progress of [-1, 0, .1, .4, .5, .7, 1, 2, NaN]) assert.ok(blinkScale(progress) > 0 && blinkScale(progress) <= 1);
  const env = environment();
  const parts = addBlinkParts(env);
  const tracker = mountEyeTracking(env.eyes, { gazeTravel: 80, gazeVerticalTravel: 48 });
  assert.equal(env.frames.size, 0);
  assert.equal(env.timers.size, 1, "one sparse blink timeout is allowed while there is no animation frame loop");
  env.advance(5200);
  env.pointer(1000, 1000);
  env.advance(80);
  assert.ok(tracker.getState().blinkScale < .1);
  assert.ok(tracker.getState().artworkOffset > 0 && tracker.getState().artworkOffset < 80);
  assert.ok(tracker.getState().artworkOffsetY > 0 && tracker.getState().artworkOffsetY < 48);
  assert.equal(env.maximumFrames(), 1, "gaze and eyelids share a single scheduled frame");
  env.advance(1000);
  assert.equal(tracker.getState().blinkScale, 1);
  assert.equal(tracker.getState().artworkOffset, 80);
  assert.equal(tracker.getState().artworkOffsetY, 48);
  assert.equal(env.eyes.getAttribute("transform"), "translate(80 48)");
  assert.deepEqual(parts[0].history, parts[1].history, "the two lids close and reopen together without independent eye movement");
  assert.ok(parts[0].history.some(value => Number(value.match(/scale\(1 ([\d.]+)\)/)?.[1]) < .1));
  assert.equal(env.frames.size, 0, "the next sparse blink must not leave a standing RAF");
  assert.equal(tracker.getState().blinkPending, true);
  tracker.destroy();
  assert.equal(env.timers.size, 0);
});

test("hidden, reduced, blurred and torn-down avatars clear both gaze axes and reopen a half-closed blink", () => {
  for (const reason of ["hidden", "reduced", "native-reduced", "blur", "pagehide", "destroy"]) {
    const env = environment();
    const parts = addBlinkParts(env);
    const tracker = mountEyeTracking(env.eyes, { gazeTravel: 80, gazeVerticalTravel: 48 });
    env.advance(5200);
    env.pointer(1000, 1000);
    env.advance(96);
    assert.ok(tracker.getState().blinkScale < .1, reason);
    assert.ok(tracker.getState().offset > 0 && tracker.getState().offsetY > 0, reason);
    if (reason === "hidden") { env.doc.hidden = true; env.doc.dispatch("visibilitychange"); }
    else if (reason === "reduced") env.setReduced(true);
    else if (reason === "native-reduced") env.setNativeReduced(true);
    else if (reason === "blur") env.win.dispatch("blur");
    else if (reason === "pagehide") env.win.dispatch("pagehide");
    else tracker.destroy();
    assert.equal(tracker.getState().target, 0, reason);
    assert.equal(tracker.getState().targetY, 0, reason);
    env.advance(reason === "blur" ? 1200 : 32);
    assert.equal(tracker.getState().offset, 0, reason);
    assert.equal(tracker.getState().offsetY, 0, reason);
    assert.equal(tracker.getState().blinkScale, 1, reason);
    assert.equal(tracker.getState().blinkPending, false, reason);
    assert.equal(env.frames.size, 0, reason);
    assert.equal(env.timers.size, 0, reason);
    for (const part of parts) assert.equal(part.history.at(-1), "scale(1 1)", reason);
    env.advance(10000);
    assert.equal(env.frames.size, 0, reason);
    assert.equal(env.timers.size, 0, reason);
    tracker.destroy();
    assert.equal(env.listeners(), 0, reason);
    assert.ok(env.observers.every(observer => !observer.active), reason);
  }
});

test("one paired-eye group follows an off-center host, coalesces pointer events and stops frames while still", () => {
  const env = environment({ centerX: 100 });
  const tracker = mountEyeTracking(env.eyes, { idleMs: 2000 });
  assert.equal(env.frames.size, 0, "mounting a static avatar must not start an idle animation loop");
  for (let i = 0; i < 100; i++) env.pointer(500);
  assert.equal(env.frames.size, 1, "rapid input shares one pending frame");
  assert.ok(tracker.getState().target > 0);
  env.advance(1500);
  assert.ok(tracker.getState().offset > 1.9 && tracker.getState().offset <= 2);
  assert.equal(env.frames.size, 0, "settled gaze does not keep requesting frames");
  assert.match(env.eyes.getAttribute("transform"), /^translate\([^ ]+ 0\)$/, "the shared eye group never acquires vertical drift or separate-eye transforms");
  env.advance(1800);
  assert.equal(tracker.getState().offset, 0);
  assert.equal(tracker.getState().target, 0);
  assert.equal(env.frames.size, 0);
  assert.equal(env.timers.size, 0);
  tracker.destroy();
});

test("left/right reversal and leaving or blurring the page return smoothly to center", () => {
  const env = environment();
  const tracker = mountEyeTracking(env.eyes);
  env.pointer(1000); env.advance(200);
  const right = tracker.getState().offset;
  env.pointer(-500);
  assert.equal(tracker.getState().offset, right, "changing direction cannot snap the current gaze");
  env.advance(16);
  assert.ok(tracker.getState().offset < right && tracker.getState().offset > -2);
  env.advance(1000);
  const left = tracker.getState().offset;
  env.root.dispatch("pointerleave");
  assert.equal(tracker.getState().offset, left, "leaving begins a return rather than teleporting the eyes");
  assert.equal(tracker.getState().target, 0);
  env.advance(1000);
  assert.equal(tracker.getState().offset, 0);
  env.pointer(1000); env.advance(200);
  env.win.dispatch("blur"); env.advance(1000);
  assert.equal(tracker.getState().offset, 0);
  assert.equal(env.frames.size, 0);
  tracker.destroy();
});

test("asset-space face metadata uses both screen projection coordinates and maps each axis to its pixel travel", () => {
  const env = environment({ centerX: 100 });
  const attributes = {
    "data-companion-face-x": "623", "data-companion-face-y": "554",
    "data-companion-body-width": "879", "data-companion-body-height": "886",
    "data-companion-gaze-reach-body-scale": "1.5",
    "data-companion-gaze-travel": "80", "data-companion-gaze-vertical-travel": "48",
  };
  env.host.getAttribute = name => attributes[name] ?? null;
  env.host.getScreenCTM = () => ({ a: .5, b: .2, c: .1, d: .4, e: 50, f: 20 });
  const tracker = mountEyeTracking(env.eyes);
  env.pointer(416.9, 366.2);
  assert.ok(Math.abs(tracker.getState().target) < 1e-12, "the centered face projects to x416.9; the containing host center at x100 is not its gaze origin");
  assert.ok(Math.abs(tracker.getState().targetY) < 1e-12, "the centered face projects to y366.2 through both CTM b and d coefficients");
  env.pointer(416.9 + 879 * Math.hypot(.5, .2) * 1.5 / 2, 366.2 - 886 * Math.hypot(.1, .4) * 1.5 / 2);
  assert.ok(Math.abs(tracker.getState().target - 1) < 1e-12, "horizontal reach uses the projected body edge length, including the CTM b coefficient");
  assert.ok(Math.abs(tracker.getState().targetY + 1) < 1e-12, "vertical reach includes the CTM c coefficient");
  env.pointer(10000, -10000); env.advance(1500);
  assert.equal(tracker.getState().offset, 2);
  assert.equal(tracker.getState().offsetY, -2);
  assert.equal(tracker.getState().artworkOffset, 80);
  assert.equal(tracker.getState().artworkOffsetY, -48);
  assert.equal(env.eyes.getAttribute("transform"), "translate(80 -48)");
  env.pointer(-10000, 10000); env.advance(1500);
  assert.equal(tracker.getState().offset, -2);
  assert.equal(tracker.getState().offsetY, 2);
  assert.equal(tracker.getState().artworkOffset, -80);
  assert.equal(tracker.getState().artworkOffsetY, 48);
  assert.equal(env.eyes.getAttribute("transform"), "translate(-80 48)");
  tracker.destroy();
});

test("gaze follows nearby pointers within the central inner area regardless of avatar or viewport size", () => {
  for (const scale of [.035, .16]) {
    const env = environment();
    const attributes = {
      "data-companion-face-x": "623", "data-companion-face-y": "554",
      "data-companion-body-width": "879", "data-companion-body-height": "886",
      "data-companion-gaze-reach-body-scale": "1.5",
      "data-companion-gaze-travel": "80", "data-companion-gaze-vertical-travel": "48",
    };
    env.host.getAttribute = name => attributes[name] ?? null;
    env.host.getScreenCTM = () => ({ a: scale, b: 0, c: 0, d: scale * 1.2, e: -12, f: 140 });
    const faceX = 623 * scale - 12, faceY = 554 * scale * 1.2 + 140;
    const reachX = 879 * scale * 1.5, reachY = 886 * scale * 1.2 * 1.5;
    const tracker = mountEyeTracking(env.eyes);
    env.pointer(faceX + reachX / 2, faceY - reachY / 2);
    assert.ok(Math.abs(tracker.getState().target - 1) < 1e-12);
    assert.ok(Math.abs(tracker.getState().targetY + 1) < 1e-12);
    env.win.innerWidth = 100000; env.win.innerHeight = 100000;
    env.pointer(faceX + reachX / 2, faceY - reachY / 2);
    assert.ok(Math.abs(tracker.getState().target - 1) < 1e-12, "a larger display cannot turn near-field gaze into a tiny movement");
    assert.ok(Math.abs(tracker.getState().targetY + 1) < 1e-12);
    env.pointer(faceX - reachX * 1.01, faceY); env.advance(1200);
    assert.equal(tracker.getState().artworkOffset, -80);
    assert.equal(623 + tracker.getState().artworkOffset, 543, "left gaze shifts the pair center left while keeping both eyes in the inner area");
    env.pointer(faceX + reachX * 1.01, faceY + reachY * 1.01); env.advance(1200);
    assert.equal(tracker.getState().artworkOffset, 80);
    assert.equal(tracker.getState().artworkOffsetY, 48);
    assert.equal(623 + tracker.getState().artworkOffset, 703, "right gaze shifts the pair center right within the inner area");
    assert.equal(env.maximumFrames(), 1);
    tracker.destroy();
  }
});

test("zero idle delay holds the pointer's gaze without a frame loop and recomputes after layout movement", () => {
  const env = environment();
  addBlinkParts(env);
  const attributes = {
    "data-companion-face-x": "623", "data-companion-face-y": "554",
    "data-companion-body-width": "879", "data-companion-body-height": "886",
    "data-companion-gaze-reach-body-scale": "1.5", "data-companion-idle-ms": "0",
    "data-companion-gaze-travel": "80", "data-companion-gaze-vertical-travel": "48",
  };
  const matrix = { a: .04, b: 0, c: 0, d: .04, e: 100 - 623 * .04, f: 100 - 554 * .04 };
  env.host.getAttribute = name => attributes[name] ?? null;
  env.host.getScreenCTM = () => matrix;
  const tracker = mountEyeTracking(env.eyes);
  env.pointer(40, 100); env.advance(6000);
  assert.equal(tracker.getState().target, -2, "a still pointer keeps looking left after the previous two-second auto-return interval");
  assert.equal(tracker.getState().artworkOffset, -80);
  assert.equal(env.frames.size, 0, "holding gaze does not require an animation loop");
  assert.equal(env.timers.size, 1, "only the sparse natural-blink timeout remains; zero idle must not schedule a return");
  matrix.e -= 100;
  env.win.dispatch("scroll");
  assert.ok(tracker.getState().target > 0, "moving the face past the last pointer recomputes direction without another pointer event");
  assert.equal(tracker.getState().artworkOffset, -80, "layout movement retargets from the presented gaze rather than snapping");
  env.advance(1200);
  assert.ok(tracker.getState().artworkOffset > 0);
  Object.assign(matrix, { a: .08, d: .08, e: 100 - 623 * .08, f: 100 - 554 * .08 });
  env.win.dispatch("resize");
  assert.ok(Math.abs(tracker.getState().target - -120 / (879 * .08 * 1.5)) < 1e-12, "resize updates the body-scaled reach as well as the face origin");
  env.win.dispatch("blur"); env.advance(1200);
  env.win.dispatch("scroll"); env.win.dispatch("resize"); env.advance(32);
  assert.equal(tracker.getState().offset, 0, "layout events cannot revive a gaze cleared by losing focus");
  assert.equal(tracker.getState().offsetY, 0);
  tracker.destroy();
  assert.equal(env.listeners(), 0);
  assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  const stopped = tracker.getState();
  env.win.dispatch("scroll"); env.win.dispatch("resize"); env.advance(10000);
  assert.deepEqual(tracker.getState(), stopped);
});

test("up, down and diagonal gaze reverse continuously within separate limits and share one idle return", () => {
  const env = environment();
  const updates = [];
  const tracker = mountEyeTracking(env.eyes, { gazeTravel: 80, gazeVerticalTravel: 48, idleMs: 2000, onState: state => updates.push(state) });
  env.pointer(100, -1000); env.advance(1000);
  assert.equal(tracker.getState().artworkOffset, 0);
  assert.equal(tracker.getState().artworkOffsetY, -48, "client up is negative source Y");
  assert.equal(updates.at(-1).verticalPosition, "up");
  assert.equal(updates.at(-1).direction, "up", "purely vertical movement still updates the preview direction");
  env.pointer(100, 1000);
  assert.equal(tracker.getState().artworkOffsetY, -48, "reversal starts at the current gaze");
  env.advance(16);
  assert.ok(tracker.getState().artworkOffsetY > -48 && tracker.getState().artworkOffsetY < 48);
  env.advance(1000);
  assert.equal(tracker.getState().artworkOffsetY, 48);
  assert.equal(updates.at(-1).direction, "down");
  env.pointer(1000, -1000); env.advance(200);
  const from = tracker.getState();
  assert.ok(from.artworkOffset > 0 && from.artworkOffsetY < 0);
  env.pointer(-1000, 1000);
  assert.equal(tracker.getState().offset, from.offset);
  assert.equal(tracker.getState().offsetY, from.offsetY);
  env.advance(16);
  assert.ok(tracker.getState().offset < from.offset && tracker.getState().offsetY > from.offsetY);
  env.advance(1000);
  assert.equal(tracker.getState().artworkOffset, -80);
  assert.equal(tracker.getState().artworkOffsetY, 48);
  assert.equal(updates.at(-1).direction, "down-left");
  const corner = tracker.getState();
  env.pointer(100, -1000); env.advance(160);
  const aligned = tracker.getState();
  const progressedX = (aligned.offset - corner.offset) / -corner.offset;
  const progressedY = (aligned.offsetY - corner.offsetY) / (-2 - corner.offsetY);
  assert.ok(Math.abs(progressedX - progressedY) < 1e-10, "an X target of zero during upward tracking must use the same follow timing as Y, rather than the idle-return timing");
  env.advance(1000);
  assert.equal(updates.at(-1).direction, "up");
  assert.equal(env.maximumFrames(), 1);
  assert.equal(env.timers.size, 1, "both axes share one inactivity timeout");
  env.advance(2500);
  const resting = tracker.getState();
  assert.equal(resting.offset, 0); assert.equal(resting.offsetY, 0);
  assert.equal(resting.target, 0); assert.equal(resting.targetY, 0);
  assert.equal(updates.at(-1).direction, "center");
  assert.equal(env.eyes.getAttribute("transform"), "translate(0 0)");
  assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  tracker.destroy();
});

test("hidden and reduced-motion states center the eyes and cancel active work, then resume only on real input", () => {
  const env = environment({ reduced: true });
  const tracker = mountEyeTracking(env.eyes);
  env.pointer(1000); env.advance(200);
  assert.equal(tracker.getState().offset, 0);
  assert.equal(env.frames.size, 0);
  env.setReduced(false); env.pointer(1000); env.advance(100);
  assert.ok(tracker.getState().offset > 0);
  env.setReduced(true);
  assert.equal(tracker.getState().offset, 0);
  assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  env.setReduced(false); env.pointer(-1000); env.advance(100);
  env.doc.hidden = true; env.doc.dispatch("visibilitychange");
  assert.equal(tracker.getState().offset, 0);
  env.pointer(1000); env.advance(200);
  assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  env.doc.hidden = false; env.doc.dispatch("visibilitychange");
  assert.equal(env.frames.size, 0);
  env.pointer(1000); env.advance(100);
  env.setNativeReduced(true);
  assert.equal(tracker.getState().offset, 0);
  assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  tracker.destroy();
});

test("page teardown and explicit destruction release every listener, observer, timeout and pending frame", () => {
  for (const viaPagehide of [false, true]) {
    const env = environment();
    const tracker = mountEyeTracking(env.eyes, { idleMs: 2000 });
    env.pointer(1000);
    assert.equal(env.frames.size, 1);
    assert.ok(env.listeners() > 0 && env.timers.size > 0);
    if (viaPagehide) env.win.dispatch("pagehide");
    else tracker.destroy();
    tracker.destroy();
    assert.equal(tracker.getState().destroyed, true);
    assert.equal(env.listeners(), 0);
    assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
    assert.ok(env.observers.every(observer => !observer.active));
    const stopped = tracker.getState();
    env.pointer(-1000); env.advance(5000);
    assert.deepEqual(tracker.getState(), stopped);
  }
});

test("a removed avatar releases its tracking resources on the next event instead of retaining a detached host", () => {
  for (const check of ["pointer", "frame", "idle"]) {
    const env = environment();
    const tracker = mountEyeTracking(env.eyes, { idleMs: 2000 });
    env.pointer(1000);
    if (check === "idle") env.advance(1000);
    env.host.isConnected = false;
    if (check === "pointer") env.pointer(-1000);
    else env.advance(check === "frame" ? 16 : 2500);
    assert.equal(tracker.getState().destroyed, true, check);
    assert.equal(env.listeners(), 0, check);
    assert.equal(env.frames.size, 0, check);
    assert.equal(env.timers.size, 0, check);
    assert.ok(env.observers.every(observer => !observer.active), check);
  }
});

test("an avatar destroyed before its shared artwork arrives cannot replace markup or install tracking", async () => {
  const env = environment();
  let resolve;
  env.win.fetch = () => new Promise(done => { resolve = done; });
  const original = [...env.host.childNodes];
  const controller = mountCompanionAvatar(env.host, { sourceURL: "https://assets.example.test/cancelled-companion.svg" });
  controller.destroy();
  resolve({ ok: true, text: async () => "<svg>late artwork must not be parsed</svg>" });
  assert.equal(await controller.ready, false);
  assert.deepEqual(env.host.childNodes, original);
  assert.equal(env.listeners(), 0);
  assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
});

test("the canonical artwork preserves the front-facing shell, level upright eyes and comfortable edge spacing", async () => {
  const [svg, layoutJSON, shellPNG] = await Promise.all([
    readFile(new URL("../site/curator/ink-avatar.svg", import.meta.url), "utf8"),
    readFile(new URL("../site/curator/companion-layout.json", import.meta.url), "utf8"),
    readFile(new URL("../site/curator/companion-shell.png", import.meta.url)),
  ]);
  const layout = JSON.parse(layoutJSON);
  const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
  const near = (actual, expected, tolerance = .01) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should remain near ${expected}`);
  const root = attributes(svg.match(/<svg\b[^>]*>/)?.[0] || "");
  assert.deepEqual(root.viewBox.split(/\s+/).map(Number), [160, 168, 928, 928]);
  assert.deepEqual(layout.canvas, { width: 1254, height: 1254 });
  assert.equal(layout.version, 6);
  assert.equal(layout.source, "front-orthographic-graphite-soft-card");
  assert.equal(shellPNG.readUInt32BE(16), layout.canvas.width);
  assert.equal(shellPNG.readUInt32BE(20), layout.canvas.height);
  assert.equal(shellPNG[25], 6, "the approved shell retains an RGBA transparency channel");
  const image = attributes(svg.match(/<image\b[^>]*\bdata-companion-shell\b[^>]*>/)?.[0] || "");
  const source = image.href || image["xlink:href"] || "";
  assert.match(source, /^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(source.split(",")[1], "base64"), shellPNG, "static and interactive artwork must embed the authoritative shell pixels");
  assert.deepEqual([image.x, image.y, image.width, image.height].map(Number), [0, 0, 1254, 1254]);
  near(Number(root["data-companion-face-x"]), 623);
  near(Number(root["data-companion-face-y"]), 554);
  assert.equal(Number(root["data-companion-body-width"]), 892);
  assert.equal(Number(root["data-companion-body-height"]), 889);
  assert.equal(Number(root["data-companion-gaze-reach-body-scale"]), 1.5);
  assert.equal(Number(root["data-companion-gaze-travel"]), 80);
  assert.equal(Number(root["data-companion-gaze-vertical-travel"]), 48);
  assert.equal(layout.gaze.maximumOffset, 80);
  assert.equal(layout.gaze.maximumVerticalOffset, 48);
  assert.equal(layout.gaze.reachBodyScale, 1.5);
  assert.deepEqual(layout.eyeSafeBounds, { x: 440, y: 440, width: 366, height: 228 });
  assert.equal(Number(root["data-companion-response-ms"]), 110);
  assert.equal(Number(root["data-companion-return-ms"]), 180);
  assert.equal(Number(root["data-companion-idle-ms"]), 0);
  assert.equal(layout.gaze.idleMs, 0);
  assert.equal([...svg.matchAll(/\bdata-companion-eyes(?:\s|=|>)/g)].length, 1);
  assert.match(svg, /<g\b[^>]*clip-path="url\(#companion-window-clip\)"/);
  const baseline = [
    { name: "left", cx: 551, cy: 554, angle: 0 },
    { name: "right", cx: 695, cy: 554, angle: 0 },
  ];
  const drawn = [];
  for (const expected of baseline) {
    const group = svg.match(new RegExp(`<g\\b[^>]*\\bdata-companion-eye="${expected.name}"[^>]*>([\\s\\S]*?)<\\/g>`));
    assert.ok(group, `missing ${expected.name} eye`);
    const transform = attributes(group[0].slice(0, group[0].indexOf(">") + 1)).transform || "";
    const placement = transform.match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)\s*rotate\(\s*([-\d.]+)\s*\)/);
    assert.ok(placement, "each front-facing eye retains a fixed center separate from the animated group");
    const [cx, cy, angle] = placement.slice(1).map(Number);
    near(cx, expected.cx); near(cy, expected.cy); near(angle, expected.angle);
    const rect = attributes(group[1].match(/<rect\b[^>]*>/)?.[0] || "");
    assert.deepEqual([rect.x, rect.y, rect.width, rect.height, rect.rx].map(Number), [-25, -59, 50, 118, 25]);
    assert.match(group[1], /data-companion-blink/);
    const record = layout.eyes.find(eye => eye.name === expected.name);
    near(record.cx, cx); near(record.cy, cy); near(record.angle, angle);
    near(record.width, Number(rect.width)); near(record.height, Number(rect.height));
    drawn.push({ cx, cy, angle });
    const radians = angle * Math.PI / 180;
    const halfWidth = 25 + 34 * Math.abs(Math.sin(radians));
    const halfHeight = 25 + 34 * Math.abs(Math.cos(radians));
    for (const offset of [-layout.gaze.maximumOffset, 0, layout.gaze.maximumOffset]) {
      for (const offsetY of [-layout.gaze.maximumVerticalOffset, 0, layout.gaze.maximumVerticalOffset]) {
        assert.ok(cx - halfWidth + offset > layout.eyeSafeBounds.x);
        assert.ok(cx + halfWidth + offset < layout.eyeSafeBounds.x + layout.eyeSafeBounds.width);
        assert.ok(cy - halfHeight + offsetY > layout.eyeSafeBounds.y);
        assert.ok(cy + halfHeight + offsetY < layout.eyeSafeBounds.y + layout.eyeSafeBounds.height);
        assert.ok(cx - halfWidth + offset - layout.windowBounds.x >= 182, "full left gaze retains the window's rounded-corner margin");
        assert.ok(layout.windowBounds.x + layout.windowBounds.width - (cx + halfWidth + offset) >= 182, "full right gaze retains the same margin");
        assert.ok(cy - halfHeight + offsetY - layout.windowBounds.y >= 163, "full upward gaze stays clear of the rounded top corners");
        assert.ok(layout.windowBounds.y + layout.windowBounds.height - (cy + halfHeight + offsetY) >= 163, "full downward gaze retains the same margin");
      }
    }
  }
  near(drawn[1].cx - drawn[0].cx, 144);
  near(drawn[1].cy - drawn[0].cy, 0);
  const windowCenter = { x: layout.windowBounds.x + layout.windowBounds.width / 2, y: layout.windowBounds.y + layout.windowBounds.height / 2 };
  near((drawn[0].cx + drawn[1].cx) / 2, windowCenter.x);
  near(drawn[0].cy, windowCenter.y);
  assert.deepEqual(layout.faceCenter, windowCenter, "resting gaze is centered in the actual black window");
});

test("the interactive preview references the canonical artwork and controller without a private desktop dependency", async () => {
  const preview = new URL("../site/curator/companion-preview.html", import.meta.url);
  const html = await readFile(preview, "utf8");
  assert.match(html, /data-companion-preview/);
  assert.equal([...html.matchAll(/\bdata-preview-companion(?:\s|=|>)/g)].length, 1);
  assert.match(html, /data-preview-reduced-motion/);
  for (const label of ["上方观察区", "下方观察区", "左侧观察区", "右侧观察区"]) assert.ok(html.includes(`aria-label="${label}"`));
  assert.match(html, /<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="\.\/companion-avatar\.js")[^>]*>/);
  assert.match(html, /href="\.\/companion-avatar\.css"/);
  assert.match(html, /src="\.\/ink-avatar\.svg"/);
  assert.doesNotMatch(html, /desktop-legacy-bridge|\/api\/desktop|\/api\/forme|webkit\.messageHandlers/);
  const resources = [...html.matchAll(/\b(?:src|href)="([^"#]+\.(?:js|css|svg)(?:\?[^"#]*)?)"/g)].map(([, source]) => source);
  for (const source of new Set(resources)) assert.equal((await stat(new URL(source, preview))).isFile(), true, source);
  const chat = await readFile(new URL("../site/curator/index.html", import.meta.url), "utf8");
  assert.match(chat, /href="(?:\.\/)?companion-avatar\.css(?:\?[^"]*)?"/);
  const entry = await readFile(new URL("../site/curator/main.js", import.meta.url), "utf8");
  assert.match(entry, /import\s*\{\s*mountCompanionAvatar\s*\}\s*from\s*['"]\.\/companion-avatar\.js['"]/);
});
