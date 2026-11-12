// ElectricBorder（React Bits）的纯 JS 移植：canvas 噪声扰动描边 + 辉光。
// 参数来自参数截图：color #ffffff / speed 1.4 / chaos 0.02 / borderRadius 0 / thickness 2。
export function createElectricBorder({
  color = "#ffffff",
  speed = 1.4,
  chaos = 0.02,
  radius = 0,
  thickness = 2,
} = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "eb-canvas";
  const ctx = canvas.getContext("2d");
  const offset = 60; // 外扩量：让“电流”可以溢出卡片边缘

  let raf = 0;
  let running = false;
  let time = 0;
  let last = 0;
  let rect = { left: 0, top: 0, width: 186, height: 248 };

  // —— 噪声（与原组件一致）——
  const random = (x) => (Math.sin(x * 12.9898) * 43758.5453) % 1;
  function noise2D(x, y) {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const a = random(i + j * 57);
    const b = random(i + 1 + j * 57);
    const c = random(i + (j + 1) * 57);
    const d = random(i + 1 + (j + 1) * 57);
    const ux = fx * fx * (3.0 - 2.0 * fx);
    const uy = fy * fy * (3.0 - 2.0 * fy);
    return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
  }
  function octavedNoise(x, octaves, lacunarity, gain, baseAmplitude, baseFrequency, t, seed, baseFlatness) {
    let y = 0;
    let amplitude = baseAmplitude;
    let frequency = baseFrequency;
    for (let i = 0; i < octaves; i++) {
      let octaveAmplitude = amplitude;
      if (i === 0) octaveAmplitude *= baseFlatness;
      y += octaveAmplitude * noise2D(frequency * x + seed * 100, t * frequency * 0.3);
      frequency *= lacunarity;
      amplitude *= gain;
    }
    return y;
  }
  function getCornerPoint(centerX, centerY, radius2, startAngle, arcLength, progress) {
    const angle = startAngle + progress * arcLength;
    return { x: centerX + radius2 * Math.cos(angle), y: centerY + radius2 * Math.sin(angle) };
  }
  function getRoundedRectPoint(t, left, top, width, height, r) {
    const straightWidth = width - 2 * r;
    const straightHeight = height - 2 * r;
    const cornerArc = (Math.PI * r) / 2;
    const totalPerimeter = 2 * straightWidth + 2 * straightHeight + 4 * cornerArc;
    const distance = t * totalPerimeter;
    let accumulated = 0;
    if (distance <= accumulated + straightWidth) {
      const progress = (distance - accumulated) / straightWidth;
      return { x: left + r + progress * straightWidth, y: top };
    }
    accumulated += straightWidth;
    if (distance <= accumulated + cornerArc) {
      const progress = (distance - accumulated) / cornerArc;
      return getCornerPoint(left + width - r, top + r, r, -Math.PI / 2, Math.PI / 2, progress);
    }
    accumulated += cornerArc;
    if (distance <= accumulated + straightHeight) {
      const progress = (distance - accumulated) / straightHeight;
      return { x: left + width, y: top + r + progress * straightHeight };
    }
    accumulated += straightHeight;
    if (distance <= accumulated + cornerArc) {
      const progress = (distance - accumulated) / cornerArc;
      return getCornerPoint(left + width - r, top + height - r, r, 0, Math.PI / 2, progress);
    }
    accumulated += cornerArc;
    if (distance <= accumulated + straightWidth) {
      const progress = (distance - accumulated) / straightWidth;
      return { x: left + width - r - progress * straightWidth, y: top + height };
    }
    accumulated += straightWidth;
    if (distance <= accumulated + cornerArc) {
      const progress = (distance - accumulated) / cornerArc;
      return getCornerPoint(left + r, top + height - r, r, Math.PI / 2, Math.PI / 2, progress);
    }
    accumulated += cornerArc;
    if (distance <= accumulated + straightHeight) {
      const progress = (distance - accumulated) / straightHeight;
      return { x: left, y: top + height - r - progress * straightHeight };
    }
    accumulated += straightHeight;
    const progress = (distance - accumulated) / cornerArc;
    return getCornerPoint(left + r, top + r, r, Math.PI, Math.PI / 2, progress);
  }

  const octaves = 10;
  const lacunarity = 1.6;
  const gain = 0.7;
  const amplitude = chaos;
  const frequency = 10;
  const baseFlatness = 0;
  const displacement = 60;

  function applySize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = rect.width + offset * 2;
    const h = rect.height + offset * 2;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
  }

  function frame(now) {
    if (!running) return;
    const deltaTime = (now - last) / 1000;
    last = now;
    time += deltaTime * speed;

    applySize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const left = offset;
    const top = offset;
    const borderWidth = rect.width;
    const borderHeight = rect.height;
    const maxRadius = Math.min(borderWidth, borderHeight) / 2;
    const r = Math.min(radius, maxRadius);
    const approximatePerimeter = 2 * (borderWidth + borderHeight) + 2 * Math.PI * r;
    const sampleCount = Math.floor(approximatePerimeter / 2);

    ctx.beginPath();
    for (let i = 0; i <= sampleCount; i++) {
      const progress = i / sampleCount;
      const point = getRoundedRectPoint(progress, left, top, borderWidth, borderHeight, r);
      const xNoise = octavedNoise(progress * 8, octaves, lacunarity, gain, amplitude, frequency, time, 0, baseFlatness);
      const yNoise = octavedNoise(progress * 8, octaves, lacunarity, gain, amplitude, frequency, time, 1, baseFlatness);
      const displacedX = point.x + xNoise * displacement;
      const displacedY = point.y + yNoise * displacement;
      if (i === 0) ctx.moveTo(displacedX, displacedY);
      else ctx.lineTo(displacedX, displacedY);
    }
    ctx.closePath();
    ctx.stroke();

    raf = requestAnimationFrame(frame);
  }

  return {
    canvas,
    setRect(next) {
      const sizeChanged = Math.abs(rect.width - next.width) > 0.5 || Math.abs(rect.height - next.height) > 0.5;
      rect = next;
      canvas.style.left = `${Math.round(next.left - offset)}px`;
      canvas.style.top = `${Math.round(next.top - offset)}px`;
      if (sizeChanged) applySize();
    },
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      applySize();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
