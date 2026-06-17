// ═══════════════════════════════════════════════════════════
// COSMIC 拆分系统 - AI客户端模块
// ═══════════════════════════════════════════════════════════

const OpenAI = require('openai');

const SENSENOVA_MODEL_NAME = process.env.SENSENOVA_MODEL || 'deepseek-v4-flash';
const SENSENOVA_BASE_URL = process.env.SENSENOVA_BASE_URL || 'https://token.sensenova.cn/v1';
const KRILL_MODEL_NAME = process.env.KRILL_MODEL || process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash:free';
const KRILL_BASE_URL = process.env.KRILL_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api-slb.krill-ai.com/coding';
const DEFAULT_MODEL_ALIAS = 'deepseek-v4-flash-free';

// 火山引擎模型名称
const VOLCENGINE_MODEL_NAME = process.env.VOLCENGINE_MODEL || 'deepseek-v4-pro-260425';
const VOLCENGINE_BASE_URL = process.env.VOLCENGINE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding';

// 模型映射表
const MODEL_MAP = {
    'deepseek-v4-flash-free': SENSENOVA_MODEL_NAME,
    'deepseek-v4-flash': SENSENOVA_MODEL_NAME,
    'deepseek-v4-flash:free': SENSENOVA_MODEL_NAME,
    'deepseek/deepseek-v4-flash:free': SENSENOVA_MODEL_NAME,
    'deepseek-v4-pro': VOLCENGINE_MODEL_NAME,
    'deepseek-v3': SENSENOVA_MODEL_NAME,               // 兼容旧入口：改走 SenseNova V4 Flash
    'deepseek-v3.2': SENSENOVA_MODEL_NAME,             // 兼容旧入口：改走 SenseNova V4 Flash
    'deepseek-r1': VOLCENGINE_MODEL_NAME,              // 兼容旧入口：改走火山引擎 DeepSeek V4 Pro
    'deepseek-reasoner': VOLCENGINE_MODEL_NAME,         // 别名
    'qwen3-coder': 'DeepSeek-R1-0528-Qwen3-8B',   // → 白山云
    'qwen3-coder-plus': 'DeepSeek-R1-0528-Qwen3-8B', // → 白山云
    'gpt-5.1-codex-mini': VOLCENGINE_MODEL_NAME,   // → 火山引擎 DeepSeek V4 Pro
    // 兼容旧版大写名称
    'DeepSeek-V3-671B': SENSENOVA_MODEL_NAME,     // 兼容旧名称：改走 SenseNova V4 Flash
    'Qwen3-Coder-Plus': 'DeepSeek-R1-0528-Qwen3-8B'
};

// GPT平台模型列表（已废弃，原GPT按钮改为火山引擎）
const GPT_MODELS = new Set([]);

// 白山云平台模型列表
const BAISHAN_MODELS = new Set(['DeepSeek-R1-0528-Qwen3-8B']);

// 火山引擎平台模型列表
const VOLCENGINE_MODELS = new Set([VOLCENGINE_MODEL_NAME]);

// SenseNova平台模型列表（OpenAI兼容）
const SENSENOVA_MODELS = new Set([SENSENOVA_MODEL_NAME]);

// Krill平台模型列表（Anthropic/Claude Code 兼容）
const KRILL_MODELS = new Set([KRILL_MODEL_NAME]);

// 必须使用流式调用的模型（R1 思考链很长，流式更稳定）
const STREAM_ONLY_MODELS = new Set(['deepseek-r1', 'DeepSeek-R1-0528-Qwen3-8B']);

/**
 * 获取 OpenAI 兼容客户端
 */
function createClient(apiKey, baseUrl, model) {
    // 根据模型选择对应平台的密钥和URL
    const isGptModel = model && GPT_MODELS.has(model);
    const isBaishanModel = model && BAISHAN_MODELS.has(model);
    const isVolcengineModel = model && VOLCENGINE_MODELS.has(model);
    const isSensenovaModel = model && SENSENOVA_MODELS.has(model);
    let key, url;
    if (apiKey) {
        key = apiKey;
    } else if (isSensenovaModel) {
        key = process.env.SENSENOVA_API_KEY;
    } else if (isVolcengineModel) {
        key = process.env.VOLCENGINE_API_KEY;
    } else if (isGptModel) {
        key = process.env.GPT_API_KEY;
    } else if (isBaishanModel) {
        key = process.env.BAISHAN_API_KEY;
    } else {
        key = process.env.IFLOW_API_KEY;
    }
    if (baseUrl) {
        url = baseUrl;
    } else if (isSensenovaModel) {
        url = SENSENOVA_BASE_URL;
    } else if (isVolcengineModel) {
        url = VOLCENGINE_BASE_URL;
    } else if (isGptModel) {
        url = process.env.GPT_BASE_URL || 'https://x.ainiaini.xyz/v1';
    } else if (isBaishanModel) {
        url = process.env.BAISHAN_BASE_URL || 'https://api.edgefn.net/v1';
    } else {
        url = process.env.IFLOW_BASE_URL || 'https://apis.iflow.cn/v1';
    }
    return new OpenAI({ apiKey: key, baseURL: url });
}

function isKrillModel(model) {
    return model && KRILL_MODELS.has(model);
}

function normalizeAnthropicMessages(messages = []) {
    const systemParts = [];
    const chatMessages = [];

    for (const message of messages) {
        const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
        const content = typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
                ? message.content.map(part => part.text || part.content || '').join('\n')
                : String(message.content || '');

        if (!content) continue;
        if (role === 'system') {
            systemParts.push(content);
        } else {
            chatMessages.push({ role, content });
        }
    }

    if (!chatMessages.length) {
        chatMessages.push({ role: 'user', content: '' });
    }

    return {
        system: systemParts.join('\n\n') || undefined,
        messages: chatMessages
    };
}

function krillUrl(path) {
    return `${KRILL_BASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function volcengineUrl(path, baseUrl = VOLCENGINE_BASE_URL) {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function extractAnthropicText(data) {
    if (typeof data?.content === 'string') return data.content;
    if (Array.isArray(data?.content)) {
        return data.content
            .map(part => part?.text || part?.content || '')
            .filter(Boolean)
            .join('');
    }
    return data?.completion || data?.message?.content || '';
}

async function callKrillAI({ messages, modelName, temperature, max_tokens, stream, res, apiKey }) {
    const key = apiKey || process.env.KRILL_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    if (!key) {
        throw new Error('缺少 KRILL_API_KEY / ANTHROPIC_AUTH_TOKEN');
    }

    const normalized = normalizeAnthropicMessages(messages);
    const body = {
        model: modelName,
        messages: normalized.messages,
        max_tokens,
        temperature
    };
    if (normalized.system) body.system = normalized.system;

    const response = await fetch(krillUrl('/v1/messages'), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
    });

    const raw = await response.text();
    let data = null;
    try {
        data = raw ? JSON.parse(raw) : null;
    } catch (error) {
        throw new Error(`Krill响应不是JSON: ${raw.slice(0, 300)}`);
    }

    if (!response.ok) {
        const message = data?.error?.message || data?.message || data?.msg || raw;
        const error = new Error(`Krill API错误 [${response.status}]: ${message}`);
        error.status = response.status;
        throw error;
    }

    const content = extractAnthropicText(data);
    if (stream && res) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
        return null;
    }

    return {
        choices: [{
            message: { role: 'assistant', content },
            finish_reason: data?.stop_reason || 'stop'
        }],
        model: data?.model || modelName,
        usage: {
            prompt_tokens: data?.usage?.input_tokens || 0,
            completion_tokens: data?.usage?.output_tokens || 0,
            total_tokens: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0)
        }
    };
}

async function callVolcengineCodingAI({ messages, modelName, temperature, max_tokens, stream, res, apiKey, baseUrl }) {
    const key = apiKey || process.env.VOLCENGINE_API_KEY;
    if (!key) {
        throw new Error('缺少 VOLCENGINE_API_KEY');
    }

    const normalized = normalizeAnthropicMessages(messages);
    const body = {
        model: modelName,
        messages: normalized.messages,
        max_tokens,
        temperature
    };
    if (normalized.system) body.system = normalized.system;

    const response = await fetch(volcengineUrl('/v1/messages', baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
    });

    const raw = await response.text();
    let data = null;
    try {
        data = raw ? JSON.parse(raw) : null;
    } catch (error) {
        throw new Error(`火山引擎 Coding 响应不是JSON: ${raw.slice(0, 300)}`);
    }

    if (!response.ok) {
        const message = data?.error?.message || data?.message || data?.msg || raw;
        const error = new Error(`火山引擎 Coding API错误 [${response.status}]: ${message}`);
        error.status = response.status;
        throw error;
    }

    const content = extractAnthropicText(data);
    if (stream && res) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
        return null;
    }

    return {
        choices: [{
            message: { role: 'assistant', content },
            finish_reason: data?.stop_reason || 'stop'
        }],
        model: data?.model || modelName,
        usage: {
            prompt_tokens: data?.usage?.input_tokens || 0,
            completion_tokens: data?.usage?.output_tokens || 0,
            total_tokens: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0)
        }
    };
}

/**
 * 调用 AI Chat 接口
 * @param {Object} options - 调用选项
 * @param {Array} options.messages - 消息数组
 * @param {string} options.model - 模型标识
 * @param {number} options.temperature - 温度参数
 * @param {number} options.max_tokens - 最大token数
 * @param {boolean} options.stream - 是否流式
 * @param {Object} options.res - Express response对象（流式时使用）
 * @param {string} options.apiKey - API密钥
 * @param {string} options.baseUrl - API基础URL
 * @returns {Object|null} AI响应
 */
async function callAI(options) {
    const {
        messages,
        model = process.env.DEFAULT_MODEL || DEFAULT_MODEL_ALIAS,
        temperature = 0.3,
        max_tokens = 8000,
        stream = false,
        res = null,
        apiKey = null,
        baseUrl = null
    } = options;

    const modelName = MODEL_MAP[model] || model;
    const isStreamOnly = STREAM_ONLY_MODELS.has(modelName);
    const isVolcengineModel = VOLCENGINE_MODELS.has(modelName);
    const activeBaseUrl = baseUrl || (isVolcengineModel ? VOLCENGINE_BASE_URL : null);

    if (isKrillModel(modelName)) {
        return callKrillAI({ messages, modelName, temperature, max_tokens, stream, res, apiKey });
    }

    if (isVolcengineModel && /\/api\/coding\/?$/i.test(activeBaseUrl || '')) {
        return callVolcengineCodingAI({ messages, modelName, temperature, max_tokens, stream, res, apiKey, baseUrl: activeBaseUrl });
    }

    const client = createClient(apiKey, baseUrl, modelName);

    if (stream && res) {
        // 流式调用（直接输出给客户端）
        const completion = await client.chat.completions.create({
            model: modelName,
            messages,
            temperature,
            max_tokens,
            stream: true
        });

        for await (const chunk of completion) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
            }
        }
        return null;
    } else if (isStreamOnly) {
        // 强制流式模型：内部用stream调用，收集完整响应后返回为非流式结果
        console.log(`   📡 模型 ${modelName} 强制流式调用中...`);
        const completion = await client.chat.completions.create({
            model: modelName,
            messages,
            temperature,
            max_tokens,
            stream: true
        });

        let fullContent = '';
        let thinkingContent = '';
        let finishReason = 'stop';
        const isR1 = modelName === 'deepseek-r1' || modelName === 'DeepSeek-R1-0528-Qwen3-8B';
        for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta;
            // 检测 finish_reason
            if (chunk.choices[0]?.finish_reason) {
                finishReason = chunk.choices[0].finish_reason;
            }
            // R1 模型：reasoning_content 是思考链，content 是最终答案
            if (isR1 && delta?.reasoning_content) {
                thinkingContent += delta.reasoning_content;
            }
            const content = delta?.content || '';
            fullContent += content;
        }
        if (isR1 && thinkingContent) {
            console.log(`   🧠 DeepSeek-R1 思考链长度: ${thinkingContent.length} 字符`);
        }
        if (finishReason === 'length') {
            console.warn(`   ⚠️ 输出被截断 (finish_reason=length)，已用完 max_tokens=${max_tokens}`);
        }

        // 构造一个兼容非流式格式的响应对象
        return {
            choices: [{
                message: { role: 'assistant', content: fullContent },
                finish_reason: finishReason
            }],
            model: modelName,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
    } else {
        // 标准非流式调用
        const completion = await client.chat.completions.create({
            model: modelName,
            messages,
            temperature,
            max_tokens,
            stream: false
        });

        // 验证API响应格式（部分兼容平台可能返回200但body是错误信息）
        if (completion && completion.status && completion.msg && !completion.choices) {
            throw new Error(`API错误 [${completion.status}]: ${completion.msg}（模型: ${modelName}）`);
        }

        // 检测截断
        if (completion?.choices?.[0]?.finish_reason === 'length') {
            console.warn(`   ⚠️ 输出被截断 (finish_reason=length)，已用完 max_tokens=${max_tokens}`);
        }

        return completion;
    }
}

/**
 * 带重试机制的AI调用
 * - 449/429 rate limit: 指数退避，从10秒起，最长60秒，带随机抖动
 * - 网络/JSON错误: 指数退避，从3秒起
 * @param {Object} options - callAI的选项
 * @param {number} maxRetries - 最大重试次数
 * @returns {Object} AI响应
 */
async function callAIWithRetry(options, maxRetries = 6) {

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                // 日志已在上一轮 catch 中输出
            }

            return await callAI(options);
        } catch (error) {
            const status = error.status || error.response?.status;
            const isRateLimit = status === 429 || status === 449
                || error.message?.includes('429') || error.message?.includes('449')
                || error.message?.includes('rate limit') || error.message?.includes('Rate Limit')
                || error.message?.includes('exceeded your current rate');
            const isRetryable = isRateLimit
                || status === 500 || status === 502 || status === 503
                || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED'
                || error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ECONNREFUSED'
                || error.message?.includes('timeout')
                || error.message?.includes('Unexpected end of JSON') || error.message?.includes('invalid json response body')
                || error.message?.includes('unexpected end of file')
                || error.message?.includes('Premature close') || error.message?.includes('premature close')
                || error.message?.includes('PREMATURE_CLOSE') || error.message?.includes('Invalid response body');

            console.warn(`   ⚠️ AI调用失败 (尝试 ${attempt + 1}/${maxRetries}): [${status || error.code || '?'}] ${error.message?.substring(0, 200)}`);

            if (isRetryable && attempt < maxRetries - 1) {
                // Rate limit: 更激进的退避 (10s, 20s, 40s, 60s, 60s ...)
                // 普通错误: 常规退避 (3s, 6s, 12s, 24s, 48s ...)
                let delay;
                if (isRateLimit) {
                    delay = Math.min(10000 * Math.pow(2, attempt), 60000);
                    console.log(`   🚫 触发限流(${status || '?'})，第 ${attempt + 1} 次重试，等待 ${(delay / 1000).toFixed(0)} 秒...`);
                } else {
                    delay = Math.min(3000 * Math.pow(2, attempt), 30000);
                    console.log(`   ⏳ 第 ${attempt + 1} 次重试，等待 ${(delay / 1000).toFixed(0)} 秒...`);
                }
                // 加入随机抖动 ±20%，避免多请求同时重试雪崩
                const jitter = delay * (0.8 + Math.random() * 0.4);
                await new Promise(resolve => setTimeout(resolve, jitter));
                continue;
            }
            throw error;
        }
    }
}

module.exports = {
    createClient,
    callAI,
    callAIWithRetry,
    MODEL_MAP,
    SENSENOVA_MODEL_NAME,
    SENSENOVA_BASE_URL,
    KRILL_MODEL_NAME,
    KRILL_BASE_URL,
    DEFAULT_MODEL_ALIAS
};
