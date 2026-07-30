import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const {
    buildLogicalGroupBatches,
    buildMergeAlignedRowBatches,
    buildWorksheetLogicalGroups,
    buildExcelBufferFromPlan,
    buildWordBufferFromMarkdown,
    createOfficeDocumentService,
    isTruncatedFinishReason,
    parseJsonResponse,
    resolveOutputFormat,
    sanitizeFilename,
    shouldUseBatchedExcelPlanning
} = require('./server/office-document-service');

assert.equal(sanitizeFilename('季度报告?.docx'), '季度报告_');
assert.equal(resolveOutputFormat('auto', 'word', ''), 'docx');
assert.equal(resolveOutputFormat('auto', null, '生成销售台账'), 'xlsx');
assert.deepEqual(parseJsonResponse('```json\n{"ok":true}\n```'), { ok: true });
assert.throws(
    () => parseJsonResponse('{"operations":[{"type":"setCell"}'),
    error => error.code === 'AI_JSON_INVALID'
);
assert.equal(isTruncatedFinishReason('length'), true);
assert.equal(isTruncatedFinishReason('max_tokens'), true);
assert.equal(isTruncatedFinishReason('end_turn'), false);

const batchBoundaryWorkbook = new ExcelJS.Workbook();
const batchBoundarySheet = batchBoundaryWorkbook.addWorksheet('功能点拆分');
batchBoundarySheet.addRow(['功能过程', '功能描述']);
for (let row = 2; row <= 181; row += 1) {
    batchBoundarySheet.addRow([`过程${row}`, '']);
}
batchBoundarySheet.mergeCells('A58:A75');
batchBoundarySheet.getCell('B58').font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF123456' } };
batchBoundarySheet.getCell('B58').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
batchBoundarySheet.mergeCells('B58:B70');
const mergeAlignedBatches = buildMergeAlignedRowBatches(batchBoundarySheet, 2, 181, 60);
assert.deepEqual(mergeAlignedBatches, [
    { startRow: 2, endRow: 75 },
    { startRow: 76, endRow: 135 },
    { startRow: 136, endRow: 181 }
]);
const logicalGroups = buildWorksheetLogicalGroups(batchBoundarySheet, 2, 181, 1, 1);
assert.equal(logicalGroups.length, 163);
assert.deepEqual(
    logicalGroups.find(group => group.startRow === 58),
    {
        groupId: 'S1-R58-75',
        startRow: 58,
        endRow: 75,
        groupValue: '过程58',
        rows: logicalGroups.find(group => group.startRow === 58).rows
    }
);
assert.equal(buildLogicalGroupBatches(logicalGroups).length, 5);
assert.equal(shouldUseBatchedExcelPlanning(
    { kind: 'excel', workbook: batchBoundaryWorkbook },
    '给每一个功能过程生成一条功能描述，合并单元格与功能过程对齐'
), true);
assert.equal(shouldUseBatchedExcelPlanning(
    { kind: 'excel', workbook: batchBoundaryWorkbook },
    '统一表头颜色'
), false);

const wordBuffer = await buildWordBufferFromMarkdown({
    title: '办公文档模块验收报告',
    subtitle: '结构与排版烟雾测试',
    markdown: `## 验收范围

本次验收覆盖 **Word 生成**、真实列表和表格结构。

- 保留事实和关键内容
- 使用清晰的标题层级

1. 读取用户任务
2. 生成可编辑文档

| 检查项 | 结果 | 说明 |
|---|---|---|
| 标题层级 | 通过 | 使用 Word 标题样式 |
| 表格结构 | 通过 | 使用真实表格对象 |`
});
assert.ok(wordBuffer.length > 3000);
const wordZip = await JSZip.loadAsync(wordBuffer);
const documentXml = await wordZip.file('word/document.xml').async('string');
assert.match(documentXml, /办公文档模块验收报告/);
assert.match(documentXml, /<w:tbl>/);
assert.match(documentXml, /<w:numPr>/);

const excelPlan = {
    summary: '生成项目台账',
    filename: '项目台账',
    applyProfessionalFormatting: true,
    sheets: [{
        name: '项目明细',
        title: '项目执行台账',
        headers: ['项目', '预算', '实际', '执行率', '状态'],
        rows: [
            ['项目A', 100000, 60000, { formula: 'C4/B4', numberFormat: '0.0%' }, '进行中'],
            ['项目B', 80000, 80000, { formula: 'C5/B5', numberFormat: '0.0%' }, '已完成']
        ],
        freezeHeader: true,
        autoFilter: true
    }],
    operations: [{
        type: 'dataValidation',
        sheet: '项目明细',
        range: 'E4:E5',
        values: ['未开始', '进行中', '已完成']
    }]
};
const excelResult = await buildExcelBufferFromPlan({
    plan: excelPlan,
    instruction: '生成项目执行台账'
});
assert.ok(excelResult.buffer.length > 4000);
assert.equal(excelResult.stats.sheetCount, 1);
assert.equal(excelResult.stats.formulaCount, 2);
assert.equal(excelResult.stats.errorCount, 0);

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(excelResult.buffer);
const worksheet = workbook.getWorksheet('项目明细');
assert.ok(worksheet);
assert.equal(worksheet.getCell('D4').value.formula, 'C4/B4');
assert.equal(worksheet.getCell('D4').numFmt, '0.0%');
assert.equal(worksheet.getCell('E4').dataValidation.type, 'list');
assert.equal(worksheet.views[0].state, 'frozen');

const fakeCallAI = async options => {
    const isExcel = options.messages?.[0]?.content?.includes('Excel 数据整理');
    const payload = isExcel
        ? {
            summary: '已生成示例清单',
            filename: '示例清单',
            applyProfessionalFormatting: true,
            sheets: [{
                name: '清单',
                headers: ['事项', '负责人', '状态'],
                rows: [['准备材料', '待补充', '未开始']]
            }],
            operations: []
        }
        : {
            summary: '已生成示例方案',
            filename: '示例方案',
            title: '示例实施方案',
            subtitle: '',
            contentMarkdown: '## 目标\n\n形成一份可执行的实施方案。\n\n## 步骤\n\n1. 明确范围\n2. 推进实施'
        };
    return {
        choices: [{ message: { content: JSON.stringify(payload) } }]
    };
};

const service = createOfficeDocumentService({
    callAIWithRetry: fakeCallAI,
    getModelName: () => 'test-model'
});
const generatedWord = await service.process({
    instruction: '生成一份实施方案',
    outputFormat: 'docx'
});
assert.equal(generatedWord.format, 'docx');
assert.match(generatedWord.filename, /\.docx$/);

const generatedExcel = await service.process({
    instruction: '生成一份事项清单 Excel',
    outputFormat: 'xlsx'
});
assert.equal(generatedExcel.format, 'xlsx');
assert.match(generatedExcel.filename, /\.xlsx$/);
assert.equal(generatedExcel.stats.errorCount, 0);

let jsonRetryCalls = 0;
const retryService = createOfficeDocumentService({
    callAIWithRetry: async () => {
        jsonRetryCalls += 1;
        if (jsonRetryCalls === 1) {
            return {
                choices: [{
                    message: { content: '{"summary":"未完成","contentMarkdown":"内容"' },
                    finish_reason: 'max_tokens'
                }]
            };
        }
        return {
            choices: [{
                message: {
                    content: JSON.stringify({
                        summary: '自动重试成功',
                        filename: '重试结果',
                        title: '重试结果',
                        subtitle: '',
                        contentMarkdown: '## 结果\n\n截断后已自动重新生成。'
                    })
                },
                finish_reason: 'stop'
            }]
        };
    },
    getModelName: () => 'test-model'
});
const retriedWord = await retryService.process({
    instruction: '生成一份重试测试文档',
    outputFormat: 'docx'
});
assert.equal(retriedWord.format, 'docx');
assert.equal(jsonRetryCalls, 2);

const qaDirectory = path.join(os.tmpdir(), 'office-document-module-qa');
await fs.mkdir(qaDirectory, { recursive: true });
const wordQaPath = path.join(qaDirectory, 'office-word-smoke.docx');
const excelQaPath = path.join(qaDirectory, 'office-excel-smoke.xlsx');
await fs.writeFile(wordQaPath, wordBuffer);
await fs.writeFile(excelQaPath, excelResult.buffer);

const inspectedWord = await service.inspect({
    path: wordQaPath,
    originalname: 'office-word-smoke.docx',
    size: wordBuffer.length
});
assert.equal(inspectedWord.kind, 'word');
assert.ok(inspectedWord.metadata.characters > 30);
assert.match(inspectedWord.preview, /验收范围/);

const inspectedExcel = await service.inspect({
    path: excelQaPath,
    originalname: 'office-excel-smoke.xlsx',
    size: excelResult.buffer.length
});
assert.equal(inspectedExcel.kind, 'excel');
assert.equal(inspectedExcel.metadata.sheetCount, 1);
assert.equal(inspectedExcel.metadata.formulaCount, 2);

const batchedSourcePath = path.join(qaDirectory, 'office-batched-source.xlsx');
await batchBoundaryWorkbook.xlsx.writeFile(batchedSourcePath);
let blueprintCalls = 0;
let groupBatchCalls = 0;
let omittedOneGroup = false;
let missingOnlyRetryCount = 0;
const batchedService = createOfficeDocumentService({
    callAIWithRetry: async options => {
        const systemPrompt = String(options.messages?.[0]?.content || '');
        if (systemPrompt.includes('Excel 批量处理规划专家')) {
            blueprintCalls += 1;
            return {
                choices: [{
                    message: {
                        content: JSON.stringify({
                            summary: '已批量补充功能描述',
                            filename: '功能点拆分_已补充描述',
                            applyProfessionalFormatting: false,
                            // 即使模型漏掉模式、列信息并低估结尾，系统也会从任务和表头中确定性推断。
                            targetSheets: [{
                                name: '功能点拆分',
                                dataStartRow: 2,
                                dataEndRow: 170
                            }],
                            setupOperations: [],
                            batchInstruction: '在功能描述列填写当前功能过程对应的简要描述'
                        })
                    },
                    finish_reason: 'stop'
                }]
            };
        }
        if (systemPrompt.includes('Excel 业务文本生成器')) {
            groupBatchCalls += 1;
            const userPrompt = String(options.messages?.find(message => message.role === 'user')?.content || '');
            const groupsMatch = userPrompt.match(/待生成分组：\n(\[[\s\S]*\])$/);
            assert.ok(groupsMatch);
            const groups = JSON.parse(groupsMatch[1]);
            let returnedGroups = groups;
            if (!omittedOneGroup && groups.length > 1) {
                returnedGroups = groups.slice(0, -1);
                omittedOneGroup = true;
            } else if (omittedOneGroup && groups.length === 1) {
                missingOnlyRetryCount += 1;
            }
            return {
                choices: [{
                    message: {
                        content: JSON.stringify({
                            items: returnedGroups.map(group => ({
                                groupId: group.groupId,
                                text: `描述 ${group.groupId}`
                            }))
                        })
                    },
                    finish_reason: 'stop'
                }]
            };
        }
        throw new Error('测试收到了未预期的 AI 提示词');
    },
    getModelName: () => 'test-model'
});
const batchedResult = await batchedService.process({
    file: {
        path: batchedSourcePath,
        originalname: '功能点拆分.xlsx',
        size: (await fs.stat(batchedSourcePath)).size
    },
    instruction: '给每一个功能过程生成一条功能描述，合并单元格与功能过程对齐',
    outputFormat: 'xlsx'
});
assert.equal(blueprintCalls, 1);
assert.equal(groupBatchCalls, 6);
assert.equal(missingOnlyRetryCount, 1);
assert.equal(batchedResult.stats.executionMode, 'groupedText');
assert.equal(batchedResult.stats.batchCount, 5);
assert.equal(batchedResult.stats.groupCount, 163);
assert.equal(batchedResult.stats.generatedTextCount, 163);
assert.equal(batchedResult.stats.processedRows, 180);
const batchedOutputWorkbook = new ExcelJS.Workbook();
await batchedOutputWorkbook.xlsx.load(batchedResult.buffer);
const batchedOutputSheet = batchedOutputWorkbook.getWorksheet('功能点拆分');
assert.equal(batchedOutputSheet.getCell('B2').value, '描述 S1-R2-2');
assert.equal(batchedOutputSheet.getCell('B58').value, '描述 S1-R58-75');
assert.ok(batchedOutputSheet.model.merges.includes('B58:B75'));
assert.ok(!batchedOutputSheet.model.merges.includes('B58:B70'));
assert.equal(batchedOutputSheet.getCell('B58').font.bold, true);
assert.equal(batchedOutputSheet.getCell('B58').font.color.argb, 'FF123456');
assert.equal(batchedOutputSheet.getCell('B58').fill.fgColor.argb, 'FFF1F5F9');

console.log(JSON.stringify({
    success: true,
    wordBytes: wordBuffer.length,
    excelBytes: excelResult.buffer.length,
    excelStats: excelResult.stats,
    qaDirectory
}, null, 2));
