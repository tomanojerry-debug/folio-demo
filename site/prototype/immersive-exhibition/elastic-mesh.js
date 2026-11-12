import { Renderer, Geometry, Program, Mesh, Texture } from "../../vendor/ogl/src/index.js";

const DIST = 4.6;
// Resting state fills the card exactly; deformation is introduced only by pointer force.
const FIT = 1;
const VERT = `precision highp float;attribute vec2 aGrid;attribute vec2 uv;attribute vec3 aOffset;attribute vec3 aNormal;uniform float uAspect;uniform float uTilt;uniform float uDist;uniform float uFit;varying vec2 vUv;varying vec3 vNormal;varying float vDepth;void main(){vUv=uv;vec2 base=vec2((aGrid.x*2.0-1.0)*uAspect,1.0-aGrid.y*2.0);vec3 p=vec3(base+aOffset.xy,aOffset.z);float ct=cos(uTilt),st=sin(uTilt);p=vec3(p.x,p.y*ct-p.z*st,p.y*st+p.z*ct);float persp=uDist/(uDist-p.z);gl_Position=vec4(vec2(p.x/uAspect,p.y)*persp*uFit,0.,1.);vNormal=aNormal;vDepth=aOffset.z;}`;
const FRAG = `precision highp float;varying vec2 vUv;varying vec3 vNormal;varying float vDepth;uniform sampler2D tMap;uniform float uHasImage;uniform float uImageAspect;uniform vec3 uColor1;uniform vec3 uColor2;uniform vec3 uHighlight;uniform float uShading;uniform vec2 uRes;uniform float uRadius;uniform float uGrid;uniform float uGridDensity;uniform float uGridOpacity;uniform vec3 uGridColor;void main(){vec2 sampleUv=vUv;float imageAlpha=1.;float frameAspect=uRes.x/max(uRes.y,1.);if(uHasImage>.5){if(frameAspect>uImageAspect){float used=uImageAspect/frameAspect;imageAlpha=step(abs(vUv.x-.5),used*.5);sampleUv.x=(vUv.x-.5)/max(used,.0001)+.5;}else{float used=frameAspect/uImageAspect;imageAlpha=step(abs(vUv.y-.5),used*.5);sampleUv.y=(vUv.y-.5)/max(used,.0001)+.5;}}vec3 base=uHasImage>.5?texture2D(tMap,clamp(sampleUv,0.,1.)).rgb:mix(uColor1,uColor2,clamp(vUv.y,0.,1.));vec3 N=normalize(vNormal),L=normalize(vec3(-.35,.55,.78)),H=normalize(L+vec3(0.,0.,1.));float diff=clamp(dot(N,L),0.,1.);float sr=pow(clamp(dot(N,H),0.,1.),26.);float sf=pow(clamp(H.z,0.,1.),26.);float spec=clamp((sr-sf)/(1.-sf),0.,1.);float ao=clamp(1.+vDepth*.45,.65,1.25);vec3 lit=base*(1.-uShading*.28)+base*diff*uShading*.55;lit=lit*ao+uHighlight*spec*uShading*.25;if(uGrid>.5){vec2 g=vUv*uGridDensity,w=uGridDensity/max(uRes,vec2(1.));vec2 d=abs(fract(g-.5)-.5)/max(w*1.5,vec2(1e-4));float line=1.-clamp(min(d.x,d.y),0.,1.);lit=mix(lit,uGridColor,line*uGridOpacity*(.45+diff*.55));}vec2 p=(vUv-.5)*uRes,halfRes=uRes*.5;float r=min(uRadius,min(halfRes.x,halfRes.y));vec2 q=abs(p)-(halfRes-r);float sd=length(max(q,0.))+min(max(q.x,q.y),0.)-r;float alpha=(1.-smoothstep(-1.25,1.25,sd))*imageAlpha;if(alpha<=.002)discard;gl_FragColor=vec4(lit,alpha);}`;

function rgb(hex) {
  let h = String(hex || "#000").replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function mountElasticMesh(container, options = {}) {
  if (!container) return null;
  const p = { color1: "#5227ff", color2: "#b19eef", highlight: "#fff", showGrid: true, gridDensity: 20, gridOpacity: .28, gridColor: "#fff", borderRadius: 4, stiffness: .05, damping: .2, grabRadius: .6, pull: .4, wobble: 5, tilt: 14, shading: .5, resolution: 25, ...options };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // WebGL 不可用（GPU 禁用、上下文超限等）时静默降级，避免打断整页渲染。
  let renderer;
  try {
    renderer = new Renderer({ alpha: true, antialias: true, dpr: Math.min(devicePixelRatio || 1, 2) });
  } catch {
    return null;
  }
  const gl = renderer.gl;
  if (!gl) return null;
  gl.clearColor(0, 0, 0, 0); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const N = Math.max(6, Math.min(40, Math.round(p.resolution))), count = N * N;
  const grid = new Float32Array(count * 2), uv = new Float32Array(count * 2), offset = new Float32Array(count * 3), normal = new Float32Array(count * 3);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * N + i, u = i / (N - 1), v = j / (N - 1); grid[k * 2] = uv[k * 2] = u; grid[k * 2 + 1] = uv[k * 2 + 1] = v; normal[k * 3 + 2] = 1; }
  const index = new Uint16Array((N - 1) * (N - 1) * 6); let q = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i, b = a + 1, c = a + N, d = c + 1; index.set([a, c, b, b, c, d], q); q += 6; }
  const geometry = new Geometry(gl, { aGrid: { size: 2, data: grid }, uv: { size: 2, data: uv }, aOffset: { size: 3, data: offset }, aNormal: { size: 3, data: normal }, index: { data: index } });
  const texture = new Texture(gl, { generateMipmaps: false, flipY: false });
  const program = new Program(gl, { vertex: VERT, fragment: FRAG, transparent: true, cullFace: null, uniforms: { tMap: { value: texture }, uHasImage: { value: 0 }, uImageAspect: { value: 1 }, uColor1: { value: rgb(p.color1) }, uColor2: { value: rgb(p.color2) }, uHighlight: { value: rgb(p.highlight) }, uGrid: { value: p.showGrid ? 1 : 0 }, uGridDensity: { value: p.gridDensity }, uGridOpacity: { value: p.gridOpacity }, uGridColor: { value: rgb(p.gridColor) }, uShading: { value: p.shading }, uRes: { value: [1, 1] }, uRadius: { value: p.borderRadius }, uAspect: { value: 1 }, uTilt: { value: p.tilt * Math.PI / 180 }, uDist: { value: DIST }, uFit: { value: FIT } } });
  if (p.image) { const img = new Image(); img.src = p.image; img.onload = () => { texture.image = img; program.uniforms.uImageAspect.value = img.naturalWidth / Math.max(1, img.naturalHeight); program.uniforms.uHasImage.value = 1; }; }
  const mesh = new Mesh(gl, { geometry, program }), baseX = new Float32Array(count), baseY = new Float32Array(count), pos = new Float32Array(count * 3), vel = new Float32Array(count * 3), acc = new Float32Array(count * 3);
  let aspect = 1;
  const resize = () => { const w = container.offsetWidth || 1, h = container.offsetHeight || 1; renderer.setSize(w, h); aspect = w / h; program.uniforms.uAspect.value = aspect; program.uniforms.uRes.value = [w, h]; for (let k = 0; k < count; k++) { baseX[k] = (grid[k * 2] * 2 - 1) * aspect; baseY[k] = 1 - grid[k * 2 + 1] * 2; } };
  const ro = new ResizeObserver(resize); ro.observe(container); resize(); container.appendChild(gl.canvas);
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, active: false };
  const move = (e) => { const r = container.getBoundingClientRect(), cx = ((e.clientX - r.left) / r.width) * 2 - 1, cy = 1 - ((e.clientY - r.top) / r.height) * 2, t = p.tilt * Math.PI / 180, a = cy / (Math.cos(t) * FIT * DIST), py = a * DIST / (1 + a * Math.sin(t)), persp = DIST / (DIST - py * Math.sin(t)); pointer.tx = cx * aspect / (persp * FIT); pointer.ty = py; pointer.active = true; };
  const leave = () => { pointer.active = false; };
  container.addEventListener("pointermove", move); container.addEventListener("pointerenter", move); container.addEventListener("pointerleave", leave);
  const step = () => {
    const coupling = .06 + p.wobble * .032, radius = Math.max(.08, p.grabRadius) * 1.4, force = p.pull * .009;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * N + i, o = k * 3; let ax = -p.stiffness * pos[o], ay = -p.stiffness * pos[o + 1], az = -p.stiffness * pos[o + 2], sx = 0, sy = 0, sz = 0, n = 0; const near = []; if (i) near.push(k - 1); if (i < N - 1) near.push(k + 1); if (j) near.push(k - N); if (j < N - 1) near.push(k + N); for (const v of near) { sx += pos[v * 3]; sy += pos[v * 3 + 1]; sz += pos[v * 3 + 2]; n++; } ax += coupling * (sx - n * pos[o]); ay += coupling * (sy - n * pos[o + 1]); az += coupling * (sz - n * pos[o + 2]); if (pointer.active && !reduced) { const dx = pointer.x - baseX[k] - pos[o], dy = pointer.y - baseY[k] - pos[o + 1], d = Math.hypot(dx, dy), t = d / radius; if (t < 1) { const bump = 1 - t * t; az += force * bump * bump * 6; if (d > 1e-4) { const pinch = t * (1 - t) * (1 - t) * 6.75, dir = force * pinch * 1.6 / d; ax += dx * dir; ay += dy * dir; } } } acc[o] = ax; acc[o + 1] = ay; acc[o + 2] = az; }
    const retain = 1 - p.damping; for (let k = 0; k < count * 3; k++) { vel[k] = (vel[k] + acc[k]) * retain; pos[k] = Math.max(-1.2, Math.min(1.2, pos[k] + vel[k])); }
  };
  const commit = () => { for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * N + i, o = k * 3, l = i ? k - 1 : k, r = i < N - 1 ? k + 1 : k, d = j ? k - N : k, u = j < N - 1 ? k + N : k; const tx = [baseX[r] + pos[r * 3] - baseX[l] - pos[l * 3], baseY[r] + pos[r * 3 + 1] - baseY[l] - pos[l * 3 + 1], pos[r * 3 + 2] - pos[l * 3 + 2]], ty = [baseX[u] + pos[u * 3] - baseX[d] - pos[d * 3], baseY[u] + pos[u * 3 + 1] - baseY[d] - pos[d * 3 + 1], pos[u * 3 + 2] - pos[d * 3 + 2]]; let nx = tx[1] * ty[2] - tx[2] * ty[1], ny = tx[2] * ty[0] - tx[0] * ty[2], nz = tx[0] * ty[1] - tx[1] * ty[0]; if (nz < 0) { nx *= -1; ny *= -1; nz *= -1; } const len = Math.hypot(nx, ny, nz) || 1; normal[o] = nx / len; normal[o + 1] = ny / len; normal[o + 2] = nz / len; offset[o] = pos[o]; offset[o + 1] = pos[o + 1]; offset[o + 2] = pos[o + 2]; } geometry.attributes.aOffset.needsUpdate = true; geometry.attributes.aNormal.needsUpdate = true; };
  let raf = 0, last = performance.now(), carry = 0;
  const frame = (now) => { raf = requestAnimationFrame(frame); const dt = Math.min(.25, (now - last) / 1000); last = now; const lerp = 1 - Math.exp(-Math.max(dt, 1e-4) / .06); pointer.x += (pointer.tx - pointer.x) * lerp; pointer.y += (pointer.ty - pointer.y) * lerp; carry += dt; let n = 0; while (carry >= 1 / 120 && n++ < 5) { step(); carry -= 1 / 120; } commit(); renderer.render({ scene: mesh }); };
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); ro.disconnect(); container.removeEventListener("pointermove", move); container.removeEventListener("pointerenter", move); container.removeEventListener("pointerleave", leave); gl.canvas.remove(); gl.getExtension("WEBGL_lose_context")?.loseContext(); };
}
