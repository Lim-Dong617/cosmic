const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    HeadingLevel,
    LevelFormat,
    Packer,
    PageNumber,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    VerticalAlign,
    WidthType
} = require('docx');

const WORD_EXTENSIONS = new Set(['.docx', '.txt', '.md']);
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.csv']);
const MAX_OFFICE_FILE_BYTES = 80 * 1024 * 1024;
const MAX_WORD_SOURCE_CHARS = 140000;
const WORD_CHUNK_CHARS = 24000;
const MAX_WORD_CHUNKS = 7;
const MAX_EXCEL_SNAPSHOT_CHARS = 60000;
const MAX_EXCEL_OPERATIONS = 1200;
const MAX_MATRIX_CELLS = 60000;

const WORD_SYSTEM_PROMPT = `你是专业的中文办公文档编辑与排版专家。你需要准确理解用户指令，对已有内容进行修改、优化、重组，或从零生成一份可直接交付的 Word 文档。

必须遵守：
1. 不编造用户未提供的事实、数字、结论、出处或人员信息；缺失信息使用“待补充”或保留原文。
2. 编辑已有文档时保留所有未被要求删除的重要信息，优先做局部、可追踪的内容改进。
3. 使用清晰的 Markdown 表达最终结构：# 标题、##/### 分级标题、真实项目符号、真实编号列表、仅在数据确实适合行列比较时使用表格。
4. 不输出解释、代码围栏或额外对话，只输出严格 JSON。

JSON 格式：
{
  "summary": "一句话概括完成的工作",
  "filename": "不含扩展名的中文文件名",
  "title": "文档标题",
  "subtitle": "可选副标题",
  "contentMarkdown": "完整的最终文档正文 Markdown"
}`;

const WORD_CHUNK_SYSTEM_PROMPT = `你是专业的中文 Word 文档编辑。用户会给出一份长文档中的一个连续片段，以及对整份文档的修改要求。

只处理当前片段，严格保留本片段中未被要求删除的事实、数字和关键信息；不要添加整份文档的总标题，不要复述其他片段，不要输出解释。使用清晰 Markdown 返回本片段处理后的完整内容。

只输出严格 JSON：
{
  "summary": "本片段完成的修改",
  "contentMarkdown": "处理后的完整片段"
}`;

const EXCEL_SYSTEM_PROMPT = `你是专业的 Excel 数据整理、建模和工作簿设计专家。你需要准确理解用户指令，为已有工作簿生成最小、可审计的修改计划，或从零生成结构清晰的新工作簿。

必须遵守：
1. 不编造用户未提供的业务事实或数据。缺失数据保留为空或标记“待补充”。
2. 派生值使用清晰、可审计的 Excel 公式；公式中的跨表引用始终使用单引号包裹工作表名。
3. 编辑已有工作簿时，不重建无关工作表，不覆盖无关单元格，不破坏现有公式和格式。
4. 仅在用户明确要求删除、去重或重构时使用删除操作。
5. 单元格纯文本即使以等号开头也放在 value；只有真正公式才使用 formula（formula 不带开头等号）。
6. 只输出严格 JSON，不输出解释或代码围栏。

可以输出的新建工作簿结构：
{
  "summary": "一句话概括完成的工作",
  "filename": "不含扩展名的中文文件名",
  "applyProfessionalFormatting": true,
  "sheets": [
    {
      "name": "工作表名",
      "title": "可选的大标题",
      "headers": ["列1", "列2"],
      "rows": [[1, "文本"], [{"formula":"SUM(B2:B10)","numberFormat":"#,##0"}, null]],
      "freezeHeader": true,
      "autoFilter": true
    }
  ],
  "operations": []
}

编辑已有工作簿时，优先返回 operations：
{
  "summary": "一句话概括完成的工作",
  "filename": "不含扩展名的中文文件名",
  "applyProfessionalFormatting": false,
  "operations": [
    {"type":"setCell","sheet":"Sheet1","address":"B2","value":"文本","formula":null,"numberFormat":"0.0%","styleRole":"normal"},
    {"type":"setRange","sheet":"Sheet1","startCell":"A2","rows":[["A","B"],["C","D"]]},
    {"type":"appendRows","sheet":"Sheet1","rows":[["A","B"]]},
    {"type":"insertRows","sheet":"Sheet1","startRow":3,"rows":[["A","B"]]},
    {"type":"deleteRows","sheet":"Sheet1","startRow":3,"count":1},
    {"type":"addSheet","name":"汇总","title":"汇总","headers":["指标","结果"],"rows":[["总数",{"formula":"COUNTA('明细'!A2:A1000)"}]]},
    {"type":"renameSheet","sheet":"Sheet1","name":"明细"},
    {"type":"setColumnWidth","sheet":"明细","column":"A","width":24},
    {"type":"formatRange","sheet":"明细","range":"A1:D1","styleRole":"header","numberFormat":null},
    {"type":"mergeCells","sheet":"明细","range":"A1:D1"},
    {"type":"freezePane","sheet":"明细","rows":1,"columns":0},
    {"type":"autoFilter","sheet":"明细","range":"A1:D100"},
    {"type":"dataValidation","sheet":"明细","range":"D2:D100","values":["未开始","进行中","已完成"]}
  ]
}

styleRole 只使用：title、header、subheader、input、output、highlight、warning、normal。`;

function sanitizeFilename(value, fallback = '办公文档处理结果') {
    const cleaned = String(value || '')
        .replace(/\.(docx|xlsx|xlsm|csv)$/i, '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 90);
    return cleaned || fallback;
}

function sanitizeSheetName(value, fallback = 'Sheet1') {
    const cleaned = String(value || '')
        .replace(/[\\/*?:[\]]/g, '_')
        .trim()
        .slice(0, 31);
    return cleaned || fallback;
}

function decodeUploadedFilename(name) {
    const original = String(name || '');
    if (!original) return '未命名文件';
    if (/[\u4e00-\u9fff]/.test(original)) return original;
    try {
        const decoded = Buffer.from(original, 'latin1').toString('utf8');
        return decoded.includes('\uFFFD') ? original : decoded;
    } catch {
        return original;
    }
}

function detectOfficeKind(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    if (WORD_EXTENSIONS.has(ext)) return 'word';
    if (EXCEL_EXTENSIONS.has(ext)) return 'excel';
    if (ext === '.xls') {
        throw new Error('暂不支持旧版 .xls，请先在 Excel 中另存为 .xlsx 后再上传');
    }
    if (ext === '.doc') {
        throw new Error('暂不支持旧版 .doc，请先在 Word 中另存为 .docx 后再上传');
    }
    throw new Error(`不支持的办公文件格式：${ext || '未知格式'}`);
}

function resolveOutputFormat(requested, sourceKind, instruction = '') {
    if (requested === 'docx' || requested === 'xlsx') return requested;
    if (sourceKind === 'word') return 'docx';
    if (sourceKind === 'excel') return 'xlsx';
    return /Excel|表格|工作簿|台账|清单|统计表|数据表|xlsx/i.test(instruction) ? 'xlsx' : 'docx';
}

function parseJsonResponse(content) {
    const raw = String(content || '').trim();
    if (!raw) throw new Error('AI 未返回可用内容');
    const unfenced = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    try {
        return JSON.parse(unfenced);
    } catch {
        const first = unfenced.indexOf('{');
        const last = unfenced.lastIndexOf('}');
        if (first >= 0 && last > first) {
            return JSON.parse(unfenced.slice(first, last + 1));
        }
        throw new Error('AI 返回内容不是有效 JSON');
    }
}

async function callForJson({
    callAIWithRetry,
    getModelName,
    userConfig,
    systemPrompt,
    userPrompt,
    maxTokens = 10000
}) {
    const completion = await callAIWithRetry({
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        model: getModelName(userConfig),
        temperature: 0.15,
        max_tokens: maxTokens,
        apiKey: userConfig?.apiKey || null,
        baseUrl: userConfig?.baseUrl || null
    }, 4);
    const content = completion?.choices?.[0]?.message?.content;
    return parseJsonResponse(content);
}

function splitLongText(text, targetLength = WORD_CHUNK_CHARS) {
    const paragraphs = String(text || '').split(/\n{2,}/);
    const chunks = [];
    let current = '';
    for (const paragraph of paragraphs) {
        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (candidate.length <= targetLength) {
            current = candidate;
            continue;
        }
        if (current) chunks.push(current);
        if (paragraph.length <= targetLength) {
            current = paragraph;
            continue;
        }
        for (let index = 0; index < paragraph.length; index += targetLength) {
            chunks.push(paragraph.slice(index, index + targetLength));
        }
        current = '';
    }
    if (current) chunks.push(current);
    return chunks.filter(Boolean);
}

function normalizeCellValue(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value !== 'object') return value;
    if (Array.isArray(value.richText)) return value.richText.map(item => item.text || '').join('');
    if (value.formula) return `=${value.formula}`;
    if (value.sharedFormula) return `=${value.sharedFormula}`;
    if (value.hyperlink) return value.text || value.hyperlink;
    if (value.error) return value.error;
    if (value.result !== undefined) return normalizeCellValue(value.result);
    return String(value.text || value);
}

async function loadExcelWorkbook(filePath, filename) {
    const workbook = new ExcelJS.Workbook();
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.csv') {
        const worksheet = await workbook.csv.readFile(filePath);
        worksheet.name = sanitizeSheetName(path.basename(filename, ext), 'CSV数据');
    } else {
        await workbook.xlsx.readFile(filePath);
    }
    return workbook;
}

function getWorksheetBounds(worksheet) {
    const rowCount = Math.max(worksheet.actualRowCount || 0, worksheet.rowCount || 0);
    const columnCount = Math.max(worksheet.actualColumnCount || 0, worksheet.columnCount || 0);
    return { rowCount, columnCount };
}

function worksheetPreview(worksheet, maxRows = 12, maxColumns = 14) {
    const { rowCount, columnCount } = getWorksheetBounds(worksheet);
    const rows = [];
    const cappedRows = Math.min(rowCount, maxRows);
    const cappedColumns = Math.min(columnCount, maxColumns);
    for (let rowIndex = 1; rowIndex <= cappedRows; rowIndex += 1) {
        const row = [];
        for (let columnIndex = 1; columnIndex <= cappedColumns; columnIndex += 1) {
            row.push(normalizeCellValue(worksheet.getCell(rowIndex, columnIndex).value));
        }
        rows.push(row);
    }
    return rows;
}

function workbookSnapshot(workbook) {
    const snapshot = { sheets: [] };
    let formulaCount = 0;
    let errorCount = 0;
    for (const worksheet of workbook.worksheets.slice(0, 12)) {
        const { rowCount, columnCount } = getWorksheetBounds(worksheet);
        const sampledRows = [];
        const rowIndexes = [];
        const headCount = Math.min(rowCount, 90);
        for (let index = 1; index <= headCount; index += 1) rowIndexes.push(index);
        if (rowCount > headCount) {
            const tailStart = Math.max(headCount + 1, rowCount - 14);
            for (let index = tailStart; index <= rowCount; index += 1) rowIndexes.push(index);
        }
        for (const rowIndex of rowIndexes) {
            const values = [];
            for (let columnIndex = 1; columnIndex <= Math.min(columnCount, 32); columnIndex += 1) {
                const cell = worksheet.getCell(rowIndex, columnIndex);
                const normalized = normalizeCellValue(cell.value);
                if (typeof normalized === 'string' && normalized.startsWith('=')) formulaCount += 1;
                if (typeof normalized === 'string' && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A)/.test(normalized)) errorCount += 1;
                values.push(normalized);
            }
            sampledRows.push({ row: rowIndex, values });
        }
        snapshot.sheets.push({
            name: worksheet.name,
            rowCount,
            columnCount,
            sampledRows,
            truncatedRows: Math.max(0, rowCount - rowIndexes.length),
            merges: Object.keys(worksheet._merges || {}).slice(0, 30)
        });
    }
    snapshot.formulaCount = formulaCount;
    snapshot.errorCount = errorCount;
    let serialized = JSON.stringify(snapshot);
    if (serialized.length > MAX_EXCEL_SNAPSHOT_CHARS) {
        serialized = serialized.slice(0, MAX_EXCEL_SNAPSHOT_CHARS);
        snapshot.truncated = true;
        snapshot.serializedPreview = `${serialized}\n...工作簿快照已截断`;
    } else {
        snapshot.serializedPreview = serialized;
    }
    return snapshot;
}

async function extractOfficeSource(file) {
    if (!file) return null;
    if (file.size > MAX_OFFICE_FILE_BYTES) {
        throw new Error('办公文档模块单文件最大支持 80MB');
    }
    const filename = decodeUploadedFilename(file.originalname);
    const kind = detectOfficeKind(filename);
    const ext = path.extname(filename).toLowerCase();
    if (kind === 'word') {
        let content = '';
        let markdown = '';
        if (ext === '.docx') {
            const [rawResult, markdownResult] = await Promise.all([
                mammoth.extractRawText({ path: file.path }),
                mammoth.convertToMarkdown({ path: file.path })
            ]);
            content = rawResult.value || '';
            markdown = markdownResult.value || content;
        } else {
            content = await fs.promises.readFile(file.path, 'utf8');
            markdown = content;
        }
        const headings = markdown
            .split(/\r?\n/)
            .filter(line => /^#{1,6}\s+/.test(line.trim()))
            .slice(0, 30)
            .map(line => line.trim());
        return {
            kind,
            filename,
            ext,
            size: file.size,
            content: markdown || content,
            rawText: content,
            metadata: {
                characters: content.length,
                paragraphs: content.split(/\n{2,}/).filter(Boolean).length,
                headings
            }
        };
    }

    const workbook = await loadExcelWorkbook(file.path, filename);
    const snapshot = workbookSnapshot(workbook);
    return {
        kind,
        filename,
        ext,
        size: file.size,
        workbook,
        snapshot,
        metadata: {
            sheetCount: workbook.worksheets.length,
            formulaCount: snapshot.formulaCount,
            errorCount: snapshot.errorCount,
            sheets: workbook.worksheets.map(worksheet => {
                const bounds = getWorksheetBounds(worksheet);
                return {
                    name: worksheet.name,
                    ...bounds,
                    preview: worksheetPreview(worksheet)
                };
            })
        }
    };
}

function sourceToPrompt(source) {
    if (!source) return '未上传源文件，本次任务为从零生成。';
    if (source.kind === 'word') return source.content;
    return source.snapshot.serializedPreview;
}

function textRunsFromInlineMarkdown(text, options = {}) {
    const source = String(text || '');
    const tokens = [];
    const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
    let cursor = 0;
    let match;
    while ((match = regex.exec(source))) {
        if (match.index > cursor) {
            tokens.push(new TextRun({ text: source.slice(cursor, match.index), ...options }));
        }
        const token = match[0];
        if (token.startsWith('**')) {
            tokens.push(new TextRun({ text: token.slice(2, -2), bold: true, ...options }));
        } else if (token.startsWith('`')) {
            tokens.push(new TextRun({ text: token.slice(1, -1), font: 'Consolas', color: '334155', ...options }));
        } else {
            tokens.push(new TextRun({ text: token.slice(1, -1), italics: true, ...options }));
        }
        cursor = regex.lastIndex;
    }
    if (cursor < source.length) {
        tokens.push(new TextRun({ text: source.slice(cursor), ...options }));
    }
    return tokens.length ? tokens : [new TextRun({ text: source, ...options })];
}

function parseMarkdownTableRow(line) {
    return String(line || '')
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());
}

function isMarkdownTableDivider(line) {
    const cells = parseMarkdownTableRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function buildDocxTable(headers, rows) {
    const columnCount = Math.max(headers.length, ...rows.map(row => row.length), 1);
    const availableWidth = 9360;
    const lengths = Array(columnCount).fill(4);
    [headers, ...rows].forEach(row => {
        for (let index = 0; index < columnCount; index += 1) {
            lengths[index] = Math.max(lengths[index], Math.min(50, String(row[index] ?? '').length));
        }
    });
    const totalLength = lengths.reduce((sum, value) => sum + value, 0);
    const widths = lengths.map(value => Math.max(900, Math.round((value / totalLength) * availableWidth)));
    const widthDelta = availableWidth - widths.reduce((sum, value) => sum + value, 0);
    widths[widths.length - 1] += widthDelta;

    const makeRow = (values, isHeader = false) => new TableRow({
        tableHeader: isHeader,
        children: Array.from({ length: columnCount }, (_, index) => new TableCell({
            width: { size: widths[index], type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 90, bottom: 90, left: 120, right: 120 },
            shading: isHeader ? { type: ShadingType.CLEAR, fill: 'E8EEF5', color: 'auto' } : undefined,
            children: [
                new Paragraph({
                    spacing: { before: 0, after: 0, line: 280 },
                    alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
                    children: textRunsFromInlineMarkdown(values[index] ?? '', {
                        font: 'Microsoft YaHei',
                        size: 20,
                        bold: isHeader,
                        color: isHeader ? '1F3A5F' : '1F2937'
                    })
                })
            ]
        }))
    });

    return new Table({
        width: { size: availableWidth, type: WidthType.DXA },
        columnWidths: widths,
        margins: { top: 90, bottom: 90, left: 120, right: 120 },
        borders: {
            top: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
            bottom: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
            left: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
            right: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
            insideHorizontal: { style: BorderStyle.SINGLE, color: 'E2E8F0', size: 3 },
            insideVertical: { style: BorderStyle.SINGLE, color: 'E2E8F0', size: 3 }
        },
        rows: [makeRow(headers, true), ...rows.map(row => makeRow(row, false))]
    });
}

function markdownToDocxChildren(markdown, title) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const children = [];
    let index = 0;
    let firstHeadingConsumed = false;
    while (index < lines.length) {
        const line = lines[index].trim();
        if (!line) {
            index += 1;
            continue;
        }

        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            const headingText = headingMatch[2].trim();
            if (!firstHeadingConsumed && headingMatch[1].length === 1 && headingText === title) {
                firstHeadingConsumed = true;
                index += 1;
                continue;
            }
            firstHeadingConsumed = true;
            const level = Math.min(headingMatch[1].length, 3);
            children.push(new Paragraph({
                heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
                keepNext: true,
                children: textRunsFromInlineMarkdown(headingText, { font: 'Microsoft YaHei' })
            }));
            index += 1;
            continue;
        }

        if (line.includes('|') && index + 1 < lines.length && isMarkdownTableDivider(lines[index + 1])) {
            const headers = parseMarkdownTableRow(line);
            const rows = [];
            index += 2;
            while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
                rows.push(parseMarkdownTableRow(lines[index]));
                index += 1;
            }
            children.push(buildDocxTable(headers, rows));
            children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
            continue;
        }

        const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
        if (bulletMatch) {
            children.push(new Paragraph({
                bullet: { level: 0 },
                spacing: { after: 80, line: 280 },
                children: textRunsFromInlineMarkdown(bulletMatch[1], { font: 'Microsoft YaHei', size: 22 })
            }));
            index += 1;
            continue;
        }

        const numberedMatch = line.match(/^\d+[.)、]\s*(.+)$/);
        if (numberedMatch) {
            children.push(new Paragraph({
                numbering: { reference: 'office-numbering', level: 0 },
                spacing: { after: 80, line: 280 },
                children: textRunsFromInlineMarkdown(numberedMatch[1], { font: 'Microsoft YaHei', size: 22 })
            }));
            index += 1;
            continue;
        }

        const paragraphLines = [line];
        index += 1;
        while (
            index < lines.length
            && lines[index].trim()
            && !/^(#{1,6})\s+/.test(lines[index].trim())
            && !/^[-*+]\s+/.test(lines[index].trim())
            && !/^\d+[.)、]\s*/.test(lines[index].trim())
            && !(lines[index].includes('|') && index + 1 < lines.length && isMarkdownTableDivider(lines[index + 1]))
        ) {
            paragraphLines.push(lines[index].trim());
            index += 1;
        }
        children.push(new Paragraph({
            spacing: { before: 0, after: 120, line: 290 },
            alignment: AlignmentType.LEFT,
            children: textRunsFromInlineMarkdown(paragraphLines.join(' '), {
                font: 'Microsoft YaHei',
                size: 22,
                color: '1F2937'
            })
        }));
    }
    return children;
}

async function buildWordBufferFromMarkdown({ title, subtitle = '', markdown = '' }) {
    const documentTitle = String(title || '办公文档').trim();
    const children = [
        new Paragraph({
            style: 'OfficeTitle',
            children: [new TextRun({ text: documentTitle, font: 'Microsoft YaHei', bold: true, size: 42, color: '0B2545' })]
        })
    ];
    if (subtitle) {
        children.push(new Paragraph({
            style: 'OfficeSubtitle',
            children: [new TextRun({ text: String(subtitle), font: 'Microsoft YaHei', size: 24, color: '64748B' })]
        }));
    }
    children.push(...markdownToDocxChildren(markdown, documentTitle));

    const document = new Document({
        creator: '智能办公文档中心',
        title: documentTitle,
        description: '由智能办公文档中心生成',
        styles: {
            default: {
                document: {
                    run: { font: 'Microsoft YaHei', size: 22, color: '1F2937' },
                    paragraph: { spacing: { after: 120, line: 290 } }
                }
            },
            paragraphStyles: [
                {
                    id: 'OfficeTitle',
                    name: 'Office Title',
                    basedOn: 'Normal',
                    next: 'Normal',
                    quickFormat: true,
                    run: { font: 'Microsoft YaHei', size: 42, bold: true, color: '0B2545' },
                    paragraph: { spacing: { before: 0, after: 100 }, keepNext: true }
                },
                {
                    id: 'OfficeSubtitle',
                    name: 'Office Subtitle',
                    basedOn: 'Normal',
                    next: 'Normal',
                    quickFormat: true,
                    run: { font: 'Microsoft YaHei', size: 24, color: '64748B' },
                    paragraph: { spacing: { before: 0, after: 300 }, keepNext: true }
                },
                {
                    id: 'Heading1',
                    name: 'Heading 1',
                    basedOn: 'Normal',
                    next: 'Normal',
                    quickFormat: true,
                    run: { font: 'Microsoft YaHei', size: 32, bold: true, color: '2E74B5' },
                    paragraph: { spacing: { before: 320, after: 160 }, keepNext: true, outlineLevel: 0 }
                },
                {
                    id: 'Heading2',
                    name: 'Heading 2',
                    basedOn: 'Normal',
                    next: 'Normal',
                    quickFormat: true,
                    run: { font: 'Microsoft YaHei', size: 26, bold: true, color: '2E74B5' },
                    paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 1 }
                },
                {
                    id: 'Heading3',
                    name: 'Heading 3',
                    basedOn: 'Normal',
                    next: 'Normal',
                    quickFormat: true,
                    run: { font: 'Microsoft YaHei', size: 24, bold: true, color: '1F4D78' },
                    paragraph: { spacing: { before: 160, after: 80 }, keepNext: true, outlineLevel: 2 }
                }
            ]
        },
        numbering: {
            config: [{
                reference: 'office-numbering',
                levels: [{
                    level: 0,
                    format: LevelFormat.DECIMAL,
                    text: '%1.',
                    alignment: AlignmentType.LEFT,
                    style: {
                        paragraph: {
                            indent: { left: 720, hanging: 360 },
                            spacing: { after: 80, line: 280 }
                        }
                    }
                }]
            }]
        },
        sections: [{
            properties: {
                page: {
                    size: { width: 12240, height: 15840 },
                    margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 }
                }
            },
            footers: {
                default: new Footer({
                    children: [new Paragraph({
                        alignment: AlignmentType.RIGHT,
                        children: [
                            new TextRun({ text: '第 ', font: 'Microsoft YaHei', size: 18, color: '94A3B8' }),
                            new TextRun({ children: [PageNumber.CURRENT], font: 'Microsoft YaHei', size: 18, color: '94A3B8' }),
                            new TextRun({ text: ' 页', font: 'Microsoft YaHei', size: 18, color: '94A3B8' })
                        ]
                    })]
                })
            },
            children
        }]
    });
    return Packer.toBuffer(document);
}

function colorArgb(value, fallback) {
    const cleaned = String(value || '').replace('#', '').toUpperCase();
    if (/^[0-9A-F]{6}$/.test(cleaned)) return `FF${cleaned}`;
    if (/^[0-9A-F]{8}$/.test(cleaned)) return cleaned;
    return fallback;
}

const EXCEL_STYLE_ROLES = {
    title: {
        font: { name: 'Microsoft YaHei', size: 18, bold: true, color: { argb: 'FFFFFFFF' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } },
        alignment: { vertical: 'middle', horizontal: 'left' }
    },
    header: {
        font: { name: 'Microsoft YaHei', size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } },
        alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
        border: {
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } }
        }
    },
    subheader: {
        font: { name: 'Microsoft YaHei', size: 11, bold: true, color: { argb: 'FF1E3A5F' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } },
        alignment: { vertical: 'middle', wrapText: true }
    },
    input: {
        font: { name: 'Microsoft YaHei', color: { argb: 'FF1D4ED8' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } }
    },
    output: {
        font: { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF166534' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } }
    },
    highlight: {
        font: { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF7C2D12' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7ED' } }
    },
    warning: {
        font: { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF991B1B' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF2F2' } }
    },
    normal: {
        font: { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF1F2937' } },
        alignment: { vertical: 'top', wrapText: false }
    }
};

function getWorksheet(workbook, requestedName, createIfMissing = false) {
    const name = sanitizeSheetName(requestedName || workbook.worksheets[0]?.name || 'Sheet1');
    let worksheet = workbook.getWorksheet(name);
    if (!worksheet && createIfMissing) worksheet = workbook.addWorksheet(name);
    if (!worksheet) throw new Error(`找不到工作表：${name}`);
    return worksheet;
}

function applyStyleRole(cell, role) {
    const style = EXCEL_STYLE_ROLES[role] || EXCEL_STYLE_ROLES.normal;
    cell.style = {
        ...cell.style,
        ...style,
        font: { ...(cell.font || {}), ...(style.font || {}) },
        fill: style.fill || cell.fill,
        alignment: { ...(cell.alignment || {}), ...(style.alignment || {}) },
        border: style.border || cell.border
    };
}

function applyCellSpec(cell, spec, defaultRole = null) {
    if (spec && typeof spec === 'object' && !Array.isArray(spec) && !(spec instanceof Date)) {
        if (spec.formula) {
            cell.value = { formula: String(spec.formula).replace(/^=/, ''), result: spec.result ?? undefined };
        } else if (Object.prototype.hasOwnProperty.call(spec, 'value')) {
            cell.value = spec.value;
        } else {
            cell.value = '';
        }
        if (spec.numberFormat) cell.numFmt = String(spec.numberFormat);
        if (spec.styleRole || defaultRole) applyStyleRole(cell, spec.styleRole || defaultRole);
        if (spec.comment) cell.note = String(spec.comment);
        if (spec.hyperlink) {
            cell.value = { text: String(spec.value || spec.hyperlink), hyperlink: String(spec.hyperlink) };
        }
        return;
    }
    cell.value = spec ?? '';
    if (defaultRole) applyStyleRole(cell, defaultRole);
}

function writeRows(worksheet, startRow, startColumn, rows, defaultRole = null) {
    if (!Array.isArray(rows)) throw new Error('rows 必须是二维数组');
    const cellCount = rows.reduce((sum, row) => sum + (Array.isArray(row) ? row.length : 0), 0);
    if (cellCount > MAX_MATRIX_CELLS) throw new Error('单次写入的单元格数量过多');
    rows.forEach((row, rowOffset) => {
        if (!Array.isArray(row)) return;
        row.forEach((value, columnOffset) => {
            applyCellSpec(worksheet.getCell(startRow + rowOffset, startColumn + columnOffset), value, defaultRole);
        });
    });
}

function copyRowPresentation(worksheet, sourceRowNumber, targetRowNumber) {
    if (sourceRowNumber < 1 || targetRowNumber < 1) return;
    const sourceRow = worksheet.getRow(sourceRowNumber);
    const targetRow = worksheet.getRow(targetRowNumber);
    targetRow.height = sourceRow.height;
    const columnCount = Math.max(worksheet.actualColumnCount || 0, worksheet.columnCount || 0);
    for (let column = 1; column <= columnCount; column += 1) {
        const sourceCell = sourceRow.getCell(column);
        const targetCell = targetRow.getCell(column);
        if (sourceCell.hasStyle) {
            targetCell.style = {
                ...sourceCell.style,
                font: sourceCell.font ? { ...sourceCell.font } : undefined,
                fill: sourceCell.fill ? { ...sourceCell.fill } : undefined,
                border: sourceCell.border ? { ...sourceCell.border } : undefined,
                alignment: sourceCell.alignment ? { ...sourceCell.alignment } : undefined,
                protection: sourceCell.protection ? { ...sourceCell.protection } : undefined
            };
        }
        if (sourceCell.dataValidation?.type) {
            targetCell.dataValidation = { ...sourceCell.dataValidation };
        }
    }
}

function styleRange(worksheet, rangeAddress, role, numberFormat = null) {
    const range = worksheet.getCell(String(rangeAddress).split(':')[0]);
    const match = String(rangeAddress).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
    if (!match) {
        applyStyleRole(range, role);
        if (numberFormat) range.numFmt = numberFormat;
        return;
    }
    const start = worksheet.getCell(`${match[1]}${match[2]}`);
    const end = worksheet.getCell(`${match[3]}${match[4]}`);
    for (let row = start.row; row <= end.row; row += 1) {
        for (let column = start.col; column <= end.col; column += 1) {
            const cell = worksheet.getCell(row, column);
            applyStyleRole(cell, role);
            if (numberFormat) cell.numFmt = numberFormat;
        }
    }
}

function createSheetFromSpec(workbook, spec, index) {
    let name = sanitizeSheetName(spec.name, `Sheet${index + 1}`);
    let suffix = 2;
    while (workbook.getWorksheet(name)) {
        name = sanitizeSheetName(`${spec.name || `Sheet${index + 1}`}_${suffix}`);
        suffix += 1;
    }
    const worksheet = workbook.addWorksheet(name, {
        views: [{ state: 'frozen', ySplit: spec.freezeHeader === false ? 0 : (spec.title ? 3 : 1), showGridLines: false }]
    });
    const headers = Array.isArray(spec.headers) ? spec.headers : [];
    const rows = Array.isArray(spec.rows) ? spec.rows : [];
    const columnCount = Math.max(headers.length, ...rows.map(row => Array.isArray(row) ? row.length : 0), 1);
    let currentRow = 1;
    if (spec.title) {
        worksheet.mergeCells(currentRow, 1, currentRow, columnCount);
        const titleCell = worksheet.getCell(currentRow, 1);
        titleCell.value = spec.title;
        applyStyleRole(titleCell, 'title');
        worksheet.getRow(currentRow).height = 34;
        currentRow += 2;
    }
    if (headers.length) {
        writeRows(worksheet, currentRow, 1, [headers], 'header');
        worksheet.getRow(currentRow).height = 26;
        if (spec.autoFilter !== false) {
            worksheet.autoFilter = {
                from: { row: currentRow, column: 1 },
                to: { row: currentRow + rows.length, column: columnCount }
            };
        }
        currentRow += 1;
    }
    writeRows(worksheet, currentRow, 1, rows, 'normal');
    return worksheet;
}

function applyExcelOperation(workbook, operation) {
    const type = String(operation?.type || '');
    if (!type) return;
    if (type === 'addSheet') {
        createSheetFromSpec(workbook, operation, workbook.worksheets.length);
        return;
    }
    if (type === 'renameSheet') {
        getWorksheet(workbook, operation.sheet).name = sanitizeSheetName(operation.name, '工作表');
        return;
    }
    if (type === 'removeSheet') {
        const worksheet = getWorksheet(workbook, operation.sheet);
        if (workbook.worksheets.length <= 1) throw new Error('不能删除工作簿中的最后一个工作表');
        workbook.removeWorksheet(worksheet.id);
        return;
    }

    const worksheet = getWorksheet(workbook, operation.sheet, type === 'setCell' || type === 'setRange');
    if (type === 'setCell') {
        const cell = worksheet.getCell(String(operation.address || 'A1'));
        applyCellSpec(cell, operation, operation.styleRole || null);
        return;
    }
    if (type === 'setRange') {
        const start = worksheet.getCell(String(operation.startCell || 'A1'));
        writeRows(worksheet, start.row, start.col, operation.rows || operation.values || []);
        return;
    }
    if (type === 'appendRows') {
        const rows = Array.isArray(operation.rows) ? operation.rows : [];
        const startRow = Math.max(worksheet.actualRowCount || 0, worksheet.rowCount || 0) + 1;
        rows.forEach((_, offset) => copyRowPresentation(worksheet, Math.max(1, startRow - 1), startRow + offset));
        writeRows(worksheet, startRow, 1, rows);
        return;
    }
    if (type === 'insertRows') {
        const rows = Array.isArray(operation.rows) ? operation.rows : [];
        const startRow = Math.max(1, Number(operation.startRow) || 1);
        worksheet.spliceRows(startRow, 0, ...rows.map(row => Array.isArray(row) ? row : []));
        rows.forEach((_, offset) => copyRowPresentation(worksheet, Math.max(1, startRow - 1), startRow + offset));
        writeRows(worksheet, startRow, 1, rows);
        return;
    }
    if (type === 'deleteRows') {
        worksheet.spliceRows(Math.max(1, Number(operation.startRow) || 1), Math.max(1, Math.min(5000, Number(operation.count) || 1)));
        return;
    }
    if (type === 'deleteColumns') {
        worksheet.spliceColumns(Math.max(1, Number(operation.startColumn) || 1), Math.max(1, Math.min(100, Number(operation.count) || 1)));
        return;
    }
    if (type === 'setColumnWidth') {
        worksheet.getColumn(operation.column || 1).width = Math.max(4, Math.min(80, Number(operation.width) || 12));
        return;
    }
    if (type === 'setRowHeight') {
        worksheet.getRow(Math.max(1, Number(operation.row) || 1)).height = Math.max(12, Math.min(120, Number(operation.height) || 20));
        return;
    }
    if (type === 'formatRange') {
        styleRange(worksheet, operation.range || 'A1', operation.styleRole || 'normal', operation.numberFormat || null);
        return;
    }
    if (type === 'mergeCells') {
        worksheet.mergeCells(String(operation.range || 'A1:A1'));
        return;
    }
    if (type === 'unmergeCells') {
        worksheet.unMergeCells(String(operation.range || 'A1:A1'));
        return;
    }
    if (type === 'freezePane') {
        worksheet.views = [{
            state: 'frozen',
            xSplit: Math.max(0, Number(operation.columns) || 0),
            ySplit: Math.max(0, Number(operation.rows) || 0),
            showGridLines: false
        }];
        return;
    }
    if (type === 'autoFilter') {
        worksheet.autoFilter = String(operation.range || 'A1:A1');
        return;
    }
    if (type === 'dataValidation') {
        const values = Array.isArray(operation.values) ? operation.values.map(value => String(value).replace(/"/g, '""')) : [];
        if (values.length) {
            const match = String(operation.range || '').match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
            if (match) {
                const start = worksheet.getCell(`${match[1]}${match[2]}`);
                const end = worksheet.getCell(`${match[3]}${match[4]}`);
                for (let row = start.row; row <= end.row; row += 1) {
                    for (let column = start.col; column <= end.col; column += 1) {
                        worksheet.getCell(row, column).dataValidation = {
                            type: 'list',
                            allowBlank: true,
                            formulae: [`"${values.join(',')}"`]
                        };
                    }
                }
            }
        }
    }
}

function findLikelyHeaderRow(worksheet) {
    const { rowCount, columnCount } = getWorksheetBounds(worksheet);
    for (let rowIndex = 1; rowIndex <= Math.min(rowCount, 10); rowIndex += 1) {
        let populated = 0;
        let textCells = 0;
        for (let columnIndex = 1; columnIndex <= Math.min(columnCount, 30); columnIndex += 1) {
            const value = normalizeCellValue(worksheet.getCell(rowIndex, columnIndex).value);
            if (value !== '') {
                populated += 1;
                if (typeof value === 'string') textCells += 1;
            }
        }
        if (populated >= 2 && textCells >= Math.ceil(populated * 0.6)) return rowIndex;
    }
    return rowCount > 0 ? 1 : 0;
}

function professionalizeWorksheet(worksheet) {
    const { rowCount, columnCount } = getWorksheetBounds(worksheet);
    if (!rowCount || !columnCount) return;
    const headerRow = findLikelyHeaderRow(worksheet);
    worksheet.views = [{ state: 'frozen', ySplit: headerRow || 0, showGridLines: false }];
    if (headerRow) {
        for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
            applyStyleRole(worksheet.getCell(headerRow, columnIndex), 'header');
        }
        worksheet.getRow(headerRow).height = Math.max(26, worksheet.getRow(headerRow).height || 0);
        if (rowCount > headerRow && !worksheet.autoFilter) {
            worksheet.autoFilter = {
                from: { row: headerRow, column: 1 },
                to: { row: rowCount, column: columnCount }
            };
        }
    }

    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
        let maxLength = 4;
        const headerText = String(normalizeCellValue(worksheet.getCell(headerRow || 1, columnIndex).value) || '');
        for (let rowIndex = 1; rowIndex <= Math.min(rowCount, 220); rowIndex += 1) {
            const value = normalizeCellValue(worksheet.getCell(rowIndex, columnIndex).value);
            maxLength = Math.max(maxLength, Math.min(60, String(value ?? '').length));
            const cell = worksheet.getCell(rowIndex, columnIndex);
            cell.font = { ...(cell.font || {}), name: cell.font?.name || 'Microsoft YaHei' };
            cell.alignment = {
                ...(cell.alignment || {}),
                vertical: cell.alignment?.vertical || 'top',
                horizontal: cell.alignment?.horizontal
                    || (typeof value === 'number' ? 'right' : /状态|类型|等级|日期|时间/.test(headerText) ? 'center' : 'left'),
                wrapText: maxLength > 28
            };
            if (rowIndex > headerRow && (!cell.numFmt || cell.numFmt === 'General')) {
                if (/率|比例|占比|百分比/.test(headerText) && typeof value === 'number') {
                    cell.numFmt = '0.0%';
                } else if (/金额|预算|成本|收入|支出|价格|单价|总计|合计/.test(headerText) && typeof value === 'number') {
                    cell.numFmt = '#,##0.00';
                } else if (/日期|时间/.test(headerText) && cell.value instanceof Date) {
                    cell.numFmt = 'yyyy-mm-dd';
                } else if (typeof value === 'number') {
                    cell.numFmt = Number.isInteger(value) ? '#,##0' : '#,##0.00';
                }
            }
        }
        worksheet.getColumn(columnIndex).width = Math.max(10, Math.min(42, maxLength + 3));
    }
}

function scanWorkbookStats(workbook) {
    let formulaCount = 0;
    let errorCount = 0;
    let populatedCells = 0;
    for (const worksheet of workbook.worksheets) {
        worksheet.eachRow({ includeEmpty: false }, row => {
            row.eachCell({ includeEmpty: false }, cell => {
                populatedCells += 1;
                const value = cell.value;
                if (value && typeof value === 'object' && (value.formula || value.sharedFormula)) formulaCount += 1;
                const normalized = normalizeCellValue(value);
                if (typeof normalized === 'string' && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A)/.test(normalized)) errorCount += 1;
            });
        });
    }
    return {
        sheetCount: workbook.worksheets.length,
        formulaCount,
        errorCount,
        populatedCells
    };
}

async function buildExcelBufferFromPlan({ plan, sourceWorkbook = null, instruction = '' }) {
    const workbook = sourceWorkbook || new ExcelJS.Workbook();
    if (!sourceWorkbook) {
        workbook.creator = '智能办公文档中心';
        workbook.created = new Date();
    }
    const sheets = Array.isArray(plan.sheets) ? plan.sheets.slice(0, 30) : [];
    if (!sourceWorkbook && sheets.length === 0) {
        sheets.push({
            name: '内容',
            title: '智能办公任务',
            headers: ['项目', '内容'],
            rows: [['任务说明', instruction || '待补充']],
            freezeHeader: true,
            autoFilter: true
        });
    }
    sheets.forEach((sheet, index) => createSheetFromSpec(workbook, sheet, index));

    const operations = Array.isArray(plan.operations) ? plan.operations.slice(0, MAX_EXCEL_OPERATIONS) : [];
    operations.forEach(operation => applyExcelOperation(workbook, operation));

    const shouldProfessionalize = !sourceWorkbook
        || plan.applyProfessionalFormatting === true
        || /优化|美化|格式|排版|专业|可读|统一样式|整理格式/.test(instruction);
    if (shouldProfessionalize) {
        workbook.worksheets.forEach(professionalizeWorksheet);
    }
    const stats = scanWorkbookStats(workbook);
    const buffer = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), stats, workbook };
}

async function buildWordResult({
    source,
    instruction,
    style,
    callAIWithRetry,
    getModelName,
    userConfig
}) {
    const sourceText = sourceToPrompt(source);
    let plan;
    if (sourceText.length > WORD_CHUNK_CHARS) {
        if (sourceText.length > MAX_WORD_SOURCE_CHARS) {
            throw new Error(`Word 文档内容超过 ${MAX_WORD_SOURCE_CHARS.toLocaleString()} 字符，请先拆分文档后分批处理`);
        }
        const chunks = splitLongText(sourceText).slice(0, MAX_WORD_CHUNKS);
        const revisedChunks = [];
        const summaries = [];
        for (let index = 0; index < chunks.length; index += 1) {
            const result = await callForJson({
                callAIWithRetry,
                getModelName,
                userConfig,
                systemPrompt: WORD_CHUNK_SYSTEM_PROMPT,
                userPrompt: `整份文档处理要求：${instruction}\n排版偏好：${style || '专业商务'}\n当前片段：${index + 1}/${chunks.length}\n\n${chunks[index]}`,
                maxTokens: 8000
            });
            revisedChunks.push(String(result.contentMarkdown || chunks[index]));
            if (result.summary) summaries.push(result.summary);
        }
        const sourceBaseName = sanitizeFilename(source?.filename || '办公文档');
        const inferredTitle = revisedChunks
            .join('\n')
            .match(/^#\s+(.+)$/m)?.[1]
            || sourceBaseName;
        plan = {
            summary: `已分 ${chunks.length} 个片段完成处理${summaries.length ? `：${summaries.slice(0, 3).join('；')}` : ''}`,
            filename: `${sourceBaseName}_优化版`,
            title: inferredTitle,
            subtitle: '',
            contentMarkdown: revisedChunks.join('\n\n')
        };
    } else {
        plan = await callForJson({
            callAIWithRetry,
            getModelName,
            userConfig,
            systemPrompt: WORD_SYSTEM_PROMPT,
            userPrompt: `用户任务：${instruction}\n排版偏好：${style || '专业商务'}\n源文件：${source?.filename || '无（从零生成）'}\n\n源内容：\n${sourceText}`,
            maxTokens: 12000
        });
    }
    const title = String(plan.title || plan.filename || '办公文档').trim();
    const markdown = String(plan.contentMarkdown || '').trim();
    if (!markdown) throw new Error('AI 未生成 Word 正文内容');
    const buffer = await buildWordBufferFromMarkdown({
        title,
        subtitle: String(plan.subtitle || ''),
        markdown
    });
    return {
        buffer,
        format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: `${sanitizeFilename(plan.filename || title)}.docx`,
        summary: String(plan.summary || 'Word 文档已处理完成'),
        stats: {
            characters: markdown.length,
            sections: (markdown.match(/^#{1,3}\s+/gm) || []).length,
            sourceKind: source?.kind || 'new'
        }
    };
}

async function buildExcelResult({
    source,
    instruction,
    style,
    callAIWithRetry,
    getModelName,
    userConfig
}) {
    const sourcePrompt = sourceToPrompt(source);
    const plan = await callForJson({
        callAIWithRetry,
        getModelName,
        userConfig,
        systemPrompt: EXCEL_SYSTEM_PROMPT,
        userPrompt: `用户任务：${instruction}\n排版偏好：${style || '专业清晰'}\n源文件：${source?.filename || '无（从零生成）'}\n源文件类型：${source?.kind || '无'}\n\n工作簿/源内容快照：\n${sourcePrompt}`,
        maxTokens: 12000
    });
    const sourceWorkbook = source?.kind === 'excel' ? source.workbook : null;
    const result = await buildExcelBufferFromPlan({
        plan,
        sourceWorkbook,
        instruction
    });
    return {
        buffer: result.buffer,
        format: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${sanitizeFilename(plan.filename || source?.filename || '办公表格处理结果')}.xlsx`,
        summary: String(plan.summary || 'Excel 工作簿已处理完成'),
        stats: {
            ...result.stats,
            sourceKind: source?.kind || 'new',
            macroNotice: source?.ext === '.xlsm' ? '输出为 .xlsx，不保留 VBA 宏' : ''
        }
    };
}

function createOfficeDocumentService({ callAIWithRetry, getModelName }) {
    if (typeof callAIWithRetry !== 'function' || typeof getModelName !== 'function') {
        throw new Error('Office document service requires AI and model dependencies');
    }

    async function inspect(file) {
        const source = await extractOfficeSource(file);
        if (!source) throw new Error('请上传要检查的 Word 或 Excel 文件');
        return {
            kind: source.kind,
            filename: source.filename,
            size: source.size,
            extension: source.ext,
            metadata: source.metadata,
            preview: source.kind === 'word'
                ? String(source.content || '').slice(0, 5000)
                : null,
            warnings: [
                source.ext === '.xlsm' ? '该文件包含宏时，处理后的 .xlsx 不会保留 VBA 宏' : null,
                source.kind === 'excel' && source.snapshot?.truncated ? '大型工作簿仅向 AI 提供代表性数据快照，未触及的数据会原样保留' : null
            ].filter(Boolean)
        };
    }

    async function process({ file = null, instruction, outputFormat = 'auto', style = 'professional', userConfig = null }) {
        const normalizedInstruction = String(instruction || '').trim();
        if (!normalizedInstruction) throw new Error('请说明希望如何修改、优化或生成文档');
        const source = file ? await extractOfficeSource(file) : null;
        const format = resolveOutputFormat(outputFormat, source?.kind || null, normalizedInstruction);
        const common = {
            source,
            instruction: normalizedInstruction,
            style,
            callAIWithRetry,
            getModelName,
            userConfig
        };
        return format === 'xlsx' ? buildExcelResult(common) : buildWordResult(common);
    }

    return { inspect, process };
}

function registerOfficeDocumentRoutes(app, {
    upload,
    handleMulterError,
    callAIWithRetry,
    getModelName
}) {
    const service = createOfficeDocumentService({ callAIWithRetry, getModelName });

    app.post('/api/office/inspect', upload.single('file'), handleMulterError, async (req, res) => {
        const uploadedPath = req.file?.path;
        try {
            const result = await service.inspect(req.file);
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('办公文档检查失败:', error);
            res.status(400).json({ error: error.message || '办公文档检查失败' });
        } finally {
            if (uploadedPath) await fs.promises.unlink(uploadedPath).catch(() => {});
        }
    });

    app.post('/api/office/process', upload.single('file'), handleMulterError, async (req, res) => {
        const uploadedPath = req.file?.path;
        try {
            let userConfig = null;
            if (req.body.userConfig) {
                try {
                    userConfig = typeof req.body.userConfig === 'string'
                        ? JSON.parse(req.body.userConfig)
                        : req.body.userConfig;
                } catch {
                    return res.status(400).json({ error: 'AI 配置格式不正确' });
                }
            }
            const result = await service.process({
                file: req.file || null,
                instruction: req.body.instruction,
                outputFormat: req.body.outputFormat || 'auto',
                style: req.body.style || 'professional',
                userConfig
            });
            res.setHeader('Content-Type', result.mimeType);
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
            res.setHeader('X-Office-Summary', encodeURIComponent(result.summary).slice(0, 1800));
            res.setHeader('X-Office-Format', result.format);
            res.setHeader('X-Office-Stats', encodeURIComponent(JSON.stringify(result.stats || {})).slice(0, 1800));
            res.setHeader('Cache-Control', 'no-store');
            res.send(result.buffer);
        } catch (error) {
            console.error('办公文档处理失败:', error);
            res.status(500).json({ error: error.message || '办公文档处理失败' });
        } finally {
            if (uploadedPath) await fs.promises.unlink(uploadedPath).catch(() => {});
        }
    });
}

module.exports = {
    WORD_EXTENSIONS,
    EXCEL_EXTENSIONS,
    applyExcelOperation,
    buildExcelBufferFromPlan,
    buildWordBufferFromMarkdown,
    createOfficeDocumentService,
    detectOfficeKind,
    extractOfficeSource,
    parseJsonResponse,
    registerOfficeDocumentRoutes,
    resolveOutputFormat,
    sanitizeFilename,
    sanitizeSheetName,
    scanWorkbookStats
};
