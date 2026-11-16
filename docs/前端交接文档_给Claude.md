# 镜序短剧工作台前端交接文档

## 1. 项目概况

- 项目目录：`/Users/zoro/Documents/视频号视频制作/短剧工作流`
- 技术栈：Node.js 原生 HTTP 服务 + 原生 JavaScript + 原生 CSS，无前端框架和 npm 依赖
- 启动命令：`npm start`
- 本机地址：`http://127.0.0.1:6040/`
- 当前本机版本：`1.3.1`
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
- 当前本机版本为1.3.1，GitHub Release未同步本机最近的所有版本，修改后先保留本地可运行状态，再单独处理发布。

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
