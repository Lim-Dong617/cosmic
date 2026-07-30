import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const {
    buildExcelBufferFromPlan,
    buildWordBufferFromMarkdown,
    createOfficeDocumentService,
    parseJsonResponse,
    resolveOutputFormat,
    sanitizeFilename
} = require('./server/office-document-service');

assert.equal(sanitizeFilename('季度报告?.docx'), '季度报告_');
assert.equal(resolveOutputFormat('auto', 'word', ''), 'docx');
assert.equal(resolveOutputFormat('auto', null, '生成销售台账'), 'xlsx');
assert.deepEqual(parseJsonResponse('```json\n{"ok":true}\n```'), { ok: true });

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

console.log(JSON.stringify({
    success: true,
    wordBytes: wordBuffer.length,
    excelBytes: excelResult.buffer.length,
    excelStats: excelResult.stats,
    qaDirectory
}, null, 2));
