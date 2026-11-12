// TextPressure（React Bits）的原生移植 —— 零依赖，逐字按鼠标距离改变字重/字宽/斜体。
function getAttr(distance, maxDist, minVal, maxVal) {
  const val = maxVal - Math.abs((maxVal * distance) / maxDist);
  return Math.max(minVal, val + minVal);
}

export function mountTextPressure(container, options = {}) {
  const {
    text = "Inbox · 遗落之地",
    fontFamily = "'Roboto Flex', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
    width = true,
    weight = true,
    italic = true,
    alpha = false,
    textColor = "rgba(255,252,238,.78)",
  } = options;

  container.textContent = "";
  const title = document.createElement("span");
  title.className = "text-pressure-title";
  title.style.color = textColor;
  title.style.fontFamily = fontFamily;
  // 初始即压感模型的最纤细/最窄端（与鼠标远离时一致），
  // 避免载入时先看到正常字宽、鼠标一动整行突然收窄。
  const restingSettings = `'wght' ${weight ? 100 : 400}, 'wdth' ${width ? 5 : 100}, 'ital' 0`;
  const spans = Array.from(text).map((ch) => {
    const s = document.createElement("span");
    s.className = "text-pressure-char";
    s.dataset.char = ch;
    s.textContent = ch === " " ? "\u00A0" : ch;
    s.style.fontVariationSettings = restingSettings;
    title.appendChild(s);
    return s;
  });
  container.appendChild(title);
  if (container.tagName !== "H1") {
    container.setAttribute("role", "img");
    container.setAttribute("aria-label", text);
  }

  const mouse = { x: 0, y: 0 };
  const cursor = { x: 0, y: 0 };
  // 初始处于“静止态”（不加粗、不变宽），直到鼠标真正移动后才开始压感变化，
  // 避免页面初次进入时标题看起来像已经处于 hover 状态。
  let started = false;

  const onMove = (event) => {
    if (!started) {
      started = true;
      mouse.x = event.clientX;
      mouse.y = event.clientY;
      cursor.x = event.clientX;
      cursor.y = event.clientY;
      if (!reduced) raf = requestAnimationFrame(loop);
    } else {
      cursor.x = event.clientX;
      cursor.y = event.clientY;
    }
  };
  window.addEventListener("mousemove", onMove);

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0;
  const loop = () => {
    mouse.x += (cursor.x - mouse.x) / 15;
    mouse.y += (cursor.y - mouse.y) / 15;
    const rect = container.getBoundingClientRect();
    const maxDist = Math.max(rect.width / 2, 1);
    spans.forEach((span) => {
      const r = span.getBoundingClientRect();
      const dx = mouse.x - (r.x + r.width / 2);
      const dy = mouse.y - (r.y + r.height / 2);
      const d = Math.sqrt(dx * dx + dy * dy);
      const wdth = width ? Math.floor(getAttr(d, maxDist, 5, 200)) : 100;
      const wght = weight ? Math.floor(getAttr(d, maxDist, 100, 900)) : 400;
      const italVal = italic ? getAttr(d, maxDist, 0, 1).toFixed(2) : 0;
      const settings = `'wght' ${wght}, 'wdth' ${wdth}, 'ital' ${italVal}`;
      if (span.style.fontVariationSettings !== settings) span.style.fontVariationSettings = settings;
      if (alpha) span.style.opacity = getAttr(d, maxDist, 0, 1).toFixed(2);
    });
    if (!reduced) raf = requestAnimationFrame(loop);
  };

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("mousemove", onMove);
    container.textContent = "";
  };
}
