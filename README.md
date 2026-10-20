# 百炼知识库工作台 · 应用原型

基于[阿里云百炼](https://www.aliyun.com/product/bailian) **ParseX 文档解析** + **RAG 知识库**两个产品的工作流构建的知识库应用原型（参考控制台页面 `bailian.console.aliyun.com/cn-beijing/rag/channel` 与 `/parsex/document-parse`）。

复刻控制台三段式流程：

```
┌─────────────────┐    ┌──────────────────────┐    ┌───────────────────────┐
│  文档解析 ParseX  │ →  │  知识库 RAG           │ →  │  Playground 知识问答   │
│  上传/URL/粘贴    │    │  切片 → 向量化 → 入库  │    │  检索 → 引用 → 流式生成 │
│  → Markdown      │    │  索引状态/切片/检索测试  │    │  SSE 事件流 + 引用溯源  │
└─────────────────┘    └──────────────────────┘    └───────────────────────┘
```

**零依赖**：仅使用 Node.js 内置模块（Node ≥ 18），无需 `npm install`。

界面为 **NotebookLM 式三栏布局**：左 Input（资料源 + 勾选范围，勾选的资料支撑回答与生成）、中 Chat（流式问答 + 引用溯源 + 建议问题）、右 Output（小测验 / 闪卡 / 心智图 / 资讯图 / Word 文档 / Excel 试算表六种产物，可交互查看与下载）。

## 界面与动效（Aurora UI）

前端视觉重做为「通透玻璃 + 极光渐变 + 克制动效」，仍是零依赖的原生 HTML/CSS/JS。

- **配色系统**：所有颜色收敛为 CSS 变量（`--brand*` / `--ink*` / `--line*` / `--panel*` / 语义色），浅色与深色各一套 token；品牌色 `#6a5cf5 → #b25bf0` 渐变，`--ok / --warn / --err` 用于真实 / 模拟 / 解析失败等状态。
- **主题切换**：右上角 ☾ / ☀ 一键切换，选择写入 `localStorage['kb-theme']`；首次访问跟随系统 `prefers-color-scheme`，并在 `<head>` 内联脚本中提前应用，避免闪烁。
- **动效清单**：
  - 背景三枚模糊光斑缓慢漂移（`drift`，26–38s）；
  - 面板、资料行、产物卡、建议问题逐条错峰入场；
  - 对话气泡入场、流式光标闪烁、检索阶段三点打字指示器、引用 chip 依次浮现；
  - 输出卡生成时高光扫过、已生成数量徽标弹跳；
  - 闪卡 3D 翻转（`perspective` + `rotateY`，支持 Enter / 空格）；
  - 弹窗缩放入场 / 淡出（Esc 关闭、焦点落到主按钮）、Toast 滑入 + 倒计时进度条；
  - 拖拽区呼吸光晕、勾选弹跳、按钮 hover 抬升、选择器箭头微动。
- **可访问性**：全局 `:focus-visible` 焦点环、图标按钮均有 `aria-label`、弹窗 `role="dialog"`、对话区 `aria-live="polite"`；全部动效在 `prefers-reduced-motion: reduce` 下关闭（含背景光斑）。
- **响应式**：≥1360 保持三栏原生宽度；1180 / 1040 / 940 逐级收窄并隐藏次要徽标；≤820 改为纵向堆叠、页面整体滚动，聊天区固定高度内部滚动。
- **零依赖**：无构建步骤、无外部字体 / CDN，直接用系统字体栈渲染。

## 快速开始

```bash
cd kb-studio
node server.js
# 打开 http://127.0.0.1:8686
```

默认 **全链路模拟模式**（无需任何凭据）：

1. 左侧 Input：拖入 `.md/.txt/.csv/.json/.html`、粘贴文本或添加链接（ParseX）；解析完成后自动入库当前笔记本；
2. 勾选资料设定回答范围（顶部「全选（n/n）」可整体切换，对齐 NotebookLM 的 source 勾选）；
3. 中间 Chat 提问（SSE 流式 + `[1][2]` 引用，点击引用查看切片原文）；右侧 Output 点六种产物按勾选范围生成：小测验可作答判分、闪卡点击翻面、心智图树状展开、Word/Excel 可下载（.doc / .csv）。

## 接入真实百炼服务

在 `kb-studio/.env`（或环境变量）中配置：

```ini
DASHSCOPE_API_KEY=sk-xxxxxxxx        # 百炼 API Key（必填）
WORKSPACE_ID=llm-xxxxxxxxxxxx        # 业务空间 ID，启用 ParseX 与托管检索（必填）
KB_CHAT_MODEL=qwen-plus              # 可选，问答模型
KB_EMBED_MODEL=text-embedding-v4     # 可选，向量模型
# KB_EMBED_MODE=mock / KB_LLM_MODE=mock  可选，强制对应环节使用模拟模式
# KB_PORT=8686                        可选，服务端口
```

配置后顶栏徽标切换为「真实」模式，对应关系：

| 环节 | 模拟模式 | 真实模式 |
| --- | --- | --- |
| 文档解析 | 本地解析文本类文件 | ParseX `POST /api/v2/apps/parse-x/parse/submit`（`file_url` → `biz_id`）+ `parse/result` 轮询 |
| 向量化 | 词袋哈希伪向量（512 维） | DashScope `text-embedding-v4`（1024 维） |
| 检索 | 余弦相似度 Top-K | 本地向量检索，或直连 `/api/v1/indices/rag/index/retrieve` |
| 问答 | 抽取式模拟回答，伪流式 | `qwen-plus` SSE 流式 + 引用提示词 |

真实模式失败时自动回退模拟模式并在界面提示。

### 远端（托管）知识库

「知识库」页 → 「绑定远端知识库」→ 填入百炼控制台「知识管理」中复制的 `index_id`，即可直连百炼托管知识库执行检索与问答（需配置 API Key + WORKSPACE_ID）。

## 后端 API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 运行模式（各环节 真实/模拟）与统计 |
| POST | `/api/parse` | 提交解析：`{name,text}` 本地解析 / `{url}` 走 ParseX |
| GET/DELETE | `/api/documents[/:id]` | 文档列表 / 详情（自动轮询 ParseX）/ 删除 |
| POST | `/api/parse/sample/:name` | 载入内置示例文档 |
| POST/GET/DELETE | `/api/indices[/:id]` | 知识库 CRUD（含远端绑定） |
| POST | `/api/indices/:id/import` | 导入文档（切片→向量化→入库，异步） |
| POST | `/api/indices/:id/retrieve` | 检索测试 `{query, top_k, threshold}` |
| POST | `/api/chat` | SSE 知识问答：`plan_start → tool_calling → tool_return → generating… → generation_end`（对齐百炼 knowledge/chat 事件风格）；支持 `doc_ids` 勾选范围过滤 |
| GET/POST/DELETE | `/api/artifacts[/:id]` | 产物列表 / 生成 `{index_id, type, doc_ids}` / 详情 / 删除 |
| GET | `/api/artifacts/:id/download` | 产物下载（测验/闪卡/心智图为 json/md，Word 为 .doc，Excel 为带 BOM 的 .csv） |

数据持久化在 `kb-studio/data/state.json`（首次运行自动创建）。

## 目录结构

```
kb-studio/
├── server.js          # HTTP 服务、路由、SSE 问答
├── lib/
│   ├── store.js       # JSON 持久化
│   ├── chunker.js     # Markdown 感知切片（标题路径 + 重叠）
│   ├── embeddings.js  # 向量化（真实 DashScope / 模拟哈希）
│   ├── vector.js      # 余弦相似度检索
│   ├── parsex.js      # ParseX 客户端（submit/result + 本地解析）
│   ├── llm.js         # 问答（流式 / 模拟抽取式）+ RAG 提示词
│   ├── generate.js    # Output 产物生成（测验/闪卡/心智图/资讯图/Word/Excel）
│   └── bailian.js     # 百炼托管知识库直连检索
├── public/            # 前端（原生 HTML/CSS/JS，NotebookLM 式三栏）
├── sample-docs/       # 内置示例文档
└── data/              # 运行时数据（自动生成）
```

## 说明与限制

- 原型用途：未做鉴权、并发控制与生产级校验，请勿暴露公网；
- PDF/Word 二进制文件本地无法解析，请使用「文件 URL」走真实 ParseX，或上传文本类文件；
- ParseX `parse/result` 的结果字段以实际返回为准，`lib/parsex.js` 中的 `extractMarkdown` 做了防御式递归提取，必要时按真实响应结构调整；
- 帮助文档参考：[ParseX API 概览](https://help.aliyun.com/zh/model-studio/parse/api-overview)、[提交解析任务](https://help.aliyun.com/zh/model-studio/parse/parse-submit)、[RAG 快速开始](https://help.aliyun.com/zh/model-studio/rag/quickstart)、[RAG API 概览](https://help.aliyun.com/zh/model-studio/rag-api-overview)、[知识问答](https://help.aliyun.com/zh/model-studio/rag-knowledge-qa)。
