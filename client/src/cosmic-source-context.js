const nameKey = value => String(value || '').normalize('NFKC')
    .replace(/^\s*[\[【][^\]】]*[\]】]\s*/, '').replace(/\s+/g, '').trim();

// Four-line editing stays compatible while the structured result keeps source evidence.
export const attachFunctionEvidence = (functions = [], extracted = []) => functions.map(func => {
    const candidates = extracted.filter(item => nameKey(item.functionName) === nameKey(func.functionName));
    const scoped = candidates.filter(item => nameKey(item.sourceChapter) === nameKey(func.sourceChapter));
    const source = scoped.length === 1 ? scoped[0] : candidates.length === 1 ? candidates[0] : null;
    if (!source) return func;
    return {
        ...func,
        documentEvidence: source.documentEvidence,
        sourceStart: source.sourceStart,
        sourceEnd: source.sourceEnd,
        sourceChapter: source.sourceChapter || func.sourceChapter
    };
});

const evidenceTexts = value => (Array.isArray(value) ? value : [value])
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);

// Each batch receives its own original passages, including functions near the end
// of a long document. Never turn an unmatched model quote into source material.
export const buildFunctionSourceContext = (documentContent, functions = [], chapters = [], maxChars = 6000) => {
    const document = String(documentContent || '');
    if (!document) return '';
    const snippets = [];
    const seen = new Set();
    const allowance = Math.max(320, Math.floor(maxChars / Math.max(functions.length, 1)) - 100);

    for (const func of functions) {
        const chapter = chapters.find(item => item.title === func.sourceChapter);
        const chapterText = String(chapter?.content || '');
        const chapterStart = chapterText ? document.indexOf(chapterText) : -1;
        const source = chapterStart >= 0 ? chapterText : document;
        const quotes = evidenceTexts(func.documentEvidence);
        const matchedQuote = quotes.find(quote => source.includes(quote));
        let anchor = matchedQuote ? source.indexOf(matchedQuote) : -1;
        let anchorLength = matchedQuote?.length || 0;
        if (anchor < 0) {
            const hints = [func.description, func.functionName, nameKey(func.functionName)
                .replace(/^(?:查询|查看|新增|创建|修改|删除|导出|导入|执行|获取)/, '')];
            const hint = hints.find(value => typeof value === 'string' && value.length >= 4 && source.includes(value));
            if (hint) { anchor = source.indexOf(hint); anchorLength = hint.length; }
        }
        // A known short chapter is useful context even for a user-edited name.
        if (anchor < 0 && chapterStart >= 0 && source.length <= allowance) {
            anchor = 0; anchorLength = source.length;
        }
        if (anchor < 0) continue;

        const size = Math.max(allowance, anchorLength);
        const padding = Math.max(0, Math.floor((size - anchorLength) / 2));
        const start = Math.max(0, anchor - padding);
        const end = Math.min(source.length, Math.max(anchor + anchorLength + padding, start + size));
        const snippet = source.slice(start, end).trim();
        if (!snippet || seen.has(snippet)) continue;
        seen.add(snippet);
        snippets.push(`【${func.functionName || func.sourceChapter || '原文依据'}】\n${snippet}`);
    }
    if (snippets.length) return snippets.join('\n\n');
    return document.length <= maxChars ? document : '';
};
