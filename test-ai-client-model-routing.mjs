import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const {
    MODEL_MAP,
    VOLCENGINE_V4_PRO_GA,
    VOLCENGINE_V4_FLASH_GA,
    VOLCENGINE_V4_PRO,
    VOLCENGINE_V4_FLASH,
    VOLCENGINE_MODELS,
    NVIDIA_V4_PRO_ALIAS,
    LEGACY_UNLIMITDS_V4_PRO_ALIAS,
    NVIDIA_V4_PRO_MODEL,
    NVIDIA_BASE_URL,
    NVIDIA_MODELS,
    INTRANET_GLM_ALIAS,
    INTRANET_GLM_MODEL,
    INTRANET_GLM_FALLBACK_MODEL,
    INTRANET_GLM_BASE_URL,
    INTRANET_GLM_MODELS,
    callAI,
    resolveModelRoute,
    getVolcengineStandardBaseUrl,
    isCodingPlanUnavailableError,
    isPermanentRateLimitError,
    isRetryableAIError,
    getAIConcurrencyState,
    AI_REQUEST_TIMEOUT_MS,
    AI_MAX_CONCURRENCY,
    AI_MAX_ATTEMPTS,
    DEFAULT_MODEL_ALIAS
} = require('./server/ai-client');

// 官方模型 ID 必须包含 GA/日期后缀，否则 Ark 标准端点返回 404。
assert.equal(VOLCENGINE_V4_PRO_GA, process.env.VOLCENGINE_V4_PRO_GA_MODEL || 'deepseek-v4-pro-ga-260813');
assert.equal(VOLCENGINE_V4_FLASH_GA, process.env.VOLCENGINE_V4_FLASH_GA_MODEL || 'deepseek-v4-flash-ga-260731');
assert.equal(VOLCENGINE_V4_PRO, process.env.VOLCENGINE_V4_PRO_MODEL || 'deepseek-v4-pro-260425');
assert.equal(VOLCENGINE_V4_FLASH, process.env.VOLCENGINE_V4_FLASH_MODEL || 'deepseek-v4-flash-260425');
assert.equal(NVIDIA_V4_PRO_ALIAS, 'nvidia-deepseek-v4-pro');
assert.equal(LEGACY_UNLIMITDS_V4_PRO_ALIAS, 'unlimitds-deepseek-v4-pro');
assert.equal(NVIDIA_V4_PRO_MODEL, process.env.NVIDIA_V4_PRO_MODEL || 'deepseek-ai/deepseek-v4-pro-0813');
assert.equal(NVIDIA_BASE_URL, process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1');
assert.equal(INTRANET_GLM_ALIAS, 'intranet-glm');
assert.equal(INTRANET_GLM_MODEL, process.env.INTRANET_GLM_MODEL || 'glm-5.2');
assert.equal(INTRANET_GLM_FALLBACK_MODEL, process.env.INTRANET_GLM_FALLBACK_MODEL || 'glm-5.1');
assert.equal(INTRANET_GLM_BASE_URL, process.env.INTRANET_GLM_BASE_URL || 'http://10.110.63.81:13000');

// 四个主要模型映射正确
assert.equal(MODEL_MAP['deepseek-v4-pro-ga'], VOLCENGINE_V4_PRO_GA);
assert.equal(MODEL_MAP['deepseek-v4-flash-ga'], VOLCENGINE_V4_FLASH_GA);
assert.equal(MODEL_MAP['deepseek-v4-pro'], VOLCENGINE_V4_PRO);
assert.equal(MODEL_MAP['deepseek-v4-flash'], VOLCENGINE_V4_FLASH);
assert.equal(MODEL_MAP[NVIDIA_V4_PRO_ALIAS], NVIDIA_V4_PRO_ALIAS);
assert.equal(MODEL_MAP[LEGACY_UNLIMITDS_V4_PRO_ALIAS], NVIDIA_V4_PRO_ALIAS);

// VOLCENGINE_MODELS 包含所有四个模型
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_PRO_GA));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_FLASH_GA));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_PRO));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_FLASH));
assert.ok(NVIDIA_MODELS.has(NVIDIA_V4_PRO_ALIAS));
assert.ok(INTRANET_GLM_MODELS.has(INTRANET_GLM_ALIAS));

// 同名模型必须通过独立内部别名路由，不能二次映射回火山引擎预览版。
const nvidiaRoute = resolveModelRoute(NVIDIA_V4_PRO_ALIAS, 'nvidia_test_key');
assert.equal(nvidiaRoute.provider, 'nvidia');
assert.equal(nvidiaRoute.modelName, NVIDIA_V4_PRO_ALIAS);
assert.equal(nvidiaRoute.requestModelName, NVIDIA_V4_PRO_MODEL);
assert.equal(nvidiaRoute.apiKey, 'nvidia_test_key');
assert.equal(nvidiaRoute.baseUrl, NVIDIA_BASE_URL);
const legacyNvidiaRoute = resolveModelRoute(LEGACY_UNLIMITDS_V4_PRO_ALIAS, 'legacy_test_key');
assert.equal(legacyNvidiaRoute.provider, 'nvidia');
assert.equal(legacyNvidiaRoute.modelName, NVIDIA_V4_PRO_ALIAS);
const overriddenNvidiaRoute = resolveModelRoute(
    NVIDIA_V4_PRO_ALIAS,
    'nvidia_override_key',
    'https://gateway.example/v1'
);
assert.equal(overriddenNvidiaRoute.apiKey, 'nvidia_override_key');
assert.equal(overriddenNvidiaRoute.baseUrl, 'https://gateway.example/v1');
assert.equal(resolveModelRoute('deepseek-v4-pro').modelName, VOLCENGINE_V4_PRO);
const intranetRoute = resolveModelRoute(INTRANET_GLM_ALIAS, 'intranet_test_key');
assert.equal(intranetRoute.provider, 'intranet-glm');
assert.equal(intranetRoute.modelName, INTRANET_GLM_ALIAS);
assert.equal(intranetRoute.requestModelName, INTRANET_GLM_MODEL);
assert.equal(intranetRoute.apiKey, 'intranet_test_key');
assert.equal(intranetRoute.baseUrl, INTRANET_GLM_BASE_URL);

// NVIDIA 分支必须请求 OpenAI Chat Completions、强制流式，并锁定非思考模式。
const originalFetch = globalThis.fetch;
try {
    let nvidiaRequestedPath = '';
    let nvidiaRequestBody = null;
    const nvidiaServer = createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            nvidiaRequestedPath = req.url;
            nvidiaRequestBody = JSON.parse(body);
            const streamBody = [
                'data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"deepseek-ai/deepseek-v4-pro-0813","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
                'data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"deepseek-ai/deepseek-v4-pro-0813","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
                'data: [DONE]'
            ].join('\n\n');
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                Connection: 'close'
            });
            res.end(`${streamBody}\n\n`);
        });
    });
    await new Promise((resolve, reject) => {
        nvidiaServer.once('error', reject);
        nvidiaServer.listen(0, '127.0.0.1', resolve);
    });
    try {
        const { port } = nvidiaServer.address();
        const nvidiaCompletion = await callAI({
            model: NVIDIA_V4_PRO_ALIAS,
            apiKey: 'nvidia_test_key',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 20000
        });
        assert.equal(nvidiaRequestedPath, '/v1/chat/completions');
        assert.equal(nvidiaRequestBody.model, NVIDIA_V4_PRO_MODEL);
        assert.equal(nvidiaRequestBody.max_tokens, 16384);
        assert.equal(nvidiaRequestBody.stream, true);
        assert.deepEqual(nvidiaRequestBody.chat_template_kwargs, { thinking: false });
        assert.equal(nvidiaCompletion.choices[0].message.content, 'OK');
    } finally {
        await new Promise((resolve, reject) => nvidiaServer.close(error => error ? reject(error) : resolve()));
    }

    // 内网分支必须请求内网 /v1/messages，并使用内网错误标签。
    let requestedUrl = '';
    globalThis.fetch = async url => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({
            content: [{ type: 'text', text: 'OK' }],
            model: INTRANET_GLM_MODEL,
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const intranetCompletion = await callAI({
        model: INTRANET_GLM_ALIAS,
        apiKey: 'intranet_test_key',
        baseUrl: 'http://intranet.example:13000',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8
    });
    assert.equal(requestedUrl, 'http://intranet.example:13000/v1/messages');
    assert.equal(intranetCompletion.choices[0].message.content, 'OK');

    const requestedModels = [];
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        requestedModels.push(body.model);
        if (body.model === INTRANET_GLM_MODEL) {
            return new Response(JSON.stringify({
                error: { message: '[1313] 当前使用模式不符合公平使用策略，请求频率已受到限制' }
            }), { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
            content: [{ type: 'text', text: 'FALLBACK_OK' }],
            model: INTRANET_GLM_FALLBACK_MODEL,
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const fallbackCompletion = await callAI({
        model: INTRANET_GLM_ALIAS,
        apiKey: 'intranet_test_key',
        baseUrl: 'http://intranet.example:13000',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8
    });
    assert.deepEqual(requestedModels, [INTRANET_GLM_MODEL, INTRANET_GLM_FALLBACK_MODEL]);
    assert.equal(fallbackCompletion.choices[0].message.content, 'FALLBACK_OK');

    globalThis.fetch = async () => new Response(JSON.stringify({
        error: { message: '[1113] 余额不足或无可用资源包，请充值' }
    }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(
        callAI({
            model: INTRANET_GLM_ALIAS,
            apiKey: 'intranet_test_key',
            baseUrl: 'http://intranet.example:13000',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 8
        }),
        error => /主模型 .* 不可用，已自动切换 .*，但备用模型也调用失败/.test(error.message)
            && /内网 GLM API错误 \[429\]/.test(error.message)
            && !isRetryableAIError(error)
    );
} finally {
    globalThis.fetch = originalFetch;
}

// 兼容旧入口
assert.equal(MODEL_MAP['deepseek-v4-flash-free'], VOLCENGINE_V4_FLASH_GA);
assert.equal(MODEL_MAP['deepseek-r1'], VOLCENGINE_V4_PRO_GA);
assert.equal(MODEL_MAP['gpt-5.1-codex-mini'], VOLCENGINE_V4_PRO_GA);
assert.equal(MODEL_MAP['glm-5.2'], VOLCENGINE_V4_FLASH_GA);

// 默认模型
assert.equal(DEFAULT_MODEL_ALIAS, 'deepseek-v4-pro-ga');

// Volcengine URL 转换
if (!process.env.VOLCENGINE_STANDARD_BASE_URL) {
    assert.equal(
        getVolcengineStandardBaseUrl('https://ark.cn-beijing.volces.com/api/coding'),
        'https://ark.cn-beijing.volces.com/api/v3'
    );
}

// CodingPlan 错误检测
assert.equal(isCodingPlanUnavailableError({
    status: 400,
    message: 'Your account does not have a valid CodingPlan subscription'
}), true);
assert.equal(isCodingPlanUnavailableError({ status: 429, message: 'rate limit' }), false);

// 已暂停/额度用尽是永久限制，不应连续等待重试。
const pausedLimitError = {
    status: 429,
    code: 'SetLimitExceeded',
    message: 'model service has been paused by Safe Experience Mode inference limit'
};
assert.equal(isPermanentRateLimitError(pausedLimitError), true);
assert.equal(isPermanentRateLimitError({ status: 429, message: '周期额度已用完' }), true);
assert.equal(isPermanentRateLimitError({ status: 429, message: 'monthly usage limit reached' }), true);
assert.equal(isPermanentRateLimitError({ status: 429, message: '[1313] 当前使用模式不符合公平使用策略，请求频率已受到限制' }), true);
assert.equal(isPermanentRateLimitError({ status: 429, message: '[1113] 余额不足或无可用资源包，请充值' }), true);
assert.equal(isRetryableAIError(pausedLimitError), false);
assert.equal(isRetryableAIError({ status: 429, message: '[1113] 余额不足或无可用资源包，请充值' }), false);
assert.equal(isRetryableAIError({ status: 429, message: 'temporary rate limit' }), true);
assert.equal(isRetryableAIError({ status: 502, message: 'Bad Gateway' }), true);
assert.equal(isRetryableAIError({ status: 404, message: 'model not found' }), false);
assert.equal(isRetryableAIError({ status: 503, code: 'MISSING_AI_API_KEY', message: 'missing key' }), false);
assert.equal(isRetryableAIError({ code: 'ETIMEDOUT', message: 'request timed out' }), true);

assert.ok(AI_REQUEST_TIMEOUT_MS >= 30000);
assert.ok(AI_MAX_CONCURRENCY >= 1 && AI_MAX_CONCURRENCY <= 8);
assert.ok(AI_MAX_ATTEMPTS >= 1 && AI_MAX_ATTEMPTS <= 8);
assert.deepEqual(getAIConcurrencyState(), {
    active: 0,
    queued: 0,
    maxConcurrency: AI_MAX_CONCURRENCY
});

console.log('✅ AI 多提供商模型路由测试通过');
