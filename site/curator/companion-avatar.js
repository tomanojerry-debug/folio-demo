const LIMIT = 2;
const RESPONSE_MS = 95;
const STILL_MS = 2000;
const EPSILON = .005;
const sourceRequests = new Map();
const mountedAvatars = new WeakMap();
let artworkSerial = 0;

const bounded = value => Number.isFinite(value) ? Math.max(-LIMIT, Math.min(LIMIT, value)) : 0;

/** Horizontal gaze around the actual face center, normalized independently of asset pixels. */
export function eyeTarget(pointerX, centerX, reach = 240, limit = LIMIT) {
  if (![pointerX, centerX, reach].every(Number.isFinite) || reach <= 0) return 0;
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.min(LIMIT, limit)) : LIMIT;
  return Math.max(-1, Math.min(1, (pointerX - centerX) / reach)) * maximum;
}

/** Exponential response is stable across refresh rates and never overshoots. */
export function stepEye(current, target, elapsedMs, responseMs = RESPONSE_MS) {
  const start = bounded(current), end = bounded(target);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return start;
  const response = Number.isFinite(responseMs) && responseMs > 0 ? responseMs : RESPONSE_MS;
  return start + (end - start) * -Math.expm1(-elapsedMs / response);
}

/** A brief paired blink; each eye scales around its own fixed design center. */
export function blinkScale(progress) {
  if (!Number.isFinite(progress)) return 1;
  const p = Math.max(0, Math.min(1, progress));
  const ease = value => (1 - Math.cos(Math.PI * value)) / 2;
  if (p < .42) return 1 - .94 * ease(p / .42);
  if (p < .54) return .06;
  return .06 + .94 * ease((p - .54) / .46);
}

/** Each eye group owns its short-lived frames and blink timer. */
export function mountEyeTracking(eyeGroup, {
  win = eyeGroup?.ownerDocument?.defaultView,
  doc = eyeGroup?.ownerDocument,
  host = eyeGroup?.closest?.('[data-companion-avatar]') || eyeGroup?.ownerSVGElement,
  idleMs,
  faceCenter,
  bodySize,
  reachBodyScale,
  gazeTravel,
  gazeVerticalTravel,
  followResponseMs,
  returnResponseMs,
  onState = () => {},
} = {}) {
  if (!eyeGroup || !win || !doc || !host) throw new TypeError('An eye group, host and document are required.');
  let offset = 0, target = 0, frame = null, idle = null, lastFrame = null, destroyed = false;
  let offsetY = 0, targetY = 0;
  let lastPointer = null;
  let blinkTimer = null, blinkStarted = null, eyelid = 1, blinkSequence = 0, focused = true;
  let lastPosition = '';
  const removals = [];
  const svg = eyeGroup.ownerSVGElement;
  const coordinate = name => {
    const value = svg?.getAttribute?.(name);
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const artworkFace = faceCenter || { x: coordinate('data-companion-face-x'), y: coordinate('data-companion-face-y') };
  const artworkBody = bodySize || { width: coordinate('data-companion-body-width'), height: coordinate('data-companion-body-height') };
  const configuredReachScale = reachBodyScale ?? coordinate('data-companion-gaze-reach-body-scale');
  const reachScale = Number.isFinite(configuredReachScale) && configuredReachScale > 0 ? configuredReachScale : 1.5;
  const configuredTravel = gazeTravel ?? coordinate('data-companion-gaze-travel');
  const travel = Number.isFinite(configuredTravel) && configuredTravel >= 0 ? configuredTravel : LIMIT;
  const configuredVerticalTravel = gazeVerticalTravel ?? coordinate('data-companion-gaze-vertical-travel');
  const verticalTravel = Number.isFinite(configuredVerticalTravel) && configuredVerticalTravel >= 0 ? configuredVerticalTravel : 0;
  const response = followResponseMs ?? coordinate('data-companion-response-ms') ?? 110;
  const returning = returnResponseMs ?? coordinate('data-companion-return-ms') ?? 160;
  const still = idleMs ?? coordinate('data-companion-idle-ms') ?? STILL_MS;
  const blinkParts = [...(eyeGroup.querySelectorAll?.('[data-companion-blink]') || [])];
  const artworkOffset = () => offset * travel / LIMIT;
  const artworkOffsetY = () => offsetY * verticalTravel / LIMIT;
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reduced = () => Boolean(media?.matches || doc.documentElement?.dataset?.reduceMotion === 'true');
  const hidden = () => Boolean(doc.hidden || host.closest?.('[hidden]'));
  const state = () => ({ offset, target, offsetY, targetY, artworkOffset: artworkOffset(), artworkOffsetY: artworkOffsetY(), blinkScale: eyelid, blinkPending: blinkTimer !== null || blinkStarted !== null, framePending: frame !== null, destroyed, reducedMotion: reduced() });
  const listen = (node, type, callback, options) => {
    if (!node?.addEventListener) return;
    node.addEventListener(type, callback, options);
    removals.push(() => node.removeEventListener(type, callback, options));
  };
  function paint() {
    eyeGroup.setAttribute('transform', `translate(${Number(artworkOffset().toFixed(4))} ${Number(artworkOffsetY().toFixed(4))})`);
    const position = offset < -.12 ? 'left' : offset > .12 ? 'right' : 'center';
    const verticalPosition = offsetY < -.12 ? 'up' : offsetY > .12 ? 'down' : 'center';
    const direction = verticalPosition === 'center' ? position : position === 'center' ? verticalPosition : `${verticalPosition}-${position}`;
    const key = `${position}/${verticalPosition}`;
    host.dataset.companionGaze = direction;
    host.dataset.companionMotion = reduced() ? 'reduced' : 'active';
    if (key !== lastPosition) { lastPosition = key; onState({ ...state(), position, verticalPosition, direction }); }
  }
  function clearIdle() {
    if (idle !== null) win.clearTimeout(idle);
    idle = null;
  }
  function stopFrame() {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null; lastFrame = null;
  }
  function paintBlink(value) {
    eyelid = value;
    for (const part of blinkParts) part.setAttribute('transform', `scale(1 ${Number(value.toFixed(4))})`);
  }
  function stopBlink() {
    if (blinkTimer !== null) win.clearTimeout(blinkTimer);
    blinkTimer = null; blinkStarted = null; paintBlink(1);
  }
  function scheduleBlink() {
    if (!blinkParts.length || blinkTimer !== null || blinkStarted !== null || destroyed || !focused || reduced() || hidden()) return;
    const intervals = [5200, 7100, 6100, 8200];
    blinkTimer = win.setTimeout(() => {
      blinkTimer = null;
      if (host.isConnected === false) { destroy(); return; }
      if (destroyed || !focused || reduced() || hidden()) return;
      blinkStarted = win.performance?.now?.() ?? 0;
      animate();
    }, intervals[blinkSequence++ % intervals.length]);
  }
  function tick(timestamp) {
    frame = null;
    if (destroyed) return;
    if (host.isConnected === false) { destroy(); return; }
    if (reduced() || hidden()) { reset(true); return; }
    const elapsed = lastFrame === null ? 1000 / 60 : Math.max(0, timestamp - lastFrame);
    lastFrame = timestamp;
    const gazeResponse = target === 0 && targetY === 0 ? returning : response;
    offset = stepEye(offset, target, elapsed, gazeResponse);
    offsetY = stepEye(offsetY, targetY, elapsed, gazeResponse);
    if (blinkStarted !== null) {
      const progress = (timestamp - blinkStarted) / 180;
      paintBlink(blinkScale(progress));
      if (progress >= 1) { blinkStarted = null; scheduleBlink(); }
    }
    const settledX = Math.abs(target - offset) <= EPSILON;
    const settledY = Math.abs(targetY - offsetY) <= EPSILON;
    const settled = settledX && settledY;
    if (settledX) offset = target;
    if (settledY) offsetY = targetY;
    paint();
    if (settled && blinkStarted === null) { lastFrame = null; return; }
    frame = win.requestAnimationFrame(tick);
  }
  function animate() {
    if (destroyed || frame !== null || (blinkStarted === null && Math.abs(target - offset) <= EPSILON && Math.abs(targetY - offsetY) <= EPSILON)) return;
    frame = win.requestAnimationFrame(tick);
  }
  function reset(immediate = false) {
    if (destroyed) return;
    if (host.isConnected === false) { destroy(); return; }
    clearIdle(); target = 0; targetY = 0; lastPointer = null;
    if (immediate || reduced() || hidden()) { stopBlink(); stopFrame(); offset = 0; offsetY = 0; paint(); }
    else animate();
  }
  function pointer(event) {
    if (host.isConnected === false) { destroy(); return; }
    if (destroyed || event.pointerType === 'touch' || reduced() || hidden()) return;
    const rect = host.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || rect.width <= 0) return;
    const matrix = svg?.getScreenCTM?.();
    const projected = matrix && [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite);
    const view = svg?.viewBox?.baseVal;
    const viewport = svg?.getBoundingClientRect?.() || rect;
    const fit = view?.width > 0 && view?.height > 0 && viewport.width > 0 && viewport.height > 0 ? Math.min(viewport.width / view.width, viewport.height / view.height) : null;
    let bodyWidth = rect.width, bodyHeight = rect.height > 0 ? rect.height : rect.width;
    if (artworkBody.width > 0 && artworkBody.height > 0) {
      if (projected) {
        const width = Math.hypot(matrix.a, matrix.b) * artworkBody.width;
        const height = Math.hypot(matrix.c, matrix.d) * artworkBody.height;
        if (width > 0 && height > 0) { bodyWidth = width; bodyHeight = height; }
      } else if (fit > 0) { bodyWidth = artworkBody.width * fit; bodyHeight = artworkBody.height * fit; }
    }
    const reach = Math.max(1, bodyWidth * reachScale);
    const verticalReach = Math.max(1, bodyHeight * reachScale);
    let center = rect.left + rect.width / 2;
    let centerY = (rect.top || 0) + (rect.height || 0) / 2;
    if (Number.isFinite(artworkFace.x) && Number.isFinite(artworkFace.y)) {
      if (projected) {
        center = matrix.a * artworkFace.x + matrix.c * artworkFace.y + matrix.e;
        centerY = matrix.b * artworkFace.x + matrix.d * artworkFace.y + matrix.f;
      }
      else {
        if (fit > 0) {
          center = viewport.left + (viewport.width - view.width * fit) / 2 + (artworkFace.x - view.x) * fit;
          centerY = viewport.top + (viewport.height - view.height * fit) / 2 + (artworkFace.y - view.y) * fit;
        }
      }
    }
    target = eyeTarget(event.clientX, center, reach);
    targetY = verticalTravel > 0 ? eyeTarget(event.clientY, centerY, verticalReach) : 0;
    lastPointer = { clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType };
    clearIdle();
    if (Number.isFinite(still) && still > 0) idle = win.setTimeout(() => { idle = null; reset(); }, still);
    scheduleBlink();
    animate();
  }
  const reproject = () => { if (lastPointer && !destroyed) pointer(lastPointer); };
  const center = () => reset();
  const blur = () => { focused = false; stopBlink(); reset(); };
  const focus = () => { focused = true; scheduleBlink(); };
  const visibility = () => { if (doc.hidden) reset(true); else scheduleBlink(); };
  const preferences = () => { if (reduced()) reset(true); else { lastPosition = ''; paint(); scheduleBlink(); } };
  function destroy() {
    if (destroyed) return;
    clearIdle(); stopBlink(); stopFrame(); offset = 0; target = 0; offsetY = 0; targetY = 0; lastPointer = null; destroyed = true;
    paint();
    for (const remove of removals.splice(0)) remove();
    observer?.disconnect();
  }
  listen(win, 'pointermove', pointer, { passive: true });
  listen(win, 'blur', blur);
  listen(win, 'focus', focus);
  listen(win, 'resize', reproject, { passive: true });
  listen(win, 'scroll', reproject, { capture: true, passive: true });
  listen(doc.documentElement, 'pointerleave', center);
  listen(doc, 'visibilitychange', visibility);
  listen(win, 'pagehide', destroy);
  if (media?.addEventListener) listen(media, 'change', preferences);
  else if (media?.addListener) { media.addListener(preferences); removals.push(() => media.removeListener(preferences)); }
  const observer = win.MutationObserver && doc.documentElement ? new win.MutationObserver(preferences) : null;
  observer?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
  paint();
  scheduleBlink();
  return { destroy, reset, getState: state };
}

function scopedArtwork(text, doc) {
  const parsed = new doc.defaultView.DOMParser().parseFromString(text, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('Invalid companion artwork.');
  const svg = doc.importNode(parsed.documentElement, true);
  const prefix = `companion-${++artworkSerial}-`;
  const ids = new Map();
  for (const element of svg.querySelectorAll('[id]')) { const id = element.id; ids.set(id, prefix + id); element.id = prefix + id; }
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      let value = attribute.value;
      for (const [from, to] of ids) value = value.replaceAll(`url(#${from})`, `url(#${to})`).replace(new RegExp(`^#${from}$`), `#${to}`);
      if (value !== attribute.value) element.setAttribute(attribute.name, value);
    }
  }
  svg.setAttribute('aria-hidden', 'true');
  if (!svg.querySelector('[data-companion-eyes]')) throw new Error('Companion eyes are missing.');
  return svg;
}

/** Inline the same static SVG once; failures retain the existing static image. */
export function mountCompanionAvatar(host, { sourceURL = new URL('./ink-avatar.svg', import.meta.url).href, onState, ...options } = {}) {
  if (!host) return { ready: Promise.resolve(false), destroy() {} };
  mountedAvatars.get(host)?.destroy();
  let destroyed = false, tracking = null;
  const original = [...host.childNodes];
  const destroy = () => {
    if (destroyed) return;
    destroyed = true; tracking?.destroy();
    if (mountedAvatars.get(host) === controller) mountedAvatars.delete(host);
  };
  if (!sourceRequests.has(sourceURL)) {
    const request = host.ownerDocument.defaultView.fetch(sourceURL, { credentials: 'same-origin' }).then(response => {
      if (!response.ok) throw new Error('Companion artwork is unavailable.');
      return response.text();
    }).catch(error => { sourceRequests.delete(sourceURL); throw error; });
    sourceRequests.set(sourceURL, request);
  }
  const ready = sourceRequests.get(sourceURL).then(text => {
    if (destroyed || !host.isConnected) return false;
    const svg = scopedArtwork(text, host.ownerDocument);
    host.dataset.companionAvatar = 'interactive';
    host.replaceChildren(svg);
    try { tracking = mountEyeTracking(svg.querySelector('[data-companion-eyes]'), { host, onState, ...options }); }
    catch (error) { host.replaceChildren(...original); delete host.dataset.companionAvatar; throw error; }
    return true;
  }).catch(() => false);
  const controller = { ready, destroy, getState: () => tracking?.getState() };
  mountedAvatars.set(host, controller);
  return controller;
}

function mountPreview(root) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const output = root.querySelector('[data-preview-gaze]');
  const positions = { left: '看向左侧', center: '看向中间', right: '看向右侧', up: '看向上方', down: '看向下方', 'up-left': '看向左上方', 'up-right': '看向右上方', 'down-left': '看向左下方', 'down-right': '看向右下方' };
  const companion = mountCompanionAvatar(root.querySelector('[data-preview-companion]'), { onState: state => {
    if (output) output.textContent = positions[state.direction || state.position];
    for (const zone of root.querySelectorAll('[data-preview-position]')) zone.dataset.active = String(zone.dataset.previewPosition === state.position || zone.dataset.previewPosition === state.verticalPosition);
  } });
  function alignObservationZones() {
    const svg = root.querySelector('[data-preview-companion] [data-companion-artwork]');
    const stage = root.querySelector('.preview-stage');
    const matrix = svg?.getScreenCTM?.();
    if (!svg || !stage || !matrix) return;
    const x = Number(svg.getAttribute('data-companion-face-x'));
    const y = Number(svg.getAttribute('data-companion-face-y'));
    if (![x, y, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)) return;
    const rect = stage.getBoundingClientRect();
    const faceX = matrix.a * x + matrix.c * y + matrix.e - rect.left - (stage.clientLeft || 0);
    const faceY = matrix.b * x + matrix.d * y + matrix.f - rect.top - (stage.clientTop || 0);
    for (const zone of root.querySelectorAll('[data-preview-position]')) {
      if (['up', 'down'].includes(zone.dataset.previewPosition)) { zone.style.left = `${faceX}px`; zone.style.transform = 'translateX(-50%)'; }
      else { zone.style.top = `${faceY}px`; zone.style.transform = 'translateY(-50%)'; }
    }
  }
  const control = root.querySelector('[data-preview-reduced-motion]');
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const hint = root.querySelector('[data-preview-motion-hint]');
  function preferences() {
    if (!control) return;
    if (media?.matches) { control.checked = true; control.disabled = true; }
    else control.disabled = false;
    doc.documentElement.dataset.reduceMotion = control.checked ? 'true' : 'false';
    if (hint) hint.textContent = control.checked ? '已减少动态效果，Tag 安静地看向中间。' : '跟随鼠标位置，离开窗口后回到中间。';
  }
  control?.addEventListener('change', preferences);
  media?.addEventListener?.('change', preferences);
  preferences();
  companion.ready.then(ready => {
    const status = root.querySelector('[data-preview-readiness]');
    if (status) status.textContent = ready ? 'Tag 准备好了' : '静态形象已显示，暂时无法开启跟随';
    if (ready) alignObservationZones();
  });
  win.addEventListener('resize', alignObservationZones, { passive: true });
  win.addEventListener('pagehide', () => {
    companion.destroy();
    control?.removeEventListener('change', preferences);
    media?.removeEventListener?.('change', preferences);
    win.removeEventListener('resize', alignObservationZones);
  }, { once: true });
}

if (typeof document !== 'undefined') {
  const preview = document.querySelector('[data-companion-preview]');
  if (preview) mountPreview(preview);
}
