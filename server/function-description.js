/**
 * 清理文本（去除不可见字符）
 */
function sanitizeText(text) {
    if (!text) return '';
    return text
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\r\n/g, '\n')
        .trim();
}

/**
 * 名称归一化（去掉章节标记、序号、多余空格）
 */
function normalizeProcessName(name) {
    if (!name) return '';
    return name
        .replace(/\[.*?\]\s*/g, '')     // 去掉 [章节名]
        .replace(/^[\d]+[.、\s]+/, '')   // 去掉序号
        .replace(/\s+/g, '')            // 去掉空格
        .toLowerCase()
        .trim();
}

function cleanProcessDisplayName(name) {
    return sanitizeText(name)
        .replace(/\[.*?\]\s*/g, '')
        .replace(/^[\d]+[.、\s]+/, '')
        .trim();
}

function compactUniqueItems(items, maxItems = 3) {
    const seen = new Set();
    const result = [];
    for (const item of items || []) {
        const text = sanitizeText(item)
            .replace(/[。；;，,、]+$/g, '')
            .trim();
        if (!text || text === '待补充') continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
        if (result.length >= maxItems) break;
    }
    return result;
}

function normalizeFunctionDescription(text, processName = '') {
    const cleanProcess = cleanProcessDisplayName(processName);
    let desc = sanitizeText(text)
        .replace(/^\|+|\|+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!desc) return '';
    if (cleanProcess) {
        const escapedProcess = cleanProcess.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        desc = desc.replace(new RegExp(`^${escapedProcess}\\s*[-—–：:]\\s*`), '').trim();
    }
    desc = desc.replace(/[。；;]+$/g, '');
    return `${desc}。`;
}

function isUsefulFunctionDescription(text) {
    const desc = sanitizeText(text);
    if (desc.length < 35) return false;
    if (/^(待补充|无|暂无|N\/A)$/i.test(desc)) return false;
    const hasProcessWords = /(该功能|用户|系统|定时|接口|触发|读取|保存|返回|展示|生成|查询|配置|支持|允许)/.test(desc);
    const looksLikeOnlyList = desc.split(/[、,，]/).length >= 6 && !/[。；;]/.test(desc);
    return hasProcessWords && !looksLikeOnlyList;
}

function buildFunctionDescription(processName, rows = [], seedDescription = '', functionalUser = '', triggerEvent = '') {
    const cleanProcess = cleanProcessDisplayName(processName) || '该功能过程';
    const seed = normalizeFunctionDescription(seedDescription, cleanProcess);
    if (isUsefulFunctionDescription(seed)) return seed;

    const eRows = rows.filter(r => r.dataMovementType === 'E');
    const rRows = rows.filter(r => r.dataMovementType === 'R');
    const wRows = rows.filter(r => r.dataMovementType === 'W');
    const xRows = rows.filter(r => r.dataMovementType === 'X');

    const describeRows = (moveRows, fallback) => {
        const items = compactUniqueItems(
            moveRows.map(row => row.subProcessDesc || row.dataGroup),
            Math.max(1, moveRows.length)
        );
        return items.length ? items.join('，并') : fallback;
    };
    const appendKeyDetails = (text, moveRows) => {
        const details = compactUniqueItems(
            moveRows.map(row => row.dataAttributes),
            Math.min(2, Math.max(1, moveRows.length))
        );
        return details.length ? `${text}，涉及${details.join('；')}` : text;
    };

    const cleanTrigger = sanitizeText(triggerEvent).replace(/[。；;]+$/g, '');
    let triggerSentence = cleanTrigger || `用户发起${cleanProcess}`;
    if (!cleanTrigger && (triggerEvent || '').includes('时钟')) {
        triggerSentence = `定时任务按预设规则触发${cleanProcess}`;
    } else if (!cleanTrigger && (functionalUser || '').includes('定时触发器')) {
        triggerSentence = `定时触发器自动发起${cleanProcess}`;
    } else if (!cleanTrigger && (triggerEvent || '').includes('接口')) {
        triggerSentence = `外部系统通过接口触发${cleanProcess}`;
    }

    const systemClauses = [];
    if (eRows.length) {
        systemClauses.push(`系统${describeRows(eRows, `接收${cleanProcess}请求`)}`);
    }
    if (rRows.length) {
        systemClauses.push(`${systemClauses.length ? '随后' : '系统'}${appendKeyDetails(describeRows(rRows, '读取相关业务数据'), rRows)}`);
    }
    if (wRows.length) {
        systemClauses.push(`${systemClauses.length ? '同时' : '系统'}${describeRows(wRows, '保存处理记录或操作日志')}`);
    }
    if (xRows.length) {
        systemClauses.push(`${systemClauses.length ? '并' : '系统'}${appendKeyDetails(describeRows(xRows, `返回${cleanProcess}结果`), xRows)}`);
    }

    return `${triggerSentence}。${systemClauses.join('，')}。`;
}

function ensureFunctionDescriptions(tableData, refFunctions = []) {
    if (!Array.isArray(tableData) || tableData.length === 0) return tableData || [];

    const refMap = new Map();
    for (const func of refFunctions || []) {
        const key = normalizeProcessName(func.functionName || func.functionalProcess || '');
        if (key) refMap.set(key, func);
    }

    const groups = [];
    let currentGroup = null;
    for (const row of tableData) {
        if (row.dataMovementType === 'E' && row.functionalProcess) {
            if (currentGroup) groups.push(currentGroup);
            currentGroup = {
                processName: row.functionalProcess,
                rows: [row],
                eRow: row
            };
        } else if (currentGroup) {
            currentGroup.rows.push(row);
        }
    }
    if (currentGroup) groups.push(currentGroup);

    for (const group of groups) {
        const key = normalizeProcessName(group.processName);
        const ref = refMap.get(key) || {};
        const existing = group.eRow.functionDescription || group.eRow.functionalDescription || '';
        const seed = isUsefulFunctionDescription(existing) ? existing : (ref.description || '');
        group.eRow.functionDescription = buildFunctionDescription(
            group.processName,
            group.rows,
            seed,
            group.eRow.functionalUser || ref.functionalUser || '',
            group.eRow.triggerEvent || ref.triggerEvent || ''
        );
        for (const row of group.rows.slice(1)) {
            row.functionDescription = '';
        }
    }

    return tableData;
}

function orderSequenceDiagrams(sequenceDiagrams, tableData) {
    if (!Array.isArray(sequenceDiagrams) || sequenceDiagrams.length <= 1) return sequenceDiagrams;
    const processOrder = new Map();
    for (const row of tableData) {
        if (row.dataMovementType === 'E' && row.functionalProcess) {
            const key = normalizeProcessName(row.functionalProcess);
            if (key && !processOrder.has(key)) processOrder.set(key, processOrder.size);
        }
    }
    const maxRank = Number.MAX_SAFE_INTEGER;
    return [...sequenceDiagrams].sort((a, b) => {
        const ar = processOrder.get(normalizeProcessName(a.processName)) ?? maxRank;
        const br = processOrder.get(normalizeProcessName(b.processName)) ?? maxRank;
        if (ar !== br) return ar - br;
        return sequenceDiagrams.indexOf(a) - sequenceDiagrams.indexOf(b);
    });
}

module.exports = {
    sanitizeText,
    normalizeProcessName,
    cleanProcessDisplayName,
    compactUniqueItems,
    normalizeFunctionDescription,
    isUsefulFunctionDescription,
    buildFunctionDescription,
    ensureFunctionDescriptions,
    orderSequenceDiagrams
};
