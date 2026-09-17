# AGENTS.md — zcode-webui 项目约定

## 发布流程（GitHub + npm，已验证可用）

发布 = 版本号 bump + release 提交 + 推送 GitHub + npm 发布。按顺序执行：

1. **确认工作区干净**：`git status --short` 必须为空（运行时文件已被 .gitignore 覆盖）。
2. **跑发布前检查**：`npm run prepublishOnly`（各入口文件的语法检查）。
3. **bump 版本号**：改 `package.json` 的 `version`。含新功能升 minor，纯修复升 patch。
4. **release 提交**：`git commit -m "chore: release vX.Y.Z"`。
5. **推送 GitHub**：`git push origin main`（remote 是 windviki/zcode-webui）。
6. **npm 发布**（scoped 包，镜像源发不出去，必须切官方源，发完切回来）：
   ```bash
   nrm use npm            # 切到官方 registry（当前日常用的是 taobao 镜像）
   npm whoami             # 确认登录态（应为 windviki）
   npm publish --access public   # scoped 包必须 --access public，否则发不出去
   nrm use taobao         # 发布完切回镜像，否则日常安装会走官方源变慢
   npm view @aixyzstudio/zcode-webui version   # 确认线上版本
   ```
7. （本机部署时）`./zcode-service.sh restart` 让服务跑新代码。注意 `/api/health`
   的 `version` 字段是进程启动时读的，重启后才会显示新版本号。

## 自我点火重启（标准流程，用户说「自我点火」即指此流程）

场景：agent 会话本身就跑在要重启的 server 里（server → zcode-server → zcode-cli → 工具 shell 全是一条
进程树）。**直接跑 `./zcode-service.sh restart` 会出事**：stop 杀掉 server 时，作为它后代的 agent、
shell、以及正在执行的 restart 脚本会一起死，`start` 永远执行不到，服务就此挂掉。

正确做法是把重启脚本本身脱离进程树，让它替我们"点火"：

1. **确认安全窗口**：无进行中任务——`/api/background` 的 `activeCount` 为 0，且
   `~/.zcode/v2/tasks-index.sqlite` 的 `tasks.task_status` 无 running 类状态。用户明说重启时可跳过。
2. **写延迟重启脚本**（如 `/tmp/zwebui-selfrestart.sh`）：
   ```bash
   #!/usr/bin/env bash
   sleep 30        # 留时间让最终消息送达浏览器
   cd /home/coder/dsh-projects/zcode-webui || exit 1
   ./zcode-service.sh restart
   ```
3. **setsid 脱离启动**（关键步骤）：
   ```bash
   setsid nohup bash /tmp/zwebui-selfrestart.sh > /tmp/zwebui-selfrestart.log 2>&1 < /dev/null &
   ```
4. **验证脱离**：`ps -o pid,ppid,sess,cmd -p <pid>` 必须显示 `PPID=1` 且 `SESS` 等于自身 pid
   （独立 session）。不满足则不得继续。
5. **立即发出最终消息**：当前会话会随旧服务一起被终止，这是预期行为，消息里要提醒用户
   重启完成后刷新页面（拿到新渲染层）。`zcode-service.sh start` 本身也用 `setsid nohup`
   拉起新服务，所以重启后的服务天然脱离旧树。

配套经验：升级官方渲染层/运行时用 `./zcode-update.sh`（见下节；`node src/cli.mjs upgrade --yes`
是 npm 安装形态下的等价入口）；旧运行时自动备份在 `~/.zcode/server.bak-*`，渲染层备份在
`vendor/renderer.bak-*`，回滚改名或跑 `./zcode-update.sh --rollback` 即可。

## 官方组件更新（标准流程，用户说「更新/升级」即指此流程）

`./zcode-update.sh` 把「拉包 → 解包 → 校验 → 原子替换 → 重启 → 校验」整条链路做在一个 sh 脚本里
（与 `src/upgrade.mjs` 部署的东西完全一致，只是纯 shell 实现）：

```bash
./zcode-update.sh              # 探测最新版本并更新，装完自动重启 + 校验
./zcode-update.sh --check      # 只看版本（当前 / 官网 / CDN）
./zcode-update.sh -v 3.12.3    # 指定版本（显式指定会绕过「shim 支持上限」的判断）
./zcode-update.sh --stable     # 只跟官网公布版本，不采用 CDN 上更新的构建
./zcode-update.sh --rollback   # 回滚到最近一次更新前的备份
```

要点：

1. **版本以 CDN 为准**：官网 changelog/install 页常比 CDN 慢一步，脚本先读官网当基线，再向上探测
   CDN 上真实存在（manifest + deb 都在）的最高版本，不一致时会提示。
2. **资源预检**：动服务之前先把本次要用的 .deb / 组件全部 HEAD 一遍，避免升到一半才发现 404。
   组件 tarball 路径里的 `+` 必须编码成 `%2B`，否则 CDN 按空格处理直接 404。
3. **原子替换 + 备份**：渲染层 `vendor/renderer.bak-<旧版本>-<ts>`，运行时
   `~/.zcode/server.bak-<旧版本>-<ts>`（各留 2 份），staged 目录校验通过才 `mv` 就位。
4. **强制校验**：版本对齐 → `/api/health` → `scripts/smoke-test.mjs`（WS/HTTP 协议桥）→
   `scripts/ui-boot-check.mjs`（headless Chromium 真跑官方渲染层）。任一失败，**默认自动回滚**并再校验一次
   （`--no-auto-rollback` 可关）。
5. **shim 支持上限**：`SHIM_MAX_SUPPORTED`（脚本与 `src/upgrade.mjs` 各一份）为 **3.12.3**，
   超过它的版本不自动升，只提示（显式 `-v` 可试装，装完照样校验界面）。

### 3.12.x 适配（2026-09-17 完成）

官方 3.12 起渲染层的启动条件变了，两处都要对上，否则界面停在「未能收到启动状态
/ 诊断 ID: startup-channel-unavailable」：

1. **服务端口消息改成对象**：`{type:'zcode:service-port', databaseStartupId}`（3.11 及更早只认裸字符串
   `'zcode:service-port'`）。
2. **必须再收到「数据库启动通道」状态**：`{type:'zcode:database-startup-state', state}`，其中
   `state.phase === 'ready'` 且 `state.startupId === databaseStartupId`（schema 是 strict object：
   schemaVersion/startupId/attemptId/sequence/startedAt/updatedAt/phase/disk 必填）。
   桌面端主进程负责开库/迁移并上报进度；本项目里数据库由官方运行时自己管，所以直接报 ready。

`web/bootstrap.js` 按 `cfg.rendererVersion`（server.mjs 注入）二选一，3.11 与 3.12 都能跑；
`state` 连发两次躲开「监听器与 `__ZCODE_RENDERER_START__` 同一次模块执行」的竞态。
协议桥本身没变（smoke 测试对 3.12 也是全绿），所以**必须靠 `scripts/ui-boot-check.mjs` 真跑浏览器**才看得出好坏。

### 3.12.x 的 CLI 依赖：内置 provider 配置（关键）

官方 3.12 的 `zcode.cjs` 启动时会解析「CLI ZCode Built-in Provider Config」，只认两处：

1. `<runtime>/agents/glm/provider/zcode-builtin.json`（桌面端把它跟 CLI 一起打包，**服务器运行时组件不含**）
2. `<entry 上溯 5 级的父目录>/config/provider/zcode-builtin.json`（本机解析成 `/home/config/...`，用不上）

缺了这个文件，`zcode.cjs login` 与 `zcode.cjs app-server`（host 起 agent 用的入口）都会**直接退出**：
`无法定位 CLI ZCode Built-in Provider Config：…`。换句话说 3.12 上登录做不了、agent 也起不来
（协议往返类测试发现不了——continuity/smoke 都不跑 agent）。

修法：`src/host.mjs` 的 `ensureCliProviderConfig()` 把 host 自己物化出来的
`<dataRoot>/v2/runtime/provider/bundled/zcode-builtin.json` 复制到 CLI 期望的位置，
只在该文件缺失时写（不覆盖官方自带的）。调用点两处：server 启动时、以及每次 host 握手成功后
（agent 一定在握手之后才 spawn），所以换运行时、清 v2 目录都能自愈。

### 3.12.x 的模型可用性（不是 bug，是官方新行为）

3.12 起模型可用性走**服务端 entitlement 校验**（provider 身份变成 `account:*`）：

- 3.11.2：直接信任本机 `~/.zcode/cli/config.json` 里的 API key（日志 `codingPlanApiKey:builtin:...`），
  所以界面能列出 GLM-5.3。
- 3.12.3：先查 `https://zcode.z.ai/api/v1/zcode-plan/billing/balance`，本机账号返回
  `plans: []`（`hasActiveStartPlan:false`）→ 日志 `[usage-stats] 读取 BigModel entitlement 未找到可用授权`
  → 界面显示「当前没有可用模型。请开通编程套餐或配置自定义模型。」（模型列表为空）。

**处理办法**：在界面「管理模型 → 添加自定义模型」里填本地 API key（官方给的路子），或续费/绑定套餐；
想回到「认本地 key」的旧行为就 `./zcode-update.sh --rollback` 退回 3.11.2（备份已在，一条命令）。
另外 3.12 渲染层还会请求 `window-controller` 通道（桌面端主进程服务，本项目不提供，日志里会刷
`Unknown channel: window-controller`）——已确认不影响启动与协议往返。

### 版本钉位

- 本机部署：**3.12.3**（`zcode-update.sh` 的 `PINNED_VERSION`、`scripts/fetch-renderer.sh` 的
  `ZCODE_VERSION` 默认值、`src/upgrade.mjs` 的 `DEFAULT_VERSION`、README 里的默认值，四处一起改）。
- shim 支持上限：**3.12.3**（`SHIM_MAX_SUPPORTED`，两处：`zcode-update.sh` 与 `src/upgrade.mjs`）。
  超过上限的版本默认不升，只提示；显式 `-v` 仍可试装，装完照常校验、起不来自动回滚。

## 其他约定

- 提交信息风格：`feat:` / `fix:` / `chore:` 前缀，正文写动机和要点（参考 `git log`）。
- 运行时产物（`*.log*`、`*.pid`、`config.json`、`data/`、`vendor/renderer/`）均已 gitignore，不要提交。
- 服务由 `zcode-service.sh {start|stop|restart|status|health|logs}` 管理，PID 记录在 `.service.pid`。
  该脚本可直接 `source`（`zcode-update.sh` 就是这么复用端口解析与启停函数的），被 source 时不分发子命令。
