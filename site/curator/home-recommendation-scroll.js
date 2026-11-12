import { glassReducedMotion } from "./glass-dialogs.js";

const railPositions = new Map();

function mountRail(rail) {
  const railName = rail.dataset.recommendGallery;
  rail.scrollLeft = railPositions.get(railName) || 0;
  const shell = rail.closest(".recommend-gallery-shell");
  const previous = shell?.querySelector('[data-action="recommend-prev"]');
  const next = shell?.querySelector('[data-action="recommend-next"]');
  const events = new AbortController();
  const { signal } = events;
  const maximumScroll = () => Math.max(0, rail.scrollWidth - rail.clientWidth);

  function updateButtons() {
    if (previous) previous.disabled = rail.scrollLeft <= 1;
    if (next) next.disabled = rail.scrollLeft >= maximumScroll() - 1;
  }

  function move(direction) {
    const cardWidth = rail.firstElementChild?.getBoundingClientRect().width || rail.clientWidth;
    const gap = parseFloat(getComputedStyle(rail).columnGap) || 0;
    rail.scrollBy({ left: direction * (cardWidth + gap), behavior: glassReducedMotion() ? "auto" : "smooth" });
  }

  function onKey(event) {
    if (!maximumScroll() || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    event.preventDefault();
    move(event.key === "ArrowRight" ? 1 : -1);
  }

  let pointer = null;
  let lastDragAt = -Infinity;
  function onPointerDown(event) {
    if (event.pointerType !== "mouse" || event.button !== 0 || !maximumScroll()) return;
    lastDragAt = -Infinity;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rail.scrollLeft, moved: false };
  }
  function onPointerMove(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!(event.buttons & 1)) {
      finishDrag(event);
      return;
    }
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!pointer.moved) {
      if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(dy)) return;
      pointer.moved = true;
      rail.setPointerCapture(event.pointerId);
      rail.classList.add("is-dragging");
    }
    event.preventDefault();
    rail.scrollLeft = pointer.left - dx;
  }
  function finishDrag(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (pointer.moved) lastDragAt = performance.now();
    pointer = null;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    rail.classList.remove("is-dragging");
  }

  previous?.addEventListener("click", () => move(-1), { signal });
  next?.addEventListener("click", () => move(1), { signal });
  rail.addEventListener("keydown", onKey, { signal });
  rail.addEventListener("scroll", updateButtons, { passive: true, signal });
  rail.addEventListener("pointerdown", onPointerDown, { signal });
  rail.addEventListener("pointermove", onPointerMove, { signal });
  rail.addEventListener("pointerup", finishDrag, { signal });
  rail.addEventListener("pointercancel", finishDrag, { signal });
  rail.addEventListener("lostpointercapture", finishDrag, { signal });
  rail.addEventListener("dragstart", event => event.preventDefault(), { signal });
  rail.addEventListener("click", event => {
    if (event.detail > 0 && performance.now() - lastDragAt < 200) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, { capture: true, signal });

  const observer = new ResizeObserver(updateButtons);
  observer.observe(rail);
  updateButtons();
  return () => {
    railPositions.set(railName, rail.scrollLeft);
    events.abort();
    observer.disconnect();
  };
}

export function mountHomeRecommendationRails(root = document) {
  const rails = root.querySelectorAll('[data-home-section="home"] [data-recommend-gallery]');
  const cleanups = Array.from(rails, mountRail);
  return () => cleanups.forEach(cleanup => cleanup());
}
