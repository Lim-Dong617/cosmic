import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    MODEL_MAP,
    SENSENOVA_GLM_MODEL_NAME,
    SENSENOVA_FLASH_LITE_MODEL_NAME,
    SENSENOVA_MODELS
} = require('./server/ai-client');

assert.equal(MODEL_MAP['glm-5.2'], SENSENOVA_GLM_MODEL_NAME);
assert.equal(MODEL_MAP['sensenova-6.8-flash-lite'], SENSENOVA_FLASH_LITE_MODEL_NAME);
assert.ok(SENSENOVA_MODELS.has(SENSENOVA_GLM_MODEL_NAME));
assert.ok(SENSENOVA_MODELS.has(SENSENOVA_FLASH_LITE_MODEL_NAME));

if (!process.env.SENSENOVA_GLM_MODEL) {
    assert.equal(SENSENOVA_GLM_MODEL_NAME, 'glm-5.2');
}
if (!process.env.SENSENOVA_FLASH_LITE_MODEL) {
    assert.equal(SENSENOVA_FLASH_LITE_MODEL_NAME, 'sensenova-6.8-flash-lite');
}

console.log('SenseNova model routing tests passed');
