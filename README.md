# Folio Demo

Folio 把散落的链接和文字整理成可以回看、串联和继续写的个人展览。Tag 是 Folio 的桌面伙伴，陪你读网页、留下收藏、找回以前读过的资料。

https://github.com/user-attachments/assets/276a3aa9-d76f-43b5-8148-08c5501dbb5f

[Web 在线体验](https://101.34.60.121/folio-demo/try/) · [Mac 本地安装（GitHub 源码）](#在-macos-上使用-tag)

Web 体验版的 Tag 仅支持输入示例库链接，暂不支持小助手吸附功能。

本仓库包含 Web 工作台、macOS 客户端源码和可在本机打开的示例展览。

在线体验沿用客户端的首页、收藏和展览界面，提供同一套 41 条示例收藏、5 场展览及预设读法。打开即可浏览，也可以试一次示例文字整理。在线手记和阅读偏好保存在当前浏览器。

## 在浏览器里体验

安装 Node.js 22 和 npm 后，在源码目录执行：

```sh
npm ci
npm run dev
```

打开 [http://127.0.0.1:4176/](http://127.0.0.1:4176/)。首次访问打开一个空白工作台，未配置模型时也可保存文字草稿。浏览器保存本机记录，清理站点数据后会丢失。

要在浏览器中查看预置演示馆，运行 `npm run desktop:server`，打开终端显示的本机地址并使用已填好的演示账号登录。此入口使用本机示例资料，包含 41 条收藏和 5 场展览。

要用自己的模型，先运行 `cp .env.example .env`。在 `.env` 中配置 `ZHIPU_CODING_API_KEY`、模型名和至少 32 字符的随机 `FORME_SESSION_SECRET`。文本接口示例使用智谱的标准 API。请使用该 API 的应用凭据，并将模型名改为账号可用的模型。只用本地内存账本时，将 `FORME_WORKER_URL` 留空。配置与访问的服务地址都只在 Node 进程生效。启用图片理解需单独提供对应视觉模型的凭据。

如需本地持久额度或异步采集，给应用和 Worker 配置同一个至少 32 字符的随机 `FORME_WORKER_TOKEN`，将应用的 `FORME_WORKER_URL` 设为 `http://127.0.0.1:8790`。另开终端执行 `npm run worker`，保持与 `npm run dev` 同时运行。外部视频采集还有平台可达性及可选的 yt-dlp、FFmpeg、转写运行时要求。

公开运行 Web 体验需要 HTTPS、共享额度账本、服务端模型密钥与独立的部署数据目录。部署说明见 [deploy/README.md](deploy/README.md)。

## 在 macOS 上使用 Tag

在 Mac 上从 GitHub 拉取源码并本地编译。需要 macOS 13 或更新版本、Node.js 22 和带 Git、Swift 的 Xcode Command Line Tools。若还未安装命令行工具，在终端运行 `xcode-select --install`。

```sh
git clone https://github.com/tomanojerry-debug/folio-demo.git
cd folio-demo
npm ci
npm run desktop -- --personal --setup-model
```

首次运行会编译并打开 Folio。按页面提示填写支持 Chat Completions 的 API 地址、模型名称和自己的 API Key。连接成功后即可和 Tag 对话。之后在源码目录再次运行 `npm run desktop -- --personal --setup-model` 即可启动，模型配置会保留在本机。Key 保存在仅本机用户可读取的配置文件中。模型问答会把相关内容发送给你选择的模型服务。

如果不确定 API 地址和模型名，可以把下面这段交给常用的 Coding Agent。

> 请帮我确认如何在 Folio 接入我指定的模型。告诉我兼容 Chat Completions 的 API 地址和准确的模型名。API Key 由我本人在这台 Mac 的 Folio 设置页填写。请勿索取、读取或传输 Key，也不要把它写入聊天、代码、日志或 GitHub。

只想浏览示例时，从 Folio 菜单退出后运行 `npm run desktop`。演示馆包含预置收藏和展览，无需模型，数据写入 `.data/folio-demo/`。

开发者也可通过 `npm run desktop -- --personal` 使用本地 `.env` 配置。源码启动的个人收藏、对话和笔记保存在 `.data/desktop/`。默认本机语义索引会在首次使用时下载公开模型，可在 `.env` 中设置 `KNOWLEDGE_EMBEDDING_BACKEND=disabled` 使用全文检索。

桌面联网搜索默认关闭。要启用，在本机 `.env` 中设置 `ZHIPU_WEB_SEARCH_MCP_URL` 和独立的 `ZHIPU_WEB_SEARCH_API_KEY`，使用具备智谱联网搜索 MCP 权限的凭据。

Tag 的原生窗口识别和浏览器协作可能需要 macOS 授权。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `site/` | Web 体验和桌面 Web 界面 |
| `server/`、`api/` | 模型适配、收藏理解、策展、Web API |
| `worker/` | 持久额度、请求缓存和可选的来源采集 |
| `desktop/` | Tag 的 Swift 外壳、本机服务和资料存储 |
| `tests/` | 使用测试替身或合成资料的运行测试 |

```sh
npm test
npm run check
```

Folio 自有代码和原创示例采用 [MIT 许可证](LICENSE)。第三方组件与馆藏作品适用各自的许可。见 [第三方来源与许可](THIRD_PARTY_NOTICES.md)。
