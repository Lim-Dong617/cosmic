import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    MODEL_MAP,
    VOLCENGINE_V4_PRO_GA,
    VOLCENGINE_V4_FLASH_GA,
    VOLCENGINE_V4_PRO,
    VOLCENGINE_V4_FLASH,
    VOLCENGINE_MODELS,
    UNLIMITDS_V4_PRO_ALIAS,
    UNLIMITDS_V4_PRO_MODEL,
    UNLIMITDS_BASE_URL,
    UNLIMITDS_MODELS,
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
assert.equal(UNLIMITDS_V4_PRO_ALIAS, 'unlimitds-deepseek-v4-pro');
assert.equal(UNLIMITDS_V4_PRO_MODEL, process.env.UNLIMITDS_V4_PRO_MODEL || 'deepseek-v4-pro');
assert.equal(UNLIMITDS_BASE_URL, process.env.UNLIMITDS_BASE_URL || 'https://unlimitds.chat/v1');

// 四个主要模型映射正确
assert.equal(MODEL_MAP['deepseek-v4-pro-ga'], VOLCENGINE_V4_PRO_GA);
assert.equal(MODEL_MAP['deepseek-v4-flash-ga'], VOLCENGINE_V4_FLASH_GA);
assert.equal(MODEL_MAP['deepseek-v4-pro'], VOLCENGINE_V4_PRO);
assert.equal(MODEL_MAP['deepseek-v4-flash'], VOLCENGINE_V4_FLASH);
assert.equal(MODEL_MAP[UNLIMITDS_V4_PRO_ALIAS], UNLIMITDS_V4_PRO_ALIAS);

// VOLCENGINE_MODELS 包含所有四个模型
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_PRO_GA));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_FLASH_GA));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_PRO));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_FLASH));
assert.ok(UNLIMITDS_MODELS.has(UNLIMITDS_V4_PRO_ALIAS));

// 同名模型必须通过独立内部别名路由，不能二次映射回火山引擎预览版。
const unlimitdsRoute = resolveModelRoute(UNLIMITDS_V4_PRO_ALIAS, 'uds_test_key');
assert.equal(unlimitdsRoute.provider, 'unlimitds');
assert.equal(unlimitdsRoute.modelName, UNLIMITDS_V4_PRO_ALIAS);
assert.equal(unlimitdsRoute.requestModelName, 'deepseek-v4-pro');
assert.equal(unlimitdsRoute.apiKey, 'uds_test_key');
assert.equal(unlimitdsRoute.baseUrl, UNLIMITDS_BASE_URL);
const overriddenUnlimitdsRoute = resolveModelRoute(
    UNLIMITDS_V4_PRO_ALIAS,
    'uds_override_key',
    'https://gateway.example/v1'
);
assert.equal(overriddenUnlimitdsRoute.apiKey, 'uds_override_key');
assert.equal(overriddenUnlimitdsRoute.baseUrl, 'https://gateway.example/v1');
assert.equal(resolveModelRoute('deepseek-v4-pro').modelName, VOLCENGINE_V4_PRO);

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
assert.equal(isRetryableAIError(pausedLimitError), false);
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
