// Markdown 感知切片：跟踪标题路径，按段落聚合，超出长度时硬切并保留重叠
// 对齐百炼知识库「解析 → 切片 → 向量化」流水线中的切片环节

function overlapTail(text, n) {
  return text.length <= n ? text : text.slice(-n);
}

function splitParagraphs(md) {
  const lines = String(md || '').split(/\r?\n/);
  const paras = [];
  let headingPath = [];
  let buf = [];

  const flush = () => {
    if (buf.length) {
      const text = buf.join('\n').trim();
      if (text) paras.push({ heading: headingPath.filter(Boolean).join(' > '), text });
      buf = [];
    }
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      flush();
      const level = m[1].length;
      headingPath = headingPath.slice(0, level - 1);
      headingPath[level - 1] = m[2].trim();
      buf.push(line);
    } else if (line.trim() === '') {
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return paras;
}

/**
 * @param {string} md 原始 Markdown 文本
 * @param {{maxLen?:number, overlap?:number}} options
 * @returns {{seq:number, heading:string, text:string}[]}
 */
function chunkMarkdown(md, options = {}) {
  const maxLen = options.maxLen || 800;
  const overlap = options.overlap || 100;
  const paras = splitParagraphs(md);
  const chunks = [];
  let cur = null;

  for (const p of paras) {
    if (p.text.length > maxLen) {
      // 超长段落硬切
      if (cur) {
        chunks.push(cur);
        cur = null;
      }
      for (let i = 0; i < p.text.length; i += maxLen - overlap) {
        chunks.push({ heading: p.heading, text: p.text.slice(i, i + maxLen) });
        if (p.text.length - i <= maxLen) break;
      }
      continue;
    }
    if (!cur) cur = { heading: p.heading, text: '' };
    const candidate = cur.text ? cur.text + '\n\n' + p.text : p.text;
    if (candidate.length > maxLen) {
      chunks.push(cur);
      const tail = overlapTail(cur.text, overlap);
      cur = { heading: p.heading, text: (tail ? tail + '\n\n' : '') + p.text };
    } else {
      cur.text = candidate;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c, i) => ({ seq: i, heading: c.heading, text: c.text }));
}

module.exports = { chunkMarkdown, splitParagraphs };
