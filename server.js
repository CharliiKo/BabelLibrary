#!/usr/bin/env node
// 百炼知识库工作台 · 应用原型（AI Platform 多协议兼容增强版）
// 复刻阿里云百炼「ParseX 文档解析 + RAG 知识库 + 知识问答」工作流
// 同时全面兼容三大 AI Platform API（上游大模型调用 + 下游开放接口双端兼容）：
//   1. OpenAI Responses API        (/v1/responses)        [首要保障，流式零缓冲优化]
//   2. OpenAI Chat Completions API (/v1/chat/completions)
//   3. Anthropic Messages REST API (/v1/messages)
// 零依赖：仅使用 Node.js 内置模块（node >= 18）

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- 极简 .env 加载 ----------
(function loadDotEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const store = require('./lib/store');
store.load();
const { chunkMarkdown } = require('./lib/chunker');
const embeddings = require('./lib/embeddings');
const { embed } = embeddings;
const { retrieve } = require('./lib/vector');
const parsex = require('./lib/parsex');
const llm = require('./lib/llm');
const bailian = require('./lib/bailian');
const generate = require('./lib/generate');

const PORT = parseInt(process.env.KB_PORT || '8686', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAMPLES_DIR = path.join(__dirname, 'sample-docs');
const MAX_BODY = 10 * 1024 * 1024; // 10MB

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 工具 ----------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, OpenAI-Beta',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  });
  res.end(body);
}

function initSse(req, res) {
  if (req.socket && typeof req.socket.setNoDelay === 'function') {
    req.socket.setNoDelay(true);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS_HEADERS,
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function maskKey(k) {
  const s = String(k || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大（>10MB）'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    throw err;
  }
}

function publicDoc(d) {
  return {
    id: d.id,
    name: d.name,
    source: d.source, // upload | paste | url | sample
    status: d.status, // parsing | parsed | failed
    parse_mode: d.parse_mode, // local | parsex | mock
    biz_id: d.biz_id || null,
    error: d.error || null,
    chars: d.markdown ? d.markdown.length : 0,
    chunks_hint: d.chunks_hint,
    created_at: d.created_at,
  };
}

function indexStats(ix) {
  const chunks = ix.chunks || [];
  return {
    id: ix.id,
    name: ix.name,
    description: ix.description || '',
    type: ix.type || 'local', // local | remote
    bailian_index_id: ix.bailian_index_id || null,
    status: ix.status || 'ready', // building | ready
    embed_mode: ix.embed_mode || 'mock',
    document_count: (ix.documents || []).length,
    chunk_count: chunks.length,
    created_at: ix.created_at,
    documents: (ix.documents || []).map((dref) => ({
      doc_id: dref.doc_id,
      name: dref.name,
      chunk_count: (chunks.filter((c) => c.doc_id === dref.doc_id) || []).length,
    })),
  };
}

function publicNode(hit) {
  return {
    id: hit.chunk.id,
    doc_id: hit.chunk.doc_id,
    doc_name: hit.chunk.doc_name,
    heading: hit.chunk.heading,
    seq: hit.chunk.seq,
    text: hit.chunk.text,
    score: Number(hit.score.toFixed(4)),
    remote: !!hit.chunk.remote,
  };
}

// ---------- 业务流程 ----------
async function createDocument({ name, text, url, page_index, source }) {
  const doc = {
    id: store.uid('doc'),
    name: name || '未命名文档',
    source: source || 'paste',
    status: 'parsing',
    parse_mode: 'local',
    biz_id: null,
    markdown: null,
    error: null,
    chunks_hint: 0,
    created_at: new Date().toISOString(),
  };

  if (url) {
    // 走 ParseX 真实解析（异步任务）
    if (!parsex.configured()) {
      const err = new Error('URL 解析需要配置 DASHSCOPE_API_KEY 与 WORKSPACE_ID（或在 .env 中填写）。文本类文件可直接上传。');
      err.status = 400;
      throw err;
    }
    doc.parse_mode = 'parsex';
    doc.name = name || url.split('/').pop() || url;
    doc.biz_id = await parsex.submitParse({ file_url: url, file_name: doc.name, page_index });
    store.state.documents.unshift(doc);
    store.save();
    return { doc, pending: true };
  }

  // 本地解析（模拟 ParseX 输出 Markdown）
  doc.parse_mode = 'local';
  doc.markdown = parsex.localParse(doc.name, text || '');
  doc.chunks_hint = chunkMarkdown(doc.markdown).length;
  doc.status = doc.markdown ? 'parsed' : 'failed';
  if (!doc.markdown) doc.error = '未解析到文本内容';
  store.state.documents.unshift(doc);
  store.save();
  return { doc, pending: false };
}

// 读取详情时顺带轮询 ParseX 任务
async function refreshParsexDoc(doc) {
  if (doc.status !== 'parsing' || !doc.biz_id) return;
  try {
    const result = await parsex.parseResult(doc.biz_id);
    if (result.status === 'success') {
      doc.markdown = result.markdown || '';
      doc.chunks_hint = chunkMarkdown(doc.markdown).length;
      doc.status = doc.markdown ? 'parsed' : 'failed';
      if (!doc.markdown) doc.error = '任务成功但未提取到 Markdown 内容（结果字段映射可能需要调整）';
      store.save();
    } else if (result.status === 'failed') {
      doc.status = 'failed';
      doc.error = 'ParseX 解析任务失败';
      store.save();
    }
  } catch (e) {
    // 网络等问题不改变状态，下次轮询再试
    console.warn('[parsex] 轮询失败:', e.message);
  }
}

// 导入文档到知识库：切片 → 向量化 → 入库（对齐百炼导入任务管道）
async function importDocument(index, doc) {
  index.status = 'building';
  store.save();
  try {
    const chunks = chunkMarkdown(doc.markdown);
    const texts = chunks.map((c) => (c.heading ? `【${c.heading}】\n` : '') + c.text);
    const { vectors, mode, warning } = await embed(texts, 'document', index.embed_mode);
    if (index.embed_mode == null || index.status === 'building') index.embed_mode = mode;

    // 移除旧切片（重复导入时覆盖）
    index.chunks = (index.chunks || []).filter((c) => c.doc_id !== doc.id);
    index.documents = (index.documents || []).filter((d) => d.doc_id !== doc.id);

    chunks.forEach((c, i) => {
      index.chunks.push({
        id: store.uid('chunk'),
        index_id: index.id,
        doc_id: doc.id,
        doc_name: doc.name,
        heading: c.heading,
        seq: c.seq,
        text: c.text,
        vector: vectors[i],
      });
    });
    index.documents.push({ doc_id: doc.id, name: doc.name });
    index.status = 'ready';
    index.warning = warning || null;
    store.save();
    return { ok: true, chunk_count: chunks.length, embed_mode: mode, warning };
  } catch (e) {
    index.status = 'ready';
    store.save();
    throw e;
  }
}

async function retrieveLocal(index, query, topK, threshold) {
  const { vectors } = await embed([query], 'query', index.embed_mode === 'real' ? 'real' : 'mock');
  return retrieve(index, vectors[0], { top_k: topK, threshold });
}

// ---------- 知识检索辅助 ----------
async function retrieveFromIndex(index, query, topK = 5, docIds = null) {
  if (!index || !query || !query.trim()) return [];
  let nodes = [];
  if (index.type === 'remote') {
    if (!bailian.configured()) throw new Error('远端知识库检索需要配置 DASHSCOPE_API_KEY 与 WORKSPACE_ID');
    nodes = (await bailian.remoteRetrieve(index.bailian_index_id, query, topK)).map((n) => ({
      chunk: { ...n, id: store.uid('node'), doc_id: null, seq: 0 },
      score: n.score,
    }));
  } else {
    nodes = await retrieveLocal(index, query, topK, 0.02);
  }
  if (Array.isArray(docIds) && docIds.length) {
    nodes = nodes.filter((n) => n.chunk.doc_id && docIds.includes(n.chunk.doc_id));
  }
  return nodes;
}

function resolveTargetIndex(indexId, modelStr) {
  if (indexId === 'none' || indexId === false) return null;
  if (indexId) {
    const found = store.findIndex(indexId);
    if (found) return found;
  }
  if (typeof modelStr === 'string' && modelStr.startsWith('kb:')) {
    const kbId = modelStr.slice(3).trim();
    const found = store.findIndex(kbId);
    if (found) return found;
  }
  return store.state.indices[0] || null;
}

/**
 * 生成文本流（支持真实多协议大模型 + 模拟模式降级）
 */
async function* generateAnswerStream(messages, query, nodes, options = {}) {
  const nodeRefs = (nodes || []).map((n) => ({
    text: n.chunk ? n.chunk.text : n.text,
    doc_name: n.chunk ? n.chunk.doc_name : n.doc_name,
    heading: n.chunk ? n.chunk.heading : n.heading,
  }));

  if (llm.available(options)) {
    for await (const delta of llm.chatStream(messages, options)) {
      yield { text: delta, mock: false };
    }
  } else {
    const answer = llm.mockAnswer(query, nodeRefs);
    for (const piece of answer.match(/[\s\S]{1,10}/g) || []) {
      if (options.signal && options.signal.aborted) return;
      yield { text: piece, mock: true };
      await sleep(12);
    }
  }
}

// ---------- SSE 知识问答（对齐百炼 /api/v2/apps/knowledge/chat 的流式事件风格） ----------
async function handleChat(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const { index_id, query, top_k, history, protocol, model } = body;
  initSse(req, res);

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  const send = (obj) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };

  try {
    if (!query || !query.trim()) throw new Error('问题不能为空');
    send({ type: 'plan_start', message: '正在规划检索策略…' });
    const index = store.findIndex(index_id);
    if (!index) throw new Error('知识库不存在，请先在「知识库」页面创建');

    // 1) 检索（tool_calling → tool_return）
    send({ type: 'tool_calling', message: `正在知识库「${index.name}」中检索…` });
    const docIds = Array.isArray(body.doc_ids) ? body.doc_ids : null;
    const nodes = await retrieveFromIndex(index, query, top_k || 5, docIds);
    send({ type: 'tool_return', nodes: nodes.map(publicNode) });

    // 2) 生成（generation_start → generating… → generation_end）
    const cfg = llm.getConfig({ protocol, model });
    let activeProtocol = cfg.protocol;
    send({
      type: 'generation_start',
      protocol: cfg.protocol,
      model: cfg.model,
      real: llm.available({ protocol, model }),
    });

    const messages = llm.buildRagMessages(
      query,
      nodes.map((n) => ({ text: n.chunk.text, doc_name: n.chunk.doc_name, heading: n.chunk.heading })),
      history
    );

    for await (const chunk of generateAnswerStream(messages, query, nodes, {
      protocol,
      model,
      signal: abortController.signal,
      onProtocolResolved: (p) => {
        activeProtocol = p;
      },
    })) {
      send({ type: 'generating', text: chunk.text, ...(chunk.mock ? { mock: true } : {}) });
    }

    send({ type: 'generation_end', finish_reason: 'stop', protocol: activeProtocol, model: cfg.model });
  } catch (e) {
    if (!abortController.signal.aborted) {
      send({ type: 'error', message: e.message });
    }
  }
  if (!res.writableEnded) res.end();
}

// ---------- 标准 AI Platform API 兼容端点 ----------
// 从 Responses / ChatCompletions / Anthropic 请求中统一解析出 query、history、system 与上游认证透传
function extractBearerOrApiKey(req, body = {}) {
  const auth = req.headers['authorization'] || '';
  if (/^Bearer\s+(.+)$/i.test(auth)) {
    const key = auth.replace(/^Bearer\s+/i, '').trim();
    if (key && key !== 'kb-studio' && key !== 'mock') return key;
  }
  const xKey = req.headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.trim() && xKey.trim() !== 'kb-studio' && xKey.trim() !== 'mock') {
    return xKey.trim();
  }
  return body.api_key || undefined;
}

function parseIncomingMessages(rawInput, rawMessages, rawInstructions) {
  const history = [];
  const systemParts = [];
  if (typeof rawInstructions === 'string' && rawInstructions.trim()) {
    systemParts.push(rawInstructions.trim());
  }

  let list = [];
  if (typeof rawInput === 'string') {
    list = [{ role: 'user', content: rawInput }];
  } else if (Array.isArray(rawInput)) {
    list = rawInput;
  } else if (Array.isArray(rawMessages)) {
    list = rawMessages;
  }

  for (const item of list) {
    if (!item) continue;
    if (typeof item === 'string') {
      history.push({ role: 'user', content: item });
      continue;
    }
    const role = String(item.role || 'user').toLowerCase();
    const text = llm.contentToText(item.content ?? item.text ?? '');
    if (!text) continue;
    if (role === 'system' || role === 'developer') {
      systemParts.push(text);
    } else {
      history.push({ role: role === 'assistant' ? 'assistant' : 'user', content: text });
    }
  }

  let query = '';
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      query = history[i].content;
      history.splice(i, 1);
      break;
    }
  }
  if (!query && history.length) {
    query = history.pop().content;
  }

  return {
    query: query.trim(),
    history,
    system: systemParts.join('\n\n').trim(),
  };
}

/**
 * 1) OpenAI Responses API 兼容服务端点 (POST /v1/responses)
 * 支持流式 (SSE: response.created -> response.output_text.delta -> response.completed) 与非流式 JSON
 */
async function handleOpenAIResponsesEndpoint(req, res) {
  const body = await readJson(req);
  const { query, history, system } = parseIncomingMessages(body.input, body.messages, body.instructions);
  if (!query) {
    return json(res, 400, {
      error: { message: 'Missing required parameter: input', type: 'invalid_request_error', param: 'input' },
    });
  }

  const meta = body.metadata || {};
  const useRag = body.rag !== false && meta.rag !== false;
  const indexId = body.index_id ?? meta.index_id;
  const docIds = body.doc_ids ?? meta.doc_ids ?? null;
  const topK = Number(body.top_k ?? meta.top_k ?? 5);
  const index = useRag ? resolveTargetIndex(indexId, body.model) : null;

  const nodes = index ? await retrieveFromIndex(index, query, topK, docIds) : [];
  const citations = nodes.map(publicNode);

  const messages = index
    ? llm.buildRagMessages(
        query,
        nodes.map((n) => ({ text: n.chunk.text, doc_name: n.chunk.doc_name, heading: n.chunk.heading })),
        history,
        system
      )
    : [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...history,
        { role: 'user', content: query },
      ];

  const passKey = extractBearerOrApiKey(req, body);
  const cfg = llm.getConfig({ api_key: passKey, model: body.model && !String(body.model).startsWith('kb:') ? body.model : undefined });
  const respId = store.uid('resp');
  const msgId = store.uid('msg');
  const createdAt = Math.floor(Date.now() / 1000);
  const modelName = body.model || cfg.model || 'kb-studio';
  const isStream = Boolean(body.stream);

  const llmOpts = {
    api_key: passKey,
    model: body.model && !String(body.model).startsWith('kb:') ? body.model : cfg.model,
    temperature: body.temperature,
    max_output_tokens: body.max_output_tokens ?? body.max_tokens,
    protocol: body.protocol || cfg.protocol,
  };

  if (!isStream) {
    let fullText = '';
    for await (const chunk of generateAnswerStream(messages, query, nodes, llmOpts)) {
      fullText += chunk.text;
    }
    const responseObj = {
      id: respId,
      object: 'response',
      created_at: createdAt,
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: system || null,
      model: modelName,
      output: [
        {
          type: 'message',
          id: msgId,
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: fullText,
              annotations: citations.map((c, idx) => ({
                type: 'file_citation',
                index: idx + 1,
                file_id: c.doc_id || c.id,
                filename: c.doc_name,
                heading: c.heading || '',
                score: c.score,
              })),
            },
          ],
        },
      ],
      output_text: fullText,
      usage: {
        input_tokens: query.length,
        output_tokens: fullText.length,
        total_tokens: query.length + fullText.length,
      },
      metadata: {
        ...meta,
        index_id: index ? index.id : null,
        citations,
      },
    };
    return json(res, 200, responseObj);
  }

  // 流式 Responses API SSE
  initSse(req, res);
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());
  llmOpts.signal = abortController.signal;

  let seq = 0;
  const emitEvent = (type, payload) => {
    if (res.writableEnded) return;
    const data = { type, sequence_number: seq++, ...payload };
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const baseResp = {
    id: respId,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress',
    error: null,
    model: modelName,
    output: [],
  };

  try {
    emitEvent('response.created', { response: baseResp });
    emitEvent('response.in_progress', { response: baseResp });
    emitEvent('response.output_item.added', {
      output_index: 0,
      item: {
        id: msgId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    emitEvent('response.content_part.added', {
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });

    let fullText = '';
    for await (const chunk of generateAnswerStream(messages, query, nodes, llmOpts)) {
      if (!chunk.text) continue;
      fullText += chunk.text;
      emitEvent('response.output_text.delta', {
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        delta: chunk.text,
      });
    }

    const completedPart = {
      type: 'output_text',
      text: fullText,
      annotations: citations.map((c, idx) => ({
        type: 'file_citation',
        index: idx + 1,
        file_id: c.doc_id || c.id,
        filename: c.doc_name,
        heading: c.heading || '',
        score: c.score,
      })),
    };
    const completedItem = {
      id: msgId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [completedPart],
    };

    emitEvent('response.output_text.done', {
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      text: fullText,
    });
    emitEvent('response.content_part.done', {
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      part: completedPart,
    });
    emitEvent('response.output_item.done', {
      output_index: 0,
      item: completedItem,
    });
    emitEvent('response.completed', {
      response: {
        ...baseResp,
        status: 'completed',
        output: [completedItem],
        output_text: fullText,
        usage: {
          input_tokens: query.length,
          output_tokens: fullText.length,
          total_tokens: query.length + fullText.length,
        },
        metadata: {
          ...meta,
          index_id: index ? index.id : null,
          citations,
        },
      },
    });
    if (!res.writableEnded) res.write('data: [DONE]\n\n');
  } catch (err) {
    if (!abortController.signal.aborted) {
      emitEvent('response.failed', {
        response: {
          ...baseResp,
          status: 'failed',
          error: { code: 'server_error', message: err.message },
        },
        error: { code: 'server_error', message: err.message },
      });
    }
  }
  if (!res.writableEnded) res.end();
}

/**
 * 2) OpenAI Chat Completions 兼容服务端点 (POST /v1/chat/completions)
 */
async function handleOpenAIChatCompletionsEndpoint(req, res) {
  const body = await readJson(req);
  const { query, history, system } = parseIncomingMessages(body.input, body.messages, body.instructions);
  if (!query) {
    return json(res, 400, {
      error: { message: 'Missing required parameter: messages', type: 'invalid_request_error', param: 'messages' },
    });
  }

  const useRag = body.rag !== false;
  const index = useRag ? resolveTargetIndex(body.index_id, body.model) : null;
  const nodes = index ? await retrieveFromIndex(index, query, body.top_k || 5, body.doc_ids || null) : [];
  const citations = nodes.map(publicNode);

  const messages = index
    ? llm.buildRagMessages(
        query,
        nodes.map((n) => ({ text: n.chunk.text, doc_name: n.chunk.doc_name, heading: n.chunk.heading })),
        history,
        system
      )
    : [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...history,
        { role: 'user', content: query },
      ];

  const passKey = extractBearerOrApiKey(req, body);
  const cfg = llm.getConfig({ api_key: passKey });
  const chatId = store.uid('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  const modelName = body.model || cfg.model || 'kb-studio';
  const isStream = Boolean(body.stream);

  const llmOpts = {
    api_key: passKey,
    model: body.model && !String(body.model).startsWith('kb:') ? body.model : cfg.model,
    temperature: body.temperature,
    max_tokens: body.max_tokens ?? body.max_completion_tokens,
    protocol: body.protocol || cfg.protocol,
  };

  if (!isStream) {
    let fullText = '';
    for await (const chunk of generateAnswerStream(messages, query, nodes, llmOpts)) {
      fullText += chunk.text;
    }
    return json(res, 200, {
      id: chatId,
      object: 'chat.completion',
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: fullText },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: query.length,
        completion_tokens: fullText.length,
        total_tokens: query.length + fullText.length,
      },
      citations,
    });
  }

  initSse(req, res);
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());
  llmOpts.signal = abortController.signal;

  const sendChunk = (delta, finishReason = null, extra = {}) => {
    if (res.writableEnded) return;
    const frame = {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    };
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  };

  try {
    sendChunk({ role: 'assistant', content: '' }, null);
    for await (const chunk of generateAnswerStream(messages, query, nodes, llmOpts)) {
      if (chunk.text) sendChunk({ content: chunk.text }, null);
    }
    sendChunk({}, 'stop', { citations });
    if (!res.writableEnded) res.write('data: [DONE]\n\n');
  } catch (err) {
    if (!abortController.signal.aborted && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\n`);
    }
  }
  if (!res.writableEnded) res.end();
}

/**
 * 3) Anthropic Messages REST API 兼容服务端点 (POST /v1/messages)
 */
async function handleAnthropicMessagesEndpoint(req, res) {
  const body = await readJson(req);
  const sysText = llm.contentToText(body.system || '');
  const { query, history, system } = parseIncomingMessages(null, body.messages, sysText);
  if (!query) {
    return json(res, 400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'messages: field required' },
    });
  }

  const meta = body.metadata || {};
  const useRag = body.rag !== false && meta.rag !== false;
  const index = useRag ? resolveTargetIndex(body.index_id ?? meta.index_id, body.model) : null;
  const nodes = index ? await retrieveFromIndex(index, query, body.top_k || 5, body.doc_ids || null) : [];
  const citations = nodes.map(publicNode);

  const messages = index
    ? llm.buildRagMessages(
        query,
        nodes.map((n) => ({ text: n.chunk.text, doc_name: n.chunk.doc_name, heading: n.chunk.heading })),
        history,
        system
      )
    : [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...history,
        { role: 'user', content: query },
      ];

  const passKey = extractBearerOrApiKey(req, body);
  const cfg = llm.getConfig({ api_key: passKey });
  const msgId = store.uid('msg');
  const modelName = body.model || cfg.model || 'claude-3-5-sonnet-latest';
  const isStream = Boolean(body.stream);

  const llmOpts = {
    api_key: passKey,
    model: body.model && !String(body.model).startsWith('kb:') ? body.model : cfg.model,
    temperature: body.temperature,
    max_tokens: body.max_tokens || 4096,
    protocol: body.protocol || cfg.protocol,
  };

  if (!isStream) {
    let fullText = '';
    for await (const chunk of generateAnswerStream(messages, query, nodes, llmOpts)) {
      fullText += chunk.text;
    }
    return json(res, 200, {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: modelName,
      content: [{ type: 'text', text: fullText, citations }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: query.length,
        output_tokens: fullText.length,
      },
    });
  }

  initSse(req, res);
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());
  llmOpts.signal = abortController.signal;

  const sendAnthropicEvent = (event, dataObj) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...dataObj })}\n\n`);
  };

  try {
    sendAnthropicEvent('message_start', {
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: modelName,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: query.length, output_tokens: 1 },
      },
    });
    sendAnthropicEvent('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    });

    let outLen = 0;
    for await (const chunk of generateAnswerStream(messages, query, nodes, llmOpts)) {
      if (!chunk.text) continue;
      outLen += chunk.text.length;
      sendAnthropicEvent('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: chunk.text },
      });
    }

    sendAnthropicEvent('content_block_stop', { index: 0 });
    sendAnthropicEvent('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outLen },
    });
    sendAnthropicEvent('message_stop', {});
  } catch (err) {
    if (!abortController.signal.aborted) {
      sendAnthropicEvent('error', {
        error: { type: 'api_error', message: err.message },
      });
    }
  }
  if (!res.writableEnded) res.end();
}

function handleModelsEndpoint(req, res) {
  const cfg = llm.getConfig();
  const created = Math.floor(Date.now() / 1000);
  const models = [
    { id: cfg.model, object: 'model', created, owned_by: 'ai-platform' },
    { id: 'kb-default', object: 'model', created, owned_by: 'kb-studio' },
    ...store.state.indices.map((ix) => ({
      id: `kb:${ix.id}`,
      object: 'model',
      created,
      owned_by: 'kb-studio',
      description: ix.name,
    })),
  ];
  return json(res, 200, { object: 'list', data: models });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    // ---- 标准 AI Platform 开放兼容接口（Responses / Chat Completions / Anthropic Messages / Models） ----
    if (
      (p === '/v1/responses' || p === '/api/v1/responses' || p === '/compatible-mode/v1/responses') &&
      req.method === 'POST'
    ) {
      return await handleOpenAIResponsesEndpoint(req, res);
    }

    if (
      (p === '/v1/chat/completions' ||
        p === '/api/v1/chat/completions' ||
        p === '/compatible-mode/v1/chat/completions') &&
      req.method === 'POST'
    ) {
      return await handleOpenAIChatCompletionsEndpoint(req, res);
    }

    if (
      (p === '/v1/messages' || p === '/api/v1/messages' || p === '/apps/anthropic/v1/messages') &&
      req.method === 'POST'
    ) {
      return await handleAnthropicMessagesEndpoint(req, res);
    }

    if (
      (p === '/v1/models' || p === '/api/v1/models' || p === '/compatible-mode/v1/models') &&
      req.method === 'GET'
    ) {
      return handleModelsEndpoint(req, res);
    }

    // ---- 静态资源 ----
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      return serveStatic(p, res);
    }

    // ---- 状态 ----
    if (p === '/api/status' && req.method === 'GET') {
      const llmCfg = llm.getConfig();
      const embedCfg = embeddings.getEmbedConfig();
      return json(res, 200, {
        app: 'bailian-kb-studio',
        version: '0.2.0',
        modes: {
          parsex: { real: parsex.configured(), workspace_id: process.env.WORKSPACE_ID || null },
          embed: { real: embeddings.realAvailable(), model: embedCfg.model },
          llm: {
            real: llm.available(),
            model: llmCfg.model,
            protocol: llmCfg.protocol,
            base_url: llmCfg.baseUrl,
            auto_fallback: llmCfg.autoFallback,
            supported_protocols: ['responses', 'chat_completions', 'anthropic', 'auto'],
          },
        },
        counts: {
          documents: store.state.documents.length,
          indices: store.state.indices.length,
          chunks: store.state.indices.reduce((s, i) => s + (i.chunks || []).length, 0),
        },
      });
    }

    // ---- AI Platform 配置管理与连接测试 ----
    if (p === '/api/settings' && req.method === 'GET') {
      const cfg = llm.getConfig();
      const embedCfg = embeddings.getEmbedConfig();
      return json(res, 200, {
        settings: {
          protocol: cfg.protocol,
          base_url: cfg.baseUrl,
          has_api_key: Boolean(cfg.apiKey),
          api_key_masked: maskKey(cfg.apiKey),
          model: cfg.model,
          embed_model: embedCfg.model,
          embed_base_url: (store.state.settings && store.state.settings.embed_base_url) || '',
          temperature: cfg.temperature,
          max_tokens: cfg.maxTokens,
          auto_fallback: cfg.autoFallback,
          mode: cfg.mode,
          resolved_endpoints: {
            responses: llm.resolveEndpointUrl(cfg.baseUrl, 'responses'),
            chat_completions: llm.resolveEndpointUrl(cfg.baseUrl, 'chat_completions'),
            anthropic: llm.resolveEndpointUrl(cfg.baseUrl, 'anthropic'),
          },
        },
      });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req);
      const updated = llm.updateRuntimeConfig(body);
      return json(res, 200, {
        ok: true,
        settings: {
          protocol: updated.protocol,
          base_url: updated.baseUrl,
          has_api_key: Boolean(updated.apiKey),
          api_key_masked: maskKey(updated.apiKey),
          model: updated.model,
          temperature: updated.temperature,
          max_tokens: updated.maxTokens,
          auto_fallback: updated.autoFallback,
          mode: updated.mode,
          resolved_endpoints: {
            responses: llm.resolveEndpointUrl(updated.baseUrl, 'responses'),
            chat_completions: llm.resolveEndpointUrl(updated.baseUrl, 'chat_completions'),
            anthropic: llm.resolveEndpointUrl(updated.baseUrl, 'anthropic'),
          },
        },
      });
    }

    if (p === '/api/llm/test' && req.method === 'POST') {
      const body = await readJson(req);
      const overrides = { ...body };
      if (overrides.api_key === '__KEEP__' || !overrides.api_key) {
        delete overrides.api_key;
      }
      const result = await llm.testConnection(overrides);
      return json(res, 200, result);
    }

    // ---- 文档解析 ----
    if (p === '/api/parse' && req.method === 'POST') {
      const body = await readJson(req);
      const { doc, pending } = await createDocument(body);
      return json(res, 200, { document: publicDoc(doc), pending });
    }

    if (p === '/api/documents' && req.method === 'GET') {
      return json(res, 200, { documents: store.state.documents.map(publicDoc) });
    }

    let m = p.match(/^\/api\/documents\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const doc = store.findDoc(decodeURIComponent(m[1]));
      if (!doc) return json(res, 404, { error: '文档不存在' });
      await refreshParsexDoc(doc);
      return json(res, 200, { document: publicDoc(doc), markdown: doc.markdown || '' });
    }

    m = p.match(/^\/api\/documents\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      store.state.documents = store.state.documents.filter((d) => d.id !== id);
      for (const ix of store.state.indices) {
        ix.chunks = (ix.chunks || []).filter((c) => c.doc_id !== id);
        ix.documents = (ix.documents || []).filter((d) => d.doc_id !== id);
      }
      store.save();
      return json(res, 200, { ok: true });
    }

    // ---- 示例文档 ----
    if (p === '/api/samples' && req.method === 'GET') {
      const names = fs.existsSync(SAMPLES_DIR)
        ? fs.readdirSync(SAMPLES_DIR).filter((f) => /\.md$/i.test(f))
        : [];
      return json(res, 200, { samples: names });
    }

    m = p.match(/^\/api\/parse\/sample\/(.+)$/);
    if (m && req.method === 'POST') {
      const name = decodeURIComponent(m[1]);
      const file = path.join(SAMPLES_DIR, name);
      if (!file.startsWith(SAMPLES_DIR) || !fs.existsSync(file)) {
        return json(res, 404, { error: '示例文档不存在' });
      }
      const { doc } = await createDocument({
        name,
        text: fs.readFileSync(file, 'utf8'),
        source: 'sample',
      });
      return json(res, 200, { document: publicDoc(doc) });
    }

    // ---- 知识库管理 ----
    if (p === '/api/indices' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.name || !body.name.trim()) return json(res, 400, { error: '知识库名称不能为空' });
      const index = {
        id: store.uid('kb'),
        name: body.name.trim(),
        description: (body.description || '').trim(),
        type: body.type === 'remote' ? 'remote' : 'local',
        bailian_index_id: body.type === 'remote' ? body.bailian_index_id : null,
        status: 'ready',
        embed_mode: null,
        chunks: [],
        documents: [],
        created_at: new Date().toISOString(),
      };
      if (index.type === 'remote' && !index.bailian_index_id) {
        return json(res, 400, { error: '创建远端知识库需要填写百炼 index_id' });
      }
      store.state.indices.unshift(index);
      store.save();
      return json(res, 200, { index: indexStats(index) });
    }

    if (p === '/api/indices' && req.method === 'GET') {
      return json(res, 200, { indices: store.state.indices.map(indexStats) });
    }

    m = p.match(/^\/api\/indices\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const ix = store.findIndex(decodeURIComponent(m[1]));
      if (!ix) return json(res, 404, { error: '知识库不存在' });
      const stats = indexStats(ix);
      stats.chunks_preview = (ix.chunks || [])
        .slice(0, 20)
        .map((c) => ({
          id: c.id,
          doc_name: c.doc_name,
          heading: c.heading,
          seq: c.seq,
          text: c.text.slice(0, 200),
          score_sample: c.vector ? c.vector.length : 0,
        }));
      return json(res, 200, { index: stats, warning: ix.warning || null });
    }

    m = p.match(/^\/api\/indices\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      store.state.indices = store.state.indices.filter((i) => i.id !== decodeURIComponent(m[1]));
      store.save();
      return json(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/indices\/([^/]+)\/import$/);
    if (m && req.method === 'POST') {
      const ix = store.findIndex(decodeURIComponent(m[1]));
      if (!ix) return json(res, 404, { error: '知识库不存在' });
      if (ix.type === 'remote') return json(res, 400, { error: '远端知识库由百炼托管，无需本地导入' });
      const body = await readJson(req);
      const doc = store.findDoc(body.document_id);
      if (!doc) return json(res, 404, { error: '文档不存在' });
      if (doc.status !== 'parsed' || !doc.markdown) return json(res, 400, { error: '文档尚未完成解析' });
      // 异步执行导入（切片 → 向量化 → 入库），前端轮询状态
      importDocument(ix, doc).catch((e) => {
        ix.status = 'ready';
        ix.warning = `导入失败：${e.message}`;
        store.save();
        console.error('[import] 失败:', e);
      });
      return json(res, 202, { ok: true, status: 'building' });
    }

    m = p.match(/^\/api\/indices\/([^/]+)\/documents\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const ix = store.findIndex(decodeURIComponent(m[1]));
      if (!ix) return json(res, 404, { error: '知识库不存在' });
      const docId = decodeURIComponent(m[2]);
      ix.chunks = (ix.chunks || []).filter((c) => c.doc_id !== docId);
      ix.documents = (ix.documents || []).filter((d) => d.doc_id !== docId);
      store.save();
      return json(res, 200, { ok: true });
    }

    // ---- 检索测试 ----
    m = p.match(/^\/api\/indices\/([^/]+)\/retrieve$/);
    if (m && req.method === 'POST') {
      const ix = store.findIndex(decodeURIComponent(m[1]));
      if (!ix) return json(res, 404, { error: '知识库不存在' });
      const body = await readJson(req);
      if (!body.query) return json(res, 400, { error: '查询内容不能为空' });
      let nodes;
      if (ix.type === 'remote') {
        nodes = (await bailian.remoteRetrieve(ix.bailian_index_id, body.query, body.top_k || 5)).map((n) => ({
          chunk: { ...n, id: store.uid('node'), doc_id: null, seq: 0 },
          score: n.score,
        }));
      } else {
        nodes = await retrieveLocal(ix, body.query, body.top_k || 5, body.threshold == null ? 0.02 : body.threshold);
      }
      return json(res, 200, { query: body.query, nodes: nodes.map(publicNode) });
    }

    // ---- 知识问答（SSE） ----
    if (p === '/api/chat' && req.method === 'POST') {
      return await handleChat(req, res);
    }

    // ---- Output 产物（NotebookLM 式生成） ----
    if (p === '/api/artifacts' && req.method === 'GET') {
      const idx = url.searchParams.get('index_id');
      const list = store.state.artifacts.filter((a) => !idx || a.index_id === idx);
      return json(res, 200, {
        artifacts: list.map((a) => ({
          id: a.id,
          type: a.type,
          title: a.title,
          index_id: a.index_id,
          created_at: a.created_at,
          has_download: !!a.download,
        })),
      });
    }

    if (p === '/api/artifacts' && req.method === 'POST') {
      const body = await readJson(req);
      const ix = store.findIndex(body.index_id);
      if (!ix) return json(res, 404, { error: '知识库不存在' });
      const docIds =
        Array.isArray(body.doc_ids) && body.doc_ids.length
          ? body.doc_ids
          : (ix.documents || []).map((d) => d.doc_id);
      const chunks = (ix.chunks || []).filter((c) => docIds.includes(c.doc_id));
      if (!chunks.length) return json(res, 400, { error: '所选资料暂无可用切片，无法生成' });
      const docs = (ix.documents || [])
        .filter((d) => docIds.includes(d.doc_id))
        .map((d) => ({ id: d.doc_id, name: d.name }));
      let result;
      try {
        result = await generate.build(body.type, { notebookName: ix.name, docs, chunks });
      } catch (e) {
        return json(res, 500, { error: '生成失败: ' + e.message });
      }
      const art = {
        id: store.uid('art'),
        type: body.type,
        index_id: ix.id,
        doc_ids: docIds,
        title: result.title,
        content: result.content,
        download: result.download || null,
        created_at: new Date().toISOString(),
      };
      store.state.artifacts.unshift(art);
      store.save();
      return json(res, 200, {
        artifact: { id: art.id, type: art.type, title: art.title, created_at: art.created_at, has_download: !!art.download },
      });
    }

    m = p.match(/^\/api\/artifacts\/([^/]+)\/download$/);
    if (m && req.method === 'GET') {
      const a = store.state.artifacts.find((x) => x.id === decodeURIComponent(m[1]));
      if (!a || !a.download) return json(res, 404, { error: '该产物不支持下载' });
      res.writeHead(200, {
        'Content-Type': a.download.mime,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.download.filename)}`,
      });
      return res.end(Buffer.from(a.download.text, 'utf8'));
    }

    m = p.match(/^\/api\/artifacts\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const a = store.state.artifacts.find((x) => x.id === decodeURIComponent(m[1]));
      if (!a) return json(res, 404, { error: '产物不存在' });
      // 单个产物也返回 has_download：前端据此决定是否显示「下载」按钮
      return json(res, 200, { artifact: { ...a, has_download: !!a.download } });
    }

    m = p.match(/^\/api\/artifacts\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      store.state.artifacts = store.state.artifacts.filter((x) => x.id !== decodeURIComponent(m[1]));
      store.save();
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: '接口不存在: ' + p });
  } catch (e) {
    console.error('[server]', req.method, p, e.message);
    json(res, e.status || 500, { error: e.message });
  }
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(p, res) {
  let file = p === '/' ? '/index.html' : p;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    const llmCfg = llm.getConfig();
    const modes = [
      parsex.configured() ? 'ParseX: 真实' : 'ParseX: 本地模拟',
      embeddings.realAvailable() ? '向量: 真实' : '向量: 模拟',
      llm.available() ? `问答: 真实 (${llmCfg.protocol} / ${llmCfg.model})` : '问答: 模拟',
    ];
    console.log(`[kb-studio] 知识库工作台已启动: http://127.0.0.1:${PORT}`);
    console.log(`[kb-studio] 运行模式 → ${modes.join(' | ')}`);
  });
}

module.exports = { server };
