const crypto = require('crypto');

function createHttpError(message, status = 500, code = null) {
    const error = new Error(message);
    error.status = status;
    if (code) error.code = code;
    return error;
}

function normalizeJobError(error) {
    return {
        message: String(error?.message || '后台任务执行失败'),
        status: Number.isInteger(error?.status) ? error.status : 500,
        code: error?.code ? String(error.code) : null
    };
}

function createAsyncJobManager({
    name = 'job',
    processor,
    ttlMs = 60 * 60 * 1000,
    cleanupIntervalMs = 5 * 60 * 1000,
    maxJobs = 500,
    maxConcurrent = 2,
    jobTimeoutMs = 40 * 60 * 1000,
    now = () => Date.now(),
    schedule = (callback) => setImmediate(callback)
} = {}) {
    if (typeof processor !== 'function') {
        throw new TypeError('processor must be a function');
    }

    const jobs = new Map();
    const requestKeys = new Map();
    const pending = [];
    let activeCount = 0;

    const isTerminal = (job) => (
        job.status === 'completed'
        || job.status === 'failed'
        || job.status === 'canceled'
    );
    const isExpired = (job, timestamp = now()) => (
        isTerminal(job)
        && job.finishedAt > 0
        && timestamp - job.finishedAt >= ttlMs
    );

    const removeJob = (job) => {
        jobs.delete(job.id);
        if (job.requestKey && requestKeys.get(job.requestKey) === job.id) {
            requestKeys.delete(job.requestKey);
        }
    };

    const cleanup = () => {
        const timestamp = now();
        for (const job of jobs.values()) {
            if (isExpired(job, timestamp)) removeJob(job);
        }

        if (jobs.size <= maxJobs) return;
        const removable = [...jobs.values()]
            .filter(isTerminal)
            .sort((a, b) => a.finishedAt - b.finishedAt);
        while (jobs.size > maxJobs && removable.length > 0) {
            removeJob(removable.shift());
        }
    };

    const toSnapshot = (job) => {
        if (!job) return null;
        return {
            id: job.id,
            name,
            requestKey: job.requestKey,
            status: job.status,
            progress: job.progress,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            updatedAt: job.updatedAt,
            finishedAt: job.finishedAt,
            ...(job.status === 'completed' ? { result: job.result } : {}),
            ...(['failed', 'canceled'].includes(job.status) ? { error: job.error } : {})
        };
    };

    const runJob = async (job, payload) => {
        if (!job || job.status !== 'queued') return;

        activeCount += 1;
        job.status = 'running';
        job.startedAt = now();
        job.updatedAt = job.startedAt;
        job.progress = { phase: 'running', message: '后台任务正在执行' };

        const updateProgress = (progress = {}) => {
            if (!progress || typeof progress !== 'object' || job.status !== 'running') return;
            job.progress = { ...job.progress, ...progress };
            job.updatedAt = now();
        };

        let timeoutTimer = null;
        let timeoutReject = null;
        const timeoutPromise = new Promise((resolve, reject) => {
            timeoutReject = reject;
        });
        timeoutPromise.catch(() => {});
        job.rejectTermination = timeoutReject;
        if (jobTimeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                if (job.terminationReason) return;
                const timeoutError = createHttpError(
                    `后台任务超过 ${Math.ceil(jobTimeoutMs / 60000)} 分钟，已自动终止`,
                    504,
                    'JOB_TIMEOUT'
                );
                job.terminationReason = 'timeout';
                job.timeoutTriggered = true;
                job.controller.abort(timeoutError);
                timeoutReject(timeoutError);
            }, jobTimeoutMs);
            timeoutTimer.unref?.();
        }

        try {
            const processorPromise = Promise.resolve(processor(
                payload,
                updateProgress,
                job.controller.signal
            ));
            job.result = jobTimeoutMs > 0
                ? await Promise.race([processorPromise, timeoutPromise])
                : await processorPromise;
            if (job.terminationReason === 'cancel' || job.cancelRequested) {
                const canceledError = createHttpError('后台任务已取消', 499, 'JOB_CANCELED');
                throw canceledError;
            }
            job.status = 'completed';
            job.progress = { ...job.progress, phase: 'completed', message: '任务已完成' };
        } catch (error) {
            if (job.terminationReason === 'cancel') {
                job.status = 'canceled';
                job.error = normalizeJobError(createHttpError('后台任务已取消', 499, 'JOB_CANCELED'));
                job.progress = { ...job.progress, phase: 'canceled', message: '任务已取消' };
            } else {
                job.status = 'failed';
                job.error = normalizeJobError(error);
                job.progress = { ...job.progress, phase: 'failed', message: job.error.message };
            }
        } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            job.rejectTermination = null;
            job.finishedAt = now();
            job.updatedAt = job.finishedAt;
            activeCount = Math.max(0, activeCount - 1);
            if (pending.length > 0) scheduleDrain();
        }
    };

    const drainOne = async () => {
        if (activeCount >= maxConcurrent) return;
        let entry = pending.shift();
        while (entry && entry.job.status !== 'queued') entry = pending.shift();
        if (!entry) return;
        await runJob(entry.job, entry.payload);
    };

    function scheduleDrain() {
        schedule(drainOne);
    }

    const findByRequestKey = (requestKey) => {
        if (!requestKey) return null;
        const id = requestKeys.get(requestKey);
        const job = id ? jobs.get(id) : null;
        if (job && isExpired(job)) {
            removeJob(job);
            return null;
        }
        return job || null;
    };

    const submit = (payload, { requestKey = '' } = {}) => {
        cleanup();
        const normalizedKey = String(requestKey || '').trim().slice(0, 200);
        const existing = findByRequestKey(normalizedKey);
        if (existing) {
            return { job: toSnapshot(existing), deduplicated: true };
        }

        if (jobs.size >= maxJobs && ![...jobs.values()].some(isTerminal)) {
            throw createHttpError('后台任务队列已满，请稍后重试', 503, 'JOB_QUEUE_FULL');
        }

        const timestamp = now();
        const job = {
            id: crypto.randomUUID(),
            requestKey: normalizedKey,
            status: 'queued',
            progress: { phase: 'queued', message: '任务已进入后台队列' },
            result: null,
            error: null,
            controller: new AbortController(),
            cancelRequested: false,
            timeoutTriggered: false,
            terminationReason: null,
            rejectTermination: null,
            createdAt: timestamp,
            startedAt: 0,
            updatedAt: timestamp,
            finishedAt: 0
        };
        jobs.set(job.id, job);
        if (normalizedKey) requestKeys.set(normalizedKey, job.id);
        pending.push({ job, payload });
        scheduleDrain();

        return { job: toSnapshot(job), deduplicated: false };
    };

    const get = (id) => {
        const job = jobs.get(String(id || ''));
        if (!job) return null;
        if (isExpired(job)) {
            removeJob(job);
            return null;
        }
        return toSnapshot(job);
    };

    const cleanupTimer = cleanupIntervalMs > 0
        ? setInterval(cleanup, cleanupIntervalMs)
        : null;
    cleanupTimer?.unref?.();

    return {
        submit,
        get,
        cancel(id) {
            const job = jobs.get(String(id || ''));
            if (!job || isTerminal(job)) return toSnapshot(job);
            job.cancelRequested = true;
            const canceledError = createHttpError('后台任务已取消', 499, 'JOB_CANCELED');
            if (!job.terminationReason) job.terminationReason = 'cancel';
            job.controller.abort(canceledError);
            job.rejectTermination?.(canceledError);
            if (job.status === 'queued') {
                job.status = 'canceled';
                job.error = normalizeJobError(createHttpError('后台任务已取消', 499, 'JOB_CANCELED'));
                job.progress = { phase: 'canceled', message: '任务已取消' };
                job.finishedAt = now();
            } else {
                job.progress = { ...job.progress, phase: 'canceling', message: '正在取消后台任务' };
            }
            job.updatedAt = now();
            return toSnapshot(job);
        },
        cleanup,
        getStats() {
            const stats = { queued: 0, running: 0, completed: 0, failed: 0, canceled: 0, total: jobs.size };
            for (const job of jobs.values()) {
                if (Object.prototype.hasOwnProperty.call(stats, job.status)) stats[job.status] += 1;
            }
            return stats;
        },
        get size() { return jobs.size; },
        close() {
            if (cleanupTimer) clearInterval(cleanupTimer);
            for (const job of jobs.values()) {
                if (!isTerminal(job)) {
                    job.cancelRequested = true;
                    const closedError = createHttpError('任务管理器已关闭', 503, 'JOB_MANAGER_CLOSED');
                    if (!job.terminationReason) job.terminationReason = 'cancel';
                    job.controller.abort(closedError);
                    job.rejectTermination?.(closedError);
                }
            }
        }
    };
}

module.exports = {
    createAsyncJobManager,
    createHttpError,
    normalizeJobError
};
