const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const multer = require('multer');
const { createAsyncJobManager, createHttpError, normalizeJobError } = require('./async-job-manager');

const BASE_PATH = '/api/export-word-jobs';
const MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const positiveInt = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const normalizeRequestKey = value => String(value || '').trim().slice(0, 200);
const removeFile = file => fs.promises.rm(file, { force: true }).catch(error => {
    console.warn('Word 导出临时文件清理失败:', error.message);
});

function createWordExportService({
    uploadRoot,
    ttlMs = 15 * 60 * 1000,
    jobTimeoutMs = 20 * 60 * 1000,
    cleanupIntervalMs = 60 * 1000,
    workerHeapMb = positiveInt(process.env.WORD_EXPORT_WORKER_HEAP_MB, 192),
    maxPending = 3
} = {}) {
    const directory = path.resolve(uploadRoot, 'word-exports');
    fs.mkdirSync(directory, { recursive: true });
    const files = new Map();
    const requestKeys = new Map();
    const workers = new Set();
    let workerTail = Promise.resolve();
    let closed = false;
    const filePath = extension => path.join(directory, `${crypto.randomUUID()}${extension}`);

    const runWorker = (inputPath, outputPath, onProgress, signal) => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const worker = fork(path.join(__dirname, 'word-export-worker.js'), [], {
            // A separate process releases the allocator's retained memory after
            // every export and keeps a V8 heap failure out of the web process.
            execArgv: [`--max-old-space-size=${workerHeapMb}`, '--max-semi-space-size=8'],
            env: Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'TZ']
                .filter(key => process.env[key]).map(key => [key, process.env[key]])),
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            windowsHide: true
        });
        workers.add(worker);
        let result;
        let failure;
        let stderr = '';
        worker.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
        const abort = () => { failure = signal.reason; worker.kill(); };
        signal.addEventListener('abort', abort, { once: true });
        worker.on('message', message => {
            if (message.type === 'progress') onProgress({ message: message.message });
            if (message.type === 'completed') result = message;
            if (message.type === 'failed') failure = createHttpError(message.error.message, message.error.status, message.error.code);
        });
        worker.on('error', error => { failure = error; });
        worker.once('close', code => {
            workers.delete(worker);
            signal.removeEventListener('abort', abort);
            if (failure) return reject(failure);
            if (/heap out of memory|allocation failed/i.test(stderr)) {
                return reject(createHttpError('Word 导出内存不足，请取消附带时序图后重试，或提高服务器内存配置', 507, 'WORD_EXPORT_MEMORY_LIMIT'));
            }
            if (!result || code !== 0) return reject(createHttpError('Word 生成进程意外退出，请重试', 500, 'WORD_EXPORT_WORKER_EXIT'));
            console.log(`Word 导出完成: ${result.size} bytes, 生成进程峰值 RSS ${result.peakRssMb}MB, 主进程 RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
            resolve({ filename: result.filename, size: result.size });
        });
        worker.send({ inputPath, outputPath });
    });

    const manager = createAsyncJobManager({
        name: 'word-export', ttlMs, jobTimeoutMs, maxConcurrent: 1, maxJobs: 30, cleanupIntervalMs: 0,
        processor: async ({ inputPath, outputPath }, onProgress, signal) => {
            const previous = workerTail;
            let release;
            workerTail = new Promise(resolve => { release = resolve; });
            await previous;
            try {
                signal.throwIfAborted();
                onProgress({ phase: 'generating', message: '正在生成 Word 文档…' });
                return await runWorker(inputPath, outputPath, onProgress, signal);
            } catch (error) {
                await removeFile(outputPath);
                throw error;
            } finally {
                await removeFile(inputPath);
                release();
            }
        }
    });

    const get = id => manager.get(id);
    const findRequest = key => key ? get(requestKeys.get(normalizeRequestKey(key))) : null;
    const assertCapacity = () => {
        const { running, queued } = manager.getStats();
        if (closed) throw createHttpError('Word 导出服务已关闭', 503, 'WORD_EXPORT_CLOSED');
        if (running + queued >= maxPending) throw createHttpError('Word 导出队列已满，请稍后重试', 429, 'WORD_EXPORT_QUEUE_FULL');
    };
    const submitFile = (inputPath, requestKey = '') => {
        requestKey = normalizeRequestKey(requestKey);
        const existing = findRequest(requestKey);
        if (existing) {
            void removeFile(inputPath);
            return existing;
        }
        assertCapacity();
        const outputPath = filePath('.docx');
        const { job, deduplicated } = manager.submit({ inputPath, outputPath }, { requestKey });
        if (deduplicated) { void removeFile(inputPath); return job; }
        files.set(job.id, { inputPath, outputPath });
        if (requestKey) requestKeys.set(requestKey, job.id);
        return job;
    };
    const cleanup = async () => {
        manager.cleanup();
        for (const [id, paths] of files) {
            if (!get(id)) {
                files.delete(id);
                await Promise.all([removeFile(paths.inputPath), removeFile(paths.outputPath)]);
            }
        }
        for (const [key, id] of requestKeys) if (!get(id)) requestKeys.delete(key);
        // Remove files left by a process restart, never a currently tracked job.
        const activeFiles = new Set([...files.values()].flatMap(item => [item.inputPath, item.outputPath]));
        const oldest = Date.now() - ttlMs - jobTimeoutMs;
        for (const name of await fs.promises.readdir(directory)) {
            if (!/^[\da-f-]{36}\.(json|docx)$/.test(name)) continue;
            const candidate = path.join(directory, name);
            if (activeFiles.has(candidate)) continue;
            const stat = await fs.promises.stat(candidate).catch(() => null);
            if (stat && stat.mtimeMs < oldest) await removeFile(candidate);
        }
    };
    const cleanupTimer = setInterval(() => void cleanup().catch(console.error), cleanupIntervalMs);
    cleanupTimer.unref();
    return {
        directory, filePath, get, findRequest, assertCapacity, submitFile, cleanup,
        getStats: () => manager.getStats(),
        outputPath: id => files.get(id)?.outputPath,
        cancel: id => manager.cancel(id),
        async close() {
            closed = true;
            clearInterval(cleanupTimer);
            manager.close();
            await Promise.all([...workers].map(worker => new Promise(resolve => {
                worker.once('close', resolve);
                worker.kill();
            })));
            await Promise.all([...files.values()].flatMap(item => [removeFile(item.inputPath), removeFile(item.outputPath)]));
        }
    };
}

function registerWordExportRoutes(app, options) {
    const service = createWordExportService(options);
    const maxUploadMb = positiveInt(process.env.WORD_EXPORT_MAX_UPLOAD_MB, 64);
    const upload = multer({
        storage: multer.diskStorage({
            destination: service.directory,
            filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.json`)
        }),
        limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1, fields: 0 }
    }).single('payload');
    const sendError = (res, error) => {
        if (!res.headersSent && !res.destroyed) res.status(error.status || 500).json({ error: error.message, code: error.code });
    };
    const accepted = (res, job) => res.status(202).json({ jobId: job.id, statusUrl: `${BASE_PATH}/${job.id}` });

    app.post(BASE_PATH, (req, res) => {
        const requestKey = normalizeRequestKey(req.query.requestKey);
        try {
            const existing = service.findRequest(requestKey);
            if (existing) { req.resume(); return accepted(res, existing); }
            service.assertCapacity();
        } catch (error) { req.resume(); return sendError(res, error); }
        upload(req, res, error => {
            if (error) return sendError(res, createHttpError(
                error.code === 'LIMIT_FILE_SIZE' ? `Word 导出数据超过 ${maxUploadMb}MB，请减少时序图或分批导出` : 'Word 导出数据上传失败',
                error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, error.code
            ));
            if (!req.file) return sendError(res, createHttpError('缺少 Word 导出数据', 400, 'WORD_EXPORT_EMPTY'));
            try { accepted(res, service.submitFile(req.file.path, requestKey)); }
            catch (error) { void removeFile(req.file.path); sendError(res, error); }
        });
    });
    app.get(`${BASE_PATH}/:jobId`, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const job = service.get(req.params.jobId);
        if (!job) return sendError(res, createHttpError('导出任务已过期或服务已重启，请重新导出', 404, 'JOB_NOT_FOUND'));
        if (job.status === 'completed') job.result = { ...job.result, downloadUrl: `${BASE_PATH}/${job.id}/download` };
        res.json({ job });
    });
    app.get(`${BASE_PATH}/:jobId/download`, (req, res) => {
        const job = service.get(req.params.jobId);
        if (!job) return sendError(res, createHttpError('导出文件已过期，请重新导出', 404, 'JOB_NOT_FOUND'));
        if (job.status !== 'completed') return sendError(res, createHttpError('Word 尚未生成完成', 409, 'WORD_EXPORT_NOT_READY'));
        res.setHeader('Cache-Control', 'no-store');
        res.type(MIME_TYPE);
        res.download(service.outputPath(job.id), job.result.filename, error => {
            if (error) sendError(res, createHttpError('Word 文件下载中断或文件已过期，请重试', error.status || 500, 'WORD_EXPORT_DOWNLOAD_FAILED'));
        });
    });
    app.delete(`${BASE_PATH}/:jobId`, (req, res) => {
        const job = service.cancel(req.params.jobId);
        if (!job) return sendError(res, createHttpError('导出任务不存在', 404, 'JOB_NOT_FOUND'));
        res.json({ job });
    });

    // Keep the old endpoint usable for clients loaded before deployment. It shares
    // the same bounded queue and isolated generator as the new polling endpoint.
    app.post('/api/export-word', async (req, res) => {
        let inputPath;
        let job;
        try {
            service.assertCapacity();
            inputPath = service.filePath('.json');
            await fs.promises.writeFile(inputPath, JSON.stringify(req.body || {}));
            job = service.submitFile(inputPath);
            while (!res.destroyed) {
                const current = service.get(job.id);
                if (current?.status === 'completed') {
                    res.type(MIME_TYPE);
                    return res.download(service.outputPath(job.id), current.result.filename, error => {
                        if (error) sendError(res, error);
                    });
                }
                if (current?.error) throw createHttpError(current.error.message, current.error.status, current.error.code);
                if (!current) throw createHttpError('导出任务已过期，请重试', 404, 'JOB_NOT_FOUND');
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            service.cancel(job.id);
        } catch (error) {
            if (inputPath && !job) await removeFile(inputPath);
            sendError(res, normalizeJobError(error));
        }
    });
    return service;
}

module.exports = { createWordExportService, registerWordExportRoutes };
