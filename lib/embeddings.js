// 向量化：真实模式调用百炼 DashScope text-embedding 接口；
// 模拟模式使用「词袋 + CJK 二元组哈希」伪向量，保证无凭据时原型全链路可跑

const DASHSCOPE_BASE = () => process.env.DASHSCOPE_BASE || 'https://dashscope.aliyuncs.com';
const MOCK_DIM = 512;

function realAvailable() {
  return !!process.env.DASHSCOPE_API_KEY && process.env.KB_EMBED_MODE !== 'mock';
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

async function realEmbed(texts, textType) {
  const key = process.env.DASHSCOPE_API_KEY;
  const model = process.env.KB_EMBED_MODEL || 'text-embedding-v4';
  const out = [];
  for (let i = 0; i < texts.length; i += 10) {
    const batch = texts.slice(i, i + 10);
    const parameters = { text_type: textType || 'document' };
    if (/v4/i.test(model)) parameters.dimension = 1024;
    const res = await fetch(`${DASHSCOPE_BASE()}/api/v1/services/embeddings/text-embedding/text-embedding`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: { texts: batch }, parameters }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.output || !Array.isArray(json.output.embeddings)) {
      throw new Error(json.message || `向量化调用失败 HTTP ${res.status}`);
    }
    const byIndex = {};
    for (const e of json.output.embeddings) byIndex[e.text_index] = e.embedding;
    for (let j = 0; j < batch.length; j++) out.push(byIndex[j]);
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

module.exports = { embed, mockEmbed, realAvailable, tokenize };
