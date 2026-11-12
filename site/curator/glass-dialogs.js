// Shared presentation lifecycle. Business state changes only after a surface exits.
const closing = new WeakMap();
const nativeOpeners = new WeakMap();
const selector = 'dialog[open], [role="dialog"][aria-modal="true"]';
const focusSelector = 'button:not(:disabled),a[href],input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';
let installed = false;
let dialogNumber = 0;

export function frameGlassDialog(dialog) {
  const header = dialog.querySelector('.forme-live-head');
  if (!header) return;
  const title = header.querySelector('h2');
  if (title) {
    if (!dialog.id) dialog.id = `forme-dialog-${++dialogNumber}`;
    title.id = `${dialog.id}-title`;
    dialog.setAttribute('aria-labelledby', title.id);
  }
  if (header.nextElementSibling?.classList.contains('forme-live-body')) return;
  const body = dialog.ownerDocument.createElement('div');
  body.className = 'forme-live-body';
  while (header.nextSibling) body.append(header.nextSibling);
  dialog.append(body);
}

export function glassReducedMotion() {
  return typeof document === 'undefined' || document.documentElement.dataset.reduceMotion === 'true'
    || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function glassSurface(element) {
  return element?.querySelector('.capture-modal,.collection-glass,.exhibit-detail-modal,.recap-ticket-stage,.inbox-all-modal,.gallery-all-modal,.notes-all-modal') || element;
}

export function closeGlassOverlay(element, commit = () => element?.remove()) {
  if (element && closing.has(element)) return closing.get(element);
  if (!element?.isConnected) { commit(); return Promise.resolve(); }
  const finish = () => { try { commit(); } finally { delete element.dataset.glassClosing; closing.delete(element); } };
  if (glassReducedMotion() || typeof element.animate !== 'function') { finish(); return Promise.resolve(); }
  element.dataset.glassClosing = 'true';
  const surface = glassSurface(element);
  // Freeze an interrupted entrance before reversing, including rapid open/close.
  const opacity = getComputedStyle(surface).opacity;
  const transform = getComputedStyle(surface).transform;
  const animations = [surface.animate([
    { opacity, transform }, { opacity: 0, transform: 'translateY(6px) scale(.985)' },
  ], { duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' })];
  if (surface !== element) animations.push(element.animate([{ opacity: getComputedStyle(element).opacity }, { opacity: 0 }], { duration: 180, easing: 'ease-in', fill: 'forwards' }));
  const done = Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
    try { finish(); } finally { animations.forEach(animation => animation.cancel()); }
  });
  closing.set(element, done);
  return done;
}

export function closeGlassDialog(dialog) {
  if (!dialog?.open) return Promise.resolve();
  return closeGlassOverlay(dialog, () => { if (dialog.open) dialog.close(); });
}

const focusable = root => [...root.querySelectorAll(focusSelector)].filter(element => element.getClientRects().length && !element.closest('[hidden],[inert]'));

export function installGlassDialogs() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  let previous = [];
  let openStack = [];
  let lastFocus = document.activeElement;
  let pointerTrigger = null;
  const returnFocus = new WeakMap();
  const capturedOpeners = new WeakSet();
  const inerted = new Map();
  const initialized = new WeakSet();
  const surfaces = () => [...document.querySelectorAll(selector)].filter(element => !element.hidden);
  const topSurface = () => {
    const all = surfaces();
    openStack = openStack.filter(element => all.includes(element));
    for (const element of all) if (!openStack.includes(element)) openStack.push(element);
    return openStack.filter(element => element.tagName === 'DIALOG' && element.matches(':modal')).at(-1) || openStack.at(-1);
  };
  const restoreInert = () => { for (const [element, value] of inerted) element.inert = value; inerted.clear(); };
  const sync = () => {
    const all = surfaces();
    const top = topSurface();
    for (const element of all) {
      if (!previous.includes(element)) {
        const old = previous.find(item => !item.isConnected && item.className === element.className);
        if (!capturedOpeners.has(element)) {
          returnFocus.set(element, old ? returnFocus.get(old) : pointerTrigger?.isConnected && !element.contains(pointerTrigger) ? pointerTrigger : lastFocus);
          pointerTrigger = null;
        }
        capturedOpeners.add(element);
        if (element.tagName === 'DIALOG') nativeOpeners.set(element, returnFocus.get(element));
        // Re-rendering an open detail after editing must not replay the entrance.
        if (old) element.dataset.glassContinuing = 'true';
        else element.dataset.glassContinuing = 'false';
      }
      if (initialized.has(element)) continue;
      initialized.add(element);
      if (element.tagName === 'DIALOG' && element.dataset.dialogManaged !== 'profile') {
        element.addEventListener('cancel', event => { event.preventDefault(); void closeGlassDialog(element); });
        let backdropDown = false;
        const outside = event => {
          const box = element.getBoundingClientRect();
          return event.target === element && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
        };
        element.addEventListener('pointerdown', event => { backdropDown = outside(event); });
        element.addEventListener('click', event => { if (backdropDown && outside(event)) void closeGlassDialog(element); backdropDown = false; });
        element.addEventListener('close', () => {
          sync();
          const target = nativeOpeners.get(element), top = topSurface();
          if (target?.isConnected && (!top || top.contains(target))) target.focus({ preventScroll: true });
        });
      }
    }
    restoreInert();
    const departed = previous.filter(element => !all.includes(element)).at(-1);
    const nestedOpener = departed && returnFocus.get(departed);
    if (top && nestedOpener?.isConnected && top.contains(nestedOpener) && !top.contains(document.activeElement)) nestedOpener.focus({ preventScroll: true });
    if (top) {
      // Inert siblings along the ancestor path, so overlays can live inside #app.
      let branch = top;
      while (branch.parentElement && branch !== document.body) {
        for (const sibling of branch.parentElement.children) {
          if (sibling === branch || ['SCRIPT','STYLE','LINK'].includes(sibling.tagName)) continue;
          inerted.set(sibling, sibling.inert); sibling.inert = true;
        }
        branch = branch.parentElement;
      }
      // A dialog that was an inert sibling may miss showModal's synchronous
      // autofocus. Restore its boundary before assigning a visible target.
      if (!top.contains(document.activeElement)) {
        const target = focusable(top)[0];
        if (target) target.focus({ preventScroll: true });
        else { top.tabIndex = -1; top.focus({ preventScroll: true }); }
      }
    } else if (previous.length) {
      const opener = returnFocus.get(previous[0]);
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || previous.some(element => element.contains(document.activeElement)))) opener.focus({ preventScroll: true });
    }
    document.documentElement.classList.toggle('has-glass-dialog', Boolean(top));
    previous = all;
    for (const element of all) capturedOpeners.delete(element);
  };
  document.addEventListener('pointerdown', event => {
    pointerTrigger = event.target.closest?.('button,a[href],input,textarea,select,[tabindex="0"]') || null;
  }, true);
  document.addEventListener('focusin', event => {
    const entering = event.target.closest?.(selector);
    if (entering && !previous.includes(entering) && !capturedOpeners.has(entering)) {
      const old = previous.find(item => !item.isConnected && item.className === entering.className);
      const opener = old ? returnFocus.get(old) : pointerTrigger?.isConnected && !entering.contains(pointerTrigger) ? pointerTrigger : event.relatedTarget && event.relatedTarget !== document.body && !entering.contains(event.relatedTarget) ? event.relatedTarget : lastFocus;
      returnFocus.set(entering, opener);
      capturedOpeners.add(entering);
      pointerTrigger = null;
      if (entering.tagName === 'DIALOG') nativeOpeners.set(entering, opener);
      openStack = openStack.filter(element => element !== entering);
      openStack.push(entering);
    }
    const top = topSurface();
    if (!top) lastFocus = event.target;
    else if (top.contains(event.target)) { if (previous.includes(top)) lastFocus = event.target; }
    else focusable(top)[0]?.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', event => {
    pointerTrigger = null;
    if (event.key !== 'Tab') return;
    const top = topSurface();
    if (!top || top.tagName === 'DIALOG') return;
    const items = focusable(top), first = items[0], last = items.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (!top.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  }, true);
  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  sync();
}
