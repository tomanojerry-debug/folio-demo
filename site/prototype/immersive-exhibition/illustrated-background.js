// Two illustrated scene plates with independently moving foreground silhouettes.
// This is a 2.5D art-direction prototype, not a reconstructed 3D street.
export function mountIllustratedBackground() {
  const root = document.querySelector('[data-home-scroll-sequence]');
  if (!root) return () => {};
  const anchors = ['[data-home-section="home"]', '[data-home-transition-copy]', '[data-home-section="inbox"]', '[data-home-section="gallery"]', '[data-home-section="records"]', '[data-home-writing]'].map(s => document.querySelector(s));
  if (anchors.some(el => !el)) throw new Error('Illustrated background requires homepage chapter anchors');
  const writing = anchors[5];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const layer = document.createElement('div');
  layer.className = 'illustrated-world';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = `
    <div class="illustrated-plate illustrated-street"><img src="./assets/illustrated-street/street.png" alt="" draggable="false"></div>
    <div class="illustrated-plate illustrated-interior"><img src="./assets/illustrated-street/interior.png" alt="" draggable="false"></div>
    <div class="illustrated-branches"></div>
    <div class="illustrated-doorway"><i></i></div>
    <div class="illustrated-haze"></div>
    <div class="illustrated-shade"></div>
    <div class="illustrated-paper"></div>`;
  const style = document.createElement('style');
  style.textContent = `
    .illustrated-world{position:absolute;inset:0;overflow:hidden;background:#294744;pointer-events:none;isolation:isolate}
    [data-background="illustrated"]>.home-scroll-sequence__canvas,
    [data-background="illustrated"]>.home-scroll-sequence__poster,
    [data-background="illustrated"]>.home-scroll-sequence__reduced{display:none!important}
    .illustrated-plate{position:absolute;inset:-3%;will-change:transform,opacity;transform-origin:72% 55%}
    .illustrated-plate img{width:100%;height:100%;object-fit:cover;object-position:65% 50%;display:block}
    .illustrated-interior{opacity:0;transform-origin:38% 55%}
    .illustrated-interior img{object-position:47% 50%}
    .illustrated-branches{position:absolute;inset:-5% auto auto -3%;width:min(23vw,340px);height:105%;transform-origin:0 0;will-change:transform,opacity}
    .illustrated-branches svg{width:100%;height:100%;overflow:visible}
    .illustrated-doorway{position:absolute;top:-10%;bottom:-10%;left:115%;width:11vw;min-width:75px;background:linear-gradient(90deg,#813d32,#b1533e 20%,#673d32 24%,#b45a43 31%,#753c31 90%,#243c39);box-shadow:-15px 0 40px #142d3430;will-change:transform;opacity:0}
    .illustrated-doorway i{position:absolute;inset:0;background:repeating-linear-gradient(91deg,transparent 0 4px,#eedaba16 5px,transparent 6px 13px);}
    .illustrated-haze{position:absolute;inset:0;background:radial-gradient(ellipse at 76% 72%,#ffd79020,transparent 42%);mix-blend-mode:screen;opacity:.5}
    .illustrated-shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(12,30,36,.62),rgba(12,30,36,.23) 48%,rgba(12,30,36,.12)),linear-gradient(180deg,rgba(10,24,33,.25),transparent 48%,rgba(11,26,31,.26));will-change:opacity}
    .illustrated-paper{position:absolute;inset:0;opacity:.035;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.72' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Cpath filter='url(%23n)' opacity='.6' d='M0 0h140v140H0z'/%3E%3C/svg%3E");mix-blend-mode:multiply}
    @media(max-width:650px){.illustrated-street img{object-position:73% 50%}.illustrated-branches{width:20vw}.illustrated-shade{background:linear-gradient(180deg,#102b3866,#102b3838 55%,#102b3875),linear-gradient(90deg,#102b3838,transparent)}}
  `;
  // Sparse, vector-native foliage gives an actual independent foreground layer.
  let leaves = '';
  for (let i = 0; i < 24; i++) {
    const x = 20 + (i * 47 % 130), y = 45 + (i * 37 % 235);
    leaves += `<ellipse cx="${x}" cy="${y}" rx="${6 + i % 4}" ry="3" transform="rotate(${i * 37} ${x} ${y})"/>`;
  }
  layer.querySelector('.illustrated-branches').innerHTML = `<svg viewBox="0 0 190 700" preserveAspectRatio="none"><g fill="#203d39" opacity=".8"><path d="M-12 710L2 195 22 40 30 -20 47 -20 36 45 20 205 12 710Z"/><path d="M18 220Q55 139 158 84L160 86Q66 149 26 235Z M19 185Q-7 106 -32 90L-28 84Q12 115 24 170Z M26 123Q82 101 102 36L105 38Q91 115 26 137Z"/>${leaves}</g></svg>`;
  root.append(style, layer);
  const street = layer.querySelector('.illustrated-street');
  const interior = layer.querySelector('.illustrated-interior');
  const branches = layer.querySelector('.illustrated-branches');
  const doorway = layer.querySelector('.illustrated-doorway');
  const shade = layer.querySelector('.illustrated-shade');
  const haze = layer.querySelector('.illustrated-haze');
  let disposed = false, ready = false, raf = 0, target = 0, current = 0, pointerX = 0, pointerY = 0, px = 0, py = 0, tops = [];
  let previous = 0;
  const clamp = n => Math.max(0, Math.min(1, n));
  const smooth = n => { n = clamp(n); return n * n * (3 - 2 * n); };
  function update() {
    let index = 0;
    while (index < 4 && scrollY >= tops[index + 1]) index++;
    target = index + clamp((scrollY - tops[index]) / Math.max(1, tops[index + 1] - tops[index]));
    const active = scrollY >= tops[5] - 2;
    root.dataset.chapter = active ? 'writing' : ['home', 'transition', 'inbox', 'gallery', 'notes'][index];
    root.dataset.interactive = String(active);
    writing.classList.toggle('is-active', active); writing.setAttribute('aria-hidden', String(!active));
    if (reduced.matches) current = target;
    request();
  }
  function measure() { tops = anchors.map(el => el.getBoundingClientRect().top + scrollY); update(); }
  function request() { if (!raf && !disposed && ready && !document.hidden) raf = requestAnimationFrame(render); }
  function render(now) {
    raf = 0; if (disposed || !ready || document.hidden) return;
    const dt = Math.min(50, now - (previous || now)); previous = now;
    const follow = 1 - Math.exp(-dt / 120);
    current += (target - current) * follow;
    px += (pointerX - px) * follow; py += (pointerY - py) * follow;
    const motion = reduced.matches ? 0 : 1;
    const advance = clamp(current / 3.3);
    const inside = smooth((current - 2.7) / 1.0);
    const inward = clamp((current - 3.5) / 1.5);
    street.style.transform = `translate3d(${-advance * 7 + px * .4 * motion}%,${advance * 1.6 + py * .3 * motion}%,0) scale(${1.03 + advance * .25 * motion})`;
    street.style.opacity = String(1 - inside);
    interior.style.opacity = String(inside);
    interior.style.transform = `translate3d(${inward * 2 + px * .25 * motion}%,${py * .2 * motion}%,0) scale(${1.03 + inward * .07 * motion})`;
    branches.style.opacity = String((1 - inside) * .7);
    branches.style.transform = `translate3d(${-advance * 110 + px * 3 * motion}px,${advance * 50 + py * 2 * motion}px,0) scale(${1 + advance * .14 * motion})`;
    const crossing = clamp((current - 2.55) / 1.25);
    doorway.style.opacity = String(reduced.matches ? 0 : Math.sin(crossing * Math.PI));
    doorway.style.transform = `translateX(${-crossing * (innerWidth * 1.4)}px)`;
    shade.style.opacity = String(.85 + smooth(current - .7) * .45);
    // Static under reduced motion; otherwise only a restrained ambient warm-light change.
    haze.style.opacity = String(reduced.matches ? .4 : .4 + Math.sin(now * .0003) * .08);
    layer.dataset.progress = current.toFixed(3);
    if (!reduced.matches && target < 5) request();
    else if (Math.abs(target - current) > .001) request();
  }
  function pointer(event) {
    if (reduced.matches || event.pointerType !== 'mouse') return;
    pointerX = (event.clientX / innerWidth - .5) * 2; pointerY = (event.clientY / innerHeight - .5) * 2; request();
  }
  function resetPointer() { pointerX = pointerY = 0; request(); }
  function visibility() { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else { previous = 0; request(); } }
  const observer = new ResizeObserver(measure); anchors.forEach(el => observer.observe(el));
  window.addEventListener('scroll', update, { passive: true }); window.addEventListener('resize', measure);
  window.addEventListener('pointermove', pointer, { passive: true }); document.addEventListener('pointerleave', resetPointer);
  document.addEventListener('visibilitychange', visibility); reduced.addEventListener('change', update);
  measure();
  const images = [...layer.querySelectorAll('img')];
  Promise.all(images.map(image => image.decode())).then(() => {
    if (disposed) return;
    ready = true; root.dataset.background = 'illustrated'; request();
  }).catch(() => { if (!disposed) { layer.style.display = 'none'; root.dataset.backgroundError = 'image-load'; } });
  return () => {
    disposed = true; cancelAnimationFrame(raf); observer.disconnect();
    window.removeEventListener('scroll', update); window.removeEventListener('resize', measure); window.removeEventListener('pointermove', pointer);
    document.removeEventListener('pointerleave', resetPointer); document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', update);
    layer.remove(); style.remove(); delete root.dataset.background; delete root.dataset.backgroundError;
  };
}
