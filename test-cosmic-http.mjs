import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const dummyKey = 'offline-http-test-dummy-key';
const modelAlias = 'siliconflow-deepseek-v3.2';
const userConfig = { model: modelAlias };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Start the real server, routes, job manager and AI client in a separate process.
// Only persistence/config loading and the bind address are replaced. The parent
// supplies an allowlisted environment with a dummy key and a loopback upstream.
async function startIsolatedServer() {
    const Module = require('node:module');
    const fs = require('node:fs');
    const net = require('node:net');
    const databasePath = require.resolve('./server/database');
    const originalLoad = Module._load;
    let dotenvCalls = 0;
    let databaseInitializations = 0;
    const forbiddenDatabaseOperation = () => { throw new Error('HTTP tests must not access a database'); };
    const database = {
        initDatabase: async () => { databaseInitializations += 1; },
        userOps: new Proxy({}, { get: () => forbiddenDatabaseOperation }),
        conversationOps: new Proxy({}, { get: () => forbiddenDatabaseOperation })
    };
    Module._load = function (request, parent, isMain) {
        if (request === 'dotenv') return { config: () => { dotenvCalls += 1; return { parsed: {} }; } };
        if (request === './database' && Module._resolveFilename(request, parent) === databasePath) return database;
        return originalLoad.call(this, request, parent, isMain);
    };
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (filename, ...args) {
        if (typeof filename === 'string' && /^\.env(?:\.|$)/.test(path.basename(filename))) {
            throw new Error('HTTP tests must not read environment files');
        }
        return originalRead.call(this, filename, ...args);
    };
    const originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const host = typeof first === 'object' ? first.host || first.hostname || 'localhost'
            : typeof args[1] === 'string' ? args[1] : 'localhost';
        assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), `External connection forbidden: ${host}`);
        return originalConnect.apply(this, args);
    };
    const express = require('express');
    const originalListen = express.application.listen;
    express.application.listen = function (...args) {
        const callback = typeof args.at(-1) === 'function' ? args.at(-1) : undefined;
        const server = originalListen.call(this, 0, '127.0.0.1', () => {
            callback?.();
            process.send({ type: 'ready', port: server.address().port, dotenvCalls, databaseInitializations });
        });
        process.on('message', message => {
            if (message?.type !== 'shutdown') return;
            server.close(() => process.exit(0));
            server.closeAllConnections?.();
        });
        process.on('disconnect', () => {
            server.close(() => process.exit(0));
            server.closeAllConnections?.();
        });
        return server;
    };
    require('./server/index.js');
}

const record = (name, evidence) => (
    `##触发事件：管理员提交${name}请求\n##功能用户：管理员\n##功能过程：${name}\n##功能过程描述：${name}并返回结果\n##原文依据：${evidence}`
);
const reply = (content, finishReason = 'stop') => ({
    id: 'offline-completion', object: 'chat.completion', created: 1,
    model: 'deepseek-ai/DeepSeek-V3.2',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

function sourceRequest(body) {
    const original = body.messages.find(message => message.role === 'user' && message.content.includes('【当前原文】'))?.content;
    assert.ok(original, 'AI requests must contain the original text');
    const range = original.match(/当前范围：第(\d+)~(\d+)字符/);
    const text = original.match(/【当前原文】\n([\s\S]*?)\n【后文，仅作上下文】/);
    assert.ok(range && text);
    return { start: Number(range[1]) - 1, end: Number(range[2]), text: text[1],
        reviewing: body.messages.some(message => message.content.includes('逐句复核候选清单')) };
}

async function runHttpTests() {
    let scenario = () => { throw new Error('Unexpected upstream request'); };
    let scenarioCalls = [];
    const mockFailures = [];
    let totalUpstreamCalls = 0;
    const upstream = http.createServer(async (request, response) => {
        try {
            assert.equal(request.method, 'POST');
            assert.equal(request.url, '/v1/chat/completions');
            assert.equal(request.headers.authorization, `Bearer ${dummyKey}`);
            let raw = '';
            for await (const chunk of request) raw += chunk;
            const body = JSON.parse(raw);
            assert.equal(body.model, 'deepseek-ai/DeepSeek-V3.2', 'the UI alias must route through the actual V3.2 provider client');
            assert.equal(body.stream, false);
            scenarioCalls.push(body);
            totalUpstreamCalls += 1;
            const result = scenario(body);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(result));
        } catch (error) {
            mockFailures.push(error);
            response.writeHead(400, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: error.message, type: 'test_mock_assertion' } }));
        }
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    const childEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(childEnvironment, {
        NODE_ENV: 'test', PORT: '3001', JWT_SECRET: dummyKey,
        DEFAULT_MODEL: modelAlias, AI_REQUEST_TIMEOUT_MS: '30000', AI_MAX_ATTEMPTS: '1',
        REGISTRATION_INVITE_CODE: 'offline-test-invite'
    });
    for (const provider of ['VOLCENGINE', 'NVIDIA', 'UNLIMITDS', 'SILICONFLOW', 'INTRANET_GLM']) {
        childEnvironment[`${provider}_API_KEY`] = dummyKey;
        childEnvironment[`${provider}_BASE_URL`] = upstreamUrl;
    }
    childEnvironment.VOLCENGINE_CODING_BASE_URL = upstreamUrl;
    childEnvironment.VOLCENGINE_STANDARD_BASE_URL = upstreamUrl;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-server'], {
        cwd: root, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
    });
    let logs = '';
    const capture = data => { logs = (logs + data.toString()).slice(-16000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const exit = once(child, 'exit');
    // Attach the startup listener before the child can load the server.
    let startupTimer;
    const startup = new Promise((resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
        child.once('error', reject);
        child.once('exit', (code, signal) => reject(new Error(`Server exited before ready (${code}/${signal})`)));
        child.on('message', message => { if (message?.type === 'ready') resolve(message); });
    });
    let passed = 0;
    try {
        const ready = await startup;
        clearTimeout(startupTimer);
        assert.equal(ready.dotenvCalls, 2);
        assert.equal(ready.databaseInitializations, 1);
        const base = `http://127.0.0.1:${ready.port}`;
        async function api(route, body) {
            const response = await fetch(base + route, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(10000)
            });
            return { status: response.status, body: await response.json() };
        }
        async function extractionJob(documentContent, extra = {}) {
            const submitted = await api('/api/extract-functions-jobs', {
                requestKey: `offline-${passed}-${Date.now()}`,
                payload: { documentContent, chapterName: '全文', userConfig, extractionMode: 'precise', ...extra }
            });
            assert.equal(submitted.status, 202);
            assert.ok(submitted.body.jobId);
            const deadline = Date.now() + 12000;
            while (Date.now() < deadline) {
                const status = await api(submitted.body.statusUrl);
                assert.equal(status.status, 200);
                const job = status.body.job;
                if (['completed', 'failed', 'canceled'].includes(job.status)) return job;
                await pause(25);
            }
            throw new Error('Extraction job failed to reach a terminal status');
        }
        async function test(name, handler, action) {
            scenario = handler;
            scenarioCalls = [];
            await action();
            assert.deepEqual(mockFailures, []);
            passed += 1;
            console.log(`PASS ${name} (${scenarioCalls.length} upstream requests)`);
        }

        const queryEvidence = '管理员按工单状态和日期查询工单列表，系统返回匹配工单。';
        const queryRecord = record('查询工单列表', queryEvidence);
        await test('short document removes over-expansion and ignores estimated quantities', body => {
            const range = sourceRequest(body);
            assert.equal(range.text, queryEvidence);
            assert.ok(body.messages[0].content.includes('禁止按字数、预估数、CRUD矩阵'));
            assert.ok(body.messages[0].content.includes('短') || body.messages[1].content.includes('短文允许只有0个或1个'));
            assert.ok(!JSON.stringify(body.messages).includes('必须导出一百项'));
            return reply(range.reviewing ? queryRecord : `${queryRecord}\n${record('按工单状态筛选', queryEvidence)}\n${record('按日期筛选工单', queryEvidence)}`);
        }, async () => {
            const job = await extractionJob(queryEvidence, {
                targetCount: 100, quantityPlan: { targetCount: 100 },
                understanding: { coreModules: [{ moduleName: '工单', estimatedFunctions: ['必须导出一百项'] }] }
            });
            assert.equal(job.status, 'completed', JSON.stringify(job.error));
            assert.equal(job.result.count, 1);
            assert.deepEqual(job.result.functions.map(item => item.functionName), ['查询工单列表']);
            assert.equal(job.result.functions[0].documentEvidence, queryEvidence);
            assert.equal(job.result.countDiagnostics.target, null);
            assert.equal(job.result.sourceDiagnostics.sourceComplete, true);
            assert.equal(scenarioCalls.length, 2);
        });

        const tailEvidence = '调度器每日归档超过三年的历史工单。';
        const tailRecord = record('归档历史工单', tailEvidence);
        const longDocument = '项目背景说明'.repeat(4200) + tailEvidence;
        const longRanges = [];
        await test('long document preserves every source character and the final requirement', body => {
            const range = sourceRequest(body);
            if (!range.reviewing) longRanges.push(range);
            return reply(range.text.includes(tailEvidence) ? tailRecord : '无可提取功能过程');
        }, async () => {
            assert.ok(longDocument.length > 16000);
            const job = await extractionJob(longDocument);
            assert.equal(job.status, 'completed', JSON.stringify(job.error));
            assert.equal(longRanges.map(range => range.text).join(''), longDocument);
            assert.ok(longRanges.length > 3);
            assert.equal(job.result.count, 1);
            assert.equal(job.result.functions[0].functionName, '归档历史工单');
            assert.equal(job.result.functions[0].sourceEnd, longDocument.length);
            assert.equal(longDocument.slice(job.result.functions[0].sourceStart), tailEvidence);
            assert.equal(job.result.sourceDiagnostics.reviewedChunks, longRanges.length);
            assert.equal(job.result.sourceDiagnostics.sourceComplete, true);
        });

        const truncatedDocument = queryEvidence + '甲'.repeat(2048 - queryEvidence.length - tailEvidence.length) + tailEvidence;
        await test('truncated parent is replaced by complete child extraction and review', body => {
            const range = sourceRequest(body);
            if (range.end - range.start === truncatedDocument.length) return reply(record('截断父片段不应保留', queryEvidence), 'length');
            return reply(range.text.includes(queryEvidence) ? queryRecord : tailRecord);
        }, async () => {
            const job = await extractionJob(truncatedDocument);
            assert.equal(job.status, 'completed', JSON.stringify(job.error));
            assert.deepEqual(job.result.functions.map(item => item.functionName), ['查询工单列表', '归档历史工单']);
            assert.equal(job.result.sourceDiagnostics.recoveredChunks, 1);
            assert.equal(job.result.sourceDiagnostics.completedChunks, 2);
            assert.equal(job.result.sourceDiagnostics.sourceComplete, true);
            assert.equal(scenarioCalls.length, 5);
        });

        const failedDocument = queryEvidence + '甲'.repeat(1600 - queryEvidence.length);
        await test('unrecoverable truncation fails the HTTP job without returning partial success', body => {
            const range = sourceRequest(body);
            return reply(queryRecord, range.end - range.start > 800 || range.start > 0 ? 'length' : 'stop');
        }, async () => {
            const job = await extractionJob(failedDocument);
            assert.equal(job.status, 'failed');
            assert.equal(job.error.code, 'TRUNCATED_FUNCTION_EXTRACTION');
            assert.equal(job.error.status, 422);
            assert.ok(job.error.message.includes('801~1600'));
            assert.equal(Object.hasOwn(job, 'result'), false);
            assert.equal(scenarioCalls.length, 4, 'the first half succeeds before the second fails');
        });

        const coverageDocument = `${queryEvidence}\n${tailEvidence}`;
        let missedFunctions;
        await test('coverage HTTP route returns a grounded omission with source offsets', body => {
            assert.ok(body.messages[1].content.includes(coverageDocument));
            return reply(JSON.stringify({ coverageScore: 50, missedFunctions: [{ functionName: '归档历史工单', documentEvidence: tailEvidence }], vagueFunctions: [], suggestions: [] }));
        }, async () => {
            const response = await api('/api/verify-coverage', { documentContent: coverageDocument, extractedFunctions: ['查询工单列表'], userConfig });
            assert.equal(response.status, 200);
            assert.equal(response.body.success, true);
            const verification = response.body.verification;
            assert.equal(verification.sourceDiagnostics.sourceComplete, true);
            missedFunctions = verification.missedFunctions;
            assert.equal(missedFunctions.length, 1);
            assert.equal(coverageDocument.slice(missedFunctions[0].sourceStart, missedFunctions[0].sourceEnd), tailEvidence);
        });

        await test('supplementary HTTP route consumes verified omissions and excludes existing functions', body => {
            sourceRequest(body);
            return reply(`${queryRecord}\n${tailRecord}`);
        }, async () => {
            const response = await api('/api/extract-supplementary', {
                documentContent: coverageDocument, existingFunctions: ['查询工单列表'], missedFunctions, userConfig
            });
            assert.equal(response.status, 200);
            assert.equal(response.body.success, true);
            assert.equal(response.body.count, 1);
            assert.deepEqual(response.body.functions.map(item => item.functionName), ['归档历史工单']);
            assert.equal(response.body.functions[0].documentEvidence, tailEvidence);
            assert.equal(response.body.sourceDiagnostics.sourceComplete, true);
            assert.equal(scenarioCalls.length, 2);
        });
        console.log(`COSMIC real HTTP integration tests passed: ${passed} scenarios, ${totalUpstreamCalls} local V3.2-compatible requests; no live model or database used.`);
    } catch (error) {
        console.error(logs);
        throw error;
    } finally {
        clearTimeout(startupTimer);
        if (child.exitCode === null && child.signalCode === null) {
            if (child.connected) child.send({ type: 'shutdown' });
            const stopped = await Promise.race([exit.then(() => true), pause(2000).then(() => false)]);
            if (!stopped) { child.kill(); await exit; }
        }
        await new Promise(resolve => {
            upstream.close(resolve);
            upstream.closeAllConnections?.();
        });
    }
}

if (process.argv.includes('--isolated-server')) await startIsolatedServer();
else await runHttpTests();
