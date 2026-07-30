import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
    AlertCircle,
    CheckCircle,
    Download,
    FileSpreadsheet,
    FileText,
    Loader2,
    RefreshCw,
    Sparkles,
    Upload,
    Wand2,
    X
} from 'lucide-react';

const MAX_OFFICE_MB = 80;
const ALLOWED_EXTENSIONS = ['.docx', '.txt', '.md', '.xlsx', '.xlsm', '.csv'];

const WORD_ACTIONS = [
    {
        title: '润色并优化结构',
        description: '保留原意，改善表达、标题层级和段落组织',
        prompt: '请在不改变事实和核心观点的前提下，润色全文，优化标题层级、段落结构和表达，使文档更专业、更易读。',
        format: 'docx'
    },
    {
        title: '整理成正式报告',
        description: '将素材重组为可直接交付的商务报告',
        prompt: '请把现有内容整理成一份正式的商务报告，补齐清晰的标题层级、摘要、主要内容和行动建议。不要编造缺失事实。',
        format: 'docx'
    },
    {
        title: '生成方案或制度',
        description: '根据文字要求从零生成规范 Word 文档',
        prompt: '请根据我的要求生成一份完整、专业、可执行的 Word 文档，包含清晰的目标、范围、具体内容、实施步骤和验收标准。',
        format: 'docx'
    }
];

const EXCEL_ACTIONS = [
    {
        title: '清洗并规范表格',
        description: '统一表头、格式、列宽和数据可读性',
        prompt: '请检查并整理这个工作簿：统一表头和格式，优化列宽与换行，保留现有数据和公式，并让表格更清晰、专业、易于维护。',
        format: 'xlsx'
    },
    {
        title: '补充统计与公式',
        description: '按需求增加可审计的计算、汇总和结果区域',
        prompt: '请理解当前工作簿结构，根据数据增加必要的统计、汇总和公式。派生值必须使用可审计的 Excel 公式，并保留原始数据。',
        format: 'xlsx'
    },
    {
        title: '生成台账或清单',
        description: '从零生成结构化、可持续维护的工作簿',
        prompt: '请根据我的要求生成一个专业的 Excel 台账，包含清晰字段、示例或待补充行、状态列、必要公式、筛选和冻结表头。',
        format: 'xlsx'
    }
];

function getExtension(filename) {
    const dotIndex = String(filename || '').lastIndexOf('.');
    return dotIndex >= 0 ? String(filename).slice(dotIndex).toLowerCase() : '';
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseDownloadFilename(contentDisposition, fallback) {
    const value = String(contentDisposition || '');
    const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) {
        try {
            return decodeURIComponent(utf8Match[1]);
        } catch {
            return utf8Match[1];
        }
    }
    const plainMatch = value.match(/filename="?([^";]+)"?/i);
    return plainMatch?.[1] || fallback;
}

function decodeHeader(value, fallback = '') {
    if (!value) return fallback;
    try {
        return decodeURIComponent(value);
    } catch {
        return String(value);
    }
}

async function getBinaryErrorMessage(error) {
    const data = error?.response?.data;
    if (data instanceof Blob) {
        try {
            const text = await data.text();
            const parsed = JSON.parse(text);
            return parsed.error || text;
        } catch {
            return error.message;
        }
    }
    return data?.error || error.message;
}

function WordPreview({ inspection }) {
    return (
        <div className="office-preview-card">
            <div className="office-preview-head">
                <div>
                    <span className="office-preview-kicker">WORD 内容概览</span>
                    <h3>{inspection.filename}</h3>
                </div>
                <div className="office-preview-stats">
                    <span>{inspection.metadata?.characters?.toLocaleString() || 0} 字符</span>
                    <span>{inspection.metadata?.paragraphs?.toLocaleString() || 0} 段落</span>
                </div>
            </div>
            {inspection.metadata?.headings?.length > 0 && (
                <div className="office-heading-list">
                    {inspection.metadata.headings.slice(0, 8).map((heading, index) => (
                        <span key={`${heading}-${index}`}>{heading.replace(/^#+\s*/, '')}</span>
                    ))}
                </div>
            )}
            <div className="office-text-preview">{inspection.preview || '未提取到可预览文本'}</div>
        </div>
    );
}

function ExcelPreview({ inspection }) {
    const [activeSheet, setActiveSheet] = useState(0);
    const sheets = inspection.metadata?.sheets || [];
    const sheet = sheets[activeSheet] || sheets[0];
    const rows = sheet?.preview || [];
    const columnCount = Math.max(...rows.map(row => row.length), 1);

    useEffect(() => {
        setActiveSheet(0);
    }, [inspection.filename]);

    return (
        <div className="office-preview-card">
            <div className="office-preview-head">
                <div>
                    <span className="office-preview-kicker">EXCEL 工作簿概览</span>
                    <h3>{inspection.filename}</h3>
                </div>
                <div className="office-preview-stats">
                    <span>{inspection.metadata?.sheetCount || 0} 个工作表</span>
                    <span>{inspection.metadata?.formulaCount || 0} 个公式</span>
                </div>
            </div>
            <div className="office-sheet-tabs">
                {sheets.map((item, index) => (
                    <button
                        key={item.name}
                        type="button"
                        className={index === activeSheet ? 'active' : ''}
                        onClick={() => setActiveSheet(index)}
                    >
                        {item.name}
                        <small>{item.rowCount} × {item.columnCount}</small>
                    </button>
                ))}
            </div>
            {sheet && (
                <div className="office-table-preview-wrap">
                    <table className="office-table-preview">
                        <tbody>
                            {rows.map((row, rowIndex) => (
                                <tr key={rowIndex}>
                                    {Array.from({ length: columnCount }, (_, columnIndex) => (
                                        <td key={columnIndex} className={rowIndex === 0 ? 'header-cell' : ''}>
                                            {String(row[columnIndex] ?? '')}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function EmptyWorkspace({ onAction }) {
    return (
        <div className="office-empty-workspace">
            <div className="office-empty-title">
                <Sparkles size={20} />
                <div>
                    <h2>也可以不上传文件，直接生成</h2>
                    <p>选择一个起点，再补充你的具体业务要求。</p>
                </div>
            </div>
            <div className="office-action-grid">
                {[WORD_ACTIONS[2], EXCEL_ACTIONS[2]].map(action => (
                    <button key={action.title} type="button" onClick={() => onAction(action)}>
                        <span className={`office-action-icon ${action.format}`}>
                            {action.format === 'docx' ? <FileText size={20} /> : <FileSpreadsheet size={20} />}
                        </span>
                        <strong>{action.title}</strong>
                        <small>{action.description}</small>
                    </button>
                ))}
            </div>
        </div>
    );
}

function OfficeDocumentApp({ selectedModel, getUserConfig, showToast }) {
    const inputRef = useRef(null);
    const [sourceFile, setSourceFile] = useState(null);
    const [inspection, setInspection] = useState(null);
    const [instruction, setInstruction] = useState('');
    const [outputFormat, setOutputFormat] = useState('auto');
    const [style, setStyle] = useState('professional');
    const [isDragging, setIsDragging] = useState(false);
    const [isInspecting, setIsInspecting] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [activity, setActivity] = useState([]);
    const [error, setError] = useState('');
    const [output, setOutput] = useState(null);

    const actions = inspection?.kind === 'excel' ? EXCEL_ACTIONS : WORD_ACTIONS;
    const canProcess = instruction.trim().length > 0 && !isProcessing && !isInspecting;
    const effectiveFormat = outputFormat === 'auto'
        ? inspection?.kind === 'excel' ? 'xlsx' : inspection?.kind === 'word' ? 'docx' : 'auto'
        : outputFormat;

    useEffect(() => () => {
        if (output?.url) URL.revokeObjectURL(output.url);
    }, [output?.url]);

    const clearOutput = () => {
        setOutput(previous => {
            if (previous?.url) URL.revokeObjectURL(previous.url);
            return null;
        });
    };

    const resetSource = () => {
        setSourceFile(null);
        setInspection(null);
        setError('');
        setUploadProgress(0);
        clearOutput();
        if (inputRef.current) inputRef.current.value = '';
    };

    const validateFile = file => {
        const extension = getExtension(file?.name);
        if (!ALLOWED_EXTENSIONS.includes(extension)) {
            return `不支持 ${extension || '该'} 格式，请上传 ${ALLOWED_EXTENSIONS.join('、')}`;
        }
        if (file.size > MAX_OFFICE_MB * 1024 * 1024) {
            return `办公文档模块单文件最大支持 ${MAX_OFFICE_MB}MB`;
        }
        return '';
    };

    const inspectFile = async file => {
        const validationError = validateFile(file);
        if (validationError) {
            setError(validationError);
            return;
        }
        setSourceFile(file);
        setInspection(null);
        setError('');
        setActivity([]);
        clearOutput();
        setIsInspecting(true);
        setUploadProgress(0);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await axios.post('/api/office/inspect', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                timeout: 180000,
                onUploadProgress: event => {
                    if (event.total) setUploadProgress(Math.round((event.loaded / event.total) * 100));
                }
            });
            setInspection(response.data);
            setOutputFormat('auto');
            setActivity([{
                status: 'done',
                title: '文件理解完成',
                detail: response.data.kind === 'excel'
                    ? `已识别 ${response.data.metadata?.sheetCount || 0} 个工作表和 ${response.data.metadata?.formulaCount || 0} 个公式`
                    : `已识别 ${response.data.metadata?.characters?.toLocaleString() || 0} 个字符和 ${response.data.metadata?.paragraphs || 0} 个段落`
            }]);
            showToast?.('办公文件已解析，可以描述处理要求');
        } catch (requestError) {
            setSourceFile(null);
            setError(requestError.response?.data?.error || requestError.message || '文件解析失败');
        } finally {
            setIsInspecting(false);
            setTimeout(() => setUploadProgress(0), 500);
        }
    };

    const handleFileInput = event => {
        const file = event.target.files?.[0];
        if (file) inspectFile(file);
        event.target.value = '';
    };

    const handleDrop = event => {
        event.preventDefault();
        setIsDragging(false);
        const file = event.dataTransfer?.files?.[0];
        if (file) inspectFile(file);
    };

    const selectAction = action => {
        setInstruction(action.prompt);
        setOutputFormat(action.format);
        clearOutput();
    };

    const processDocument = async () => {
        if (!canProcess) return;
        setError('');
        clearOutput();
        setIsProcessing(true);
        setUploadProgress(0);
        const startedAt = Date.now();
        setActivity([
            {
                status: 'done',
                title: sourceFile ? '读取源文件' : '确认生成任务',
                detail: sourceFile ? `已载入 ${sourceFile.name}` : '将根据文字要求从零生成'
            },
            {
                status: 'running',
                title: '理解任务并制定处理方案',
                detail: `正在使用 ${selectedModel || '当前 AI 模型'} 分析内容、格式和交付目标`
            }
        ]);

        try {
            const formData = new FormData();
            if (sourceFile) formData.append('file', sourceFile);
            formData.append('instruction', instruction.trim());
            formData.append('outputFormat', outputFormat);
            formData.append('style', style);
            formData.append('userConfig', JSON.stringify(getUserConfig?.() || { model: selectedModel }));
            const response = await axios.post('/api/office/process', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                responseType: 'blob',
                timeout: 20 * 60 * 1000,
                onUploadProgress: event => {
                    if (event.total) setUploadProgress(Math.round((event.loaded / event.total) * 100));
                }
            });

            const format = response.headers['x-office-format']
                || (effectiveFormat === 'xlsx' ? 'xlsx' : 'docx');
            const fallbackName = `办公文档处理结果.${format}`;
            const filename = parseDownloadFilename(response.headers['content-disposition'], fallbackName);
            const summary = decodeHeader(response.headers['x-office-summary'], '办公文档已处理完成');
            let stats = {};
            try {
                stats = JSON.parse(decodeHeader(response.headers['x-office-stats'], '{}'));
            } catch {
                stats = {};
            }
            const url = URL.createObjectURL(response.data);
            setOutput({ url, filename, summary, format, stats, size: response.data.size });
            setActivity(previous => [
                previous[0],
                {
                    status: 'done',
                    title: '理解任务并制定处理方案',
                    detail: '已完成内容与结构规划'
                },
                {
                    status: 'done',
                    title: format === 'xlsx' ? '生成并校验 Excel 工作簿' : '生成并校验 Word 文档',
                    detail: stats.executionMode === 'groupedText'
                        ? `已覆盖 ${stats.processedRows || 0} 行、生成 ${stats.generatedTextCount || 0} 条分组文本，文件已可下载`
                        : `处理耗时 ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))} 秒，文件已可下载`
                }
            ]);
            showToast?.('办公文档处理完成');
        } catch (requestError) {
            const message = await getBinaryErrorMessage(requestError);
            setError(message || '办公文档处理失败');
            setActivity(previous => previous.map((item, index) => index === previous.length - 1
                ? { ...item, status: 'error', title: '处理失败', detail: message || '请检查任务要求后重试' }
                : item));
        } finally {
            setIsProcessing(false);
            setTimeout(() => setUploadProgress(0), 800);
        }
    };

    const downloadOutput = () => {
        if (!output?.url) return;
        const link = document.createElement('a');
        link.href = output.url;
        link.download = output.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
    };

    const outputStats = useMemo(() => {
        if (!output) return [];
        if (output.format === 'xlsx') {
            if (output.stats?.executionMode === 'groupedText') {
                return [
                    `${output.stats?.groupCount || 0} 个逻辑分组`,
                    `${output.stats?.generatedTextCount || 0} 条文本`,
                    `${output.stats?.processedRows || 0} 行全部覆盖`,
                    `${output.stats?.batchCount || 0} 个后台批次`,
                    output.stats?.errorCount ? `${output.stats.errorCount} 个已有公式错误` : '未发现已有公式错误'
                ];
            }
            return [
                `${output.stats?.sheetCount || 0} 个工作表`,
                `${output.stats?.formulaCount || 0} 个公式`,
                output.stats?.errorCount ? `${output.stats.errorCount} 个已有公式错误` : '未发现已有公式错误'
            ];
        }
        return [
            `${output.stats?.characters?.toLocaleString() || 0} 字符`,
            `${output.stats?.sections || 0} 个章节`,
            formatBytes(output.size)
        ];
    }, [output]);

    return (
        <div className="main-content office-main">
            <div className="top-bar office-top-bar">
                <div className="top-bar-left">
                    <span className="top-bar-title">智能办公文档中心</span>
                    <span className="office-top-badge">Word · Excel</span>
                </div>
                <div className="office-top-capabilities">
                    <span><CheckCircle size={13} />理解需求</span>
                    <span><CheckCircle size={13} />修改优化</span>
                    <span><CheckCircle size={13} />从零生成</span>
                </div>
            </div>

            {(uploadProgress > 0 && uploadProgress < 100) && (
                <div className="office-upload-progress">
                    <div style={{ width: `${uploadProgress}%` }} />
                </div>
            )}

            <div className="office-workspace">
                <section className="office-hero">
                    <div className="office-hero-copy">
                        <span className="office-eyebrow"><Wand2 size={15} /> 通用文档智能处理</span>
                        <h1>把需求说清楚，剩下的交给系统</h1>
                        <p>上传现有 Word 或 Excel 直接修改，也可以只描述目标，从零生成一份专业、可继续编辑的办公文档。</p>
                    </div>
                    <div className="office-format-pills">
                        <span className="word"><FileText size={17} /> DOCX</span>
                        <span className="excel"><FileSpreadsheet size={17} /> XLSX</span>
                    </div>
                </section>

                <div className="office-grid">
                    <div className="office-source-column">
                        <section className="office-panel">
                            <div className="office-panel-heading">
                                <div>
                                    <span className="office-step">01</span>
                                    <h2>源文件（可选）</h2>
                                </div>
                                {sourceFile && (
                                    <button type="button" className="office-link-button" onClick={resetSource}>
                                        <X size={14} /> 移除
                                    </button>
                                )}
                            </div>

                            {!sourceFile ? (
                                <div
                                    className={`office-drop-zone ${isDragging ? 'dragging' : ''}`}
                                    onClick={() => inputRef.current?.click()}
                                    onDragEnter={event => { event.preventDefault(); setIsDragging(true); }}
                                    onDragOver={event => event.preventDefault()}
                                    onDragLeave={() => setIsDragging(false)}
                                    onDrop={handleDrop}
                                >
                                    <span className="office-drop-icon"><Upload size={27} /></span>
                                    <strong>拖入 Word 或 Excel</strong>
                                    <p>或点击选择现有文件进行修改与优化</p>
                                    <small>支持 .docx / .txt / .md / .xlsx / .xlsm / .csv，最大 {MAX_OFFICE_MB}MB</small>
                                </div>
                            ) : (
                                <div className={`office-file-card ${inspection?.kind || ''}`}>
                                    <span className="office-file-icon">
                                        {inspection?.kind === 'excel' ? <FileSpreadsheet size={24} /> : <FileText size={24} />}
                                    </span>
                                    <div>
                                        <strong>{sourceFile.name}</strong>
                                        <span>{formatBytes(sourceFile.size)} · {inspection?.kind === 'excel' ? 'Excel 工作簿' : 'Word 文档'}</span>
                                    </div>
                                    {isInspecting ? <Loader2 className="spinner" size={20} /> : <CheckCircle size={20} />}
                                </div>
                            )}
                            <input
                                ref={inputRef}
                                type="file"
                                accept={ALLOWED_EXTENSIONS.join(',')}
                                onChange={handleFileInput}
                                style={{ display: 'none' }}
                            />
                        </section>

                        {inspection ? (
                            inspection.kind === 'excel'
                                ? <ExcelPreview inspection={inspection} />
                                : <WordPreview inspection={inspection} />
                        ) : (
                            <EmptyWorkspace onAction={selectAction} />
                        )}
                    </div>

                    <div className="office-task-column">
                        <section className="office-panel office-task-panel">
                            <div className="office-panel-heading">
                                <div>
                                    <span className="office-step">02</span>
                                    <h2>描述处理要求</h2>
                                </div>
                                <span className="office-required">必填</span>
                            </div>

                            <div className="office-action-chips">
                                {actions.map(action => (
                                    <button key={action.title} type="button" onClick={() => selectAction(action)}>
                                        {action.title}
                                    </button>
                                ))}
                            </div>

                            <textarea
                                value={instruction}
                                onChange={event => {
                                    setInstruction(event.target.value);
                                    clearOutput();
                                }}
                                placeholder={inspection?.kind === 'excel'
                                    ? '例如：保留原始数据，新增一个“月度汇总”工作表，按部门统计金额并增加完成率公式；统一日期与金额格式……'
                                    : '例如：保留原有事实和数据，重写摘要，优化标题层级，把实施步骤整理成编号列表，整体语气更正式……'}
                                rows={8}
                            />
                            <div className="office-instruction-footer">
                                <span>{instruction.trim().length} 字</span>
                                <span>系统会保留未被要求删除的重要内容</span>
                            </div>

                            <div className="office-options">
                                <label>
                                    <span>输出格式</span>
                                    <select value={outputFormat} onChange={event => setOutputFormat(event.target.value)}>
                                        <option value="auto">智能判断{effectiveFormat !== 'auto' ? `（${effectiveFormat.toUpperCase()}）` : ''}</option>
                                        <option value="docx">Word（.docx）</option>
                                        <option value="xlsx">Excel（.xlsx）</option>
                                    </select>
                                </label>
                                <label>
                                    <span>排版风格</span>
                                    <select value={style} onChange={event => setStyle(event.target.value)}>
                                        <option value="professional">专业商务</option>
                                        <option value="executive">简洁汇报</option>
                                        <option value="compact">紧凑实用</option>
                                        <option value="minimal">极简清晰</option>
                                    </select>
                                </label>
                            </div>

                            <button
                                type="button"
                                className="office-process-button"
                                disabled={!canProcess}
                                onClick={processDocument}
                            >
                                {isProcessing ? <Loader2 className="spinner" size={18} /> : <Sparkles size={18} />}
                                {isProcessing ? '正在理解并处理文档…' : sourceFile ? '开始修改并生成' : '开始生成文档'}
                            </button>
                        </section>

                        {(activity.length > 0 || output) && (
                            <section className="office-panel office-result-panel">
                                <div className="office-panel-heading">
                                    <div>
                                        <span className="office-step">03</span>
                                        <h2>处理结果</h2>
                                    </div>
                                    {output && <span className="office-complete-badge"><CheckCircle size={13} /> 已完成</span>}
                                </div>
                                <div className="office-activity-list">
                                    {activity.map((item, index) => (
                                        <div key={`${item.title}-${index}`} className={`office-activity ${item.status}`}>
                                            <span>
                                                {item.status === 'running'
                                                    ? <Loader2 className="spinner" size={15} />
                                                    : item.status === 'error'
                                                        ? <AlertCircle size={15} />
                                                        : <CheckCircle size={15} />}
                                            </span>
                                            <div>
                                                <strong>{item.title}</strong>
                                                <small>{item.detail}</small>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {output && (
                                    <div className={`office-output-card ${output.format}`}>
                                        <span className="office-output-icon">
                                            {output.format === 'xlsx' ? <FileSpreadsheet size={25} /> : <FileText size={25} />}
                                        </span>
                                        <div className="office-output-info">
                                            <strong>{output.filename}</strong>
                                            <p>{output.summary}</p>
                                            <div>
                                                {outputStats.map(stat => <span key={stat}>{stat}</span>)}
                                            </div>
                                            {output.stats?.macroNotice && (
                                                <small className="office-output-warning">{output.stats.macroNotice}</small>
                                            )}
                                        </div>
                                        <button type="button" onClick={downloadOutput}>
                                            <Download size={17} /> 下载
                                        </button>
                                    </div>
                                )}
                            </section>
                        )}

                        {error && (
                            <div className="office-error">
                                <AlertCircle size={18} />
                                <div>
                                    <strong>处理没有完成</strong>
                                    <span>{error}</span>
                                </div>
                                <button type="button" onClick={() => setError('')}><X size={14} /></button>
                            </div>
                        )}

                        {error && instruction.trim() && !isProcessing && (
                            <button type="button" className="office-retry-button" onClick={processDocument}>
                                <RefreshCw size={15} /> 重新处理
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default OfficeDocumentApp;
