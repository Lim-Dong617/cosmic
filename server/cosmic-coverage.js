const { splitSourceRanges, locateEvidence } = require('./cosmic-extraction');
const { extractBalancedJsonCandidates, isTruncatedFinishReason } = require('./document-understanding');

// Coverage audits use the same bounded source ranges as extraction. Invalid
// JSON or invented evidence is an audit failure, never an empty missed list.
async function verifyGroundedCoverage({ documentContent, extractedFunctions, modelName, systemPrompt, callAIWithRetry, signal, chunkChars = 6000 }) {
    const ranges = splitSourceRanges(documentContent, chunkChars);
    const missed = new Map();
    const vague = new Map();
    const suggestions = new Set();
    const scores = [];
    for (const range of ranges) {
        if (signal?.aborted) throw signal.reason || new Error('覆盖度验证已取消');
        let verified = null;
        const messages = [
            { role: 'system', content: `${systemPrompt}\n当前只审查提供的原文片段，不以全书预估数补齐。每个missedFunctions项的documentEvidence必须逐字引用当前原文连续4~800字，不能只引用标题/实体名。已在同一业务请求中覆盖的筛选条件、统计指标和内部步骤不能另算遗漏。vagueFunctions只是命名建议，不自动增项。` },
            { role: 'user', content: `【前文，仅作上下文】\n${documentContent.slice(Math.max(0, range.start - 400), range.start)}\n【当前原文：第${range.start + 1}~${range.end}字符】\n${documentContent.slice(range.start, range.end)}\n【后文，仅作上下文】\n${documentContent.slice(range.end, range.end + 400)}\n\n【全局已提取名称，仅用于核对】\n${extractedFunctions.map((name, index) => `${index + 1}. ${name}`).join('\n')}\n只返回当前原文的审查JSON，missedFunctions和vagueFunctions无项时使用[]。` }
        ];
        for (let attempt = 0; attempt < 2 && !verified; attempt += 1) {
            const response = await callAIWithRetry({ messages, model: modelName, temperature: 0.1, max_tokens: 8000, signal }, 2);
            if (signal?.aborted) throw signal.reason || new Error('覆盖度验证已取消');
            const choice = response?.choices?.[0];
            try {
                if (isTruncatedFinishReason(choice?.finish_reason || response?.stop_reason)) throw new Error('审查输出被截断');
                const candidate = extractBalancedJsonCandidates(choice?.message?.content).map(text => {
                    try { return JSON.parse(text); } catch { return null; }
                }).find(item => item && Array.isArray(item.missedFunctions) && Array.isArray(item.vagueFunctions));
                if (!candidate || !Number.isFinite(Number(candidate.coverageScore)) || Number(candidate.coverageScore) < 0 || Number(candidate.coverageScore) > 100) throw new Error('审查JSON格式无效');
                const grounded = candidate.missedFunctions.map(func => {
                    const evidence = locateEvidence(documentContent, func.documentEvidence, range);
                    if (!func.functionName || !evidence) throw new Error('遗漏建议缺少有效原文依据');
                    return { ...func, documentEvidence: evidence.text, sourceStart: evidence.start, sourceEnd: evidence.end };
                });
                verified = { ...candidate, missedFunctions: grounded };
            } catch (error) {
                if (attempt === 1) {
                    error.status = 422;
                    error.message = `第${range.start + 1}~${range.end}字符覆盖度验证未完成：${error.message}，请重试。`;
                    throw error;
                }
                messages.push({ role: 'user', content: `上次审查未通过：${error.message}。重新审查并返回完整有效JSON；不要把无依据功能当遗漏。` });
            }
        }
        scores.push(Number(verified.coverageScore));
        for (const item of verified.missedFunctions) {
            if (!extractedFunctions.includes(item.functionName)) missed.set(`${item.functionName}\u0001${item.documentEvidence}`, item);
        }
        for (const item of verified.vagueFunctions) {
            if (item?.functionName && extractedFunctions.includes(item.functionName)) vague.set(item.functionName, item);
        }
        for (const suggestion of Array.isArray(verified.suggestions) ? verified.suggestions : []) if (typeof suggestion === 'string') suggestions.add(suggestion);
    }
    return {
        coverageScore: scores.length ? Math.min(...scores) : 0,
        scoreBasis: '各原文片段AI审查得分的最低值，仅供复核参考',
        totalDocumentFunctions: extractedFunctions.length + missed.size,
        extractedCount: extractedFunctions.length,
        missedFunctions: [...missed.values()], vagueFunctions: [...vague.values()], suggestions: [...suggestions],
        sourceDiagnostics: { sourceChars: documentContent.length, chunkCount: ranges.length, completedChunks: ranges.length, sourceComplete: true }
    };
}

module.exports = { verifyGroundedCoverage };
