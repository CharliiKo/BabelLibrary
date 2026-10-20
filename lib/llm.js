// 大模型问答：真实模式走 DashScope OpenAI 兼容接口（SSE 流式）；
// 模拟模式生成带引用的抽取式回答，模拟百炼知识问答的流式输出体验

const DASHSCOPE_BASE = () => process.env.DASHSCOPE_BASE || 'https://dashscope.aliyuncs.com';

function chatModel() {
  return process.env.KB_CHAT_MODEL || 'qwen-plus';
}

function available() {
  return !!process.env.DASHSCOPE_API_KEY && process.env.KB_LLM_MODE !== 'mock';
}

/**
 * 流式对话，逐段 yield 文本增量
 * @param {Array<{role:string, content:string}>} messages
 */
async function* chatStream(messages, options = {}) {
  const res = await fetch(`${DASHSCOPE_BASE()}/compatible-mode/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model || chatModel(),
      messages,
      temperature: options.temperature == null ? 0.3 : options.temperature,
      stream: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`模型调用失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) yield delta;
      } catch {
        /* 忽略非 JSON 心跳行 */
      }
    }
  }
}

/**
 * 构造 RAG 提示词（对齐百炼知识问答：基于参考资料作答 + 引用标注 + 拒答）
 */
function buildRagMessages(query, nodes, history = []) {
  const refs = nodes
    .map((n, i) => `【参考资料${i + 1}】（来源：${n.doc_name}${n.heading ? ' / ' + n.heading : ''}）\n${n.text}`)
    .join('\n\n');
  const system = [
    '你是知识库问答助手。请仅依据下方参考资料回答用户问题，要求：',
    '1. 回答准确、简洁，使用中文；',
    '2. 在引用资料的相应内容后标注编号，如 [1]、[2]；',
    '3. 如果参考资料不足以回答问题，请直接说明无法从知识库中找到答案，不要编造。',
    refs ? `\n# 参考资料\n${refs}` : '\n（本次未检索到任何参考资料，请说明知识库中没有相关内容。）',
  ].join('\n');
  const messages = [{ role: 'system', content: system }];
  for (const m of (history || []).slice(-6)) {
    if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: 'user', content: query });
  return messages;
}

/**
 * 模拟回答：抽取命中最相关切片，带引用标注
 */
function mockAnswer(query, nodes) {
  if (!nodes || !nodes.length) {
    return '未能在知识库中检索到与该问题相关的内容。\n\n（当前为模拟问答模式：配置 DASHSCOPE_API_KEY 环境变量后，Playground 将调用真实大模型生成回答。）';
  }
  const parts = nodes.slice(0, 3).map((n, i) => {
    const seg = n.text.replace(/\s+/g, ' ').slice(0, 160);
    return `[${i + 1}] ${seg}…（来源：${n.doc_name}）`;
  });
  return [
    '（模拟回答：以下要点抽取自知识库中最相关的切片，仅供演示检索链路。）',
    '',
    `关于「${query}」，知识库中的相关内容要点如下：`,
    '',
    parts.join('\n\n'),
  ].join('\n');
}

/**
 * 非流式完整回答（产物生成用）
 */
async function complete(messages, options = {}) {
  let out = '';
  for await (const delta of chatStream(messages, options)) out += delta;
  return out;
}

module.exports = { available, chatStream, complete, buildRagMessages, mockAnswer, chatModel };
