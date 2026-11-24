import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const extraction = require('./server/cosmic-extraction');
const prompts = require('./server/prompts');
const { isV4CosmicModel } = require('./server/cosmic-model-profile');
const { canonicalFunctionNameKey } = require('./server/cosmic-quality');
const { isTruncatedFinishReason } = require('./server/document-understanding');

const record = (name, { trigger = '用户触发', user = '发起者：用户 接收者：用户', desc = `${name}并返回业务结果` } = {}) => (
    `##触发事件：${trigger}\n##功能用户：${user}\n##功能过程：${name}\n##功能过程描述：${desc}`
);

const completion = (content, finishReason = 'stop') => ({
    choices: [{ message: { content }, finish_reason: finishReason }]
});

// 1. V4 数量优先提示词不得再继承保守的 CRUD 合并策略，同时必须守住文档边界。
assert.ok(
    !prompts.SENSENOVA_V4_QUANTITY_PRIORITY_PROMPT.includes('优先归并为一个“维护/管理/配置xxx”'),
    'V4 quantity prompt must not force CRUD merging'
);
assert.ok(
    prompts.SENSENOVA_V4_QUANTITY_PRIORITY_PROMPT.includes('禁止粗暴合并'),
    'V4 quantity prompt must explicitly prevent over-merging'
);
assert.ok(
    prompts.COSMIC_QUANTITY_PRIORITY_PROMPT.includes('严守文档内容底线'),
    'quantity prompt must preserve document grounding constraints'
);

// 从 server/index.js 加载真实的 executeFunctionExtraction、selectDocumentSliceForRound 及辅助解析器。
const serverSource = fs.readFileSync(new URL('./server/index.js', import.meta.url), 'utf8');
const sliceStart = serverSource.indexOf('function selectDocumentSliceForRound(');
const sliceEnd = serverSource.indexOf('async function executeContinueAnalysis(', sliceStart);
const fnStart = serverSource.indexOf('async function executeFunctionExtraction(');
const fnEnd = serverSource.indexOf('const functionExtractionJobManager', fnStart);
assert.ok(sliceStart > 0 && sliceEnd > sliceStart, 'selectDocumentSliceForRound must exist');
assert.ok(fnStart > 0 && fnEnd > fnStart, 'executeFunctionExtraction must exist');

function extractFunctionsFromText(text) {
    const functions = [];
    let current = null;
    for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^##\s*(触发事件|功能用户|功能过程|功能过程描述)[：:]\s*(.*)$/);
        if (!match) continue;
        if (match[1] === '触发事件') {
            if (current?.functionName) functions.push(current);
            current = { triggerEvent: match[2].trim(), functionalUser: '', functionName: '', description: '' };
        } else if (current) {
            if (match[1] === '功能用户') current.functionalUser = match[2].trim();
            if (match[1] === '功能过程') current.functionName = match[2].trim();
            if (match[1] === '功能过程描述') current.description = match[2].trim();
        }
    }
    if (current?.functionName) functions.push(current);
    return functions;
}

function dedupeFunctionsByName(functions, { semantic = true } = {}) {
    const seen = new Set();
    return functions.filter(func => {
        const key = semantic
            ? canonicalFunctionNameKey(func.functionName)
            : String(func.functionName || '').replace(/\s+/g, '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function createQuantityHarness(callAIWithRetry) {
    const context = vm.createContext({
        ...extraction,
        isTruncatedFinishReason,
        console: { log() {}, warn() {}, error() {} },
        createHttpError: (message, status, code) => Object.assign(new Error(message), { status, code }),
        getModelName: () => 'siliconflow-deepseek-v4-flash',
        isSenseNovaV4Model: isV4CosmicModel,
        getFunctionExtractionPrompt: (modelName, mode, requested) => (
            isV4CosmicModel(modelName, requested)
                ? prompts.SENSENOVA_V4_QUANTITY_PRIORITY_PROMPT
                : prompts.COSMIC_QUANTITY_PRIORITY_PROMPT
        ),
        getRelevantModulesForChapter: () => [],
        qualifyFunctionNames: functions => functions,
        extractFunctionsFromText,
        dedupeFunctionsByName,
        buildFunctionListText: extraction.functionListText,
        callAIWithRetry
    });
    vm.runInContext(
        serverSource.slice(sliceStart, sliceEnd)
        + '\n'
        + serverSource.slice(fnStart, fnEnd)
        + '\nglobalThis.execute = executeFunctionExtraction; globalThis.selectSlice = selectDocumentSliceForRound;',
        context
    );
    return context;
}

// 2. 尽多细拆模式：长文档自动分段、截断续写、不封顶裁剪、语义去重同义项、多轮深挖后正常停止。
{
    const tailMarker = '定时归档超过三年的区域巡检报告。';
    const longDoc = ('区域管理模块支持区域台账的新增、编辑、删除、查询列表、查看详情、导入与导出。\n').repeat(260) + tailMarker;
    assert.ok(longDoc.length > 7500);
    const seenPrompts = [];
    let supplementRound = 0;

    const harness = createQuantityHarness(async options => {
        const userMsg = options.messages.at(-1).content;
        seenPrompts.push(userMsg);
        assert.ok(
            !userMsg.includes('应合并为一个维护/配置/查询功能过程'),
            'quantity mode must never inject the old V4 CRUD-merge rule'
        );

        // 截断续写测试：第一段模拟 length 截断，第二条消息为续写请求。
        if (userMsg.includes('因长度上限被截断')) {
            return completion([
                record('删除区域台账'),
                record('查询区域台账列表'),
                record('查看区域台账详情')
            ].join('\n\n'));
        }
        if (userMsg.includes('第 1/')) {
            return completion([
                record('新增区域台账'),
                record('创建区域台账'), // 同义重复，应被语义去重清除
                record('修改区域台账')
            ].join('\n\n'), 'length');
        }
        if (userMsg.includes(tailMarker) && userMsg.includes('当前原文')) {
            return completion([
                record('导出区域台账数据'),
                record('定时归档区域巡检报告', { trigger: '时钟触发', user: '发起者：定时触发器 接收者：本系统' })
            ].join('\n\n'));
        }
        if (userMsg.includes('当前原文')) {
            return completion(record('导入区域台账数据'));
        }
        // 深度补漏轮次
        supplementRound += 1;
        if (supplementRound === 1) {
            return completion([
                record('启用区域台账'),
                record('停用区域台账'),
                record('批量删除区域台账')
            ].join('\n\n'));
        }
        return completion('无新增功能过程');
    });

    const result = await harness.execute({
        documentContent: longDoc,
        chapterName: '2 区域管理',
        extractionMode: 'quantity',
        targetCount: 5, // 保底 5 个，尽多细拆不应裁剪到 5 个
        quantityMaximize: true,
        userConfig: { model: 'siliconflow-deepseek-v4-flash' }
    });

    const names = result.functions.map(f => f.functionName);
    assert.ok(result.countDiagnostics.chunkCount >= 2, 'long chapter in quantity mode should chunk');
    assert.equal(result.countDiagnostics.quantityMaximize, true);
    assert.equal(result.countDiagnostics.targetSatisfied, true);
    assert.ok(names.length >= 10, `expected >=10 unclipped functions, got ${names.length}: ${names.join(', ')}`);
    assert.ok(names.includes('新增区域台账'));
    assert.ok(!names.includes('创建区域台账'), 'semantic dedupe must drop synonym duplicate');
    assert.ok(names.includes('查询区域台账列表'));
    assert.ok(names.includes('查看区域台账详情'));
    assert.ok(names.includes('定时归档区域巡检报告'), 'tail chunk requirement must be extracted');
    assert.ok(names.includes('批量删除区域台账'), 'supplement pass should add deeper operations');
}

// 3. 精确目标模式（quantityMaximize: false）：支持最多 4 轮多角度补位并精确匹配目标数。
{
    let callNum = 0;
    const harness = createQuantityHarness(async () => {
        callNum += 1;
        if (callNum === 1) {
            return completion([record('新增工单'), record('修改工单')].join('\n\n'));
        }
        if (callNum === 2) {
            return completion([record('删除工单'), record('查询工单列表')].join('\n\n'));
        }
        if (callNum === 3) {
            return completion([record('审核工单'), record('驳回工单')].join('\n\n'));
        }
        return completion([record('派发工单'), record('归档工单'), record('导出工单')].join('\n\n'));
    });

    const result = await harness.execute({
        documentContent: '工单管理支持新增、修改、删除、查询、审核、驳回、派发、归档和导出工单。',
        chapterName: '3 工单管理',
        extractionMode: 'quantity',
        targetCount: 7,
        quantityMaximize: false,
        userConfig: { model: 'siliconflow-deepseek-v4-flash' }
    });

    assert.equal(result.count, 7, 'exact quantity mode must deliver exact target count');
    assert.equal(result.countDiagnostics.supplementAttempts, 3, 'should support >2 supplement rounds');
    assert.equal(result.countDiagnostics.targetSatisfied, true);
    assert.equal(result.countDiagnostics.deficit, 0);
}

// 4. 一键拆分长文档轮次切片应覆盖头、中、尾全部内容。
{
    const harness = createQuantityHarness(async () => completion(''));
    const head = 'HEAD_REQUIREMENT_MARKER';
    const mid = 'MID_REQUIREMENT_MARKER';
    const tail = 'TAIL_REQUIREMENT_MARKER';
    const hugeDoc = head + '甲'.repeat(22000) + mid + '乙'.repeat(22000) + tail;
    const slices = [1, 2, 3].map(r => harness.selectSlice(hugeDoc, r, 20000));
    assert.ok(slices.some(s => s.includes(head)), 'round slices must cover head');
    assert.ok(slices.some(s => s.includes(mid)), 'round slices must cover middle');
    assert.ok(slices.some(s => s.includes(tail)), 'round slices must cover tail');
}

console.log('COSMIC quantity priority optimization tests passed');
