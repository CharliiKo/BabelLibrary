// 余弦相似度 + Top-K 检索（本地向量检索，模拟百炼知识库的向量召回）

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * @param {{chunks: Array}} index 含 vector 的切片集合
 * @param {number[]} queryVec 查询向量
 * @param {{top_k?:number, threshold?:number}} options
 */
function retrieve(index, queryVec, options = {}) {
  const topK = options.top_k || 5;
  const threshold = options.threshold == null ? 0.02 : options.threshold;
  return (index.chunks || [])
    .map((c) => ({ chunk: c, score: cosine(c.vector, queryVec) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = { cosine, retrieve };
