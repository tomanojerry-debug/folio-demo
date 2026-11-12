import * as T from '../../vendor/three/three.module.js';

// Background-only study: existing DOM, chapter anchors and writing controls remain authoritative.
export function mountCoastalBackground() {
  const root = document.querySelector('[data-home-scroll-sequence]');
  if (!root) return () => {};
  const canvas = root.querySelector('canvas');
  const poster = root.querySelector('[data-home-sequence-poster]');
  const writing = document.querySelector('[data-home-writing]');
  const selectors = ['[data-home-section="home"]', '[data-home-transition-copy]', '[data-home-section="inbox"]', '[data-home-section="gallery"]', '[data-home-section="records"]', '[data-home-writing]'];
  const anchors = selectors.map(s => document.querySelector(s));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  canvas.style.filter = 'brightness(.76) saturate(.82)';
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  const scene = new T.Scene();
  scene.fog = new T.FogExp2('#8d788b', .009);
  const camera = new T.PerspectiveCamera(49, 1, .1, 260);
  const resources = new Set();
  const track = value => (resources.add(value), value);
  const material = (color, extras = {}) => track(new T.MeshStandardMaterial({ color, roughness: .86, ...extras }));
  const stone = material('#53575b');
  const sand = material('#9c8d82');
  const timber = material('#534437');
  const bronze = material('#57524a', { metalness: .5, roughness: .42 });
  const cream = material('#d6c9b0');
  const glow = material('#ffe1a3', { emissive: '#ffb965', emissiveIntensity: 2 });
  const boxGeo = track(new T.BoxGeometry(1, 1, 1));
  const rockGeo = track(new T.IcosahedronGeometry(1, 1));
  const leafGeo = track(new T.IcosahedronGeometry(1, 1));
  function mesh(geometry, mat, pos, scale = [1, 1, 1], parent = scene) {
    const m = new T.Mesh(geometry, mat); m.position.set(...pos); m.scale.set(...scale); parent.add(m); return m;
  }
  const box = (pos, size, mat, parent) => mesh(boxGeo, mat, pos, size, parent);
  let seed = 217;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  scene.add(new T.HemisphereLight('#e7b9c0', '#303d42', 2.0));
  const sunLight = new T.DirectionalLight('#ffceb1', 2.5); sunLight.position.set(-35, 16, -65); scene.add(sunLight);

  // A procedural dusk sky: cloud bands and a soft sun remain behind all geometry.
  const skyMat = track(new T.ShaderMaterial({ side: T.BackSide, depthWrite: false,
    uniforms: { time: { value: 0 } },
    vertexShader: 'varying vec3 v; void main(){v=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec3 v; uniform float time;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
      void main(){vec3 d=normalize(v); float h=max(d.y,0.); vec3 c=mix(vec3(.84,.51,.40),vec3(.23,.27,.43),smoothstep(0.,.65,h));
      vec2 p=d.xz/(abs(d.y)+.22)*2.; p.x+=time*.003; float n=noise(p*2.)*.55+noise(p*5.)*.28+noise(p*11.)*.17;
      float cloud=smoothstep(.5,.72,n)*smoothstep(.01,.15,h)*(1.-smoothstep(.35,.65,h));c=mix(c,vec3(.40,.34,.44),cloud*.65);
      float s=distance(d,normalize(vec3(-.40,.085,-1.))); c+=vec3(1.,.59,.26)*exp(-s*17.)*.35;c=mix(c,vec3(1.,.89,.66),1.-smoothstep(.018,.022,s));gl_FragColor=vec4(c,1.);}`
  }));
  mesh(track(new T.SphereGeometry(180, 32, 20)), skyMat, [0, 0, 0]);

  const waterMat = track(new T.ShaderMaterial({ uniforms: { time: { value: 0 } },
    vertexShader: `varying vec3 w;void main(){w=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(w,1.);}`,
    fragmentShader: `varying vec3 w;uniform float time;void main(){
      float wave=sin(w.z*5.+sin(w.x*.8+time*.2)*1.8-time*.65)*.5+.5;
      float fine=sin(w.z*19.+w.x*3.+time*.5)*.5+.5;
      float horizon=smoothstep(10.,125.,-w.z);vec3 c=mix(vec3(.15,.23,.29),vec3(.53,.43,.49),horizon);
      float strip=exp(-pow((w.x+24.)/(3.+max(0.,w.z+100.)*.12),2.));
      c+=vec3(.72,.35,.17)*strip*pow(wave,9.)*(.4+.6*fine);c+=wave*.025;gl_FragColor=vec4(c,1.);}`
  }));
  const sea = mesh(track(new T.PlaneGeometry(330, 330)), waterMat, [0, -.45, -50]); sea.rotation.x = -Math.PI / 2;

  // Raised coastal bank, with a winding, explicitly clear pedestrian route.
  const pathX = z => 3 + 2.5 * Math.sin((z + 7) * .075);
  const groundGeo = track(new T.PlaneGeometry(36, 95, 40, 75)); groundGeo.rotateX(-Math.PI / 2);
  const positions = groundGeo.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), z = positions.getZ(i) - 12;
    const distance = Math.abs(x - pathX(z));
    positions.setXYZ(i, x, -.05 + Math.min(distance / 6, 1) * (.5 + .55 * Math.sin(x * .7) * Math.cos(z * .4)), z);
  }
  groundGeo.computeVertexNormals(); mesh(groundGeo, sand, [0, 0, 0]);
  const pathMat = material('#b4a391');
  for (let i = 0; i < 55; i++) {
    const z = 24 - i * .83;
    const tile = box([pathX(z), .06, z], [3.2, .12, .77], pathMat); tile.rotation.y = -.17 * Math.cos((z + 7) * .075);
  }
  for (let i = 0; i < 170; i++) {
    const z = random() * 85 - 52, x = random() * 34 - 17;
    if (Math.abs(x - pathX(z)) < 2.5 || (z < -11 && z > -31 && x > -2 && x < 16)) continue;
    const size = .35 + random() * 1.25;
    const rock = mesh(rockGeo, stone, [x, .12, z], [size * 1.4, size * .62, size]); rock.rotation.set(random(), random() * 6, random());
  }

  const foliage = material('#344b43');
  const flowerMat = material('#8e7897');
  const stems = new T.InstancedMesh(track(new T.ConeGeometry(.09, .7, 3)), foliage, 1600);
  const flowers = new T.InstancedMesh(track(new T.IcosahedronGeometry(.105, 0)), flowerMat, 600);
  const dummy = new T.Object3D(); let blades = 0, petals = 0;
  for (let i = 0; i < 2600 && blades < 1600; i++) {
    const z = random() * 73 - 42, x = random() * 32 - 16;
    if (Math.abs(x - pathX(z)) < 2.1 || (z < -10 && z > -31 && x > -2 && x < 16)) continue;
    dummy.position.set(x, .4, z); dummy.scale.setScalar(.7 + random()); dummy.rotation.set(.12 * random(), random() * 6, random() * .3); dummy.updateMatrix(); stems.setMatrixAt(blades++, dummy.matrix);
    if (petals < 600) { dummy.position.y = .75 + random() * .15; dummy.updateMatrix(); flowers.setMatrixAt(petals++, dummy.matrix); }
  }
  stems.count = blades; flowers.count = petals; scene.add(stems, flowers);
  function tree(x, z, scale) {
    const group = new T.Group(); group.position.set(x, 0, z); group.scale.setScalar(scale); scene.add(group);
    const trunk = track(new T.CylinderGeometry(.15, .29, 5, 7)); mesh(trunk, timber, [0, 2.5, 0], [1, 1, 1], group);
    for (let j = 0; j < 9; j++) {
      const a = j * 2.4, radius = 1 + random();
      const branch = mesh(trunk, timber, [Math.cos(a) * .65, 4, Math.sin(a) * .65], [.45, .55, .45], group); branch.rotation.z = Math.cos(a) * .7;
      mesh(leafGeo, foliage, [Math.cos(a) * radius, 5 + random() * 1.3, Math.sin(a) * radius], [1.8, .85, 1.4], group);
    }
    return group;
  }
  const trees = [tree(-9, 12, 1.45), tree(-12, -8, 1.1), tree(14, -5, .9), tree(16, -33, 1.05)];
  for (let i = 0; i < 12; i++) {
    const z = 22 - i * 4.1, x = pathX(z) + (i % 2 ? -2.15 : 2.15);
    box([x, .11, z], [.52, .2, .52], stone);
    box([x, .47, z], [.26, .5, .26], glow);
    box([x, .77, z], [.48, .08, .48], bronze);
    for (const dx of [-.2, .2]) for (const dz of [-.2, .2]) box([x + dx, .45, z + dz], [.035, .6, .035], bronze);
  }

  // Pavilion modules are real geometry, so pillars, roof and artworks occlude correctly.
  const pavilion = new T.Group(); pavilion.position.set(6, .1, -21); scene.add(pavilion);
  box([0, .14, 0], [15, .28, 12], cream, pavilion);
  box([0, 5.1, 0], [16, .25, 13], bronze, pavilion);
  box([0, 4.93, 0], [15.4, .09, 12.4], timber, pavilion);
  const glass = material('#a5b0b7', { transparent: true, opacity: .10, metalness: .4, roughness: .18, depthWrite: false });
  for (const x of [-7, -3.5, 0, 3.5, 7]) {
    for (const z of [-5.5, 5.5]) box([x, 2.6, z], [.1, 5, .1], bronze, pavilion);
    if (x < 7) box([x + 1.75, 2.6, -5.5], [3.4, 4.9, .025], glass, pavilion);
  }
  for (const x of [-7, 7]) box([x, 2.6, 0], [.025, 4.9, 11], glass, pavilion);
  for (const x of [-5, 0, 5]) {
    box([x, 4.84, 0], [2.2, .025, .04], glow, pavilion);
    const lamp = new T.PointLight('#ffd299', 12, 10, 2); lamp.position.set(x, 4.5, 0); pavilion.add(lamp);
  }
  const artColors = ['#7c8f82', '#b49783', '#73808e'];
  for (let i = 0; i < 3; i++) {
    const x = -4.5 + i * 4.5;
    box([x, 2.3, -2.3], [2.7, 4, .18], cream, pavilion);
    box([x, 2.55, -2.19], [2.1, 2.5, .03], material(artColors[i]), pavilion);
    // Quiet abstract studies belong to the backdrop, not fake user exhibition data.
    mesh(track(new T.CircleGeometry(.64, 32)), material('#d9c4a4'), [x, 2.8, -2.16], [1, 1, 1], pavilion);
    box([x, 1.04, -2.15], [.7, .025, .02], bronze, pavilion);
  }
  box([0, .7, 2], [5.5, .16, 1.1], timber, pavilion);
  for (const x of [-2.2, 2.2]) box([x, .37, 2], [.14, .6, .8], bronze, pavilion);

  const cameraPositions = [[0, 4.6, 29], [1, 4.0, 20], [2.4, 3.6, 11], [3, 3.2, -7], [5, 2.8, -12], [5, 2.8, -12]].map(p => new T.Vector3(...p));
  const targets = [[1, 2, -23], [2, 2, -23], [3, 2.1, -23], [5, 2.5, -24], [5, 2.5, -24], [5, 2.5, -24]].map(p => new T.Vector3(...p));
  let desired = 0, current = 0, raf = 0, disposed = false;
  let tops = [];
  const finalImage = root.querySelector('.home-scroll-sequence__reduced--final');
  const clamp = n => Math.max(0, Math.min(1, n));
  function measure() { tops = anchors.map(el => el.getBoundingClientRect().top + scrollY); renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); update(); }
  function update() {
    let segment = 0;
    while (segment < tops.length - 2 && scrollY >= tops[segment + 1]) segment++;
    desired = segment + clamp((scrollY - tops[segment]) / Math.max(1, tops[segment + 1] - tops[segment]));
    const active = scrollY >= tops[5] - 2;
    root.dataset.chapter = active ? 'writing' : ['home', 'transition', 'inbox', 'gallery', 'notes'][segment];
    root.dataset.interactive = String(active);
    writing.classList.toggle('is-active', active); writing.setAttribute('aria-hidden', String(!active));
    // Keep the existing paper composition aligned with the unchanged writing controls.
    finalImage.style.opacity = String(clamp((desired - 4) * 1.5));
    if (reduced.matches) current = desired;
    requestFrame();
  }
  function render(now) {
    raf = 0; if (disposed || document.hidden) return;
    current += (desired - current) * .075;
    const i = Math.min(4, Math.floor(current)), p = current - i, ease = p * p * (3 - 2 * p);
    camera.position.lerpVectors(cameraPositions[i], cameraPositions[i + 1], ease);
    camera.lookAt(new T.Vector3().lerpVectors(targets[i], targets[i + 1], ease));
    const t = reduced.matches ? 0 : now * .001;
    skyMat.uniforms.time.value = t; waterMat.uniforms.time.value = t;
    trees.forEach((tree, index) => { tree.rotation.z = Math.sin(t * .35 + index) * .003; });
    renderer.render(scene, camera); poster.classList.add('is-ready'); root.dataset.background = 'coastal';
    if (!reduced.matches && desired < 5) requestFrame();
  }
  function requestFrame() { if (!raf && !disposed) raf = requestAnimationFrame(render); }
  function visibility() { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else requestFrame(); }
  window.addEventListener('scroll', update, { passive: true }); window.addEventListener('resize', measure);
  document.addEventListener('visibilitychange', visibility); reduced.addEventListener('change', update);
  const resizeObserver = new ResizeObserver(measure); anchors.forEach(el => resizeObserver.observe(el));
  measure();
  return () => {
    disposed = true; cancelAnimationFrame(raf); resizeObserver.disconnect();
    window.removeEventListener('scroll', update); window.removeEventListener('resize', measure);
    document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', update);
    resources.forEach(resource => resource.dispose()); stems.dispose(); flowers.dispose(); renderer.dispose(); canvas.style.filter = ''; finalImage.style.opacity = ''; delete root.dataset.background;
  };
}
