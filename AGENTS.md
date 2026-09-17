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
5. **shim 支持上限**：`SHIM_MAX_SUPPORTED`（脚本与 `src/upgrade.mjs` 各一份）默认 **3.11.2**，
   超过它的版本不自动升，只提示。原因见下条。

### 3.12.x 暂不支持（重要）

官方 3.12.0 起的渲染层要求桌面端下发 `window` message `zcode:database-startup-state`
（常量在渲染层 `assets/src-*.js`）+ 一个 MessagePort 的「数据库启动通道」，等不到就在 30 秒后渲染
「未能收到启动状态 / 诊断 ID: startup-channel-unavailable」。协议桥（WS/HTTP）本身是好的，
所以 **smoke 测试会全绿，只有真跑浏览器才看得出来**——这正是 `ui-boot-check.mjs` 存在的理由。
要支持 3.12.x，必须按该协议补齐 `web/zcode-bridge.js` 的启动通道（含 state 校验与端口语义）。

- 2026-09-17 实测：3.12.3 装上后界面停在上面的失败页 → 脚本自动回滚回 3.11.2。
- `node src/cli.mjs upgrade` 已加同一道闸：目标版本 > `SHIM_MAX_SUPPORTED` 时直接拒绝（`--force` 可越）。
- 因此本机部署的钉住版本仍是 **3.11.2**（`scripts/fetch-renderer.sh` 的 `ZCODE_VERSION` 默认值、
  `src/upgrade.mjs` 的 `DEFAULT_VERSION`、`zcode-update.sh` 的 `PINNED_VERSION`，
  三处 + README 里的默认值要一起改）。

## 其他约定

- 提交信息风格：`feat:` / `fix:` / `chore:` 前缀，正文写动机和要点（参考 `git log`）。
- 运行时产物（`*.log*`、`*.pid`、`config.json`、`data/`、`vendor/renderer/`）均已 gitignore，不要提交。
- 服务由 `zcode-service.sh {start|stop|restart|status|health|logs}` 管理，PID 记录在 `.service.pid`。
  该脚本可直接 `source`（`zcode-update.sh` 就是这么复用端口解析与启停函数的），被 source 时不分发子命令。
