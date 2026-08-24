// ═══════════════════════════════════════════════════════════
// COSMIC 拆分系统 - AI客户端模块
// DeepSeek-V4 多提供商 AI 客户端
// ═══════════════════════════════════════════════════════════

const OpenAI = require('openai');

// ═══════════ 火山引擎四个模型 ═══════════
// 1. DeepSeek-V4-Pro正式版 (正式版，最强质量)
const VOLCENGINE_V4_PRO_GA = process.env.VOLCENGINE_V4_PRO_GA_MODEL || 'deepseek-v4-pro-ga-260813';
// 2. DeepSeek-V4-Flash正式版 (正式版，高速)
const VOLCENGINE_V4_FLASH_GA = process.env.VOLCENGINE_V4_FLASH_GA_MODEL || 'deepseek-v4-flash-ga-260731';
// 3. DeepSeek-V4-pro (预览版 Pro)
const VOLCENGINE_V4_PRO = process.env.VOLCENGINE_V4_PRO_MODEL || 'deepseek-v4-pro-260425';
// 4. DeepSeek-V4-flash (预览版 Flash)
const VOLCENGINE_V4_FLASH = process.env.VOLCENGINE_V4_FLASH_MODEL || 'deepseek-v4-flash-260425';

// 火山引擎 API 配置
const VOLCENGINE_API_KEY = process.env.VOLCENGINE_API_KEY;
const VOLCENGINE_BASE_URL = process.env.VOLCENGINE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const VOLCENGINE_CODING_BASE_URL = process.env.VOLCENGINE_CODING_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding';

// UnlimitDS OpenAI 兼容配置。使用独立内部别名，避免与火山引擎
// `deepseek-v4-pro` UI 别名发生二次映射冲突。
const UNLIMITDS_V4_PRO_ALIAS = 'unlimitds-deepseek-v4-pro';
const UNLIMITDS_V4_PRO_MODEL = process.env.UNLIMITDS_V4_PRO_MODEL || 'deepseek-v4-pro';
const UNLIMITDS_API_KEY = process.env.UNLIMITDS_API_KEY || null;
const UNLIMITDS_BASE_URL = process.env.UNLIMITDS_BASE_URL || 'https://unlimitds.chat/v1';

function readBoundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

// OpenAI SDK has its own retries by default. This service already owns retry
// policy, so disable the hidden layer to avoid 3x SDK retries multiplied by
// 6x business retries under load.
const AI_REQUEST_TIMEOUT_MS = readBoundedInteger(
    process.env.AI_REQUEST_TIMEOUT_MS,
    8 * 60 * 1000,
    30 * 1000,
    20 * 60 * 1000
);
const AI_MAX_CONCURRENCY = readBoundedInteger(process.env.AI_MAX_CONCURRENCY, 2, 1, 8);
const AI_QUEUE_TIMEOUT_MS = readBoundedInteger(
    process.env.AI_QUEUE_TIMEOUT_MS,
    10 * 60 * 1000,
    30 * 1000,
    30 * 60 * 1000
);
const AI_MAX_ATTEMPTS = readBoundedInteger(process.env.AI_MAX_ATTEMPTS, 4, 1, 8);
const AI_MODULE_REQUEST_TIMEOUT_MS = readBoundedInteger(
    process.env.AI_MODULE_REQUEST_TIMEOUT_MS,
    2 * 60 * 1000,
    30 * 1000,
    AI_REQUEST_TIMEOUT_MS
);
const AI_MODULE_MAX_ATTEMPTS = readBoundedInteger(process.env.AI_MODULE_MAX_ATTEMPTS, 2, 1, 4);
const AI_STREAM_IDLE_TIMEOUT_MS = readBoundedInteger(
    process.env.AI_STREAM_IDLE_TIMEOUT_MS,
    2 * 60 * 1000,
    15 * 1000,
    Math.min(AI_REQUEST_TIMEOUT_MS, 5 * 60 * 1000)
);

function createAbortError(message = 'AI调用已取消') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError();
}

function waitWithSignal(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(createAbortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function createStreamGuard(externalSignal, totalTimeoutMs, idleTimeoutMs = AI_STREAM_IDLE_TIMEOUT_MS) {
    const controller = new AbortController();
    let abortKind = null;
    let idleTimer = null;

    const abort = (kind) => {
        if (controller.signal.aborted) return;
        abortKind = kind;
        controller.abort();
    };
    const onExternalAbort = () => abort('external');
    if (externalSignal?.aborted) abort('external');
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    const totalTimer = setTimeout(() => abort('total-timeout'), totalTimeoutMs);
    const touch = () => {
        if (controller.signal.aborted) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort('idle-timeout'), idleTimeoutMs);
    };
    touch();

    return {
        signal: controller.signal,
        touch,
        cleanup() {
            clearTimeout(totalTimer);
            if (idleTimer) clearTimeout(idleTimer);
            externalSignal?.removeEventListener('abort', onExternalAbort);
        },
        normalizeError(error) {
            if (abortKind === 'external') return createAbortError();
            if (abortKind === 'idle-timeout' || abortKind === 'total-timeout') {
                const seconds = Math.round((abortKind === 'idle-timeout' ? idleTimeoutMs : totalTimeoutMs) / 1000);
                const timeoutError = new Error(
                    abortKind === 'idle-timeout'
                        ? `AI流连续${seconds}秒无数据，已中止并准备重试`
                        : `AI流总耗时超过${seconds}秒，已中止并准备重试`
                );
                timeoutError.code = 'ETIMEDOUT';
                timeoutError.status = 504;
                return timeoutError;
            }
            return error;
        }
    };
}

// 默认模型（DeepSeek-V4-Pro正式版）
const DEFAULT_MODEL_ALIAS = 'deepseek-v4-pro-ga';

// 模型映射表：UI 标识 → 实际模型名
const MODEL_MAP = {
    // 四个主要模型
    'deepseek-v4-pro-ga': VOLCENGINE_V4_PRO_GA,         // DeepSeek-V4-Pro正式版
    'deepseek-v4-flash-ga': VOLCENGINE_V4_FLASH_GA,     // DeepSeek-V4-Flash正式版
    'deepseek-v4-pro': VOLCENGINE_V4_PRO,               // DeepSeek-V4-pro
    'deepseek-v4-flash': VOLCENGINE_V4_FLASH,           // DeepSeek-V4-flash
    [UNLIMITDS_V4_PRO_ALIAS]: UNLIMITDS_V4_PRO_ALIAS,    // UnlimitDS DeepSeek-V4-Pro
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
const UNLIMITDS_MODELS = new Set([UNLIMITDS_V4_PRO_ALIAS]);

// 已废弃的平台列表（保留变量以兼容其他模块引用）
const GPT_MODELS = new Set([]);
const BAISHAN_MODELS = new Set([]);
const SENSENOVA_MODELS = new Set([]);
const KRILL_MODELS = new Set([]);

// 必须使用流式调用的模型（Pro 大模型思考链长，流式更稳定）
const STREAM_ONLY_MODELS = new Set([
    VOLCENGINE_V4_PRO_GA,
    VOLCENGINE_V4_PRO,
    UNLIMITDS_V4_PRO_ALIAS
]);

function resolveModelRoute(model, apiKey = null, baseUrl = null) {
    const modelName = MODEL_MAP[model] || model || DEFAULT_MODEL_ALIAS;
    if (UNLIMITDS_MODELS.has(modelName)) {
        return {
            provider: 'unlimitds',
            modelName,
            requestModelName: UNLIMITDS_V4_PRO_MODEL,
            apiKey: apiKey || UNLIMITDS_API_KEY,
            baseUrl: baseUrl || UNLIMITDS_BASE_URL
        };
    }
    return {
        provider: 'volcengine',
        modelName,
        requestModelName: modelName,
        apiKey: apiKey || VOLCENGINE_API_KEY,
        baseUrl: baseUrl || VOLCENGINE_BASE_URL
    };
}

/**
 * 获取当前模型提供商对应的 OpenAI 兼容客户端。
 */
function createClient(apiKey, baseUrl, model, timeoutMs = AI_REQUEST_TIMEOUT_MS) {
    const route = resolveModelRoute(model, apiKey, baseUrl);
    if (!route.apiKey) {
        const envName = route.provider === 'unlimitds' ? 'UNLIMITDS_API_KEY' : 'VOLCENGINE_API_KEY';
        const error = new Error(`缺少 ${envName}`);
        error.code = 'MISSING_AI_API_KEY';
        error.status = 503;
        throw error;
    }
    return new OpenAI({
        apiKey: route.apiKey,
        baseURL: route.baseUrl,
        timeout: timeoutMs,
        maxRetries: 0
    });
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

async function callVolcengineCodingAI({ messages, modelName, temperature, max_tokens, stream, res, apiKey, baseUrl, timeoutMs = AI_REQUEST_TIMEOUT_MS, signal = null }) {
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    let response;
    let raw;
    try {
        response = await fetch(volcengineUrl('/v1/messages', baseUrl), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        raw = await response.text();
    } catch (error) {
        if (controller.signal.aborted) {
            if (signal?.aborted) throw createAbortError();
            const timeoutError = new Error(`火山引擎 Coding API调用超时（${Math.round(timeoutMs / 1000)}秒）`);
            timeoutError.code = 'ETIMEDOUT';
            timeoutError.status = 504;
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortFromCaller);
    }

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
 * 调用 AI Chat 接口（按模型路由到对应提供商）
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
        baseUrl = null,
        requestTimeoutMs = AI_REQUEST_TIMEOUT_MS,
        signal = null
    } = options;
    throwIfAborted(signal);

    const route = resolveModelRoute(model, apiKey, baseUrl);
    const { modelName, requestModelName } = route;
    const isStreamOnly = STREAM_ONLY_MODELS.has(modelName);
    const isVolcengineModel = VOLCENGINE_MODELS.has(modelName);
    const activeBaseUrl = route.baseUrl;

    // 尝试 Coding 端点（如果配置了 coding URL）
    if (isVolcengineModel && /\/api\/coding\/?$/i.test(activeBaseUrl || '')) {
        try {
            return await callVolcengineCodingAI({ messages, modelName, temperature, max_tokens, stream, res, apiKey: route.apiKey, baseUrl: activeBaseUrl, timeoutMs: requestTimeoutMs, signal });
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

    const client = createClient(route.apiKey, route.baseUrl, modelName, requestTimeoutMs);

    if (stream && res) {
        // 流式调用（直接输出给客户端）
        const guard = createStreamGuard(signal, requestTimeoutMs);
        let emittedContent = false;
        try {
            const completion = await client.chat.completions.create({
                model: requestModelName,
                messages,
                temperature,
                max_tokens,
                stream: true
            }, { signal: guard.signal });

            for await (const chunk of completion) {
                guard.touch();
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    emittedContent = true;
                    res.write(`data: ${JSON.stringify({ content })}\n\n`);
                }
            }
            return null;
        } catch (error) {
            const normalizedError = guard.normalizeError(error);
            if (emittedContent) normalizedError.doNotRetry = true;
            throw normalizedError;
        } finally {
            guard.cleanup();
        }
    } else if (isStreamOnly) {
        // 强制流式模型：内部用stream调用，收集完整响应后返回为非流式结果
        console.log(`   📡 模型 ${requestModelName} (${route.provider}) 强制流式调用中...`);
        const guard = createStreamGuard(signal, requestTimeoutMs);
        try {
            const completion = await client.chat.completions.create({
                model: requestModelName,
                messages,
                temperature,
                max_tokens,
                stream: true
            }, { signal: guard.signal });

            let fullContent = '';
            let thinkingChars = 0;
            let finishReason = 'stop';
            const isProModel = modelName === VOLCENGINE_V4_PRO_GA
                || modelName === VOLCENGINE_V4_PRO
                || UNLIMITDS_MODELS.has(modelName);
            for await (const chunk of completion) {
                guard.touch();
                const delta = chunk.choices[0]?.delta;
                if (chunk.choices[0]?.finish_reason) {
                    finishReason = chunk.choices[0].finish_reason;
                }
                // 只统计思考链长度，不把整段思考链常驻内存。
                if (isProModel && delta?.reasoning_content) {
                    thinkingChars += delta.reasoning_content.length;
                }
                fullContent += delta?.content || '';
            }
            if (isProModel && thinkingChars > 0) {
                console.log(`   🧠 DeepSeek V4 Pro 思考链长度: ${thinkingChars} 字符`);
            }
            if (finishReason === 'length') {
                console.warn(`   ⚠️ 输出被截断 (finish_reason=length)，已用完 max_tokens=${max_tokens}`);
            }

            return {
                choices: [{
                    message: { role: 'assistant', content: fullContent },
                    finish_reason: finishReason
                }],
                model: requestModelName,
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            };
        } catch (error) {
            throw guard.normalizeError(error);
        } finally {
            guard.cleanup();
        }
    } else {
        // 标准非流式调用
        const guard = createStreamGuard(signal, requestTimeoutMs, requestTimeoutMs);
        let completion;
        try {
            completion = await client.chat.completions.create({
                model: requestModelName,
                messages,
                temperature,
                max_tokens,
                stream: false
            }, { signal: guard.signal });
        } catch (error) {
            throw guard.normalizeError(error);
        } finally {
            guard.cleanup();
        }

        // 验证API响应格式（部分兼容平台可能返回200但body是错误信息）
        if (completion && completion.status && completion.msg && !completion.choices) {
            throw new Error(`API错误 [${completion.status}]: ${completion.msg}（模型: ${requestModelName}）`);
        }

        // 检测截断
        if (completion?.choices?.[0]?.finish_reason === 'length') {
            console.warn(`   ⚠️ 输出被截断 (finish_reason=length)，已用完 max_tokens=${max_tokens}`);
        }

        return completion;
    }
}

function getAIErrorStatus(error) {
    return error?.status || error?.response?.status || null;
}

function isRateLimitError(error) {
    const status = getAIErrorStatus(error);
    const message = String(error?.message || '');
    return status === 429 || status === 449
        || /\b(?:429|449)\b|rate limit|exceeded your current rate/i.test(message);
}

function isPermanentRateLimitError(error) {
    if (!isRateLimitError(error)) return false;
    return /SetLimitExceeded|service has been paused|Safe Experience Mode|inference limit|insufficient quota|billing quota|quota (?:is )?(?:exhausted|depleted)|weekly (?:usage )?limit|monthly (?:usage )?limit|周期额度|额度(?:已)?用完|注册限制/i
        .test(String(error?.message || ''));
}

function isRetryableAIError(error) {
    if (error?.doNotRetry) return false;
    if (error?.code === 'MISSING_AI_API_KEY') return false;
    if (isPermanentRateLimitError(error)) return false;
    const status = getAIErrorStatus(error);
    const message = String(error?.message || '');
    return isRateLimitError(error)
        || [500, 502, 503, 504].includes(status)
        || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE', 'ECONNREFUSED'].includes(error?.code)
        || /timeout|Unexpected end of JSON|invalid json response body|unexpected end of file|Premature close|PREMATURE_CLOSE|Invalid response body/i
            .test(message);
}

let activeAIRequests = 0;
const aiRequestQueue = [];

function getAIConcurrencyState() {
    return {
        active: activeAIRequests,
        queued: aiRequestQueue.length,
        maxConcurrency: AI_MAX_CONCURRENCY
    };
}

function createAIRelease() {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        activeAIRequests = Math.max(0, activeAIRequests - 1);
        const next = aiRequestQueue.shift();
        if (next) next.start();
    };
}

function acquireAIConcurrencySlot(modelName, signal = null) {
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (activeAIRequests < AI_MAX_CONCURRENCY) {
        activeAIRequests += 1;
        return Promise.resolve(createAIRelease());
    }

    return new Promise((resolve, reject) => {
        const queuedAt = Date.now();
        let settled = false;
        const cleanup = () => {
            clearTimeout(entry.timeout);
            signal?.removeEventListener('abort', onAbort);
        };
        const removeFromQueue = () => {
            const index = aiRequestQueue.indexOf(entry);
            if (index >= 0) aiRequestQueue.splice(index, 1);
        };
        const onAbort = () => {
            if (settled) return;
            settled = true;
            removeFromQueue();
            cleanup();
            reject(createAbortError());
        };
        const entry = {
            start: () => {
                if (settled) return;
                settled = true;
                cleanup();
                activeAIRequests += 1;
                console.log(`   🟢 AI排队请求已启动: ${modelName || '默认模型'} (等待 ${Date.now() - queuedAt}ms)`);
                resolve(createAIRelease());
            },
            timeout: null
        };
        entry.timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            removeFromQueue();
            cleanup();
            const error = new Error(`AI请求排队超时（${Math.round(AI_QUEUE_TIMEOUT_MS / 1000)}秒）`);
            error.code = 'AI_QUEUE_TIMEOUT';
            error.status = 503;
            reject(error);
        }, AI_QUEUE_TIMEOUT_MS);
        signal?.addEventListener('abort', onAbort, { once: true });
        aiRequestQueue.push(entry);
        console.log(`   🟡 AI并发已满，请求排队: ${modelName || '默认模型'} (队列 ${aiRequestQueue.length})`);
    });
}

/**
 * 带并发保护和分类重试的 AI 调用。
 * 永久额度暂停不重试；短暂限流和 5xx 使用有界指数退避。
 */
async function callAIWithRetry(options, maxAttempts = AI_MAX_ATTEMPTS) {
    const attempts = readBoundedInteger(maxAttempts, AI_MAX_ATTEMPTS, 1, 8);
    const modelName = MODEL_MAP[options?.model] || options?.model || DEFAULT_MODEL_ALIAS;
    const signal = options?.signal || null;

    for (let attempt = 0; attempt < attempts; attempt++) {
        throwIfAborted(signal);
        const release = await acquireAIConcurrencySlot(modelName, signal);
        try {
            try {
                return await callAI(options);
            } catch (error) {
                const status = getAIErrorStatus(error);
                const permanentLimit = isPermanentRateLimitError(error);
                const retryable = isRetryableAIError(error);
                console.warn(`   ⚠️ AI调用失败 (尝试 ${attempt + 1}/${attempts}): [${status || error.code || '?'}] ${String(error.message || '').substring(0, 200)}`);

                if (permanentLimit) {
                    console.warn('   ⛔ 检测到已暂停或用尽的模型额度，停止无效重试');
                }
                if (!retryable || attempt >= attempts - 1) throw error;

                const rateLimited = isRateLimitError(error);
                const delay = rateLimited
                    ? Math.min(8000 * Math.pow(2, attempt), 32000)
                    : Math.min(3000 * Math.pow(2, attempt), 20000);
                const jitter = delay * (0.8 + Math.random() * 0.4);
                console.log(`   ⏳ ${rateLimited ? '限流' : '5xx/网络错误'}退避 ${(jitter / 1000).toFixed(1)} 秒后重试...`);
                release();
                await waitWithSignal(jitter, signal);
            }
        } finally {
            release();
        }
    }
}

module.exports = {
    createClient,
    callAI,
    callAIWithRetry,
    getAIErrorStatus,
    isPermanentRateLimitError,
    isRetryableAIError,
    getAIConcurrencyState,
    AI_REQUEST_TIMEOUT_MS,
    AI_MAX_CONCURRENCY,
    AI_MAX_ATTEMPTS,
    AI_MODULE_REQUEST_TIMEOUT_MS,
    AI_MODULE_MAX_ATTEMPTS,
    AI_STREAM_IDLE_TIMEOUT_MS,
    MODEL_MAP,
    // 新的四个火山引擎模型
    VOLCENGINE_V4_PRO_GA,
    VOLCENGINE_V4_FLASH_GA,
    VOLCENGINE_V4_PRO,
    VOLCENGINE_V4_FLASH,
    VOLCENGINE_BASE_URL,
    VOLCENGINE_CODING_BASE_URL,
    VOLCENGINE_MODELS,
    UNLIMITDS_V4_PRO_ALIAS,
    UNLIMITDS_V4_PRO_MODEL,
    UNLIMITDS_BASE_URL,
    UNLIMITDS_MODELS,
    resolveModelRoute,
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
    callCompanyGlmAI,
    __testing: {
        acquireAIConcurrencySlot,
        createStreamGuard,
        waitWithSignal
    }
};
