# 镜序短剧工作台前端交接文档

## 1. 项目概况

- 项目目录：`/Users/zoro/Documents/视频号视频制作/短剧工作流`
- 技术栈：Node.js 原生 HTTP 服务 + 原生 JavaScript + 原生 CSS，无前端框架和 npm 依赖
- 启动命令：`npm start`
- 本机地址：`http://127.0.0.1:6040/`
- 当前本机版本：`1.5.7`
- 前端入口：`public/index.html`、`public/app.js`、`public/style.css`
- 设置页组件：`public/settings-ui.js`
- 图片查看器：`public/image-viewer.js`
- @ 引用菜单：`public/mentions.js`

后端会以静态文件方式提供前端资源。新增前端文件时，需要同步检查 `src/server.js` 的静态白名单。

## 2. 当前界面结构

`public/app.js` 使用单页状态渲染，主要页面状态为：

- `state.screen === 'editor'`：单个剧本工作区
- `state.screen === 'library'`：剧本库，可进入选择模式并多选删除
- `state.screen === 'voice'`：MiniMax 语音工作台

核心渲染函数：

- `sidebar()`：左侧导航、最近项目、剧本库和语音工作台入口
- `projectLibrary()`：剧本库卡片和选择模式
- `scriptSection(project)`：剧本输入、风格、画幅、时长、自动语音、失败重试、视频渠道
- `assetsSection(project)`：资产分类、图片模型、资产卡片和批量生成
- `assetCard(asset)`：人物、场景、道具、分镜图卡片
- `storyboardsSection(project)`：分镜卡片、提示词、参考图、音频、视频状态
- `openSettings()`：接口配置、系统提示词、软件更新
- `voiceStudio()`：MiniMax TTS、音色、音频历史

当前页面使用事件委托。大多数按钮使用 `data-action`，不要为每张卡片单独绑定大量事件。

## 3. 已完成的产品功能

### 剧本和分镜

- 先分析剧本并列出资产清单，用户勾选后才生成图片
- 资产生成、分镜生成、视频生成分开确认
- 可跳过人工检查，自动串联后续流程
- “全部重新解析分镜”保留旧分镜、旧成片和历史
- 单个分镜现在使用“重新生成提示词”
  - 只更新当前分镜
  - 只返回一条分镜
  - 保留台词、参考图和其他分镜
  - 不再要求前后衔接确认
  - AI 改动台词或返回多条时保留旧分镜
- 整剧重新解析会自动缩小长剧本分段，避免 DeepSeek 输出截断
- 深度重解析失败后可以继续未完成段落

### 资产和带货产品图

- 人物、场景、道具、分镜图分类
- 道具卡现在支持两种替换方式
  - 点击“选择产品图”从文件夹选择
  - 将 PNG、JPEG、WebP 直接拖到道具图上
- 单图限制15MB
- 替换图片后相关视频确认会失效
- 素材编辑仍通过 `editAsset()` 和 `PATCH /api/projects/:id/assets/:assetId`

### 放大编辑

- 剧本区有“放大预览”按钮
- 分镜提示词有“放大预览”按钮
- 当前放大窗口是可编辑 textarea
- 剧本放大编辑保存后回填草稿，需要用户再点击顶部“保存修改”写入项目
- 分镜提示词放大编辑保存后直接调用分镜 PATCH
- 相关函数
  - `openEditablePreview(type, id, title, text)`
  - `data-action="expand-script"`
  - `data-action="expand-shot-prompt"`
  - `data-action="save-expanded-editor"`

### 视频渠道和重试

- 视频渠道保存在项目级 `videoProviderId`
- 右侧显示“视频渠道”和“换渠道”
- 失败自动重试开关字段为 `autoRetryVideo`
- 明确失败最多自动重试2次
- 提交结果未知时不会自动重提，避免重复计费

### 厂商配置

厂商方案通过设置页管理，按用途分为：

- `deepseek`：剧本与分镜
- `grsai`：资产生图
- `fydmai`：视频生成

当前默认厂商方案 UI 模仿 CC Switch 的“厂商卡片 + 详情编辑”逻辑。

厂商列表右上角有“选择”：开启后点卡片选中，再点“删除所选”。删除走 `POST /api/provider-profiles/remove`（`ProviderSettings.remove`），只是把方案标成 `archived` 从列表和模型选择里收起，记录和 Key 仍留在本机配置文件里，已提交的任务才能继续查询；使用中的方案不能删。

已接入的协议：

- OpenAI Chat Completions
- OpenAI Images
- Grsai 原生
- 菲阳动漫原生
- 萤漫 OpenAI 兼容视频
- 自定义 HTTP JSON

当前本机的剧本方案已经切换到 CCAPI Gemini 4 Argon。不要把 Key 写进源码、README、更新包或 GitHub。

## 4. 关键 API

所有请求需要使用 `/api/bootstrap` 返回的 `token`，前端 `api()` 已自动带 `X-Workflow-Token`。

### 启动数据

```http
GET /api/bootstrap
```

主要字段：

- `settings`：当前用途方案的脱敏配置
- `providerProfiles`：厂商方案列表、当前选择、厂商目录
- `updates`：更新状态
- `concurrency`：图片和视频并发
- `prompts`：系统提示词
- `projects`：项目摘要
- `capabilities`、`videoProfile`：视频能力
- `voice`：语音工作台脱敏数据
- `rules`：人物设定板规则

### 项目

```http
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
POST   /api/projects/batch-delete
POST   /api/projects/:id/prepare
POST   /api/projects/:id/generate-assets
POST   /api/projects/:id/reparse-storyboards
POST   /api/projects/:id/review
POST   /api/projects/:id/videos
POST   /api/projects/:id/merge
```

### 资产

```http
PATCH /api/projects/:id/assets/:assetId
POST  /api/projects/:id/assets/:assetId/generate
POST  /api/projects/:id/assets/:assetId/image
```

图片替换接口接收 JSON：

```json
{"base64":"..."}
```

服务端会检查 PNG、JPEG、WebP 文件头，再写入本地项目媒体目录。

### 分镜

```http
PATCH /api/projects/:id/shots/:shotId
POST  /api/projects/:id/shots/:shotId/rebuild
POST  /api/projects/:id/shots/:shotId/resume
POST  /api/projects/:id/shots/:shotId/confirm-continuity
```

分镜 PATCH 可以提交：

- `title`
- `prompt`
- `duration`
- `audioIds`
- `audioRoles`

### 厂商与更新

```http
GET  /api/provider-profiles
POST /api/settings
GET  /api/updates
POST /api/updates/settings
POST /api/updates/check
POST /api/updates/install
```

### 语音

```http
GET    /api/voice
POST   /api/voice/settings
POST   /api/voice/presets
POST   /api/voice/synthesize
DELETE /api/voice/history/:id
GET    /voice-media/:file
```

## 5. 前端状态和保存规则

- `state.draft` 保存编辑中的项目设置
- `state.dirty` 表示项目设置尚未保存
- 剧本输入、风格、画幅、时长、分辨率、补充规则、自动语音、自动重试、视频渠道都通过 `state.draft` 编辑
- `saveProject()` 调用项目 PATCH
- 分镜编辑器单独调用分镜 PATCH
- 不要把完整 Key 放入 `state` 或页面文本。后端只返回 `configured: true/false`
- 页面刷新依赖 `/api/bootstrap`，不要假设本地 localStorage 中有完整项目数据

## 6. 前端改动注意事项

1. 保持原生 JavaScript，不引入 React、Vue 或构建步骤。
2. 所有用户文本必须经过 `escape()` 后再放入 HTML。
3. 长文本使用 textarea 或 `pre` 的滚动容器，不要让提示词卡片撑爆页面。
4. 新按钮优先使用 `data-action`，在统一 click 事件中处理。
5. 新图片预览优先复用 `image-viewer.js`。
6. 修改前先读取当前状态，避免把异步轮询返回的项目旧数据覆盖用户正在编辑的草稿。
7. 不要删除旧的项目、媒体、历史和厂商方案。
8. 不要对真实项目自动触发图片、视频或语音生成测试。
9. 接口配置变更会影响计费任务。已有提交任务必须继续使用快照里的原厂商配置。
10. 更新包不能包含 `.env`、`data/`、`outputs/` 或任何 Key。

## 7. 当前适合 Claude 继续做的前端工作

- 优化剧本编辑区布局，进一步减少右侧设置撑高造成的视觉空白
- 优化可编辑放大窗口的保存状态、快捷键和未保存提示
- 道具拖拽替换增加拖拽中的视觉反馈和产品图预览
- 分镜提示词预览增加图片、音频引用的可视化编辑体验
- 设置页厂商卡片增加搜索、折叠和移动端适配
- 对长文本、长提示词和错误提示做浏览器验收
- 不要改动后端任务状态和旧项目数据结构，除非先补迁移逻辑和测试

## 8. 验证方式

```bash
node --check public/app.js
npm test
npm start
```

当前后端测试集最近一次为74项通过。前端修改后至少执行 `node --check public/app.js`，涉及交互时再打开本机工作台检查正常入口。

## 9. 交接边界

- 目标是维护镜序短剧工作台的前端体验，不重新设计后端工作流。
- 现有本机 Key、用户项目、图片、视频、音频和历史记录都属于用户数据。
- 不要打印 Key，不要将 Key 复制到文档、截图、提交信息或远程仓库。
- 当前本机版本为1.5.3，GitHub Release未同步本机最近的所有版本，修改后先保留本地可运行状态，再单独处理发布。

## 10. 主题和毛玻璃（2026-11-15 新增）

- 侧栏左下角有三档主题切换：白天、跟随系统、夜间。选择记在 localStorage 的 `drama-theme`，默认跟随系统。
- `public/index.html` 头部的内联脚本在样式加载前设置 `<html data-theme>`，避免闪白。`public/app.js` 的 `applyTheme()`、`setTheme()`、`themeSwitch()` 负责切换和渲染按钮。
- `public/style.css` 里不再写死颜色。所有颜色都是变量，两套取值在文件末尾的“主题层”里（`:root` 和 `:root[data-theme=dark]`）。新增样式请直接用这些变量，例如 `--ink`、`--muted`、`--paper`、`--sunk`、`--line`、`--accent`。
- 毛玻璃只加在大块面板上（侧栏、顶栏、分区卡片、弹窗遮罩、浮动条）。素材卡、分镜卡这类数量多的卡片只用半透明底色，不加模糊，避免滚动掉帧。
- 不支持 `backdrop-filter` 的浏览器会通过 `@supports` 退回不透明底色。
- 动态背景在 `public/backdrop.js`：夜间是宇宙（WebGL 着色器），白天是线描星轨，移植自「Claude 会话同步」面板。没有 WebGL 时退回 2D 画布，再不行露出 CSS 光斑。这个文件已加进 `src/server.js` 的静态白名单。
- 顶栏已去掉。并发设置、接口设置、任务记录、主题切换和连接状态都在侧栏底部。侧栏可收起成图标栏（`toggleSidebar()`，记在 localStorage 的 `drama-sidebar`），窗口窄于 900px 时固定收起。
- 主按钮（`button.primary`）是中性色：白天深色、夜间浅色。橙色 `--accent` 只用于步骤、链接等小面积提示。

## 11. 解析容错、剧本改动与连接测试

- 分镜解析（`generateStoryboards`）：输出被截断时自动把该段对半拆开继续；某段没返回分镜或引用写错时同一段自动重试，最多共 3 次。单条重新拆分（`rebuildShot`）在 AI 返回内容不合格时同样最多试 3 次，接口本身报错不重试。
- 图片引用除了 key，也认素材名称和内部编号（`referenceKeys`）。
- 全部重新解析分镜复用现有资产清单：新段落的 `analysisState` 直接记为 `completed`，否则界面会再次要求“拆解剧本并列资产清单”，全自动模式下还会接着生图。启动时 `recover()` 会修正旧版本留下的这种项目。
- 项目标题旁的“复制为新项目”图标已去掉；改剧本后另建版本的原有流程不变。
- 厂商连接测试：`POST /api/provider-profiles/:id/test`，实现在 `src/provider-test.js`。文本发一次 `max_tokens:16` 的对话；生图和视频只发 GET（`/v1/models`、菲阳的 `/caps`、任务查询），不提交生成。结果分 `ok` / `reachable` / `fail` 三档，不回显 Key 和上游响应。

## 12. 剧本导出与导入

- 剧本库不再有“选择 / 完成选择”模式：勾选框常驻，工具栏是全选、导出、导入、删除。
- `GET /api/projects/export?ids=a,b`：把所选项目的 `project.json` 和项目目录里的媒体文件打成一个 ZIP 流式下载。`POST /api/projects/import`（`Content-Type: application/zip`，仍需页面令牌）：解包后每个项目生成新的 id，不覆盖已有项目。
- 实现在 `src/project-transfer.js` 和 `src/zip.js`（自己写的最小 ZIP 读写，没有加依赖；不支持超过 4GB 和加密的包）。
- 包里不含 Key、厂商配置、语音库和上传缓存；进行中的任务、远端任务号和厂商绑定在导出时去掉。语音工作台的音频不随包走，导入后分镜里对本机不存在的音频引用会被清掉。
- 导入时媒体文件名必须通过和 `store.media` 相同的白名单，引用了包里没有的文件按“未生成”处理。
- 拖入导入：把导出的 ZIP，或 TXT / Markdown 剧本文件拖进窗口任意位置（资产卡片除外）即可导入；剧本库工具栏的“导入剧本”既是按钮也是落点。入口统一是 `importProjectFile()`：ZIP 走 `/api/projects/import`，文本文件新建一个项目并把内容填进剧本（文件名作标题，编码按 UTF-8、UTF-16、GB18030 依次尝试）。
- 视频渠道按模型展开：`videoChannels()` 把每个已配置视频方案的模型列表逐个列出（`value` 为 `方案id::模型id`），项目用 `videoProviderId` + `videoModel` 记住所选；`videoConfigForProject()` 和快照的 `videoConfig()` 据此覆盖方案当前模型。方案里“当前使用模型”只是没单独选时的默认值。
- 系统提示词不再内置：`promptDefinitions` 五项的 `default` 都是空字符串，`prompts/storyboard-format-system.txt` 已从仓库删除。使用者在“接口设置 → 系统提示词”里自己填；已经保存过自定义内容的电脑不受影响。

## 自由创作（侧栏“自由创作”）

- 不经过剧本和分镜：一段提示词加参考图，直接生成视频或图片。前端在 `public/studio.js`，后端在 `src/studio.js`，接口是 `/api/studio`、`/api/studio/references`、`/api/studio/items`，文件走 `/studio-media/`。
- 数据放在 `data/projects/_studio/`（`studio.json` 加参考图、成品文件），不属于任何项目，不进项目导出包。
- 参考图按顺序叫 图1、图2…，提示词里写 `@图1` 引用；提交时后端换成各厂商自己的引用写法。可以点选、拖入或粘贴图片。
- 视频用“接口配置”里已配置的视频方案和模型，图片用当前启用的生图方案；并发和项目共用同一组上限。
- 提交前先记下提交时间，拿到任务号立刻保存；失败后“继续查询”只查原任务，不会重复提交。
- 输入区内容记在模块里的 `draft`，整页重画后还原；结果列表按条更新，不打断正在播放的视频。停在这个页面时，后台轮询不重画项目。
- 输入框是 `contenteditable`：`@图N` 显示成带缩略图的小标签（`.studio-at`），存取时仍是纯文字 `@图N`。标签后跟一个零宽字符方便放光标，序列化时去掉。
- 悬停缩略图或标签出小预览（`.studio-peek`），点击走全站的看图器。模型、画幅/分辨率、时长是自绘弹出面板（`.studio-pop`），不用原生下拉。
- 页面内切换（视频/图片、创作/画布、选参数）只局部重画（`paint()`），不调全局 `render()`。


## 画布（自由创作 → 画布）

- 前端在 `public/canvas.js`，打开后是盖住整个窗口的一层（`.cv`），不走全局 `render()`。后端存取在 `src/studio.js`（`cleanCanvas`、`createCanvas` 等），每张画布一个 `data/projects/_studio/canvas_<id>.json`，接口 `/api/studio/canvases`。
- 节点两种：图片、视频；来源两种：上传（`source:'upload'`）和生成（`source:'gen'`，`itemId` 指向自由创作的一条作品）。连线只表示“这张图是那个生成节点的参考图”，顺序就是 图1、图2…
- 节点有三种：图片、视频、音频。图片、音频、视频都能上传（底栏“上传素材”、拖入、粘贴）。音视频走 `POST /api/studio/clips`（请求体是原始字节，`Content-Type: application/octet-stream`，文件名放 `X-File-Name`，上限 500MB），后端用 FFmpeg 整理成 mp4 / mp3 / m4a，登记在 `studio.json` 的 `clips` 里，文件名 `clip_*`。没有节点引用、放了一天以上的 clip 会在启动时清掉。
- 单选一个有成品的节点时，上方出现工具条（`drawNodeBar`）：图片“预览、下载”，视频“分离音视频、预览、下载”，音频“截取、下载”。分离走 `POST /api/studio/split`（得到无声视频 + m4a 音轨两个新节点），截取走 `POST /api/studio/trim`（`start`、`end` 按秒），新节点放在右边并连线。处理都在 `src/media-clips.js`，需要本机装 FFmpeg。
- 音频节点的波形在浏览器里用 `OfflineAudioContext` 解码算出来，按地址缓存；截取时在波形上拖左右把手或整段。
- 红色播放线可以拖（`seek` 拖动），节点选中后点波形任意位置也会跳过去。选中的视频节点按住画面就能拖动，底部 46px 留给原生播放控件；没拖动只点一下画面是播放 / 暂停。
- 参考音频：音频节点也有出线把手，只能连到视频生成节点，每个最多 3 段。输入框里显示为“音频N”，`@` 菜单能插入 `@音频N` 标签。生成时前端传 `audioFiles`（clip 地址），后端 `Studio.create` 只认登记过的音频 clip，`run()` 用厂商的 `uploadAudio` 上传后放进 `referenceAudios`，提示词里的 `@音频N` 原样保留。
- 拖节点、拉线、框选靠近窗口边缘（64px 内）时画面自动朝那边移（`edgePan`），越靠边越快。
- 输入框右上角有放大按钮（`studio-expand`），创作页和画布里都有；画布里放大后会把画面往上挪，保证输入框在底栏上方完整露出。
- 生成走自由创作的同一个接口。选中生成节点时，下方输入框就是自由创作那个：`setHost()` 让 `draft` 指向节点内容，增删参考图和生成由画布接管。
- 生成出来的图要当参考图时，先调 `/api/studio/items/:id/reference` 复制登记成参考图。
- 交互：空格或中键拖动画面；鼠标滚轮缩放，触控板双指平移、捏合缩放；空白处拖动框选；从图片节点右侧“+”拉线，松手在空白处弹菜单建节点，松手在生成节点上直接连；多选后拉线会把选中的图片一起连过去。
- 多选时出现虚线框（`.cv-selbox`），框上方有“打组 / 解组 / 删除”，右侧的“+”把选中的图片一起连出去。分组存在画布的 `groups` 里（一个节点只属于一个组），显示成节点下面的底板，拖底板整组移动，双击组名改名。
- 没做：音频、剧本、剪辑、导演台、撤销重做、单独选中删除连线（连线在输入框的参考图上点 × 删除）。

## FFmpeg 自动安装（2026-11-17 新增）

- `src/ffmpeg-tools.js`：`ffmpegTools.ensure()` 先看系统里的 `ffmpeg`、`ffprobe` 能不能运行；不能就按平台从 `eugeneware/ffmpeg-static` 的 b6.1.1 Release 下载 `.gz`，边下边算 SHA-256（大小和摘要写死在 `FFMPEG_BUILDS`），解压到 `data/tools/ffmpeg/`。校验不通过就删掉，不留半截文件。
- `src/media-clips.js`、`src/video-merge.js` 都通过 `ffmpegTools.run(name, args, options)` 调用，第一次使用时如果还在安装会等它装完。安装失败的错误带 `install: true`，原样显示给用户。
- `src/server.js` 启动 5 秒后在后台调用一次 `ensure()`，所以更新完重启就会自动装好。测试用 `createFfmpegTools({dir, fetchImpl, platform, arch, base, builds, check})` 注入假的下载源。
- 以后升级 FFmpeg 版本：改 `FFMPEG_RELEASE` 和 `FFMPEG_BUILDS`，大小和摘要取 GitHub Release API 里每个资源的 `size` 和 `digest`。

## Scenetra 视频渠道（2026-11-17 新增）

- `src/scenetra.js`：`SCENETRA_MODELS` 按 Scenetra 的 OpenAPI（`https://app.scenetra.com/api/v1/openapi.json`，公开可读）写明每个模型的文生 / 参考生端点、参考图和音频字段名、引用写法（`@Image1`、`@image_1`、`Image 1`、`[Image 1]`……）、时长、清晰度、画幅和音频开关。模型 ID 用的是我们自己的家族名（如 `seedance-2-5`），提交时按有没有参考素材选 `-t2v` 或 `-ref2v`。
- 协议名 `scenetra`：`createProvider` 返回 `ScenetraVideoProvider`；`referenceTag`、工作流的 `providerPrompt`（`@音频·名字` → 模型的音频写法）和自由创作（`@音频N` → 模型的音频写法）都按模型换写法；`profileCapabilities(config)` 让工作流按模型查表拿时长、清晰度和参考图上限。
- 提交：先 `POST /api/v1/generate/{端点}?dryRun=1` 免费校验，再正式提交，返回 `runId`；查询 `GET /api/v1/runs/{runId}`，`outputs[].url` 是成片地址。工作流和自由创作的提交钩子会从 `runId` 记下任务号（dryRun 的返回不记）。
- 参考素材：`hostTemporarily` 先传 uguu.se，失败重试一次后换 tmpfiles.org（转成 `/dl/` 直链）；同内容在有效期 60% 内复用。返回的 `expiresAt` 也写进工作流的 `upload-cache.json`，过期后重新上传。
- 连接测试只 `GET /api/v1/models`，看所选模型的两个端点是否开放，不提交生成。测试在 `test/scenetra.test.js`，全部用假的 Scenetra 和假的图床。

## 惠喵视频渠道与悟空文本预设（2026-11-17 新增）

- `src/huimiao.js`：协议名 `huimiao`，按 `https://huimiaovip.com/docs/api-guide.md` 写。上传：`POST /v1/uploads/presign` → 对 `put_url` 原样带 `headers` 做 PUT（不带 Key）→ `POST /v1/uploads/complete`，返回的 `object_key` 作为 assetId（缓存 1 小时）。音频先经 `audioForUpload` 转 mp3，并用 ffprobe 读时长填 `duration_ms`（至少 2 秒）。
- 提交 `POST /v1/videos/generations`，字段 `model/prompt/duration/resolution/ratio/asset_keys/audio_asset_keys`，每次一个新的 `Idempotency-Key`；状态 `queued/in_progress/completed/failed`。下载 `GET /v1/videos/{id}/content`，手动跟随跳转，跨域不带 Key，`409 video_preparing` 按 Retry-After 重试。
- 提示词引用写成 `参考图N`、`参考音频N`（文档示例写法）。`HUIMIAO_MODELS` 是文档 9B 节的 7 个模型快照（时长、参考上限）；清晰度取方案“视频参数”里填的值。表外的模型 ID 全部用方案里填的参数。
- 连接测试读 `/v1/models` 和 `/v1/balance`，报出所选模型的真实时长、清晰度、参考上限和积分。
- 悟空 API 只是文本预设（`openai-chat`，`https://wkapi.work` + `/v1/chat/completions`），没有新代码。


## 文字调用失败原因与超时（2026-11-17 新增）

- 起因：Windows 上“全部重新解析分镜”反复报“提交结果暂不明确，请先核对服务端任务”，真实原因（超时、中转站返回 HTML、网络断）被吞；日志还多一个句号“。。”。
- `src/http.js`：`ApiClient` 先读文本再解析，错误带 `detail`（`ProviderError.detail`）：`等待超过N秒仍未返回，已超时`、`网络中断（ECONNRESET 等）`、`返回内容不是JSON（HTTP 200，text/html）`、`HTTP 401：上游错误说明`（说明最多 160 字，Key 与 `sk-…` 等形式替换成 `***`，HTML 错误页正文不回显）。图片、视频的 POST 仍标记 `submissionUnknown`，`errorText` 仍提示核对服务端任务，但括号里带上原因。
- `src/providers.js`：文字调用统一走 `requestText`，失败改成普通 `ProviderError`（`submissionUnknown: false`，`code` 为 `TEXT_TIMEOUT` 或 `TEXT_REQUEST_FAILED`），显示“文字服务请求失败：原因”。文字对话没有服务端任务可查，不会重复生成扣费成品。`parseJsonText` 能读 ```json 代码块或前后带说明的回复（Gemini 经悟空等中转常这样），以 `{` 开头却没收尾（部分中转站截断时仍报 `finish_reason: stop`）按 `TEXT_OUTPUT_TRUNCATED` 处理，分镜自动对半拆段；其他读不出的内容说明收到多少字，并标 `retryable` 让分镜同段自动再试。`finish_reason` 不区分大小写。
- 超时取舍：分镜一次最多 24000 token，慢模型或中转站要好几分钟，原来默认 120 秒必然超时。文字方案（含自定义 json 协议的文字方案）的超时低于 10 分钟时按 10 分钟（`TEXT_MIN_TIMEOUT_MS`）；设置里填更长的照用。代价是网络真不通时要等满 10 分钟才报错。全部重新解析遇到文字超时、且该段 ≥1200 字时，像输出截断一样自动对半拆开再解析，同一段只因超时拆一次（最坏多等一轮），段落上限 2600 字不变以保持上下文连贯。
- `src/storyboard-reparse.js` 中断日志去掉错误末尾的标点后再接“。旧分镜保留…”；`studio.js` 的“原因：”只在没有 `detail` 时追加。测试在 `test/text-errors.test.js`。
