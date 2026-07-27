import React, { useRef, useState } from 'react';
import axios from 'axios';
import {
    AlertCircle,
    CheckCircle,
    Code2,
    FileArchive,
    FileCode2,
    Image,
    Loader2,
    Sparkles,
    Upload,
    X
} from 'lucide-react';

const SOURCE_EXTENSIONS = ['.zip', '.html', '.htm'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const MAX_SCREENSHOTS = 8;

const extensionOf = (filename) => {
    const index = String(filename || '').lastIndexOf('.');
    return index >= 0 ? filename.slice(index).toLowerCase() : '';
};

function CodeSourceAnalyzer({ isOpen, onClose, onComplete, userConfig }) {
    const sourceInputRef = useRef(null);
    const imageInputRef = useRef(null);
    const [sourceFile, setSourceFile] = useState(null);
    const [screenshots, setScreenshots] = useState([]);
    const [analysisMode, setAnalysisMode] = useState('requirement');
    const [userGuidelines, setUserGuidelines] = useState('');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [error, setError] = useState('');

    if (!isOpen) return null;

    const selectSource = (event) => {
        const file = event.target.files?.[0] || null;
        event.target.value = '';
        if (!file) return;
        const ext = extensionOf(file.name);
        if (!SOURCE_EXTENSIONS.includes(ext)) {
            setError('代码源仅支持 .zip、.html 或 .htm');
            return;
        }
        setError('');
        setSourceFile(file);
    };

    const selectScreenshots = (event) => {
        const selected = Array.from(event.target.files || []);
        event.target.value = '';
        const invalid = selected.find(file => !IMAGE_EXTENSIONS.includes(extensionOf(file.name)));
        if (invalid) {
            setError(`截图格式不支持：${invalid.name}`);
            return;
        }
        const merged = [...screenshots, ...selected].slice(0, MAX_SCREENSHOTS);
        setScreenshots(merged);
        setError(
            screenshots.length + selected.length > MAX_SCREENSHOTS
                ? `最多保留前 ${MAX_SCREENSHOTS} 张截图`
                : ''
        );
    };

    const removeScreenshot = (index) => {
        setScreenshots(current => current.filter((_, itemIndex) => itemIndex !== index));
    };

    const submit = async () => {
        if (!sourceFile && screenshots.length === 0) {
            setError('请至少上传一个代码包/HTML页面或一张系统截图');
            return;
        }

        const formData = new FormData();
        if (sourceFile) formData.append('source', sourceFile);
        screenshots.forEach(file => formData.append('screenshots', file));
        formData.append('analysisMode', analysisMode);
        formData.append('userGuidelines', userGuidelines);
        formData.append('userConfig', JSON.stringify(userConfig || {}));

        try {
            setError('');
            setIsAnalyzing(true);
            setUploadProgress(2);
            const response = await axios.post('/api/analyze-code-source', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                timeout: 20 * 60 * 1000,
                onUploadProgress: event => {
                    if (!event.total) return;
                    setUploadProgress(Math.min(35, Math.round((event.loaded / event.total) * 35)));
                }
            });
            setUploadProgress(100);
            onComplete(response.data);
            setSourceFile(null);
            setScreenshots([]);
            setUserGuidelines('');
        } catch (requestError) {
            setError(requestError.response?.data?.error || requestError.message || '代码反向分析失败');
        } finally {
            setIsAnalyzing(false);
            setTimeout(() => setUploadProgress(0), 800);
        }
    };

    return (
        <div className="table-view-overlay code-source-overlay" onClick={isAnalyzing ? undefined : onClose}>
            <div className="table-view-panel code-source-panel" onClick={event => event.stopPropagation()}>
                <div className="table-view-header code-source-header">
                    <div>
                        <h2><Code2 size={19} /> 代码 / 页面智能拆分</h2>
                        <p>从代码包、HTML页面和系统截图反向生成需求与COSMIC功能清单</p>
                    </div>
                    <button className="btn btn-ghost btn-icon" onClick={onClose} disabled={isAnalyzing}>
                        <X size={18} />
                    </button>
                </div>

                <div className="code-source-body">
                    {error && (
                        <div className="error-banner code-source-error">
                            <AlertCircle size={16} />
                            <span>{error}</span>
                        </div>
                    )}

                    <div className="code-source-section">
                        <div className="code-source-section-title">
                            <span>1</span>
                            上传分析材料
                        </div>
                        <div className="code-source-upload-grid">
                            <button
                                type="button"
                                className={`code-source-upload-card ${sourceFile ? 'selected' : ''}`}
                                onClick={() => sourceInputRef.current?.click()}
                                disabled={isAnalyzing}
                            >
                                <div className="code-source-upload-icon violet">
                                    {sourceFile ? <FileCode2 size={24} /> : <FileArchive size={24} />}
                                </div>
                                <strong>{sourceFile ? sourceFile.name : '上传代码包或HTML'}</strong>
                                <span>
                                    {sourceFile
                                        ? `${(sourceFile.size / 1024 / 1024).toFixed(2)} MB`
                                        : '支持 .zip、.html、.htm'}
                                </span>
                                <em>{sourceFile ? '点击更换文件' : '自动过滤依赖、构建产物和二进制文件'}</em>
                            </button>
                            <button
                                type="button"
                                className={`code-source-upload-card ${screenshots.length ? 'selected' : ''}`}
                                onClick={() => imageInputRef.current?.click()}
                                disabled={isAnalyzing}
                            >
                                <div className="code-source-upload-icon cyan"><Image size={24} /></div>
                                <strong>上传系统截图</strong>
                                <span>{screenshots.length ? `已选择 ${screenshots.length} 张` : '支持 PNG、JPG、WEBP'}</span>
                                <em>最多 {MAX_SCREENSHOTS} 张，可与代码一起分析</em>
                            </button>
                        </div>
                        <input
                            ref={sourceInputRef}
                            type="file"
                            accept=".zip,.html,.htm"
                            onChange={selectSource}
                            style={{ display: 'none' }}
                        />
                        <input
                            ref={imageInputRef}
                            type="file"
                            accept=".png,.jpg,.jpeg,.webp"
                            multiple
                            onChange={selectScreenshots}
                            style={{ display: 'none' }}
                        />

                        {screenshots.length > 0 && (
                            <div className="code-source-file-list">
                                {screenshots.map((file, index) => (
                                    <div key={`${file.name}-${file.lastModified}-${index}`} className="code-source-file-chip">
                                        <Image size={13} />
                                        <span title={file.name}>{file.name}</span>
                                        <button
                                            type="button"
                                            onClick={() => removeScreenshot(index)}
                                            disabled={isAnalyzing}
                                            aria-label={`移除 ${file.name}`}
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="code-source-section">
                        <div className="code-source-section-title">
                            <span>2</span>
                            选择处理方式
                        </div>
                        <div className="code-source-mode-grid">
                            <button
                                type="button"
                                className={`code-source-mode-card ${analysisMode === 'requirement' ? 'active' : ''}`}
                                onClick={() => setAnalysisMode('requirement')}
                                disabled={isAnalyzing}
                            >
                                <FileCode2 size={20} />
                                <div>
                                    <strong>先生成需求文档</strong>
                                    <span>适合需要评审、补充和留档的项目，再走现有完整拆分流程</span>
                                </div>
                                {analysisMode === 'requirement' && <CheckCircle size={17} />}
                            </button>
                            <button
                                type="button"
                                className={`code-source-mode-card ${analysisMode === 'direct' ? 'active' : ''}`}
                                onClick={() => setAnalysisMode('direct')}
                                disabled={isAnalyzing}
                            >
                                <Sparkles size={20} />
                                <div>
                                    <strong>直接形成COSMIC功能清单</strong>
                                    <span>跳过需求文档确认，识别后直接进入功能过程复核和ERWX拆分</span>
                                </div>
                                {analysisMode === 'direct' && <CheckCircle size={17} />}
                            </button>
                        </div>
                    </div>

                    <div className="code-source-section">
                        <div className="code-source-section-title">
                            <span>3</span>
                            补充业务背景（可选）
                        </div>
                        <textarea
                            className="setting-input code-source-guidelines"
                            rows={3}
                            value={userGuidelines}
                            onChange={event => setUserGuidelines(event.target.value)}
                            placeholder="例如：这是面向网络优化人员的工单系统；只分析业务功能，忽略系统管理和演示页面……"
                            disabled={isAnalyzing}
                        />
                    </div>

                    {isAnalyzing && (
                        <div className="code-source-progress">
                            <div className="code-source-progress-label">
                                <span><Loader2 size={15} className="spinner" /> 正在读取代码、识别界面并反向生成需求…</span>
                                <span>{uploadProgress < 35 ? `${uploadProgress}%` : 'AI分析中'}</span>
                            </div>
                            <div className="progress-bar-container">
                                <div
                                    className="progress-bar"
                                    style={{ width: `${uploadProgress < 35 ? uploadProgress : 72}%` }}
                                />
                            </div>
                        </div>
                    )}
                </div>

                <div className="code-source-footer">
                    <div className="code-source-hint">
                        <Upload size={14} />
                        代码文本会发送至已配置的AI服务分析，但不会执行压缩包中的程序
                    </div>
                    <div>
                        <button className="btn btn-secondary" onClick={onClose} disabled={isAnalyzing}>取消</button>
                        <button className="btn btn-primary" onClick={submit} disabled={isAnalyzing}>
                            {isAnalyzing
                                ? <><Loader2 size={15} className="spinner" /> 分析中…</>
                                : <><Sparkles size={15} /> 开始反向分析</>}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default CodeSourceAnalyzer;
