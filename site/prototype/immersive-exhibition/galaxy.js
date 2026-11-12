// Galaxy 星云背景：React Bits <Galaxy /> 效果的 vanilla WebGL 实现（无 ogl 依赖）。
// 全屏三角形 + 同一个 fragment shader；透明背景叠加在场景深蓝渐变上。

const VERTEX_SHADER = `
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform vec2 uFocal;
uniform vec2 uRotation;
uniform float uStarSpeed;
uniform float uDensity;
uniform float uHueShift;
uniform float uSpeed;
uniform vec2 uMouse;
uniform float uGlowIntensity;
uniform float uSaturation;
uniform bool uMouseRepulsion;
uniform float uTwinkleIntensity;
uniform float uRotationSpeed;
uniform float uRepulsionStrength;
uniform float uMouseActiveFactor;
uniform float uAutoCenterRepulsion;
uniform bool uTransparent;

varying vec2 vUv;

#define NUM_LAYER 4.0
#define STAR_COLOR_CUTOFF 0.2
#define MAT45 mat2(0.7071, -0.7071, 0.7071, 0.7071)
#define PERIOD 3.0

float Hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float tri(float x) {
  return abs(fract(x) * 2.0 - 1.0);
}

float tris(float x) {
  float t = fract(x);
  return 1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0));
}

float trisn(float x) {
  float t = fract(x);
  return 2.0 * (1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0))) - 1.0;
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float Star(vec2 uv, float flare) {
  float d = length(uv);
  float m = (0.05 * uGlowIntensity) / d;
  float rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * flare * uGlowIntensity;
  uv *= MAT45;
  rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * 0.3 * flare * uGlowIntensity;
  m *= smoothstep(1.0, 0.2, d);
  return m;
}

vec3 StarLayer(vec2 uv) {
  vec3 col = vec3(0.0);

  vec2 gv = fract(uv) - 0.5;
  vec2 id = floor(uv);

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 si = id + vec2(float(x), float(y));
      float seed = Hash21(si);
      float size = fract(seed * 345.32);
      float glossLocal = tri(uStarSpeed / (PERIOD * seed + 1.0));
      float flareSize = smoothstep(0.9, 1.0, size) * glossLocal;

      float red = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 1.0)) + STAR_COLOR_CUTOFF;
      float blu = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 3.0)) + STAR_COLOR_CUTOFF;
      float grn = min(red, blu) * seed;
      vec3 base = vec3(red, grn, blu);

      float hue = atan(base.g - base.r, base.b - base.r) / (2.0 * 3.14159) + 0.5;
      hue = fract(hue + uHueShift / 360.0);
      float sat = length(base - vec3(dot(base, vec3(0.299, 0.587, 0.114)))) * uSaturation;
      float val = max(max(base.r, base.g), base.b);
      base = hsv2rgb(vec3(hue, sat, val));

      vec2 pad = vec2(tris(seed * 34.0 + uTime * uSpeed / 10.0), tris(seed * 38.0 + uTime * uSpeed / 30.0)) - 0.5;

      float star = Star(gv - offset - pad, flareSize);
      vec3 color = base;

      float twinkle = trisn(uTime * uSpeed + seed * 6.2831) * 0.5 + 1.0;
      twinkle = mix(1.0, twinkle, uTwinkleIntensity);
      star *= twinkle;

      col += star * size * color;
    }
  }

  return col;
}

void main() {
  vec2 focalPx = uFocal * uResolution.xy;
  vec2 uv = (vUv * uResolution.xy - focalPx) / uResolution.y;

  vec2 mouseNorm = uMouse - vec2(0.5);

  if (uAutoCenterRepulsion > 0.0) {
    vec2 centerUV = vec2(0.0, 0.0);
    float centerDist = length(uv - centerUV);
    vec2 repulsion = normalize(uv - centerUV) * (uAutoCenterRepulsion / (centerDist + 0.1));
    uv += repulsion * 0.05;
  } else if (uMouseRepulsion) {
    vec2 mousePosUV = (uMouse * uResolution.xy - focalPx) / uResolution.y;
    float mouseDist = length(uv - mousePosUV);
    vec2 repulsion = normalize(uv - mousePosUV) * (uRepulsionStrength / (mouseDist + 0.1));
    uv += repulsion * 0.05 * uMouseActiveFactor;
  } else {
    vec2 mouseOffset = mouseNorm * 0.1 * uMouseActiveFactor;
    uv += mouseOffset;
  }

  float autoRotAngle = uTime * uRotationSpeed;
  mat2 autoRot = mat2(cos(autoRotAngle), -sin(autoRotAngle), sin(autoRotAngle), cos(autoRotAngle));
  uv = autoRot * uv;

  uv = mat2(uRotation.x, -uRotation.y, uRotation.y, uRotation.x) * uv;

  vec3 col = vec3(0.0);

  for (float i = 0.0; i < 1.0; i += 1.0 / NUM_LAYER) {
    float depth = fract(i + uStarSpeed * uSpeed);
    float scale = mix(20.0 * uDensity, 0.5 * uDensity, depth);
    float fade = depth * smoothstep(1.0, 0.9, depth);
    col += StarLayer(uv * scale + i * 453.32) * fade;
  }

  if (uTransparent) {
    float alpha = length(col);
    alpha = smoothstep(0.0, 0.3, alpha);
    alpha = min(alpha, 1.0);
    gl_FragColor = vec4(col, alpha);
  } else {
    gl_FragColor = vec4(col, 1.0);
  }
}
`;

const DEFAULTS = {
  focal: [0.5, 0.5],
  rotation: [1.0, 0.0],
  starSpeed: 0.5,
  density: 1,
  hueShift: 140,
  disableAnimation: false,
  speed: 1.0,
  mouseInteraction: true,
  glowIntensity: 0.3,
  saturation: 0.0,
  mouseRepulsion: true,
  twinkleIntensity: 0.3,
  rotationSpeed: 0.1,
  repulsionStrength: 2,
  autoCenterRepulsion: 0,
  transparent: true,
};

export function mountGalaxy(container, options = {}) {
  if (!container) return () => {};
  const opts = { ...DEFAULTS, ...options };
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  container.appendChild(canvas);

  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false })
    || canvas.getContext("experimental-webgl", { alpha: true, premultipliedAlpha: false });
  if (!gl) { canvas.remove(); return () => {}; }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  function compile(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn("Galaxy shader error:", gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("Galaxy link error:", gl.getProgramInfoLog(program));
    canvas.remove();
    return () => {};
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const positionLoc = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

  const loc = (name) => gl.getUniformLocation(program, name);
  const uniforms = {
    uTime: loc("uTime"),
    uResolution: loc("uResolution"),
    uFocal: loc("uFocal"),
    uRotation: loc("uRotation"),
    uStarSpeed: loc("uStarSpeed"),
    uDensity: loc("uDensity"),
    uHueShift: loc("uHueShift"),
    uSpeed: loc("uSpeed"),
    uMouse: loc("uMouse"),
    uGlowIntensity: loc("uGlowIntensity"),
    uSaturation: loc("uSaturation"),
    uMouseRepulsion: loc("uMouseRepulsion"),
    uTwinkleIntensity: loc("uTwinkleIntensity"),
    uRotationSpeed: loc("uRotationSpeed"),
    uRepulsionStrength: loc("uRepulsionStrength"),
    uMouseActiveFactor: loc("uMouseActiveFactor"),
    uAutoCenterRepulsion: loc("uAutoCenterRepulsion"),
    uTransparent: loc("uTransparent"),
  };

  gl.uniform2f(uniforms.uFocal, opts.focal[0], opts.focal[1]);
  gl.uniform2f(uniforms.uRotation, opts.rotation[0], opts.rotation[1]);
  gl.uniform1f(uniforms.uDensity, opts.density);
  gl.uniform1f(uniforms.uHueShift, opts.hueShift);
  gl.uniform1f(uniforms.uSpeed, opts.speed);
  gl.uniform1f(uniforms.uGlowIntensity, opts.glowIntensity);
  gl.uniform1f(uniforms.uSaturation, opts.saturation);
  gl.uniform1i(uniforms.uMouseRepulsion, opts.mouseRepulsion ? 1 : 0);
  gl.uniform1f(uniforms.uTwinkleIntensity, opts.twinkleIntensity);
  gl.uniform1f(uniforms.uRotationSpeed, opts.rotationSpeed);
  gl.uniform1f(uniforms.uRepulsionStrength, opts.repulsionStrength);
  gl.uniform1f(uniforms.uAutoCenterRepulsion, opts.autoCenterRepulsion);
  gl.uniform1i(uniforms.uTransparent, opts.transparent ? 1 : 0);
  gl.uniform1f(uniforms.uMouseActiveFactor, 0);
  gl.uniform1f(uniforms.uStarSpeed, 0);
  gl.uniform1f(uniforms.uTime, 0);

  const targetMouse = { x: 0.5, y: 0.5 };
  const smoothMouse = { x: 0.5, y: 0.5 };
  let targetActive = 0;
  let smoothActive = 0;

  function resize() {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform3f(uniforms.uResolution, canvas.width, canvas.height, canvas.width / canvas.height);
  }
  resize();
  window.addEventListener("resize", resize);

  const onMouseMove = (event) => {
    const rect = container.getBoundingClientRect();
    targetMouse.x = (event.clientX - rect.left) / (rect.width || 1);
    targetMouse.y = 1.0 - (event.clientY - rect.top) / (rect.height || 1);
    targetActive = 1.0;
  };
  const onMouseLeave = () => { targetActive = 0; };
  if (opts.mouseInteraction) {
    container.addEventListener("mousemove", onMouseMove);
    container.addEventListener("mouseleave", onMouseLeave);
  }

  const startedAt = performance.now();
  let raf = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const t = (now - startedAt) / 1000;
    if (!opts.disableAnimation) {
      gl.uniform1f(uniforms.uTime, t);
      gl.uniform1f(uniforms.uStarSpeed, (t * opts.starSpeed) / 10.0);
    }
    const lerp = 0.05;
    smoothMouse.x += (targetMouse.x - smoothMouse.x) * lerp;
    smoothMouse.y += (targetMouse.y - smoothMouse.y) * lerp;
    smoothActive += (targetActive - smoothActive) * lerp;
    gl.uniform2f(uniforms.uMouse, smoothMouse.x, smoothMouse.y);
    gl.uniform1f(uniforms.uMouseActiveFactor, smoothActive);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    if (opts.mouseInteraction) {
      container.removeEventListener("mousemove", onMouseMove);
      container.removeEventListener("mouseleave", onMouseLeave);
    }
    canvas.remove();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
