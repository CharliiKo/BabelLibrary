// Output 产物生成：小测验 / 闪卡 / 心智图 / 资讯图 / Word 文档 / Excel 试算表
// 真实模式（配置 DASHSCOPE_API_KEY）下小测验/闪卡/资讯图/Word 由大模型生成；
// 模拟模式下基于切片做抽取式生成，保证无凭据时全功能可演示

const llm = require('./llm');

const TITLES = {
  quiz: '小测验',
  flashcards: '闪卡',
  mindmap: '心智图',
  infographic: '资讯图',
  word: 'Word 文档',
  excel: 'Excel 试算表',
};

function firstSentence(text, max = 90) {
  const t = String(text || '').replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim();
  const m = t.match(/^[^。！？!?\n]{6,}[。！？!?]/);
  let s = m ? m[0] : t.split(/[。\n]/)[0] || t;
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = (seed >>> 0) || 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function materialsText(chunks, cap = 12) {
  return chunks
    .slice(0, cap)
    .map((c) => `【${c.doc_name}${c.heading ? ' / ' + c.heading : ''}】\n${c.text.slice(0, 600)}`)
    .join('\n\n---\n\n');
}

function tryParseJson(text) {
  if (!text) return null;
  let t = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ---------------- 模拟生成 ---------------- */

function mockQuiz(ctx) {
  const questions = [];
  const pool = ctx.chunks.map((c) => firstSentence(c.text));
  ctx.chunks.slice(0, 5).forEach((c, i) => {
    const correct = firstSentence(c.text);
    const distractors = [];
    for (const s of seededShuffle(pool, i + 13)) {
      if (s !== correct && !distractors.includes(s) && distractors.length < 3) distractors.push(s);
    }
    while (distractors.length < 3) distractors.push('以上描述均不正确');
    const options = seededShuffle([correct, ...distractors], i + 7);
    questions.push({
      q: `根据《${c.doc_name}》${c.heading ? `「${c.heading}」部分` : ''}，下列哪项描述是正确的？`,
      options,
      answer: options.indexOf(correct),
    });
  });
  return { questions };
}

function mockCards(ctx) {
  return {
    cards: ctx.chunks.slice(0, 12).map((c) => ({
      front: c.heading ? `《${c.doc_name}》中「${c.heading}」的要点是什么？` : `请概括《${c.doc_name}》中以下内容的要点`,
      back: firstSentence(c.text, 220),
    })),
  };
}

function mockMindmap(ctx) {
  const byDoc = {};
  for (const c of ctx.chunks) (byDoc[c.doc_name] = byDoc[c.doc_name] || []).push(c);
  return {
    root: ctx.notebookName,
    children: Object.entries(byDoc).map(([doc, cs]) => {
      const byHead = {};
      for (const c of cs) (byHead[c.heading || '（正文）'] = byHead[c.heading || '（正文）'] || []).push(c);
      return {
        label: doc,
        children: Object.entries(byHead).map(([head, list]) => ({
          label: head,
          children: list.slice(0, 2).map((c) => ({ label: firstSentence(c.text, 60) })),
        })),
      };
    }),
  };
}

function mockInfographicMd(ctx) {
  const chars = ctx.chunks.reduce((s, c) => s + c.text.length, 0);
  const lines = [
    `# ${ctx.notebookName} · 资讯图`,
    '',
    `> 共 **${ctx.docs.length}** 份资料 · **${ctx.chunks.length}** 个切片 · **${chars}** 字`,
    '',
  ];
  const byDoc = {};
  for (const c of ctx.chunks) (byDoc[c.doc_name] = byDoc[c.doc_name] || []).push(c);
  for (const [doc, cs] of Object.entries(byDoc)) {
    lines.push(`## 📄 ${doc}`, '');
    cs.slice(0, 3).forEach((c, i) => lines.push(`- **要点 ${i + 1}**：${firstSentence(c.text, 120)}`));
    lines.push('');
  }
  return lines.join('\n');
}

function mockWordMd(ctx) {
  const lines = [`# ${ctx.notebookName} · 学习报告`, '', '> 由知识库工作台根据所选资料自动生成。', ''];
  const byDoc = {};
  for (const c of ctx.chunks) (byDoc[c.doc_name] = byDoc[c.doc_name] || []).push(c);
  for (const [doc, cs] of Object.entries(byDoc)) {
    lines.push(`## ${doc}`, '');
    const byHead = {};
    for (const c of cs) (byHead[c.heading || '（正文）'] = byHead[c.heading || '（正文）'] || []).push(c);
    for (const [head, list] of Object.entries(byHead)) {
      lines.push(`### ${head}`, '');
      lines.push(list.map((c) => c.text.slice(0, 400)).join('\n\n'), '');
    }
  }
  return lines.join('\n');
}

function mdToSimpleHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let t = esc(md);
  t = t.replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
  t = t.replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>');
  t = t.replace(/^[-*] (.*)$/gm, '<li>$1</li>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.split(/\n{2,}/).map((b) => (/^<(h\d|li|blockquote)/.test(b.trim()) ? b : `<p>${b.replace(/\n/g, '<br>')}</p>`)).join('\n');
  return `<html><head><meta charset="utf-8"><title>report</title></head><body style="font-family:'Microsoft YaHei',sans-serif;line-height:1.8">${t}</body></html>`;
}

function csvEscape(v) {
  const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(ctx) {
  const rows = [['文档', '章节', '切片#', '字符数', '内容']];
  for (const c of ctx.chunks) rows.push([c.doc_name, c.heading || '', c.seq, c.text.length, c.text.replace(/\s+/g, ' ')]);
  return '\ufeff' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
}

/* ---------------- 真实模式提示词 ---------------- */

async function llmQuiz(ctx) {
  const text = await llm.complete([
    {
      role: 'system',
      content:
        '你是出题助手。基于用户提供的资料生成 5 道单选题，只输出 JSON，格式：{"questions":[{"q":"题干","options":["选项1","选项2","选项3","选项4"],"answer":0}]}，answer 为正确选项下标（从 0 开始）。不要输出其他内容。',
    },
    { role: 'user', content: `资料：\n${materialsText(ctx.chunks)}` },
  ]);
  const data = tryParseJson(text);
  return data && Array.isArray(data.questions) && data.questions.length ? data : null;
}

async function llmCards(ctx) {
  const text = await llm.complete([
    {
      role: 'system',
      content: '你是学习卡片助手。基于资料生成 8~12 张问答闪卡，只输出 JSON：{"cards":[{"front":"问题","back":"答案"}]}。不要输出其他内容。',
    },
    { role: 'user', content: `资料：\n${materialsText(ctx.chunks)}` },
  ]);
  const data = tryParseJson(text);
  return data && Array.isArray(data.cards) && data.cards.length ? data : null;
}

async function llmMarkdown(ctx, kind) {
  const sys =
    kind === 'infographic'
      ? '你是资讯图设计师。基于资料输出一份 Markdown 资讯图大纲：标题、核心数据、分模块要点（用标题与列表），中文。'
      : '你是文档撰写助手。基于资料输出一份结构完整的 Markdown 学习报告（标题、摘要、分章节正文、结论），中文。';
  return llm.complete([
    { role: 'system', content: sys },
    { role: 'user', content: `资料：\n${materialsText(ctx.chunks, 16)}` },
  ]);
}

/* ---------------- 入口 ---------------- */

/**
 * @param {string} type quiz|flashcards|mindmap|infographic|word|excel
 * @param {{notebookName:string, docs:Array, chunks:Array}} ctx
 */
async function build(type, ctx) {
  if (!TITLES[type]) throw new Error('未知产物类型: ' + type);
  const real = llm.available();
  let content = null;
  let download = null;
  const title = `${ctx.notebookName} · ${TITLES[type]}`;

  if (type === 'quiz') {
    content = real ? await llmQuiz(ctx).catch(() => null) : null;
    if (!content) content = mockQuiz(ctx);
    download = { filename: `${title}.json`, mime: 'application/json; charset=utf-8', text: JSON.stringify(content, null, 2) };
  } else if (type === 'flashcards') {
    content = real ? await llmCards(ctx).catch(() => null) : null;
    if (!content) content = mockCards(ctx);
    download = { filename: `${title}.json`, mime: 'application/json; charset=utf-8', text: JSON.stringify(content, null, 2) };
  } else if (type === 'mindmap') {
    content = mockMindmap(ctx);
    const md = [`# ${content.root}`];
    const walk = (n, d) => {
      for (const c of n.children || []) {
        md.push(`${'  '.repeat(d)}- ${c.label}`);
        walk(c, d + 1);
      }
    };
    walk(content, 1);
    download = { filename: `${title}.md`, mime: 'text/markdown; charset=utf-8', text: md.join('\n') };
  } else if (type === 'infographic') {
    const md = real ? await llmMarkdown(ctx, 'infographic').catch(() => null) : null;
    content = { markdown: md || mockInfographicMd(ctx) };
    download = { filename: `${title}.md`, mime: 'text/markdown; charset=utf-8', text: content.markdown };
  } else if (type === 'word') {
    const md = real ? await llmMarkdown(ctx, 'word').catch(() => null) : null;
    const markdown = md || mockWordMd(ctx);
    content = { markdown };
    download = { filename: `${title}.doc`, mime: 'application/msword', text: mdToSimpleHtml(markdown) };
  } else if (type === 'excel') {
    const csv = buildCsv(ctx);
    content = {
      columns: ['文档', '章节', '切片#', '字符数', '内容'],
      preview: ctx.chunks.slice(0, 50).map((c) => [c.doc_name, c.heading || '', c.seq, c.text.length, c.text.replace(/\s+/g, ' ').slice(0, 120)]),
      row_count: ctx.chunks.length,
    };
    download = { filename: `${title}.csv`, mime: 'text/csv; charset=utf-8', text: csv };
  }

  return { title, content, download };
}

module.exports = { build, TITLES };
