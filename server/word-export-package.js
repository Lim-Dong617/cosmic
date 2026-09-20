const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const JSZip = require('jszip');
const { Packer } = require('docx');

async function writeWordPackage(zip, outputPath) {
    if (!outputPath) return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await pipeline(zip.generateNodeStream({ compression: 'DEFLATE', streamFiles: true }), fs.createWriteStream(outputPath));
    return null;
}

// Compile bounded native docx fragments so the library never expands the whole
// document into its much larger intermediate XML object tree at once. Each
// fragment uses the same styles/page settings. Merge the OOXML bodies and image
// relationships into one document, preserving a continuous table and numbering.
class WordDocumentWriter {
    constructor(createDocument) {
        this.createDocument = createDocument;
        this.pending = [];
        this.parts = [];
        this.relationships = [];
        this.batch = 0;
        this.drawingId = 0;
        this.zip = null;
    }

    async compile(children) {
        return JSZip.loadAsync(await Packer.toBuffer(this.createDocument(children)));
    }

    async push(...children) {
        for (const child of children) {
            if (child.wordXml) {
                await this.flush();
                this.parts.push(child.wordXml);
            } else {
                this.pending.push(child);
                if (this.pending.length >= 80) await this.flush();
            }
        }
    }

    async flush() {
        if (!this.pending.length) return;
        const zip = await this.compile(this.pending);
        this.pending = [];
        const xml = await zip.file('word/document.xml').async('string');
        if (!this.zip) {
            this.zip = zip;
            this.prefix = xml.slice(0, xml.indexOf('<w:body>') + '<w:body>'.length);
            this.suffix = xml.slice(xml.lastIndexOf('<w:sectPr'));
        }
        let body = xml.slice(xml.indexOf('<w:body>') + '<w:body>'.length, xml.lastIndexOf('<w:sectPr'));
        const relationships = await zip.file('word/_rels/document.xml.rels').async('string');
        const usedIds = new Set([...body.matchAll(/\br:(?:embed|id|link)="([^"]+)"/g)].map(match => match[1]));
        this.batch++;
        for (const relation of relationships.match(/<Relationship\b[^>]*\/>/g) || []) {
            const id = relation.match(/\bId="([^"]+)"/)?.[1];
            if (usedIds.has(id)) this.relationships.push(relation.replace(`Id="${id}"`, `Id="part${this.batch}-${id}"`));
        }
        body = body.replace(/\br:(embed|id|link)="([^"]+)"/g, (_match, attribute, id) => `r:${attribute}="part${this.batch}-${id}"`)
            .replace(/(<wp:docPr\b[^>]*\bid=")\d+("[^>]*>)/g, (_match, before, after) => `${before}${++this.drawingId}${after}`);
        for (const file of zip.file(/^word\/media\//)) {
            if (!this.zip.file(file.name)) this.zip.file(file.name, await file.async('nodebuffer'));
        }
        this.parts.push(body);
    }

    async table(rows, createTable) {
        let prefix;
        const body = [];
        // Keep the first header only; Word's tableHeader property repeats it at
        // page boundaries. Splitting the compilation must not split the table.
        for (let start = 0; start < Math.max(1, rows.length); start += 60) {
            const zip = await this.compile([createTable(rows.slice(start, start + 60))]);
            const xml = await zip.file('word/document.xml').async('string');
            const table = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)?.[0];
            if (!table) throw new Error('Word 表格生成失败');
            const tableRows = table.match(/<w:tr\b[\s\S]*?<\/w:tr>/g);
            if (!prefix) prefix = table.slice(0, table.indexOf('<w:tr'));
            body.push(...(start ? tableRows.slice(1) : tableRows));
        }
        return { wordXml: prefix + body.join('') + '</w:tbl>' };
    }

    async finish() {
        await this.flush();
        this.zip.file('word/document.xml', this.prefix + this.parts.join('') + this.suffix);
        const relations = await this.zip.file('word/_rels/document.xml.rels').async('string');
        this.zip.file('word/_rels/document.xml.rels', relations.replace('</Relationships>', this.relationships.join('') + '</Relationships>'));
        this.parts = [];
        return this.zip;
    }
}

module.exports = { WordDocumentWriter, writeWordPackage };
