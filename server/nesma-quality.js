// ═══════════════════════════════════════════════════════════
// NESMA 功能点质量净化与批次辅助模块
// ═══════════════════════════════════════════════════════════

const NESMA_FP_WEIGHTS = {
    ILF: { '低': 7, '中': 10, '高': 15 },
    EIF: { '低': 5, '中': 7, '高': 10 },
    EI:  { '低': 3, '中': 4, '高': 6 },
    EO:  { '低': 4, '中': 5, '高': 7 },
    EQ:  { '低': 3, '中': 4, '高': 6 },
};

const NESMA_REUSE_COEFFICIENTS = {
    '低': 1.0,
    '中': 0.667,
    '高': 0.333,
};

// 按 低:中:高 = 1:3:6 循环分配（使用局部计数器，避免多请求并发串号）
const NESMA_REUSE_LEVEL_PATTERN = [
    '低', '中', '中', '中', '高', '高', '高', '高', '高', '高'
];

const VENDOR_AND_DOMAIN_TOKENS = [
    '华为', '中兴', '爱立信', '诺基亚', '大唐', '烽火', '思科', '新华三', '锐捷',
    '5G', '4G', '3G', '2G', 'NR', 'LTE', 'NB-IoT', '核心网', '传输网', '无线网', '接入网',
    'KPI', '告警', '工单', '质差', '性能', '配置', '任务', '日志', '规则', '模板',
    '接口', '审批', '待审批', '已审批', '历史', '小区', '基站', '网元', '网格', '频段'
];

/**
 * 规范化 NESMA 业务功能名（消除禁用词"报表"，统一紧凑格式）
 */
function normalizeNesmaFuncName(name) {
    let text = String(name || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';

    const hadReportWord = /报表/.test(text);
    if (hadReportWord) {
        text = text
            .replace(/统计汇总报表/g, '统计汇总')
            .replace(/综合汇总报表/g, '综合汇总')
            .replace(/审计汇总报表/g, '审计汇总')
            .replace(/汇总报表/g, '汇总')
            .replace(/统计报表/g, '统计分析')
            .replace(/分析报表/g, '分析')
            .replace(/呈现报表/g, '展示页面')
            .replace(/展示报表/g, '展示页面')
            .replace(/明细报表/g, '明细查询页面')
            .replace(/报表/g, '汇总分析');
    }

    return text.trim();
}

/**
 * 判断是否为纯非功能需求/UI外观废话（如深蓝主题、浏览器兼容性等）
 * 注意：避免误伤国产化迁移模式中的"前端应用迁移"合法功能点。
 */
function isNonFunctionalNesmaItem(row, { extractionMode = 'precise' } = {}) {
    if (!row) return true;
    const name = String(row.funcName || '').trim();
    const desc = String(row.funcDescription || '').trim();
    const migDim = String(row.migrationDimension || '').trim();
    if (!name) return true;

    // 国产化迁移模式里的"前端应用迁移"属于显式迁移维度，不按 UI 噪声过滤
    if (extractionMode === 'guochanhua' && migDim && migDim !== '原有业务') {
        return false;
    }

    const combined = `${name} ${desc}`;
    const uiStylePattern = /(深蓝主题|暗黑主题|浅色主题|界面主题|主题配色|页面配色|字体样式|界面风格|视觉风格|外观样式|界面美观|主流浏览器|浏览器兼容|浏览器访问|分辨率适配|页面响应时间|并发用户数|系统部署架构)/;
    const genericUiConfigName = /^(系统)?界面(主题|风格|样式|配色|配置)(信息|配置|查看|修改|设置|管理)?$/;
    const uiThemeActionName = /(修改|设置|查看|配置|保存|查询).*(界面主题|深蓝主题|主题配色|浏览器兼容|页面配色)/;

    if (uiThemeActionName.test(name) || genericUiConfigName.test(name)) {
        return true;
    }

    if (uiStylePattern.test(combined)) {
        // 如果名称本身只是界面/主题/浏览器/样式相关，无真实业务实体词，则过滤
        const hasCoreBusinessEntity = /(小区|基站|网元|告警|工单|KPI|指标|性能|用户|角色|权限|订单|合同|资产|设备|审批|日志|规则|接口|任务|报表|账单|库存|项目|计划)/.test(name);
        if (!hasCoreBusinessEntity) {
            return true;
        }
    }

    return false;
}

/**
 * 提取功能名中的关键实体词，用于同模块原子子步骤检测与近重复检测
 */
function extractEntitySignature(name) {
    const normalized = String(name || '')
        .normalize('NFKC')
        .toUpperCase()
        .replace(/[\s\-_()（）【】[\]·、，,。:：]/g, '');

    const preserved = [];
    for (const token of VENDOR_AND_DOMAIN_TOKENS) {
        const upper = token.toUpperCase();
        if (normalized.includes(upper)) preserved.push(upper);
    }
    return preserved;
}

function shareCoreEntity(nameA, nameB) {
    const sigA = extractEntitySignature(nameA);
    const sigB = extractEntitySignature(nameB);
    if (sigA.length === 0 || sigB.length === 0) return false;

    // 若双方带有明确不同的厂家前缀，绝对不是同一实体
    const vendors = ['华为', '中兴', '爱立信', '诺基亚', '大唐', '烽火', '思科', '新华三', '锐捷'];
    const vendorsA = vendors.filter(v => String(nameA).includes(v));
    const vendorsB = vendors.filter(v => String(nameB).includes(v));
    if (vendorsA.length > 0 && vendorsB.length > 0 && !vendorsA.some(v => vendorsB.includes(v))) {
        return false;
    }

    const common = sigA.filter(t => sigB.includes(t));
    return common.length >= Math.min(2, Math.min(sigA.length, sigB.length));
}

/**
 * 识别明显违背 NESMA 基本过程原子性的"子步骤伪功能点"
 * 例如：
 * - 返回告警同步回执 (EO) — 同步回执只是 EI 的响应确认，不是独立 EO
 * - 华为性能KPI数据入库 (EI) 紧跟在 定时采集华为性能KPI数据 (EI) 后
 * - 中兴告警数据入库 (EI) 紧跟在 接收中兴网管告警推送 (EI) 后
 * - 更新工单审批状态 (EI) / 记录审批意见 (EI) 紧跟在 审批质差问题工单 (EI) 后
 */
function isAtomicSubstepNoise(row, allRows) {
    if (!row) return false;
    const name = String(row.funcName || '').trim();
    const cat = String(row.category || '').toUpperCase().trim();
    const modKey = `${row.level1 || ''}||${row.level2 || ''}`;

    // 1. 独立的"返回同步回执 / 返回响应结果 / 返回操作结果"伪功能点
    if (/^(返回|发送|回传|响应|输出).*(同步回执|接收回执|回执|响应结果|确认回执|操作回执|成功提示)$/.test(name)) {
        return true;
    }

    // 同二级模块内兄弟行
    const siblings = allRows.filter(r => r !== row && `${r.level1 || ''}||${r.level2 || ''}` === modKey);

    // 2. 拆碎的"XXX数据入库 / XXX记录入库"（排除合法的 FTP入库 / 批量导入入库）
    if (cat === 'EI' && /(数据|记录|指标|告警)入库$/.test(name) && !/(FTP|文件|模板|批量|手工|手动|离线|迁移)/i.test(name)) {
        const hasParentIngest = siblings.some(s =>
            String(s.category || '').toUpperCase() === 'EI'
            && /^(定时采集|自动采集|定时拉取|拉取|采集|接收|实时接收|同步)/.test(String(s.funcName || '').trim())
            && shareCoreEntity(name, s.funcName)
        );
        if (hasParentIngest) return true;
    }

    // 3. 拆碎的审批字段更新："更新XXX审批状态" / "记录XXX审批意见"（保留"审批通过/审批驳回/退回"等独立业务动作）
    if (cat === 'EI' && /^(更新|修改|保存|记录|写入).*(审批状态|审批意见|审核状态|审核意见)$/.test(name)) {
        const hasParentApproval = siblings.some(s =>
            String(s.category || '').toUpperCase() === 'EI'
            && /(审批|审核)/.test(String(s.funcName || '').trim())
            && !/^(更新|修改|保存|记录|写入).*(审批状态|审批意见|审核状态|审核意见)$/.test(String(s.funcName || '').trim())
            && shareCoreEntity(name, s.funcName)
        );
        if (hasParentApproval) return true;
    }

    return false;
}

/**
 * 识别精准模式下的低质量"单字段筛选"凑数 EQ
 * 例如同二级模块里已有"查询页面/信息页面"，又把同一列表的每个筛选框拆成"按地市筛选"、"按频段筛选"、"按状态筛选"
 */
function isTrivialSingleFieldFilterEq(row, allRows) {
    if (!row || String(row.category || '').toUpperCase() !== 'EQ') return false;
    const name = String(row.funcName || '').trim();
    const isSingleFieldFilter = /按[\u4e00-\u9fa5A-Za-z0-9]{1,8}(筛选|过滤|查询)$/.test(name);
    if (!isSingleFieldFilter) return false;

    const modKey = `${row.level1 || ''}||${row.level2 || ''}`;
    const siblings = allRows.filter(r => r !== row && `${r.level1 || ''}||${r.level2 || ''}` === modKey);
    return siblings.some(s =>
        String(s.category || '').toUpperCase() === 'EQ'
        && /(信息页面|查询页面|列表页面|列表查询)$/.test(String(s.funcName || '').trim())
        && shareCoreEntity(name, s.funcName)
    );
}

/**
 * 为精准模式构造同二级模块下的语义去重键，避免"华为小区配置管理"与"华为小区查询统计"重复产出同一套查询/导出/详情
 * 严格保留厂家、制式和独立业务子域，绝不误合并不同厂家或不同业务对象。
 */
function buildPreciseSemanticKey(row) {
    const l2 = String(row.level2 || row.subFunction || '').replace(/^\s*\d+(?:\.\d+)*\s*/, '').trim();
    const cat = String(row.category || '').toUpperCase().trim();
    const rawName = String(row.funcName || '').trim();

    let actionBucket = '';
    if (cat === 'EQ') {
        if (/模板导出$/.test(rawName)) actionBucket = '模板导出';
        else if (/(数据导出|记录导出|导出)$/.test(rawName)) actionBucket = '导出';
        else if (/(详情查看|详情页面|详情)$/.test(rawName)) actionBucket = '详情';
        else if (/(历史查看|审批历史|处理历史|日志查看|日志查询)/.test(rawName)) actionBucket = '历史日志';
        else if (/监控/.test(rawName)) actionBucket = '监控';
        else if (/(待审批|已审批)/.test(rawName)) actionBucket = rawName;
        else if (/(信息页面|列表页面|基础信息页面)$/.test(rawName)) actionBucket = '列表页';
        else if (/(查询页面|列表查询页面|组合查询页面|综合查询页面)$/.test(rawName)) actionBucket = '查询页';
        else return '';
    } else if (cat === 'ILF') {
        actionBucket = 'ILF';
    } else {
        return '';
    }

    // 去掉后缀与常见修饰噪音，保留核心实体词（含厂家与子对象）
    const stem = rawName
        .replace(/(模板导出|数据导出|记录导出|导出|详情查看|详情页面|详情|基础信息页面|信息页面|列表查询页面|组合查询页面|综合查询页面|查询页面|列表页面|配置信息|记录信息|基础信息|数据信息|信息存储|存储|信息)$/, '')
        .replace(/(配置|基础|列表|数据|记录|明细)$/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();

    if (!stem) return '';
    return `${l2}||${cat}||${stem}||${actionBucket}`;
}

/**
 * 综合质量净化管道
 */
function sanitizeNesmaTableData(rows = [], {
    extractionMode = 'precise',
    fpWeights = NESMA_FP_WEIGHTS,
    reuseCoefficients = NESMA_REUSE_COEFFICIENTS,
    reusePattern = NESMA_REUSE_LEVEL_PATTERN,
    reassignReuse = true
} = {}) {
    const diagnostics = {
        rawCount: Array.isArray(rows) ? rows.length : 0,
        finalCount: 0,
        removedNonFunctionalCount: 0,
        removedAtomicNoiseCount: 0,
        removedTrivialFilterCount: 0,
        removedDuplicateCount: 0,
        normalizedReportNameCount: 0,
        ilfCount: 0,
        ilfIncompleteNames: [],
        removedSamples: []
    };

    if (!Array.isArray(rows) || rows.length === 0) {
        return { tableData: [], diagnostics };
    }

    // 第一步：命名规范化（去掉"报表"字眼）
    const normalizedRows = rows.map(row => {
        const origName = String(row.funcName || '').trim();
        const nextName = normalizeNesmaFuncName(origName);
        if (origName !== nextName) {
            diagnostics.normalizedReportNameCount++;
        }
        return {
            ...row,
            funcName: nextName
        };
    }).filter(row => row.funcName);

    // 第二步：过滤非功能废话 & 原子子步骤伪功能点 & 精准模式单字段凑数筛选
    const filtered = [];
    for (const row of normalizedRows) {
        if (isNonFunctionalNesmaItem(row, { extractionMode })) {
            diagnostics.removedNonFunctionalCount++;
            if (diagnostics.removedSamples.length < 15) diagnostics.removedSamples.push(`非功能:${row.funcName}`);
            continue;
        }
        if (extractionMode !== 'quantity' && isAtomicSubstepNoise(row, normalizedRows)) {
            diagnostics.removedAtomicNoiseCount++;
            if (diagnostics.removedSamples.length < 15) diagnostics.removedSamples.push(`原子拆碎:${row.funcName}`);
            continue;
        }
        if (extractionMode === 'precise' && isTrivialSingleFieldFilterEq(row, normalizedRows)) {
            diagnostics.removedTrivialFilterCount++;
            if (diagnostics.removedSamples.length < 15) diagnostics.removedSamples.push(`单字段筛选:${row.funcName}`);
            continue;
        }
        filtered.push(row);
    }

    // 第三步：去重（数量优先/国产化按 三级模块||功能名，精准模式叠加同二级模块语义去重）
    const deduped = [];
    const exactKeys = new Set();
    const semanticKeys = new Set();
    const scopedByModule = extractionMode === 'quantity' || extractionMode === 'guochanhua';

    for (const row of filtered) {
        const l3 = String(row.level3 || row.level4 || '').trim().toLowerCase();
        const nameKey = String(row.funcName || '').trim().toLowerCase();
        const exactKey = scopedByModule ? `${l3}||${nameKey}` : nameKey;

        if (exactKeys.has(exactKey)) {
            diagnostics.removedDuplicateCount++;
            if (diagnostics.removedSamples.length < 15) diagnostics.removedSamples.push(`重名:${row.funcName}`);
            continue;
        }

        if (extractionMode === 'precise') {
            const semKey = buildPreciseSemanticKey(row);
            if (semKey && semanticKeys.has(semKey)) {
                diagnostics.removedDuplicateCount++;
                if (diagnostics.removedSamples.length < 15) diagnostics.removedSamples.push(`同域重复:${row.funcName}`);
                continue;
            }
            if (semKey) semanticKeys.add(semKey);
        }

        exactKeys.add(exactKey);
        deduped.push(row);
    }

    // 第四步：使用局部计数器重新编号并同步 UFP / 重用程度 / AFP（彻底消除全局状态并发串号）
    const finalRows = deduped.map((row, idx) => {
        const cat = String(row.category || '').toUpperCase().trim();
        const complexity = row.complexity || '低';
        const fpCount = (fpWeights[cat] && fpWeights[cat][complexity]) || row.fpCount || 0;
        const reuseLevel = reassignReuse
            ? reusePattern[idx % reusePattern.length]
            : (row.reuseLevel || '低');
        const coeff = reuseCoefficients[reuseLevel] || 1.0;
        const afp = Math.round(fpCount * coeff * 1000) / 1000;

        return {
            ...row,
            id: String(idx + 1),
            category: cat,
            complexity,
            fpCount,
            reuseLevel,
            afp
        };
    });

    // 第五步：ILF 完整性诊断（仅统计提醒，不随意删改）
    const ilfs = finalRows.filter(r => r.category === 'ILF');
    diagnostics.ilfCount = ilfs.length;
    for (const ilf of ilfs) {
        const modKey = `${ilf.level1 || ''}||${ilf.level2 || ''}`;
        const sameMod = finalRows.filter(r => `${r.level1 || ''}||${r.level2 || ''}` === modKey);
        const hasEi = sameMod.some(r => r.category === 'EI');
        const hasOut = sameMod.some(r => r.category === 'EO' || r.category === 'EQ');
        if (!hasEi || !hasOut) {
            diagnostics.ilfIncompleteNames.push(ilf.funcName);
        }
    }

    diagnostics.finalCount = finalRows.length;
    return { tableData: finalRows, diagnostics };
}

/**
 * 长文档按批次模块精准切片：短文档直接返回原文，长文档抽取与当前批次模块相关的上下文段落，防止超上下文或超时
 */
function buildNesmaBatchDocumentExcerpt(fullText, batchMods = [], maxChars = 14000) {
    const source = String(fullText || '');
    if (!source || source.length <= maxChars || !Array.isArray(batchMods) || batchMods.length === 0) {
        return source;
    }

    const lines = source.split('\n');
    const keywords = new Set();
    for (const mod of batchMods) {
        const rawParts = [
            mod.level1,
            mod.level2,
            mod.level3,
            ...(Array.isArray(mod.businessObjects) ? mod.businessObjects : [])
        ];
        for (const p of rawParts) {
            const cleaned = String(p || '')
                .replace(/^\s*\d+(?:\.\d+)*[\s.、-]*/, '')
                .trim();
            if (cleaned.length >= 2) keywords.add(cleaned);
            // 也加入 2-4 字子词段辅助命中
            cleaned.split(/[与和及、/（）()，,\s]+/).forEach(seg => {
                if (seg.trim().length >= 2) keywords.add(seg.trim());
            });
        }
    }

    const kwList = [...keywords];
    const scored = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let score = 0;
        for (const kw of kwList) {
            if (line.includes(kw)) score += kw.length >= 4 ? 3 : 1;
        }
        if (score > 0) scored.push({ index: i, score });
    }

    if (scored.length === 0) {
        return source.slice(0, maxChars);
    }

    // 以命中行为锚点构建片段：先保命中行及其后文，再补少量前文，避免命中行前有超长段落把命中内容挤出 maxChars
    const hitIndexes = scored
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 18)
        .sort((a, b) => a.index - b.index)
        .map(h => h.index);

    const perHitBudget = Math.max(800, Math.floor(maxChars / Math.max(1, Math.min(hitIndexes.length, 6))));
    const chunks = [];
    const usedLineRanges = [];
    let totalLen = 0;

    for (const hitIdx of hitIndexes) {
        if (totalLen >= maxChars) break;
        if (usedLineRanges.some(r => hitIdx >= r.start && hitIdx <= r.end)) continue;

        const parts = [];
        let budgetLeft = Math.min(perHitBudget, maxChars - totalLen);

        // 1. 少量前文（最多前 2 行且不超过 250 字符）
        const preLines = [];
        let preChars = 0;
        for (let i = hitIdx - 1; i >= Math.max(0, hitIdx - 2); i--) {
            const lineText = lines[i].trim();
            if (!lineText) continue;
            const clipped = lineText.length > 200 ? `...${lineText.slice(-200)}` : lineText;
            if (preChars + clipped.length > 250) break;
            preLines.unshift(clipped);
            preChars += clipped.length + 1;
        }
        if (preLines.length > 0 && preChars < budgetLeft * 0.35) {
            parts.push(...preLines);
            budgetLeft -= preChars;
        }

        // 2. 命中行及后续正文（优先保留完整上下文）
        let endIdx = hitIdx;
        for (let i = hitIdx; i < Math.min(lines.length, hitIdx + 24); i++) {
            const lineText = lines[i];
            if (!lineText.trim() && i > hitIdx) continue;
            if (lineText.length + 1 > budgetLeft) {
                if (i === hitIdx) {
                    parts.push(lineText.slice(0, Math.max(200, budgetLeft)));
                }
                break;
            }
            parts.push(lineText);
            budgetLeft -= lineText.length + 1;
            endIdx = i;
        }

        const chunk = parts.join('\n').trim();
        if (chunk) {
            chunks.push(chunk);
            totalLen += chunk.length + 6;
            usedLineRanges.push({ start: Math.max(0, hitIdx - 2), end: endIdx });
        }
    }

    const excerpt = chunks.join('\n\n...\n\n');
    return excerpt.length > maxChars ? excerpt.slice(0, maxChars) : excerpt;
}

module.exports = {
    NESMA_FP_WEIGHTS,
    NESMA_REUSE_COEFFICIENTS,
    NESMA_REUSE_LEVEL_PATTERN,
    normalizeNesmaFuncName,
    isNonFunctionalNesmaItem,
    isAtomicSubstepNoise,
    isTrivialSingleFieldFilterEq,
    sanitizeNesmaTableData,
    buildNesmaBatchDocumentExcerpt
};
