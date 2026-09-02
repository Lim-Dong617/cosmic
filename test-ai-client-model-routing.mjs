import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
    MODEL_MAP,
    VOLCENGINE_V4_PRO_GA,
    VOLCENGINE_V4_FLASH_GA,
    VOLCENGINE_V4_PRO,
    VOLCENGINE_V4_FLASH,
    VOLCENGINE_MODELS,
    NVIDIA_V4_PRO_ALIAS,
    NVIDIA_V4_PRO_MODEL,
    NVIDIA_BASE_URL,
    NVIDIA_MODELS,
    UNLIMITDS_V4_PRO_ALIAS,
    UNLIMITDS_V4_PRO_MODEL,
    UNLIMITDS_BASE_URL,
    UNLIMITDS_MODELS,
    SILICONFLOW_MODEL_ALIAS,
    SILICONFLOW_MODEL,
    SILICONFLOW_BASE_URL,
    SILICONFLOW_MODELS,
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
assert.equal(NVIDIA_V4_PRO_MODEL, process.env.NVIDIA_V4_PRO_MODEL || 'deepseek-ai/deepseek-v4-pro-0813');
assert.equal(NVIDIA_BASE_URL, process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1');
assert.equal(UNLIMITDS_V4_PRO_ALIAS, 'unlimitds-deepseek-v4-pro');
assert.equal(UNLIMITDS_V4_PRO_MODEL, process.env.UNLIMITDS_V4_PRO_MODEL || 'deepseek-v4-pro');
assert.equal(UNLIMITDS_BASE_URL, process.env.UNLIMITDS_BASE_URL || 'https://unlimitds.chat/v1');
assert.equal(SILICONFLOW_MODEL_ALIAS, 'siliconflow-deepseek-v3.2');
assert.equal(SILICONFLOW_MODEL, process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V3.2');
assert.equal(SILICONFLOW_BASE_URL, process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1');
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
assert.equal(MODEL_MAP[UNLIMITDS_V4_PRO_ALIAS], UNLIMITDS_V4_PRO_ALIAS);
assert.equal(MODEL_MAP[SILICONFLOW_MODEL_ALIAS], SILICONFLOW_MODEL_ALIAS);
assert.equal(MODEL_MAP['siliconflow-deepseek-v4-flash'], SILICONFLOW_MODEL_ALIAS);

// VOLCENGINE_MODELS 包含所有四个模型
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_PRO_GA));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_FLASH_GA));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_PRO));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_FLASH));
assert.ok(NVIDIA_MODELS.has(NVIDIA_V4_PRO_ALIAS));
assert.deepEqual([...UNLIMITDS_MODELS], [UNLIMITDS_V4_PRO_ALIAS]);
assert.deepEqual([...SILICONFLOW_MODELS], [SILICONFLOW_MODEL_ALIAS]);
assert.equal(NVIDIA_MODELS.has(UNLIMITDS_V4_PRO_ALIAS), false);
assert.equal(VOLCENGINE_MODELS.has(UNLIMITDS_V4_PRO_ALIAS), false);
assert.equal(UNLIMITDS_MODELS.has(NVIDIA_V4_PRO_ALIAS), false);
assert.equal(VOLCENGINE_MODELS.has(SILICONFLOW_MODEL_ALIAS), false);
assert.equal(SILICONFLOW_MODELS.has(UNLIMITDS_V4_PRO_ALIAS), false);
assert.ok(INTRANET_GLM_MODELS.has(INTRANET_GLM_ALIAS));

// 同名模型必须通过独立内部别名路由，不能二次映射回火山引擎预览版。
const nvidiaRoute = resolveModelRoute(NVIDIA_V4_PRO_ALIAS, 'nvidia_test_key');
assert.equal(nvidiaRoute.provider, 'nvidia');
assert.equal(nvidiaRoute.modelName, NVIDIA_V4_PRO_ALIAS);
assert.equal(nvidiaRoute.requestModelName, NVIDIA_V4_PRO_MODEL);
assert.equal(nvidiaRoute.apiKey, 'nvidia_test_key');
assert.equal(nvidiaRoute.baseUrl, NVIDIA_BASE_URL);
const overriddenNvidiaRoute = resolveModelRoute(
    NVIDIA_V4_PRO_ALIAS,
    'nvidia_override_key',
    'https://gateway.example/v1'
);
assert.equal(overriddenNvidiaRoute.apiKey, 'nvidia_override_key');
assert.equal(overriddenNvidiaRoute.baseUrl, 'https://gateway.example/v1');
const unlimitdsRoute = resolveModelRoute(UNLIMITDS_V4_PRO_ALIAS, 'uds_unlimitds_test_key');
assert.equal(unlimitdsRoute.provider, 'unlimitds');
assert.equal(unlimitdsRoute.modelName, UNLIMITDS_V4_PRO_ALIAS);
assert.equal(unlimitdsRoute.requestModelName, UNLIMITDS_V4_PRO_MODEL);
assert.equal(unlimitdsRoute.apiKey, 'uds_unlimitds_test_key');
assert.equal(unlimitdsRoute.baseUrl, UNLIMITDS_BASE_URL);
const overriddenUnlimitdsRoute = resolveModelRoute(
    UNLIMITDS_V4_PRO_ALIAS,
    'uds_unlimitds_override_key',
    'https://unlimitds-gateway.example/v1'
);
assert.equal(overriddenUnlimitdsRoute.provider, 'unlimitds');
assert.equal(overriddenUnlimitdsRoute.apiKey, 'uds_unlimitds_override_key');
assert.equal(overriddenUnlimitdsRoute.baseUrl, 'https://unlimitds-gateway.example/v1');
assert.deepEqual(
    resolveModelRoute(unlimitdsRoute.modelName, unlimitdsRoute.apiKey, unlimitdsRoute.baseUrl),
    unlimitdsRoute
);
const siliconflowRoute = resolveModelRoute(SILICONFLOW_MODEL_ALIAS, 'siliconflow_test_key');
assert.equal(siliconflowRoute.provider, 'siliconflow');
assert.equal(siliconflowRoute.modelName, SILICONFLOW_MODEL_ALIAS);
assert.equal(siliconflowRoute.requestModelName, SILICONFLOW_MODEL);
assert.equal(siliconflowRoute.apiKey, 'siliconflow_test_key');
assert.equal(siliconflowRoute.baseUrl, SILICONFLOW_BASE_URL);
assert.deepEqual(
    resolveModelRoute(siliconflowRoute.modelName, siliconflowRoute.apiKey, siliconflowRoute.baseUrl),
    siliconflowRoute
);
const legacySiliconflowRoute = resolveModelRoute('siliconflow-deepseek-v4-flash', 'legacy_siliconflow_test_key');
assert.equal(legacySiliconflowRoute.provider, 'siliconflow');
assert.equal(legacySiliconflowRoute.modelName, SILICONFLOW_MODEL_ALIAS);
assert.equal(legacySiliconflowRoute.requestModelName, SILICONFLOW_MODEL);
assert.equal(legacySiliconflowRoute.apiKey, 'legacy_siliconflow_test_key');
assert.equal(resolveModelRoute('deepseek-v4-pro').modelName, VOLCENGINE_V4_PRO);
const intranetRoute = resolveModelRoute(INTRANET_GLM_ALIAS, 'intranet_test_key');
assert.equal(intranetRoute.provider, 'intranet-glm');
assert.equal(intranetRoute.modelName, INTRANET_GLM_ALIAS);
assert.equal(intranetRoute.requestModelName, INTRANET_GLM_MODEL);
assert.equal(intranetRoute.apiKey, 'intranet_test_key');
assert.equal(intranetRoute.baseUrl, INTRANET_GLM_BASE_URL);

// 独立子进程只注入假密钥，不继承真实密钥或读取 .env，并禁止网络请求。
const aiClientModulePath = require.resolve('./server/ai-client');
function checkIsolatedUnlimitdsConfig(source, extraEnv = {}) {
    const result = spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        for (const transport of ['node:http', 'node:https']) {
            require(transport).request = () => { throw new Error('Unexpected network request in configuration test'); };
        }
        globalThis.fetch = async () => { throw new Error('Unexpected fetch in configuration test'); };
        const ai = require(process.argv[1]);
        (async () => { ${source} })().catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
    `, aiClientModulePath], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            VOLCENGINE_API_KEY: 'volcengine_env_test_key',
            VOLCENGINE_BASE_URL: 'http://127.0.0.1:9/volcengine/v1',
            NVIDIA_API_KEY: 'nvidia_env_test_key',
            NVIDIA_BASE_URL: 'http://127.0.0.1:9/nvidia/v1',
            ...extraEnv
        }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
}

checkIsolatedUnlimitdsConfig(`
    const route = ai.resolveModelRoute(ai.UNLIMITDS_V4_PRO_ALIAS);
    assert.equal(route.provider, 'unlimitds');
    assert.equal(route.apiKey, null);
    assert.equal(route.baseUrl, 'https://unlimitds.chat/v1');
    assert.equal(route.requestModelName, 'deepseek-v4-pro');
    await assert.rejects(ai.callAI({
        model: ai.UNLIMITDS_V4_PRO_ALIAS,
        messages: [{ role: 'user', content: 'ping' }],
        requestTimeoutMs: 1000
    }), error => error.code === 'MISSING_AI_API_KEY'
        && error.status === 503
        && /UNLIMITDS_API_KEY/.test(error.message)
        && !ai.isRetryableAIError(error));
`);

checkIsolatedUnlimitdsConfig(`
    const route = ai.resolveModelRoute(ai.SILICONFLOW_MODEL_ALIAS);
    assert.equal(route.provider, 'siliconflow');
    assert.equal(route.apiKey, null);
    assert.equal(route.baseUrl, 'https://api.siliconflow.cn/v1');
    assert.equal(route.requestModelName, 'deepseek-ai/DeepSeek-V3.2');
    await assert.rejects(ai.callAI({
        model: ai.SILICONFLOW_MODEL_ALIAS,
        messages: [{ role: 'user', content: 'ping' }],
        requestTimeoutMs: 1000
    }), error => error.code === 'MISSING_AI_API_KEY'
        && error.status === 503
        && /SILICONFLOW_API_KEY/.test(error.message)
        && !ai.isRetryableAIError(error));
`);

// 线上可能残留旧 V4 变量，但新通道必须忽略它并继续使用 V3.2。
checkIsolatedUnlimitdsConfig(`
    assert.equal(ai.SILICONFLOW_MODEL, 'deepseek-ai/DeepSeek-V3.2');
    const route = ai.resolveModelRoute('siliconflow-deepseek-v4-flash');
    assert.equal(route.provider, 'siliconflow');
    assert.equal(route.modelName, ai.SILICONFLOW_MODEL_ALIAS);
    assert.equal(route.requestModelName, 'deepseek-ai/DeepSeek-V3.2');
`, {
    SILICONFLOW_V4_FLASH_MODEL: 'deepseek-ai/DeepSeek-V4-Flash'
});

checkIsolatedUnlimitdsConfig(`
    assert.equal(ai.UNLIMITDS_V4_PRO_MODEL, 'unlimitds-custom-model');
    assert.equal(ai.UNLIMITDS_BASE_URL, 'http://127.0.0.1:9/unlimitds/v1');
    assert.deepEqual(ai.resolveModelRoute(ai.UNLIMITDS_V4_PRO_ALIAS), {
        provider: 'unlimitds',
        modelName: ai.UNLIMITDS_V4_PRO_ALIAS,
        requestModelName: 'unlimitds-custom-model',
        apiKey: 'uds_unlimitds_env_test_key',
        baseUrl: 'http://127.0.0.1:9/unlimitds/v1'
    });
    assert.equal(ai.resolveModelRoute(ai.NVIDIA_V4_PRO_ALIAS).apiKey, 'nvidia_env_test_key');
    assert.equal(ai.resolveModelRoute(ai.NVIDIA_V4_PRO_ALIAS).baseUrl, 'http://127.0.0.1:9/nvidia/v1');
    assert.equal(ai.resolveModelRoute('deepseek-v4-pro').apiKey, 'volcengine_env_test_key');
    assert.equal(ai.resolveModelRoute('deepseek-v4-pro').baseUrl, 'http://127.0.0.1:9/volcengine/v1');
    assert.equal(ai.SILICONFLOW_MODEL, 'siliconflow-custom-model');
    assert.equal(ai.SILICONFLOW_BASE_URL, 'http://127.0.0.1:9/siliconflow/v1');
    assert.deepEqual(ai.resolveModelRoute(ai.SILICONFLOW_MODEL_ALIAS), {
        provider: 'siliconflow',
        modelName: ai.SILICONFLOW_MODEL_ALIAS,
        requestModelName: 'siliconflow-custom-model',
        apiKey: 'siliconflow_env_test_key',
        baseUrl: 'http://127.0.0.1:9/siliconflow/v1'
    });
`, {
    UNLIMITDS_API_KEY: 'uds_unlimitds_env_test_key',
    UNLIMITDS_BASE_URL: 'http://127.0.0.1:9/unlimitds/v1',
    UNLIMITDS_V4_PRO_MODEL: 'unlimitds-custom-model',
    SILICONFLOW_API_KEY: 'siliconflow_env_test_key',
    SILICONFLOW_BASE_URL: 'http://127.0.0.1:9/siliconflow/v1',
    SILICONFLOW_MODEL: 'siliconflow-custom-model'
});

// NVIDIA 分支必须请求 OpenAI Chat Completions、强制流式，并锁定非思考模式。
const originalFetch = globalThis.fetch;
try {
    let nvidiaRequestedPath = '';
    let nvidiaAuthorization = '';
    let nvidiaRequestBody = null;
    const nvidiaServer = createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            nvidiaRequestedPath = req.url;
            nvidiaAuthorization = req.headers.authorization;
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
        assert.equal(nvidiaAuthorization, 'Bearer nvidia_test_key');
        assert.equal(nvidiaRequestBody.model, NVIDIA_V4_PRO_MODEL);
        assert.equal(nvidiaRequestBody.max_tokens, 16384);
        assert.equal(nvidiaRequestBody.stream, true);
        assert.deepEqual(nvidiaRequestBody.chat_template_kwargs, { thinking: false });
        assert.equal(nvidiaCompletion.choices[0].message.content, 'OK');
    } finally {
        await new Promise((resolve, reject) => nvidiaServer.close(error => error ? reject(error) : resolve()));
    }

    // 第五路 UnlimitDS 独立鉴权、强制 SSE；不得沿用 NVIDIA 的参数或合并思考链。
    const unlimitdsRequests = [];
    const unlimitdsServer = createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            unlimitdsRequests.push({
                method: req.method,
                path: req.url,
                authorization: req.headers.authorization,
                body: JSON.parse(body)
            });
            const chunks = [
                { role: 'assistant', reasoning_content: 'PRIVATE_REASONING_ONLY' },
                { content: 'UNLIMIT', reasoning_content: 'MORE_PRIVATE_REASONING' },
                { content: 'DS_OK' },
                {}
            ].map((delta, index) => `data: ${JSON.stringify({
                id: 'unlimitds-test',
                object: 'chat.completion.chunk',
                created: 1,
                model: UNLIMITDS_V4_PRO_MODEL,
                choices: [{ index: 0, delta, finish_reason: index === 3 ? 'stop' : null }]
            })}`);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
            res.end(`${[...chunks, 'data: [DONE]'].join('\n\n')}\n\n`);
        });
    });
    await new Promise((resolve, reject) => {
        unlimitdsServer.once('error', reject);
        unlimitdsServer.listen(0, '127.0.0.1', resolve);
    });
    try {
        const { port } = unlimitdsServer.address();
        const unlimitdsOptions = {
            model: UNLIMITDS_V4_PRO_ALIAS,
            apiKey: 'uds_unlimitds_test_key',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 20000,
            requestTimeoutMs: 5000
        };
        const unlimitdsCompletion = await callAI(unlimitdsOptions);
        assert.equal(unlimitdsCompletion.model, UNLIMITDS_V4_PRO_MODEL);
        assert.deepEqual(unlimitdsCompletion.choices, [{
            message: { role: 'assistant', content: 'UNLIMITDS_OK' },
            finish_reason: 'stop'
        }]);

        const forwardedChunks = [];
        const streamedCompletion = await callAI({
            ...unlimitdsOptions,
            stream: true,
            res: { write: chunk => forwardedChunks.push(chunk) }
        });
        assert.equal(streamedCompletion, null);
        assert.deepEqual(forwardedChunks.map(chunk => JSON.parse(chunk.slice('data: '.length))), [
            { content: 'UNLIMIT' },
            { content: 'DS_OK' }
        ]);
        assert.equal(unlimitdsRequests.length, 2);
        for (const request of unlimitdsRequests) {
            assert.equal(request.method, 'POST');
            assert.equal(request.path, '/v1/chat/completions');
            assert.equal(request.authorization, 'Bearer uds_unlimitds_test_key');
            assert.equal(request.body.model, UNLIMITDS_V4_PRO_MODEL);
            assert.equal(request.body.stream, true);
            assert.equal(request.body.max_tokens, 20000);
            assert.equal(Object.hasOwn(request.body, 'chat_template_kwargs'), false);
            assert.deepEqual(request.body.messages, unlimitdsOptions.messages);
        }
    } finally {
        await new Promise((resolve, reject) => unlimitdsServer.close(error => error ? reject(error) : resolve()));
    }

    // 硅基流动使用独立鉴权，并按标准 OpenAI Chat Completions 非流式调用。
    let siliconflowRequest = null;
    const siliconflowServer = createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            siliconflowRequest = {
                method: req.method,
                path: req.url,
                authorization: req.headers.authorization,
                body: JSON.parse(body)
            };
            res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
            res.end(JSON.stringify({
                id: 'siliconflow-test',
                object: 'chat.completion',
                created: 1,
                model: SILICONFLOW_MODEL,
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: 'SILICONFLOW_OK' },
                    finish_reason: 'stop'
                }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            }));
        });
    });
    await new Promise((resolve, reject) => {
        siliconflowServer.once('error', reject);
        siliconflowServer.listen(0, '127.0.0.1', resolve);
    });
    try {
        const { port } = siliconflowServer.address();
        const messages = [{ role: 'user', content: 'ping' }];
        const siliconflowCompletion = await callAI({
            model: SILICONFLOW_MODEL_ALIAS,
            apiKey: 'siliconflow_test_key',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            messages,
            max_tokens: 1234,
            requestTimeoutMs: 5000
        });
        assert.equal(siliconflowRequest.method, 'POST');
        assert.equal(siliconflowRequest.path, '/v1/chat/completions');
        assert.equal(siliconflowRequest.authorization, 'Bearer siliconflow_test_key');
        assert.equal(siliconflowRequest.body.model, SILICONFLOW_MODEL);
        assert.equal(siliconflowRequest.body.stream, false);
        assert.equal(siliconflowRequest.body.max_tokens, 1234);
        assert.deepEqual(siliconflowRequest.body.messages, messages);
        assert.equal(Object.hasOwn(siliconflowRequest.body, 'chat_template_kwargs'), false);
        assert.equal(siliconflowCompletion.choices[0].message.content, 'SILICONFLOW_OK');
    } finally {
        await new Promise((resolve, reject) => siliconflowServer.close(error => error ? reject(error) : resolve()));
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
assert.equal(MODEL_MAP['deepseek-v3.2'], VOLCENGINE_V4_FLASH_GA);

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
