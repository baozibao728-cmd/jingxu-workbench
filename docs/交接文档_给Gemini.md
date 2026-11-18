# 镜序工作台交接文档（给 Gemini）

写于 2026-11-18，当前版本 1.5.10。先通读本文，再看 `docs/前端交接文档_给Claude.md`（界面结构、函数名、已完成功能的细节都在那里，内容同样适用）。

## 1. 项目是什么

镜序是一个本机运行的短剧制作工作台：剧本 → 拆分镜 → 生成人物/场景/道具图 → 生成分镜视频 → 配音 → 合成整集。另有“自由创作”（单条生图/生视频）和“画布”（节点连线式创作）。用户在网页里操作，后端调用各家 AI 厂商的接口。

- 目录：`/Users/zoro/Documents/视频号视频制作/短剧工作流`
- 技术栈：Node.js（≥22.9）原生 HTTP 服务 + 原生 JavaScript + 原生 CSS。没有前端框架，没有 npm 依赖，没有构建步骤。
- 地址：`http://127.0.0.1:6040/`
- 公开仓库：`baozibao728-cmd/jingxu-workbench`，其他人的电脑通过 GitHub Release 自动更新。
- 用户用中文交流，回复请用中文，少用术语。用户很在意界面质感和动画流畅度。

## 2. 必须遵守的规则（用户原话）

- 不要打印 Key，不要将 Key 复制到文档、截图、提交信息或远程仓库
- 不要把 Key 写进源码、README、更新包或 GitHub
- 不要对真实项目自动触发图片、视频或语音生成测试（会花用户的钱；测试一律用假的 fetch）
- 不要删除旧的项目、媒体、历史和厂商方案
- 更新包不能包含 `.env`、`data/`、`outputs/` 或任何 Key
- 保持原生 JavaScript，不引入 React、Vue 或构建步骤
- 所有用户文本必须经过 `escape()` 再放进 HTML

补充：
- Key 存在 `.env` 和 `data/projects/provider-settings.json`，只能在代码里读取使用，不能输出到终端。读数据文件排查问题时，要过滤掉名字含 key/token/secret 的字段。
- 用户截图里曾出现过真实 Key（萤漫 `sk-mc-…`、Scenetra `scnk_…`），绝不能使用或抄写。
- 新增前端文件时，要同步加到 `src/server.js` 的静态白名单。
- 前端用事件委托（`data-action`），不要给每张卡片单独绑事件。

## 3. 目录速览

| 位置 | 作用 |
|---|---|
| `src/server.js` | HTTP 服务、路由、静态文件、启动后后台安装 FFmpeg |
| `src/workflow.js` | 剧本流水线核心：资产、分镜、视频提交/轮询/下载、`errorText()`、`pollTask()` |
| `src/studio.js` | 自由创作和画布的生成任务 |
| `src/providers.js` / `src/http.js` | 文字/图片厂商调用、`ApiClient`、`downloadResult()`（下载成片） |
| `src/custom-providers.js` | 按协议创建视频厂商：`fydmai`、`openai-video`（萤漫）、`huimiao`、`scenetra`、`json`；`referenceTag()` 决定提示词里怎么引用参考图 |
| `src/scenetra.js` | Scenetra 视频渠道：13 个模型族的参数表、参考素材传公开临时图床、提交前免费校验（dry-run） |
| `src/huimiao.js` | 惠喵视频渠道：自己的直传上传、幂等键提交、下载时跳转到别的域名不带 Key |
| `src/provider-settings.js` | 厂商预设目录（文字/图片/视频）和配置校验 |
| `src/provider-test.js` | 接口设置里的“测试连接”（只读，不生成） |
| `src/ffmpeg-tools.js` | 自动下载、校验 FFmpeg 到 `data/tools/ffmpeg/` |
| `src/storyboard-reparse.js` / `src/script-chunks.js` | 全部重新解析分镜、长剧本分段 |
| `src/update-manager.js` | 自动更新（从 GitHub Release 下载、校验 SHA-256、备份、回滚） |
| `public/app.js` | 主界面（单页状态渲染） |
| `public/canvas.js` | 画布（平移缩放、连线、流光、边缘自动跟随） |
| `public/studio.js` | 自由创作页 |
| `public/settings-ui.js` | 接口设置弹窗 |
| `public/style.css` | 全部样式（玻璃质感主题、夜间模式） |
| `test/*.test.js` | Node 自带测试，共 124 个 |
| `data/` | 用户数据（项目、媒体、历史、厂商方案），**不要删、不要提交、不要打包** |

## 4. 日常操作

```bash
npm test
```
改完代码必须跑，全部通过才能提交。

重启工作台（先确认没有任务在跑）：
```bash
curl -s http://127.0.0.1:6040/api/concurrency
```
`running` 和 `queued` 都是 0 才能重启，否则会打断用户的生成任务。
```bash
kill $(lsof -ti tcp:6040 -sTCP:LISTEN); open 启动工作台.command
```

## 5. 发布流程

工作分支是 `frontend-glass-theme`，`main` 是发布分支。

1. 改 `package.json` 的 `version`。
2. 在 `docs/公开发布与自动更新.md` 末尾加这一版的中文更新说明，并把第 3 行“当前版本”改掉；`docs/前端交接文档_给Claude.md` 里的“当前本机版本”也同步改。
3. `npm test` 全部通过。
4. `python3 scripts/package-public.py`，生成到 `outputs/`。
5. 检查两个 zip：不能有 `.env`、`data/`、`outputs/`，不能有任何真实 Key（`sk-`、`scnk_`、`hm_live_` 开头的长串）。
6. 提交 `Release X.Y.Z`，然后：
   ```bash
   git checkout main && git merge --ff-only frontend-glass-theme && git tag vX.Y.Z && git push origin main vX.Y.Z && git checkout frontend-glass-theme
   ```
7. GitHub Actions（`release.yml`）会自动测试、打包、发布。到 `https://api.github.com/repos/baozibao728-cmd/jingxu-workbench/releases/tags/vX.Y.Z` 确认有附件。附件名里的中文会被 GitHub 去掉，这是正常的。

只有用户说“发布”“推送”时才发版。

## 6. 最近做了什么（1.5.0 ～ 1.5.3）

- **1.5.0 画布**：节点连线、成组、音视频节点、分离音视频、截取音频。
- **1.5.1**：没有 FFmpeg 的电脑会在后台自动下载安装（ffmpeg-static b6.1.1，固定了各系统的大小和 SHA-256）。
- **1.5.2**：
  - 新增 Scenetra、惠喵两个视频渠道，以及悟空 API（wkapi）文字预设。
  - 修复 Windows 上“全部重新解析分镜”中断：文字调用至少等 10 分钟，超时的长段自动拆小，失败时显示真实原因。
  - 画布拖线时边缘跟随变慢，流光改成细而清晰的蓝光。
- **1.5.3**：
  - 查进度时遇到断网、5xx、429 会重试约 3 分钟，不再把已提交的任务直接判成失败（`workflow.pollTask()`）。
  - 下载成片改为“2 分钟没收到数据才算断开”，最多重下 3 次，并且边下边写到硬盘。
  - 返回的 JSON 只写了一半时，会自动拆小那一段再解析。

### Scenetra 渠道要点

- 它的接口只收图片/音频的公网链接，所以参考素材会先传到公开临时图床：先用 uguu.se（3 小时后失效），失败再用 tmpfiles.org（1 小时）。
- 国内网络可能连不上这两个图床，需要代理。用户已知晓，并且同意了图片会公开 1～3 小时。
- 提交前先调一次免费的 dry-run 校验。校验连不上就不提交，也不扣积分。
- 已用真实 Key 验证过：上传 7 张参考图、提交、出片都成功；下载因为太慢而超时，这个问题 1.5.3 已经修了。

### 惠喵 / wkapi

- 都还没有用真实 Key 验证过。
- 惠喵的清晰度默认只给 720p；“测试连接”会读 `/v1/models`，报出模型实际支持的清晰度。

## 7. 待办和需要留意的

1. 等朋友那台 Windows 电脑更新到 1.5.3 后，确认“全部重新解析分镜”不再报错。
2. 惠喵和 wkapi 等用户真实测试，有报错再修。
3. Scenetra 成片下载链接是否需要带认证、多久过期，都还没确认。目前按公开链接下载。
4. 自由创作里那张“待核对”（11/17 05:11）卡片：用户已确认 Scenetra 后台没有这条任务，可以删掉。

## 8. 写代码的习惯

- 风格紧凑：短函数、少空行，和现有代码保持一致。
- 注释用中文，写“为什么”。
- 报给用户的错误一律用中文，并说明下一步该怎么做（例如“可以点‘继续查询’”），不要显示英文原始报错。
- 已提交到厂商的任务要先记下任务号，断线后用“继续查询”接着查，绝不能重复提交、重复扣费。
- 新厂商的接入方式：
  - 写一个 `XxxVideoProvider` 类，实现 `uploadImage`、`submit`、`getTask`，可选实现 `uploadAudio`、`downloadTask`；
  - 在 `custom-providers.js` 按协议创建这个类；
  - 在 `provider-settings.js` 加预设；
  - 在 `provider-test.js` 加只读的连接测试；
  - 在 `settings-ui.js` 加协议名和提示；
  - 用假的 fetch 写测试（参考 `test/huimiao.test.js`、`test/scenetra.test.js`）。
