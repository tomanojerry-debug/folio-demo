// Noomo Showcase 式 WebGL 3D 空间：项目玻璃卡沿 Z 轴排布，滚轮驱动相机穿行，
// 带透视投影、雾景深与近景淡出。相机只随滚轮移动，鼠标不参与。纯原生 WebGL，无依赖。

const ROCK_SPACING = 520;
const CAMERA_DIST = 300;
const FOV = 55;
const CARD_W = 150;
const CARD_H = 112.5;
const CARD_T = 3;
const CARD_R = 5;
// 当前卡到达时的放大倍率：接近过程平滑放大，离开时收回
const FOCUS_SCALE = 1.32;
// 卡片正面是一张「多藏品玻璃拼贴」（横版 4:3）：半透明淡紫玻璃底 + 1 张展览封面大图 +
// 最多 3 张关联藏品小图（圆角、白色描边、柔和紫影），紫色渐变标签与外缘白描边高光
const FACE_W = 683;
const FACE_H = 512;

// 玻璃球三色（参考图 2）：粉紫 Luminous / 冰蓝 Moon Pond / 奶白粉 Plumeria。
// 按 candidate.id 稳定分配，每张卡取一色，保持低对比高明度的"水珠玻璃"气质。
function ballPalette(id) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const PALETTES = [
    { tint: [232, 196, 218], glow: "rgba(236,184,208,.34)", edge: "rgba(198,166,214,.6)", dark: "rgba(120,84,138,.22)" },
    { tint: [194, 220, 240], glow: "rgba(182,212,238,.34)", edge: "rgba(166,190,222,.6)", dark: "rgba(78,108,148,.20)" },
    { tint: [250, 244, 246], glow: "rgba(248,214,224,.30)", edge: "rgba(226,210,220,.55)", dark: "rgba(148,118,132,.16)" },
  ];
  return PALETTES[h % PALETTES.length];
}

// FORME 3D 大字标题：漫游起点。标题位于世界 z=+ROCK_SPACING（卡片走廊最前方），
// 初始镜头（p=-1）正对标题，滚动推近穿过它后进入卡片走廊；卡片保持原位置不动，
// 穿过标题后镜头与卡片的相对关系与原版完全一致。
const TITLE_Z = ROCK_SPACING;
const TITLE_DIST = CAMERA_DIST + ROCK_SPACING - TITLE_Z; // p=-1 时相机到标题距离 = CAMERA_DIST
const TITLE_RATIO_H = 0.54;                       // 标题高度 ≈ 可视高度的 54%，占满中央
const TITLE_THICKNESS = 4;
const TITLE_CANVAS_W = 1024;
const TITLE_CANVAS_H = 400;

function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function multiply(a, b) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return o;
}
function translation(x, y, z) {
  return new Float32Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);
}
function rotationX(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}
function rotationY(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
function rotationZ(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function scale3(sx, sy, sz) {
  return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
}
function transpose(m) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r * 4 + c];
  return o;
}
function transformPoint(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3] * v[3],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7] * v[3],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11] * v[3],
    m[12] * v[0] + m[13] * v[1] + m[14] * v[2] + m[15] * v[3],
  ];
}
function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan((fovY * Math.PI) / 360);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, 2 * far * near * nf,
    0, 0, -1, 0,
  ]);
}


// 圆角玻璃卡：正面贴封面、背面磨砂模糊封面（镜像）、四条圆角侧边用玻璃色。
// 圆角矩形轮廓逆时针采样，正/背面三角扇，侧边沿轮廓挤出。
function buildGlassCardGeometry(width = CARD_W, height = CARD_H, thickness = CARD_T, radius = CARD_R, cornerSegments = 10) {
  const r = Math.max(0.5, Math.min(radius, width / 2 - 1, height / 2 - 1));
  const hw = width / 2 - r;
  const hh = height / 2 - r;
  const pts = [];
  const arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= cornerSegments; i++) {
      const a = a0 + (a1 - a0) * (i / cornerSegments);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  // 逆时针轮廓：右下 → 右上 → 左上 → 左下（y 向上）
  arc(hw, -hh, -Math.PI / 2, 0);
  arc(hw, hh, 0, Math.PI / 2);
  arc(-hw, hh, Math.PI / 2, Math.PI);
  arc(-hw, -hh, Math.PI, Math.PI * 1.5);
  const count = pts.length - 1; // 闭合轮廓，去掉重复终点
  const halfT = thickness / 2;

  const positions = [], normals = [], uvs = [], colors = [], texMix = [], texBack = [], indices = [];
  const push = (p, n, uv, color, tm, tb) => {
    positions.push(p[0], p[1], p[2]);
    normals.push(n[0], n[1], n[2]);
    uvs.push(uv[0], uv[1]);
    colors.push(color[0], color[1], color[2]);
    texMix.push(tm);
    texBack.push(tb);
  };
  const uvAt = (x, y, mirror) => [
    mirror ? 1 - (x + width / 2) / width : (x + width / 2) / width,
    1 - (y + height / 2) / height,
  ];

  // 正面：封面贴图（主纹理），法线 +Z
  const frontCenter = positions.length / 3;
  push([0, 0, halfT], [0, 0, 1], [0.5, 0.5], [0.9, 0.93, 0.98], 1, 0);
  for (let i = 0; i <= count; i++) {
    const p = pts[i % count];
    push([p[0], p[1], halfT], [0, 0, 1], uvAt(p[0], p[1], false), [0.9, 0.93, 0.98], 1, 0);
  }
  for (let i = 0; i < count; i++) {
    indices.push(frontCenter, frontCenter + 1 + i, frontCenter + 1 + ((i + 1) % count));
  }

  // 背面：磨砂封面（副纹理，UV 镜像），法线 -Z，绕序反向
  const backCenter = positions.length / 3;
  push([0, 0, -halfT], [0, 0, -1], [0.5, 0.5], [0.72, 0.7, 0.84], 1, 1);
  for (let i = 0; i <= count; i++) {
    const p = pts[i % count];
    push([p[0], p[1], -halfT], [0, 0, -1], uvAt(p[0], p[1], true), [0.72, 0.7, 0.84], 1, 1);
  }
  for (let i = 0; i < count; i++) {
    indices.push(backCenter, backCenter + 1 + ((i + 1) % count), backCenter + 1 + i);
  }

  // 侧边：沿轮廓挤出，逆时针外侧法线 = (dy, -dx)，上亮下暗；
  // 配色对齐收新弹窗玻璃渐变（淡蓝 → 橙红 → 深蓝）
  const sideTop = [0.56, 0.77, 0.87];    // rgba(143,196,222)
  const sideMid = [0.76, 0.36, 0.28];    // rgba(194,91,72)
  const sideBottom = [0.13, 0.17, 0.24]; // rgba(32,44,62)
  for (let i = 0; i < count; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % count];
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy) || 1;
    const n = [dy / len, -dx / len, 0];
    const t = Math.max(0, Math.min(1, (p0[1] + height / 2) / height)); // 0 底 → 1 顶
    const u = t < 0.46 ? t / 0.46 : (t - 0.46) / 0.54;
    const from = t < 0.46 ? sideBottom : sideMid;
    const to = t < 0.46 ? sideMid : sideTop;
    const color = [
      from[0] + (to[0] - from[0]) * u,
      from[1] + (to[1] - from[1]) * u,
      from[2] + (to[2] - from[2]) * u,
    ];
    const a = positions.length / 3;
    push([p0[0], p0[1], -halfT], n, [0, 0], color, 0, 0);
    push([p1[0], p1[1], -halfT], n, [0, 0], color, 0, 0);
    push([p1[0], p1[1], halfT], n, [0, 0], color, 0, 0);
    push([p0[0], p0[1], halfT], n, [0, 0], color, 0, 0);
    indices.push(a, a + 1, a + 2, a, a + 2, a + 3);
  }

  return {
    positions: new Float32Array(positions), normals: new Float32Array(normals),
    uvs: new Float32Array(uvs), colors: new Float32Array(colors),
    texMix: new Float32Array(texMix), texBack: new Float32Array(texBack),
    indices: new Uint16Array(indices),
  };
}

// FORME 标题用的双面透明薄板：正面/背面两个 quad，纹理全透明区域不渲染侧边，
// 使大字真正"浮"在空气里，而不是一块玻璃矩形。不写深度（渲染时 depthMask(false)）。
function buildTitlePlaneGeometry(width, height) {
  const hw = width / 2, hh = height / 2;
  const positions = [], normals = [], uvs = [], colors = [], texMix = [], texBack = [], indices = [];
  const push = (x, y, z, nx, ny, nz, u, v) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    colors.push(1, 1, 1);
    texMix.push(1);
    texBack.push(0);
  };
  // v：canvas 第 0 行（顶）映射到 quad 顶部，与卡片 uvAt 的方向一致
  push(-hw, -hh, 0, 0, 0, 1, 0, 1);
  push(hw, -hh, 0, 0, 0, 1, 1, 1);
  push(hw, hh, 0, 0, 0, 1, 1, 0);
  push(-hw, hh, 0, 0, 0, 1, 0, 0);
  indices.push(0, 1, 2, 0, 2, 3);
  // 背面：v 同向，u 镜像（从背面看文字仍正读）
  push(-hw, -hh, 0, 0, 0, -1, 1, 1);
  push(hw, -hh, 0, 0, 0, -1, 0, 1);
  push(hw, hh, 0, 0, 0, -1, 0, 0);
  push(-hw, hh, 0, 0, 0, -1, 1, 0);
  indices.push(4, 6, 5, 4, 7, 6);
  return {
    positions: new Float32Array(positions), normals: new Float32Array(normals),
    uvs: new Float32Array(uvs), colors: new Float32Array(colors),
    texMix: new Float32Array(texMix), texBack: new Float32Array(texBack),
    indices: new Uint16Array(indices),
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// 圆角图片瓦片：object-fit cover 裁切 + 白色细描边 + 柔和紫影（参考图磨砂面板叠层感）
function drawCover(ctx, img, x, y, w, h, radius, label) {
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.save();
  ctx.clip();
  if (img) {
    const ir = img.width / img.height;
    const tr = w / h;
    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    if (ir > tr) { sw = img.height * tr; sx = (img.width - sw) / 2; }
    else { sh = img.width / tr; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  } else {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, "#dcd2f4");
    g.addColorStop(1, "#b6a8e4");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.font = "600 52px 'Noto Sans SC', 'PingFang SC', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText([...(label || "✦")][0] || "✦", x + w / 2, y + h / 2);
  }
  ctx.restore();
  ctx.shadowColor = "rgba(125,105,190,.38)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 7;
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.strokeStyle = "rgba(255,255,255,.85)";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

// 正面拼贴（横版 4:3）：半透明淡紫玻璃底 + 主封面大图 + 最多 3 张藏品小图 +
// 紫色渐变标签 + 对角高光 + 外缘白色描边（参考「手持玻璃卡」截图的质感）
function composeExhibitionFace(ctx, candidate, images) {
  const W = FACE_W, H = FACE_H;
  const pal = ballPalette(candidate.id);
  // 玻璃底：参考玻璃气泡的「暖米杏 → 冷紫丁香」双色低饱和渐变，中间过渡卡色相；
  // 高透明，背景透出，内部是"染色玻璃"而非遮罩
  const base = ctx.createLinearGradient(0, 0, W, H);
  base.addColorStop(0, "rgba(247,231,214,.26)");
  base.addColorStop(0.45, `rgba(${pal.tint[0]},${pal.tint[1]},${pal.tint[2]},.16)`);
  base.addColorStop(1, "rgba(203,199,233,.28)");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  roundRectPath(ctx, 0, 0, W, H, 22);
  ctx.save();
  ctx.clip();
  // 左上柔和的玻璃球氛围光（随卡色相）
  const glow = ctx.createRadialGradient(150, 90, 12, 150, 90, 420);
  glow.addColorStop(0, pal.glow);
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const arts = images.arts || [];
  const members = candidate.members || [];
  ctx.save();
  ctx.globalAlpha = 0.9; // 图块轻微透出玻璃感
  // 主图：左侧大卡（展览封面）
  drawCover(ctx, images.cover, 30, 30, 380, 330, 28, candidate.title);
  // 右上 / 右中：两件关联藏品
  drawCover(ctx, arts[0], 432, 30, 221, 160, 20, members[0]?.title || "");
  drawCover(ctx, arts[1], 432, 208, 221, 160, 20, members[1]?.title || "");
  // 左下小卡：第三件藏品，压在主图下缘形成层叠
  drawCover(ctx, arts[2], 30, 340, 250, 142, 20, members[2]?.title || "");
  // 紫色渐变标签（参考图主按钮的紫渐变）
  roundRectPath(ctx, 432, 386, 221, 50, 25);
  const pill = ctx.createLinearGradient(432, 386, 653, 436);
  pill.addColorStop(0, "#7d6df2");
  pill.addColorStop(1, "#a08df7");
  ctx.fillStyle = pill;
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.96)";
  ctx.font = "500 24px 'Noto Sans SC', 'PingFang SC', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("关联藏品", 542, 412);
  ctx.restore();
  // 主高光：左上局部弧形柔白光斑（参考玻璃气泡的月牙形高光，非均匀描边）
  ctx.save();
  ctx.translate(W * 0.3, H * 0.22);
  ctx.scale(1.5, 1);
  ctx.rotate(-0.45);
  const light = ctx.createRadialGradient(0, 0, 8, 0, 0, W * 0.42);
  light.addColorStop(0, "rgba(255,255,255,.55)");
  light.addColorStop(0.45, "rgba(255,255,255,.18)");
  light.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = light;
  ctx.fillRect(-W * 0.7, -H * 0.7, W * 1.4, H * 1.4);
  ctx.restore();
  // 玻璃球式锐利高光点：上左一枚白亮的镜面小光斑
  const hotspot = ctx.createRadialGradient(W * 0.24, H * 0.16, 2, W * 0.24, H * 0.16, 92);
  hotspot.addColorStop(0, "rgba(255,255,255,.85)");
  hotspot.addColorStop(0.35, "rgba(255,255,255,.32)");
  hotspot.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hotspot;
  ctx.fillRect(0, 0, W, H);
  // 右下细冷反光线：玻璃折出的环境反射（参考气泡右下那道细线）
  ctx.save();
  ctx.translate(W * 0.74, H * 0.78);
  ctx.rotate(-0.6);
  const refl = ctx.createLinearGradient(-130, 0, 130, 0);
  refl.addColorStop(0, "rgba(205,201,233,0)");
  refl.addColorStop(0.5, "rgba(216,212,240,.58)");
  refl.addColorStop(1, "rgba(205,201,233,0)");
  ctx.strokeStyle = refl;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-130, 0);
  ctx.lineTo(130, 0);
  ctx.stroke();
  ctx.restore();
  // 上缘细亮边（真玻璃受光边缘，克制）
  ctx.fillStyle = "rgba(255,255,255,.34)";
  ctx.fillRect(0, 0, W, 2);
  // 底部内侧阴影（玻璃厚度在底缘的暗影，随卡色偏一点）
  const bottomShadow = ctx.createLinearGradient(0, H * 0.86, 0, H);
  bottomShadow.addColorStop(0, "rgba(25,30,55,0)");
  bottomShadow.addColorStop(1, pal.dark);
  ctx.fillStyle = bottomShadow;
  ctx.fillRect(0, H * 0.86, W, H * 0.14);
  ctx.restore();
  // 边缘泛光：整圈柔羽化的冷白淡紫光晕（参考图：四面均匀、充分羽化）
  roundRectPath(ctx, 0, 0, W, H, 22);
  ctx.save();
  ctx.shadowColor = "rgba(214,210,242,.85)";
  ctx.shadowBlur = 38;
  ctx.strokeStyle = "rgba(214,210,242,.14)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  // 第二层更宽的泛光：让光晕充分扩散、四周均匀
  ctx.save();
  ctx.shadowColor = "rgba(226,222,246,.35)";
  ctx.shadowBlur = 64;
  ctx.strokeStyle = "rgba(226,222,246,.05)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  // 内侧亮边 + 卡色描边（细、克制）
  ctx.shadowColor = "rgba(255,255,255,.55)";
  ctx.shadowBlur = 12;
  ctx.strokeStyle = "rgba(255,255,255,.60)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  roundRectPath(ctx, 2, 2, W - 4, H - 4, 20);
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// 记录卡面：单条用户记录的玻璃卡。
// kind === "image"：大图贴满卡面主体 + 来源胶囊 + 标题 + 类型戳；
// kind === "language"：衬线大字摘录 + 来源胶囊 + 出处小标。复用展览卡的玻璃底与高光语言。
function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function composeRecordFace(ctx, candidate, images) {
  const W = FACE_W, H = FACE_H;
  const pal = ballPalette(candidate.id);
  // 玻璃底：参考玻璃气泡的「暖米杏 → 冷紫丁香」双色渐变，中间过渡卡色相
  const glass = ctx.createLinearGradient(0, 0, W, H);
  glass.addColorStop(0, "rgba(247,231,214,.30)");
  glass.addColorStop(0.45, `rgba(${pal.tint[0]},${pal.tint[1]},${pal.tint[2]},.20)`);
  glass.addColorStop(1, "rgba(203,199,233,.30)");
  ctx.fillStyle = glass;
  ctx.fillRect(0, 0, W, H);

  roundRectPath(ctx, 0, 0, W, H, 22);
  ctx.save();
  ctx.clip();
  // 左上柔和的玻璃球氛围光（随卡色相）
  const glow = ctx.createRadialGradient(150, 90, 12, 150, 90, 420);
  glow.addColorStop(0, pal.glow);
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const sourceLabel = [candidate.source, candidate.typeLabel].filter(Boolean).join(" · ");
  const pill = (text, y, font, fill = "rgba(20,18,42,.52)", color = "rgba(255,255,255,.92)", paddingX = 18, paddingY = 12) => {
    ctx.font = font;
    const w = ctx.measureText(text).width;
    const x = W - 30 - w - paddingX;
    roundRectPath(ctx, x, y - paddingY, w + paddingX * 2, paddingY * 2, (paddingY * 2) / 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + paddingX + w / 2, y);
  };
  if (sourceLabel) pill(sourceLabel, 58, "600 20px 'Noto Sans SC','PingFang SC',sans-serif");

  if (candidate.kind === "image") {
    drawCover(ctx, images.cover, 41, 44, 601, 344, 26, candidate.title);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(255,250,241,.96)";
    ctx.font = "500 32px 'Noto Serif SC','Songti SC','Noto Sans SC',serif";
    ctx.fillText(String(candidate.title || "").slice(0, 18), 41, 442, 520);
    pill("图片记录", 446, "600 18px 'Noto Sans SC','PingFang SC',sans-serif", "rgba(20,18,42,.5)", "rgba(255,255,255,.9)", 14, 10);
  } else {
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(255,250,241,.5)";
    ctx.font = "500 96px 'Noto Serif SC','Songti SC',serif";
    ctx.fillText("“", 44, 148);
    const quote = String(candidate.quote || candidate.title || "");
    ctx.fillStyle = "rgba(255,250,241,.94)";
    ctx.font = "500 40px 'Noto Serif SC','Songti SC',serif";
    const lines = wrapCanvasText(ctx, quote, 588).slice(0, 5);
    let y = 184;
    for (const line of lines) {
      ctx.fillText(line, 52, y);
      y += 55;
    }
    ctx.fillStyle = "rgba(255,250,241,.72)";
    ctx.font = "500 23px 'Noto Sans SC','PingFang SC',sans-serif";
    ctx.fillText(`— ${String(candidate.title || "").slice(0, 14)}`, 52, 456, 500);
    pill("语言记录", 446, "600 18px 'Noto Sans SC','PingFang SC',sans-serif", "rgba(20,18,42,.5)", "rgba(255,255,255,.9)", 14, 10);
  }

  // 对角玻璃高光 + 外缘白色描边
  const sheen = ctx.createLinearGradient(-70, -70, W + 110, H + 110);
  sheen.addColorStop(0, "rgba(255,255,255,.34)");
  sheen.addColorStop(0.42, "rgba(255,255,255,.05)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  // 边缘泛光：整圈柔羽化的冷白淡紫光晕（参考图：四面均匀、充分羽化）
  roundRectPath(ctx, 0, 0, W, H, 14);
  ctx.save();
  ctx.shadowColor = "rgba(214,210,242,.85)";
  ctx.shadowBlur = 38;
  ctx.strokeStyle = "rgba(214,210,242,.14)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.shadowColor = "rgba(226,222,246,.35)";
  ctx.shadowBlur = 64;
  ctx.strokeStyle = "rgba(226,222,246,.05)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  ctx.shadowColor = "rgba(255,255,255,.55)";
  ctx.shadowBlur = 12;
  ctx.strokeStyle = "rgba(255,255,255,.72)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  roundRectPath(ctx, 2, 2, W - 4, H - 4, 13);
  ctx.strokeStyle = "rgba(255,255,255,.28)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// 背面信息卡面（双面都显示信息）：收新弹窗同款玻璃底 + 眉标 / 标题 / 副标 / meta /
// 标签胶囊 / 成员缩略图。背面纹理 UV 镜像，翻面时文字仍正读。
function composeExhibitionBack(ctx, candidate, arts) {
  const W = FACE_W, H = FACE_H;
  const pal = ballPalette(candidate.id);
  // 玻璃底：暖米杏 → 冷紫丁香双色渐变（下方压暗保证文字可读），背景色透出
  const glass = ctx.createLinearGradient(0, 0, W, H);
  glass.addColorStop(0, "rgba(247,231,214,.24)");
  glass.addColorStop(0.46, `rgba(${pal.tint[0]},${pal.tint[1]},${pal.tint[2]},0.16)`);
  glass.addColorStop(1, "rgba(48,56,92,0.30)");
  ctx.fillStyle = glass;
  ctx.fillRect(0, 0, W, H);

  roundRectPath(ctx, 0, 0, W, H, 14);
  ctx.save();
  ctx.clip();
  const glow = ctx.createRadialGradient(80, 60, 10, 80, 60, 320);
  glow.addColorStop(0, "rgba(255,255,255,.16)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  // 下部柔和压暗：标签/成员区在清透玻璃上仍可读
  const scrim = ctx.createLinearGradient(0, H * 0.42, 0, H);
  scrim.addColorStop(0, "rgba(30,32,58,0)");
  scrim.addColorStop(1, "rgba(30,32,58,0.42)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, W, H);
  // 上缘细亮边（与正面一致，克制）
  ctx.fillStyle = "rgba(255,255,255,.38)";
  ctx.fillRect(0, 0, W, 2);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f2a85f";
  ctx.font = "700 18px 'Noto Sans SC','PingFang SC',sans-serif";
  ctx.fillText(candidate.kind === "exhibition" ? "PERSONAL EXHIBITION · 随机漫游" : "正在形成 · 随机漫游", 44, 64);

  ctx.shadowColor = "rgba(20,22,44,.5)";
  ctx.shadowBlur = 6;
  ctx.fillStyle = "rgba(255,250,241,.97)";
  ctx.font = "500 46px 'Noto Serif SC','Songti SC','Noto Sans SC',serif";
  ctx.fillText(String(candidate.title || "").slice(0, 14), 44, 148, 595);

  ctx.fillStyle = "rgba(255,250,241,.78)";
  ctx.font = "400 20px 'Noto Sans SC','PingFang SC',sans-serif";
  ctx.fillText(String(candidate.subtitle || "").slice(0, 36), 44, 194, 595);

  ctx.fillStyle = "rgba(255,250,241,.6)";
  ctx.font = "400 16px 'Noto Sans SC','PingFang SC',sans-serif";
  ctx.fillText(String(candidate.meta || "").slice(0, 42), 44, 230, 595);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  // 标签胶囊
  let tx = 44;
  ctx.font = "500 16px 'Noto Sans SC','PingFang SC',sans-serif";
  for (const tag of (candidate.tags || []).slice(0, 4)) {
    const w = ctx.measureText(tag).width;
    if (tx + w + 34 > W - 60) break;
    roundRectPath(ctx, tx, 252, w + 24, 34, 17);
    ctx.fillStyle = "rgba(255,255,255,.14)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.34)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,250,241,.92)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tag, tx + 12 + w / 2, 270);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    tx += w + 34;
  }

  // 成员缩略图
  const members = (candidate.members || []).slice(0, 3);
  if (members.length) {
    ctx.fillStyle = "rgba(255,250,241,.5)";
    ctx.font = "600 13px 'Noto Sans SC','PingFang SC',sans-serif";
    ctx.fillText("来自你的收藏", 44, 342);
    let mx = 44;
    for (let i = 0; i < members.length; i++) {
      drawCover(ctx, arts[i] || null, mx, 360, 62, 62, 14, members[i].title);
      mx += 76;
    }
  }
  ctx.restore();

  // 边缘泛光：整圈柔羽化的冷白淡紫光晕
  roundRectPath(ctx, 0, 0, W, H, 22);
  ctx.save();
  ctx.shadowColor = "rgba(214,210,242,.85)";
  ctx.shadowBlur = 38;
  ctx.strokeStyle = "rgba(214,210,242,.14)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.shadowColor = "rgba(226,222,246,.35)";
  ctx.shadowBlur = 64;
  ctx.strokeStyle = "rgba(226,222,246,.05)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  ctx.shadowColor = "rgba(255,255,255,.55)";
  ctx.shadowBlur = 12;
  ctx.strokeStyle = "rgba(255,255,255,.55)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  roundRectPath(ctx, 2, 2, W - 4, H - 4, 20);
  ctx.strokeStyle = "rgba(255,255,255,.2)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// 多藏品玻璃卡正面纹理：先画占位拼贴，封面与藏品图全部加载完再重绘上传
function loadFaceTexture(gl, candidate) {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_W;
  canvas.height = FACE_H;
  const ctx = canvas.getContext("2d");
  const members = (candidate.members || []).slice(0, 3);
  const images = { cover: null, arts: members.map(() => null) };
  let pending = 0;

  function makeTexture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([240, 236, 225, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const texture = makeTexture();
  const backTexture = makeTexture();

  function upload() {
    composeExhibitionFace(ctx, candidate, images);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    // 背面信息卡面（双面都显示信息）：全分辨率排版，翻面时正读
    const b = document.createElement("canvas");
    b.width = FACE_W;
    b.height = FACE_H;
    const bctx = b.getContext("2d");
    composeExhibitionBack(bctx, candidate, images.arts);
    gl.bindTexture(gl.TEXTURE_2D, backTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b);
  }

  function loadOne(src, assign) {
    if (!src) return;
    pending += 1;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { assign(img); pending -= 1; if (pending === 0) upload(); };
    img.onerror = () => { pending -= 1; if (pending === 0) upload(); };
    img.src = src;
  }

  upload(); // 先画占位布局，图片加载完再替换
  loadOne(candidate.cover, (img) => { images.cover = img; });
  members.forEach((member, i) => loadOne(member.thumbnail, (img) => { images.arts[i] = img; }));
  return { texture, backTexture, ready: () => true };
}

// 记录卡正面纹理：图片记录贴缩略图、语言记录直接排版；与展览卡共用磨砂背面逻辑。
export function loadRecordFaceTexture(gl, candidate) {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_W;
  canvas.height = FACE_H;
  const ctx = canvas.getContext("2d");
  let image = null;

  function makeTexture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([240, 236, 225, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const texture = makeTexture();
  const backTexture = makeTexture();

  function upload() {
    composeRecordFace(ctx, candidate, { cover: image });
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    // 背面磨砂：缩小 + 高斯模糊出磨砂玻璃感
    const c = document.createElement("canvas");
    c.width = 171;
    c.height = 128;
    const bctx = c.getContext("2d");
    bctx.filter = "blur(8px)";
    bctx.drawImage(canvas, 0, 0, 171, 128);
    gl.bindTexture(gl.TEXTURE_2D, backTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  }

  upload(); // 先画占位排版，图片记录加载完成后再替换
  if (candidate.kind === "image" && candidate.cover) {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { image = img; upload(); };
    img.onerror = () => { image = null; upload(); };
    img.src = candidate.cover;
  }
  return { texture, backTexture, ready: () => true };
}

// 手动字距排版：textAlign=center 下按总宽居中逐字绘制（letterSpacing 兼容性兜底）。
function drawSpacedText(ctx, text, cx, y, spacing) {
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x + widths[i] / 2, y);
    x += widths[i] + spacing;
  }
}

// 同 drawSpacedText，但用 strokeText 描边（字形亮边描光用），保持与填充一致的字距。
function strokeSpacedText(ctx, font, text, cx, y, spacing, style) {
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let x = cx - total / 2;
  ctx.save();
  ctx.font = font;
  ctx.strokeStyle = style.strokeStyle;
  ctx.lineWidth = style.lineWidth;
  ctx.lineJoin = "round";
  for (let i = 0; i < chars.length; i++) {
    ctx.strokeText(chars[i], x + widths[i] / 2, y);
    x += widths[i] + spacing;
  }
  ctx.restore();
}

// FORME 3D 标题纹理：与暮色背景同族的哑光玻璃字。整体色阶收敛到背景渐变
// （#8c85c4 → #afa3d2 → #c5a3c8 → #d79aab）的蓝紫/薰衣草范围内，只比背景略深一档保证可读；
// 高光收敛成细而克制的层次：柔和环境光晕 → 玻璃侧边 → 同族色主字渐变 →
// 顶部微反光 + 低对比斜向光带 + 细亮边。字体加载完成后自动重绘。
function composeTitleTexture(gl) {
  const canvas = document.createElement("canvas");
  canvas.width = TITLE_CANVAS_W;
  canvas.height = TITLE_CANVAS_H;
  const ctx = canvas.getContext("2d");
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function draw() {
    const W = TITLE_CANVAS_W, H = TITLE_CANVAS_H;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const font = `500 ${Math.round(W * 0.235)}px "Harmony", "Instrument Serif", "Noto Serif SC", serif`;
    const spacing = Math.round(W * 0.032);
    const cx = W / 2, cy = H * 0.5;
    // 1) 柔和粉紫外发光（参考 HOLO 字：无硬阴影，只有大范围柔光）
    ctx.save();
    ctx.shadowColor = "rgba(255,190,226,.75)";
    ctx.shadowBlur = 58;
    ctx.fillStyle = "rgba(255,224,240,.28)";
    ctx.font = font;
    drawSpacedText(ctx, "Folio", cx, cy, spacing);
    ctx.restore();
    // 1b) 第二层更宽的外发光：光晕充分扩散
    ctx.save();
    ctx.shadowColor = "rgba(255,210,235,.30)";
    ctx.shadowBlur = 90;
    ctx.fillStyle = "rgba(255,224,240,.10)";
    ctx.font = font;
    drawSpacedText(ctx, "Folio", cx, cy, spacing);
    ctx.restore();
    // 2) 极轻的玻璃侧边（浅紫，只给一点厚度，不形成阴影）
    ctx.font = font;
    ctx.fillStyle = "rgba(190,170,230,.10)";
    drawSpacedText(ctx, "Folio", cx + 4, cy + 4, spacing);
    // 3) 白底：半透明奶白，背景透出（HOLO 字的白色基底）
    ctx.font = font;
    ctx.fillStyle = "rgba(255,253,250,.95)";
    drawSpacedText(ctx, "Folio", cx, cy, spacing);
    // 4) 全息镭射层：对角流动的粉 → 紫 → 蓝 → 青渐变（HOLO 字的核心）
    const holo = ctx.createLinearGradient(cx - W * 0.34, cy - H * 0.32, cx + W * 0.34, cy + H * 0.34);
    holo.addColorStop(0, "rgba(255,170,205,.97)");
    holo.addColorStop(0.3, "rgba(196,152,255,.94)");
    holo.addColorStop(0.62, "rgba(135,178,255,.93)");
    holo.addColorStop(1, "rgba(135,226,255,.92)");
    ctx.fillStyle = holo;
    drawSpacedText(ctx, "Folio", cx, cy, spacing);
    // 4b) 细高光带：一条斜向的亮色扫过字面，模拟镭射膜的镜面反光
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-W * 0.05, cy - H * 0.20);
    ctx.lineTo(W * 1.05, cy - H * 0.34);
    ctx.lineTo(W * 1.05, cy - H * 0.16);
    ctx.lineTo(-W * 0.05, cy - H * 0.02);
    ctx.closePath();
    ctx.clip();
    ctx.font = font;
    ctx.fillStyle = "rgba(255,255,255,.38)";
    drawSpacedText(ctx, "Folio", cx, cy, spacing);
    ctx.restore();
    // 5) 顶部微反光：轻白顶光，保持通透
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H * 0.40);
    ctx.clip();
    const gloss = ctx.createLinearGradient(0, cy - H * 0.16, 0, cy + H * 0.06);
    gloss.addColorStop(0, "rgba(255,255,255,.18)");
    gloss.addColorStop(0.55, "rgba(255,255,255,.05)");
    gloss.addColorStop(1, "rgba(255,255,255,0)");
    ctx.font = font;
    ctx.fillStyle = gloss;
    drawSpacedText(ctx, "Folio", cx, cy, spacing);
    ctx.restore();
    // 6) 极细白描边：给镭射层一点轮廓分离，不硬不黑
    strokeSpacedText(ctx, font, "Folio", cx, cy, spacing, {
      strokeStyle: "rgba(255,255,255,.55)",
      lineWidth: 1,
    });
    strokeSpacedText(ctx, font, "Folio", cx, cy, spacing, {
      strokeStyle: "rgba(190,170,235,.30)",
      lineWidth: 0.8,
    });
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  }
  draw();
  if (document.fonts?.ready) document.fonts.ready.then(draw);
  return texture;
}

// —— 玻璃碎片背景：取代星尘点。每片是带随机旋转/漂移/自旋的小四边形，
// 纹理按图 1 参考（宝石切面碎玻璃）重构：三种形态（锐利长条 / 厚片 / 星芒）；
// 每个扇形刻面按与光源夹角独立着色（迎光近白粉 → 侧面粉紫 → 背光深蓝紫，无纯黑）；
// 棱边"半圈亮半圈暗"——迎光棱纯白高光+光点，背光棱深蓝紫描边；高透、mipmap 锐化。
// 多张变体纹理混合使用，避免千片一面。随镜头推进有真实视差 ——
const SHARD_COUNT = 92;        // 走廊纵深散布的碎片
const SHARD_NEAR_COUNT = 12;   // 开场时在 FORME 与镜头之间的近景碎片
const SHARD_HERO_COUNT = 6;    // 大块 hero 碎片，拉开大小层次
const SHARD_VARIANTS = 6;      // 碎玻璃纹理变体数（三种形态 × 每种 2 张）
function buildShardGeometry() {
  // 单位 quad（1×1，中心原点），双面，texMix=1 纯纹理；v 方向与卡片/标题一致
  const positions = [], normals = [], uvs = [], colors = [], texMix = [], texBack = [], indices = [];
  const push = (x, y, nx, ny, nz, u, v) => {
    positions.push(x, y, 0);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    colors.push(1, 1, 1);
    texMix.push(1);
    texBack.push(0);
  };
  push(-0.5, -0.5, 0, 0, 1, 0, 1);
  push(0.5, -0.5, 0, 0, 1, 1, 1);
  push(0.5, 0.5, 0, 0, 1, 1, 0);
  push(-0.5, 0.5, 0, 0, 1, 0, 0);
  indices.push(0, 1, 2, 0, 2, 3);
  push(-0.5, -0.5, 0, 0, -1, 0, 1);
  push(0.5, -0.5, 0, 0, -1, 1, 1);
  push(0.5, 0.5, 0, 0, -1, 1, 0);
  push(-0.5, 0.5, 0, 0, -1, 0, 0);
  indices.push(4, 6, 5, 4, 7, 6);
  return {
    positions: new Float32Array(positions), normals: new Float32Array(normals),
    uvs: new Float32Array(uvs), colors: new Float32Array(colors),
    texMix: new Float32Array(texMix), texBack: new Float32Array(texBack),
    indices: new Uint16Array(indices),
  };
}
function composeShardTextures(gl, count) {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  const cx = S / 2, cy = S / 2;
  const rnd = (i, salt) => { const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453; return s - Math.floor(s); };
  const lerpC = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
  // 三种碎片形态：0 锐利长条（顶点少、压得扁，像飞出的尖碎片）、
  // 1 厚片（顶点适中、近圆润不规则多边形）、2 星芒（顶点多、深凹口带尖角）
  const FORMS = [
    { min: 4, max: 5, alt: 0.82, lo: 0.46, hi: 0.64 },  // 细长条（保留长条辨识度，宽到能看出刻面）
    { min: 6, max: 7, alt: 0.86, lo: 0.88, hi: 1.10 },  // 厚片
    { min: 8, max: 9, alt: 0.36, lo: 0.74, hi: 0.96 },  // 深凹口星芒
  ];
  const textures = [];
  for (let v = 0; v < count; v++) {
    const F = FORMS[v % FORMS.length];
    // 同形态的第二个变体换一套随机盐，让 A/B 两版形状与布局真正不同
    const vv = v + Math.floor(v / FORMS.length) * 13;
    ctx.clearRect(0, 0, S, S);
    // 1) 折线轮廓：按形态取顶点数与压扁程度，半径交替出断裂凹口
    const n = F.min + Math.floor(rnd(vv, 1) * (F.max - F.min + 1));
    const squash = F.lo + rnd(vv, 2) * (F.hi - F.lo);
    const baseR = 46 + rnd(vv, 3) * 26;
    const a0 = rnd(vv, 4) * Math.PI * 2;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2;
      const r = (k % 2 === 0 ? 1 : F.alt * (0.66 + rnd(vv, 5 + k) * 0.5)) * baseR * (0.8 + rnd(vv, 5 + k + n) * 0.4);
      pts.push([cx + Math.cos(a) * r * squash, cy + Math.sin(a) * r]);
    }
    const gx = pts.reduce((s, p) => s + p[0], 0) / n;
    const gy = pts.reduce((s, p) => s + p[1], 0) / n;
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < n; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.closePath();
    };
    // 2) 宝石切面底：极浅冷白，几乎与背景同调（图 2 底色），只给刻面做载体
    outline();
    ctx.fillStyle = "rgba(255,255,255,.10)";
    ctx.fill();
    // 3) 扇形刻面：先在离屏画布用实色画满（迎光白粉 → 侧面粉紫 → 背光深靛紫，
    //    按与左上光源的夹角插值），再整体以统一透明度叠回主画布——颜色保持饱和、
    //    透明度均匀，不会在中心堆积成暗点，模拟图 1 宝石切面的"逐面明暗"
    const LIGHT_X = -0.5, LIGHT_Y = -0.65;
    const WHITE_PINK = [255, 246, 250], PINK_PURPLE = [222, 160, 196], DEEP_BLUE = [72, 84, 152];
    const off = document.createElement("canvas");
    off.width = S;
    off.height = S;
    const octx = off.getContext("2d");
    for (let k = 0; k < n; k++) {
      const p = pts[k], q = pts[(k + 1) % n];
      const mx = (p[0] + q[0]) / 2 - gx, my = (p[1] + q[1]) / 2 - gy;
      const ml = Math.hypot(mx, my) || 1;
      const d = (mx / ml) * LIGHT_X + (my / ml) * LIGHT_Y; // -1..1
      const t = Math.min(1, Math.max(0, (d + 0.7) / 1.4));
      const col = t < 0.5 ? lerpC(DEEP_BLUE, PINK_PURPLE, t * 2) : lerpC(PINK_PURPLE, WHITE_PINK, (t - 0.5) * 2);
      octx.beginPath();
      octx.moveTo(gx, gy);
      octx.lineTo(p[0], p[1]);
      octx.lineTo(q[0], q[1]);
      octx.closePath();
      octx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      octx.fill();
    }
    ctx.globalAlpha = 0.42 + rnd(vv, 40) * 0.14; // 0.42–0.56 统一透明度（通透不压成黑点）
    ctx.drawImage(off, 0, 0);
    ctx.globalAlpha = 1;
    // 4) 贯穿反光带：左上→右下的亮带掠过整片（图 1 细长晶体上的对焦反光带），
    //    增强"实心切割"的密度感
    ctx.save();
    outline();
    ctx.clip();
    const band = ctx.createLinearGradient(gx - baseR, gy - baseR, gx + baseR, gy + baseR);
    band.addColorStop(0.3, "rgba(255,255,255,0)");
    band.addColorStop(0.44, `rgba(255,255,255,${0.16 + rnd(vv, 80) * 0.12})`);
    band.addColorStop(0.58, "rgba(255,255,255,0)");
    ctx.fillStyle = band;
    ctx.fillRect(gx - baseR * 1.3, gy - baseR * 1.3, baseR * 2.6, baseR * 2.6);
    ctx.restore();
    // 5) 刻面分界：重心到各顶点的细线，用柔和的粉紫（有彩色、不是黑线），
    //    让切面边界清晰但不刺眼
    ctx.strokeStyle = "rgba(160,132,182,.24)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      ctx.moveTo(gx, gy);
      ctx.lineTo(pts[k][0], pts[k][1]);
    }
    ctx.stroke();
    // 6) 半圈亮半圈暗的棱边（图 1 的核心特征）：迎光棱纯白高光 + 光点，
    //    背光棱深蓝紫描边；中间过渡为粉紫细线
    for (let k = 0; k < n; k++) {
      const p = pts[k], q = pts[(k + 1) % n];
      const ex = q[0] - p[0], ey = q[1] - p[1];
      const len = Math.hypot(ex, ey) || 1;
      let nx = ey / len, ny = -ex / len;
      const mx = (p[0] + q[0]) / 2 - gx, my = (p[1] + q[1]) / 2 - gy;
      if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
      const d = nx * LIGHT_X + ny * LIGHT_Y;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
      if (d > 0.35) {
        ctx.save();
        ctx.shadowColor = "rgba(255,255,255,.95)";
        ctx.shadowBlur = 3;
        ctx.strokeStyle = "rgba(255,255,255,1)";
        ctx.lineWidth = 2.6;
        ctx.stroke();
        ctx.restore();
        // 迎光棱中点加一枚锐利镜面光点
        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,1)";
        ctx.shadowColor = "rgba(255,255,255,1)";
        ctx.shadowBlur = 2;
        ctx.beginPath();
        ctx.arc((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 2.2 + rnd(vv, 200 + k) * 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (d > -0.12) {
        ctx.strokeStyle = "rgba(255,238,246,.5)";
        ctx.lineWidth = 1.6;
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(86,98,166,.42)";
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
    }
    // 7) 内部粉尘：细小白点，模拟玻璃内杂质
    const specks = 6 + Math.floor(rnd(vv, 80) * 8);
    for (let s = 0; s < specks; s++) {
      const a = rnd(vv, 90 + s) * Math.PI * 2;
      const rr = Math.sqrt(rnd(vv, 100 + s)) * baseR * 0.72;
      ctx.fillStyle = `rgba(255,255,255,${0.14 + rnd(vv, 110 + s) * 0.26})`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rr * squash, cy + Math.sin(a) * rr, 0.6 + rnd(vv, 120 + s) * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    // 生成 mipmap：碎片在远距/小尺寸下保持锐利，不再发糊
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    textures.push(texture);
  }
  return textures;
}
function createShards() {
  const rnd = (i, salt) => { const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453; return s - Math.floor(s); };
  const make = (i, near) => {
    const side = rnd(i, 2) < 0.5 ? -1 : 1;
    return {
      tex: Math.floor(rnd(i, 15) * SHARD_VARIANTS),
      x: near ? (rnd(i, 3) - 0.5) * 620 : (110 + rnd(i, 4) * 640) * side,
      y: (rnd(i, 5) - 0.5) * 1040,
      z: near ? 580 + rnd(i, 6) * 190 : -360 - rnd(i, 7) * 5600,
      s: near ? 4 + rnd(i, 8) * 8 : 8 + rnd(i, 9) * 40,
      rot: rnd(i, 10) * Math.PI * 2,
      spin: (rnd(i, 11) - 0.5) * 1.4,
      driftX: (rnd(i, 12) - 0.5) * 2.4,
      driftY: (rnd(i, 13) - 0.5) * 2.4,
      phase: rnd(i, 14) * 6.2831,
    };
  };
  const shards = [];
  for (let i = 0; i < SHARD_COUNT; i++) shards.push(make(i, false));
  for (let i = 0; i < SHARD_NEAR_COUNT; i++) shards.push(make(100 + i, true));
  for (let i = 0; i < SHARD_HERO_COUNT; i++) {
    const side = rnd(200 + i, 2) < 0.5 ? -1 : 1;
    shards.push({
      tex: Math.floor(rnd(210 + i, 15) * SHARD_VARIANTS),
      x: (180 + rnd(201 + i, 4) * 340) * side,
      y: (rnd(202 + i, 5) - 0.5) * 840,
      z: -650 - rnd(203 + i, 7) * 1650,
      s: 55 + rnd(204 + i, 9) * 55,
      rot: rnd(205 + i, 10) * Math.PI * 2,
      spin: (rnd(206 + i, 11) - 0.5) * 0.8,
      driftX: (rnd(207 + i, 12) - 0.5) * 2,
      driftY: (rnd(208 + i, 13) - 0.5) * 2,
      phase: rnd(209 + i, 14) * 6.2831,
    });
  }
  return shards;
}

export function mountNoomoScene(container, { candidates, advance, getState, onActive, onProject, faceLoader }) {
  if (!container) return null;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  container.appendChild(canvas);
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true })
    || canvas.getContext("experimental-webgl", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) { canvas.remove(); return null; }

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  // 画布纹理按预乘 alpha 上传，配合 ONE / ONE_MINUS_SRC_ALPHA 实现半透明玻璃
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  function compile(ctx, type, src) {
    const shader = ctx.createShader(type);
    ctx.shaderSource(shader, src);
    ctx.compileShader(shader);
    if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) console.warn("noomo3d shader:", ctx.getShaderInfoLog(shader));
    return shader;
  }
  const VERTEX = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    attribute vec2 aUv;
    attribute vec3 aColor;
    attribute float aTexMix;
    attribute float aTexBack;
    uniform mat4 uProjView;
    uniform mat4 uModel;
    varying vec3 vNormal;
    varying vec2 vUv;
    varying vec3 vColor;
    varying float vTexMix;
    varying float vTexBack;
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = uModel * vec4(aPosition, 1.0);
      gl_Position = uProjView * wp;
      vWorldPos = wp.xyz;
      vNormal = mat3(uModel) * aNormal;
      vUv = aUv;
      vColor = aColor;
      vTexMix = aTexMix;
      vTexBack = aTexBack;
    }
  `;
  const FRAGMENT = `
    precision highp float;
    uniform sampler2D uTex;
    uniform sampler2D uTexBack;
    uniform vec3 uCamPos;
    uniform vec3 uLightDir;
    uniform vec3 uFogColor;
    uniform float uFogNear;
    uniform float uFogFar;
    uniform float uCardFade;
    varying vec3 vNormal;
    varying vec2 vUv;
    varying vec3 vColor;
    varying float vTexMix;
    varying float vTexBack;
    varying vec3 vWorldPos;
    void main() {
      vec3 n = normalize(vNormal);
      vec4 texA = texture2D(uTex, vUv);
      vec4 texB = texture2D(uTexBack, vUv);
      vec4 tex = mix(texA, texB, vTexBack);
      // 反预乘：还原纹理作者的真实亮色，让玻璃底色清透、背景透出
      vec3 texCol = tex.rgb / max(tex.a, 0.0001);
      vec3 albedo = mix(vColor, texCol, vTexMix);
      vec3 viewDir = normalize(uCamPos - vWorldPos);
      float ndv = max(dot(n, viewDir), 0.0);
      // 环境光反射：只在掠射边缘（Fresnel）与角度合适时出现局部 glint（高指数镜面），
      // 不整卡均匀加白，避免曝光
      float fresnel = pow(1.0 - ndv, 2.2);
      vec3 halfDir = normalize(uLightDir + viewDir);
      float spec = pow(max(dot(n, halfDir), 0.0), 48.0);
      float diff = max(dot(n, uLightDir), 0.0);
      float rim = pow(1.0 - ndv, 2.0);
      float isFace = step(0.5, vTexMix);
      // 正面贴图按原色直出（清亮玻璃），仅边缘轻微受光；侧边保留光照且半透明（薄玻璃边缘）
      vec3 base = mix(albedo * (0.28 + diff * 0.62 + rim * 0.5), albedo, isFace);
      vec3 glassGlow = vec3(1.0) * (fresnel * 0.16 + spec * 0.24);
      vec3 lit = base + glassGlow * (isFace * 0.5 + 0.35);
      float alpha = mix(0.5, tex.a, isFace);
      float dist = length(uCamPos - vWorldPos);
      float fog = smoothstep(uFogNear, uFogFar, dist);
      float nearFade = smoothstep(0.0, 150.0, uCamPos.z - vWorldPos.z);
      float outA = nearFade * alpha * uCardFade;
      vec3 fogged = mix(lit, uFogColor * outA, fog) * nearFade;
      gl_FragColor = vec4(fogged, outA);
    }
  `;
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.warn("noomo3d link:", gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const loc = (name) => gl.getUniformLocation(program, name);
  const uniforms = {
    uProjView: loc("uProjView"), uModel: loc("uModel"), uTex: loc("uTex"),
    uTexBack: loc("uTexBack"),
    uCamPos: loc("uCamPos"), uLightDir: loc("uLightDir"),
    uFogColor: loc("uFogColor"), uFogNear: loc("uFogNear"), uFogFar: loc("uFogFar"), uCardFade: loc("uCardFade"),
  };
  gl.uniform1i(uniforms.uTex, 0);
  gl.uniform1i(uniforms.uTexBack, 1);
  gl.uniform3f(uniforms.uLightDir, -0.42, 0.55, 0.72);
  gl.uniform1f(uniforms.uCardFade, 1);
  // 雾色与随机漫游的浅灰白背景（#f2f2f4 一带）一致，卡片向远处自然融进背景
  gl.uniform3f(uniforms.uFogColor, 0.94, 0.94, 0.97);
  gl.uniform1f(uniforms.uFogNear, 700);
  gl.uniform1f(uniforms.uFogFar, 4200);

  function makeDrawable(ctx, geometry) {
    const buffers = {};
    for (const [name, data] of Object.entries(geometry)) {
      if (name === "indices") continue;
      const buffer = ctx.createBuffer();
      ctx.bindBuffer(ctx.ARRAY_BUFFER, buffer);
      ctx.bufferData(ctx.ARRAY_BUFFER, data, ctx.STATIC_DRAW);
      buffers[name] = buffer;
    }
    const indexBuffer = ctx.createBuffer();
    ctx.bindBuffer(ctx.ELEMENT_ARRAY_BUFFER, indexBuffer);
    ctx.bufferData(ctx.ELEMENT_ARRAY_BUFFER, geometry.indices, ctx.STATIC_DRAW);
    return { buffers, indexBuffer, count: geometry.indices.length };
  }
  const mainDrawable = makeDrawable(gl, buildGlassCardGeometry());
  const attribs = {
    aPosition: gl.getAttribLocation(program, "aPosition"),
    aNormal: gl.getAttribLocation(program, "aNormal"),
    aUv: gl.getAttribLocation(program, "aUv"),
    aColor: gl.getAttribLocation(program, "aColor"),
    aTexMix: gl.getAttribLocation(program, "aTexMix"),
    aTexBack: gl.getAttribLocation(program, "aTexBack"),
  };
  const attributeSize = { aPosition: 3, aNormal: 3, aUv: 2, aColor: 3, aTexMix: 1, aTexBack: 1 };
  const bufferKey = { aPosition: "positions", aNormal: "normals", aUv: "uvs", aColor: "colors", aTexMix: "texMix", aTexBack: "texBack" };
  function bindAttributes(drawable) {
    for (const [name, locId] of Object.entries(attribs)) {
      gl.bindBuffer(gl.ARRAY_BUFFER, drawable.buffers[bufferKey[name]]);
      gl.enableVertexAttribArray(locId);
      gl.vertexAttribPointer(locId, attributeSize[name], gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, drawable.indexBuffer);
  }

  const cards = candidates.map((candidate, i) => {
    const tex = (faceLoader || loadFaceTexture)(gl, candidate);
    const seed = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    const rx = ((seed - Math.floor(seed)) * 2 - 1) * 20;
    // 卡片固定散落在走廊两侧（幅度克制、左右交替、带随机抖动）：
    // 镜头飞行时平移转向去“找”下一张卡，卡片本身不做横向归中动画
    const lane = 130 + ((i * 37) % 5) * 18 + rx;
    const xOffset = (i % 2 === 0 ? -1 : 1) * lane;
    return {
      xOffset,
      yaw: (i % 2 === 0 ? -1 : 1) * 0.22,
      pitch: 0.06,
      tex,
      seed: seed - Math.floor(seed),
      // 上下错落：远卡在走廊里高低分布，避免所有卡排在同一水平线上
      rise: (i % 3) * 50 - 30 + rx * 0.5,
    };
  });
  // 玻璃碎片背景（与卡片同一画布/程序，先于卡片绘制，被卡片与标题自然遮挡）
  const shardDrawable = makeDrawable(gl, buildShardGeometry());
  const shardTextures = composeShardTextures(gl, SHARD_VARIANTS);
  const shards = createShards();
  const titleTexture = composeTitleTexture(gl);

  let proj = null;
  let cardScale = 1;
  let titleDrawable = null;
  let titleW = 0, titleH = 0;
  // 聚焦位下沉量：宽屏贴向底部信息带；窄屏（≤760px，caption 纵向堆叠变高）保持靠上避免遮挡
  let focusLift = 46;
  function resize() {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const dpr = Math.min(1.75, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    proj = perspective(FOV, canvas.width / Math.max(1, canvas.height), 1, 6000);
    cardScale = Math.max(1, Math.min(1.45, height / 760));
    focusLift = width <= 760 ? 22 : 46;
    // FORME 标题：初始距离固定，大小按该距离下可视高度比例（"大大的"占满中央）
    const titleVisibleH = 2 * TITLE_DIST * Math.tan((FOV * Math.PI) / 360);
    const nextW = titleVisibleH * TITLE_RATIO_H * (TITLE_CANVAS_W / TITLE_CANVAS_H);
    const nextH = titleVisibleH * TITLE_RATIO_H;
    if (!titleDrawable || Math.abs(nextW - titleW) > 0.5 || Math.abs(nextH - titleH) > 0.5) {
      titleW = nextW;
      titleH = nextH;
      titleDrawable = makeDrawable(gl, buildTitlePlaneGeometry(titleW, titleH));
    }
    gl.useProgram(program);
  }
  resize();
  window.addEventListener("resize", resize);

  let raf = 0;
  let last = performance.now();
  const mountAt = performance.now();
  let activeIndex = -1;

  // 焦点系数：|d| 越接近 0 越聚焦（1 为完全聚焦），0.16 内保持满聚焦，0.76 外完全散开。
  // 收窄保持窗口，让当前卡更早开始让位，下一张卡在接近过程中持续可见地滑入中央
  function focusAt(d) {
    const t = Math.min(1, Math.max(0, (Math.abs(d) - 0.16) / 0.6));
    return 1 - t * t * (3 - 2 * t);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    advance(dt);
    const state = getState();

    // 走廊沿 -z 展开（卡片在相机正前方），滚轮推进时相机向 -z 前进。
    // 标题槽占 [-1,0)：p=-1 镜头正对居中的 FORME 大字，随后从标题车道平滑
    // 转向第一张卡的车道；p≥0 后维持原版"当前卡 → 下一张卡"的车道转向。
    const p = state.position;
    const i0 = Math.max(-1, Math.min(cards.length - 1, Math.floor(p)));
    const i1 = Math.min(cards.length - 1, i0 + 1);
    const frac = Math.min(1, Math.max(0, p - Math.floor(p)));
    const steer = frac * frac * (3 - 2 * frac);
    const x0 = i0 < 0 ? 0 : cards[i0].xOffset;
    const x1 = i1 < 0 ? 0 : cards[i1].xOffset;
    const camX = x0 + (x1 - x0) * steer;
    const camZ = CAMERA_DIST - p * ROCK_SPACING;
    const roll = Math.max(-0.06, Math.min(0.06, state.velocity * -0.0006));
    const view = multiply(rotationZ(roll), translation(-camX, 0, -camZ));
    const mvp = multiply(proj, view);
    gl.uniformMatrix4fv(uniforms.uProjView, false, transpose(mvp));
    gl.uniform3f(uniforms.uCamPos, camX, 0, camZ);

    const active = Math.max(0, Math.min(cards.length - 1, Math.round(state.position)));
    if (active !== activeIndex) { activeIndex = active; onActive(active); }

    // 玻璃碎片 + 卡片 + 标题共用同一透明 canvas：先远后近
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    // 玻璃碎片：沿走廊散布，缓慢漂移自旋，随镜头推进掠过（带景深视差）
    gl.uniform1f(uniforms.uCardFade, 1);
    const tSec = now * 0.001;
    for (const sh of shards) {
      const x = sh.x + Math.sin(tSec * 0.22 + sh.phase) * sh.driftX * 9;
      const y = sh.y + Math.sin(tSec * 0.3 + sh.phase * 1.7) * sh.driftY * 8;
      const z = sh.z + Math.sin(tSec * 0.16 + sh.phase * 0.8) * 6;
      const a = sh.rot + tSec * sh.spin;
      const s = sh.s;
      const group = multiply(multiply(multiply(translation(x, y, z), rotationZ(a)), rotationX(0.38)), scale3(s, s, s));
      bindAttributes(shardDrawable);
      gl.uniformMatrix4fv(uniforms.uModel, false, transpose(group));
      const shardTex = shardTextures[sh.tex];
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shardTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, shardTex);
      gl.drawElements(gl.TRIANGLES, shardDrawable.count, gl.UNSIGNED_SHORT, 0);
    }
    // 卡片只在标题完全消散后渐显（p∈[-0.45,0]），避免"标题后面透出卡片"
    const cardReveal = Math.min(1, Math.max(0, (p + 0.45) / 0.45));
    const revealE = cardReveal * cardReveal * (3 - 2 * cardReveal);
    gl.uniform1f(uniforms.uCardFade, revealE);
    const drawCards = revealE > 0.02;
    if (drawCards) {
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const dist = i - state.position;
      const focus = focusAt(dist);
      const sway = Math.sin(now * 0.0003 + i * 1.3) * 0.14;
      // 轨迹：卡片固定在车道上，只做摆正/放大；横向归中由镜头平移完成
      const targetYaw = (card.yaw + dist * 0.05) * (1 - focus) + sway * (1 - focus);
      card.yaw += (targetYaw - card.yaw) * 0.06;
      const pitch = (Math.sin(now * 0.00025 + i * 1.7) * 0.05 + card.pitch) * (1 - focus);
      const bob = Math.sin(now * 0.0006 + i * 2.1) * 8;
      const hh = (CARD_H / 2) * cardScale;
      const laneY = bob + (i % 2 === 0 ? -14 : 14) + (-20 + hh) + card.rise;
      const focusY = bob * 0.5 + (-focusLift + hh);
      const y = laneY + (focusY - laneY) * focus;
      const x = card.xOffset;
      const s = cardScale * (1 + (FOCUS_SCALE - 1) * focus);
      const group = multiply(multiply(multiply(translation(x, y, -i * ROCK_SPACING), rotationY(card.yaw)), rotationX(pitch)), scale3(s, s, s));

      // 主卡：展览封面厚玻璃卡（正面是多藏品玻璃拼贴）
      bindAttributes(mainDrawable);
      gl.uniformMatrix4fv(uniforms.uModel, false, transpose(group));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, card.tex.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, card.tex.backTexture);
      gl.drawElements(gl.TRIANGLES, mainDrawable.count, gl.UNSIGNED_SHORT, 0);
      if (i === active && onProject) {
        const modelMvp = multiply(mvp, group);
        const center = transformPoint(modelMvp, [0, 0, 0, 1]);
        const bottom = transformPoint(modelMvp, [0, -CARD_H / 2, 0, 1]);
        const left = transformPoint(modelMvp, [-CARD_W / 2, -CARD_H / 2, 0, 1]);
        const w = container.clientWidth || canvas.width;
        const h = container.clientHeight || canvas.height;
        const sx = (center[0] / center[3] * 0.5 + 0.5) * w;
        const sy = (1 - (bottom[1] / bottom[3] * 0.5 + 0.5)) * h;
        const lx = (left[0] / left[3] * 0.5 + 0.5) * w;
        onProject(sx, sy, lx);
      }
    }
    }

    // FORME 3D 标题（第一张卡前方）：居中、轻浮微摆；滚动时镜头推近穿过它，
    // shader 的 nearFade 会在相机贴近时自动淡出，卡片从大字后浮出。
    if (titleDrawable) {
      gl.uniform1f(uniforms.uCardFade, 1); // 标题不受卡片渐隐影响
      const titleIn = Math.min(1, (now - mountAt) / 900);
      const back = 1.70158;
      const ease = titleIn >= 1 ? 1 : 1 + (back + 1) * Math.pow(titleIn - 1, 3) + back * Math.pow(titleIn - 1, 2);
      const tBob = Math.sin(now * 0.00045) * 5;
      const tYaw = Math.sin(now * 0.00022) * 0.022;
      const ts = cardScale * (0.86 + 0.14 * ease);
      const tGroup = multiply(multiply(multiply(translation(0, tBob, TITLE_Z), rotationY(tYaw)), rotationX(0.012)), scale3(ts, ts, ts));
      gl.depthMask(false); // 透明文字不写深度：字母外区域让卡片与星尘透过来
      gl.enable(gl.CULL_FACE); // 背面剔除：只渲染朝向相机的一面，避免背面镜像重影
      gl.cullFace(gl.BACK);
      bindAttributes(titleDrawable);
      gl.uniformMatrix4fv(uniforms.uModel, false, transpose(tGroup));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, titleTexture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, titleTexture);
      gl.drawElements(gl.TRIANGLES, titleDrawable.count, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(true);
    }
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    canvas.remove();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
