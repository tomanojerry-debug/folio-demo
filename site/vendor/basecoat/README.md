# Basecoat 1.1.0 · FORME 本地组件子集

来源：[官方安装文档](https://basecoatui.com/installation/)、[官方定制文档](https://basecoatui.com/customization/)、[npm 包](https://www.npmjs.com/package/basecoat-css/v/1.1.0)、[源仓库](https://github.com/hunvreus/basecoat)。获取日期：2026-11-09。

使用 `npm pack basecoat-css@1.1.0 --ignore-scripts` 下载官方发布包，没有执行安装脚本，也没有修改项目依赖。原始压缩包 SHA-256：`46eb1cedcd3845013d03a2f46341c63ec51f97185cef932eeb79a332a7c12b48`。

## 文件与修改范围

- `js/basecoat.min.js`、`js/dropdown-menu.min.js`：官方 `dist/js/` 文件原样复制。
- `basecoat-scoped.css`：从官方 `dist/basecoat.cdn.css` 提取按钮、输入框、文本域、下拉菜单、共享浮层和文字提示的 59 条根规则。保留其嵌套状态和声明；没有重新设计组件。文件约 58 KB，未压缩。
- `build-scoped.mjs`：可复现的提取脚本，使用 PostCSS AST 筛选根选择器，使用 selector parser 处理带逗号的复合选择器。
- `LICENSE.md`：Basecoat MIT 原文；`LICENSE.tailwindcss`：匹配编译产物头部的 Tailwind CSS 4.3.1 MIT 原文；`LICENSE.icons`：保留官方 CSS 内嵌勾选和箭头 SVG 的 Lucide／Feather 许可。[图标许可来源](https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE)

没有引入完整 CDN CSS、全局 reset、`:root`／`html`／`body` 规则、外部字体、额外工具类、Dialog、Tabs、Toast 或这些组件的脚本。

## 引入

```html
<link rel="stylesheet" href="/vendor/basecoat/basecoat-scoped.css">
<script defer src="/vendor/basecoat/js/basecoat.min.js"></script>
<script defer src="/vendor/basecoat/js/dropdown-menu.min.js"></script>
```

先加载组件 CSS，再加载应用的外观覆盖。无需 React、Tailwind 浏览器运行时或额外 `data-basecoat` 标记。标准 `.btn`、`.input`、`.textarea`、`.dropdown-menu` 和 `[data-tooltip]` 即是组件边界。

全部 CSS 自定义属性（包括 Tailwind 内部属性）都机械改名为 `--bc-*`，例如 `--primary` 变成 `--bc-primary`。默认值只声明在 `:where(.btn,.input,.textarea,.dropdown-menu,[data-tooltip])`，不会改写 FORME 的 `--accent`／`--muted`。保留的 `@property` 注册也使用 `--bc-*` 专属名称，不会影响现有 Tailwind 内部属性。

应用主题应覆盖**组件上的**默认值，只写在 `:root` 的继承值无法覆盖组件本身的默认值：

```css
:where(.btn,.input,.textarea,.dropdown-menu,[data-tooltip]) {
  --bc-font-sans: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --bc-background: #f7f5ee;
  --bc-foreground: #292e27;
  --bc-primary: #58684b;
  --bc-primary-foreground: #fffdf8;
  --bc-popover: #fffdf8;
  --bc-popover-foreground: #292e27;
  --bc-muted: #eeece3;
  --bc-muted-foreground: #6b7164;
  --bc-accent: #e9eddf;
  --bc-accent-foreground: #58684b;
  --bc-border: #ddded3;
  --bc-input: #ddded3;
  --bc-ring: #889574;
}
```

菜单按[官方结构](https://basecoatui.com/components/dropdown-menu/)使用：`.dropdown-menu` 容器的直接子按钮带 `aria-haspopup="menu"`、`aria-expanded` 和 `aria-controls`；直接子浮层使用 `[data-popover][aria-hidden="true"]`，其中放 `[role="menu"]`。项目事件委托识别按钮时，可使用 `<button role="menuitem" data-action="…">`，继续保留原有 `data-action` 协议。菜单文字由产品提供，全部使用中文。

按钮／输入／文本域／`data-tooltip="中文提示"` 只需 CSS。交互脚本可以脱离本文件单独使用，但必须由应用提供 `[data-popover][aria-hidden]` 的显隐、定位和 `.active`／聚焦外观；ARIA 属性本身不会自动隐藏普通 `div`。runtime 要先于菜单脚本加载；新增 DOM 后可调用 `window.basecoat.initAll()`，官方 MutationObserver 也会自动初始化和清理组件。

## 边界

样式仍会作用于所有使用这些标准类／属性的元素，这是有意的组件接入范围；不要把这些名称用于无关元素。浮层是普通 DOM，会受容器裁切；没有自动 portal／跨窗口显示。文字提示仍是官方 CSS 提示，不能替代可访问名称。原始编译产物含 CSS nesting、`color-mix()` 等现代 CSS，最低支持的 WKWebView 仍须实测；`anchor-size()` 仅是菜单最小宽度的可选增强，基础定位仍使用普通绝对定位。

## 复现

从已校验的官方压缩包提取 `package/dist/basecoat.cdn.css` 到临时目录。在独立临时工具目录安装 `postcss@8.5.6` 和 `postcss-selector-parser@7.1.0`（`--ignore-scripts`），随后运行：

```sh
node site/vendor/basecoat/build-scoped.mjs /tmp/basecoat.cdn.css /tmp/basecoat-tooling
```

脚本不会修改现有 UI 或服务端。更新版本前需检查上游选择器；当前脚本校验 Tailwind 编译标识并拒绝意外的全局规则。
