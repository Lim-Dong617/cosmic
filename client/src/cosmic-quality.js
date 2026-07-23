const normalizeText = (value) => String(value || '')
    .normalize('NFKC')
    .replace(/^\s*\d+(?:\.\d+)*[.、\s]*/, '')
    .replace(/[\s_\-—–，,。；;：:（）()【】\[\]“”"'·]/g, '')
    .toLowerCase()
    .trim();

export const normalizeProcessOrderKey = (name) => String(name || '')
    .replace(/\[.*?\]\s*/g, '')
    .replace(/^[\d]+[.、\s]+/, '')
    .replace(/\s+/g, '')
    .toLowerCase()
    .trim();

const normalizeScope = (func) => normalizeText(
    func?.sourceChapter || func?.level1 || ''
);

const splitOperationAndObject = (name) => {
    let text = normalizeText(name);
    let batch = false;
    if (text.startsWith('批量')) {
        batch = true;
        text = text.slice(2);
    }

    const operationGroups = [
        { key: '进入', pattern: /^(?:导航至|跳转至|进入|打开)/ },
        { key: '创建', pattern: /^(?:新建|新增|创建|添加)/ },
        { key: '修改', pattern: /^(?:编辑|修改)/ },
        { key: '删除', pattern: /^(?:删除|移除)/ },
        { key: '查询', pattern: /^(?:查询|查看|获取)/ },
        { key: '导出', pattern: /^导出/ },
        { key: '导入', pattern: /^(?:导入|上传)/ },
        { key: '执行', pattern: /^(?:执行|运行)/ },
        { key: '关闭', pattern: /^(?:关闭|收起)/ },
        { key: '展开', pattern: /^(?:展开|展示|显示)/ },
        { key: '切换', pattern: /^切换/ },
        { key: '排序', pattern: /^(?:排序|对.+?进行排序)/ },
    ];

    let operation = '';
    for (const group of operationGroups) {
        const match = text.match(group.pattern);
        if (!match) continue;
        operation = group.key;
        text = text.slice(match[0].length);
        break;
    }

    if (operation === '查询' || operation === '导出') {
        text = text.replace(/(?:数据)?(?:记录|列表|清单)$/, '');
    }
    if (operation === '展开' && !/(?:菜单|下拉|面板|弹窗)/.test(text)) {
        operation = '展示';
    }

    return {
        operation,
        object: text,
        batch,
    };
};

export const canonicalFunctionKey = (name) => {
    const parts = splitOperationAndObject(name);
    if (!parts.object) return normalizeText(name);
    return `${parts.batch ? '批量' : ''}${parts.operation}\u0001${parts.object}`;
};

const areLikelyDuplicateFunctions = (left, right) => {
    const leftScope = normalizeScope(left);
    const rightScope = normalizeScope(right);
    if (leftScope && rightScope && leftScope !== rightScope) return false;
    return canonicalFunctionKey(left?.functionName) === canonicalFunctionKey(right?.functionName);
};

export const deduplicateFunctionObjects = (functions = []) => {
    const kept = [];
    for (const func of functions) {
        if (!normalizeText(func?.functionName)) continue;
        if (kept.some(existing => areLikelyDuplicateFunctions(existing, func))) continue;
        kept.push(func);
    }
    return kept;
};

export const inheritMissingFunctionLevels = (functions = []) => {
    let last = { level1: '', level2: '', level3: '', sourceChapter: '' };

    return functions.map(func => {
        const next = { ...func };
        const source = String(next.sourceChapter || '').trim();
        const sourceChanged = Boolean(
            source
            && last.sourceChapter
            && normalizeText(source) !== normalizeText(last.sourceChapter)
        );
        if (sourceChanged) {
            last = { level1: '', level2: '', level3: '', sourceChapter: source };
        }

        const hasLevel1 = Boolean(next.level1);
        const hasLevel2 = Boolean(next.level2);
        const hasLevel3 = Boolean(next.level3);

        if (hasLevel1) {
            const level1Changed = Boolean(
                last.level1
                && normalizeText(next.level1) !== normalizeText(last.level1)
            );
            next.level2 = hasLevel2 ? next.level2 : '';
            next.level3 = hasLevel3 ? next.level3 : '';
            if (level1Changed) {
                last.level2 = '';
                last.level3 = '';
            }
        } else if (hasLevel2) {
            next.level1 = last.level1;
            next.level3 = hasLevel3 ? next.level3 : '';
        } else if (hasLevel3) {
            next.level1 = last.level1;
            next.level2 = last.level2;
        } else if (!sourceChanged) {
            next.level1 = last.level1;
            next.level2 = last.level2;
            next.level3 = last.level3;
        }

        if (!next.sourceChapter && !sourceChanged) {
            next.sourceChapter = last.sourceChapter;
        }

        last = {
            level1: next.level1 || '',
            level2: next.level2 || '',
            level3: next.level3 || '',
            sourceChapter: next.sourceChapter || source || '',
        };
        return next;
    });
};

export const orderCosmicTableData = (rows, functions = []) => {
    if (!Array.isArray(rows) || rows.length <= 1) return rows || [];

    const groups = [];
    let currentGroup = null;
    rows.forEach((row, rowIndex) => {
        const clonedRow = { ...row };
        if (clonedRow.dataMovementType === 'E' && clonedRow.functionalProcess) {
            if (currentGroup) groups.push(currentGroup);
            currentGroup = {
                index: rowIndex,
                processName: clonedRow.functionalProcess,
                rows: [clonedRow],
            };
        } else if (currentGroup) {
            currentGroup.rows.push(clonedRow);
        } else {
            groups.push({
                index: rowIndex,
                processName: clonedRow.functionalProcess || '',
                rows: [clonedRow],
                orphan: true,
            });
        }
    });
    if (currentGroup) groups.push(currentGroup);

    const functionOrder = new Map();
    functions.forEach((func, index) => {
        const key = normalizeProcessOrderKey(
            func?.functionName || func?.functionalProcess || func
        );
        if (key && !functionOrder.has(key)) functionOrder.set(key, index);
    });
    const maxRank = Number.MAX_SAFE_INTEGER;

    return groups
        .sort((left, right) => {
            const leftRank = functionOrder.get(normalizeProcessOrderKey(left.processName)) ?? maxRank;
            const rightRank = functionOrder.get(normalizeProcessOrderKey(right.processName)) ?? maxRank;
            if (leftRank !== rightRank) return leftRank - rightRank;
            return left.index - right.index;
        })
        .flatMap(group => group.rows);
};

export const isReferenceOnlyChapterTitle = (title) => (
    /(?:^|\s)(?:目录|阅读说明|数据与状态口径|功能拆分建议|验收核对清单|附录)(?:\s|$)/.test(
        String(title || '').replace(/^\s*\d+(?:\.\d+)*[.、\s]*/, '')
    )
);
