function normalizeCompactText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/^\s*\d+(?:\.\d+)*[.、\s]*/, '')
        .replace(/[\s_\-—–，,。；;：:（）()【】\[\]“”"'·]/g, '')
        .toLowerCase()
        .trim();
}

function chapterHeadingKey(value) {
    const text = String(value || '').normalize('NFKC').trim();
    const number = text.match(/^(\d+(?:\.\d+)*)/)?.[1] || '';
    return `${number}\u0001${normalizeCompactText(text)}`;
}

function keepLastDuplicateHeadingPositions(lines, positions) {
    const lastPositionByHeading = new Map();
    positions.forEach(position => {
        lastPositionByHeading.set(chapterHeadingKey(lines[position]), position);
    });
    return positions.filter(position => (
        lastPositionByHeading.get(chapterHeadingKey(lines[position])) === position
    ));
}

function isReferenceOnlyChapterTitle(title) {
    const clean = String(title || '')
        .normalize('NFKC')
        .replace(/^\s*\d+(?:\.\d+)*[.、\s]*/, '')
        .trim();
    return /^(?:目录|阅读说明|数据与状态口径|功能拆分建议|验收核对清单|附录)(?:\s|$)/.test(clean);
}

function canonicalFunctionNameKey(name) {
    let text = normalizeCompactText(name);
    let batch = false;
    if (text.startsWith('批量')) {
        batch = true;
        text = text.slice(2);
    }

    const operationGroups = [
        ['进入', /^(?:导航至|跳转至|进入|打开)/],
        ['创建', /^(?:新建|新增|创建|添加)/],
        ['修改', /^(?:编辑|修改)/],
        ['删除', /^(?:删除|移除)/],
        ['查询', /^(?:查询|查看|获取)/],
        ['导出', /^导出/],
        ['导入', /^(?:导入|上传)/],
        ['执行', /^(?:执行|运行)/],
        ['关闭', /^(?:关闭|收起)/],
        ['展开', /^(?:展开|展示|显示)/],
        ['切换', /^切换/],
    ];

    let operation = '';
    for (const [key, pattern] of operationGroups) {
        const match = text.match(pattern);
        if (!match) continue;
        operation = key;
        text = text.slice(match[0].length);
        break;
    }

    if (operation === '查询' || operation === '导出') {
        text = text.replace(/(?:数据)?(?:记录|列表|清单)$/, '');
    }
    if (operation === '展开' && !/(?:菜单|下拉|面板|弹窗)/.test(text)) {
        operation = '展示';
    }
    return text ? `${batch ? '批量' : ''}${operation}\u0001${text}` : normalizeCompactText(name);
}

function orderCosmicTableData(rows) {
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
    return groups.flatMap(group => group.rows);
}

module.exports = {
    canonicalFunctionNameKey,
    chapterHeadingKey,
    isReferenceOnlyChapterTitle,
    keepLastDuplicateHeadingPositions,
    orderCosmicTableData,
};
