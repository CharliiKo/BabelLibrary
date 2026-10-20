// 向量化：真实模式支持 OpenAI 兼容 /v1/embeddings 接口与百炼原生 DashScope text-embedding 接口；
// 模拟模式使用「词袋 + CJK 二元组哈希」伪向量，保证无凭据或仅配置纯对话网关（如 Anthropic）时全链路可跑

const store = require('./store');
const MOCK_DIM = 512;

function getEmbedConfig() {
  const saved = (store.state && store.state.settings) || {};
  const apiKey =
    saved.api_key ||
    process.env.AI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.DASHSCOPE_API_KEY ||
    '';
  const baseUrl =
    saved.embed_base_url ||
    process.env.KB_EMBED_BASE_URL ||
    saved.base_url ||
    process.env.AI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    process.env.DASHSCOPE_BASE ||
    'https://dashscope.aliyuncs.com';
  const model =
    saved.embed_model ||
    process.env.KB_EMBED_MODEL ||
    (/dashscope\.aliyuncs\.com/i.test(baseUrl) ? 'text-embedding-v4' : 'text-embedding-3-small');
  const mode = process.env.KB_EMBED_MODE || 'auto';
  return { apiKey: String(apiKey).trim(), baseUrl: String(baseUrl).trim(), model: String(model).trim(), mode };
}

function realAvailable() {
  const cfg = getEmbedConfig();
  if (!cfg.apiKey || cfg.mode === 'mock') return false;
  // Anthropic 官方 API 不提供 embeddings 端点，默认直接使用本地向量化避免无谓报错
  if (/anthropic\.com/i.test(cfg.baseUrl) || /^sk-ant-/i.test(cfg.apiKey)) return false;
  return true;
}

function tokenize(text) {
  const t = [];
  const latin = String(text).toLowerCase().match(/[a-z0-9_.+-]+/g) || [];
  for (const w of latin) if (w.length > 1) t.push(w);
  const cjk = String(text).match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i < cjk.length; i++) {
    t.push(cjk[i]);
    if (i + 1 < cjk.length) t.push(cjk[i] + cjk[i + 1]);
  }
  return t;
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function mockEmbed(text) {
  const v = new Array(MOCK_DIM).fill(0);
  for (const tok of tokenize(text)) v[djb2(tok) % MOCK_DIM] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  for (let i = 0; i < MOCK_DIM; i++) v[i] /= norm;
  return v;
}

function resolveOpenAIEmbedUrl(rawBase) {
  let base = String(rawBase || '').trim().replace(/\/+$/, '');
  base = base
    .replace(/\/v1\/(responses|chat\/completions|messages|embeddings)$/i, '/v1')
    .replace(/\/(responses|chat\/completions|messages|embeddings)$/i, '');
  if (/^https?:\/\/dashscope(?:-intl)?\.aliyuncs\.com$/i.test(base)) {
    return `${base}/compatible-mode/v1/embeddings`;
  }
  return /\/(v\d+|compatible-mode\/v\d+)$/i.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
}

async function openAIEmbedBatch(batch, cfg) {
  const url = resolveOpenAIEmbedUrl(cfg.baseUrl);
  const body = { model: cfg.model, input: batch };
  if (/v4/i.test(cfg.model)) body.dimensions = 1024;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(json.data)) {
    const msg = (json.error && json.error.message) || json.message || `OpenAI Embeddings 调用失败 HTTP ${res.status}`;
    throw new Error(msg);
  }
  const byIndex = {};
  for (let idx = 0; idx < json.data.length; idx++) {
    const item = json.data[idx];
    byIndex[item.index != null ? item.index : idx] = item.embedding;
  }
  return batch.map((_, j) => byIndex[j]);
}

async function dashscopeNativeEmbedBatch(batch, textType, cfg) {
  const root = cfg.baseUrl.replace(/\/compatible-mode\/v\d+.*$/i, '').replace(/\/+$/, '');
  const parameters = { text_type: textType || 'document' };
  if (/v4/i.test(cfg.model)) parameters.dimension = 1024;
  const res = await fetch(`${root}/api/v1/services/embeddings/text-embedding/text-embedding`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, input: { texts: batch }, parameters }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.output || !Array.isArray(json.output.embeddings)) {
    throw new Error(json.message || `DashScope 向量化调用失败 HTTP ${res.status}`);
  }
  const byIndex = {};
  for (const e of json.output.embeddings) byIndex[e.text_index] = e.embedding;
  return batch.map((_, j) => byIndex[j]);
}

async function realEmbed(texts, textType) {
  const cfg = getEmbedConfig();
  const isDashscopeRoot = /^https?:\/\/dashscope(?:-intl)?\.aliyuncs\.com\/?$/i.test(cfg.baseUrl);
  const out = [];
  for (let i = 0; i < texts.length; i += 10) {
    const batch = texts.slice(i, i + 10);
    let vectors;
    if (isDashscopeRoot) {
      try {
        vectors = await dashscopeNativeEmbedBatch(batch, textType, cfg);
      } catch {
        vectors = await openAIEmbedBatch(batch, cfg);
      }
    } else {
      vectors = await openAIEmbedBatch(batch, cfg);
    }
    out.push(...vectors);
  }
  return out;
}

/**
 * @param {string[]} texts
 * @param {string} textType 'document' | 'query'
 * @param {string} forceMode 'mock' | 'real' | undefined（自动）
 * @returns {Promise<{vectors:number[][], mode:'mock'|'real', warning?:string}>}
 */
async function embed(texts, textType, forceMode) {
  if (!texts.length) return { vectors: [], mode: 'mock' };
  const wantReal = forceMode ? forceMode === 'real' : realAvailable();
  if (wantReal) {
    try {
      const vectors = await realEmbed(texts, textType);
      return { vectors, mode: 'real' };
    } catch (e) {
      console.warn('[embeddings] 真实向量化失败，回退模拟模式:', e.message);
      return {
        vectors: texts.map(mockEmbed),
        mode: 'mock',
        warning: `向量化真实调用失败已回退模拟模式：${e.message}`,
      };
    }
  }
  return { vectors: texts.map(mockEmbed), mode: 'mock' };
}

module.exports = { embed, mockEmbed, realAvailable, tokenize, getEmbedConfig };
