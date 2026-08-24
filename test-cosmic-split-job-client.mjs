import assert from 'node:assert/strict';
import {
    resolveContinueAnalysisRound,
    runContinueAnalysisJob,
    runCosmicModuleRecognitionJob,
    runCosmicSplitJob,
    runDocumentUnderstandingJob,
    runFunctionExtractionJob
} from './client/src/cosmic-split-jobs.js';

const response = (data, status = 200) => ({ status, data });

const httpError = (status, code, message = `HTTP ${status}`, transportCode = null) => {
    const error = new Error(message);
    error.status = status;
    error.response = {
        status,
        data: { error: message, code }
    };
    if (transportCode) error.code = transportCode;
    return error;
};

const transportError = (code, message = code) => {
    const error = new Error(message);
    error.code = code;
    return error;
};

const createScriptedClient = ({ posts = [], gets = [], deletes = [] } = {}) => {
    const calls = { post: [], get: [], delete: [] };
    let postIndex = 0;
    let getIndex = 0;
    let deleteIndex = 0;

    const runStep = async (steps, index, args, method) => {
        assert.ok(index < steps.length, `${method} received an unexpected call`);
        const step = steps[index];
        if (typeof step === 'function') return step(...args);
        if (step instanceof Error) throw step;
        return step;
    };

    return {
        calls,
        async post(...args) {
            calls.post.push(args);
            return runStep(posts, postIndex++, args, 'POST');
        },
        async get(...args) {
            calls.get.push(args);
            return runStep(gets, getIndex++, args, 'GET');
        },
        async delete(...args) {
            calls.delete.push(args);
            return runStep(deletes, deleteIndex++, args, 'DELETE');
        }
    };
};

const completedJob = (result) => response({
    job: { status: 'completed', result }
});

const fastPolling = {
    initialPollMs: 0,
    maxPollMs: 0,
    maxWaitMs: 30_000
};

async function testNormalLifecycle() {
    const statuses = [];
    const result = { tableData: [{ functionalProcess: '查询工单' }] };
    const client = createScriptedClient({
        posts: [response({ jobId: 'job-normal', status: 'queued' }, 202)],
        gets: [
            response({ job: { status: 'queued', progress: { phase: 'queued' } } }),
            response({ job: { status: 'running', progress: { phase: 'generating' } } }),
            completedJob(result)
        ]
    });

    const actual = await runCosmicSplitJob({
        httpClient: client,
        payload: { batchIndex: 0 },
        requestKey: 'run:batch-1',
        onStatus: status => statuses.push(status),
        ...fastPolling
    });

    assert.deepEqual(actual, result);
    assert.equal(client.calls.post.length, 1);
    assert.equal(client.calls.get.length, 3);
    assert.deepEqual(statuses.map(item => item.status), ['queued', 'running', 'completed']);
}

async function testPolling502DoesNotResubmit() {
    const statuses = [];
    const client = createScriptedClient({
        posts: [response({ jobId: 'job-poll-502' }, 202)],
        gets: [
            httpError(502, 'BAD_GATEWAY', 'Bad Gateway'),
            response({ job: { status: 'running' } }),
            completedJob({ ok: true })
        ]
    });

    const actual = await runCosmicSplitJob({
        httpClient: client,
        payload: { batchIndex: 1 },
        requestKey: 'run:batch-2',
        onStatus: status => statuses.push(status),
        ...fastPolling
    });

    assert.deepEqual(actual, { ok: true });
    assert.equal(client.calls.post.length, 1, 'polling 502 must not create another job');
    assert.equal(client.calls.get.length, 3);
    assert.ok(statuses.some(item => item.status === 'reconnecting'));
}

async function testPostTimeoutRetriesSameRequestKey() {
    const client = createScriptedClient({
        posts: [
            transportError('ECONNABORTED', 'submission timeout'),
            response({ jobId: 'job-after-timeout', deduplicated: true }, 202)
        ],
        gets: [completedJob({ recovered: true })]
    });

    const actual = await runCosmicSplitJob({
        httpClient: client,
        payload: { batchIndex: 2, value: 'same-payload' },
        requestKey: 'run:batch-3',
        ...fastPolling
    });

    assert.deepEqual(actual, { recovered: true });
    assert.equal(client.calls.post.length, 2);
    assert.equal(client.calls.post[0][1].requestKey, 'run:batch-3');
    assert.equal(client.calls.post[1][1].requestKey, 'run:batch-3');
    assert.deepEqual(client.calls.post[1][1].payload, client.calls.post[0][1].payload);
}

async function testJobNotFoundResubmitsSameAttempt() {
    const statuses = [];
    const client = createScriptedClient({
        posts: [
            response({ jobId: 'job-before-restart' }, 202),
            response({ jobId: 'job-after-restart' }, 202)
        ],
        gets: [
            httpError(404, 'JOB_NOT_FOUND', 'job was lost after service restart'),
            completedJob({ restored: true })
        ]
    });

    const actual = await runCosmicSplitJob({
        httpClient: client,
        payload: { batchIndex: 3 },
        requestKey: 'run:batch-4',
        onStatus: status => statuses.push(status),
        ...fastPolling
    });

    assert.deepEqual(actual, { restored: true });
    assert.equal(client.calls.post.length, 2);
    assert.equal(client.calls.post[0][1].requestKey, 'run:batch-4');
    assert.equal(client.calls.post[1][1].requestKey, 'run:batch-4');
    assert.equal(client.calls.get[1][0], '/api/cosmic-split-jobs/job-after-restart');
    assert.ok(statuses.some(item => item.status === 'restarting'));
}

async function testFailed500UsesNewAttemptKey() {
    const statuses = [];
    const client = createScriptedClient({
        posts: [
            response({ jobId: 'job-attempt-1' }, 202),
            response({ jobId: 'job-attempt-2' }, 202)
        ],
        gets: [
            response({
                job: {
                    status: 'failed',
                    error: { status: 500, code: 'UPSTREAM_FAILURE', message: 'temporary upstream failure' }
                }
            }),
            completedJob({ retried: true })
        ]
    });

    const actual = await runCosmicSplitJob({
        httpClient: client,
        payload: { batchIndex: 4 },
        requestKey: 'run:batch-5',
        onStatus: status => statuses.push(status),
        ...fastPolling
    });

    assert.deepEqual(actual, { retried: true });
    assert.equal(client.calls.post.length, 2);
    assert.equal(client.calls.post[0][1].requestKey, 'run:batch-5');
    assert.equal(client.calls.post[1][1].requestKey, 'run:batch-5:attempt-2');
    assert.ok(statuses.some(item => item.status === 'retrying'));
}

async function testCancellationStopsPolling() {
    const controller = new AbortController();
    const client = createScriptedClient({
        posts: [response({ jobId: 'job-cancel' }, 202)],
        gets: [response({ job: { status: 'running' } })],
        deletes: [response({ success: true })]
    });

    const pending = runCosmicSplitJob({
        httpClient: client,
        payload: { batchIndex: 5 },
        requestKey: 'run:batch-6',
        signal: controller.signal,
        initialPollMs: 10_000,
        maxPollMs: 10_000,
        maxWaitMs: 30_000
    });
    setTimeout(() => controller.abort(), 10);

    await assert.rejects(pending, error => (
        error?.name === 'AbortError'
        || error?.code === 'ABORT_ERR'
    ));
    assert.equal(client.calls.post.length, 1);
    assert.equal(client.calls.get.length, 1, 'cancellation must stop further polling');
    assert.equal(client.calls.delete.length, 1, 'cancellation should request server-side job cancellation');
    assert.equal(client.calls.delete[0][0], '/api/cosmic-split-jobs/job-cancel');
}

async function testJobWrappersUseTheirOwnEndpoints() {
    const wrappers = [
        [runDocumentUnderstandingJob, '/api/understand-document-jobs'],
        [runContinueAnalysisJob, '/api/continue-analyze-jobs'],
        [runFunctionExtractionJob, '/api/extract-functions-jobs'],
        [runCosmicModuleRecognitionJob, '/api/cosmic/recognize-modules-jobs']
    ];
    for (const [runner, endpoint] of wrappers) {
        const client = createScriptedClient({
            posts: [response({ jobId: 'job-wrapper' }, 202)],
            gets: [completedJob({ endpoint })]
        });
        const actual = await runner({
            httpClient: client,
            payload: { documentContent: 'test' },
            requestKey: `wrapper:${endpoint}`,
            ...fastPolling
        });
        assert.deepEqual(actual, { endpoint });
        assert.equal(client.calls.post[0][0], endpoint);
        assert.equal(client.calls.get[0][0], `${endpoint}/job-wrapper`);
    }
}

function testContinueAnalysisRoundResolution() {
    const coverageVerification = {
        coverageScore: 70,
        missedFunctions: ['补充功能'],
        vagueFunctions: []
    };

    const completed = resolveContinueAnalysisRound({
        reply: '[ALL_DONE]',
        doneMarker: true,
        isDone: true,
        resultKind: 'done_marker',
        tableData: []
    });
    assert.equal(completed.isValid, true);
    assert.equal(completed.shouldMerge, false);
    assert.equal(completed.shouldFinish, true);
    assert.equal(completed.needsLegacyParse, false);

    const continueAfterCoverage = resolveContinueAnalysisRound({
        reply: '[ALL_DONE]',
        doneMarker: true,
        isDone: false,
        resultKind: 'done_marker',
        tableData: [],
        coverageVerification
    });
    assert.equal(continueAfterCoverage.isValid, true);
    assert.equal(continueAfterCoverage.shouldFinish, false);
    assert.equal(continueAfterCoverage.shouldContinue, true);
    assert.deepEqual(continueAfterCoverage.coverageVerification, coverageVerification);

    const legacyContinueAfterCoverage = resolveContinueAnalysisRound({
        reply: '[ALL_DONE]',
        isDone: false,
        coverageVerification
    });
    assert.equal(legacyContinueAfterCoverage.needsLegacyParse, false);
    assert.equal(legacyContinueAfterCoverage.isValid, true);
    assert.equal(legacyContinueAfterCoverage.shouldContinue, true);
    assert.deepEqual(legacyContinueAfterCoverage.coverageVerification, coverageVerification);

    const legacyEmptyTable = {
        reply: '[ALL_DONE]\n|功能用户|功能过程|数据移动类型|\n|:---|:---|:---|',
        isDone: true
    };
    const legacyBeforeParse = resolveContinueAnalysisRound(legacyEmptyTable);
    assert.equal(legacyBeforeParse.needsLegacyParse, true);
    const legacyAfterParse = resolveContinueAnalysisRound(legacyEmptyTable, []);
    assert.equal(legacyAfterParse.needsLegacyParse, false);
    assert.equal(legacyAfterParse.isValid, true);
    assert.equal(legacyAfterParse.shouldFinish, true);

    const finalTable = [{ functionalProcess: '查询工单', dataMovementType: 'E' }];
    const markerWithRows = resolveContinueAnalysisRound({
        reply: '[ALL_DONE]',
        doneMarker: true,
        isDone: true,
        resultKind: 'table_and_done_marker',
        tableData: finalTable
    });
    assert.equal(markerWithRows.shouldMerge, true);
    assert.equal(markerWithRows.shouldFinish, true);
    assert.deepEqual(markerWithRows.tableData, finalTable);

    const invalid = resolveContinueAnalysisRound({ reply: '', isDone: false, tableData: [] });
    assert.equal(invalid.isValid, false);
    assert.equal(invalid.shouldContinue, false);
}

await testNormalLifecycle();
await testPolling502DoesNotResubmit();
await testPostTimeoutRetriesSameRequestKey();
await testJobNotFoundResubmitsSameAttempt();
await testFailed500UsesNewAttemptKey();
await testCancellationStopsPolling();
await testJobWrappersUseTheirOwnEndpoints();
testContinueAnalysisRoundResolution();

console.log('cosmic split job client tests passed');
