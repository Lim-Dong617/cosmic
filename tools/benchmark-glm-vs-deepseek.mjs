import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const {
    COSMIC_QUANTITY_PRIORITY_PROMPT,
    buildCosmicSplitPrompt
} = require('../server/prompts');

const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const API_KEY = process.env.VOLCENGINE_API_KEY;

const MODELS = [
    { alias: 'glm-5.2', id: process.env.BENCH_GLM_MODEL || 'glm-5-2-260617' },
    { alias: 'deepseek-v4-pro', id: process.env.BENCH_DEEPSEEK_MODEL || 'deepseek-v4-pro-260425' }
];

if (!API_KEY) {
    throw new Error('缺少 VOLCENGINE_API_KEY，无法运行在线模型对比');
}

const EXTRACTION_TARGET = 16;
const EXTRACTION_DOCUMENT = `# 告警闭环管理

本模块明确包含以下16项业务能力，每一项都有独立入口、独立业务结果，不允许合并：
1. 用户新建无线告警规则并保存规则记录。
2. 用户修改既有无线告警规则并保存新版本。
3. 用户删除无线告警规则并返回删除结果。
4. 用户按条件查询无线告警规则列表。
5. 用户查看单条无线告警规则详情。
6. 用户启用无线告警规则并记录启用状态。
7. 用户停用无线告警规则并记录停用状态。
8. 用户复制无线告警规则形成一条新规则。
9. 用户批量导入无线告警规则文件并返回导入结果。
10. 用户导出无线告警规则清单文件。
11. 系统每天定时从综合网管同步无线告警数据。
12. 系统每五分钟定时检测无线告警阈值。
13. 系统对超过阈值的数据定时生成无线告警预警记录。
14. 系统定时向值班人员发送无线告警通知。
15. 外部工单系统调用本系统接口写入告警工单数据。
16. 外部运维平台调用本系统接口查询告警统计结果。

以上16项必须逐项形成独立功能过程。`;

const EXTRACTION_ANCHORS = [
    ['新建规则', /(?:新建|创建|新增).*无线告警规则/],
    ['修改规则', /(?:修改|编辑).*无线告警规则/],
    ['删除规则', /删除.*无线告警规则/],
    ['查询列表', /(?:查询|查看).*无线告警规则.*(?:列表|清单)/],
    ['查看详情', /(?:查看|查询).*无线告警规则.*详情/],
    ['启用规则', /启用.*无线告警规则/],
    ['停用规则', /停用.*无线告警规则/],
    ['复制规则', /复制.*无线告警规则/],
    ['导入规则', /导入.*无线告警规则/],
    ['导出规则', /导出.*无线告警规则/],
    ['同步告警', /(?:定时.*同步|同步.*告警).*综合网管|定时.*同步.*无线告警/],
    ['检测阈值', /定时.*检测.*无线告警阈值/],
    ['生成预警', /定时.*生成.*无线告警预警/],
    ['发送通知', /定时.*(?:发送|推送).*无线告警通知/],
    ['写入工单', /(?:写入|同步|接收).*告警工单数据/],
    ['查询统计', /(?:查询|获取).*告警统计结果/]
];

const SPLIT_FUNCTIONS = [
    '查询无线告警规则列表',
    '查询有线告警规则列表',
    '查看无线告警规则详情',
    '查看有线告警规则详情',
    '导出无线告警规则',
    '导出有线告警规则',
    '启用无线告警规则',
    '启用有线告警规则'
];

const JUDGMENT_CASES = [
    { id: 'J1', name: '查询告警规则列表', expected: 'ERX' },
    { id: 'J2', name: '创建告警规则', expected: 'EWX' },
    { id: 'J3', name: '修改告警规则', expected: 'ERWX' },
    { id: 'J4', name: '删除告警规则', expected: 'EWX' },
    { id: 'J5', name: '导出告警统计报表（不持久化导出文件）', expected: 'ERX' },
    { id: 'J6', name: '定时汇总告警统计结果（不向外部呈现）', expected: 'ERW' },
    { id: 'J7', name: '外部系统查询本系统告警数据', expected: 'ERX' },
    { id: 'J8', name: '外部系统向本系统写入告警数据', expected: 'EWX' }
];

function compactName(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\s_\-—–，,。；;：:（）()【】\[\]“”"'·]/g, '')
        .toLowerCase();
}

function parseFunctionNames(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map(line => line.match(/^##\s*功能过程[：:]\s*(.+?)\s*$/)?.[1]?.trim())
        .filter(Boolean);
}

function parseCosmicProcessNames(text) {
    const names = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
        if (/功能用户|:?-{2,}/.test(trimmed)) continue;
        const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim());
        if (cells.length < 5) continue;
        const dmtIndex = cells.findIndex(cell => /^(?:E|Entry|输入)(?:[（(].*?[）)])?$/i.test(cell));
        if (dmtIndex < 0) continue;
        const candidate = cells.slice(0, dmtIndex).find(cell => SPLIT_FUNCTIONS.includes(cell));
        if (candidate) names.push(candidate);
    }
    return names;
}

function extractJson(text) {
    const clean = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const arrayStart = clean.indexOf('[');
    const arrayEnd = clean.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
        return JSON.parse(clean.slice(arrayStart, arrayEnd + 1));
    }
    const objectStart = clean.indexOf('{');
    const objectEnd = clean.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
        return JSON.parse(clean.slice(objectStart, objectEnd + 1));
    }
    throw new Error('响应中没有可解析的JSON');
}

async function callModel(model, messages, { maxTokens = 8000, temperature = 0 } = {}) {
    const startedAt = Date.now();
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            model: model.id,
            messages,
            temperature,
            max_tokens: maxTokens
        })
    });
    const raw = await response.text();
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${payload?.error?.message || raw.slice(0, 300)}`);
    }
    return {
        text: payload?.choices?.[0]?.message?.content || '',
        model: payload?.model || '',
        finishReason: payload?.choices?.[0]?.finish_reason || '',
        usage: payload?.usage || {},
        latencyMs: Date.now() - startedAt
    };
}

async function runExtraction(model, run) {
    const userPrompt = `请从以下需求文档中按目标数量提取功能过程列表：\n\n${EXTRACTION_DOCUMENT}\n\n` +
        `【数量优先执行策略】\n- 本次目标：恰好输出 ${EXTRACTION_TARGET} 个功能过程。\n` +
        '- 文档已经逐项明确16项独立业务结果，禁止把不同序号的能力合并。\n' +
        `- 输出前自检：##功能过程 行数必须等于 ${EXTRACTION_TARGET}。`;
    const response = await callModel(model, [
        { role: 'system', content: COSMIC_QUANTITY_PRIORITY_PROMPT },
        { role: 'user', content: userPrompt }
    ], { maxTokens: 8000, temperature: 0 });
    const names = parseFunctionNames(response.text);
    const normalized = names.map(compactName);
    const duplicateCount = normalized.length - new Set(normalized).size;
    const missingAnchors = EXTRACTION_ANCHORS
        .filter(([, pattern]) => !names.some(name => pattern.test(name)))
        .map(([label]) => label);
    return {
        test: 'quantity-extraction',
        run,
        requestedModel: model.id,
        returnedModel: response.model,
        target: EXTRACTION_TARGET,
        outputCount: names.length,
        targetError: Math.abs(names.length - EXTRACTION_TARGET),
        duplicateCount,
        coveredAnchors: EXTRACTION_ANCHORS.length - missingAnchors.length,
        totalAnchors: EXTRACTION_ANCHORS.length,
        missingAnchors,
        names,
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
        usage: response.usage
    };
}

async function runSplitPreservation(model) {
    const functionText = SPLIT_FUNCTIONS.map(name => (
        `##触发事件：用户触发\n##功能用户：发起者：用户 接收者：用户\n##功能过程：${name}\n##功能过程描述：用户发起${name}，系统处理并返回独立业务结果。`
    )).join('\n\n');
    const userPrompt = `请对以下 ${SPLIT_FUNCTIONS.length} 个功能过程逐一进行COSMIC拆分：\n\n${functionText}\n\n` +
        `硬性要求：输入N=${SPLIT_FUNCTIONS.length}，输出必须有恰好N个E行；名称逐字复制；相似名称也不得合并；只输出Markdown表格。`;
    const response = await callModel(model, [
        { role: 'system', content: buildCosmicSplitPrompt(false, false) },
        { role: 'user', content: userPrompt }
    ], { maxTokens: 12000, temperature: 0 });
    const names = parseCosmicProcessNames(response.text);
    const missing = SPLIT_FUNCTIONS.filter(expected => !names.includes(expected));
    return {
        test: 'split-preservation',
        requestedModel: model.id,
        returnedModel: response.model,
        target: SPLIT_FUNCTIONS.length,
        outputCount: names.length,
        uniqueOutputCount: new Set(names).size,
        targetError: Math.abs(names.length - SPLIT_FUNCTIONS.length),
        missing,
        names,
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
        usage: response.usage
    };
}

async function runCosmicJudgment(model) {
    const prompt = `你是COSMIC度量专家。请为下列功能选出最小且业务上正确的数据移动序列。\n` +
        `规则：查询/外部查询通常ERX；创建/删除/外部写入通常EWX；修改ERWX；不持久化导出文件的导出ERX；不对外呈现的定时汇总ERW。\n` +
        `只返回JSON数组，每项格式 {"id":"J1","dmt":"ERX"}，不得解释。\n\n${JSON.stringify(JUDGMENT_CASES.map(({ id, name }) => ({ id, name })))}`;
    const response = await callModel(model, [{ role: 'user', content: prompt }], {
        maxTokens: 2500,
        temperature: 0
    });
    let parsed = [];
    let parseError = '';
    try {
        const value = extractJson(response.text);
        parsed = Array.isArray(value) ? value : value.items || value.results || [];
    } catch (error) {
        parseError = error.message;
    }
    const answerMap = new Map(parsed.map(item => [String(item?.id || ''), String(item?.dmt || '').toUpperCase().replace(/[^ERWX]/g, '')]));
    const details = JUDGMENT_CASES.map(item => ({
        id: item.id,
        expected: item.expected,
        actual: answerMap.get(item.id) || '',
        correct: answerMap.get(item.id) === item.expected
    }));
    return {
        test: 'cosmic-judgment',
        requestedModel: model.id,
        returnedModel: response.model,
        score: details.filter(item => item.correct).length,
        total: details.length,
        parseError,
        details,
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
        usage: response.usage
    };
}

function summarize(results) {
    return MODELS.map(model => {
        const rows = results.filter(item => item.alias === model.alias && !item.error);
        const extractions = rows.filter(item => item.test === 'quantity-extraction');
        const split = rows.find(item => item.test === 'split-preservation');
        const judgment = rows.find(item => item.test === 'cosmic-judgment');
        const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        return {
            alias: model.alias,
            model: model.id,
            returnedModels: [...new Set(rows.map(item => item.returnedModel).filter(Boolean))],
            extraction: {
                runs: extractions.length,
                averageCount: avg(extractions.map(item => item.outputCount)),
                averageTargetError: avg(extractions.map(item => item.targetError)),
                averageAnchorCoverage: avg(extractions.map(item => item.coveredAnchors / item.totalAnchors)),
                counts: extractions.map(item => item.outputCount)
            },
            split: split ? {
                count: split.outputCount,
                target: split.target,
                missing: split.missing
            } : null,
            judgment: judgment ? `${judgment.score}/${judgment.total}` : null,
            averageLatencyMs: avg(rows.map(item => item.latencyMs))
        };
    });
}

const results = [];
for (const model of MODELS) {
    for (let run = 1; run <= 2; run++) {
        try {
            results.push({ alias: model.alias, ...await runExtraction(model, run) });
        } catch (error) {
            results.push({ alias: model.alias, test: 'quantity-extraction', run, error: error.message });
        }
    }
    try {
        results.push({ alias: model.alias, ...await runSplitPreservation(model) });
    } catch (error) {
        results.push({ alias: model.alias, test: 'split-preservation', error: error.message });
    }
    try {
        results.push({ alias: model.alias, ...await runCosmicJudgment(model) });
    } catch (error) {
        results.push({ alias: model.alias, test: 'cosmic-judgment', error: error.message });
    }
}

console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    endpoint: API_URL,
    controls: {
        sameProvider: true,
        samePromptPerTest: true,
        temperature: 0,
        extractionRunsPerModel: 2
    },
    summary: summarize(results),
    results
}, null, 2));
