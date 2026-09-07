// Opt-in live smoke tests. Uses synthetic requirements only; never uploads the
// user's local business documents. Requires SILICONFLOW_API_KEY in the runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config();
const { callAIWithRetry, SILICONFLOW_MODEL_ALIAS, resolveModelRoute } = require('../server/ai-client');
const { extractGroundedFunctions } = require('../server/cosmic-extraction');
const { V3_2_FUNCTION_EXTRACTION_PROMPT } = require('../server/prompts');

const route = resolveModelRoute(SILICONFLOW_MODEL_ALIAS);
if (!route.apiKey) {
    console.error('未执行在线测试：请在运行环境配置 SILICONFLOW_API_KEY。不要将密钥写入测试报告或版本库。');
    process.exit(2);
}
assert.match(route.requestModelName, /v3\.2/i, 'Live test must use V3.2');

const query = '值班员输入状态和日期范围查询巡检任务，系统在同一列表展示任务编号、名称和执行状态；筛选与排序是该次查询的条件。';
const create = '管理员提交新增巡检计划请求，系统保存计划并返回计划编号。';
const remove = '管理员单独提交删除巡检计划请求，系统删除指定计划并返回删除结果。';
const tail = '档案员单独提交归档历史工单请求，系统保存归档日期并返回归档结果。';
const background = '本段为文档编写背景与术语说明，没有新增业务操作要求。状态是记录的一个属性，编号是记录的标识，日期使用年月日格式。\n';
const cases = [
    { id: 'short-query', text: query, expected: 1, anchors: [/查询.*巡检任务|巡检任务.*查询/] },
    { id: 'short-independent-operations', text: `${create}\n${remove}`, expected: 2, anchors: [/(新增|创建).*巡检计划/, /删除.*巡检计划/] },
    { id: 'no-functional-requirements', text: '文档名称：巡检系统背景材料。本文仅记录项目简称与编写日期，尚无业务操作需求。', expected: 0, anchors: [] },
    { id: 'long-tail', text: `${query}\n${background.repeat(340)}\n${tail}`, expected: 2, anchors: [/查询.*巡检任务|巡检任务.*查询/, /归档.*历史工单|历史工单.*归档/] }
];
const startedAt = new Date().toISOString();
const report = { startedAt, model: route.requestModelName, syntheticInputsOnly: true, cases: [] };
let failed = false;
for (const sample of cases) {
    const started = Date.now();
    try {
        console.log(`开始 ${sample.id}：${sample.text.length} 字`);
        const result = await extractGroundedFunctions({
            documentContent: sample.text, chapterName: '全文', modelName: SILICONFLOW_MODEL_ALIAS,
            systemPrompt: V3_2_FUNCTION_EXTRACTION_PROMPT, callAIWithRetry,
            signal: AbortSignal.timeout(20 * 60 * 1000),
            onProgress: progress => console.log(`${sample.id}: ${progress.message}`)
        });
        const names = result.functions.map(func => func.functionName);
        const checks = {
            expectedCount: names.length === sample.expected,
            expectedBusinessActions: sample.anchors.every(anchor => names.some(name => anchor.test(name))),
            sourceComplete: result.sourceDiagnostics.sourceComplete,
            allEvidenceFound: result.functions.every(func => sample.text.slice(func.sourceStart, func.sourceEnd) === func.documentEvidence),
            tailCovered: sample.id !== 'long-tail' || result.functions.some(func => func.sourceEnd > 16000 && func.documentEvidence.includes('归档'))
        };
        const passed = Object.values(checks).every(Boolean);
        report.cases.push({ id: sample.id, sourceChars: sample.text.length, durationMs: Date.now() - started, passed, checks, expectedCount: sample.expected, names, ...result });
        if (!passed) failed = true;
        console.log(`${sample.id}: ${passed ? '通过' : '未通过'}，提取 ${names.length} 项`);
    } catch (error) {
        failed = true;
        report.cases.push({ id: sample.id, passed: false, durationMs: Date.now() - started, errorCode: error.code || error.name, status: error.status || null });
        console.error(`${sample.id}: 调用未完成（${error.code || error.name}）`);
    }
}
await fs.mkdir(new URL('../outputs/', import.meta.url), { recursive: true });
const filename = `cosmic-v32-live-${startedAt.replace(/[:.]/g, '-')}.json`;
await fs.writeFile(new URL(`../outputs/${filename}`, import.meta.url), JSON.stringify(report, null, 2));
console.log(`在线测试报告：outputs/${filename}`);
process.exitCode = failed ? 1 : 0;
