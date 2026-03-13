# Codex WSL Proxy (systemd 常驻版)

这个项目在 WSL 中提供一个本地代理：
- 对外提供 OpenAI 兼容路径：`http://127.0.0.1:17777/openai/v1`
- 对上游转发到 Azure OpenAI：`https://pmagent2.openai.azure.com/openai/v1`
- 认证使用 `DefaultAzureCredential`（Entra ID），不依赖 API Key

## 1. 前提条件

- WSL 已启用 `systemd`
- 已安装 Node.js（当前机器使用 nvm）
- 你已经完成 Azure 登录（你目前已 `az login`）
- Codex 配置指向代理：`/root/.codex/config.toml`

## 2. 一次性安装 systemd 服务

在项目根目录执行：

```bash
cd /root/codexproxy
chmod +x scripts/install-systemd-service.sh
sudo ./scripts/install-systemd-service.sh
```

安装脚本会做这些事：
1. 复制 service 文件到 `/etc/systemd/system/codexproxy.service`
2. 生成（或更新）环境变量文件 `/etc/default/codexproxy`
3. 执行 `systemctl daemon-reload`
4. 执行 `systemctl enable --now codexproxy.service`

## 3. 日常运维命令

查看服务状态：

```bash
systemctl status codexproxy.service --no-pager
```

重启服务：

```bash
sudo systemctl restart codexproxy.service
```

停止服务：

```bash
sudo systemctl stop codexproxy.service
```

启动服务：

```bash
sudo systemctl start codexproxy.service
```

开机自启开关：

```bash
sudo systemctl enable codexproxy.service
sudo systemctl disable codexproxy.service
```

## 4. 如何改 Azure Endpoint

编辑环境文件：

```bash
sudo editor /etc/default/codexproxy
```

重点变量：

- `UPSTREAM_AOAI_BASE_URL`：改成新的 Azure OpenAI endpoint（必须带 `/openai/v1`）
- `AZURE_OPENAI_SCOPE`：默认保持 `https://cognitiveservices.azure.com/.default`
- `LISTEN_HOST` / `LISTEN_PORT`：本地监听地址和端口

示例：

```env
UPSTREAM_AOAI_BASE_URL=https://<your-new-resource>.openai.azure.com/openai/v1
```

修改后生效步骤：

```bash
sudo systemctl daemon-reload
sudo systemctl restart codexproxy.service
```

然后验证：

```bash
curl -sS http://127.0.0.1:17777/healthz
curl -sS -w '\nHTTP_STATUS=%{http_code}\n' http://127.0.0.1:17777/readyz
```

## 5. 怎么看错误日志（重点）

看最近 200 行：

```bash
journalctl -u codexproxy.service -n 200 --no-pager
```

实时跟踪：

```bash
journalctl -u codexproxy.service -f
```

只看 error 级别（systemd priority）：

```bash
journalctl -u codexproxy.service -p err --since today --no-pager
```

按时间窗口查：

```bash
journalctl -u codexproxy.service --since "10 min ago" --no-pager
```

只看本次启动后的日志（避免被历史报错干扰）：

```bash
journalctl -u codexproxy.service --since "5 min ago" --no-pager
```

## 6. 常见问题

### Q1: `status` 里提示找不到 Node

原因：`NODE_BIN` 指向旧版本 nvm 路径。

处理：

```bash
command -v node
sudo editor /etc/default/codexproxy
# 更新 NODE_BIN 为 command -v node 输出
sudo systemctl restart codexproxy.service
```

### Q2: `/readyz` 返回 503，`credential_unavailable`

原因：`DefaultAzureCredential` 当前无法在 WSL 中拿到 token。

处理：
1. 在 WSL 内确认 Azure 登录状态：`az account show`
2. 必要时重新登录：`az login`
3. 重启服务：`sudo systemctl restart codexproxy.service`
4. 再看日志定位：`journalctl -u codexproxy.service -n 200 --no-pager`

### Q3: 想恢复默认配置模板

模板文件在项目内：
- `deploy/codexproxy.service`
- `deploy/codexproxy.env.example`

重新安装：

```bash
cd /root/codexproxy
sudo ./scripts/install-systemd-service.sh
```

### Q4: 日志里出现 `EADDRINUSE: 127.0.0.1:17777`

原因：端口已被其他进程占用（常见是之前手动 `node src/index.js` 没停）。

处理：

```bash
ss -ltnp | rg 17777
sudo pkill -f "node src/index.js"  # 只在确认是旧手动进程时执行
sudo systemctl restart codexproxy.service
```

## 7. 关键文件

- Service 模板：`/root/codexproxy/deploy/codexproxy.service`
- 环境变量示例：`/root/codexproxy/deploy/codexproxy.env.example`
- 安装脚本：`/root/codexproxy/scripts/install-systemd-service.sh`
- 实际生效的环境变量：`/etc/default/codexproxy`
- systemd unit：`/etc/systemd/system/codexproxy.service`
