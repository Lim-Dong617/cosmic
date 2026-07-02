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
        const headingName = name.toLowerCase().match(/^heading\s+([1-4])$/);
        if (styleId && headingName) byName[Number(headingName[1]) - 1] = styleId;
        if (styleId && outline && Number(outline) >= 0 && Number(outline) <= 3) {
            byOutline[Number(outline)] ||= styleId;
        }
    }
    return [0, 1, 2, 3].map(level => byName[level] || byOutline[level]).filter(Boolean);
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
    const missingParagraphNumbering = headingParagraphs.filter(paragraph => !/<w:numPr>[\s\S]*?<\/w:numPr>/.test(paragraph));
    const missingStyleNumbering = [...headingStyleIds].filter(styleId => {
        const escapedStyleId = styleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const styleBlock = stylesXml.match(new RegExp(`<w:style\\b(?=[^>]*w:styleId="${escapedStyleId}")[^>]*>[\\s\\S]*?<\\/w:style>`))?.[0] || '';
        return !/<w:numPr>[\s\S]*?<\/w:numPr>/.test(styleBlock);
    });

    const expectedLevelTexts = ['%1.', '%1.%2.', '%1.%2.%3.'];
    const missingLevelTexts = expectedLevelTexts.filter(text => !numberingXml.includes(`w:val="${text}"`));

    if (headingParagraphs.length === 0) throw new Error('No heading paragraphs found in exported DOCX.');
    if (manualHeadings.length) throw new Error(`Manual heading numbers remain: ${manualHeadings.join(' | ')}`);
    if (missingParagraphNumbering.length) throw new Error(`Heading paragraphs missing numPr: ${missingParagraphNumbering.length}`);
    if (missingStyleNumbering.length) throw new Error(`Heading styles missing numPr: ${missingStyleNumbering.join(', ')}`);
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
