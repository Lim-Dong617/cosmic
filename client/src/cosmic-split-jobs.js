const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = new Set([
    'ECONNABORTED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ERR_NETWORK',
    'ERR_BAD_RESPONSE'
]);

export const createCosmicRunId = (prefix = 'cosmic') => {
    const uuid = globalThis.crypto?.randomUUID?.();
    return `${prefix}-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
};

export const completedFunctionNames = (rows = []) => [...new Set(
    rows.map(row => row?.functionalProcess).filter(Boolean)
)];

export const resolveContinueAnalysisRound = (response = {}, legacyTableData = null) => {
    const reply = String(response?.reply || '');
    const hasServerTableData = Array.isArray(response?.tableData);
    const hasLegacyTableData = Array.isArray(legacyTableData);
    const tableData = hasServerTableData
        ? response.tableData
        : (hasLegacyTableData ? legacyTableData : []);
    const doneMarker = response?.doneMarker === true || reply.includes('[ALL_DONE]');
    const resultKind = String(response?.resultKind || '');
    const hasTable = tableData.length > 0;
    const isStatusOnlyResult = doneMarker || resultKind === 'done_marker';
    const isValid = hasTable || isStatusOnlyResult;

    return {
        tableData,
        hasTable,
        doneMarker,
        resultKind,
        hasServerTableData,
        needsLegacyParse: !hasServerTableData && !hasLegacyTableData && reply.includes('|'),
        isValid,
        shouldMerge: hasTable,
        shouldFinish: isValid && Boolean(response?.isDone),
        shouldContinue: isValid && !response?.isDone,
        coverageVerification: response?.coverageVerification || null
    };
};

export const isCanceledRequest = (error, signal = null) => (
    signal?.aborted
    || error?.name === 'AbortError'
    || error?.name === 'CanceledError'
    || error?.code === 'ERR_CANCELED'
    || error?.code === 'ABORT_ERR'
);

export const isTransientJobError = (error) => {
    const status = error?.response?.status || error?.status || null;
    if (TRANSIENT_HTTP_STATUSES.has(status)) return true;
    if (TRANSIENT_ERROR_CODES.has(error?.code)) return true;
    return !error?.response && /network|timeout|failed to fetch|bad gateway/i.test(String(error?.message || ''));
};

const waitWithAbort = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
    }
    const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
});

const makeJobError = (jobError = {}, fallback = '后台任务执行失败') => {
    const error = new Error(jobError.message || fallback);
    error.status = jobError.status || 500;
    error.code = jobError.code || null;
    error.response = {
        status: error.status,
        data: { error: error.message, code: error.code }
    };
    return error;
};

/**
 * 提交后台任务并轮询结果。
 * POST 使用稳定 requestKey，响应丢失后重复提交也只会启动一个服务端任务。
 */
export async function runBackgroundJob({
    httpClient,
    payload,
    requestKey,
    jobBasePath,
    jobLabel = '后台任务',
    signal = null,
    onStatus = null,
    maxWaitMs = 45 * 60 * 1000,
    maxJobAttempts = 2,
    maxServiceRestarts = 3,
    initialPollMs = 2500,
    maxPollMs = 6000
}) {
    if (!httpClient?.post || !httpClient?.get) {
        throw new TypeError('runBackgroundJob requires an axios-compatible httpClient');
    }
    if (!jobBasePath || !String(jobBasePath).startsWith('/api/')) {
        throw new TypeError('runBackgroundJob requires a valid jobBasePath');
    }

    const startedAt = Date.now();
    const baseRequestKey = String(requestKey || createCosmicRunId('batch')).slice(0, 160);
    let jobAttempt = 0;
    let serviceRestarts = 0;

    const ensureWithinDeadline = () => {
        if (Date.now() - startedAt > maxWaitMs) {
            const error = new Error(`${jobLabel}等待超过 ${Math.round(maxWaitMs / 60000)} 分钟，任务已停止等待，可稍后重试`);
            error.code = 'JOB_WAIT_TIMEOUT';
            error.status = 504;
            error.response = { status: 504, data: { error: error.message, code: error.code } };
            throw error;
        }
    };

    const submit = async (attemptKey) => {
        let lastError = null;
        for (let submitAttempt = 0; submitAttempt < 3; submitAttempt++) {
            ensureWithinDeadline();
            try {
                const response = await httpClient.post(jobBasePath, {
                    requestKey: attemptKey,
                    payload
                }, {
                    signal,
                    timeout: 30000
                });
                if (!response.data?.jobId) throw new Error(`服务端未返回${jobLabel}任务ID`);
                return response.data.jobId;
            } catch (error) {
                if (isCanceledRequest(error, signal)) throw error;
                lastError = error;
                if (!isTransientJobError(error) || submitAttempt >= 2) throw error;
                onStatus?.({ status: 'reconnecting', message: '任务提交响应中断，正在安全重试（不会重复拆分）' });
                await waitWithAbort(1000 * Math.pow(2, submitAttempt), signal);
            }
        }
        throw lastError;
    };

    let activeJobId = null;
    try {
        while (jobAttempt < maxJobAttempts) {
            const attemptKey = jobAttempt === 0
                ? baseRequestKey
                : `${baseRequestKey}:attempt-${jobAttempt + 1}`;
            let jobId = await submit(attemptKey);
            activeJobId = jobId;
            let pollMs = initialPollMs;

            while (true) {
                ensureWithinDeadline();
                let response;
                try {
                    response = await httpClient.get(`${jobBasePath}/${encodeURIComponent(jobId)}`, {
                        signal,
                        timeout: 30000
                    });
                } catch (error) {
                    if (isCanceledRequest(error, signal)) throw error;
                    const notFound = error?.response?.status === 404
                        && error?.response?.data?.code === 'JOB_NOT_FOUND';
                    if (notFound && serviceRestarts < maxServiceRestarts) {
                        serviceRestarts += 1;
                        onStatus?.({ status: 'restarting', message: '服务已重启，正在自动恢复当前任务' });
                        jobId = await submit(attemptKey);
                        activeJobId = jobId;
                        pollMs = initialPollMs;
                        continue;
                    }
                    if (!isTransientJobError(error)) throw error;
                    onStatus?.({ status: 'reconnecting', message: '状态查询暂时中断，后台任务仍在继续' });
                    await waitWithAbort(pollMs, signal);
                    pollMs = Math.min(maxPollMs, Math.ceil(pollMs * 1.35));
                    continue;
                }

                const job = response.data?.job;
                if (!job?.status) throw new Error(`服务端返回了无效的${jobLabel}任务状态`);
                onStatus?.(job);
                if (job.status === 'completed') {
                    activeJobId = null;
                    return job.result;
                }
                if (job.status === 'failed' || job.status === 'canceled') {
                    const error = makeJobError(job.error, `${jobLabel}失败`);
                    if (job.status === 'failed' && jobAttempt + 1 < maxJobAttempts && isTransientJobError(error)) {
                        jobAttempt += 1;
                        activeJobId = null;
                        onStatus?.({ status: 'retrying', message: `${jobLabel}失败，正在自动重试一次` });
                        await waitWithAbort(2000 * jobAttempt, signal);
                        break;
                    }
                    throw error;
                }

                await waitWithAbort(pollMs, signal);
                pollMs = Math.min(maxPollMs, Math.ceil(pollMs * 1.15));
            }
        }
    } catch (error) {
        if (
            (isCanceledRequest(error, signal) || error?.code === 'JOB_WAIT_TIMEOUT')
            && activeJobId
            && typeof httpClient.delete === 'function'
        ) {
            try {
                await httpClient.delete(`${jobBasePath}/${encodeURIComponent(activeJobId)}`, { timeout: 10000 });
            } catch (_) {
                // 最佳努力取消；即使取消请求失败，本地轮询也必须立即停止。
            }
        }
        throw error;
    }

    throw new Error(`${jobLabel}未能完成`);
}

export const runCosmicSplitJob = options => runBackgroundJob({
    ...options,
    jobBasePath: '/api/cosmic-split-jobs',
    jobLabel: 'COSMIC后台拆分'
});

export const runDocumentUnderstandingJob = options => runBackgroundJob({
    ...options,
    jobBasePath: '/api/understand-document-jobs',
    jobLabel: '文档理解'
});

export const runContinueAnalysisJob = options => runBackgroundJob({
    ...options,
    jobBasePath: '/api/continue-analyze-jobs',
    jobLabel: '一键拆分'
});

export const runFunctionExtractionJob = options => runBackgroundJob({
    ...options,
    jobBasePath: '/api/extract-functions-jobs',
    jobLabel: '功能过程提取'
});

export const runCosmicModuleRecognitionJob = options => runBackgroundJob({
    ...options,
    jobBasePath: '/api/cosmic/recognize-modules-jobs',
    jobLabel: '模块识别'
});
