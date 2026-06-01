import React, { useState, useRef, useEffect, useCallback } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
    Upload, FileText, Send, Download, Bot, User, Loader2,
    CheckCircle, AlertCircle, X, Trash2, Copy, Check, Eye, Table,
    Zap, Sparkles, Brain, Plus, BarChart3, RefreshCw,
    FileSpreadsheet, Target, Info, Edit3, Save
} from 'lucide-react';

// NESMA 功能点权重表
const FP_WEIGHTS = {
    ILF: { '低': 7, '中': 10, '高': 15 },
    EIF: { '低': 5, '中': 7, '高': 10 },
    EI:  { '低': 3, '中': 4, '高': 6 },
    EO:  { '低': 4, '中': 5, '高': 7 },
    EQ:  { '低': 3, '中': 4, '高': 6 },
};

// 重用程度 → 调整系数（参考"软件开发计价模型" 10/7/4/5/4）
const REUSE_COEFFICIENTS = {
    '低': 1.0,     // 完全新开发
    '中': 0.667,   // 部分复用
    '高': 0.333,   // 高度复用
};

// 类别中文名
const CATEGORY_LABELS = {
    ILF: '内部逻辑文件',
    EIF: '外部接口文件',
    EI: '外部输入',
    EO: '外部输出',
    EQ: '外部查询',
};

const MAX_UPLOAD_MB = 300;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const initialAnalysisProgress = {
    visible: false,
    status: 'idle',
    title: '',
    phase: '',
    percent: 0,
    current: 0,
    total: 0,
    detail: '',
    stats: ''
};

function NesmaApp({ selectedModel, getUserConfig, showToast: externalShowToast }) {
    // ═══════════ 状态管理 ═══════════
    const [messages, setMessages] = useState([]);
    const [inputText, setInputText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [documentContent, setDocumentContent] = useState('');
    const [documentName, setDocumentName] = useState('');
    const [nesmaTableData, setNesmaTableData] = useState([]);
    const [copied, setCopied] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [showPreview, setShowPreview] = useState(false);
    const [showTableView, setShowTableView] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [toastMessage, setToastMessage] = useState('');
    const [isWaitingForAnalysis, setIsWaitingForAnalysis] = useState(false);
    const [userGuidelines, setUserGuidelines] = useState('');
    const [coverageResult, setCoverageResult] = useState(null);
    const [isVerifying, setIsVerifying] = useState(false);
    const [currentStep, setCurrentStep] = useState(0); // 0=未开始, 1=模块识别中, 2=提取中, 3=完成
    const [showEditModal, setShowEditModal] = useState(false);
    const [moduleStructure, setModuleStructure] = useState(null); // NESMA三级模块结构
    const [extractionMode, setExtractionMode] = useState('precise'); // 'precise' | 'quantity'
    const [totalTargetCount, setTotalTargetCount] = useState(200); // 数量优先：用户指定的目标总功能点数
    const [quantityPlan, setQuantityPlan] = useState(null); // 每模块目标数量规划 [{level1,level2,level3,target,...}]
    const [showQuantityPlan, setShowQuantityPlan] = useState(false); // 数量规划弹窗

    // 章节模式
    const [chapters, setChapters] = useState([]);
    const [showChapterView, setShowChapterView] = useState(false);
    const [analysisProgress, setAnalysisProgress] = useState(initialAnalysisProgress);

    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);
    const dropZoneRef = useRef(null);
    const abortControllerRef = useRef(null);

    // ═══════════ 初始化 ═══════════
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const showToast = (message) => {
        if (externalShowToast) { externalShowToast(message); return; }
        setToastMessage(message);
        setTimeout(() => setToastMessage(''), 2500);
    };

    const updateAnalysisProgress = useCallback((patch) => {
        setAnalysisProgress(prev => ({
            ...prev,
            visible: true,
            status: patch.status || prev.status || 'running',
            ...patch
        }));
    }, []);

    const resetAnalysisProgress = useCallback(() => {
        setAnalysisProgress(initialAnalysisProgress);
    }, []);

    const AnalysisProgressPanel = () => {
        if (!analysisProgress.visible) return null;
        const percent = Math.max(0, Math.min(100, Math.round(analysisProgress.percent || 0)));
        const isDone = analysisProgress.status === 'done';
        const isWaiting = analysisProgress.status === 'waiting';
        const statusText = isDone ? 'Done' : isWaiting ? 'Waiting' : 'Running';

        return (
            <div className={`analysis-progress-panel ${isDone ? 'done' : isWaiting ? 'waiting' : ''}`}>
                <div className="analysis-progress-head">
                    <div className="analysis-progress-title">
                        {isDone ? <CheckCircle size={16} /> : isWaiting ? <AlertCircle size={16} /> : <Loader2 size={16} className="spinner" />}
                        <span>{analysisProgress.title || 'Analysis progress'}</span>
                        <em>{statusText}</em>
                    </div>
                    <strong>{percent}%</strong>
                </div>
                <div className="analysis-progress-bar">
                    <span style={{ width: `${percent}%` }} />
                </div>
                <div className="analysis-progress-meta">
                    <div>
                        <b>{analysisProgress.phase || 'Preparing'}</b>
                        <p>{analysisProgress.detail || 'Preparing analysis task...'}</p>
                    </div>
                    {(analysisProgress.total > 0 || analysisProgress.stats) && (
                        <div className="analysis-progress-count">
                            {analysisProgress.total > 0 && <span>{analysisProgress.current}/{analysisProgress.total}</span>}
                            {analysisProgress.stats && <small>{analysisProgress.stats}</small>}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // ═══════════ 文件处理 ═══════════
    const handleDragEnter = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }, []);
    const handleDragLeave = useCallback((e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.currentTarget === dropZoneRef.current && !e.currentTarget.contains(e.relatedTarget)) setIsDragging(false);
    }, []);
    const handleDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); }, []);
    const handleDrop = useCallback((e) => {
        e.preventDefault(); e.stopPropagation(); setIsDragging(false);
        const files = e.dataTransfer?.files;
        if (files?.length > 0) processFile(files[0]);
    }, []);

    const handleFileSelect = (e) => {
        const file = e.target.files?.[0];
        if (file) processFile(file);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const processFile = async (file) => {
        setErrorMessage('');
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        if (!['.docx', '.txt', '.md'].includes(ext)) {
            setErrorMessage(`不支持的文件格式: ${ext}，请上传 .docx, .txt 或 .md 文件`);
            return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            setErrorMessage(`文件大小超过限制（最大${MAX_UPLOAD_MB}MB）`);
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        try {
            setIsLoading(true);
            setUploadProgress(0);
            const res = await axios.post('/api/parse-word', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                timeout: 300000,
                onUploadProgress: (e) => setUploadProgress(Math.round((e.loaded * 100) / e.total))
            });

            if (res.data.success) {
                setDocumentContent(res.data.text);
                setDocumentName(res.data.filename);
                setUploadProgress(100);
                setMessages(prev => [...prev,
                    { role: 'system', content: `📄 已导入文档: ${res.data.filename}\n📊 大小: ${(res.data.fileSize / 1024).toFixed(1)} KB | 字符数: ${res.data.wordCount}\n\n${res.data.text.substring(0, 600)}${res.data.text.length > 600 ? '\n\n...(点击"预览文档"查看完整内容)' : ''}` },
                    { role: 'assistant', content: '✅ 文档已就绪！您可以在下方输入**特殊拆分要求**，或直接点击**「开始NESMA功能点拆分」**按钮。' }
                ]);
                setIsWaitingForAnalysis(true);
            }
        } catch (error) {
            const msg = error.response?.data?.error || error.message;
            setErrorMessage(`文档解析失败: ${msg}`);
        } finally {
            setIsLoading(false);
            setTimeout(() => setUploadProgress(0), 1000);
        }
    };

    // ═══════════ 章节识别（含NESMA三级模块识别） ═══════════
    const startChapterRecognition = async () => {
        if (!documentContent) { showToast('请先上传文档'); return; }

        setIsLoading(true);
        setIsWaitingForAnalysis(false);
        setCurrentStep(1);
        updateAnalysisProgress({
            title: 'NESMA analysis',
            phase: 'Module recognition',
            percent: 10,
            current: 1,
            total: 4,
            detail: 'Analyzing level 1/2/3 module structure...',
            stats: `${documentContent.length.toLocaleString()} chars`
        });
        setMessages([{ role: 'system', content: '🔬 **NESMA三级模块识别中...**\n正在分析文档的一级/二级/三级模块层级结构...' }]);

        let recognizedModules = null;

        // ── 第一步：NESMA三级模块结构识别（这是关键！用来驱动后续提取的覆盖度） ──
        try {
            const modRes = await axios.post('/api/nesma/recognize-modules', {
                documentContent,
                userConfig: getUserConfig()
            });
            if (modRes.data.success && modRes.data.moduleData?.modules?.length > 0) {
                recognizedModules = modRes.data.moduleData;
                setModuleStructure(recognizedModules);
                updateAnalysisProgress({
                    phase: 'Module recognition complete',
                    percent: 28,
                    current: 1,
                    total: 4,
                    detail: `Found ${recognizedModules.modules.length} modules. Preparing chapter detection.`,
                    stats: `${recognizedModules.modules.length} modules`
                });

                // ── 如果是数量优先模式，自动生成数量规划 ──
                let generatedPlan = null;
                const currentMode = extractionMode; // capture current mode
                if (currentMode === 'quantity') {
                    const mods = recognizedModules.modules;
                    const totalEst = mods.reduce((s, m) => s + (m.estimatedFunctionPoints || 15), 0) || 1;
                    // 按预估占比分配目标数量，最小8，最大999
                    const plan = mods.map(m => ({
                        level1: m.level1,
                        level2: m.level2,
                        level3: m.level3,
                        businessObjects: m.businessObjects || [],
                        estimated: m.estimatedFunctionPoints || 15,
                        target: Math.max(8, Math.round((m.estimatedFunctionPoints || 15) / totalEst * totalTargetCount))
                    }));
                    // 修正合计误差，加到最大模块上
                    const planTotal = plan.reduce((s, p) => s + p.target, 0);
                    if (plan.length > 0) {
                        const maxIdx = plan.reduce((mi, p, i) => p.target > plan[mi].target ? i : mi, 0);
                        plan[maxIdx].target += totalTargetCount - planTotal;
                        if (plan[maxIdx].target < 8) plan[maxIdx].target = 8;
                    }
                    generatedPlan = plan;
                    setQuantityPlan(plan);
                }

                const modSummary = recognizedModules.modules.map((m, i) =>
                    `${i + 1}. **${m.level3}**（${m.level1} > ${m.level2}）: ${
                        m.businessObjects?.join('、') || '若干业务对象'
                    }${generatedPlan ? `，目标 **${generatedPlan[i]?.target || '?'}** 个功能点` : `，预估 ~${m.estimatedFunctionPoints || '?'} 个功能点`}`
                ).join('\n');

                const planTip = generatedPlan
                    ? `\n\n📊 **已生成数量规划**（总目标 ${totalTargetCount} 个）。可点击「**调整规划**」按钮修改各模块目标数量。`
                    : '';

                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `## 🗂️ 三级模块结构识别完成\n\n共识别到 **${recognizedModules.modules.length}** 个三级模块节点：\n\n${modSummary}${planTip}\n\n这些模块将作为"脚手架"指导功能点提取，确保不遗漏任何三级模块。`
                }]);
            }
        } catch (e) {
            console.warn('NESMA模块识别失败，将跳过模块脚手架:', e.message);
            setMessages(prev => [...prev, {
                role: 'system',
                content: '⚠️ 三级模块识别失败，将使用默认章节模式（功能点可能略有遗漏）。'
            }]);
        }

        // ── 第二步：章节分割 ──
        setMessages(prev => [...prev, {
            role: 'system',
            content: '📑 **章节识别中...**\n正在按标题结构切分章节...'
        }]);

        try {
        updateAnalysisProgress({
            phase: 'Chapter detection',
            percent: 36,
            current: 2,
            total: 4,
            detail: 'Splitting document into chapters.'
        });
            const res = await axios.post('/api/split-chapters', { documentContent });
            if (res.data.success) {
                const chapterList = res.data.chapters;
                setChapters(chapterList);
                updateAnalysisProgress({
                    status: 'waiting',
                    phase: 'Waiting for chapter confirmation',
                    percent: 45,
                    current: 2,
                    total: 4,
                    detail: `Found ${chapterList.length} chapters. Confirm the selection to start NESMA extraction.`,
                    stats: `selected ${chapterList.filter(ch => ch.selected).length}/${chapterList.length}`
                });

                const chapterSummary = chapterList.map((ch, i) =>
                    `${ch.selected ? '☑' : '☐'} **${i + 1}.** ${ch.title} (${ch.charCount}字)`
                ).join('\n');

                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `## 📑 章节识别完成\n\n共识别到 **${chapterList.length}** 个章节：\n\n${chapterSummary}\n\n${recognizedModules ? `✅ 已加载三级模块脚手架（${recognizedModules.modules.length}个三级模块），提取将更全面。` : ''}\n\n点击**「确认·开始NESMA提取」**按钮。`,
                    showChapterActions: true
                }]);
                setCurrentStep(2);
            }
        } catch (error) {
            setMessages(prev => [...prev, {
                role: 'system',
                content: '⚠️ 章节自动识别失败，将使用全文模式提取功能点。'
            }]);
            setChapters([{ title: '全文', content: documentContent, charCount: documentContent.length, selected: true }]);
            await startNesmaExtraction([{ title: '全文', content: documentContent, selected: true }], recognizedModules);
        } finally {
            setIsLoading(false);
        }
    };

    const toggleChapter = (index) => {
        setChapters(prev => prev.map((ch, i) =>
            i === index ? { ...ch, selected: !ch.selected } : ch
        ));
    };

    // ═══════════ NESMA 功能点提取 ═══════════
    const startNesmaExtraction = async (chapterList = null, externalModules = null) => {
        const selectedChapters = (chapterList || chapters).filter(ch => ch.selected);
        const activeModuleStructure = externalModules || moduleStructure; // 优先使用传入的，否则用state里的
        if (selectedChapters.length === 0) { showToast('请至少选择一个章节'); return; }

        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;

        setIsLoading(true);
        setCurrentStep(2);
        setNesmaTableData([]);
        updateAnalysisProgress({
            status: 'running',
            title: 'NESMA extraction',
            phase: 'Function point extraction',
            percent: 50,
            current: 0,
            total: selectedChapters.length,
            detail: 'Extracting function points from selected chapters.',
            stats: '0 function points'
        });

        let allTableData = [];
        let round = 1;
        const maxRounds = 3;

        try {
            for (let i = 0; i < selectedChapters.length; i++) {
                if (signal.aborted) return;
                const chapter = selectedChapters[i];
                updateAnalysisProgress({
                    phase: 'Function point extraction',
                    percent: 50 + Math.round((i / Math.max(selectedChapters.length, 1)) * 45),
                    current: i + 1,
                    total: selectedChapters.length,
                    detail: `Analyzing chapter: ${chapter.title}`,
                    stats: `${allTableData.length} function points`
                });

                setMessages(prev => {
                    const filtered = prev.filter(m => !m.content.startsWith('🔍'));
                    return [...filtered, {
                        role: 'system',
                        content: `🔍 **NESMA功能点提取 (${i + 1}/${selectedChapters.length})**\n正在分析章节: ${chapter.title}...`
                    }];
                });

                const res = await axios.post('/api/nesma/extract-functions', {
                    documentContent,
                    chapterContent: chapter.content,
                    chapterName: chapter.title,
                    userGuidelines,
                    previousResults: allTableData,
                    moduleStructure: activeModuleStructure,
                    extractionMode,
                    targetFpCount: extractionMode === 'quantity' ? totalTargetCount : null,
                    quantityPlan: extractionMode === 'quantity' ? quantityPlan : null, // 模块级别目标数量规划
                    userConfig: getUserConfig()
                }, { signal });

                if (res.data.success && res.data.tableData?.length > 0) {
                    // 去掉与已有数据重名的
                    const existingNames = new Set(allTableData.map(r => r.funcName?.toLowerCase().trim()));
                    const newData = res.data.tableData.filter(r => !existingNames.has(r.funcName?.toLowerCase().trim()));
                    allTableData = [...allTableData, ...newData];
                    setNesmaTableData(allTableData);
                    updateAnalysisProgress({
                        phase: 'Function point extraction',
                        percent: 50 + Math.round(((i + 1) / Math.max(selectedChapters.length, 1)) * 45),
                        current: i + 1,
                        total: selectedChapters.length,
                        detail: `Finished chapter: ${chapter.title}`,
                        stats: `${allTableData.length} function points`
                    });
                }

                // 章节间等待
                if (i < selectedChapters.length - 1) {
                    try {
                        await new Promise((resolve, reject) => {
                            const t = setTimeout(resolve, 2000);
                            signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
                        });
                    } catch (e) { if (e.name === 'AbortError' || signal.aborted) return; }
                }
            }
            setCurrentStep(3);
            updateAnalysisProgress({
                status: 'done',
                phase: 'Completed',
                percent: 100,
                current: selectedChapters.length,
                total: selectedChapters.length,
                detail: 'NESMA function point extraction completed.',
                stats: `${allTableData.length} function points`
            });

            // ?? 统计汇总
            const catCounts = {};
            let totalFP = 0;
            allTableData.forEach(r => {
                catCounts[r.category] = (catCounts[r.category] || 0) + 1;
                totalFP += r.fpCount || 0;
            });
            const catSummary = Object.entries(catCounts).map(([k, v]) => `${k}: ${v}个`).join(' | ');

            setMessages(prev => {
                const filtered = prev.filter(m => !m.content.startsWith('🔍'));
                return [...filtered, {
                    role: 'assistant',
                    content: `## 🎉 NESMA功能点提取完成！\n\n从 **${selectedChapters.length}** 个章节中共识别到 **${allTableData.length}** 个功能点。\n\n📊 **总功能点数(UFP)**: ${totalFP}\n📊 类别分布：${catSummary}\n\n点击**「查看表格」**查看完整结果，或**「导出Excel」**下载。`,
                    showActions: true
                }];
            });
        } catch (error) {
            if (error.name === 'AbortError' || error.name === 'CanceledError') return;
            if (allTableData.length > 0) {
                setCurrentStep(3);
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `⚠️ 功能点提取部分完成（已提取 ${allTableData.length} 个）。\n错误: ${error.response?.data?.error || error.message}`,
                    showActions: true
                }]);
            } else {
                setMessages(prev => [...prev, { role: 'assistant', content: `❌ NESMA功能点提取失败: ${error.response?.data?.error || error.message}` }]);
                setCurrentStep(0);
            }
        } finally {
            setIsLoading(false);
        }
    };

    // ═══════════ 覆盖度验证 ═══════════
    const verifyCoverage = async () => {
        if (!documentContent || nesmaTableData.length === 0) {
            showToast('请先完成NESMA功能点提取后再验证');
            return;
        }

        setIsVerifying(true);
        setMessages(prev => [...prev, {
            role: 'system',
            content: `🔍 **覆盖度验证中...**\n正在检查 ${nesmaTableData.length} 个功能点是否覆盖文档中的所有功能...`
        }]);

        try {
            const res = await axios.post('/api/nesma/verify-coverage', {
                documentContent,
                extractedFunctions: nesmaTableData,
                userConfig: getUserConfig()
            });

            if (res.data.success && res.data.verification) {
                const v = res.data.verification;
                setCoverageResult(v);

                const scoreEmoji = v.coverageScore >= 90 ? '🟢' : v.coverageScore >= 70 ? '🟡' : '🔴';
                const missedList = (v.missedFunctions || []).map((f, i) =>
                    `${i + 1}. **[${f.category || '?'}] ${f.functionName}**\n   📝 ${f.reason || ''}\n   📄 文档依据: "${f.documentEvidence || '无'}"`
                ).join('\n\n');

                let resultContent = `## ${scoreEmoji} NESMA覆盖度验证结果\n\n`;
                resultContent += `- **覆盖度评分**: ${v.coverageScore}/100\n`;
                resultContent += `- **已提取功能点数**: ${nesmaTableData.length}\n`;
                resultContent += `- **遗漏功能点数**: ${v.missedFunctions?.length || 0}\n\n`;

                if (v.missedFunctions?.length > 0) {
                    resultContent += `### ⚠️ 遗漏的功能点：\n\n${missedList}\n\n`;
                    resultContent += `---\n\n点击 **「补充提取」** 按钮可自动提取遗漏的功能点。`;
                } else {
                    resultContent += `\n✅ NESMA功能点提取完整度良好！`;
                }

                if (v.categoryMismatches?.length > 0) {
                    const mismatchList = v.categoryMismatches.map((m, i) =>
                        `${i + 1}. **${m.functionName}**: ${m.currentCategory} → ${m.suggestedCategory} (${m.reason})`
                    ).join('\n');
                    resultContent += `\n\n### 🔄 类别建议修正：\n${mismatchList}`;
                }

                setMessages(prev => {
                    const filtered = prev.filter(m => !m.content.startsWith('🔍 **覆盖度验证中'));
                    return [...filtered, {
                        role: 'assistant',
                        content: resultContent,
                        showCoverageActions: v.missedFunctions?.length > 0
                    }];
                });
            }
        } catch (error) {
            setMessages(prev => {
                const filtered = prev.filter(m => !m.content.startsWith('🔍 **覆盖度验证中'));
                return [...filtered, {
                    role: 'assistant',
                    content: `❌ 覆盖度验证失败: ${error.response?.data?.error || error.message}`
                }];
            });
        } finally {
            setIsVerifying(false);
        }
    };

    // ═══════════ 补充提取 ═══════════
    const extractSupplementary = async () => {
        if (!coverageResult?.missedFunctions?.length) {
            showToast('没有需要补充提取的功能');
            return;
        }

        setIsLoading(true);
        setMessages(prev => [...prev, {
            role: 'system',
            content: `🔄 **补充提取中...**\n正在针对 ${coverageResult.missedFunctions.length} 个遗漏功能点进行补充分析...`
        }]);

        try {
            const res = await axios.post('/api/nesma/extract-supplementary', {
                documentContent,
                existingFunctions: nesmaTableData,
                missedFunctions: coverageResult.missedFunctions,
                moduleStructure,  // 补充提取也传入模块脚手架
                userConfig: getUserConfig()
            });

            if (res.data.success && res.data.tableData?.length > 0) {
                const existingNames = new Set(nesmaTableData.map(r => r.funcName?.toLowerCase().trim()));
                const newData = res.data.tableData.filter(r => !existingNames.has(r.funcName?.toLowerCase().trim()));

                if (newData.length > 0) {
                    // ── 智能模块插入：将每个新功能点插入到对应模块的末尾 ──
                    // 辅助函数：获取功能点的各级模块标识
                    const getModuleKey = (r, level) => {
                        const l1 = (r.level1 || r.funcModule || '').trim();
                        const l2 = (r.level2 || r.subFunction || '').trim();
                        const l3 = (r.level3 || '').trim();
                        if (level === 3) return `${l1}|||${l2}|||${l3}`;
                        if (level === 2) return `${l1}|||${l2}`;
                        return l1;
                    };

                    // 对现有数据建立索引：每个模块key对应的最后一条记录的索引
                    const buildLastIndexMap = (data) => {
                        const map3 = {}, map2 = {}, map1 = {};
                        data.forEach((r, idx) => {
                            const k3 = getModuleKey(r, 3);
                            const k2 = getModuleKey(r, 2);
                            const k1 = getModuleKey(r, 1);
                            if (k3) map3[k3] = idx;
                            if (k2) map2[k2] = idx;
                            if (k1) map1[k1] = idx;
                        });
                        return { map3, map2, map1 };
                    };

                    // 逐条插入新功能点到对应模块位置
                    let mergedData = [...nesmaTableData];
                    let insertedCount = 0;

                    for (const newRow of newData) {
                        // 重建索引（因为每次插入后位置会变化）
                        const { map3, map2, map1 } = buildLastIndexMap(mergedData);
                        const k3 = getModuleKey(newRow, 3);
                        const k2 = getModuleKey(newRow, 2);
                        const k1 = getModuleKey(newRow, 1);

                        // 按三级 → 二级 → 一级 → 末尾 优先顺序查找插入点
                        let insertAfterIdx = -1;
                        if (k3 && map3[k3] !== undefined) {
                            insertAfterIdx = map3[k3];
                        } else if (k2 && map2[k2] !== undefined) {
                            insertAfterIdx = map2[k2];
                        } else if (k1 && map1[k1] !== undefined) {
                            insertAfterIdx = map1[k1];
                        }

                        const rowWithId = { ...newRow, id: String(mergedData.length + 1) };
                        if (insertAfterIdx >= 0) {
                            mergedData.splice(insertAfterIdx + 1, 0, rowWithId);
                        } else {
                            mergedData.push(rowWithId);
                        }
                        insertedCount++;
                    }

                    // 重新整理id顺序
                    mergedData.forEach((r, i) => { r.id = String(i + 1); });
                    const updatedData = mergedData;
                    setNesmaTableData(updatedData);
                    const totalFP = updatedData.reduce((sum, r) => sum + (r.fpCount || 0), 0);

                    setMessages(prev => {
                        const filtered = prev.filter(m => !m.content.startsWith('🔄 **补充提取中'));
                        return [...filtered, {
                            role: 'assistant',
                            content: `🎉 **补充提取完成！**\n\n- 新增 **${newData.length}** 个功能点\n- 总计 **${updatedData.length}** 个功能点 / **${totalFP}** UFP\n\n可继续点击 **「覆盖度验证」** 再次检查。`,
                            showActions: true
                        }];
                    });
                    setCoverageResult(null);
                } else {
                    setMessages(prev => [...prev, {
                        role: 'assistant',
                        content: '⚠️ 补充的功能点与已有数据重复，未产生新数据。'
                    }]);
                }
            } else {
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: '⚠️ 补充提取未发现新的功能点。'
                }]);
            }
        } catch (error) {
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `❌ 补充提取失败: ${error.response?.data?.error || error.message}`
            }]);
        } finally {
            setIsLoading(false);
        }
    };

    // ═══════════ 导出Excel ═══════════
    const exportExcel = async () => {
        if (nesmaTableData.length === 0) { showToast('没有可导出的数据'); return; }
        try {
            const response = await axios.post('/api/nesma/export-excel',
                { tableData: nesmaTableData, filename: `NESMA功能点_${documentName || '结果'}` },
                { responseType: 'blob' }
            );
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.download = `NESMA功能点_${documentName || '结果'}.xlsx`;
            link.click();
            window.URL.revokeObjectURL(url);
            showToast('Excel导出成功');
        } catch (error) {
            showToast('导出失败: ' + error.message);
        }
    };

    const copyContent = (content) => {
        navigator.clipboard.writeText(content);
        setCopied(true);
        showToast('已复制到剪贴板');
        setTimeout(() => setCopied(false), 2000);
    };

    const clearChat = () => {
        setMessages([]);
        setNesmaTableData([]);
        setDocumentContent('');
        setDocumentName('');
        setCurrentStep(0);
        setIsWaitingForAnalysis(false);
        setChapters([]);
        setCoverageResult(null);
        setModuleStructure(null);
        setQuantityPlan(null);
    };

    const stopAnalysis = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            setIsLoading(false);
            showToast('分析已停止');
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            // For NESMA, Enter sends a chat message (not implemented here, just prevent)
        }
    };

    // ═══════════ 表格编辑 ═══════════
    const updateTableRow = (index, field, value) => {
        setNesmaTableData(prev => {
            const updated = [...prev];
            updated[index] = { ...updated[index], [field]: value };
            // 自动计算功能点数
            if (field === 'category' || field === 'complexity') {
                const cat = field === 'category' ? value : updated[index].category;
                const comp = field === 'complexity' ? value : updated[index].complexity;
                if (FP_WEIGHTS[cat] && FP_WEIGHTS[cat][comp]) {
                    updated[index].fpCount = FP_WEIGHTS[cat][comp];
                }
            }
            // 自动计算AFP（调整后功能点）
            if (field === 'category' || field === 'complexity' || field === 'reuseLevel') {
                const rl = field === 'reuseLevel' ? value : updated[index].reuseLevel || '低';
                const coeff = REUSE_COEFFICIENTS[rl] || 1.0;
                const fp = updated[index].fpCount || 0;
                updated[index].afp = Math.round(fp * coeff * 1000) / 1000;
            }
            return updated;
        });
    };

    const deleteTableRow = (index) => {
        setNesmaTableData(prev => prev.filter((_, i) => i !== index));
        showToast('已删除功能点');
    };

    const addTableRow = () => {
        setNesmaTableData(prev => [...prev, {
            id: String(prev.length + 1),
            level1: '', level2: '', level3: '',
            funcModule: '', subFunction: '', funcName: '', category: 'EI', complexity: '低',
            fpCount: 3, det: 0, retFtr: 0,
            reuseLevel: '低', afp: 3, modType: '新增',
            funcDescription: '', interfaceDescription: ''
        }]);
    };

    // ═══════════ 统计计算 ═══════════
    const getStats = () => {
        const catCounts = {};
        let totalFP = 0;
        let totalAFP = 0;
        nesmaTableData.forEach(r => {
            catCounts[r.category] = (catCounts[r.category] || 0) + 1;
            totalFP += r.fpCount || 0;
            const coeff = REUSE_COEFFICIENTS[r.reuseLevel || '低'] || 1.0;
            totalAFP += (r.fpCount || 0) * coeff;
        });
        totalAFP = Math.round(totalAFP * 100) / 100;
        return { catCounts, totalFP, totalAFP };
    };

    // ═══════════ 渲染 ═══════════
    const { catCounts, totalFP, totalAFP } = getStats();

    return (
        <>
            {/* Toast (only if no external) */}
            {!externalShowToast && toastMessage && <div className="toast">{toastMessage}</div>}

            {/* ═══ Main Content ═══ */}
            <div className="main-content">
                {/* Top Bar */}
                <div className="top-bar">
                    <div className="top-bar-left">
                        <span className="top-bar-title">NESMA 功能点智能拆分</span>
                        {nesmaTableData.length > 0 && (
                            <span className="top-bar-badge nesma-badge">
                                {nesmaTableData.length} 个功能点 · UFP:{totalFP} · AFP:{totalAFP}
                            </span>
                        )}
                    </div>
                    <div className="top-bar-right">
                        {nesmaTableData.length > 0 && (
                            <>
                                <button className="btn btn-secondary btn-sm" onClick={() => setShowTableView(true)}>
                                    <Table size={14} /> 查看表格
                                </button>
                                <button className="btn btn-success btn-sm" onClick={exportExcel}>
                                    <Download size={14} /> 导出Excel
                                </button>
                            </>
                        )}
                        <button className="btn btn-ghost btn-icon" onClick={clearChat} title="清空对话">
                            <Trash2 size={16} />
                        </button>
                    </div>
                </div>

                {/* Document Info Bar */}
                {documentName && (
                    <div className="doc-info-bar">
                        <FileText size={14} style={{ color: 'var(--nesma-accent)' }} />
                        <span className="doc-info-name">{documentName}</span>
                        <span className="doc-info-stats">{documentContent.length} 字符</span>
                        <div className="doc-info-actions">
                            <button className="btn btn-ghost btn-sm" onClick={() => setShowPreview(true)}>
                                <Eye size={13} /> 预览
                            </button>
                        </div>
                    </div>
                )}

                {/* Error Banner */}
                {errorMessage && (
                    <div className="error-banner">
                        <AlertCircle size={16} />
                        {errorMessage}
                        <button className="btn btn-ghost btn-sm" onClick={() => setErrorMessage('')} style={{ marginLeft: 'auto' }}>
                            <X size={14} />
                        </button>
                    </div>
                )}

                {/* Upload Progress */}
                {uploadProgress > 0 && uploadProgress < 100 && (
                    <div style={{ padding: '0 24px' }}>
                        <div className="progress-bar-container">
                            <div className="progress-bar nesma-progress" style={{ width: `${uploadProgress}%` }} />
                        </div>
                    </div>
                )}

                {/* Chat Area */}
                <div className="chat-area">
                    {messages.length === 0 && !documentContent ? (
                        /* Welcome Screen */
                        <div className="welcome-screen">
                            <div className="welcome-icon nesma-welcome-icon">📐</div>
                            <h1 className="welcome-title nesma-title">NESMA 功能点拆分系统</h1>
                            <p className="welcome-subtitle">
                                基于AI大模型的NESMA功能点分析工具，自动将需求文档拆分为标准的ILF/EIF/EI/EO/EQ功能点清单
                            </p>
                            <div className="welcome-features">
                                <div className="welcome-feature">
                                    <div className="welcome-feature-icon nesma-feat-1"><FileText size={18} /></div>
                                    <h3>智能文档解析</h3>
                                    <p>支持 .docx, .txt, .md 格式，自动提取功能描述</p>
                                </div>
                                <div className="welcome-feature">
                                    <div className="welcome-feature-icon nesma-feat-2"><Brain size={18} /></div>
                                    <h3>NESMA标准拆分</h3>
                                    <p>ILF/EIF/EI/EO/EQ五类功能点，带复杂度和权重</p>
                                </div>
                                <div className="welcome-feature">
                                    <div className="welcome-feature-icon nesma-feat-3"><BarChart3 size={18} /></div>
                                    <h3>子功能→功能过程</h3>
                                    <p>按子功能展开完整功能过程，增删改查全覆盖</p>
                                </div>
                            </div>

                            {/* Upload Zone */}
                            <div
                                ref={dropZoneRef}
                                className={`upload-zone ${isDragging ? 'dragging' : ''}`}
                                onClick={() => fileInputRef.current?.click()}
                                onDragEnter={handleDragEnter}
                                onDragLeave={handleDragLeave}
                                onDragOver={handleDragOver}
                                onDrop={handleDrop}
                            >
                                <div className="upload-zone-icon">📂</div>
                                <h3>上传需求文档</h3>
                                <p>拖拽文件到此处，或点击选择文件</p>
                                <p style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>支持 .docx, .txt, .md 格式</p>
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".docx,.txt,.md"
                                onChange={handleFileSelect}
                                style={{ display: 'none' }}
                            />
                        </div>
                    ) : (
                        /* Messages */
                        <>
                            <AnalysisProgressPanel />
                            {messages.map((msg, idx) => (
                                <div key={idx} className={`message ${msg.role}`}>
                                    <div className="message-avatar">
                                        {msg.role === 'assistant' ? <Bot size={16} /> :
                                            msg.role === 'user' ? <User size={16} /> :
                                                <Info size={16} />}
                                    </div>
                                    <div className="message-content">
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                                        {msg.showActions && nesmaTableData.length > 0 && (
                                            <div className="result-actions">
                                                <button className="btn btn-primary btn-sm nesma-btn" onClick={() => setShowTableView(true)}>
                                                    <Table size={14} /> 查看表格
                                                </button>
                                                <button className="btn btn-success btn-sm" onClick={exportExcel}>
                                                    <Download size={14} /> 导出Excel
                                                </button>
                                                <button className="btn btn-secondary btn-sm" onClick={verifyCoverage} disabled={isVerifying || isLoading}>
                                                    {isVerifying ? <Loader2 size={14} className="spinner" /> : <Target size={14} />} 覆盖度验证
                                                </button>
                                            </div>
                                        )}
                                        {msg.showCoverageActions && (
                                            <div className="result-actions">
                                                <button className="btn btn-primary btn-sm nesma-btn" onClick={extractSupplementary} disabled={isLoading}>
                                                    <Plus size={14} /> 补充提取
                                                </button>
                                                <button className="btn btn-secondary btn-sm" onClick={verifyCoverage} disabled={isVerifying || isLoading}>
                                                    <RefreshCw size={14} /> 重新验证
                                                </button>
                                            </div>
                                        )}
                                        {msg.showChapterActions && chapters.length > 0 && (
                                            <div className="result-actions">
                                                <button className="btn btn-secondary btn-sm" onClick={() => setShowChapterView(true)}>
                                                    <Eye size={14} /> 查看/编辑章节
                                                </button>
                                                <button className="btn btn-primary btn-sm nesma-btn" onClick={() => startNesmaExtraction()} disabled={isLoading}>
                                                    <Target size={14} /> 确认·开始NESMA提取
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {isLoading && (
                                <div className="message assistant">
                                    <div className="message-avatar"><Bot size={16} /></div>
                                    <div className="message-content" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Loader2 size={16} className="spinner" />
                                        <span>AI 正在分析...</span>
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </>
                    )}
                </div>

                {/* Input Area */}
                <div className="input-area">
                    {documentContent && (
                        <div className="input-actions" style={{ marginBottom: 8 }}>
                            {/* ── 模式切换行 ── */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>提取模式：</span>
                                <button onClick={() => setExtractionMode('precise')} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, border: 'none', cursor: 'pointer', background: extractionMode === 'precise' ? 'var(--nesma-accent)' : 'var(--bg-tertiary)', color: extractionMode === 'precise' ? '#fff' : 'var(--text-secondary)', fontWeight: extractionMode === 'precise' ? 600 : 400, transition: 'all 0.15s' }}>🎯 精准模式</button>
                                <button onClick={() => setExtractionMode('quantity')} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, border: 'none', cursor: 'pointer', background: extractionMode === 'quantity' ? '#f59e0b' : 'var(--bg-tertiary)', color: extractionMode === 'quantity' ? '#fff' : 'var(--text-secondary)', fontWeight: extractionMode === 'quantity' ? 600 : 400, transition: 'all 0.15s' }}>📊 数量优先</button>
                                <button onClick={() => setExtractionMode('guochanhua')} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, border: 'none', cursor: 'pointer', background: extractionMode === 'guochanhua' ? '#10b981' : 'var(--bg-tertiary)', color: extractionMode === 'guochanhua' ? '#fff' : 'var(--text-secondary)', fontWeight: extractionMode === 'guochanhua' ? 600 : 400, transition: 'all 0.15s' }}>🏗️ 国产化迁移</button>
                                {extractionMode === 'quantity' && (
                                    <>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: '3px 8px' }}>
                                            <span style={{ fontSize: 11, color: '#f59e0b', whiteSpace: 'nowrap' }}>目标总数：</span>
                                            <input
                                                type="number" min={50} max={9999} step={50}
                                                value={totalTargetCount}
                                                onChange={e => setTotalTargetCount(Math.max(50, Math.min(9999, parseInt(e.target.value) || 300)))}
                                                style={{ width: 70, padding: '1px 4px', fontSize: 13, border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4, background: 'transparent', color: '#d97706', fontWeight: 700, textAlign: 'center', outline: 'none' }}
                                            />
                                            <span style={{ fontSize: 11, color: '#f59e0b' }}>个</span>
                                        </div>
                                        {quantityPlan && (
                                            <button
                                                onClick={() => setShowQuantityPlan(true)}
                                                style={{ padding: '3px 10px', borderRadius: 8, fontSize: 11, border: '1px solid rgba(245,158,11,0.5)', cursor: 'pointer', background: 'rgba(245,158,11,0.15)', color: '#f59e0b', fontWeight: 600, transition: 'all 0.15s', whiteSpace: 'nowrap' }}
                                            >
                                                📋 调整规划（{quantityPlan.length}个模块）
                                            </button>
                                        )}
                                        <span style={{ fontSize: 11, color: '#f59e0b' }}>⚡ 系统将按模块比例分配目标，全面展开CRUD</span>
                                    </>
                                )}
                                {extractionMode === 'precise' && (
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>严格按文档内容提取，分类精准</span>
                                )}
                                {extractionMode === 'guochanhua' && (
                                    <span style={{ fontSize: 11, color: '#10b981' }}>🏗️ 标准NESMA功能点 + 7大国产化迁移维度（采集/ETL/汇总/接口/流程/前端/报表）</span>
                                )}
                            </div>

                            <div className="input-actions-left">
                                {currentStep === 0 && (
                                    <button
                                        className="btn btn-primary nesma-btn"
                                        onClick={startChapterRecognition}
                                        disabled={isLoading}
                                    >
                                        <Target size={14} /> 开始NESMA功能点拆分
                                    </button>
                                )}
                                {currentStep === 2 && chapters.length > 0 && !isLoading && (
                                    <>
                                        <button className="btn btn-secondary" onClick={() => setShowChapterView(true)}>
                                            <Eye size={14} /> 查看/编辑章节
                                        </button>
                                        <button className="btn btn-primary nesma-btn" onClick={() => startNesmaExtraction()} disabled={isLoading}>
                                            <Target size={14} /> 确认·开始NESMA提取
                                        </button>
                                    </>
                                )}
                                {currentStep === 3 && !isLoading && (
                                    <>
                                        <button className="btn btn-secondary" onClick={() => setShowEditModal(true)}>
                                            <Edit3 size={14} /> 编辑功能点表格
                                        </button>
                                        <button className="btn btn-primary nesma-btn" onClick={startChapterRecognition} disabled={isLoading}>
                                            <RefreshCw size={14} /> 重新提取
                                        </button>
                                    </>
                                )}
                                {isLoading && (
                                    <button className="btn btn-secondary btn-sm" onClick={stopAnalysis}>
                                        <X size={14} /> 停止分析
                                    </button>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: 4 }}>
                                {nesmaTableData.length > 0 && !isLoading && currentStep === 3 && (
                                    <button className="btn btn-secondary btn-sm" onClick={verifyCoverage} disabled={isVerifying}>
                                        {isVerifying ? <Loader2 size={13} className="spinner" /> : <Target size={13} />} 覆盖度验证
                                    </button>
                                )}
                                {documentContent && !isLoading && currentStep === 0 && (
                                    <button className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()}>
                                        <RefreshCw size={13} /> 重新上传
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Hidden file input */}
                    <input ref={fileInputRef} type="file" accept=".docx,.txt,.md" onChange={handleFileSelect} style={{ display: 'none' }} />
                </div>
            </div>

            {/* ═══ Chapter Selection Modal ═══ */}
            {showChapterView && (
                <div className="table-view-overlay" onClick={() => setShowChapterView(false)}>
                    <div className="table-view-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 700 }}>
                        <div className="table-view-header">
                            <h2><FileText size={18} /> 章节列表</h2>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                    已选 {chapters.filter(ch => ch.selected).length}/{chapters.length} 章节
                                </span>
                                <button className="btn btn-ghost btn-sm" onClick={() => {
                                    const allSelected = chapters.every(ch => ch.selected);
                                    setChapters(prev => prev.map(ch => ({ ...ch, selected: !allSelected })));
                                }}>
                                    {chapters.every(ch => ch.selected) ? '取消全选' : '全选'}
                                </button>
                                <button className="btn btn-ghost btn-icon" onClick={() => setShowChapterView(false)}>
                                    <X size={18} />
                                </button>
                            </div>
                        </div>
                        <div className="table-view-body" style={{ padding: 16 }}>
                            {chapters.map((ch, idx) => (
                                <div
                                    key={idx}
                                    style={{
                                        display: 'flex', alignItems: 'flex-start', gap: 12,
                                        padding: '12px 16px', borderRadius: 'var(--radius-sm)',
                                        border: `1px solid ${ch.selected ? 'var(--border-active)' : 'var(--border-subtle)'}`,
                                        background: ch.selected ? 'rgba(13, 79, 139, 0.03)' : 'transparent',
                                        marginBottom: 8, cursor: 'pointer', transition: 'all 0.15s ease'
                                    }}
                                    onClick={() => toggleChapter(idx)}
                                >
                                    <input type="checkbox" checked={ch.selected} onChange={() => toggleChapter(idx)}
                                        style={{ marginTop: 3, cursor: 'pointer', accentColor: 'var(--nesma-accent)' }} />
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>
                                            {idx + 1}. {ch.title}
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ch.charCount} 字</div>
                                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5, maxHeight: 60, overflow: 'hidden' }}>
                                            {ch.content.substring(0, 200)}...
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                            <button className="btn btn-secondary" onClick={() => setShowChapterView(false)}>关闭</button>
                            <button className="btn btn-primary nesma-btn" onClick={() => { setShowChapterView(false); startNesmaExtraction(); }}
                                disabled={chapters.filter(ch => ch.selected).length === 0}>
                                <Target size={14} /> 确认·开始NESMA提取 ({chapters.filter(ch => ch.selected).length}个章节)
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ NESMA Table View Modal ═══ */}
            {showTableView && (
                <div className="table-view-overlay" onClick={() => setShowTableView(false)}>
                    <div className="table-view-panel" onClick={e => e.stopPropagation()}>
                        <div className="table-view-header">
                            <h2><Table size={18} /> NESMA 功能点清单</h2>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                <div className="table-view-stats">
                                    <div className="table-stat">功能点: <span className="table-stat-value">{nesmaTableData.length}</span></div>
                                    <div className="table-stat">UFP: <span className="table-stat-value">{totalFP}</span></div>
                                    <div className="table-stat">AFP: <span className="table-stat-value" style={{color:'var(--nesma-accent)'}}>{totalAFP}</span></div>
                                    {['ILF', 'EIF', 'EI', 'EO', 'EQ'].map(cat => (
                                        <div key={cat} className="table-stat">
                                            <span className={`nesma-cat-badge cat-${cat.toLowerCase()}`} style={{ width: 32, height: 20, fontSize: 9 }}>{cat}</span>
                                            {catCounts[cat] || 0}
                                        </div>
                                    ))}
                                </div>
                                <button className="btn btn-success btn-sm" onClick={exportExcel}>
                                    <Download size={14} /> 导出Excel
                                </button>
                                <button className="btn btn-ghost btn-icon" onClick={() => setShowTableView(false)}>
                                    <X size={18} />
                                </button>
                            </div>
                        </div>
                        <div className="table-view-body">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th style={{ width: '3%' }}>#</th>
                                        <th style={{ width: '10%' }}>一级模块</th>
                                        <th style={{ width: '10%' }}>二级模块</th>
                                        <th style={{ width: '9%' }}>三级模块</th>
                                        <th style={{ width: '13%' }}>业务功能</th>
                                        <th style={{ width: '5%' }}>类型</th>
                                        {nesmaTableData.some(r => r.migrationDimension && r.migrationDimension !== '原有业务' && r.migrationDimension !== '') && (
                                            <th style={{ width: '9%', color: '#10b981' }}>🏗️ 迁移维度</th>
                                        )}
                                        <th style={{ width: '16%' }}>功能需求描述</th>
                                        <th style={{ width: '12%' }}>外部接口需求描述</th>
                                        <th style={{ width: '4%' }}>UFP</th>
                                        <th style={{ width: '4%' }}>AFP</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {nesmaTableData.map((row, idx) => {
                                        const hasMigrationCol = nesmaTableData.some(r => r.migrationDimension && r.migrationDimension !== '原有业务' && r.migrationDimension !== '');
                                        const l1 = row.level1 || row.funcModule || '';
                                        const prevL1 = idx > 0 ? (nesmaTableData[idx-1].level1 || nesmaTableData[idx-1].funcModule || '') : '';
                                        const showL1 = (l1 && l1 !== '无' && l1 !== prevL1) ? l1 : '';
                                        const l2 = row.level2 || row.subFunction || '';
                                        const prevL2 = idx > 0 ? (nesmaTableData[idx-1].level2 || nesmaTableData[idx-1].subFunction || '') : '';
                                        const showL2 = (l2 && l2 !== '无' && l2 !== prevL2) ? l2 : '';
                                        const l3 = row.level3 || row.level4 || '';
                                        const prevL3 = idx > 0 ? (nesmaTableData[idx-1].level3 || nesmaTableData[idx-1].level4 || '') : '';
                                        const showL3 = (l3 && l3 !== '无' && l3 !== prevL3) ? l3 : '';

                                        // 迁移维度颜色映射
                                        const migDimColors = {
                                            '采集数据迁移': '#0ea5e9',
                                            'ETL迁移配置': '#8b5cf6',
                                            '数据汇总迁移': '#f59e0b',
                                            '外部接口迁移': '#ef4444',
                                            '流程引擎迁移': '#ec4899',
                                            '前端应用迁移': '#14b8a6',
                                            '报表引擎迁移': '#f97316',
                                            '原有业务': 'var(--text-muted)',
                                        };
                                        const migDim = row.migrationDimension || '';
                                        const migColor = migDimColors[migDim] || '#10b981';
                                        const isMigration = migDim && migDim !== '原有业务' && migDim !== '';

                                        return (
                                        <tr key={idx} style={isMigration ? { background: 'rgba(16,185,129,0.03)' } : {}}>
                                            <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{row.id || idx + 1}</td>
                                            <td style={{ fontWeight: showL1 ? 600 : 400, color: showL1 ? 'var(--nesma-accent)' : 'transparent', fontSize: 12 }}>{showL1 || '—'}</td>
                                            <td style={{ fontWeight: showL2 ? 600 : 400, color: showL2 ? 'var(--text-primary)' : 'transparent', fontSize: 12 }}>{showL2 || '—'}</td>
                                            <td style={{ fontWeight: showL3 ? 600 : 400, color: showL3 ? '#6366f1' : 'transparent', fontSize: 12 }}>{showL3 || '—'}</td>
                                            <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{row.funcName}</td>
                                            <td style={{ textAlign: 'center' }}>
                                                <span className={`nesma-cat-badge cat-${row.category?.toLowerCase()}`}>{row.category}</span>
                                            </td>
                                            {hasMigrationCol && (
                                                <td style={{ textAlign: 'center' }}>
                                                    {isMigration ? (
                                                        <span style={{
                                                            display: 'inline-block', padding: '2px 6px', borderRadius: 10,
                                                            fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                                                            background: `${migColor}20`, color: migColor,
                                                            border: `1px solid ${migColor}40`
                                                        }}>{migDim}</span>
                                                    ) : (
                                                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>原有业务</span>
                                                    )}
                                                </td>
                                            )}
                                            <td style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{row.funcDescription || ''}</td>
                                            <td style={{ fontSize: 11, color: row.interfaceDescription && row.interfaceDescription !== '无' ? '#0891b2' : 'var(--text-muted)', lineHeight: 1.4 }}>{row.interfaceDescription && row.interfaceDescription !== '无' ? row.interfaceDescription : '—'}</td>
                                            <td style={{ textAlign: 'center', fontWeight: 600, fontSize: 11 }}>{row.fpCount}</td>
                                            <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--nesma-accent)', fontSize: 11 }}>{row.afp != null ? row.afp : row.fpCount}</td>
                                        </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}


            {/* ═══ Document Preview Modal ═══ */}
            {showPreview && (
                <div className="preview-overlay" onClick={() => setShowPreview(false)}>
                    <div className="preview-panel" onClick={e => e.stopPropagation()}>
                        <div className="preview-header">
                            <h2>📄 {documentName}</h2>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="btn btn-ghost btn-sm" onClick={() => copyContent(documentContent)}>
                                    {copied ? <Check size={13} /> : <Copy size={13} />} 复制
                                </button>
                                <button className="btn btn-ghost btn-icon" onClick={() => setShowPreview(false)}>
                                    <X size={16} />
                                </button>
                            </div>
                        </div>
                        <div className="preview-body">{documentContent}</div>
                    </div>
                </div>
            )}

            {/* ═══ Edit Table Modal ═══ */}
            {showEditModal && (
                <div className="function-list-panel" onClick={() => setShowEditModal(false)}>
                    <div className="func-editor-container" onClick={e => e.stopPropagation()}>
                        <div className="func-editor-header">
                            <div className="func-editor-header-left">
                                <h2><Edit3 size={18} /> NESMA功能点编辑</h2>
                                <span className="func-editor-count">
                                    共 {nesmaTableData.length} 个功能点 · UFP:{totalFP} · AFP:{totalAFP}
                                </span>
                            </div>
                            <div className="func-editor-header-right">
                                <button className="btn btn-secondary btn-sm" onClick={addTableRow}>
                                    <Plus size={14} /> 新增功能点
                                </button>
                                <button className="btn btn-ghost btn-icon" onClick={() => setShowEditModal(false)}>
                                    <X size={18} />
                                </button>
                            </div>
                        </div>

                        <div className="func-editor-table-header">
                            <div className="func-col" style={{ width: 32, textAlign: 'center' }}>#</div>
                            <div className="func-col" style={{ width: 110 }}>一级模块</div>
                            <div className="func-col" style={{ width: 110 }}>二级模块</div>
                            <div className="func-col" style={{ width: 110 }}>三级模块</div>
                            <div className="func-col" style={{ flex: 1, minWidth: 120 }}>业务功能</div>
                            <div className="func-col" style={{ width: 64 }}>类型</div>
                            <div className="func-col" style={{ width: 180 }}>功能需求描述</div>
                            <div className="func-col" style={{ width: 42 }}>UFP</div>
                            <div className="func-col" style={{ width: 42 }}>AFP</div>
                            <div className="func-col" style={{ width: 36, textAlign: 'center' }}>操作</div>
                        </div>

                        <div className="func-editor-body">
                            {nesmaTableData.map((row, idx) => (
                                <div key={idx} className="func-editor-row">
                                    <div className="func-col" style={{ width: 32, textAlign: 'center' }}>
                                        <span className="func-idx-badge">{idx + 1}</span>
                                    </div>
                                    <div className="func-col" style={{ width: 110 }}>
                                        <input className="func-input" value={row.level1 || row.funcModule || ''} onChange={e => { updateTableRow(idx, 'level1', e.target.value); updateTableRow(idx, 'funcModule', e.target.value); }} placeholder="一级模块" />
                                    </div>
                                    <div className="func-col" style={{ width: 110 }}>
                                        <input className="func-input" value={row.level2 || row.subFunction || ''} onChange={e => { updateTableRow(idx, 'level2', e.target.value); updateTableRow(idx, 'subFunction', e.target.value); }} placeholder="二级模块" />
                                    </div>
                                    <div className="func-col" style={{ width: 110 }}>
                                        <input className="func-input" value={row.level3 || ''} onChange={e => updateTableRow(idx, 'level3', e.target.value)} placeholder="三级模块" />
                                    </div>
                                    <div className="func-col" style={{ flex: 1, minWidth: 120 }}>
                                        <input className="func-input func-input-name" value={row.funcName || ''} onChange={e => updateTableRow(idx, 'funcName', e.target.value)} placeholder="业务功能" />
                                    </div>
                                    <div className="func-col" style={{ width: 64 }}>
                                        <select className="func-select" value={row.category || 'EI'} onChange={e => updateTableRow(idx, 'category', e.target.value)}>
                                            <option value="ILF">ILF</option>
                                            <option value="EIF">EIF</option>
                                            <option value="EI">EI</option>
                                            <option value="EO">EO</option>
                                            <option value="EQ">EQ</option>
                                        </select>
                                    </div>
                                    <div className="func-col" style={{ width: 180 }}>
                                        <input className="func-input" value={row.funcDescription || ''} onChange={e => updateTableRow(idx, 'funcDescription', e.target.value)} placeholder="功能需求描述" />
                                    </div>
                                    <div className="func-col" style={{ width: 42, textAlign: 'center', fontWeight: 600, fontSize: 11 }}>
                                        {row.fpCount || 0}
                                    </div>
                                    <div className="func-col" style={{ width: 42, textAlign: 'center', fontWeight: 700, color: 'var(--nesma-accent)', fontSize: 11 }}>
                                        {row.afp != null ? row.afp : row.fpCount || 0}
                                    </div>
                                    <div className="func-col" style={{ width: 36, textAlign: 'center' }}>
                                        <button className="func-action-btn danger" title="删除" onClick={() => deleteTableRow(idx)}>
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="func-editor-footer">
                            <div className="func-editor-footer-info">
                                <Info size={14} style={{ color: 'var(--text-muted)' }} />
                                <span>修改类别/重用程度会自动重新计算 · UFP权重(低复杂度): ILF(7) EIF(5) EI(3) EO(4) EQ(3) · 重用系数: 低(1.0) 中(0.667) 高(0.333) · AFP = UFP × 重用系数</span>
                            </div>
                            <div className="func-editor-footer-actions">
                                <button className="btn btn-secondary" onClick={() => setShowEditModal(false)}>关闭</button>
                                <button className="btn btn-primary nesma-btn" onClick={() => { setShowEditModal(false); showToast('功能点数据已更新'); }}>
                                    <Save size={14} /> 保存修改
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ 数量规划弹窗 ═══ */}
            {showQuantityPlan && quantityPlan && (
                <div className="table-view-overlay" onClick={() => setShowQuantityPlan(false)}>
                    <div className="table-view-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 760 }}>
                        <div className="table-view-header">
                            <h2>📊 数量优先·模块规划</h2>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                    共 {quantityPlan.length} 个三级模块 · 目标合计&nbsp;
                                    <strong style={{ color: '#f59e0b' }}>{quantityPlan.reduce((s, p) => s + p.target, 0)}</strong> 个功能点
                                </span>
                                <button className="btn btn-ghost btn-icon" onClick={() => setShowQuantityPlan(false)}>
                                    <X size={18} />
                                </button>
                            </div>
                        </div>

                        {/* 总量重新分配工具栏 */}
                        <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'rgba(245,158,11,0.04)' }}>
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>重新按总目标数平均分配：</span>
                            <input
                                type="number" min={50} max={3000} step={50}
                                value={totalTargetCount}
                                onChange={e => setTotalTargetCount(Math.max(10, parseInt(e.target.value) || 200))}
                                style={{ width: 80, padding: '3px 6px', fontSize: 13, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', textAlign: 'center' }}
                            />
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>个</span>
                            <button
                                onClick={() => {
                                    const mods = quantityPlan;
                                    const totalEst = mods.reduce((s, m) => s + (m.estimated || 15), 0) || 1;
                                    const plan = mods.map(m => ({
                                        ...m,
                                        target: Math.max(8, Math.round((m.estimated || 15) / totalEst * totalTargetCount))
                                    }));
                                    const planSum = plan.reduce((s, p) => s + p.target, 0);
                                    if (plan.length > 0) {
                                        const maxIdx = plan.reduce((mi, p, i) => p.target > plan[mi].target ? i : mi, 0);
                                        plan[maxIdx].target += totalTargetCount - planSum;
                                        if (plan[maxIdx].target < 8) plan[maxIdx].target = 8;
                                    }
                                    setQuantityPlan(plan);
                                }}
                                style={{ padding: '4px 14px', borderRadius: 8, fontSize: 12, border: 'none', cursor: 'pointer', background: '#f59e0b', color: '#fff', fontWeight: 600 }}
                            >
                                🔄 按比例重新分配
                            </button>
                            <button
                                onClick={() => {
                                    const n = quantityPlan.length;
                                    const base = Math.floor(totalTargetCount / n);
                                    const rem = totalTargetCount - base * n;
                                    setQuantityPlan(prev => prev.map((m, i) => ({ ...m, target: base + (i === 0 ? rem : 0) })));
                                }}
                                style={{ padding: '4px 14px', borderRadius: 8, fontSize: 12, border: '1px solid var(--border-subtle)', cursor: 'pointer', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', fontWeight: 500 }}
                            >
                                均分
                            </button>
                        </div>

                        <div className="table-view-body" style={{ padding: '12px 20px' }}>
                            {/* 表头 */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 2fr 80px 80px', gap: 8, padding: '6px 8px', background: 'var(--bg-tertiary)', borderRadius: 6, marginBottom: 6, fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                                <div>一级模块</div>
                                <div>二级模块</div>
                                <div>三级模块</div>
                                <div>业务对象</div>
                                <div style={{ textAlign: 'center' }}>预估</div>
                                <div style={{ textAlign: 'center' }}>目标数量</div>
                            </div>
                            {quantityPlan.map((mod, idx) => (
                                <div
                                    key={idx}
                                    style={{
                                        display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 2fr 80px 80px',
                                        gap: 8, padding: '7px 8px', borderRadius: 6,
                                        background: idx % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.02)',
                                        border: '1px solid transparent',
                                        transition: 'border-color 0.15s',
                                        alignItems: 'center',
                                        marginBottom: 2
                                    }}
                                    onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(245,158,11,0.2)'}
                                    onMouseLeave={e => e.currentTarget.style.borderColor = 'transparent'}
                                >
                                    <div style={{ fontSize: 11, color: 'var(--nesma-accent)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mod.level1}>{mod.level1}</div>
                                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mod.level2}>{mod.level2}</div>
                                    <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mod.level3}>{mod.level3}</div>
                                    <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(mod.businessObjects || []).join('、')}>{(mod.businessObjects || []).join('、') || '-'}</div>
                                    <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>~{mod.estimated || '?'}</div>
                                    <div style={{ textAlign: 'center' }}>
                                        <input
                                            type="number" min={1} max={500}
                                            value={mod.target}
                                            onChange={e => {
                                                const val = Math.max(1, parseInt(e.target.value) || 1);
                                                setQuantityPlan(prev => prev.map((m, i) => i === idx ? { ...m, target: val } : m));
                                            }}
                                            style={{
                                                width: 60, padding: '2px 4px', fontSize: 12,
                                                border: '1px solid rgba(245,158,11,0.4)', borderRadius: 6,
                                                background: 'rgba(245,158,11,0.08)', color: '#d97706',
                                                fontWeight: 700, textAlign: 'center'
                                            }}
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                💡 目标数量越大，AI会对该模块展开更多功能点细节
                            </span>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="btn btn-secondary" onClick={() => setShowQuantityPlan(false)}>关闭</button>
                                <button className="btn btn-primary nesma-btn" onClick={() => { setShowQuantityPlan(false); showToast('规划已保存，开始提取时将按此规划执行'); }}>
                                    <Save size={14} /> 保存规划
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default NesmaApp;
