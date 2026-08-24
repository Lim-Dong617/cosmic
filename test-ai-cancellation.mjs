import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    AI_MAX_CONCURRENCY,
    getAIConcurrencyState,
    __testing
} = require('./server/ai-client');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 流中途不再产生分片时，空闲看门狗必须中止，并转换为可重试的 504。
{
    const guard = __testing.createStreamGuard(null, 500, 25);
    await delay(60);
    assert.equal(guard.signal.aborted, true);
    const error = guard.normalizeError(new Error('stream aborted'));
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.status, 504);
    assert.match(error.message, /无数据/);
    guard.cleanup();
}

// 外部取消要保持 AbortError 语义，不能被当成超时重试。
{
    const controller = new AbortController();
    const guard = __testing.createStreamGuard(controller.signal, 500, 250);
    controller.abort();
    await delay(0);
    const error = guard.normalizeError(new Error('aborted'));
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ABORT_ERR');
    guard.cleanup();
}

// 排队中的请求取消后必须从队列移除；所有 release 后 active/queued 均归零。
{
    const releases = [];
    for (let index = 0; index < AI_MAX_CONCURRENCY; index++) {
        releases.push(await __testing.acquireAIConcurrencySlot(`holder-${index}`));
    }
    assert.equal(getAIConcurrencyState().active, AI_MAX_CONCURRENCY);

    const controller = new AbortController();
    const queuedResult = __testing.acquireAIConcurrencySlot('queued', controller.signal)
        .then(() => null, error => error);
    assert.equal(getAIConcurrencyState().queued, 1);
    controller.abort();
    const queueError = await queuedResult;
    assert.equal(queueError.name, 'AbortError');
    assert.equal(getAIConcurrencyState().queued, 0);

    releases.forEach(release => release());
    assert.deepEqual(getAIConcurrencyState(), {
        active: 0,
        queued: 0,
        maxConcurrency: AI_MAX_CONCURRENCY
    });
}

// 退避等待也必须可立即取消。
{
    const controller = new AbortController();
    const waiting = __testing.waitWithSignal(5000, controller.signal)
        .then(() => null, error => error);
    controller.abort();
    const error = await waiting;
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ABORT_ERR');
}

console.log('✅ AI流看门狗与取消释放测试通过');
