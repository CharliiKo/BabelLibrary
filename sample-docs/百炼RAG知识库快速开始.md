# 百炼 RAG 知识库快速开始

RAG（Retrieval-Augmented Generation，检索增强生成）知识库是阿里云百炼提供的知识管理与问答服务。本文档介绍如何用 5 步创建一个知识库，并完成一次检索与问答。

## 什么是 RAG 知识库

RAG 知识库将企业私有的文档资料转化为可检索的知识资产。系统自动完成四个环节：文档解析、切片（Segmentation）、向量化（Embedding）与索引构建。知识库状态变为「已就绪」后，即可用于检索和问答。

## 创建知识库的步骤

第一步，进入控制台的知识管理页面，点击「创建知识库」。第二步，填写名称和描述，知识库类型选择「文档搜索」，使用场景选择「基础文档问答」。第三步，数据来源选择「上传文件」，拖拽或点击上传一份 PDF、Word 或 Markdown 文件。第四步，索引设置保持默认，点击「创建知识库」。

系统将自动完成解析、切片、向量化与索引构建。首次登录控制台时会自动开通 RAG 知识库服务，并发放 720 小时免费额度。

## 前置条件

使用 RAG 知识库需要准备两件事：一个阿里云账号，以及一个 API Key。API Key 在控制台的 API Key 页面创建，以 sk- 开头，调用 API 时通过 Authorization Bearer 方式携带。

## API 接入方式

RAG API 的服务地址格式为 https://{workspace_id}.cn-beijing.maas.aliyuncs.com，其中 workspace_id 是业务空间 ID，格式如 llm-xxxxxxxxxxxx，可在控制台业务空间管理页面查看。

RAG API 分为三组接口：知识库管理接口位于 /api/v1/indices/ 路径下，负责知识库 CRUD、文档管理、切片管理与检索；数据导入接口位于 /api/v1/connector/dash/ 路径下，负责类目管理与文件上传；知识问答接口位于 /api/v2/apps/knowledge/ 路径下，提供 SSE 流式问答。

## 检索接口调用示例

检索接口的完整地址为 /api/v1/indices/rag/index/retrieve。请求体中包含三个关键字段：index_id 是知识库 ID，在知识管理页面点击对应知识库即可复制；query 是查询内容；top_k 指定返回的切片数量。

返回的 nodes 数组包含命中切片，按相关性分数倒序排列。所有接口通过 POST 方法调用，请求头需要携带 Authorization: Bearer $DASHSCOPE_API_KEY 和 Content-Type: application/json。

## 知识问答服务

知识问答服务基于大模型结合知识检索能力，支持绑定多个知识库（最多 15 个），自动检索相关内容并生成自然语言回答。检索模式分为两种：极速模式单轮检索后直接生成回答，适合简单明确的问题；多轮智能检索模式基于大模型进行多轮规划搜索，自动完成意图识别、Query 改写和知识库路由，适合复杂问题。

知识问答通过 chat 接口调用，返回 SSE 流式响应。事件按以下顺序返回：plan_start、planning、plan_end 表示规划阶段；tool_calling、tool_return 表示检索工具调用阶段；generation_start、generating、generation_end 表示生成阶段，generation_end 事件中 finish_reason 为 stop。

## 生成控制参数

知识问答服务提供多种生成控制参数：拒答参数开启后，当检索结果不足以回答问题时，模型拒绝回答并返回自定义的拒答话术；防泄漏参数防止知识库原文在回答中被直接泄漏；引用参数开启后，模型回答中会展示引用来源，标注回答内容出自哪个文档；多模态回复开启后，回答中会包含知识库中的图片等多模态内容。

## 多轮对话注意事项

平台不保存对话状态，每次请求需传入完整的 messages 历史。建议限制历史长度为最近 10 轮，避免超出模型上下文窗口；检索时仅基于最新一条 user message，以降低噪声。
