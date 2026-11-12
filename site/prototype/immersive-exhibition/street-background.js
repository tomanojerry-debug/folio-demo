import * as T from '../../vendor/three/three.module.js';

// Continuous 3D foreground with independent painted sky, shoreline and water layers.
export function mountStreetBackground() {
  const root = document.querySelector('[data-home-scroll-sequence]');
  if (!root) return () => {};
  const anchors = ['[data-home-section="home"]', '[data-home-transition-copy]', '[data-home-section="inbox"]', '[data-home-section="gallery"]', '[data-home-section="records"]', '[data-home-writing]'].map(s => document.querySelector(s));
  if (anchors.some(a => !a)) throw new Error('Missing street chapter anchors');
  // Use a separate canvas so the original 2D sequence remains a viable fallback.
  const canvas = document.createElement('canvas');
  canvas.className = 'street-world'; canvas.setAttribute('aria-hidden', 'true');
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFShadowMap;
  const style = document.createElement('style');
  style.textContent = `
    .street-world{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
    [data-background="street3d"]>.home-scroll-sequence__canvas,[data-background="street3d"]>.home-scroll-sequence__poster,[data-background="street3d"]>.home-scroll-sequence__reduced{display:none!important}
    .street-ink{position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,#102a3a55,transparent 65%),linear-gradient(0deg,#132f3933,transparent 35%,#102b3822);}
    .street-paper{position:absolute;inset:0;pointer-events:none;opacity:.055;mix-blend-mode:multiply;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Cpath filter='url(%23n)' d='M0 0h160v160H0z'/%3E%3C/svg%3E")}
  `;
  const ink = document.createElement('div'); ink.className = 'street-ink'; ink.setAttribute('aria-hidden', 'true');
  const paper = document.createElement('div'); paper.className = 'street-paper'; paper.setAttribute('aria-hidden', 'true');
  root.append(style, canvas, ink, paper);
  const scene = new T.Scene(); scene.background = new T.Color('#396888');
  scene.fog = new T.Fog('#7894a5', 85, 230);
  const camera = new T.PerspectiveCamera(54, 1, .08, 300);
  let disposed = false;
  const resources = new Set(); const keep = r => (resources.add(r), r);
  let seed = 411;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  function texture(kind) {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const p = c.getContext('2d');
    p.fillStyle = kind === 'stone' ? '#c6b99d' : '#f1e6c9'; p.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 16000; i++) {
      p.fillStyle = `rgba(47,57,49,${random() * .065})`;
      p.fillRect(random() * 512, random() * 512, 1 + random() * 2, 1 + random() * 5);
    }
    if (kind === 'stone') {
      for (let row = 0; row < 8; row++) for (let col = -1; col < 5; col++) {
        const x = col * 128 + row % 2 * 64, y = row * 64;
        p.strokeStyle = '#7a817574'; p.lineWidth = 3; p.strokeRect(x + 2, y + 2, 124, 60);
        p.fillStyle = `rgba(245,229,201,${random() * .19})`; p.fillRect(x + 5, y + 5, 118, 54);
      }
    }
    const t = keep(new T.CanvasTexture(c)); t.colorSpace = T.SRGBColorSpace; t.wrapS = t.wrapT = T.RepeatWrapping;
    t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); return t;
  }
  const plasterTexture = texture('plaster'), pavingTexture = texture('stone'); pavingTexture.repeat.set(9, 25);
  const mat = (color, extras = {}) => keep(new T.MeshStandardMaterial({ color, roughness: .96, ...extras }));
  const cream = mat('#e7d7b7', { map: plasterTexture });
  const lightCream = mat('#f5e6c9', { map: plasterTexture });
  const red = mat('#af4937'), redLight = mat('#ce6048'), teal = mat('#254344'), roofMat = mat('#304d54');
  const stone = mat('#a89e87'), brass = mat('#96855b', { metalness: .45, roughness: .5 });
  const wood = mat('#604c3d'), glow = mat('#ffdc95', { emissive: '#ffca75', emissiveIntensity: .65 });
  const darkGlass = mat('#587375', { metalness: .15, roughness: .3 });
  const glass = mat('#acc5bb', { transparent: true, opacity: .075, depthWrite: false, roughness: .3 });
  const boxGeometry = keep(new T.BoxGeometry(1, 1, 1));
  const cylinderGeometry = keep(new T.CylinderGeometry(1, 1, 1, 10));
  const sphereGeometry = keep(new T.IcosahedronGeometry(1, 1));
  function mesh(geo, material, pos, scale = [1, 1, 1], parent = scene) {
    const m = new T.Mesh(geo, material); m.position.set(...pos); m.scale.set(...scale);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  }
  const box = (pos, scale, material, parent) => mesh(boxGeometry, material, pos, scale, parent);
  const cylinder = (pos, scale, material, parent) => mesh(cylinderGeometry, material, pos, scale, parent);
  const group = (pos, angle = 0) => { const g = new T.Group(); g.position.set(...pos); g.rotation.y = angle; scene.add(g); return g; };
  scene.add(new T.HemisphereLight('#b3d1ed', '#a08966', 2.0));
  const sun = new T.DirectionalLight('#ffe1ab', 2.6); sun.position.set(-16, 25, 14); sun.target.position.set(2, 0, -6);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -28, right: 28, top: 33, bottom: -33, near: 1, far: 95 });
  sun.shadow.normalBias = .04; sun.shadow.bias = -.0002; scene.add(sun, sun.target);
  // Generated paintings remain in world space, so foreground geometry occludes them.
  const assetLoader = new T.TextureLoader();
  function paintedTexture(name, repeat = false) {
    const promise = assetLoader.loadAsync(new URL(`./assets/waterfront-parallax/${name}-v1.png`, import.meta.url).href);
    return promise.then(t => {
      if (disposed) { t.dispose(); return null; }
      keep(t); t.colorSpace = T.SRGBColorSpace;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      if (repeat) t.wrapS = t.wrapT = T.MirroredRepeatWrapping;
      return t;
    });
  }
  const skyMaterial = keep(new T.ShaderMaterial({
    side: T.BackSide, depthWrite: false, toneMapped: false,
    uniforms: { painting: { value: null }, ready: { value: 0 } },
    vertexShader: 'varying vec3 direction;void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec3 direction;uniform sampler2D painting;uniform float ready;
      void main(){vec3 d=normalize(direction);float u=atan(d.z,d.x)/6.2831853+.5;
      float v=clamp(d.y*1.55+.08,0.,1.);vec3 c=vec3(.035,.14,.24);
      if(ready>.5)c=texture2D(painting,vec2(u*2.,v)).rgb;
      gl_FragColor=vec4(c,1.);
      #include <colorspace_fragment>
      }`
  }));
  const sky = mesh(keep(new T.SphereGeometry(250, 40, 24)), skyMaterial, [0, 0, 0]);
  sky.castShadow = sky.receiveShadow = false; sky.renderOrder = -10;
  const skyLoad = paintedTexture('sky', true).then(t => { if(t) { skyMaterial.uniforms.painting.value = t; skyMaterial.uniforms.ready.value = 1; } });
  // Reference layout: a single building frontage on the right, open waterfront left.
  const ground = box([12.75, -.3, -3], [44.5, .4, 84], mat('#c9bca1', { map: pavingTexture })); ground.castShadow = false;
  box([4.15, -.01, -15.5], [2.7, .18, 59], lightCream);
  for (let z = -44; z < 14; z += 1.2) box([2.75, .04, z], [.24, .24, 1.13], stone);
  const waterMaterial = keep(new T.MeshBasicMaterial({ color: '#356082', toneMapped: false }));
  let waterTexture = null;
  const waterLoad = paintedTexture('water', true).then(t => {
    if (!t) return;
    waterTexture = t; t.repeat.set(18, 18);
    waterMaterial.map = t; waterMaterial.color.set('#ffffff'); waterMaterial.needsUpdate = true;
  });
  // A flat painted surface, not modeled waves. Mirrored repeats avoid open water edges.
  const water = mesh(keep(new T.PlaneGeometry(1000, 1000)), waterMaterial, [-45, -.48, -55]);
  water.rotation.x = -Math.PI / 2; water.castShadow = water.receiveShadow = false;
  // Low quay rails bend around the end of the promenade, leaving the view open.
  function rail(x, z, angle = 0) {
    const g = group([x, 0, z], angle);
    for (const dx of [-1.5, 1.5]) { cylinder([dx, .45, 0], [.055, .9, .055], teal, g); cylinder([dx, .94, 0], [.095, .08, .095], brass, g); }
    for (const y of [.36, .78]) box([0, y, 0], [3, .045, .045], teal, g);
  }
  for (let z = -42; z < 24; z += 3) rail(-9.2, z, Math.PI / 2);
  for (let x = -7.7; x < 5; x += 3) rail(x, -44.4);
  const shoreMaterial = keep(new T.MeshBasicMaterial({ transparent: true, alphaTest: .03, depthWrite: true, fog: false, toneMapped: false }));
  const shoreHeight = 260 / 3;
  // Alpha shoreline baseline measured on the original 2172x724 PNG (not its preview).
  const shore = mesh(keep(new T.PlaneGeometry(260, shoreHeight)), shoreMaterial, [-45, shoreHeight * (597 / 724 - .5) - .46, -155]);
  shore.visible = false; shore.castShadow = shore.receiveShadow = false;
  const shoreLoad = paintedTexture('shore').then(t => {
    if (!t) return;
    shoreMaterial.map = t; shoreMaterial.needsUpdate = true; shore.visible = true;
  });
  function label(text, width, height, bg, fg, size = 80) {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 256; const p = c.getContext('2d');
    p.fillStyle = bg; p.fillRect(0, 0, 1024, 256); p.fillStyle = fg;
    p.textAlign = 'center'; p.textBaseline = 'middle'; p.font = `${size}px Georgia`; p.fillText(text, 512, 132);
    const t = keep(new T.CanvasTexture(c)); t.colorSpace = T.SRGBColorSpace;
    return { material: mat('#ffffff', { map: t }), size: [width, height, .025] };
  }
  function frame(x, y, z, w, h, parent, lit = false) {
    box([x, y, z], [w, h, .045], lit ? glow : darkGlass, parent);
    for (const dx of [-w / 2, 0, w / 2]) box([x + dx, y, z + .04], [.09, h + .14, .13], red, parent);
    for (const dy of [-h / 2, .18, h / 2]) box([x, y + dy, z + .06], [w + .18, .09, .14], red, parent);
    box([x, y - h / 2 - .1, z + .1], [w + .38, .16, .32], lightCream, parent);
    box([x, y + h / 2 + .15, z], [w + .36, .15, .2], lightCream, parent);
  }
  function roof(w, d, y, parent) {
    const rise = w * .25, length = Math.hypot(w / 2 + .3, rise), angle = Math.atan2(rise, w / 2 + .3);
    for (const side of [-1, 1]) {
      const slab = box([side * w / 4, y + rise / 2, 0], [length, .16, d + .7], roofMat, parent); slab.rotation.z = -side * angle;
      // Thin roof seams supply the etched illustration rhythm without tile meshes.
      for (let z = -d / 2; z <= d / 2; z += .5) {
        const seam = box([side * w / 4, y + rise / 2 + .09, z], [length, .025, .035], teal, parent); seam.rotation.z = -side * angle;
      }
    }
    const shape = new T.Shape(); shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, rise); shape.closePath();
    const geo = keep(new T.ShapeGeometry(shape));
    for (const side of [-1, 1]) { const gable = mesh(geo, cream, [0, y, side * (d / 2 + .02)], [1, 1, 1], parent); if (side < 0) gable.rotation.y = Math.PI; }
    box([w * .26, y + rise * .85, -d * .2], [.65, 2, .75], red, parent);
    box([w * .26, y + rise * .85 + 1, -d * .2], [.8, .14, .9], stone, parent);
  }
  function house(x, z, w, height, material, angle) {
    const g = group([x, 0, z], angle); const d = 6;
    box([0, height / 2, 0], [w, height, d], material, g);
    box([0, .35, 3.07], [w + .12, .7, .2], stone, g);
    box([0, 3.6, 3.1], [w + .15, .13, .24], lightCream, g);
    box([0, height -.1, 3.13], [w + .35, .2, .35], lightCream, g);
    for (let xw = -w / 2 + 1.05; xw < w / 2 -.4; xw += 2) {
      frame(xw, 5.0, 3.06, 1.1, 1.8, g, random() > .35);
      frame(xw, 1.9, 3.06, 1.35, 2.2, g, random() > .55);
    }
    const roofGroup = new T.Group(); roofGroup.rotation.y = Math.PI / 2; g.add(roofGroup);
    roof(d, w, height, roofGroup);
    return g;
  }
  // The red neighbor touches the gallery; the row recedes toward the water.
  for (let i = 0; i < 4; i++) house(8.5, -10.9 - i * 7.7, 7.6, 7.1 - i * .3, i === 0 ? red : cream, -Math.PI / 2);
  // Front faces the promenade at x=5.5; local +x runs toward the near/right end.
  const gallery = group([13, .18, 0], -Math.PI / 2);
  box([0, -.04, 0], [14, .12, 15], mat('#c6b48f', { map: plasterTexture }), gallery);
  box([-7, 2.45, 0], [.35, 4.9, 15], cream, gallery);
  box([7, 2.45, 0], [.35, 4.9, 15], cream, gallery);
  box([0, 2.45, -7.5], [14, 4.9, .35], cream, gallery);
  box([0, 4.85, 0], [14, .18, 15], lightCream, gallery);
  // Front shop windows: only posts, low plinths and lintels, never a solid wall behind glass.
  for (const [x, width] of [[-6.65, .7], [2.55, 1.7], [6.5, 1]]) box([x, 2.4, 7.5], [width, 4.8, .55], lightCream, gallery);
  const windowCenter = -2.3, windowWidth = 8;
  box([windowCenter, .28, 7.5], [windowWidth, .55, .55], cream, gallery);
  box([windowCenter, 2.3, 7.52], [windowWidth, 3.5, .025], glass, gallery);
  for (const dx of [-4, -1.34, 1.34, 4]) box([windowCenter + dx, 2.28, 7.6], [.1, 3.55, .18], red, gallery);
  for (const y of [.58, 4.03]) box([windowCenter, y, 7.6], [windowWidth, .13, .18], red, gallery);
  box([windowCenter, .55, 7.65], [8.2, .14, .65], lightCream, gallery);
  const doorX = 4.65;
  for (const dx of [-1.12, 1.12]) box([doorX + dx, 2.05, 7.52], [.18, 4.1, .5], redLight, gallery);
  box([doorX, 4.07, 7.52], [2.42, .2, .5], redLight, gallery);
  box([doorX, .015, 7.5], [2.4, .04, .8], brass, gallery);
  box([doorX, -.09, 8.03], [2.8, .16, .85], stone, gallery);
  // A door parked inward leaves the full camera corridor clear.
  box([doorX + 1.15, 1.95, 6.35], [.1, 3.8, 2.15], red, gallery);
  cylinder([doorX + 1.05, 1.7, 5.5], [.035, .5, .035], brass, gallery);
  box([0, 4.48, 7.5], [14.2, .8, .62], cream, gallery);
  const gallerySign = label('F O R M E', 2.8, .65, '#e9dbbb', '#344b4a', 105);
  box([doorX, 4.5, 7.83], gallerySign.size, gallerySign.material, gallery);
  box([0, 6.2, 0], [14, 2.6, 15], cream, gallery);
  for (const x of [-4.6, -.15, 4.45]) frame(x, 6.25, 7.54, 1.55, 1.9, gallery, true);
  box([0, 7.5, 7.57], [14.5, .2, .35], lightCream, gallery);
  const galleryRoof = new T.Group(); galleryRoof.rotation.y = Math.PI / 2; gallery.add(galleryRoof); roof(15, 14, 7.5, galleryRoof);
  // Sidewalk objects provide strong near/mid-distance occlusion during the approach.
  function lamp(x, z) {
    const g = group([x, 0, z]); cylinder([0, .12, 0], [.28, .24, .28], teal, g);
    cylinder([0, 1.65, 0], [.055, 3.1, .055], teal, g); cylinder([0, .5, 0], [.12, .8, .12], teal, g);
    box([0, 3.35, 0], [.42, .66, .42], glow, g);
    for (const x of [-.23, .23]) for (const z of [-.23, .23]) box([x, 3.35, z], [.035, .72, .035], teal, g);
    box([0, 2.99, 0], [.56, .09, .56], teal, g);
    const cap = mesh(keep(new T.ConeGeometry(.47, .32, 4)), teal, [0, 3.85, 0], [1, 1, 1], g); cap.rotation.y = Math.PI / 4;
    cylinder([0, 4.05, 0], [.035, .16, .035], brass, g);
  }
  for (const z of [-7.5, -18, -29, -39]) lamp(2.95, z);
  const leafMats = ['#284c45', '#456351', '#65755a'].map(c => mat(c, { flatShading: true }));
  const trees = [];
  function plant(x, z, large = false) {
    const g = group([x, 0, z]);
    if (!large) {
      mesh(keep(new T.CylinderGeometry(.34, .24, .55, 12)), teal, [0, .28, 0], [1, 1, 1], g);
      cylinder([0, .57, 0], [.36, .08, .36], teal, g);
    }
    const h = large ? 4.9 : 1.7, base = large ? 0 : .5;
    cylinder([0, base + h / 2, 0], [large ? .15 : .035, h, large ? .15 : .035], wood, g);
    for (let i = 0; i < (large ? 38 : 12); i++) {
      const a = i * 2.4, r = (large ? 1.5 : .38) * (.5 + random()), y = base + h * ((large ? .88 : .55) + random() * .35);
      const branch = cylinder([Math.cos(a) * r * .5, y -.3, Math.sin(a) * r * .5], [large ? .045 : .012, r + .4, large ? .045 : .012], wood, g);
      branch.rotation.z = Math.cos(a) * 1.0; branch.rotation.x = Math.sin(a) * 1.0;
      const s = large ? .45 + random() * .4 : .22 + random() * .12;
      mesh(sphereGeometry, leafMats[i % 3], [Math.cos(a) * r, y, Math.sin(a) * r], [s, s * .65, s * .8], g);
    }
    if (large) trees.push(g); return g;
  }
  const foregroundTree = plant(-9, 3, true); foregroundTree.scale.set(1.7, 1.65, 1.7);
  for (const z of [6.5, -6.8, -12, -19, -26, -34]) plant(4.7, z);
  function bench(x, z, angle = 0) {
    const g = group([x, 0, z], angle);
    for (let i = 0; i < 5; i++) box([0, .5, -.34 + i * .16], [2.5, .08, .13], wood, g);
    for (let i = 0; i < 3; i++) box([0, .88 + i * .16, -.4], [2.5, .12, .08], wood, g);
    for (const x of [-.96, .96]) { box([x, .25, 0], [.09, .5, .65], teal, g); box([x, .8, -.43], [.08, .95, .08], teal, g); }
  }
  bench(-8, -14, Math.PI / 2);
  const board = group([4.2, 0, 1.8], -Math.PI / 2 -.12);
  const poster = label('ON VIEW', 1.02, 1.4, '#ac4938', '#f4e4c1', 128);
  box([0, 1.08, 0], [1.2, 1.65, .12], wood, board); box([0, 1.1, .075], poster.size, poster.material, board);
  for (const x of [-.5, .5]) { const leg = box([x, .6, -.15], [.07, 1.25, .08], wood, board); leg.rotation.x = -.23; }
  // Procedural abstract canvases are background decoration, not user exhibition content.
  function artwork(index) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 640; const p = c.getContext('2d');
    p.fillStyle = '#e1d4b5'; p.fillRect(0, 0, 512, 640);
    p.fillStyle = ['#b95740', '#294e53', '#8e926a'][index % 3]; p.beginPath(); p.arc(270, 240, 150, 0, Math.PI * 2); p.fill();
    p.fillStyle = '#345454'; p.fillRect(65, 320, 220, 230); p.fillStyle = '#be9572'; p.fillRect(250, 385, 180, 165);
    for (let i = 0; i < 6000; i++) { p.fillStyle = `rgba(43,49,40,${random() * .1})`; p.fillRect(random() * 512, random() * 640, 2, 3); }
    const t = keep(new T.CanvasTexture(c)); t.colorSpace = T.SRGBColorSpace; return mat('#ffffff', { map: t });
  }
  for (let i = 0; i < 3; i++) {
    const x = -4.7 + i * 4.7;
    box([x, 2.5, -7.25], [2.7, 3.2, .14], wood, gallery);
    box([x, 2.5, -7.16], [2.52, 3.02, .04], lightCream, gallery);
    box([x, 2.5, -7.12], [2.25, 2.76, .025], artwork(i), gallery);
    box([x + 1.55, 1.32, -7.2], [.3, .15, .025], lightCream, gallery);
  }
  for (const x of [-4.5, .6]) {
    box([x, .57, 4.3], [1.0, 1.15, 1.0], lightCream, gallery);
    const sculpture = mesh(keep(new T.TorusKnotGeometry(.32, .105, 64, 8)), red, [x, 1.63, 4.3], [1, 1.3, 1], gallery);
    sculpture.rotation.z = .2;
  }
  bench(14, -2, -Math.PI / 2);
  const table = group([17, .18, 4]);
  box([0, .82, 0], [2.4, .14, 1.2], wood, table);
  for (const x of [-1, 1]) for (const z of [-.43, .43]) box([x, .4, z], [.1, .8, .1], wood, table);
  box([-.3, .91, 0], [.75, .045, .5], cream, table); box([.32, .91, 0], [.48, .04, .5], red, table);
  // Warm pendant lights and ceiling rails give the interior depth overhead.
  for (const z of [5, 0, -5]) {
    box([0, 4.52, z], [11, .07, .07], teal, gallery);
    for (const x of [-3.5, 2.5]) {
      cylinder([x, 4.05, z], [.018, .9, .018], teal, gallery);
      mesh(keep(new T.ConeGeometry(.38, .28, 16, 1, true)), brass, [x, 3.62, z], [1, 1, 1], gallery);
      cylinder([x, 3.49, z], [.3, .035, .3], glow, gallery);
    }
  }
  const insideLight = new T.PointLight('#ffdb9a', 38, 22, 2); insideLight.position.set(13, 3.7, 0); scene.add(insideLight);
  const fill = new T.PointLight('#ffe4b9', 20, 15, 2); fill.position.set(8, 3, -2); scene.add(fill);

  const positions = [[-8, 2.6, 12], [-5.5, 2.4, 9.5], [-1.8, 2.15, 6.8], [7.5, 2.23, 4.65], [12.5, 2.23, 3.3], [15, 2.23, 1]].map(p => new T.Vector3(...p));
  const looks = [[3, 4.1, -8], [4.8, 3.4, -2.5], [6, 2.8, 3.6], [19.5, 2.5, 2.8], [20.3, 2.5, -.5], [20.3, 2.5, -3.5]].map(p => new T.Vector3(...p));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0, target = 0, current = 0, last = 0, tops = [], px = 0, py = 0, tx = 0, ty = 0;
  const aim = new T.Vector3(); const clamp = n => Math.max(0, Math.min(1, n));
  function request() { if (!raf && !disposed && !document.hidden) raf = requestAnimationFrame(render); }
  function update() {
    let i = 0; while (i < 4 && scrollY >= tops[i + 1]) i++;
    target = i + clamp((scrollY - tops[i]) / Math.max(1, tops[i + 1] - tops[i]));
    const active = scrollY >= tops[5] - 2;
    root.dataset.chapter = active ? 'writing' : ['home', 'transition', 'inbox', 'gallery', 'notes'][i];
    root.dataset.interactive = String(active); anchors[5].classList.toggle('is-active', active); anchors[5].setAttribute('aria-hidden', String(!active));
    if (reduced.matches) current = Math.round(target);
    request();
  }
  function measure() {
    tops = anchors.map(el => el.getBoundingClientRect().top + scrollY);
    renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight;
    camera.fov = 54; camera.updateProjectionMatrix(); update();
  }
  function render(now) {
    raf = 0; if (disposed || document.hidden) return;
    const dt = Math.min(50, now - (last || now)); last = now;
    const ease = 1 - Math.exp(-dt / 150);
    if (!reduced.matches) current += (target - current) * ease;
    px += (tx - px) * ease; py += (ty - py) * ease;
    const i = Math.min(4, Math.floor(current)), fraction = clamp(current - i), p = fraction * fraction * (3 - 2 * fraction);
    camera.position.lerpVectors(positions[i], positions[i + 1], p); aim.lerpVectors(looks[i], looks[i + 1], p);
    // Finish the sideways turn before reaching the narrow physical doorway.
    if (i === 2) {
      const turn = clamp(fraction * 1.65), turnEase = turn * turn * (3 - 2 * turn);
      camera.position.z = T.MathUtils.lerp(positions[2].z, positions[3].z, turnEase);
    }
    const closing = clamp((current - 4.15) / .85);
    // The existing closing colophon uses dark ink; ease into a light paper wash.
    ink.style.backgroundColor = closing > 0
      ? `rgba(238,228,201,${closing * .92})`
      : `rgba(12,25,30,${clamp(current - 2) * .14})`;
    if (!reduced.matches) { camera.position.x += px * .08; aim.x += px * .22; aim.y += py * .12; }
    camera.lookAt(aim);
    sky.position.copy(camera.position);
    if (waterTexture) waterTexture.offset.y = reduced.matches ? 0 : Math.sin(now * .00017) * .003;
    trees.forEach((tree, j) => { tree.rotation.z = reduced.matches ? 0 : Math.sin(now * .00035 + j) * .006; });
    renderer.render(scene, camera);
    root.dataset.background = 'street3d'; canvas.dataset.progress = current.toFixed(3);
    canvas.dataset.camera = camera.position.toArray().map(n => n.toFixed(2)).join(',');
    if (!reduced.matches && (current < 2.8 || Math.abs(target - current) > .001 || Math.abs(tx - px) > .001 || Math.abs(ty - py) > .001)) request();
  }
  function pointer(e) { if (reduced.matches || e.pointerType !== 'mouse') return; tx = e.clientX / innerWidth * 2 - 1; ty = .5 - e.clientY / innerHeight; request(); }
  function leave() { tx = ty = 0; request(); }
  function visibility() { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else { last = 0; request(); } }
  function lost(e) { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; canvas.style.visibility = 'hidden'; ink.style.visibility = 'hidden'; paper.style.visibility = 'hidden'; delete root.dataset.background; }
  function restored() { canvas.style.visibility = ''; ink.style.visibility = ''; paper.style.visibility = ''; request(); }
  canvas.addEventListener('webglcontextlost', lost); canvas.addEventListener('webglcontextrestored', restored);
  window.addEventListener('scroll', update, { passive: true }); window.addEventListener('resize', measure); window.addEventListener('pointermove', pointer, { passive: true });
  document.addEventListener('pointerleave', leave); document.addEventListener('visibilitychange', visibility); reduced.addEventListener('change', update);
  const observer = new ResizeObserver(measure); anchors.forEach(el => observer.observe(el)); measure();
  Promise.all([skyLoad, shoreLoad, waterLoad]).then(() => {
    if (!disposed) { canvas.dataset.paintedLayers = 'ready'; request(); }
  }).catch(error => {
    if (!disposed) { canvas.dataset.paintedLayers = 'error'; console.warn('Painted background asset failed to load', error); request(); }
  });
  return () => {
    disposed = true; cancelAnimationFrame(raf); observer.disconnect();
    window.removeEventListener('scroll', update); window.removeEventListener('resize', measure); window.removeEventListener('pointermove', pointer);
    document.removeEventListener('pointerleave', leave); document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', update);
    canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored);
    resources.forEach(r => r.dispose()); renderer.dispose(); canvas.remove(); ink.remove(); paper.remove(); style.remove(); delete root.dataset.background;
  };
}
