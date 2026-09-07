const { isTruncatedFinishReason } = require('./document-understanding');
const { canonicalFunctionNameKey } = require('./cosmic-quality');

const EMPTY_RESULT = '无可提取功能过程';
const SOURCE_RULES = `
【原文约束，优先于示例和模块预估】
只提取当前原文明确支持的独立业务过程；上下文仅用于理解跨段语义。
禁止按字数、预估数、CRUD矩阵、指标×维度组合凑数。字段、筛选条件、内部计算步骤不自动成为独立过程。
原文明确要求的独立新增、修改、删除、查询、定时任务或接口不可仅因同一页面或对象而合并。
每项输出五行：##触发事件：、##功能用户：、##功能过程：、##功能过程描述：、##原文依据：。
原文依据必须逐字引用当前原文中一段连续的实际需求（4~800字，不能只引用标题或通用名词），不得改写、加省略号或用推测作依据。
每段依据须与当前处理范围相交。跨段重复需求只提取一次，不得通过同义改名重复输出。
功能名须包含具体业务对象及独立业务结果，名称相同时用真实业务限定词区分。
没有实际功能需求时只输出“${EMPTY_RESULT}”。只输出完整五行记录或这句固定文本。`;

function extractionError(message, code = 'INCOMPLETE_FUNCTION_EXTRACTION') {
    const error = new Error(message);
    error.status = 422;
    error.code = code;
    return error;
}

function checkAbort(signal) {
    if (!signal?.aborted) return;
    const error = signal.reason instanceof Error ? signal.reason : new Error('功能提取已取消');
    if (error.name === 'Error') error.name = 'AbortError';
    throw error;
}

// Ranges are contiguous and retain every source character, including long
// paragraphs and tables without blank lines. Context is added separately.
function splitSourceRanges(text, maxChars = 6000, offset = 0) {
    const size = Math.max(64, Math.floor(Number(maxChars) || 6000));
    const ranges = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(text.length, start + size);
        if (end < text.length) {
            const window = text.slice(start, end);
            const boundary = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('；'));
            if (boundary >= size / 2) end = start + boundary + 1;
            // Do not cut between a UTF-16 surrogate pair.
            if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
        }
        ranges.push({ start: offset + start, end: offset + end });
        start = end;
    }
    return ranges;
}

function parseGroundedFunctionList(content) {
    const clean = String(content || '').trim().replace(/^```[^\n]*\n|\n```$/g, '').trim();
    if (clean === EMPTY_RESULT) return [];
    const fields = { '触发事件': 'triggerEvent', '功能用户': 'functionalUser', '功能过程': 'functionName', '功能过程描述': 'description', '原文依据': 'documentEvidence' };
    const functions = [];
    let current = null;
    let malformed = false;
    for (const line of clean.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const match = line.trim().match(/^##\s*(触发事件|功能用户|功能过程|功能过程描述|原文依据)[：:]\s*(.*)$/);
        if (!match) { malformed = true; continue; }
        if (match[1] === '触发事件') {
            if (current) functions.push(current);
            current = { selected: true };
        }
        const field = fields[match[1]];
        if (!current || current[field] !== undefined) { malformed = true; continue; }
        current[field] = match[2].trim();
    }
    if (current) functions.push(current);
    if (malformed || !functions.length || functions.some(func => Object.values(fields).some(field => !func[field]))) {
        throw extractionError('功能列表格式不完整，必须返回五行记录并包含原文依据', 'INVALID_EXTRACTION_FORMAT');
    }
    return functions;
}

// Ignore layout whitespace from Word/table extraction while retaining exact
// source offsets; punctuation and words must still match the document.
function locateEvidence(source, evidence, range, contextChars = 400) {
    const quote = String(evidence || '').trim().replace(/^[“"「『]|[”"」』]$/g, '');
    const needle = quote.replace(/\s/g, '');
    if (needle.length < 4 || needle.length > 800) return null;
    const from = Math.max(0, range.start - contextChars);
    const to = Math.min(source.length, range.end + contextChars);
    const positions = [];
    const chars = [];
    for (let index = from; index < to; index += 1) {
        if (!/\s/.test(source[index])) { chars.push(source[index]); positions.push(index); }
    }
    const normalized = chars.join('');
    let matchAt = normalized.indexOf(needle);
    while (matchAt >= 0) {
        const start = positions[matchAt];
        const end = positions[matchAt + needle.length - 1] + 1;
        if (start < range.end && end > range.start) return { start, end, text: source.slice(start, end) };
        matchAt = normalized.indexOf(needle, matchAt + 1);
    }
    return null;
}

function groundFunctions(functions, source, range, chapterName) {
    return functions.map(func => {
        const evidence = locateEvidence(source, func.documentEvidence, range);
        if (!evidence) throw extractionError(`功能“${func.functionName}”缺少可在当前原文核对的依据`, 'UNSUPPORTED_FUNCTION_EVIDENCE');
        return { ...func, documentEvidence: evidence.text, sourceStart: evidence.start, sourceEnd: evidence.end, sourceChapter: chapterName };
    });
}

function functionListText(functions, includeEvidence = false) {
    return functions.map(func => `##触发事件：${func.triggerEvent}\n##功能用户：${func.functionalUser}\n##功能过程：${func.functionName}\n##功能过程描述：${func.description}${includeEvidence ? `\n##原文依据：${func.documentEvidence.replace(/\s*\r?\n\s*/g, ' ')}` : ''}`).join('\n\n');
}

function deduplicateGroundedFunctions(functions) {
    const normalize = value => String(value || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
    const seen = new Set();
    const names = new Set();
    const kept = [];
    return functions.filter(func => {
        const key = [func.sourceChapter, func.functionName, func.triggerEvent, func.functionalUser].map(normalize).join('\u0001');
        if (seen.has(key)) return false;
        seen.add(key);
        // Overlap context can make neighboring requests name the same quoted
        // transaction "新增" and "创建". Only collapse synonyms when source,
        // actor and trigger agree; name similarity alone is not enough.
        const duplicateEvidence = kept.some(previous => {
            if ([func.sourceChapter, func.triggerEvent, func.functionalUser].some((value, index) =>
                normalize(value) !== normalize([previous.sourceChapter, previous.triggerEvent, previous.functionalUser][index]))) return false;
            if (canonicalFunctionNameKey(previous.functionName) !== canonicalFunctionNameKey(func.functionName)) return false;
            const intersection = Math.min(previous.sourceEnd, func.sourceEnd) - Math.max(previous.sourceStart, func.sourceStart);
            const union = Math.max(previous.sourceEnd, func.sourceEnd) - Math.min(previous.sourceStart, func.sourceStart);
            return union > 0 && intersection / union >= 0.8;
        });
        if (duplicateEvidence) return false;
        kept.push(func);
        return true;
    }).map(func => {
        let name = func.functionName;
        if (names.has(normalize(name))) {
            // Downstream tables identify a process by name. Preserve separately
            // triggered/user-specific processes with a meaningful qualifier.
            name = `${name}（${func.triggerEvent}；${func.functionalUser}）`;
        }
        names.add(normalize(name));
        return { ...func, functionName: name };
    });
}

async function extractGroundedFunctions({
    documentContent, chapterName = '', userGuidelines = '', moduleNames = [],
    modelName, systemPrompt, callAIWithRetry, signal, onProgress = () => {},
    chunkChars = 6000, maxSplitDepth = 3
}) {
    const source = String(documentContent || '');
    if (!source.trim()) throw extractionError('缺少文档内容', 'MISSING_DOCUMENT');
    const ranges = splitSourceRanges(source, chunkChars);
    const diagnostics = { sourceChars: source.length, chunkCount: ranges.length, completedChunks: 0, reviewedChunks: 0, recoveredChunks: 0, rejectedCandidateCount: 0, sourceComplete: false, warnings: [] };
    let calls = 0;
    // Each node may use two extraction attempts and two review attempts.
    // Reserve the whole bounded recovery tree for every initial source range.
    const maxCalls = ranges.length * 4 * (2 ** (maxSplitDepth + 1) - 1);

    async function processRange(range, depth = 0) {
        checkAbort(signal);
        const scope = `章节：${chapterName || '全文'}；当前范围：第${range.start + 1}~${range.end}字符`;
        const reference = moduleNames.length ? `\n模块名称参考（不代表必需功能或数量）：${moduleNames.join('、').slice(0, 1500)}` : '';
        const original = `${scope}${reference}\n\n【前文，仅作上下文】\n${source.slice(Math.max(0, range.start - 400), range.start)}\n【当前原文】\n${source.slice(range.start, range.end)}\n【后文，仅作上下文】\n${source.slice(range.end, range.end + 400)}`;
        const messages = [
            { role: 'system', content: `${systemPrompt}\n${SOURCE_RULES}` },
            { role: 'user', content: `${original}${userGuidelines ? `\n\n用户要求（不得据此编造原文未要求的业务）：${userGuidelines}` : ''}\n逐段提取当前原文的实际功能，短文允许只有0个或1个，数量以证据为准。` }
        ];
        async function callAndValidate(stage, requestMessages) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                checkAbort(signal);
                if (++calls > maxCalls) throw extractionError('提取自动恢复达到请求上限，请重试当前章节');
                onProgress({ phase: stage, message: `${stage === 'reviewing' ? '核对遗漏和过拆' : '提取原文功能'}：${scope}（已处理${diagnostics.completedChunks}/${diagnostics.chunkCount}片段）` });
                const completion = await callAIWithRetry({ messages: requestMessages, model: modelName, temperature: 0.1, max_tokens: 12000, signal }, 2);
                checkAbort(signal);
                const choice = completion?.choices?.[0];
                if (isTruncatedFinishReason(choice?.finish_reason || completion?.stop_reason)) {
                    throw extractionError('模型输出被截断', 'TRUNCATED_FUNCTION_EXTRACTION');
                }
                const content = String(choice?.message?.content || '');
                try {
                    return groundFunctions(parseGroundedFunctionList(content), source, range, chapterName);
                } catch (error) {
                    if (attempt === 1) throw error;
                    diagnostics.rejectedCandidateCount += 1;
                    requestMessages = [...requestMessages,
                        { role: 'assistant', content },
                        { role: 'user', content: `校验未通过：${error.message}。请重新核对本段，删除无原文支持的扩展项，补齐缺失字段，返回完整五行列表；不是只输出改动。没有实际功能时输出“${EMPTY_RESULT}”。` }
                    ];
                }
            }
        }
        try {
            const initial = await callAndValidate('extracting', messages);
            const reviewed = await callAndValidate('reviewing', [
                ...messages,
                { role: 'assistant', content: functionListText(initial, true) || EMPTY_RESULT },
                { role: 'user', content: `请对照同一段原文逐句复核候选清单，输出修正后的完整清单（包含保留项）：\n1. 补上原文明确要求却漏掉的独立触发/业务结果，特别检查段末和表格行。\n2. 删除没有原文支持的新增、删除、导入导出、审批、定时、通知等扩展；不能仅因行业常见或闭环需要而添加。\n3. 同一请求中的筛选条件、指标列、内部计算和展示步骤不单拆；原文明确独立的新增/修改/删除或不同触发过程也不能机械合并。\n4. 检查引用确实支撑该动作和对象，不接受只引用实体名或标题。\n5. 不以数量多少判断质量，不向预估数补齐。保留每项五行与逐字原文依据。没有实际功能时输出“${EMPTY_RESULT}”。` }
            ]);
            diagnostics.completedChunks += 1;
            diagnostics.reviewedChunks += 1;
            return reviewed;
        } catch (error) {
            checkAbort(signal);
            const recoverable = ['TRUNCATED_FUNCTION_EXTRACTION', 'INVALID_EXTRACTION_FORMAT', 'UNSUPPORTED_FUNCTION_EVIDENCE'].includes(error.code);
            if (recoverable && depth < maxSplitDepth && range.end - range.start > 800) {
                // Recovery must be binary: paragraph-based splitting can
                // produce three children and exceed the reserved tree budget.
                let middle = range.start + Math.ceil((range.end - range.start) / 2);
                if (/[\uD800-\uDBFF]/.test(source[middle - 1]) && /[\uDC00-\uDFFF]/.test(source[middle])) middle -= 1;
                const halves = [{ start: range.start, end: middle }, { start: middle, end: range.end }];
                diagnostics.chunkCount += halves.length - 1;
                diagnostics.recoveredChunks += 1;
                onProgress({ phase: 'recovering', message: `${scope}输出不完整，正在缩小片段重提，已截断结果不会计入成功` });
                const recovered = [];
                for (const half of halves) recovered.push(...await processRange(half, depth + 1));
                return recovered;
            }
            error.message = `${scope}提取未完成：${error.message}`;
            throw error;
        }
    }
    const functions = [];
    for (const range of ranges) functions.push(...await processRange(range));
    diagnostics.sourceComplete = diagnostics.completedChunks === diagnostics.chunkCount;
    if (diagnostics.rejectedCandidateCount) diagnostics.warnings.push(`有${diagnostics.rejectedCandidateCount}次输出因格式或原文依据校验未通过而重新生成。`);
    return { functions: deduplicateGroundedFunctions(functions), sourceDiagnostics: diagnostics };
}

module.exports = { EMPTY_RESULT, SOURCE_RULES, splitSourceRanges, parseGroundedFunctionList, locateEvidence, deduplicateGroundedFunctions, functionListText, extractGroundedFunctions };
