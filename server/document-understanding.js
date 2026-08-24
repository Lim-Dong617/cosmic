const DEFAULT_ARRAY_FIELDS = [
    'userRoles',
    'businessEntities',
    'kpiAndMetrics',
    'dataFlows',
    'aggregationAndReports',
    'externalInterfaces',
    'businessRules',
    'coreModules'
];

const BREAKDOWN_FIELDS = [
    'crudFunctions',
    'aggregationFunctions',
    'reportFunctions',
    'workflowFunctions',
    'interfaceFunctions',
    'timerFunctions',
    'alertFunctions',
    'otherFunctions'
];

const DEFAULT_TOTAL_BUDGET_MS = 18 * 60 * 1000;
const DEFAULT_PRIMARY_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONTINUATION_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_COMPACT_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;

function createUnderstandingError(message, code = 'INVALID_DOCUMENT_UNDERSTANDING', status = 422) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function isTruncatedFinishReason(value) {
    return /^(?:length|max_tokens|max_output_tokens|token_limit)$/i.test(String(value || '').trim());
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function toObjectArray(value) {
    if (Array.isArray(value)) return value.filter(isPlainObject);
    return isPlainObject(value) ? [value] : [];
}

function toStringArray(value) {
    if (Array.isArray(value)) {
        return value.map(item => toText(item)).filter(Boolean);
    }
    const text = toText(value);
    return text ? [text] : [];
}

function toNonNegativeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function extractBalancedJsonCandidates(text) {
    const source = String(text || '');
    const candidates = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (start < 0) {
            if (char === '{') {
                start = index;
                depth = 1;
                inString = false;
                escaped = false;
            }
            continue;
        }

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                candidates.push(source.slice(start, index + 1));
                start = -1;
            }
        }
    }

    return candidates;
}

function normalizeDocumentUnderstanding(value) {
    if (!isPlainObject(value)) {
        throw createUnderstandingError('文档理解结果不是JSON对象');
    }
    if (!toText(value.projectName)) {
        throw createUnderstandingError('文档理解结果缺少projectName');
    }
    if (!Array.isArray(value.coreModules)) {
        throw createUnderstandingError('文档理解结果缺少coreModules数组');
    }
    const rawTotal = Number(value.totalEstimatedFunctions);
    if (!Number.isFinite(rawTotal) || rawTotal < 0) {
        throw createUnderstandingError('文档理解结果缺少有效的totalEstimatedFunctions');
    }

    const normalized = {
        projectName: toText(value.projectName),
        projectDescription: toText(value.projectDescription),
        businessDomain: toText(value.businessDomain),
        systemBoundary: toText(value.systemBoundary)
    };
    for (const field of DEFAULT_ARRAY_FIELDS) normalized[field] = [];

    normalized.userRoles = toObjectArray(value.userRoles).map(item => ({
        roleName: toText(item.roleName),
        roleDescription: toText(item.roleDescription)
    })).filter(item => item.roleName);

    normalized.businessEntities = toObjectArray(value.businessEntities).map(item => ({
        entityName: toText(item.entityName),
        entityDescription: toText(item.entityDescription),
        keyAttributes: toStringArray(item.keyAttributes),
        hasLifecycle: Boolean(item.hasLifecycle),
        lifecycleStates: toStringArray(item.lifecycleStates),
        relatedEntities: toStringArray(item.relatedEntities),
        crudOperations: toStringArray(item.crudOperations)
    })).filter(item => item.entityName);

    normalized.kpiAndMetrics = toObjectArray(value.kpiAndMetrics).map(item => ({
        metricName: toText(item.metricName),
        metricDescription: toText(item.metricDescription),
        relatedEntity: toText(item.relatedEntity),
        hasThreshold: Boolean(item.hasThreshold),
        thresholdDescription: toText(item.thresholdDescription)
    })).filter(item => item.metricName);

    normalized.dataFlows = toObjectArray(value.dataFlows).map(item => ({
        flowName: toText(item.flowName),
        source: toText(item.source),
        destination: toText(item.destination),
        frequency: toText(item.frequency),
        dataDescription: toText(item.dataDescription)
    })).filter(item => item.flowName);

    normalized.aggregationAndReports = toObjectArray(value.aggregationAndReports).map(item => ({
        name: toText(item.name),
        type: toText(item.type),
        dimensions: toStringArray(item.dimensions),
        metrics: toStringArray(item.metrics),
        triggerType: toText(item.triggerType),
        outputForm: toText(item.outputForm)
    })).filter(item => item.name);

    normalized.externalInterfaces = toObjectArray(value.externalInterfaces).map(item => ({
        interfaceName: toText(item.interfaceName),
        direction: toText(item.direction),
        externalSystem: toText(item.externalSystem),
        dataDescription: toText(item.dataDescription)
    })).filter(item => item.interfaceName);

    normalized.businessRules = toObjectArray(value.businessRules).map(item => ({
        ruleName: toText(item.ruleName),
        ruleDescription: toText(item.ruleDescription),
        triggerCondition: toText(item.triggerCondition),
        resultAction: toText(item.resultAction)
    })).filter(item => item.ruleName);

    normalized.coreModules = value.coreModules.filter(isPlainObject).map(item => ({
        moduleName: toText(item.moduleName),
        moduleDescription: toText(item.moduleDescription),
        estimatedFunctions: (Array.isArray(item.estimatedFunctions) ? item.estimatedFunctions : [])
            .map(func => typeof func === 'string'
                ? { functionName: toText(func), triggerType: '', businessEntity: '', scenario: '' }
                : {
                    functionName: toText(func?.functionName),
                    triggerType: toText(func?.triggerType),
                    businessEntity: toText(func?.businessEntity),
                    scenario: toText(func?.scenario)
                })
            .filter(func => func.functionName)
    })).filter(item => item.moduleName);

    const listedFunctionNames = new Set(
        normalized.coreModules.flatMap(module => module.estimatedFunctions.map(func => func.functionName))
    );
    normalized.functionBreakdown = {};
    const rawBreakdown = isPlainObject(value.functionBreakdown) ? value.functionBreakdown : {};
    for (const field of BREAKDOWN_FIELDS) {
        normalized.functionBreakdown[field] = toNonNegativeInteger(rawBreakdown[field]);
    }
    normalized.totalEstimatedFunctions = Math.max(
        toNonNegativeInteger(rawTotal),
        listedFunctionNames.size
    );

    return normalized;
}

function parseDocumentUnderstandingResponse(text) {
    const candidates = extractBalancedJsonCandidates(text);
    let lastError = null;
    for (const candidate of candidates) {
        try {
            return normalizeDocumentUnderstanding(JSON.parse(candidate));
        } catch (error) {
            lastError = error;
        }
    }
    throw createUnderstandingError(
        `文档理解JSON不完整或格式无效${lastError?.message ? `：${lastError.message}` : ''}`
    );
}

function getCompletionResult(completion) {
    const choice = completion?.choices?.[0];
    return {
        content: String(choice?.message?.content || ''),
        finishReason: choice?.finish_reason || completion?.stop_reason || ''
    };
}

function tryParseUnderstanding(content) {
    try {
        return { understanding: parseDocumentUnderstandingResponse(content), error: null };
    } catch (error) {
        return { understanding: null, error };
    }
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = signal.reason instanceof Error ? signal.reason : new Error('后台任务已取消');
    if (!error.name || error.name === 'Error') error.name = 'AbortError';
    throw error;
}

function toPositiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function createUnderstandingBudget(externalSignal, totalBudgetMs) {
    throwIfAborted(externalSignal);
    const durationMs = toPositiveInteger(totalBudgetMs, DEFAULT_TOTAL_BUDGET_MS);
    const controller = new AbortController();
    let expired = false;
    const timeoutError = createUnderstandingError(
        `文档理解自动恢复超过${Math.ceil(durationMs / 60000)}分钟总时间预算`,
        'DOCUMENT_UNDERSTANDING_TIMEOUT',
        422
    );
    timeoutError.name = 'TimeoutError';

    const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
    const timer = setTimeout(() => {
        expired = true;
        controller.abort(timeoutError);
    }, durationMs);

    return {
        signal: controller.signal,
        expired: () => expired,
        timeoutError,
        cleanup: () => {
            clearTimeout(timer);
            externalSignal?.removeEventListener('abort', abortFromExternalSignal);
        }
    };
}

async function generateDocumentUnderstanding(options = {}) {
    if (typeof options.callAIWithRetry !== 'function') {
        throw new TypeError('generateDocumentUnderstanding requires callAIWithRetry');
    }
    const budget = createUnderstandingBudget(options.signal || null, options.totalBudgetMs);
    try {
        return await generateDocumentUnderstandingWithinBudget({
            ...options,
            signal: budget.signal
        });
    } catch (error) {
        if (budget.expired()) {
            if (error !== budget.timeoutError) budget.timeoutError.cause = error;
            throw budget.timeoutError;
        }
        throw error;
    } finally {
        budget.cleanup();
    }
}

async function generateDocumentUnderstandingWithinBudget({
    callAIWithRetry,
    modelName,
    documentContent,
    fullPrompt,
    compactPrompt,
    signal = null,
    onProgress = () => {},
    maxTokens = 16000,
    continuationMaxTokens = 12000,
    compactMaxTokens = 16000,
    primaryRequestTimeoutMs = DEFAULT_PRIMARY_REQUEST_TIMEOUT_MS,
    continuationRequestTimeoutMs = DEFAULT_CONTINUATION_REQUEST_TIMEOUT_MS,
    compactRequestTimeoutMs = DEFAULT_COMPACT_REQUEST_TIMEOUT_MS
} = {}) {
    const baseMessages = [
        { role: 'system', content: fullPrompt },
        { role: 'user', content: `请分析以下需求文档：\n\n${documentContent}` }
    ];
    let generationAttempts = 1;
    let wasTruncated = false;

    throwIfAborted(signal);
    const primaryCompletion = await callAIWithRetry({
        messages: baseMessages,
        model: modelName,
        temperature: 0.1,
        max_tokens: maxTokens,
        requestTimeoutMs: toPositiveInteger(primaryRequestTimeoutMs, DEFAULT_PRIMARY_REQUEST_TIMEOUT_MS),
        signal
    }, 2);
    const primary = getCompletionResult(primaryCompletion);
    wasTruncated = isTruncatedFinishReason(primary.finishReason);
    let parsed = tryParseUnderstanding(primary.content);
    if (parsed.understanding && !wasTruncated) {
        return {
            understanding: parsed.understanding,
            validated: true,
            recoveryMode: 'none',
            generationAttempts,
            recoveredFromTruncation: false
        };
    }

    if (wasTruncated && primary.content.includes('{')) {
        throwIfAborted(signal);
        onProgress({ phase: 'continuing', message: '文档理解输出达到长度上限，正在自动续写' });
        generationAttempts += 1;
        const continuationCompletion = await callAIWithRetry({
            messages: [
                ...baseMessages,
                { role: 'assistant', content: primary.content },
                {
                    role: 'user',
                    content: '上一个JSON因长度上限中断。请从中断位置后的第一个字符继续，只输出缺失的JSON后缀并闭合所有结构；不要重复开头，不要使用Markdown代码围栏，不要添加说明。'
                }
            ],
            model: modelName,
            temperature: 0.1,
            max_tokens: continuationMaxTokens,
            requestTimeoutMs: toPositiveInteger(
                continuationRequestTimeoutMs,
                DEFAULT_CONTINUATION_REQUEST_TIMEOUT_MS
            ),
            signal
        }, 1);
        const continuation = getCompletionResult(continuationCompletion);
        const continuationWasTruncated = isTruncatedFinishReason(continuation.finishReason);
        wasTruncated = wasTruncated || continuationWasTruncated;
        parsed = tryParseUnderstanding(primary.content + continuation.content);
        if (parsed.understanding && !continuationWasTruncated) {
            return {
                understanding: parsed.understanding,
                validated: true,
                recoveryMode: 'continued',
                generationAttempts,
                recoveredFromTruncation: true
            };
        }
    }

    throwIfAborted(signal);
    onProgress({ phase: 'retrying', message: '文档理解结果不完整，正在使用紧凑结构重新生成' });
    generationAttempts += 1;
    const compactCompletion = await callAIWithRetry({
        messages: [
            { role: 'system', content: compactPrompt },
            { role: 'user', content: `请从头分析以下需求文档并输出完整JSON：\n\n${documentContent}` }
        ],
        model: modelName,
        temperature: 0.1,
        max_tokens: compactMaxTokens,
        requestTimeoutMs: toPositiveInteger(compactRequestTimeoutMs, DEFAULT_COMPACT_REQUEST_TIMEOUT_MS),
        signal
    }, 1);
    const compact = getCompletionResult(compactCompletion);
    const compactWasTruncated = isTruncatedFinishReason(compact.finishReason);
    parsed = tryParseUnderstanding(compact.content);
    if (parsed.understanding && !compactWasTruncated) {
        return {
            understanding: parsed.understanding,
            validated: true,
            recoveryMode: 'compact-retry',
            generationAttempts,
            recoveredFromTruncation: wasTruncated || compactWasTruncated
        };
    }

    const error = createUnderstandingError(
        compactWasTruncated || wasTruncated
            ? '文档理解输出多次达到长度上限，自动恢复后仍未生成完整JSON'
            : '文档理解输出格式异常，自动重试后仍未生成有效JSON'
    );
    error.cause = parsed.error;
    throw error;
}

module.exports = {
    extractBalancedJsonCandidates,
    generateDocumentUnderstanding,
    isTruncatedFinishReason,
    normalizeDocumentUnderstanding,
    parseDocumentUnderstandingResponse
};
