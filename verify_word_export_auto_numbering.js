const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const JSZip = require('jszip');

const PORT = 32123;
const OUT = path.join(__dirname, 'outputs', 'word_export_auto_numbering_test.docx');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeXmlText(text) {
    return String(text || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function styleBlocks(stylesXml) {
    return [...stylesXml.matchAll(/<w:style\b(?=[^>]*w:type="paragraph")[^>]*>[\s\S]*?<\/w:style>/g)]
        .map(match => match[0]);
}

function detectHeadingStyleIds(stylesXml) {
    const byName = {};
    const byOutline = {};
    for (const block of styleBlocks(stylesXml)) {
        const styleId = block.match(/\bw:styleId="([^"]+)"/)?.[1];
        const name = block.match(/<w:name\b[^>]*\bw:val="([^"]*)"/)?.[1] || '';
        const outline = block.match(/<w:outlineLvl\b[^>]*\bw:val="(\d+)"/)?.[1];
        const headingName = name.toLowerCase().match(/^heading\s+([1-9])$/);
        if (styleId && headingName) byName[Number(headingName[1]) - 1] = styleId;
        if (styleId && outline && Number(outline) >= 0 && Number(outline) <= 8) {
            byOutline[Number(outline)] ||= styleId;
        }
    }
    const detectedLevels = [
        ...Object.keys(byName).map(Number),
        ...Object.keys(byOutline).map(Number)
    ];
    const highestLevel = Math.max(3, ...detectedLevels);
    return Array.from(
        { length: highestLevel + 1 },
        (_, level) => byName[level] || byOutline[level]
    ).filter(Boolean);
}

async function postExportWord() {
    const body = {
        filename: 'auto-numbering-test',
        documentName: 'Auto Numbering Test',
        sequenceDiagrams: [],
        tableData: [
            {
                level1: 'Module A',
                level2: 'Module B',
                level3: 'Module C',
                functionalUser: 'Initiator: User Receiver: System',
                triggerEvent: 'User trigger',
                functionalProcess: 'Query sample data',
                dataMovementType: 'E',
                subProcessDesc: 'Receive query request',
                dataGroup: 'Query request',
                dataAttributes: 'request id',
                functionDescription: 'The system receives a query request and returns sample data.'
            },
            {
                dataMovementType: 'R',
                subProcessDesc: 'Read sample data',
                dataGroup: 'Sample table',
                dataAttributes: 'sample id'
            },
            {
                dataMovementType: 'X',
                subProcessDesc: 'Return query result',
                dataGroup: 'Query response',
                dataAttributes: 'result status'
            }
        ]
    };

    for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${PORT}/api/export-word`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }
            return Buffer.from(await response.arrayBuffer());
        } catch (error) {
            if (attempt === 29) throw error;
            await sleep(500);
        }
    }
}

async function verifyDocx(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml').async('string');
    const stylesXml = await zip.file('word/styles.xml').async('string');
    const numberingXml = await zip.file('word/numbering.xml').async('string');
    const headingStyleIds = new Set(detectHeadingStyleIds(stylesXml));

    const headingParagraphs = [...documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
        .map(match => match[0])
        .filter(paragraph => headingStyleIds.has(paragraph.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/)?.[1]));

    const manualHeadings = headingParagraphs
        .map(paragraph => decodeXmlText([...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => match[1]).join('')).trim())
        .filter(text => /^\d+(?:\.\d+)*\.?\s+/.test(text));
    const paragraphNumberingOverrides = headingParagraphs.filter(paragraph => /<w:numPr>[\s\S]*?<\/w:numPr>/.test(paragraph));
    const styleNumbering = [...headingStyleIds].map((styleId, level) => {
        const escapedStyleId = styleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const styleBlock = stylesXml.match(new RegExp(`<w:style\\b(?=[^>]*w:styleId="${escapedStyleId}")[^>]*>[\\s\\S]*?<\\/w:style>`))?.[0] || '';
        return {
            styleId,
            level,
            numId: styleBlock.match(/<w:numId\b[^>]*\bw:val="(\d+)"/)?.[1],
            ilvl: styleBlock.match(/<w:ilvl\b[^>]*\bw:val="(\d+)"/)?.[1]
        };
    });
    const missingStyleNumbering = styleNumbering.filter(item => !item.numId);
    const styleNumIds = new Set(styleNumbering.map(item => item.numId).filter(Boolean));
    const wrongStyleLevels = styleNumbering.filter(item => Number(item.ilvl) !== item.level);

    const expectedLevelTexts = [...headingStyleIds].map((_, level) => (
        Array.from({ length: level + 1 }, (_unused, index) => `%${index + 1}`).join('.') + '.'
    ));
    const missingLevelTexts = expectedLevelTexts.filter(text => !numberingXml.includes(`w:val="${text}"`));

    if (headingParagraphs.length === 0) throw new Error('No heading paragraphs found in exported DOCX.');
    if (manualHeadings.length) throw new Error(`Manual heading numbers remain: ${manualHeadings.join(' | ')}`);
    if (paragraphNumberingOverrides.length) {
        throw new Error(`Heading paragraphs must inherit numbering from styles, but ${paragraphNumberingOverrides.length} have direct numPr.`);
    }
    if (missingStyleNumbering.length) {
        throw new Error(`Heading styles missing numPr: ${missingStyleNumbering.map(item => item.styleId).join(', ')}`);
    }
    if (styleNumIds.size !== 1) throw new Error(`Heading styles do not share one numId: ${[...styleNumIds].join(', ')}`);
    if (wrongStyleLevels.length) {
        throw new Error(`Heading styles have wrong ilvl: ${wrongStyleLevels.map(item => `${item.styleId}:${item.ilvl}`).join(', ')}`);
    }
    if (missingLevelTexts.length) throw new Error(`Missing numbering level texts: ${missingLevelTexts.join(', ')}`);

    return {
        headingParagraphs: headingParagraphs.length,
        headingStyles: [...headingStyleIds]
    };
}

async function main() {
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: __dirname,
        env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
        const buffer = await postExportWord();
        await fs.mkdir(path.dirname(OUT), { recursive: true });
        await fs.writeFile(OUT, buffer);
        const result = await verifyDocx(buffer);
        console.log(JSON.stringify({ ok: true, output: OUT, ...result }, null, 2));
    } finally {
        child.kill();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
