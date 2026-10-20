// 简单 JSON 文件持久化（原型用途）
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const state = { documents: [], indices: [], artifacts: [] };

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.documents = Array.isArray(parsed.documents) ? parsed.documents : [];
    state.indices = Array.isArray(parsed.indices) ? parsed.indices : [];
    state.artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
  } catch {
    /* 首次运行，无状态文件 */
  }
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('[store] 保存失败:', e.message);
    }
  }, 30);
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function findDoc(id) {
  return state.documents.find((d) => d.id === id);
}

function findIndex(id) {
  return state.indices.find((i) => i.id === id);
}

module.exports = { state, load, save, uid, findDoc, findIndex, DATA_DIR };
