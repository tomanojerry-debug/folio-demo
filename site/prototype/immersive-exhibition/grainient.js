// Grainient（React Bits）的原生 WebGL2 移植 —— 零依赖，作为 Inbox 场景图下方的动态颗粒渐变背景。
const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uTimeSpeed;
uniform float uColorBalance;
uniform float uWarpStrength;
uniform float uWarpFrequency;
uniform float uWarpSpeed;
uniform float uWarpAmplitude;
uniform float uBlendAngle;
uniform float uBlendSoftness;
uniform float uRotationAmount;
uniform float uNoiseScale;
uniform float uGrainAmount;
uniform float uGrainScale;
uniform float uGrainAnimated;
uniform float uContrast;
uniform float uGamma;
uniform float uSaturation;
uniform vec2 uCenterOffset;
uniform float uZoom;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
out vec4 fragColor;
#define S(a,b,t) smoothstep(a,b,t)
mat2 Rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
vec2 hash(vec2 p){p=vec2(dot(p,vec2(2127.1,81.17)),dot(p,vec2(1269.5,283.37)));return fract(sin(p)*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);float n=mix(mix(dot(-1.0+2.0*hash(i+vec2(0.0,0.0)),f-vec2(0.0,0.0)),dot(-1.0+2.0*hash(i+vec2(1.0,0.0)),f-vec2(1.0,0.0)),u.x),mix(dot(-1.0+2.0*hash(i+vec2(0.0,1.0)),f-vec2(0.0,1.0)),dot(-1.0+2.0*hash(i+vec2(1.0,1.0)),f-vec2(1.0,1.0)),u.x),u.y);return 0.5+0.5*n;}
void mainImage(out vec4 o, vec2 C){
  float t=iTime*uTimeSpeed;
  vec2 uv=C/iResolution.xy;
  float ratio=iResolution.x/iResolution.y;
  vec2 tuv=uv-0.5+uCenterOffset;
  tuv/=max(uZoom,0.001);

  float degree=noise(vec2(t*0.1,tuv.x*tuv.y)*uNoiseScale);
  tuv.y*=1.0/ratio;
  tuv*=Rot(radians((degree-0.5)*uRotationAmount+180.0));
  tuv.y*=ratio;

  float frequency=uWarpFrequency;
  float ws=max(uWarpStrength,0.001);
  float amplitude=uWarpAmplitude/ws;
  float warpTime=t*uWarpSpeed;
  tuv.x+=sin(tuv.y*frequency+warpTime)/amplitude;
  tuv.y+=sin(tuv.x*(frequency*1.5)+warpTime)/(amplitude*0.5);

  vec3 colLav=uColor1;
  vec3 colOrg=uColor2;
  vec3 colDark=uColor3;
  float b=uColorBalance;
  float s=max(uBlendSoftness,0.0);
  mat2 blendRot=Rot(radians(uBlendAngle));
  float blendX=(tuv*blendRot).x;
  float edge0=-0.3-b-s;
  float edge1=0.2-b+s;
  float v0=0.5-b+s;
  float v1=-0.3-b-s;
  vec3 layer1=mix(colDark,colOrg,S(edge0,edge1,blendX));
  vec3 layer2=mix(colOrg,colLav,S(edge0,edge1,blendX));
  vec3 col=mix(layer1,layer2,S(v0,v1,tuv.y));

  vec2 grainUv=uv*max(uGrainScale,0.001);
  if(uGrainAnimated>0.5){grainUv+=vec2(iTime*0.05);}
  float grain=fract(sin(dot(grainUv,vec2(12.9898,78.233)))*43758.5453);
  col+=(grain-0.5)*uGrainAmount;

  col=(col-0.5)*uContrast+0.5;
  float luma=dot(col,vec3(0.2126,0.7152,0.0722));
  col=mix(vec3(luma),col,uSaturation);
  col=pow(max(col,0.0),vec3(1.0/max(uGamma,0.001)));
  col=clamp(col,0.0,1.0);

  o=vec4(col,1.0);
}
void main(){
  vec4 o=vec4(0.0);
  mainImage(o,gl_FragCoord.xy);
  fragColor=o;
}`;

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1];
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

export function mountGrainient(container, options = {}) {
  const {
    color1 = "#8FC4DE",
    color2 = "#C25B48",
    color3 = "#202C3E",
    timeSpeed = 0.22,
    colorBalance = 0,
    warpStrength = 1.2,
    warpFrequency = 4,
    warpSpeed = 1.5,
    warpAmplitude = 60,
    blendAngle = 0,
    blendSoftness = 0.06,
    rotationAmount = 320,
    noiseScale = 2.2,
    grainAmount = 0.08,
    grainScale = 2.5,
    grainAnimated = true,
    contrast = 1.35,
    gamma = 1.05,
    saturation = 0.85,
    centerX = 0,
    centerY = 0,
    zoom = 0.85,
    opacity = 0.55,
  } = options;

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%";
  container.appendChild(canvas);
  container.style.opacity = String(opacity);

  const gl = canvas.getContext("webgl2", { alpha: true, antialias: false });
  if (!gl) return () => canvas.remove();

  gl.clearColor(0, 0, 0, 0);

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const positionLoc = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name) => gl.getUniformLocation(program, name);
  const u = {};
  for (const name of [
    "iTime", "iResolution", "uTimeSpeed", "uColorBalance", "uWarpStrength", "uWarpFrequency",
    "uWarpSpeed", "uWarpAmplitude", "uBlendAngle", "uBlendSoftness", "uRotationAmount",
    "uNoiseScale", "uGrainAmount", "uGrainScale", "uGrainAnimated", "uContrast", "uGamma",
    "uSaturation", "uCenterOffset", "uZoom", "uColor1", "uColor2", "uColor3",
  ]) u[name] = uniform(name);

  gl.uniform1f(u.uTimeSpeed, timeSpeed);
  gl.uniform1f(u.uColorBalance, colorBalance);
  gl.uniform1f(u.uWarpStrength, warpStrength);
  gl.uniform1f(u.uWarpFrequency, warpFrequency);
  gl.uniform1f(u.uWarpSpeed, warpSpeed);
  gl.uniform1f(u.uWarpAmplitude, warpAmplitude);
  gl.uniform1f(u.uBlendAngle, blendAngle);
  gl.uniform1f(u.uBlendSoftness, blendSoftness);
  gl.uniform1f(u.uRotationAmount, rotationAmount);
  gl.uniform1f(u.uNoiseScale, noiseScale);
  gl.uniform1f(u.uGrainAmount, grainAmount);
  gl.uniform1f(u.uGrainScale, grainScale);
  gl.uniform1f(u.uGrainAnimated, grainAnimated ? 1 : 0);
  gl.uniform1f(u.uContrast, contrast);
  gl.uniform1f(u.uGamma, gamma);
  gl.uniform1f(u.uSaturation, saturation);
  gl.uniform2f(u.uCenterOffset, centerX, centerY);
  gl.uniform1f(u.uZoom, zoom);
  gl.uniform3fv(u.uColor1, hexToRgb(color1));
  gl.uniform3fv(u.uColor2, hexToRgb(color2));
  gl.uniform3fv(u.uColor3, hexToRgb(color3));

  const updatePlacement = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const wCSS = Math.max(1, container.clientWidth);
    const hCSS = Math.max(1, container.clientHeight);
    const w = wCSS * dpr;
    const h = hCSS * dpr;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(u.iResolution, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  updatePlacement();

  const ro = new ResizeObserver(updatePlacement);
  ro.observe(container);

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0;
  let last = performance.now();
  let time = 0;

  const frame = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    time += dt;
    gl.uniform1f(u.iTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reduced) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    canvas.remove();
  };
}
