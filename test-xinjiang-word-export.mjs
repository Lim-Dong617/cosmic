import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { xml2js } = require('xml-js');
const { buildXinjiangWordDocument } = require('./server/xinjiang-word-export');
const { buildWordDocument } = require('./server/word-export');
const child = (node, name) => node.elements?.find(item => item.name === name);
const text = node => node?.type === 'text' ? node.text : (node?.elements || []).map(text).join('');
const descendants = (node, name) => [ ...(node?.name === name ? [node] : []), ...(node?.elements || []).flatMap(item => descendants(item, name)) ];
const visible = node => descendants(node, 'w:t').map(text).join('');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5i8AAAAASUVORK5CYII=';
const processRows = (name, modules = {}, extra = {}) => [
    { ...modules, functionalProcess: name, dataMovementType: 'E', functionalUser: '管理员', triggerEvent: '管理员提交查询', subProcessDesc: '提交查询条件', dataAttributes: '区域、基站编号', functionDescription: '根据区域和基站编号查询数据，返回符合条件的记录。', ...extra },
    { dataMovementType: 'R', subProcessDesc: '读取基站记录', dataAttributes: '基站编号、名称、状态' },
    { dataMovementType: 'X', subProcessDesc: '返回查询结果', dataAttributes: '查询结果列表' }
];
const tableData = [
    ...processRows('5G基站查询', { level1: '1. 网络运营', level2: '1.1. 资源管理', level3: '1.1.1. 基站管理' }, { requirementType: '新增' }),
    ...processRows('告警查询', {}, { requirementType: '优化' }),
    ...processRows('5G基站查询', { level1: '网络分析', level2: '资源分析', level3: '基站分析' }),
    ...processRows('工单查询', { level1: '运维管理' }),
    ...processRows('历史记录查询', { level1: '系统管理', level2: '审计管理', level3: '日志管理', level4: '历史日志' })
];
const original = await JSZip.loadAsync(await fs.readFile('server/templates/xinjiang-requirements.docx'));
const buffer = await buildXinjiangWordDocument({
    tableData, documentName: '新疆网络运营系统.xlsx',
    sequenceDiagrams: [0, 2, 4].map(processIndex => ({ processIndex, processName: tableData[processIndex * 3].functionalProcess, imageBase64: png }))
});
const zip = await JSZip.loadAsync(buffer);
const documentXml = await zip.file('word/document.xml').async('string');
const body = child(child(xml2js(documentXml), 'w:document'), 'w:body');
const headingStyles = ['4', '5', '7', '8', '9', '10'];
const counters = Array(6).fill(0);
const outline = [];
for (const p of body.elements.filter(item => item.name === 'w:p')) {
    const pPr = child(p, 'w:pPr');
    const level = headingStyles.indexOf(child(pPr || {}, 'w:pStyle')?.attributes?.['w:val']);
    if (level < 0) continue;
    assert.equal(child(pPr, 'w:numPr'), undefined, 'Heading numbers must be inherited from real heading styles');
    assert.doesNotMatch(visible(p), /^\d+(?:\.\d+)*[.、]/, 'No literal section numbers');
    counters[level]++;
    counters.fill(0, level + 1);
    outline.push({ number: counters.slice(0, level + 1).join('.'), title: visible(p) });
}
assert.deepEqual(outline.filter(item => !item.number.includes('.')).map(item => item.title),
    ['需求说明', '系统现状', '功能架构图', '功能需求', '非功能性需求（可选）', '附加值调整因子说明']);
for (const [number, title] of [
    ['4.1', '网络运营'], ['4.1.1', '资源管理'], ['4.1.1.1', '基站管理'],
    ['4.1.1.1.1', '5G基站查询（新增）'], ['4.1.1.1.2', '告警查询（优化）'],
    ['4.2.1.1.1', '5G基站查询（需求类型待确认）'],
    ['4.3.1', '未指定二级模块'], ['4.3.1.1', '未指定三级模块'],
    ['4.4.1.1.1', '历史日志'], ['4.4.1.1.1.1', '历史记录查询（需求类型待确认）']
]) assert.ok(outline.some(item => item.number === number && item.title === title), `Missing heading ${number} ${title}`);
const captions = body.elements.filter(item => visible(item).startsWith('图 4.'));
assert.deepEqual(captions.map(visible), ['图 4.1 5G基站查询时序图', '图 4.2 5G基站查询时序图', '图 4.3 历史记录查询时序图']);
for (const p of captions) {
    const previous = body.elements[body.elements.indexOf(p) - 1];
    assert.equal(descendants(previous, 'w:drawing').length, 1);
    assert.ok(child(child(previous, 'w:pPr'), 'w:keepNext'), 'Image must stay with caption');
    assert.equal(child(child(p, 'w:pPr'), 'w:jc').attributes['w:val'], 'center');
    assert.match(text(p), /SEQ XjFigure/);
}
const visibleBody = visible(body);
assert.match(visibleBody, /1\. 提交查询条件（数据字段：区域、基站编号）/);
assert.match(visibleBody, /3\. 返回查询结果（数据字段：查询结果列表）/);
assert.doesNotMatch(visible(body.elements.find(item => item.name === 'w:tbl')), /1\. 网络运营|1\.1\. 资源管理|1\.1\.1\. 基站管理/, 'Module list must not retain obsolete imported section numbers');
assert.doesNotMatch(visibleBody, /请在此处|示例：|行政楼|XXXX年|XX项目需求说明书/);
assert.match(documentXml, /TOC \\o &quot;1-6&quot;|TOC \\o "1-6"/);
for (const entry of ['word/styles.xml', 'word/numbering.xml', 'word/header1.xml', 'word/footer1.xml', 'word/theme/theme1.xml']) {
    assert.deepEqual(await zip.file(entry).async('nodebuffer'), await original.file(entry).async('nodebuffer'), `Preserve ${entry}`);
}
assert.match(await zip.file('word/settings.xml').async('string'), /<w:updateFields w:val="true"/);
assert.deepEqual(child(body, 'w:sectPr'), child(child(child(xml2js(await original.file('word/document.xml').async('string')), 'w:document'), 'w:body'), 'w:sectPr'));
for (const file of zip.file(/\.xml$/)) xml2js(await file.async('string'));

const noDiagrams = await JSZip.loadAsync(await buildXinjiangWordDocument({ tableData: processRows('查询', { level1: '模块A' }) }));
assert.doesNotMatch(await noDiagrams.file('word/document.xml').async('string'), /SEQ XjFigure/);
await assert.rejects(buildXinjiangWordDocument({ tableData: [{ dataMovementType: 'R' }] }), /未找到可导出/);
await assert.rejects(buildXinjiangWordDocument({ tableData: processRows('查询'), sequenceDiagrams: [{ processName: '查询', imageBase64: 'invalid' }] }), /有效 PNG/);

// Exercise template dispatch; real HTTP submission/download is covered by test-word-export-jobs.
const result = await buildWordDocument({ tableData, exportTemplate: 'xinjiang', documentName: '接口测试' });
assert.ok(Buffer.isBuffer(result));
assert.match(await (await JSZip.loadAsync(result)).file('word/document.xml').async('string'), /接口测试/);
console.log('新疆 Word 导出通过：六章结构、真实标题1～6、连续图题、图片绑定、合并单元格层级、缺图、同名过程、源格式保留及导出接口。');

if (process.argv.includes('--sample')) {
    const samplePng = process.argv[process.argv.indexOf('--sample') + 1];
    const sampleRows = tableData.slice(0, 6);
    const imageBase64 = samplePng ? (await fs.readFile(samplePng)).toString('base64') : png;
    const sample = await buildXinjiangWordDocument({
        tableData: sampleRows, documentName: '新疆网络运营系统',
        sequenceDiagrams: [0, 1].map(processIndex => ({ processIndex, processName: sampleRows[processIndex * 3].functionalProcess, imageBase64 }))
    });
    const output = path.resolve('outputs/xinjiang-template-qa/新疆模板导出验证.docx');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, sample);
    console.log(output);
}
