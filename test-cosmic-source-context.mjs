import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { attachFunctionEvidence, buildFunctionSourceContext } from './client/src/cosmic-source-context.js';

const require = createRequire(import.meta.url);
const quality = require('./server/cosmic-quality.js');
const server = fs.readFileSync(new URL('./server/index.js', import.meta.url), 'utf8');
const extractFunction = (name, nextMarker) => server.slice(
    server.indexOf(`function ${name}(`),
    server.indexOf(nextMarker, server.indexOf(`function ${name}(`))
);
// Evaluate the production chapter functions without starting Express or loading credentials.
const chapterContext = vm.createContext({ ...quality, console });
vm.runInContext(
    extractFunction('extractHeadingLevel', '\n/**')
    + extractFunction('splitIntoChapters', "\napp.post('/api/split-chapters'")
    + '\nglobalThis.split = splitIntoChapters;', chapterContext
);
const compactDocument = '管理员可以导出每日运行记录。\n\n# 新增告警\n支持创建告警。\n\n# 删除告警\n管理员删除告警。';
const compactChapters = chapterContext.split(compactDocument);
assert.equal(compactChapters.length, 3);
assert.equal(compactChapters[0].title, '文档开头');
assert.ok(compactChapters.every(chapter => chapter.selected));
assert.ok(compactChapters.some(chapter => chapter.content.includes('支持创建告警。')));
assert.ok(compactChapters.some(chapter => chapter.content.includes('管理员删除告警。')));
const referenceChapters = chapterContext.split('# 新增告警\n支持创建告警。\n# 附录\n名词解释。');
assert.equal(referenceChapters.find(chapter => chapter.title === '附录').selected, false);

const evidence = '管理员确认归档后，系统将历史订单状态改为已归档，并返回归档记录。';
const tailChapter = '# 历史归档\n' + '历史说明。'.repeat(1200) + evidence;
const longDocument = '# 首页\n' + '仅展示首页。'.repeat(3000) + '\n' + tailChapter;
const func = { functionName: '归档历史订单', sourceChapter: '历史归档', documentEvidence: evidence };
const context = buildFunctionSourceContext(longDocument, [func], [{ title: '历史归档', content: tailChapter }]);
assert.ok(context.includes(evidence), 'Late-document evidence must reach the batch');
assert.ok(!context.includes('仅展示首页'), 'Unrelated beginning must not replace batch evidence');

const secondEvidence = '业务员提交退款申请后，系统写入退款单并通知复核人。';
const twoContexts = buildFunctionSourceContext(longDocument + '\n' + secondEvidence, [func, {
    functionName: '提交退款申请', documentEvidence: secondEvidence
}], [{ title: '历史归档', content: tailChapter }]);
assert.ok(twoContexts.includes(evidence));
assert.ok(twoContexts.includes(secondEvidence));
const largeQuote = '保留完整依据'.repeat(1000);
assert.ok(buildFunctionSourceContext(largeQuote, [{ functionName: '记录依据', documentEvidence: largeQuote }], [], 1000).includes(largeQuote));
assert.equal(buildFunctionSourceContext(longDocument, [{ functionName: '不存在的功能', documentEvidence: '伪造原文' }]), '');
assert.equal(buildFunctionSourceContext('支持查询任务。', [{ functionName: '任务查询' }]), '支持查询任务。');

const retained = attachFunctionEvidence([
    { functionName: '查询记录', sourceChapter: '模块乙' },
    { functionName: '查询记录', sourceChapter: '模块甲' }
], [
    { functionName: '查询记录', sourceChapter: '模块甲', documentEvidence: '甲查询原文', sourceStart: 3, sourceEnd: 8 },
    { functionName: '查询记录', sourceChapter: '模块乙', documentEvidence: '乙查询原文', sourceStart: 9, sourceEnd: 14 }
]);
assert.equal(retained[0].documentEvidence, '乙查询原文');
assert.equal(retained[1].sourceStart, 3);

// Exercise the actual client request wrapper: one chapter failure must not prevent
// a later chapter from running or masquerade as complete source processing.
const app = fs.readFileSync(new URL('./client/src/App.jsx', import.meta.url), 'utf8');
const trackedStart = app.indexOf('const requestTrackedExtraction = async');
const trackedEnd = app.indexOf('const parseCollectedFunctions', trackedStart);
const calls = [];
const trackedContext = vm.createContext({
    signal: new AbortController().signal,
    extractedWithEvidence: [], sourceDiagnostics: [], failedChapters: [],
    requestFunctionExtraction: async payload => {
        calls.push(payload.chapterName);
        if (payload.chapterName === '第二章') throw new Error('上游超时');
        if (payload.chapterName === '第四章') return { data: { success: true, sourceDiagnostics: { sourceComplete: false } } };
        return { data: { success: true, functions: [{ functionName: `${payload.chapterName}查询`, documentEvidence: '实际原文' }], sourceDiagnostics: { sourceComplete: true, completedChunks: 1 } } };
    }
});
vm.runInContext(app.slice(trackedStart, trackedEnd) + '\nglobalThis.track = requestTrackedExtraction;', trackedContext);
for (const chapterName of ['第一章', '第二章', '第三章', '第四章']) await trackedContext.track({ chapterName }, {});
assert.deepEqual(calls, ['第一章', '第二章', '第三章', '第四章']);
assert.equal(trackedContext.extractedWithEvidence.length, 2);
assert.equal(trackedContext.failedChapters.length, 2);
assert.equal(trackedContext.failedChapters[0].title, '第二章');
assert.equal(trackedContext.failedChapters[1].title, '第四章');

console.log('COSMIC chapter preservation, source context, evidence retention and chapter failure checks passed.');
