import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAsyncJobManager } = require('./server/async-job-manager');

function createHarness(processor, { startAt = 1_000, ttlMs = 1_000, ...managerOptions } = {}) {
    let currentTime = startAt;
    const scheduled = [];
    const manager = createAsyncJobManager({
        name: 'cosmic-split',
        processor,
        ttlMs,
        cleanupIntervalMs: 0,
        now: () => currentTime,
        schedule: callback => scheduled.push(callback),
        ...managerOptions
    });

    return {
        manager,
        scheduled,
        setTime(value) {
            currentTime = value;
        },
        advanceTime(delta) {
            currentTime += delta;
        },
        async runNext() {
            const callback = scheduled.shift();
            assert.equal(typeof callback, 'function', 'expected one scheduled job');
            await callback();
        }
    };
}

// 并发上限：后续任务保持 queued，前一任务结束后才会被调度。
{
    const releases = [];
    let running = 0;
    let peakRunning = 0;
    const harness = createHarness(async payload => {
        running += 1;
        peakRunning = Math.max(peakRunning, running);
        await new Promise(resolve => releases.push(resolve));
        running -= 1;
        return { value: payload.value };
    }, { maxConcurrent: 1, jobTimeoutMs: 0 });

    const first = harness.manager.submit({ value: 1 }, { requestKey: 'serial-1' });
    const second = harness.manager.submit({ value: 2 }, { requestKey: 'serial-2' });
    const firstCallback = harness.scheduled.shift();
    const firstPending = firstCallback();
    await Promise.resolve();
    assert.equal(harness.manager.get(first.job.id).status, 'running');

    const blockedCallback = harness.scheduled.shift();
    await blockedCallback();
    assert.equal(harness.manager.get(second.job.id).status, 'queued');

    releases.shift()();
    await firstPending;
    const secondCallback = harness.scheduled.shift();
    const secondPending = secondCallback();
    await Promise.resolve();
    releases.shift()();
    await secondPending;
    assert.equal(peakRunning, 1);
    assert.equal(harness.manager.get(second.job.id).status, 'completed');
    harness.manager.close();
}

// 取消排队任务：processor 不应被调用，快照明确显示 canceled。
{
    let processorCalls = 0;
    const harness = createHarness(async () => {
        processorCalls += 1;
        return { ok: true };
    });
    const submitted = harness.manager.submit({}, { requestKey: 'cancel-queued' });
    const canceled = harness.manager.cancel(submitted.job.id);
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.error.code, 'JOB_CANCELED');
    await harness.runNext();
    assert.equal(processorCalls, 0);
    harness.manager.close();
}

// 总时限：即使processor没有自行返回，任务也必须失败并释放worker。
{
    const manager = createAsyncJobManager({
        processor: async () => new Promise(() => {}),
        cleanupIntervalMs: 0,
        jobTimeoutMs: 15,
        maxConcurrent: 1
    });
    const submitted = manager.submit({}, { requestKey: 'timeout-job' });
    await new Promise(resolve => setTimeout(resolve, 100));
    const timedOut = manager.get(submitted.job.id);
    assert.equal(timedOut.status, 'failed');
    assert.equal(timedOut.error.code, 'JOB_TIMEOUT');
    assert.equal(timedOut.error.status, 504);
    manager.close();
}

// 运行中先取消：即使processor忽略signal，也应立即保持canceled，不能随后被timeout改写。
{
    const manager = createAsyncJobManager({
        processor: async () => new Promise(() => {}),
        cleanupIntervalMs: 0,
        jobTimeoutMs: 40,
        maxConcurrent: 1
    });
    const submitted = manager.submit({}, { requestKey: 'cancel-before-timeout' });
    await new Promise(resolve => setTimeout(resolve, 10));
    manager.cancel(submitted.job.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(manager.get(submitted.job.id).status, 'canceled');
    assert.equal(manager.get(submitted.job.id).error.code, 'JOB_CANCELED');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(manager.get(submitted.job.id).status, 'canceled');
    manager.close();
}

// 成功任务：queued -> running -> completed，并保留进度及完整结果。
{
    let processorCalls = 0;
    const harness = createHarness(async (payload, updateProgress) => {
        processorCalls += 1;
        assert.deepEqual(payload, { functions: ['查询告警'] });
        harness.setTime(1_200);
        updateProgress({ phase: 'splitting', current: 1, total: 1 });
        harness.setTime(1_500);
        return {
            tableData: [{ functionalProcess: '查询告警', dataMovementType: 'E' }],
            count: 1
        };
    });

    const submitted = harness.manager.submit(
        { functions: ['查询告警'] },
        { requestKey: ' success-key ' }
    );
    assert.equal(submitted.deduplicated, false);
    assert.equal(submitted.job.status, 'queued');
    assert.equal(submitted.job.requestKey, 'success-key');
    assert.equal(submitted.job.createdAt, 1_000);
    assert.equal('result' in submitted.job, false);
    assert.equal(harness.scheduled.length, 1);

    await harness.runNext();

    const completed = harness.manager.get(submitted.job.id);
    assert.equal(processorCalls, 1);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.startedAt, 1_000);
    assert.equal(completed.finishedAt, 1_500);
    assert.equal(completed.updatedAt, 1_500);
    assert.deepEqual(completed.progress, {
        phase: 'completed',
        message: '任务已完成',
        current: 1,
        total: 1
    });
    assert.deepEqual(completed.result, {
        tableData: [{ functionalProcess: '查询告警', dataMovementType: 'E' }],
        count: 1
    });
    assert.equal('error' in completed, false);
    harness.manager.close();
}

// requestKey 幂等：排队中及完成后重复提交都复用同一任务，processor 只执行一次。
{
    let processorCalls = 0;
    const harness = createHarness(async payload => {
        processorCalls += 1;
        return { echoed: payload.value };
    });

    const first = harness.manager.submit({ value: 7 }, { requestKey: 'idem-1' });
    const queuedDuplicate = harness.manager.submit({ value: 99 }, { requestKey: ' idem-1 ' });
    assert.equal(queuedDuplicate.deduplicated, true);
    assert.equal(queuedDuplicate.job.id, first.job.id);
    assert.equal(harness.scheduled.length, 1);

    await harness.runNext();
    const completedDuplicate = harness.manager.submit({ value: 123 }, { requestKey: 'idem-1' });
    assert.equal(completedDuplicate.deduplicated, true);
    assert.equal(completedDuplicate.job.id, first.job.id);
    assert.equal(completedDuplicate.job.status, 'completed');
    assert.deepEqual(completedDuplicate.job.result, { echoed: 7 });
    assert.equal(processorCalls, 1);
    assert.equal(harness.scheduled.length, 0);
    harness.manager.close();
}

// 失败任务：错误被规范化并以 failed 快照返回，不暴露 result。
{
    const harness = createHarness(async () => {
        const error = new Error('上游模型暂不可用');
        error.status = 502;
        error.code = 'MODEL_BAD_GATEWAY';
        throw error;
    });

    const submitted = harness.manager.submit({}, { requestKey: 'failure-key' });
    harness.setTime(2_000);
    await harness.runNext();

    const failed = harness.manager.get(submitted.job.id);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.error, {
        message: '上游模型暂不可用',
        status: 502,
        code: 'MODEL_BAD_GATEWAY'
    });
    assert.deepEqual(failed.progress, {
        phase: 'failed',
        message: '上游模型暂不可用'
    });
    assert.equal(failed.finishedAt, 2_000);
    assert.equal('result' in failed, false);
    harness.manager.close();
}

// TTL/404 语义：未知或已过期任务返回 null；过期同时释放 requestKey，可重新提交。
{
    const harness = createHarness(async payload => ({ generation: payload.generation }), {
        startAt: 10_000,
        ttlMs: 500
    });

    assert.equal(harness.manager.get('missing-job-id'), null);

    const first = harness.manager.submit({ generation: 1 }, { requestKey: 'ttl-key' });
    harness.setTime(10_100);
    await harness.runNext();
    assert.equal(harness.manager.get(first.job.id).status, 'completed');

    harness.setTime(10_599);
    assert.notEqual(harness.manager.get(first.job.id), null);
    harness.setTime(10_600);
    assert.equal(harness.manager.get(first.job.id), null);
    assert.equal(harness.manager.size, 0);

    const second = harness.manager.submit({ generation: 2 }, { requestKey: 'ttl-key' });
    assert.equal(second.deduplicated, false);
    assert.notEqual(second.job.id, first.job.id);
    await harness.runNext();
    assert.deepEqual(harness.manager.get(second.job.id).result, { generation: 2 });

    harness.advanceTime(500);
    harness.manager.cleanup();
    assert.equal(harness.manager.get(second.job.id), null);
    assert.equal(harness.manager.size, 0);
    harness.manager.close();
}

console.log('✅ 异步任务管理器测试通过');
