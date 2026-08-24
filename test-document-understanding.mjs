import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    generateDocumentUnderstanding,
    isTruncatedFinishReason,
    normalizeDocumentUnderstanding,
    parseDocumentUnderstandingResponse
} = require('./server/document-understanding');

const fullPrompt = 'full understanding prompt';
const compactPrompt = 'compact understanding prompt';
const documentContent = '测试需求文档';

const validUnderstanding = {
    projectName: '工单系统',
    projectDescription: '包含{x}占位符的描述',
    businessEntities: [{ entityName: '工单', crudOperations: ['创建', '查询'] }],
    coreModules: [{
        moduleName: '工单管理',
        estimatedFunctions: [{ functionName: '查询工单', triggerType: '用户触发' }]
    }],
    functionBreakdown: { crudFunctions: 1 },
    totalEstimatedFunctions: 1
};

const completion = (content, finishReason = 'stop') => ({
    choices: [{ message: { content }, finish_reason: finishReason }]
});

const createScriptedCall = (steps, calls = []) => async (options, maxAttempts) => {
    calls.push({ options, maxAttempts });
    assert.ok(steps.length > 0, 'unexpected AI call');
    const step = steps.shift();
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(options, maxAttempts);
    return step;
};

async function testPrimarySuccess() {
    const calls = [];
    const callAIWithRetry = createScriptedCall([
        completion(`说明文字 {"ignored":true}\n\`\`\`json\n${JSON.stringify(validUnderstanding)}\n\`\`\``)
    ], calls);
    const result = await generateDocumentUnderstanding({
        callAIWithRetry,
        modelName: 'model-a',
        documentContent,
        fullPrompt,
        compactPrompt
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.max_tokens, 16000);
    assert.equal(calls[0].options.requestTimeoutMs, 5 * 60 * 1000);
    assert.equal(calls[0].maxAttempts, 2);
    assert.equal(result.recoveryMode, 'none');
    assert.equal(result.validated, true);
    assert.equal(result.understanding.projectName, '工单系统');
    assert.equal(result.understanding.totalEstimatedFunctions, 1);
}

async function testTruncatedOutputContinues() {
    const partial = '{"projectName":"工单系统","coreModules":[{"moduleName":"工单管理","estimatedFunctions":[';
    const suffix = '{"functionName":"查询工单","triggerType":"用户触发"}]}],"totalEstimatedFunctions":1}';
    const calls = [];
    const progress = [];
    const result = await generateDocumentUnderstanding({
        callAIWithRetry: createScriptedCall([
            completion(partial, 'length'),
            completion(suffix, 'stop')
        ], calls),
        modelName: 'model-a',
        documentContent,
        fullPrompt,
        compactPrompt,
        onProgress: item => progress.push(item)
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.max_tokens, 12000);
    assert.equal(calls[1].options.requestTimeoutMs, 3 * 60 * 1000);
    assert.equal(calls[1].maxAttempts, 1);
    assert.equal(calls[1].options.messages[2].role, 'assistant');
    assert.equal(calls[1].options.messages[2].content, partial);
    assert.equal(result.recoveryMode, 'continued');
    assert.equal(result.recoveredFromTruncation, true);
    assert.ok(progress.some(item => item.phase === 'continuing'));
}

async function testParseableLengthStillRequiresRecovery() {
    const calls = [];
    const result = await generateDocumentUnderstanding({
        callAIWithRetry: createScriptedCall([
            completion(JSON.stringify(validUnderstanding), 'length'),
            completion('', 'stop')
        ], calls),
        modelName: 'model-a',
        documentContent,
        fullPrompt,
        compactPrompt
    });

    assert.equal(calls.length, 2);
    assert.equal(result.recoveryMode, 'continued');
    assert.equal(result.recoveredFromTruncation, true);
}

async function testInvalidJsonUsesCompactRetry() {
    const calls = [];
    const result = await generateDocumentUnderstanding({
        callAIWithRetry: createScriptedCall([
            completion('不是JSON', 'stop'),
            completion(JSON.stringify(validUnderstanding), 'stop')
        ], calls),
        modelName: 'model-a',
        documentContent,
        fullPrompt,
        compactPrompt
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.messages[0].content, compactPrompt);
    assert.equal(calls[1].options.requestTimeoutMs, 4 * 60 * 1000);
    assert.equal(calls[1].maxAttempts, 1);
    assert.equal(result.recoveryMode, 'compact-retry');
    assert.equal(result.generationAttempts, 2);
}

async function testTruncatedContinuationUsesCompactRetry() {
    const partial = '{"projectName":"工单系统","coreModules":[],"totalEstimatedFunctions":';
    const calls = [];
    const result = await generateDocumentUnderstanding({
        callAIWithRetry: createScriptedCall([
            completion(partial, 'length'),
            completion('1}', 'max_output_tokens'),
            completion(JSON.stringify(validUnderstanding), 'stop')
        ], calls),
        modelName: 'model-a',
        documentContent,
        fullPrompt,
        compactPrompt
    });

    assert.equal(calls.length, 3);
    assert.equal(result.recoveryMode, 'compact-retry');
    assert.equal(result.recoveredFromTruncation, true);
}

async function testTruncatedCompactResultFails() {
    await assert.rejects(
        generateDocumentUnderstanding({
            callAIWithRetry: createScriptedCall([
                completion('不是JSON', 'stop'),
                completion(JSON.stringify(validUnderstanding), 'token_limit')
            ]),
            modelName: 'model-a',
            documentContent,
            fullPrompt,
            compactPrompt
        }),
        error => error?.code === 'INVALID_DOCUMENT_UNDERSTANDING' && error?.status === 422
    );
}

async function testFailedContinuationUsesCompactRetry() {
    const calls = [];
    const result = await generateDocumentUnderstanding({
        callAIWithRetry: createScriptedCall([
            completion('{"projectName":"工单系统",', 'max_tokens'),
            completion('仍然不是可拼接的JSON', 'stop'),
            completion(JSON.stringify(validUnderstanding), 'stop')
        ], calls),
        modelName: 'model-a',
        documentContent,
        fullPrompt,
        compactPrompt
    });

    assert.equal(calls.length, 3);
    assert.equal(result.recoveryMode, 'compact-retry');
    assert.equal(result.generationAttempts, 3);
    assert.equal(result.recoveredFromTruncation, true);
}

async function testInvalidAfterRecoveryFailsExplicitly() {
    await assert.rejects(
        generateDocumentUnderstanding({
            callAIWithRetry: createScriptedCall([
                completion('{"projectName":', 'token_limit'),
                completion('broken', 'stop'),
                completion('{}', 'stop')
            ]),
            modelName: 'model-a',
            documentContent,
            fullPrompt,
            compactPrompt
        }),
        error => error?.code === 'INVALID_DOCUMENT_UNDERSTANDING' && error?.status === 422
    );
}

async function testAbortStopsRecoveryCalls() {
    const controller = new AbortController();
    const calls = [];
    const callAIWithRetry = createScriptedCall([
        () => {
            controller.abort();
            return completion('{"projectName":', 'length');
        }
    ], calls);

    await assert.rejects(
        generateDocumentUnderstanding({
            callAIWithRetry,
            modelName: 'model-a',
            documentContent,
            fullPrompt,
            compactPrompt,
            signal: controller.signal
        }),
        error => error?.name === 'AbortError'
    );
    assert.equal(calls.length, 1);
}

async function testTotalBudgetStopsLongRunningCall() {
    await assert.rejects(
        generateDocumentUnderstanding({
            callAIWithRetry: async options => new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            }),
            modelName: 'model-a',
            documentContent,
            fullPrompt,
            compactPrompt,
            totalBudgetMs: 20
        }),
        error => error?.code === 'DOCUMENT_UNDERSTANDING_TIMEOUT'
            && error?.status === 422
            && error?.name === 'TimeoutError'
    );
}

function testParsingAndNormalization() {
    for (const reason of ['length', 'max_tokens', 'max_output_tokens', 'token_limit', 'LENGTH']) {
        assert.equal(isTruncatedFinishReason(reason), true);
    }
    assert.equal(isTruncatedFinishReason('stop'), false);

    const parsed = parseDocumentUnderstandingResponse(
        `前置对象 {"example":true}\n${JSON.stringify(validUnderstanding)}\n后置说明`
    );
    assert.equal(parsed.projectDescription, '包含{x}占位符的描述');
    assert.equal(parsed.coreModules[0].estimatedFunctions[0].functionName, '查询工单');

    const normalized = normalizeDocumentUnderstanding({
        projectName: '测试系统',
        coreModules: [{ moduleName: '模块', estimatedFunctions: ['功能A', '功能B'] }],
        aggregationAndReports: [{ name: '月报', dimensions: '地市', metrics: '成功率' }],
        totalEstimatedFunctions: '1'
    });
    assert.deepEqual(normalized.aggregationAndReports[0].dimensions, ['地市']);
    assert.equal(normalized.totalEstimatedFunctions, 2, 'total must cover listed unique functions');

    assert.throws(
        () => parseDocumentUnderstandingResponse('{}'),
        error => error?.code === 'INVALID_DOCUMENT_UNDERSTANDING'
    );
    assert.throws(
        () => normalizeDocumentUnderstanding({ projectName: '测试', coreModules: {}, totalEstimatedFunctions: 1 }),
        error => error?.code === 'INVALID_DOCUMENT_UNDERSTANDING'
    );
}

await testPrimarySuccess();
await testTruncatedOutputContinues();
await testParseableLengthStillRequiresRecovery();
await testInvalidJsonUsesCompactRetry();
await testFailedContinuationUsesCompactRetry();
await testTruncatedContinuationUsesCompactRetry();
await testTruncatedCompactResultFails();
await testInvalidAfterRecoveryFailsExplicitly();
await testAbortStopsRecoveryCalls();
await testTotalBudgetStopsLongRunningCall();
testParsingAndNormalization();

console.log('document understanding tests passed');
