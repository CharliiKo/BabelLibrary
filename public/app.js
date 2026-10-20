// 知识库工作台 · NotebookLM 风格三栏前端
// 左 Input（资料源 + 勾选范围）/ 中 Chat（流式问答 + 引用）/ 右 Output（六种产物）
// UI 增强：极光背景、玻璃质感、逐条入场动画、3D 闪卡、主题切换、打字指示器

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
function toast(msg, isErr) {
  const root = $('#toastRoot');
  while (root.children.length >= 4) root.firstElementChild.remove(); // 同屏最多 4 条
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.setAttribute('role', 'status');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 420);
  }, 3200);
}
function mdToHtml(src) {
  let t = esc(src);
  t = t.replace(/```([\s\S]*?)```/g, (m, c) => `<pre><code>${c.replace(/^\n/, '')}</code></pre>`);
  t = t.replace(/^#### (.*)$/gm, '<h4>$1</h4>').replace(/^### (.*)$/gm, '<h3>$1</h3>')
       .replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>');
  t = t.replace(/^[-*] (.*)$/gm, '<li>$1</li>');
  t = t.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, (m) => `<ul>${m}</ul>`);
  t = t.split(/\n{2,}/).map((b) => (/^<(h\d|ul|pre|li|blockquote)/.test(b.trim()) ? b : `<p>${b.replace(/\n/g, '<br>')}</p>`)).join('\n');
  return t;
}
function fileIcon(name) {
  const e = (name || '').split('.').pop().toLowerCase();
  return { pdf: '📕', md: '📝', txt: '📄', csv: '📊', json: '🧾', html: '🌐', htm: '🌐', xml: '🧾' }[e] || '📄';
}
const fileExt = (name) => ((name || '').split('.').pop() || '').toLowerCase();
const typingDots = '<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>';
const statusLine = (text) => `<span class="status-line">${esc(text)}${typingDots}</span>`;

/* ---------------- 全局状态 ---------------- */
let NB = null;                 // 当前 notebook（index 详情）
let DOC_STATUS = {};           // docId -> 全局文档状态
let selected = new Set();      // 勾选的资料
let pendingImport = new Set(); // 解析完成后待自动导入
let chatHistory = [];
let sending = false;           // 防止重复发送
let treeSig = '';              // 资料集合指纹：仅在集合变化时重放入场动画

const OUT_TYPES = [
  { type: 'quiz', label: '小测验', icon: '📊' },
  { type: 'flashcards', label: '闪卡', icon: '🃏' },
  { type: 'mindmap', label: '心智图', icon: '🧠' },
  { type: 'infographic', label: '资讯图', icon: '📌' },
  { type: 'word', label: 'Word 文档', icon: '📝' },
  { type: 'excel', label: 'Excel 试算表', icon: '📈' },
];
const outIcon = (t) => (OUT_TYPES.find((o) => o.type === t) || {}).icon || '📦';

/* ---------------- 模式徽标 ---------------- */
async function renderModeBadges() {
  try {
    const s = await api('/api/status');
    const b = (l, real) => `<span class="mode-badge ${real ? 'real' : 'mock'}"><i class="dot" aria-hidden="true"></i>${l} · ${real ? '真实' : '模拟'}</span>`;
    $('#modeBadges').innerHTML = b('解析', s.modes.parsex.real) + b('向量', s.modes.embed.real) + b('问答', s.modes.llm.real);
  } catch { /* 后端未连接 */ }
}

/* ---------------- 主题切换 ---------------- */
function wireTheme() {
  const btn = $('#themeToggle');
  const meta = $('#themeColor');
  const label = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    btn.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
    if (meta) meta.setAttribute('content', dark ? '#0a0912' : '#f5f4fa');
  };
  label();
  btn.addEventListener('click', () => {
    const html = document.documentElement;
    const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
    html.classList.add('theme-transition');
    html.dataset.theme = next;
    try { localStorage.setItem('kb-theme', next); } catch { /* 隐私模式忽略 */ }
    label();
    setTimeout(() => html.classList.remove('theme-transition'), 420);
  });
}

/* ---------------- Notebook 管理 ---------------- */
async function loadNotebooks(keepId) {
  const { indices } = await api('/api/indices');
  let list = indices;
  if (!list.length) {
    const r = await api('/api/indices', { method: 'POST', body: { name: '我的笔记本', description: 'NotebookLM 风格工作台默认笔记本' } });
    list = [r.index];
  }
  const sel = $('#nbSelect');
  sel.innerHTML = list.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
  const want = keepId && list.some((i) => i.id === keepId) ? keepId : list[0].id;
  sel.value = want;
  await loadNotebook(want);
}

async function loadNotebook(id) {
  const { index } = await api(`/api/indices/${id}`);
  NB = index;
  const { documents } = await api('/api/documents');
  DOC_STATUS = {};
  for (const d of documents) DOC_STATUS[d.id] = d;
  // 默认全选当前 notebook 的资料
  selected = new Set((NB.documents || []).map((d) => d.doc_id));
  chatHistory = [];
  treeSig = '';
  $('#chatLog').innerHTML = '';
  $('#greeting').style.display = '';
  renderTree();
  renderScopeChip();
  refreshArtifacts();
}

/* ---------------- 左栏：资料树 ---------------- */
function renderTree() {
  const docs = NB.documents || [];
  $('#selCount').textContent = `${selected.size}/${docs.length}`;
  const allOn = docs.length > 0 && selected.size === docs.length;
  $('#toggleAll').classList.toggle('on', allOn);
  $('#toggleAll').setAttribute('aria-pressed', String(allOn));
  const tree = $('#srcTree');
  if (!docs.length) {
    tree.innerHTML = '<div class="src-empty">还没有资料。<br>拖入文件、粘贴文本或添加链接开始。</div>';
    treeSig = '';
    return;
  }
  // 只有资料集合变化才重放逐条入场动画；勾选/取消时不重放，避免列表抖动
  const sig = docs.map((d) => d.doc_id).join('|');
  const animate = sig !== treeSig;
  treeSig = sig;

  tree.innerHTML = `
    <div class="src-group">▾ 📁 我上传的 <span class="cnt">${docs.length}</span></div>
    ${docs.map((d, i) => {
      const st = DOC_STATUS[d.doc_id];
      const status = st ? st.status : 'parsed';
      const badge = status === 'parsing' ? '<span class="st">解析中…</span>' : status === 'failed' ? '<span class="st err">失败</span>' : '';
      return `<div class="src-row${animate ? ' anim-in' : ''}" data-ext="${esc(fileExt(d.name))}"${animate ? ` style="--i:${i}"` : ''}>
        <span class="fico" aria-hidden="true">${fileIcon(d.name)}</span>
        <button type="button" class="fname" data-doc="${d.doc_id}" title="点击查看解析结果">${esc(d.name)}</button>
        ${badge}
        <button class="check-btn ${selected.has(d.doc_id) ? 'on' : ''}" data-sel="${d.doc_id}" title="勾选 / 取消" aria-label="勾选或取消：${esc(d.name)}" aria-pressed="${selected.has(d.doc_id)}">✓</button>
      </div>`;
    }).join('')}`;

  $$('button[data-sel]', tree).forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.sel;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    renderTree(); renderScopeChip();
    // 只给刚点的那一个复选圆圈播放弹跳
    const fresh = $(`[data-sel="${id}"]`, tree);
    if (fresh) {
      fresh.classList.add('just');
      fresh.addEventListener('animationend', () => fresh.classList.remove('just'), { once: true });
    }
  }));
  $$('.fname[data-doc]', tree).forEach((f) => f.addEventListener('click', () => viewDoc(f.dataset.doc)));
}

function renderScopeChip() {
  const total = (NB && NB.documents ? NB.documents.length : 0);
  $('#scopeChip').textContent = selected.size === total
    ? `🌐 资料来源：全部（${total}）`
    : `🌐 资料来源：已勾选 ${selected.size}/${total}`;
}

async function viewDoc(docId) {
  try {
    const { document: d, markdown } = await api(`/api/documents/${docId}`);
    openModal(`${esc(d.name)}`, `<div class="md">${mdToHtml(markdown || d.error || '(无内容)')}</div>`, [{ label: '关闭' }]);
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 上传 / 粘贴 / URL ---------------- */
async function ingestText(name, text) {
  const r = await api('/api/parse', { method: 'POST', body: { name, text, source: 'upload' } });
  await importToNb(r.document.id);
}
async function ingestUrl(url, name, pageIndex) {
  const r = await api('/api/parse', { method: 'POST', body: { url, name, page_index: pageIndex || undefined, source: 'url' } });
  if (r.pending) {
    pendingImport.add(r.document.id);
    toast('已提交 ParseX 任务，解析完成后自动入库');
  } else {
    await importToNb(r.document.id);
  }
}
async function importToNb(docId) {
  await api(`/api/indices/${NB.id}/import`, { method: 'POST', body: { document_id: docId } });
  selected.add(docId);
  await reloadNbDocs();
  toast('已加入资料并完成索引');
}
async function reloadNbDocs() {
  const { index } = await api(`/api/indices/${NB.id}`);
  NB = index;
  const { documents } = await api('/api/documents');
  DOC_STATUS = {};
  for (const d of documents) DOC_STATUS[d.id] = d;
  renderTree(); renderScopeChip();
}

function wireLeftPanel() {
  const dz = $('#srcDrop');
  $('#pickFile').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { for (const f of e.target.files) handleFile(f); e.target.value = ''; });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('dragover');
    for (const f of e.dataTransfer.files) handleFile(f);
  });
  $('#pasteBtn').addEventListener('click', () => {
    openModal('粘贴文本', `
      <label class="field"><span class="lb">名称</span><input id="pName" placeholder="例如：笔记.md"></label>
      <label class="field"><span class="lb">内容</span><textarea id="pText" rows="10"></textarea></label>`, [
      { label: '加入资料', primary: true, fn: async () => {
        const text = $('#pText').value;
        if (!text.trim()) return toast('内容不能为空', true);
        try { closeModal(); await ingestText($('#pName').value.trim() || '粘贴文档.md', text); }
        catch (e) { toast(e.message, true); }
      } }, { label: '取消' }]);
  });
  $('#urlBtn').addEventListener('click', () => {
    openModal('添加链接（ParseX 解析）', `
      <label class="field"><span class="lb">文件 URL（公网可访问）</span><input id="uUrl" placeholder="https://example.com/doc.pdf"></label>
      <label class="field"><span class="lb">名称（可选）</span><input id="uName"></label>
      <label class="field"><span class="lb">页数范围（可选，如 1-10）</span><input id="uPages"></label>
      <div class="hint-sm">需配置 DASHSCOPE_API_KEY 与 WORKSPACE_ID；未配置时请改用上传 / 粘贴。</div>`, [
      { label: '提交', primary: true, fn: async () => {
        const url = $('#uUrl').value.trim();
        if (!url) return toast('请输入 URL', true);
        try { closeModal(); await ingestUrl(url, $('#uName').value.trim(), $('#uPages').value.trim()); }
        catch (e) { toast(e.message, true); }
      } }, { label: '取消' }]);
  });
  $('#toggleAll').addEventListener('click', () => {
    const docs = NB.documents || [];
    if (selected.size === docs.length) selected.clear();
    else selected = new Set(docs.map((d) => d.doc_id));
    renderTree(); renderScopeChip();
  });
  $('#collapseL').addEventListener('click', () => {
    const panel = $('#leftPanel');
    panel.classList.toggle('collapsed');
    $('#collapseL').setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
  });
  $('#collapseR').addEventListener('click', () => {
    const panel = $('.panel.right');
    panel.classList.toggle('collapsed');
    $('#collapseR').setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
  });
}

async function handleFile(f) {
  if (f.size > 10 * 1024 * 1024) return toast('文件过大（>10MB）', true);
  const text = await f.text().catch(() => null);
  if (text == null) return toast(`「${f.name}」为二进制文件，请改用「添加链接」走 ParseX`, true);
  try { await ingestText(f.name, text); } catch (e) { toast(e.message, true); }
}

/* ---------------- 轮询：解析中/待导入 ---------------- */
setInterval(async () => {
  if (!NB) return;
  const needPoll = pendingImport.size > 0 || (NB.documents || []).some((d) => DOC_STATUS[d.doc_id] && DOC_STATUS[d.doc_id].status === 'parsing');
  if (!needPoll) return;
  try {
    const { documents } = await api('/api/documents');
    DOC_STATUS = {};
    for (const d of documents) DOC_STATUS[d.id] = d;
    for (const id of Array.from(pendingImport)) {
      const d = DOC_STATUS[id];
      if (d && d.status === 'parsed') {
        pendingImport.delete(id);
        await api(`/api/indices/${NB.id}/import`, { method: 'POST', body: { document_id: id } });
        selected.add(id);
        toast(`「${d.name}」解析完成，已入库`);
      } else if (d && d.status === 'failed') {
        pendingImport.delete(id);
        toast(`「${d.name}」解析失败`, true);
      }
    }
    await reloadNbDocs();
  } catch { /* ignore */ }
}, 2500);

/* ---------------- 中栏：Chat ---------------- */
const SUGGESTIONS = ['总结这些资料的重点', '比较这些资料的差异', '根据这些资料出几道练习题'];

function renderChips() {
  $('#chips').innerHTML = SUGGESTIONS.map((s) => `<button class="chip-sug">${esc(s)}</button>`).join('');
  $$('.chip-sug', $('#chips')).forEach((b) => b.addEventListener('click', () => sendChat(b.textContent)));
}

async function sendChat(text) {
  const query = (text != null ? text : $('#chatInput').value).trim();
  if (!query || !NB || sending) return;
  if (!selected.size) return toast('请至少勾选一份资料', true);
  sending = true;
  $('#chatSend').disabled = true;
  $('#chatSend').setAttribute('aria-busy', 'true');
  $('#chatInput').value = '';
  autoGrowInput();
  $('#greeting').style.display = 'none';
  const log = $('#chatLog');

  const u = document.createElement('div');
  u.className = 'msg user'; u.textContent = query;
  log.appendChild(u);
  const a = document.createElement('div');
  a.className = 'msg assistant';
  a.innerHTML = statusLine('正在检索勾选的资料');
  log.setAttribute('aria-busy', 'true'); // 先标记 busy，再插入状态行，避免逐字/逐条打断读屏
  log.appendChild(a);
  scrollChat(true);

  let answer = '';
  let nodes = [];
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index_id: NB.id, query, doc_ids: Array.from(selected), history: chatHistory.slice(-6) }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!frame.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(frame.slice(5).trim()); } catch { continue; }
        if (ev.type === 'tool_calling') a.innerHTML = statusLine(ev.message);
        else if (ev.type === 'tool_return') {
          nodes = ev.nodes || [];
          a.innerHTML = nodes.length
            ? statusLine(`命中 ${nodes.length} 个切片，生成中`)
            : '<span class="status-line">勾选范围内未命中切片…</span>';
        } else if (ev.type === 'generating') {
          if (!answer) a.classList.add('streaming');
          answer += ev.text;
          a.textContent = answer;
          scrollChat(true);
        } else if (ev.type === 'generation_end') {
          chatHistory.push({ role: 'user', content: query }, { role: 'assistant', content: answer });
          a.classList.remove('streaming');
          renderCites(a, nodes);
        } else if (ev.type === 'error') throw new Error(ev.message);
      }
    }
  } catch (e) {
    a.classList.remove('streaming');
    a.innerHTML = `<span style="color:var(--err)">出错了：${esc(e.message)}</span>`;
  } finally {
    sending = false;
    $('#chatSend').disabled = false;
    $('#chatSend').removeAttribute('aria-busy');
    log.removeAttribute('aria-busy');
    scrollChat(true);
  }
}

function reduceMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function scrollChat(smooth) {
  const area = $('#chatArea');
  if (!area) return;
  if (smooth && !reduceMotion()) area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
  else area.scrollTop = area.scrollHeight;
}

function renderCites(msgEl, nodes) {
  if (!nodes.length) return;
  const c = document.createElement('div');
  c.className = 'cites';
  c.innerHTML = '引用：' + nodes.map((n, i) =>
    `<button type="button" class="cite-chip" data-i="${i}" style="animation-delay:${i * 45}ms">[${i + 1}] ${esc(n.doc_name || '远端')}${n.heading ? ' · ' + esc(n.heading.slice(0, 18)) : ''}</button>`).join('');
  msgEl.appendChild(c);
  $$('.cite-chip', c).forEach((chip) => chip.addEventListener('click', () => {
    const n = nodes[Number(chip.dataset.i)];
    openModal(`引用 [${Number(chip.dataset.i) + 1}] · score ${n.score}`, `<div class="md">${mdToHtml(n.text)}</div>`, [{ label: '关闭' }]);
  }));
}

/* ---------------- 右栏：Output ---------------- */
function renderOutGrid() {
  $('#outGrid').innerHTML = OUT_TYPES.map((o) =>
    `<button class="out-card" data-type="${o.type}" title="生成${o.label}">
      <span class="oico" aria-hidden="true">${o.icon}</span><span>${o.label}</span><span class="arr" aria-hidden="true">›</span>
    </button>`).join('');
  $$('.out-card', $('#outGrid')).forEach((b) => b.addEventListener('click', () => generateArtifact(b.dataset.type, b)));
}

async function generateArtifact(type, btn) {
  if (!NB) return;
  if (!selected.size) return toast('请至少勾选一份资料', true);
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const r = await api('/api/artifacts', { method: 'POST', body: { index_id: NB.id, type, doc_ids: Array.from(selected) } });
    toast(`已生成：${r.artifact.title}`);
    await refreshArtifacts();
    viewArtifact(r.artifact.id);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

async function refreshArtifacts() {
  if (!NB) return;
  const list = $('#genList');
  if (!list.dataset.loaded) list.innerHTML = '<div class="gen-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
  const { artifacts } = await api(`/api/artifacts?index_id=${encodeURIComponent(NB.id)}`);
  list.dataset.loaded = '1';

  const countEl = $('#genCount');
  if (countEl.textContent !== String(artifacts.length)) {
    countEl.textContent = artifacts.length;
    countEl.classList.remove('pop');
    void countEl.offsetWidth;
    countEl.classList.add('pop');
    countEl.addEventListener('animationend', () => countEl.classList.remove('pop'), { once: true });
  }

  if (!artifacts.length) {
    list.innerHTML = '<div class="gen-empty"><span class="big" aria-hidden="true">✨</span>还没有产物<br>从上方选一种形态开始生成</div>';
    return;
  }
  list.innerHTML = artifacts.map((a, i) => `
    <div class="gen-item" style="animation-delay:${Math.min(i, 9) * 45}ms">
      <button type="button" class="gen-open" data-id="${a.id}" aria-label="打开产物：${esc(a.title)}">
        <span class="gico" aria-hidden="true">${outIcon(a.type)}</span>
        <span class="gmain">
          <span class="gtitle">${esc(a.title)}</span>
          <span class="gtime">${fmtTime(a.created_at)}</span>
        </span>
      </button>
      <button class="gdel" data-del="${a.id}" title="删除" aria-label="删除产物：${esc(a.title)}">✕</button>
    </div>`).join('');
  $$('.gen-open', list).forEach((b) => b.addEventListener('click', () => viewArtifact(b.dataset.id)));
  $$('button[data-del]', list).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('删除该产物？此操作不可撤销。')) return;
    await api(`/api/artifacts/${b.dataset.del}`, { method: 'DELETE' });
    refreshArtifacts();
  }));
}

async function viewArtifact(id) {
  const { artifact: a } = await api(`/api/artifacts/${id}`);
  let body = '';
  const c = a.content || {};
  if (a.type === 'quiz') {
    body = (c.questions || []).map((q, qi) => `
      <div class="quiz-q" data-ans="${q.answer}" style="animation-delay:${qi * 55}ms">
        <div class="qt">${qi + 1}. ${esc(q.q)}</div>
        ${(q.options || []).map((o, oi) => `<button class="quiz-opt" data-oi="${oi}">${esc(String.fromCharCode(65 + oi))}. ${esc(o)}</button>`).join('')}
      </div>`).join('') || '<div class="gen-empty">无题目</div>';
  } else if (a.type === 'flashcards') {
    body = `<div class="cards-grid">${(c.cards || []).map((cd, i) =>
      `<button type="button" class="fcard" aria-pressed="false" style="animation-delay:${i * 55}ms">
        <span class="f-inner">
          <span class="f-face f-front" data-face="front"><span class="fcap">问题</span><span class="ff">${esc(cd.front)}</span></span>
          <span class="f-face f-back" data-face="back" aria-hidden="true"><span class="fcap">答案</span><span class="fb">${esc(cd.back)}</span></span>
        </span>
      </button>`).join('')}</div>
      <div class="hint-inline">点击卡片翻转查看答案</div>`;
  } else if (a.type === 'mindmap') {
    const walk = (n) => `<li>${n.label ? esc(n.label) : ''}${n.children && n.children.length ? `<ul>${n.children.map(walk).join('')}</ul>` : ''}</li>`;
    body = `<div class="mtree"><ul><li class="root">${esc(c.root || '')}${(c.children || []).map((ch) => `<ul>${(ch.children || []).map(walk).join('')}</ul>`).map((s) => s.replace('<ul>', '<li style="list-style:none">' ).replace('</ul>', '</li>')).join('')}</li></ul></div>`;
  } else if (a.type === 'infographic' || a.type === 'word') {
    body = `<div class="md">${mdToHtml(c.markdown || '')}</div>`;
  } else if (a.type === 'excel') {
    body = `<div class="hint-sm mb">共 ${c.row_count} 行（预览前 ${Math.min(50, c.row_count || 0)} 行），下载得到完整 CSV</div>
      <table class="xl"><thead><tr>${(c.columns || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${(c.preview || []).map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  } else {
    body = `<pre>${esc(JSON.stringify(c, null, 2))}</pre>`;
  }

  const canDownload = a.has_download != null ? a.has_download : !!(a.download && a.download.filename);
  const buttons = [];
  if (canDownload) buttons.push({ label: '⬇ 下载', primary: true, fn: () => { window.location.href = `/api/artifacts/${a.id}/download`; } });
  buttons.push({ label: '关闭' });
  buttons.push({ label: '删除', danger: true, fn: async () => {
    if (!confirm('删除该产物？此操作不可撤销。')) return;
    closeModal();
    await api(`/api/artifacts/${a.id}`, { method: 'DELETE' });
    refreshArtifacts();
  } });
  const mask = openModal(esc(a.title), body, buttons);

  if (a.type === 'quiz') {
    $$('.quiz-q', mask).forEach((q) => {
      const ans = Number(q.dataset.ans);
      $$('.quiz-opt', q).forEach((opt) => opt.addEventListener('click', () => {
        $$('.quiz-opt', q).forEach((o) => o.classList.remove('correct', 'wrong'));
        const oi = Number(opt.dataset.oi);
        opt.classList.add(oi === ans ? 'correct' : 'wrong');
        if (oi !== ans) $$('.quiz-opt', q)[ans] && $$('.quiz-opt', q)[ans].classList.add('correct');
      }));
    });
  }
  if (a.type === 'flashcards') {
    $$('.fcard', mask).forEach((f) => {
      const back = $('.f-back', f);
      f.addEventListener('click', () => {
        const flipped = f.classList.toggle('flipped');
        f.setAttribute('aria-pressed', String(flipped));
        if (back) back.setAttribute('aria-hidden', String(!flipped));
      });
    });
  }
}

/* ---------------- 顶栏事件 ---------------- */
function wireTopbar() {
  $('#nbSelect').addEventListener('change', () => loadNotebook($('#nbSelect').value));
  $('#nbNew').addEventListener('click', () => {
    openModal('新建任务（知识库）', `
      <label class="field"><span class="lb">名称</span><input id="nbName" placeholder="例如：EESM5536 数字通信"></label>
      <label class="field"><span class="lb">描述（可选）</span><input id="nbDesc"></label>`, [
      { label: '创建', primary: true, fn: async () => {
        const name = $('#nbName').value.trim();
        if (!name) return toast('名称不能为空', true);
        try {
          const r = await api('/api/indices', { method: 'POST', body: { name, description: $('#nbDesc').value.trim() } });
          closeModal();
          await loadNotebooks(r.index.id);
          toast('已创建新任务');
        } catch (e) { toast(e.message, true); }
      } }, { label: '取消' }]);
  });
  $('#consoleLink').addEventListener('click', async () => {
    const { indices } = await api('/api/indices');
    const { documents } = await api('/api/documents');
    const mask = openModal('管理', `
      <div class="hint-sm lead">知识库（Notebook）</div>
      ${indices.map((i) => `<div class="gen-item"><span class="gico">📚</span><div class="gmain"><div class="gtitle">${esc(i.name)}</div><div class="gtime">${i.document_count} 资料 · ${i.chunk_count} 切片 · ${i.type === 'remote' ? '远端' : i.embed_mode === 'real' ? '真实向量' : '模拟向量'}</div></div><button class="gdel" data-kbdel="${i.id}" aria-label="删除知识库">✕</button></div>`).join('') || '<div class="src-empty">无</div>'}
      <div class="hint-sm lead mt">全部文档（含未入库）</div>
      ${documents.slice(0, 30).map((d) => `<div class="gen-item"><span class="gico">${fileIcon(d.name)}</span><div class="gmain"><div class="gtitle">${esc(d.name)}</div><div class="gtime">${d.status} · ${d.chars} 字</div></div><button class="gdel" data-docdel="${d.id}" aria-label="删除文档">✕</button></div>`).join('') || '<div class="src-empty">无</div>'}`, [
      { label: '关闭' }]);
    $$('button[data-kbdel]', mask).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('删除该知识库及其切片？')) return;
      await api(`/api/indices/${b.dataset.kbdel}`, { method: 'DELETE' });
      closeModal(); await loadNotebooks(NB && NB.id);
    }));
    $$('button[data-docdel]', mask).forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/documents/${b.dataset.docdel}`, { method: 'DELETE' });
      closeModal(); $('#consoleLink').click();
      reloadNbDocs();
    }));
  });
  $('#clearChat').addEventListener('click', () => {
    chatHistory = [];
    $('#chatLog').innerHTML = '';
    $('#greeting').style.display = '';
    scrollChat(false);
  });
}

/* ---------------- 弹窗 ---------------- */
const INERT_SELECTORS = '.topbar, .nlm, #toastRoot';

function setBackgroundInert(on) {
  $$(INERT_SELECTORS).forEach((el) => {
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  });
}

function focusables(root) {
  return $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', root)
    .filter((el) => !el.disabled && el.getClientRects().length > 0);
}

function openModal(title, bodyHtml, buttons = []) {
  closeModal();
  const root = $('#modalRoot');
  $$('.modal-mask.is-closing', root).forEach((m) => m.remove()); // 清掉正在淡出的旧层，避免误抓

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask._opener = document.activeElement;
  const foot = buttons.map((b, i) => {
    const cls = [b.primary ? 'primary' : '', b.danger ? 'danger' : ''].filter(Boolean).join(' ');
    return `<button ${cls ? `class="${cls}" ` : ''}data-btn="${i}">${esc(b.label)}</button>`;
  }).join('');
  mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${String(title).replace(/<[^>]*>/g, '')}">
      <div class="modal-head"><h3>${title}</h3><button type="button" class="close-x" data-close aria-label="关闭">✕</button></div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-foot">${foot}</div>
    </div>`;
  root.appendChild(mask);

  mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
  $('[data-close]', mask).addEventListener('click', closeModal);
  buttons.forEach((b, i) => $(`button[data-btn="${i}"]`, mask).addEventListener('click', () => (b.fn ? b.fn() : closeModal())));

  // Esc 关闭 + Tab 焦点循环（把键盘焦点关在弹窗内）
  mask._key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(mask);
    if (!f.length) return;
    const firstEl = f[0];
    const lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };
  document.addEventListener('keydown', mask._key);
  setBackgroundInert(true);

  // 初始焦点给主操作（下载），否则给「关闭」——绝不停在删除上
  const first = $('.modal-foot button.primary', mask) || $('.modal-foot button', mask);
  if (first) first.focus({ preventScroll: true });
  return mask;
}

function closeModal() {
  const root = $('#modalRoot');
  const mask = root.querySelector('.modal-mask:not(.is-closing)');
  if (!mask) return;
  mask.classList.add('is-closing');
  const done = () => {
    if (mask._key) document.removeEventListener('keydown', mask._key);
    const opener = mask._opener;
    mask.remove();
    // 若还有新弹窗在，保持背景 inert，也不抢它的焦点
    if (!root.querySelector('.modal-mask')) {
      setBackgroundInert(false);
      if (opener && document.contains(opener)) {
        try { opener.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    }
  };
  mask.addEventListener('animationend', done, { once: true });
  setTimeout(done, 280); // 动画未触发时的兜底
}

/* ---------------- 启动 ---------------- */
function autoGrowInput() {
  const ta = $('#chatInput');
  requestAnimationFrame(() => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 168) + 'px';
  });
}

(async function init() {
  wireTheme();
  renderModeBadges();
  setInterval(renderModeBadges, 15000);
  renderChips();
  renderOutGrid();
  wireLeftPanel();
  wireTopbar();
  $('#chatSend').addEventListener('click', () => sendChat());
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chatInput').addEventListener('input', autoGrowInput);
  try {
    await loadNotebooks();
  } catch (e) {
    toast('后端连接失败: ' + e.message, true);
  }
})();
