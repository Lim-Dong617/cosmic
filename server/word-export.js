const docx = require('docx');
const { WordDocumentWriter, writeWordPackage } = require('./word-export-package');
const { orderCosmicTableData } = require('./cosmic-quality');
const { buildXinjiangWordDocument } = require('./xinjiang-word-export');
const { createHttpError } = require('./async-job-manager');
const { sanitizeText, normalizeProcessName, normalizeFunctionDescription, buildFunctionDescription, ensureFunctionDescriptions, orderSequenceDiagrams } = require('./function-description');

function escapeXmlAttr(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function stripManualHeadingNumber(text) {
    return String(text || '').replace(/^\s*\d+(?:\.\d+)*\.?\s*/, '').trim();
}

function nextWordNumberingId(xml, attrName) {
    const regex = new RegExp(`w:${attrName}="(\\d+)"`, 'g');
    let max = 0;
    let match;
    while ((match = regex.exec(xml))) {
        max = Math.max(max, Number(match[1]));
    }
    return max + 1;
}

function getWordStyleBlocks(stylesXml) {
    return [...String(stylesXml || '').matchAll(/<w:style\b(?=[^>]*w:type="paragraph")[^>]*>[\s\S]*?<\/w:style>/g)]
        .map(match => match[0]);
}

function detectHeadingStyleIds(stylesXml) {
    const byName = {};
    const byOutline = {};
    const maxWordHeadingLevel = 9;

    for (const block of getWordStyleBlocks(stylesXml)) {
        const styleId = block.match(/\bw:styleId="([^"]+)"/)?.[1];
        if (!styleId) continue;

        const name = block.match(/<w:name\b[^>]*\bw:val="([^"]*)"/)?.[1] || '';
        const outline = block.match(/<w:outlineLvl\b[^>]*\bw:val="(\d+)"/)?.[1];
        const headingName = name.toLowerCase().match(/^heading\s+([1-9])$/);
        const chineseHeadingName = name.match(/^标题\s*([1-9])$/);

        if (headingName) byName[Number(headingName[1]) - 1] = styleId;
        if (chineseHeadingName) byName[Number(chineseHeadingName[1]) - 1] = styleId;
        if (outline && Number(outline) >= 0 && Number(outline) < maxWordHeadingLevel) {
            byOutline[Number(outline)] ||= styleId;
        }
    }

    const detectedLevels = [
        ...Object.keys(byName).map(Number),
        ...Object.keys(byOutline).map(Number)
    ];
    const highestLevel = Math.max(3, ...detectedLevels);

    return Array.from({ length: highestLevel + 1 }, (_, level) => (
        byName[level]
        || byOutline[level]
        || `Heading${level + 1}`
    ));
}

function buildHeadingNumberingLevel(level, styleId) {
    const lvlText = Array.from({ length: level + 1 }, (_, index) => `%${index + 1}`).join('.') + '.';
    const safeStyleId = escapeXmlAttr(styleId);
    return [
        `<w:lvl w:ilvl="${level}">`,
        '<w:start w:val="1"/>',
        '<w:numFmt w:val="decimal"/>',
        `<w:pStyle w:val="${safeStyleId}"/>`,
        '<w:suff w:val="space"/>',
        `<w:lvlText w:val="${lvlText}"/>`,
        '<w:lvlJc w:val="left"/>',
        '<w:pPr><w:ind w:left="0" w:hanging="0"/></w:pPr>',
        '</w:lvl>'
    ].join('');
}

function addHeadingNumberingDefinition(numberingXml, headingStyleIds) {
    if (!numberingXml || !numberingXml.includes('</w:numbering>')) return { xml: numberingXml, numId: null };

    const abstractNumId = nextWordNumberingId(numberingXml, 'abstractNumId');
    const numId = nextWordNumberingId(numberingXml, 'numId');
    const levelsXml = headingStyleIds
        .map((styleId, level) => buildHeadingNumberingLevel(level, styleId))
        .join('');

    const definition = [
        `<w:abstractNum w:abstractNumId="${abstractNumId}">`,
        '<w:nsid w:val="6B9E4A21"/>',
        '<w:multiLevelType w:val="multilevel"/>',
        '<w:tmpl w:val="6B9E4A21"/>',
        levelsXml,
        '</w:abstractNum>',
        `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractNumId}"/></w:num>`
    ].join('');

    return {
        xml: numberingXml.replace('</w:numbering>', `${definition}</w:numbering>`),
        numId
    };
}

function buildNumPr(level, numId) {
    return `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`;
}

function setHeadingStyleNumbering(stylesXml, headingStyleIds, numId) {
    let xml = stylesXml;

    headingStyleIds.forEach((styleId, level) => {
        const escapedStyleId = styleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const styleRegex = new RegExp(`<w:style\\b(?=[^>]*w:styleId="${escapedStyleId}")[^>]*>[\\s\\S]*?<\\/w:style>`);
        xml = xml.replace(styleRegex, (styleBlock) => {
            const numPr = buildNumPr(level, numId);
            const outline = `<w:outlineLvl w:val="${level}"/>`;
            if (/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/.test(styleBlock)) {
                return styleBlock.replace(/<w:pPr\b([^>]*)>([\s\S]*?)<\/w:pPr>/, (_match, attrs, inner) => {
                    const cleaned = inner
                        .replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, '')
                        .replace(/<w:outlineLvl\b[^>]*\/>/g, '');
                    return `<w:pPr${attrs}>${cleaned}${numPr}${outline}</w:pPr>`;
                });
            }
            return styleBlock.replace(/(<w:name\b[^>]*\/>)/, `$1<w:pPr>${numPr}${outline}</w:pPr>`);
        });
    });

    return xml;
}

function clearHeadingParagraphNumberingOverrides(documentXml, headingStyleIds) {
    const headingStyles = new Set(headingStyleIds);
    return documentXml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) => {
        const styleId = paragraphXml.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/)?.[1];
        if (!headingStyles.has(styleId)) return paragraphXml;

        if (/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/.test(paragraphXml)) {
            return paragraphXml.replace(/<w:pPr\b([^>]*)>([\s\S]*?)<\/w:pPr>/, (_match, attrs, inner) => {
                const cleaned = inner.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, '');
                return `<w:pPr${attrs}>${cleaned}</w:pPr>`;
            });
        }
        return paragraphXml;
    });
}

function setUpdateFieldsOnOpen(settingsXml) {
    if (!settingsXml || !settingsXml.includes('</w:settings>')) return settingsXml;
    if (/<w:updateFields\b/.test(settingsXml)) {
        return settingsXml.replace(/<w:updateFields\b[^>]*\/>/, '<w:updateFields w:val="true"/>');
    }
    return settingsXml.replace('</w:settings>', '<w:updateFields w:val="true"/></w:settings>');
}

async function applyAutoHeadingNumbering(zip) {
    const documentFile = zip.file('word/document.xml');
    const stylesFile = zip.file('word/styles.xml');
    const numberingFile = zip.file('word/numbering.xml');

    if (!documentFile || !stylesFile || !numberingFile) return zip;

    let documentXml = await documentFile.async('string');
    let stylesXml = await stylesFile.async('string');
    let numberingXml = await numberingFile.async('string');
    const headingStyleIds = detectHeadingStyleIds(stylesXml);
    const { xml: patchedNumberingXml, numId } = addHeadingNumberingDefinition(numberingXml, headingStyleIds);

    if (!numId) return zip;

    numberingXml = patchedNumberingXml;
    stylesXml = setHeadingStyleNumbering(stylesXml, headingStyleIds, numId);
    // 标题编号只由 Heading 样式控制。段落级 numPr 会把标题锁死在某个
    // numId 上，用户后来插入一级标题或调整章节时，子标题就无法跟随更新。
    documentXml = clearHeadingParagraphNumberingOverrides(documentXml, headingStyleIds);

    zip.file('word/numbering.xml', numberingXml);
    zip.file('word/styles.xml', stylesXml);
    zip.file('word/document.xml', documentXml);

    const settingsFile = zip.file('word/settings.xml');
    if (settingsFile) {
        zip.file('word/settings.xml', setUpdateFieldsOnOpen(await settingsFile.async('string')));
    }

    return zip;
}

async function buildWordDocument(payload = {}, { outputPath } = {}) {
    const {
        tableData,
        filename = 'COSMIC功能规格说明书',
        sequenceDiagrams,
        documentName,
        exportTemplate = 'hierarchy'
    } = payload;

    if (!Array.isArray(tableData) || tableData.length === 0) {
        throw createHttpError('没有可导出的数据', 400, 'WORD_EXPORT_EMPTY');
    }

    if (exportTemplate === 'xinjiang') {
        const buffer = await buildXinjiangWordDocument({
            tableData: orderCosmicTableData(tableData), sequenceDiagrams, documentName, filename,
            buildDescription: buildFunctionDescription, outputPath
        });
        return buffer;
    }

    // 检查是否有功能描述数据
    const hasDescription = tableData.some(r => r.functionDescription);
    const exportTableData = hasDescription ? ensureFunctionDescriptions(orderCosmicTableData(tableData)) : orderCosmicTableData(tableData);
    const orderedSequenceDiagrams = orderSequenceDiagrams(sequenceDiagrams, exportTableData);
    const hasSequenceDiagrams = Boolean(orderedSequenceDiagrams?.some(diagram => diagram?.imageBase64));
    const isHierarchyTemplate = exportTemplate !== 'business-spec';

    console.log(`📝 开始生成Word文档，共 ${exportTableData.length} 行数据...`);

    const {
        Document, Paragraph, TextRun, HeadingLevel, ImageRun,
        AlignmentType, BorderStyle, Table, TableRow, TableCell, WidthType,
        VerticalAlign, TableOfContents
    } = docx;

    const font = '微软雅黑';
    const cleanFilename = String(documentName || filename || 'XX项目需求')
        .replace(/^COSMIC功能规格说明书[_-]?/, '')
        .replace(/^COSMIC拆分[_-]?/, '')
        .replace(/\.(docx|xlsx|xlsm|xls)$/i, '')
        .trim();
    const projectTitle = cleanFilename || 'XX项目需求';
    const requirementTitle = /需求/.test(projectTitle) ? projectTitle : `${projectTitle}需求`;
    const now = new Date();
    const issueMonth = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`;

    // ── 1. 将 tableData 按功能过程分组 ──
    const functionGroups = [];
    let currentGroup = null;
    let currentFuncUser = '';
    let currentTrigger = '';
    let currentL1 = '';
    let currentL2 = '';
    let currentL3 = '';
    let currentL4 = '';

    for (const row of exportTableData) {
        if (row.level1) currentL1 = row.level1;
        if (row.level2) currentL2 = row.level2;
        if (row.level3) currentL3 = row.level3;
        if (row.level4) currentL4 = row.level4;

        if (row.dataMovementType === 'E' && row.functionalProcess) {
            if (row.functionalUser) currentFuncUser = row.functionalUser;
            if (row.triggerEvent) currentTrigger = row.triggerEvent;
            currentGroup = {
                functionalProcess: row.functionalProcess,
                functionalUser: currentFuncUser,
                triggerEvent: currentTrigger,
                functionDescription: row.functionDescription || '',
                cleanName: row.functionalProcess.replace(/\[.*?\]\s*/, '').trim(),
                level1: row.level1 || currentL1 || '',
                level2: row.level2 || currentL2 || '',
                level3: row.level3 || currentL3 || '',
                level4: row.level4 || currentL4 || '',
                rows: [row]
            };
            functionGroups.push(currentGroup);
        } else if (currentGroup) {
            currentGroup.rows.push(row);
        }
    }

    const uniqueFuncs = functionGroups.map(g => g.functionalProcess);
    const totalCfp = exportTableData.length;
    const eCount = exportTableData.filter(r => r.dataMovementType === 'E').length;
    const rCount = exportTableData.filter(r => r.dataMovementType === 'R').length;
    const wCount = exportTableData.filter(r => r.dataMovementType === 'W').length;
    const xCount = exportTableData.filter(r => r.dataMovementType === 'X').length;

    // ── 2. 构建时序图映射 ──
    const diagramMap = new Map();
    if (orderedSequenceDiagrams && orderedSequenceDiagrams.length > 0) {
        for (const diag of orderedSequenceDiagrams) {
            if (diag.processName) {
                diagramMap.set(diag.processName, diag);
                diagramMap.set(normalizeProcessName(diag.processName), diag);
            }
        }
    }

    const paragraph = (text, options = {}) => new Paragraph({
        children: [new TextRun({
            text: String(text || ''),
            bold: Boolean(options.bold),
            italics: Boolean(options.italics),
            size: options.size || 21,
            color: options.color || '333333',
            font
        })],
        alignment: options.alignment,
        heading: options.heading,
        spacing: options.spacing || { after: 120, line: 300 },
        indent: options.indent,
        border: options.border
    });

    const heading = (text, level, color = '1A1A2E') => paragraph(stripManualHeadingNumber(text), {
        bold: true,
        size: level === 1 ? 32 : level === 2 ? 27 : level === 3 ? 23 : 21,
        color,
        heading: level === 1
            ? HeadingLevel.HEADING_1
            : level === 2
                ? HeadingLevel.HEADING_2
                : level === 3
                    ? HeadingLevel.HEADING_3
                    : HeadingLevel.HEADING_4,
        spacing: { before: level === 1 ? 560 : level === 4 ? 260 : 320, after: 180 }
    });

    const tableCell = (text, options = {}) => new TableCell({
        children: [paragraph(text, {
            bold: options.bold,
            size: options.size || 18,
            color: options.color || '333333',
            alignment: options.alignment,
            spacing: { after: 0, line: 260 }
        })],
        width: options.width ? { size: options.width, type: WidthType.DXA } : undefined,
        margins: { top: 90, bottom: 90, left: 120, right: 120 },
        verticalAlign: VerticalAlign.CENTER,
        shading: options.fill ? { fill: options.fill } : undefined
    });

    const simpleTable = (headers, rows, widths = []) => docChildren.table(rows, batchRows => new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
            new TableRow({
                tableHeader: true,
                children: headers.map((header, index) => tableCell(header, {
                    bold: true,
                    color: 'FFFFFF',
                    fill: '1F4E78',
                    alignment: AlignmentType.CENTER,
                    width: widths[index]
                }))
            }),
            ...batchRows.map(row => new TableRow({
                children: row.map((cell, index) => tableCell(cell, {
                    alignment: index === 0 ? AlignmentType.CENTER : undefined,
                    width: widths[index]
                }))
            }))
        ]
    }));

    const moduleSummaryMap = new Map();
    for (const group of functionGroups) {
        const key = [group.level1 || '', group.level2 || '', group.level3 || '', group.level4 || ''].join('\u0001');
        if (!moduleSummaryMap.has(key)) {
            moduleSummaryMap.set(key, {
                level1: group.level1 || '未指定',
                level2: group.level2 || '未指定',
                level3: group.level3 || '未指定',
                level4: group.level4 || '',
                funcCount: 0,
                cfp: 0
            });
        }
        const item = moduleSummaryMap.get(key);
        item.funcCount += 1;
        item.cfp += group.rows.length;
    }
    const moduleSummaryRows = [...moduleSummaryMap.values()].map((item, index) => [
        String(index + 1),
        item.level1,
        item.level2,
        item.level4 || item.level3,
        String(item.funcCount),
        String(item.cfp)
    ]);

    const createDocument = children => new Document({
        creator: 'COSMIC 拆分智能分析系统',
        title: requirementTitle,
        description: '业务需求说明书 - 自动生成',
        styles: {
            default: {
                document: {
                    run: { font: '微软雅黑', size: 21 }
                }
            }
        },
        sections: [{
            properties: {
                page: {
                    margin: { top: 1440, right: 1080, bottom: 1440, left: 1080 }
                }
            },
            children
        }]
    });

    const docChildren = new WordDocumentWriter(createDocument);
    const appendSequenceDiagram = async (group, { includeSteps = false } = {}) => {
        const diagram = diagramMap.get(group.functionalProcess)
            || diagramMap.get(normalizeProcessName(group.functionalProcess));
        if (!diagram?.imageBase64) return false;

        await docChildren.push(paragraph('关键时序图/业务逻辑图', {
            bold: true,
            size: 20,
            color: '1F4E78',
            spacing: { before: 180, after: 120 }
        }));
        try {
            const imgBuffer = Buffer.from(diagram.imageBase64, 'base64');
            const imgWidth = diagram.width || 800;
            const imgHeight = diagram.height || 400;
            const maxWidth = 550;
            const scale = Math.min(1, maxWidth / imgWidth);
            const displayWidth = Math.round(imgWidth * scale);
            const displayHeight = Math.round(imgHeight * scale);

            await docChildren.push(new Paragraph({
                children: [new ImageRun({
                    data: imgBuffer,
                    transformation: { width: displayWidth, height: displayHeight },
                    type: 'png'
                })],
                alignment: AlignmentType.CENTER,
                spacing: { after: 200 }
            }));
        } catch (imgErr) {
            console.warn(`  ⚠️ 时序图嵌入失败 (${group.cleanName}):`, imgErr.message);
            await docChildren.push(paragraph(`[时序图嵌入失败: ${imgErr.message}]`, { color: 'E74C3C' }));
        }

        if (includeSteps) {
            await docChildren.push(paragraph('本时序图步骤如下：', { bold: true }));
            for (const [index, row] of group.rows.entries()) {
                const dmtLabels = { E: '进入', R: '读取', W: '写入', X: '退出' };
                const dmtLabel = dmtLabels[row.dataMovementType] || row.dataMovementType;
                await docChildren.push(paragraph(`${index + 1}）${row.subProcessDesc || ''}（${dmtLabel}${row.dataGroup ? ` - ${row.dataGroup}` : ''}）`, {
                    indent: { left: 480 },
                    spacing: { after: 60, line: 280 }
                }));
            }
        }
        return true;
    };

    // 封面：参考“XX项目需求 / 业务需求说明书 / 公司 / 年月”模板。
    await docChildren.push(
        paragraph(requirementTitle, {
            bold: true,
            size: 42,
            color: '1F4E78',
            alignment: AlignmentType.CENTER,
            spacing: { before: 900, after: 360 }
        }),
        paragraph('业务需求说明书', {
            bold: true,
            size: 34,
            color: '333333',
            alignment: AlignmentType.CENTER,
            spacing: { after: 720 }
        }),
        paragraph(`功能过程 ${uniqueFuncs.length} 个    CFP ${totalCfp}    E/R/W/X ${eCount}/${rCount}/${wCount}/${xCount}`, {
            size: 21,
            color: '666666',
            alignment: AlignmentType.CENTER,
            spacing: { after: 900 }
        }),
        paragraph('COSMIC 拆分智能分析系统', {
            size: 22,
            color: '666666',
            alignment: AlignmentType.CENTER,
            spacing: { before: 900, after: 120 }
        }),
        paragraph(issueMonth, {
            size: 21,
            color: '666666',
            alignment: AlignmentType.CENTER,
            spacing: { after: 600 }
        }),
        new Paragraph({
            children: [new TextRun({ text: '', font })],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1F4E78' } },
            spacing: { after: 360 }
        }),
        paragraph('目录', { bold: true, size: 28, color: '1F4E78', spacing: { before: 300, after: 120 } }),
        new TableOfContents('目录', { hyperlink: true, headingStyleRange: isHierarchyTemplate ? '1-4' : '1-3' })
    );

    if (isHierarchyTemplate) {
        let lastLevel1 = '';
        let lastLevel2Key = '';
        let lastLevel3Key = '';

        for (const group of functionGroups) {
            const level1 = sanitizeText(group.level1) || '未指定一级模块';
            const level2 = sanitizeText(group.level2) || '未指定二级模块';
            // 用户指定第三级目录取“四级模块”。兼容目前附件中仍命名为
            // “三级模块”的旧模板：没有 level4 时回退到 level3。
            const level3 = sanitizeText(group.level4 || group.level3) || '未指定四级模块';
            const level2Key = `${level1}\u0001${level2}`;
            const level3Key = `${level2Key}\u0001${level3}`;

            if (level1 !== lastLevel1) {
                await docChildren.push(heading(level1, 1));
                lastLevel1 = level1;
                lastLevel2Key = '';
                lastLevel3Key = '';
            }
            if (level2Key !== lastLevel2Key) {
                await docChildren.push(heading(level2, 2));
                lastLevel2Key = level2Key;
                lastLevel3Key = '';
            }
            if (level3Key !== lastLevel3Key) {
                await docChildren.push(heading(level3, 3));
                lastLevel3Key = level3Key;
            }

            await docChildren.push(heading(group.cleanName || group.functionalProcess, 4, '1F4E78'));
            const functionDescription = group.functionDescription || buildFunctionDescription(
                group.functionalProcess,
                group.rows,
                '',
                group.functionalUser,
                group.triggerEvent
            );
            await docChildren.push(paragraph(normalizeFunctionDescription(functionDescription, group.functionalProcess)));
            await appendSequenceDiagram(group);
        }
    } else {
    await docChildren.push(heading('1. 需求说明', 1));
    await docChildren.push(heading('1.1. 总体描述', 2));
    await docChildren.push(paragraph(`本文档参考《附件1XX项目需求说明书V1.0.0》模板生成，基于已导入的 COSMIC 功能点拆分结果形成业务需求说明书。文档覆盖 ${uniqueFuncs.length} 个功能需求，合计 ${totalCfp} CFP，并为每个功能需求保留${hasSequenceDiagrams ? '关键时序图/业务逻辑图、' : ''}功能描述和数据移动步骤。`));
    await docChildren.push(heading('1.2. 建设目标', 2));
    await docChildren.push(paragraph('1）形成与功能模块层级一致的业务需求说明，便于评审、开发、测试和规模度量引用。'));
    await docChildren.push(paragraph('2）将 COSMIC 拆分中的功能过程、功能用户、触发事件、数据移动类型和数据组转化为可交付的需求描述。'));
    if (hasSequenceDiagrams) {
        await docChildren.push(paragraph('3）嵌入关键时序图/业务逻辑图，直观说明用户、系统和数据库之间的交互过程。'));
    }
    await docChildren.push(heading('1.3. 建设必要性', 2));
    await docChildren.push(paragraph('通过统一的需求说明书模板承载拆分结果，可以减少人工整理表格和文档的重复工作，提高需求材料、规模评估材料和后续研发材料之间的一致性。'));
    await docChildren.push(heading('1.4. 系统现状', 2));
    await docChildren.push(heading('1.4.1. 系统概况', 3));
    await docChildren.push(paragraph(`本次导入数据已识别 ${moduleSummaryRows.length || 1} 个功能模块组合，涉及 ${uniqueFuncs.length} 个功能过程。`));
    await docChildren.push(heading('1.4.2. 系统已实现功能', 3));
    await docChildren.push(paragraph('已实现或待建设功能以“需求功能清单”为准，清单中保留一级模块、二级模块、三级模块和对应功能需求名称。'));
    await docChildren.push(heading('1.4.3. 存在问题', 3));
    await docChildren.push(paragraph(`现有拆分表偏向规模评估口径，缺少面向阅读和评审的业务需求说明结构，因此需要转换为${hasSequenceDiagrams ? '带时序图和' : '带'}功能描述的需求说明书。`));

    await docChildren.push(heading('2. 功能架构图', 1));
    await docChildren.push(paragraph('功能架构图应分层分域展示一级、二级、三级模块。当前版本根据 COSMIC 拆分表中的模块字段自动生成模块清单，可在定稿时替换或补充正式架构图。'));
    if (moduleSummaryRows.length > 0) {
        await docChildren.push(await simpleTable(
            ['序号', '一级模块', '二级模块', '三级模块', '功能过程数', 'CFP'],
            moduleSummaryRows,
            [700, 2200, 2200, 2600, 1000, 900]
        ));
    }

    await docChildren.push(heading('3. 功能需求', 1));
    for (let fi = 0; fi < functionGroups.length; fi++) {
        const group = functionGroups[fi];
        const funcNumber = `3.${fi + 1}`;
        await docChildren.push(heading(`${funcNumber}. ${group.cleanName || group.functionalProcess}（新增）`, 2));
        await docChildren.push(paragraph(`一级模块：${group.level1 || '未指定'}    二级模块：${group.level2 || '未指定'}    三级模块：${group.level3 || '未指定'}`, { color: '666666', size: 19 }));
        await docChildren.push(paragraph(`功能用户：${group.functionalUser || '未指定'}    触发事件：${group.triggerEvent || '未指定'}`, { color: '666666', size: 19 }));

        await appendSequenceDiagram(group, { includeSteps: true });

        await docChildren.push(heading(`${funcNumber}.${hasSequenceDiagrams ? 2 : 1}. 功能描述`, 3, '1F4E78'));
        const functionDescription = group.functionDescription || buildFunctionDescription(
            group.functionalProcess,
            group.rows,
            '',
            group.functionalUser,
            group.triggerEvent
        );
        await docChildren.push(paragraph(functionDescription));
    }

    await docChildren.push(heading(`3.${functionGroups.length + 1}. 需求功能清单`, 2));
    await docChildren.push(await simpleTable(
        ['序号', '功能需求', '一级模块', '二级模块', '三级模块', 'CFP'],
        functionGroups.map((group, index) => [
            String(index + 1),
            group.cleanName || group.functionalProcess,
            group.level1 || '未指定',
            group.level2 || '未指定',
            group.level3 || '未指定',
            String(group.rows.length)
        ]),
        [700, 2600, 1800, 1800, 2300, 800]
    ));

    await docChildren.push(heading('4. 附加值调整因子说明', 1));
    await docChildren.push(paragraph('本章节参考模板保留附加值调整因子说明结构，具体取值可由评估人员结合项目实际情况确认。'));
    await docChildren.push(heading('4.1. 需求变更规模因子', 2));
    await docChildren.push(await simpleTable(
        ['需求变更规模因子(CF)', '描述', '调整因子'],
        [
            ['匡算', '项目投资阶段初步计算投资，是最粗略的投资测算。', '2.00'],
            ['概算', '项目可研阶段，根据有代表性的资料综合测算。', '1.50'],
            ['预算', '项目立项或采购阶段形成的相对明确测算。', '1.20'],
            ['结算', '项目实施完成后，按实际交付范围进行确认。', '1.00']
        ],
        [1800, 5600, 1200]
    ));
    await docChildren.push(heading('4.2. 应用领域', 2));
    await docChildren.push(await simpleTable(
        ['应用类型', '描述', '调整因子'],
        [
            ['业务处理', '办公自动化系统、日常管理及业务处理应用软件等。', '1.0'],
            ['应用集成', '企业服务总线、应用集成等。', '1.2'],
            ['实时控制', '对实时性、可靠性要求较高的控制类系统。', '1.4']
        ],
        [1800, 5600, 1200]
    ));
    await docChildren.push(heading('4.3. 质量及特性', 2));
    await docChildren.push(await simpleTable(
        ['质量特性', '判断标准', '建议取值'],
        [
            ['分布式处理', '通过网络进行客户端/服务器及网络基础应用分布处理和传输。', '按项目确认'],
            ['性能', '应答时间或处理率对高峰时间或业务时间较重要。', '按项目确认'],
            ['可靠性', '发生故障时修复难度、经济损失或业务影响较高。', '按项目确认']
        ],
        [1800, 5600, 1200]
    ));
    }

    // ── 6. 生成并发送文档 ──
    const zip = await applyAutoHeadingNumbering(await docChildren.finish());
    return writeWordPackage(zip, outputPath);
}

module.exports = { buildWordDocument };
