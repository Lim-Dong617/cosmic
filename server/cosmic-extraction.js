const { isTruncatedFinishReason } = require('./document-understanding');
const { canonicalFunctionNameKey } = require('./cosmic-quality');

const EMPTY_RESULT = '无可提取功能过程';
const SOURCE_RULES = `
【原文约束，优先于示例和模块预估】
只提取当前原文明确支持的独立业务过程；上下文仅用于理解跨段语义。
禁止按字数、预估数、CRUD矩阵、指标×维度组合凑数。字段、筛选条件、内部计算步骤不自动成为独立过程。
原文明确要求的独立新增、修改、删除、查询、定时任务或接口不可仅因同一页面或对象而合并。
每项严格输出五行（覆盖上文四行示例），字段顺序固定：
##触发事件：...
##功能用户：...
##功能过程：...
##功能过程描述：...
##原文依据：...
原文依据必须逐字复制当前原文中一段连续的实际需求（4~800字，不能只引用标题或通用名词），不得改写、加省略号或用推测作依据，尽量保持原文标点并在单行输出。
每段依据须与当前处理范围相交。跨段重复需求只提取一次，不得通过同义改名重复输出。
功能名须包含具体业务对象及独立业务结果，名称相同时用真实业务限定词区分。
没有实际功能需求时只输出“${EMPTY_RESULT}”。只输出完整五行记录或这句固定文本。`;

const ACTION_VERBS = [
    '查询', '查看', '检索', '搜索',
    '新增', '创建', '新建', '添加', '录入',
    '修改', '编辑', '更新', '变更', '调整',
    '删除', '移除', '注销', '作废', '清空',
    '导出', '下载', '导入', '上传',
    '审批', '审核', '驳回', '派单', '派发', '受理',
    '推送', '发送', '通知', '告警', '预警',
    '定时', '归档', '同步', '汇总', '统计', '评估'
];

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
    let lastField = null;
    let malformed = false;
    for (const line of clean.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Tolerate optional markdown bold wrapper around the field label (e.g. **##触发事件：**).
        const normalizedLine = trimmed.replace(/^\*\*(\s*##[^*]+?)\*\*\s*(.*)$/, '$1$2');
        const match = normalizedLine.match(/^##\s*(触发事件|功能用户|功能过程|功能过程描述|原文依据)[：:]\s*(.*)$/);
        if (!match) {
            // Word tables/paragraphs copied verbatim under ##原文依据 may span multiple lines.
            if (current && lastField === 'documentEvidence' && current.documentEvidence && !trimmed.startsWith('##')) {
                current.documentEvidence = `${current.documentEvidence}\n${trimmed}`;
                continue;
            }
            malformed = true;
            continue;
        }
        if (match[1] === '触发事件') {
            if (current) functions.push(current);
            current = { selected: true };
        }
        const field = fields[match[1]];
        if (!current || current[field] !== undefined) { malformed = true; continue; }
        current[field] = match[2].trim();
        lastField = field;
    }
    if (current) functions.push(current);
    if (malformed || !functions.length || functions.some(func => Object.values(fields).some(field => !func[field]))) {
        throw extractionError('功能列表格式不完整，必须返回五行记录并包含原文依据', 'INVALID_EXTRACTION_FORMAT');
    }
    return functions;
}

function cleanEvidenceQuote(evidence) {
    let text = String(evidence || '').trim();
    text = text.replace(/^(?:原文依据|原文引用|原文|引用|依据|见原文|来源)[：:]\s*/, '').trim();
    for (let i = 0; i < 2; i += 1) {
        const next = text
            .replace(/^\*\*(.*)\*\*$/, '$1')
            .replace(/^`(.*)`$/, '$1')
            .replace(/^[“"「『'‘](.*)[”"」』'’]$/, '$1')
            .trim();
        if (next === text) break;
        text = next;
    }
    return text.replace(/^[“"「『]|[”"」』]$/g, '').trim();
}

function buildCoreCharStream(text, baseOffset = 0) {
    const chars = [];
    const positions = [];
    for (let index = 0; index < text.length; index += 1) {
        const normalized = text[index].normalize('NFKC').toLowerCase();
        for (const ch of normalized) {
            if (/[\p{L}\p{N}]/u.test(ch)) {
                chars.push(ch);
                positions.push(baseOffset + index);
            }
        }
    }
    return { text: chars.join(''), positions };
}

function hasInventedActionVerb(needleCore, candidateCore) {
    for (const verb of ACTION_VERBS) {
        if (needleCore.includes(verb) && !candidateCore.includes(verb)) return true;
    }
    return false;
}

function longestCommonSubstringLength(a, b) {
    if (!a.length || !b.length) return 0;
    const prev = new Uint16Array(b.length + 1);
    const curr = new Uint16Array(b.length + 1);
    let best = 0;
    for (let i = 0; i < a.length; i += 1) {
        curr.fill(0);
        const ai = a.charCodeAt(i);
        for (let j = 0; j < b.length; j += 1) {
            if (ai === b.charCodeAt(j)) {
                const len = prev[j] + 1;
                curr[j + 1] = len;
                if (len > best) best = len;
            }
        }
        prev.set(curr);
    }
    return best;
}

function longestCommonSubsequenceLength(a, b) {
    if (!a.length || !b.length) return 0;
    let prev = new Uint16Array(b.length + 1);
    let curr = new Uint16Array(b.length + 1);
    for (let i = 0; i < a.length; i += 1) {
        const ai = a.charCodeAt(i);
        curr[0] = 0;
        for (let j = 0; j < b.length; j += 1) {
            curr[j + 1] = ai === b.charCodeAt(j)
                ? prev[j] + 1
                : (prev[j + 1] >= curr[j] ? prev[j + 1] : curr[j]);
        }
        const swap = prev;
        prev = curr;
        curr = swap;
    }
    return prev[b.length];
}

function bigramOverlapRatio(needle, candidate) {
    if (needle.length < 2 || candidate.length < 2) return 0;
    const candidateBigrams = new Set();
    for (let i = 0; i < candidate.length - 1; i += 1) {
        candidateBigrams.add(candidate.slice(i, i + 2));
    }
    let hits = 0;
    const total = needle.length - 1;
    for (let i = 0; i < total; i += 1) {
        if (candidateBigrams.has(needle.slice(i, i + 2))) hits += 1;
    }
    return hits / total;
}

function locateFuzzyCoreEvidence(source, range, sourceCore, corePositions, coreNeedle) {
    if (coreNeedle.length < 16 || coreNeedle.length > 600 || sourceCore.length < 16) return null;
    const anchorSize = 4;
    const step = 2;
    const bucketWidth = Math.max(16, Math.floor(coreNeedle.length * 0.35));
    const buckets = new Map();

    for (let i = 0; i <= coreNeedle.length - anchorSize; i += step) {
        const anchor = coreNeedle.slice(i, i + anchorSize);
        let pos = sourceCore.indexOf(anchor);
        let seen = 0;
        while (pos >= 0 && seen < 12) {
            const diagonal = pos - i;
            const bucketKey = Math.round(diagonal / bucketWidth);
            for (let delta = -1; delta <= 1; delta += 1) {
                const key = bucketKey + delta;
                let entry = buckets.get(key);
                if (!entry) {
                    entry = { hits: 0, distinctAnchors: new Set(), minSrc: pos, maxSrc: pos + anchorSize, minNeedle: i, maxNeedle: i + anchorSize };
                    buckets.set(key, entry);
                }
                if (!entry.distinctAnchors.has(i)) {
                    entry.distinctAnchors.add(i);
                    entry.hits += 1;
                    if (pos < entry.minSrc) entry.minSrc = pos;
                    if (pos + anchorSize > entry.maxSrc) entry.maxSrc = pos + anchorSize;
                    if (i < entry.minNeedle) entry.minNeedle = i;
                    if (i + anchorSize > entry.maxNeedle) entry.maxNeedle = i + anchorSize;
                }
            }
            seen += 1;
            pos = sourceCore.indexOf(anchor, pos + 1);
        }
    }

    const candidates = [...buckets.values()]
        .filter(entry => entry.hits >= 3)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 4);

    const maxWindowLen = Math.ceil(coreNeedle.length * 1.8) + 20;
    for (const candidate of candidates) {
        const padLeft = Math.min(candidate.minNeedle + 6, Math.ceil(coreNeedle.length * 0.4));
        const padRight = Math.min((coreNeedle.length - candidate.maxNeedle) + 6, Math.ceil(coreNeedle.length * 0.4));
        const winStart = Math.max(0, candidate.minSrc - padLeft);
        const winEnd = Math.min(sourceCore.length, candidate.maxSrc + padRight);
        if (winEnd - winStart > maxWindowLen || winEnd <= winStart) continue;

        const spanStart = Math.max(winStart, candidate.minSrc);
        const spanEnd = Math.min(winEnd, candidate.maxSrc);
        const sourceStart = corePositions[spanStart];
        const sourceEnd = corePositions[spanEnd - 1] + 1;
        if (!(sourceStart < range.end && sourceEnd > range.start)) continue;

        const candidateCore = sourceCore.slice(winStart, winEnd);
        if (hasInventedActionVerb(coreNeedle, candidateCore)) continue;
        if (bigramOverlapRatio(coreNeedle, candidateCore) < 0.70) continue;
        if (longestCommonSubstringLength(coreNeedle, candidateCore) < 6) continue;
        const lcsLen = longestCommonSubsequenceLength(coreNeedle, candidateCore);
        if (lcsLen / coreNeedle.length < 0.80) continue;

        // Refine exact start/end around matched anchor region to cover edge chars cleanly.
        let refinedStart = spanStart;
        let refinedEnd = spanEnd;
        let leftNeedle = candidate.minNeedle;
        while (refinedStart > winStart && leftNeedle > 0 && sourceCore[refinedStart - 1] === coreNeedle[leftNeedle - 1]) {
            refinedStart -= 1;
            leftNeedle -= 1;
        }
        let rightNeedle = candidate.maxNeedle;
        while (refinedEnd < winEnd && rightNeedle < coreNeedle.length && sourceCore[refinedEnd] === coreNeedle[rightNeedle]) {
            refinedEnd += 1;
            rightNeedle += 1;
        }
        const start = corePositions[refinedStart];
        const end = corePositions[refinedEnd - 1] + 1;
        if (start < range.end && end > range.start) {
            return { start, end, text: source.slice(start, end) };
        }
    }
    return null;
}

// Match quoted evidence back to exact source offsets while tolerating harmless
// Word/table layout noise (whitespace, fullwidth/halfwidth punctuation, markdown
// pipes) and minor wording trims on long quotes, without accepting fabricated actions.
function locateEvidence(source, evidence, range, contextChars = 400) {
    const quote = cleanEvidenceQuote(evidence);
    const needle = quote.replace(/\s/g, '');
    if (needle.length < 4 || needle.length > 1500) return null;
    const from = Math.max(0, range.start - contextChars);
    const to = Math.min(source.length, range.end + contextChars);

    // Tier 1: exact non-whitespace substring match.
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

    // Ellipsis quotes must not bypass verification unless the literal ellipsis exists in Tier 1.
    if (/\.{3,}|…/.test(quote)) return null;

    // Tier 2: NFKC + punctuation/table-symbol normalized match.
    const windowText = source.slice(from, to);
    const { text: sourceCore, positions: corePositions } = buildCoreCharStream(windowText, from);
    const coreNeedle = buildCoreCharStream(quote).text;
    const strippedQuote = quote.replace(/^(?:[（(]?\d+[）).、.\s]+|[•·▪▫●\-*]+\s*)/, '').trim();
    const strippedCoreNeedle = strippedQuote !== quote ? buildCoreCharStream(strippedQuote).text : '';
    const candidateNeedles = [coreNeedle, strippedCoreNeedle].filter((item, idx, arr) => item.length >= 4 && arr.indexOf(item) === idx);

    for (const targetNeedle of candidateNeedles) {
        let coreAt = sourceCore.indexOf(targetNeedle);
        while (coreAt >= 0) {
            const start = corePositions[coreAt];
            const end = corePositions[coreAt + targetNeedle.length - 1] + 1;
            if (start < range.end && end > range.start) return { start, end, text: source.slice(start, end) };
            coreAt = sourceCore.indexOf(targetNeedle, coreAt + 1);
        }
    }

    // Tier 3: controlled fuzzy alignment for long quotes with minor punctuation/parenthetical trims.
    for (const targetNeedle of candidateNeedles) {
        const fuzzy = locateFuzzyCoreEvidence(source, range, sourceCore, corePositions, targetNeedle);
        if (fuzzy) return fuzzy;
    }

    return null;
}

function normalizeGroundedFunctionalUser(triggerEvent, functionalUser) {
    const trigger = String(triggerEvent || '').trim();
    const user = String(functionalUser || '').trim();
    if (!user) return user;
    const match = user.match(/^发起者[：:]\s*(.+?)\s+接收者[：:]\s*(.+)$/);
    if (!match) return user;
    const initiator = match[1].trim();
    const receiver = match[2].trim();
    if (trigger === '时钟触发') {
        if (/^(?:本)?系统$/.test(initiator) && /^(?:本)?系统$/.test(receiver)) {
            return '发起者：定时触发器 接收者：本系统';
        }
        if (/^(?:定时触发器|定时调度器|调度器)$/.test(initiator) && receiver === '系统') {
            return `发起者：${initiator} 接收者：本系统`;
        }
    } else if (trigger === '用户触发') {
        if (initiator && !/^(?:本)?系统$|定时|调度|外部/.test(initiator) && /^(?:本)?系统$/.test(receiver)) {
            return `发起者：${initiator} 接收者：${initiator}`;
        }
    } else if (trigger === '接口调用触发') {
        if (initiator && receiver === '系统') {
            return `发起者：${initiator} 接收者：本系统`;
        }
    }
    return user;
}

function evaluateGrounding(functions, source, range, chapterName) {
    const grounded = [];
    const unsupported = [];
    for (const func of functions) {
        const evidence = locateEvidence(source, func.documentEvidence, range);
        if (!evidence) {
            unsupported.push(func);
        } else {
            const functionalUser = normalizeGroundedFunctionalUser(func.triggerEvent, func.functionalUser);
            grounded.push({ ...func, functionalUser, documentEvidence: evidence.text, sourceStart: evidence.start, sourceEnd: evidence.end, sourceChapter: chapterName });
        }
    }
    return { grounded, unsupported };
}

function groundFunctions(functions, source, range, chapterName) {
    const { grounded, unsupported } = evaluateGrounding(functions, source, range, chapterName);
    if (unsupported.length) {
        const names = unsupported.slice(0, 3).map(item => `“${item.functionName}”`).join('、');
        const extra = unsupported.length > 3 ? `等${unsupported.length}项` : '';
        throw extractionError(`功能${names}${extra}缺少可在当前原文核对的依据`, 'UNSUPPORTED_FUNCTION_EVIDENCE');
    }
    return grounded;
}

function findBinarySplitPoint(source, range) {
    const length = range.end - range.start;
    const midpoint = range.start + Math.ceil(length / 2);
    const bandStart = range.start + Math.floor(length * 0.35);
    const bandEnd = range.start + Math.ceil(length * 0.65);
    let bestBoundary = -1;
    let bestDistance = Infinity;
    for (let index = bandStart; index < bandEnd; index += 1) {
        const ch = source[index];
        if (ch === '\n' || ch === '。' || ch === '；') {
            const splitPos = index + 1;
            const distance = Math.abs(splitPos - midpoint);
            if (splitPos > range.start && splitPos < range.end && distance < bestDistance) {
                bestDistance = distance;
                bestBoundary = splitPos;
            }
        }
    }
    let middle = bestBoundary > 0 ? bestBoundary : midpoint;
    if (/[\uD800-\uDBFF]/.test(source[middle - 1]) && /[\uDC00-\uDFFF]/.test(source[middle])) middle -= 1;
    return middle;
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
    const diagnostics = {
        sourceChars: source.length,
        chunkCount: ranges.length,
        completedChunks: 0,
        reviewedChunks: 0,
        recoveredChunks: 0,
        rejectedCandidateCount: 0,
        droppedUnsupportedCount: 0,
        droppedUnsupportedNames: [],
        sourceComplete: false,
        warnings: []
    };
    let calls = 0;
    // Each node may use two extraction attempts and two review attempts.
    // Reserve the whole bounded recovery tree for every initial source range.
    const maxCalls = ranges.length * 4 * (2 ** (maxSplitDepth + 1) - 1);

    function recordDroppedUnsupported(unsupported) {
        diagnostics.droppedUnsupportedCount += unsupported.length;
        for (const item of unsupported) {
            if (diagnostics.droppedUnsupportedNames.length < 10 && item?.functionName) {
                diagnostics.droppedUnsupportedNames.push(item.functionName);
            }
        }
    }

    async function processRange(range, depth = 0) {
        checkAbort(signal);
        const scope = `章节：${chapterName || '全文'}；当前范围：第${range.start + 1}~${range.end}字符`;
        const reference = moduleNames.length ? `\n模块名称参考（不代表必需功能或数量）：${moduleNames.join('、').slice(0, 1500)}` : '';
        const original = `${scope}${reference}\n\n【前文，仅作上下文】\n${source.slice(Math.max(0, range.start - 400), range.start)}\n【当前原文】\n${source.slice(range.start, range.end)}\n【后文，仅作上下文】\n${source.slice(range.end, range.end + 400)}`;
        const messages = [
            { role: 'system', content: `${systemPrompt}\n${SOURCE_RULES}` },
            { role: 'user', content: `${original}${userGuidelines ? `\n\n用户要求（不得据此编造原文未要求的业务）：${userGuidelines}` : ''}\n逐段提取当前原文的实际功能，短文允许只有0个或1个，数量以证据为准。` }
        ];
        const canSplitFurther = depth < maxSplitDepth && range.end - range.start > 800;

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
                    const parsed = parseGroundedFunctionList(content);
                    const { grounded, unsupported } = evaluateGrounding(parsed, source, range, chapterName);
                    if (!unsupported.length) return grounded;

                    const names = unsupported.slice(0, 5).map(item => `“${item.functionName}”`).join('、');
                    const extra = unsupported.length > 5 ? `等${unsupported.length}项` : '';
                    if (attempt === 1) {
                        // Do not fail an entire document over isolated ungrounded candidates
                        // once retry has already run: keep verified items and warn clearly.
                        if (grounded.length > 0) {
                            recordDroppedUnsupported(unsupported);
                            return grounded;
                        }
                        if (!canSplitFurther && (depth > 0 || ranges.length > 1)) {
                            recordDroppedUnsupported(unsupported);
                            return [];
                        }
                        throw extractionError(`功能${names}${extra}缺少可在当前原文核对的依据`, 'UNSUPPORTED_FUNCTION_EVIDENCE');
                    }

                    diagnostics.rejectedCandidateCount += 1;
                    requestMessages = [...requestMessages,
                        { role: 'assistant', content },
                        { role: 'user', content: `校验未通过：功能${names}${extra}缺少可在当前原文核对的依据。请直接逐字复制【当前原文】中的连续需求短句填入「##原文依据：」（不得改写、加省略号或仅引用【前文/后文】）；若当前原文确实未要求该功能则删除该项。请返回完整五行列表；没有实际功能时输出“${EMPTY_RESULT}”。` }
                    ];
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
            if (recoverable && canSplitFurther) {
                // Recovery must be binary: paragraph-based splitting can
                // produce three children and exceed the reserved tree budget.
                const middle = findBinarySplitPoint(source, range);
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
    if (diagnostics.droppedUnsupportedCount) {
        const sample = diagnostics.droppedUnsupportedNames.length
            ? `（如：${diagnostics.droppedUnsupportedNames.slice(0, 3).join('、')}）`
            : '';
        diagnostics.warnings.push(`已过滤${diagnostics.droppedUnsupportedCount}条缺少原文依据的候选功能${sample}，其余已核验功能已保留。`);
    }
    return { functions: deduplicateGroundedFunctions(functions), sourceDiagnostics: diagnostics };
}

module.exports = { EMPTY_RESULT, SOURCE_RULES, splitSourceRanges, parseGroundedFunctionList, locateEvidence, normalizeGroundedFunctionalUser, deduplicateGroundedFunctions, functionListText, extractGroundedFunctions };
