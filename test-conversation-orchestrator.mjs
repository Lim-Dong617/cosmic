import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    applyConversationPlan,
    buildConversationContext,
    createConversationPlan,
    normalizeConversationPlan
} = require('./server/conversation-orchestrator');

const normalizedPlan = normalizeConversationPlan({
    answer: '更新告警功能。',
    intent: 'mixed',
    documentPatches: [
        {
            type: 'replace',
            match: '系统展示告警列表。',
            replacement: '系统展示告警列表，并支持按级别筛选。'
        },
        {
            type: 'replace',
            match: '系统展示告警列表。',
            replacement: '系统展示告警列表，并支持按级别筛选。'
        }
    ],
    functionChanges: [{
        type: 'update',
        target: '查询告警列表',
        changes: {
            description: '用户提交级别条件后，系统返回匹配的告警列表。',
            unknownField: '不能写入'
        }
    }],
    cosmicTargets: [
        {
            type: 'update',
            functionName: '查询告警列表',
            instruction: '增加读取告警级别筛选条件'
        },
        {
            type: 'update',
            functionName: '查看告警记录',
            instruction: '以最后一条同功能修改要求为准'
        }
    ]
});

assert.equal(normalizedPlan.documentPatches.length, 1);
assert.equal(normalizedPlan.cosmicTargets.length, 1);
assert.equal(normalizedPlan.cosmicTargets[0].instruction, '以最后一条同功能修改要求为准');
assert.equal(normalizedPlan.functionChanges[0].changes.unknownField, undefined);

const mutation = applyConversationPlan({
    documentContent: '# 告警管理\n\n系统展示告警列表。',
    parsedFunctions: [{
        functionName: '查询告警列表',
        triggerEvent: '用户提交查询条件',
        functionalUser: '发起者：用户 接收者：系统',
        description: '系统返回告警列表。',
        selected: true
    }],
    plan: normalizedPlan
});

assert.ok(mutation.documentContent.includes('支持按级别筛选'));
assert.equal(mutation.changeSummary.documentApplied, 1);
assert.equal(mutation.changeSummary.functionsApplied, 1);
assert.equal(
    mutation.functions[0].description,
    '用户提交级别条件后，系统返回匹配的告警列表。'
);
assert.equal(mutation.cosmicTargets.length, 1);

const context = buildConversationContext({
    instruction: '把告警级别筛选补充进去',
    conversationHistory: [
        { role: 'user', content: '先看一下告警模块' },
        { role: 'assistant', content: '当前有查询告警列表功能。' }
    ],
    documentContent: '# 告警管理\n\n系统展示告警列表。',
    parsedFunctions: mutation.functions,
    tableData: [{
        dataMovementType: 'E',
        functionalProcess: '查询告警列表',
        subProcessDesc: '接收告警查询条件'
    }],
    userGuidelines: '保持业务语言'
});

assert.equal(context.conversationHistory.length, 2);
assert.equal(context.currentState.functionCount, 1);
assert.equal(context.currentState.cosmicFunctionCount, 1);
assert.ok(context.currentState.relevantDocumentContent.includes('告警列表'));

let capturedRequest = null;
const planned = await createConversationPlan({
    instruction: '把告警查询说明改得更清楚',
    conversationHistory: [],
    documentContent: '# 告警管理',
    parsedFunctions: mutation.functions,
    tableData: [],
    userGuidelines: '',
    userConfig: {},
    modelName: 'mock-model',
    callAIWithRetry: async request => {
        capturedRequest = request;
        return {
            choices: [{
                message: {
                    content: JSON.stringify({
                        answer: '已理解。',
                        intent: 'answer',
                        needsClarification: false,
                        documentPatches: [],
                        functionChanges: [],
                        cosmicTargets: []
                    })
                }
            }]
        };
    }
});

assert.equal(planned.answer, '已理解。');
assert.equal(capturedRequest.model, 'mock-model');
assert.ok(capturedRequest.messages[0].content.includes('不要在这里生成ERWX表格'));
assert.ok(!capturedRequest.messages[0].content.includes('只输出Markdown表格'));

const serverSource = await readFile(new URL('./server/index.js', import.meta.url), 'utf8');
const chatRoute = serverSource.slice(
    serverSource.indexOf("app.post('/api/chat/stream'"),
    serverSource.indexOf('// ═══════════════════════ 导出Excel', serverSource.indexOf("app.post('/api/chat/stream'"))
);
const cosmicBatchRoute = serverSource.slice(
    serverSource.indexOf('async function executeCosmicSplitBatch'),
    serverSource.indexOf('const cosmicSplitJobManager', serverSource.indexOf('async function executeCosmicSplitBatch'))
);
assert.ok(chatRoute.includes('createConversationPlan'));
assert.ok(!chatRoute.includes('getCosmicSplitPrompt('));
assert.ok(chatRoute.includes("type: 'activity'"));
assert.ok(chatRoute.includes("id: 'planning'"));
assert.ok(chatRoute.includes("id: 'answer'"));
assert.ok(
    chatRoute.indexOf("res.setHeader('Content-Type'") < chatRoute.indexOf('createConversationPlan'),
    'SSE headers must be flushed before the long-running AI planning call'
);
assert.ok(chatRoute.includes('await streamText(answer)'));
assert.ok(cosmicBatchRoute.includes('buildCosmicSplitPrompt'));
assert.ok(cosmicBatchRoute.includes('applyEnhancedExperienceTemplatePruning'));

console.log('conversation orchestrator tests passed');
