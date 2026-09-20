import { createCosmicRunId, isCanceledRequest, isTransientJobError, runBackgroundJob } from './cosmic-split-jobs.js';

export async function exportWordFile({ httpClient, payload, onStatus, signal }) {
    // Multipart uploads go straight to disk on the server, avoiding an in-memory
    // JSON body containing every base64 diagram in the main web process.
    const upload = new FormData();
    upload.append('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'word-export.json');
    const client = {
        post: (url, { requestKey }, config) => httpClient.post(`${url}?requestKey=${encodeURIComponent(requestKey)}`, upload, {
            ...config,
            timeout: 300000,
            onUploadProgress: event => {
                if (event.total) onStatus?.(`上传 Word 导出数据 ${Math.round(event.loaded / event.total * 100)}%`);
            }
        }),
        get: (...args) => httpClient.get(...args),
        delete: (...args) => httpClient.delete(...args)
    };
    const result = await runBackgroundJob({
        httpClient: client,
        requestKey: createCosmicRunId('word-export'),
        jobBasePath: '/api/export-word-jobs',
        jobLabel: 'Word 导出',
        signal,
        maxJobAttempts: 1,
        maxServiceRestarts: 1,
        initialPollMs: 1500,
        maxPollMs: 4000,
        onStatus: job => onStatus?.(job.progress?.message || job.message || '正在生成 Word…')
    });
    if (!/^\/api\/export-word-jobs\/[\da-f-]+\/download$/.test(result?.downloadUrl || '')) {
        throw new Error('服务端未返回有效的 Word 下载地址');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        onStatus?.(attempt ? '下载连接中断，正在重试…' : 'Word 已生成，正在下载…');
        try {
            const response = await httpClient.get(result.downloadUrl, { responseType: 'blob', timeout: 300000, signal });
            return response.data;
        } catch (error) {
            if (isCanceledRequest(error, signal) || !isTransientJobError(error) || attempt === 2) throw error;
        }
    }
}

export async function wordExportErrorMessage(error) {
    let data = error.response?.data;
    if (typeof data?.text === 'function') {
        try { data = JSON.parse(await data.text()); } catch { data = null; }
    }
    if (data?.error) return data.error;
    if ([502, 503, 504].includes(error.response?.status)) return '服务器暂时无法完成导出，请稍后重试；大文档可先取消附带时序图';
    if (error.response?.status === 404) return '导出文件已过期或服务已重启，请重新导出';
    return error.message || '未知导出错误';
}
