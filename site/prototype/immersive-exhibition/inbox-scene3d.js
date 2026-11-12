// inbox-scene3d.js — Inbox 场景态：真 3D 玻璃卡层（零依赖原生 WebGL）。
// 思路：卡片是带真实厚度的 3D 几何体，站在一个与静态场景态背景匹配的 3D 相机空间里；
// 地面是一张接收接触阴影的 3D 平面（皮肤实时采样背景图，保证与背景无缝）；
// 玻璃的透射/反射也实时采样背景图，反光随环境明暗变化。
// 降级路径（移动端 / 减动效 / 无 WebGL）继续走 CSS 场景，本模块不挂载。

export function mountInboxScene3D({ scene, cards, onOpen }) {
  if (!scene || !cards.length) return null;
  const stage = scene.querySelector(".inbox-scene__stage") || scene;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return null;
  const canvas = document.createElement("canvas");
  canvas.className = "inbox-scene__webgl";
  canvas.setAttribute("role", "group");
  canvas.setAttribute("aria-label", "散落在场景中的玻璃卡片，悬停查看，点击打开详情");
  canvas.tabIndex = 0;
  scene.classList.add("is-webgl-scene");
  stage.appendChild(canvas);
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true })
    || canvas.getContext("experimental-webgl", { alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) {
    canvas.remove();
    scene.classList.remove("is-webgl-scene");
    return null;
  }
  // 预热：空清除 + finish，确保上下文与合成器建立联系
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.finish();

  // 背景采样源：优先使用当前动态湖面，海报作为视频未就绪时的可靠回退。
  const sceneVideo = stage.querySelector(".inbox-scene__video");
  const FOV_Y = 55 * Math.PI / 180;
  const CAM_H = 2.5;
  const PITCH = 0.0312;           // 微俯视，让地平线落在 y≈47%
  const PUSH_MAX = 1.05;          // 10s 循环内相机向前推的幅度（与视频推镜近似）
  const GLASS_T = 0.08;           // 玻璃厚度（世界单位，约 8px 的近景视觉厚度）
  const BASE_PX = 118;            // 统一基准宽度（近/中/远由锚点 s 分层缩放）

  // ---------- 数学工具 ----------
  const M4 = {
    identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    multiply(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
      }
      return o;
    },
    translate(x, y, z) { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]); },
    rotX(a) {
      const c = Math.cos(a), s = Math.sin(a);
      return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
    },
    rotY(a) {
      const c = Math.cos(a), s = Math.sin(a);
      return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
    },
    rotZ(a) {
      const c = Math.cos(a), s = Math.sin(a);
      return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    },
    perspective(fovY, aspect, near, far) {
      const f = 1 / Math.tan(fovY / 2);
      const nf = 1 / (near - far);
      return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
    },
    lookAt(eye, target, up) {
      const z = norm3(sub3(eye, target));
      const x = norm3(cross3(up, z));
      const y = cross3(z, x);
      return new Float32Array([
        x[0], x[1], x[2], 0,
        y[0], y[1], y[2], 0,
        z[0], z[1], z[2], 0,
        -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
      ]);
    },
  };
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // 投影：世界点 (x, y, z)（相机在 (0,CAM_H,-push) 微俯视）→ 屏幕分数 (0..1, 0..1)
  function projectPoint(x, y, z, push, aspect = 1) {
    const ey = y - CAM_H;
    const fwd = -z - push;
    const yCam = ey * Math.cos(PITCH) - fwd * Math.sin(PITCH);
    const zCam = -(ey * Math.sin(PITCH) + fwd * Math.cos(PITCH));
    if (zCam > -0.05) return null;
    const ndcY = yCam / (-zCam) / Math.tan(FOV_Y / 2);
    const ndcX = x / (-zCam) / Math.tan(FOV_Y / 2) / aspect;
    return [0.5 + 0.5 * ndcX, 0.5 - 0.5 * ndcY];
  }
  // 反解：让「卡片中心」（高度随距离变化）投到目标屏幕 y 的地面距离
  function solveCardDist(yFrac, px, tanX, aspect) {
    let lo = 0.5, hi = 600;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const w = (px * mid * tanX * 2) / W;
      const h = (w * 4.05) / 3;
    const p = projectPoint(0, h / 2, -mid, 0, aspect);
      if (!p) { lo = mid; continue; }
      if (p[1] < yFrac) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  // ---------- 几何 ----------
  function buildRoundedCard(w, h, t, radius, seg) {
    const r = Math.max(0.02, Math.min(radius, w / 2 - 0.01, h / 2 - 0.01));
    const hw = w / 2 - r, hh = h / 2 - r;
    const pts = [];
    const arc = (cx, cy, a0, a1) => {
      for (let i = 0; i <= seg; i++) {
        const a = a0 + (a1 - a0) * (i / seg);
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
    };
    // 逆时针轮廓（x 左→右，y 下→上）：右下 → 右上 → 左上 → 左下
    arc(hw, -hh, -Math.PI / 2, 0);
    arc(hw, hh, 0, Math.PI / 2);
    arc(-hw, hh, Math.PI / 2, Math.PI);
    arc(-hw, -hh, Math.PI, Math.PI * 1.5);
    const n = pts.length - 1;
    const hf = t / 2;
    const pos = [], nrm = [], uv = [], idx = [];
    const edge = [];
    const push = (x, y, z, nx, ny, nz, u, v, e) => {
      pos.push(x, y, z); nrm.push(nx, ny, nz); uv.push(u, v); edge.push(e);
    };
    const uvAt = (x, y) => [x / w + 0.5, 1 - (y / h + 0.5)];
    // 正面（面向相机，+Z）
    push(0, 0, hf, 0, 0, 1, 0.5, 0.5, 0);
    const center = 0;
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i];
      const u = uvAt(x, y);
      push(x, y, hf, 0, 0, 1, u[0], u[1], 0);
    }
    for (let i = 0; i < n; i++) {
      idx.push(center, 1 + i, 1 + ((i + 1) % n));
    }
    // 背面（-Z）
    push(0, 0, -hf, 0, 0, -1, 0.5, 0.5, 0);
    const backCenter = 1 + n;
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i];
      const u = uvAt(x, y);
      push(x, y, -hf, 0, 0, -1, u[0], u[1], 0);
    }
    for (let i = 0; i < n; i++) {
      idx.push(backCenter, backCenter + 1 + ((i + 1) % n), backCenter + 1 + i);
    }
    // 侧边（挤出）
    const e0 = 1 + n + 1 + n;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = dy / len, ny = -dx / len;
      const base = e0 + i * 4;
      push(x0, y0, hf, nx, ny, 0, 0, 0, 1);
      push(x1, y1, hf, nx, ny, 0, 0, 0, 1);
      push(x0, y0, -hf, nx, ny, 0, 0, 0, 1);
      push(x1, y1, -hf, nx, ny, 0, 0, 0, 1);
      idx.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
    return {
      pos: new Float32Array(pos),
      nrm: new Float32Array(nrm),
      uv: new Float32Array(uv),
      edge: new Float32Array(edge),
      idx: new Uint16Array(idx),
      count: idx.length,
    };
  }

  function buildShadowQuad() {
    const s = 1;
    return {
      pos: new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]),
      uv: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      idx: new Uint16Array([0, 1, 2, 2, 1, 3]),
      count: 6,
    };
  }

  // ---------- 着色器 ----------
  const CARD_VS = `
    attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv; attribute float aEdge;
    uniform mat4 uProjView; uniform mat4 uModel;
    varying vec3 vNrm; varying vec3 vWorld; varying vec2 vUv; varying float vEdge;
    void main(){
      vec4 wp = uModel * vec4(aPos, 1.0);
      vWorld = wp.xyz;
      vNrm = normalize(mat3(uModel) * aNrm);
      vUv = aUv;
      vEdge = aEdge;
      gl_Position = uProjView * wp;
    }`;
  const CARD_FS = `
    precision highp float;
    varying vec3 vNrm; varying vec3 vWorld; varying vec2 vUv; varying float vEdge;
    uniform sampler2D uVideo; uniform sampler2D uContent;
    uniform vec3 uCamPos; uniform float uHover; uniform float uTime;
    uniform vec2 uSpotlight;
    uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;
    uniform vec2 uViewport;
    void main(){
      vec3 V = normalize(uCamPos - vWorld);
      vec3 N = normalize(vNrm);
      float ndv = max(dot(N, V), 0.0);
      // 逐片元屏幕坐标：避免顶点插值误差在玻璃透射/反射处产生内部接缝线
      vec2 suv = clamp(gl_FragCoord.xy / uViewport, 0.0, 1.0);
      vec2 refr = (vUv - 0.5) * (0.014 + 0.008 * uHover);
      // 环境透出为主：轻微磨砂（3 次采样柔化）+ 折射偏移
      vec3 trans = texture2D(uVideo, clamp(suv + refr, 0.0, 1.0)).rgb;
      trans += texture2D(uVideo, clamp(suv + refr + vec2(0.004, 0.0), 0.0, 1.0)).rgb;
      trans += texture2D(uVideo, clamp(suv + refr + vec2(0.0, 0.004), 0.0, 1.0)).rgb;
      trans *= 0.3333;
      float tLum = dot(trans, vec3(0.299, 0.587, 0.114));
      trans = mix(vec3(0.16, 0.14, 0.11), trans, smoothstep(0.03, 0.14, tLum));
      // 柔和环境反射：只带一点天空反光，保持清透
      float reflY = clamp(0.5 - (suv.y - 0.5) * 1.45, 0.02, 0.45);
      vec3 refl = texture2D(uVideo, vec2(clamp(suv.x, 0.02, 0.98), reflY)).rgb;
      float rLum = dot(refl, vec3(0.299, 0.587, 0.114));
      vec3 skyCol = mix(vec3(0.90, 0.91, 0.94), vec3(0.42, 0.55, 0.78), 1.0 - smoothstep(0.0, 0.45, reflY));
      refl = mix(skyCol, refl, smoothstep(0.04, 0.12, rLum));
      float fres = pow(1.0 - ndv, 2.2);
      float reflectMix = clamp(0.16 + fres * 0.30, 0.0, 0.44);
      vec3 col = mix(trans, refl, reflectMix);
      // 玻璃清透染色：透出环境时带一点冷白
      col = mix(col, vec3(0.93, 0.96, 1.0), 0.10);
      vec3 L = normalize(vec3(-0.42 + sin(uTime * 0.12) * 0.05, 0.62, 0.58 + cos(uTime * 0.1) * 0.05));
      vec3 H = normalize(L + V);
      float dist = length(vWorld - uCamPos);
      // 远卡降低动态细节，避免小尺寸上高光/扫光闪动
      float detail = 1.0 - smoothstep(7.0, 38.0, dist);
      float spec = pow(max(dot(N, H), 0.0), 72.0) * (0.35 + 0.65 * detail);
      col += vec3(1.0, 0.97, 0.90) * spec * 0.38;
      float dEdge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
      float rim = 1.0 - smoothstep(0.0, 0.09, dEdge);
      col += refl * rim * 0.32;
      col += vec3(0.93, 0.97, 1.0) * rim * 0.18;
      col += vec3(0.92, 0.96, 1.0) * (1.0 - vUv.y) * 0.08;
      // 底部贴地 AO：靠近地面的下缘轻微压暗，增强“插在沙地里”的接地感
      float baseAO = smoothstep(0.72, 1.0, vUv.y);
      col *= mix(1.0, 0.90, baseAO * 0.5);
      if (vEdge > 0.5) {
        col = mix(col, col * 0.80, 0.40);
        col += texture2D(uVideo, clamp(suv + vec2(0.0, 0.06), 0.0, 1.0)).rgb * 0.08;
      }
      vec4 cont = texture2D(uContent, vUv);
      // Hover 时整张卡均匀显现内容，不使用跟随指针的聚光灯遮罩。
      float reveal = smoothstep(0.02, 0.34, uHover);
      col = mix(col, cont.rgb, cont.a * reveal * 0.96);
      float sweep = fract((vUv.x + vUv.y) * 1.12 - uTime * 0.42);
      float shine = smoothstep(0.0, 0.10, sweep) * (1.0 - smoothstep(0.09, 0.20, sweep));
      col += vec3(1.0, 0.99, 0.93) * shine * (0.05 + 0.55 * uHover) * (0.30 + 0.70 * detail) * 0.5;
      float fog = smoothstep(uFogNear, uFogFar, dist);
      col = mix(col, uFog, fog * 0.40);
      // 更通透：环境明显透出，hover 时稍实保证文字可读
      float alpha = mix(0.70, 0.90, uHover);
      if (vEdge > 0.5) alpha = 0.82;
      gl_FragColor = vec4(col, alpha);
    }`;
  const SHADOW_VS = `
    attribute vec3 aPos; attribute vec2 aUv;
    uniform mat4 uProjView; uniform mat4 uModel;
    varying vec2 vUv;
    void main(){
      vUv = aUv;
      gl_Position = uProjView * uModel * vec4(aPos, 1.0);
    }`;
  const SHADOW_FS = `
    precision highp float;
    varying vec2 vUv;
    uniform float uOpacity;
    void main(){
      float d = length(vUv - 0.5) * 2.0;
      float a = 1.0 - smoothstep(0.15, 1.0, d);
      a = a * a * (3.0 - 2.0 * a);
      gl_FragColor = vec4(0.05, 0.02, 0.005, a * uOpacity);
    }`;

  function createProgram(vs, fs) {
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn("scene3d shader:", gl.getShaderInfoLog(s));
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    return p;
  }

  const cardProg = createProgram(CARD_VS, CARD_FS);
  const shadowProg = createProgram(SHADOW_VS, SHADOW_FS);
  const cardAttribs = {
    pos: gl.getAttribLocation(cardProg, "aPos"),
    nrm: gl.getAttribLocation(cardProg, "aNrm"),
    uv: gl.getAttribLocation(cardProg, "aUv"),
    edge: gl.getAttribLocation(cardProg, "aEdge"),
  };
  const cardUniforms = {
    pv: gl.getUniformLocation(cardProg, "uProjView"),
    model: gl.getUniformLocation(cardProg, "uModel"),
    video: gl.getUniformLocation(cardProg, "uVideo"),
    content: gl.getUniformLocation(cardProg, "uContent"),
    cam: gl.getUniformLocation(cardProg, "uCamPos"),
    hover: gl.getUniformLocation(cardProg, "uHover"),
    spotlight: gl.getUniformLocation(cardProg, "uSpotlight"),
    time: gl.getUniformLocation(cardProg, "uTime"),
    fog: gl.getUniformLocation(cardProg, "uFog"),
    fogNear: gl.getUniformLocation(cardProg, "uFogNear"),
    fogFar: gl.getUniformLocation(cardProg, "uFogFar"),
    viewport: gl.getUniformLocation(cardProg, "uViewport"),
  };
  const shadowUniforms = {
    pv: gl.getUniformLocation(shadowProg, "uProjView"),
    model: gl.getUniformLocation(shadowProg, "uModel"),
    opacity: gl.getUniformLocation(shadowProg, "uOpacity"),
  };
  const shadowAttribs = {
    pos: gl.getAttribLocation(shadowProg, "aPos"),
    uv: gl.getAttribLocation(shadowProg, "aUv"),
  };

  // ---------- 缓冲 ----------
  function makeBuffers(geo) {
    const b = {
      vao: null,
      pos: gl.createBuffer(), idx: gl.createBuffer(),
      nrm: geo.nrm ? gl.createBuffer() : null,
      uv: geo.uv ? gl.createBuffer() : null,
      edge: geo.edge ? gl.createBuffer() : null,
      count: geo.count,
    };
    const bind = (buf, arr, loc, size, prog) => {
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    if (gl.createVertexArray) {
      b.vao = gl.createVertexArray();
      gl.bindVertexArray(b.vao);
    }
    bind(b.pos, geo.pos, cardAttribs.pos, 3, cardProg);
    if (geo.nrm) bind(b.nrm, geo.nrm, cardAttribs.nrm, 3, cardProg);
    if (geo.uv) bind(b.uv, geo.uv, cardAttribs.uv, 2, cardProg);
    if (geo.edge) bind(b.edge, geo.edge, cardAttribs.edge, 1, cardProg);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.idx, gl.STATIC_DRAW);
    if (gl.createVertexArray) gl.bindVertexArray(null);
    return b;
  }

  // ---------- 纹理 ----------
  const videoCanvas = document.createElement("canvas");
  videoCanvas.width = 512;
  videoCanvas.height = 288;
  const vctx = videoCanvas.getContext("2d");
  const videoTex = gl.createTexture();
  const contentTexs = [];
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = 64;
  shadowCanvas.height = 64;
  {
    const c = shadowCanvas.getContext("2d");
    const g = c.createRadialGradient(32, 32, 2, 32, 32, 31);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(0.55, "rgba(0,0,0,.55)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  }
  const shadowTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, shadowTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, shadowCanvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  function bindVideoTex() {
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    if (sceneVideo?.readyState >= 2 && sceneVideo.videoWidth) {
      const iw = sceneVideo.videoWidth, ih = sceneVideo.videoHeight;
      const scale = Math.max(W / iw, H / ih);
      const vw = W / scale, vh = H / scale;
      const sx = (iw - vw) * 0.5;
      const sy = Math.max(0, Math.min(ih - vh, (ih - vh) * 0.5));
      const vch = Math.max(64, Math.round(384 * H / W));
      if (videoCanvas.height !== vch || videoCanvas.width !== 384) { videoCanvas.width = 384; videoCanvas.height = vch; }
      vctx.drawImage(sceneVideo, sx, sy, vw, vh, 0, 0, 384, vch);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoCanvas);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([36, 21, 20, 255]));
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // 卡片内容画布：来源 · 类型 + 标题（悬停浮现）
  function makeContentTexture(card) {
    const W = 256, H = 346;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.clearRect(0, 0, W, H);
    const meta = `${card.item.source || ""} · ${card.item.type || ""}`.toUpperCase();
    const title = card.item.title || "";
    const inDirection = card.insight?.members?.includes(card.item.id);
    const wrap = (text, font, maxW) => {
      x.font = font;
      const words = String(text).split("");
      const lines = [];
      let line = "";
      for (const ch of words) {
        const test = line + ch;
        if (x.measureText(test).width > maxW && line) { lines.push(line); line = ch; }
        else line = test;
      }
      if (line) lines.push(line);
      return lines;
    };
    const paintOverlay = () => {
      // 底部压暗
      const g = x.createLinearGradient(0, H * 0.22, 0, H);
      g.addColorStop(0, "rgba(18,10,4,.02)");
      g.addColorStop(0.52, "rgba(18,10,4,.12)");
      g.addColorStop(1, "rgba(18,10,4,.82)");
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
      x.textBaseline = "alphabetic";
      x.fillStyle = "rgba(255,252,238,.88)";
      x.font = "600 15px 'IBM Plex Sans','Noto Sans SC',sans-serif";
      x.letterSpacing = "1.2px";
      x.fillText(meta, 18, H - 78);
      if (inDirection) {
        x.fillStyle = "#ffe1a8";
        x.font = "14px sans-serif";
        x.fillText("✦", W - 30, H - 78);
      }
      x.fillStyle = "#fffdf4";
      x.font = "500 25px 'Noto Serif SC','Noto Sans SC',serif";
      x.textAlign = "left";
      const lines = wrap(title, "500 25px 'Noto Serif SC','Noto Sans SC',serif", W - 36).slice(0, 2);
      lines.forEach((line, i) => x.fillText(line, 18, H - 50 + i * 31));
    };
    const drawCover = (img) => {
      const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      const sw = W / scale, sh = H / scale;
      x.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, W, H);
      x.fillStyle = "rgba(18,14,12,.08)";
      x.fillRect(0, 0, W, H);
    };
    // 无缩略图时仍有一层有质感的生成式占位，不出现空白卡面。
    const fallback = x.createLinearGradient(0, 0, W, H);
    fallback.addColorStop(0, "#8ca9bd");
    fallback.addColorStop(0.46, "#5f7180");
    fallback.addColorStop(1, "#b47c54");
    x.fillStyle = fallback;
    x.fillRect(0, 0, W, H);
    paintOverlay();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (card.item.thumbnail) {
      const img = new Image();
      img.onload = () => {
        if (disposed) return;
        x.clearRect(0, 0, W, H);
        drawCover(img);
        paintOverlay();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      };
      img.src = card.item.thumbnail;
    }
    return tex;
  }

  // ---------- 布局与卡片状态 ----------
  let W = 0, H = 0, dpr = 1;
  const cardStates = [];
  function layout() {
    const rect = stage.getBoundingClientRect();
    W = Math.max(1, Math.floor(rect.width));
    H = Math.max(1, Math.floor(rect.height));
    dpr = Math.min(1.75, window.devicePixelRatio || 1);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
    const aspect = W / H;
    const tanX = Math.tan(FOV_Y / 2) * aspect;
    cards.forEach((card, i) => {
      const a = card.anchor || {};
      const depth = Number(a.d || 0);
      let yFrac = (a.y ?? 65) / 100;
      yFrac = depth === 2 ? Math.min(0.56, Math.max(0.30, yFrac)) : depth === 1 ? Math.min(0.72, Math.max(0.52, yFrac)) : Math.min(0.72, Math.max(0.58, yFrac));
      const xFrac = (a.x ?? 50) / 100;
      const px = BASE_PX * (a.s ?? 1);
      const d = solveCardDist(yFrac, px, tanX, aspect);
      const z = -d;
      const w = px * d * tanX * 2 / W;
      const h = w * 4.05 / 3;
      const x = (xFrac - 0.5) * 2 * d * tanX;
      cardStates[i] = {
        x, z, w, h,
        lean: 0,
        slotR: 0,
        slotY: ((a.ty ?? 0) * Math.PI) / 180,
        hover: 0, hoverTarget: 0, hovered: false,
        spotX: 0.5, spotY: 0.5, spotTargetX: 0.5, spotTargetY: 0.5,
        fogNear: 8 + depth * 8,
        fogFar: 22 + depth * 13,
        shadowOpacity: depth === 0 ? 0.78 : depth === 1 ? 0.58 : 0.38,
      };
    });
  }

  // ---------- 渲染 ----------
  const shadowGeo = buildShadowQuad();
  const shadowBufs = (() => {
    const b = { pos: gl.createBuffer(), idx: gl.createBuffer(), count: shadowGeo.count };
    if (gl.createVertexArray) {
      b.vao = gl.createVertexArray();
      gl.bindVertexArray(b.vao);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.bufferData(gl.ARRAY_BUFFER, shadowGeo.pos, gl.STATIC_DRAW);
    let loc = gl.getAttribLocation(shadowProg, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    b.uv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b.uv);
    gl.bufferData(gl.ARRAY_BUFFER, shadowGeo.uv, gl.STATIC_DRAW);
    loc = gl.getAttribLocation(shadowProg, "aUv");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, shadowGeo.idx, gl.STATIC_DRAW);
    if (gl.createVertexArray) gl.bindVertexArray(null);
    return b;
  })();

  let cardBuffers = [];
  function buildCardBuffers() {
    cardBuffers.forEach((b) => { gl.deleteBuffer(b.pos); gl.deleteBuffer(b.idx); });
    cardBuffers = cardStates.map((s) => {
      const geo = buildRoundedCard(s.w, s.h, GLASS_T, Math.min(s.w * 0.085, 0.22), 7);
      return makeBuffers(geo);
    });
  }

  let raf = 0, disposed = false, lastT = 0;
  let frameCount = 0, probeDone = false;
  let hoverIndex = -1;
  const pointer = { x: 0.5, y: 0.5 };
  const hoverEase = (cur, target, dt) => cur + (target - cur) * Math.min(1, dt * 7);

  function disposeModule() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("keydown", onKey);
    scene.classList.remove("is-webgl-scene", "is-hovering");
    canvas.remove();
    cardBuffers.forEach((b) => { gl.deleteBuffer(b.pos); gl.deleteBuffer(b.idx); });
    gl.deleteBuffer(shadowBufs.pos);
    gl.deleteBuffer(shadowBufs.idx);
    contentTexs.forEach((t) => gl.deleteTexture(t));
    gl.deleteTexture(videoTex);
    gl.deleteTexture(shadowTex);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // 自检：画满若干帧后读一次画布像素，若没有任何卡片被画出则回退 CSS 场景，避免空场景。
  function probeRender(push) {
    if (probeDone) return;
    probeDone = true;
    const st = cardStates[Math.floor(cardStates.length / 2)];
    if (!st) return;
    const pp = projectPoint(st.x, st.h / 2 + GLASS_T / 2, st.z, push, W / H);
    if (!pp) { failToCss(); return; }
    const x0 = Math.max(0, Math.min(canvas.width - 8, Math.floor(pp[0] * canvas.width) - 3));
    const y0 = Math.max(0, Math.min(canvas.height - 8, Math.floor((1 - pp[1]) * canvas.height) - 3));
    const buf = new Uint8Array(7 * 7 * 4);
    gl.readPixels(x0, y0, 7, 7, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    for (let i = 3; i < buf.length; i += 4) {
      if (buf[i] > 10) return;
    }
    failToCss();
  }
  function failToCss() {
    disposeModule();
    scene.dispatchEvent(new CustomEvent("scene3d:failed"));
  }

  function viewMatrix(push) {
    const eye = [0, CAM_H, -push];
    const target = [0, CAM_H - Math.tan(PITCH) * 12, -push - 12];
    return M4.lookAt(eye, target, [0, 1, 0]);
  }

  function drawCard(st, buf, model, time, push, pv) {
    gl.useProgram(cardProg);
    if (buf.vao) gl.bindVertexArray(buf.vao);
    if (!buf.vao) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.pos);
      gl.vertexAttribPointer(cardAttribs.pos, 3, gl.FLOAT, false, 0, 0);
      if (buf.nrm) { gl.bindBuffer(gl.ARRAY_BUFFER, buf.nrm); gl.vertexAttribPointer(cardAttribs.nrm, 3, gl.FLOAT, false, 0, 0); }
      if (buf.uv) { gl.bindBuffer(gl.ARRAY_BUFFER, buf.uv); gl.vertexAttribPointer(cardAttribs.uv, 2, gl.FLOAT, false, 0, 0); }
      if (buf.edge) { gl.bindBuffer(gl.ARRAY_BUFFER, buf.edge); gl.vertexAttribPointer(cardAttribs.edge, 1, gl.FLOAT, false, 0, 0); }
    }
    gl.uniformMatrix4fv(cardUniforms.pv, false, pv);
    gl.uniformMatrix4fv(cardUniforms.model, false, model);
    gl.uniform1i(cardUniforms.video, 0);
    gl.uniform1i(cardUniforms.content, 1);
    gl.uniform3f(cardUniforms.cam, 0, CAM_H, -push);
    gl.uniform1f(cardUniforms.hover, st.hover);
    gl.uniform2f(cardUniforms.spotlight, st.spotX, st.spotY);
    gl.uniform1f(cardUniforms.time, time);
    gl.uniform3f(cardUniforms.fog, 0.78, 0.82, 0.87);
    gl.uniform1f(cardUniforms.fogNear, st.fogNear);
    gl.uniform1f(cardUniforms.fogFar, st.fogFar);
    gl.uniform2f(cardUniforms.viewport, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, contentTexs[cardStates.indexOf(st)] || contentTexs[0]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.idx);
    gl.drawElements(gl.TRIANGLES, buf.count, gl.UNSIGNED_SHORT, 0);
    if (buf.vao) gl.bindVertexArray(null);
  }

  function drawShadow(st, pv) {
    if (st.hover > 0.25) return;
    const fade = 1 - Math.min(1, st.hover * 2.2);
    const sx = st.w * 1.7;
    const sz = st.w * 0.5;
    const model = M4.multiply(
      M4.translate(st.x + st.w * 0.3, 0.02, st.z - st.w * 0.16),
      M4.multiply(M4.rotY(0.26), scale3(sx, 1, sz))
    );
    gl.useProgram(shadowProg);
    if (shadowBufs.vao) gl.bindVertexArray(shadowBufs.vao);
    if (!shadowBufs.vao) {
      gl.bindBuffer(gl.ARRAY_BUFFER, shadowBufs.pos);
      gl.vertexAttribPointer(shadowAttribs.pos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, shadowBufs.uv);
      gl.vertexAttribPointer(shadowAttribs.uv, 2, gl.FLOAT, false, 0, 0);
    }
    gl.uniformMatrix4fv(shadowUniforms.pv, false, pv);
    gl.uniformMatrix4fv(shadowUniforms.model, false, model);
    gl.uniform1f(shadowUniforms.opacity, st.shadowOpacity * fade);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, shadowBufs.idx);
    gl.drawElements(gl.TRIANGLES, shadowBufs.count, gl.UNSIGNED_SHORT, 0);
    if (shadowBufs.vao) gl.bindVertexArray(null);
  }

  function scale3(sx, sy, sz) {
    return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
  }

  function cardModel(st) {
    const hov = st.hover;
    const ease = hov * hov * (3 - 2 * hov);
    const lift = ease * 0.42;
    const scale = 1 + ease * 0.05;
    const driftY = (pointer.y - 0.5) * 0.035 * (1 + (1 - st.hover) * 0.4);
    const driftX = (pointer.x - 0.5) * 0.06 * (1 + (1 - st.hover) * 0.4);
    // 直立卡片：垂直于地面，绕底边垂直轴摆放不同角度；hover 时摆正朝向相机并轻浮
    let out = M4.translate(st.x + driftX, st.h / 2 + GLASS_T / 2 + lift, st.z + driftY);
    out = M4.multiply(out, M4.rotY(st.slotY * (1 - ease) + ease * (-st.slotY)));
    out = M4.multiply(out, scale3(scale, scale, scale));
    return out;
  }

  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    if (document.hidden) return;
    // 滚动推进真实相机；近卡的尺寸和位移因此天然变化得更快。
    const progress = Number(scene.style.getPropertyValue("--scene-progress")) || 0;
    const push = progress * PUSH_MAX;
    bindVideoTex();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.depthMask(false);
    const aspect = W / H;
    const proj = M4.perspective(FOV_Y, aspect, 0.1, 4000);
    const view = viewMatrix(push);
    const pv = M4.multiply(proj, view);

    // 接触阴影 + 卡片（远 → 近）
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
    const drawOrder = [...cardStates.keys()].sort((a, b) => cardStates[a].z - cardStates[b].z);
    drawOrder.forEach((i) => {
      const st = cardStates[i];
      st.hover = hoverEase(st.hover, i === hoverIndex ? 1 : 0, dt);
      st.spotX = hoverEase(st.spotX, st.spotTargetX, dt * 1.35);
      st.spotY = hoverEase(st.spotY, st.spotTargetY, dt * 1.35);
      st.hovered = st.hover > 0.5;
    });
    // 背面剔除：去掉透明玻璃背面叠影与内部结构线
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    drawOrder.forEach((i) => {
      drawCard(cardStates[i], cardBuffers[i], cardModel(cardStates[i]), now / 1000, push, pv);
    });
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    const anyHover = cardStates.some((s) => s.hovered);
    scene.classList.toggle("is-hovering", anyHover);
    canvas.style.cursor = anyHover ? "pointer" : "default";
    frameCount += 1;
    if (frameCount === 10) probeRender(push);
  }

  // ---------- 拾取 ----------
  function rayFromPointer(px, py) {
    const aspect = W / H;
    const tanY = Math.tan(FOV_Y / 2);
    const ndcX = (px / W) * 2 - 1;
    const ndcY = 1 - (py / H) * 2;
    const progress = Number(scene.style.getPropertyValue("--scene-progress")) || 0;
    const push = progress * PUSH_MAX;
    const view = viewMatrix(push);
    const invView = invertLookAt(view);
    const dirCam = [ndcX * tanY * aspect, ndcY * tanY, -1];
    const dir = transformDir(invView, dirCam);
    const origin = [0, CAM_H, -push];
    return { origin, dir };
  }
  function invertLookAt(m) {
    const r = [m[0], m[1], m[2]], u = [m[4], m[5], m[6]], f = [m[8], m[9], m[10]];
    const t = [m[12], m[13], m[14]];
    const tx = -dot3(r, t), ty = -dot3(u, t), tz = -dot3(f, t);
    return new Float32Array([
      r[0], u[0], f[0], 0,
      r[1], u[1], f[1], 0,
      r[2], u[2], f[2], 0,
      tx, ty, tz, 1,
    ]);
  }
  function transformDir(m, v) {
    return [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
    ];
  }
  function pickCardHit(px, py) {
    const { origin, dir } = rayFromPointer(px, py);
    let best = null, bestT = Infinity;
    cardStates.forEach((st, i) => {
      const hit = intersectCard(origin, dir, st);
      if (hit && hit.t < bestT) { bestT = hit.t; best = { index: i, uv: hit.uv }; }
    });
    return best;
  }
  function pickCard(px, py) { return pickCardHit(px, py)?.index ?? -1; }
  function intersectCard(origin, dir, st) {
    // 把射线变换进卡片局部系（卡片绕底边垂直轴旋转 slotY），命中区与显示完全一致，
    // 避免小卡片边缘 hover 闪烁
    const cy = st.h / 2 + GLASS_T / 2 + st.hover * 0.42;
    const cosY = Math.cos(st.slotY), sinY = Math.sin(st.slotY);
    const ox = origin[0] - st.x, oy = origin[1] - cy, oz = origin[2] - st.z;
    const lox = ox * cosY + oz * sinY;
    const loz = -ox * sinY + oz * cosY;
    const ldx = dir[0] * cosY + dir[2] * sinY;
    const ldz = -dir[0] * sinY + dir[2] * cosY;
    if (Math.abs(ldz) < 1e-6) return null;
    const t = -loz / ldz;
    if (t < 0) return null;
    const lpx = lox + ldx * t;
    const lpy = oy + dir[1] * t;
    const pad = 0.06;
    if (Math.abs(lpx) > st.w / 2 + pad) return null;
    if (Math.abs(lpy) > st.h / 2 + pad) return null;
    return { t, uv: [lpx / st.w + 0.5, 0.5 - lpy / st.h] };
  }

  // ---------- 事件 ----------
  const onPointerMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (e.clientX - rect.left) / rect.width;
    pointer.y = (e.clientY - rect.top) / rect.height;
    const hit = pickCardHit(e.clientX - rect.left, e.clientY - rect.top);
    hoverIndex = hit?.index ?? -1;
    if (hit) {
      const st = cardStates[hit.index];
      st.spotTargetX = Math.max(0, Math.min(1, hit.uv[0]));
      st.spotTargetY = Math.max(0, Math.min(1, hit.uv[1]));
    }
  };
  const onPointerLeave = () => {
    hoverIndex = -1;
    pointer.x = 0.5;
    pointer.y = 0.5;
    cardStates.forEach((st) => { st.spotTargetX = 0.5; st.spotTargetY = 0.5; });
  };
  let downAt = null;
  const onPointerDown = (e) => { downAt = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6;
    downAt = null;
    if (moved) return;
    const rect = canvas.getBoundingClientRect();
    const i = hoverIndex >= 0 ? hoverIndex : pickCard(e.clientX - rect.left, e.clientY - rect.top);
    if (i >= 0) {
      const c = cards[i];
      onOpen?.(c);
    }
  };
  const onResize = () => {
    layout();
    buildCardBuffers();
  };
  const onKey = (e) => {
    if (e.key === "Enter" && hoverIndex >= 0) {
      e.preventDefault();
      onOpen?.(cards[hoverIndex]);
    }
  };
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  window.addEventListener("resize", onResize);
  canvas.addEventListener("keydown", onKey);

  // 内容纹理（等字体就绪后再画一次更清晰）
  cards.forEach((c, i) => { contentTexs[i] = makeContentTexture(c); });
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (disposed) return;
      cards.forEach((c, i) => {
        const t = makeContentTexture(c);
        gl.deleteTexture(contentTexs[i]);
        contentTexs[i] = t;
      });
    });
  }

  layout();
  buildCardBuffers();
  raf = requestAnimationFrame(frame);

  return {
    dispose: disposeModule,
  };
}
