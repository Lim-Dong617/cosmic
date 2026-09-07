import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isV4CosmicModel, isV32CosmicModel } = require('./server/cosmic-model-profile.js');

for (const model of [
  'siliconflow-deepseek-v3.2',
  'siliconflow-deepseek-v4-flash',
  'deepseek-ai/DeepSeek-V3.2',
]) {
  assert.equal(isV4CosmicModel(model), false, `${model} must not inherit V4 behavior`);
  assert.equal(isV32CosmicModel(model), true);
}

for (const model of [
  'deepseek-v4-pro-ga',
  'deepseek-v4-flash-ga',
  'deepseek-v4-pro-ga-260813',
  'deepseek-v4-flash-ga-260731',
  'deepseek-v4-pro-260425',
  'deepseek-v4-flash-260425',
  'nvidia-deepseek-v4-pro',
  'deepseek-ai/deepseek-v4-pro-0813',
  'unlimitds-deepseek-v4-pro',
]) {
  assert.equal(isV4CosmicModel(model), true, `${model} retains V4 classification`);
  assert.equal(isV32CosmicModel(model), false);
}

// Resolved models win over an obsolete alias; provider aliases also allow
// private deployment IDs without reading any environment or credentials.
assert.equal(isV4CosmicModel('deepseek-v4-flash-ga-260731', 'deepseek-v3.2'), true);
assert.equal(isV32CosmicModel('deepseek-v4-flash-ga-260731', 'deepseek-v3.2'), false);
assert.equal(isV32CosmicModel('ep-private-model', 'siliconflow-deepseek-v3.2'), true);
assert.equal(isV4CosmicModel('ep-private-model', 'deepseek-v4-pro'), true);
assert.equal(isV4CosmicModel(' DEEPSEEK-V4-PRO '), true);
for (const model of ['intranet-glm', 'glm-5.2', 'unknown', null, undefined, 32]) {
  assert.equal(isV4CosmicModel(model), false);
  assert.equal(isV32CosmicModel(model), false);
}

console.log('cosmic model profile tests passed');
