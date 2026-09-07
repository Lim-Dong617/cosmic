import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    EMPTY_RESULT,
    splitSourceRanges,
    parseGroundedFunctionList,
    locateEvidence,
    deduplicateGroundedFunctions,
    extractGroundedFunctions
} = require('./server/cosmic-extraction');

// Deliberately import only the extraction module: these tests never load .env,
// contact a provider, or depend on a particular model's nondeterministic output.
const completion = (content, finishReason = 'stop') => ({
    choices: [{ message: { content }, finish_reason: finishReason }]
});

const record = (name, evidence, { trigger = '管理员提交请求', user = '管理员' } = {}) => (
    `##触发事件：${trigger}\n##功能用户：${user}\n##功能过程：${name}\n##功能过程描述：${name}并返回业务结果\n##原文依据：${evidence}`
);

function scriptedCall(steps, calls = []) {
    return async (options, maxAttempts) => {
        calls.push({ options, maxAttempts });
        assert.ok(steps.length, 'unexpected extra AI request');
        const step = steps.shift();
        if (step instanceof Error) throw step;
        return typeof step === 'function' ? step(options, maxAttempts) : step;
    };
}

function sourceRequest(options) {
    const prompt = options.messages.find(message => message.role === 'user' && message.content.includes('【当前原文】'))?.content;
    assert.ok(prompt, 'every extraction/review request must retain its original source');
    const scope = prompt.match(/当前范围：第(\d+)~(\d+)字符/);
    const current = prompt.match(/【当前原文】\n([\s\S]*?)\n【后文，仅作上下文】/);
    assert.ok(scope && current, 'source range and unmodified current text must be present');
    return {
        start: Number(scope[1]) - 1,
        end: Number(scope[2]),
        text: current[1],
        reviewing: options.messages.at(-1).content.includes('逐句复核候选清单')
    };
}

const extract = (options) => extractGroundedFunctions({
    modelName: 'offline-test-model',
    systemPrompt: '提取明确的业务功能。',
    chapterName: '3.2 回归测试',
    ...options
});

function testContiguousSourceRanges() {
    const cases = [
        '甲'.repeat(26001) + '文档最后一字尾',
        ('一行表格：编号\t名称\t业务需求；\n').repeat(1700),
        '甲'.repeat(63) + '😀' + '乙'.repeat(129) + '😀尾',
        '段落第一部分。'.repeat(300) + '\n\n末段必须保留。'
    ];
    for (const text of cases) {
        for (const chunkChars of [64, 127, 6000]) {
            const ranges = splitSourceRanges(text, chunkChars);
            assert.equal(ranges[0].start, 0);
            assert.equal(ranges.at(-1).end, text.length);
            let next = 0;
            for (const range of ranges) {
                assert.equal(range.start, next, 'source ranges must neither overlap nor skip characters');
                assert.ok(range.end > range.start && range.end - range.start <= chunkChars);
                assert.ok(!/[\uD800-\uDBFF]$/.test(text.slice(range.start, range.end)), 'must not split a surrogate pair');
                next = range.end;
            }
            assert.equal(ranges.map(range => text.slice(range.start, range.end)).join(''), text);
        }
    }
    assert.deepEqual(splitSourceRanges('', 64), []);
    assert.deepEqual(splitSourceRanges('甲'.repeat(130), 64, 500), [
        { start: 500, end: 564 }, { start: 564, end: 628 }, { start: 628, end: 630 }
    ]);
}

async function testLongUnbrokenSourceRetainsItsTail() {
    const tail = '调度器每日归档超过三年的历史工单。';
    const documentContent = '背景说明'.repeat(6100) + tail;
    const initialRanges = [];
    const reviewedRanges = [];
    const result = await extract({
        documentContent,
        callAIWithRetry: async (options, maxAttempts) => {
            assert.equal(options.model, 'offline-test-model');
            assert.equal(maxAttempts, 2);
            const range = sourceRequest(options);
            (range.reviewing ? reviewedRanges : initialRanges).push(range);
            return completion(range.text.includes(tail) ? record('归档历史工单', tail) : EMPTY_RESULT);
        }
    });
    assert.ok(initialRanges.length > 3, 'fixture must exercise a multi-chunk long paragraph');
    assert.equal(initialRanges.map(range => range.text).join(''), documentContent);
    assert.deepEqual(reviewedRanges.map(({ start, end }) => ({ start, end })), initialRanges.map(({ start, end }) => ({ start, end })));
    assert.deepEqual(result.functions.map(func => func.functionName), ['归档历史工单']);
    assert.equal(result.functions[0].sourceEnd, documentContent.length);
    assert.equal(documentContent.slice(result.functions[0].sourceStart, result.functions[0].sourceEnd), tail);
    assert.equal(result.sourceDiagnostics.sourceComplete, true);
    assert.equal(result.sourceDiagnostics.completedChunks, initialRanges.length);
    assert.equal(result.sourceDiagnostics.reviewedChunks, initialRanges.length);
}

async function testEveryChunkReviewAddsOmissionsAndRemovesInventedActions() {
    const requirements = [1, 2, 3].map(id => `管理员可以查询仓库${id}的库存列表，也可以单独删除仓库${id}的作废库存记录。`);
    const documentContent = requirements.map(text => text.padEnd(160, '背景')).join('');
    const calls = [];
    const result = await extract({
        documentContent,
        chunkChars: 160,
        callAIWithRetry: async options => {
            const range = sourceRequest(options);
            calls.push(range);
            const index = range.start / 160;
            const evidence = requirements[index];
            assert.ok(evidence && range.text.includes(evidence));
            const query = record(`查询仓库${index + 1}库存`, evidence);
            // The fake action quotes real text, so semantic review must remove it.
            const second = record(range.reviewing ? `删除仓库${index + 1}作废库存` : `导出仓库${index + 1}库存`, evidence);
            return completion(`${query}\n\n${second}`);
        }
    });
    assert.equal(calls.length, 6);
    assert.deepEqual(calls.map(call => call.reviewing), [false, true, false, true, false, true]);
    assert.equal(result.functions.length, 6);
    assert.ok(result.functions.every(func => !func.functionName.includes('导出')));
    assert.equal(result.functions.filter(func => func.functionName.includes('删除')).length, 3);
    assert.equal(result.sourceDiagnostics.reviewedChunks, 3);
    assert.equal(result.sourceDiagnostics.sourceComplete, true);
}

async function testParseableTruncationSplitsAndDiscardsParentCandidates() {
    const first = '管理员可以查询工单列表。';
    const last = '调度器每日归档历史工单。';
    const documentContent = first + '甲'.repeat(2048 - first.length - last.length) + last;
    const calls = [];
    const progress = [];
    const result = await extract({
        documentContent,
        onProgress: item => progress.push(item),
        callAIWithRetry: async options => {
            const range = sourceRequest(options);
            calls.push(range);
            if (range.start === 0 && range.end === documentContent.length) {
                return completion(record('不得保留的截断候选', first), 'length');
            }
            return completion(range.text.includes(first) ? record('查询工单列表', first) : record('归档历史工单', last));
        }
    });
    assert.equal(calls.length, 5, 'truncated parent must be replaced by extraction plus review of both children');
    assert.deepEqual(result.functions.map(func => func.functionName), ['查询工单列表', '归档历史工单']);
    const childRanges = calls.filter(call => !call.reviewing).slice(1);
    assert.equal(childRanges.map(range => range.text).join(''), documentContent);
    assert.equal(result.sourceDiagnostics.chunkCount, 2);
    assert.equal(result.sourceDiagnostics.completedChunks, 2);
    assert.equal(result.sourceDiagnostics.reviewedChunks, 2);
    assert.equal(result.sourceDiagnostics.recoveredChunks, 1);
    assert.equal(result.sourceDiagnostics.sourceComplete, true);
    assert.ok(progress.some(item => item.phase === 'recovering'));
}

async function testFailedRecoveryCannotReturnPartialSuccess() {
    const evidence = '管理员可以查询工单列表。';
    const calls = [];
    let result;
    await assert.rejects(async () => {
        result = await extract({
            documentContent: evidence + '甲'.repeat(1600 - evidence.length),
            callAIWithRetry: async options => {
                const range = sourceRequest(options);
                calls.push(range);
                return completion(record('查询工单列表', evidence), range.end - range.start > 800 || range.start > 0 ? 'length' : 'stop');
            }
        });
    }, error => error?.code === 'TRUNCATED_FUNCTION_EXTRACTION' && error?.status === 422 && error.message.includes('801~1600'));
    assert.equal(result, undefined, 'successful earlier child must never be exposed as a complete result');
    assert.equal(calls.length, 4);
    assert.ok(calls[2].reviewing, 'first child has completed review before second child fails');
}

async function testReviewTruncationAlsoRequiresFullRecovery() {
    const evidence = '管理员可以查询工单列表。';
    const documentContent = evidence + '甲'.repeat(1600 - evidence.length);
    const calls = [];
    const result = await extract({
        documentContent,
        callAIWithRetry: async options => {
            const range = sourceRequest(options);
            calls.push(range);
            const content = range.text.includes(evidence) ? record('查询工单列表', evidence) : EMPTY_RESULT;
            return completion(content, range.end === 1600 && range.start === 0 && range.reviewing ? 'length' : 'stop');
        }
    });
    assert.equal(calls.length, 6);
    assert.equal(result.functions.length, 1);
    assert.equal(result.sourceDiagnostics.completedChunks, 2);
    assert.equal(result.sourceDiagnostics.reviewedChunks, 2);
    assert.equal(result.sourceDiagnostics.recoveredChunks, 1);
    assert.equal(result.sourceDiagnostics.sourceComplete, true);
}

async function testMissingFieldsAndEvidenceAreRepaired() {
    const evidence = '管理员可以查询工单列表。';
    const valid = record('查询工单列表', evidence);
    const malformed = [
        valid.replace('##功能用户：管理员\n', ''),
        valid.replace(`\n##原文依据：${evidence}`, ''),
        valid.replace(`##原文依据：${evidence}`, '##原文依据：')
    ];
    for (const candidate of malformed) {
        const calls = [];
        const result = await extract({
            documentContent: evidence,
            callAIWithRetry: scriptedCall([completion(candidate), completion(valid), completion(valid)], calls)
        });
        assert.equal(calls.length, 3);
        assert.match(calls[1].options.messages.at(-1).content, /校验未通过/);
        assert.equal(calls[1].options.messages.at(-2).content, candidate);
        assert.equal(result.functions[0].documentEvidence, evidence);
        assert.equal(result.sourceDiagnostics.rejectedCandidateCount, 1);
        assert.equal(result.sourceDiagnostics.warnings.length, 1);
        assert.equal(result.sourceDiagnostics.sourceComplete, true);
    }
}

async function testFabricatedQuoteCanBeRepairedButNeverAccepted() {
    const evidence = '管理员可以查询工单列表。';
    const fabricated = record('导出工单列表', '管理员可以导出工单列表。');
    const valid = record('查询工单列表', evidence);
    const calls = [];
    const result = await extract({
        documentContent: evidence,
        callAIWithRetry: scriptedCall([completion(fabricated), completion(valid), completion(valid)], calls)
    });
    assert.equal(result.functions.length, 1);
    assert.equal(result.functions[0].functionName, '查询工单列表');
    assert.match(calls[1].options.messages.at(-1).content, /原文核对的依据/);

    const rejectedCalls = [];
    await assert.rejects(extract({
        documentContent: evidence,
        callAIWithRetry: scriptedCall([completion(fabricated), completion(fabricated)], rejectedCalls)
    }), error => error?.code === 'UNSUPPORTED_FUNCTION_EVIDENCE' && error?.status === 422);
    assert.equal(rejectedCalls.length, 2, 'unrepairable evidence must fail before review or result publication');
}

function testEvidenceMustIntersectCurrentRangeAndPreserveWords() {
    const source = '前文要求查询工单列表。\n当前要求\t删除\n作废工单。\n后文要求定时归档。';
    const range = { start: source.indexOf('当前'), end: source.indexOf('\n后文') };
    const found = locateEvidence(source, '“当前要求 删除 作废工单。”', range);
    assert.deepEqual(found, { start: range.start, end: range.end, text: source.slice(range.start, range.end) });
    assert.equal(locateEvidence(source, '前文要求查询工单列表。', range), null, 'context alone cannot justify a new current-range function');
    assert.equal(locateEvidence(source, '后文要求定时归档。', range), null);
    assert.equal(locateEvidence(source, '当前要求导出作废工单。', range), null);
    assert.equal(locateEvidence(source, '当前要求…作废工单。', range), null);
    assert.equal(locateEvidence(source, '工单', range), null);
}

async function testEmptyFunctionListUsesExplicitFixedSentence() {
    assert.deepEqual(parseGroundedFunctionList(EMPTY_RESULT), []);
    for (const text of ['', '没有功能', `${EMPTY_RESULT}。`, `${EMPTY_RESULT}\n##功能过程：查询工单`]) {
        assert.throws(() => parseGroundedFunctionList(text), error => error?.code === 'INVALID_EXTRACTION_FORMAT');
    }
    const calls = [];
    const result = await extract({
        documentContent: '本项目使用蓝色界面，文档由业务部门编写。',
        callAIWithRetry: scriptedCall([completion(EMPTY_RESULT), completion(EMPTY_RESULT)], calls)
    });
    assert.deepEqual(result.functions, []);
    assert.equal(calls.length, 2, 'an empty first pass must still be reviewed for omissions');
    assert.equal(result.sourceDiagnostics.reviewedChunks, 1);
    assert.equal(result.sourceDiagnostics.sourceComplete, true);
}

async function testCancellationStopsReviewAndRecovery() {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let calls = 0;
    await assert.rejects(extract({
        documentContent: '管理员查询工单列表。',
        signal: alreadyAborted.signal,
        callAIWithRetry: async () => { calls += 1; return completion(EMPTY_RESULT); }
    }), error => error?.name === 'AbortError');
    assert.equal(calls, 0);

    for (const finishReason of ['stop', 'length']) {
        const controller = new AbortController();
        calls = 0;
        await assert.rejects(extract({
            documentContent: '甲'.repeat(1600),
            signal: controller.signal,
            callAIWithRetry: async options => {
                calls += 1;
                assert.equal(options.signal, controller.signal);
                controller.abort();
                return completion(EMPTY_RESULT, finishReason);
            }
        }), error => error?.name === 'AbortError');
        assert.equal(calls, 1, 'cancellation must prevent both review and truncation recovery requests');
    }
}

async function testCrossChunkDuplicatesAndIndependentSimilarNames() {
    const evidence = '管理员单独查询当前工单列表，或单独查询历史工单列表；调度器每日查询当前工单列表。';
    const unit = evidence.padEnd(200, '甲');
    const content = [
        record('查询当前工单列表', evidence, { trigger: '点击当前工单查询', user: '管理员' }),
        record('查询历史工单列表', evidence, { trigger: '点击历史工单查询', user: '管理员' }),
        record('查询当前工单列表', evidence, { trigger: '每日定时', user: '调度器' })
    ].join('\n\n');
    const result = await extract({
        documentContent: unit + unit,
        chunkChars: 200,
        callAIWithRetry: async () => completion(content)
    });
    assert.deepEqual(result.functions.map(func => func.functionName), [
        '查询当前工单列表', '查询历史工单列表', '查询当前工单列表（每日定时；调度器）'
    ]);
    assert.equal(new Set(result.functions.map(func => func.functionName)).size, 3);
    assert.equal(result.sourceDiagnostics.completedChunks, 2);
    assert.equal(result.sourceDiagnostics.reviewedChunks, 2);
}

const tests = [
    testContiguousSourceRanges,
    testLongUnbrokenSourceRetainsItsTail,
    testEveryChunkReviewAddsOmissionsAndRemovesInventedActions,
    testParseableTruncationSplitsAndDiscardsParentCandidates,
    testFailedRecoveryCannotReturnPartialSuccess,
    testReviewTruncationAlsoRequiresFullRecovery,
    testMissingFieldsAndEvidenceAreRepaired,
    testFabricatedQuoteCanBeRepairedButNeverAccepted,
    testEvidenceMustIntersectCurrentRangeAndPreserveWords,
    testEmptyFunctionListUsesExplicitFixedSentence,
    testCancellationStopsReviewAndRecovery,
    testCrossChunkDuplicatesAndIndependentSimilarNames
];
let deepRecoveryCalls = 0;
const fullyRecovered = await extract({
    documentContent: '甲'.repeat(24000),
    callAIWithRetry: async options => {
        deepRecoveryCalls++;
        const range = sourceRequest(options);
        return completion(EMPTY_RESULT, range.end - range.start > 800 ? 'length' : 'stop');
    }
});
assert.ok(deepRecoveryCalls > 64, 'Every source range needs its own full recovery budget');
assert.equal(fullyRecovered.sourceDiagnostics.completedChunks, 32);
assert.equal(fullyRecovered.sourceDiagnostics.sourceComplete, true);
const commonSource = { sourceChapter: '工单', triggerEvent: '用户触发', functionalUser: '管理员', sourceStart: 58, sourceEnd: 75 };
assert.equal(deduplicateGroundedFunctions([
    { ...commonSource, functionName: '新增工单' },
    { ...commonSource, functionName: '创建工单' }
]).length, 1, 'Synonyms quoting the same transaction across a chunk boundary must count once');
assert.equal(deduplicateGroundedFunctions([
    { ...commonSource, functionName: '查询工单列表' },
    { ...commonSource, functionName: '获取工单', sourceStart: 90, sourceEnd: 120 }
]).length, 2, 'Similar names backed by separate source transactions must survive');
for (const test of tests) await test();
console.log(`cosmic extraction tests passed (${tests.length} regression cases)`);
