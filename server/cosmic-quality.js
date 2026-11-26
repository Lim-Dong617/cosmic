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

const FUNCTIONAL_CHAPTER_GUARD_RE = /(?:功能需求|功能描述|功能说明|功能设计|功能列表|功能清单|业务功能|核心功能|系统功能|界面功能)/;
const REFERENCE_CHAPTER_PREFIX_RE = /^(?:目\s*录|contents|文档说明|编写目的|文档目的|文档介绍|阅读说明|文档修订记录|修订记录|版本记录|版本历史|变更记录|术语与缩略语|术语定义|术语与定义|缩略语|名词解释|参考文档|参考资料|引用标准|数据与状态口径|功能拆分建议|验收核对清单|附\s*录|附\s*件|项目背景|业务背景|建设背景|需求背景|建设目标|项目目标|建设原则|背景与目标|项目概述|需求概述|干系人|组织保障|项目组织|实施计划|进度计划|里程碑|投资估算|预算估算|经费预算|效益分析|经济效益|社会效益|风险分析|风险管控|非功能性?(?:需求|指标|要求)|性能(?:需求|指标|要求)|安全性?(?:需求|指标|要求)|可靠性(?:需求|指标|要求)|可用性(?:需求|指标|要求)|兼容性(?:需求|指标|要求)|运维保障|部署架构|硬件配置|软硬件环境|资源需求|资源测算|验收标准|验收方案|培训方案|售后服务)(?:[\s（(【：:—–\-]|$)/i;

function isReferenceOnlyChapterTitle(title) {
    const clean = String(title || '')
        .normalize('NFKC')
        .replace(/<a\b[^>]*>\s*<\/a>/gi, '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^__(.+)__$/, '$1')
        .replace(/^\*\*(.+)\*\*$/, '$1')
        .replace(/^\s*(?:第[一二三四五六七八九十百千\d]+[章节篇]|[（(][一二三四五六七八九十\d]+[）)]|[一二三四五六七八九十]+[、.．]|\d+(?:\.\d+)*[.、\s]+)\s*/, '')
        .trim();
    if (!clean) return false;
    if (FUNCTIONAL_CHAPTER_GUARD_RE.test(clean)) return false;
    return REFERENCE_CHAPTER_PREFIX_RE.test(clean);
}

const INTRO_FUNCTIONAL_VERB_RE = /(?:支持|查询|查看|检索|搜索|新增|创建|新建|添加|录入|修改|编辑|更新|删除|移除|导出|下载|导入|上传|审批|审核|驳回|派单|派发|告警|预警|推送|通知|定时|归档|同步|计算|统计|汇总|展示|呈现|配置|跳转|点击|切换|弹窗|接口|功能过程)/;
const INTRO_BOILERPLATE_SIGNAL_RE = /(?:版本号|模板版本|修订记录|文档状态|编制单位|编写人|起草人|审核人|批准人|适用对象|需求说明书|技术规范书|建设方案|有限公司|分公司|目\s*录|PRODUCT\s+REQUIREMENTS|可行性评估书|扩容工程需求|日期[：:]|发布日期)/i;

function isBoilerplateIntro(text) {
    const clean = String(text || '').trim();
    if (!clean) return true;
    // Never auto-deselect intro text if it contains any concrete functional requirement verbs.
    if (INTRO_FUNCTIONAL_VERB_RE.test(clean)) return false;
    if (INTRO_BOILERPLATE_SIGNAL_RE.test(clean)) return true;
    // Pure short title/date/subtitle header lines with no functional content
    const nonEmptyLines = clean.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return nonEmptyLines.length <= 8 && clean.length <= 260;
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
    isBoilerplateIntro,
    isReferenceOnlyChapterTitle,
    keepLastDuplicateHeadingPositions,
    orderCosmicTableData,
};
