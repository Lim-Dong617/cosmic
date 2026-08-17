// ═══════════════════════════════════════════════════════════
// COSMIC 拆分系统 - AI客户端模块
// 统一使用火山引擎 DeepSeek-V4 系列模型
// ═══════════════════════════════════════════════════════════

const OpenAI = require('openai');

// ═══════════ 火山引擎四个模型 ═══════════
// 1. DeepSeek-V4-Pro正式版 (正式版，最强质量)
const VOLCENGINE_V4_PRO_GA = process.env.VOLCENGINE_V4_PRO_GA_MODEL || 'deepseek-v4-pro-0813';
// 2. DeepSeek-V4-Flash正式版 (正式版，高速)
const VOLCENGINE_V4_FLASH_GA = process.env.VOLCENGINE_V4_FLASH_GA_MODEL || 'deepseek-v4-flash-ga-260731';
// 3. DeepSeek-V4-pro (预览版 Pro)
const VOLCENGINE_V4_PRO = process.env.VOLCENGINE_V4_PRO_MODEL || 'deepseek-v4-pro-260425';
// 4. DeepSeek-V4-flash (预览版 Flash)
const VOLCENGINE_V4_FLASH = process.env.VOLCENGINE_V4_FLASH_MODEL || 'deepseek-v4-flash';

// 火山引擎 API 配置
const VOLCENGINE_API_KEY = process.env.VOLCENGINE_API_KEY;
const VOLCENGINE_BASE_URL = process.env.VOLCENGINE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const VOLCENGINE_CODING_BASE_URL = process.env.VOLCENGINE_CODING_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding';

// 默认模型（DeepSeek-V4-Pro正式版）
const DEFAULT_MODEL_ALIAS = 'deepseek-v4-pro-ga';

// 模型映射表：UI 标识 → 实际模型名
const MODEL_MAP = {
    // 四个主要模型
    'deepseek-v4-pro-ga': VOLCENGINE_V4_PRO_GA,         // DeepSeek-V4-Pro正式版
    'deepseek-v4-flash-ga': VOLCENGINE_V4_FLASH_GA,     // DeepSeek-V4-Flash正式版
    'deepseek-v4-pro': VOLCENGINE_V4_PRO,               // DeepSeek-V4-pro
    'deepseek-v4-flash': VOLCENGINE_V4_FLASH,           // DeepSeek-V4-flash
    // 兼容旧入口 → 统一映射到新模型
    'deepseek-v4-flash-free': VOLCENGINE_V4_FLASH_GA,   // 旧Flash → Flash正式版
    'deepseek-v4-flash:free': VOLCENGINE_V4_FLASH_GA,
    'deepseek/deepseek-v4-flash:free': VOLCENGINE_V4_FLASH_GA,
    'deepseek-v3': VOLCENGINE_V4_FLASH_GA,
    'deepseek-v3.2': VOLCENGINE_V4_FLASH_GA,
    'deepseek-r1': VOLCENGINE_V4_PRO_GA,
    'deepseek-reasoner': VOLCENGINE_V4_PRO_GA,
    'deepseek-v4-pro-260425': VOLCENGINE_V4_PRO,
    'gpt-5.1-codex-mini': VOLCENGINE_V4_PRO_GA,
    'glm-5.2': VOLCENGINE_V4_FLASH_GA,
    'company-glm-5.2': VOLCENGINE_V4_FLASH_GA,
    'sensenova-6.8-flash-lite': VOLCENGINE_V4_FLASH,
    'qwen3-coder': VOLCENGINE_V4_FLASH,
    'qwen3-coder-plus': VOLCENGINE_V4_FLASH,
    'DeepSeek-V3-671B': VOLCENGINE_V4_FLASH_GA,
    'Qwen3-Coder-Plus': VOLCENGINE_V4_FLASH
};

// 所有模型统一走火山引擎
const VOLCENGINE_MODELS = new Set([
    VOLCENGINE_V4_PRO_GA,
    VOLCENGINE_V4_FLASH_GA,
    VOLCENGINE_V4_PRO,
    VOLCENGINE_V4_FLASH
]);

// 已废弃的平台列表（保留变量以兼容其他模块引用）
const GPT_MODELS = new Set([]);
const BAISHAN_MODELS = new Set([]);
const SENSENOVA_MODELS = new Set([]);
const KRILL_MODELS = new Set([]);

// 必须使用流式调用的模型（Pro 大模型思考链长，流式更稳定）
const STREAM_ONLY_MODELS = new Set([VOLCENGINE_V4_PRO_GA, VOLCENGINE_V4_PRO]);

/**
 * 获取 OpenAI 兼容客户端（统一使用火山引擎）
 */
function createClient(apiKey, baseUrl, model) {
    const key = apiKey || VOLCENGINE_API_KEY;
    const url = baseUrl || VOLCENGINE_BASE_URL;
    return new OpenAI({ apiKey: key, baseURL: url });
}

function isKrillModel(model) {
    return false; // 已废弃 Krill
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
    // 保留函数签名以兼容引用
    return '';
}

function companyGlmUrl(path, baseUrl) {
    // 保留函数签名以兼容引用
    return '';
}

function volcengineUrl(path, baseUrl = VOLCENGINE_CODING_BASE_URL) {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function getVolcengineStandardBaseUrl(baseUrl = VOLCENGINE_CODING_BASE_URL) {
    const configured = String(process.env.VOLCENGINE_STANDARD_BASE_URL || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    const source = String(baseUrl || '').replace(/\/+$/, '');
    if (/\/api\/coding$/i.test(source)) {
        return source.replace(/\/api\/coding$/i, '/api/v3');
    }
    if (/\/api\/v3$/i.test(source)) return source;
    try {
        return `${new URL(source).origin}/api/v3`;
    } catch {
        return VOLCENGINE_BASE_URL.replace(/\/+$/, '');
    }
}

function isCodingPlanUnavailableError(error) {
    const message = String(error?.message || '');
    return error?.status === 400
        && /CodingPlan|valid\s+subscription|subscription\s+has\s+expired/i.test(message);
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

async function callKrillAI() {
    throw new Error('Krill 通道已废弃，请使用火山引擎模型');
}

async function callCompanyGlmAI() {
    throw new Error('公司 GLM 通道已废弃，请使用火山引擎模型');
}

async function callVolcengineCodingAI({ messages, modelName, temperature, max_tokens, stream, res, apiKey, baseUrl }) {
    const key = apiKey || VOLCENGINE_API_KEY;
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
 * 调用 AI Chat 接口（统一火山引擎）
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
    const activeBaseUrl = baseUrl || VOLCENGINE_BASE_URL;

    // 尝试 Coding 端点（如果配置了 coding URL）
    if (isVolcengineModel && /\/api\/coding\/?$/i.test(activeBaseUrl || '')) {
        try {
            return await callVolcengineCodingAI({ messages, modelName, temperature, max_tokens, stream, res, apiKey, baseUrl: activeBaseUrl });
        } catch (error) {
            if (!isCodingPlanUnavailableError(error)) throw error;
            const standardBaseUrl = getVolcengineStandardBaseUrl(activeBaseUrl);
            console.warn(`   ↪️ 火山 CodingPlan 不可用，改走同模型标准推理端点: ${standardBaseUrl}`);
            return callAI({
                ...options,
                model: modelName,
                apiKey: apiKey || VOLCENGINE_API_KEY,
                baseUrl: standardBaseUrl
            });
        }
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
        const isProModel = modelName === VOLCENGINE_V4_PRO_GA || modelName === VOLCENGINE_V4_PRO;
        for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta;
            // 检测 finish_reason
            if (chunk.choices[0]?.finish_reason) {
                finishReason = chunk.choices[0].finish_reason;
            }
            // Pro 模型：reasoning_content 是思考链，content 是最终答案
            if (isProModel && delta?.reasoning_content) {
                thinkingContent += delta.reasoning_content;
            }
            const content = delta?.content || '';
            fullContent += content;
        }
        if (isProModel && thinkingContent) {
            console.log(`   🧠 DeepSeek V4 Pro 思考链长度: ${thinkingContent.length} 字符`);
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
    // 新的四个火山引擎模型
    VOLCENGINE_V4_PRO_GA,
    VOLCENGINE_V4_FLASH_GA,
    VOLCENGINE_V4_PRO,
    VOLCENGINE_V4_FLASH,
    VOLCENGINE_BASE_URL,
    VOLCENGINE_CODING_BASE_URL,
    VOLCENGINE_MODELS,
    getVolcengineStandardBaseUrl,
    isCodingPlanUnavailableError,
    DEFAULT_MODEL_ALIAS,
    // 兼容旧模块引用（指向新模型或空值）
    SENSENOVA_MODEL_NAME: VOLCENGINE_V4_FLASH_GA,
    SENSENOVA_GLM_MODEL_NAME: VOLCENGINE_V4_FLASH_GA,
    SENSENOVA_FLASH_LITE_MODEL_NAME: VOLCENGINE_V4_FLASH,
    COMPANY_GLM_MODEL_ALIAS: 'company-glm-5.2',
    COMPANY_GLM_MODEL_NAME: VOLCENGINE_V4_FLASH_GA,
    COMPANY_GLM_BASE_URL: VOLCENGINE_BASE_URL,
    SENSENOVA_MODELS,
    SENSENOVA_BASE_URL: VOLCENGINE_BASE_URL,
    KRILL_MODEL_NAME: VOLCENGINE_V4_FLASH_GA,
    KRILL_BASE_URL: VOLCENGINE_BASE_URL,
    VOLCENGINE_MODEL_NAME: VOLCENGINE_V4_PRO_GA,
    VOLCENGINE_STANDARD_BASE_URL: VOLCENGINE_BASE_URL,
    companyGlmUrl,
    callCompanyGlmAI
};
