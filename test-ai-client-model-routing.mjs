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
    getVolcengineStandardBaseUrl,
    isCodingPlanUnavailableError,
    DEFAULT_MODEL_ALIAS
} = require('./server/ai-client');

// 四个主要模型映射正确
assert.equal(MODEL_MAP['deepseek-v4-pro-ga'], VOLCENGINE_V4_PRO_GA);
assert.equal(MODEL_MAP['deepseek-v4-flash-ga'], VOLCENGINE_V4_FLASH_GA);
assert.equal(MODEL_MAP['deepseek-v4-pro'], VOLCENGINE_V4_PRO);
assert.equal(MODEL_MAP['deepseek-v4-flash'], VOLCENGINE_V4_FLASH);

// VOLCENGINE_MODELS 包含所有四个模型
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_PRO_GA));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_FLASH_GA));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_PRO));
assert.ok(VOLCENGINE_MODELS.has(VOLCENGINE_V4_FLASH));

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

console.log('✅ 火山引擎模型路由测试通过');
