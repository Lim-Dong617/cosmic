'use strict';

// Deterministic, lossless document preprocessor for COSMIC / NESMA requirement specs.
// Strips formatting noise (Word bookmark anchors, TOC blocks, empty images, cover
// revision tables, template placeholders) and compacts repetitive schema/dictionary
// tables while preserving 100% of functional requirement text and field names.

const HTML_ENTITY_MAP = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&ldquo;': '“',
    '&rdquo;': '”',
    '&lsquo;': '‘',
    '&rsquo;': '’',
};

function decodeHtmlEntities(text) {
    return String(text || '')
        .replace(/&(nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash|hellip|ldquo|rdquo|lsquo|rsquo);/gi, (match) => (
            HTML_ENTITY_MAP[match.toLowerCase()] ?? match
        ))
        .replace(/&#(\d+);/g, (_, code) => {
            const num = Number.parseInt(code, 10);
            return Number.isFinite(num) && num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : '';
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const num = Number.parseInt(hex, 16);
            return Number.isFinite(num) && num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : '';
        });
}

function stripInlineHtmlTagsOnly(html) {
    return String(html || '')
        .replace(/<img\b[^>]*>/gi, '')
        .replace(/<a\b[^>]*\bid=["'][^"']*["'][^>]*>\s*<\/a>/gi, '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/(?:p|div|li|tr)>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t\r\n]+/g, ' ')
        .trim();
}

function stripInlineHtml(html) {
    return decodeHtmlEntities(stripInlineHtmlTagsOnly(html))
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t\r\n]+/g, ' ')
        .trim();
}

function cleanInlineMarkdownNoise(text) {
    let value = String(text || '');
    value = value.replace(/<a\b[^>]*>\s*<\/a>/gi, '');
    value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    value = value.replace(/\\([.>\-()_[\]*#])/g, '$1');
    return value;
}

function unwrapBoldAndAnchors(text) {
    let value = cleanInlineMarkdownNoise(text).trim();
    for (let i = 0; i < 2; i += 1) {
        const next = value
            .replace(/^__(.+)__$/, '$1')
            .replace(/^\*\*(.+)\*\*$/, '$1')
            .trim();
        if (next === value) break;
        value = next;
    }
    return value;
}

// ── Table Classification & Compaction ──

const METADATA_HEADER_RE = /(?:版本号|修订日期|修改日期|更新日期|修订人|修改人|编写人|起草人|审核人|审定人|批准人|评审人|变更记录|修订说明|修改内容|修订内容|文档编号|签字)/;
const FUNCTIONAL_HEADER_RE = /(?:功能名称|功能点|功能模块|功能描述|功能说明|子功能|需求描述|业务需求|交互与结果|交互说明|操作步骤|验收标准|验收要点|触发事件|功能过程|接口名称|接口说明|菜单名称|页面名称|业务场景)/;
const FIELD_NAME_HEADER_RE = /^(?:字段名称?|英文名称?|中文名称?|数据项(?:名称)?|列名|参数名称?|属性名称?|指标名称?|field(?:\s*name)?|column(?:\s*name)?)$/i;
const SCHEMA_META_HEADER_RE = /(?:类型|枚举|长度|数据样例|样例|示例|是否必填|必填|主键|默认值|单位|属性|说明|备注|口径|规则|算法|映射|来源)/;
const RULE_COLUMN_HEADER_RE = /(?:算法|规则|口径|映射|逻辑|校验|约束|计算|说明|加工|备注|要求)/;
const ACTION_VERB_RE = /(?:支持|查询|查看|检索|搜索|新增|创建|新建|添加|录入|修改|编辑|更新|删除|移除|导出|下载|导入|上传|审批|审核|驳回|派单|派发|告警|预警|推送|通知|定时|归档|同步|计算|统计|汇总|展示|弹窗|跳转|点击|切换|配置|生成)/;
const RULE_SIGNAL_RE = /(?:=|>=|<=|>|<|计算|公式|校验|如果|若|当|默认|自动|触发|状态|阈值|聚合|汇总|映射|关联|去重|兼容|规则|唯一|继承|按天|定时|枚举|必须|不得|不可|否则|区间|范围|回退|归档|合并|派单|审核|分级|重算|同步|联动)/;
const PURE_TYPE_ONLY_RE = /^(?:文本|字符串|整数|数字|小数|浮点|布尔|日期|时间|日期时间|时间戳|必填|非必填|选填|可选|主键|外键|无|暂无|-|—|string|int|integer|number|boolean|date|datetime|varchar\([^)]*\))$/i;

function parseHtmlTable(tableHtml) {
    const rows = [];
    const trMatches = tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trMatches) {
        const cellMatches = tr.match(/<t[hd]\b[\s\S]*?<\/t[hd]>/gi) || [];
        const cells = cellMatches.map(cell => stripInlineHtml(cell));
        if (cells.some(cell => cell.length > 0)) {
            rows.push(cells);
        }
    }
    return rows;
}

function escapePipeCell(value) {
    return String(value || '').replace(/\|/g, '｜').replace(/\r?\n/g, ' ').trim();
}

function formatMarkdownPipeTable(headers, dataRows) {
    const colCount = Math.max(
        headers.length,
        ...dataRows.map(row => row.length)
    );
    if (colCount === 0) return '';
    const padRow = (row) => {
        const padded = [];
        for (let i = 0; i < colCount; i += 1) {
            padded.push(escapePipeCell(row[i] || ''));
        }
        return `| ${padded.join(' | ')} |`;
    };
    const sep = `| ${Array(colCount).fill('---').join(' | ')} |`;
    return [padRow(headers), sep, ...dataRows.map(padRow)].join('\n');
}

function isMetadataRevisionTable(headers, dataRows) {
    const headerJoined = headers.join(' ');
    if (FUNCTIONAL_HEADER_RE.test(headerJoined)) return false;
    const metaCols = headers.filter(h => METADATA_HEADER_RE.test(h)).length;
    if (metaCols >= 2) return true;
    // Key-value cover info tables (2 cols, <= 12 rows, e.g. 项目名称 / 版本号 / 编写人 / 日期)
    if (headers.length <= 4 && dataRows.length <= 10) {
        const allFirstCol = [headers[0], ...dataRows.map(r => r[0] || '')].join(' ');
        const hits = (allFirstCol.match(/(?:文档编号|版本号|文档状态|编制单位|编写人|起草人|审核人|批准人|签发人|修订日期|发布日期|密级|项目编号)/g) || []).length;
        const bodyText = dataRows.map(r => r.join(' ')).join(' ');
        if (hits >= 3 && !ACTION_VERB_RE.test(bodyText)) return true;
    }
    return false;
}

function findFieldTableColumns(headers) {
    const headerJoined = headers.join(' ');
    if (FUNCTIONAL_HEADER_RE.test(headerJoined)) return null;
    const fieldColIndex = headers.findIndex(h => FIELD_NAME_HEADER_RE.test(h.replace(/[（(].*?[)）]/g, '').trim()));
    if (fieldColIndex < 0) return null;
    const schemaHits = headers.filter((h, idx) => idx !== fieldColIndex && SCHEMA_META_HEADER_RE.test(h)).length;
    if (schemaHits < 1) return null;
    const ruleColIndexes = [];
    headers.forEach((h, idx) => {
        if (idx !== fieldColIndex && RULE_COLUMN_HEADER_RE.test(h)) {
            ruleColIndexes.push(idx);
        }
    });
    return { fieldColIndex, ruleColIndexes };
}

function compactFieldDefinitionTable(headers, dataRows, { fieldColIndex, ruleColIndexes }) {
    const fieldNames = [];
    const seenFields = new Set();
    const ruleNotes = [];

    for (const row of dataRows) {
        const rawName = String(row[fieldColIndex] || '').trim();
        if (!rawName) continue;
        if (!seenFields.has(rawName)) {
            seenFields.add(rawName);
            fieldNames.push(rawName);
        }
        if (ruleColIndexes.length > 0) {
            const ruleText = ruleColIndexes
                .map(idx => String(row[idx] || '').trim())
                .filter(cell => cell && !PURE_TYPE_ONLY_RE.test(cell))
                .join('；');
            if (ruleText && (ruleText.length >= 12 || RULE_SIGNAL_RE.test(ruleText))) {
                ruleNotes.push(`- ${rawName}：${ruleText}`);
            }
        }
    }

    if (fieldNames.length === 0) return null;
    const lines = [`【字段清单（共${fieldNames.length}项）】${fieldNames.join('、')}`];
    if (ruleNotes.length > 0) {
        lines.push('【字段口径与规则】');
        lines.push(...ruleNotes);
    }
    return lines.join('\n');
}

function isLargeStaticDataTable(headers, dataRows) {
    if (dataRows.length < 25) return false;
    const headerJoined = headers.join(' ');
    if (FUNCTIONAL_HEADER_RE.test(headerJoined)) return false;
    let actionRowCount = 0;
    for (const row of dataRows) {
        if (ACTION_VERB_RE.test(row.join(' '))) actionRowCount += 1;
    }
    return (actionRowCount / dataRows.length) < 0.15;
}

function formatHtmlTable(tableHtml, stats) {
    const rows = parseHtmlTable(tableHtml);
    if (rows.length === 0) return '';
    const headers = rows[0];
    const dataRows = rows.slice(1);
    const rawTableTextLen = rows.map(r => r.join('\n')).join('\n').length;

    if (isMetadataRevisionTable(headers, dataRows)) {
        stats.removedMetadataTables += 1;
        stats.savedTableChars += rawTableTextLen;
        return '';
    }

    if (dataRows.length >= 10) {
        const fieldCols = findFieldTableColumns(headers);
        if (fieldCols) {
            const compacted = compactFieldDefinitionTable(headers, dataRows, fieldCols);
            if (compacted && compacted.length < rawTableTextLen * 0.88) {
                stats.compactedFieldTables += 1;
                stats.savedTableChars += Math.max(0, rawTableTextLen - compacted.length);
                return `\n\n${compacted}\n\n`;
            }
        }
    }

    if (isLargeStaticDataTable(headers, dataRows)) {
        const sampleRows = dataRows.slice(0, 5);
        const folded = `${formatMarkdownPipeTable(headers, sampleRows)}\n（注：以上为前 5 行示例，共 ${dataRows.length} 行静态明细/枚举数据，已自动折叠其余 ${dataRows.length - 5} 行）`;
        stats.foldedLargeTables += 1;
        stats.savedTableChars += Math.max(0, rawTableTextLen - folded.length);
        return `\n\n${folded}\n\n`;
    }

    stats.preservedFunctionalTables += 1;
    return `\n\n${formatMarkdownPipeTable(headers, dataRows)}\n\n`;
}

// ── HTML → Clean Markdown ──

function convertDocxHtmlToMarkdown(html, stats) {
    const source = String(html || '');
    const anchorMatches = source.match(/<a\b[^>]*\bid=["'][^"']*["'][^>]*>\s*<\/a>/gi);
    if (anchorMatches) stats.removedAnchors += anchorMatches.length;

    const imgMatches = source.match(/<img\b[^>]*>/gi);
    if (imgMatches) stats.removedImages += imgMatches.length;

    // Extract tables first into unique placeholders so inner <p>/<ul> tags don't break table formatting.
    const tableBlocks = [];
    let working = source.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
        const formatted = formatHtmlTable(tableHtml, stats);
        const token = `\u0000TABLE_${tableBlocks.length}\u0000`;
        tableBlocks.push(formatted);
        return `\n\n${token}\n\n`;
    });

    // Drop single paragraphs that are strictly Word internal TOC links (<p><a href="#_Toc...">...</a></p>).
    // Match strictly within one <p>...</p> element so adjacent body paragraphs can never be swallowed.
    working = working.replace(/<p\b[^>]*>((?:(?!<\/p>)[\s\S])*)<\/p>/gi, (full, inner) => {
        if (/^\s*(?:<a\b[^>]*\bhref=["']#_Toc[^"']*["'][^>]*>(?:(?!<\/a>)[\s\S])*<\/a>\s*)+$/i.test(inner)) {
            stats.removedTocLines += 1;
            return '\n';
        }
        return full;
    });

    // Strip bookmark anchors & images globally.
    working = working
        .replace(/<a\b[^>]*\bid=["'][^"']*["'][^>]*>\s*<\/a>/gi, '')
        .replace(/<img\b[^>]*>/gi, '');

    // Convert headings <h1>..<h6> cleanly (strip bold/anchor wrappers inside headings).
    // Keep HTML entities encoded until AFTER all tag stripping so literal `<` / `>` in
    // formulas (e.g. `掉话率>1%`, `使用率<30%`) can never be misinterpreted as HTML tags!
    working = working.replace(/<h([1-6])\b[^>]*>((?:(?!<\/h\1>)[\s\S])*)<\/h\1>/gi, (_, level, inner) => {
        const text = unwrapBoldAndAnchors(stripInlineHtmlTagsOnly(inner));
        if (!text) return '\n';
        return `\n\n${'#'.repeat(Number(level))} ${text}\n\n`;
    });

    // Convert list items & paragraphs (strictly single-element bounded, entities still encoded).
    working = working
        .replace(/<li\b[^>]*>((?:(?!<\/li>)[\s\S])*)<\/li>/gi, (_, inner) => {
            const text = stripInlineHtmlTagsOnly(inner);
            return text ? `\n- ${text}` : '';
        })
        .replace(/<\/?(?:ul|ol|thead|tbody|tfoot|div|section|article|header|footer|blockquote)\b[^>]*>/gi, '\n')
        .replace(/<p\b[^>]*>((?:(?!<\/p>)[\s\S])*)<\/p>/gi, (_, inner) => {
            const text = stripInlineHtmlTagsOnly(inner);
            return text ? `\n${text}\n` : '\n';
        })
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '');

    // Decode HTML entities ONLY after every HTML tag has been stripped.
    working = decodeHtmlEntities(working);

    // Restore formatted tables (already entity-decoded).
    working = working.replace(/\u0000TABLE_(\d+)\u0000/g, (_, idx) => tableBlocks[Number(idx)] || '');
    return working;
}

// ── TOC / Placeholder / Heading Restoration on Markdown ──

const TOC_LINK_LINE_RE = /^\[[^\]]+\]\(#_Toc\d+\)$/;
const TOC_HEADER_LINE_RE = /^(?:#{1,6}\s+)?(?:目\s*录|contents)$/i;
const TOC_DOT_LEADER_LINE_RE = /^.{1,80}(?:\.{3,}|…{2,}|·{3,}|\t)\s*\d{1,4}\s*$/;
const PURE_PLACEHOLDER_LINE_RE = /^(?:X{4,}|x{4,}|待补充|待完善|暂无|无|N\/A|【(?:请在此|此处|说明|填写说明|描述|示例)[^】]{0,60}】|（(?:请在此|此处|填写说明)[^）]{0,60}）|\[(?:请在此|此处|填写说明)[^\]]{0,60}\])$/i;

function stripTocAndNoiseLines(text, stats) {
    const lines = String(text || '').split(/\r?\n/);
    const kept = [];
    let inTocBlock = false;
    let tocBlankStreak = 0;

    for (let i = 0; i < lines.length; i += 1) {
        const rawLine = lines[i];
        const cleanedLine = cleanInlineMarkdownNoise(rawLine);
        const trimmed = cleanedLine.trim();

        // Count anchor/image removals on pure markdown inputs (when HTML path wasn't used)
        if (rawLine !== cleanedLine) {
            const anchors = rawLine.match(/<a\b[^>]*>\s*<\/a>/gi);
            if (anchors) stats.removedAnchors += anchors.length;
            const imgs = rawLine.match(/!\[[^\]]*\]\([^)]*\)/g);
            if (imgs) stats.removedImages += imgs.length;
        }

        // Remove explicit Word TOC links anywhere
        if (TOC_LINK_LINE_RE.test(trimmed)) {
            stats.removedTocLines += 1;
            continue;
        }

        // Detect TOC section header ("目录" / "__目  录__")
        if (TOC_HEADER_LINE_RE.test(unwrapBoldAndAnchors(trimmed))) {
            // Look ahead: either TOC lines follow, OR TOC links were already stripped
            // in the HTML pass so the very next non-empty line is a real heading.
            let tocLookaheadHits = 0;
            let firstNonEmpty = '';
            for (let j = i + 1; j < Math.min(lines.length, i + 15); j += 1) {
                const nextTrimmed = cleanInlineMarkdownNoise(lines[j]).trim();
                if (!nextTrimmed) continue;
                if (!firstNonEmpty) firstNonEmpty = nextTrimmed;
                if (TOC_LINK_LINE_RE.test(nextTrimmed) || TOC_DOT_LEADER_LINE_RE.test(nextTrimmed) || /^\d+(?:\.\d+)*[\s.、]+.{1,50}\s+\d{1,3}$/.test(nextTrimmed)) {
                    tocLookaheadHits += 1;
                }
            }
            const nextIsHeading = /^#{1,6}\s+/.test(firstNonEmpty)
                || /^(?:第[一二三四五六七八九十\d]+[章节]|[一二三四五六七八九十]+[、.]|\d+(?:\.\d+)*[\s.、])/.test(firstNonEmpty);
            if (tocLookaheadHits >= 2) {
                inTocBlock = true;
                tocBlankStreak = 0;
                stats.removedTocLines += 1;
                continue;
            }
            if (nextIsHeading) {
                stats.removedTocLines += 1;
                continue;
            }
        }

        if (inTocBlock) {
            if (!trimmed) {
                tocBlankStreak += 1;
                if (tocBlankStreak >= 3) inTocBlock = false;
                continue;
            }
            tocBlankStreak = 0;
            const looksLikeTocEntry = (
                TOC_LINK_LINE_RE.test(trimmed)
                || TOC_DOT_LEADER_LINE_RE.test(trimmed)
                || (/^\d+(?:\.\d+)*[\s.、]+.{1,50}\s+\d{1,3}$/.test(trimmed) && !/^#{1,6}\s/.test(trimmed))
                || (/^(?:第[一二三四五六七八九十\d]+[章节]|[一二三四五六七八九十]+[、.]|（[一二三四五六七八九十\d]+）).{1,50}\s+\d{1,3}$/.test(trimmed))
            );
            if (looksLikeTocEntry) {
                stats.removedTocLines += 1;
                continue;
            }
            // First real heading or body paragraph exits the TOC block
            inTocBlock = false;
        }

        if (TOC_DOT_LEADER_LINE_RE.test(trimmed) && !/^\|/.test(trimmed)) {
            stats.removedTocLines += 1;
            continue;
        }

        if (PURE_PLACEHOLDER_LINE_RE.test(trimmed)) {
            stats.removedPlaceholders += 1;
            continue;
        }

        kept.push(cleanedLine);
    }

    return kept.join('\n');
}

function restoreWordHeadingNumbers(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const headingRows = lines
        .map((line, index) => {
            const match = line.trim().match(/^(#{1,6})\s+(.+)$/);
            if (!match) return null;
            const title = unwrapBoldAndAnchors(match[2]);
            if (!title) return null;
            return {
                index,
                level: match[1].length,
                title,
            };
        })
        .filter(Boolean);

    if (headingRows.length === 0) {
        return cleanInlineMarkdownNoise(markdown)
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // Word cover/document titles are frequently Heading 1 too. When the first
    // two headings are adjacent peers, keep the first as an unnumbered title.
    const first = headingRows[0];
    const second = headingRows[1];
    const textBetweenFirstTwo = second
        ? lines.slice(first.index + 1, second.index).join('').trim()
        : '';
    const skipFirstAsDocumentTitle = Boolean(
        second
        && first.level === second.level
        && !textBetweenFirstTwo
        && /需求|说明书|文档|内容|方案|报告|设计|规格|项目/.test(first.title)
    );

    const structuralRows = skipFirstAsDocumentTitle ? headingRows.slice(1) : headingRows;
    const baseLevel = Math.min(...structuralRows.map(row => row.level));
    const counters = Array(6).fill(0);
    const replacements = new Map();

    headingRows.forEach((row, rowIndex) => {
        if (skipFirstAsDocumentTitle && rowIndex === 0) {
            replacements.set(row.index, row.title);
            return;
        }
        if (/^(?:目\s*录|contents)$/i.test(row.title)) {
            replacements.set(row.index, row.title);
            return;
        }

        const counterIndex = row.level - baseLevel;
        for (let i = 0; i < counterIndex; i++) {
            if (counters[i] === 0) counters[i] = 1;
        }
        counters[counterIndex] += 1;
        counters.fill(0, counterIndex + 1);

        // Do not duplicate numbers that were typed into the heading itself (Arabic or Chinese chapter numbers).
        if (/^(?:\d+(?:\.\d+)*[.、\s]|第[一二三四五六七八九十百千\d]+[章节篇]|[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十\d]+[）)])/.test(row.title)) {
            replacements.set(row.index, row.title);
            return;
        }
        const number = counters.slice(0, counterIndex + 1).join('.');
        replacements.set(row.index, `${number}. ${row.title}`);
    });

    return lines
        .map((line, index) => replacements.has(index) ? replacements.get(index) : line)
        .join('\n')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<a\b[^>]*>\s*<\/a>/gi, '')
        .replace(/\\([.>\-])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function preprocessDocument({ html = null, markdown = null, restoreHeadings = true } = {}) {
    const stats = {
        applied: false,
        rawChars: 0,
        cleanedChars: 0,
        savedChars: 0,
        savedPercent: 0,
        removedAnchors: 0,
        removedImages: 0,
        removedTocLines: 0,
        removedPlaceholders: 0,
        removedMetadataTables: 0,
        compactedFieldTables: 0,
        foldedLargeTables: 0,
        preservedFunctionalTables: 0,
        savedTableChars: 0,
    };

    let working = '';
    if (html != null) {
        // Compute raw baseline length matching Mammoth's uncompacted block/cell output.
        const rawBaseline = decodeHtmlEntities(
            String(html)
                .replace(/<img\b[^>]*>/gi, '')
                .replace(/<\/(?:p|div|h[1-6]|li|tr|td|th)>/gi, '\n\n')
                .replace(/<[^>]+>/g, '')
        ).replace(/\n{3,}/g, '\n\n').trim();
        stats.rawChars = rawBaseline.length;
        working = convertDocxHtmlToMarkdown(html, stats);
    } else {
        const rawText = String(markdown || '');
        stats.rawChars = rawText.length;
        working = rawText;
    }

    working = stripTocAndNoiseLines(working, stats);
    const cleaned = restoreHeadings
        ? restoreWordHeadingNumbers(working)
        : working.replace(/\n{3,}/g, '\n\n').trim();

    stats.cleanedChars = cleaned.length;
    stats.savedChars = Math.max(0, stats.rawChars - stats.cleanedChars);
    stats.savedPercent = stats.rawChars > 0
        ? Math.round((stats.savedChars / stats.rawChars) * 100)
        : 0;
    stats.applied = (
        stats.savedChars > 0
        || stats.removedAnchors > 0
        || stats.removedTocLines > 0
        || stats.removedMetadataTables > 0
        || stats.compactedFieldTables > 0
        || stats.foldedLargeTables > 0
    );

    return { text: cleaned, stats };
}

module.exports = {
    preprocessDocument,
    restoreWordHeadingNumbers,
    convertDocxHtmlToMarkdown,
    stripTocAndNoiseLines,
};
