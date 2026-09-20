import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { exportWordFile, wordExportErrorMessage } from './client/src/word-export-jobs.js';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { createWordExportService } = require('./server/word-export-jobs');
const { xml2js } = require('xml-js');
const largeImages = process.argv.includes('--large-images');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5i8AAAAASUVORK5CYII=';
const crc32 = data => {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
};
const pngChunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
};
const bigPng = index => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(128); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
    const scanlines = randomBytes(64 * (128 * 3 + 1));
    for (let row = 0; row < 64; row++) scanlines[row * (128 * 3 + 1)] = 0;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
        pngChunk('tEXt', Buffer.from(`process\0${index}`)), pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
};
const makePayload = (count, exportTemplate = 'hierarchy') => ({
    exportTemplate, filename: '功能过程导出验证', documentName: '功能过程导出验证',
    tableData: Array.from({ length: count }, (_, index) => [
        { level1: '网络运营', level2: `资源管理${Math.floor(index / 50)}`, level3: '基站管理',
            functionalProcess: `查询基站${index}`, functionalUser: '管理员', triggerEvent: '提交查询条件',
            dataMovementType: 'E', subProcessDesc: '输入区域和编号', dataGroup: '查询条件', dataAttributes: '区域、编号',
            functionDescription: '系统接收用户提交的区域和编号，查询对应的基站记录并返回符合条件的记录，供管理员核实基站状态。' },
        { dataMovementType: 'R', subProcessDesc: '读取基站记录', dataGroup: '基站记录', dataAttributes: '编号、状态' },
        { dataMovementType: 'X', subProcessDesc: '返回查询结果', dataGroup: '查询结果', dataAttributes: '编号、状态' }
    ]).flat(),
    sequenceDiagrams: Array.from({ length: count }, (_, processIndex) => ({
        processIndex, processName: `查询基站${processIndex}`, imageBase64: largeImages && count > 100 ? bigPng(processIndex) : png,
        width: largeImages ? 128 : 1, height: largeImages ? 64 : 1
    }))
});
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'word-export-jobs-test-'));
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { NODE_ENV: 'test', JWT_SECRET: 'offline-export-test', VOLCENGINE_API_KEY: 'offline-export-test',
    REGISTRATION_INVITE_CODE: 'offline-export-test', UPLOAD_TMP_DIR: temp, WORD_EXPORT_WORKER_HEAP_MB: '192' });
const child = spawn(process.execPath, ['--max-old-space-size=128', 'test-cosmic-http.mjs', '--isolated-server'], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
});
const exited = once(child, 'exit');
let logs = '';
const memoryLogs = [];
const capture = data => {
    logs = (logs + data).slice(-20000);
    memoryLogs.push(...String(data).split('\n').filter(line => line.includes('进程峰值 RSS')));
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);
let startupTimer;
try {
    const port = await new Promise((resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error('Word test server startup timeout')), 15000);
        child.on('message', message => { if (message.type === 'ready') resolve(message.port); });
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Word test server exited: ${code}`)));
    });
    clearTimeout(startupTimer);
    const base = `http://127.0.0.1:${port}`;
    const request = (url, options = {}) => fetch(base + url, { signal: AbortSignal.timeout(60000), ...options });
    const submit = async (payload, key) => {
        const body = new FormData();
        body.append('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'payload.json');
        const response = await request(`/api/export-word-jobs?requestKey=${key}`, { method: 'POST', body });
        assert.equal(response.status, 202, await response.clone().text());
        return (await response.json()).jobId;
    };
    const status = async id => (await (await request(`/api/export-word-jobs/${id}`)).json()).job;
    const wait = async id => {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const job = await status(id);
            if (['completed', 'failed', 'canceled'].includes(job.status)) return job;
            await pause(100);
        }
        throw new Error('Word export did not finish');
    };
    const checkDocument = async (buffer, count, template) => {
        const zip = await JSZip.loadAsync(buffer);
        const xml = await zip.file('word/document.xml').async('string');
        for (let index = 0; index < count; index++) assert.ok(xml.includes(`查询基站${index}<`), `Missing process ${index}`);
        assert.equal((xml.match(/<w:drawing\b/g) || []).length, count, 'Every process must retain its diagram');
        const rels = xml2js(await zip.file('word/_rels/document.xml.rels').async('string'), { compact: true }).Relationships.Relationship;
        const relationMap = new Map(rels.map(item => [item._attributes.Id, item._attributes]));
        assert.equal(relationMap.size, rels.length, 'Relationship IDs must be unique after fragment merging');
        for (const [, id] of xml.matchAll(/\br:embed="([^"]+)"/g)) {
            const target = relationMap.get(id)?.Target;
            assert.ok(target && zip.file(`word/${target}`), `Broken image reference ${id}`);
        }
        const drawingIds = [...xml.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)].map(match => match[1]);
        assert.equal(new Set(drawingIds).size, drawingIds.length, 'Drawing IDs must be unique');
        if (template === 'business-spec') {
            const tableRowCounts = (xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || []).map(table => (table.match(/<w:tr\b/g) || []).length);
            assert.ok(tableRowCounts.includes(count + 1), 'The full function list remains one table with one header');
        }
        if (template !== 'xinjiang') {
            const styles = await zip.file('word/styles.xml').async('string');
            assert.match(styles, /<w:numPr>/, 'Automatic heading numbering survives export');
            const headingParagraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g).filter(p => /<w:pStyle w:val="Heading[1-9]"/.test(p));
            assert.ok(headingParagraphs.every(p => !p.includes('<w:numPr>')), 'Headings inherit editable numbering from styles');
        }
    };

    for (const template of ['hierarchy', 'business-spec', 'xinjiang']) {
        const started = Date.now();
        const payload = makePayload(1111, template);
        const id = await submit(payload, `large-${template}`);
        assert.equal(await submit(payload, `large-${template}`), id, 'Retry must reuse the job');
        const queuedDownload = await request(`/api/export-word-jobs/${id}/download`);
        assert.equal(queuedDownload.status, 409);
        let healthChecks = 0;
        let maxHealthMs = 0;
        let job;
        const deadline = Date.now() + 90000;
        do {
            assert.ok(Date.now() < deadline, 'Export must finish before the test deadline');
            const healthStart = Date.now();
            assert.equal((await request('/api/health')).status, 200);
            maxHealthMs = Math.max(maxHealthMs, Date.now() - healthStart);
            healthChecks++;
            job = await status(id);
            if (['completed', 'failed', 'canceled'].includes(job.status)) break;
            await pause(100);
        } while (true);
        assert.equal(job.status, 'completed', JSON.stringify(job.error));
        assert.ok(maxHealthMs < 3000, 'The web server must remain responsive during generation');
        for (let attempt = 0; attempt < 2; attempt++) {
            const downloaded = await request(job.result.downloadUrl);
            assert.equal(downloaded.status, 200);
            assert.match(downloaded.headers.get('content-type'), /wordprocessingml/);
            assert.ok(downloaded.headers.get('content-disposition').includes('attachment'));
            const buffer = Buffer.from(await downloaded.arrayBuffer());
            assert.equal(buffer.length, job.result.size);
            if (!attempt) await checkDocument(buffer, 1111, template);
        }
        console.log(`PASS ${template}: 1111 processes + diagrams, ${Date.now() - started}ms, ${healthChecks} health checks, max latency ${maxHealthMs}ms`);
    }
    const bad = await wait(await submit({ tableData: [] }, 'empty'));
    assert.equal(bad.status, 'failed');
    assert.equal(bad.error.status, 400);
    assert.equal((await request('/api/export-word-jobs/missing')).status, 404);

    const running = await submit(makePayload(1111, 'xinjiang'), 'cancel-running');
    const queued = await submit(makePayload(1), 'cancel-queued');
    const queuedSecond = await submit(makePayload(1), 'cancel-queued-second');
    const overflowBody = new FormData();
    overflowBody.append('payload', new Blob([JSON.stringify(makePayload(1))]), 'payload.json');
    assert.equal((await request('/api/export-word-jobs?requestKey=overflow', { method: 'POST', body: overflowBody })).status, 429);
    await request(`/api/export-word-jobs/${queuedSecond}`, { method: 'DELETE' });
    await request(`/api/export-word-jobs/${queued}`, { method: 'DELETE' });
    await request(`/api/export-word-jobs/${running}`, { method: 'DELETE' });
    assert.equal((await wait(queued)).status, 'canceled');
    assert.equal((await wait(running)).status, 'canceled');
    assert.equal((await wait(await submit(makePayload(1), 'after-cancel'))).status, 'completed');

    const legacy = await request('/api/export-word', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makePayload(1)) });
    assert.equal(legacy.status, 200);
    await checkDocument(Buffer.from(await legacy.arrayBuffer()), 1, 'hierarchy');

    // Drive the browser helper against the real HTTP service. Lose one download
    // response, then retry the completed file without regenerating the document.
    let downloadAttempts = 0;
    const axiosLike = async (url, config = {}) => {
        const response = await request(url, config);
        const data = config.responseType === 'blob' ? await response.blob() : await response.json();
        if (!response.ok) throw Object.assign(new Error('HTTP error'), { response: { status: response.status, data } });
        return { data };
    };
    const client = {
        post: (url, body, config) => axiosLike(url, { ...config, method: 'POST', body }),
        get: (url, config) => {
            if (url.endsWith('/download') && downloadAttempts++ === 0) throw Object.assign(new Error('Connection interrupted'), { code: 'ERR_NETWORK' });
            return axiosLike(url, config);
        },
        delete: url => axiosLike(url, { method: 'DELETE' })
    };
    const downloadedBlob = await exportWordFile({ httpClient: client, payload: makePayload(1) });
    await checkDocument(Buffer.from(await downloadedBlob.arrayBuffer()), 1, 'hierarchy');
    assert.equal(downloadAttempts, 2);
    assert.equal(await wordExportErrorMessage({ response: { data: new Blob(['{"error":"内存不足"}']) } }), '内存不足');
    console.log('PASS HTTP upload, idempotency, completed-file retries, health responsiveness, cancellation, validation and legacy download');
    console.log(memoryLogs.join('\n'));
} catch (error) {
    console.error(logs);
    throw error;
} finally {
    clearTimeout(startupTimer);
    child.kill();
    await exited;
}

// Expired jobs must release their generated files as well as metadata.
const service = createWordExportService({ uploadRoot: temp, ttlMs: 30, cleanupIntervalMs: 60000 });
try {
    const input = service.filePath('.json');
    await fs.writeFile(input, JSON.stringify(makePayload(1)));
    const job = service.submitFile(input, 'expiry');
    const output = service.outputPath(job.id);
    const deadline = Date.now() + 30000;
    while (service.get(job.id)?.status !== 'completed') {
        assert.ok(Date.now() < deadline, 'Cleanup fixture generation timed out');
        assert.notEqual(service.get(job.id)?.status, 'failed');
        await pause(5);
    }
    await pause(50);
    await service.cleanup();
    assert.equal(service.get(job.id), null);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    await assert.rejects(fs.stat(input), { code: 'ENOENT' });
    console.log('PASS expired file cleanup');

    const constrained = createWordExportService({ uploadRoot: temp, workerHeapMb: 16 });
    try {
        const failingInput = constrained.filePath('.json');
        await fs.writeFile(failingInput, JSON.stringify(makePayload(200, 'business-spec')));
        const failingJob = constrained.submitFile(failingInput);
        const deadline = Date.now() + 30000;
        while (['queued', 'running'].includes(constrained.get(failingJob.id)?.status)) {
            assert.ok(Date.now() < deadline, 'Memory failure must terminate the generator');
            await pause(50);
        }
        assert.equal(constrained.get(failingJob.id).error.code, 'WORD_EXPORT_MEMORY_LIMIT');
        assert.equal(constrained.get(failingJob.id).error.status, 507);
        assert.equal(constrained.getStats().running, 0);
        console.log('PASS generator heap exhaustion is reported without crashing the parent');
    } finally { await constrained.close(); }
} finally {
    await service.close();
    await fs.rm(temp, { recursive: true, force: true });
}
