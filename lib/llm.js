// 多协议大模型客户端（零依赖 Node >= 18）
// 兼容三大 AI Platform API 协议，首要保证 OpenAI Responses API 极速流畅：
//   1. OpenAI Responses API       (POST /v1/responses)        [默认 / 首选，流式零缓冲优化]
//   2. OpenAI Chat Completions    (POST /v1/chat/completions)
//   3. Anthropic Messages REST API(POST /v1/messages)
// 同时保留模拟抽取式回答模式，在未配置任何 API Key 时全功能可演示。

const store = require('./store');

const PROTOCOLS = ['responses', 'chat_completions', 'anthropic', 'auto'];

// 内存级网关能力缓存：记录每个 baseUrl 已探测成功的协议与参数偏好，避免重复试错开销
const gatewayHints = new Map();

function getHint(baseUrl) {
  if (! gatewayHints.has(baseUrl)) gatewayHints.set(baseUrl, {});
  return gatewayHints.get(baseUrl);
}

/**
 * 规范化协议名称
 * @param {string} raw
 * @returns {'responses'|'chat_completions'|'anthropic'|'auto'}
 */
function normalizeProtocol(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (['responses', 'response', 'openai-responses', 'openai_responses', '/v1/responses', 'v1/responses'].includes(s)) {
    return 'responses';
  }
  if (
    [
      'chat_completions',
      'chat-completions',
      'chat_completion',
      'chat-completion',
      'chat',
      'openai',
      'openai-chat',
      '/v1/chat/completions',
      'v1/chat/completions',
    ].includes(s)
  ) {
    return 'chat_completions';
  }
  if (['anthropic', 'messages', 'anthropic-messages', 'anthropic_messages', 'claude', '/v1/messages', 'v1/messages'].includes(s)) {
    return 'anthropic';
  }
  if (s === 'auto') return 'auto';
  return 'responses';
}

/**
 * 读取当前生效的 AI Platform 配置（优先级：运行时 store.state.settings > 环境变量 > 默认值）
 */
function getConfig(overrides = {}) {
  const saved = (store.state && store.state.settings) || {};

  // 空字符串视为「未配置」：保存的空 Key 不应遮蔽 .env / 环境变量中的密钥
  const pickKey = (v) => (typeof v === 'string' && v.trim() ? v : undefined);
  const apiKey =
    pickKey(overrides.api_key) ??
    pickKey(overrides.apiKey) ??
    pickKey(saved.api_key) ??
    process.env.AI_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.DASHSCOPE_API_KEY ??
    '';

  const rawProtocol =
    overrides.protocol ??
    saved.protocol ??
    process.env.KB_API_PROTOCOL ??
    process.env.AI_API_PROTOCOL ??
    process.env.WIRE_API ??
    '';

  let baseUrl =
    overrides.base_url ??
    overrides.baseUrl ??
    saved.base_url ??
    process.env.AI_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    process.env.ANTHROPIC_BASE_URL ??
    process.env.DASHSCOPE_BASE ??
    '';

  let protocol = normalizeProtocol(rawProtocol);
  if (!protocol) {
    if (
      (process.env.ANTHROPIC_API_KEY && !process.env.AI_API_KEY && !process.env.OPENAI_API_KEY) ||
      /anthropic\.com/i.test(baseUrl) ||
      /^sk-ant-/i.test(apiKey)
    ) {
      protocol = 'anthropic';
    } else {
      // 默认优先使用 Responses API（配合 auto_fallback 兼顾旧网关平滑回退）
      protocol = 'responses';
    }
  }

  if (!baseUrl) {
    if (protocol === 'anthropic' || /^sk-ant-/i.test(apiKey)) {
      baseUrl = 'https://api.anthropic.com';
    } else if (process.env.DASHSCOPE_API_KEY && apiKey === process.env.DASHSCOPE_API_KEY) {
      baseUrl = 'https://dashscope.aliyuncs.com';
    } else {
      baseUrl = 'https://api.openai.com/v1';
    }
  }

  const model =
    overrides.model ??
    saved.model ??
    process.env.KB_CHAT_MODEL ??
    process.env.AI_MODEL ??
    process.env.OPENAI_MODEL ??
    process.env.ANTHROPIC_MODEL ??
    (protocol === 'anthropic'
      ? 'claude-3-5-sonnet-latest'
      : /dashscope\.aliyuncs\.com/i.test(baseUrl)
      ? 'qwen-plus'
      : 'gpt-4o-mini');

  const temperature =
    overrides.temperature !== undefined
      ? Number(overrides.temperature)
      : saved.temperature !== undefined
      ? Number(saved.temperature)
      : process.env.KB_TEMPERATURE !== undefined
      ? Number(process.env.KB_TEMPERATURE)
      : 0.3;

  const maxTokens =
    overrides.max_tokens ??
    overrides.max_output_tokens ??
    saved.max_tokens ??
    (process.env.KB_MAX_TOKENS ? parseInt(process.env.KB_MAX_TOKENS, 10) : 4096);

  const autoFallback =
    overrides.auto_fallback !== undefined
      ? Boolean(overrides.auto_fallback)
      : saved.auto_fallback !== undefined
      ? Boolean(saved.auto_fallback)
      : process.env.KB_AUTO_FALLBACK !== 'false';

  const timeoutMs =
    overrides.timeout_ms ??
    saved.timeout_ms ??
    (process.env.KB_REQUEST_TIMEOUT_MS ? parseInt(process.env.KB_REQUEST_TIMEOUT_MS, 10) : 60000);

  const mode = overrides.mode ?? saved.mode ?? process.env.KB_LLM_MODE ?? 'auto';

  return {
    apiKey: String(apiKey || '').trim(),
    baseUrl: String(baseUrl || '').trim(),
    protocol,
    model: String(model || '').trim() || 'gpt-4o-mini',
    temperature: Number.isFinite(temperature) ? temperature : 0.3,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
    autoFallback,
    timeoutMs,
    mode,
  };
}

/**
 * 更新运行时配置并持久化
 */
function updateRuntimeConfig(patch = {}) {
  if (!store.state.settings || typeof store.state.settings !== 'object') {
    store.state.settings = {};
  }
  const s = store.state.settings;
  if (patch.protocol !== undefined) s.protocol = normalizeProtocol(patch.protocol) || 'responses';
  if (patch.base_url !== undefined) s.base_url = String(patch.base_url).trim();
  if (patch.api_key !== undefined && patch.api_key !== '__KEEP__') s.api_key = String(patch.api_key).trim();
  if (patch.model !== undefined) s.model = String(patch.model).trim();
  if (patch.embed_model !== undefined) s.embed_model = String(patch.embed_model).trim();
  if (patch.embed_base_url !== undefined) s.embed_base_url = String(patch.embed_base_url).trim();
  if (patch.temperature !== undefined) s.temperature = Number(patch.temperature);
  if (patch.max_tokens !== undefined) s.max_tokens = parseInt(patch.max_tokens, 10) || 4096;
  if (patch.auto_fallback !== undefined) s.auto_fallback = Boolean(patch.auto_fallback);
  if (patch.mode !== undefined) s.mode = patch.mode;

  // 配置变更后清空网关缓存，立即按新配置生效
  gatewayHints.clear();
  if (typeof store.saveSync === 'function') store.saveSync();
  else store.save();
  return getConfig();
}

function chatModel() {
  return getConfig().model;
}

function available(overrides) {
  const cfg = getConfig(overrides);
  return Boolean(cfg.apiKey) && cfg.mode !== 'mock';
}

/**
 * 根据 baseUrl 与目标协议解析完整请求 Endpoint URL
 * 支持用户填写根域名、带 /v1 的前缀、百炼域名或完整端点 URL
 * @param {string} rawBase
 * @param {'responses'|'chat_completions'|'anthropic'} protocol
 */
function resolveEndpointUrl(rawBase, protocol) {
  let base = String(rawBase || '').trim().replace(/\/+$/, '');
  if (!base) {
    base = protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
  }

  // 若用户直接填了具体端点路径，先剥离末端协议路径以支持协议无缝切换
  base = base
    .replace(/\/v1\/responses$/i, '/v1')
    .replace(/\/responses$/i, '')
    .replace(/\/v1\/chat\/completions$/i, '/v1')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/v1\/messages$/i, '/v1')
    .replace(/\/messages$/i, '');

  // 阿里云百炼 DashScope 根域名特殊路径适配
  if (/^https?:\/\/dashscope(?:-intl)?\.aliyuncs\.com$/i.test(base)) {
    if (protocol === 'responses') {
      return `${base}/compatible-mode/v1/responses`;
    }
    if (protocol === 'chat_completions') {
      return `${base}/compatible-mode/v1/chat/completions`;
    }
    if (protocol === 'anthropic') {
      return `${base}/apps/anthropic/v1/messages`;
    }
  }

  const hasVersionSuffix = /\/(v\d+(?:beta\d*)?|compatible-mode\/v\d+)$/i.test(base);
  if (protocol === 'responses') {
    return hasVersionSuffix ? `${base}/responses` : `${base}/v1/responses`;
  }
  if (protocol === 'chat_completions') {
    return hasVersionSuffix ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }
  if (protocol === 'anthropic') {
    return hasVersionSuffix ? `${base}/messages` : `${base}/v1/messages`;
  }
  return hasVersionSuffix ? `${base}/responses` : `${base}/v1/responses`;
}

/**
 * 将任意消息 content 转为纯文本
 */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.input_text === 'string') return part.input_text;
        if (part && typeof part.output_text === 'string') return part.output_text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return String(content);
}

/**
 * 判断模型是否为不支持 temperature 的推理模型（o1 / o3 / o4 / gpt-5 / codex / deepseek-r1 等）
 */
function isReasoningModel(model) {
  return /^(o1|o3|o4|gpt-5|codex|deepseek-r1|qwq)/i.test(String(model || '').trim());
}

/**
 * 1) 构造 OpenAI Responses API (/v1/responses) 请求体
 * 支持三种 input 格式以兼容官方 OpenAI、Codex 网关、OneAPI/NewAPI、LiteLLM 与 DashScope：
 *   - 'simple'   (默认首选，最广泛兼容): instructions + input: [{ role, content: string }]
 *   - 'canonical'(严格块结构): instructions + input: [{ type: 'message', role, content: [{ type: 'input_text'|'output_text', text }] }]
 *   - 'string'   (单字符串输入): instructions + input: "..."
 */
function buildResponsesPayload(messages, options = {}) {
  const cfg = getConfig(options);
  const model = options.model || cfg.model;
  const inputFormat = options.inputFormat || 'simple';
  const inlineSystem = Boolean(options.inlineSystem);

  const systemParts = [];
  const convMessages = [];

  if (typeof options.instructions === 'string' && options.instructions.trim()) {
    systemParts.push(options.instructions.trim());
  }

  for (const m of messages || []) {
    if (!m) continue;
    const role = String(m.role || 'user').toLowerCase();
    const text = contentToText(m.content);
    if (!text) continue;
    if (role === 'system' || role === 'developer') {
      systemParts.push(text);
    } else {
      convMessages.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        text,
      });
    }
  }

  if (!convMessages.length && systemParts.length) {
    convMessages.push({ role: 'user', text: systemParts.pop() });
  }

  const instructions = systemParts.join('\n\n').trim();
  let input;

  if (inputFormat === 'string') {
    if (convMessages.length === 1 && convMessages[0].role === 'user') {
      input = convMessages[0].text;
    } else {
      input = convMessages
        .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.text}`)
        .join('\n\n');
    }
    if (inlineSystem && instructions) {
      input = `${instructions}\n\n${input}`;
    }
  } else if (inputFormat === 'canonical') {
    input = [];
    if (inlineSystem && instructions) {
      input.push({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: instructions }],
      });
    }
    for (const m of convMessages) {
      input.push({
        type: 'message',
        role: m.role,
        content: [
          {
            type: m.role === 'assistant' ? 'output_text' : 'input_text',
            text: m.text,
          },
        ],
      });
    }
  } else {
    // 'simple': [{ role: 'user' | 'assistant', content: '...' }]
    input = [];
    if (inlineSystem && instructions) {
      input.push({ role: 'system', content: instructions });
    }
    for (const m of convMessages) {
      input.push({ role: m.role, content: m.text });
    }
  }

  const payload = {
    model,
    input,
    stream: options.stream !== undefined ? Boolean(options.stream) : true,
  };

  if (instructions && !inlineSystem) {
    payload.instructions = instructions;
  }

  if (!options.omitTemperature && !isReasoningModel(model)) {
    const temp = options.temperature !== undefined ? options.temperature : cfg.temperature;
    if (temp !== undefined && temp !== null) payload.temperature = Number(temp);
  }

  const maxOut = options.max_output_tokens ?? options.max_tokens;
  if (maxOut && Number.isFinite(Number(maxOut))) {
    payload.max_output_tokens = Number(maxOut);
  }

  return payload;
}

/**
 * 2) 构造 OpenAI Chat Completions (/v1/chat/completions) 请求体
 */
function buildChatCompletionsPayload(messages, options = {}) {
  const cfg = getConfig(options);
  const model = options.model || cfg.model;

  const normMessages = [];
  if (typeof options.instructions === 'string' && options.instructions.trim()) {
    normMessages.push({ role: 'system', content: options.instructions.trim() });
  }
  for (const m of messages || []) {
    if (!m) continue;
    const role = ['system', 'developer', 'assistant', 'user'].includes(m.role)
      ? m.role === 'developer'
        ? 'system'
        : m.role
      : 'user';
    const content = contentToText(m.content);
    if (content) normMessages.push({ role, content });
  }

  const payload = {
    model,
    messages: normMessages,
    stream: options.stream !== undefined ? Boolean(options.stream) : true,
  };

  if (!options.omitTemperature && !isReasoningModel(model)) {
    const temp = options.temperature !== undefined ? options.temperature : cfg.temperature;
    if (temp !== undefined && temp !== null) payload.temperature = Number(temp);
  }

  const maxTokens = options.max_tokens ?? options.max_output_tokens;
  if (maxTokens && Number.isFinite(Number(maxTokens))) {
    payload.max_tokens = Number(maxTokens);
  }

  return payload;
}

/**
 * 3) 构造 Anthropic Messages REST API (/v1/messages) 请求体
 * 严格遵循 Anthropic 规范：
 *   - system 提升为顶层字段
 *   - messages 仅允许 user / assistant，且必须以 user 开头、严格交替、内容非空
 *   - max_tokens 必填
 */
function buildAnthropicPayload(messages, options = {}) {
  const cfg = getConfig(options);
  const model = options.model || cfg.model;

  const systemParts = [];
  if (typeof options.instructions === 'string' && options.instructions.trim()) {
    systemParts.push(options.instructions.trim());
  }

  const alternating = [];
  for (const m of messages || []) {
    if (!m) continue;
    const rawRole = String(m.role || 'user').toLowerCase();
    const text = contentToText(m.content).trim();
    if (!text) continue;

    if (rawRole === 'system' || rawRole === 'developer') {
      systemParts.push(text);
      continue;
    }

    const role = rawRole === 'assistant' ? 'assistant' : 'user';
    if (alternating.length > 0 && alternating[alternating.length - 1].role === role) {
      // 合并相邻同角色消息，避免 Anthropic 报 roles must alternate 错误
      alternating[alternating.length - 1].content += '\n\n' + text;
    } else {
      alternating.push({ role, content: text });
    }
  }

  // Anthropic 要求第一条消息必须是 user
  while (alternating.length > 0 && alternating[0].role !== 'user') {
    alternating.shift();
  }
  if (!alternating.length) {
    alternating.push({ role: 'user', content: systemParts.pop() || '你好' });
  }

  const payload = {
    model,
    max_tokens: Number(options.max_tokens ?? options.max_output_tokens ?? cfg.maxTokens ?? 4096),
    messages: alternating,
    stream: options.stream !== undefined ? Boolean(options.stream) : true,
  };

  const system = systemParts.join('\n\n').trim();
  if (system) {
    payload.system = system;
  }

  if (!options.omitTemperature && !isReasoningModel(model)) {
    const temp = options.temperature !== undefined ? options.temperature : cfg.temperature;
    if (temp !== undefined && temp !== null) payload.temperature = Number(temp);
  }

  return payload;
}

/**
 * 从非流式或 completed 的 Responses API 响应对象中提取完整文本
 */
function extractResponsesText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.output_text === 'string' && obj.output_text.length > 0) {
    return obj.output_text;
  }
  if (obj.response && typeof obj.response === 'object') {
    const nested = extractResponsesText(obj.response);
    if (nested) return nested;
  }
  if (Array.isArray(obj.output)) {
    const parts = [];
    for (const item of obj.output) {
      if (!item) continue;
      if (typeof item.text === 'string') parts.push(item.text);
      else if (typeof item.content === 'string') parts.push(item.content);
      else if (Array.isArray(item.content)) {
        for (const p of item.content) {
          if (!p) continue;
          if (typeof p === 'string') parts.push(p);
          else if (typeof p.text === 'string') parts.push(p.text);
          else if (typeof p.output_text === 'string') parts.push(p.output_text);
          else if (typeof p.refusal === 'string') parts.push(p.refusal);
        }
      }
    }
    if (parts.length) return parts.join('');
  }
  // 兼容部分网关在 /v1/responses 端点返回 Chat Completions 或 Anthropic 结构
  if (Array.isArray(obj.choices) && obj.choices[0]) {
    const ch = obj.choices[0];
    if (ch.message && typeof ch.message.content === 'string') return ch.message.content;
    if (ch.delta && typeof ch.delta.content === 'string') return ch.delta.content;
    if (typeof ch.text === 'string') return ch.text;
  }
  if (Array.isArray(obj.content)) {
    return extractAnthropicText(obj);
  }
  return '';
}

/**
 * 从 Chat Completions 响应对象中提取文本
 */
function extractChatCompletionsText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (Array.isArray(obj.choices) && obj.choices[0]) {
    const c = obj.choices[0];
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (c.message && Array.isArray(c.message.content)) return contentToText(c.message.content);
    if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
    if (typeof c.text === 'string') return c.text;
  }
  return extractResponsesText(obj);
}

/**
 * 从 Anthropic Messages 响应对象中提取文本
 */
function extractAnthropicText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((block) => {
        if (!block) return '';
        if (typeof block === 'string') return block;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (typeof block.text === 'string') return block.text;
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * 高性能流式 SSE 行解析器：
 * - 兼容 \r\n 与 \n
 * - 支持标准 event: + data: 双行格式，也兼容无空行分隔的紧凑 data: 流
 * - 遇到流结束信号立即退出并安全释放 reader，避免尾部挂起等待
 */
async function* iterateSseFrames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent = '';
  let dataLines = [];

  const flushFrame = () => {
    if (!dataLines.length) {
      currentEvent = '';
      return null;
    }
    const data = dataLines.join('\n').trim();
    const ev = currentEvent;
    dataLines = [];
    currentEvent = '';
    return { event: ev, data };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          const frame = flushFrame();
          if (frame) yield frame;
          continue;
        }

        if (line.startsWith(':')) {
          // SSE 注释/心跳行
          continue;
        }

        if (line.startsWith('event:')) {
          // 若上一段 data 尚未通过空行刷新，先刷新
          if (dataLines.length) {
            const prev = flushFrame();
            if (prev) yield prev;
          }
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (line.startsWith('data:')) {
          const rawPayload = line.slice(5).trim();
          // 針對紧凑型网关（连续多行各自都是完整 JSON 的 data: 行，中间未发空行），立即逐帧推送，实现零缓冲延迟
          if (
            dataLines.length > 0 &&
            ((rawPayload.startsWith('{') && rawPayload.endsWith('}')) || rawPayload === '[DONE]')
          ) {
            const prev = flushFrame();
            if (prev) yield prev;
          }
          dataLines.push(rawPayload);
          // 如果没有显式 event: 前缀，或者单行已经是完整 JSON / [DONE]，立即派发，无需等待下一个 \n
          if (rawPayload === '[DONE]' || (rawPayload.startsWith('{') && rawPayload.endsWith('}'))) {
            const immediate = flushFrame();
            if (immediate) yield immediate;
          }
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const rem of buffer.split(/\r?\n/)) {
        const line = rem.trim();
        if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
    }
    const tail = flushFrame();
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 忽略流关闭异常 */
    }
  }
}

/**
 * 构建带超时的 AbortSignal
 */
function createRequestSignal(userSignal, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`请求超时 (${timeoutMs}ms)`));
  }, timeoutMs);

  const onUserAbort = () => {
    clearTimeout(timer);
    controller.abort(userSignal.reason || new Error('请求已取消'));
  };

  if (userSignal) {
    if (userSignal.aborted) onUserAbort();
    else userSignal.addEventListener('abort', onUserAbort, { once: true });
  }

  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
    },
  };
}

/**
 * 提取可读的 HTTP 错误详情
 */
async function readHttpError(res, protocol) {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    const msg =
      (j.error && (j.error.message || j.error.code || JSON.stringify(j.error))) ||
      j.message ||
      j.detail;
    if (msg) detail = msg;
  } catch {
    /* keep raw text */
  }
  const err = new Error(`[${protocol}] 模型调用失败 HTTP ${res.status}: ${detail}`);
  err.status = res.status;
  err.rawBody = text;
  err.protocol = protocol;
  return err;
}

/**
 * OpenAI Responses API (/v1/responses) 流式生成器
 * 针对首字延迟 (TTFT)、多形态事件帧、非流式 JSON 降级、网关参数差异做了全方位流畅度优化
 */
async function* streamResponses(messages, options = {}) {
  const cfg = getConfig(options);
  const hint = getHint(cfg.baseUrl);
  const endpoint = options.endpointOverride || resolveEndpointUrl(cfg.baseUrl, 'responses');

  const inputFormat = options.inputFormat || hint.responsesInputFormat || 'simple';
  const omitTemperature = Boolean(options.omitTemperature || hint.omitTemperature);
  const inlineSystem = Boolean(options.inlineSystem || hint.inlineSystem);

  const payload = buildResponsesPayload(messages, {
    ...options,
    inputFormat,
    omitTemperature,
    inlineSystem,
    stream: options.stream !== undefined ? Boolean(options.stream) : true,
  });

  const { signal, clear } = createRequestSignal(options.signal, cfg.timeoutMs);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        Accept: payload.stream ? 'text/event-stream, application/json' : 'application/json',
        ...(options.headers || {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    clear();
    throw err;
  }

  // 连接建立后清除首包连接定时器（流式传输期间不误杀长回答）
  clear();

  if (!res.ok) {
    const err = await readHttpError(res, 'responses');
    const errText = String(err.rawBody || err.message || '');

    // 1. 自适应重试：若模型不支持 temperature（如推理模型 o1/o3/gpt-5/codex）
    if (res.status === 400 && !omitTemperature && /temperature/i.test(errText)) {
      hint.omitTemperature = true;
      yield* streamResponses(messages, { ...options, omitTemperature: true });
      return;
    }

    // 2. 自适应重试：若网关要求 canonical content_blocks 或 string input，或不支持 instructions
    if ((res.status === 400 || res.status === 422) && !options._retriedSchema) {
      if (/instructions/i.test(errText) && !inlineSystem) {
        hint.inlineSystem = true;
        yield* streamResponses(messages, { ...options, inlineSystem: true, _retriedSchema: true });
        return;
      }
      const nextFormat = inputFormat === 'simple' ? 'canonical' : 'string';
      hint.responsesInputFormat = nextFormat;
      yield* streamResponses(messages, { ...options, inputFormat: nextFormat, _retriedSchema: true });
      return;
    }

    // 3. 阿里云百炼 DashScope Responses 备选路径重试
    if (
      (res.status === 404 || res.status === 405) &&
      /dashscope(?:-intl)?\.aliyuncs\.com/i.test(cfg.baseUrl) &&
      !options.endpointOverride
    ) {
      const altEndpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/api/v2/apps/protocols/compatible-mode/v1/responses`;
      if (altEndpoint !== endpoint) {
        yield* streamResponses(messages, { ...options, endpointOverride: altEndpoint });
        return;
      }
    }

    throw err;
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  // 兼容：若网关忽略 stream: true 直接返回 application/json，直接提取文本并流畅输出
  if (contentType.includes('application/json') || !payload.stream) {
    const json = await res.json().catch(() => ({}));
    if (json.error) {
      throw new Error(`[responses] ${json.error.message || JSON.stringify(json.error)}`);
    }
    const text = extractResponsesText(json);
    if (text) yield text;
    return;
  }

  let hasYieldedDelta = false;
  let fallbackDoneText = '';

  for await (const frame of iterateSseFrames(res)) {
    const { event, data } = frame;
    if (!data) continue;
    if (data === '[DONE]') {
      if (!hasYieldedDelta && fallbackDoneText) {
        yield fallbackDoneText;
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const type = parsed.type || event || '';

    // 标准 Responses API 文本增量事件
    if (type === 'response.output_text.delta') {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : parsed.delta?.text || '';
      if (delta) {
        hasYieldedDelta = true;
        yield delta;
      }
      continue;
    }

    // 兼容部分网关发送的 content_part.delta / text.delta
    if (type === 'response.content_part.delta' || type === 'response.text.delta') {
      const delta =
        typeof parsed.delta === 'string'
          ? parsed.delta
          : parsed.delta?.text || parsed.delta?.output_text || '';
      if (delta) {
        hasYieldedDelta = true;
        yield delta;
      }
      continue;
    }

    // 兼容 refusal 增量
    if (type === 'response.refusal.delta') {
      if (typeof parsed.delta === 'string' && parsed.delta) {
        hasYieldedDelta = true;
        yield parsed.delta;
      }
      continue;
    }

    // 兼容推理摘要增量回调（不污染正文，但可供调用方感知）
    if (
      (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') &&
      typeof options.onReasoning === 'function'
    ) {
      if (typeof parsed.delta === 'string' && parsed.delta) {
        options.onReasoning(parsed.delta);
      }
      continue;
    }

    // 兼容部分网关在 /v1/responses 转发 Chat Completions chunk
    if (Array.isArray(parsed.choices) && parsed.choices[0]?.delta?.content) {
      hasYieldedDelta = true;
      yield parsed.choices[0].delta.content;
      continue;
    }

    // 记录 done 快照文本，防止网关只发 done 而不发 delta
    if (type === 'response.output_text.done') {
      if (typeof parsed.text === 'string' && parsed.text) {
        fallbackDoneText += parsed.text;
      }
      continue;
    }
    if (type === 'response.content_part.done' && parsed.part?.text) {
      if (!fallbackDoneText) fallbackDoneText = parsed.part.text;
      continue;
    }
    if (type === 'response.output_item.done' && parsed.item) {
      const itemText = extractResponsesText({ output: [parsed.item] });
      if (itemText && !fallbackDoneText) fallbackDoneText = itemText;
      continue;
    }

    // 流完成事件：若此前未收到任何 delta，则兜底输出完整文本并立即结束流
    if (type === 'response.completed' || type === 'response.done') {
      if (!hasYieldedDelta) {
        const finalText = extractResponsesText(parsed.response || parsed) || fallbackDoneText;
        if (finalText) {
          hasYieldedDelta = true;
          yield finalText;
        }
      }
      return;
    }

    // 错误事件处理
    if (type === 'response.failed' || type === 'error' || parsed.error) {
      const errObj = parsed.error || parsed.response?.error || {};
      const msg = errObj.message || parsed.message || 'Responses API 流式生成失败';
      throw new Error(`[responses] ${msg}`);
    }
  }

  if (!hasYieldedDelta && fallbackDoneText) {
    yield fallbackDoneText;
  }
}

/**
 * OpenAI Chat Completions API (/v1/chat/completions) 流式生成器
 */
async function* streamChatCompletions(messages, options = {}) {
  const cfg = getConfig(options);
  const hint = getHint(cfg.baseUrl);
  const endpoint = options.endpointOverride || resolveEndpointUrl(cfg.baseUrl, 'chat_completions');
  const omitTemperature = Boolean(options.omitTemperature || hint.omitTemperature);

  const payload = buildChatCompletionsPayload(messages, {
    ...options,
    omitTemperature,
    stream: options.stream !== undefined ? Boolean(options.stream) : true,
  });

  const { signal, clear } = createRequestSignal(options.signal, cfg.timeoutMs);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        Accept: payload.stream ? 'text/event-stream, application/json' : 'application/json',
        ...(options.headers || {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    clear();
    throw err;
  }

  clear();

  if (!res.ok) {
    const err = await readHttpError(res, 'chat_completions');
    if (res.status === 400 && !omitTemperature && /temperature/i.test(String(err.rawBody || err.message))) {
      hint.omitTemperature = true;
      yield* streamChatCompletions(messages, { ...options, omitTemperature: true });
      return;
    }
    throw err;
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json') || !payload.stream) {
    const json = await res.json().catch(() => ({}));
    if (json.error) {
      throw new Error(`[chat_completions] ${json.error.message || JSON.stringify(json.error)}`);
    }
    const text = extractChatCompletionsText(json);
    if (text) yield text;
    return;
  }

  let hasYielded = false;
  for await (const frame of iterateSseFrames(res)) {
    const { data } = frame;
    if (!data) continue;
    if (data === '[DONE]') return;

    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }

    if (j.error) {
      throw new Error(`[chat_completions] ${j.error.message || JSON.stringify(j.error)}`);
    }

    const choice = j.choices && j.choices[0];
    if (choice) {
      const delta = choice.delta && choice.delta.content;
      if (typeof delta === 'string' && delta.length > 0) {
        hasYielded = true;
        yield delta;
      } else if (!hasYielded && choice.message && typeof choice.message.content === 'string' && choice.message.content) {
        hasYielded = true;
        yield choice.message.content;
      }
      if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
        // 某些网关在同一个 chunk 既有 delta 又有 finish_reason，已 yield delta 后即可安全继续等待或结束
      }
    }
  }
}

/**
 * Anthropic Messages REST API (/v1/messages) 流式生成器
 */
async function* streamAnthropic(messages, options = {}) {
  const cfg = getConfig(options);
  const endpoint = options.endpointOverride || resolveEndpointUrl(cfg.baseUrl, 'anthropic');
  const payload = buildAnthropicPayload(messages, {
    ...options,
    stream: options.stream !== undefined ? Boolean(options.stream) : true,
  });

  const headers = {
    'x-api-key': cfg.apiKey,
    'anthropic-version': options.anthropicVersion || process.env.ANTHROPIC_VERSION || '2023-06-01',
    'Content-Type': 'application/json',
    Accept: payload.stream ? 'text/event-stream, application/json' : 'application/json',
    ...(options.headers || {}),
  };

  // 对于非官方 Anthropic 聚合网关（OneAPI/NewAPI/百炼等），同时附带 Authorization: Bearer 提高兼容性
  if (!/^https?:\/\/api\.anthropic\.com\b/i.test(endpoint)) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }

  const { signal, clear } = createRequestSignal(options.signal, cfg.timeoutMs);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    clear();
    throw err;
  }

  clear();

  if (!res.ok) {
    throw await readHttpError(res, 'anthropic');
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json') || !payload.stream) {
    const json = await res.json().catch(() => ({}));
    if (json.type === 'error' || json.error) {
      const msg = (json.error && json.error.message) || json.message || 'Anthropic 调用失败';
      throw new Error(`[anthropic] ${msg}`);
    }
    const text = extractAnthropicText(json);
    if (text) yield text;
    return;
  }

  let hasYielded = false;
  for await (const frame of iterateSseFrames(res)) {
    const { event, data } = frame;
    if (!data || data === '[DONE]') return;

    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }

    const type = j.type || event || '';

    if (type === 'content_block_delta') {
      const delta = j.delta;
      if (delta && delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        hasYielded = true;
        yield delta.text;
      } else if (delta && typeof delta.text === 'string' && delta.text) {
        hasYielded = true;
        yield delta.text;
      }
      continue;
    }

    if (type === 'content_block_start') {
      const block = j.content_block;
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text) {
        hasYielded = true;
        yield block.text;
      }
      continue;
    }

    // 兼容部分网关在 /v1/messages 返回整包 message 或 OpenAI choices
    if (type === 'message' && Array.isArray(j.content) && !hasYielded) {
      const text = extractAnthropicText(j);
      if (text) {
        hasYielded = true;
        yield text;
      }
      continue;
    }
    if (Array.isArray(j.choices) && j.choices[0]?.delta?.content) {
      hasYielded = true;
      yield j.choices[0].delta.content;
      continue;
    }

    if (type === 'message_stop') {
      return;
    }

    if (type === 'error' || j.error) {
      const msg = (j.error && j.error.message) || j.message || 'Anthropic 流式响应错误';
      throw new Error(`[anthropic] ${msg}`);
    }
  }
}

/**
 * 判断错误是否属于「当前网关不支持该协议端点」，从而允许平滑回退到备选协议
 */
function isEndpointUnsupportedError(err) {
  if (!err) return false;
  const status = err.status;
  if ([404, 405, 501].includes(status)) return true;
  if (status === 400 || status === 422) {
    const msg = String(err.rawBody || err.message || '').toLowerCase();
    if (
      msg.includes('not found') ||
      msg.includes('unsupported') ||
      msg.includes('unknown endpoint') ||
      msg.includes('invalid url') ||
      msg.includes('messages is required')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 统一流式对话入口：
 * - 首要保证 Responses API 极速流畅
 * - 支持 responses / chat_completions / anthropic / auto 四种模式
 * - 当开启 autoFallback 且还未向客户端写出任何 token 时，若目标协议端点不支持（如 404/405/501），自动平滑回退并缓存可用协议
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} options
 */
async function* chatStream(messages, options = {}) {
  const cfg = getConfig(options);
  const hint = getHint(cfg.baseUrl);

  // 确定协议尝试顺序：Responses API 始终具有最高优先级（除非用户显式锁定其他协议）
  let primary = cfg.protocol === 'auto' ? hint.workingProtocol || 'responses' : cfg.protocol;
  if (cfg.protocol === 'responses' && hint.workingProtocol && cfg.autoFallback && !options.strictProtocol) {
    primary = hint.workingProtocol;
  }

  const order = [primary];
  if (cfg.autoFallback && !options.strictProtocol) {
    for (const candidate of ['responses', 'chat_completions', 'anthropic']) {
      if (!order.includes(candidate)) order.push(candidate);
    }
  }

  const runnerMap = {
    responses: streamResponses,
    chat_completions: streamChatCompletions,
    anthropic: streamAnthropic,
  };

  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const proto = order[i];
    const runner = runnerMap[proto] || streamResponses;
    let yieldedAny = false;
    try {
      for await (const delta of runner(messages, { ...options, protocol: proto })) {
        if (delta) {
          if (!yieldedAny) {
            yieldedAny = true;
            hint.workingProtocol = proto;
            if (typeof options.onProtocolResolved === 'function') {
              options.onProtocolResolved(proto);
            }
          }
          yield delta;
        }
      }
      hint.workingProtocol = proto;
      return;
    } catch (err) {
      lastErr = err;
      const canFallback =
        !yieldedAny &&
        i + 1 < order.length &&
        (cfg.protocol === 'auto' || isEndpointUnsupportedError(err));
      if (!canFallback) {
        throw err;
      }
      console.warn(`[llm] 协议 ${proto} 不可用 (${err.message})，自动切换至 ${order[i + 1]}`);
    }
  }

  if (lastErr) throw lastErr;
}

/**
 * 构造 RAG 提示词（对齐百炼知识问答：基于参考资料作答 + 引用标注 + 拒答）
 */
function buildRagMessages(query, nodes, history = [], extraSystem = '') {
  const refs = (nodes || [])
    .map((n, i) => `【参考资料${i + 1}】（来源：${n.doc_name || '知识库'}${n.heading ? ' / ' + n.heading : ''}）\n${n.text}`)
    .join('\n\n');
  const system = [
    extraSystem ? extraSystem.trim() + '\n' : '',
    '你是知识库问答助手。请仅依据下方参考资料回答用户问题，要求：',
    '1. 回答准确、简洁，使用中文；',
    '2. 在引用资料的相应内容后标注编号，如 [1]、[2]；',
    '3. 如果参考资料不足以回答问题，请直接说明无法从知识库中找到答案，不要编造。',
    refs ? `\n# 参考资料\n${refs}` : '\n（本次未检索到任何参考资料，请说明知识库中没有相关内容。）',
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [{ role: 'system', content: system }];
  for (const m of (history || []).slice(-6)) {
    if (m && (m.role === 'user' || m.role === 'assistant') && m.content) {
      messages.push({ role: m.role, content: contentToText(m.content) });
    }
  }
  messages.push({ role: 'user', content: contentToText(query) });
  return messages;
}

/**
 * 模拟回答：抽取命中最相关切片，带引用标注
 */
function mockAnswer(query, nodes) {
  if (!nodes || !nodes.length) {
    return '未能在知识库中检索到与该问题相关的内容。\n\n（当前为模拟问答模式：在右上角「⚙ 管理」配置 AI Platform API Key 或设置环境变量后，将调用真实大模型生成回答。）';
  }
  const parts = nodes.slice(0, 3).map((n, i) => {
    const seg = String(n.text || '').replace(/\s+/g, ' ').slice(0, 160);
    return `[${i + 1}] ${seg}…（来源：${n.doc_name || '知识库'}）`;
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
 * 非流式完整回答（产物生成及非流式接口用）
 * 默认复用流式通道聚合（避免部分 Responses 网关不支持 stream:false 或长文本网关超时）
 */
async function complete(messages, options = {}) {
  let out = '';
  for await (const delta of chatStream(messages, options)) {
    out += delta;
  }
  return out;
}

/**
 * 连接与流畅度测试（测量首包延迟 TTFT 与总耗时）
 */
async function testConnection(overrides = {}) {
  const cfg = getConfig(overrides);
  if (!cfg.apiKey) {
    throw new Error('请先填写 API Key');
  }
  const start = Date.now();
  let ttftMs = null;
  let usedProtocol = cfg.protocol === 'auto' ? 'responses' : cfg.protocol;
  let output = '';

  const messages = [
    { role: 'system', content: 'You are a helpful assistant. Reply briefly in 1 short sentence.' },
    { role: 'user', content: 'Ping! Please reply with OK.' },
  ];

  for await (const delta of chatStream(messages, {
    ...overrides,
    max_output_tokens: 32,
    max_tokens: 32,
    onProtocolResolved: (p) => {
      usedProtocol = p;
    },
  })) {
    if (ttftMs === null) ttftMs = Date.now() - start;
    output += delta;
  }

  const totalMs = Date.now() - start;
  return {
    ok: true,
    configured_protocol: cfg.protocol,
    used_protocol: usedProtocol,
    endpoint: resolveEndpointUrl(cfg.baseUrl, usedProtocol),
    model: cfg.model,
    ttft_ms: ttftMs ?? totalMs,
    total_ms: totalMs,
    preview: output.trim().slice(0, 120),
  };
}

module.exports = {
  PROTOCOLS,
  available,
  chatStream,
  complete,
  buildRagMessages,
  mockAnswer,
  chatModel,
  getConfig,
  updateRuntimeConfig,
  normalizeProtocol,
  resolveEndpointUrl,
  buildResponsesPayload,
  buildChatCompletionsPayload,
  buildAnthropicPayload,
  extractResponsesText,
  extractChatCompletionsText,
  extractAnthropicText,
  testConnection,
  contentToText,
};
