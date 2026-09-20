const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const { xml2js, js2xml } = require('xml-js');

// Keep the supplied OOXML package as the authority for styles, numbering and page layout.
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'xinjiang-requirements.docx');
const HEADING_STYLES = ['4', '5', '7', '8', '9', '10'];
const clone = value => JSON.parse(JSON.stringify(value));
const element = (name, attributes = {}, elements = []) => ({ type: 'element', name, attributes, elements });
const child = (node, name) => node?.elements?.find(item => item.name === name);
const content = node => node?.type === 'text' ? node.text : (node?.elements || []).map(content).join('');
const value = input => String(input ?? '').trim();
const cleanHeading = input => value(input).replace(/^\d+(?:\.\d+)*[.、](?!\d)\s*/, '').replace(/^\d+(?:\.\d+)+\s+/, '').trim();
const cleanProcess = input => cleanHeading(value(input).replace(/^\[[^\]]*\]\s*/, ''));
const textNode = text => element('w:t', { 'xml:space': 'preserve' }, [{ type: 'text', text: String(text) }]);
const textRun = (text, properties) => element('w:r', {}, [...(properties ? [clone(properties)] : []), textNode(text)]);

function setProperty(node, name, attributes = {}) {
    node.elements ||= [];
    node.elements = node.elements.filter(item => item.name !== name);
    node.elements.push(element(name, attributes));
}

function removeProperties(node, names) {
    if (node?.elements) node.elements = node.elements.filter(item => !names.includes(item.name));
}

function blackRunProperties(properties) {
    const result = properties ? clone(properties) : element('w:rPr');
    removeProperties(result, ['w:color', 'w:i', 'w:iCs', 'w:highlight']);
    setProperty(result, 'w:color', { 'w:val': '000000' });
    setProperty(result, 'w:i', { 'w:val': '0' });
    setProperty(result, 'w:iCs', { 'w:val': '0' });
    return result;
}

function paragraphFrom(source, text, { style, keepNext = false, center = false } = {}) {
    const properties = clone(child(source, 'w:pPr') || element('w:pPr'));
    removeProperties(properties, ['w:numPr']);
    if (style) setProperty(properties, 'w:pStyle', { 'w:val': style });
    // infoblue is an example-only style in the reference, never a body/heading style.
    if (child(properties, 'w:pStyle')?.attributes?.['w:val'] === '28') removeProperties(properties, ['w:pStyle']);
    setProperty(properties, 'w:keepNext', { 'w:val': keepNext ? '1' : '0' });
    const markProperties = child(properties, 'w:rPr');
    if (markProperties) properties.elements[properties.elements.indexOf(markProperties)] = blackRunProperties(markProperties);
    if (center) {
        setProperty(properties, 'w:jc', { 'w:val': 'center' });
        setProperty(properties, 'w:ind', { 'w:left': '0', 'w:right': '0', 'w:firstLine': '0' });
    }
    const runProperties = blackRunProperties(child(child(source, 'w:r'), 'w:rPr'));
    return element('w:p', {}, [properties, textRun(text, runProperties)]);
}

function field(instruction, cached, properties) {
    return [
        element('w:r', {}, [element('w:fldChar', { 'w:fldCharType': 'begin', 'w:dirty': 'true' })]),
        element('w:r', {}, [element('w:instrText', { 'xml:space': 'preserve' }, [{ type: 'text', text: ` ${instruction} ` }])]),
        element('w:r', {}, [element('w:fldChar', { 'w:fldCharType': 'separate' })]),
        textRun(cached, properties),
        element('w:r', {}, [element('w:fldChar', { 'w:fldCharType': 'end' })])
    ];
}

function groupFunctions(rows) {
    const groups = [];
    const levels = ['', '', '', ''];
    let current;
    let functionalUser = '';
    let triggerEvent = '';
    for (const row of rows) {
        for (let i = 0; i < levels.length; i++) {
            const incoming = value(row[`level${i + 1}`]);
            if (incoming && incoming !== levels[i]) {
                levels[i] = incoming;
                levels.fill('', i + 1); // A new parent must never inherit the previous parent's children.
            }
        }
        if (row.dataMovementType === 'E' && value(row.functionalProcess)) {
            functionalUser = value(row.functionalUser) || functionalUser;
            triggerEvent = value(row.triggerEvent) || triggerEvent;
            current = {
                processName: value(row.functionalProcess), name: cleanProcess(row.functionalProcess),
                levels: [...levels], functionalUser, triggerEvent, processIndex: groups.length,
                description: value(row.functionDescription || row.functionalDescription),
                requirementType: value(row.requirementType || row.changeType), rows: [row]
            };
            groups.push(current);
        } else if (current) current.rows.push(row);
    }
    return groups;
}

function moduleTree(groups) {
    const root = { children: new Map(), groups: [] };
    for (const group of groups) {
        let parent = root;
        const levels = group.levels.slice(0, group.levels[3] ? 4 : 3);
        levels.forEach((name, index) => {
            const title = cleanHeading(name) || `未指定${['一', '二', '三', '四'][index]}级模块`;
            if (!parent.children.has(title)) parent.children.set(title, { title, children: new Map(), groups: [] });
            parent = parent.children.get(title);
        });
        parent.groups.push(group);
    }
    return root;
}

function matchDiagram(group, diagrams, used) {
    const sameName = item => cleanProcess(item.processName) === group.name;
    const indexed = diagrams.find(item => !used.has(item) && item.processIndex === group.processIndex && sameName(item));
    // New clients always supply processIndex; do not steal a different occurrence's image.
    const diagram = indexed || diagrams.find(item => !used.has(item) && item.processIndex == null && sameName(item));
    if (diagram) used.add(diagram);
    return diagram;
}

function imageParagraph(relationshipId, id, width, height, title) {
    const cx = String(Math.round(width * 9525));
    const cy = String(Math.round(height * 9525));
    return element('w:p', {}, [
        element('w:pPr', {}, [element('w:keepNext'), element('w:jc', { 'w:val': 'center' }), element('w:spacing', { 'w:after': '120' })]),
        element('w:r', {}, [element('w:drawing', {}, [
            element('wp:inline', { distT: '0', distB: '0', distL: '0', distR: '0' }, [
                element('wp:extent', { cx, cy }), element('wp:docPr', { id: String(id), name: title, descr: title }),
                element('a:graphic', { 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main' }, [
                    element('a:graphicData', { uri: 'http://schemas.openxmlformats.org/drawingml/2006/picture' }, [
                        element('pic:pic', { 'xmlns:pic': 'http://schemas.openxmlformats.org/drawingml/2006/picture' }, [
                            element('pic:nvPicPr', {}, [element('pic:cNvPr', { id: '0', name: title }), element('pic:cNvPicPr')]),
                            element('pic:blipFill', {}, [element('a:blip', { 'r:embed': relationshipId }), element('a:stretch', {}, [element('a:fillRect')])]),
                            element('pic:spPr', {}, [
                                element('a:xfrm', {}, [element('a:off', { x: '0', y: '0' }), element('a:ext', { cx, cy })]),
                                element('a:prstGeom', { prst: 'rect' }, [element('a:avLst')])
                            ])
                        ])
                    ])
                ])
            ])
        ])])
    ]);
}

async function buildXinjiangWordDocument({ tableData, sequenceDiagrams = [], documentName, filename, buildDescription }) {
    const zip = await JSZip.loadAsync(await fs.readFile(TEMPLATE_PATH));
    const document = xml2js(await zip.file('word/document.xml').async('string'));
    const root = child(document, 'w:document');
    const body = child(root, 'w:body');
    const source = body.elements.filter(item => item.type === 'element');
    const sourceParagraph = text => {
        const found = source.find(item => item.name === 'w:p' && content(item).trim() === text);
        if (!found) throw new Error(`新疆模板缺少段落：${text}`);
        return found;
    };
    const headingSources = HEADING_STYLES.map((style, index) => source.find(item => item.name === 'w:p'
        && child(child(item, 'w:pPr'), 'w:pStyle')?.attributes?.['w:val'] === style)
        || (index === 5 ? sourceParagraph('功能性用户需求标题1(请注明本需求是：新增、优化、删除）') : null));
    const bodySource = sourceParagraph('详细描述功能需求1的具体内容，包括约束条件、输入输出、排序规则、状态转换等等。');
    const captionSource = sourceParagraph('图4.1 功能需求1时序图');
    const groups = groupFunctions(tableData);
    if (!groups.length) throw new Error('未找到可导出的功能过程，请检查 Excel 的功能过程和数据移动类型');
    const project = value(documentName || filename || 'XX项目').replace(/^COSMIC(?:功能规格说明书|拆分)[_-]?/, '').replace(/\.(xlsx|xlsm|xls|docx)$/i, '') || 'XX项目';
    const title = /需求说明书$/.test(project) ? project : `${project.replace(/需求$/, '')}需求说明书`;
    const now = new Date();
    const paragraphs = [];
    const tocEntries = [];
    const counters = [0, 0, 0, 0, 0, 0];
    let bookmarkId = 1000;
    const paragraph = text => paragraphFrom(bodySource, text);
    const appendText = text => value(text).split(/\r?\n/).filter(Boolean).forEach(line => paragraphs.push(paragraph(line)));
    const heading = (text, level) => {
        const name = cleanHeading(text);
        counters[level - 1] += 1;
        counters.fill(0, level);
        const number = counters.slice(0, level).join('.') + '.';
        const bookmark = `XjHeading${++bookmarkId}`;
        const p = paragraphFrom(headingSources[level - 1], name, { style: HEADING_STYLES[level - 1], keepNext: true });
        p.elements.splice(1, 0, element('w:bookmarkStart', { 'w:id': String(bookmarkId), 'w:name': bookmark }));
        p.elements.push(element('w:bookmarkEnd', { 'w:id': String(bookmarkId) }));
        paragraphs.push(p);
        tocEntries.push({ name, level, number, bookmark });
    };
    const pending = text => appendText(`${text}待补充。`);

    heading('需求说明', 1);
    heading('总体描述', 2);
    appendText(`本需求说明书描述${project}的功能需求，共包含 ${groups.length} 个功能过程。功能需求按导入清单中的模块层级组织，逐项列明业务流程、数据字段和功能描述。`);
    heading('建设目标', 2); pending('项目建设目标');
    heading('建设必要性', 2); pending('项目建设必要性');
    heading('系统现状', 1);
    heading('系统概况', 2); pending('系统现状及部署情况');
    heading('系统已实现功能', 2); pending('现有已实现功能清单及功能架构现状');
    heading('存在问题', 2); pending('现有系统存在的问题');
    heading('功能架构图', 1);
    pending('功能架构图');
    appendText('本次需求涉及的模块及功能清单如下：');
    const sourceTable = source.find(item => item.name === 'w:tbl');
    const table = clone(sourceTable);
    const sourceRows = sourceTable.elements.filter(item => item.name === 'w:tr');
    table.elements = table.elements.filter(item => item.name !== 'w:tr');
    const header = clone(sourceRows[0]);
    let headerProperties = child(header, 'w:trPr');
    if (!headerProperties) { headerProperties = element('w:trPr'); header.elements.unshift(headerProperties); }
    setProperty(headerProperties, 'w:tblHeader');
    table.elements.push(header);
    groups.forEach((group, index) => {
        const row = clone(sourceRows[2]);
        const cells = row.elements.filter(item => item.name === 'w:tc');
        const texts = [String(index + 1), group.name, cleanHeading(group.levels[0]) || '未指定', cleanHeading(group.levels[1]) || '未指定', group.levels.slice(2).filter(Boolean).map(cleanHeading).join(' / ') || '未指定'];
        cells.forEach((cell, cellIndex) => {
            const p = paragraphFrom(child(cell, 'w:p'), texts[cellIndex]);
            cell.elements = cell.elements.filter(item => item.name === 'w:tcPr');
            cell.elements.push(p);
        });
        removeProperties(child(row, 'w:trPr'), ['w:trHeight']);
        table.elements.push(row);
    });
    paragraphs.push(table);
    heading('功能需求', 1);
    const relationships = xml2js(await zip.file('word/_rels/document.xml.rels').async('string'));
    const relationshipsRoot = child(relationships, 'Relationships');
    const usedDiagrams = new Set();
    let figureNumber = 0;
    const appendFunction = (group, level) => {
        const explicitType = /^(新增|优化|删除)$/.test(group.requirementType) ? group.requirementType : '';
        const alreadyTyped = /[（(](新增|优化|删除)[）)]$/.test(group.name);
        heading(`${group.name}${alreadyTyped ? '' : `（${explicitType || '需求类型待确认'}）`}`, level);
        paragraphs.push(paragraphFrom(sourceParagraph('（1）关键时序图/业务逻辑图'), '（1）关键时序图/业务逻辑图', { keepNext: true }));
        const diagram = matchDiagram(group, Array.isArray(sequenceDiagrams) ? sequenceDiagrams : [], usedDiagrams);
        if (diagram?.imageBase64) {
            const data = Buffer.from(String(diagram.imageBase64).replace(/^data:image\/png;base64,/, ''), 'base64');
            if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`${group.name}的时序图不是有效 PNG 图片，请重新生成`);
            const width = data.readUInt32BE(16);
            const height = data.readUInt32BE(20);
            if (!width || !height) throw new Error(`${group.name}的时序图尺寸无效`);
            figureNumber += 1;
            const relationshipId = `rIdXjDiagram${figureNumber}`;
            const imageName = `xinjiang-sequence-${figureNumber}.png`;
            zip.file(`word/media/${imageName}`, data);
            relationshipsRoot.elements.push(element('Relationship', {
                Id: relationshipId, Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', Target: `media/${imageName}`
            }));
            // The reference's text area is 8306 twips (553 px). Leave room for the caption on tall diagrams.
            const scale = Math.min(1, 550 / width, 570 / height);
            const caption = `图 4.${figureNumber} ${group.name}时序图`;
            paragraphs.push(imageParagraph(relationshipId, 10000 + figureNumber, width * scale, height * scale, caption));
            const p = paragraphFrom(captionSource, '', { center: true });
            const properties = child(child(p, 'w:r'), 'w:rPr');
            p.elements = [child(p, 'w:pPr'), textRun('图 ', properties),
                ...field('STYLEREF 1 \\s', '4', properties), textRun('.', properties),
                ...field('SEQ XjFigure \\* ARABIC \\s 1', String(figureNumber), properties),
                textRun(` ${group.name}时序图`, properties)];
            paragraphs.push(p);
        } else appendText('时序图待补充。');
        paragraphs.push(paragraphFrom(sourceParagraph('本时序图流程步骤如下：'), '本时序图流程步骤如下：', { keepNext: true }));
        group.rows.forEach((row, index) => appendText(`${index + 1}. ${value(row.subProcessDesc) || value(row.dataGroup)}${row.dataAttributes ? `（数据字段：${value(row.dataAttributes)}）` : ''}`));
        paragraphs.push(paragraphFrom(sourceParagraph('（2）功能描述'), '（2）功能描述', { keepNext: true }));
        if (group.functionalUser) appendText(`功能用户：${group.functionalUser}`);
        if (group.triggerEvent) appendText(`触发事件：${group.triggerEvent}`);
        appendText(group.description || (buildDescription ? buildDescription(group.processName, group.rows, '', group.functionalUser, group.triggerEvent) : group.rows.map(row => value(row.subProcessDesc)).filter(Boolean).join('；')) || '功能描述待补充。');
    };
    const visit = (node, depth) => {
        for (const submodule of node.children.values()) {
            heading(submodule.title, depth);
            visit(submodule, depth + 1);
        }
        node.groups.forEach(group => appendFunction(group, depth));
    };
    visit(moduleTree(groups), 2);
    heading('非功能性需求（可选）', 1); pending('非功能性需求');
    heading('附加值调整因子说明', 1);
    const factorTitles = ['需求变更规模因子', '应用类型', '质量及特性', '开发语言', '开发团队背景', '完整性级别调整因子'];
    for (const factorTitle of factorTitles) {
        heading(factorTitle, 2);
        pending(`本项目${factorTitle}及取值依据`);
        const start = source.indexOf(sourceParagraph(factorTitle));
        const referenceTable = source.slice(start + 1).find(item => item.name === 'w:tbl');
        if (referenceTable) paragraphs.push(clone(referenceTable));
    }

    const pageBreak = element('w:p', {}, [element('w:r', {}, [element('w:br', { 'w:type': 'page' })])]);
    const cover = source.slice(0, 14).map(clone);
    cover[3] = paragraphFrom(sourceParagraph('XX项目需求说明书'), title, { center: true });
    cover[12] = paragraphFrom(sourceParagraph('XX部门'), '编制部门：待补充', { center: true });
    cover[13] = paragraphFrom(sourceParagraph('XXXX年XX月'), `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`, { center: true });
    const toc = tocEntries.map(entry => element('w:p', {}, [
        element('w:pPr', {}, [element('w:pStyle', { 'w:val': ['17', '19', '14', '18', '18', '18'][entry.level - 1] }),
            element('w:ind', { 'w:left': String((entry.level - 1) * 300) })]),
        element('w:hyperlink', { 'w:anchor': entry.bookmark }, [textRun(`${entry.number} ${entry.name}`)])
    ]));
    toc[0].elements.splice(1, 0,
        element('w:r', {}, [element('w:fldChar', { 'w:fldCharType': 'begin', 'w:dirty': 'true' })]),
        element('w:r', {}, [element('w:instrText', { 'xml:space': 'preserve' }, [{ type: 'text', text: ' TOC \\o "1-6" \\h \\z \\u ' }])]),
        element('w:r', {}, [element('w:fldChar', { 'w:fldCharType': 'separate' })]));
    toc[toc.length - 1].elements.push(element('w:r', {}, [element('w:fldChar', { 'w:fldCharType': 'end' })]));
    body.elements = [...cover, pageBreak, clone(sourceParagraph('目 录')), ...toc, clone(pageBreak), ...paragraphs, clone(child(body, 'w:sectPr'))];
    zip.file('word/document.xml', js2xml(document));
    zip.file('word/_rels/document.xml.rels', js2xml(relationships));
    const settings = xml2js(await zip.file('word/settings.xml').async('string'));
    setProperty(child(settings, 'w:settings'), 'w:updateFields', { 'w:val': 'true' });
    zip.file('word/settings.xml', js2xml(settings));
    const types = xml2js(await zip.file('[Content_Types].xml').async('string'));
    const typesRoot = child(types, 'Types');
    if (!typesRoot.elements.some(item => item.attributes?.Extension === 'png')) typesRoot.elements.push(element('Default', { Extension: 'png', ContentType: 'image/png' }));
    zip.file('[Content_Types].xml', js2xml(types));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildXinjiangWordDocument };
