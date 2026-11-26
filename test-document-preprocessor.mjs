import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isReferenceOnlyChapterTitle as clientIsRef } from './client/src/cosmic-quality.js';

const require = createRequire(import.meta.url);
const { preprocessDocument } = require('./server/document-preprocessor.js');
const { isReferenceOnlyChapterTitle: serverIsRef, isBoilerplateIntro } = require('./server/cosmic-quality.js');
const { extractGroundedFunctions, EMPTY_RESULT } = require('./server/cosmic-extraction.js');

// ── 1. HTML-to-Markdown lossless cleaning, anchor removal, formula `<` / `>` preservation ──
{
    const sampleHtml = `
        <p>产品需求说明书</p>
        <p>版本号：V2.0｜日期：2026年11月</p>
        <table>
            <tr><th>版本号</th><th>修订日期</th><th>修订人</th><th>修改内容</th></tr>
            <tr><td>V1.0</td><td>2026-10-01</td><td>张三</td><td>初稿</td></tr>
            <tr><td>V2.0</td><td>2026-11-01</td><td>李四</td><td>补充内容</td></tr>
        </table>
        <p><strong>目录</strong></p>
        <p><a href="#_Toc1001">1. 业务背景\t2</a></p>
        <p><a href="#_Toc1002">2. 功能需求\t3</a></p>
        <h1><a id="_Toc1001"></a>1. 业务背景</h1>
        <p>本系统面向无线网优团队建设。</p>
        <h1><a id="_Toc1002"></a><a id="section14"></a>2. 功能需求</h1>
        <h2><a id="section15"></a><strong>2.1 告警与阈值监控</strong></h2>
        <p>当掉话率&gt;1%且使用率&lt;30%时触发告警；当掉话率&lt;=1%时恢复正常。</p>
        <p>支持管理员查询告警列表并导出Excel清单。<img src="" /></p>
        <table>
            <tr><th>编号</th><th>功能名称</th><th>交互与结果</th></tr>
            <tr><td>F-01</td><td>查询告警列表</td><td>按地市、时间查询并返回分页列表</td></tr>
            <tr><td>F-02</td><td>导出告警清单</td><td>导出当前筛选结果Excel文件</td></tr>
        </table>
        <h3>2.1.1 涉及数据</h3>
        <table>
            <tr><th>编号</th><th>字段名称</th><th>类型/枚举</th><th>算法与规则说明</th><th>数据样例</th></tr>
            ${Array.from({ length: 12 }, (_, i) => `<tr><td>${i + 1}</td><td>字段${i + 1}</td><td>文本</td><td>${i === 0 ? '系统自动生成全局唯一标识（主键）' : i === 1 ? '当使用率>80%标记高负荷' : '普通说明'}</td><td>SAMPLE-${i + 1}</td></tr>`).join('')}
        </table>
        <h3>2.1.2 地市基站静态清单</h3>
        <table>
            <tr><th>地市</th><th>区县</th><th>站点编码</th></tr>
            ${Array.from({ length: 30 }, (_, i) => `<tr><td>南宁</td><td>青秀区</td><td>SITE-${i + 1}</td></tr>`).join('')}
        </table>
    `;

    const { text, stats } = preprocessDocument({ html: sampleHtml, restoreHeadings: true });
    assert.equal(stats.applied, true);
    assert.equal(stats.removedMetadataTables, 1);
    assert.equal(stats.compactedFieldTables, 1);
    assert.equal(stats.foldedLargeTables, 1);
    assert.equal(stats.preservedFunctionalTables, 1);
    assert.ok(stats.removedAnchors >= 4);
    assert.ok(stats.removedTocLines >= 2);
    assert.equal(stats.removedImages, 1);

    // Zero anchors / TOC / revision metadata left
    assert.ok(!text.includes('<a id='));
    assert.ok(!text.includes('_Toc'));
    assert.ok(!text.includes('修订人'));
    assert.ok(!text.includes('![]('));

    // Headings cleanly numbered without double prefixes or anchors
    assert.ok(text.includes('2. 功能需求'));
    assert.ok(!text.includes('1. 2. 功能需求'));
    assert.ok(text.includes('2.1 告警与阈值监控'));

    // Formula `<` / `>` and every functional requirement preserved 100%
    assert.ok(text.includes('当掉话率>1%且使用率<30%时触发告警；当掉话率<=1%时恢复正常。'));
    assert.ok(text.includes('支持管理员查询告警列表并导出Excel清单。'));
    assert.ok(text.includes('| F-01 | 查询告警列表 | 按地市、时间查询并返回分页列表 |'));
    assert.ok(text.includes('| F-02 | 导出告警清单 | 导出当前筛选结果Excel文件 |'));

    // All 12 field names + non-trivial rule notes preserved in compacted field block
    assert.ok(text.includes('【字段清单（共12项）】'));
    for (let i = 1; i <= 12; i += 1) {
        assert.ok(text.includes(`字段${i}`), `missing field 字段${i}`);
    }
    assert.ok(text.includes('当使用率>80%标记高负荷'));
    assert.ok(!text.includes('SAMPLE-12'), 'sample data boilerplate should be stripped from compacted field tables');

    // Static 30-row table folded to 5 rows + fold note
    assert.ok(text.includes('SITE-5'));
    assert.ok(!text.includes('SITE-28'));
    assert.ok(text.includes('已自动折叠其余 25 行'));
}

// ── 2. Server & Client chapter reference-only rules + boilerplate intro detection ──
{
    const referenceTitles = [
        '1. 需求概述',
        '1.1 业务背景',
        '1.2 建设目标',
        '4. 非功能性需求',
        '4.1 性能需求',
        '4.2 安全需求',
        '5. 实施计划',
        '6. 投资估算',
        '7. 术语与缩略语',
        '8. 附录：源表清单',
        '修订记录'
    ];
    for (const title of referenceTitles) {
        assert.equal(serverIsRef(title), true, `server should treat "${title}" as reference-only`);
        assert.equal(clientIsRef(title), true, `client should treat "${title}" as reference-only`);
    }

    const functionalTitles = [
        '2. 功能需求',
        '2.1 License使用详情',
        '3. 业务需求',
        '3.1 性能监控功能设计',
        '4. 安全告警管理',
        '8. 无线参数优化计划',
        '5. 智能体对话交互'
    ];
    for (const title of functionalTitles) {
        assert.equal(serverIsRef(title), false, `server must NOT skip functional title "${title}"`);
        assert.equal(clientIsRef(title), false, `client must NOT skip functional title "${title}"`);
    }

    assert.equal(isBoilerplateIntro('产品需求说明书\n版本号：V1.0\n编写人：张三\n2026年11月'), true);
    assert.equal(isBoilerplateIntro('管理员可以导出每日运行记录。'), false);
}

// ── 3. Intra-chapter chunk concurrency & deterministic ordering ──
{
    const chunks = [1, 2, 3, 4].map(i => `管理员可以查询模块${i}的运行明细列表。`.padEnd(160, '说明'));
    const documentContent = chunks.join('');
    let inFlight = 0;
    let peakInFlight = 0;

    const result = await extractGroundedFunctions({
        documentContent,
        chapterName: '3. 并发切片测试',
        modelName: 'offline-test',
        systemPrompt: '提取功能',
        chunkChars: 160,
        chunkConcurrency: 3,
        reviewPolicy: 'always',
        callAIWithRetry: async (options) => {
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            const prompt = options.messages.find(m => m.role === 'user' && m.content.includes('【当前原文】')).content;
            const current = prompt.match(/【当前原文】\n([\s\S]*?)\n【后文，仅作上下文】/)[1];
            const idx = Number(current.match(/模块(\d+)/)[1]);
            // Reverse latency so later chunks finish earlier than earlier chunks; output must still stay ordered 1..4.
            await new Promise(r => setTimeout(r, (5 - idx) * 15));
            inFlight -= 1;
            const evidence = `管理员可以查询模块${idx}的运行明细列表。`;
            return {
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        content: `##触发事件：管理员发起查询\n##功能用户：管理员\n##功能过程：查询模块${idx}运行明细\n##功能过程描述：查询模块${idx}明细\n##原文依据：${evidence}`
                    }
                }]
            };
        }
    });

    assert.ok(peakInFlight >= 2, `expected concurrent chunk execution, peakInFlight=${peakInFlight}`);
    assert.deepEqual(
        result.functions.map(f => f.functionName),
        ['查询模块1运行明细', '查询模块2运行明细', '查询模块3运行明细', '查询模块4运行明细']
    );
    assert.equal(result.sourceDiagnostics.reviewedChunks, 4);
    assert.equal(result.sourceDiagnostics.skippedReviewChunks, 0);
    assert.equal(result.sourceDiagnostics.sourceComplete, true);
}

// ── 4. Smart review policy skips clean short chunks, still reviews tables & long chunks ──
{
    const shortClean = '管理员可以查询工单列表。';
    let cleanCalls = 0;
    const cleanResult = await extractGroundedFunctions({
        documentContent: shortClean,
        chapterName: '短章测试',
        modelName: 'offline-test',
        systemPrompt: '提取功能',
        reviewPolicy: 'smart',
        callAIWithRetry: async () => {
            cleanCalls += 1;
            return {
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        content: `##触发事件：管理员查询\n##功能用户：管理员\n##功能过程：查询工单列表\n##功能过程描述：查询工单列表\n##原文依据：${shortClean}`
                    }
                }]
            };
        }
    });
    assert.equal(cleanCalls, 1, 'smart review should skip redundant 2nd pass on clean short non-table chunk');
    assert.equal(cleanResult.sourceDiagnostics.skippedReviewChunks, 1);
    assert.equal(cleanResult.sourceDiagnostics.reviewedChunks, 0);
    assert.equal(cleanResult.sourceDiagnostics.sourceComplete, true);

    const tableChunk = '| 编号 | 功能 | 说明 |\n| --- | --- | --- |\n| 1 | 导出工单 | 管理员可以导出工单列表。 |';
    let tableCalls = 0;
    const tableResult = await extractGroundedFunctions({
        documentContent: tableChunk,
        chapterName: '表格测试',
        modelName: 'offline-test',
        systemPrompt: '提取功能',
        reviewPolicy: 'smart',
        callAIWithRetry: async () => {
            tableCalls += 1;
            return {
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        content: '##触发事件：管理员导出\n##功能用户：管理员\n##功能过程：导出工单列表\n##功能过程描述：导出工单\n##原文依据：管理员可以导出工单列表。'
                    }
                }]
            };
        }
    });
    assert.equal(tableCalls, 2, 'smart review MUST still run review pass when chunk contains tables');
    assert.equal(tableResult.sourceDiagnostics.reviewedChunks, 1);
    assert.equal(tableResult.sourceDiagnostics.skippedReviewChunks, 0);

    // Long empty chunk still gets reviewed to prevent silent omissions
    const longEmpty = '项目总体架构说明。'.repeat(80);
    let emptyCalls = 0;
    await extractGroundedFunctions({
        documentContent: longEmpty,
        chapterName: '空提取复核测试',
        modelName: 'offline-test',
        systemPrompt: '提取功能',
        reviewPolicy: 'smart',
        callAIWithRetry: async () => {
            emptyCalls += 1;
            return { choices: [{ finish_reason: 'stop', message: { content: EMPTY_RESULT } }] };
        }
    });
    assert.equal(emptyCalls, 2, 'smart review MUST still review long empty chunks to catch omissions');
}

console.log('✅ document preprocessor, chapter filter, chunk concurrency & smart review tests passed');
