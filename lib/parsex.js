// ParseX 文档解析客户端
// 真实模式：POST /api/v2/apps/parse-x/parse/submit 提交任务（file_url → biz_id），
// /api/v2/apps/parse-x/parse/result 轮询结果（异步任务，status: processing|success|failed）
// 本地模式：直接解析文本类文件（md/txt/csv/json/html），模拟 ParseX 的输出格式

function configured() {
  return !!(process.env.DASHSCOPE_API_KEY && process.env.WORKSPACE_ID);
}

function baseUrl() {
  return `https://${process.env.WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com`;
}

/**
 * 提交解析任务
 * @param {{file_url:string, file_name?:string, page_index?:string, image_caption?:boolean}} input
 * @returns {Promise<string>} biz_id
 */
async function submitParse(input) {
  const body = {
    file_url: input.file_url,
    file_name: input.file_name || input.file_url.split('/').pop() || 'document',
    output: { output_file_format: ['markdown'], layout_table_format: 'markdown' },
  };
  if (input.page_index || input.image_caption != null) {
    body.processing = {
      doc_processing_config: {
        ...(input.page_index ? { page_index: input.page_index } : {}),
        ...(input.image_caption != null ? { image_caption: input.image_caption } : {}),
      },
    };
  }
  const res = await fetch(`${baseUrl()}/api/v2/apps/parse-x/parse/submit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (json.data && json.data.biz_id) return json.data.biz_id;
  throw new Error(json.message || `ParseX 提交失败 HTTP ${res.status}`);
}

/**
 * 查询解析结果（异步轮询）
 * @returns {Promise<{status:'processing'|'success'|'failed', markdown?:string, raw:object}>}
 */
async function parseResult(bizId) {
  const res = await fetch(`${baseUrl()}/api/v2/apps/parse-x/parse/result`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ biz_id: bizId }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.code && json.code !== 'Success') {
    throw new Error(json.message || `ParseX 查询失败 HTTP ${res.status}`);
  }
  const data = json.data || {};
  const status = data.status === 'success' ? 'success' : data.status === 'failed' ? 'failed' : 'processing';
  return { status, markdown: extractMarkdown(data), raw: json };
}

// 防御式提取：ParseX 结果字段以实际返回为准，这里递归查找 markdown/长文本字段
function extractMarkdown(node, depth = 0) {
  if (node == null || depth > 4) return null;
  if (typeof node === 'string') return node.length > 50 ? node : null;
  if (typeof node !== 'object') return null;
  for (const k of ['markdown', 'result_markdown', 'content', 'text', 'result']) {
    const v = node[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const v of Object.values(node)) {
    const found = extractMarkdown(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * 本地解析文本类文件，输出 Markdown（模拟 ParseX 输出）
 */
function localParse(fileName, rawText) {
  let text = String(rawText || '');
  if (/\.(html?|xml)$/i.test(fileName)) {
    text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    text = text.replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<[^>]+>/g, ' ');
  }
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

module.exports = { configured, submitParse, parseResult, localParse, extractMarkdown };
