import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { verifyGroundedCoverage } = require('./server/cosmic-coverage');
const extraction = require('./server/cosmic-extraction');
const prompts = require('./server/prompts');
const { isV4CosmicModel } = require('./server/cosmic-model-profile');
const completion = (value, finish = 'stop') => ({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: finish }] });
const emptyAudit = { coverageScore: 100, missedFunctions: [], vagueFunctions: [], suggestions: [] };
const quote = '管理员可以归档历史工单，系统保存归档日期并返回结果。';
const source = '前文说明。'.repeat(1800) + quote;
let calls = 0;
const audit = await verifyGroundedCoverage({
    documentContent: source, extractedFunctions: ['查询当前工单'], modelName: 'offline', systemPrompt: prompts.COVERAGE_VERIFICATION_PROMPT,
    callAIWithRetry: async options => {
        calls++;
        const current = options.messages[1].content.split('字符】\n')[1].split('\n【后文')[0];
        return completion(current.includes(quote) ? { ...emptyAudit, coverageScore: 50, missedFunctions: [{ functionName: '归档历史工单', documentEvidence: quote }] } : emptyAudit);
    }
});
assert.ok(calls > 1);
assert.equal(audit.missedFunctions.length, 1);
assert.equal(audit.missedFunctions[0].sourceEnd, source.length);
assert.equal(audit.sourceDiagnostics.sourceComplete, true);
assert.equal(audit.coverageScore, 50);

for (const response of [completion(emptyAudit, 'length'), completion({ ...emptyAudit, missedFunctions: [{ functionName: '删除工单', documentEvidence: '管理员可以永久删除所有工单。' }] }), completion('{}')]) {
    let attempts = 0;
    await assert.rejects(verifyGroundedCoverage({ documentContent: quote, extractedFunctions: ['查询工单'], modelName: 'offline', systemPrompt: '',
        callAIWithRetry: async () => { attempts++; return response; }
    }), /验证未完成/);
    assert.equal(attempts, 2, 'bad audit must retry once, then fail instead of reporting no omissions');
}
const controller = new AbortController();
await assert.rejects(verifyGroundedCoverage({ documentContent: quote, extractedFunctions: ['查询工单'], systemPrompt: '', signal: controller.signal,
    callAIWithRetry: async () => { controller.abort(); return completion(emptyAudit); }
}), error => error.name === 'AbortError');

// Exercise the real precise API processor without starting the web server or
// loading credentials. Huge inferred estimates must never enter model input.
const server = fs.readFileSync(new URL('./server/index.js', import.meta.url), 'utf8');
const start = server.indexOf('async function executeFunctionExtraction(');
const end = server.indexOf('const functionExtractionJobManager', start);
const record = `##触发事件：用户触发\n##功能用户：发起者：管理员 接收者：管理员\n##功能过程：归档历史工单\n##功能过程描述：管理员归档历史工单并接收结果\n##原文依据：${quote}`;
const context = vm.createContext({
    ...extraction, console: { log() {}, error() {} },
    getModelName: () => 'siliconflow-deepseek-v3.2',
    isSenseNovaV4Model: isV4CosmicModel,
    getFunctionExtractionPrompt: () => prompts.FUNCTION_EXTRACTION_PROMPT,
    getRelevantModulesForChapter: () => [],
    qualifyFunctionNames: functions => functions,
    buildFunctionListText: extraction.functionListText,
    callAIWithRetry: async options => {
        assert.ok(!options.messages.some(message => /9999|必须提取删除工单/.test(message.content)));
        return completion(record);
    }
});
vm.runInContext(server.slice(start, end) + '\nglobalThis.execute = executeFunctionExtraction;', context);
const result = await context.execute({ documentContent: quote, understanding: { totalEstimatedFunctions: 9999, coreModules: [{ moduleName: '必须提取删除工单' }] } });
assert.equal(result.count, 1);
assert.equal(result.functions[0].documentEvidence, quote);
assert.equal(result.sourceDiagnostics.reviewedChunks, 1);
assert.equal(result.countDiagnostics.target, null);
console.log('COSMIC grounded coverage and precise API processor tests passed');
