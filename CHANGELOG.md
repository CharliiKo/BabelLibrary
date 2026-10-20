# 更新日志（CHANGELOG）

所有对外可见的版本变更记录于此。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)；
每个版本的完整验证证据存放在 `.ui-preview/reviews/`（不参与 git，可随时删除）。

## [1.1.1] — 2026-10-20 · 发布工程（基于 v1.1.0）

> 维护方：DeepSeek 端。对 v1.1.0 的发布级补齐，不改变其功能行为。

### 新增

- **离线自测套件 `test/api-compatibility.test.js`**：补齐 v1.1.0 README 声称但压缩包中缺失的自测命令。零依赖、模拟模式（无需 API Key / 外网），12 项断言覆盖：
  `/api/status` 版本一致性、`/api/settings` 协议归一化 + 密钥掩码 + 还原、`/v1/models`（含 `kb:<index_id>`）、
  `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 三端点的流式与非流式（SSE 事件序列、`[DONE]`、citations、`file_citation`）、
  `/api/chat` 模拟事件链；自动创建并清理临时知识库。
- **`VERSION` 文件 + 版本号统一管理**：`/api/status` 的 `version` 字段改由 `VERSION` 文件驱动，与 git 标签保持一致（修复 v1.1.0 上报 `0.2.0` 与标签不符的问题）。
- **`CHANGELOG.md`、`VERSION-TREE.md`**：版本历史与版本树文档。
- README 新增「版本管理」章节与自测说明。

### 修复

- **空 API Key 不再遮蔽环境变量**：`lib/llm.js` 的 `getConfig()` 此前对 `saved.api_key` 使用 `??` 链，保存过空字符串后会永久忽略 `.env` / 环境变量中的密钥；现空字符串视为「未配置」。

### 文档

- README 恢复并扩充「说明与限制」：明确 v1.1.0 起 `/v1/*` 兼容端点**无鉴权 + `Access-Control-Allow-Origin: *`** 的本机密钥暴露面（保存 Key 后任意本机网页/进程可消耗该 Key），以及未指定 `index_id` 时的回落行为与 `usage` 计量口径。

### 验证

- 自测 `node test/api-compatibility.test.js`：**12/12 通过**；数据自动清理（docs=2 / indices=2 / artifacts=11，设置还原默认）。
- UI 回归（v1.1.0 候选，8687 端口）：10 场景全过、零控制台错误 → 报告 `v110-ui.md`。
- 协议矩阵（v1.1.0 候选，桩上游）：35/38 通过 → 报告 `v110-protocol.md`。

## [1.1.0] — 2026-10-20 · AI Platform 多协议兼容

> 来源：`kb-studio.zip`（Gemini4-Argon 交付，SHA-256 `F9FCDED1…BEEBC`），**代码原样入库**（7 个文件 +2471/−245，未做任何修改）。
> 基于 v1.0.0：完整保留 Aurora 视觉、无障碍修复与产物下载按钮。

### 新增 — 出站协议适配（调用上游大模型）

- **OpenAI Responses API（`/v1/responses`，默认首选）**：流式零缓冲 SSE 解析、TCP `setNoDelay` + `flushHeaders`、前端 `requestAnimationFrame` 帧合并；支持 `simple` / `canonical` / `string` 三种 `input` 结构与推理模型参数（temperature / instructions）自适应重试；网关返回 JSON 时自动降级提取。
- **OpenAI Chat Completions（`/v1/chat/completions`）**：兼容标准 OpenAI、OneAPI/NewAPI、vLLM、百炼 `compatible-mode` 等网关。
- **Anthropic Messages（`/v1/messages`）**：顶层 `system` 抽取、严格 `user`/`assistant` 角色交替与相邻合并、`x-api-key` + `anthropic-version` 头、`content_block_delta` 流式解析。
- **auto 自动探测 + 自动回退**：目标端点 404/405/501 时按 Responses → Chat Completions → Anthropic 顺序平滑回退（`KB_AUTO_FALLBACK=false` 可关闭）；`base_url` 支持根域名、带 `/v1`、完整端点及百炼特殊路径（`/compatible-mode/v1/*`、`/apps/anthropic/v1/messages`）。
- 环境变量全面兼容：`AI_API_KEY` / `AI_BASE_URL` / `KB_API_PROTOCOL` / `KB_CHAT_MODEL` / `OPENAI_*` / `ANTHROPIC_*` / `DASHSCOPE_*` / `KB_LLM_MODE` / `KB_EMBED_*` / `KB_AUTO_FALLBACK` 系列。

### 新增 — 对外兼容端点（供第三方客户端 / SDK 直接接入）

- `POST /v1/responses`：OpenAI Responses 规范，支持 `stream: true/false`、`input`（字符串 / 消息数组 / 标准块）、`instructions`，结合知识库 RAG 检索并返回 `file_citation` 注解。
- `POST /v1/chat/completions`：标准 `chat.completion` / `chat.completion.chunk` + `[DONE]`，返回 `citations`。
- `POST /v1/messages`：Anthropic 规范，`message_start → content_block_delta → message_stop` 事件流，顶层 `system`，`content[0].citations`。
- `GET /v1/models`：当前模型 + `kb-default` + 每个知识库的 `kb:<index_id>` 模型。

### 新增 — 运行时配置（无需重启）

- `GET/POST /api/settings`：协议 / Base URL / API Key / 模型 / 温度 / max_tokens / auto_fallback / mode 运行时切换，立即持久化生效；Key 掩码显示（`sk-t****9f3a`），`api_key: "__KEEP__"` 表示保留原密钥。
- `POST /api/llm/test`：实测握手协议、实际使用的 endpoint、首字延迟（TTFT）与总耗时。
- **UI**：管理面板新增「AI Platform API 接入配置」卡片（协议 4 项下拉 / 模型 / Base URL / Key 密码框 / 保存 / 测试连接 + 结果框）；顶栏模式徽标可点击进入配置，问答徽标 title 显示当前协议与模型。

### 新增 — 向量化

- OpenAI 兼容 `/v1/embeddings`（批量、URL 自动解析）+ DashScope 原生 text-embedding 接口；Anthropic 官方无 embeddings 端点时自动使用本地模拟向量化。

### 其他

- CORS 与 `OPTIONS` 预检支持（兼容端点跨域调用）；`store.js` 支持 `settings` 持久化与 `saveSync`。

### 已知问题（验证发现，未在 v1.1.0 内修复）

- **P1-1（安全）**：`/v1/*` 端点无鉴权且 `Access-Control-Allow-Origin: *` —— 保存 API Key 后，本机任意网页 / 进程可调用并消耗该 Key（服务仅绑定 127.0.0.1，非远程暴露）。已在 README「说明与限制」中提示；后续版本可引入本地访问令牌。
- P2-1：显式传入无效 `index_id` / `kb:<id>` 时静默回落到第一个知识库（应返回 4xx），可能产生"错误范围的自信回答"。
- P2-2：上游 `model_not_found` 404 被判为"端点不支持"，触发 3 次无谓协议尝试，且最终错误标注为最后尝试的协议而非配置协议。
- P2-3：自动回退后缓存的"工作协议"会覆盖显式指定的 `protocol`，直到重新保存设置。
- P2-5：非法 JSON 请求体的错误响应为 `{"error":"字符串"}`，非 OpenAI/Anthropic 协议错误形状。
- P2-7：Responses SSE 在 `response.completed` 之后追加非标准 `data: [DONE]`。
- P2-8：`usage` 中的 token 计数为字符数估算，非真实 token。
- 打包缺陷：压缩包缺失 README 引用的 `test/api-compatibility.test.js`（v1.1.1 已补齐）；`/api/status` 上报 `0.2.0` 与版本标签不符（v1.1.1 已对齐）。

### 验证

- 协议矩阵（桩上游，实测出站请求头 / 载荷 / 回退 / 错误路径 / 密钥不泄漏）：**35/38 通过** → `.ui-preview/reviews/v110-protocol.md`。
- UI 回归（设置面板 / 聊天 / 产物 / 主题 / 响应式 / 零控制台错误）：**全过** → `.ui-preview/reviews/v110-ui.md`。

## [1.0.0] — 2026-10-20 · Aurora UI 重设计与稳定性

> 维护方：DeepSeek 端。基线：百炼「ParseX 文档解析 + RAG 知识库 + 知识问答」三段式工作流原型
> （上传/URL/粘贴解析、切片入库、检索问答 SSE + 引用、六种 Output 产物、NotebookLM 式三栏布局）。

### 新增 — 视觉体系（Aurora UI）

- **设计 token 系统**：全部颜色收敛为 CSS 变量，浅色 / 深色各一套（`--brand*` / `--ink*` / `--line*` / `--panel*` / 语义色 / 语义文字色）；品牌渐变 `#5b4ad8 → #7846cf → #8f3fc4`；产物六色各自配对浅深 tint。
- **深色模式**：右上角 ☾/☀ 一键切换，`localStorage` 持久化、首次跟随系统、`<head>` 内联脚本提前应用防闪烁、`meta theme-color` 跟随。
- **玻璃质感**：72% 白玻璃面板 + 24px backdrop blur + 内高光 + 紫调多层阴影。

### 新增 — 动效系统（21 组关键帧，`prefers-reduced-motion` 全量关闭）

- 背景三枚模糊光斑 26–38s 缓慢漂移；面板 / 资料行 / 产物卡 / 建议问题逐条错峰入场。
- 对话气泡入场、流式光标、检索阶段三点打字指示器、引用 chip 依次浮现。
- 闪卡 3D 翻转（`perspective` + `rotateY`，支持 Enter/Space）；弹窗缩放入场 / 淡出；Toast 滑入 + 倒计时进度条；拖拽区呼吸光晕；勾选弹跳；产物生成高光扫过与数量徽标弹跳。

### 新增 — 无障碍（WCAG 对齐，实测达标）

- 键盘全量可达：管理入口 / 资料名 / 引用 / 产物条目全部原生 `<button>` 化（42 步 Tab 全部可达）。
- 弹窗焦点管理：焦点陷阱（Tab 循环）、背景 `inert`、Esc 关闭、焦点还原到打开者、初始焦点绝不停在删除按钮。
- 对比度实测：焦点环 4.4–7.4:1、三级文字 4.7–5.4:1、渐变白字 ≥4.9:1、输入框边界 ≥3.2:1、小测判分 6.0:1。
- `aria-pressed` / `aria-live` / `aria-busy` 语义、闪卡按钮化 + 背面 `aria-hidden`、强制高对比模式回退。

### 新增 — 响应式

- 1360 / 1180 / 1040 / 940 / 880 断点体系；≤880px 三栏改纵向堆叠、页面整体滚动、聊天区有界滚动、420px 顶栏单行。

### 修复

- **产物弹窗缺「⬇ 下载」按钮**：`GET /api/artifacts/:id` 响应缺失 `has_download` 契约字段（前后端双修：server 补字段 + 前端 fallback）。
- 产物删除增加二次确认，删除按钮移至末位且不再获得默认焦点；折叠面板切换按钮在折叠态可见可点。
- 移动端布局不可滚动问题（`display: revert` 误伤 grid）。

### 验证

- 双代理两轮独立审计：a11y（P0 全清、P1 对比度全达标，报告 `a11y-consistency.md`）；运行时 T1–T14 矩阵（20+ 场景零控制台错误，报告 `runtime.md`）。
