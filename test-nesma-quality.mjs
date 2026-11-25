import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
    normalizeNesmaFuncName,
    isNonFunctionalNesmaItem,
    isAtomicSubstepNoise,
    sanitizeNesmaTableData,
    buildNesmaBatchDocumentExcerpt
} = require('./server/nesma-quality.js');
const {
    NESMA_FUNCTION_EXTRACTION_PROMPT,
    NESMA_MODULE_RECOGNITION_PROMPT,
    NESMA_COVERAGE_VERIFICATION_PROMPT
} = require('./server/nesma-prompts.js');

// 1. 禁用词"报表"自动规范化
assert.equal(normalizeNesmaFuncName('指令操作统计报表'), '指令操作统计分析');
assert.equal(normalizeNesmaFuncName('指令操作审计汇总报表'), '指令操作审计汇总');
assert.equal(normalizeNesmaFuncName('网络质量呈现报表'), '网络质量展示页面');
assert.equal(normalizeNesmaFuncName('华为5G小区数量统计计算'), '华为5G小区数量统计计算');

// 2. 非功能/界面废话识别（不误伤真实业务与国产化前端迁移）
assert.equal(
    isNonFunctionalNesmaItem({
        funcName: '系统界面配置信息',
        funcDescription: '存储系统界面主题、浏览器兼容性等配置信息'
    }),
    true
);
assert.equal(
    isNonFunctionalNesmaItem({
        funcName: '修改系统界面主题配置',
        funcDescription: '配置系统界面采用深蓝主题'
    }),
    true
);
assert.equal(
    isNonFunctionalNesmaItem({
        funcName: '华为5G小区配置信息',
        funcDescription: '存储华为5G小区配置数据'
    }),
    false
);
assert.equal(
    isNonFunctionalNesmaItem(
        {
            funcName: '前端迁移进度信息页面',
            funcDescription: '查看浏览器兼容性改造进度',
            migrationDimension: '前端应用迁移'
        },
        { extractionMode: 'guochanhua' }
    ),
    false
);

// 3. 原子基本过程拆碎项拦截 + 保留独立业务分支
const atomicRows = [
    { level1: '管理', level2: '华为性能', level3: '华为性能采集', funcName: '定时采集华为性能KPI数据', category: 'EI' },
    { level1: '管理', level2: '华为性能', level3: '华为性能采集', funcName: '华为性能KPI数据入库', category: 'EI' },
    { level1: '管理', level2: '华为性能', level3: '华为性能采集', funcName: '华为性能数据FTP入库', category: 'EI' },
    { level1: '管理', level2: '中兴告警', level3: '中兴告警接收', funcName: '接收中兴网管告警推送', category: 'EI' },
    { level1: '管理', level2: '中兴告警', level3: '中兴告警接收', funcName: '中兴告警数据入库', category: 'EI' },
    { level1: '管理', level2: '中兴告警', level3: '中兴告警接收', funcName: '返回告警同步回执', category: 'EO' },
    { level1: '管理', level2: '质差工单', level3: '质差工单审批', funcName: '审批质差问题工单', category: 'EI' },
    { level1: '管理', level2: '质差工单', level3: '质差工单审批', funcName: '更新工单审批状态', category: 'EI' },
    { level1: '管理', level2: '质差工单', level3: '质差工单审批', funcName: '记录审批意见', category: 'EI' },
    { level1: '管理', level2: '质差工单', level3: '质差工单审批', funcName: '质差问题工单审批通过', category: 'EI' },
    { level1: '管理', level2: '质差工单', level3: '质差工单审批', funcName: '质差问题工单审批驳回', category: 'EI' }
];
assert.equal(isAtomicSubstepNoise(atomicRows[1], atomicRows), true);  // 华为性能KPI数据入库
assert.equal(isAtomicSubstepNoise(atomicRows[2], atomicRows), false); // FTP入库保留
assert.equal(isAtomicSubstepNoise(atomicRows[4], atomicRows), true);  // 中兴告警数据入库
assert.equal(isAtomicSubstepNoise(atomicRows[5], atomicRows), true);  // 返回告警同步回执
assert.equal(isAtomicSubstepNoise(atomicRows[7], atomicRows), true);  // 更新工单审批状态
assert.equal(isAtomicSubstepNoise(atomicRows[8], atomicRows), true);  // 记录审批意见
assert.equal(isAtomicSubstepNoise(atomicRows[9], atomicRows), false); // 审批通过保留
assert.equal(isAtomicSubstepNoise(atomicRows[10], atomicRows), false); // 审批驳回保留

// 4. 精准模式综合净化：保多厂家独立，去非功能/去原子拆碎/去单字段筛选/去兄弟模块重复
const rawMixed = [
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.1 华为5G小区配置与性能采集', level3: '2.1.1 华为小区配置管理', funcName: '华为5G小区配置信息', category: 'ILF' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.1 华为5G小区配置与性能采集', level3: '2.1.1 华为小区配置管理', funcName: '新增华为5G小区配置', category: 'EI' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.1 华为5G小区配置与性能采集', level3: '2.1.1 华为小区配置管理', funcName: '华为5G小区配置信息页面', category: 'EQ' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.1 华为5G小区配置与性能采集', level3: '2.1.1 华为小区配置管理', funcName: '华为5G小区配置按地市筛选', category: 'EQ' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.1 华为5G小区配置与性能采集', level3: '2.1.1 华为小区配置管理', funcName: '华为5G小区配置导出', category: 'EQ' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.1 华为5G小区配置与性能采集', level3: '2.1.2 华为小区查询统计', funcName: '华为5G小区基础信息页面', category: 'EQ' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.1 华为5G小区配置与性能采集', level3: '2.1.2 华为小区查询统计', funcName: '华为5G小区数据导出', category: 'EQ' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.1 华为5G小区配置与性能采集', level3: '2.1.2 华为小区查询统计', funcName: '华为5G小区统计报表', category: 'EO' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.2 中兴5G小区配置与告警接收', level3: '2.2.1 中兴小区配置管理', funcName: '中兴5G小区配置信息', category: 'ILF' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.2 中兴5G小区配置与告警接收', level3: '2.2.1 中兴小区配置管理', funcName: '新增中兴5G小区配置', category: 'EI' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.2 中兴5G小区配置与告警接收', level3: '2.2.1 中兴小区配置管理', funcName: '中兴5G小区配置信息页面', category: 'EQ' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.3 质差问题工单处理', level3: '2.3.1 质差工单管理', funcName: '系统界面配置信息', category: 'ILF', funcDescription: '存储系统界面主题、浏览器兼容性等配置信息' },
    { level1: '2 华为与中兴5G小区数据及告警管理', level2: '2.3 质差问题工单处理', level3: '2.3.1 质差工单管理', funcName: '修改系统界面主题配置', category: 'EI', funcDescription: '配置系统界面采用深蓝主题' }
];

const preciseRes = sanitizeNesmaTableData(rawMixed, { extractionMode: 'precise' });
const preciseNames = preciseRes.tableData.map(r => r.funcName);
assert.equal(preciseRes.diagnostics.removedNonFunctionalCount, 2);
assert.equal(preciseRes.diagnostics.removedTrivialFilterCount, 1);
assert.equal(preciseRes.diagnostics.removedDuplicateCount, 2);
assert.equal(preciseRes.diagnostics.normalizedReportNameCount, 1);
assert.ok(preciseNames.includes('华为5G小区配置信息'));
assert.ok(preciseNames.includes('中兴5G小区配置信息'));
assert.ok(preciseNames.includes('新增华为5G小区配置'));
assert.ok(preciseNames.includes('新增中兴5G小区配置'));
assert.ok(preciseNames.includes('华为5G小区配置信息页面'));
assert.ok(preciseNames.includes('中兴5G小区配置信息页面'));
assert.ok(preciseNames.includes('华为5G小区统计分析'));
assert.ok(!preciseNames.some(n => n.includes('报表')));
assert.ok(!preciseNames.includes('华为5G小区配置按地市筛选'));
assert.ok(!preciseNames.includes('华为5G小区基础信息页面'));
assert.ok(!preciseNames.includes('华为5G小区数据导出'));

// 数量优先模式保留单字段筛选
const quantityRes = sanitizeNesmaTableData(rawMixed, { extractionMode: 'quantity' });
assert.ok(quantityRes.tableData.some(r => r.funcName === '华为5G小区配置按地市筛选'));

// 5. 长文档切片测试
const longDoc = [
    '1 概述\n' + '无关背景介绍。'.repeat(2000),
    '2.1 华为5G小区配置\n管理员可新增和查询华为5G小区配置数据。',
    '3 附录\n' + '其他内容。'.repeat(2000)
].join('\n');
const excerpt = buildNesmaBatchDocumentExcerpt(longDoc, [{ level1: '2 管理', level2: '2.1 华为5G小区配置', level3: '2.1.1 华为5G小区配置管理', businessObjects: ['华为5G小区配置数据'] }], 2000);
assert.ok(excerpt.length <= 2000);
assert.ok(excerpt.includes('华为5G小区配置'));

// 6. 提示词一致性检查（不再自相矛盾）
assert.ok(!NESMA_FUNCTION_EXTRACTION_PROMPT.includes('指令操作统计报表'));
assert.ok(!NESMA_FUNCTION_EXTRACTION_PROMPT.includes('操作审计统计报表'));
assert.ok(!NESMA_COVERAGE_VERIFICATION_PROMPT.includes('统计报表/呈现报表/汇总报表'));
assert.ok(NESMA_MODULE_RECOGNITION_PROMPT.includes('严禁将同一业务对象的“配置/录入”和“查询/统计”硬拆成两个并列三级模块'));

// 7. COSMIC 阶段2 makeUniqueName 去叠字测试
const indexSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'index.js'), 'utf8');
const fnStart = indexSrc.indexOf('function mergePrefixOverlap(');
const fnEnd = indexSrc.indexOf('function getRowProcessName(');
assert.ok(fnStart > 0 && fnEnd > fnStart, 'mergePrefixOverlap & makeUniqueName should exist in server/index.js');
const ctx = vm.createContext({});
vm.runInContext(indexSrc.slice(fnStart, fnEnd), ctx);

const existing = new Set(['华为5g小区配置数据表', '中兴5g小区配置数据表', '质差问题工单表']);
const u1 = ctx.makeUniqueName('华为5G小区配置数据表', '查询华为5G小区列表', existing);
assert.equal(u1, '查询华为5G小区配置数据表');
assert.ok(!u1.includes('华为华为'));

const u2 = ctx.makeUniqueName('中兴5G小区配置数据表', '查询中兴5G小区列表', existing);
assert.equal(u2, '查询中兴5G小区配置数据表');
assert.ok(!u2.includes('中兴中兴'));

const u3 = ctx.makeUniqueName('质差问题工单表', '审批质差问题工单', existing);
assert.equal(u3, '审批质差问题工单表');
assert.ok(!u3.includes('质差质差'));
existing.add(u3.toLowerCase());

const u4 = ctx.makeUniqueName('质差问题工单表', '审批质差问题工单', existing);
assert.equal(u4, '审批质差问题工单状态表');
assert.ok(!u4.includes('质差质差') && !u4.includes('质差问题质差问题'));

console.log('test-nesma-quality.mjs passed!');
