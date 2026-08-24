import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
    Upload, FileText, Send, Download, Settings, Bot, User, Loader2,
    CheckCircle, AlertCircle, X, Trash2, Copy, Check, Eye, Table,
    Zap, Sparkles, Brain, ChevronDown, Plus, BarChart3, RefreshCw,
    FileSpreadsheet, Target, Info, Edit3, Scissors, GripVertical, Save,
    History, LogOut, BookOpen, GitBranch, Layers, Code2
} from 'lucide-react';
import NesmaApp from './NesmaApp';
import OfficeDocumentApp from './OfficeDocumentApp';
import HistoryPanel from './HistoryPanel';
import CodeSourceAnalyzer from './CodeSourceAnalyzer';
import SequenceDiagram, { generateAllDiagramImages } from './SequenceDiagram';
import {
    canonicalFunctionKey,
    deduplicateFunctionObjects,
    inheritMissingFunctionLevels,
    isReferenceOnlyChapterTitle,
    normalizeProcessOrderKey,
    orderCosmicTableData,
    allocateQuantityPlanToChapters
} from './cosmic-quality';
import {
    completedFunctionNames,
    createCosmicRunId,
    isUsableDocumentUnderstanding,
    resolveContinueAnalysisRound,
    runContinueAnalysisJob,
    runCosmicModuleRecognitionJob,
    runCosmicSplitJob,
    runDocumentUnderstandingJob,
    runFunctionExtractionJob
} from './cosmic-split-jobs';

const MAX_UPLOAD_MB = 300;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const COSMIC_EXCEL_IMPORT_TIMEOUT_MS = 20 * 60 * 1000;
// 与服务端 AI_MAX_CONCURRENCY=2 对齐，避免 Render 上快速模式同时压入过多长请求。
const COSMIC_FAST_CONCURRENCY = 2;
const COSMIC_LARGE_DOCUMENT_CHARS = 12000;
const COSMIC_LARGE_FUNCTION_COUNT = 40;
const COSMIC_MANY_CHAPTERS = 8;
const UNLIMITDS_MODEL_ALIAS = 'unlimitds-deepseek-v4-pro';

const resolveCosmicConcurrency = ({ mode, documentChars = 0, functionCount = 0, chapterCount = 0 }) => {
    const autoStabilized = mode === 'fast' && (
        documentChars >= COSMIC_LARGE_DOCUMENT_CHARS
        || functionCount >= COSMIC_LARGE_FUNCTION_COUNT
        || chapterCount >= COSMIC_MANY_CHAPTERS
    );
    return {
        concurrency: mode === 'fast' && !autoStabilized ? COSMIC_FAST_CONCURRENCY : 1,
        autoStabilized
    };
};
const COSMIC_EXCEL_IMPORT_STEPS = [
    { percent: 28, current: 2, phase: '读取工作簿', detail: '服务端正在读取 Excel 工作簿和工作表。' },
    { percent: 44, current: 3, phase: '识别表头和层级', detail: '正在识别 COSMIC 表头、模块层级和数据移动列。' },
    { percent: 62, current: 4, phase: '整理拆分结果', detail: '正在整理功能过程、ERWX 子过程和 CFP 统计。' },
    { percent: 78, current: 4, phase: '补齐功能描述', detail: '正在检查功能描述，必要时会调用 AI 或本地规则补齐。' },
    { percent: 91, current: 4, phase: '等待结果返回', detail: '服务端仍在处理，请保持页面打开，完成后会自动展示结果。' }
];

const initialAnalysisProgress = {
    visible: false,
    status: 'idle',
    title: '',
    phase: '',
    percent: 0,
    current: 0,
    total: 0,
    detail: '',
    stats: '',
    history: [],
    startedAt: 0,
    updatedAt: 0
};

const initialAiActivity = {
    visible: false,
    status: 'idle',
    startedAt: 0,
    endedAt: 0,
    steps: []
};

const formatActivityDuration = (durationMs = 0) => {
    const seconds = Math.max(0, durationMs) / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} 分 ${Math.round(seconds % 60)} 秒`;
};

const parseMarkdownHeading = (line) => {
    const match = String(line || '').match(/^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (!match) return null;
    const title = match[2].trim();
    if (title.length < 2 || title.length > 120) return null;
    return {
        title,
        depth: Math.min(match[1].length, 3)
    };
};

const stripHeadingNumber = (title) => {
    const markdownHeading = parseMarkdownHeading(title);
    return String(markdownHeading?.title || title || '')
    .trim()
    .replace(/^\d+(?:\.\d+)*[.、\s]*/, '')
    .trim();
};

const normalizeHeadingMatchText = (text) => String(text || '')
    .replace(/^\d+(?:\.\d+)*[.、\s]*/, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[【】\[\]（）()\-—–_、，,。；;：:\s]/g, '')
    .toLowerCase()
    .trim();

const isLikelyDocumentHeading = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.length < 2) return false;
    if (parseMarkdownHeading(trimmed)) return true;
    if (trimmed.length > 80) return false;
    if (!/^\d+(?:\.\d+)*[.、\s]\s*[^\d\s].+/.test(trimmed)) return false;
    if (/[\u3002\uff0c\u3001\uff1b\uff1a\u2026\uff01\uff1f,;:!?)\uff09\u300b\u300f\u201d\u2019]$/.test(trimmed)) return false;
    return !/应当|应该|需要|具体为|如下[\uff1a:]|以下[\uff1a:]|包括[\uff1a:]|说明[\uff1a:]|要求[\uff1a:]|其中[\uff0c,]/.test(trimmed);
};

const displayLevelsFromHeadingPath = (path) => {
    if (!path.length) return { level1: '', level2: '', level3: '' };
    if (path.length === 1) return { level1: path[0], level2: '', level3: '' };
    if (path.length === 2) return { level1: path[0], level2: path[1], level3: '' };
    if (path.length === 3) return { level1: path[0], level2: path[1], level3: path[2] };
    return {
        level1: path[0],
        level2: path[path.length - 2],
        level3: path[path.length - 1]
    };
};

const extractDocumentHeadingOutline = (text) => {
    if (!text) return [];
    const lines = text.split('\n');
    const rawHeadings = [];
    for (let i = 0; i < lines.length; i++) {
        const rawTitle = lines[i].trim();
        if (!isLikelyDocumentHeading(rawTitle)) continue;
        const markdownHeading = parseMarkdownHeading(rawTitle);
        const title = markdownHeading?.title || rawTitle;
        const num = title.match(/^(\d+(?:\.\d+)*)/)?.[1] || '';
        rawHeadings.push({
            title,
            cleanTitle: stripHeadingNumber(title),
            parts: markdownHeading
                ? Array.from({ length: markdownHeading.depth }, (_, index) => index + 1)
                : (num ? num.split('.').map(n => parseInt(n, 10)) : []),
            lineIndex: i
        });
    }

    // Mammoth may materialize both TOC entries and real body headings as plain
    // text. Keep the last occurrence so the outline points at the actual body.
    const lastLineByHeading = new Map();
    rawHeadings.forEach(heading => {
        const key = `${heading.parts.join('.')}\u0001${normalizeHeadingMatchText(heading.cleanTitle)}`;
        lastLineByHeading.set(key, heading.lineIndex);
    });
    const headings = rawHeadings.filter(heading => {
        const key = `${heading.parts.join('.')}\u0001${normalizeHeadingMatchText(heading.cleanTitle)}`;
        return lastLineByHeading.get(key) === heading.lineIndex;
    });

    const stack = [];
    return headings.map((heading, index) => {
        const depth = heading.parts.length;
        stack[depth - 1] = heading.title;
        stack.length = depth;
        const nextLine = headings[index + 1]?.lineIndex ?? lines.length;
        const path = stack.filter(Boolean);
        return {
            ...heading,
            path,
            levels: displayLevelsFromHeadingPath(path),
            content: lines.slice(heading.lineIndex + 1, nextLine).join('\n')
        };
    });
};

const includesUsefulMatch = (haystack, needle) => {
    if (!haystack || !needle) return false;
    if (needle.length <= 2) return false;
    return haystack.includes(needle) || needle.includes(haystack);
};

const matchFunctionToOriginalHeading = (func, outline = []) => {
    if (!func || !outline.length) return null;
    const functionName = normalizeHeadingMatchText(func.functionName);
    const description = normalizeHeadingMatchText(func.description);
    const sourceChapter = normalizeHeadingMatchText(func.sourceChapter);

    let best = null;
    let bestScore = 0;
    for (const heading of outline) {
        if (isReferenceOnlyChapterTitle(heading.title)) continue;
        const headingTitle = normalizeHeadingMatchText(heading.cleanTitle || heading.title);
        const headingFull = normalizeHeadingMatchText(heading.title);
        const content = normalizeHeadingMatchText(heading.content).slice(0, 2000);
        let score = 0;

        if (sourceChapter && normalizeHeadingMatchText(heading.title) === sourceChapter) score += 160;
        if (includesUsefulMatch(functionName, headingTitle)) score += 120 + Math.min(headingTitle.length, functionName.length);
        if (description && includesUsefulMatch(description, headingTitle)) score += 70;
        if (functionName && content.includes(functionName)) score += 95;
        if (description && description.length >= 6 && content.includes(description.slice(0, Math.min(24, description.length)))) score += 50;
        if (functionName && headingFull.includes(functionName.slice(0, Math.min(8, functionName.length)))) score += 30;

        if (score > bestScore) {
            bestScore = score;
            best = heading;
        }
    }
    return bestScore >= 50 ? best : null;
};

const cleanProcessDisplayName = (name) => String(name || '')
    .replace(/\[.*?\]\s*/g, '')
    .replace(/^[\d]+[.、\s]+/, '')
    .trim();

const compactUniqueItems = (items = [], maxItems = 3) => {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const text = String(item || '').replace(/[。；;，,、]+$/g, '').trim();
        if (!text || text === '待补充') continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
        if (result.length >= maxItems) break;
    }
    return result;
};

const isUsefulFunctionDescription = (text) => {
    const desc = String(text || '').trim();
    if (desc.length < 35) return false;
    if (/^(待补充|无|暂无|N\/A)$/i.test(desc)) return false;
    const hasProcessWords = /(该功能|用户|系统|定时|接口|触发|读取|保存|返回|展示|生成|查询|配置|支持|允许)/.test(desc);
    const looksLikeOnlyList = desc.split(/[、,，]/).length >= 6 && !/[。；;]/.test(desc);
    return hasProcessWords && !looksLikeOnlyList;
};

const buildFallbackFunctionDescription = (processName, rows = [], seedDescription = '', functionalUser = '', triggerEvent = '') => {
    const cleanProcess = cleanProcessDisplayName(processName) || '该功能过程';
    const seed = String(seedDescription || '').trim().replace(/[。；;]+$/g, '');
    if (isUsefulFunctionDescription(seed)) {
        return seed.startsWith(`${cleanProcess} -`) ? `${seed}。` : `${cleanProcess} - ${seed}。`;
    }

    const eItems = compactUniqueItems(rows.filter(r => r.dataMovementType === 'E').map(r => r.dataGroup || r.subProcessDesc), 2);
    const rItems = compactUniqueItems(rows.filter(r => r.dataMovementType === 'R').map(r => r.dataGroup || r.subProcessDesc), 3);
    const wItems = compactUniqueItems(rows.filter(r => r.dataMovementType === 'W').map(r => r.dataGroup || r.subProcessDesc), 2);
    const xItems = compactUniqueItems(rows.filter(r => r.dataMovementType === 'X').map(r => r.dataGroup || r.subProcessDesc), 2);

    const eText = eItems.length ? eItems.join('、') : `${cleanProcess}请求`;
    const rText = rItems.length ? rItems.join('、') : '相关业务数据';
    const wText = wItems.length ? wItems.join('、') : '处理记录或操作日志';
    const xText = xItems.length ? xItems.join('、') : `${cleanProcess}结果`;

    let actorText = '用户';
    let startText = `该功能允许用户完成${cleanProcess}操作`;
    if ((triggerEvent || '').includes('时钟')) {
        actorText = '定时任务';
        startText = `该功能由定时任务触发，用于按预设规则执行${cleanProcess}流程`;
    } else if ((triggerEvent || '').includes('接口')) {
        actorText = '外部系统';
        startText = `该功能支持外部系统通过接口触发${cleanProcess}流程`;
    } else if ((functionalUser || '').includes('定时触发器')) {
        actorText = '定时触发器';
        startText = `该功能由定时触发器发起，用于自动执行${cleanProcess}流程`;
    }

    const writeClause = wItems.length ? `在处理过程中保存${wText}` : '完成处理过程中的状态整理';
    const resultClause = (triggerEvent || '').includes('时钟')
        ? `并输出${xText}，便于系统持续跟踪处理状态和后续结果`
        : `最终向${actorText === '外部系统' ? '调用方系统' : '用户'}返回${xText}，帮助完成业务查看、判断或后续处理`;

    return `${cleanProcess} - ${startText}。${actorText}发起后，系统会接收${eText}，结合${rText}进行业务处理，${writeClause}，${resultClause}。`;
};

const buildFunctionDescriptionMap = (rows = [], functions = []) => {
    const refMap = new Map();
    functions.forEach(func => {
        const key = normalizeProcessOrderKey(func.functionName || func.functionalProcess || '');
        if (key) refMap.set(key, func);
    });

    const map = new Map();
    let currentGroup = null;
    const groups = [];
    rows.forEach(row => {
        if (row.dataMovementType === 'E' && row.functionalProcess) {
            if (currentGroup) groups.push(currentGroup);
            currentGroup = { processName: row.functionalProcess, eRow: row, rows: [row] };
        } else if (currentGroup) {
            currentGroup.rows.push(row);
        }
    });
    if (currentGroup) groups.push(currentGroup);

    groups.forEach(group => {
        const key = normalizeProcessOrderKey(group.processName);
        const ref = refMap.get(key) || {};
        const existing = group.eRow.functionDescription || '';
        const description = isUsefulFunctionDescription(existing)
            ? existing
            : buildFallbackFunctionDescription(
                group.processName,
                group.rows,
                ref.description || '',
                group.eRow.functionalUser || ref.functionalUser || '',
                group.eRow.triggerEvent || ref.triggerEvent || ''
            );
        map.set(group.processName, description);
    });
    return map;
};

function App({ user, token, onLogout }) {
    // ═══════════ 状态管理 ═══════════
    const idCounterRef = useRef(0);
    const generateId = () => `func_${Date.now()}_${++idCounterRef.current}`;
    const [messages, setMessages] = useState([]);
    const [inputText, setInputText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [documentContent, setDocumentContent] = useState('');
    const [documentName, setDocumentName] = useState('');
    const [apiStatus, setApiStatus] = useState({ hasApiKey: false });
    const [tableData, setTableData] = useState([]);
    const [streamingContent, setStreamingContent] = useState('');
    const [aiActivity, setAiActivity] = useState(initialAiActivity);
    const [activityClock, setActivityClock] = useState(Date.now());
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
    const [showSequenceDiagram, setShowSequenceDiagram] = useState(false);
    const [showCodeSourceAnalyzer, setShowCodeSourceAnalyzer] = useState(false);
    const [exportWithDiagrams, setExportWithDiagrams] = useState(false);
    const [excelExportTemplate, setExcelExportTemplate] = useState('standard');
    const [wordExportTemplate, setWordExportTemplate] = useState('hierarchy');
    const [generateDescription, setGenerateDescription] = useState(true); // 是否在拆分时生成功能描述
    const [useEnhancedCosmicExperience, setUseEnhancedCosmicExperience] = useState(() => {
        if (typeof window !== 'undefined') {
            return window.localStorage.getItem('useEnhancedCosmicExperience') === 'true';
        }
        return false;
    });
    const [splitExecutionMode, setSplitExecutionMode] = useState(() => {
        if (typeof window !== 'undefined') {
            const savedMode = window.localStorage.getItem('cosmicSplitExecutionMode');
            return savedMode === 'fast' ? 'fast' : 'stable';
        }
        return 'stable';
    });
    const [isGeneratingDiagrams, setIsGeneratingDiagrams] = useState(false);
    const [diagramProgress, setDiagramProgress] = useState('');
    const [isSupplementingDescription, setIsSupplementingDescription] = useState(false); // 是否正在补充功能描述

    // 用户会话管理
    const [currentConversationId, setCurrentConversationId] = useState(null);
    const [showHistory, setShowHistory] = useState(false);
    const saveTimerRef = useRef(null);

    // 带认证的axios实例
    const authAxios = useMemo(() => axios.create({
        headers: { Authorization: `Bearer ${token}` }
    }), [token]);

    // 工作模式：COSMIC、NESMA 或通用办公文档
    const [analysisMode, setAnalysisMode] = useState(() => {
        if (typeof window !== 'undefined') {
            return window.localStorage.getItem('analysisMode') || 'cosmic';
        }
        return 'cosmic';
    });

    // 模型选择（统一火山引擎四个模型）
    const [selectedModel, setSelectedModel] = useState(() => {
        if (typeof window !== 'undefined') {
            const savedModel = window.localStorage.getItem('selectedModel');
            // 兼容旧选项，统一迁移到新模型
            const migrationMap = {
                'deepseek-v4-flash-free': 'deepseek-v4-pro-ga',
                'deepseek-v3': 'deepseek-v4-pro-ga',
                'deepseek-r1': 'deepseek-v4-pro-ga',
                'glm-5.2': 'deepseek-v4-flash-ga',
                'company-glm-5.2': 'deepseek-v4-flash-ga',
                'deepseek-v4-flash': UNLIMITDS_MODEL_ALIAS,
                'sensenova-6.8-flash-lite': UNLIMITDS_MODEL_ALIAS,
                'qwen3-coder': UNLIMITDS_MODEL_ALIAS,
                'gpt-5.1-codex-mini': 'deepseek-v4-pro-ga'
            };
            return migrationMap[savedModel] || savedModel || 'deepseek-v4-pro-ga';
        }
        return 'deepseek-v4-pro-ga';
    });

    // 目标功能过程数量
    const [minFunctionCount, setMinFunctionCount] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = window.localStorage.getItem('minFunctionCount');
            return saved ? parseInt(saved, 10) || 30 : 30;
        }
        return 30;
    });

    // 两步骤模式
    const [functionListText, setFunctionListText] = useState('');
    const [parsedFunctions, setParsedFunctions] = useState([]); // 结构化功能列表
    const [showFunctionListEditor, setShowFunctionListEditor] = useState(false);
    const [editingFunctionIndex, setEditingFunctionIndex] = useState(-1); // 当前编辑的功能索引
    const [currentStep, setCurrentStep] = useState(0); // 0=未开始, 1=章节识别, 2=提取中, 3=待确认, 4=拆分中

    // 章节模式
    const [chapters, setChapters] = useState([]);
    const [showChapterView, setShowChapterView] = useState(false);

    // ═══ 借鉴NESMA的新功能 ═══
    const [moduleStructure, setModuleStructure] = useState(null); // 三级模块结构
    const [extractionMode, setExtractionMode] = useState('precise'); // 'precise' | 'quantity'
    const [totalTargetCount, setTotalTargetCount] = useState(50); // 数量优先目标数
    const [quantityPlan, setQuantityPlan] = useState(null); // 每模块目标数量规划
    const [showQuantityPlan, setShowQuantityPlan] = useState(false); // 数量规划弹窗

    // 失败批次重试
    const [failedBatchInfo, setFailedBatchInfo] = useState([]); // [{index, functions, texts, names, error}]
    const [analysisProgress, setAnalysisProgress] = useState(initialAnalysisProgress);

    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);
    const dropZoneRef = useRef(null);
    const abortControllerRef = useRef(null);
    const excelProgressTimerRef = useRef(null);
    const aiActivityRef = useRef(initialAiActivity);
    const documentHeadingOutline = useMemo(
        () => extractDocumentHeadingOutline(documentContent),
        [documentContent]
    );

    // ═══════════ 初始化 ═══════════
    useEffect(() => {
        checkApiStatus();
    }, []);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            window.localStorage.setItem('selectedModel', selectedModel);
            window.localStorage.setItem('minFunctionCount', String(minFunctionCount));
            window.localStorage.setItem('analysisMode', analysisMode);
            window.localStorage.setItem('useEnhancedCosmicExperience', useEnhancedCosmicExperience ? 'true' : 'false');
            window.localStorage.setItem('cosmicSplitExecutionMode', splitExecutionMode);
        }
    }, [selectedModel, minFunctionCount, analysisMode, useEnhancedCosmicExperience, splitExecutionMode]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, streamingContent, aiActivity.steps.length]);

    useEffect(() => {
        if (!aiActivity.visible || aiActivity.status !== 'running') return undefined;
        setActivityClock(Date.now());
        const timer = setInterval(() => setActivityClock(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [aiActivity.visible, aiActivity.status]);

    useEffect(() => () => {
        if (excelProgressTimerRef.current) clearInterval(excelProgressTimerRef.current);
    }, []);

    // 自动保存对话（防抖）
    useEffect(() => {
        if (!currentConversationId || !token) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            const uniqueFuncs = [...new Set(tableData.map(r => r.functionalProcess).filter(Boolean))];
            authAxios.put(`/api/auth/conversations/${currentConversationId}`, {
                title: documentName || '未命名分析',
                messages: messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    ...(m.activity?.steps?.length ? { activity: m.activity } : {})
                })),
                tableData,
                functionList: functionListText,
                functionCount: uniqueFuncs.length,
                cfpCount: tableData.length
            }).catch(err => console.warn('自动保存失败:', err.message));
        }, 3000);
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    }, [messages, tableData, functionListText, documentName, currentConversationId, token]);

    // ═══════════ API ═══════════
    const checkApiStatus = async () => {
        try {
            const res = await axios.get('/api/health');
            setApiStatus(res.data);
            if (!res.data.hasUnlimitdsApiKey) {
                setSelectedModel(model => model === UNLIMITDS_MODEL_ALIAS ? 'deepseek-v4-pro-ga' : model);
            }
        } catch (error) {
            console.error('检查API状态失败:', error);
        }
    };

    const handleModelChange = async (model) => {
        try {
            await axios.post('/api/switch-model', { model });
            setSelectedModel(model);
            const labels = {
                'deepseek-v4-pro-ga': 'DeepSeek-V4-Pro正式版',
                'deepseek-v4-flash-ga': 'DeepSeek-V4-Flash正式版',
                'deepseek-v4-pro': 'DeepSeek-V4-pro',
                [UNLIMITDS_MODEL_ALIAS]: 'DeepSeek-V4-Pro（UnlimitDS）'
            };
            showToast(`已切换到 ${labels[model] || model}`);
        } catch (error) {
            showToast(error.response?.data?.error || '切换模型失败');
        }
    };

    const getUserConfig = () => {
        return {
            apiKey: null,
            baseUrl: null,
            model: selectedModel,
            provider: selectedModel === UNLIMITDS_MODEL_ALIAS ? 'unlimitds' : 'volcengine'
        };
    };

    const requestCosmicSplitBatch = async (payload, {
        signal = null,
        requestKey = createCosmicRunId('batch'),
        onStatus = null
    } = {}) => ({
        data: await runCosmicSplitJob({
            httpClient: axios,
            payload,
            requestKey,
            signal,
            onStatus
        })
    });

    const requestFunctionExtraction = async (payload, {
        signal = null,
        requestKey = createCosmicRunId('extract'),
        onStatus = null
    } = {}) => ({
        data: await runFunctionExtractionJob({
            httpClient: axios,
            payload,
            requestKey,
            signal,
            onStatus
        })
    });

    const showToast = (message) => {
        setToastMessage(message);
        setTimeout(() => setToastMessage(''), 2500);
    };

    const commitAiActivity = useCallback((updater) => {
        const next = typeof updater === 'function'
            ? updater(aiActivityRef.current)
            : updater;
        aiActivityRef.current = next;
        setAiActivity(next);
        return next;
    }, []);

    const beginAiActivity = useCallback(() => {
        const now = Date.now();
        return commitAiActivity({
            visible: true,
            status: 'running',
            startedAt: now,
            endedAt: 0,
            steps: [{
                id: 'connection',
                title: '连接 AI 服务',
                detail: '正在建立实时连接，后续步骤和生成内容会显示在这里。',
                status: 'running',
                sequence: 0,
                receivedAt: now
            }]
        });
    }, [commitAiActivity]);

    const upsertAiActivity = useCallback((incoming = {}) => commitAiActivity(prev => {
        const now = Date.now();
        const id = incoming.id || `activity-${incoming.sequence || now}`;
        const existingIndex = prev.steps.findIndex(step => step.id === id);
        const existing = existingIndex >= 0 ? prev.steps[existingIndex] : {};
        const step = {
            ...existing,
            ...incoming,
            id,
            title: incoming.title || existing.title || '处理任务',
            detail: incoming.detail || existing.detail || '',
            status: incoming.status || existing.status || 'running',
            receivedAt: now
        };
        let steps;
        if (existingIndex >= 0) {
            steps = prev.steps.map((item, index) => index === existingIndex ? step : item);
        } else {
            steps = [...prev.steps, step]
                .sort((left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER));
        }
        if (id !== 'connection') {
            steps = steps.map(item => item.id === 'connection' && item.status === 'running'
                ? { ...item, status: 'done', detail: '实时连接已建立。' }
                : item);
        }
        return {
            ...prev,
            visible: true,
            status: incoming.status === 'error' ? 'error' : 'running',
            startedAt: prev.startedAt || now,
            steps
        };
    }), [commitAiActivity]);

    const completeAiActivity = useCallback((status = 'done', errorDetail = '') => commitAiActivity(prev => {
        const endedAt = Date.now();
        let markedError = false;
        const steps = prev.steps.map(step => {
            if (step.status !== 'running') return step;
            if (status === 'error' && !markedError) {
                markedError = true;
                return {
                    ...step,
                    status: 'error',
                    detail: errorDetail || step.detail
                };
            }
            return { ...step, status: 'done' };
        });
        if (status === 'error' && !markedError) {
            steps.push({
                id: 'request-error',
                title: 'AI 处理失败',
                detail: errorDetail || '请求未完成。',
                status: 'error',
                receivedAt: endedAt
            });
        }
        return {
            ...prev,
            visible: true,
            status,
            endedAt,
            steps
        };
    }), [commitAiActivity]);

    const hideAiActivity = useCallback(() => {
        commitAiActivity(prev => ({ ...prev, visible: false }));
    }, [commitAiActivity]);

    const resetAiActivity = useCallback(() => {
        commitAiActivity(initialAiActivity);
    }, [commitAiActivity]);

    const updateAnalysisProgress = useCallback((patch) => {
        setAnalysisProgress(prev => {
            const now = Date.now();
            const isNewTask = !prev.visible
                || (patch.title && patch.title !== prev.title)
                || (patch.status === 'running' && ['done', 'waiting', 'error', 'canceled'].includes(prev.status));
            const previousHistory = isNewTask ? [] : (prev.history || []);
            const nextStatus = patch.status || prev.status || 'running';
            const nextPhase = patch.phase || prev.phase || '准备中';
            const nextDetail = patch.detail || prev.detail || '正在准备分析任务...';
            const last = previousHistory[previousHistory.length - 1];
            const shouldRecord = !last
                || last.phase !== nextPhase
                || last.detail !== nextDetail
                || last.status !== nextStatus;
            return {
                ...prev,
                visible: true,
                status: nextStatus,
                ...patch,
                startedAt: isNewTask ? now : (prev.startedAt || now),
                updatedAt: now,
                history: shouldRecord
                    ? [...previousHistory, {
                        phase: nextPhase,
                        detail: nextDetail,
                        status: nextStatus,
                        at: now
                    }].slice(-12)
                    : previousHistory
            };
        });
    }, []);

    const resetAnalysisProgress = useCallback(() => {
        setAnalysisProgress(initialAnalysisProgress);
    }, []);

    const clearExcelProgressTimer = useCallback(() => {
        if (excelProgressTimerRef.current) {
            clearInterval(excelProgressTimerRef.current);
            excelProgressTimerRef.current = null;
        }
    }, []);

    const startExcelImportProgress = useCallback((file) => {
        clearExcelProgressTimer();
        let stepIndex = 0;
        const fileSizeMb = file?.size ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : '';
        updateAnalysisProgress({
            status: 'running',
            title: 'COSMIC Excel 导入',
            phase: '上传文件',
            percent: 6,
            current: 1,
            total: 5,
            detail: `正在上传 ${file?.name || 'Excel 文件'}，随后会自动解析拆分结果。`,
            stats: fileSizeMb
        });
        excelProgressTimerRef.current = setInterval(() => {
            const step = COSMIC_EXCEL_IMPORT_STEPS[Math.min(stepIndex, COSMIC_EXCEL_IMPORT_STEPS.length - 1)];
            stepIndex += 1;
            setAnalysisProgress(prev => {
                if (!prev.visible || prev.status !== 'running' || prev.title !== 'COSMIC Excel 导入') return prev;
                return {
                    ...prev,
                    ...step,
                    total: 5,
                    percent: Math.max(prev.percent || 0, step.percent),
                    stats: prev.stats || fileSizeMb
                };
            });
        }, 2200);
    }, [clearExcelProgressTimer, updateAnalysisProgress]);

    const AnalysisProgressPanel = () => {
        if (!analysisProgress.visible) return null;
        const percent = Math.max(0, Math.min(100, Math.round(analysisProgress.percent || 0)));
        const isDone = analysisProgress.status === 'done';
        const isWaiting = analysisProgress.status === 'waiting';
        const isError = analysisProgress.status === 'error';
        const isCanceled = analysisProgress.status === 'canceled';
        const statusText = isDone
            ? '已完成'
            : isWaiting
                ? '等待确认'
                : isError
                    ? '执行失败'
                    : isCanceled
                        ? '已停止'
                        : '进行中';

        return (
            <div className={`analysis-progress-panel ${isDone ? 'done' : isWaiting ? 'waiting' : isError ? 'error' : isCanceled ? 'canceled' : ''}`}>
                <div className="analysis-progress-head">
                    <div className="analysis-progress-title">
                        {isDone
                            ? <CheckCircle size={16} />
                            : isWaiting || isError || isCanceled
                                ? <AlertCircle size={16} />
                                : <Loader2 size={16} className="spinner" />}
                        <span>{analysisProgress.title || '分析进度'}</span>
                        <em>{statusText}</em>
                    </div>
                    <strong>{percent}%</strong>
                </div>
                <div className="analysis-progress-bar">
                    <span style={{ width: `${percent}%` }} />
                </div>
                <div className="analysis-progress-meta">
                    <div>
                        <b>{analysisProgress.phase || '准备中'}</b>
                        <p>{analysisProgress.detail || '正在准备分析任务...'}</p>
                    </div>
                    {(analysisProgress.total > 0 || analysisProgress.stats) && (
                        <div className="analysis-progress-count">
                            {analysisProgress.total > 0 && <span>{analysisProgress.current}/{analysisProgress.total}</span>}
                            {analysisProgress.stats && <small>{analysisProgress.stats}</small>}
                        </div>
                    )}
                </div>
                {(analysisProgress.history || []).length > 1 && (
                    <div className="analysis-progress-trace">
                        {(analysisProgress.history || []).slice(-6).map((event, index) => (
                            <div className={`analysis-progress-trace-item ${event.status || ''}`} key={`${event.at}-${index}`}>
                                <span>
                                    {event.status === 'done'
                                        ? <Check size={11} />
                                        : event.status === 'error'
                                            ? <X size={11} />
                                            : <Loader2 size={11} className={event.status === 'running' ? 'spinner' : ''} />}
                                </span>
                                <div>
                                    <b>{event.phase}</b>
                                    <p>{event.detail}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    const AiActivityPanel = ({ activity, compact = false }) => {
        if (!activity?.steps?.length) return null;
        const isRunning = activity.status === 'running';
        const isError = activity.status === 'error';
        const durationMs = activity.durationMs ?? Math.max(
            0,
            (activity.endedAt || activityClock) - (activity.startedAt || activityClock)
        );
        const statusLabel = isRunning ? '实时进行中' : isError ? '执行失败' : '已完成';
        const steps = activity.steps;

        const timeline = (
            <div className="ai-activity-timeline">
                {steps.map((step, index) => (
                    <div className={`ai-activity-step ${step.status || 'running'}`} key={`${step.id || index}-${index}`}>
                        <span className="ai-activity-step-icon">
                            {step.status === 'done'
                                ? <Check size={12} />
                                : step.status === 'error'
                                    ? <X size={12} />
                                    : step.status === 'warning'
                                        ? <AlertCircle size={12} />
                                        : <Loader2 size={12} className="spinner" />}
                        </span>
                        <div>
                            <b>{step.title}</b>
                            {step.detail && <p>{step.detail}</p>}
                        </div>
                    </div>
                ))}
            </div>
        );

        if (compact) {
            return (
                <details className={`ai-activity-history ${isError ? 'error' : ''}`}>
                    <summary>
                        <span><Brain size={13} /> AI 工作过程</span>
                        <small>{steps.length} 步 · {formatActivityDuration(durationMs)}</small>
                        <ChevronDown size={13} />
                    </summary>
                    {timeline}
                </details>
            );
        }

        return (
            <div className={`ai-activity-panel ${isRunning ? 'running' : ''} ${isError ? 'error' : ''}`}>
                <div className="ai-activity-head">
                    <div>
                        <span className="ai-activity-orb"><Brain size={15} /></span>
                        <div>
                            <b>AI 工作过程</b>
                            <small>实时展示可验证的执行步骤与产出</small>
                        </div>
                    </div>
                    <em>{statusLabel} · {formatActivityDuration(durationMs)}</em>
                </div>
                {timeline}
            </div>
        );
    };

    const allocateQuantityTargets = useCallback((items, total) => {
        const targetTotal = Math.max(0, parseInt(total, 10) || 0);
        if (!Array.isArray(items) || items.length === 0) return [];
        const weights = items.map(item => Math.max(1, item.estimated || item.estimatedFunctions || 8));
        const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || items.length;
        const raw = weights.map(weight => (weight / weightTotal) * targetTotal);
        const targets = raw.map(value => Math.floor(value));
        let remaining = targetTotal - targets.reduce((sum, value) => sum + value, 0);
        const order = raw
            .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
            .sort((a, b) => b.fraction - a.fraction);
        for (let i = 0; i < remaining; i++) {
            targets[order[i % order.length].index] += 1;
        }
        return targets;
    }, []);

    const buildQuantityPlanFromModules = useCallback((modules, total) => {
        if (!Array.isArray(modules) || modules.length === 0) return [];
        const targets = allocateQuantityTargets(modules, total);
        return modules.map((m, index) => ({
            level1: m.level1,
            level2: m.level2,
            level3: m.level3,
            businessObjects: m.businessObjects || [],
            triggerTypes: m.triggerTypes || [],
            estimated: m.estimatedFunctions || m.estimated || 8,
            target: targets[index] || 0
        }));
    }, [allocateQuantityTargets]);

    const getModuleEstimateTotal = useCallback(() => {
        if (!moduleStructure?.modules?.length) return 0;
        const declaredTotal = Number(moduleStructure.totalEstimated) || 0;
        const summedTotal = moduleStructure.modules.reduce((sum, m) => (
            sum + (Number(m.estimatedFunctions || m.estimated) || 0)
        ), 0);
        return declaredTotal || summedTotal;
    }, [moduleStructure]);

    const updateQuantityTotalTarget = useCallback((nextTotal) => {
        const safeTotal = Math.max(0, parseInt(nextTotal, 10) || 0);
        setTotalTargetCount(safeTotal);
        setQuantityPlan(prev => {
            if (!prev || prev.length === 0) return prev;
            const targets = allocateQuantityTargets(prev, safeTotal);
            return prev.map((item, index) => ({ ...item, target: targets[index] || 0 }));
        });
    }, [allocateQuantityTargets]);

    const switchToQuantityMode = useCallback((targetTotal = null, openPlan = false) => {
        const estimateTotal = getModuleEstimateTotal();
        const nextTotal = Math.max(0, parseInt(targetTotal ?? estimateTotal ?? totalTargetCount, 10) || 0);
        setExtractionMode('quantity');
        setTotalTargetCount(nextTotal);
        if (moduleStructure?.modules?.length) {
            setQuantityPlan(buildQuantityPlanFromModules(moduleStructure.modules, nextTotal));
        }
        if (openPlan) setShowQuantityPlan(true);
        if (nextTotal > 0) showToast(`已切到数量优先，目标总数 ${nextTotal} 个`);
    }, [buildQuantityPlanFromModules, getModuleEstimateTotal, moduleStructure, totalTargetCount]);

    const prepareQuantityReExtraction = useCallback((targetTotal = null) => {
        switchToQuantityMode(targetTotal, true);
        setCurrentStep(2);
    }, [switchToQuantityMode]);

    const handleExtractionModeChange = useCallback((mode) => {
        if (mode === 'quantity') {
            switchToQuantityMode(null, false);
        } else {
            setExtractionMode('precise');
        }
    }, [switchToQuantityMode]);

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

    const processCosmicExcelFile = async (file) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('userConfig', JSON.stringify(getUserConfig()));

        try {
            setIsLoading(true);
            setUploadProgress(0);
            startExcelImportProgress(file);
            const res = await axios.post('/api/parse-cosmic-excel', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                timeout: COSMIC_EXCEL_IMPORT_TIMEOUT_MS,
                onUploadProgress: (e) => {
                    if (!e.total) return;
                    const rawPercent = Math.round((e.loaded * 100) / e.total);
                    setUploadProgress(rawPercent);
                    setAnalysisProgress(prev => {
                        if (!prev.visible || prev.title !== 'COSMIC Excel 导入' || (prev.percent || 0) > 26) return prev;
                        return {
                            ...prev,
                            status: 'running',
                            phase: '上传文件',
                            percent: Math.max(prev.percent || 0, 6 + Math.round(rawPercent * 0.2)),
                            current: 1,
                            total: 5,
                            detail: `正在上传 ${file.name}，上传完成后服务端会继续解析 Excel。`
                        };
                    });
                }
            });

            if (res.data.success) {
                const importedTableData = orderCosmicTableData(
                    res.data.tableData || [],
                    res.data.parsedFunctions || [],
                    res.data.moduleStructure || null
                );
                setDocumentContent(res.data.documentContent || '');
                setDocumentName(res.data.filename);
                setTableData(importedTableData);
                setParsedFunctions(res.data.parsedFunctions || []);
                setFunctionListText(res.data.functionListText || '');
                setModuleStructure(res.data.moduleStructure || null);
                setChapters([]);
                setQuantityPlan(null);
                setFailedBatchInfo([]);
                setCoverageResult(null);
                setCurrentStep(0);
                setShowFunctionListEditor(false);
                setShowChapterView(false);
                setIsWaitingForAnalysis(false);
                setExportWithDiagrams(true);
                clearExcelProgressTimer();
                setUploadProgress(100);

                const counts = res.data.dmtCounts || {};
                const descGen = res.data.descriptionGeneration || {};
                const descStatus = descGen.source === 'excel'
                    ? '使用Excel原有功能描述'
                    : descGen.source === 'local-fallback'
                        ? `AI生成失败，已用本地规则兜底 ${descGen.fallbackCount || 0} 条`
                        : `已调用AI生成/补齐功能描述 ${descGen.generatedCount || 0} 条`;
                updateAnalysisProgress({
                    status: 'done',
                    title: 'COSMIC Excel 导入',
                    phase: '导入完成',
                    percent: 100,
                    current: 5,
                    total: 5,
                    detail: `已识别 ${res.data.functionCount || 0} 个功能过程，生成 ${res.data.count || 0} 条 CFP 明细。`,
                    stats: `E×${counts.E || 0} R×${counts.R || 0} W×${counts.W || 0} X×${counts.X || 0}`
                });
                setMessages(prev => [...prev,
                    {
                        role: 'system',
                        content: `已导入已拆分 COSMIC Excel：${res.data.filename}\n格式：${res.data.format?.name || 'COSMIC拆分表'} | 工作表：${res.data.format?.sheetName || '-'} | 功能过程：${res.data.functionCount} 个 | CFP：${res.data.count}\nERWX：E×${counts.E || 0} R×${counts.R || 0} W×${counts.W || 0} X×${counts.X || 0}\n功能描述：${descStatus}`
                    },
                    {
                        role: 'assistant',
                        content: '已识别拆分结果，并跳过 COSMIC 拆分流程。已默认开启“附带时序图”，可以直接查看时序图，或导出带时序图的 Word 需求文档。',
                        showActions: true
                    }
                ]);
                showToast(`已导入 ${res.data.functionCount} 个功能过程，可直接导出Word`);
                ensureConversation(res.data.filename);
            }
        } catch (error) {
            const isTimeout = error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '');
            const msg = isTimeout
                ? `导入超过 ${Math.round(COSMIC_EXCEL_IMPORT_TIMEOUT_MS / 60000)} 分钟，请稍后重试或检查外部AI服务响应是否正常`
                : (error.response?.data?.error || error.message);
            clearExcelProgressTimer();
            updateAnalysisProgress({
                status: 'waiting',
                title: 'COSMIC Excel 导入失败',
                phase: '处理失败',
                percent: 100,
                current: 0,
                total: 0,
                detail: msg || '导入过程中发生错误。',
                stats: ''
            });
            setErrorMessage(`COSMIC Excel解析失败: ${msg}`);
        } finally {
            clearExcelProgressTimer();
            setIsLoading(false);
            setTimeout(() => setUploadProgress(0), 1000);
        }
    };

    const processFile = async (file) => {
        setErrorMessage('');
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        const docExts = ['.docx', '.txt', '.md'];
        const cosmicExcelExts = ['.xlsx', '.xlsm', '.xls'];
        if (![...docExts, ...cosmicExcelExts].includes(ext)) {
            setErrorMessage(`不支持的文件格式: ${ext}，请上传 .docx, .txt, .md 或 .xlsx/.xlsm 文件`);
            return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            setErrorMessage(`文件大小超过限制（最大${MAX_UPLOAD_MB}MB）`);
            return;
        }

        if (cosmicExcelExts.includes(ext)) {
            await processCosmicExcelFile(file);
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
                { role: 'system', content: `已导入文档: ${res.data.filename}\n大小: ${(res.data.fileSize / 1024).toFixed(1)} KB | 字符数: ${res.data.wordCount}\n\n${res.data.text.substring(0, 600)}${res.data.text.length > 600 ? '\n\n...(点击"预览文档"查看完整内容)' : ''}` },
                { role: 'assistant', content: '文档已就绪。您可以在下方输入**特殊拆分要求**，或直接点击**「开始智能拆分」**按钮。' }
                ]);
                setIsWaitingForAnalysis(true);
                // 自动创建对话记录
                ensureConversation(res.data.filename);
            }
        } catch (error) {
            const msg = error.response?.data?.error || error.message;
            setErrorMessage(`文档解析失败: ${msg}`);
        } finally {
            setIsLoading(false);
            setTimeout(() => setUploadProgress(0), 1000);
        }
    };

    // ═══════════ 表格数据去重 ═══════════

    // 从功能过程名提取关键词，支持逐步加长
    const getKeyword = (processName, length = 4) => {
        if (!processName) return '';
        const clean = processName.replace(/\[.*?\]\s*/, '').trim();
        if (clean.length <= length) return clean;
        return clean.substring(0, length);
    };

    // 生成唯一名称：关键词自然融入名称中，不使用括号和数字
    const makeUniqueName = (original, processName, existingNames, verbPrefix = null) => {
        const cleanProcess = (processName || '').replace(/\[.*?\]\s*/, '').trim();
        if (!cleanProcess) return original;

        // 自动检测动词前缀
        if (!verbPrefix) {
            const autoVerb = original.match(/^(接收|读取|保存|更新|返回|呈现|记录|检索|获取|查询|写入|删除|批量)/);
            if (autoVerb) verbPrefix = autoVerb[1];
        }

        const lengths = [4, 6, 8, cleanProcess.length];
        for (const len of lengths) {
            const keyword = cleanProcess.substring(0, Math.min(len, cleanProcess.length));
            let candidate;
            if (verbPrefix) {
                candidate = verbPrefix + keyword + original.substring(verbPrefix.length);
            } else {
                candidate = keyword + original;
            }
            if (!existingNames.has(candidate.toLowerCase().trim())) {
                return candidate;
            }
        }
        return cleanProcess + original;
    };

    // normalize 功能过程名：去掉章节标记、序号前缀、空格，转小写
    // 与后端 normalizeProcessName 保持一致，避免 V3.2 微调名称时发生误判
    const normalizeProcName = (name) => {
        if (!name) return '';
        return name
            .replace(/\[.*?\]\s*/g, '')   // 去掉 [章节名]
            .replace(/^[\d]+[.、\s]+/, '') // 去掉序号
            .replace(/\s+/g, '')           // 去掉所有空格
            .toLowerCase()
            .trim();
    };

    const deduplicateData = (existing, newData, expectedNames = null) => {
        // 白名单的 normalize 版本（用于模糊比对）
        const normalizedWhitelist = expectedNames
            ? new Set([...expectedNames].map(n => normalizeProcName(n)))
            : null;

        // 1. 按功能过程去重（跳过已存在的整个功能过程，但白名单内的不跳过）
        const existingProcessRows = existing.filter(r => r.dataMovementType === 'E' && r.functionalProcess);
        const existingProcesses = new Set(
            existingProcessRows.map(r => r.functionalProcess.toLowerCase().trim())
        );
        // 同时保留 normalize 版本，用于模糊比对
        const existingProcessesNorm = new Set(
            existingProcessRows.map(r => normalizeProcName(r.functionalProcess))
        );
        const existingProcessNameByKey = new Map(
            existingProcessRows.map(r => [r.functionalProcess.toLowerCase().trim(), r.functionalProcess])
        );
        const existingProcessNameByNorm = new Map(
            existingProcessRows.map(r => [normalizeProcName(r.functionalProcess), r.functionalProcess])
        );

        const result = [];
        let skipCurrent = false;
        for (const row of newData) {
            if (row.dataMovementType === 'E' && row.functionalProcess) {
                const nameKey = row.functionalProcess.toLowerCase().trim();
                const nameNorm = normalizeProcName(row.functionalProcess);
                // 白名单保护：精确匹配 OR normalize 后匹配，都视为本批次应拆分的功能过程
                const inWhitelist = expectedNames && (
                    expectedNames.has(nameKey) ||
                    (normalizedWhitelist && normalizedWhitelist.has(nameNorm))
                );
                if (inWhitelist) {
                    skipCurrent = false;
                    existingProcesses.add(nameKey);
                    existingProcessesNorm.add(nameNorm);
                    existingProcessNameByKey.set(nameKey, row.functionalProcess);
                    existingProcessNameByNorm.set(nameNorm, row.functionalProcess);
                } else if (existingProcesses.has(nameKey) || existingProcessesNorm.has(nameNorm)) {
                    // 精确重复 或 normalize 后重复，才跳过（防止 V3.2 微调名称被误跳）
                    const matchedName = existingProcessNameByKey.get(nameKey) || existingProcessNameByNorm.get(nameNorm) || '';
                    console.warn('[COSMIC dedup] skip duplicated functional process', {
                        skipped: row.functionalProcess,
                        matched: matchedName,
                        normalized: nameNorm
                    });
                    skipCurrent = true; continue;
                } else {
                    skipCurrent = false;
                    existingProcesses.add(nameKey);
                    existingProcessesNorm.add(nameNorm);
                    existingProcessNameByKey.set(nameKey, row.functionalProcess);
                    existingProcessNameByNorm.set(nameNorm, row.functionalProcess);
                }
            }
            if (!skipCurrent) result.push(row);
        }

        // 2. 对合并后的数据进行数据组和子过程描述去重
        const allData = [...existing, ...result];

        // 重建每行对应的功能过程
        let currentProcess = '';
        const rowProcessMap = [];
        for (let i = 0; i < allData.length; i++) {
            if (allData[i].dataMovementType === 'E' && allData[i].functionalProcess) {
                currentProcess = allData[i].functionalProcess;
            }
            rowProcessMap[i] = currentProcess;
        }

        // 收集已有 existing 中的数据组和子过程描述
        const existingDataGroups = new Map(); // dataGroup(lower) -> processName
        for (let i = 0; i < existing.length; i++) {
            const dg = existing[i].dataGroup?.trim();
            if (dg && dg !== '待补充') {
                existingDataGroups.set(dg.toLowerCase(), rowProcessMap[i]);
            }
        }

        const allDgNames = new Set();
        for (let i = 0; i < existing.length; i++) {
            const dg = existing[i].dataGroup?.trim();
            if (dg && dg !== '待补充') allDgNames.add(dg.toLowerCase());
        }

        const allDescNames = new Set();
        for (let i = 0; i < existing.length; i++) {
            const desc = existing[i].subProcessDesc?.trim();
            if (desc) allDescNames.add(desc.toLowerCase());
        }

        // 收集已有 existing 中的数据属性
        const existingDataAttrs = new Map(); // dataAttributes(lower) -> processName
        for (let i = 0; i < existing.length; i++) {
            const attr = existing[i].dataAttributes?.trim();
            if (attr && attr !== '待补充') {
                existingDataAttrs.set(attr.toLowerCase(), rowProcessMap[i]);
            }
        }

        const allAttrNames = new Set();
        for (let i = 0; i < existing.length; i++) {
            const attr = existing[i].dataAttributes?.trim();
            if (attr && attr !== '待补充') allAttrNames.add(attr.toLowerCase());
        }

        // 对新增result中的行做数据组/子过程去重（关键词前缀策略）
        const newStartIdx = existing.length;
        for (let i = 0; i < result.length; i++) {
            const globalIdx = newStartIdx + i;
            const processName = rowProcessMap[globalIdx];

            // 检查数据组是否与已有数据冲突
            const dg = result[i].dataGroup?.trim();
            if (dg && dg !== '待补充') {
                const dgKey = dg.toLowerCase();
                if (existingDataGroups.has(dgKey) && existingDataGroups.get(dgKey) !== processName) {
                    const newName = makeUniqueName(dg, processName, allDgNames);
                    if (newName !== dg) {
                        result[i] = { ...result[i], dataGroup: newName };
                    }
                }
                allDgNames.add((result[i].dataGroup || dg).toLowerCase().trim());
                existingDataGroups.set((result[i].dataGroup || dg).toLowerCase(), processName);
            }

            // 检查子过程描述是否与已有数据冲突
            const desc = result[i].subProcessDesc?.trim();
            if (desc && allDescNames.has(desc.toLowerCase())) {
                const prefixMatch = desc.match(/^(接收|读取|保存|更新|返回|呈现|记录|检索|获取|查询|写入|删除|批量)/);
                const newName = makeUniqueName(desc, processName, allDescNames, prefixMatch ? prefixMatch[1] : null);
                if (newName !== desc) {
                    result[i] = { ...result[i], subProcessDesc: newName };
                }
            }
            allDescNames.add((result[i].subProcessDesc || desc || '').toLowerCase().trim());

            // 检查数据属性是否与已有数据冲突
            const attr = result[i].dataAttributes?.trim();
            if (attr && attr !== '待补充') {
                const attrKey = attr.toLowerCase();
                if (existingDataAttrs.has(attrKey) && existingDataAttrs.get(attrKey) !== processName) {
                    const newName = makeUniqueName(attr, processName, allAttrNames);
                    if (newName !== attr) {
                        result[i] = { ...result[i], dataAttributes: newName };
                    }
                }
                allAttrNames.add((result[i].dataAttributes || attr).toLowerCase().trim());
                existingDataAttrs.set((result[i].dataAttributes || attr).toLowerCase(), processName);
            }
        }

        // 3. 最终验证：检查result中是否仍有重复，用关键词后缀去重
        const MAX_VERIFY = 3;
        for (let v = 0; v < MAX_VERIFY; v++) {
            let hasdup = false;

            // 数据组验证
            const verifyDgSet = new Set();
            for (let i = 0; i < existing.length; i++) {
                const dg = existing[i].dataGroup?.trim()?.toLowerCase();
                if (dg && dg !== '待补充') verifyDgSet.add(dg);
            }
            for (let i = 0; i < result.length; i++) {
                const dg = result[i].dataGroup?.trim()?.toLowerCase();
                if (!dg || dg === '待补充') continue;
                if (verifyDgSet.has(dg)) {
                    const newName = makeUniqueName(result[i].dataGroup, rowProcessMap[newStartIdx + i], verifyDgSet);
                    result[i] = { ...result[i], dataGroup: newName };
                    hasdup = true;
                }
                verifyDgSet.add(result[i].dataGroup.trim().toLowerCase());
            }

            // 子过程描述验证
            const verifyDescSet = new Set();
            for (let i = 0; i < existing.length; i++) {
                const d = existing[i].subProcessDesc?.trim()?.toLowerCase();
                if (d) verifyDescSet.add(d);
            }
            for (let i = 0; i < result.length; i++) {
                const d = result[i].subProcessDesc?.trim()?.toLowerCase();
                if (!d) continue;
                if (verifyDescSet.has(d)) {
                    const newName = makeUniqueName(result[i].subProcessDesc, rowProcessMap[newStartIdx + i], verifyDescSet);
                    result[i] = { ...result[i], subProcessDesc: newName };
                    hasdup = true;
                }
                verifyDescSet.add(result[i].subProcessDesc.trim().toLowerCase());
            }

            // 数据属性验证
            const verifyAttrSet = new Set();
            for (let i = 0; i < existing.length; i++) {
                const a = existing[i].dataAttributes?.trim()?.toLowerCase();
                if (a && a !== '待补充') verifyAttrSet.add(a);
            }
            for (let i = 0; i < result.length; i++) {
                const a = result[i].dataAttributes?.trim()?.toLowerCase();
                if (!a || a === '待补充') continue;
                if (verifyAttrSet.has(a)) {
                    const newName = makeUniqueName(result[i].dataAttributes, rowProcessMap[newStartIdx + i], verifyAttrSet);
                    result[i] = { ...result[i], dataAttributes: newName };
                    hasdup = true;
                }
                verifyAttrSet.add(result[i].dataAttributes.trim().toLowerCase());
            }

            if (!hasdup) break;
        }

        return result;
    };

    const findMissingSplitFunctions = (functions, rows) => {
        const splitNames = new Set(
            rows
                .filter(r => r.dataMovementType === 'E' && r.functionalProcess)
                .map(r => normalizeProcName(r.functionalProcess))
        );

        return functions
            .filter(f => f?.selected !== false && f?.functionName)
            .filter(f => !splitNames.has(normalizeProcName(f.functionName)));
    };


    // ═══════════ 两步骤模式：阶段1 - 章节识别 + 功能过程提取 ═══════════

    // 步骤1a: 模块识别 + 章节识别
    const startChapterRecognition = async () => {
        if (!documentContent) { showToast('请先上传文档'); return; }

        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;
        const moduleRunId = createCosmicRunId('module-recognition');

        setIsLoading(true);
        setIsWaitingForAnalysis(false);
        setCurrentStep(1);
        updateAnalysisProgress({
            title: 'COSMIC analysis',
            phase: 'Module recognition',
            percent: 8,
            current: 1,
            total: 5,
            detail: 'Analyzing level 1/2/3 module structure...',
            stats: `${documentContent.length.toLocaleString()} chars`
        });
        setMessages([{ role: 'system', content: '**三级模块识别中...**\n正在分析文档的一级/二级/三级模块层级结构...' }]);

        let recognizedModules = null;

        // ── 第一步：三级模块结构识别（借鉴NESMA） ──
        try {
            const moduleResult = await runCosmicModuleRecognitionJob({
                httpClient: axios,
                payload: {
                    documentContent,
                    userConfig: getUserConfig()
                },
                requestKey: `${moduleRunId}:document`,
                signal,
                onStatus: job => {
                    const message = job?.progress?.message || job?.message;
                    if (message) updateAnalysisProgress({ detail: message });
                }
            });
            const modRes = { data: moduleResult };
            if (modRes.data.degraded) {
                setMessages(prev => [...prev, {
                    role: 'system',
                    content: `⚠️ ${modRes.data.warning || 'AI模块识别暂不可用，已根据文档标题生成模块脚手架。'}`
                }]);
            }
            if (modRes.data.success && modRes.data.moduleData?.modules?.length > 0) {
                recognizedModules = modRes.data.moduleData;
                setModuleStructure(recognizedModules);
                updateAnalysisProgress({
                    phase: 'Module recognition complete',
                    percent: 24,
                    current: 1,
                    total: 5,
                    detail: `Found ${recognizedModules.modules.length} modules. Preparing extraction structure.`,
                    stats: `${recognizedModules.modules.length} modules`
                });

                // 如果是数量优先模式，自动生成数量规划
                let generatedPlan = null;
                if (extractionMode === 'quantity') {
                    const mods = recognizedModules.modules;
                    const targets = allocateQuantityTargets(mods, totalTargetCount);
                    const plan = mods.map(m => ({
                        level1: m.level1,
                        level2: m.level2,
                        level3: m.level3,
                        businessObjects: m.businessObjects || [],
                        triggerTypes: m.triggerTypes || [],
                        estimated: m.estimatedFunctions || 8,
                        target: targets[mods.indexOf(m)] || 0
                    }));
                    generatedPlan = plan;
                    setQuantityPlan(plan);
                }

                const modSummary = recognizedModules.modules.map((m, i) =>
                    `${i + 1}. **${m.level3}**（${m.level1} > ${m.level2}）: ${m.businessObjects?.join('、') || '若干业务对象'
                    }${generatedPlan ? (generatedPlan[i]?.target > 0 ? `，目标 **${generatedPlan[i]?.target}** 个功能过程` : `，本轮 **跳过**`) : `，预估 ~${m.estimatedFunctions || '?'} 个功能过程`}`
                ).join('\n');

                const skippedModules = generatedPlan ? generatedPlan.filter(p => (p.target || 0) <= 0) : [];
                const planTip = generatedPlan
                    ? `\n\n**已生成数量规划**（总目标 ${totalTargetCount} 个）。可点击「**调整规划**」按钮修改各模块目标数量。${skippedModules.length > 0 ? `\n\n注意：因目标数小于模块数，本轮将跳过 ${skippedModules.length} 个模块：${skippedModules.map(m => m.level3).join('、')}` : ''}`
                    : '';

                const moduleTitle = modRes.data.degraded ? '模块脚手架降级生成' : '三级模块结构识别完成';
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `## ${moduleTitle}\n\n共得到 **${recognizedModules.modules.length}** 个三级模块节点：\n\n${modSummary}${planTip}\n\n这些模块将作为"脚手架"指导功能过程提取。数量目标不足覆盖全部模块时，系统会明确标记本轮跳过的模块。`
                }]);
            }
        } catch (e) {
            if (e.name === 'AbortError' || e.name === 'CanceledError' || signal.aborted) {
                setIsLoading(false);
                return;
            }
            console.warn('COSMIC模块识别失败，将跳过模块脚手架:', e.message);
            setMessages(prev => [...prev, {
                role: 'system',
                content: '三级模块识别失败，将使用默认章节模式（功能过程可能略有遗漏）。'
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
                percent: 32,
                current: 2,
                total: 5,
                detail: 'Splitting the document into chapters and selecting likely functional sections.'
            });
            const res = await axios.post('/api/split-chapters', {
                documentContent,
                moduleStructure: recognizedModules || null
            }, { signal });
            if (res.data.success) {
                const chapterList = res.data.chapters;
                setChapters(chapterList);
                updateAnalysisProgress({
                    status: 'waiting',
                    phase: 'Waiting for chapter confirmation',
                    percent: 40,
                    current: 2,
                    total: 5,
                    detail: `Found ${chapterList.length} chapters. Confirm the selection to start function extraction.`,
                    stats: `selected ${chapterList.filter(ch => ch.selected).length}/${chapterList.length}`
                });

                const chapterSummary = chapterList.map((ch, i) =>
                    `${ch.selected ? '☑' : '☐'} **${i + 1}.** ${ch.title} (${ch.charCount}字)`
                ).join('\n');

                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `## 章节识别完成\n\n共识别到 **${chapterList.length}** 个章节：\n\n${chapterSummary}\n\n${recognizedModules ? `已加载三级模块脚手架（${recognizedModules.modules.length}个模块），提取将更全面。` : ''}\n\n已自动选中包含功能描述的章节。`,
                    showChapterActions: true
                }]);
                setCurrentStep(2); // 等待用户确认
            }
        } catch (error) {
            if (error.name === 'AbortError' || error.name === 'CanceledError' || signal.aborted) return;
            // 章节识别失败，退回到全文模式
            setMessages(prev => [...prev, {
                role: 'system',
                content: '章节自动识别失败，将使用全文模式提取功能过程。'
            }]);
            setChapters([{ title: '全文', content: documentContent, charCount: documentContent.length, selected: true }]);
            await startFunctionExtractionFromChapters([{ title: '全文', content: documentContent, selected: true }]);
        } finally {
            setIsLoading(false);
        }
    };

    // 切换章节选中状态
    const toggleChapter = (index) => {
        setChapters(prev => prev.map((ch, i) =>
            i === index ? { ...ch, selected: !ch.selected } : ch
        ));
    };

    // 步骤1b: 按章节提取功能过程
    const startFunctionExtractionFromChapters = async (chapterList = null) => {
        const selectedChapters = (chapterList || chapters).filter(ch => ch.selected);
        if (selectedChapters.length === 0) {
            showToast('请至少选择一个章节');
            return;
        }

        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;
        const extractionRunId = createCosmicRunId('function-extraction');
        const extractionProfile = resolveCosmicConcurrency({
            mode: splitExecutionMode,
            documentChars: documentContent.length,
            chapterCount: selectedChapters.length
        });
        const extractionConcurrency = extractionProfile.concurrency;
        const extractionModeLabel = extractionProfile.autoStabilized
            ? '大文档自动稳健模式（串行）'
            : extractionConcurrency > 1
            ? `快速模式（${extractionConcurrency} 路并发）`
            : '稳健模式（串行）';

        setIsLoading(true);
        setCurrentStep(2);
        updateAnalysisProgress({
            status: 'running',
            title: 'COSMIC analysis',
            phase: 'Function extraction',
            percent: 42,
            current: 0,
            total: selectedChapters.length,
            detail: `Extracting functional processes using ${extractionModeLabel}.`,
            stats: `0 functions`
        });

        let allFunctions = '';
        let totalCount = 0;
        const quantityTotalTarget = extractionMode === 'quantity'
            ? (quantityPlan ? quantityPlan.reduce((s, p) => s + p.target, 0) : totalTargetCount)
            : 0;
        const quantityChapterTargets = extractionMode === 'quantity'
            ? allocateQuantityPlanToChapters(
                selectedChapters,
                quantityPlan,
                quantityTotalTarget
            )
            : [];
        if (extractionMode === 'quantity' && quantityTotalTarget > 0) {
            const allocatedTotal = quantityChapterTargets.reduce((sum, value) => sum + value, 0);
            if (allocatedTotal !== quantityTotalTarget) {
                console.warn('[COSMIC quantity] chapter target allocation drift', {
                    requested: quantityTotalTarget,
                    allocated: allocatedTotal,
                    chapterTargets: quantityChapterTargets
                });
            }
        }
        const skippedQuantityModules = extractionMode === 'quantity' && quantityPlan
            ? quantityPlan.filter(p => (p.target || 0) <= 0)
            : [];
        if (skippedQuantityModules.length > 0) {
            setMessages(prev => [...prev, {
                role: 'system',
                content: `**数量目标不足覆盖全部模块**\n本轮将跳过 ${skippedQuantityModules.length} 个三级模块：${skippedQuantityModules.map(m => m.level3).join('、')}\n\n如需覆盖这些模块，请在「调整规划」中给它们分配目标数量，或提高目标总数。`
            }]);
        }

        const attachChapterSource = (chapter, functionList) => functionList
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
                if (
                    chapter.title !== '全文' &&
                    /^##\s*功能过程[：:]/.test(line) &&
                    !/^##\s*功能过程[：:]\s*[\[【]/.test(line)
                ) {
                    return line.replace(/^##\s*功能过程[：:]\s*/, `##功能过程：[${chapter.title}] `);
                }
                return line;
            })
            .join('\n');

        try {
            if (extractionConcurrency > 1) {
                const chapterResults = new Array(selectedChapters.length);
                let completedChapters = 0;
                let completedFunctionCount = 0;

                const extractChapterConcurrently = async (index) => {
                    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                    const chapter = selectedChapters[index];
                    const chapterTargetCount = quantityChapterTargets[index] || 0;
                    let result;

                    if (extractionMode === 'quantity' && chapterTargetCount <= 0) {
                        result = { functionList: '', count: 0, skipped: true };
                    } else {
                        const res = await requestFunctionExtraction({
                            documentContent: chapter.content,
                            chapterName: chapter.title,
                            userGuidelines,
                            userConfig: getUserConfig(),
                            extractionMode,
                            moduleStructure: moduleStructure || null,
                            quantityPlan: extractionMode === 'quantity' ? quantityPlan : null,
                            targetCount: chapterTargetCount
                        }, {
                            signal,
                            requestKey: `${extractionRunId}:chapter-${index + 1}`,
                            onStatus: job => {
                                const message = job?.progress?.message || job?.message;
                                if (message) updateAnalysisProgress({ detail: `${chapter.title}: ${message}` });
                            }
                        });

                        result = {
                            functionList: res.data.success && res.data.functionList
                                ? attachChapterSource(chapter, res.data.functionList)
                                : '',
                            count: res.data.count || 0,
                            skipped: false
                        };
                    }

                    chapterResults[index] = result;
                    completedChapters += 1;
                    completedFunctionCount += result.count;
                    updateAnalysisProgress({
                        phase: 'Function extraction',
                        percent: 42 + Math.round((completedChapters / Math.max(selectedChapters.length, 1)) * 22),
                        current: completedChapters,
                        total: selectedChapters.length,
                        detail: result.skipped
                            ? `Skipped chapter: ${chapter.title} (target 0)`
                            : `Finished chapter: ${chapter.title}`,
                        stats: `${completedFunctionCount} functions found · ${extractionModeLabel}`
                    });
                    return result;
                };

                for (let windowStart = 0; windowStart < selectedChapters.length; windowStart += extractionConcurrency) {
                    if (signal.aborted) return;
                    const windowIndexes = [];
                    for (let index = windowStart; index < Math.min(windowStart + extractionConcurrency, selectedChapters.length); index++) {
                        windowIndexes.push(index);
                    }
                    const activeDescriptions = windowIndexes.map(index => {
                        const chapter = selectedChapters[index];
                        const target = quantityChapterTargets[index] || 0;
                        return extractionMode === 'quantity' && target > 0
                            ? `${chapter.title}（目标 ${target}）`
                            : chapter.title;
                    });

                    updateAnalysisProgress({
                        phase: 'Function extraction',
                        percent: 42 + Math.round((completedChapters / Math.max(selectedChapters.length, 1)) * 22),
                        current: completedChapters,
                        total: selectedChapters.length,
                        detail: `Analyzing ${activeDescriptions.length} chapters concurrently: ${activeDescriptions.join('、')}`,
                        stats: `${completedFunctionCount} functions found · ${extractionModeLabel}`
                    });
                    setMessages(prev => {
                        const filtered = prev.filter(m => !m.content.startsWith('🔍'));
                        return [...filtered, {
                            role: 'system',
                            content: `🔍 **功能过程提取（已完成 ${completedChapters}/${selectedChapters.length}）**\n正在并发分析章节: ${activeDescriptions.join('、')}...`
                        }];
                    });

                    const windowResults = await Promise.allSettled(
                        windowIndexes.map(index => extractChapterConcurrently(index))
                    );
                    allFunctions = chapterResults
                        .map(result => result?.functionList || '')
                        .filter(Boolean)
                        .join('\n');
                    totalCount = chapterResults.reduce((sum, result) => sum + (result?.count || 0), 0);
                    const failedResult = windowResults.find(result => result.status === 'rejected');
                    if (failedResult) throw failedResult.reason;
                }
            } else {
                for (let i = 0; i < selectedChapters.length; i++) {
                    if (signal.aborted) return;
                    const chapter = selectedChapters[i];
                    const chapterTargetCount = quantityChapterTargets[i] || 0;
                    if (extractionMode === 'quantity' && chapterTargetCount <= 0) {
                        updateAnalysisProgress({
                            phase: 'Function extraction',
                            percent: 42 + Math.round(((i + 1) / Math.max(selectedChapters.length, 1)) * 22),
                            current: i + 1,
                            total: selectedChapters.length,
                            detail: `Skipped chapter: ${chapter.title} (target 0)`,
                            stats: `${totalCount} functions found · ${extractionModeLabel}`
                        });
                        continue;
                    }
                    updateAnalysisProgress({
                        phase: 'Function extraction',
                        percent: 42 + Math.round((i / Math.max(selectedChapters.length, 1)) * 22),
                        current: i,
                        total: selectedChapters.length,
                        detail: extractionMode === 'quantity' && chapterTargetCount > 0
                            ? `Analyzing chapter: ${chapter.title} (target ${chapterTargetCount})`
                            : `Analyzing chapter: ${chapter.title}`,
                        stats: `${totalCount} functions found · ${extractionModeLabel}`
                    });

                    setMessages(prev => {
                        const filtered = prev.filter(m => !m.content.startsWith('🔍'));
                        return [...filtered, {
                            role: 'system',
                            content: `🔍 **功能过程提取（已完成 ${i}/${selectedChapters.length}）**\n正在分析章节: ${chapter.title}...`
                        }];
                    });

                    const res = await requestFunctionExtraction({
                        documentContent: chapter.content,
                        chapterName: chapter.title,
                        userGuidelines,
                        userConfig: getUserConfig(),
                        extractionMode,
                        moduleStructure: moduleStructure || null,
                        quantityPlan: extractionMode === 'quantity' ? quantityPlan : null,
                        targetCount: chapterTargetCount
                    }, {
                        signal,
                        requestKey: `${extractionRunId}:chapter-${i + 1}`,
                        onStatus: job => {
                            const message = job?.progress?.message || job?.message;
                            if (message) updateAnalysisProgress({ detail: `${chapter.title}: ${message}` });
                        }
                    });

                    if (res.data.success && res.data.functionList) {
                        // 给每条功能附上章节来源标记
                        const chapterFunctions = attachChapterSource(chapter, res.data.functionList);

                        allFunctions += (allFunctions ? '\n' : '') + chapterFunctions;
                        totalCount += res.data.count || 0;
                        updateAnalysisProgress({
                            phase: 'Function extraction',
                            percent: 42 + Math.round(((i + 1) / Math.max(selectedChapters.length, 1)) * 22),
                            current: i + 1,
                            total: selectedChapters.length,
                            detail: `Finished chapter: ${chapter.title}`,
                            stats: `${totalCount} functions found · ${extractionModeLabel}`
                        });
                    }

                    // 稳健模式保留章节间等待，避免严格限流平台连续请求。
                    if (i < selectedChapters.length - 1) {
                        try {
                            await new Promise((resolve, reject) => {
                                const t = setTimeout(resolve, 4000);
                                signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
                            });
                        } catch (e) { if (e.name === 'AbortError' || signal.aborted) return; }
                    }
                }
            }

            setFunctionListText(allFunctions);
            // 自动解析为结构化数据
            const parsed = deduplicateFunctionObjects(
                inheritMissingFunctionLevels(parseFunctionListText(allFunctions)),
                { semantic: extractionMode !== 'quantity' }
            );

            // ── 将章节的 level1/level2/level3 注入到每个功能过程对象 ──
            // chapters 状态里已有后端返回的层级信息，通过 sourceChapter 匹配 title
            const chapterLevelMap = {};
            (chapterList || chapters).forEach(ch => {
                if (ch.title) {
                    const titleNumber = ch.title.match(/^(\d+(?:\.\d+)*)/)?.[1] || '';
                    const titleDepth = ch.headingDepth || (titleNumber ? titleNumber.split('.').length : 0);
                    chapterLevelMap[ch.title] = {
                        level1: ch.level1 || '',
                        level2: titleDepth >= 2 ? (ch.level2 || '') : '',
                        level3: titleDepth >= 3 ? (ch.level3 || '') : ''
                    };
                }
            });
            parsed.forEach(f => {
                // 如果 moduleStructure 已成功匹配（level2 非空说明有具体模块归属），
                // 不用粗粒度章节层级覆盖
                if (f.level2) return;
                const src = f.sourceChapter;
                if (src && chapterLevelMap[src]) {
                    // 仅填充空缺的层级字段，不覆盖已有值
                    const cl = chapterLevelMap[src];
                    if (!f.level1 && cl.level1) f.level1 = cl.level1;
                    if (!f.level2 && cl.level2) f.level2 = cl.level2;
                    if (!f.level3 && cl.level3) f.level3 = cl.level3;
                }
            });

            const leveledParsed = inheritMissingFunctionLevels(parsed);
            setFunctionListText(functionsToText(leveledParsed));
            setParsedFunctions(leveledParsed);
            setCurrentStep(3);
            updateAnalysisProgress({
                status: 'waiting',
                phase: 'Function list ready',
                percent: 66,
                current: 3,
                total: 5,
                detail: `Extracted ${leveledParsed.length} functional processes. Review them before COSMIC splitting.`,
                stats: `${leveledParsed.filter(f => f.selected !== false).length}/${leveledParsed.length} selected`
            });

            // 构建简洁的统计摘要，不再dump原始文本
            const triggerStats = {};
            leveledParsed.forEach(f => {
                const trigger = f.triggerEvent || '未知';
                triggerStats[trigger] = (triggerStats[trigger] || 0) + 1;
            });
            const triggerSummary = Object.entries(triggerStats)
                .map(([k, v]) => `${k}: ${v}个`)
                .join(' | ');
            const moduleEstimateTotal = getModuleEstimateTotal();
            const hasLargeEstimateGap = extractionMode === 'precise'
                && moduleEstimateTotal > 0
                && leveledParsed.length > 0
                && leveledParsed.length < Math.ceil(moduleEstimateTotal * 0.6);
            const estimateGapNote = hasLargeEstimateGap
                ? `\n\n### 数量差异说明\n\n模块脚手架粗估约 **${moduleEstimateTotal}** 个功能过程，这是按三级模块、业务对象和触发类型推算的可展开空间；当前精准模式实际提取 **${leveledParsed.length}** 个，是按 COSMIC 业务目的合并后的结果。若要按粗估规模展开，请使用下方 **按粗估数重提**。`
                : '';

            setMessages(prev => {
                const filtered = prev.filter(m => !m.content.startsWith('🔍'));
                return [...filtered, {
                    role: 'assistant',
                    content: `## 功能过程提取完成\n\n使用 **${extractionModeLabel}** 从 **${selectedChapters.length}** 个章节中共识别到 **${leveledParsed.length}** 个功能过程。\n\n触发类型分布：${triggerSummary}${estimateGapNote}\n\n请点击**「查看/编辑功能列表」**按钮检查和修改，确认后点击**「开始COSMIC拆分」**。`,
                    showFunctionListActions: true,
                    showQuantityEstimateActions: hasLargeEstimateGap,
                    estimateTarget: moduleEstimateTotal
                }];
            });
        } catch (error) {
            if (error.name === 'AbortError' || error.name === 'CanceledError') return;
            if (allFunctions) {
                // 部分成功
                setFunctionListText(allFunctions);
                const parsed = deduplicateFunctionObjects(
                    inheritMissingFunctionLevels(parseFunctionListText(allFunctions)),
                    { semantic: extractionMode !== 'quantity' }
                );
                setFunctionListText(functionsToText(parsed));
                setParsedFunctions(parsed);
                setCurrentStep(3);
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `功能过程提取部分完成（已提取 ${parsed.length} 个）。\n错误: ${error.response?.data?.error || error.message}\n\n请点击**「查看/编辑功能列表」**按钮检查。`,
                    showFunctionListActions: true
                }]);
                updateAnalysisProgress({
                    status: 'waiting',
                    phase: 'Function extraction partially completed',
                    detail: `已保留 ${parsed.length} 个功能过程，可检查后继续拆分。`
                });
            } else {
                setMessages(prev => [...prev, { role: 'assistant', content: `❌ 功能过程提取失败: ${error.response?.data?.error || error.message}` }]);
                setCurrentStep(0);
                updateAnalysisProgress({
                    status: 'error',
                    phase: 'Function extraction failed',
                    detail: error.response?.data?.error || error.message || '功能过程提取失败'
                });
            }
        } finally {
            setIsLoading(false);
        }
    };

    // 兼容：直接调用（全文模式 - 用于一键分析）
    const startFunctionExtraction = async () => {
        await startChapterRecognition();
    };

    // ═══════════ 两步骤模式：阶段2 - COSMIC分段拆分（批次模式，断网安全） ═══════════
    const startCosmicSplit = async () => {
        // 先同步结构化数据回 text
        let activeFunctions = inheritMissingFunctionLevels(parsedFunctions).filter(f => f.selected !== false);
        if (activeFunctions.length === 0) {
            // 回退到旧模式：用纯文本
            let textForSplit = functionListText;
            if (!textForSplit) { showToast('请先提取功能过程列表'); return; }
            activeFunctions = inheritMissingFunctionLevels(parseFunctionListText(textForSplit)).filter(f => f.selected !== false);
            if (activeFunctions.length === 0) { showToast('未找到功能过程'); return; }
        }

        // Lock the selected mode for this run. Large documents and long
        // function lists automatically fall back to serial execution even if
        // the user previously selected fast mode.
        const splitProfile = resolveCosmicConcurrency({
            mode: splitExecutionMode,
            documentChars: documentContent.length,
            functionCount: activeFunctions.length
        });
        const batchConcurrency = splitProfile.concurrency;
        // 稳健模式逐功能提交，缩短单个后台任务；快速模式仍保留每批2个。
        const cosmicBatchSize = batchConcurrency > 1 ? 2 : 1;
        const splitRunId = createCosmicRunId('full-split');
        const executionModeLabel = splitProfile.autoStabilized
            ? '大文档自动稳健模式（串行）'
            : batchConcurrency > 1
                ? `快速模式（${batchConcurrency} 路并发）`
                : '稳健模式（串行）';

        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;

        setIsLoading(true);
        setCurrentStep(4);
        setTableData([]);
        updateAnalysisProgress({
            status: 'running',
            title: 'COSMIC split',
            phase: 'Preparing batches',
            percent: 68,
            current: 0,
            total: 0,
            detail: 'Preparing selected functional processes for batch splitting.',
            stats: `${activeFunctions.length} functions`
        });

        // 将功能过程分批
        const totalFunctions = activeFunctions.length;
        const batches = [];
        for (let i = 0; i < totalFunctions; i += cosmicBatchSize) {
            const batchFuncs = activeFunctions.slice(i, i + cosmicBatchSize);
            // 将每个功能过程转为文本格式
            const batchTexts = batchFuncs.map(f =>
                `##触发事件：${f.triggerEvent || '用户触发'}\n##功能用户：${f.functionalUser || '发起者：用户 接收者：用户'}\n##功能过程：${f.functionName}\n##功能过程描述：${f.description || ''}`
            );
            batches.push({ functions: batchFuncs, texts: batchTexts });
        }

        const totalBatches = batches.length;
        updateAnalysisProgress({
            status: 'running',
            title: 'COSMIC split',
            phase: 'Batch splitting',
            percent: 70,
            current: 0,
            total: totalBatches,
            detail: `Split into ${totalBatches} batches. Starting batch processing.`,
            stats: `${totalFunctions} functions`
        });
        setMessages(prev => [...prev, {
            role: 'system',
            content: `**阶段2：COSMIC后台分段拆分**\n共 **${totalFunctions}** 个功能过程，分为 **${totalBatches}** 个批次（每批 ${cosmicBatchSize} 个），正在使用 **${executionModeLabel}** 拆分...\n\n*每批先提交为后台任务，再通过短请求查询状态；临时 502 或页面连接抖动不会重复启动该批次。已完成批次会即时保留。*`
        }]);

        let allTableData = [];
        let completedBatches = 0;
        let failedBatches = [];
        const batchTimings = [];
        setFailedBatchInfo([]); // 清空上次的失败记录

        const waitWithAbort = (ms) => new Promise((resolve, reject) => {
            const t = setTimeout(resolve, ms);
            signal.addEventListener('abort', () => {
                clearTimeout(t);
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });

        const buildBatchContext = (batch) => {
            const functionLevelMap = {};
            let headingContext = null;
            batch.functions.forEach(f => {
                if (f.functionName) {
                    const levels = getModuleLevels(f);
                    if (levels.level1 || levels.level2 || levels.level3) {
                        functionLevelMap[f.functionName] = levels;
                        if (!headingContext) {
                            headingContext = { level1: levels.level1, level2: levels.level2, level3: levels.level3 };
                        }
                    }
                }
            });
            return {
                headingContext,
                functionLevelMap: Object.keys(functionLevelMap).length > 0 ? functionLevelMap : null
            };
        };

        const reportBatchJobStatus = (batchIndex) => (job) => {
            const message = job?.progress?.message || job?.message;
            if (!message) return;
            updateAnalysisProgress({
                phase: 'Background batch processing',
                current: completedBatches,
                total: totalBatches,
                detail: `Batch ${batchIndex + 1}: ${message}`,
                stats: `${completedBatches}/${totalBatches} done, ${allTableData.length} CFP`
            });
        };

        const runCosmicBatch = async (bi, previousResultsSnapshot) => {
            const batch = batches[bi];
            const startedAt = Date.now();
            const batchFuncNames = batch.functions.map(f => f.functionName).join('、');
            const { headingContext, functionLevelMap } = buildBatchContext(batch);

            try {
                const res = await requestCosmicSplitBatch({
                    batchFunctions: batch.texts,
                    batchIndex: bi,
                    totalBatches,
                    documentContent: documentContent.substring(0, 6000),
                    userGuidelines,
                    previousFunctionNames: completedFunctionNames(previousResultsSnapshot),
                    userConfig: getUserConfig(),
                    headingContext,
                    functionLevelMap,
                    generateDescription,
                    useEnhancedExperience: useEnhancedCosmicExperience
                }, {
                    signal,
                    requestKey: `${splitRunId}:batch-${bi}`,
                    onStatus: reportBatchJobStatus(bi)
                });

                return {
                    ok: true,
                    index: bi,
                    batch,
                    names: batchFuncNames,
                    data: res.data.tableData || [],
                    durationMs: Date.now() - startedAt
                };
            } catch (batchError) {
                if (batchError.name === 'AbortError' || batchError.name === 'CanceledError' || signal.aborted) {
                    throw batchError;
                }
                return {
                    ok: false,
                    index: bi,
                    batch,
                    names: batchFuncNames,
                    error: batchError.response?.data?.error || batchError.message,
                    durationMs: Date.now() - startedAt
                };
            }
        };

        try {
            if (batchConcurrency <= 1) {
                for (let bi = 0; bi < totalBatches; bi++) {
                    if (signal.aborted) return;

                    const batch = batches[bi];
                    const batchFuncNames = batch.functions.map(f => f.functionName).join('、');
                    updateAnalysisProgress({
                        phase: 'Batch splitting',
                        percent: 70 + Math.round((completedBatches / Math.max(totalBatches, 1)) * 27),
                        current: bi + 1,
                        total: totalBatches,
                        detail: `Processing batch ${bi + 1}: ${batch.functions.map(f => f.functionName).join(', ')}`,
                        stats: `${completedBatches}/${totalBatches} done, ${allTableData.length} CFP`
                    });

                    // 更新进度
                    setMessages(prev => {
                        const filtered = prev.filter(m => !m.content.startsWith('**批次'));
                        return [...filtered, {
                            role: 'system',
                            content: `**批次 ${bi + 1}/${totalBatches}** | 正在拆分：${batchFuncNames}\n\n进度：${completedBatches}/${totalBatches} 批次完成，已获得 ${allTableData.length} 个子过程`
                        }];
                    });

                    try {
                        // 构建每个功能过程的独立层级映射（修复：不再只取第一个功能的层级）
                        const batchFunctionLevelMap = {};
                        let batchHeadingCtx = null;
                        batch.functions.forEach(f => {
                            if (f.functionName) {
                                const levels = getModuleLevels(f);
                                if (levels.level1 || levels.level2 || levels.level3) {
                                    batchFunctionLevelMap[f.functionName] = levels;
                                    if (!batchHeadingCtx) {
                                        batchHeadingCtx = { level1: levels.level1, level2: levels.level2, level3: levels.level3 };
                                    }
                                }
                            }
                        });
                        const res = await requestCosmicSplitBatch({
                            batchFunctions: batch.texts,
                            batchIndex: bi,
                            totalBatches,
                            documentContent: documentContent.substring(0, 6000),
                            userGuidelines,
                            previousFunctionNames: completedFunctionNames(allTableData),
                            userConfig: getUserConfig(),
                            headingContext: batchHeadingCtx,
                            functionLevelMap: Object.keys(batchFunctionLevelMap).length > 0 ? batchFunctionLevelMap : null,
                            generateDescription,
                            useEnhancedExperience: useEnhancedCosmicExperience
                        }, {
                            signal,
                            requestKey: `${splitRunId}:batch-${bi}`,
                            onStatus: reportBatchJobStatus(bi)
                        });

                        if (res.data.success) {
                            const newData = res.data.tableData || [];
                            if (newData.length > 0) {
                                // 白名单同时收录原始小写名 + normalize 名，与 deduplicateData 内的双重检测对齐
                                const expectedNames = new Set([
                                    ...batch.functions.map(f => f.functionName.toLowerCase().trim()),
                                    ...batch.functions.map(f => normalizeProcName(f.functionName))
                                ]);
                                const deduped = deduplicateData(allTableData, newData, expectedNames);
                                if (deduped.length > 0) {
                                    allTableData = orderCosmicTableData([...allTableData, ...deduped], activeFunctions, moduleStructure);
                                    setTableData(allTableData);
                                }
                            }
                            completedBatches++;
                            updateAnalysisProgress({
                                phase: 'Batch splitting',
                                percent: 70 + Math.round((completedBatches / Math.max(totalBatches, 1)) * 27),
                                current: completedBatches,
                                total: totalBatches,
                                detail: `Finished batch ${bi + 1}.`,
                                stats: `${completedBatches}/${totalBatches} done, ${allTableData.length} CFP`
                            });
                        }
                    } catch (batchError) {
                        if (batchError.name === 'AbortError' || batchError.name === 'CanceledError' || signal.aborted) return;

                        const batchErrMsg = batchError.response?.data?.error || batchError.message;
                        console.error(`批次 ${bi + 1} 失败:`, batchErrMsg);
                        failedBatches.push({
                            index: bi,
                            names: batchFuncNames,
                            error: batchErrMsg,
                            functions: batch.functions,  // 保存完整的功能过程数据
                            texts: batch.texts            // 保存拆分用文本
                        });
                        setFailedBatchInfo([...failedBatches]);
                        updateAnalysisProgress({
                            phase: 'Batch skipped',
                            percent: 70 + Math.round((completedBatches / Math.max(totalBatches, 1)) * 27),
                            current: bi + 1,
                            total: totalBatches,
                            detail: `Batch ${bi + 1} failed and was skipped. Continuing remaining batches.`,
                            stats: `${failedBatches.length} failed, ${allTableData.length} CFP`
                        });

                        setMessages(prev => {
                            const filtered = prev.filter(m => !m.content.startsWith('**批次'));
                            return [...filtered, {
                                role: 'system',
                                content: `**批次 ${bi + 1} 失败**: ${batchErrMsg}\n\n已记录该批次，继续处理剩余批次...`
                            }];
                        });
                        // 第一批失败也继续，确保所有批次都会执行或进入可重试清单。
                        try {
                            await new Promise((resolve, reject) => {
                                const t = setTimeout(resolve, 8000);
                                signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
                            });
                        } catch (e) { if (e.name === 'AbortError' || signal.aborted) return; }
                        continue;
                    }

                    // 批次间等待，避免限流（DeepSeek平台限流严格，需要较长间隔）
                    if (bi < totalBatches - 1) {
                        try {
                            await new Promise((resolve, reject) => {
                                const t = setTimeout(resolve, 5000);
                                signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
                            });
                        } catch (e) { if (e.name === 'AbortError' || signal.aborted) return; }
                    }
                }

                // 最终汇总
            } else {
                for (let windowStart = 0; windowStart < totalBatches; windowStart += batchConcurrency) {
                    if (signal.aborted) return;

                    const windowIndexes = [];
                    for (let bi = windowStart; bi < Math.min(windowStart + batchConcurrency, totalBatches); bi++) {
                        windowIndexes.push(bi);
                    }
                    const activeNames = windowIndexes
                        .map(bi => `${bi + 1}: ${batches[bi].functions.map(f => f.functionName).join(', ')}`)
                        .join(' | ');

                    updateAnalysisProgress({
                        phase: 'Batch splitting',
                        percent: 70 + Math.round((completedBatches / Math.max(totalBatches, 1)) * 27),
                        current: completedBatches,
                        total: totalBatches,
                        detail: `Processing ${windowIndexes.length} batch(es): ${activeNames}`,
                        stats: `${completedBatches}/${totalBatches} done, ${allTableData.length} CFP`
                    });

                    setMessages(prev => {
                        const filtered = prev.filter(m => !m.content.startsWith('**批次'));
                        return [...filtered, {
                            role: 'system',
                            content: `**批次 ${windowIndexes.map(i => i + 1).join(', ')}/${totalBatches}** | 并发拆分中\n\n${activeNames}\n\n进度：${completedBatches}/${totalBatches} 批次完成，已获得 ${allTableData.length} 个子过程`
                        }];
                    });

                    const previousResultsSnapshot = [...allTableData];
                    const windowResults = await Promise.all(windowIndexes.map(bi => runCosmicBatch(bi, previousResultsSnapshot)));
                    windowResults.sort((a, b) => a.index - b.index);

                    for (const result of windowResults) {
                        if (result.ok) {
                            const newData = result.data || [];
                            if (newData.length > 0) {
                                const expectedNames = new Set([
                                    ...result.batch.functions.map(f => f.functionName.toLowerCase().trim()),
                                    ...result.batch.functions.map(f => normalizeProcName(f.functionName))
                                ]);
                                const deduped = deduplicateData(allTableData, newData, expectedNames);
                                if (deduped.length > 0) {
                                    allTableData = orderCosmicTableData([...allTableData, ...deduped], activeFunctions, moduleStructure);
                                }
                            }
                            completedBatches++;
                            batchTimings.push({ index: result.index, durationMs: result.durationMs, count: newData.length });
                            updateAnalysisProgress({
                                phase: 'Batch splitting',
                                percent: 70 + Math.round((completedBatches / Math.max(totalBatches, 1)) * 27),
                                current: completedBatches,
                                total: totalBatches,
                                detail: `Finished batch ${result.index + 1} in ${(result.durationMs / 1000).toFixed(1)}s.`,
                                stats: `${completedBatches}/${totalBatches} done, ${allTableData.length} CFP`
                            });
                        } else {
                            console.error(`批次 ${result.index + 1} 失败:`, result.error);
                            failedBatches.push({
                                index: result.index,
                                names: result.names,
                                error: result.error,
                                functions: result.batch.functions,
                                texts: result.batch.texts
                            });
                            setFailedBatchInfo([...failedBatches]);
                            updateAnalysisProgress({
                                phase: 'Batch skipped',
                                percent: 70 + Math.round((completedBatches / Math.max(totalBatches, 1)) * 27),
                                current: completedBatches,
                                total: totalBatches,
                                detail: `Batch ${result.index + 1} failed and was skipped. Continuing remaining batches.`,
                                stats: `${failedBatches.length} failed, ${allTableData.length} CFP`
                            });
                            setMessages(prev => {
                                const filtered = prev.filter(m => !m.content.startsWith('**批次'));
                                return [...filtered, {
                                    role: 'system',
                                    content: `**批次 ${result.index + 1} 失败**: ${result.error}\n\n已记录为失败批次，继续处理剩余批次...`
                                }];
                            });
                        }
                    }

                    allTableData = orderCosmicTableData(allTableData, activeFunctions, moduleStructure);
                    setTableData(allTableData);

                    if (completedBatches === 0 && failedBatches.length === totalBatches) {
                        throw new Error(failedBatches[0]?.error || 'All COSMIC batches failed');
                    }

                    if (windowStart + batchConcurrency < totalBatches) {
                        try {
                            await waitWithAbort(5000);
                        } catch (e) { if (e.name === 'AbortError' || signal.aborted) return; }
                    }
                }
            }

            const uniqueFunctions = [...new Set(allTableData.map(r => r.functionalProcess).filter(Boolean))];
            const missingSplitFunctions = findMissingSplitFunctions(activeFunctions, allTableData);
            if (missingSplitFunctions.length > 0) {
                const missingKeys = new Set(missingSplitFunctions.map(f => normalizeProcName(f.functionName)));
                batches.forEach((batch, index) => {
                    if (failedBatches.some(item => item.index === index)) return;
                    const containsMissing = batch.functions.some(f => missingKeys.has(normalizeProcName(f.functionName)));
                    if (!containsMissing) return;
                    failedBatches.push({
                        index,
                        names: batch.functions.map(f => f.functionName).join('、'),
                        error: '结果完整性检查发现该批次仍有功能过程未拆分',
                        functions: batch.functions,
                        texts: batch.texts
                    });
                });
            }
            const effectiveCompletedBatches = Math.max(
                0,
                totalBatches - new Set(failedBatches.map(item => item.index)).size
            );
            let summaryContent = `**COSMIC分段拆分完成**\n\n`;
            summaryContent += `共 **${totalBatches}** 个批次，成功 **${effectiveCompletedBatches}** 个`;
            if (failedBatches.length > 0) {
                summaryContent += `，失败 **${failedBatches.length}** 个`;
            }
            summaryContent += `\n- **${uniqueFunctions.length}** 个功能过程\n- **${allTableData.length}** 个子过程（CFP点数）`;
            summaryContent += `\n- E: ${allTableData.filter(r => r.dataMovementType === 'E').length} | R: ${allTableData.filter(r => r.dataMovementType === 'R').length} | W: ${allTableData.filter(r => r.dataMovementType === 'W').length} | X: ${allTableData.filter(r => r.dataMovementType === 'X').length}`;
            summaryContent += `\n- 执行模式：${executionModeLabel}`;
            if (missingSplitFunctions.length > 0) {
                const missingList = missingSplitFunctions.map(f => `- ${f.functionName}`).join('\n');
                summaryContent += `\n\n⚠️ **检测到 ${missingSplitFunctions.length} 个功能过程未完成COSMIC拆分**\n${missingList}\n\n建议点击**「重试失败批次」**或重新拆分缺失功能过程。`;
                console.warn('[COSMIC coverage] missing functional processes after split', missingSplitFunctions.map(f => f.functionName));
            }
            if (batchTimings.length > 0) {
                const avgSeconds = batchTimings.reduce((sum, item) => sum + item.durationMs, 0) / batchTimings.length / 1000;
                const slowest = batchTimings.reduce((max, item) => item.durationMs > max.durationMs ? item : max, batchTimings[0]);
                summaryContent += `\n- 批次耗时：平均 ${avgSeconds.toFixed(1)}s，最慢第 ${slowest.index + 1} 批 ${(slowest.durationMs / 1000).toFixed(1)}s`;
            }

            if (failedBatches.length > 0) {
                summaryContent += `\n\n以下批次拆分失败，可点击**「重试失败批次」**单独补充：\n`;
                summaryContent += failedBatches.map(fb => `- 批次 ${fb.index + 1}: ${fb.names} (${fb.error})`).join('\n');
                // 保存失败批次的完整信息到 state，供重试使用
                setFailedBatchInfo(failedBatches);
            }

            setMessages(prev => {
                const filtered = prev.filter(m => !m.content.startsWith('**批次') && !m.content.startsWith('**阶段2'));
                return [...filtered, {
                    role: 'assistant',
                    content: summaryContent,
                    showActions: true
                }];
            });
            setCurrentStep(0);
            updateAnalysisProgress({
                status: failedBatches.length > 0 || missingSplitFunctions.length > 0 ? 'waiting' : 'done',
                phase: failedBatches.length > 0 || missingSplitFunctions.length > 0 ? 'Partial completion' : 'Completed',
                percent: 100,
                current: effectiveCompletedBatches,
                total: totalBatches,
                detail: failedBatches.length > 0
                    ? 'Some batches failed. You can retry failed batches.'
                    : missingSplitFunctions.length > 0
                        ? 'Some functions were not split. Check the missing list.'
                        : 'COSMIC split completed.',
                stats: `${uniqueFunctions.length} functions, ${allTableData.length} CFP`
            });
        } catch (error) {
            if (error.name === 'AbortError' || error.name === 'CanceledError') return;
            // 保存已累积的失败批次信息
            if (failedBatches.length > 0) {
                setFailedBatchInfo(failedBatches);
            }
            // 即使出错，如果已有部分数据也保留
            if (allTableData.length > 0) {
                const uniqueFunctions = [...new Set(allTableData.map(r => r.functionalProcess).filter(Boolean))];
                setMessages(prev => {
                    const filtered = prev.filter(m => !m.content.startsWith('**批次') && !m.content.startsWith('**阶段2'));
                    return [...filtered, {
                        role: 'assistant',
                        content: `**拆分部分完成**（${completedBatches}/${totalBatches} 批次成功，后续批次出错: ${error.response?.data?.error || error.message}）\n\n已完成部分：\n- **${uniqueFunctions.length}** 个功能过程\n- **${allTableData.length}** 个子过程（CFP）\n\n已完成的数据已保留${failedBatches.length > 0 ? '，可点击**「重试失败批次」**补充拆分丢失的功能过程。' : '，可点击**「重新COSMIC拆分」**继续。'}`,
                        showActions: true
                    }];
                });
            } else {
                setMessages(prev => [...prev, { role: 'assistant', content: `❌ COSMIC拆分失败: ${error.response?.data?.error || error.message}` }]);
            }
            setCurrentStep(0);
            updateAnalysisProgress({
                status: 'error',
                phase: 'Split failed',
                detail: error.response?.data?.error || error.message || 'COSMIC拆分失败'
            });
        } finally {
            setIsLoading(false);
        }
    };

    // ═══════════ 重试失败批次（仅补充拆分失败的功能过程） ═══════════
    const retryFailedBatches = async () => {
        if (failedBatchInfo.length === 0) { showToast('没有需要重试的失败批次'); return; }

        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;
        const retryRunId = createCosmicRunId('retry-split');

        setIsLoading(true);
        setCurrentStep(4);
        updateAnalysisProgress({
            status: 'running',
            title: 'COSMIC split retry',
            phase: 'Retrying failed batches',
            percent: 70,
            current: 0,
            total: failedBatchInfo.length,
            detail: '正在将失败批次重新提交为后台任务。'
        });

        // 只重试当前仍缺失的功能，避免“同批另一个功能已成功”时重复追加CFP。
        const completedKeysBeforeRetry = new Set(
            tableData
                .filter(row => row.dataMovementType === 'E' && row.functionalProcess)
                .map(row => normalizeProcName(row.functionalProcess))
        );
        const retryBatches = failedBatchInfo.map(fb => {
            const pendingIndexes = (fb.functions || [])
                .map((func, index) => ({ func, text: fb.texts?.[index] || '' }))
                .filter(({ func }) => !completedKeysBeforeRetry.has(normalizeProcName(func.functionName)));
            return {
                functions: pendingIndexes.map(item => item.func),
                texts: pendingIndexes.map(item => item.text),
                originalIndex: fb.index,
                names: pendingIndexes.map(item => item.func.functionName).join('、')
            };
        }).filter(batch => batch.functions.length > 0);

        const totalRetry = retryBatches.length;
        const totalFuncCount = retryBatches.reduce((s, b) => s + b.functions.length, 0);

        if (totalRetry === 0) {
            setFailedBatchInfo([]);
            setIsLoading(false);
            setCurrentStep(0);
            updateAnalysisProgress({
                status: 'done',
                phase: 'Retry completed',
                percent: 100,
                current: 0,
                total: 0,
                detail: '之前标记失败的功能过程已经存在，无需重复拆分。'
            });
            return;
        }

        setMessages(prev => [...prev, {
            role: 'system',
            content: `**重试失败批次**\n共 **${totalFuncCount}** 个功能过程（${totalRetry} 个批次），正在补充拆分...`
        }]);

        let allTableData = [...tableData]; // 保留已有数据
        let completedRetry = 0;
        let stillFailed = [];

        try {
            for (let ri = 0; ri < totalRetry; ri++) {
                if (signal.aborted) return;

                const batch = retryBatches[ri];

                setMessages(prev => {
                    const filtered = prev.filter(m => !m.content.startsWith('**重试批次'));
                    return [...filtered, {
                        role: 'system',
                        content: `**重试批次 ${ri + 1}/${totalRetry}**（原批次 ${batch.originalIndex + 1}）| 正在拆分：${batch.names}\n\n进度：${completedRetry}/${totalRetry} 完成`
                    }];
                });

                try {
                    // 重试时也构建每个功能过程的独立层级映射
                    const retryFunctionLevelMap = {};
                    let retryHeadingCtx = null;
                    batch.functions.forEach(f => {
                        if (f.functionName) {
                            const levels = getModuleLevels(f);
                            if (levels.level1 || levels.level2 || levels.level3) {
                                retryFunctionLevelMap[f.functionName] = levels;
                                if (!retryHeadingCtx) {
                                    retryHeadingCtx = { level1: levels.level1, level2: levels.level2, level3: levels.level3 };
                                }
                            }
                        }
                    });
                    const res = await requestCosmicSplitBatch({
                        batchFunctions: batch.texts,
                        batchIndex: batch.originalIndex,
                        totalBatches: totalRetry,
                        documentContent: documentContent.substring(0, 6000),
                        userGuidelines,
                        previousFunctionNames: completedFunctionNames(allTableData),
                        userConfig: getUserConfig(),
                        headingContext: retryHeadingCtx,
                        functionLevelMap: Object.keys(retryFunctionLevelMap).length > 0 ? retryFunctionLevelMap : null,
                        generateDescription,
                        useEnhancedExperience: useEnhancedCosmicExperience
                    }, {
                        signal,
                        requestKey: `${retryRunId}:batch-${batch.originalIndex}`,
                        onStatus: (job) => {
                            const detail = job?.progress?.message || job?.message;
                            if (detail) updateAnalysisProgress({ detail: `Retry batch ${ri + 1}: ${detail}` });
                        }
                    });

                    if (res.data.success) {
                        const newData = res.data.tableData || [];
                        if (newData.length > 0) {
                            // 重试时同样传入白名单，防止重试批次的功能过程被误当作已完成而跳过
                            const retryExpectedNames = new Set([
                                ...batch.functions.map(f => f.functionName.toLowerCase().trim()),
                                ...batch.functions.map(f => normalizeProcName(f.functionName))
                            ]);
                            const deduped = deduplicateData(allTableData, newData, retryExpectedNames);
                            if (deduped.length > 0) {
                                allTableData = orderCosmicTableData([...allTableData, ...deduped], parsedFunctions, moduleStructure);
                                setTableData(allTableData);
                            }
                        }
                        completedRetry++;
                    }
                } catch (retryError) {
                    if (retryError.name === 'AbortError' || retryError.name === 'CanceledError' || signal.aborted) return;

                    const errMsg = retryError.response?.data?.error || retryError.message;
                    console.error(`重试批次 ${ri + 1}（原批次 ${batch.originalIndex + 1}）失败:`, errMsg);
                    stillFailed.push({
                        index: batch.originalIndex,
                        names: batch.names,
                        error: errMsg,
                        functions: batch.functions,
                        texts: batch.texts
                    });

                    setMessages(prev => {
                        const filtered = prev.filter(m => !m.content.startsWith('**重试批次'));
                        return [...filtered, {
                            role: 'system',
                            content: `**重试批次 ${ri + 1}（原批次 ${batch.originalIndex + 1}）再次失败**: ${errMsg}\n\n继续处理...`
                        }];
                    });

                    // 失败后等更久
                    try {
                        await new Promise((resolve, reject) => {
                            const t = setTimeout(resolve, 10000);
                            signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
                        });
                    } catch (e) { if (e.name === 'AbortError' || signal.aborted) return; }
                    continue;
                }

                // 批次间等待
                if (ri < totalRetry - 1) {
                    try {
                        await new Promise((resolve, reject) => {
                            const t = setTimeout(resolve, 5000);
                            signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
                        });
                    } catch (e) { if (e.name === 'AbortError' || signal.aborted) return; }
                }
            }

            // 汇总
            const uniqueFunctions = [...new Set(allTableData.map(r => r.functionalProcess).filter(Boolean))];
            const missingSplitFunctions = findMissingSplitFunctions(parsedFunctions, allTableData);
            if (missingSplitFunctions.length > 0) {
                const missingKeys = new Set(missingSplitFunctions.map(f => normalizeProcName(f.functionName)));
                retryBatches.forEach(batch => {
                    if (stillFailed.some(item => item.index === batch.originalIndex)) return;
                    if (!batch.functions.some(f => missingKeys.has(normalizeProcName(f.functionName)))) return;
                    stillFailed.push({
                        index: batch.originalIndex,
                        names: batch.names,
                        error: '重试后完整性检查仍发现未拆分功能过程',
                        functions: batch.functions,
                        texts: batch.texts
                    });
                });
            }
            setFailedBatchInfo(stillFailed);
            const successfulRetry = Math.max(0, totalRetry - new Set(stillFailed.map(item => item.index)).size);
            let summaryContent = stillFailed.length === 0 && missingSplitFunctions.length === 0
                ? `**失败批次全部重试成功**\n\n`
                : `**失败批次重试完成**（${successfulRetry}/${totalRetry} 成功）\n\n`;
            summaryContent += `当前合计：\n- **${uniqueFunctions.length}** 个功能过程\n- **${allTableData.length}** 个子过程（CFP点数）`;
            summaryContent += `\n- E: ${allTableData.filter(r => r.dataMovementType === 'E').length} | R: ${allTableData.filter(r => r.dataMovementType === 'R').length} | W: ${allTableData.filter(r => r.dataMovementType === 'W').length} | X: ${allTableData.filter(r => r.dataMovementType === 'X').length}`;
            if (missingSplitFunctions.length > 0) {
                const missingList = missingSplitFunctions.map(f => `- ${f.functionName}`).join('\n');
                summaryContent += `\n\n⚠️ **仍有 ${missingSplitFunctions.length} 个功能过程未完成COSMIC拆分**\n${missingList}`;
                console.warn('[COSMIC coverage] missing functional processes after retry', missingSplitFunctions.map(f => f.functionName));
            }

            if (stillFailed.length > 0) {
                summaryContent += `\n\n仍有 ${stillFailed.length} 个批次失败，可再次点击**「重试失败批次」**：\n`;
                summaryContent += stillFailed.map(fb => `- 批次 ${fb.index + 1}: ${fb.names}`).join('\n');
            }

            setMessages(prev => {
                const filtered = prev.filter(m => !m.content.startsWith('**重试'));
                return [...filtered, {
                    role: 'assistant',
                    content: summaryContent,
                    showActions: true
                }];
            });
            setCurrentStep(0);
            updateAnalysisProgress({
                status: stillFailed.length > 0 || missingSplitFunctions.length > 0 ? 'waiting' : 'done',
                phase: stillFailed.length > 0 || missingSplitFunctions.length > 0 ? 'Retry partially completed' : 'Retry completed',
                percent: 100,
                current: successfulRetry,
                total: totalRetry,
                detail: stillFailed.length > 0
                    ? '仍有批次失败，可再次重试。'
                    : missingSplitFunctions.length > 0
                        ? '仍有功能过程未拆分，请检查缺失清单。'
                        : '全部失败批次已经补齐。'
            });
        } catch (error) {
            if (error.name === 'AbortError' || error.name === 'CanceledError') return;
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `❌ 重试失败: ${error.response?.data?.error || error.message}`
            }]);
            setCurrentStep(0);
            updateAnalysisProgress({
                status: 'error',
                phase: 'Retry failed',
                detail: error.response?.data?.error || error.message || '失败批次重试失败'
            });
        } finally {
            setIsLoading(false);
        }
    };

    // ═══════════ 一键完成模式 ═══════════
    const startOneKeyAnalysis = async () => {
        if (!documentContent) { showToast('请先上传文档'); return; }

        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;
        const oneKeyRunId = createCosmicRunId('one-key');

        setIsLoading(true);
        setIsWaitingForAnalysis(false);
        setTableData([]);
        updateAnalysisProgress({
            status: 'running',
            title: 'COSMIC one-key analysis',
            phase: 'Document understanding',
            percent: 5,
            current: 0,
            total: 15,
            detail: '后台正在理解文档，页面连接中断后会自动恢复。'
        });

        let allTableData = [];
        let round = 1;
        const maxRounds = 15;
        let lastCoverage = null;

        try {
            // 阶段1: 文档理解
            setMessages([{ role: 'system', content: '🔍 **阶段1：深度理解文档**\n正在分析文档结构...' }]);

            let understanding = null;
            try {
                const understandRes = await runDocumentUnderstandingJob({
                    httpClient: axios,
                    payload: {
                        documentContent,
                        userConfig: getUserConfig()
                    },
                    requestKey: `${oneKeyRunId}:understand`,
                    signal,
                    onStatus: job => {
                        const message = job?.progress?.message || job?.message;
                        if (message) updateAnalysisProgress({ detail: message });
                    }
                });

                if (understandRes.success && isUsableDocumentUnderstanding(understandRes.understanding)) {
                    understanding = understandRes.understanding;
                    const modules = understanding.coreModules;
                    const moduleSummary = modules.map((m, i) => {
                        const funcs = m.estimatedFunctions || [];
                        const funcList = funcs.map(f =>
                            typeof f === 'object' ? `${f.functionName} [${f.triggerType}]` : f
                        ).join('、');
                        return `**${i + 1}. ${m.moduleName}** - ${funcList}`;
                    }).join('\n\n');
                    const estimatedCount = Number(understanding.totalEstimatedFunctions) > 0
                        ? understanding.totalEstimatedFunctions
                        : '未生成';
                    const recoveryNote = understandRes.recoveryMode === 'continued'
                        ? '\n\n> 输出曾达到长度上限，系统已自动续写并校验。'
                        : understandRes.recoveryMode === 'compact-retry'
                            ? '\n\n> 首次输出不完整，系统已用紧凑结构重新生成并校验。'
                            : '';

                    setMessages([{
                        role: 'assistant',
                        content: `## 文档理解完成\n\n**项目**: ${understanding.projectName}\n**预估功能数**: ${estimatedCount}\n\n### 核心模块\n${moduleSummary || '暂无'}${recoveryNote}\n\n**开始COSMIC拆分...**`
                    }]);
                    await new Promise((resolve, reject) => {
                        const t = setTimeout(resolve, 1000);
                        signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
                    });
                } else {
                    throw new Error('文档理解未返回通过校验的业务结构');
                }
            } catch (e) {
                if (e.name === 'AbortError' || signal.aborted) return;
                understanding = null;
                const reason = e.response?.data?.error || e.message || '结果格式无效';
                setMessages([{
                    role: 'system',
                    content: `⚠️ 文档理解未生成有效结构，已跳过辅助理解并继续按原文拆分。\n\n原因：${reason}`
                }]);
            }

            // 阶段2: 循环拆分
            let completedNaturally = false;
            while (round <= maxRounds) {
                if (signal.aborted) return;
                const uniqueFunctions = [...new Set(allTableData.map(r => r.functionalProcess).filter(Boolean))];

                setMessages(prev => {
                    const filtered = prev.filter(m => !m.content.startsWith('**第 '));
                    return [...filtered, {
                        role: 'system',
                        content: extractionMode === 'quantity'
                            ? `**第 ${round} 轮分析** | 已识别 ${allTableData.length} 个子过程 / 目标 ${minFunctionCount} 个功能过程`
                            : `**第 ${round} 轮分析** | 已识别 ${allTableData.length} 个子过程 / ${[...new Set(allTableData.map(r => r.functionalProcess).filter(Boolean))].length} 个功能过程`
                    }];
                });
                updateAnalysisProgress({
                    status: 'running',
                    phase: `One-key split round ${round}`,
                    percent: Math.min(92, 10 + Math.round((round / maxRounds) * 82)),
                    current: round,
                    total: maxRounds,
                    detail: `第 ${round} 轮已在后台执行；网络短暂中断会自动续查。`,
                    stats: `${uniqueFunctions.length} functions · ${allTableData.length} CFP`
                });

                const response = await runContinueAnalysisJob({
                    httpClient: axios,
                    payload: {
                        documentContent,
                        previousFunctionNames: completedFunctionNames(allTableData),
                        round,
                        targetFunctions: minFunctionCount,
                        understanding,
                        userGuidelines,
                        userConfig: getUserConfig(),
                        coverageVerification: lastCoverage,
                        extractionMode,
                        useEnhancedExperience: useEnhancedCosmicExperience
                    },
                    requestKey: `${oneKeyRunId}:round-${round}`,
                    signal,
                    onStatus: job => {
                        const message = job?.progress?.message || job?.message;
                        if (message) updateAnalysisProgress({ detail: message });
                    }
                });

                if (!response?.success) {
                    throw new Error(`第 ${round} 轮未返回可用的分析结果`);
                }

                let roundResult = resolveContinueAnalysisRound(response);
                // 兼容尚未返回结构化 tableData 的旧服务端；新服务端不再二次解析。
                if (roundResult.needsLegacyParse) {
                    const tableRes = await axios.post('/api/parse-table', { markdown: response.reply }, { signal });
                    if (!tableRes.data?.success) {
                        throw new Error(`第 ${round} 轮结果无法解析为COSMIC表格，已停止以避免误报完成`);
                    }
                    roundResult = resolveContinueAnalysisRound(response, tableRes.data.tableData);
                }

                if (!roundResult.isValid) {
                    throw new Error(`第 ${round} 轮结果无法解析为COSMIC表格，已停止以避免误报完成`);
                }

                if (roundResult.shouldMerge) {
                    const deduped = deduplicateData(allTableData, roundResult.tableData);
                    if (deduped.length > 0) {
                        allTableData = orderCosmicTableData([...allTableData, ...deduped], parsedFunctions, moduleStructure);
                        setTableData(allTableData);
                    }
                }

                // 覆盖不足时，完成标记是合法的“无新增行控制帧”；保存审查结果并进入下一轮。
                lastCoverage = roundResult.coverageVerification;
                if (roundResult.shouldFinish) {
                    completedNaturally = true;
                    break;
                }

                round++;
                if (round <= maxRounds) {
                    try {
                        await new Promise((resolve, reject) => {
                            const t = setTimeout(resolve, 5000);
                            signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
                        });
                    } catch (e) { if (e.name === 'AbortError' || signal.aborted) return; }
                }
            }

            // 最终汇总
            const uniqueFunctions = [...new Set(allTableData.map(r => r.functionalProcess).filter(Boolean))];
            setMessages(prev => {
                const filtered = prev.filter(m => !m.content.startsWith('**第 '));
                return [...filtered, {
                    role: 'assistant',
                    content: `${completedNaturally ? '**分析完成**' : '**已达到15轮上限，当前结果已保留，请检查是否仍有遗漏**'}\n\n经过 **${Math.min(round, maxRounds)}** 轮分析：\n- **${uniqueFunctions.length}** 个功能过程\n- **${allTableData.length}** 个子过程（CFP）\n- E: ${allTableData.filter(r => r.dataMovementType === 'E').length} | R: ${allTableData.filter(r => r.dataMovementType === 'R').length} | W: ${allTableData.filter(r => r.dataMovementType === 'W').length} | X: ${allTableData.filter(r => r.dataMovementType === 'X').length}`,
                    showActions: true
                }];
            });
            updateAnalysisProgress({
                status: completedNaturally ? 'done' : 'waiting',
                phase: completedNaturally ? 'One-key analysis completed' : 'Round limit reached',
                percent: 100,
                current: Math.min(round, maxRounds),
                total: maxRounds,
                detail: completedNaturally ? '一键拆分及覆盖检查已完成。' : '已保留当前结果；请检查后决定是否继续补充。',
                stats: `${uniqueFunctions.length} functions · ${allTableData.length} CFP`
            });
        } catch (error) {
            if (error.name === 'AbortError' || error.name === 'CanceledError') return;
            setMessages(prev => [...prev, { role: 'assistant', content: `❌ 分析失败: ${error.response?.data?.error || error.message}` }]);
            updateAnalysisProgress({
                status: 'error',
                phase: 'One-key analysis failed',
                detail: error.response?.data?.error || error.message || '一键拆分失败'
            });
        } finally {
            setIsLoading(false);
        }
    };

    // ═══════════ 对话功能 ═══════════
    const groupCosmicRowsForConversation = (rows = []) => {
        const groups = [];
        let current = null;
        rows.forEach(row => {
            if (row.dataMovementType === 'E' && row.functionalProcess) {
                if (current) groups.push(current);
                current = {
                    functionName: row.functionalProcess,
                    rows: [row]
                };
            } else if (current) {
                current.rows.push(row);
            }
        });
        if (current) groups.push(current);
        return groups;
    };

    const conversationFunctionKey = (name) => (
        canonicalFunctionKey(name || '') || normalizeProcName(name || '')
    );

    const resolveConversationFunction = (target, functions, existingGroups) => {
        const targetKey = conversationFunctionKey(target.functionName);
        const explicit = target.function?.functionName ? target.function : null;
        const matched = functions.find(func => conversationFunctionKey(func.functionName) === targetKey);
        const existingGroup = existingGroups.find(group => (
            conversationFunctionKey(group.functionName) === targetKey
        ));
        const existingERow = existingGroup?.rows?.[0] || {};
        return {
            triggerEvent: explicit?.triggerEvent || matched?.triggerEvent || existingERow.triggerEvent || '用户触发',
            functionalUser: explicit?.functionalUser || matched?.functionalUser || existingERow.functionalUser || '发起者：用户 接收者：用户',
            functionName: explicit?.functionName || matched?.functionName || target.functionName,
            description: explicit?.description || matched?.description || existingERow.functionDescription || '',
            level1: explicit?.level1 || matched?.level1 || existingERow.level1 || '',
            level2: explicit?.level2 || matched?.level2 || existingERow.level2 || '',
            level3: explicit?.level3 || matched?.level3 || existingERow.level3 || '',
            existingRows: existingGroup?.rows || []
        };
    };

    const applyConversationCosmicTargets = async ({
        targets,
        nextFunctions,
        nextDocumentContent,
        baseTableData,
        signal = null
    }) => {
        const allTargets = Array.isArray(targets) ? targets : [];
        if (allTargets.length === 0) return baseTableData;

        const originalGroups = groupCosmicRowsForConversation(baseTableData);
        const targetKeys = new Set(allTargets.map(target => conversationFunctionKey(target.functionName)));
        let workingRows = originalGroups
            .filter(group => !targetKeys.has(conversationFunctionKey(group.functionName)))
            .flatMap(group => group.rows);
        const regenerationTargets = allTargets.filter(target => target.type !== 'delete');
        const batchSize = 2;
        const conversationRunId = createCosmicRunId('conversation-split');

        for (let start = 0; start < regenerationTargets.length; start += batchSize) {
            const batchTargets = regenerationTargets.slice(start, start + batchSize);
            const batchFunctions = batchTargets.map(target => (
                resolveConversationFunction(target, nextFunctions, originalGroups)
            ));
            const batchTexts = batchFunctions.map((func, index) => {
                const target = batchTargets[index];
                const existingSummary = func.existingRows.length
                    ? func.existingRows.map(row => (
                        `${row.dataMovementType}:${row.subProcessDesc || ''}`
                        + `；数据组=${row.dataGroup || ''}`
                        + `；属性=${row.dataAttributes || ''}`
                    )).join('\n')
                    : '无现有拆分，本次为新增功能过程。';
                return `##触发事件：${func.triggerEvent}\n`
                    + `##功能用户：${func.functionalUser}\n`
                    + `##功能过程：${func.functionName}\n`
                    + `##功能过程描述：${func.description}\n`
                    + `##本次对话修改要求：${target.instruction || '根据用户要求重新生成完整且合规的COSMIC拆分'}\n`
                    + `##现有拆分参考：\n${existingSummary}`;
            });
            const functionLevelMap = {};
            batchFunctions.forEach(func => {
                functionLevelMap[func.functionName] = {
                    level1: func.level1 || '',
                    level2: func.level2 || '',
                    level3: func.level3 || ''
                };
            });
            const firstLevels = functionLevelMap[batchFunctions[0]?.functionName] || null;
            const response = await requestCosmicSplitBatch({
                batchFunctions: batchTexts,
                batchIndex: Math.floor(start / batchSize),
                totalBatches: Math.ceil(regenerationTargets.length / batchSize),
                documentContent: String(nextDocumentContent || '').slice(0, 6000),
                userGuidelines,
                previousFunctionNames: completedFunctionNames(workingRows),
                userConfig: getUserConfig(),
                headingContext: firstLevels,
                functionLevelMap,
                generateDescription,
                useEnhancedExperience: useEnhancedCosmicExperience
            }, {
                signal,
                requestKey: `${conversationRunId}:batch-${Math.floor(start / batchSize)}`,
                onStatus: job => {
                    const message = job?.progress?.message || job?.message;
                    if (message) setStreamingContent(`正在更新COSMIC表格：${message}`);
                }
            });
            const generatedRows = response.data?.tableData || [];
            if (!response.data?.success || generatedRows.length === 0) {
                throw new Error(`功能过程“${batchFunctions.map(func => func.functionName).join('、')}”未返回有效拆分结果`);
            }
            const expectedNames = new Set([
                ...batchFunctions.map(func => func.functionName.toLowerCase().trim()),
                ...batchFunctions.map(func => normalizeProcName(func.functionName))
            ]);
            const deduped = deduplicateData(workingRows, generatedRows, expectedNames);
            workingRows = [...workingRows, ...deduped];
        }

        return orderCosmicTableData(workingRows, nextFunctions, moduleStructure);
    };

    const applyConversationStateUpdate = async (action, { signal = null } = {}) => {
        const nextDocumentContent = typeof action.documentContent === 'string'
            ? action.documentContent
            : documentContent;
        const nextFunctions = inheritMissingFunctionLevels(
            (Array.isArray(action.functions) ? action.functions : parsedFunctions).map(func => ({
                ...func,
                id: func.id || generateId(),
                selected: func.selected !== false
            }))
        );

        let nextTableData = tableData;
        if (Array.isArray(action.cosmicTargets) && action.cosmicTargets.length > 0) {
            setStreamingContent('正在调用原COSMIC拆分流程同步更新表格…');
            nextTableData = await applyConversationCosmicTargets({
                targets: action.cosmicTargets,
                nextFunctions,
                nextDocumentContent,
                baseTableData: tableData,
                signal
            });
        }

        // COSMIC联动成功后一次性提交状态，取消/失败时不留下半更新工作区。
        setDocumentContent(nextDocumentContent);
        setParsedFunctions(nextFunctions);
        setFunctionListText(action.functionListText || functionsToText(nextFunctions));
        if (Array.isArray(action.cosmicTargets) && action.cosmicTargets.length > 0) {
            setTableData(nextTableData);
        }

        if (nextFunctions.length > 0 && nextTableData.length === 0) {
            setCurrentStep(3);
        }
        return {
            functions: nextFunctions.length,
            cfp: nextTableData.length,
            cosmicUpdated: action.cosmicTargets?.length || 0
        };
    };

    const sendMessage = async () => {
        if (!inputText.trim() || isLoading) return;
        const userMessage = inputText.trim();
        const conversationHistory = messages
            .filter(message => ['user', 'assistant'].includes(message.role))
            .slice(-10)
            .map(message => ({ role: message.role, content: message.content }));
        setInputText('');
        setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
        setIsLoading(true);
        setStreamingContent('');
        beginAiActivity();
        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;

        try {
            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: userMessage }],
                    conversationHistory,
                    documentContent,
                    userGuidelines,
                    userConfig: getUserConfig(),
                    tableData,
                    functionListText,
                    parsedFunctions
                }),
                signal
            });
            if (!response.ok) {
                let errorMessage = `对话请求失败 (${response.status})`;
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorMessage;
                } catch (error) { /* ignore non-JSON error */ }
                throw new Error(errorMessage);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let streamBuffer = '';
            let pendingAction = null;
            let streamError = '';

            while (true) {
                const { done, value } = await reader.read();
                streamBuffer += decoder.decode(value || new Uint8Array(), { stream: !done });
                const frames = streamBuffer.split(/\r?\n\r?\n/);
                streamBuffer = frames.pop() || '';

                for (const frame of frames) {
                    const data = frame
                        .split(/\r?\n/)
                        .filter(line => line.startsWith('data: '))
                        .map(line => line.slice(6))
                        .join('\n');
                    if (!data || data === '[DONE]') continue;
                    let parsed = null;
                    try {
                        parsed = JSON.parse(data);
                    } catch (error) {
                        continue;
                    }
                    if (parsed.activity) {
                        upsertAiActivity(parsed.activity);
                    }
                    if (parsed.content) {
                        fullContent += parsed.content;
                        setStreamingContent(fullContent);
                    }
                    if (parsed.action) pendingAction = parsed.action;
                    if (parsed.error) streamError = parsed.error;
                }
                if (done) break;
            }
            if (streamError) throw new Error(streamError);

            if (fullContent || pendingAction) {
                let finalContent = fullContent || '已理解并准备应用本次修改。';
                if (pendingAction?.type === 'state_update') {
                    upsertAiActivity({
                        id: 'workspace-sync',
                        sequence: Number.MAX_SAFE_INTEGER - 1,
                        title: '同步更新当前工作区',
                        detail: pendingAction.cosmicTargets?.length > 0
                            ? `正在调用原 COSMIC 流程更新 ${pendingAction.cosmicTargets.length} 个功能过程。`
                            : '正在更新需求文档和功能清单。',
                        status: 'running'
                    });
                    try {
                        const updateStats = await applyConversationStateUpdate(pendingAction, { signal });
                        upsertAiActivity({
                            id: 'workspace-sync',
                            sequence: Number.MAX_SAFE_INTEGER - 1,
                            title: '同步更新当前工作区',
                            detail: `同步完成：${updateStats.functions} 个功能过程、${updateStats.cfp} CFP。`,
                            status: 'done',
                            meta: updateStats
                        });
                        if (pendingAction.cosmicTargets?.length > 0) {
                            finalContent += `\n\n✅ 已通过原COSMIC拆分流程完成联动更新。当前共 **${updateStats.functions}** 个功能过程、**${updateStats.cfp}** CFP。`;
                        } else {
                            finalContent += '\n\n✅ 变更已写入当前系统状态，预览、表格和后续导出将使用更新后的内容。';
                        }
                    } catch (updateError) {
                        if (
                            signal.aborted
                            || updateError.name === 'AbortError'
                            || updateError.name === 'CanceledError'
                            || updateError.code === 'ERR_CANCELED'
                        ) throw updateError;
                        upsertAiActivity({
                            id: 'workspace-sync',
                            sequence: Number.MAX_SAFE_INTEGER - 1,
                            title: '同步更新当前工作区',
                            detail: updateError.response?.data?.error || updateError.message,
                            status: 'error'
                        });
                        finalContent += `\n\n⚠️ 文档/功能清单修改已处理，但COSMIC表格联动失败：${updateError.response?.data?.error || updateError.message}`;
                    }
                }
                const completedActivity = completeAiActivity('done');
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: finalContent,
                    activity: {
                        ...completedActivity,
                        visible: false,
                        durationMs: completedActivity.endedAt - completedActivity.startedAt
                    }
                }]);
            }
            setStreamingContent('');
        } catch (error) {
            if (signal.aborted || error.name === 'AbortError' || error.name === 'CanceledError') {
                completeAiActivity('error', '已取消');
                return;
            }
            const failedActivity = completeAiActivity('error', error.message);
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `❌ 对话失败: ${error.message}`,
                activity: {
                    ...failedActivity,
                    visible: false,
                    durationMs: failedActivity.endedAt - failedActivity.startedAt
                }
            }]);
        } finally {
            if (abortControllerRef.current?.signal === signal) abortControllerRef.current = null;
            setIsLoading(false);
            setStreamingContent('');
            hideAiActivity();
        }
    };

    // ═══════════ 导出Excel ═══════════
    const exportExcel = async () => {
        if (tableData.length === 0) { showToast('没有可导出的数据'); return; }
        try {
            let sequenceDiagrams = null;
            const exportTableData = orderCosmicTableData(tableData, parsedFunctions, moduleStructure);

            // 如果勾选了「附带时序图」，先在客户端生成所有时序图PNG
            if (exportWithDiagrams) {
                setIsGeneratingDiagrams(true);
                setDiagramProgress('正在生成时序图...');
                showToast('正在生成时序图，请稍候...');
                try {
                    sequenceDiagrams = await generateAllDiagramImages(
                        exportTableData,
                        (current, total) => {
                            setDiagramProgress(`生成时序图 ${current}/${total}`);
                        }
                    );
                    setDiagramProgress(`已生成 ${sequenceDiagrams.length} 张时序图，正在导出...`);
                } catch (err) {
                    console.warn('时序图生成部分失败:', err);
                    showToast('部分时序图生成失败，将导出无时序图版本');
                    sequenceDiagrams = null;
                }
            }

            const response = await axios.post('/api/export-excel',
                {
                    tableData: exportTableData,
                    filename: `COSMIC拆分_${documentName || '结果'}`,
                    exportTemplate: excelExportTemplate,
                    sequenceDiagrams: sequenceDiagrams && sequenceDiagrams.length > 0 ? sequenceDiagrams : undefined
                },
                { responseType: 'blob', timeout: 120000 }
            );
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.download = `COSMIC拆分_${documentName || '结果'}${excelExportTemplate === 'assessment' ? '_评估模板' : ''}${sequenceDiagrams ? '_含时序图' : ''}.xlsx`;
            link.click();
            window.URL.revokeObjectURL(url);
            showToast(sequenceDiagrams ? `Excel导出成功（含 ${sequenceDiagrams.length} 张时序图）` : 'Excel导出成功');
        } catch (error) {
            showToast('导出失败: ' + error.message);
        } finally {
            setIsGeneratingDiagrams(false);
            setDiagramProgress('');
        }
    };

    // ═══════════ 导出Word文档（借鉴omega-cosmic的DocBuilder） ═══════════
    const exportWord = async () => {
        if (tableData.length === 0) { showToast('没有可导出的数据'); return; }
        try {
            let sequenceDiagrams = null;
            const exportTableData = orderCosmicTableData(tableData, parsedFunctions, moduleStructure);

            // 如果勾选了「附带时序图」，先在客户端生成所有时序图PNG
            if (exportWithDiagrams) {
                setIsGeneratingDiagrams(true);
                setDiagramProgress('正在生成时序图...');
                showToast('正在生成时序图，请稍候...');
                try {
                    sequenceDiagrams = await generateAllDiagramImages(
                        exportTableData,
                        (current, total) => {
                            setDiagramProgress(`生成时序图 ${current}/${total}`);
                        }
                    );
                    setDiagramProgress(`已生成 ${sequenceDiagrams.length} 张时序图，正在生成Word...`);
                } catch (err) {
                    console.warn('时序图生成部分失败:', err);
                    showToast('部分时序图生成失败，将导出无时序图版本');
                    sequenceDiagrams = null;
                }
            }

            const response = await axios.post('/api/export-word',
                {
                    tableData: exportTableData,
                    filename: `COSMIC功能规格说明书_${documentName || '结果'}`,
                    documentName: documentName || '',
                    exportTemplate: wordExportTemplate,
                    sequenceDiagrams: sequenceDiagrams && sequenceDiagrams.length > 0 ? sequenceDiagrams : undefined
                },
                { responseType: 'blob', timeout: 120000 }
            );
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.download = `COSMIC功能规格说明书_${documentName || '结果'}${wordExportTemplate === 'business-spec' ? '_完整说明书' : '_模块层级版'}${sequenceDiagrams ? '_含时序图' : ''}.docx`;
            link.click();
            window.URL.revokeObjectURL(url);
            showToast(sequenceDiagrams ? `Word导出成功（含 ${sequenceDiagrams.length} 张时序图）` : 'Word文档导出成功');
        } catch (error) {
            showToast('导出Word失败: ' + error.message);
        } finally {
            setIsGeneratingDiagrams(false);
            setDiagramProgress('');
        }
    };

    const copyContent = (content) => {
        navigator.clipboard.writeText(content);
        setCopied(true);
        showToast('已复制到剪贴板');
        setTimeout(() => setCopied(false), 2000);
    };

    const renderExcelTemplateSelect = () => (
        <label className="excel-template-select" title="选择Excel导出模板">
            <span>模板</span>
            <select value={excelExportTemplate} onChange={e => setExcelExportTemplate(e.target.value)}>
                <option value="standard">标准结果</option>
                <option value="assessment">COSMIC评估模板</option>
            </select>
        </label>
    );

    const renderWordTemplateSelect = () => (
        <label className="excel-template-select" title="选择Word导出模板">
            <span>Word模板</span>
            <select value={wordExportTemplate} onChange={e => setWordExportTemplate(e.target.value)}>
                <option value="hierarchy">模块层级文档</option>
                <option value="business-spec">完整说明书（原模板）</option>
            </select>
        </label>
    );

    const renderEnhancedExperienceToggle = () => (
        <label className="seq-export-toggle cosmic-experience-toggle" title="拆分前注入COSMIC经验规则：查询不强制写W、CRUD/导入导出/流程/定时/接口按经验模板校准">
            <input
                type="checkbox"
                checked={useEnhancedCosmicExperience}
                onChange={e => setUseEnhancedCosmicExperience(e.target.checked)}
            />
            <BookOpen size={12} /> 拆分经验增强版
        </label>
    );

    const renderSplitExecutionModeToggle = () => (
        <div
            className="split-execution-toggle"
            role="group"
            aria-label="COSMIC 执行模式"
            title={splitExecutionMode === 'fast'
                ? `短文档最多 ${COSMIC_FAST_CONCURRENCY} 路并发；大文档、40个以上功能或多章节会自动改为串行`
                : '功能提取和COSMIC拆分均串行执行，适合容易限流或更看重稳定性的模型'}
        >
            <span className="split-execution-label">执行模式</span>
            <button
                type="button"
                className={splitExecutionMode === 'stable' ? 'active stable' : ''}
                onClick={() => setSplitExecutionMode('stable')}
                disabled={isLoading}
            >
                稳健
            </button>
            <button
                type="button"
                className={splitExecutionMode === 'fast' ? 'active fast' : ''}
                onClick={() => setSplitExecutionMode('fast')}
                disabled={isLoading}
            >
                <Zap size={11} /> 快速
            </button>
        </div>
    );

    // ═══════════ 补充功能描述 ═══════════
    const supplementDescription = async () => {
        if (tableData.length === 0) {
            showToast('没有可补充的数据');
            return;
        }

        // 检查是否已有功能描述
        const hasDescription = tableData.some(row => row.functionDescription);
        if (hasDescription) {
            const confirm = window.confirm('检测到已有功能描述，是否覆盖重新生成？');
            if (!confirm) return;
        }

        setIsSupplementingDescription(true);
        try {
            const response = await axios.post('/api/supplement-description', {
                tableData,
                userConfig: getUserConfig()
            });

            if (response.data.success) {
                setTableData(response.data.tableData);
                const descGen = response.data.descriptionGeneration || {};
                const descStatus = descGen.source === 'local-fallback'
                    ? `AI生成失败，已用本地规则兜底 ${descGen.fallbackCount || 0} 条`
                    : `AI生成 ${descGen.generatedCount || 0} 条${descGen.fallbackCount ? `，本地兜底 ${descGen.fallbackCount} 条` : ''}`;
                showToast('功能描述补充完成');
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `✅ **功能描述已补充**\n\n已为 ${response.data.supplementedCount} 个功能过程重新生成功能描述。\n\n${descStatus}。`
                }]);
            }
        } catch (error) {
            showToast('补充功能描述失败: ' + (error.response?.data?.error || error.message));
        } finally {
            setIsSupplementingDescription(false);
        }
    };

    const clearChat = () => {
        setMessages([]);
        setTableData([]);
        setDocumentContent('');
        setDocumentName('');
        setFunctionListText('');
        setParsedFunctions([]);
        setCurrentStep(0);
        setIsWaitingForAnalysis(false);
        setModuleStructure(null);
        setQuantityPlan(null);
        setFailedBatchInfo([]);
        resetAnalysisProgress();
        resetAiActivity();
    };

    const stopAnalysis = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsLoading(false);
            setCurrentStep(failedBatchInfo.length > 0 ? 0 : (parsedFunctions.length > 0 ? 3 : 0));
            updateAnalysisProgress({
                status: 'canceled',
                phase: 'Stopped',
                detail: '已停止页面等待，并已请求取消当前后台任务。'
            });
            showToast('分析已停止，可重新开始或重试失败批次');
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ═══════════ 功能列表结构化管理 ═══════════

    // 将 ##格式的纯文本 解析为结构化数组
    const parseFunctionListText = (text) => {
        if (!text) return [];
        const functions = [];
        // 按 ##触发事件 分隔
        const blocks = text.split(/(?=##\s*触发事件[：:])/).filter(b => b.trim());
        for (const block of blocks) {
            const lines = block.trim().split('\n');
            const func = {
                id: `func_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                triggerEvent: '',
                functionalUser: '',
                functionName: '',
                description: '',
                selected: true,
                sourceChapter: '',
                level1: '',
                level2: '',
                level3: ''
            };
            for (const line of lines) {
                const t = line.trim();
                if (t.match(/^##\s*触发事件[：:]/)) {
                    func.triggerEvent = t.replace(/^##\s*触发事件[：:]\s*/, '').trim();
                } else if (t.match(/^##\s*功能用户[：:]/)) {
                    func.functionalUser = t.replace(/^##\s*功能用户[：:]\s*/, '').trim();
                } else if (t.match(/^##\s*功能过程[：:]/) && !t.match(/描述/)) {
                    const raw = t.replace(/^##\s*功能过程[：:]\s*/, '').trim();
                    const chMatch = raw.match(/^\[(.*?)\]/);
                    if (chMatch) func.sourceChapter = chMatch[1];
                    func.functionName = raw.replace(/^\[.*?\]\s*/, '').trim();
                } else if (t.match(/^##\s*功能过程描述[：:]/)) {
                    func.description = t.replace(/^##\s*功能过程描述[：:]\s*/, '').trim();
                }
            }
            if (func.functionName) {
                functions.push(func);
            }
        }
        // 填入 level1/level2/level3（根据 moduleStructure 匹配 sourceChapter）
        // 辅助函数：用 businessObjects 关键词模糊匹配模块
        const fuzzyMatchModule = (func, modules) => {
            if (!modules || modules.length === 0) return null;
            const fname = (func.functionName || '').toLowerCase();
            const fdesc = (func.description || '').toLowerCase();
            const combined = fname + ' ' + fdesc;
            if (!combined.trim()) return null;
            let bestMatch = null;
            let bestScore = 0;
            for (const m of modules) {
                let score = 0;
                // 匹配业务对象关键词
                const bos = m.businessObjects || [];
                for (const bo of bos) {
                    const boKey = bo.replace(/[（()）\[\]]/g, '').toLowerCase().trim();
                    if (boKey.length >= 2) {
                        const checkLen = Math.min(4, boKey.length);
                        if (combined.includes(boKey.substring(0, checkLen))) {
                            score += boKey.length;
                        }
                    }
                }
                // 匹配模块名称关键词
                const modName = (m.level3 || '').replace(/^[\d.]+\s*/, '').toLowerCase().trim();
                if (modName.length >= 2) {
                    const checkLen = Math.min(4, modName.length);
                    if (combined.includes(modName.substring(0, checkLen))) {
                        score += modName.length;
                    }
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = m;
                }
            }
            return bestScore >= 2 ? bestMatch : null;
        };

        const getModulesForSourceChapter = (func, modules) => {
            if (!Array.isArray(modules) || modules.length === 0) return [];
            const source = String(func.sourceChapter || '').trim();
            if (!source) return modules;

            const sourceNorm = normalizeHeadingMatchText(source);
            const sourceNumber = source.match(/^(\d+(?:\.\d+)*)/)?.[1] || '';
            const sourceTopNumber = sourceNumber.split('.')[0] || '';
            const scoped = modules.filter(m => {
                const fields = [m.level3, m.level2, m.level1];
                if (fields.some(value => normalizeHeadingMatchText(value) === sourceNorm)) return true;
                if (!sourceTopNumber) return false;
                const level1Number = String(m.level1 || '').match(/^(\d+)/)?.[1] || '';
                return sourceNumber.split('.').length === 1 && level1Number === sourceTopNumber;
            });
            return scoped.length > 0 ? scoped : modules;
        };

        functions.forEach(f => {
            if (moduleStructure && moduleStructure.modules) {
                const candidates = getModulesForSourceChapter(f, moduleStructure.modules);
                let matched = fuzzyMatchModule(f, candidates);
                if (matched) {
                    f.level1 = matched.level1 || '';
                    f.level2 = matched.level2 || '';
                    f.level3 = matched.level3 || '';
                    return;
                }

                // The source chapter is still authoritative for the top-level
                // scope. Do not borrow an unrelated child module just because a
                // short keyword also appears elsewhere in the document.
                if (f.sourceChapter && candidates.length > 0) {
                    const level1Values = [...new Set(candidates.map(m => m.level1).filter(Boolean))];
                    if (level1Values.length === 1) f.level1 = level1Values[0];
                    if (candidates.length === 1) {
                        f.level2 = candidates[0].level2 || '';
                        f.level3 = candidates[0].level3 || '';
                    }
                    return;
                }
            }

            const originalHeading = matchFunctionToOriginalHeading(f, documentHeadingOutline);
            if (!originalHeading) return;
            f.level1 = originalHeading.levels.level1 || '';
            f.level2 = originalHeading.levels.level2 || '';
            f.level3 = originalHeading.levels.level3 || '';
            f.sourceChapter = originalHeading.title || f.sourceChapter || '';
        });
        return inheritMissingFunctionLevels(functions);
    };

    // 根据功能过程的 sourceChapter 获取三级模块信息
    const getModuleLevels = (func) => {
        // Prefer the reviewed/function-scoped hierarchy. A fuzzy document-wide
        // match must never overwrite a precise module assignment.
        if (func.level1 || func.level2 || func.level3) {
            return { level1: func.level1 || '', level2: func.level2 || '', level3: func.level3 || '' };
        }

        const originalHeading = matchFunctionToOriginalHeading(func, documentHeadingOutline);
        if (originalHeading) {
            return {
                level1: originalHeading.levels.level1 || '',
                level2: originalHeading.levels.level2 || '',
                level3: originalHeading.levels.level3 || ''
            };
        }
        const ch = func.sourceChapter || '';
        if (moduleStructure && moduleStructure.modules) {
            // 1. 精确匹配 sourceChapter
            if (ch) {
                const matched = moduleStructure.modules.find(m =>
                    m.level3 === ch || m.level2 === ch || m.level1 === ch
                );
                if (matched) return { level1: matched.level1 || '', level2: matched.level2 || '', level3: matched.level3 || '' };
            }
            // 2. 模糊匹配：用 functionName 和 description 匹配模块的 businessObjects
            const fname = (func.functionName || '').toLowerCase();
            const fdesc = (func.description || '').toLowerCase();
            const combined = fname + ' ' + fdesc;
            if (combined.trim()) {
                let bestMatch = null;
                let bestScore = 0;
                for (const m of moduleStructure.modules) {
                    let score = 0;
                    const bos = m.businessObjects || [];
                    for (const bo of bos) {
                        const boKey = bo.replace(/[（()）\[\]]/g, '').toLowerCase().trim();
                        if (boKey.length >= 2) {
                            const checkLen = Math.min(4, boKey.length);
                            if (combined.includes(boKey.substring(0, checkLen))) {
                                score += boKey.length;
                            }
                        }
                    }
                    const modName = (m.level3 || '').replace(/^[\d.]+\s*/, '').toLowerCase().trim();
                    if (modName.length >= 2) {
                        const checkLen = Math.min(4, modName.length);
                        if (combined.includes(modName.substring(0, checkLen))) {
                            score += modName.length;
                        }
                    }
                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = m;
                    }
                }
                if (bestMatch && bestScore >= 2) {
                    return { level1: bestMatch.level1 || '', level2: bestMatch.level2 || '', level3: bestMatch.level3 || '' };
                }
            }
        }
        return { level1: '', level2: '', level3: ch };
    };

    // 将结构化数组转回 ##格式纯文本
    const functionsToText = (functions) => {
        return functions
            .filter(f => f.selected !== false)
            .map(f => {
                const sourcePrefix = f.sourceChapter ? `[${f.sourceChapter}] ` : '';
                return `##触发事件：${f.triggerEvent || '用户触发'}\n##功能用户：${f.functionalUser || '发起者：用户 接收者：用户'}\n##功能过程：${sourcePrefix}${f.functionName}\n##功能过程描述：${f.description || ''}`;
            })
            .join('\n\n');
    };

    const handleCodeSourceAnalysisReady = (result) => {
        const requirementDocument = result.requirementDocument || '';
        const preparedFunctions = (result.functions || []).map(func => ({
            ...func,
            id: generateId(),
            selected: true,
            sourceChapter: func.sourceChapter || func.level3 || ''
        }));
        const sourceStats = result.sourceSummary
            ? `${result.sourceSummary.fileCount || 0} 个文件，选取 ${result.sourceSummary.includedFiles?.length || 0} 个重点源码文件`
            : `系统截图 ${result.screenshotObservation ? '已识别' : '已上传'}`;
        const warningText = (result.warnings || []).length
            ? `\n\n注意：${result.warnings.join('；')}`
            : '';

        setDocumentContent(requirementDocument);
        setDocumentName(result.documentName || `${result.systemName || '系统'}_代码反向需求.md`);
        setModuleStructure(result.moduleStructure?.modules?.length ? result.moduleStructure : null);
        setQuantityPlan(null);
        setChapters([]);
        setTableData([]);
        setCoverageResult(null);
        setFailedBatchInfo([]);
        setShowChapterView(false);
        setShowFunctionListEditor(false);
        setExtractionMode('precise');
        setAnalysisProgress(initialAnalysisProgress);

        if (result.analysisMode === 'direct' && preparedFunctions.length > 0) {
            setParsedFunctions(preparedFunctions);
            setFunctionListText(functionsToText(preparedFunctions));
            setCurrentStep(3);
            setIsWaitingForAnalysis(false);
            setMessages([
                {
                    role: 'system',
                    content: `已完成代码/页面反向分析：${sourceStats}。生成 ${result.moduleStructure?.modules?.length || 0} 个模块、${preparedFunctions.length} 个功能过程。${warningText}`
                },
                {
                    role: 'assistant',
                    content: `## 代码反向功能清单已就绪\n\n已跳过需求文档章节提取步骤，识别出 **${preparedFunctions.length}** 个可进入COSMIC拆分的功能过程。\n\n系统同时生成了一份反向需求文档用于追溯。请先查看/编辑功能列表，确认后点击 **「开始COSMIC拆分」**。`,
                    showFunctionListActions: true
                }
            ]);
        } else {
            setParsedFunctions([]);
            setFunctionListText('');
            setCurrentStep(0);
            setIsWaitingForAnalysis(true);
            setMessages([
                {
                    role: 'system',
                    content: `已完成代码/页面反向分析：${sourceStats}。需求文档包含 ${requirementDocument.length} 个字符。${warningText}`
                },
                {
                    role: 'assistant',
                    content: `## 反向需求文档已生成\n\n已根据代码、HTML页面和系统截图生成 **${result.systemName || '当前系统'}** 的需求文档，并识别出 **${result.moduleStructure?.modules?.length || 0}** 个模块候选。\n\n您可以点击顶部 **「预览」** 检查文档，然后点击下方 **「开始智能拆分」**，继续使用现有的模块识别、功能提取和COSMIC拆分流程。`
                }
            ]);
        }

        ensureConversation(result.documentName || result.systemName || '代码反向分析');
        setShowCodeSourceAnalyzer(false);
        showToast(result.analysisMode === 'direct' ? '功能清单已生成' : '反向需求文档已生成');
    };

    // 更新某个功能的某个字段
    const updateFunction = (index, field, value) => {
        setParsedFunctions(prev => {
            const updated = [...prev];
            updated[index] = { ...updated[index], [field]: value };
            return updated;
        });
    };

    // 删除某个功能
    const deleteFunction = (index) => {
        setParsedFunctions(prev => prev.filter((_, i) => i !== index));
        showToast('已删除功能过程');
    };

    // 新增一个空功能
    const addFunction = () => {
        setParsedFunctions(prev => [...prev, {
            id: generateId(),
            triggerEvent: '用户触发',
            functionalUser: '发起者：用户 接收者：用户',
            functionName: '',
            description: '',
            selected: true,
            sourceChapter: '',
            level1: '',
            level2: '',
            level3: ''
        }]);
        // 自动聚焦到最后一个
        setTimeout(() => {
            const editor = document.querySelector('.func-editor-body');
            if (editor) editor.scrollTop = editor.scrollHeight;
        }, 100);
    };

    // 拆分一个功能为两个
    const splitFunction = (index) => {
        setParsedFunctions(prev => {
            const updated = [...prev];
            const original = updated[index];
            const clone = {
                id: generateId(),
                triggerEvent: original.triggerEvent,
                functionalUser: original.functionalUser,
                functionName: original.functionName + '（拆分）',
                description: original.description,
                selected: true,
                sourceChapter: original.sourceChapter || '',
                level1: original.level1 || '',
                level2: original.level2 || '',
                level3: original.level3 || ''
            };
            updated.splice(index + 1, 0, clone);
            return updated;
        });
        showToast('已拆分，请编辑新功能过程名称');
    };

    // 切换功能选中状态
    const toggleFunctionSelected = (index) => {
        setParsedFunctions(prev => {
            const updated = [...prev];
            updated[index] = { ...updated[index], selected: !updated[index].selected };
            return updated;
        });
    };

    // 保存编辑 - 将结构化数据同步回 functionListText，并恢复到待拆分状态
    const saveFunctionEdits = () => {
        const text = functionsToText(parsedFunctions);
        setFunctionListText(text);
        setShowFunctionListEditor(false);
        const selectedCount = parsedFunctions.filter(f => f.selected !== false).length;
        showToast(`已保存 ${selectedCount} 个功能过程`);

        // 恢复到"待拆分"状态，使用户可以重新点击 "开始COSMIC拆分"
        setCurrentStep(3);
        setMessages(prev => {
            // 移除旧的功能列表操作提示
            const filtered = prev.filter(m => !m.showFunctionListActions);
            return [...filtered, {
                role: 'assistant',
                content: `**功能列表已更新**（共 ${selectedCount} 个功能过程）\n\n请点击**「开始COSMIC拆分」**按钮进行ERWX拆分。`,
                showFunctionListActions: true
            }];
        });
    };

    // 打开编辑器时，从 functionListText 解析结构化数据
    const openFunctionEditor = () => {
        if (parsedFunctions.length === 0 && functionListText) {
            const parsed = inheritMissingFunctionLevels(parseFunctionListText(functionListText));
            setParsedFunctions(parsed);
        } else if (parsedFunctions.length > 0) {
            setParsedFunctions(prev => inheritMissingFunctionLevels(prev));
        }
        setShowFunctionListEditor(true);
    };

    // ═══════════ 覆盖度验证 + 补充提取 ═══════════
    const verifyCoverage = async () => {
        if (!documentContent || tableData.length === 0) {
            showToast('请先完成COSMIC拆分后再验证');
            return;
        }

        const extractedFunctions = [...new Set(tableData.map(r => r.functionalProcess).filter(Boolean))];
        if (extractedFunctions.length === 0) {
            showToast('没有可验证的功能过程');
            return;
        }

        setIsVerifying(true);
        setMessages(prev => [...prev, {
            role: 'system',
            content: `🔍 **覆盖度验证中...**\n正在检查 ${extractedFunctions.length} 个功能过程是否覆盖了文档中的所有功能...`
        }]);

        try {
            const res = await axios.post('/api/verify-coverage', {
                documentContent,
                extractedFunctions,
                userConfig: getUserConfig()
            });

            if (res.data.success && res.data.verification) {
                const v = res.data.verification;
                setCoverageResult(v);

                const scoreEmoji = v.coverageScore >= 90 ? '🟢' : v.coverageScore >= 70 ? '🟡' : '🔴';
                const missedList = (v.missedFunctions || []).map((f, i) =>
                    `${i + 1}. **${f.functionName}** (${f.triggerType || '未知触发'})\n   📝 ${f.reason || ''}\n   📄 文档依据: "${f.documentEvidence || '无'}"`
                ).join('\n\n');

                const suggestionsText = (v.suggestions || []).map((s, i) => `${i + 1}. ${s}`).join('\n');

                let resultContent = `## ${scoreEmoji} 覆盖度验证结果\n\n`;
                resultContent += `- **覆盖度评分**: ${v.coverageScore}/100\n`;
                resultContent += `- **文档预估功能数**: ${v.totalDocumentFunctions || '?'}\n`;
                resultContent += `- **已提取功能数**: ${v.extractedCount || extractedFunctions.length}\n`;
                resultContent += `- **遗漏功能数**: ${v.missedFunctions?.length || 0}\n\n`;

                if (v.missedFunctions && v.missedFunctions.length > 0) {
                    resultContent += `### 遗漏的功能过程:\n\n${missedList}\n\n`;
                }
                if (v.suggestions && v.suggestions.length > 0) {
                    resultContent += `### 改进建议:\n${suggestionsText}\n\n`;
                }

                if (v.missedFunctions && v.missedFunctions.length > 0) {
                    resultContent += `---\n\n点击 **「补充提取」** 按钮可自动提取遗漏的功能过程。`;
                } else {
                    resultContent += `\n功能过程提取完整度良好。`;
                }

                setMessages(prev => {
                    const filtered = prev.filter(m => !m.content.startsWith('🔍 **覆盖度验证中'));
                    return [...filtered, {
                        role: 'assistant',
                        content: resultContent,
                        showCoverageActions: v.missedFunctions && v.missedFunctions.length > 0
                    }];
                });

                // 如果覆盖度低，自动提示
                if (v.coverageScore < 90 && v.missedFunctions && v.missedFunctions.length > 0) {
                    showToast(`发现 ${v.missedFunctions.length} 个遗漏功能，建议补充提取`);
                }
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

    const extractSupplementary = async () => {
        if (!coverageResult || !coverageResult.missedFunctions || coverageResult.missedFunctions.length === 0) {
            showToast('没有需要补充提取的功能');
            return;
        }

        const existingFunctions = [...new Set(tableData.map(r => r.functionalProcess).filter(Boolean))];
        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;
        const supplementaryRunId = createCosmicRunId('supplementary-split');

        setIsLoading(true);
        setMessages(prev => [...prev, {
            role: 'system',
            content: `**补充提取中...**\n正在针对 ${coverageResult.missedFunctions.length} 个遗漏功能进行补充分析...`
        }]);

        try {
            // 第一步：补充提取功能过程
            const extractRes = await axios.post('/api/extract-supplementary', {
                documentContent,
                existingFunctions,
                missedFunctions: coverageResult.missedFunctions,
                userConfig: getUserConfig()
            }, { signal });

            if (extractRes.data.success && extractRes.data.functions && extractRes.data.functions.length > 0) {
                const existingFunctionKeys = new Set(existingFunctions.map(normalizeProcName));
                const newFunctions = deduplicateFunctionObjects(
                    extractRes.data.functions.filter(func => (
                        func?.functionName
                        && !existingFunctionKeys.has(normalizeProcName(func.functionName))
                    )),
                    { semantic: extractionMode !== 'quantity' }
                );
                if (newFunctions.length === 0) {
                    throw new Error('补充提取结果与已有功能重复，没有可新增的功能过程');
                }

                setMessages(prev => {
                    const filtered = prev.filter(m => !m.content.startsWith('**补充提取中'));
                    return [...filtered, {
                        role: 'system',
                        content: `补充提取到 **${newFunctions.length}** 个新功能过程，正在进行COSMIC拆分...`
                    }];
                });

                // 第二步：逐功能使用后台job拆分，避免补充入口重新落回长同步请求。
                let supplementaryRows = [];
                for (let index = 0; index < newFunctions.length; index++) {
                    const func = newFunctions[index];
                    const functionText = `##触发事件：${func.triggerEvent || '用户触发'}\n`
                        + `##功能用户：${func.functionalUser || '发起者：用户 接收者：用户'}\n`
                        + `##功能过程：${func.functionName}\n`
                        + `##功能过程描述：${func.description || ''}`;
                    const batchResult = await requestCosmicSplitBatch({
                        batchFunctions: [functionText],
                        batchIndex: index,
                        totalBatches: newFunctions.length,
                        documentContent: documentContent.substring(0, 6000),
                        userGuidelines,
                        previousFunctionNames: completedFunctionNames([...tableData, ...supplementaryRows]),
                        userConfig: getUserConfig(),
                        generateDescription,
                        useEnhancedExperience: useEnhancedCosmicExperience
                    }, {
                        signal,
                        requestKey: `${supplementaryRunId}:batch-${index}`,
                        onStatus: job => {
                            const detail = job?.progress?.message || job?.message;
                            if (detail) {
                                setMessages(prev => {
                                    const filtered = prev.filter(m => !m.content.startsWith('补充拆分进度'));
                                    return [...filtered, {
                                        role: 'system',
                                        content: `补充拆分进度 ${index + 1}/${newFunctions.length}：${detail}`
                                    }];
                                });
                            }
                        }
                    });
                    const batchRows = batchResult.data?.tableData || [];
                    if (!batchResult.data?.success || batchRows.length === 0) {
                        throw new Error(`补充功能“${func.functionName}”未返回有效拆分结果`);
                    }
                    const expectedNames = new Set([
                        func.functionName.toLowerCase().trim(),
                        normalizeProcName(func.functionName)
                    ]);
                    const dedupedBatch = deduplicateData([...tableData, ...supplementaryRows], batchRows, expectedNames);
                    supplementaryRows = [...supplementaryRows, ...dedupedBatch];
                }
                const splitRes = { data: { success: true, tableData: supplementaryRows } };

                if (splitRes.data.success && splitRes.data.tableData && splitRes.data.tableData.length > 0) {
                    const deduped = deduplicateData(tableData, splitRes.data.tableData);
                    if (deduped.length > 0) {
                        const mergedFunctions = deduplicateFunctionObjects(
                            inheritMissingFunctionLevels([
                                ...parsedFunctions,
                                ...newFunctions.map(func => ({
                                    ...func,
                                    id: func.id || generateId(),
                                    selected: func.selected !== false
                                }))
                            ]),
                            { semantic: extractionMode !== 'quantity' }
                        );
                        const newTableData = orderCosmicTableData([...tableData, ...deduped], mergedFunctions, moduleStructure);
                        setTableData(newTableData);
                        setParsedFunctions(mergedFunctions);
                        setFunctionListText(functionsToText(mergedFunctions));

                        const newTotalFuncs = [...new Set(newTableData.map(r => r.functionalProcess).filter(Boolean))].length;
                        setMessages(prev => {
                            const filtered = prev.filter(m => (
                                !m.content.startsWith('补充提取到')
                                && !m.content.startsWith('补充拆分进度')
                            ));
                            return [...filtered, {
                                role: 'assistant',
                                content: `**补充拆分完成**\n\n- 新增 **${deduped.filter(r => r.dataMovementType === 'E').length}** 个功能过程\n- 新增 **${deduped.length}** 个子过程（CFP）\n- 总计 **${newTotalFuncs}** 个功能过程 / **${newTableData.length}** CFP\n\n可继续点击 **「覆盖度验证」** 再次检查完整度。`,
                                showActions: true
                            }];
                        });
                        setCoverageResult(null);
                    } else {
                        setMessages(prev => [...prev, {
                            role: 'assistant',
                            content: '补充的功能过程与已有数据重复，未产生新数据。'
                        }]);
                    }
                } else {
                    setMessages(prev => [...prev, {
                        role: 'assistant',
                        content: '补充功能的COSMIC拆分未返回有效数据，请尝试手动补充。'
                    }]);
                }
            } else {
                setMessages(prev => {
                    const filtered = prev.filter(m => !m.content.startsWith('**补充提取中'));
                    return [...filtered, {
                        role: 'assistant',
                        content: '补充提取未发现新的功能过程。可能遗漏的功能已在已有列表中被不同名称覆盖。'
                    }];
                });
            }
        } catch (error) {
            if (signal.aborted || error.name === 'AbortError' || error.name === 'CanceledError') return;
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `❌ 补充提取失败: ${error.response?.data?.error || error.message}`
            }]);
        } finally {
            if (abortControllerRef.current?.signal === signal) abortControllerRef.current = null;
            setIsLoading(false);
        }
    };

    // ═══════════ 对话管理函数 ═══════════
    const createNewConversation = async () => {
        try {
            const res = await authAxios.post('/api/auth/conversations', {
                title: '未命名分析',
                documentName: '',
                analysisMode: analysisMode
            });
            if (res.data.success) {
                setCurrentConversationId(res.data.conversationId);
                return res.data.conversationId;
            }
        } catch (err) {
            console.warn('创建对话失败:', err.message);
        }
        return null;
    };

    const handleNewConversation = () => {
        setMessages([]);
        setTableData([]);
        setDocumentContent('');
        setDocumentName('');
        setFunctionListText('');
        setParsedFunctions([]);
        setCurrentStep(0);
        setChapters([]);
        setModuleStructure(null);
        setCoverageResult(null);
        setCurrentConversationId(null);
        setIsWaitingForAnalysis(false);
        resetAiActivity();
    };

    const handleLoadConversation = (conv) => {
        setCurrentConversationId(conv.id);
        setMessages(conv.messages || []);
        setTableData(orderCosmicTableData(conv.table_data || [], [], null));
        setDocumentName(conv.document_name || '');
        setFunctionListText(conv.function_list || '');
        setParsedFunctions([]);
        setModuleStructure(null);
        setCurrentStep(0);
        setIsWaitingForAnalysis(false);
        resetAiActivity();
        if (conv.analysis_mode) setAnalysisMode(conv.analysis_mode);
        showToast('已加载历史分析记录');
    };

    const handleManualSave = async () => {
        let convId = currentConversationId;
        if (!convId) {
            convId = await createNewConversation();
            if (!convId) { showToast('保存失败'); return; }
        }
        try {
            const tableDataForSave = orderCosmicTableData(tableData, parsedFunctions, moduleStructure);
            const uniqueFuncs = [...new Set(tableDataForSave.map(r => r.functionalProcess).filter(Boolean))];
            await authAxios.put(`/api/auth/conversations/${convId}`, {
                title: documentName || '未命名分析',
                messages: messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    ...(m.activity?.steps?.length ? { activity: m.activity } : {})
                })),
                tableData: tableDataForSave,
                functionList: functionListText,
                functionCount: uniqueFuncs.length,
                cfpCount: tableDataForSave.length
            });
            showToast('已保存');
        } catch (err) {
            showToast('保存失败: ' + (err.response?.data?.error || err.message));
        }
    };

    // 上传文档时自动创建对话
    const ensureConversation = async (docName) => {
        if (!currentConversationId && token) {
            try {
                const res = await authAxios.post('/api/auth/conversations', {
                    title: docName || '未命名分析',
                    documentName: docName || '',
                    analysisMode
                });
                if (res.data.success) {
                    setCurrentConversationId(res.data.conversationId);
                }
            } catch (err) {
                console.warn('创建对话失败:', err.message);
            }
        }
    };

    // ═══════════ 渲染 ═══════════
    return (
        <div className="app-container">
            {/* Toast */}
            {toastMessage && <div className="toast">{toastMessage}</div>}

            {/* 历史记录面板 */}
            <HistoryPanel
                token={token}
                isOpen={showHistory}
                onClose={() => setShowHistory(false)}
                onLoadConversation={handleLoadConversation}
                onNewConversation={handleNewConversation}
            />
            <CodeSourceAnalyzer
                isOpen={showCodeSourceAnalyzer}
                onClose={() => setShowCodeSourceAnalyzer(false)}
                onComplete={handleCodeSourceAnalysisReady}
                userConfig={getUserConfig()}
            />

            {/* ═══ Sidebar ═══ */}
            <div className="sidebar">
                <div className="sidebar-header">
                    <div className="sidebar-logo">
                        <div className={`sidebar-logo-icon ${
                            analysisMode === 'cosmic'
                                ? 'cosmic-brand-logo-shell'
                                : analysisMode === 'office'
                                    ? 'office-logo-icon'
                                    : 'nesma-logo-icon'
                        }`}>
                            {analysisMode === 'cosmic' ? (
                                <img className="cosmic-brand-logo cosmic-brand-logo-sidebar" src="/cosmic-logo-mark.png" alt="COSMIC" />
                            ) : analysisMode === 'office' ? (
                                <FileSpreadsheet size={22} />
                            ) : (
                                <BarChart3 size={22} />
                            )}
                        </div>
                        <div>
                            <h1>{
                                analysisMode === 'cosmic'
                                    ? 'COSMIC 拆分'
                                    : analysisMode === 'office'
                                        ? '智能办公'
                                        : 'NESMA 拆分'
                            }</h1>
                            <p>{
                                analysisMode === 'cosmic'
                                    ? '智能功能规模分析'
                                    : analysisMode === 'office'
                                        ? 'Word · Excel 文档处理'
                                        : '功能点智能拆分'
                            }</p>
                        </div>
                    </div>
                    <div className="sidebar-header-actions">
                        <button
                            className="btn btn-ghost btn-icon sidebar-history-btn"
                            onClick={() => setShowHistory(true)}
                            title="历史记录"
                        >
                            <History size={18} />
                        </button>
                        <button
                            className="btn btn-ghost btn-icon sidebar-new-btn"
                            onClick={handleNewConversation}
                            title="新建任务"
                        >
                            <Plus size={18} />
                        </button>
                    </div>
                </div>

                <div className="sidebar-content">
                    {/* 工作模式选择 */}
                    <div className="section-group">
                        <div className="section-label">工作模式</div>
                        <div className="model-selector">
                            <button
                                className={`model-option ${analysisMode === 'cosmic' ? 'active' : ''}`}
                                onClick={() => setAnalysisMode('cosmic')}
                            >
                                <span className="model-option-dot" />
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>COSMIC</div>
                                    <div style={{ fontSize: 11, opacity: 0.6 }}>ERWX 数据移动拆分</div>
                                </div>
                            </button>
                            <button
                                className={`model-option nesma-mode-btn ${analysisMode === 'nesma' ? 'active' : ''}`}
                                onClick={() => setAnalysisMode('nesma')}
                            >
                                <span className="model-option-dot" />
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>NESMA</div>
                                    <div style={{ fontSize: 11, opacity: 0.6 }}>ILF/EIF/EI/EO/EQ 功能点</div>
                                </div>
                            </button>
                            <button
                                className={`model-option office-mode-btn ${analysisMode === 'office' ? 'active' : ''}`}
                                onClick={() => setAnalysisMode('office')}
                            >
                                <span className="model-option-dot" />
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>智能办公文档</div>
                                    <div style={{ fontSize: 11, opacity: 0.6 }}>Word / Excel 修改与生成</div>
                                </div>
                            </button>
                        </div>
                    </div>

                    {/* 模型选择 */}
                    <div className="section-group">
                        <div className="section-label">🤖 AI 模型</div>
                        <div className="model-selector">
                            <button
                                className={`model-option ${selectedModel === 'deepseek-v4-pro-ga' ? 'active' : ''}`}
                                onClick={() => handleModelChange('deepseek-v4-pro-ga')}
                                style={selectedModel === 'deepseek-v4-pro-ga' ? { borderColor: '#7c3aed', background: 'rgba(124,58,237,0.12)' } : {}}
                            >
                                <span className="model-option-dot" style={{ background: '#7c3aed' }} />
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>DeepSeek-V4-Pro正式版</div>
                                    <div style={{ fontSize: 11, opacity: 0.6 }}>最强质量 · 推荐</div>
                                </div>
                            </button>
                            <button
                                className={`model-option ${selectedModel === 'deepseek-v4-flash-ga' ? 'active' : ''}`}
                                onClick={() => handleModelChange('deepseek-v4-flash-ga')}
                                style={selectedModel === 'deepseek-v4-flash-ga' ? { borderColor: '#0ea5e9', background: 'rgba(14,165,233,0.12)' } : {}}
                            >
                                <span className="model-option-dot" style={{ background: '#0ea5e9' }} />
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>DeepSeek-V4-Flash正式版</div>
                                    <div style={{ fontSize: 11, opacity: 0.6 }}>高速稳定 · 性价比高</div>
                                </div>
                            </button>
                            <button
                                className={`model-option ${selectedModel === 'deepseek-v4-pro' ? 'active' : ''}`}
                                onClick={() => handleModelChange('deepseek-v4-pro')}
                                style={selectedModel === 'deepseek-v4-pro' ? { borderColor: '#a855f7', background: 'rgba(168,85,247,0.12)' } : {}}
                            >
                                <span className="model-option-dot" style={{ background: '#a855f7' }} />
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>DeepSeek-V4-pro</div>
                                    <div style={{ fontSize: 11, opacity: 0.6 }}>预览版 · 高质量</div>
                                </div>
                            </button>
                            <button
                                className={`model-option ${selectedModel === UNLIMITDS_MODEL_ALIAS ? 'active' : ''}`}
                                onClick={() => handleModelChange(UNLIMITDS_MODEL_ALIAS)}
                                disabled={apiStatus.status === 'ok' && !apiStatus.hasUnlimitdsApiKey}
                                title={apiStatus.status === 'ok' && !apiStatus.hasUnlimitdsApiKey ? '服务器尚未配置 UNLIMITDS_API_KEY' : '使用 UnlimitDS DeepSeek V4 Pro'}
                                style={selectedModel === UNLIMITDS_MODEL_ALIAS ? { borderColor: '#06b6d4', background: 'rgba(6,182,212,0.12)' } : {}}
                            >
                                <span className="model-option-dot" style={{ background: '#06b6d4' }} />
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>DeepSeek-V4-Pro</div>
                                    <div style={{ fontSize: 11, opacity: 0.6 }}>
                                        {apiStatus.status === 'ok' && !apiStatus.hasUnlimitdsApiKey
                                            ? 'UnlimitDS · 需配置 API Key'
                                            : 'UnlimitDS · 第三方 API'}
                                    </div>
                                </div>
                            </button>
                        </div>
                    </div>

                    {/* 拆分设置 */}
                    {analysisMode !== 'office' && (
                    <div className="section-group">
                        <div className="section-label">拆分设置</div>
                        {/* 模块脚手架信息 */}
                        {moduleStructure && moduleStructure.modules && (
                            <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(108,92,231,0.06)', border: '1px solid rgba(108,92,231,0.15)', marginBottom: 8 }}>
                                <div style={{ fontSize: 11, color: 'var(--accent-violet)', fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <Layers size={13} /> 已识别模块脚手架
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                    {moduleStructure.modules.length} 个三级模块 · 粗估参考 ~{getModuleEstimateTotal() || '?'} 个功能过程
                                </div>
                                {extractionMode === 'precise' && getModuleEstimateTotal() > 0 && (
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => switchToQuantityMode(getModuleEstimateTotal(), true)}
                                        style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}
                                    >
                                        <BarChart3 size={13} /> 按粗估数转数量优先
                                    </button>
                                )}
                            </div>
                        )}
                        {extractionMode === 'quantity' && (
                            <div className="setting-row">
                                <span className="setting-label">数量优先·目标总数</span>
                                <input
                                    type="number"
                                    className="setting-input number-input"
                                    value={totalTargetCount}
                                    onChange={e => updateQuantityTotalTarget(e.target.value)}
                                    min={0}
                                />
                            </div>
                        )}
                        <div className="setting-row">
                            <span className="setting-label">全局拆分要求（可选）</span>
                            <textarea
                                className="setting-input"
                                placeholder="例如：仅拆分接口功能、重点关注XX模块..."
                                value={userGuidelines}
                                onChange={e => setUserGuidelines(e.target.value)}
                                rows={2}
                            />
                        </div>
                    </div>
                    )}
                </div>

                {/* 状态栏 */}
                <div className="status-bar">
                    <span className={`status-dot ${apiStatus.hasApiKey ? 'online' : 'offline'}`} />
                    <span>{apiStatus.hasApiKey ? '已连接' : '未连接'}</span>
                </div>

                {/* 用户信息栏 */}
                {user && (
                    <div className="sidebar-user-bar">
                        <div className="sidebar-user-avatar" style={{ background: user.avatarColor || '#6C63FF' }}>
                            {(user.displayName || user.username || '?').charAt(0).toUpperCase()}
                        </div>
                        <div className="sidebar-user-info">
                            <span className="sidebar-user-name">{user.displayName || user.username}</span>
                            <span className="sidebar-user-id">@{user.username}</span>
                        </div>
                        <button className="btn btn-ghost btn-icon sidebar-logout-btn" onClick={onLogout} title="退出登录">
                            <LogOut size={16} />
                        </button>
                    </div>
                )}
            </div>

            {/* ═══ Main Content (conditionally rendered based on mode) ═══ */}
            {analysisMode === 'office' ? (
                <OfficeDocumentApp
                    selectedModel={selectedModel}
                    getUserConfig={getUserConfig}
                    showToast={showToast}
                />
            ) : analysisMode === 'nesma' ? (
                <NesmaApp
                    selectedModel={selectedModel}
                    getUserConfig={getUserConfig}
                    showToast={showToast}
                />
            ) : (
                <>
                    <div className="main-content">
                        {/* Top Bar */}
                        <div className="top-bar">
                            <div className="top-bar-left">
                                <span className="top-bar-title">COSMIC 功能规模智能分析</span>
                                {tableData.length > 0 && (
                                    <span className="top-bar-badge">
                                        {[...new Set(tableData.map(r => r.functionalProcess).filter(Boolean))].length} 个功能过程 · {tableData.length} CFP
                                        {' · '}
                                        {['E', 'R', 'W', 'X'].map(dmt => (
                                            <span key={dmt} style={{ marginLeft: 2 }}>
                                                <span className={`dmt-badge dmt-${dmt.toLowerCase()}`} style={{ width: 16, height: 16, fontSize: 8, display: 'inline-flex', verticalAlign: 'middle' }}>{dmt}</span>
                                                <span style={{ fontSize: 11, marginLeft: 1, marginRight: 4 }}>{tableData.filter(r => r.dataMovementType === dmt).length}</span>
                                            </span>
                                        ))}
                                    </span>
                                )}
                            </div>
                            <div className="top-bar-right">
                                {tableData.length > 0 && (
                                    <>
                                        <button className="btn btn-secondary btn-sm" onClick={() => setShowTableView(true)}>
                                            <Table size={14} /> 查看表格
                                        </button>
                                        <button className="btn btn-success btn-sm" onClick={exportExcel}>
                                            <Download size={14} /> 导出Excel
                                        </button>
                                        {renderExcelTemplateSelect()}
                                        <button className="btn btn-sm" onClick={exportWord} style={{ background: 'linear-gradient(135deg, #3B82F6, #6C5CE7)', color: '#fff', border: 'none' }} title="导出为Word功能规格说明书">
                                            <FileText size={14} /> 导出Word
                                        </button>
                                    </>
                                )}
                                <button className="btn btn-secondary btn-sm" onClick={handleManualSave} title="保存当前分析">
                                    <Save size={14} /> 保存
                                </button>
                                <button className="btn btn-ghost btn-icon" onClick={clearChat} title="清空对话">
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        </div>

                        {/* Document Info Bar */}
                        {documentName && (
                            <div className="doc-info-bar">
                                <FileText size={14} style={{ color: 'var(--accent-violet)' }} />
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
                                    <div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
                                </div>
                            </div>
                        )}

                        {/* Chat Area */}
                        <div className="chat-area">
                            {messages.length === 0 && !documentContent ? (
                                /* Welcome Screen */
                                <div className="welcome-screen">
                                    <div className="welcome-icon cosmic-welcome-logo">
                                        <img className="cosmic-brand-logo cosmic-brand-logo-welcome" src="/cosmic-logo-mark.png" alt="COSMIC 智能拆分系统" />
                                    </div>
                                    <h1 className="welcome-title">COSMIC 智能拆分系统</h1>
                                    <p className="welcome-subtitle">
                                        基于AI大模型的COSMIC功能规模度量工具，自动将需求文档拆分为标准的ERWX数据移动表格
                                    </p>
                                    <div className="welcome-features">
                                        <div className="welcome-feature">
                                            <div className="welcome-feature-icon violet"><FileText size={18} /></div>
                                            <h3>多源智能解析</h3>
                                            <p>支持需求文档、COSMIC Excel、代码包、HTML和系统截图</p>
                                        </div>
                                        <div className="welcome-feature">
                                            <div className="welcome-feature-icon blue"><Brain size={18} /></div>
                                            <h3>AI 深度拆分</h3>
                                            <p>DeepSeek V4 Pro 多通道，精准ERWX拆分</p>
                                        </div>
                                        <div className="welcome-feature">
                                            <div className="welcome-feature-icon cyan"><BarChart3 size={18} /></div>
                                            <h3>专业级输出</h3>
                                            <p>标准拆分表、时序图和Word需求文档，直接交付使用</p>
                                        </div>
                                    </div>
                                    <AnalysisProgressPanel />

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
                                        <div className="upload-zone-icon"><Upload size={34} /></div>
                                        <h3>上传需求文档或COSMIC Excel</h3>
                                        <p>拖拽文件到此处，或点击选择文件</p>
                                        <p style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>支持 .docx, .txt, .md, .xlsx, .xlsm 格式</p>
                                    </div>
                                    <button
                                        type="button"
                                        className="code-source-entry"
                                        onClick={() => setShowCodeSourceAnalyzer(true)}
                                    >
                                        <Code2 size={21} />
                                        <div>
                                            <strong>没有需求文档？从代码、HTML或系统截图开始</strong>
                                            <span>可先反向生成需求文档，也可直接形成COSMIC功能清单</span>
                                        </div>
                                    </button>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".docx,.txt,.md,.xlsx,.xlsm,.xls"
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
                                                {msg.activity?.steps?.length > 0 && (
                                                    <AiActivityPanel activity={msg.activity} compact />
                                                )}
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                                                {msg.showActions && tableData.length > 0 && (
                                                    <div className="result-actions">
                                                        <button className="btn btn-primary btn-sm" onClick={() => setShowTableView(true)}>
                                                            <Table size={14} /> 查看表格
                                                        </button>
                                                        <button className="btn btn-success btn-sm" onClick={exportExcel} disabled={isGeneratingDiagrams}>
                                                            {isGeneratingDiagrams ? <Loader2 size={14} className="spinner" /> : <Download size={14} />} {isGeneratingDiagrams ? diagramProgress : '导出Excel'}
                                                        </button>
                                                        {renderExcelTemplateSelect()}
                                                        <label className="seq-export-toggle" title="导出Excel/Word时附带每个功能过程的时序图">
                                                            <input type="checkbox" checked={exportWithDiagrams} onChange={e => setExportWithDiagrams(e.target.checked)} />
                                                            <GitBranch size={12} /> 附带时序图
                                                        </label>
                                                        {renderWordTemplateSelect()}
                                                        <button className="btn btn-sm" onClick={exportWord} disabled={isGeneratingDiagrams} style={{ background: 'linear-gradient(135deg, #3B82F6, #6C5CE7)', color: '#fff', border: 'none' }} title="导出为带时序图的Word需求文档">
                                                            {isGeneratingDiagrams ? <Loader2 size={14} className="spinner" /> : <FileText size={14} />} {isGeneratingDiagrams ? diagramProgress : '导出Word'}
                                                        </button>
                                                        <button className="btn btn-secondary btn-sm" onClick={supplementDescription} disabled={isSupplementingDescription || isLoading} title="为功能过程补充功能描述">
                                                            {isSupplementingDescription ? <Loader2 size={14} className="spinner" /> : <FileText size={14} />} {isSupplementingDescription ? '补充中...' : '补充功能描述'}
                                                        </button>
                                                        <button className="btn btn-secondary btn-sm" onClick={() => setShowSequenceDiagram(true)} style={{ background: 'linear-gradient(135deg, rgba(108,92,231,0.12), rgba(59,130,246,0.12))', border: '1px solid rgba(108,92,231,0.2)', color: '#6c5ce7' }}>
                                                            <GitBranch size={14} /> 查看时序图
                                                        </button>
                                                        <button className="btn btn-secondary btn-sm" onClick={verifyCoverage} disabled={isVerifying || isLoading}>
                                                            {isVerifying ? <Loader2 size={14} className="spinner" /> : <Target size={14} />} 覆盖度验证
                                                        </button>
                                                    </div>
                                                )}
                                                {msg.showCoverageActions && (
                                                    <div className="result-actions">
                                                        <button className="btn btn-primary btn-sm" onClick={extractSupplementary} disabled={isLoading}>
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
                                                        <button className="btn btn-primary btn-sm" onClick={() => startFunctionExtractionFromChapters()} disabled={isLoading}>
                                                            <Target size={14} /> 确认·开始提取
                                                        </button>
                                                    </div>
                                                )}
                                                {msg.showFunctionListActions && parsedFunctions.length > 0 && (
                                                    <div className="result-actions">
                                                        <button className="btn btn-primary btn-sm" onClick={openFunctionEditor}>
                                                            <Edit3 size={14} /> 查看/编辑功能列表
                                                        </button>
                                                        {msg.showQuantityEstimateActions && (
                                                            <button className="btn btn-secondary btn-sm" onClick={() => prepareQuantityReExtraction(msg.estimateTarget)} disabled={isLoading}>
                                                                <BarChart3 size={14} /> 按粗估数重提
                                                            </button>
                                                        )}
                                                        <label className="seq-export-toggle" title="拆分时生成功能描述（会增加AI处理时间和成本）">
                                                            <input type="checkbox" checked={generateDescription} onChange={e => setGenerateDescription(e.target.checked)} />
                                                            <FileText size={12} /> 生成功能描述
                                                        </label>
                                                        {renderEnhancedExperienceToggle()}
                                                        {renderSplitExecutionModeToggle()}
                                                        <button className="btn btn-success btn-sm" onClick={startCosmicSplit} disabled={isLoading}>
                                                            <Sparkles size={14} /> 确认·开始COSMIC拆分
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                    {(aiActivity.visible || streamingContent) && (
                                        <div className="message assistant">
                                            <div className="message-avatar"><Bot size={16} /></div>
                                            <div className="message-content ai-live-message">
                                                {aiActivity.visible && <AiActivityPanel activity={aiActivity} />}
                                                {streamingContent && (
                                                    <div className="ai-streaming-output">
                                                        <div className="ai-streaming-output-label">
                                                            <Sparkles size={12} />
                                                            <span>生成内容</span>
                                                        </div>
                                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>
                                                        {isLoading && <span className="ai-stream-caret" aria-hidden="true" />}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    {isLoading && !streamingContent && !aiActivity.visible && (
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
                            {/* Action Buttons */}
                            {documentContent && (
                                <div className="input-actions" style={{ marginBottom: 8 }}>
                                    {/* ── 提取模式切换行（借鉴NESMA） ── */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>提取模式：</span>
                                        <button onClick={() => handleExtractionModeChange('precise')} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, border: 'none', cursor: 'pointer', background: extractionMode === 'precise' ? 'var(--accent-violet)' : 'var(--bg-tertiary)', color: extractionMode === 'precise' ? '#fff' : 'var(--text-secondary)', fontWeight: extractionMode === 'precise' ? 600 : 400, transition: 'all 0.15s', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Target size={12} /> 精准模式</button>
                                        <button onClick={() => handleExtractionModeChange('quantity')} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, border: 'none', cursor: 'pointer', background: extractionMode === 'quantity' ? '#f59e0b' : 'var(--bg-tertiary)', color: extractionMode === 'quantity' ? '#fff' : 'var(--text-secondary)', fontWeight: extractionMode === 'quantity' ? 600 : 400, transition: 'all 0.15s', display: 'inline-flex', alignItems: 'center', gap: 5 }}><BarChart3 size={12} /> 数量优先</button>
                                        {renderEnhancedExperienceToggle()}
                                        {renderSplitExecutionModeToggle()}
                                        {extractionMode === 'quantity' && (
                                            <>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: '3px 8px' }}>
                                                    <span style={{ fontSize: 11, color: '#f59e0b', whiteSpace: 'nowrap' }}>目标总数：</span>
                                                    <input
                                                        type="number" min={0} step={1}
                                                        value={totalTargetCount}
                                                        onChange={e => updateQuantityTotalTarget(e.target.value)}
                                                        style={{ width: 60, padding: '1px 4px', fontSize: 13, border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4, background: 'transparent', color: '#d97706', fontWeight: 700, textAlign: 'center', outline: 'none' }}
                                                    />
                                                    <span style={{ fontSize: 11, color: '#f59e0b' }}>个</span>
                                                </div>
                                                {quantityPlan && (
                                                    <button
                                                        onClick={() => setShowQuantityPlan(true)}
                                                        style={{ padding: '3px 10px', borderRadius: 8, fontSize: 11, border: '1px solid rgba(245,158,11,0.5)', cursor: 'pointer', background: 'rgba(245,158,11,0.15)', color: '#f59e0b', fontWeight: 600, transition: 'all 0.15s', whiteSpace: 'nowrap' }}
                                                    >
                                                        <FileText size={12} /> 调整规划（{quantityPlan.length}个模块）
                                                    </button>
                                                )}
                                                <span style={{ fontSize: 11, color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Zap size={12} /> 目标少时筛选精简，目标多时扩展补足；目标为0的模块会提示跳过</span>
                                            </>
                                        )}
                                        {extractionMode === 'precise' && (
                                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>按业务目的合并提取；模块预估仅作粗估参考</span>
                                        )}
                                    </div>

                                    <div className="input-actions-left">
                                        {/* 两步骤模式按钮 */}
                                        {currentStep === 0 && (
                                            <>
                                                <button
                                                    className="btn btn-primary"
                                                    onClick={startFunctionExtraction}
                                                    disabled={isLoading}
                                                >
                                                    <Target size={14} /> 两步骤拆分
                                                </button>
                                                <button
                                                    className="btn btn-secondary"
                                                    onClick={startOneKeyAnalysis}
                                                    disabled={isLoading}
                                                >
                                                    <Zap size={14} /> 一键拆分
                                                </button>
                                                {parsedFunctions.length > 0 && (
                                                    <>
                                                        <button className="btn btn-secondary" onClick={openFunctionEditor}>
                                                            <Edit3 size={14} /> 编辑功能列表 ({parsedFunctions.filter(f => f.selected !== false).length})
                                                        </button>
                                                        <button className="btn btn-primary" onClick={startCosmicSplit} disabled={isLoading}>
                                                            <Sparkles size={14} /> 重新COSMIC拆分
                                                        </button>
                                                    </>
                                                )}
                                                {failedBatchInfo.length > 0 && (
                                                    <button
                                                        className="btn btn-primary"
                                                        onClick={retryFailedBatches}
                                                        disabled={isLoading}
                                                        style={{ background: 'linear-gradient(135deg, #f59e0b, #ef4444)', border: 'none' }}
                                                    >
                                                        <RefreshCw size={14} /> 重试失败批次 ({failedBatchInfo.reduce((s, b) => s + b.functions.length, 0)}个功能)
                                                    </button>
                                                )}
                                            </>
                                        )}
                                        {currentStep === 2 && (
                                            <>
                                                <button className="btn btn-secondary" onClick={() => setShowChapterView(true)}>
                                                    <Eye size={14} /> 查看/编辑章节
                                                </button>
                                                <button className="btn btn-primary" onClick={() => startFunctionExtractionFromChapters()} disabled={isLoading}>
                                                    <Target size={14} /> 确认章节·开始提取
                                                </button>
                                            </>
                                        )}
                                        {currentStep === 3 && (
                                            <>
                                                <button className="btn btn-secondary" onClick={openFunctionEditor}>
                                                    <Edit3 size={14} /> 查看/编辑功能列表 ({parsedFunctions.filter(f => f.selected !== false).length})
                                                </button>
                                                <button className="btn btn-primary" onClick={startCosmicSplit} disabled={isLoading}>
                                                    <Sparkles size={14} /> 开始COSMIC拆分
                                                </button>
                                            </>
                                        )}
                                        {isLoading && (
                                            <button className="btn btn-secondary btn-sm" onClick={stopAnalysis}>
                                                <X size={14} /> 停止分析
                                            </button>
                                        )}
                                        {!documentContent && (
                                            <>
                                                <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
                                                    <Upload size={14} /> 上传文档
                                                </button>
                                                <button className="btn btn-secondary btn-sm" onClick={() => setShowCodeSourceAnalyzer(true)}>
                                                    <Code2 size={14} /> 上传代码/截图
                                                </button>
                                            </>
                                        )}
                                    </div>
                                    <div style={{ display: 'flex', gap: 4 }}>
                                        {tableData.length > 0 && !isLoading && currentStep === 0 && (
                                            <>
                                                <button className="btn btn-secondary btn-sm" onClick={() => setShowSequenceDiagram(true)} style={{ background: 'linear-gradient(135deg, rgba(108,92,231,0.08), rgba(59,130,246,0.08))', border: '1px solid rgba(108,92,231,0.15)', color: '#6c5ce7' }}>
                                                    <GitBranch size={13} /> 时序图
                                                </button>
                                                <button className="btn btn-secondary btn-sm" onClick={verifyCoverage} disabled={isVerifying}>
                                                    {isVerifying ? <Loader2 size={13} className="spinner" /> : <Target size={13} />} 覆盖度验证
                                                </button>
                                            </>
                                        )}
                                        {documentContent && !isLoading && currentStep === 0 && (
                                            <>
                                                <button className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()}>
                                                    <RefreshCw size={13} /> 重新上传
                                                </button>
                                                <button className="btn btn-ghost btn-sm" onClick={() => setShowCodeSourceAnalyzer(true)}>
                                                    <Code2 size={13} /> 代码/截图分析
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Chat Input */}
                            <div className="input-row">
                                <div className="input-wrapper">
                                    <textarea
                                        className="input-textarea"
                                        placeholder={documentContent ? '直接输入修改或追问；明确的修改会同步到文档、功能清单和COSMIC表...' : '请先上传需求文档、COSMIC Excel、代码包或系统截图...'}
                                        value={inputText}
                                        onChange={e => setInputText(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        disabled={isLoading}
                                        rows={1}
                                    />
                                </div>
                                <button
                                    className="btn btn-primary btn-icon"
                                    onClick={sendMessage}
                                    disabled={isLoading || !inputText.trim()}
                                    title="发送消息"
                                >
                                    <Send size={16} />
                                </button>
                            </div>

                            {/* Hidden file input for re-upload */}
                            {!messages.length && !documentContent ? null : (
                                <input ref={fileInputRef} type="file" accept=".docx,.txt,.md,.xlsx,.xlsm,.xls" onChange={handleFileSelect} style={{ display: 'none' }} />
                            )}
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
                                            className="chapter-item"
                                            style={{
                                                display: 'flex', alignItems: 'flex-start', gap: 12,
                                                padding: '12px 16px', borderRadius: 'var(--radius-sm)',
                                                border: `1px solid ${ch.selected ? 'var(--border-active)' : 'var(--border-subtle)'}`,
                                                background: ch.selected ? 'rgba(108, 92, 231, 0.03)' : 'transparent',
                                                marginBottom: 8, cursor: 'pointer',
                                                transition: 'all 0.15s ease'
                                            }}
                                            onClick={() => toggleChapter(idx)}
                                        >
                                            <input
                                                type="checkbox" checked={ch.selected}
                                                onChange={() => toggleChapter(idx)}
                                                style={{ marginTop: 3, cursor: 'pointer', accentColor: 'var(--accent-violet)' }}
                                            />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>
                                                    {idx + 1}. {ch.title}
                                                </div>
                                                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                                    {ch.charCount} 字
                                                </div>
                                                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5, maxHeight: 60, overflow: 'hidden' }}>
                                                    {ch.content.substring(0, 200)}...
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                                    <button className="btn btn-secondary" onClick={() => setShowChapterView(false)}>
                                        关闭
                                    </button>
                                    <button className="btn btn-primary" onClick={() => { setShowChapterView(false); startFunctionExtractionFromChapters(); }} disabled={chapters.filter(ch => ch.selected).length === 0}>
                                        <Target size={14} /> 确认·开始提取 ({chapters.filter(ch => ch.selected).length}个章节)
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ═══ Table View Modal ═══ */}
                    {showTableView && (
                        <div className="table-view-overlay" onClick={() => setShowTableView(false)}>
                            <div className="table-view-panel" onClick={e => e.stopPropagation()}>
                                <div className="table-view-header">
                                    <h2><Table size={18} /> COSMIC 拆分结果表格</h2>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                        <div className="table-view-stats">
                                            <div className="table-stat">
                                                功能过程: <span className="table-stat-value">{[...new Set(tableData.map(r => r.functionalProcess).filter(Boolean))].length}</span>
                                            </div>
                                            <div className="table-stat">
                                                CFP: <span className="table-stat-value" style={{ color: 'var(--accent-violet)' }}>{tableData.length}</span>
                                            </div>
                                            {['E', 'R', 'W', 'X'].map(dmt => (
                                                <div key={dmt} className="table-stat">
                                                    <span className={`dmt-badge dmt-${dmt.toLowerCase()}`} style={{ width: 24, height: 20, fontSize: 10 }}>{dmt}</span>
                                                    {tableData.filter(r => r.dataMovementType === dmt).length}
                                                </div>
                                            ))}
                                            <div className="table-stat" style={{ borderLeft: '1px solid var(--border-subtle)', paddingLeft: 12, marginLeft: 4 }}>
                                                {(() => {
                                                    const triggers = {};
                                                    tableData.filter(r => r.dataMovementType === 'E' && r.triggerEvent).forEach(r => {
                                                        triggers[r.triggerEvent] = (triggers[r.triggerEvent] || 0) + 1;
                                                    });
                                                    return Object.entries(triggers).map(([t, c]) => (
                                                        <span key={t} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 10, background: t === '用户触发' ? 'rgba(108,92,231,0.12)' : t === '时钟触发' ? 'rgba(245,158,11,0.12)' : 'rgba(16,185,129,0.12)', color: t === '用户触发' ? '#6c5ce7' : t === '时钟触发' ? '#f59e0b' : '#10b981', fontWeight: 500, marginRight: 4 }}>
                                                            {t === '用户触发' ? '👤' : t === '时钟触发' ? '⏰' : '🔗'} {c}
                                                        </span>
                                                    ));
                                                })()}
                                            </div>
                                        </div>
                                        <button className="btn btn-success btn-sm" onClick={exportExcel} disabled={isGeneratingDiagrams}>
                                            {isGeneratingDiagrams ? <Loader2 size={14} className="spinner" /> : <Download size={14} />} {isGeneratingDiagrams ? diagramProgress : '导出Excel'}
                                        </button>
                                        {renderExcelTemplateSelect()}
                                        {renderWordTemplateSelect()}
                                        <button className="btn btn-sm" onClick={exportWord} disabled={isGeneratingDiagrams} style={{ background: 'linear-gradient(135deg, #3B82F6, #6C5CE7)', color: '#fff', border: 'none' }} title="导出为Word功能规格说明书">
                                            {isGeneratingDiagrams ? <Loader2 size={14} className="spinner" /> : <FileText size={14} />} {isGeneratingDiagrams ? diagramProgress : '导出Word'}
                                        </button>
                                        <label className="seq-export-toggle" title="导出时附带每个功能过程的时序图">
                                            <input type="checkbox" checked={exportWithDiagrams} onChange={e => setExportWithDiagrams(e.target.checked)} />
                                            <GitBranch size={12} /> 附带时序图
                                        </label>
                                        <button className="btn btn-secondary btn-sm" onClick={supplementDescription} disabled={isSupplementingDescription || isLoading} title="为功能过程补充功能描述">
                                            {isSupplementingDescription ? <Loader2 size={14} className="spinner" /> : <FileText size={14} />} {isSupplementingDescription ? '补充中...' : '补充功能描述'}
                                        </button>
                                        <button className="btn btn-secondary btn-sm" onClick={() => { setShowTableView(false); setShowSequenceDiagram(true); }} style={{ background: 'linear-gradient(135deg, rgba(108,92,231,0.12), rgba(59,130,246,0.12))', border: '1px solid rgba(108,92,231,0.2)', color: '#6c5ce7' }}>
                                            <GitBranch size={14} /> 查看时序图
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
                                                <th style={{ width: '6%' }}>一级模块</th>
                                                <th style={{ width: '6%' }}>二级模块</th>
                                                <th style={{ width: '7%' }}>三级模块</th>
                                                <th style={{ width: '9%' }}>功能用户</th>
                                                <th style={{ width: '5%' }}>触发事件</th>
                                                <th style={{ width: '9%' }}>功能过程</th>
                                                <th style={{ width: '11%' }}>子过程描述</th>
                                                <th style={{ width: '4%' }}>类型</th>
                                                <th style={{ width: '8%' }}>数据组</th>
                                                <th style={{ width: '14%' }}>数据属性</th>
                                                <th style={{ width: '18%' }}>功能描述</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(() => {
                                                // 构建 functionalProcess → levels 映射
                                                const procLevelMap = {};
                                                parsedFunctions.forEach(f => {
                                                    const lv = getModuleLevels(f);
                                                    procLevelMap[f.functionName] = lv;
                                                });
                                                const functionDescriptionMap = buildFunctionDescriptionMap(tableData, parsedFunctions);
                                                let lastLevels = { level1: '', level2: '', level3: '' };
                                                return tableData.map((row, idx) => {
                                                    if (row.dataMovementType === 'E' && row.functionalProcess) {
                                                        lastLevels = procLevelMap[row.functionalProcess] || { level1: '', level2: '', level3: '' };
                                                    }
                                                    const lv = lastLevels;
                                                    const functionDescription = row.dataMovementType === 'E'
                                                        ? (functionDescriptionMap.get(row.functionalProcess) || row.functionDescription || '')
                                                        : '';
                                                    return (
                                                        <tr key={idx} className={row.dataMovementType === 'E' ? 'row-e' : ''}>
                                                            <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{idx + 1}</td>
                                                            <td style={{ fontSize: 11 }}>
                                                                {row.dataMovementType === 'E' && lv.level1 ? (
                                                                    <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, background: 'rgba(108,92,231,0.1)', color: 'var(--accent-violet)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }} title={lv.level1}>{lv.level1}</span>
                                                                ) : ''}
                                                            </td>
                                                            <td style={{ fontSize: 11 }}>
                                                                {row.dataMovementType === 'E' && lv.level2 ? (
                                                                    <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.1)', color: '#3b82f6', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }} title={lv.level2}>{lv.level2}</span>
                                                                ) : ''}
                                                            </td>
                                                            <td style={{ fontSize: 11 }}>
                                                                {row.dataMovementType === 'E' && lv.level3 ? (
                                                                    <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.1)', color: '#10b981', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }} title={lv.level3}>{lv.level3}</span>
                                                                ) : ''}
                                                            </td>
                                                            <td>{row.dataMovementType === 'E' ? row.functionalUser : ''}</td>
                                                            <td>{row.dataMovementType === 'E' ? row.triggerEvent : ''}</td>
                                                            <td style={{ fontWeight: row.functionalProcess ? 600 : 400, color: row.functionalProcess ? 'var(--text-primary)' : '' }}>
                                                                {row.functionalProcess}
                                                            </td>
                                                            <td>{row.subProcessDesc}</td>
                                                            <td style={{ textAlign: 'center' }}>
                                                                <span className={`dmt-badge dmt-${row.dataMovementType?.toLowerCase()}`}>{row.dataMovementType}</span>
                                                            </td>
                                                            <td>{row.dataGroup}</td>
                                                            <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{row.dataAttributes}</td>
                                                            <td className="function-description-cell" title={functionDescription}>
                                                                {functionDescription}
                                                            </td>
                                                        </tr>
                                                    );
                                                });
                                            })()}
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

                    {/* ═══ 数量规划弹窗（借鉴NESMA） ═══ */}
                    {showQuantityPlan && quantityPlan && (
                        <div className="table-view-overlay" onClick={() => setShowQuantityPlan(false)}>
                            <div className="table-view-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 760 }}>
                                <div className="table-view-header">
                                    <h2><BarChart3 size={18} /> 数量优先·模块规划</h2>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                            共 {quantityPlan.length} 个三级模块 · 目标合计&nbsp;
                                            <strong style={{ color: '#f59e0b' }}>{quantityPlan.reduce((s, p) => s + p.target, 0)}</strong> 个功能过程
                                        </span>
                                        <button className="btn btn-ghost btn-icon" onClick={() => setShowQuantityPlan(false)}>
                                            <X size={18} />
                                        </button>
                                    </div>
                                </div>

                                {/* 总量重新分配工具栏 */}
                                <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'rgba(245,158,11,0.04)' }}>
                                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>重新按总目标数分配：</span>
                                    <input
                                        type="number" min={0} step={1}
                                        value={totalTargetCount}
                                        onChange={e => updateQuantityTotalTarget(e.target.value)}
                                        style={{ width: 80, padding: '3px 6px', fontSize: 13, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', textAlign: 'center' }}
                                    />
                                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>个</span>
                                    <button
                                        onClick={() => {
                                            const mods = quantityPlan;
                                            const targets = allocateQuantityTargets(mods, totalTargetCount);
                                            const plan = mods.map((m, i) => ({
                                                ...m,
                                                target: targets[i] || 0
                                            }));
                                            setQuantityPlan(plan);
                                        }}
                                        style={{ padding: '4px 14px', borderRadius: 8, fontSize: 12, border: 'none', cursor: 'pointer', background: '#f59e0b', color: '#fff', fontWeight: 600 }}
                                    >
                                        <RefreshCw size={13} /> 按比例重新分配
                                    </button>
                                    <button
                                        onClick={() => {
                                            const n = quantityPlan.length;
                                            const base = Math.floor(totalTargetCount / n);
                                            const rem = totalTargetCount - base * n;
                                            setQuantityPlan(prev => prev.map((m, i) => ({ ...m, target: base + (i < rem ? 1 : 0) })));
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
                                            <div style={{ fontSize: 11, color: 'var(--accent-violet)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mod.level1}>{mod.level1}</div>
                                            <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mod.level2}>{mod.level2}</div>
                                            <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mod.level3}>{mod.level3}</div>
                                            <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(mod.businessObjects || []).join('、')}>{(mod.businessObjects || []).join('、') || '-'}</div>
                                            <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>~{mod.estimated || '?'}</div>
                                            <div style={{ textAlign: 'center' }}>
                                                <input
                                                    type="number" min={0} max={200}
                                                    value={mod.target}
                                                    onChange={e => {
                                                        const val = Math.max(0, parseInt(e.target.value) || 0);
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
                                    <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                        <Info size={13} /> 目标数量越大，AI会对该模块展开更多功能过程细节
                                    </span>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <button className="btn btn-secondary" onClick={() => setShowQuantityPlan(false)}>关闭</button>
                                        <button className="btn btn-primary" onClick={() => { setShowQuantityPlan(false); showToast('规划已保存，开始提取时将按此规划执行'); }}>
                                            <Save size={14} /> 保存规划
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ═══ Function List Editor Modal (Structured) ═══ */}
                    {showFunctionListEditor && (
                        <div className="function-list-panel" onClick={() => setShowFunctionListEditor(false)}>
                            <div className="func-editor-container" onClick={e => e.stopPropagation()}>
                                <div className="func-editor-header">
                                    <div className="func-editor-header-left">
                                        <h2><Edit3 size={18} /> 功能过程列表编辑</h2>
                                        <span className="func-editor-count">
                                            共 {parsedFunctions.length} 个 · 已选 {parsedFunctions.filter(f => f.selected !== false).length} 个
                                        </span>
                                    </div>
                                    <div className="func-editor-header-right">
                                        <button className="btn btn-secondary btn-sm" onClick={addFunction}>
                                            <Plus size={14} /> 新增功能
                                        </button>
                                        <button className="btn btn-ghost btn-icon" onClick={() => setShowFunctionListEditor(false)}>
                                            <X size={18} />
                                        </button>
                                    </div>
                                </div>

                                {/* 表格头 */}
                                <div className="func-editor-table-header">
                                    <div className="func-col func-col-check">选中</div>
                                    <div className="func-col func-col-idx">#</div>
                                    <div className="func-col func-col-module">一级模块</div>
                                    <div className="func-col func-col-module">二级模块</div>
                                    <div className="func-col func-col-module">三级模块</div>
                                    <div className="func-col func-col-trigger">触发事件</div>
                                    <div className="func-col func-col-user">功能用户</div>
                                    <div className="func-col func-col-name">功能过程名称</div>
                                    <div className="func-col func-col-desc">功能过程描述</div>
                                    <div className="func-col func-col-actions">操作</div>
                                </div>

                                <div className="func-editor-body">
                                    {parsedFunctions.length === 0 ? (
                                        <div className="func-editor-empty">
                                            <p>暂无功能过程数据</p>
                                            <button className="btn btn-primary btn-sm" onClick={addFunction}>
                                                <Plus size={14} /> 添加第一个功能过程
                                            </button>
                                        </div>
                                    ) : (
                                        inheritMissingFunctionLevels(parsedFunctions).map((func, idx) => (
                                            <div
                                                key={func.id || idx}
                                                className={`func-editor-row ${func.selected === false ? 'disabled' : ''} ${editingFunctionIndex === idx ? 'editing' : ''}`}
                                            >
                                                <div className="func-col func-col-check">
                                                    <input
                                                        type="checkbox"
                                                        checked={func.selected !== false}
                                                        onChange={() => toggleFunctionSelected(idx)}
                                                        style={{ accentColor: 'var(--accent-violet)', cursor: 'pointer' }}
                                                    />
                                                </div>
                                                <div className="func-col func-col-idx">
                                                    <span className="func-idx-badge">{idx + 1}</span>
                                                </div>
                                                {(() => {
                                                    const lv = getModuleLevels(func); return (<>
                                                        <div className="func-col func-col-module" title={lv.level1}>
                                                            <span className="func-module-tag lv1">{lv.level1 || '—'}</span>
                                                        </div>
                                                        <div className="func-col func-col-module" title={lv.level2}>
                                                            <span className="func-module-tag lv2">{lv.level2 || '—'}</span>
                                                        </div>
                                                        <div className="func-col func-col-module" title={lv.level3}>
                                                            <span className="func-module-tag lv3">{lv.level3 || '—'}</span>
                                                        </div>
                                                    </>);
                                                })()}
                                                <div className="func-col func-col-trigger">
                                                    <select
                                                        className="func-select"
                                                        value={func.triggerEvent || '用户触发'}
                                                        onChange={e => updateFunction(idx, 'triggerEvent', e.target.value)}
                                                    >
                                                        <option value="用户触发">用户触发</option>
                                                        <option value="时钟触发">时钟触发</option>
                                                        <option value="接口调用触发">接口调用触发</option>
                                                    </select>
                                                </div>
                                                <div className="func-col func-col-user">
                                                    <input
                                                        className="func-input"
                                                        value={func.functionalUser || ''}
                                                        onChange={e => updateFunction(idx, 'functionalUser', e.target.value)}
                                                        placeholder="发起者：用户 接收者：用户"
                                                    />
                                                </div>
                                                <div className="func-col func-col-name">
                                                    <input
                                                        className="func-input func-input-name"
                                                        value={func.functionName || ''}
                                                        onChange={e => updateFunction(idx, 'functionName', e.target.value)}
                                                        placeholder="请输入功能过程名称"
                                                    />
                                                </div>
                                                <div className="func-col func-col-desc">
                                                    <input
                                                        className="func-input"
                                                        value={func.description || ''}
                                                        onChange={e => updateFunction(idx, 'description', e.target.value)}
                                                        placeholder="功能过程描述..."
                                                    />
                                                </div>
                                                <div className="func-col func-col-actions">
                                                    <button
                                                        className="func-action-btn" title="拆分为两个功能"
                                                        onClick={() => splitFunction(idx)}
                                                    >
                                                        <Scissors size={13} />
                                                    </button>
                                                    <button
                                                        className="func-action-btn danger" title="删除此功能"
                                                        onClick={() => deleteFunction(idx)}
                                                    >
                                                        <Trash2 size={13} />
                                                    </button>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>

                                <div className="func-editor-footer">
                                    <div className="func-editor-footer-info">
                                        <Info size={14} style={{ color: 'var(--text-muted)' }} />
                                        <span>可直接点击表格字段编辑 · 拆分可将一个功能过程复制为两个 · 取消选中的功能不会参与COSMIC拆分</span>
                                    </div>
                                    <div className="func-editor-footer-actions">
                                        <button className="btn btn-secondary" onClick={() => setShowFunctionListEditor(false)}>
                                            取消
                                        </button>
                                        <button className="btn btn-primary" onClick={saveFunctionEdits}>
                                            <Save size={14} /> 保存修改
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ═══ Sequence Diagram Modal ═══ */}
                    <SequenceDiagram
                        tableData={tableData}
                        isOpen={showSequenceDiagram}
                        onClose={() => setShowSequenceDiagram(false)}
                    />
                </>
            )}
        </div>
    );
}

export default App;
