// 百炼 RAG 托管知识库直连（真实模式）
// 对应控制台「知识管理」中已创建的知识库：POST /api/v1/indices/rag/index/retrieve

function configured() {
  return !!(process.env.DASHSCOPE_API_KEY && process.env.WORKSPACE_ID);
}

function baseUrl() {
  return `https://${process.env.WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com`;
}

/**
 * 直连百炼托管知识库执行检索
 * @returns {Promise<Array<{text:string, score:number, doc_name?:string, raw:object}>>}
 */
async function remoteRetrieve(indexId, query, topK = 5) {
  const res = await fetch(`${baseUrl()}/api/v1/indices/rag/index/retrieve`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ index_id: indexId, query, top_k: topK }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code && json.code !== 'Success')) {
    throw new Error(json.message || `远端检索失败 HTTP ${res.status}`);
  }
  const data = json.data || {};
  const nodes = data.nodes || [];
  return nodes.map((n) => ({
    text: n.text || n.content || n.node || '',
    score: typeof n.score === 'number' ? n.score : 0,
    doc_name: n.doc_name || (n.metadata && n.metadata.doc_name) || '远端切片',
    heading: '',
    remote: true,
  }));
}

module.exports = { configured, remoteRetrieve };
