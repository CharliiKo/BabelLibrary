# 百炼知识库工作台 · 应用原型（AI Platform 多协议兼容增强版）

基于[阿里云百炼](https://www.aliyun.com/product/bailian) **ParseX 文档解析** + **RAG 知识库**两个产品的工作流构建的知识库应用原型，并全面升级了 **AI Platform API 多协议双向兼容性**：

1. **OpenAI Responses API (`/v1/responses`)** — **默认首选协议**，针对流式输出做了零缓冲 SSE 解析、TCP `setNoDelay` + `flushHeaders`、前端 `requestAnimationFrame` 帧合并、多种 `input` 结构（`simple` / `canonical` / `string`）与推理模型参数自适应重试，确保极速流畅。
2. **OpenAI Chat Completions API (`/v1/chat/completions`)** — 兼容标准 OpenAI、OneAPI/NewAPI、vLLM、百炼 `compatible-mode` 等网关。
3. **Anthropic Messages REST API (`/v1/messages`)** — 原生支持顶层 `system` 抽取、严格 `user`/`assistant` 角色交替合并、`x-api-key` + `anthropic-version` 头及 `content_block_delta` 流式解析。

```
┌─────────────────┐    ┌──────────────────────┐    ┌───────────────────────┐
│  文档解析 ParseX  │ →  │  知识库 RAG           │ →  │  Playground / 多协议API │
│  上传/URL/粘贴    │    │  切片 → 向量化 → 入库  │    │  Responses (首选流畅)  │
│  → Markdown      │    │  索引状态/切片/检索测试  │    │  ChatCompletions      │
└─────────────────┘    └──────────────────────┘    │  Anthropic /v1/messages│
                                                   └───────────────────────┘
```

**零依赖**：仅使用 Node.js 内置模块（Node ≥ 18），无需 `npm install`。

## 快速开始

```bash
cd kb-studio
node server.js
# 打开 http://127.0.0.1:8686
```

## 接入 AI Platform API（三种协议与动态配置）

### 方式一：Web 界面可视化配置（无需重启）

点击界面右上角 **「⚙ 管理」**（或顶栏模式徽标），在 **「AI Platform API 接入配置」** 面板中可随时切换：
- **协议类型**：`OpenAI Responses API (/v1/responses · 首选流畅)`、`OpenAI Chat Completions (/v1/chat/completions)`、`Anthropic Messages REST API (/v1/messages)`、`自动探测 (auto)`
- **API Base URL**：支持填写根地址（如 `https://api.openai.com`、`https://api.anthropic.com`、`https://dashscope.aliyuncs.com`）、带 `/v1` 地址或完整端点地址
- **API Key & Model**：保存后立即持久化生效，点击 **「⚡ 测试连接与流式延迟」** 可实测首包延迟（TTFT）与流式响应。

### 方式二：`.env` 或环境变量配置

在 `kb-studio/.env`（或环境变量）中配置：

```ini
# 通用 AI Platform 配置（优先级高于特定厂商变量）
AI_API_KEY=sk-xxxxxxxx
AI_BASE_URL=https://api.openai.com/v1
KB_API_PROTOCOL=responses            # responses (默认首选) | chat_completions | anthropic | auto
KB_CHAT_MODEL=gpt-4o-mini            # 或 gpt-4.1 / claude-3-5-sonnet-latest / qwen-plus

# 也完全兼容厂商标准环境变量：
# OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
# ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
# DASHSCOPE_API_KEY / DASHSCOPE_BASE / WORKSPACE_ID

# 向量化配置（兼容 OpenAI /v1/embeddings 与百炼原生 text-embedding）
KB_EMBED_MODEL=text-embedding-3-small
# KB_EMBED_BASE_URL=https://api.openai.com/v1
# KB_EMBED_MODE=mock                 # 可选：强制向量使用本地模拟
# KB_LLM_MODE=mock                   # 可选：强制问答使用本地模拟
# KB_AUTO_FALLBACK=true              # 默认开启：当目标协议端点返回 404/405/501 时自动平滑回退备选协议
```

## 后端 API 一览（含对外兼容 AI Platform 协议端点）

### 1. 对外开放的 AI Platform 兼容接口（可直接接入第三方客户端 / SDK）

| 方法 | 路径 | 协议规范 | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/responses` | **OpenAI Responses API** | 支持 `stream: true/false`、`input`（字符串/消息数组/标准块）、`instructions`，自动结合知识库 RAG 检索并返回 `file_citation` 注解 |
| POST | `/v1/chat/completions` | **OpenAI Chat Completions** | 支持 `stream: true/false`、`messages`，返回标准 `chat.completion.chunk` / `chat.completion` 及 `citations` |
| POST | `/v1/messages` | **Anthropic Messages API** | 支持 `stream: true/false`、顶层 `system`、`messages`，返回标准 `message_start` → `content_block_delta` → `message_stop` 事件流 |
| GET | `/v1/models` | OpenAI / Anthropic Models | 返回当前可用模型与知识库索引模型（`kb:<index_id>`） |

### 2. 工作台内部 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 运行模式（各环节 真实/模拟、当前激活协议与模型）与统计 |
| GET/POST | `/api/settings` | 获取 / 动态更新 AI Platform API 协议、Base URL、API Key、Model 等配置 |
| POST | `/api/llm/test` | 测试 AI Platform 连通性、实际握手协议、首字延迟 (TTFT) 与总耗时 |
| POST | `/api/parse` | 提交解析：`{name,text}` 本地解析 / `{url}` 走 ParseX |
| GET/DELETE | `/api/documents[/:id]` | 文档列表 / 详情（自动轮询 ParseX）/ 删除 |
| POST/GET/DELETE | `/api/indices[/:id]` | 知识库 CRUD（含远端绑定） |
| POST | `/api/indices/:id/import` | 导入文档（切片→向量化→入库，异步） |
| POST | `/api/indices/:id/retrieve` | 检索测试 `{query, top_k, threshold}` |
| POST | `/api/chat` | SSE 知识问答：`plan_start → tool_calling → tool_return → generating… → generation_end` |
| GET/POST/DELETE | `/api/artifacts[/:id]` | 产物列表 / 生成 `{index_id, type, doc_ids}` / 详情 / 删除 |

## 运行兼容性自测

```bash
node test/api-compatibility.test.js
```

离线 · 模拟模式（无需任何 API Key / 外网），覆盖 `/api/status` 版本、`/api/settings` 归一化与掩码、`/v1/models`、三个协议端点的流式与非流式（事件序列 / `[DONE]` / citations / `file_citation`）以及 `/api/chat` 模拟链路；会在结束时自动清理临时知识库并还原设置。真实上游协议行为（含自动回退、鉴权头、SSE 帧解析）的验证记录见 `.ui-preview/reviews/v110-protocol.md`（基于本地桩上游）。

## 版本管理

- 当前版本：见 [VERSION](VERSION)（`/api/status` 同步上报）；版本历史见 [CHANGELOG.md](CHANGELOG.md)，版本树见 [VERSION-TREE.md](VERSION-TREE.md)。
- 采用 git 管理：`git tag` 查看全部版本（v1.0.0 / v1.1.0 / v1.1.1），`git log --oneline --decorate` 查看演进线。

## 说明与限制

- **原型用途**：未做鉴权、并发控制与生产级校验，请勿暴露公网。
- **密钥暴露面（v1.1.0 起需特别注意）**：`/v1/*` 兼容端点默认**无需鉴权**且带 `Access-Control-Allow-Origin: *`。若已通过界面保存 API Key，本机任意网页（浏览器访问不可信页面时）或本机进程均可调用这些端点并消耗该 Key、读取知识库问答。缓解措施：仅在受信任环境运行、不保存长期 Key、或通过环境变量按需注入。
- 未显式指定 `index_id` / `kb:<id>` 无效时，服务端会回落到第一个知识库（v1.1.0 已知行为，见 CHANGELOG「已知问题」）。
- `usage` 中的 token 数为字符数估算，非真实 token 计量。
- PDF/Word 二进制文件本地无法解析，请使用「文件 URL」走真实 ParseX，或上传文本类文件。
- ParseX `parse/result` 的结果字段以实际返回为准，`lib/parsex.js` 中的 `extractMarkdown` 做了防御式递归提取。
