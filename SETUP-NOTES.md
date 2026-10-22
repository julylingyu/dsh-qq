# qq-bridge / dsh-qq 部署笔记（给下一个 DSH 会话看）

> 这个会话装完就换人了，所有关键信息落在这里。新会话开始时先读本文件。

## 这是什么

- 仓库：`E:\dsh\dsh-qq`（github.com/h-D-ACE/dsh-qq，qq-bridge 的二次开发）
- 作用：把 QQ（SnowLuma → OneBot v11）接到本机 DSH（桌面版），让 AI 在群里聊天
- QQ 机器人账号：`1822268646`（昵称 流火与风）；管理员 ownerQQ：`1718675873`；白名单群：`310723364`
- DSH profile：`C:\Users\15031\.dsh\profiles\desktop`（setup-dsh 已装 preset `qq-chat-v2`、MCP `mcp-snowluma`/`mcp-snowluma-host`/`mcp-web-search-safe`、bundle `qq-mode-console`/`qq-agent-presets`）

## 怎么启动（按顺序）

1. QQ 后端：SnowLuma 在 `E:\SnowLuma`（v2.1.1 lite，自带 Node 26.12.1 在 `E:\SnowLuma\node\`，`launcher.bat` 已改用它）
   - 启动：双击 `E:\SnowLuma\launcher.bat`（或 `E:\SnowLuma\node\node.exe E:\SnowLuma\index.mjs`）
   - WebUI：http://127.0.0.1:5099 （账号 admin，密码在 `E:\SnowLuma\config\webui.json` 里是哈希；首次启动日志有初始密码）
   - 该账号要开 OneBot：WS 服务端 `127.0.0.1:3001`、HTTP API `127.0.0.1:3000`（配置在 `E:\SnowLuma\config\onebot_1822268646.json`）
2. 桥接：`cd E:\dsh\dsh-qq; node src\bridge.js`（当前以隐藏窗口后台跑）
   - 桥接控制台：http://127.0.0.1:3100 ，令牌在 `state/console-token`
   - 日常建议用 `control-center.bat`（控制中心，3099）统一启停；别同时用 start.bat，会撞单实例锁
3. DSH 桌面版常驻；桥接会自动发现 DSH 地址（随机端口）并重连

## 配置要点（config.json）

- `ownerQQ: 1718675873`、`allow.groups: ["310723364"]`、`allow.private: ["1718675873"]`
- `dsh.provider: deepseek-account`、`model: deepseek-flash`、`reasoningEffort: high`
- `snowluma.homeDir: E:\SnowLuma`、`launcherPath: E:\SnowLuma\launcher.bat`
- 唤醒已按用户要求调低：`socialV2.wake.recommendedProbability 0.03`、`batchWindowMs 12000`、`maxWakePerHour 8`、`recommendedSleepMinMs 600000`
- 视频：`socialV2.media.video`（enabled、ffmpegPath `E:/Program Files/oopz/ffmpeg.exe`、frames 6、maxWidth 720、maxBytes 50MB）
- 角色卡：`state/current-role.json` = `{"role":"流火与风","mode":"active"}`，卡在 `roles/流火与风.md`

## 本仓库自己改过的功能（不是上游）

1. **QQ 视频抽帧看画面**（新增）
   - `src/video-frames.mjs`：ffmpeg 均匀抽帧 → JPEG；带超时/临时目录清理；`npm run test:video` 可回归
   - `src/safe-fetch.js`：新增 `safeFetchBinary()`（同样 SSRF/大小/跳转防护，但不校验图片签名）
   - `src/bridge.js`：
     - `video` 段 + **伪装成 image 段的 QQ 短视频**（URL 带 `appid=1415`/`orgfmt=t264`）都识别为视频
     - `resolveMediaList` / `fetchMediaData` 对视频抽帧后当图片交给视觉模型
     - **引用消息的媒体并入当前消息**（引用视频再 @ 也能看到）
     - **唤醒时自动内联未读里最近 5 个媒体**（不再只靠模型调 `qq_get_message_images`）
     - 抽帧结果缓存 10 分钟
   - `src/mcp-snowluma-safe.js`：`qq_get_message_images` 描述/标签支持视频帧
   - 文档：`docs/guides/CONFIGURATION.md` 的 `socialV2.media.video`
2. **人格卡**：`roles/流火与风.md`（DSH 这边起草，已启用）
3. `package.json` 加了 `test:video` 脚本

## 已知环境问题

- **沙箱模式下 pwsh 起不来**（退出码 0xC0000142）；plwsh 在 danger-full-access 下正常。排查/操作 Shell 时用 full access。
- DSH 桌面版每次重启端口会变，桥接能自动发现，不用手改。
- SnowLuma 启动后第一次 WS 连接常失败一次（1006）属正常，会自动重连。
- 机器人偶尔会说「看不了视频/抽不了帧」——那是模型自我认知，真正抽帧在桥接侧；先查 `_bridge.log` 里有没有 `[video]` / `内联媒体` 行。

## 日志/备份

- 桥接：`E:\dsh\dsh-qq\_bridge.log`、`state/bridge.log`、工具调用 `state/tool-calls.jsonl`
- profile 变更前备份：`C:\Users\15031\.dsh\profiles\desktop\package.json.bak-20261022-225248`、`cordis.patch.yml.bak-20261022-225248`
- SnowLuma 日志：`E:\SnowLuma\logs\`
