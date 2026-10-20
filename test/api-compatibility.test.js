#!/usr/bin/env node
/**
 * kb-studio 兼容性自测（离线 · 模拟模式，无需任何 API Key / 外网）
 *
 * 覆盖：
 *   - /api/status 版本号（与 VERSION 文件一致）
 *   - /api/settings 读取 / 修改 / 还原（协议归一化、密钥不回显）
 *   - /v1/models 列表（含 kb:<index_id> 模型）
 *   - /v1/chat/completions  非流式 + 流式（SSE 解析、[DONE]、citations）
 *   - /v1/responses         非流式 + 流式（事件序列、output_text、file_citation）
 *   - /v1/messages          非流式 + 流式（message_start/delta/stop、无 [DONE]）
 *   - 回归：/api/parse → 建库 → 导入 → /api/chat SSE（模拟链路）
 *
 * 用法：node test/api-compatibility.test.js
 * 说明：全程使用 KB_LLM_MODE=mock 模拟问答；会创建临时知识库/文档并在结束时清理，
 *       修改 /api/settings 前会先备份并在结束时还原。
 */
'use strict';

process.env.KB_LLM_MODE = 'mock'; // 强制模拟问答，保证离线可跑
process.env.KB_EMBED_MODE = 'mock';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { server } = require('../server.js');

const VERSION_FILE = path.join(__dirname, '..', 'VERSION');
const APP_VERSION = fs.readFileSync(VERSION_FILE, 'utf8').trim();

const results = [];
async function check(id, name, fn) {
  try {
    const info = await fn();
    results.push({ id, name, ok: true, info });
  } catch (e) {
    results.push({ id, name, ok: false, info: e.message });
  }
}

async function postJson(base, p, obj, raw) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(obj === undefined ? {} : obj),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, res };
}

async function readSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames = [];
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const evLine = raw.split('\n').find((l) => l.startsWith('event:'));
      const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      const data = dataLines.join('\n');
      events.push({ event: evLine ? evLine.slice(6).trim() : null, data });
      frames.push(data);
    }
  }
  return { frames, events };
}

function sseJson(events) {
  return events
    .filter((e) => e.data !== '[DONE]')
    .map((e) => {
      try { return { event: e.event, ...JSON.parse(e.data) }; } catch { return null; }
    })
    .filter(Boolean);
}

(async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`[selftest] kb-studio v${APP_VERSION} @ ${base}（mock 模式）\n`);

  let savedBackup = null;
  let scratch = null;

  try {
    // ---------- 1. /api/status ----------
    await check('S1', '/api/status 版本与协议字段', async () => {
      const r = await (await fetch(base + '/api/status')).json();
      assert.strictEqual(r.version, APP_VERSION, `status 版本 ${r.version} != VERSION ${APP_VERSION}`);
      assert.ok(Array.isArray(r.modes.llm.supported_protocols) && r.modes.llm.supported_protocols.includes('auto'));
      return `version=${r.version}, llm.protocol=${r.modes.llm.protocol}, mock=${!r.modes.llm.real}`;
    });

    // ---------- 2. 准备临时知识库（RAG 引用需要切片） ----------
    await check('S2', '解析 → 建库 → 导入（异步）→ 切片就绪', async () => {
      const parse = await postJson(base, '/api/parse', {
        name: 'selftest-兼容性自测.md',
        text: '# 自测文档\n\n## 协议\nOpenAI Responses API 位于 /v1/responses。\n\n## 流式\nSSE 事件以 response.output_text.delta 传递增量。',
      });
      assert.strictEqual(parse.status, 200, '解析失败: ' + parse.text);
      const docId = parse.json.document.id;
      const idx = await postJson(base, '/api/indices', { name: '自测-临时知识库', description: 'api-compatibility.test.js 临时数据' });
      assert.strictEqual(idx.status, 200, '建库失败: ' + idx.text);
      const indexId = idx.json.index.id;
      const imp = await postJson(base, `/api/indices/${indexId}/import`, { document_id: docId });
      assert.ok(imp.status === 200 || imp.status === 202, `导入返回 ${imp.status}: ${imp.text}`);
      // 导入为异步（202 building），轮询等待切片入库
      const t0 = Date.now();
      for (;;) {
        const cur = await (await fetch(`${base}/api/indices/${indexId}`)).json();
        if ((cur.index.chunk_count || 0) > 0) break;
        if (Date.now() - t0 > 15000) throw new Error('导入超时：切片未入库');
        await new Promise((r) => setTimeout(r, 150));
      }
      scratch = { docId, indexId };
      return `index=${indexId}（异步导入 + 轮询就绪）`;
    });

    assert.ok(scratch, '临时知识库准备失败，无法继续协议测试');
    const kbModel = `kb:${scratch.indexId}`;

    // ---------- 3. /v1/models ----------
    await check('S3', '/v1/models 形状与 kb: 模型', async () => {
      const r = await (await fetch(base + '/v1/models')).json();
      assert.strictEqual(r.object, 'list');
      assert.ok(Array.isArray(r.data) && r.data.some((m) => m.id === kbModel), '缺少 kb:<index_id> 模型');
      return `${r.data.length} models, 含 ${kbModel}`;
    });

    // ---------- 4. /api/settings 语义 ----------
    await check('S4', '/api/settings 读取 + 协议归一化 + 还原', async () => {
      const before = (await (await fetch(base + '/api/settings')).json()).settings;
      savedBackup = { protocol: before.protocol, base_url: before.base_url, model: before.model };
      // 无效协议应归一化为 responses；非法值不落库
      const mod = await postJson(base, '/api/settings', { protocol: 'bogus-protocol', model: 'selftest-model' });
      assert.strictEqual(mod.status, 200);
      assert.strictEqual(mod.json.settings.protocol, 'responses', '无效协议未归一化为 responses');
      assert.strictEqual(mod.json.settings.model, 'selftest-model');
      // 还原
      const back = await postJson(base, '/api/settings', savedBackup);
      assert.strictEqual(back.status, 200);
      assert.strictEqual(back.json.settings.protocol, savedBackup.protocol);
      return `归一化 bogus→responses，已还原 ${savedBackup.protocol}/${savedBackup.model}`;
    });

    await check('S5', '/api/settings 密钥掩码（不回显原文）', async () => {
      const r = await (await fetch(base + '/api/settings')).json();
      assert.ok(!('api_key' in r.settings), '响应不应包含 api_key 原文字段');
      return `api_key_masked="${r.settings.api_key_masked}"`;
    });

    // ---------- 5. /v1/chat/completions ----------
    await check('S6', '/v1/chat/completions 非流式', async () => {
      const r = await postJson(base, '/v1/chat/completions', {
        model: kbModel,
        messages: [{ role: 'user', content: '自测：这些资料的要点？' }],
        stream: false,
      });
      assert.strictEqual(r.status, 200);
      const j = r.json;
      assert.strictEqual(j.object, 'chat.completion');
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      assert.ok(typeof text === 'string' && text.length > 0, 'choices[0].message.content 为空');
      assert.ok(Array.isArray(j.citations) && j.citations.length > 0, '缺少 citations');
      return `object=chat.completion, ${text.length} 字, ${j.citations.length} 引用`;
    });

    await check('S7', '/v1/chat/completions 流式（delta + [DONE]）', async () => {
      const res = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: kbModel, messages: [{ role: 'user', content: '自测：流式要点？' }], stream: true }),
      });
      assert.strictEqual(res.status, 200);
      const { frames, events } = await readSSE(res);
      assert.strictEqual(frames[frames.length - 1], '[DONE]', '流未以 [DONE] 结束');
      const chunks = sseJson(events);
      let text = '';
      let cited = false;
      for (const c of chunks) {
        if (c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content) text += c.choices[0].delta.content;
        if (Array.isArray(c.citations) && c.citations.length) cited = true;
      }
      assert.ok(text.length > 0, '流式未产出增量文本');
      assert.ok(cited, '流式缺少 citations');
      assert.ok(chunks.every((c) => c.object === undefined || c.object === 'chat.completion.chunk'));
      return `${chunks.length} chunks, ${text.length} 字, 含 citations`;
    });

    // ---------- 6. /v1/responses ----------
    await check('S8', '/v1/responses 非流式（output_text + file_citation）', async () => {
      const r = await postJson(base, '/v1/responses', { model: kbModel, input: '自测：协议要点？', stream: false });
      assert.strictEqual(r.status, 200);
      const j = r.json;
      assert.strictEqual(j.object, 'response');
      assert.strictEqual(j.status, 'completed');
      assert.ok(typeof j.output_text === 'string' && j.output_text.length > 0, 'output_text 为空');
      const content = j.output && j.output[0] && j.output[0].content && j.output[0].content[0];
      assert.ok(content && content.type === 'output_text', '缺少 output_text 内容块');
      const ann = (content && content.annotations) || [];
      assert.ok(ann.length > 0 && ann[0].type === 'file_citation', '缺少 file_citation 注解');
      return `status=completed, ${j.output_text.length} 字, ${ann.length} file_citation`;
    });

    await check('S9', '/v1/responses 流式（事件序列）', async () => {
      const res = await fetch(base + '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: kbModel, input: '自测：流式协议？', stream: true }),
      });
      assert.strictEqual(res.status, 200);
      const { events } = await readSSE(res);
      const evs = sseJson(events);
      const types = evs.map((e) => e.type || e.event);
      assert.ok(types.includes('response.created'), '缺少 response.created');
      assert.ok(types.includes('response.output_text.delta'), '缺少 response.output_text.delta');
      assert.ok(types.includes('response.completed'), '缺少 response.completed');
      const text = evs.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
      assert.ok(text.length > 0, '流式未产出增量文本');
      return `事件 ${types.length} 个（created→delta×${types.filter((t) => t === 'response.output_text.delta').length}→completed）`;
    });

    // ---------- 7. /v1/messages ----------
    await check('S10', '/v1/messages 非流式（system 抽取 + citations）', async () => {
      const r = await postJson(base, '/v1/messages', {
        model: kbModel,
        system: '仅依据资料回答',
        messages: [{ role: 'user', content: '自测：流式说明？' }],
        stream: false,
        max_tokens: 512,
      });
      assert.strictEqual(r.status, 200);
      const j = r.json;
      assert.strictEqual(j.type, 'message');
      assert.strictEqual(j.role, 'assistant');
      const text = j.content && j.content[0] && j.content[0].text;
      assert.ok(typeof text === 'string' && text.length > 0, 'content[0].text 为空');
      // Anthropic 风格：citations 附在 content 块上
      const cits = (j.content && j.content[0] && j.content[0].citations) || [];
      assert.ok(Array.isArray(cits) && cits.length > 0, '缺少 content[0].citations');
      return `type=message, ${text.length} 字, ${cits.length} citations`;
    });

    await check('S11', '/v1/messages 流式（Anthropic 事件序列，无 [DONE]）', async () => {
      const res = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: kbModel,
          system: '仅依据资料回答',
          messages: [{ role: 'user', content: '自测：SSE 事件？' }],
          stream: true,
          max_tokens: 512,
        }),
      });
      assert.strictEqual(res.status, 200);
      const { frames, events } = await readSSE(res);
      assert.ok(!frames.includes('[DONE]'), 'Anthropic 流不应出现 [DONE]');
      const evs = sseJson(events);
      const types = evs.map((e) => e.type || e.event);
      assert.ok(types.includes('message_start'), '缺少 message_start');
      assert.ok(types.includes('content_block_delta'), '缺少 content_block_delta');
      assert.ok(types.includes('message_stop'), '缺少 message_stop');
      const text = evs
        .filter((e) => e.type === 'content_block_delta' && e.delta && e.delta.text)
        .map((e) => e.delta.text)
        .join('');
      assert.ok(text.length > 0, '流式未产出增量文本');
      return `事件 ${types.length} 个（start→delta×${types.filter((t) => t === 'content_block_delta').length}→stop），无 [DONE]`;
    });

    // ---------- 8. 回归：/api/chat 模拟链路 ----------
    await check('S12', '/api/chat SSE（模拟事件链）', async () => {
      const res = await fetch(base + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_id: scratch.indexId, query: '自测：回归问题' }),
      });
      assert.strictEqual(res.status, 200);
      const { events } = await readSSE(res);
      const evs = sseJson(events);
      const types = evs.map((e) => e.type);
      assert.ok(types.includes('plan_start'), '缺少 plan_start');
      assert.ok(types.includes('tool_calling'), '缺少 tool_calling');
      assert.ok(types.includes('generating'), '缺少 generating');
      assert.ok(types.includes('generation_end'), '缺少 generation_end');
      return `事件链 ${types.join(' → ')}`;
    });
  } finally {
    // ---------- 清理：临时数据 + 设置还原 ----------
    try {
      if (scratch) {
        await fetch(`${base}/api/indices/${scratch.indexId}`, { method: 'DELETE' });
        await fetch(`${base}/api/documents/${scratch.docId}`, { method: 'DELETE' });
      }
      if (savedBackup) await postJson(base, '/api/settings', savedBackup);
    } catch { /* 尽力清理 */ }
    await new Promise((resolve) => server.close(resolve));
  }

  // ---------- 汇总 ----------
  const fail = results.filter((r) => !r.ok);
  console.log('─'.repeat(72));
  for (const r of results) {
    console.log(`${r.ok ? '  ✔ PASS' : '  ✘ FAIL'}  ${r.id}  ${r.name}${r.info ? '  →  ' + r.info : ''}`);
  }
  console.log('─'.repeat(72));
  console.log(`结果：${results.length - fail.length}/${results.length} 通过${fail.length ? '，失败 ' + fail.length : ''}`);
  process.exitCode = fail.length ? 1 : 0;
})().catch((e) => {
  console.error('[selftest] 意外错误：', e);
  process.exitCode = 1;
});
