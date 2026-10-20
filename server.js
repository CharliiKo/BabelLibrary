#!/usr/bin/env node
// 百炼知识库工作台 · 应用原型
// 复刻阿里云百炼「ParseX 文档解析 + RAG 知识库 + 知识问答」工作流
// 零依赖：仅使用 Node.js 内置模块（node >= 18）
//
// 运行：node server.js    （默认端口 8686，可用 KB_PORT 修改）
// 可选环境变量 / .env：
//   DASHSCOPE_API_KEY   百炼 API Key（sk- 开头），配置后启用真实模型
//   WORKSPACE_ID        百炼业务空间 ID（llm-xxx），配置后启用 ParseX / 托管检索
//   KB_CHAT_MODEL       问答模型，默认 qwen-plus
//   KB_EMBED_MODEL      向量模型，默认 text-embedding-v4
//   KB_EMBED_MODE=mock / KB_LLM_MODE=mock  强制对应环节使用模拟模式

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
const { embed } = require('./lib/embeddings');
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
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
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
    throw new Error('请求体不是合法 JSON');
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

// ---------- SSE 知识问答（对齐百炼 /api/v2/apps/knowledge/chat 的流式事件风格） ----------
async function handleChat(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const { index_id, query, top_k, history } = body;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    if (!query || !query.trim()) throw new Error('问题不能为空');
    send({ type: 'plan_start', message: '正在规划检索策略…' });
    const index = store.findIndex(index_id);
    if (!index) throw new Error('知识库不存在，请先在「知识库」页面创建');

    // 1) 检索（tool_calling → tool_return）
    send({ type: 'tool_calling', message: `正在知识库「${index.name}」中检索…` });
    let nodes = [];
    if (index.type === 'remote') {
      if (!bailian.configured()) throw new Error('远端知识库检索需要配置 DASHSCOPE_API_KEY 与 WORKSPACE_ID');
      nodes = (await bailian.remoteRetrieve(index.bailian_index_id, query, top_k || 5)).map((n) => ({
        chunk: { ...n, id: store.uid('node'), doc_id: null, seq: 0 },
        score: n.score,
      }));
    } else {
      const hits = await retrieveLocal(index, query, top_k || 5, 0.02);
      nodes = hits;
    }
    // NotebookLM 式「勾选范围」：仅使用被勾选的资料支撑回答
    const docIds = Array.isArray(body.doc_ids) ? body.doc_ids : null;
    if (docIds && docIds.length) {
      nodes = nodes.filter((n) => n.chunk.doc_id && docIds.includes(n.chunk.doc_id));
    }
    send({ type: 'tool_return', nodes: nodes.map(publicNode) });

    // 2) 生成（generation_start → generating… → generation_end）
    send({ type: 'generation_start' });
    if (llm.available()) {
      const messages = llm.buildRagMessages(
        query,
        nodes.map((n) => ({ text: n.chunk.text, doc_name: n.chunk.doc_name, heading: n.chunk.heading })),
        history
      );
      for await (const delta of llm.chatStream(messages)) {
        send({ type: 'generating', text: delta });
      }
    } else {
      const answer = llm.mockAnswer(
        query,
        nodes.map((n) => ({ text: n.chunk.text, doc_name: n.chunk.doc_name }))
      );
      for (const piece of answer.match(/[\s\S]{1,8}/g) || []) {
        send({ type: 'generating', text: piece, mock: true });
        await sleep(20);
      }
    }
    send({ type: 'generation_end', finish_reason: 'stop' });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    // ---- 静态资源 ----
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      return serveStatic(p, res);
    }

    // ---- 状态 ----
    if (p === '/api/status' && req.method === 'GET') {
      return json(res, 200, {
        app: 'bailian-kb-studio',
        version: '0.1.0',
        modes: {
          parsex: { real: parsex.configured(), workspace_id: process.env.WORKSPACE_ID || null },
          embed: { real: require('./lib/embeddings').realAvailable(), model: process.env.KB_EMBED_MODEL || 'text-embedding-v4' },
          llm: { real: llm.available(), model: llm.chatModel() },
        },
        counts: {
          documents: store.state.documents.length,
          indices: store.state.indices.length,
          chunks: store.state.indices.reduce((s, i) => s + (i.chunks || []).length, 0),
        },
      });
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
        .map((c) => ({ id: c.id, doc_name: c.doc_name, heading: c.heading, seq: c.seq, text: c.text.slice(0, 200), score_sample: c.vector ? c.vector.length : 0 }));
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
      return handleChat(req, res);
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

server.listen(PORT, '127.0.0.1', () => {
  const modes = [
    parsex.configured() ? 'ParseX: 真实' : 'ParseX: 本地模拟',
    require('./lib/embeddings').realAvailable() ? '向量: 真实' : '向量: 模拟',
    llm.available() ? '问答: 真实' : '问答: 模拟',
  ];
  console.log(`[kb-studio] 知识库工作台已启动: http://127.0.0.1:${PORT}`);
  console.log(`[kb-studio] 运行模式 → ${modes.join(' | ')}`);
});
