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
