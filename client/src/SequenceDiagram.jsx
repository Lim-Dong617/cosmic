import React, { useState, useEffect, useRef, useCallback } from 'react';
import mermaid from 'mermaid';
import {
    X, Download, ChevronLeft, ChevronRight, Maximize2, Minimize2,
    FileText, ZoomIn, ZoomOut, RotateCcw, Layers
} from 'lucide-react';

// 初始化 Mermaid
mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
        primaryColor: '#6c5ce7',
        primaryTextColor: '#1a1a2e',
        primaryBorderColor: '#a29bfe',
        lineColor: '#636e72',
        secondaryColor: '#00b894',
        tertiaryColor: '#fdcb6e',
        noteBkgColor: '#f8f9fa',
        noteTextColor: '#2d3436',
        noteBorderColor: '#dfe6e9',
        actorBkg: '#6c5ce7',
        actorBorder: '#5b4cdb',
        actorTextColor: '#ffffff',
        actorLineColor: '#b2bec3',
        signalColor: '#2d3436',
        signalTextColor: '#2d3436',
        sequenceNumberColor: '#ffffff',
    },
    sequence: {
        diagramMarginX: 20,
        diagramMarginY: 20,
        actorMargin: 80,
        width: 180,
        height: 50,
        boxMargin: 10,
        boxTextMargin: 8,
        noteMargin: 12,
        messageMargin: 40,
        mirrorActors: false,
        useMaxWidth: false,
        showSequenceNumbers: true,
    },
    fontFamily: '"Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 13,
});

/**
 * 将 tableData 按功能过程分组
 */
function groupByFunctionalProcess(tableData) {
    const groups = [];
    let currentGroup = null;
    let currentFuncUser = '';
    let currentTrigger = '';

    for (const row of tableData) {
        if (row.dataMovementType === 'E') {
            if (currentGroup) groups.push(currentGroup);
            currentFuncUser = row.functionalUser || currentFuncUser;
            currentTrigger = row.triggerEvent || currentTrigger;
            currentGroup = {
                processName: row.functionalProcess || '未命名功能过程',
                functionalUser: currentFuncUser,
                triggerEvent: currentTrigger,
                rows: [row],
            };
        } else if (currentGroup) {
            currentGroup.rows.push(row);
        }
    }
    if (currentGroup) groups.push(currentGroup);
    return groups;
}

/**
 * 解析功能用户字段获取发起者和接收者
 */
function parseFunctionalUser(funcUser) {
    if (!funcUser) return { initiator: '用户', receiver: '用户' };
    const initMatch = funcUser.match(/发起者[：:]\s*(.+?)(?:\s|$)/);
    const recvMatch = funcUser.match(/接收者[：:]\s*(.+?)(?:\s|$)/);
    return {
        initiator: initMatch ? initMatch[1].trim() : '用户',
        receiver: recvMatch ? recvMatch[1].trim() : '用户',
    };
}

/**
 * 安全化 Mermaid 参与者名称（去除特殊字符）
 */
function sanitizeActorName(name) {
    return name.replace(/[<>"{}|\\\/\[\]()#;]/g, '').trim() || '未知';
}

/**
 * 为单个功能过程生成 Mermaid 时序图定义
 */
function generateMermaidDef(group) {
    const { processName, functionalUser, triggerEvent, rows } = group;
    const { initiator, receiver } = parseFunctionalUser(functionalUser);

    const safeInitiator = sanitizeActorName(initiator);
    const safeReceiver = sanitizeActorName(receiver);

    // 确定参与者
    const actors = new Set();
    const isTimerTrigger = triggerEvent?.includes('时钟');
    const isInterfaceTrigger = triggerEvent?.includes('接口');

    let triggerActor = safeInitiator;
    if (isTimerTrigger) triggerActor = '定时触发器';
    else if (isInterfaceTrigger) triggerActor = safeInitiator;

    actors.add(triggerActor);
    actors.add('系统');
    actors.add('数据库');
    if (safeReceiver !== triggerActor && safeReceiver !== '系统' && safeReceiver !== '本系统') {
        actors.add(safeReceiver);
    }

    let mermaidCode = 'sequenceDiagram\n';

    // 声明参与者
    if (isTimerTrigger) {
        mermaidCode += `    participant T as 定时触发器\n`;
    } else if (isInterfaceTrigger) {
        mermaidCode += `    participant T as ${triggerActor}\n`;
    } else {
        mermaidCode += `    participant T as ${triggerActor}\n`;
    }
    mermaidCode += `    participant S as 系统\n`;
    mermaidCode += `    participant DB as 数据库\n`;
    if (safeReceiver !== triggerActor && safeReceiver !== '系统' && safeReceiver !== '本系统') {
        mermaidCode += `    participant R as ${safeReceiver}\n`;
    }

    // 功能过程标题
    const cleanProcessName = processName.replace(/\[.*?\]\s*/, '').trim();
    mermaidCode += `    \n`;
    mermaidCode += `    rect rgba(108, 92, 231, 0.05)\n`;
    mermaidCode += `    Note over T,DB: ${cleanProcessName}\n`;

    // 生成每一步数据移动
    for (const row of rows) {
        const dmt = row.dataMovementType;
        const desc = (row.subProcessDesc || '').replace(/[<>"{}|\\\/\[\]()#;]/g, '').trim();
        const dataGroup = (row.dataGroup || '').replace(/[<>"{}|\\\/\[\]()#;]/g, '').trim();

        switch (dmt) {
            case 'E':
                mermaidCode += `    T->>+S: ${desc}\n`;
                if (dataGroup) {
                    mermaidCode += `    Note right of T: [E] ${dataGroup}\n`;
                }
                break;
            case 'R':
                mermaidCode += `    S->>+DB: ${desc}\n`;
                mermaidCode += `    DB-->>-S: 返回数据\n`;
                if (dataGroup) {
                    mermaidCode += `    Note right of DB: [R] ${dataGroup}\n`;
                }
                break;
            case 'W':
                mermaidCode += `    S->>DB: ${desc}\n`;
                if (dataGroup) {
                    mermaidCode += `    Note right of DB: [W] ${dataGroup}\n`;
                }
                break;
            case 'X': {
                const outputTarget = (safeReceiver !== triggerActor && safeReceiver !== '系统' && safeReceiver !== '本系统')
                    ? 'R' : 'T';
                mermaidCode += `    S-->>-${outputTarget}: ${desc}\n`;
                if (dataGroup) {
                    mermaidCode += `    Note left of S: [X] ${dataGroup}\n`;
                }
                break;
            }
        }
    }

    mermaidCode += `    end\n`;

    return mermaidCode;
}


/**
 * SequenceDiagram 组件 - 时序图查看器
 */
function SequenceDiagram({ tableData, isOpen, onClose }) {
    const [groups, setGroups] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [renderedSvg, setRenderedSvg] = useState('');
    const [isRendering, setIsRendering] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [viewMode, setViewMode] = useState('single'); // 'single' | 'grid'
    const [gridSvgs, setGridSvgs] = useState([]);
    const containerRef = useRef(null);
    const svgContainerRef = useRef(null);

    // 分组
    useEffect(() => {
        if (isOpen && tableData && tableData.length > 0) {
            const g = groupByFunctionalProcess(tableData);
            setGroups(g);
            setCurrentIndex(0);
            setZoom(1);
        }
    }, [isOpen, tableData]);

    // 渲染单个时序图
    const renderDiagram = useCallback(async (index) => {
        if (!groups[index]) return;
        setIsRendering(true);
        try {
            const mermaidCode = generateMermaidDef(groups[index]);
            const id = `seq-diagram-${Date.now()}-${index}`;
            const { svg } = await mermaid.render(id, mermaidCode);
            setRenderedSvg(svg);
        } catch (err) {
            console.error('Mermaid 渲染失败:', err);
            setRenderedSvg(`<div style="padding:20px;color:#e74c3c;text-align:center;">
                <p style="font-size:16px;font-weight:600;">⚠️ 时序图渲染失败</p>
                <p style="font-size:13px;color:#95a5a6;margin-top:8px;">${err.message || '未知错误'}</p>
            </div>`);
        } finally {
            setIsRendering(false);
        }
    }, [groups]);

    // 渲染网格视图
    const renderGridView = useCallback(async () => {
        if (groups.length === 0) return;
        setIsRendering(true);
        const svgs = [];
        for (let i = 0; i < groups.length; i++) {
            try {
                const mermaidCode = generateMermaidDef(groups[i]);
                const id = `seq-grid-${Date.now()}-${i}`;
                const { svg } = await mermaid.render(id, mermaidCode);
                svgs.push({ index: i, svg, name: groups[i].processName });
            } catch (err) {
                svgs.push({
                    index: i,
                    svg: `<div style="padding:12px;color:#e74c3c;font-size:12px;">渲染失败</div>`,
                    name: groups[i].processName,
                });
            }
        }
        setGridSvgs(svgs);
        setIsRendering(false);
    }, [groups]);

    useEffect(() => {
        if (groups.length > 0 && viewMode === 'single') {
            renderDiagram(currentIndex);
        } else if (groups.length > 0 && viewMode === 'grid') {
            renderGridView();
        }
    }, [currentIndex, groups, viewMode, renderDiagram, renderGridView]);

    const goNext = () => setCurrentIndex(prev => Math.min(prev + 1, groups.length - 1));
    const goPrev = () => setCurrentIndex(prev => Math.max(prev - 1, 0));
    const zoomIn = () => setZoom(prev => Math.min(prev + 0.2, 3));
    const zoomOut = () => setZoom(prev => Math.max(prev - 0.2, 0.3));
    const resetZoom = () => setZoom(1);

    // 导出当前时序图为 SVG
    const exportSvg = () => {
        if (!renderedSvg) return;
        const blob = new Blob([renderedSvg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const currentGroup = groups[currentIndex];
        const cleanName = (currentGroup?.processName || '时序图').replace(/\[.*?\]\s*/, '').trim();
        link.download = `时序图_${cleanName}.svg`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
    };

    // 导出所有时序图为 HTML
    const exportAllAsHtml = async () => {
        if (groups.length === 0) return;
        let htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>COSMIC 时序图</title>
<style>
    body { font-family: 'Inter', 'Segoe UI', 'Microsoft YaHei', sans-serif; background: #f5f6fa; margin: 0; padding: 20px; }
    .diagram-container { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .diagram-title { font-size: 18px; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
    .diagram-meta { font-size: 13px; color: #636e72; margin-bottom: 16px; }
    .diagram-svg { overflow-x: auto; }
    h1 { text-align: center; color: #6c5ce7; font-size: 24px; margin-bottom: 8px; }
    .subtitle { text-align: center; color: #636e72; font-size: 14px; margin-bottom: 32px; }
</style>
</head>
<body>
<h1>🔬 COSMIC 时序图集</h1>
<p class="subtitle">共 ${groups.length} 个功能过程</p>
`;
        for (let i = 0; i < groups.length; i++) {
            try {
                const code = generateMermaidDef(groups[i]);
                const id = `export-${Date.now()}-${i}`;
                const { svg } = await mermaid.render(id, code);
                const cleanName = groups[i].processName.replace(/\[.*?\]\s*/, '').trim();
                htmlContent += `<div class="diagram-container">
    <div class="diagram-title">${i + 1}. ${cleanName}</div>
    <div class="diagram-meta">${groups[i].triggerEvent || ''} · ${groups[i].functionalUser || ''} · E→R→W→X 共 ${groups[i].rows.length} 步</div>
    <div class="diagram-svg">${svg}</div>
</div>\n`;
            } catch (err) {
                htmlContent += `<div class="diagram-container"><div class="diagram-title">${i + 1}. ${groups[i].processName}</div><p style="color:#e74c3c;">渲染失败: ${err.message}</p></div>\n`;
            }
        }
        htmlContent += '</body></html>';
        const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `COSMIC时序图_全部${groups.length}个.html`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
    };

    if (!isOpen) return null;

    const currentGroup = groups[currentIndex] || null;

    return (
        <div className="seq-diagram-overlay" onClick={onClose}>
            <div
                className={`seq-diagram-panel ${isFullscreen ? 'fullscreen' : ''}`}
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="seq-diagram-header">
                    <div className="seq-diagram-header-left">
                        <div className="seq-diagram-header-icon">📊</div>
                        <div>
                            <h2>COSMIC 时序图</h2>
                            <p>{groups.length} 个功能过程</p>
                        </div>
                    </div>
                    <div className="seq-diagram-header-right">
                        <div className="seq-diagram-view-toggle">
                            <button
                                className={`seq-view-btn ${viewMode === 'single' ? 'active' : ''}`}
                                onClick={() => setViewMode('single')}
                                title="单图浏览"
                            >
                                <FileText size={14} />
                            </button>
                            <button
                                className={`seq-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
                                onClick={() => setViewMode('grid')}
                                title="网格总览"
                            >
                                <Layers size={14} />
                            </button>
                        </div>
                        <button className="btn btn-secondary btn-sm" onClick={exportSvg} disabled={!renderedSvg || viewMode === 'grid'}>
                            <Download size={14} /> 导出SVG
                        </button>
                        <button className="btn btn-primary btn-sm" onClick={exportAllAsHtml} disabled={groups.length === 0}>
                            <Download size={14} /> 导出全部HTML
                        </button>
                        <button
                            className="btn btn-ghost btn-icon"
                            onClick={() => setIsFullscreen(!isFullscreen)}
                            title={isFullscreen ? '退出全屏' : '全屏'}
                        >
                            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                        </button>
                        <button className="btn btn-ghost btn-icon" onClick={onClose}>
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {viewMode === 'single' ? (
                    <>
                        {/* 功能过程导航 */}
                        <div className="seq-diagram-nav">
                            <button
                                className="seq-nav-btn"
                                onClick={goPrev}
                                disabled={currentIndex === 0}
                            >
                                <ChevronLeft size={16} />
                            </button>
                            <div className="seq-nav-info">
                                <select
                                    className="seq-nav-select"
                                    value={currentIndex}
                                    onChange={e => setCurrentIndex(parseInt(e.target.value))}
                                >
                                    {groups.map((g, idx) => {
                                        const cleanName = g.processName.replace(/\[.*?\]\s*/, '').trim();
                                        return (
                                            <option key={idx} value={idx}>
                                                {idx + 1}. {cleanName}
                                            </option>
                                        );
                                    })}
                                </select>
                                <span className="seq-nav-counter">{currentIndex + 1} / {groups.length}</span>
                            </div>
                            <button
                                className="seq-nav-btn"
                                onClick={goNext}
                                disabled={currentIndex === groups.length - 1}
                            >
                                <ChevronRight size={16} />
                            </button>
                        </div>

                        {/* 当前功能过程信息 */}
                        {currentGroup && (
                            <div className="seq-diagram-meta">
                                <div className="seq-meta-badge trigger">
                                    {currentGroup.triggerEvent?.includes('时钟') ? '⏰' :
                                        currentGroup.triggerEvent?.includes('接口') ? '🔗' : '👤'}
                                    {currentGroup.triggerEvent || '未知'}
                                </div>
                                <div className="seq-meta-badge user">
                                    {currentGroup.functionalUser || ''}
                                </div>
                                <div className="seq-meta-steps">
                                    {['E', 'R', 'W', 'X'].map(dmt => {
                                        const count = currentGroup.rows.filter(r => r.dataMovementType === dmt).length;
                                        return (
                                            <span key={dmt} className={`seq-step-badge step-${dmt.toLowerCase()}`}>
                                                {dmt}×{count}
                                            </span>
                                        );
                                    })}
                                    <span className="seq-step-total">
                                        共 {currentGroup.rows.length} 步 ({currentGroup.rows.length} CFP)
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Zoom Controls */}
                        <div className="seq-diagram-zoom">
                            <button className="seq-zoom-btn" onClick={zoomOut} title="缩小"><ZoomOut size={14} /></button>
                            <span className="seq-zoom-level">{Math.round(zoom * 100)}%</span>
                            <button className="seq-zoom-btn" onClick={zoomIn} title="放大"><ZoomIn size={14} /></button>
                            <button className="seq-zoom-btn" onClick={resetZoom} title="重置"><RotateCcw size={14} /></button>
                        </div>

                        {/* SVG 渲染区域 */}
                        <div className="seq-diagram-body" ref={svgContainerRef}>
                            {isRendering ? (
                                <div className="seq-diagram-loading">
                                    <div className="seq-loading-spinner" />
                                    <p>正在生成时序图...</p>
                                </div>
                            ) : (
                                <div
                                    className="seq-diagram-svg-wrapper"
                                    style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
                                    dangerouslySetInnerHTML={{ __html: renderedSvg }}
                                />
                            )}
                        </div>
                    </>
                ) : (
                    /* 网格视图 */
                    <div className="seq-diagram-grid-body">
                        {isRendering ? (
                            <div className="seq-diagram-loading">
                                <div className="seq-loading-spinner" />
                                <p>正在生成所有时序图...</p>
                            </div>
                        ) : (
                            <div className="seq-diagram-grid">
                                {gridSvgs.map((item) => (
                                    <div
                                        key={item.index}
                                        className="seq-grid-item"
                                        onClick={() => { setCurrentIndex(item.index); setViewMode('single'); }}
                                    >
                                        <div className="seq-grid-item-header">
                                            <span className="seq-grid-item-idx">{item.index + 1}</span>
                                            <span className="seq-grid-item-name">
                                                {item.name.replace(/\[.*?\]\s*/, '').trim()}
                                            </span>
                                        </div>
                                        <div
                                            className="seq-grid-item-svg"
                                            dangerouslySetInnerHTML={{ __html: item.svg }}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * 将 SVG 字符串转换为 PNG base64
 * @returns {{ base64: string, width: number, height: number }}
 */
async function svgToPngBase64(svgString, scale = 2) {
    return new Promise((resolve, reject) => {
        // 从 SVG 中提取宽高
        const widthMatch = svgString.match(/width="([^"]+)"/);
        const heightMatch = svgString.match(/height="([^"]+)"/);
        let svgWidth = widthMatch ? parseFloat(widthMatch[1]) : 800;
        let svgHeight = heightMatch ? parseFloat(heightMatch[1]) : 600;

        // 确保 SVG 有白色背景（Excel 中透明背景很丑）
        const bgRect = `<rect width="100%" height="100%" fill="white"/>`;
        const svgWithBg = svgString.replace(/(<svg[^>]*>)/, `$1${bgRect}`);

        const svgBlob = new Blob([svgWithBg], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth || svgWidth;
            const h = img.naturalHeight || svgHeight;
            const canvas = document.createElement('canvas');
            canvas.width = w * scale;
            canvas.height = h * scale;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.scale(scale, scale);
            ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            const dataUrl = canvas.toDataURL('image/png');
            const base64 = dataUrl.split(',')[1];
            resolve({ base64, width: w, height: h });
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('SVG to PNG conversion failed'));
        };
        img.src = url;
    });
}

/**
 * 生成所有功能过程的时序图 PNG 图片（用于嵌入 Excel）
 * @param {Array} tableData - COSMIC 拆分表格数据
 * @param {function} onProgress - 进度回调 (current, total)
 * @returns {Promise<Array<{ processName: string, imageBase64: string, width: number, height: number }>>}
 */
export async function generateAllDiagramImages(tableData, onProgress = null) {
    const groups = groupByFunctionalProcess(tableData);
    const results = [];

    for (let i = 0; i < groups.length; i++) {
        if (onProgress) onProgress(i + 1, groups.length);
        try {
            const mermaidCode = generateMermaidDef(groups[i]);
            const id = `excel-export-${Date.now()}-${i}`;
            const { svg } = await mermaid.render(id, mermaidCode);
            const { base64, width, height } = await svgToPngBase64(svg, 2);
            results.push({
                processName: groups[i].processName,
                processIndex: i,
                imageBase64: base64,
                width,
                height,
            });
        } catch (err) {
            console.warn(`时序图 ${i + 1} 生成失败:`, err.message);
            // 跳过失败的图，不阻塞整体导出
        }
        // 间隔一小会避免 Mermaid DOM 冲突
        await new Promise(r => setTimeout(r, 50));
    }

    return results;
}

export { groupByFunctionalProcess, generateMermaidDef };
export default SequenceDiagram;
