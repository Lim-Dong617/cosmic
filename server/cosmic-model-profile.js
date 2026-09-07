'use strict';

// Pure model classification. Keep provider routing in ai-client.js; this module
// must not load credentials or instantiate network clients.
const V4_MODELS = new Set([
    'deepseek-v4-pro-ga',
    'deepseek-v4-flash-ga',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-v4-flash-free',
    'deepseek-v4-flash:free',
    'deepseek/deepseek-v4-flash:free',
    'deepseek-v4-pro-ga-260813',
    'deepseek-v4-flash-ga-260731',
    'deepseek-v4-pro-260425',
    'deepseek-v4-flash-260425',
    'nvidia-deepseek-v4-pro',
    'deepseek-ai/deepseek-v4-pro-0813',
    'unlimitds-deepseek-v4-pro',
]);

const V32_MODELS = new Set([
    'siliconflow-deepseek-v3.2',
    // Historical UI alias now routes to SiliconFlow V3.2.
    'siliconflow-deepseek-v4-flash',
    'deepseek-ai/deepseek-v3.2',
    'deepseek-v3.2',
]);

function normalizeModelName(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function modelFamily(modelName, requestedModel = null) {
    // A resolved known model takes precedence over its old UI alias (for
    // example deepseek-v3.2 is historically mapped to a Volcengine V4 model).
    const resolved = normalizeModelName(modelName);
    if (V32_MODELS.has(resolved)) return 'v3.2';
    if (V4_MODELS.has(resolved)) return 'v4';
    // Custom deployment IDs may not contain a recognizable model name.
    const requested = normalizeModelName(requestedModel);
    if (V32_MODELS.has(requested)) return 'v3.2';
    if (V4_MODELS.has(requested)) return 'v4';
    return null;
}

function isV4CosmicModel(modelName, requestedModel = null) {
    return modelFamily(modelName, requestedModel) === 'v4';
}

function isV32CosmicModel(modelName, requestedModel = null) {
    return modelFamily(modelName, requestedModel) === 'v3.2';
}

module.exports = { isV4CosmicModel, isV32CosmicModel };
