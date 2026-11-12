# Folio 在线体验部署预案

本目录提供在腾讯云新增独立 HTTPS 预览站的配置模板。预览使用 Folio Web 版和现有 `/api/forme`。线上模型配置使用为 Demo 单独创建的标准 API Key。

## 在腾讯云准备预览

1. 核对云主机的内存、磁盘和可用端口，为 Demo 选择独立域名，按主机所在地区核对腾讯云的域名接入要求。将域名指向主机并为该域名签发 HTTPS 证书。
2. 创建 `folio-demo` 服务用户，将审查后的发布包放到 `/opt/folio-demo/releases/<version>`，运行 `npm ci`，把 `/opt/folio-demo/current` 指向这一版。主机应安装 Node.js 22。服务文件中的 `/usr/bin/node` 应指向这套运行时。
3. 为 Demo 创建独立且兼容 Upstash REST API 的 Redis 实例。将 `folio-demo.env.example` 复制到 `/etc/folio-demo.env`，设置所有者为 `root`，文件权限设为 `0600`，然后在服务器上填入专用模型 Key、会话签名密钥和 Redis 凭据。由 systemd 读取配置。替换模型时使用对应的应用 API 和该 Demo 专用的 Key。
4. 安装 `folio-demo.service`。本机进程监听 `127.0.0.1:4186`。应用静态资源来自发布包的 `site/`，会话接口来自同一服务。用 `systemctl daemon-reload` 和 `systemctl enable --now folio-demo` 启动。
5. 把 `nginx-preview.conf.example` 中的示例域名、证书路径和预览密码文件替换为实际值，作为独立站点加入 Nginx 的 `http` 配置。`nginx -t` 通过后重新加载 Nginx。

## 预览验收

- 用浏览器核对 HTTPS、静态页面、匿名返回 `401`、预览登录后会话接口返回 `enabled: true`，以及两个浏览器会话的收藏互相独立。
- 通过短文本做一次真实模型验证。使用应用界面操作，检查结果和引用。检查服务日志仅有请求状态或诊断 ID，浏览器的资源、请求和响应中找不到模型 Key。
- 在开放匿名访问前，补齐文本入口限制、访客额度和停用开关的验收。当前 Nginx 模板按连接 IP 限制请求速率，应用自身在 Nginx 后会把请求计入同一个分钟额度。预览仍按独立实例的全站每日额度计数。应验证应用的访客限额能区分代理后的独立访客，再开放公开额度。
- 需要暂停新的模型调用时清空 `/etc/folio-demo.env` 中的 `ZHIPU_CODING_API_KEY`，重启 `folio-demo` 服务。确认会话端点报告 `enabled: false`，浏览器仍可打开工作台。旧会话的请求结果可能继续从缓存返回，需停止全部 API 流量时可在 Nginx 暂停 `/api/forme`。回滚应用时切回 `/opt/folio-demo/current` 的上一版本并重启服务。

智谱的变量名沿用现有服务读取的配置键。模板将端点设为智谱标准 API。模型名称以该 Key 的权限为准。

## 在腾讯云提供公开样例体验

沿用当前 HTTPS 站点，在 `/folio-demo/try/` 打开 Folio 工作台。工作台通过只读 `/folio-demo/api/library` 加载客户端预置的收藏、展览和读稿。手记和阅读设置保存在当前浏览器。文字整理通过同源 `/folio-demo/api/forme` 提交固定样例，结果按匿名签名会话缓存最多 24 小时。模型尚未配置时仍可浏览示例馆。

用两个独立的 systemd 服务部署。应用服务监听 `127.0.0.1:4186`，账本 Worker 仅监听 `127.0.0.1:8791`。Nginx 只代理应用服务，旧站点的路由和 Worker 保持原配置。应用在受信任的本机代理模式下使用 Nginx 写入的访客地址，额度账本记录加密散列。

1. 检查端口和 HTTPS 站点配置。创建 `folio-public-demo` 和 `folio-public-ledger` 两个服务用户。将审查后的源码部署到 `/opt/folio-public-demo/releases/<version>`，把 `/opt/folio-public-demo/current` 和 `/opt/folio-public-ledger/current` 指向该版本。确认 unit 中的 Node 路径指向 Node.js 22 或更高版本。
2. 将两个 `*.env.example` 模板分别复制到 `/etc/folio-public-demo.env` 与 `/etc/folio-public-ledger.env`，权限设为 `0600`。生成两个独立的至少 32 字符随机值，分别用于应用的 `FOLIO_PUBLIC_SESSION_SECRET` 和两份环境文件匹配的 Worker 令牌。将专用智谱标准 API Key 直接填入应用服务的 `FOLIO_PUBLIC_MODEL_API_KEY`。模型留空时服务以浏览模式运行。
3. 安装 `folio-public-demo.service` 和 `folio-public-ledger.service`。`systemctl daemon-reload` 后，执行 `systemctl enable --now folio-public-ledger folio-public-demo`。systemd 为账本服务创建 `/var/lib/folio-public-ledger`。将 `nginx-public-demo.location.example` 复制为 `/etc/nginx/snippets/folio-public-demo-location.conf`，只在现有 HTTPS `server` 块增加一条 `include /etc/nginx/snippets/folio-public-demo-location.conf;`。执行 `nginx -t` 通过后重载。
4. 验收 `/folio-demo/try/` 的首页、收藏、展览、预设读稿和配图。确认 `/folio-demo/api/library` 只接受 GET 和 HEAD，且 `/folio-demo/api/desktop/state` 返回 `404`。使用两个独立浏览器会话检查结果隔离和原文引用。未配模型时会话报告 `enabled: false`。超过额度时返回 `429`，账本不可用时返回 `503`。真实模型验收会消耗一个请求额度。

全站每 UTC 日最多发起 30 次模型请求，`FOLIO_PUBLIC_DAILY_LIMIT` 可设为 1–30。当前浏览器会话当天重复点击复用结果。清空模型 Key 并重启 `folio-public-demo` 可切回浏览模式。回滚时切回两个 `current` 链接的上一版本并重启这两个服务，也可移除专用 Nginx 路由后重载。
