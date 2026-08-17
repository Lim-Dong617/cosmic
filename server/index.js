// ═══════════════════════════════════════════════════════════
// COSMIC 拆分智能分析系统 - 主服务器
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const docx = require('docx');
const JSZip = require('jszip');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config(); // also try CWD

const {
    callAI,
    callAIWithRetry,
    MODEL_MAP,
    DEFAULT_MODEL_ALIAS,
    SENSENOVA_MODEL_NAME,
    SENSENOVA_MODELS
} = require('./ai-client');
const {
    FUNCTION_EXTRACTION_PROMPT,
    COSMIC_SPLIT_PROMPT,
    DOCUMENT_UNDERSTANDING_PROMPT,
    COVERAGE_VERIFICATION_PROMPT,
    SUPPLEMENTARY_EXTRACTION_PROMPT,
    COSMIC_MODULE_RECOGNITION_PROMPT,
    COSMIC_QUANTITY_PRIORITY_PROMPT,
    SENSENOVA_V4_FUNCTION_EXTRACTION_PROMPT,
    SENSENOVA_V4_QUANTITY_PRIORITY_PROMPT,
    SENSENOVA_V4_COSMIC_SPLIT_PROMPT,
    buildCosmicSplitPrompt,
    buildSensenovaV4CosmicSplitPrompt
} = require('./prompts');
const { NESMA_FUNCTION_EXTRACTION_PROMPT, NESMA_QUANTITY_PRIORITY_PROMPT, NESMA_MODULE_RECOGNITION_PROMPT, NESMA_COVERAGE_VERIFICATION_PROMPT, NESMA_GUOCHANHUA_MIGRATION_PROMPT } = require('./nesma-prompts');
const { authRouter } = require('./auth');
const { initDatabase } = require('./database');
const { buildCosmicAssessmentWorkbook } = require('./cosmic-template-export');
const {
    canonicalFunctionNameKey,
    isReferenceOnlyChapterTitle,
    keepLastDuplicateHeadingPositions,
    orderCosmicTableData
} = require('./cosmic-quality');
const {
    MAX_SCREENSHOTS,
    analyzeCodeSource,
    extractSourceArtifact
} = require('./code-source-analyzer');
const {
    applyConversationPlan,
    createConversationPlan
} = require('./conversation-orchestrator');
const { registerOfficeDocumentRoutes } = require('./office-document-service');


const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '300', 10);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const REQUEST_BODY_LIMIT = `${MAX_UPLOAD_MB}mb`;

function escapeXmlAttr(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function stripManualHeadingNumber(text) {
    return String(text || '').replace(/^\s*\d+(?:\.\d+)*\.?\s*/, '').trim();
}

function nextWordNumberingId(xml, attrName) {
    const regex = new RegExp(`w:${attrName}="(\\d+)"`, 'g');
    let max = 0;
    let match;
    while ((match = regex.exec(xml))) {
        max = Math.max(max, Number(match[1]));
    }
    return max + 1;
}

function getWordStyleBlocks(stylesXml) {
    return [...String(stylesXml || '').matchAll(/<w:style\b(?=[^>]*w:type="paragraph")[^>]*>[\s\S]*?<\/w:style>/g)]
        .map(match => match[0]);
}

function detectHeadingStyleIds(stylesXml) {
    const byName = {};
    const byOutline = {};
    const maxWordHeadingLevel = 9;

    for (const block of getWordStyleBlocks(stylesXml)) {
        const styleId = block.match(/\bw:styleId="([^"]+)"/)?.[1];
        if (!styleId) continue;

        const name = block.match(/<w:name\b[^>]*\bw:val="([^"]*)"/)?.[1] || '';
        const outline = block.match(/<w:outlineLvl\b[^>]*\bw:val="(\d+)"/)?.[1];
        const headingName = name.toLowerCase().match(/^heading\s+([1-9])$/);
        const chineseHeadingName = name.match(/^标题\s*([1-9])$/);

        if (headingName) byName[Number(headingName[1]) - 1] = styleId;
        if (chineseHeadingName) byName[Number(chineseHeadingName[1]) - 1] = styleId;
        if (outline && Number(outline) >= 0 && Number(outline) < maxWordHeadingLevel) {
            byOutline[Number(outline)] ||= styleId;
        }
    }

    const detectedLevels = [
        ...Object.keys(byName).map(Number),
        ...Object.keys(byOutline).map(Number)
    ];
    const highestLevel = Math.max(3, ...detectedLevels);

    return Array.from({ length: highestLevel + 1 }, (_, level) => (
        byName[level]
        || byOutline[level]
        || `Heading${level + 1}`
    ));
}

function buildHeadingNumberingLevel(level, styleId) {
    const lvlText = Array.from({ length: level + 1 }, (_, index) => `%${index + 1}`).join('.') + '.';
    const safeStyleId = escapeXmlAttr(styleId);
    return [
        `<w:lvl w:ilvl="${level}">`,
        '<w:start w:val="1"/>',
        '<w:numFmt w:val="decimal"/>',
        `<w:pStyle w:val="${safeStyleId}"/>`,
        '<w:suff w:val="space"/>',
        `<w:lvlText w:val="${lvlText}"/>`,
        '<w:lvlJc w:val="left"/>',
        '<w:pPr><w:ind w:left="0" w:hanging="0"/></w:pPr>',
        '</w:lvl>'
    ].join('');
}

function addHeadingNumberingDefinition(numberingXml, headingStyleIds) {
    if (!numberingXml || !numberingXml.includes('</w:numbering>')) return { xml: numberingXml, numId: null };

    const abstractNumId = nextWordNumberingId(numberingXml, 'abstractNumId');
    const numId = nextWordNumberingId(numberingXml, 'numId');
    const levelsXml = headingStyleIds
        .map((styleId, level) => buildHeadingNumberingLevel(level, styleId))
        .join('');

    const definition = [
        `<w:abstractNum w:abstractNumId="${abstractNumId}">`,
        '<w:nsid w:val="6B9E4A21"/>',
        '<w:multiLevelType w:val="multilevel"/>',
        '<w:tmpl w:val="6B9E4A21"/>',
        levelsXml,
        '</w:abstractNum>',
        `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractNumId}"/></w:num>`
    ].join('');

    return {
        xml: numberingXml.replace('</w:numbering>', `${definition}</w:numbering>`),
        numId
    };
}

function buildNumPr(level, numId) {
    return `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`;
}

function setHeadingStyleNumbering(stylesXml, headingStyleIds, numId) {
    let xml = stylesXml;

    headingStyleIds.forEach((styleId, level) => {
        const escapedStyleId = styleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const styleRegex = new RegExp(`<w:style\\b(?=[^>]*w:styleId="${escapedStyleId}")[^>]*>[\\s\\S]*?<\\/w:style>`);
        xml = xml.replace(styleRegex, (styleBlock) => {
            const numPr = buildNumPr(level, numId);
            const outline = `<w:outlineLvl w:val="${level}"/>`;
            if (/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/.test(styleBlock)) {
                return styleBlock.replace(/<w:pPr\b([^>]*)>([\s\S]*?)<\/w:pPr>/, (_match, attrs, inner) => {
                    const cleaned = inner
                        .replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, '')
                        .replace(/<w:outlineLvl\b[^>]*\/>/g, '');
                    return `<w:pPr${attrs}>${cleaned}${numPr}${outline}</w:pPr>`;
                });
            }
            return styleBlock.replace(/(<w:name\b[^>]*\/>)/, `$1<w:pPr>${numPr}${outline}</w:pPr>`);
        });
    });

    return xml;
}

function clearHeadingParagraphNumberingOverrides(documentXml, headingStyleIds) {
    const headingStyles = new Set(headingStyleIds);
    return documentXml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) => {
        const styleId = paragraphXml.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/)?.[1];
        if (!headingStyles.has(styleId)) return paragraphXml;

        if (/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/.test(paragraphXml)) {
            return paragraphXml.replace(/<w:pPr\b([^>]*)>([\s\S]*?)<\/w:pPr>/, (_match, attrs, inner) => {
                const cleaned = inner.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, '');
                return `<w:pPr${attrs}>${cleaned}</w:pPr>`;
            });
        }
        return paragraphXml;
    });
}

function setUpdateFieldsOnOpen(settingsXml) {
    if (!settingsXml || !settingsXml.includes('</w:settings>')) return settingsXml;
    if (/<w:updateFields\b/.test(settingsXml)) {
        return settingsXml.replace(/<w:updateFields\b[^>]*\/>/, '<w:updateFields w:val="true"/>');
    }
    return settingsXml.replace('</w:settings>', '<w:updateFields w:val="true"/></w:settings>');
}

async function applyAutoHeadingNumbering(docxBuffer) {
    const zip = await JSZip.loadAsync(docxBuffer);
    const documentFile = zip.file('word/document.xml');
    const stylesFile = zip.file('word/styles.xml');
    const numberingFile = zip.file('word/numbering.xml');

    if (!documentFile || !stylesFile || !numberingFile) return docxBuffer;

    let documentXml = await documentFile.async('string');
    let stylesXml = await stylesFile.async('string');
    let numberingXml = await numberingFile.async('string');
    const headingStyleIds = detectHeadingStyleIds(stylesXml);
    const { xml: patchedNumberingXml, numId } = addHeadingNumberingDefinition(numberingXml, headingStyleIds);

    if (!numId) return docxBuffer;

    numberingXml = patchedNumberingXml;
    stylesXml = setHeadingStyleNumbering(stylesXml, headingStyleIds, numId);
    // 标题编号只由 Heading 样式控制。段落级 numPr 会把标题锁死在某个
    // numId 上，用户后来插入一级标题或调整章节时，子标题就无法跟随更新。
    documentXml = clearHeadingParagraphNumberingOverrides(documentXml, headingStyleIds);

    zip.file('word/numbering.xml', numberingXml);
    zip.file('word/styles.xml', stylesXml);
    zip.file('word/document.xml', documentXml);

    const settingsFile = zip.file('word/settings.xml');
    if (settingsFile) {
        zip.file('word/settings.xml', setUpdateFieldsOnOpen(await settingsFile.async('string')));
    }

    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ═══════════════════════ 中间件 ═══════════════════════

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition', 'X-Office-Summary', 'X-Office-Format', 'X-Office-Stats']
}));
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

// 挂载认证路由
app.use('/api/auth', authRouter);

// 服务前端静态文件
if (process.env.NODE_ENV === 'production') {
    // 生产环境：只服务构建后的 dist 目录
    const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
    if (fs.existsSync(clientBuildPath)) {
        app.use(express.static(clientBuildPath));
    }
} else {
    // 开发环境：服务 client 根目录（配合 Vite 开发服务器）
    const clientRootPath = path.join(__dirname, '..', 'client');
    app.use(express.static(clientRootPath));
}

// 文件上传配置
const uploadDir = process.env.UPLOAD_TMP_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
            const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname || '')}`;
            cb(null, safeName);
        }
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (req, file, cb) => {
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ext = path.extname(file.originalname).toLowerCase();
        const allowedExts = ['.docx', '.doc', '.txt', '.md', '.xlsx', '.xlsm', '.xls', '.csv'];
        if (allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`不支持的文件格式: ${ext}，请上传 .docx, .txt, .md, .xlsx, .xlsm 或 .csv 文件`));
        }
    }
});

const codeSourceUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
            const safeName = `code-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname || '')}`;
            cb(null, safeName);
        }
    }),
    limits: {
        fileSize: Math.min(MAX_UPLOAD_BYTES, 80 * 1024 * 1024),
        files: MAX_SCREENSHOTS + 1
    },
    fileFilter: (req, file, cb) => {
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ext = path.extname(file.originalname).toLowerCase();
        const sourceExts = ['.zip', '.html', '.htm'];
        const imageExts = ['.png', '.jpg', '.jpeg', '.webp'];
        const allowed = file.fieldname === 'source'
            ? sourceExts.includes(ext)
            : file.fieldname === 'screenshots' && imageExts.includes(ext);
        if (allowed) {
            cb(null, true);
        } else {
            cb(new Error(
                file.fieldname === 'source'
                    ? `不支持的代码源格式: ${ext}，请上传 .zip、.html 或 .htm`
                    : `不支持的截图格式: ${ext}，请上传 .png、.jpg、.jpeg 或 .webp`
            ));
        }
    }
});

// Multer错误处理中间件
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: `文件大小超过限制（最大${MAX_UPLOAD_MB}MB）` });
        }
        return res.status(400).json({ error: `上传错误: ${err.message}` });
    } else if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
};

// 当前选择的模型
const configuredDefaultModel = process.env.DEFAULT_MODEL || DEFAULT_MODEL_ALIAS;
let currentModel = MODEL_MAP[configuredDefaultModel] || configuredDefaultModel;

// ═══════════════════════ 工具函数 ═══════════════════════

/**
 * 获取用户配置的模型名称
 */
function getModelName(userConfig) {
    if (userConfig?.model) {
        return MODEL_MAP[userConfig.model] || userConfig.model;
    }
    return currentModel;
}

registerOfficeDocumentRoutes(app, {
    upload,
    handleMulterError,
    callAIWithRetry,
    getModelName
});

const SENSENOVA_V4_MODEL_ALIASES = new Set([
    'deepseek-v4-flash-free',
    'deepseek-v4-flash',
    'deepseek-v4-flash:free',
    'deepseek/deepseek-v4-flash:free'
]);

function isSenseNovaV4Model(modelName, requestedModel = null) {
    if (requestedModel) {
        return SENSENOVA_V4_MODEL_ALIASES.has(requestedModel);
    }
    return modelName === SENSENOVA_MODEL_NAME || modelName === 'deepseek-v4-flash';
}

function getFunctionExtractionPrompt(modelName, extractionMode, requestedModel = null) {
    if (isSenseNovaV4Model(modelName, requestedModel)) {
        return extractionMode === 'quantity'
            ? SENSENOVA_V4_QUANTITY_PRIORITY_PROMPT
            : SENSENOVA_V4_FUNCTION_EXTRACTION_PROMPT;
    }
    return extractionMode === 'quantity'
        ? COSMIC_QUANTITY_PRIORITY_PROMPT
        : FUNCTION_EXTRACTION_PROMPT;
}

function getCosmicSplitPrompt(modelName, requestedModel = null, options = {}) {
    const useEnhancedExperience = typeof options === 'boolean'
        ? options
        : Boolean(options?.useEnhancedExperience);
    if (useEnhancedExperience) {
        return isSenseNovaV4Model(modelName, requestedModel)
            ? buildSensenovaV4CosmicSplitPrompt(true, true)
            : buildCosmicSplitPrompt(true, true);
    }
    return isSenseNovaV4Model(modelName, requestedModel)
        ? SENSENOVA_V4_COSMIC_SPLIT_PROMPT
        : COSMIC_SPLIT_PROMPT;
}

function getCosmicMoveRequirements(functionName, useEnhancedExperience = false) {
    const standard = {
        template: '标准业务处理',
        requireR: true,
        requireW: true,
        requireX: true,
        allowR: true,
        allowW: true,
        allowX: true
    };
    if (!useEnhancedExperience) return standard;

    const name = String(functionName || '').replace(/\s+/g, '');
    const hasQueryIntent = /(查询|查看|检索|搜索|浏览|列表|详情)/.test(name);
    const hasMutationIntent = /(新增|创建|新建|添加|修改|编辑|删除|移除|导入|导出|保存|提交|审批|审核|受理|派发|派单|同步|汇总|统计|生成|推送|发送|更新|配置|维护|处理|闭环|流转|执行|下载|上传)/.test(name);

    if (/(导出|下载.*报表|下载.*Excel|下载.*文件)/.test(name)) {
        return { template: '导出类 E-R-X', requireR: true, requireW: false, requireX: true, allowR: true, allowW: true, allowX: true };
    }
    if (/(导入|上传)/.test(name)) {
        return { template: '导入类 E-R-W-X', requireR: true, requireW: true, requireX: true, allowR: true, allowW: true, allowX: true };
    }
    if (hasQueryIntent && !hasMutationIntent) {
        return { template: '查询/查看类 E-R-X', requireR: true, requireW: false, requireX: true, allowR: true, allowW: false, allowX: true };
    }
    if (/(新增|创建|新建|添加|删除|移除|注销|作废)/.test(name) && !/(修改|编辑|更新|导入|导出|审批|审核|受理|派发|派单|流转|闭环|处理|提交|执行|统计|汇总|生成|同步)/.test(name)) {
        return { template: '新增/删除类 E-W-X', requireR: false, requireW: true, requireX: true, allowR: false, allowW: true, allowX: true };
    }
    if (/(定时|自动|周期).*(统计|汇总|报表|生成)|(?:统计|汇总).*(定时|自动|周期)/.test(name)) {
        return { template: '定时统计/汇总类 E-R-W', requireR: true, requireW: true, requireX: false, allowR: true, allowW: true, allowX: true };
    }
    if (/(接口|外部系统|第三方).*(查询|查看)|(?:查询|查看).*(接口|外部系统|第三方)/.test(name)) {
        return { template: '外部接口查询类 E-R-X', requireR: true, requireW: false, requireX: true, allowR: true, allowW: false, allowX: true };
    }
    if (/(接口|外部系统|第三方).*(同步|写入|新增|推送|接收)|(?:同步|写入|推送|接收).*(接口|外部系统|第三方)/.test(name)) {
        return { template: '外部接口写入类 E-W-X', requireR: false, requireW: true, requireX: true, allowR: false, allowW: true, allowX: true };
    }

    return standard;
}

function allowsQueryOnlyWithoutWrite(functionName, useEnhancedExperience = false) {
    const requirements = getCosmicMoveRequirements(functionName, useEnhancedExperience);
    return useEnhancedExperience && requirements.requireR && !requirements.requireW && requirements.requireX;
}

function isCosmicProcessIncomplete(functionName, hasR, hasW, hasX, useEnhancedExperience = false) {
    const requirements = getCosmicMoveRequirements(functionName, useEnhancedExperience);
    return (requirements.requireR && !hasR)
        || (requirements.requireW && !hasW)
        || (requirements.requireX && !hasX);
}

function getCosmicRepairPolicy(functionName, useEnhancedExperience = false) {
    const requirements = getCosmicMoveRequirements(functionName, useEnhancedExperience);
    const requiredParts = ['E(1个)'];
    if (requirements.requireR) requiredParts.push('R(至少1个)');
    if (requirements.requireW) requiredParts.push('W(至少1个)');
    if (requirements.requireX) requiredParts.push('X(1个)');

    const avoidParts = [];
    if (!requirements.allowR) avoidParts.push('不要输出R，不要编造读取配置、读取原有数据或读取状态');
    if (!requirements.allowW) avoidParts.push('不要输出W，除非原文明确要求持久化保存');
    if (!requirements.allowX) avoidParts.push('不要默认补X，除非需要向用户或外部系统呈现/通知结果');

    const rule = useEnhancedExperience
        ? `按“${requirements.template}”经验模板输出：必须包含 ${requiredParts.join(' + ')}。${avoidParts.join('；')}`
        : `必须包含 ${requiredParts.join(' + ')}`;

    return {
        requirements,
        minRows: requiredParts.length,
        rule
    };
}

function isCosmicRepairValid(parsed, policy) {
    const hasE = parsed.some(r => r.dmt === 'E');
    const hasR = parsed.some(r => r.dmt === 'R');
    const hasW = parsed.some(r => r.dmt === 'W');
    const hasX = parsed.some(r => r.dmt === 'X');
    const req = policy.requirements;

    return hasE
        && (!req.requireR || hasR)
        && (!req.requireW || hasW)
        && (!req.requireX || hasX)
        && (req.allowR || !hasR)
        && (req.allowW || !hasW)
        && (req.allowX || !hasX);
}

function buildCosmicRepairPrompt(functionName, useEnhancedExperience = false) {
    const policy = getCosmicRepairPolicy(functionName, useEnhancedExperience);
    const example = [
        { dmt: 'E', subProcess: '接收xxx请求', dataGroup: 'xxx请求数据', dataAttributes: '请求ID、操作类型、时间戳、参数' }
    ];
    if (policy.requirements.requireR) {
        example.push({ dmt: 'R', subProcess: '读取xxx数据', dataGroup: 'xxx数据表', dataAttributes: '编号、名称、状态、更新时间' });
    }
    if (policy.requirements.requireW) {
        example.push({ dmt: 'W', subProcess: '保存xxx信息', dataGroup: 'xxx数据表', dataAttributes: '编号、名称、状态、保存时间' });
    }
    if (policy.requirements.requireX) {
        example.push({ dmt: 'X', subProcess: '返回xxx结果', dataGroup: 'xxx处理结果', dataAttributes: '结果码、处理状态、提示信息、响应时间' });
    }

    const prompt = `请对功能过程"${functionName}"进行COSMIC拆分，严格按JSON数组格式输出。

要求：
- ${policy.rule}
- 只输出JSON数组，不要任何其他文字

输出格式示例：
${JSON.stringify(example, null, 2)}

现在请输出"${functionName}"的COSMIC拆分JSON：`;

    return { prompt, policy };
}

function applyEnhancedExperienceTemplatePruning(tableData, useEnhancedExperience = false) {
    if (!useEnhancedExperience || !Array.isArray(tableData)) return tableData;

    const pruned = [];
    let currentProc = '';
    let removedCount = 0;

    for (const row of tableData) {
        if (row.dataMovementType === 'E' && row.functionalProcess) {
            currentProc = row.functionalProcess;
        }
        const requirements = getCosmicMoveRequirements(currentProc, true);
        const shouldRemove = (row.dataMovementType === 'R' && !requirements.allowR)
            || (row.dataMovementType === 'W' && !requirements.allowW)
            || (row.dataMovementType === 'X' && !requirements.allowX);

        if (shouldRemove) {
            removedCount++;
            continue;
        }
        pruned.push(row);
    }

    if (removedCount > 0) {
        console.log(`🧭 COSMIC经验增强版: 按模板移除 ${removedCount} 条非必要数据移动`);
    }
    return pruned;
}

function getCosmicCompletenessRule(useEnhancedExperience = false) {
    if (!useEnhancedExperience) {
        return '每个功能过程必须有完整的 E + R(≥1) + W(≥1) + X 子过程。';
    }
    return '增强版开启：先按功能过程名称匹配经验模板，不要默认补齐E+R+W+X。查询/查看/列表/详情使用E+R+X且禁止强补W；新增/创建/删除使用E+W+X且禁止编造读取配置/原有数据作为R；修改/导入/流程使用E+R+W+X；导出使用E+R+X，只有明确服务端保存导出文件才补W；定时统计/汇总使用E+R+W，只有需要呈现或通知结果才补X。';
}

function dedupeFunctionsByName(functions = []) {
    const seen = new Set();
    const deduped = [];
    for (const func of functions) {
        const key = canonicalFunctionNameKey(func.functionName || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(func);
    }
    return deduped;
}

function cleanBusinessContextName(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/^\s*\d+(?:\.\d+)*[.、\s]*/, '')
        .replace(/[（(]\s*\d+\s*[）)]\s*$/, '')
        .replace(/(?:定义|状态|配置)?管理$/, '')
        .trim();
}

function buildBusinessObjectQualifiers(chapterName, moduleStructure) {
    const genericObjects = [
        '标签', '版本', '任务', '记录', '规则', '模型', '报表', '日志',
        '文件', '接口', '告警', '预警', '工单', '角色', '权限', '指标',
        '资产', '目录', '申请', '流程'
    ];
    const relevantModules = getRelevantModulesForChapter(moduleStructure?.modules || [], chapterName);
    const contexts = [
        chapterName,
        ...relevantModules.flatMap(mod => [mod.level3, mod.level2, mod.level1])
    ]
        .map(cleanBusinessContextName)
        .filter(Boolean);
    const qualifiers = new Map();

    for (const context of contexts) {
        for (const genericObject of genericObjects) {
            if (qualifiers.has(genericObject)) continue;
            const objectIndex = context.indexOf(genericObject);
            if (objectIndex <= 0) continue;
            const prefix = context.slice(0, objectIndex).trim();
            if (prefix.length < 2 || prefix.length > 10) continue;
            if (/创建|新增|编辑|修改|删除|查询|查看|启用|停用|导入|导出|同步|生成|执行/.test(prefix)) continue;
            qualifiers.set(genericObject, `${prefix}${genericObject}`);
        }
    }
    return qualifiers;
}

function qualifyFunctionNames(functions = [], chapterName = '', moduleStructure = null) {
    const qualifiers = buildBusinessObjectQualifiers(chapterName, moduleStructure);
    if (qualifiers.size === 0) return functions;

    return functions.map(func => {
        const originalName = String(func.functionName || '').trim();
        let qualifiedName = originalName;
        for (const [genericObject, fullObject] of qualifiers) {
            if (qualifiedName.includes(fullObject) || !qualifiedName.includes(genericObject)) continue;
            qualifiedName = qualifiedName.replace(genericObject, fullObject);
            break;
        }
        return qualifiedName === originalName ? func : { ...func, functionName: qualifiedName };
    });
}

/**
 * 清理文本（去除不可见字符）
 */
function sanitizeText(text) {
    if (!text) return '';
    return text
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\r\n/g, '\n')
        .trim();
}

/**
 * 名称归一化（去掉章节标记、序号、多余空格）
 */
function normalizeProcessName(name) {
    if (!name) return '';
    return name
        .replace(/\[.*?\]\s*/g, '')     // 去掉 [章节名]
        .replace(/^[\d]+[.、\s]+/, '')   // 去掉序号
        .replace(/\s+/g, '')            // 去掉空格
        .toLowerCase()
        .trim();
}

function cleanProcessDisplayName(name) {
    return sanitizeText(name)
        .replace(/\[.*?\]\s*/g, '')
        .replace(/^[\d]+[.、\s]+/, '')
        .trim();
}

function compactUniqueItems(items, maxItems = 3) {
    const seen = new Set();
    const result = [];
    for (const item of items || []) {
        const text = sanitizeText(item)
            .replace(/[。；;，,、]+$/g, '')
            .trim();
        if (!text || text === '待补充') continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
        if (result.length >= maxItems) break;
    }
    return result;
}

function normalizeFunctionDescription(text, processName = '') {
    const cleanProcess = cleanProcessDisplayName(processName);
    let desc = sanitizeText(text)
        .replace(/^\|+|\|+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!desc) return '';
    if (cleanProcess) {
        const escapedProcess = cleanProcess.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        desc = desc.replace(new RegExp(`^${escapedProcess}\\s*[-—–：:]\\s*`), '').trim();
    }
    desc = desc.replace(/[。；;]+$/g, '');
    return `${desc}。`;
}

function isUsefulFunctionDescription(text) {
    const desc = sanitizeText(text);
    if (desc.length < 35) return false;
    if (/^(待补充|无|暂无|N\/A)$/i.test(desc)) return false;
    const hasProcessWords = /(该功能|用户|系统|定时|接口|触发|读取|保存|返回|展示|生成|查询|配置|支持|允许)/.test(desc);
    const looksLikeOnlyList = desc.split(/[、,，]/).length >= 6 && !/[。；;]/.test(desc);
    return hasProcessWords && !looksLikeOnlyList;
}

function buildFunctionDescription(processName, rows = [], seedDescription = '', functionalUser = '', triggerEvent = '') {
    const cleanProcess = cleanProcessDisplayName(processName) || '该功能过程';
    const seed = normalizeFunctionDescription(seedDescription, cleanProcess);
    if (isUsefulFunctionDescription(seed)) return seed;

    const eRows = rows.filter(r => r.dataMovementType === 'E');
    const rRows = rows.filter(r => r.dataMovementType === 'R');
    const wRows = rows.filter(r => r.dataMovementType === 'W');
    const xRows = rows.filter(r => r.dataMovementType === 'X');

    const describeRows = (moveRows, fallback) => {
        const items = compactUniqueItems(
            moveRows.map(row => row.subProcessDesc || row.dataGroup),
            Math.max(1, moveRows.length)
        );
        return items.length ? items.join('，并') : fallback;
    };
    const appendKeyDetails = (text, moveRows) => {
        const details = compactUniqueItems(
            moveRows.map(row => row.dataAttributes),
            Math.min(2, Math.max(1, moveRows.length))
        );
        return details.length ? `${text}，涉及${details.join('；')}` : text;
    };

    const cleanTrigger = sanitizeText(triggerEvent).replace(/[。；;]+$/g, '');
    let triggerSentence = cleanTrigger || `用户发起${cleanProcess}`;
    if (!cleanTrigger && (triggerEvent || '').includes('时钟')) {
        triggerSentence = `定时任务按预设规则触发${cleanProcess}`;
    } else if (!cleanTrigger && (functionalUser || '').includes('定时触发器')) {
        triggerSentence = `定时触发器自动发起${cleanProcess}`;
    } else if (!cleanTrigger && (triggerEvent || '').includes('接口')) {
        triggerSentence = `外部系统通过接口触发${cleanProcess}`;
    }

    const systemClauses = [];
    if (eRows.length) {
        systemClauses.push(`系统${describeRows(eRows, `接收${cleanProcess}请求`)}`);
    }
    if (rRows.length) {
        systemClauses.push(`${systemClauses.length ? '随后' : '系统'}${appendKeyDetails(describeRows(rRows, '读取相关业务数据'), rRows)}`);
    }
    if (wRows.length) {
        systemClauses.push(`${systemClauses.length ? '同时' : '系统'}${describeRows(wRows, '保存处理记录或操作日志')}`);
    }
    if (xRows.length) {
        systemClauses.push(`${systemClauses.length ? '并' : '系统'}${appendKeyDetails(describeRows(xRows, `返回${cleanProcess}结果`), xRows)}`);
    }

    return `${triggerSentence}。${systemClauses.join('，')}。`;
}

function ensureFunctionDescriptions(tableData, refFunctions = []) {
    if (!Array.isArray(tableData) || tableData.length === 0) return tableData || [];

    const refMap = new Map();
    for (const func of refFunctions || []) {
        const key = normalizeProcessName(func.functionName || func.functionalProcess || '');
        if (key) refMap.set(key, func);
    }

    const groups = [];
    let currentGroup = null;
    for (const row of tableData) {
        if (row.dataMovementType === 'E' && row.functionalProcess) {
            if (currentGroup) groups.push(currentGroup);
            currentGroup = {
                processName: row.functionalProcess,
                rows: [row],
                eRow: row
            };
        } else if (currentGroup) {
            currentGroup.rows.push(row);
        }
    }
    if (currentGroup) groups.push(currentGroup);

    for (const group of groups) {
        const key = normalizeProcessName(group.processName);
        const ref = refMap.get(key) || {};
        const existing = group.eRow.functionDescription || group.eRow.functionalDescription || '';
        const seed = isUsefulFunctionDescription(existing) ? existing : (ref.description || '');
        group.eRow.functionDescription = buildFunctionDescription(
            group.processName,
            group.rows,
            seed,
            group.eRow.functionalUser || ref.functionalUser || '',
            group.eRow.triggerEvent || ref.triggerEvent || ''
        );
        for (const row of group.rows.slice(1)) {
            row.functionDescription = '';
        }
    }

    return tableData;
}

function orderSequenceDiagrams(sequenceDiagrams, tableData) {
    if (!Array.isArray(sequenceDiagrams) || sequenceDiagrams.length <= 1) return sequenceDiagrams;
    const processOrder = new Map();
    for (const row of tableData) {
        if (row.dataMovementType === 'E' && row.functionalProcess) {
            const key = normalizeProcessName(row.functionalProcess);
            if (key && !processOrder.has(key)) processOrder.set(key, processOrder.size);
        }
    }
    const maxRank = Number.MAX_SAFE_INTEGER;
    return [...sequenceDiagrams].sort((a, b) => {
        const ar = processOrder.get(normalizeProcessName(a.processName)) ?? maxRank;
        const br = processOrder.get(normalizeProcessName(b.processName)) ?? maxRank;
        if (ar !== br) return ar - br;
        return sequenceDiagrams.indexOf(a) - sequenceDiagrams.indexOf(b);
    });
}

function normalizeCosmicDmt(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (/COSMIC规定|四种数据移动|四选一|必填|输入.*输出.*读.*写|E.*R.*W.*X/.test(s)) return null;
    const up = s.toUpperCase();
    if (up === 'E' || up === 'ENTRY' || s === '输入' || s === '入' || s === '进入') return 'E';
    if (up === 'R' || up === 'READ' || s === '读' || s === '读取') return 'R';
    if (up === 'W' || up === 'WRITE' || s === '写' || s === '写入' || s === '保存') return 'W';
    if (up === 'X' || up === 'EXIT' || s === '输出' || s === '退出' || s === '出') return 'X';

    const withoutParen = up.replace(/[（(].*?[)）]/g, '').trim();
    if (['E', 'R', 'W', 'X'].includes(withoutParen)) return withoutParen;

    const dashMatch = up.match(/^([ERWX])\s*[-—–]\s*/);
    if (dashMatch) return dashMatch[1];

    const numPrefixMatch = up.match(/^\d+\s*[-—–.、]\s*([ERWX])$/);
    if (numPrefixMatch) return numPrefixMatch[1];

    const embeddedMatch = up.match(/\b([ERWX])\b/);
    if (embeddedMatch && /数据移动|移动类型|输入|读取|写入|输出|ENTRY|READ|WRITE|EXIT/i.test(s)) {
        return embeddedMatch[1];
    }
    return null;
}

function isCosmicExcelInstructionRow(values) {
    const text = values.filter(Boolean).join('\n');
    return /来源于需求文档|必填|选填|COSMIC规定|四种数据移动|四选一|功能处理可能只有一个触发输入|填写说明|人工填写/.test(text);
}

function excelCellValueToText(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value.map(excelCellValueToText).filter(Boolean).join(' ');
    }
    if (typeof value === 'object') {
        if (value.richText) {
            return value.richText.map(part => part.text || '').join('');
        }
        if (value.text) return String(value.text);
        if (value.result !== undefined) return excelCellValueToText(value.result);
        if (value.hyperlink) return String(value.text || value.hyperlink || '');
        if (value.error) return String(value.error);
    }
    return '';
}

function getExcelCellText(cell) {
    return sanitizeText(excelCellValueToText(cell?.value));
}

async function loadExcelWorkbook(filePath) {
    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.readFile(filePath);
        return workbook;
    } catch (initialError) {
        // 部分标准 OOXML/第三方导出的工作簿会显式使用 x:workbook、
        // x:worksheet 等 SpreadsheetML 前缀。ExcelJS 4.x 的模型解析器
        // 无法识别这些合法前缀。仅在首次读取失败时于内存副本中去掉 x:
        // 标签前缀，再交给 ExcelJS；用户上传的原文件不会被改写。
        const source = await fs.promises.readFile(filePath);
        const zip = await JSZip.loadAsync(source);
        const xmlPaths = Object.keys(zip.files).filter(name => (
            (
                /^xl\/.*\.xml$/i.test(name)
                || /^xl\/worksheets\/_rels\/.*\.rels$/i.test(name)
            )
            && !zip.files[name].dir
        ));
        let normalizedCount = 0;
        await Promise.all(xmlPaths.map(async (name) => {
            const file = zip.file(name);
            if (!file) return;
            let xml = await file.async('string');
            let changed = false;
            if (/<\/?x:/.test(xml)) {
                xml = xml.replace(/(<\/?)x:/g, '$1');
                changed = true;
            }
            if (/^xl\/worksheets\/_rels\/.*\.rels$/i.test(name)) {
                const cleaned = xml.replace(
                    /<Relationship\b(?=[^>]*\bType="[^"]*\/(?:comments|vmlDrawing)")[^>]*\/>/gi,
                    ''
                );
                changed ||= cleaned !== xml;
                xml = cleaned;
            }
            if (!changed) return;
            zip.file(name, xml);
            normalizedCount++;
        }));
        if (normalizedCount === 0) throw initialError;

        const normalizedBuffer = await zip.generateAsync({
            type: 'nodebuffer',
            compression: 'DEFLATE'
        });
        const compatibleWorkbook = new ExcelJS.Workbook();
        await compatibleWorkbook.xlsx.load(normalizedBuffer);
        console.log(`📗 Excel兼容读取：已规范化 ${normalizedCount} 个带 x: 前缀的 OOXML 部件`);
        return compatibleWorkbook;
    }
}

function normalizeExcelHeader(value) {
    return String(value || '')
        .replace(/\s+/g, '')
        .replace(/[：:]/g, '')
        .trim();
}

function buildCosmicExcelColumnMap(headers) {
    const normalized = headers.map(normalizeExcelHeader);
    const findCol = (...predicates) => {
        const index = normalized.findIndex(header => header && predicates.some(predicate => predicate(header)));
        return index >= 0 ? index + 1 : 0;
    };

    return {
        level1: findCol(h => h.includes('一级标题') || h.includes('一级模块') || h.includes('一级业务功能')),
        level2: findCol(h => h.includes('二级标题') || h.includes('二级模块') || h.includes('二级业务功能')),
        level3: findCol(h => h.includes('三级标题') || h.includes('三级模块') || h.includes('三级业务功能')),
        level4: findCol(h => h.includes('四级标题') || h.includes('四级模块') || h.includes('四级业务功能')),
        functionalUser: findCol(h => h === '功能用户' || (h.includes('功能用户') && !h.includes('需求'))),
        triggerEvent: findCol(h => h.includes('触发事件')),
        functionalProcess: findCol(h => h === '功能过程' || (h.includes('功能过程') && !h.includes('描述'))),
        subProcessDesc: findCol(h => h.includes('子过程描述') || h.includes('子处理')),
        dataMovementType: findCol(h => h.includes('数据移动类型') || h === '数据移动' || h === '类型' || h.includes('移动类型')),
        dataGroup: findCol(h => h.includes('数据组')),
        dataAttributes: findCol(h => h.includes('数据属性')),
        functionDescription: findCol(h => h === '功能描述' || h.includes('功能过程描述') || (h.includes('功能描述') && !h.includes('用户需求')))
    };
}

function scoreCosmicExcelHeader(headers, columnMap, sheetName = '') {
    if (!columnMap.functionalProcess || !columnMap.dataMovementType) return 0;
    if (!columnMap.subProcessDesc && !columnMap.dataGroup && !columnMap.dataAttributes) return 0;

    let score = 20;
    for (const key of ['functionalUser', 'triggerEvent', 'subProcessDesc', 'dataGroup', 'dataAttributes']) {
        if (columnMap[key]) score += 5;
    }
    for (const key of ['level1', 'level2', 'level3', 'level4', 'functionDescription']) {
        if (columnMap[key]) score += 3;
    }

    const headerText = headers.join('|');
    if (/功能点拆分表|COSMIC拆分结果|COSMIC|拆分/.test(sheetName)) score += 8;
    if (/修订标识|OPEX|CAPEX|CFP评估师核定/.test(headerText)) score += 8;
    return score;
}

function detectCosmicExcelLayout(workbook) {
    let best = null;

    for (const worksheet of workbook.worksheets) {
        const rowLimit = Math.min(30, worksheet.rowCount || 0);
        const colLimit = Math.min(80, Math.max(worksheet.actualColumnCount || 0, worksheet.columnCount || 0, 18));

        for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber++) {
            // 评估模板常把“功能过程/数据移动”等主表头放在第一行，
            // 把“一级模块/二级模块/三级模块/四级模块”放在其下一行。
            // 同时尝试 1~3 行表头窗口，按列合并后再做名称匹配。
            for (let headerRowSpan = 1; headerRowSpan <= 3; headerRowSpan++) {
                const headers = [];
                for (let col = 1; col <= colLimit; col++) {
                    const parts = [];
                    for (
                        let offset = 0;
                        offset < headerRowSpan && rowNumber + offset <= rowLimit;
                        offset++
                    ) {
                        const text = getExcelCellText(worksheet.getRow(rowNumber + offset).getCell(col));
                        if (text && !parts.includes(text)) parts.push(text);
                    }
                    headers.push(parts.join(' '));
                }
                const columnMap = buildCosmicExcelColumnMap(headers);
                const score = scoreCosmicExcelHeader(headers, columnMap, worksheet.name);
                if (score > (best?.score || 0)) {
                    best = {
                        worksheet,
                        headerRowNumber: rowNumber,
                        headerRowSpan,
                        columnMap,
                        headers,
                        score
                    };
                }
            }
        }
    }

    return best && best.score > 0 ? best : null;
}

function getDefaultSubProcessDesc(dmt, processName) {
    const cleanProcess = cleanProcessDisplayName(processName) || '该功能';
    return {
        E: `接收${cleanProcess}请求`,
        R: `读取${cleanProcess}相关数据`,
        W: `保存${cleanProcess}处理结果`,
        X: `返回${cleanProcess}处理结果`
    }[dmt] || `${cleanProcess}数据移动`;
}

function parseCosmicExcelRows(worksheet, headerRowNumber, columnMap) {
    const tableData = [];
    let currentFunctionalUser = '';
    let currentTriggerEvent = '';
    let currentFunctionalProcess = '';
    let currentL1 = '';
    let currentL2 = '';
    let currentL3 = '';
    let currentL4 = '';

    const getByKey = (row, key) => {
        const col = columnMap[key];
        return col ? getExcelCellText(row.getCell(col)) : '';
    };

    for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
        const row = worksheet.getRow(rowNumber);
        const rawValues = [
            getByKey(row, 'level1'),
            getByKey(row, 'level2'),
            getByKey(row, 'level3'),
            getByKey(row, 'level4'),
            getByKey(row, 'functionalUser'),
            getByKey(row, 'triggerEvent'),
            getByKey(row, 'functionalProcess'),
            getByKey(row, 'subProcessDesc'),
            getByKey(row, 'dataMovementType'),
            getByKey(row, 'dataGroup'),
            getByKey(row, 'dataAttributes'),
            getByKey(row, 'functionDescription')
        ];
        if (isCosmicExcelInstructionRow(rawValues)) continue;

        const dmt = normalizeCosmicDmt(getByKey(row, 'dataMovementType'));
        if (!dmt) continue;

        const rawLevel1 = getByKey(row, 'level1');
        const rawLevel2 = getByKey(row, 'level2');
        const rawLevel3 = getByKey(row, 'level3');
        const rawLevel4 = getByKey(row, 'level4');
        const rawFuncUser = getByKey(row, 'functionalUser');
        const rawTrigger = getByKey(row, 'triggerEvent');
        const rawProcess = getByKey(row, 'functionalProcess');

        if (rawLevel1) currentL1 = rawLevel1;
        if (rawLevel2) currentL2 = rawLevel2;
        if (rawLevel3) currentL3 = rawLevel3;
        if (rawLevel4) currentL4 = rawLevel4;
        if (rawFuncUser) currentFunctionalUser = rawFuncUser;
        if (rawTrigger) currentTriggerEvent = rawTrigger;
        if (rawProcess) currentFunctionalProcess = rawProcess;

        if (dmt === 'E' && !currentFunctionalProcess) continue;
        if (dmt !== 'E' && !currentFunctionalProcess) continue;

        let subProcessDesc = getByKey(row, 'subProcessDesc');
        if (!subProcessDesc) {
            subProcessDesc = getDefaultSubProcessDesc(dmt, currentFunctionalProcess);
        }

        tableData.push({
            functionalUser: currentFunctionalUser,
            triggerEvent: currentTriggerEvent,
            functionalProcess: dmt === 'E' ? currentFunctionalProcess : '',
            subProcessDesc,
            dataMovementType: dmt,
            dataGroup: getByKey(row, 'dataGroup') || '待补充',
            dataAttributes: getByKey(row, 'dataAttributes') || '待补充',
            functionDescription: dmt === 'E' ? getByKey(row, 'functionDescription') : '',
            level1: currentL1,
            level2: currentL2,
            level3: currentL3,
            level4: currentL4
        });
    }

    return tableData;
}

function buildParsedFunctionsFromTableData(tableData) {
    return tableData
        .filter(row => row.dataMovementType === 'E' && row.functionalProcess)
        .map((row, index) => ({
            id: `imported_${index + 1}`,
            triggerEvent: row.triggerEvent || '',
            functionalUser: row.functionalUser || '',
            functionName: row.functionalProcess || '',
            description: row.functionDescription || '',
            selected: true,
            sourceChapter: row.level4 || row.level3 || row.level2 || row.level1 || '',
            level1: row.level1 || '',
            level2: row.level2 || '',
            level3: row.level3 || '',
            level4: row.level4 || ''
        }));
}

function buildFunctionListTextFromTableData(tableData) {
    return buildParsedFunctionsFromTableData(tableData)
        .map(func => [
            `## 触发事件：${func.triggerEvent || '用户触发'}`,
            `## 功能用户：${func.functionalUser || '发起者：用户 接收者：用户'}`,
            `## 功能过程：${func.functionName}`,
            `## 功能过程描述：${func.description || `${func.functionName}功能过程`}`
        ].join('\n'))
        .join('\n\n');
}

function buildModuleStructureFromTableData(tableData) {
    const modules = [];
    const seen = new Set();
    for (const row of tableData) {
        if (row.dataMovementType !== 'E') continue;
        const level1 = row.level1 || '';
        const level2 = row.level2 || '';
        const level3 = row.level3 || '';
        const level4 = row.level4 || '';
        if (!level1 && !level2 && !level3 && !level4) continue;
        const key = [level1, level2, level3, level4].join('\u0001');
        if (seen.has(key)) continue;
        seen.add(key);
        modules.push({
            level1,
            level2,
            level3,
            level4,
            businessObjects: [],
            triggerTypes: row.triggerEvent ? [row.triggerEvent] : [],
            estimatedFunctions: tableData.filter(r => (
                r.dataMovementType === 'E'
                && (r.level1 || '') === level1
                && (r.level2 || '') === level2
                && (r.level3 || '') === level3
                && (r.level4 || '') === level4
            )).length || 1
        });
    }
    return modules.length > 0 ? { modules, totalEstimated: modules.reduce((sum, m) => sum + m.estimatedFunctions, 0) } : null;
}

function getCosmicExcelFormatName(layout) {
    const headerText = (layout?.headers || []).join('|');
    if (/修订标识|OPEX|CAPEX|CFP评估师核定/.test(headerText) || /功能点拆分表/.test(layout?.worksheet?.name || '')) {
        return 'COSMIC评估模板';
    }
    return '标准COSMIC拆分结果';
}

function parseJsonBodyField(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function buildFunctionGroupsFromTableData(tableData = []) {
    const groups = [];
    let currentGroup = null;
    let currentFuncUser = '';
    let currentTrigger = '';
    let currentL1 = '';
    let currentL2 = '';
    let currentL3 = '';
    let currentL4 = '';

    for (const row of tableData || []) {
        if (row.level1) currentL1 = row.level1;
        if (row.level2) currentL2 = row.level2;
        if (row.level3) currentL3 = row.level3;
        if (row.level4) currentL4 = row.level4;

        if (row.dataMovementType === 'E' && row.functionalProcess) {
            if (row.functionalUser) currentFuncUser = row.functionalUser;
            if (row.triggerEvent) currentTrigger = row.triggerEvent;
            currentGroup = {
                functionalProcess: row.functionalProcess,
                functionalUser: currentFuncUser,
                triggerEvent: currentTrigger,
                functionDescription: row.functionDescription || '',
                level1: row.level1 || currentL1 || '',
                level2: row.level2 || currentL2 || '',
                level3: row.level3 || currentL3 || '',
                level4: row.level4 || currentL4 || '',
                rows: [row],
                eRow: row
            };
            groups.push(currentGroup);
        } else if (currentGroup) {
            currentGroup.rows.push(row);
        }
    }
    return groups;
}

function parseAiDescriptionJson(content) {
    const text = String(content || '').trim();
    if (!text) return [];

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const source = fenced ? fenced[1].trim() : text;
    const candidates = [
        source,
        source.match(/\[[\s\S]*\]/)?.[0],
        source.match(/\{[\s\S]*\}/)?.[0]
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed)) return parsed;
            if (Array.isArray(parsed.descriptions)) return parsed.descriptions;
            if (Array.isArray(parsed.items)) return parsed.items;
        } catch {
            // Try the next candidate.
        }
    }
    return [];
}

async function generateFunctionDescriptionsWithAI(tableData, userConfig = null, options = {}) {
    const groups = buildFunctionGroupsFromTableData(tableData);
    if (groups.length === 0) {
        return { tableData: tableData || [], generatedCount: 0, fallbackCount: 0, usedAI: false, error: null };
    }

    const forceRegenerate = Boolean(options.forceRegenerate);
    const targetGroups = groups.filter(group => (
        forceRegenerate || !isUsefulFunctionDescription(group.eRow.functionDescription || group.eRow.functionalDescription || '')
    ));
    if (targetGroups.length === 0) {
        return { tableData, generatedCount: 0, fallbackCount: 0, usedAI: false, error: null };
    }

    const modelName = getModelName(userConfig);
    const descriptions = new Map();
    const configuredBatchSize = Number.parseInt(process.env.DESCRIPTION_AI_BATCH_SIZE || '', 10);
    const batchSize = Number.isFinite(configuredBatchSize)
        ? Math.max(5, Math.min(25, configuredBatchSize))
        : 20;
    const disableAI = Boolean(options.disableAI) || process.env.NODE_ENV === 'test';
    let aiError = null;

    const systemPrompt = `你是资深软件需求分析师，负责把COSMIC功能点拆分结果改写为业务需求说明书中的“功能描述”。
要求：
1. 只输出JSON数组，不要Markdown，不要解释。
2. 每项包含 processName 和 functionDescription 两个字段。
3. functionDescription 用一个完整的中文自然段，100~220字，面向需求文档读者，按业务发生顺序概括该功能过程的全部子过程：谁在什么场景触发、系统接收什么参数、读取哪些数据、是否写入日志或业务数据、最后输出或呈现什么结果。
4. 必须覆盖 dataMoves 中每条非重复的 subProcess 所表达的业务动作，并可结合 dataGroup、dataAttributes 把指标、字段和输出形式概括清楚；不要机械罗列字段。
5. 不要在段首重复功能过程名称或添加“功能描述：”前缀；不要改变功能过程名称；不要编造与输入步骤无关的业务能力。
写作示例：用户通过设置统计日期、城市、站型等筛选条件触发查询。系统接收参数后读取符合条件的基站价值统计指标，包括各类基站数量、等效用户数、日业务量及价值分类，同时记录操作日志，并将指标卡片、饼图、趋势图和TOP基站榜单等可视化内容渲染至首页，为用户呈现基站运营态势总览。`;

    for (let start = 0; !disableAI && start < targetGroups.length; start += batchSize) {
        const batch = targetGroups.slice(start, start + batchSize);
        const payload = batch.map(group => ({
            processName: group.functionalProcess,
            module: {
                level1: group.level1 || '',
                level2: group.level2 || '',
                level3: group.level3 || '',
                level4: group.level4 || ''
            },
            functionalUser: group.functionalUser || '',
            triggerEvent: group.triggerEvent || '',
            dataMoves: group.rows.map(row => ({
                type: row.dataMovementType || '',
                subProcess: row.subProcessDesc || '',
                dataGroup: row.dataGroup || '',
                dataAttributes: row.dataAttributes || ''
            }))
        }));

        try {
            console.log(`🧠 AI补充功能描述: ${start + 1}-${start + batch.length}/${targetGroups.length}`);
            const completion = await callAIWithRetry({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `请为以下COSMIC功能过程生成需求说明书里的功能描述：\n${JSON.stringify(payload, null, 2)}` }
                ],
                model: modelName,
                temperature: 0.25,
                max_tokens: Math.min(12000, 1200 + batch.length * 650)
            });
            const reply = completion?.choices?.[0]?.message?.content || '';
            const parsed = parseAiDescriptionJson(reply);
            for (const item of parsed) {
                const processName = item.processName || item.functionalProcess || item.name || '';
                const description = normalizeFunctionDescription(item.functionDescription || item.description || '', processName);
                if (processName && isUsefulFunctionDescription(description)) {
                    descriptions.set(normalizeProcessName(processName), description);
                }
            }
        } catch (error) {
            aiError = error;
            console.warn(`⚠️ AI补充功能描述失败，回退本地规则: ${error.message}`);
            break;
        }
    }

    let generatedCount = 0;
    let fallbackCount = 0;
    for (const group of targetGroups) {
        const key = normalizeProcessName(group.functionalProcess);
        const aiDescription = descriptions.get(key);
        const description = aiDescription || buildFunctionDescription(
            group.functionalProcess,
            group.rows,
            '',
            group.functionalUser,
            group.triggerEvent
        );

        if (aiDescription) generatedCount++;
        else fallbackCount++;

        for (const row of group.rows) {
            row.functionDescription = row.dataMovementType === 'E' ? description : '';
        }
    }

    return {
        tableData,
        generatedCount,
        fallbackCount,
        usedAI: generatedCount > 0,
        error: aiError ? aiError.message : null
    };
}

/**
 * 名称对齐：将AI输出的功能过程名映射回阶段1确认的标准名称
 * 解决AI在拆分时微调功能过程名称导致前端误去重、功能过程丢失
 */
function alignProcessNames(tableData, referenceNames) {
    if (!referenceNames || referenceNames.length === 0) return tableData;

    // 构建标准名称的归一化映射: normalized -> original
    const normalizedMap = new Map();
    for (const refName of referenceNames) {
        const key = normalizeProcessName(refName);
        if (key) normalizedMap.set(key, refName);
    }

    let alignCount = 0;
    for (const row of tableData) {
        if (!row.functionalProcess) continue;

        const normalized = normalizeProcessName(row.functionalProcess);

        // 1. 归一化后精确匹配
        if (normalizedMap.has(normalized)) {
            const ref = normalizedMap.get(normalized);
            if (row.functionalProcess !== ref) {
                console.log(`  🔗 对齐: "${row.functionalProcess}" → "${ref}"`);
                row.functionalProcess = ref;
                alignCount++;
            }
            continue;
        }

        // 2. 包含匹配：AI输出包含标准名核心部分，或标准名包含AI输出
        let bestMatch = null;
        let bestScore = 0;
        for (const [refNorm, refOriginal] of normalizedMap.entries()) {
            if (normalized.includes(refNorm) || refNorm.includes(normalized)) {
                const score = Math.min(normalized.length, refNorm.length) / Math.max(normalized.length, refNorm.length);
                // 阈值提高到 0.8：避免相似但不同的功能过程（如"采集基站数据"和"采集小区数据"）被误对齐
                // V3.2 输出名称更精确，低阈值反而会造成误合并 → 触发误判为重复 → 整块 skip
                if (score > bestScore && score > 0.8) {
                    bestScore = score;
                    bestMatch = refOriginal;
                }
            }
        }

        if (bestMatch) {
            console.log(`  🔗 模糊对齐: "${row.functionalProcess}" → "${bestMatch}" (相似度${(bestScore * 100).toFixed(0)}%)`);
            row.functionalProcess = bestMatch;
            alignCount++;
        }
    }

    if (alignCount > 0) {
        console.log(`🔗 名称对齐: 共修正 ${alignCount} 个功能过程名称`);
    }

    return tableData;
}

function alignProcessNamesByOrder(tableData, referenceNames) {
    if (!referenceNames || referenceNames.length === 0) return tableData;

    // V4 安全检查：统计实际E行数量
    const eRows = tableData.filter(r => r.dataMovementType === 'E' && r.functionalProcess);

    // 如果E行数量与参考名数量不匹配（AI跳过了某些功能过程），
    // 回退到模糊匹配，避免顺序错位导致名称全部对齐错误
    if (eRows.length !== referenceNames.length) {
        console.warn(`⚠️ V4顺序对齐: E行数(${eRows.length}) ≠ 参考名数(${referenceNames.length})，回退模糊匹配`);
        return alignProcessNames(tableData, referenceNames);
    }

    let refIndex = 0;
    let alignCount = 0;
    for (const row of tableData) {
        if (row.dataMovementType !== 'E' || !row.functionalProcess) continue;
        if (refIndex >= referenceNames.length) break;
        const refName = referenceNames[refIndex++];
        if (row.functionalProcess !== refName) {
            console.log(`  🔗 V4顺序对齐: "${row.functionalProcess}" → "${refName}"`);
            row.functionalProcess = refName;
            alignCount++;
        }
    }

    if (alignCount > 0) {
        console.log(`🔗 V4顺序名称对齐: 共修正 ${alignCount} 个功能过程名称`);
    }

    return tableData;
}

function limitSubprocessesPerFunction(tableData, maxRows = 5) {
    if (!Array.isArray(tableData) || tableData.length === 0) return tableData || [];

    const groups = [];
    let currentGroup = null;
    for (const row of tableData) {
        if (row.dataMovementType === 'E') {
            currentGroup = { processName: row.functionalProcess || '', rows: [row] };
            groups.push(currentGroup);
        } else if (currentGroup) {
            currentGroup.rows.push(row);
        } else {
            groups.push({ processName: '', rows: [row], orphan: true });
        }
    }

    let trimmedCount = 0;
    const limited = groups.flatMap(group => {
        const rows = group.rows;
        if (group.orphan || rows.length <= maxRows) return rows;

        const keep = new Set([0]); // E
        const lastXIndex = rows.reduce((found, row, index) => (
            row.dataMovementType === 'X' ? index : found
        ), -1);
        if (lastXIndex > 0) keep.add(lastXIndex);

        const availableSlots = Math.max(0, maxRows - keep.size);
        const middleIndexes = rows
            .map((row, index) => ({ row, index }))
            .filter(item => item.index !== 0 && item.index !== lastXIndex);
        const priority = [];
        const firstR = middleIndexes.find(item => item.row.dataMovementType === 'R');
        const firstW = middleIndexes.find(item => item.row.dataMovementType === 'W');
        if (firstR) priority.push(firstR.index);
        if (firstW) priority.push(firstW.index);
        middleIndexes.forEach(item => {
            if (!priority.includes(item.index)) priority.push(item.index);
        });
        priority.slice(0, availableSlots).forEach(index => keep.add(index));

        const keptRows = rows.filter((_, index) => keep.has(index));
        trimmedCount += rows.length - keptRows.length;
        return keptRows;
    });

    if (trimmedCount > 0) {
        console.log(`✂️ 子过程上限保护: 已裁减 ${trimmedCount} 条次要R/W，每个功能过程最多 ${maxRows} 条`);
    }
    return limited;
}

/**
 * 解析Markdown表格
 * @param {string} markdown - AI输出的Markdown内容
 * @param {string[]|null} referenceNames - 阶段1确认的标准功能过程名列表（用于名称对齐）
 */
/**
 * 解析Markdown表格
 * @param {string} markdown - AI输出的Markdown内容
 * @param {string[]|null} referenceNames - 阶段1确认的标准功能过程名列表（用于名称对齐）
 * @param {{ level1?: string, level2?: string, level3?: string }|null} headingContext - 当前章节的层级上下文
 */
function parseMarkdownTable(markdown, referenceNames = null, headingContext = null, functionLevelMap = null, alignMode = 'fuzzy') {
    if (!markdown) return [];

    const tableData = [];
    const lines = markdown.split('\n');
    let inTable = false;
    let headerFound = false;
    let headerColumns = [];
    let currentFunctionalUser = '';
    let currentTriggerEvent = '';
    let currentFunctionalProcess = '';

    // 提取层级信息（来自章节上下文）
    const hLevel1 = headingContext?.level1 || '';
    const hLevel2 = headingContext?.level2 || '';
    const hLevel3 = headingContext?.level3 || '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;

        // 检查是否是表头
        if (trimmed.includes('功能用户') || trimmed.includes('触发事件') || trimmed.includes('功能过程')) {
            headerFound = true;
            inTable = true;
            headerColumns = trimmed
                .split('|')
                .filter((_, i, arr) => i > 0 && i < arr.length - 1)
                .map(c => c.trim());
            continue;
        }

        // 跳过分隔行
        if (/^\|[\s:-]+\|/.test(trimmed)) continue;

        if (!headerFound) continue;

        // 解析数据行
        const cells = trimmed.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(c => c.trim());

        // ─── DMT 规范化函数（兼容 V3.2 多种格式）───
        // 支持：E/R/W/X（标准）、R（读）/W（写）/X（出）（中文括注）
        //        Entry/Read/Write/Exit（英文全称）、输入/读/写/输出（纯中文）
        const normalizeDmt = (raw) => {
            const s = (raw || '').trim();
            if (!s) return null;
            const up = s.toUpperCase();
            if (up === 'E' || up === 'ENTRY' || s === '输入' || s === '入') return 'E';
            if (up === 'R' || up === 'READ'  || s === '读' || s === '读取') return 'R';
            if (up === 'W' || up === 'WRITE' || s === '写' || s === '写入' || s === '保存') return 'W';
            if (up === 'X' || up === 'EXIT'  || s === '输出' || s === '退出' || s === '出') return 'X';
            // 带括注：E（入）、R（读）、W（写）、X（出）、E(Entry) 等
            const withoutParen = up.replace(/[（(].*?[)）]/g, '').trim();
            if (['E','R','W','X'].includes(withoutParen)) return withoutParen;
            // V3.2 有时输出 "E-输入"、"R-读取" 等带连字符格式
            const dashMatch = up.match(/^([ERWX])\s*[-—–]\s*/);
            if (dashMatch) return dashMatch[1];
            // V3.2 有时输出 "1-E"、"2-R" 等带序号格式
            const numPrefixMatch = up.match(/^\d+\s*[-—–.、]\s*([ERWX])$/);
            if (numPrefixMatch) return numPrefixMatch[1];
            return null; // 无法识别
        };

        let funcUser, triggerEvt, funcProcess, subProcessDesc, dataMovementType, dataGroup, dataAttributes, functionDescription;
        let dmt = null;

        // 优先按表头定位列，兼容新增的“功能描述”列以及模型偶发的列顺序变化
        if (headerColumns.length > 0) {
            let normalizedHeaderColumns = headerColumns.map(h => h.replace(/\s+/g, ''));
            let valueCells = cells;
            if (valueCells.length === normalizedHeaderColumns.length + 1 && /^\d+$/.test(valueCells[0])) {
                valueCells = valueCells.slice(1);
            }

            const getByHeader = (predicate) => {
                const idx = normalizedHeaderColumns.findIndex(predicate);
                return idx >= 0 ? valueCells[idx] : '';
            };

            funcUser = getByHeader(h => h.includes('功能用户'));
            triggerEvt = getByHeader(h => h.includes('触发事件'));
            funcProcess = getByHeader(h => h.includes('功能过程') && !h.includes('描述'));
            subProcessDesc = getByHeader(h => h.includes('子过程描述'));
            dataMovementType = getByHeader(h => h.includes('数据移动类型') || h === '类型');
            dataGroup = getByHeader(h => h.includes('数据组'));
            dataAttributes = getByHeader(h => h.includes('数据属性'));
            functionDescription = getByHeader(h => h.includes('功能描述') && !h.includes('子过程'));
            dmt = normalizeDmt(dataMovementType);
        }

        if (!dmt && cells.length >= 8) {
            // V3.2 有时多输出一列序号列在最前面，或新版多输出“功能描述”列
            // 检测第一列是否是纯数字序号
            if (/^\d+$/.test(cells[0])) {
                [, funcUser, triggerEvt, funcProcess, subProcessDesc, dataMovementType, dataGroup, dataAttributes, functionDescription] = cells;
                dmt = normalizeDmt(dataMovementType);
                if (!dmt) {
                    // 序号列 + DMT在最后
                    const lastDmt = normalizeDmt(cells[cells.length - 1]);
                    if (lastDmt) {
                        dmt = lastDmt;
                        subProcessDesc = cells[4];
                        dataGroup     = cells[5];
                        dataAttributes = cells[6];
                    }
                }
            }
            if (!dmt) {
                // 不是序号列开头，按新版8列或旧版7列处理
                [funcUser, triggerEvt, funcProcess, subProcessDesc, dataMovementType, dataGroup, dataAttributes, functionDescription] = cells;
                dmt = normalizeDmt(dataMovementType);
            }
        }

        if (!dmt && cells.length >= 7) {
            // 标准7列格式
            [funcUser, triggerEvt, funcProcess, subProcessDesc, dataMovementType, dataGroup, dataAttributes] = cells;
            dmt = normalizeDmt(dataMovementType);

            // V3.2 有时把列顺序变成：...| subProcessDesc | dataGroup | dataAttributes | DMT |（DMT移到最后）
            if (!dmt && cells.length >= 7) {
                const lastDmt = normalizeDmt(cells[cells.length - 1]);
                if (lastDmt) {
                    // DMT 在最后一列
                    dmt = lastDmt;
                    subProcessDesc = cells[3];
                    dataGroup     = cells[4];
                    dataAttributes = cells[5];
                }
            }
        }

        if (!dmt && cells.length >= 4) {
            // V3.2 的 R/W/X 行有时省略前面的空列，只保留有效列
            // 尝试扫描每个 cell，找出 DMT 所在位置
            for (let ci = 0; ci < cells.length; ci++) {
                const candidate = normalizeDmt(cells[ci]);
                if (candidate) {
                    dmt = candidate;
                    // DMT 前面是子过程描述，后面是数据组、数据属性
                    subProcessDesc  = cells[ci - 1] || '';
                    dataGroup       = cells[ci + 1] || '';
                    dataAttributes  = cells[ci + 2] || '';
                    funcUser        = '';
                    triggerEvt      = '';
                    funcProcess     = '';
                    break;
                }
            }
        }

        if (!dmt) continue; // 无法识别 DMT，跳过

        // 更新当前功能用户、触发事件、功能过程（仅非空时更新，延续上一行的值）
        if (funcUser) currentFunctionalUser = funcUser;
        if (triggerEvt) currentTriggerEvent = triggerEvt;
        if (funcProcess) currentFunctionalProcess = funcProcess;

        // 清理子过程描述
        let cleanSubProcess = sanitizeText(subProcessDesc);
        // V3.2 修复：E 行子过程描述为空时不应跳过整行，给一个默认描述
        if (!cleanSubProcess) {
            if (dmt === 'E' && currentFunctionalProcess) {
                cleanSubProcess = `接收${currentFunctionalProcess}请求`;
                console.log(`  ⚠️ V3.2兼容: E行子过程描述为空，自动补充: "${cleanSubProcess}"`);
            } else {
                continue; // 非E行且无子过程描述，跳过
            }
        }

        tableData.push({
            functionalUser: currentFunctionalUser,
            triggerEvent: currentTriggerEvent,
            functionalProcess: dmt === 'E' ? currentFunctionalProcess : '',
            subProcessDesc: cleanSubProcess,
            dataMovementType: dmt,
            dataGroup: sanitizeText(dataGroup) || '待补充',
            dataAttributes: sanitizeText(dataAttributes) || '待补充',
            functionDescription: dmt === 'E' ? sanitizeText(functionDescription) : '',
            // 章节层级（来自 headingContext）
            level1: hLevel1,
            level2: hLevel2,
            level3: hLevel3
        });
    }

    // 名称对齐：将AI输出的功能过程名映射回阶段1的标准名
    if (referenceNames && referenceNames.length > 0) {
        if (alignMode === 'sequential') {
            alignProcessNamesByOrder(tableData, referenceNames);
        } else {
            alignProcessNames(tableData, referenceNames);
        }
    }

    // V3.2 修复：检测并修复"孤立的 R/W/X 行组"（前面没有 E 行的情况）
    // 当 V3.2 输出的 E 行因格式异常被跳过时，后续 R/W/X 行会失去所属功能过程
    // 策略：如果一组 R→W→X 行的 functionalProcess 为空，但 currentFunctionalUser/triggerEvent 有值，
    //        说明 E 行被跳过了，需要从 referenceNames 中找到下一个未使用的功能过程名补回
    if (referenceNames && referenceNames.length > 0) {
        // 收集已成功解析的功能过程名
        const parsedProcessNames = new Set(tableData.filter(r => r.dataMovementType === 'E' && r.functionalProcess).map(r => r.functionalProcess));
        // 找出 referenceNames 中未被解析到的功能过程
        const missingProcesses = referenceNames.filter(name => !parsedProcessNames.has(name));

        if (missingProcesses.length > 0) {
            console.log(`  ⚠️ V3.2兼容: 检测到 ${missingProcesses.length} 个功能过程的E行可能被跳过: ${missingProcesses.slice(0, 5).join(', ')}${missingProcesses.length > 5 ? '...' : ''}`);

            // 扫描 tableData，找到"第一行就是 R 且前面没有 E"的位置
            let missingIdx = 0;
            for (let i = 0; i < tableData.length && missingIdx < missingProcesses.length; i++) {
                const row = tableData[i];
                // 找到一个 R 行，且它前面不是 E 行（或者它是第一行）
                if (row.dataMovementType === 'R') {
                    const prevRow = i > 0 ? tableData[i - 1] : null;
                    if (!prevRow || prevRow.dataMovementType === 'X') {
                        // 这是一个新功能过程组的开始，但缺少 E 行
                        // 插入一个合成的 E 行
                        const processName = missingProcesses[missingIdx];
                        const syntheticE = {
                            functionalUser: row.functionalUser || currentFunctionalUser || '',
                            triggerEvent: row.triggerEvent || currentTriggerEvent || '',
                            functionalProcess: processName,
                            subProcessDesc: `接收${processName}请求`,
                            dataMovementType: 'E',
                            dataGroup: `${processName}请求数据`,
                            dataAttributes: '请求标识、触发时间、操作类型、请求参数',
                            level1: hLevel1,
                            level2: hLevel2,
                            level3: hLevel3
                        };
                        tableData.splice(i, 0, syntheticE);
                        console.log(`  🔧 V3.2修复: 为 "${processName}" 补充合成E行 (位置${i})`);
                        missingIdx++;
                        i++; // 跳过刚插入的行
                    }
                }
            }
        }
    }

    // 按功能过程独立匹配层级（修复：不再整批共用第一个功能的层级）
    if (functionLevelMap && Object.keys(functionLevelMap).length > 0) {
        let currentProcess = '';
        for (const row of tableData) {
            if (row.dataMovementType === 'E' && row.functionalProcess) {
                currentProcess = row.functionalProcess;
            }
            // 精确匹配
            let funcLevels = functionLevelMap[currentProcess];
            // 模糊匹配：去掉 [章节名] 标记后再试
            if (!funcLevels && currentProcess) {
                const cleanName = currentProcess.replace(/\[.*?\]\s*/, '').trim();
                funcLevels = functionLevelMap[cleanName];
            }
            if (funcLevels) {
                row.level1 = funcLevels.level1 || '';
                row.level2 = funcLevels.level2 || '';
                row.level3 = funcLevels.level3 || '';
            }
        }
        console.log(`  🏷️ 已按功能过程独立分配层级（共 ${Object.keys(functionLevelMap).length} 个映射）`);
    }

    return limitSubprocessesPerFunction(deduplicateTableData(tableData));
}

/**
 * 从功能过程名称中提取关键词（用于去重时添加前缀）
 * @param {string} processName - 功能过程名称
 * @param {number} length - 关键词长度，默认4，可逐步增加以获取更独特的关键词
 */
function extractProcessKeyword(processName, length = 4) {
    if (!processName) return '';
    // 去掉章节标记
    const clean = processName.replace(/\[.*?\]\s*/, '').trim();
    if (clean.length <= length) return clean;
    return clean.substring(0, length);
}

/**
 * 尝试用逐渐增长的关键词长度来生成唯一名称
 * 关键词自然融入名称中：数据组前缀拼接，子过程描述在动词后插入
 * @param {string} original - 原始名称
 * @param {string} processName - 所属功能过程名称
 * @param {Set} existingNames - 已存在的名称集合（lowercase）
 * @param {string|null} verbPrefix - 动词前缀（如"读取"），有则在动词后插入关键词
 * @returns {string} 唯一化后的名称
 */
function makeUniqueName(original, processName, existingNames, verbPrefix = null) {
    const cleanProcess = (processName || '').replace(/\[.*?\]\s*/, '').trim();
    if (!cleanProcess) return original;

    // 自动检测动词前缀（如果调用方没传）
    if (!verbPrefix) {
        const autoVerb = original.match(/^(接收|读取|保存|更新|返回|呈现|记录|检索|获取|查询|写入|删除|批量)/);
        if (autoVerb) verbPrefix = autoVerb[1];
    }

    // 逐步增加关键词长度: 4 → 6 → 8 → 全名
    const lengths = [4, 6, 8, cleanProcess.length];
    for (const len of lengths) {
        const keyword = cleanProcess.substring(0, Math.min(len, cleanProcess.length));
        let candidate;
        if (verbPrefix) {
            // 动词 + 关键词 + 剩余部分，如 "读取" + "用户管理" + "信息"
            candidate = verbPrefix + keyword + original.substring(verbPrefix.length);
        } else {
            // 关键词 + 原名，如 "用户管理" + "信息表"
            candidate = keyword + original;
        }
        if (!existingNames.has(candidate.toLowerCase().trim())) {
            return candidate;
        }
    }
    // 兜底：完整功能过程名 + 原名
    return cleanProcess + original;
}

/**
 * 获取当前行所属的功能过程名称
 */
function getRowProcessName(tableData, rowIndex) {
    // 向上查找最近的E行的功能过程名称
    for (let i = rowIndex; i >= 0; i--) {
        if (tableData[i].dataMovementType === 'E' || tableData[i].functionalProcess) {
            if (tableData[i].functionalProcess) return tableData[i].functionalProcess;
        }
    }
    return '';
}

/**
 * 对解析后的表格数据进行深度去重
 * 1. 数据组名称全局不重复
 * 2. 子过程描述全局不重复
 * 3. 数据属性全局不重复
 * 策略：使用功能过程的语义关键词区分，关键词长度逐步递增，不使用数字编号
 */
function deduplicateTableData(tableData) {
    if (!tableData || tableData.length === 0) return tableData;

    const MAX_ROUNDS = 5;
    let totalDataGroupFixes = 0;
    let totalSubProcessFixes = 0;
    let totalDataAttrFixes = 0;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
        let fixedThisRound = 0;

        // ——— 步骤1：重建每行对应的功能过程映射 ———
        let currentProcess = '';
        const rowProcessMap = [];
        for (let i = 0; i < tableData.length; i++) {
            if (tableData[i].dataMovementType === 'E' && tableData[i].functionalProcess) {
                currentProcess = tableData[i].functionalProcess;
            }
            rowProcessMap[i] = currentProcess;
        }

        // ——— 步骤2：数据组跨功能过程去重（关键词前缀） ———
        const dataGroupMap = new Map();
        for (let i = 0; i < tableData.length; i++) {
            const dg = tableData[i].dataGroup;
            if (!dg || dg === '待补充') continue;
            const key = dg.toLowerCase().trim();
            if (!dataGroupMap.has(key)) dataGroupMap.set(key, []);
            dataGroupMap.get(key).push({ index: i, processName: rowProcessMap[i] });
        }

        // 收集当前所有数据组名（用于检查唯一性）
        const allDgNames = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const dg = tableData[i].dataGroup;
            if (dg && dg !== '待补充') allDgNames.add(dg.toLowerCase().trim());
        }

        for (const [key, rows] of dataGroupMap.entries()) {
            const uniqueProcesses = [...new Set(rows.map(r => r.processName))];
            if (uniqueProcesses.length <= 1) continue;

            let firstKept = false;
            for (const row of rows) {
                if (!firstKept) { firstKept = true; continue; }
                const original = tableData[row.index].dataGroup;
                const newName = makeUniqueName(original, row.processName, allDgNames);
                if (newName !== original) {
                    allDgNames.delete(original.toLowerCase().trim());
                    tableData[row.index].dataGroup = newName;
                    allDgNames.add(newName.toLowerCase().trim());
                    fixedThisRound++;
                    totalDataGroupFixes++;
                }
            }
        }

        // ——— 步骤3：子过程描述跨功能过程去重（关键词插入） ———
        const subDescMap = new Map();
        for (let i = 0; i < tableData.length; i++) {
            const desc = tableData[i].subProcessDesc;
            if (!desc) continue;
            const key = desc.toLowerCase().trim();
            if (!subDescMap.has(key)) subDescMap.set(key, []);
            subDescMap.get(key).push({ index: i, processName: rowProcessMap[i] });
        }

        const allDescNames = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const desc = tableData[i].subProcessDesc;
            if (desc) allDescNames.add(desc.toLowerCase().trim());
        }

        for (const [key, rows] of subDescMap.entries()) {
            const uniqueProcesses = [...new Set(rows.map(r => r.processName))];
            if (uniqueProcesses.length <= 1) continue;

            let firstKept = false;
            for (const row of rows) {
                if (!firstKept) { firstKept = true; continue; }
                const original = tableData[row.index].subProcessDesc;
                const prefixMatch = original.match(/^(接收|读取|保存|更新|返回|呈现|记录|检索|获取|查询|写入|删除|批量)/);
                const newName = makeUniqueName(original, row.processName, allDescNames, prefixMatch ? prefixMatch[1] : null);
                if (newName !== original) {
                    allDescNames.delete(original.toLowerCase().trim());
                    tableData[row.index].subProcessDesc = newName;
                    allDescNames.add(newName.toLowerCase().trim());
                    fixedThisRound++;
                    totalSubProcessFixes++;
                }
            }
        }

        // ——— 步骤3.5：数据属性跨功能过程去重（关键词前缀） ———
        const dataAttrMap = new Map();
        for (let i = 0; i < tableData.length; i++) {
            const attr = tableData[i].dataAttributes;
            if (!attr || attr === '待补充') continue;
            const key = attr.toLowerCase().trim();
            if (!dataAttrMap.has(key)) dataAttrMap.set(key, []);
            dataAttrMap.get(key).push({ index: i, processName: rowProcessMap[i] });
        }

        const allAttrNames = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const attr = tableData[i].dataAttributes;
            if (attr && attr !== '待补充') allAttrNames.add(attr.toLowerCase().trim());
        }

        for (const [key, rows] of dataAttrMap.entries()) {
            const uniqueProcesses = [...new Set(rows.map(r => r.processName))];
            if (uniqueProcesses.length <= 1) continue;

            let firstKept = false;
            for (const row of rows) {
                if (!firstKept) { firstKept = true; continue; }
                const original = tableData[row.index].dataAttributes;
                const newName = makeUniqueName(original, row.processName, allAttrNames);
                if (newName !== original) {
                    allAttrNames.delete(original.toLowerCase().trim());
                    tableData[row.index].dataAttributes = newName;
                    allAttrNames.add(newName.toLowerCase().trim());
                    fixedThisRound++;
                    totalDataAttrFixes++;
                }
            }
        }

        // ——— 步骤4：数据组绝对去重（关键词前缀融入） ———
        const dgAbsCheck = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const dg = tableData[i].dataGroup;
            if (!dg || dg === '待补充') continue;
            const key = dg.toLowerCase().trim();
            if (dgAbsCheck.has(key)) {
                const newName = makeUniqueName(dg, rowProcessMap[i], dgAbsCheck);
                tableData[i].dataGroup = newName;
                dgAbsCheck.add(newName.toLowerCase().trim());
                fixedThisRound++;
                totalDataGroupFixes++;
            } else {
                dgAbsCheck.add(key);
            }
        }

        // ——— 步骤5：子过程描述绝对去重（关键词融入） ———
        const descAbsCheck = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const desc = tableData[i].subProcessDesc;
            if (!desc) continue;
            const key = desc.toLowerCase().trim();
            if (descAbsCheck.has(key)) {
                const newName = makeUniqueName(desc, rowProcessMap[i], descAbsCheck);
                tableData[i].subProcessDesc = newName;
                descAbsCheck.add(newName.toLowerCase().trim());
                fixedThisRound++;
                totalSubProcessFixes++;
            } else {
                descAbsCheck.add(key);
            }
        }

        // ——— 步骤5.5：数据属性绝对去重（关键词前缀融入） ———
        const attrAbsCheck = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const attr = tableData[i].dataAttributes;
            if (!attr || attr === '待补充') continue;
            const key = attr.toLowerCase().trim();
            if (attrAbsCheck.has(key)) {
                const newName = makeUniqueName(attr, rowProcessMap[i], attrAbsCheck);
                tableData[i].dataAttributes = newName;
                attrAbsCheck.add(newName.toLowerCase().trim());
                fixedThisRound++;
                totalDataAttrFixes++;
            } else {
                attrAbsCheck.add(key);
            }
        }

        // ——— 检查是否还有残留重复 ———
        if (fixedThisRound === 0) {
            if (round > 1) {
                console.log(`✅ 第 ${round} 轮检查通过，无重复项`);
            }
            break;
        }

        console.log(`🔧 第 ${round} 轮去重: 修正了 ${fixedThisRound} 处重复`);

        if (round === MAX_ROUNDS) {
            console.log(`⚠️ 达到最大去重轮次(${MAX_ROUNDS})，执行强制关键词去重`);
            forceKeywordDedup(tableData, rowProcessMap);
        }
    }

    if (totalDataGroupFixes > 0 || totalSubProcessFixes > 0 || totalDataAttrFixes > 0) {
        console.log(`📊 去重汇总: 共修正 ${totalDataGroupFixes} 个数据组名称, ${totalSubProcessFixes} 个子过程描述, ${totalDataAttrFixes} 个数据属性`);
    }

    return tableData;
}

/**
 * 强制关键词去重 — 最终兜底：用功能过程关键词自然融入名称
 */
function forceKeywordDedup(tableData, rowProcessMap) {
    // 数据组去重
    const dgSeen = new Set();
    for (let i = 0; i < tableData.length; i++) {
        const dg = tableData[i].dataGroup;
        if (!dg || dg === '待补充') continue;
        const key = dg.toLowerCase().trim();
        if (dgSeen.has(key)) {
            const newName = makeUniqueName(dg, rowProcessMap[i], dgSeen);
            tableData[i].dataGroup = newName;
            dgSeen.add(newName.toLowerCase().trim());
        } else {
            dgSeen.add(key);
        }
    }

    // 子过程描述去重
    const descSeen = new Set();
    for (let i = 0; i < tableData.length; i++) {
        const desc = tableData[i].subProcessDesc;
        if (!desc) continue;
        const key = desc.toLowerCase().trim();
        if (descSeen.has(key)) {
            const newName = makeUniqueName(desc, rowProcessMap[i], descSeen);
            tableData[i].subProcessDesc = newName;
            descSeen.add(newName.toLowerCase().trim());
        } else {
            descSeen.add(key);
        }
    }

    // 数据属性去重
    const attrSeen = new Set();
    for (let i = 0; i < tableData.length; i++) {
        const attr = tableData[i].dataAttributes;
        if (!attr || attr === '待补充') continue;
        const key = attr.toLowerCase().trim();
        if (attrSeen.has(key)) {
            const newName = makeUniqueName(attr, rowProcessMap[i], attrSeen);
            tableData[i].dataAttributes = newName;
            attrSeen.add(newName.toLowerCase().trim());
        } else {
            attrSeen.add(key);
        }
    }
}

/**
 * 从功能过程列表文本中提取功能列表
 */
function extractFunctionsFromText(text) {
    const functions = [];
    const sections = text.split(/(?=##)/);

    let currentFunc = null;

    for (const section of sections) {
        const lines = section.trim().split('\n');
        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith('##触发事件：') || trimmed.startsWith('## 触发事件：')) {
                if (currentFunc && currentFunc.functionName) {
                    functions.push(currentFunc);
                }
                currentFunc = {
                    triggerEvent: trimmed.replace(/^##\s*触发事件[：:]/, '').trim(),
                    functionalUser: '',
                    functionName: '',
                    description: '',
                    selected: true
                };
            } else if (trimmed.startsWith('##功能用户：') || trimmed.startsWith('## 功能用户：')) {
                if (currentFunc) {
                    currentFunc.functionalUser = trimmed.replace(/^##\s*功能用户[：:]/, '').trim();
                }
            } else if (trimmed.startsWith('##功能过程：') || trimmed.startsWith('## 功能过程：')) {
                if (currentFunc) {
                    currentFunc.functionName = trimmed.replace(/^##\s*功能过程[：:]/, '').trim();
                }
            } else if (trimmed.startsWith('##功能过程描述：') || trimmed.startsWith('## 功能过程描述：')) {
                if (currentFunc) {
                    currentFunc.description = trimmed.replace(/^##\s*功能过程描述[：:]/, '').trim();
                }
            }
        }
    }

    if (currentFunc && currentFunc.functionName) {
        functions.push(currentFunc);
    }

    return functions;
}

function buildFunctionListText(functions) {
    return functions.map(f => `##触发事件：${f.triggerEvent || '用户触发'}
##功能用户：${f.functionalUser || '发起者：用户 接收者：用户'}
##功能过程：${f.functionName}
##功能过程描述：${f.description || ''}`).join('\n\n');
}

// ═══════════════════════ API路由 ═══════════════════════

// 健康检查
app.get('/api/health', (req, res) => {
    const hasSenseNovaApiKey = Boolean(process.env.SENSENOVA_API_KEY);
    const hasVolcengineApiKey = Boolean(process.env.VOLCENGINE_API_KEY);
    res.json({
        status: 'ok',
        hasApiKey: hasSenseNovaApiKey || hasVolcengineApiKey,
        hasSenseNovaApiKey,
        hasVolcengineApiKey,
        codeAnalysisModel: MODEL_MAP['deepseek-v4-pro'] || 'deepseek-v4-pro-260425',
        currentModel: currentModel,
        model: currentModel,
        platform: SENSENOVA_MODELS.has(currentModel) ? 'SenseNova' : 'OpenAI-compatible',
        availableModels: Array.from(new Set(Object.values(MODEL_MAP)))
    });
});

// 切换模型
app.post('/api/switch-model', (req, res) => {
    const { model } = req.body;
    const modelName = MODEL_MAP[model] || model;
    currentModel = modelName;
    console.log(`✅ 模型已切换到: ${currentModel}`);
    res.json({ success: true, model: currentModel });
});

// API配置（开放平台模式）
app.post('/api/config', (req, res) => {
    const { apiKey } = req.body;
    if (apiKey && apiKey.includes('你的') && apiKey.includes('密钥')) {
        return res.status(400).json({ error: '请填入真实的 API Key' });
    }
    res.json({ success: true, message: 'API配置已更新' });
});

// ═══════════════════════ 文档解析 ═══════════════════════

function restoreWordHeadingNumbers(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const headingRows = lines
        .map((line, index) => {
            const match = line.trim().match(/^(#{1,6})\s+(.+)$/);
            return match ? {
                index,
                level: match[1].length,
                // Mammoth escapes manually typed dots in headings ("1\\."), so
                // normalize the title before checking whether it is numbered.
                title: match[2].trim().replace(/\\([.>\-])/g, '$1')
            } : null;
        })
        .filter(Boolean);

    if (headingRows.length === 0) return String(markdown || '').trim();

    // Word cover/document titles are frequently Heading 1 too. When the first
    // two headings are adjacent peers, keep the first as an unnumbered title.
    const first = headingRows[0];
    const second = headingRows[1];
    const textBetweenFirstTwo = second
        ? lines.slice(first.index + 1, second.index).join('').trim()
        : '';
    const skipFirstAsDocumentTitle = Boolean(
        second
        && first.level === second.level
        && !textBetweenFirstTwo
        && /需求|说明书|文档|内容|方案|报告|设计|规格|项目/.test(first.title)
    );

    const structuralRows = skipFirstAsDocumentTitle ? headingRows.slice(1) : headingRows;
    const baseLevel = Math.min(...structuralRows.map(row => row.level));
    const counters = Array(6).fill(0);
    const replacements = new Map();

    headingRows.forEach((row, rowIndex) => {
        if (skipFirstAsDocumentTitle && rowIndex === 0) {
            replacements.set(row.index, row.title);
            return;
        }
        if (/^(?:目录|contents)$/i.test(row.title)) {
            replacements.set(row.index, row.title);
            return;
        }

        const counterIndex = row.level - baseLevel;
        for (let i = 0; i < counterIndex; i++) {
            if (counters[i] === 0) counters[i] = 1;
        }
        counters[counterIndex] += 1;
        counters.fill(0, counterIndex + 1);

        // Do not duplicate numbers that were typed into the heading itself.
        if (/^\d+(?:\.\d+)*[.、\s]/.test(row.title)) {
            replacements.set(row.index, row.title);
            return;
        }
        const number = counters.slice(0, counterIndex + 1).join('.');
        replacements.set(row.index, `${number}. ${row.title}`);
    });

    return lines
        .map((line, index) => replacements.has(index) ? replacements.get(index) : line)
        .join('\n')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\\([.>\-])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ═══════════════════════ 代码 / HTML / 系统截图反向分析 ═══════════════════════
app.post(
    '/api/analyze-code-source',
    codeSourceUpload.fields([
        { name: 'source', maxCount: 1 },
        { name: 'screenshots', maxCount: MAX_SCREENSHOTS }
    ]),
    handleMulterError,
    async (req, res) => {
        const uploadedFiles = [
            ...(req.files?.source || []),
            ...(req.files?.screenshots || [])
        ];
        try {
            const sourceFile = req.files?.source?.[0] || null;
            const rawScreenshotFiles = req.files?.screenshots || [];
            const oversizedScreenshot = rawScreenshotFiles.find(file => file.size > 10 * 1024 * 1024);
            if (oversizedScreenshot) {
                return res.status(400).json({ error: `截图 ${oversizedScreenshot.originalname} 超过10MB限制` });
            }
            const screenshotFiles = await Promise.all(rawScreenshotFiles.map(async file => ({
                ...file,
                buffer: await fs.promises.readFile(file.path)
            })));
            if (!sourceFile && screenshotFiles.length === 0) {
                return res.status(400).json({ error: '请至少上传一个ZIP/HTML代码源或一张系统截图' });
            }

            const analysisMode = req.body.analysisMode === 'direct' ? 'direct' : 'requirement';
            const userGuidelines = String(req.body.userGuidelines || '').trim();
            let userConfig = null;
            if (req.body.userConfig) {
                try {
                    userConfig = typeof req.body.userConfig === 'string'
                        ? JSON.parse(req.body.userConfig)
                        : req.body.userConfig;
                } catch (error) {
                    return res.status(400).json({ error: 'AI配置格式不正确' });
                }
            }
            const codeAnalysisConfig = {
                model: 'deepseek-v4-pro',
                provider: 'volcengine',
                apiKey: userConfig?.provider === 'volcengine' ? (userConfig.apiKey || null) : null,
                baseUrl: userConfig?.provider === 'volcengine' ? (userConfig.baseUrl || null) : null
            };
            const codeAnalysisModel = getModelName(codeAnalysisConfig);
            if (!codeAnalysisConfig.apiKey && !process.env.VOLCENGINE_API_KEY) {
                return res.status(503).json({
                    error: '代码反向分析固定使用 DeepSeek V4 Pro，但服务器未配置 VOLCENGINE_API_KEY'
                });
            }

            let sourceArtifact = null;
            if (sourceFile) {
                sourceArtifact = await extractSourceArtifact(
                    await fs.promises.readFile(sourceFile.path),
                    sourceFile.originalname
                );
            }

            console.log(
                `🧩 开始代码反向分析: ${sourceFile?.originalname || '仅截图'}`
                + `, 截图 ${screenshotFiles.length} 张, 模式 ${analysisMode}`
                + `, 模型 ${codeAnalysisModel}`
            );
            const result = await analyzeCodeSource({
                sourceArtifact,
                screenshotFiles,
                analysisMode,
                userGuidelines,
                userConfig: codeAnalysisConfig,
                modelName: codeAnalysisModel,
                callAIWithRetry
            });

            const baseName = path.basename(
                sourceFile?.originalname || result.systemName || '系统截图',
                path.extname(sourceFile?.originalname || '')
            );
            const documentName = `${baseName || result.systemName || '系统'}_代码反向需求.md`;
            console.log(
                `✅ 代码反向分析完成: ${result.modules.length} 个模块,`
                + ` ${result.functions.length} 个功能过程`
            );
            res.json({
                success: true,
                analysisMode,
                analysisModel: codeAnalysisModel,
                documentName,
                sourceSummary: sourceArtifact ? {
                    sourceName: sourceArtifact.sourceName,
                    sourceType: sourceArtifact.sourceType,
                    fileCount: sourceArtifact.fileCount,
                    candidateCount: sourceArtifact.candidateCount,
                    includedFiles: sourceArtifact.includedFiles,
                    ignoredCount: sourceArtifact.ignoredCount,
                    truncated: sourceArtifact.truncated
                } : null,
                moduleStructure: {
                    modules: result.modules,
                    totalEstimated: result.modules.reduce(
                        (sum, module) => sum + (Number(module.estimatedFunctions) || 0),
                        0
                    ),
                    summary: result.summary
                },
                ...result
            });
        } catch (error) {
            console.error('代码反向分析失败:', error);
            res.status(500).json({ error: '代码反向分析失败: ' + error.message });
        } finally {
            await Promise.all(uploadedFiles
                .map(file => file?.path)
                .filter(Boolean)
                .map(filePath => fs.promises.unlink(filePath).catch(() => {})));
        }
    }
);

app.post('/api/parse-word', upload.single('file'), handleMulterError, async (req, res) => {
    const uploadedPath = req.file?.path;
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传文件' });
        }

        const ext = path.extname(req.file.originalname).toLowerCase();
        let text = '';

        console.log(`📄 解析文件: ${req.file.originalname}, 大小: ${req.file.size} bytes`);

        if (ext === '.docx') {
            // Raw text drops Word's automatic heading numbers and all heading
            // styles. Markdown keeps Heading 1/2/3 semantics so we can restore a
            // stable visible outline before chapter detection.
            const result = await mammoth.convertToMarkdown(
                { path: uploadedPath },
                { convertImage: mammoth.images.imgElement(() => ({ src: '' })) }
            );
            text = restoreWordHeadingNumbers(result.value);
        } else if (ext === '.txt' || ext === '.md') {
            text = await fs.promises.readFile(uploadedPath, 'utf-8');
        } else if (ext === '.doc') {
            return res.status(400).json({ error: '不支持旧版.doc格式，请另存为.docx格式' });
        }

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: '文档内容为空' });
        }

        res.json({
            success: true,
            text,
            filename: req.file.originalname,
            fileSize: req.file.size,
            wordCount: text.length
        });
    } catch (error) {
        console.error('解析文档失败:', error);
        res.status(500).json({ error: '解析文档失败: ' + error.message });
    } finally {
        if (uploadedPath) {
            fs.promises.unlink(uploadedPath).catch(() => {});
        }
    }
});

app.post('/api/parse-cosmic-excel', upload.single('file'), handleMulterError, async (req, res) => {
    const uploadedPath = req.file?.path;
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传文件' });
        }

        const ext = path.extname(req.file.originalname).toLowerCase();
        if (ext === '.xls') {
            return res.status(400).json({ error: '暂不支持旧版 .xls 文件，请另存为 .xlsx 或 .xlsm 后上传' });
        }
        if (!['.xlsx', '.xlsm'].includes(ext)) {
            return res.status(400).json({ error: '请上传已拆分的 COSMIC Excel 文件（.xlsx 或 .xlsm）' });
        }

        console.log(`📊 解析COSMIC Excel: ${req.file.originalname}, 大小: ${req.file.size} bytes`);

        const workbook = await loadExcelWorkbook(uploadedPath);

        const layout = detectCosmicExcelLayout(workbook);
        if (!layout) {
            return res.status(400).json({
                error: '未识别到COSMIC拆分表头，请确认Excel中包含“功能过程、子过程描述、数据移动类型、数据组、数据属性”等列'
            });
        }

        const userConfig = parseJsonBodyField(req.body.userConfig, null);
        const parsedRows = parseCosmicExcelRows(layout.worksheet, layout.headerRowNumber, layout.columnMap);
        const eRowsBeforeDescription = parsedRows.filter(row => row.dataMovementType === 'E' && row.functionalProcess);
        const usefulDescriptionCount = eRowsBeforeDescription.filter(row => (
            isUsefulFunctionDescription(row.functionDescription || row.functionalDescription || '')
        )).length;
        const shouldRegenerateAllDescriptions = eRowsBeforeDescription.length > 0 && usefulDescriptionCount === 0;
        const shouldSupplementMissingDescriptions = eRowsBeforeDescription.length > usefulDescriptionCount;

        let tableData = parsedRows;
        let descriptionGeneration = {
            source: 'excel',
            generatedCount: 0,
            fallbackCount: 0,
            missingBefore: Math.max(0, eRowsBeforeDescription.length - usefulDescriptionCount),
            error: null
        };
        if (shouldRegenerateAllDescriptions || shouldSupplementMissingDescriptions) {
            const generationResult = await generateFunctionDescriptionsWithAI(tableData, userConfig, {
                forceRegenerate: shouldRegenerateAllDescriptions
            });
            tableData = generationResult.tableData;
            descriptionGeneration = {
                source: generationResult.generatedCount > 0
                    ? (shouldRegenerateAllDescriptions ? 'ai-regenerated' : 'ai-supplemented')
                    : 'local-fallback',
                generatedCount: generationResult.generatedCount,
                fallbackCount: generationResult.fallbackCount,
                missingBefore: Math.max(0, eRowsBeforeDescription.length - usefulDescriptionCount),
                error: generationResult.error
            };
        } else {
            tableData = ensureFunctionDescriptions(tableData);
        }
        const functionCount = tableData.filter(row => row.dataMovementType === 'E' && row.functionalProcess).length;

        if (!tableData.length || functionCount === 0) {
            return res.status(400).json({ error: '已识别到表头，但未解析到有效的COSMIC数据行，请检查“数据移动类型”列是否填写 E/R/W/X' });
        }

        const parsedFunctions = buildParsedFunctionsFromTableData(tableData);
        const moduleStructure = buildModuleStructureFromTableData(tableData);
        const dmtCounts = tableData.reduce((acc, row) => {
            if (row.dataMovementType) acc[row.dataMovementType] = (acc[row.dataMovementType] || 0) + 1;
            return acc;
        }, {});
        const formatName = getCosmicExcelFormatName(layout);
        const documentContent = [
            `已导入已拆分COSMIC文件：${req.file.originalname}`,
            `识别格式：${formatName}`,
            `工作表：${layout.worksheet.name}`,
            `功能过程：${functionCount} 个`,
            `数据移动/CFP：${tableData.length} 条`,
            `ERWX统计：E×${dmtCounts.E || 0} R×${dmtCounts.R || 0} W×${dmtCounts.W || 0} X×${dmtCounts.X || 0}`,
            `功能描述：${descriptionGeneration.source === 'excel'
                ? '使用Excel原有描述'
                : descriptionGeneration.source === 'local-fallback'
                    ? 'AI生成失败，已使用本地规则兜底'
                    : `已调用AI生成 ${descriptionGeneration.generatedCount} 条`}`
        ].join('\n');

        res.json({
            success: true,
            filename: req.file.originalname,
            fileSize: req.file.size,
            tableData,
            parsedFunctions,
            functionListText: buildFunctionListTextFromTableData(tableData),
            moduleStructure,
            documentContent,
            count: tableData.length,
            functionCount,
            dmtCounts,
            descriptionGeneration,
            format: {
                name: formatName,
                sheetName: layout.worksheet.name,
                headerRow: layout.headerRowNumber,
                hasLevels: Boolean(
                    layout.columnMap.level1
                    || layout.columnMap.level2
                    || layout.columnMap.level3
                    || layout.columnMap.level4
                ),
                hasDescription: Boolean(layout.columnMap.functionDescription)
            }
        });
    } catch (error) {
        console.error('解析COSMIC Excel失败:', error);
        res.status(500).json({ error: '解析COSMIC Excel失败: ' + error.message });
    } finally {
        if (uploadedPath) {
            fs.promises.unlink(uploadedPath).catch(() => {});
        }
    }
});

// ═══════════════════════ 文档理解 ═══════════════════════

app.post('/api/understand-document', async (req, res) => {
    try {
        const { documentContent, userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log('🔍 开始深度理解文档...');
        const modelName = getModelName(userConfig);

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: DOCUMENT_UNDERSTANDING_PROMPT },
                { role: 'user', content: `请分析以下需求文档：\n\n${documentContent}` }
            ],
            model: modelName,
            temperature: 0.1,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            console.error('❌ AI返回空响应:', JSON.stringify(completion, null, 2).substring(0, 500));
            return res.status(500).json({ error: 'AI返回了空响应，请重试或切换模型' });
        }
        const reply = completion.choices[0].message.content;

        // 尝试解析JSON
        let understanding = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                understanding = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn('JSON解析失败，使用默认结构');
            understanding = {
                projectName: '未识别',
                projectDescription: reply.substring(0, 200),
                coreModules: [],
                totalEstimatedFunctions: 30
            };
        }

        console.log('✅ 文档理解完成');
        res.json({ success: true, understanding });
    } catch (error) {
        console.error('文档理解失败:', error);
        res.status(500).json({ error: '文档理解失败: ' + error.message });
    }
});

// ═══════════════════════ 章节识别 ═══════════════════════

/**
 * 从标题文本中提取数字编号层级深度
 * 规则（以图片示例为准）：
 *   「2.1 关于...」      → 编号段数2 → 一级标题 depth=1
 *   「2.1.1 故障...」   → 编号段数3 → 二级标题 depth=2
 *   「2.1.1.1 新增...」 → 编号段数4 → 三级标题 depth=3
 * 非数字编号标题(第X章/中文序号等) → depth=0
 * @param {string} title - 标题文本
 * @returns {{ depth: number, numStr: string }} depth=0表示非数字编号
 */
function extractHeadingLevel(title) {
    if (!title) return { depth: 0, numStr: '' };
    const trimmed = title.trim();
    const markdownMatch = trimmed.match(/^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (markdownMatch) {
        const markdownTitle = markdownMatch[2].trim();
        const numMatch = markdownTitle.match(/^(\d+(?:\.\d+)*)(?:[\s.]|$)/);
        return {
            depth: Math.min(markdownMatch[1].length, 3),
            numStr: numMatch?.[1] || ''
        };
    }
    // 匹配数字编号开头，如 "2.1"、"2.1.1"、"2.1.1.2"
    const numMatch = trimmed.match(/^(\d+(?:\.\d+)*)(?:[\s.]|$)/);
    if (!numMatch) return { depth: 0, numStr: '' };
    const numStr = numMatch[1]; // e.g. "2.1.1"
    const parts = numStr.split('.');
    // 第一段是最顶层模块号（如"2"），后续才是层级深度
    // depth = parts.length - 1，最少为1，最多为3
    const depth = Math.min(Math.max(parts.length - 1, 1), 3);
    return { depth, numStr };
}

/**
 * 自动识别文档章节结构
 * 辨别标题 vs 正文的多层过滤：
 *  1. 不同类型标题设不同最大长度（第X章60字, 数字编号30字, 中文序号35字）
 *  2. 以句子标点结尾（。，；：！？…）的行必为正文，排除
 *  3. 含正文特征词（应当/需要/如下/以下等）的行排除
 *  4. 两候选标题之间内容少于30字 → 是列表项而非章节分割点
 *  5. 章节数过多(>20) → 自动收敛到顶层标题
 *
 * 每个章节对象还携带 level1/level2/level3 字段（基于编号层级）：
 *  - 2.1 xxx     → { level1: '2.1 xxx', level2: '', level3: '' }
 *  - 2.1.1 xxx   → { level1: '2.1 xxx（继承）', level2: '2.1.1 xxx', level3: '' }
 *  - 2.1.1.1 xxx → { level1: ..., level2: ..., level3: '2.1.1.1 xxx' }
 */
function normalizeModuleMatchText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/^\s*\d+(?:\.\d+)*[\s.\u3001]*/, '')
        .replace(/\[[^\]]*\]|\([^)]*\)|\u3010[^\u3011]*\u3011|\uFF08[^\uFF09]*\uFF09/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .toLowerCase()
        .trim();
}

function extractLeadingNumber(value) {
    const match = String(value || '').normalize('NFKC').trim().match(/^(\d+(?:\.\d+)*)/);
    return match ? match[1] : '';
}

function scoreModuleHeadingLine(line, mod) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return 0;

    const lineNum = extractLeadingNumber(trimmed);
    const moduleNum = extractLeadingNumber(mod.level3) || extractLeadingNumber(mod.level2);
    const lineNorm = normalizeModuleMatchText(trimmed);
    const l3Norm = normalizeModuleMatchText(mod.level3);
    const l2Norm = normalizeModuleMatchText(mod.level2);
    const l1Norm = normalizeModuleMatchText(mod.level1);
    if (!lineNorm || (!l3Norm && !moduleNum)) return 0;

    let score = 0;
    if (moduleNum && lineNum === moduleNum) score += 900;
    else if (moduleNum && lineNum && (lineNum.startsWith(`${moduleNum}.`) || moduleNum.startsWith(`${lineNum}.`))) score += 90;

    if (l3Norm) {
        if (lineNorm === l3Norm) score += 700;
        else if (lineNorm.includes(l3Norm) || l3Norm.includes(lineNorm)) score += 260;
    }
    if (l2Norm && lineNorm.includes(l2Norm)) score += 70;
    if (l1Norm && lineNorm.includes(l1Norm)) score += 30;

    const { depth } = extractHeadingLevel(trimmed);
    if (depth === 3) score += 60;
    else if (depth === 2) score += 25;
    else if (depth === 1) score += 10;

    if (trimmed.length > 120) score -= 160;
    if (/[\u3002\uff0c\u3001\uff1b\uff1a\u2026\uff01\uff1f,;:!?)\uff09]$/.test(trimmed)) score -= 180;
    return score;
}

function findModuleAnchors(lines, modules) {
    const anchors = [];
    const usedLines = new Set();
    let searchStart = 0;

    modules.forEach((mod, moduleIndex) => {
        let best = null;
        for (let i = searchStart; i < lines.length; i++) {
            if (usedLines.has(i)) continue;
            const score = scoreModuleHeadingLine(lines[i], mod);
            if (!best || score > best.score) {
                best = { lineIndex: i, title: lines[i].trim(), mod, moduleIndex, score };
                if (score >= 980) break;
            }
        }

        if (best && best.score >= 340) {
            anchors.push(best);
            usedLines.add(best.lineIndex);
            searchStart = best.lineIndex + 1;
        }
    });

    return anchors;
}

function splitIntoModuleAlignedChapters(text, moduleStructure) {
    const modules = Array.isArray(moduleStructure?.modules) ? moduleStructure.modules : [];
    if (!text || modules.length === 0) return null;

    const lines = text.split('\n');
    const anchors = findModuleAnchors(lines, modules)
        .sort((a, b) => a.lineIndex - b.lineIndex);

    const minMatches = Math.max(3, Math.ceil(modules.length * 0.5));
    if (anchors.length < minMatches) return null;

    return anchors.map((anchor, index) => {
        const nextAnchor = anchors[index + 1];
        const endLine = nextAnchor ? nextAnchor.lineIndex : lines.length;
        const content = lines.slice(anchor.lineIndex, endLine).join('\n').trim();
        return {
            title: anchor.mod.level3 || anchor.title,
            content,
            charCount: content.length,
            selected: content.length > 30,
            level1: anchor.mod.level1 || '',
            level2: anchor.mod.level2 || '',
            level3: anchor.mod.level3 || anchor.title,
            headingDepth: 3,
            moduleAligned: true,
            sourceTitle: anchor.title,
            moduleIndex: anchor.moduleIndex,
            matchScore: anchor.score
        };
    });
}

function getRelevantModulesForChapter(modules, chapterName) {
    if (!Array.isArray(modules) || modules.length === 0) return [];
    const chapterNorm = normalizeModuleMatchText(chapterName);
    if (!chapterNorm) return modules;

    const exactL3 = modules.filter(m => normalizeModuleMatchText(m.level3) === chapterNorm);
    if (exactL3.length > 0) return exactL3;

    const looseL3 = modules.filter(m => {
        const l3 = normalizeModuleMatchText(m.level3);
        return l3 && (chapterNorm.includes(l3) || l3.includes(chapterNorm));
    });
    if (looseL3.length > 0) return looseL3;

    const level2Matches = modules.filter(m => {
        const l2 = normalizeModuleMatchText(m.level2);
        return l2 && (chapterNorm.includes(l2) || l2.includes(chapterNorm));
    });
    if (level2Matches.length > 0) return level2Matches;

    const level1Matches = modules.filter(m => {
        const l1 = normalizeModuleMatchText(m.level1);
        return l1 && (chapterNorm.includes(l1) || l1.includes(chapterNorm));
    });
    return level1Matches.length > 0 ? level1Matches : modules;
}

function headingNumberDepth(value) {
    const num = extractLeadingNumber(value);
    return num ? num.split('.').length : 0;
}

function stripModuleNumber(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/^\s*\d+(?:\.\d+)*[\s.\u3001、-]*/, '')
        .trim();
}

function shouldCollapseOverDetailedModules(modules) {
    if (!Array.isArray(modules) || modules.length <= 30) return false;
    const parentKeys = new Set(modules.map(m => [
        normalizeModuleMatchText(m.level1),
        normalizeModuleMatchText(m.level2)
    ].join('|')));
    const shallowLevel3Count = modules.filter(m => headingNumberDepth(m.level3) <= 2).length;
    return parentKeys.size > 0
        && parentKeys.size <= Math.ceil(modules.length * 0.65)
        && shallowLevel3Count >= Math.ceil(modules.length * 0.6);
}

function collapseOverDetailedModules(moduleData) {
    const modules = Array.isArray(moduleData?.modules) ? moduleData.modules : [];
    if (!shouldCollapseOverDetailedModules(modules)) return moduleData;

    const level1Order = [];
    const level1Rank = new Map();
    const groups = new Map();

    modules.forEach((m) => {
        const rawLevel1 = stripModuleNumber(m.level1) || m.level1 || '功能模块';
        const rawLevel2 = stripModuleNumber(m.level2) || stripModuleNumber(m.level3) || m.level2 || m.level3 || '子模块';
        const l1Key = normalizeModuleMatchText(rawLevel1) || rawLevel1;
        if (!level1Rank.has(l1Key)) {
            level1Rank.set(l1Key, level1Order.length + 1);
            level1Order.push(l1Key);
        }

        const key = `${l1Key}|${normalizeModuleMatchText(rawLevel2) || rawLevel2}`;
        if (!groups.has(key)) {
            groups.set(key, {
                rawLevel1,
                rawLevel2,
                level1Index: level1Rank.get(l1Key),
                level2Number: parseInt(extractLeadingNumber(m.level2), 10) || null,
                businessObjects: new Set(),
                triggerTypes: new Set(),
                estimatedFunctions: 0
            });
        }

        const group = groups.get(key);
        (m.businessObjects || []).forEach(obj => { if (obj) group.businessObjects.add(obj); });
        (m.triggerTypes || []).forEach(trigger => { if (trigger) group.triggerTypes.add(trigger); });
        group.estimatedFunctions += Number(m.estimatedFunctions) || 0;
    });

    const level2Counters = new Map();
    const collapsed = Array.from(groups.values()).map((group) => {
        const nextCount = (level2Counters.get(group.level1Index) || 0) + 1;
        level2Counters.set(group.level1Index, nextCount);
        const childIndex = group.level2Number || nextCount;
        const level1 = `${group.level1Index} ${group.rawLevel1}`;
        const level2 = `${group.level1Index}.1 ${group.rawLevel1}`;
        const cleanLevel3Name = /管理$/.test(group.rawLevel2) ? group.rawLevel2 : `${group.rawLevel2}管理`;
        return {
            level1,
            level2,
            level3: `${group.level1Index}.1.${childIndex} ${cleanLevel3Name}`,
            businessObjects: Array.from(group.businessObjects).slice(0, 12),
            estimatedFunctions: Math.max(3, Math.round(group.estimatedFunctions || 6)),
            triggerTypes: Array.from(group.triggerTypes)
        };
    });

    return {
        ...moduleData,
        modules: collapsed,
        totalEstimated: collapsed.reduce((sum, m) => sum + (Number(m.estimatedFunctions) || 0), 0),
        summary: `${moduleData?.summary || ''} 已将过细功能项折叠为页面/面板级三级模块。`.trim(),
        collapsedFrom: modules.length
    };
}

function scoreLineForModule(line, mod) {
    const lineNorm = normalizeModuleMatchText(line);
    if (!lineNorm) return 0;
    const tokens = [
        stripModuleNumber(mod.level3).replace(/管理$/, ''),
        stripModuleNumber(mod.level2).replace(/管理$/, ''),
        stripModuleNumber(mod.level1),
        ...(mod.businessObjects || [])
    ]
        .map(normalizeModuleMatchText)
        .filter(token => token && token.length >= 2);

    return tokens.reduce((score, token, index) => {
        if (lineNorm.includes(token) || token.includes(lineNorm)) {
            return score + (index === 0 ? 8 : index === 1 ? 5 : 2);
        }
        return score;
    }, 0);
}

function buildModuleContentExcerpt(text, mod, maxChars = 6000) {
    if (!text) return mod.level3 || '';
    const lines = text.split('\n');
    const scored = lines
        .map((line, index) => ({ index, score: scoreLineForModule(line, mod) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 6)
        .sort((a, b) => a.index - b.index);

    if (scored.length === 0) {
        return `${mod.level3 || ''}\n${text.slice(0, maxChars)}`.trim();
    }

    const ranges = [];
    scored.forEach(({ index }) => {
        const start = Math.max(0, index - 8);
        const end = Math.min(lines.length, index + 18);
        const last = ranges[ranges.length - 1];
        if (last && start <= last.end) {
            last.end = Math.max(last.end, end);
        } else {
            ranges.push({ start, end });
        }
    });

    const excerpt = ranges
        .map(range => lines.slice(range.start, range.end).join('\n').trim())
        .filter(Boolean)
        .join('\n\n...\n\n')
        .slice(0, maxChars);
    return `${mod.level3 || ''}\n${excerpt}`.trim();
}

function buildModuleScaffoldChapters(text, moduleStructure) {
    const modules = Array.isArray(moduleStructure?.modules) ? moduleStructure.modules : [];
    if (!text || modules.length === 0) return null;

    return modules.map((mod, index) => {
        const content = buildModuleContentExcerpt(text, mod);
        return {
            title: mod.level3 || `模块 ${index + 1}`,
            content,
            charCount: content.length,
            selected: true,
            level1: mod.level1 || '',
            level2: mod.level2 || '',
            level3: mod.level3 || '',
            headingDepth: 3,
            moduleAligned: true,
            syntheticFromModule: true,
            moduleIndex: index
        };
    });
}

function hasExcessiveSyntheticChapterOverlap(chapters, sourceText) {
    if (!Array.isArray(chapters) || chapters.length < 3 || !sourceText) return false;

    const sourceLength = normalizeModuleMatchText(sourceText).length;
    if (sourceLength < 80) return false;

    const bodies = chapters.map(chapter => {
        const contentLines = String(chapter?.content || '').split('\n');
        if (normalizeModuleMatchText(contentLines[0]) === normalizeModuleMatchText(chapter?.title)) {
            contentLines.shift();
        }
        return normalizeModuleMatchText(contentLines.join('\n'));
    });
    const nearFullCount = bodies.filter(body => body.length >= sourceLength * 0.72).length;
    const leadFingerprints = bodies
        .filter(body => body.length >= 80)
        .map(body => body.slice(0, 320));
    const uniqueLeadCount = new Set(leadFingerprints).size;

    return nearFullCount >= Math.ceil(chapters.length * 0.6)
        || (leadFingerprints.length >= 3
            && uniqueLeadCount <= Math.ceil(leadFingerprints.length * 0.4));
}

function isUsableDocumentChapterSplit(chapters) {
    if (!Array.isArray(chapters)) return false;
    const realChapters = chapters.filter(ch => ch && ch.title !== '全文');
    if (realChapters.length < 2) return false;
    const selectedCount = realChapters.filter(ch => ch.selected && (ch.charCount || 0) > 50).length;
    return selectedCount >= Math.min(2, realChapters.length);
}

function findModuleForChapter(chapter, modules) {
    const chapterNorm = normalizeModuleMatchText(chapter?.title);
    if (!chapterNorm || !Array.isArray(modules)) return null;
    let best = null;
    let bestScore = 0;
    modules.forEach((mod, index) => {
        const fields = [mod.level3, mod.level2, mod.level1].map(normalizeModuleMatchText);
        let score = 0;
        fields.forEach((field, fieldIndex) => {
            if (!field) return;
            if (chapterNorm === field) score = Math.max(score, fieldIndex === 0 ? 100 : 70);
            else if (chapterNorm.includes(field) || field.includes(chapterNorm)) {
                score = Math.max(score, fieldIndex === 0 ? 70 : 40);
            }
        });
        if (score > bestScore) {
            bestScore = score;
            best = { mod, index };
        }
    });
    return bestScore >= 40 ? best : null;
}

function annotateDocumentChaptersWithModules(chapters, moduleStructure) {
    const modules = Array.isArray(moduleStructure?.modules) ? moduleStructure.modules : [];
    if (!modules.length || !Array.isArray(chapters)) return chapters;

    return chapters.map(chapter => {
        const match = findModuleForChapter(chapter, modules);
        if (!match) return chapter;
        const { mod, index } = match;
        return {
            ...chapter,
            level1: chapter.level1 || mod.level1 || '',
            level2: chapter.level2 || mod.level2 || '',
            level3: chapter.level3 || mod.level3 || chapter.title,
            moduleIndex: Number.isInteger(chapter.moduleIndex) ? chapter.moduleIndex : index,
            moduleMatched: true
        };
    });
}

function parseModuleRecognitionContent(reply) {
    if (!reply) return null;
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed?.modules)
        ? parsed
        : { modules: [], totalEstimated: 0, summary: 'No modules returned' };
}

function normalizeModuleData(moduleData) {
    const modules = Array.isArray(moduleData?.modules) ? moduleData.modules : [];
    const cleanedModules = modules
        .filter(m => m && (m.level1 || m.level2 || m.level3))
        .map(m => ({
            ...m,
            level1: String(m.level1 || '').trim(),
            level2: String(m.level2 || '').trim(),
            level3: String(m.level3 || m.level2 || '').trim(),
            businessObjects: Array.isArray(m.businessObjects) ? m.businessObjects.filter(Boolean).slice(0, 12) : [],
            triggerTypes: Array.isArray(m.triggerTypes) ? m.triggerTypes.filter(Boolean).slice(0, 6) : [],
            estimatedFunctions: Number(m.estimatedFunctions ?? m.estimatedFunctionPoints) || 5
        }))
        .filter(m => m.level3);

    return {
        ...moduleData,
        modules: cleanedModules,
        totalEstimated: cleanedModules.reduce((sum, m) => sum + (Number(m.estimatedFunctions) || 0), 0),
        summary: moduleData?.summary || ''
    };
}

async function retryCompactModuleRecognition({ documentContent, modelName, methodLabel }) {
    const compactPrompt = `你是${methodLabel}需求模块识别专家。请从需求文档中识别“页面/面板/流程/业务域”级三级模块，输出紧凑 JSON。

硬性规则：
1. 只输出 JSON，不要解释。
2. modules 数量控制在 15~25 个，最多 30 个。
3. 不要把筛选条件、搜索、排序、公式、推荐规则步骤、字段说明拆成模块。
4. level3 必须是页面/面板/流程级名称，例如“站址推荐管理”“GIS地图管理”“仿真验证管理”。
5. 每个模块的 businessObjects 最多 4 个，triggerTypes 最多 3 个。

JSON 格式：
{"modules":[{"level1":"1 规划全局概览","level2":"1.1 规划全局概览","level3":"1.1.1 左侧信息面板管理","businessObjects":["问题区域"],"estimatedFunctions":6,"triggerTypes":["用户触发"]}],"totalEstimated":100,"summary":"..."}`;

    const completion = await callAIWithRetry({
        messages: [
            { role: 'system', content: compactPrompt },
            { role: 'user', content: `请识别以下文档的三级模块结构：\n\n${documentContent}` }
        ],
        model: modelName,
        temperature: 0.05,
        max_tokens: 12000
    });

    return parseModuleRecognitionContent(completion?.choices?.[0]?.message?.content);
}

function build5GPlanningFallbackModules(documentContent) {
    const text = String(documentContent || '');
    if (!/5G|基站|站址推荐|GIS地图|仿真验证/.test(text)) {
        return { modules: [], totalEstimated: 0, summary: 'No local fallback matched' };
    }

    const modules = [
        ['1 规划全局概览', '1.1 规划全局概览', '1.1.1 左侧信息面板管理', ['问题区域', '推荐站址', '仿真站址'], 8],
        ['1 规划全局概览', '1.1 规划全局概览', '1.1.2 中间GIS地图管理', ['GIS地图', '图层', '覆盖范围'], 10],
        ['1 规划全局概览', '1.1 规划全局概览', '1.1.3 右侧信息面板管理', ['规划进度', '评估指标', '问题闭环'], 6],
        ['1 规划全局概览', '1.1 规划全局概览', '1.1.4 智能体交互管理', ['智能体', '查询', '通知'], 5],
        ['2 问题聚合分析', '2.1 问题聚合分析', '2.1.1 统计概览与筛选管理', ['问题点', '问题区域', '筛选条件'], 6],
        ['2 问题聚合分析', '2.1 问题聚合分析', '2.1.2 问题区域与问题点列表管理', ['问题区域', '问题点', '排序规则'], 8],
        ['2 问题聚合分析', '2.1 问题聚合分析', '2.1.3 GIS地图与区域调整管理', ['GIS地图', '区域轮廓', '基站图层'], 10],
        ['2 问题聚合分析', '2.1 问题聚合分析', '2.1.4 智能体交互参数调整', ['智能体', '查询', '聚合参数'], 5],
        ['3 规划方案生成', '3.1 规划方案生成', '3.1.1 顶部栏与方案进度管理', ['方案列表', '筛选条件', '生成进度'], 6],
        ['3 规划方案生成', '3.1 规划方案生成', '3.1.2 站址推荐管理', ['推荐站址', '站址确认', '站址地图'], 12],
        ['3 规划方案生成', '3.1 规划方案生成', '3.1.3 工参推荐管理', ['方位角', '扇区', '工参校准'], 10],
        ['3 规划方案生成', '3.1 规划方案生成', '3.1.4 仿真验证管理', ['仿真任务', '覆盖率', '校准过程'], 8],
        ['3 规划方案生成', '3.1 规划方案生成', '3.1.5 方案确认管理', ['方案数据', '方案确认', '人工审核'], 5],
        ['3 规划方案生成', '3.1 规划方案生成', '3.1.6 智能体交互管理', ['智能体', '操作命令', '状态通知'], 6],
        ['4 规划评估与闭环', '4.1 规划评估与闭环', '4.1.1 价值评估管理', ['评分统计', '优先建设标记', 'GIS价值地图'], 10],
        ['4 规划评估与闭环', '4.1 规划评估与闭环', '4.1.2 闭环评估管理', ['闭环率', '建设状态', '偏差分析'], 10],
        ['4 规划评估与闭环', '4.1 规划评估与闭环', '4.1.3 智能体交互管理', ['智能体', '查询', '通知'], 5],
        ['5 智能体交互与调度', '5.1 智能体交互与调度', '5.1.1 智能体首页与流程调度', ['智能体首页', '一键规划任务', '全流程执行'], 8],
        ['5 智能体交互与调度', '5.1 智能体交互与调度', '5.1.2 对话式交互与报告生成', ['对话交互', '规划报告', '规划回放'], 7],
        ['5 智能体交互与调度', '5.1 智能体交互与调度', '5.1.3 批量处理管理', ['批量规划任务', '队列管理', '对比分析'], 6]
    ].map(([level1, level2, level3, businessObjects, estimatedFunctions]) => ({
        level1,
        level2,
        level3,
        businessObjects,
        estimatedFunctions,
        triggerTypes: ['用户触发']
    }));

    return {
        modules,
        totalEstimated: modules.reduce((sum, m) => sum + m.estimatedFunctions, 0),
        summary: '本地兜底生成的5G基站规划模块骨架',
        fallback: true
    };
}

async function recoverModuleData({ moduleData, documentContent, modelName, methodLabel }) {
    let recovered = normalizeModuleData(moduleData);
    if (recovered.modules.length > 0 && recovered.modules.length <= 30) {
        return collapseOverDetailedModules(recovered);
    }

    try {
        const reason = recovered.modules.length > 30
            ? `过细(${recovered.modules.length}个)`
            : '为空';
        console.warn(`${methodLabel}模块识别${reason}，尝试紧凑重试...`);
        recovered = normalizeModuleData(await retryCompactModuleRecognition({ documentContent, modelName, methodLabel }));
    } catch (retryErr) {
        console.warn(`${methodLabel}模块紧凑重试失败:`, retryErr.message);
    }
    if (recovered.modules.length > 0 && recovered.modules.length <= 30) {
        return collapseOverDetailedModules(recovered);
    }

    const fallback = normalizeModuleData(build5GPlanningFallbackModules(documentContent));
    if (fallback.modules.length > 0) {
        console.warn(`${methodLabel}模块识别仍${recovered.modules.length > 30 ? `过细(${recovered.modules.length}个)` : '为空'}，使用本地模块兜底。`);
        return collapseOverDetailedModules(fallback);
    }

    return collapseOverDetailedModules(recovered);
}

function splitIntoChapters(text) {
    if (!text) return [];

    const lines = text.split('\n');
    const chapters = [];
    const MAX_MARKDOWN_HEADING_LENGTH = 120;

    const parseMarkdownHeading = (line) => {
        const match = String(line || '').match(/^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
        if (!match) return null;
        const title = match[2].trim();
        if (title.length < 2 || title.length > MAX_MARKDOWN_HEADING_LENGTH) return null;
        return {
            title,
            depth: Math.min(match[1].length, 3),
            markdownLevel: match[1].length
        };
    };

    // 各类标题模式 + 对应最大长度
    const HEADING_RULES = [
        { pattern: /^第[一二三四五六七八九十百千\d]+[章节篇]\s*.+/, maxLen: 60 },
        { pattern: /^[（(][一二三四五六七八九十\d]+[）)]\s*.+/, maxLen: 40 },
        { pattern: /^[一二三四五六七八九十]+[、．.]\s*.+/, maxLen: 35 },
        { pattern: /^\d+(\.\d+)*[\.、\s]\s*[^\d\s].+/, maxLen: 30 },
    ];

    // 以这些标点结尾 → 正文句子，不是标题
    const BODY_ENDINGS = /[\u3002\uff0c\u3001\uff1b\uff1a\u2026\uff01\uff1f,;:!?)\uff09\u300b\u300f\u201d\u2019]$/;

    // 正文特征词 → 包含则不是标题
    const BODY_INDICATORS = /应当|应该|需要|具体为|如下[\uff1a:]|以下[\uff1a:]|包括[\uff1a:]|说明[\uff1a:]|要求[\uff1a:]|其中[\uff0c,]|通过.*实现|由于|由此|因此|则需|不得|不应|不能|禁止|本[章节]介绍|本[章节]描述/;

    // 判断是否为章节标题
    function isHeading(line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length < 2) return false;
        // Markdown 的 # / ## / ### 是显式结构标记，优先级高于正文特征过滤。
        // 代码反向需求直接生成 Markdown，不经过 Mammoth，必须原生识别。
        if (parseMarkdownHeading(trimmed)) return true;
        // Requirement headings commonly carry a trailing workload/count marker,
        // e.g. "1.1 元数据采集（578）". A closing parenthesis normally looks
        // sentence-like, but must not disqualify this numbered-heading form.
        const hasTrailingCount = /[（(]\s*\d+\s*[）)]$/.test(trimmed);
        if (BODY_ENDINGS.test(trimmed) && !hasTrailingCount) return false;
        if (BODY_INDICATORS.test(trimmed)) return false;
        for (const { pattern, maxLen } of HEADING_RULES) {
            if (trimmed.length <= maxLen && pattern.test(trimmed)) return true;
        }
        return false;
    }

    // 第一遍：找所有候选标题行位置
    const rawCandidatePositions = [];
    for (let i = 0; i < lines.length; i++) {
        if (isHeading(lines[i])) rawCandidatePositions.push(i);
    }
    // Mammoth can emit both TOC entries and body headings as plain text. A TOC
    // entry followed by explanatory text may otherwise survive the content
    // length filter and become a duplicate/out-of-order chapter.
    const candidatePositions = keepLastDuplicateHeadingPositions(lines, rawCandidatePositions);

    if (candidatePositions.length === 0) {
        return [{ title: '全文', content: text, charCount: text.length, selected: true }];
    }

    // 第二遍：过滤「内容过短」的假标题（两标题间内容<30字 → 是列表项）
    const MIN_CHAPTER_CONTENT = 30;
    const headingPositions = [];

    for (let i = 0; i < candidatePositions.length; i++) {
        const curPos = candidatePositions[i];
        const nextPos = (i < candidatePositions.length - 1)
            ? candidatePositions[i + 1]
            : lines.length;
        const contentBetween = lines.slice(curPos + 1, nextPos)
            .join('').replace(/\s/g, '').length;
        if (contentBetween >= MIN_CHAPTER_CONTENT) {
            headingPositions.push(curPos);
        }
    }

    if (headingPositions.length === 0) {
        return [{ title: '全文', content: text, charCount: text.length, selected: true }];
    }

    // 普通文本标题过多时(>20)，只保留顶层标题。
    // 显式 Markdown 标题可靠性更高，60个以内保留原层级，避免把代码反向需求
    // 中几十个 ### 功能条目重新合并成一个大章节。
    let finalPositions = headingPositions;
    const markdownHeadingCount = headingPositions.filter(pos => parseMarkdownHeading(lines[pos])).length;
    const preserveMarkdownOutline = markdownHeadingCount === headingPositions.length
        && markdownHeadingCount <= 60;
    if (headingPositions.length > 20 && !preserveMarkdownOutline) {
        const topLevel = headingPositions.filter(pos => {
            const t = lines[pos].trim();
            const markdownHeading = parseMarkdownHeading(t);
            if (markdownHeading) return markdownHeading.markdownLevel <= 2;
            return /^第[一二三四五六七八九十百千\d]+[章节篇]/.test(t)
                || /^[（(][一二三四五六七八九十\d]+[）)]/.test(t)
                || /^[一二三四五六七八九十]+[、．.]/.test(t)
                || /^\d+[.、\s]\s*[^\d\s]/.test(t);
        });
        if (topLevel.length >= 2 && topLevel.length <= 20) {
            finalPositions = topLevel;
            console.log(`📑 章节过多(${headingPositions.length})，已收敛到 ${finalPositions.length} 个顶层章节`);
        }
    }

    // 文档开头到第一个标题之间的内容
    // Intro text before the first detected heading is context, not a selectable chapter.

    // 按最终标题位置分章，同时计算 level1/level2/level3
    // 维护滚动的每层当前标题文本
    let currentL1 = '';
    let currentL2 = '';
    let currentL3 = '';

    for (let i = 0; i < finalPositions.length; i++) {
        const startLine = finalPositions[i];
        const endLine = (i < finalPositions.length - 1) ? finalPositions[i + 1] : lines.length;
        const rawTitle = lines[startLine].trim();
        const markdownHeading = parseMarkdownHeading(rawTitle);
        const title = markdownHeading?.title || rawTitle;
        const content = lines.slice(startLine, endLine).join('\n').trim();

        // 根据编号层级更新滚动层级状态
        const depth = markdownHeading?.depth || extractHeadingLevel(title).depth;
        if (depth === 1) {
            currentL1 = title;
            currentL2 = '';
            currentL3 = '';
        } else if (depth === 2) {
            currentL2 = title;
            currentL3 = '';
        } else if (depth === 3) {
            currentL3 = title;
        }
        // depth===0 (非数字编号) 不更新层级

        chapters.push({
            title,
            content,
            charCount: content.length,
            selected: content.length > 50 && !isReferenceOnlyChapterTitle(title),
            referenceOnly: isReferenceOnlyChapterTitle(title),
            level1: currentL1,
            level2: currentL2,
            level3: currentL3,
            headingDepth: depth
        });
    }

    return chapters;
}

app.post('/api/split-chapters', (req, res) => {
    try {
        const { documentContent, moduleStructure: rawModuleStructure = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        let moduleStructure = collapseOverDetailedModules(rawModuleStructure);
        if (moduleStructure?.modules?.length > 30) {
            const fallbackStructure = normalizeModuleData(build5GPlanningFallbackModules(documentContent));
            if (fallbackStructure.modules.length > 0) {
                moduleStructure = fallbackStructure;
                console.log(`   replaced over-detailed chapter scaffold with fallback modules: ${rawModuleStructure?.modules?.length || 0} -> ${moduleStructure.modules.length}`);
            }
        }
        const documentChapters = splitIntoChapters(documentContent);
        const moduleAlignedChapters = splitIntoModuleAlignedChapters(documentContent, moduleStructure);
        // The selectable chapter list must reflect the source document's headings.
        // AI-recognized modules are an extraction scaffold, not a replacement table
        // of contents: their fuzzy anchors can point several modules at the same
        // paragraph and produce repeated, synthetic "chapters". Only fall back to
        // the scaffold when the source document has no usable heading structure.
        const useDocumentChapters = isUsableDocumentChapterSplit(documentChapters);
        let moduleScaffoldChapters = useDocumentChapters
            ? null
            : (moduleAlignedChapters || buildModuleScaffoldChapters(documentContent, moduleStructure));
        if (hasExcessiveSyntheticChapterOverlap(moduleScaffoldChapters, documentContent)) {
            console.warn('   module scaffold chapters overlap excessively; falling back to a single full-document chapter');
            moduleScaffoldChapters = null;
        }
        const chapters = useDocumentChapters
            ? annotateDocumentChaptersWithModules(documentChapters, moduleStructure)
            : (moduleScaffoldChapters || documentChapters);
        const moduleAligned = Boolean(moduleScaffoldChapters);
        console.log(`📑 章节识别完成: 共 ${chapters.length} 个章节`);
        if (useDocumentChapters) {
            console.log('   document-split: using source chapter boundaries');
        }
        if (moduleScaffoldChapters) {
            console.log(`   module-aligned: ${chapters.length}/${moduleStructure?.modules?.length || 0}`);
        }
        chapters.forEach((ch, i) => {
            console.log(`   ${i + 1}. ${ch.title} (${ch.charCount}字${ch.selected ? '' : ', 跳过'})`);
        });

        res.json({ success: true, chapters, count: chapters.length, moduleAligned });
    } catch (error) {
        console.error('章节识别失败:', error);
        res.status(500).json({ error: '章节识别失败: ' + error.message });
    }
});

// ═══════════════════════ 功能过程提取（阶段1） ═══════════════════════

app.post('/api/extract-functions', async (req, res) => {
    try {
        const { documentContent, chapterName = '', userGuidelines = '', userConfig = null, extractionMode = 'precise', moduleStructure = null, quantityPlan = null, targetCount = 0 } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }
        if (extractionMode === 'quantity' && (Number(targetCount) || 0) <= 0) {
            return res.json({
                success: true,
                functionList: '',
                functions: [],
                count: 0,
                skipped: true
            });
        }

        const chapterInfo = chapterName ? `【${chapterName}】章节的` : '';
        const modeLabel = extractionMode === 'quantity' ? '数量优先' : '精准';
        console.log(`📋 开始提取功能过程列表${chapterName ? '（' + chapterName + '）' : ''}（${modeLabel}模式）...`);
        const modelName = getModelName(userConfig);
        const requestedModel = userConfig?.model || null;

        const isV4Flash = isSenseNovaV4Model(modelName, requestedModel);
        const activePrompt = getFunctionExtractionPrompt(modelName, extractionMode, requestedModel);

        // 构建理解上下文（如果有文档理解结果）
        let understandingHint = '';
        const understanding = req.body.understanding || null;
        if (understanding) {
            const parts = [];

            // 1. 核心模块和功能预估
            if (understanding.coreModules && understanding.coreModules.length > 0) {
                const modulesList = understanding.coreModules.map(m => {
                    const funcs = m.estimatedFunctions || [];
                    const funcList = Array.isArray(funcs) && funcs.length > 0 && typeof funcs[0] === 'object'
                        ? funcs.map(f => f.functionName).join('、')
                        : (Array.isArray(funcs) ? funcs.join('、') : '');
                    return `- ${m.moduleName}: ${funcList}`;
                }).join('\n');
                parts.push(`【功能模块参考】请确保每个模块的功能都被提取：\n${modulesList}`);
            }

            // 2. 业务实体（含生命周期 → 状态变迁功能）
            if (understanding.businessEntities && understanding.businessEntities.length > 0) {
                const entityList = understanding.businessEntities.map(e => {
                    let desc = `- ${e.entityName}`;
                    if (e.hasLifecycle && e.lifecycleStates && e.lifecycleStates.length > 0) {
                        desc += `（生命周期：${e.lifecycleStates.join('→')}，每个状态变迁都是独立功能过程）`;
                    }
                    if (e.crudOperations && e.crudOperations.length > 0) {
                        desc += `（需覆盖操作：${e.crudOperations.join('、')}）`;
                    }
                    return desc;
                }).join('\n');
                parts.push(`【业务实体参考】以下每个业务实体的相关操作都必须提取为独立功能过程：\n${entityList}`);
            }

            // 3. KPI指标体系 → 指标计算/采集功能
            if (understanding.kpiAndMetrics && understanding.kpiAndMetrics.length > 0) {
                const metricsList = understanding.kpiAndMetrics.map(m => {
                    let desc = `- ${m.metricName}`;
                    if (m.relatedEntity) desc += `（关联：${m.relatedEntity}）`;
                    if (m.hasThreshold) desc += `（有阈值判断，需拆出阈值检测和预警通知两个功能）`;
                    return desc;
                }).join('\n');
                parts.push(`【KPI指标体系】以下每个指标的采集/计算/达标率统计都可能是独立功能过程：\n${metricsList}`);
            }

            // 4. 汇总/报表场景
            if (understanding.aggregationAndReports && understanding.aggregationAndReports.length > 0) {
                const aggList = understanding.aggregationAndReports.map(a => {
                    const dims = a.dimensions ? a.dimensions.join('、') : '';
                    const metrics = a.metrics ? a.metrics.join('、') : '';
                    return `- ${a.name}（类型：${a.type}，维度：${dims}，指标：${metrics}，触发：${a.triggerType || ''}）`;
                }).join('\n');
                parts.push(`【汇总/报表需求】以下每个汇总/报表都是独立功能过程，不同维度×不同指标需分别拆出：\n${aggList}`);
            }

            // 5. 业务规则
            if (understanding.businessRules && understanding.businessRules.length > 0) {
                const rulesList = understanding.businessRules.map(r => {
                    return `- ${r.ruleName}：${r.ruleDescription}（触发条件：${r.triggerCondition || ''}→动作：${r.resultAction || ''}）`;
                }).join('\n');
                parts.push(`【业务规则】以下每条规则可能对应1-2个独立功能过程：\n${rulesList}`);
            }

            // 6. 外部接口
            if (understanding.externalInterfaces && understanding.externalInterfaces.length > 0) {
                const ifList = understanding.externalInterfaces.map(i => {
                    return `- ${i.interfaceName}：${i.direction}（对接：${i.externalSystem}，数据：${i.dataDescription}）`;
                }).join('\n');
                parts.push(`【外部接口】每个接口方向是独立功能过程：\n${ifList}`);
            }

            // 7. 功能数量预估
            const total = understanding.totalEstimatedFunctions || '未知';
            const breakdown = understanding.functionBreakdown || {};
            const breakdownStr = Object.entries(breakdown)
                .filter(([k, v]) => v > 0)
                .map(([k, v]) => `${k}: ${v}`)
                .join('、');
            parts.push(`预估总功能过程数量：${total}${breakdownStr ? '（' + breakdownStr + '）' : ''}`);

            if (parts.length > 0) {
                understandingHint = '\n\n' + parts.join('\n\n');
            }
        }

        // 构建模块脚手架提示（来自三级模块识别结果）
        let moduleScaffoldHint = '';
        if (moduleStructure && moduleStructure.modules && moduleStructure.modules.length > 0) {
            const planMap = {};
            if (Array.isArray(quantityPlan)) {
                quantityPlan.forEach(p => {
                    const key = (p.level3 || '').trim();
                    if (key) planMap[key] = Number(p.target) || 0;
                });
            }
            const activeScaffoldModules = getRelevantModulesForChapter(moduleStructure.modules, chapterName);
            const activeScaffoldKeys = new Set(activeScaffoldModules.map(m => (m.level3 || '').trim()).filter(Boolean));
            const scaffoldList = activeScaffoldModules.map(m => {
                const objs = (m.businessObjects || []).join('、');
                const triggers = (m.triggerTypes || []).join('、');
                const hasPlan = Object.prototype.hasOwnProperty.call(planMap, (m.level3 || '').trim());
                const targetText = hasPlan
                    ? (planMap[(m.level3 || '').trim()] > 0 ? `，本轮目标 ${planMap[(m.level3 || '').trim()]} 个` : '，本轮目标 0 个（明确跳过）')
                    : `，预估 ~${m.estimatedFunctions || '?'} 个功能过程`;
                return `- ${m.level1} > ${m.level2} > ${m.level3}：业务对象[${objs}]，触发类型[${triggers}]${targetText}`;
            }).join('\n');
            const skippedList = Array.isArray(quantityPlan)
                ? quantityPlan
                    .filter(p => (Number(p.target) || 0) <= 0)
                    .filter(p => activeScaffoldKeys.size === 0 || activeScaffoldKeys.has((p.level3 || '').trim()))
                    .map(p => p.level3)
                    .filter(Boolean)
                : [];
            moduleScaffoldHint = extractionMode === 'quantity'
                ? `\n\n【三级模块脚手架】以下是文档识别到的三级模块结构，并包含本轮数量规划。目标大于0的模块必须尽量覆盖；目标为0的模块是用户可见的明确跳过项，不要从这些模块中提取功能过程。\n${scaffoldList}${skippedList.length > 0 ? `\n\n【本轮明确跳过的模块】${skippedList.join('、')}` : ''}`
                : `\n\n【三级模块脚手架】以下是文档识别到的三级模块结构，请确保每个模块的功能都被提取，不要遗漏任何模块：\n${scaffoldList}`;
        }

        let userPrompt;
        if (extractionMode === 'quantity' && targetCount > 0) {
            userPrompt = `请从以下${chapterInfo}需求文档中按目标数量提取功能过程列表：\n\n${documentContent}${understandingHint}${moduleScaffoldHint}`;
            userPrompt += `\n\n【数量优先执行策略】\n`;
            userPrompt += `- 本次目标：输出约 ${targetCount} 个功能过程，上下浮动不超过5%。\n`;
            userPrompt += `- 如果文档可拆出的功能明显多于目标数：请筛选业务主干、核心接口、关键数据处理、主要查询统计、关键自动化任务；忽略低频、重复、边缘、纯展示、可由主流程覆盖的功能。\n`;
            userPrompt += `- 如果文档可拆出的功能少于目标数：请在不虚构业务的前提下，按业务对象、CRUD、状态流转、查询统计、导入导出、定时任务、外部接口等维度合理扩展。\n`;
            userPrompt += `- 目标少时不要追求覆盖所有细节；目标多时可以展开细粒度功能，但禁止无意义凑数或重复改名。\n`;
            userPrompt += `- 输出数量必须优先服从本次目标，而不是“宁可多提取”。`;
        } else {
            userPrompt = `请从以下${chapterInfo}需求文档中提取所有功能过程列表：\n\n${documentContent}${understandingHint}${moduleScaffoldHint}`;
        }
        if (userGuidelines) {
            userPrompt += `\n\n用户特殊要求：${userGuidelines}`;
        }
        if (extractionMode === 'quantity' && targetCount > 0) {
            userPrompt += `\n\n**再次确认：本章节只输出约 ${targetCount} 个功能过程。目标少则筛选精简，目标多则合理扩展。**`;
        }
        if (isV4Flash) {
            userPrompt += `\n\n【V4 Flash 专用校准】\n- 你必须优先避免重复和过细拆分。\n- 同一业务对象的配置、新增、修改、删除、查看列表，如果业务目的相同，应合并为一个维护/配置/查询功能过程。\n- 不要为了接近数量目标而重复输出近似功能过程；功能过程名称必须唯一。\n- 如果无法在不重复的前提下达到目标数量，允许低于目标。`;
        }

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: activePrompt },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 16000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            console.error('❌ AI返回空响应:', JSON.stringify(completion, null, 2).substring(0, 500));
            return res.status(500).json({ error: 'AI返回了空响应，请重试或切换模型' });
        }
        let reply = completion.choices[0].message.content;
        const extractedFunctions = extractFunctionsFromText(reply);
        let functions = qualifyFunctionNames(extractedFunctions, chapterName, moduleStructure);
        functions = dedupeFunctionsByName(functions);
        const namesAdjusted = functions.length !== extractedFunctions.length
            || functions.some((func, idx) => func.functionName !== extractedFunctions[idx]?.functionName);
        if (namesAdjusted) {
            console.log(`🏷️ 功能过程名称整理: ${extractedFunctions.length} 个候选 → ${functions.length} 个唯一完整名称`);
            reply = buildFunctionListText(functions);
        }
        if (extractionMode === 'quantity' && targetCount > 0) {
            const maxAllowed = Math.max(1, Math.ceil(targetCount * 1.05));
            if (functions.length > maxAllowed) {
                console.log(`✂️ 数量优先裁剪: ${functions.length} → ${maxAllowed}（目标 ${targetCount}）`);
                functions = functions.slice(0, maxAllowed);
                reply = buildFunctionListText(functions);
            }
        }

        console.log(`✅ 提取到 ${functions.length} 个功能过程`);
        res.json({
            success: true,
            functionList: reply,
            functions,
            count: functions.length
        });
    } catch (error) {
        console.error('功能过程提取失败:', error);
        res.status(500).json({ error: '功能过程提取失败: ' + error.message });
    }
});

// ═══════════════════════ COSMIC拆分（阶段2） ═══════════════════════

app.post('/api/cosmic-split', async (req, res) => {
    try {
        const { functionList, documentContent = '', userGuidelines = '', previousResults = [], batchIndex = 0, totalBatches = 1, userConfig = null, headingContext = null, functionLevelMap = null, useEnhancedExperience = false } = req.body;

        if (!functionList) {
            return res.status(400).json({ error: '缺少功能过程列表' });
        }

        console.log(`🔄 开始COSMIC拆分 (批次 ${batchIndex + 1}/${totalBatches})...${useEnhancedExperience ? ' [经验增强版]' : ''}`);
        const modelName = getModelName(userConfig);
        const requestedModel = userConfig?.model || null;
        const isV4Flash = isSenseNovaV4Model(modelName, requestedModel);
        const activeSplitPrompt = getCosmicSplitPrompt(modelName, requestedModel, { useEnhancedExperience });
        const completenessRule = getCosmicCompletenessRule(useEnhancedExperience);

        // 构建已完成的提示
        let userPrompt = '';
        if (previousResults.length > 0) {
            const completedFunctions = [...new Set(previousResults.map(r => r.functionalProcess).filter(Boolean))];
            userPrompt = `请对以下功能过程列表中【尚未拆分】的功能进行COSMIC拆分。

## 功能过程列表
${functionList}

## 已完成拆分的功能过程（共${completedFunctions.length}个，请勿重复）
${completedFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n')}

**请只拆分上面列表中未出现在"已完成"中的功能过程。**
**【重要】请严格按照上方功能过程列表的顺序进行拆分输出，不要打乱顺序。列表的顺序对应文档的章节顺序。**
**【必须遵守】输出表格中的"功能过程"名称必须与上方列表完全一致，不得自行修改、合并或重命名。**
${completenessRule}
输出表格必须包含"功能描述"列，且只在每个功能过程的E行填写一段流程型描述。
只输出Markdown表格，不要其他说明。`;
        } else {
            userPrompt = `请对以下功能过程进行COSMIC拆分：\n\n${functionList}\n\n**【重要】请严格按照上方功能过程列表的先后顺序进行拆分输出，不要打乱顺序。列表的顺序对应文档的章节/目录顺序，输出结果必须保持一致。**\n**【必须遵守】输出表格中的"功能过程"名称必须与上方列表完全一致，不得自行修改、合并或重命名。**\n${completenessRule}\n输出表格必须包含"功能描述"列，且只在每个功能过程的E行填写一段流程型描述。`;
        }

        if (documentContent) {
            userPrompt += `\n\n参考文档内容：\n${documentContent.substring(0, 6000)}`;
        }
        if (userGuidelines) {
            userPrompt += `\n\n用户特殊要求：${userGuidelines}`;
        }

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: activeSplitPrompt },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 32000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            console.error('❌ AI返回空响应:', JSON.stringify(completion, null, 2).substring(0, 500));
            return res.status(500).json({ error: 'AI返回了空响应，请重试或切换模型' });
        }
        let reply = completion.choices[0].message.content;

        // V3.2 截断检测与自动续传
        const finishReason = completion.choices[0].finish_reason;
        if (finishReason === 'length') {
            console.warn('⚠️ COSMIC拆分输出被截断，尝试续传...');
            try {
                const continueCompletion = await callAIWithRetry({
                    messages: [
                        { role: 'system', content: activeSplitPrompt },
                        { role: 'user', content: userPrompt },
                        { role: 'assistant', content: reply },
                        { role: 'user', content: '你的输出被截断了，请从上次中断的位置继续输出剩余的Markdown表格行。不要重复已输出的内容，直接续写表格。' }
                    ],
                    model: modelName,
                    temperature: 0.3,
                    max_tokens: 16000
                });
                if (continueCompletion?.choices?.[0]?.message?.content) {
                    reply += '\n' + continueCompletion.choices[0].message.content;
                    console.log('✅ 续传成功，已拼接后续内容');
                }
            } catch (continueErr) {
                console.warn('⚠️ 续传失败，使用已有内容:', continueErr.message);
            }
        }

        // 从functionList中提取标准功能过程名作为对齐参考
        const refFunctions = extractFunctionsFromText(functionList);
        const refNames = refFunctions.map(f => f.functionName).filter(Boolean);
        // 解析表格数据（含名称对齐 + 按功能过程独立层级注入）
        let tableData = parseMarkdownTable(reply, refNames, headingContext, functionLevelMap, isV4Flash ? 'sequential' : 'fuzzy');
        tableData = applyEnhancedExperienceTemplatePruning(tableData, useEnhancedExperience);

        // ═══ V3.2 完整性校验：检测只有E行没有R/W/X的功能过程，自动补拆 ═══
        const incompleteFuncs = [];
        let currentProc = '';
        let hasR = false, hasW = false, hasX = false;
        for (const row of tableData) {
            if (row.dataMovementType === 'E' && row.functionalProcess) {
                if (currentProc && isCosmicProcessIncomplete(currentProc, hasR, hasW, hasX, useEnhancedExperience)) {
                    incompleteFuncs.push(currentProc);
                }
                currentProc = row.functionalProcess;
                hasR = false; hasW = false; hasX = false;
            } else if (row.dataMovementType === 'R') hasR = true;
            else if (row.dataMovementType === 'W') hasW = true;
            else if (row.dataMovementType === 'X') hasX = true;
        }
        if (currentProc && isCosmicProcessIncomplete(currentProc, hasR, hasW, hasX, useEnhancedExperience)) {
            incompleteFuncs.push(currentProc);
        }

        if (incompleteFuncs.length > 0) {
            console.warn(`⚠️ COSMIC拆分: 检测到 ${incompleteFuncs.length} 个功能过程缺少必要数据移动，逐个JSON补拆中...`);
            
            for (const funcName of incompleteFuncs) {
                try {
                    const { prompt: singleRepairPrompt, policy: repairPolicy } = buildCosmicRepairPrompt(funcName, useEnhancedExperience);

                    const singleRepair = await callAIWithRetry({
                        messages: [
                            { role: 'user', content: singleRepairPrompt }
                        ],
                        model: modelName,
                        temperature: 0.3,
                        max_tokens: 2000
                    });

                    if (singleRepair?.choices?.[0]?.message?.content) {
                        const repairReply = singleRepair.choices[0].message.content;
                        const jsonMatch = repairReply.match(/\[[\s\S]*\]/);
                        if (jsonMatch) {
                            try {
                                const parsed = JSON.parse(jsonMatch[0]);
                                if (Array.isArray(parsed) && parsed.length >= repairPolicy.minRows) {
                                    const hasE = parsed.some(r => r.dmt === 'E');
                                    const hasR = parsed.some(r => r.dmt === 'R');
                                    const hasW = parsed.some(r => r.dmt === 'W');
                                    const hasX = parsed.some(r => r.dmt === 'X');

                                    if (isCosmicRepairValid(parsed, repairPolicy)) {
                                        const origERow = tableData.find(r => r.dataMovementType === 'E' && r.functionalProcess && r.functionalProcess.toLowerCase().trim() === funcName.toLowerCase().trim());
                                        const fUser = origERow?.functionalUser || '';
                                        const tEvent = origERow?.triggerEvent || '';

                                        const repairData = parsed.map(item => ({
                                            functionalUser: fUser,
                                            triggerEvent: tEvent,
                                            functionalProcess: item.dmt === 'E' ? funcName : '',
                                            subProcessDesc: item.subProcess || '',
                                            dataMovementType: item.dmt,
                                            dataGroup: item.dataGroup || '待补充',
                                            dataAttributes: item.dataAttributes || '待补充',
                                            functionDescription: item.functionDescription || '',
                                            level1: origERow?.level1 || headingContext?.level1 || '',
                                            level2: origERow?.level2 || headingContext?.level2 || '',
                                            level3: origERow?.level3 || headingContext?.level3 || ''
                                        }));

                                        const cleanedData = [];
                                        let skipCurrent = false;
                                        for (const row of tableData) {
                                            if (row.dataMovementType === 'E' && row.functionalProcess) {
                                                skipCurrent = (row.functionalProcess.toLowerCase().trim() === funcName.toLowerCase().trim());
                                            }
                                            if (!skipCurrent) {
                                                cleanedData.push(row);
                                            }
                                        }
                                        tableData = [...cleanedData, ...repairData];
                                        console.log(`  ✅ "${funcName}" JSON补拆成功 (${repairData.length}行)`);
                                    } else {
                                        console.warn(`  ⚠️ "${funcName}" JSON补拆缺少类型 (E:${hasE} R:${hasR} W:${hasW} X:${hasX})`);
                                    }
                                }
                            } catch (jsonErr) {
                                console.warn(`  ⚠️ "${funcName}" JSON解析失败: ${jsonErr.message}`);
                            }
                        } else {
                            console.warn(`  ⚠️ "${funcName}" 补拆回复中未找到JSON数组`);
                        }
                    }
                } catch (singleErr) {
                    console.warn(`  ⚠️ "${funcName}" 补拆失败: ${singleErr.message}`);
                }
            }
        }

        // ═══ V4 专用：检测被AI跳过（未输出）的功能过程，自动补拆 ═══
        if (isV4Flash && refNames.length > 0) {
            const parsedProcessNamesNorm = new Set(
                tableData.filter(r => r.dataMovementType === 'E' && r.functionalProcess)
                    .map(r => normalizeProcessName(r.functionalProcess))
            );
            const skippedProcesses = refNames.filter(name =>
                !parsedProcessNamesNorm.has(normalizeProcessName(name))
            );

            if (skippedProcesses.length > 0) {
                console.warn(`⚠️ V4检测: AI跳过了 ${skippedProcesses.length} 个功能过程，自动补拆: ${skippedProcesses.join('、')}`);

                for (const funcName of skippedProcesses) {
                    try {
                        const { prompt: v4RepairPrompt, policy: repairPolicy } = buildCosmicRepairPrompt(funcName, useEnhancedExperience);

                        const v4Repair = await callAIWithRetry({
                            messages: [{ role: 'user', content: v4RepairPrompt }],
                            model: modelName,
                            temperature: 0.3,
                            max_tokens: 2000
                        });

                        if (v4Repair?.choices?.[0]?.message?.content) {
                            const jsonMatch = v4Repair.choices[0].message.content.match(/\[[\s\S]*\]/);
                            if (jsonMatch) {
                                const parsed = JSON.parse(jsonMatch[0]);
                                if (Array.isArray(parsed) && parsed.length >= repairPolicy.minRows && isCosmicRepairValid(parsed, repairPolicy)) {

                                    const refFunc = refFunctions.find(f => normalizeProcessName(f.functionName) === normalizeProcessName(funcName));
                                    const funcLevels = functionLevelMap?.[funcName] || {};

                                    const repairData = parsed.map(item => ({
                                        functionalUser: refFunc?.functionalUser || '',
                                        triggerEvent: refFunc?.triggerEvent || '',
                                        functionalProcess: item.dmt === 'E' ? funcName : '',
                                        subProcessDesc: item.subProcess || '',
                                        dataMovementType: item.dmt,
                                        dataGroup: item.dataGroup || '待补充',
                                        dataAttributes: item.dataAttributes || '待补充',
                                        functionDescription: item.functionDescription || '',
                                        level1: funcLevels.level1 || headingContext?.level1 || '',
                                        level2: funcLevels.level2 || headingContext?.level2 || '',
                                        level3: funcLevels.level3 || headingContext?.level3 || ''
                                    }));

                                    tableData = [...tableData, ...repairData];
                                    console.log(`  ✅ V4补拆跳过的 "${funcName}" 成功 (${repairData.length}行)`);
                                } else {
                                    console.warn(`  ⚠️ V4补拆 "${funcName}" JSON结构不完整`);
                                }
                            }
                        }
                    } catch (err) {
                        console.warn(`  ⚠️ V4补拆 "${funcName}" 失败: ${err.message}`);
                    }
                }
            }
        }

        tableData = applyEnhancedExperienceTemplatePruning(tableData, useEnhancedExperience);
        tableData = limitSubprocessesPerFunction(ensureFunctionDescriptions(tableData, refFunctions));

        console.log(`✅ COSMIC拆分完成，解析到 ${tableData.length} 条子过程` + (headingContext?.level1 ? `，层级: ${headingContext.level1}` : ''));
        res.json({
            success: true,
            reply,
            tableData,
            count: tableData.length
        });
    } catch (error) {
        console.error('COSMIC拆分失败:', error.message);
        console.error('错误详情:', error.status, error.code, JSON.stringify(error.error || {}).substring(0, 300));
        const errMsg = error.message || '未知错误';
        res.status(500).json({ error: 'COSMIC拆分失败: ' + errMsg });
    }
});

// ═══════════════════════ COSMIC分段拆分（批次模式） ═══════════════════════

app.post('/api/cosmic-split-batch', async (req, res) => {
    try {
        const {
            batchFunctions = [],       // 本批次要拆分的功能过程文本列表
            batchIndex = 0,            // 当前批次序号
            totalBatches = 1,          // 总批次数
            documentContent = '',      // 参考文档
            userGuidelines = '',       // 用户特殊要求
            previousResults = [],      // 之前批次已完成的结果（用于避免重复）
            userConfig = null,
            headingContext = null,     // 当前章节的层级上下文 {level1, level2, level3}（兼容旧版）
            functionLevelMap = null,   // 每个功能过程独立的层级映射 {funcName: {level1, level2, level3}}
            generateDescription = true, // 是否生成功能描述
            useEnhancedExperience = false // 是否使用COSMIC拆分经验增强版
        } = req.body;

        if (!batchFunctions || batchFunctions.length === 0) {
            return res.status(400).json({ error: '缺少本批次的功能过程列表' });
        }

        console.log(`🔄 COSMIC分段拆分 (批次 ${batchIndex + 1}/${totalBatches}): ${batchFunctions.length} 个功能过程...${generateDescription ? ' [含功能描述]' : ' [不含功能描述]'}${useEnhancedExperience ? ' [经验增强版]' : ''}`);
        const modelName = getModelName(userConfig);
        const requestedModel = userConfig?.model || null;
        const isV4Flash = isSenseNovaV4Model(modelName, requestedModel);
        const activeSplitPrompt = isV4Flash
            ? buildSensenovaV4CosmicSplitPrompt(generateDescription, useEnhancedExperience)
            : buildCosmicSplitPrompt(generateDescription, useEnhancedExperience);
        const completenessRule = getCosmicCompletenessRule(useEnhancedExperience);

        // 将本批次功能过程组成文本
        const batchFunctionText = batchFunctions.join('\n\n');

        // 提取本批次功能过程名列表（用于在 prompt 中明确强调"必须输出"）
        const batchFuncNames = batchFunctions.map(text => {
            const match = text.match(/##\s*功能过程[：:]\s*(.+)/);
            return match ? match[1].trim() : null;
        }).filter(Boolean);

        // 构建提示：当前批次强制要求放最前，"已完成"仅作参考背景
        // 关键：V3.2 更遵循接近末尾的强指令，因此把"必须输出"重申放在最后
        let userPrompt = `## ⚡ 本次任务（最高优先级，无论如何必须完整输出）
请对以下 **${batchFunctions.length} 个功能过程**进行COSMIC拆分（批次 ${batchIndex + 1}/${totalBatches}）：

${batchFunctionText}`;

        // 如果有之前批次的结果，作为"背景参考"提示，不再作为禁止条件
        if (previousResults.length > 0) {
            const completedFunctions = [...new Set(previousResults.map(r => r.functionalProcess).filter(Boolean))];
            if (completedFunctions.length > 0) {
                userPrompt += `\n\n## 背景参考（仅供避免完全相同子过程描述，不影响本批次输出）
以下功能过程在之前批次已拆分，它们的子过程描述名称请避免重复，但**不代表本批次功能过程可以跳过**：
${completedFunctions.slice(0, 25).map((f, i) => `${i + 1}. ${f}`).join('\n')}${completedFunctions.length > 25 ? `\n...（共${completedFunctions.length}个）` : ''}`;
            }
        }

        if (documentContent) {
            // 只传部分文档内容作为参考
            userPrompt += `\n\n参考文档内容（摘要）：\n${documentContent.substring(0, 4000)}`;
        }
        if (userGuidelines) {
            userPrompt += `\n\n用户特殊要求：${userGuidelines}`;
        }

        // 重申强制要求放在 prompt 最后，V3.2 更倾向遵循最近的指令
        userPrompt += `\n\n## ⚡ 再次确认（必须遵守）
- 上方列出的 **${batchFuncNames.length} 个功能过程必须全部出现在输出表格中**，一个都不能少
- 功能过程名称与"背景参考"中的名称相似也必须单独拆分，不能以"已完成"为由跳过
- **【最重要】${completenessRule} 绝对禁止只输出E行就跳到下一个功能过程！**
- **输出顺序：必须逐个功能过程完整输出（先输出功能A的E→R→W→X全部行，再输出功能B的E→R→W→X全部行），禁止先列出所有E行再补R/W/X！**
- 输出表格中的"功能过程"列名称必须与上方列表**完全一致**，不得修改`;

        if (generateDescription) {
            userPrompt += `\n- 输出表格必须包含"功能描述"列，且只在每个功能过程的E行填写一段流程型描述，不能简单堆叠字段`;
        }

        userPrompt += `\n- 只输出Markdown表格，不要其他说明`;

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: activeSplitPrompt },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 32000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            console.error('❌ AI返回空响应:', JSON.stringify(completion, null, 2).substring(0, 500));
            return res.status(500).json({ error: 'AI返回了空响应，请重试或切换模型' });
        }
        let reply = completion.choices[0].message.content;

        // V3.2 截断检测与自动续传
        const finishReason = completion.choices[0].finish_reason;
        if (finishReason === 'length') {
            console.warn(`⚠️ 批次 ${batchIndex + 1} 输出被截断，尝试续传...`);
            try {
                const continueCompletion = await callAIWithRetry({
                    messages: [
                        { role: 'system', content: activeSplitPrompt },
                        { role: 'user', content: userPrompt },
                        { role: 'assistant', content: reply },
                        { role: 'user', content: '你的输出被截断了，请从上次中断的位置继续输出剩余的Markdown表格行。不要重复已输出的内容，直接续写表格。' }
                    ],
                    model: modelName,
                    temperature: 0.3,
                    max_tokens: 16000
                });
                if (continueCompletion?.choices?.[0]?.message?.content) {
                    reply += '\n' + continueCompletion.choices[0].message.content;
                    console.log(`✅ 批次 ${batchIndex + 1} 续传成功`);
                }
            } catch (continueErr) {
                console.warn('⚠️ 续传失败，使用已有内容:', continueErr.message);
            }
        }

        // 从batchFunctions中提取标准功能过程名作为对齐参考
        const refFunctions = extractFunctionsFromText(batchFunctionText);
        const refNames = refFunctions.map(f => f.functionName).filter(Boolean);
        // 解析表格数据（含名称对齐 + 按功能过程独立层级注入）
        let tableData = parseMarkdownTable(reply, refNames, headingContext, functionLevelMap, isV4Flash ? 'sequential' : 'fuzzy');
        tableData = applyEnhancedExperienceTemplatePruning(tableData, useEnhancedExperience);

        // ═══ V3.2 完整性校验：检测只有E行没有R/W/X的功能过程，自动补拆 ═══
        const incompleteFuncs = [];
        let currentProc = '';
        let hasR = false, hasW = false, hasX = false;
        for (const row of tableData) {
            if (row.dataMovementType === 'E' && row.functionalProcess) {
                // 检查上一个功能过程是否完整
                if (currentProc && isCosmicProcessIncomplete(currentProc, hasR, hasW, hasX, useEnhancedExperience)) {
                    incompleteFuncs.push(currentProc);
                }
                currentProc = row.functionalProcess;
                hasR = false; hasW = false; hasX = false;
            } else if (row.dataMovementType === 'R') hasR = true;
            else if (row.dataMovementType === 'W') hasW = true;
            else if (row.dataMovementType === 'X') hasX = true;
        }
        // 检查最后一个功能过程
        if (currentProc && isCosmicProcessIncomplete(currentProc, hasR, hasW, hasX, useEnhancedExperience)) {
            incompleteFuncs.push(currentProc);
        }

        if (incompleteFuncs.length > 0) {
            console.warn(`⚠️ 批次 ${batchIndex + 1}: 检测到 ${incompleteFuncs.length} 个功能过程缺少必要数据移动，逐个JSON补拆中...`);
            
            for (const funcName of incompleteFuncs) {
                try {
                    // 使用JSON格式输出，彻底绕过Markdown表格解析问题
                    const { prompt: singleRepairPrompt, policy: repairPolicy } = buildCosmicRepairPrompt(funcName, useEnhancedExperience);

                    const singleRepair = await callAIWithRetry({
                        messages: [
                            { role: 'user', content: singleRepairPrompt }
                        ],
                        model: modelName,
                        temperature: 0.3,
                        max_tokens: 2000
                    });

                    if (singleRepair?.choices?.[0]?.message?.content) {
                        const repairReply = singleRepair.choices[0].message.content;
                        // 从回复中提取JSON数组
                        const jsonMatch = repairReply.match(/\[[\s\S]*\]/);
                        if (jsonMatch) {
                            try {
                                const parsed = JSON.parse(jsonMatch[0]);
                                if (Array.isArray(parsed) && parsed.length >= repairPolicy.minRows) {
                                    const hasE = parsed.some(r => r.dmt === 'E');
                                    const hasR = parsed.some(r => r.dmt === 'R');
                                    const hasW = parsed.some(r => r.dmt === 'W');
                                    const hasX = parsed.some(r => r.dmt === 'X');

                                    if (isCosmicRepairValid(parsed, repairPolicy)) {
                                        // 找到原E行的functionalUser和triggerEvent
                                        const origERow = tableData.find(r => r.dataMovementType === 'E' && r.functionalProcess && r.functionalProcess.toLowerCase().trim() === funcName.toLowerCase().trim());
                                        const fUser = origERow?.functionalUser || '';
                                        const tEvent = origERow?.triggerEvent || '';

                                        // 转换为tableData格式
                                        const repairData = parsed.map(item => ({
                                            functionalUser: fUser,
                                            triggerEvent: tEvent,
                                            functionalProcess: item.dmt === 'E' ? funcName : '',
                                            subProcessDesc: item.subProcess || '',
                                            dataMovementType: item.dmt,
                                            dataGroup: item.dataGroup || '待补充',
                                            dataAttributes: item.dataAttributes || '待补充',
                                            functionDescription: item.functionDescription || '',
                                            level1: origERow?.level1 || headingContext?.level1 || '',
                                            level2: origERow?.level2 || headingContext?.level2 || '',
                                            level3: origERow?.level3 || headingContext?.level3 || ''
                                        }));

                                        // 移除原来不完整的数据，替换为补拆结果
                                        const cleanedData = [];
                                        let skipCurrent = false;
                                        for (const row of tableData) {
                                            if (row.dataMovementType === 'E' && row.functionalProcess) {
                                                skipCurrent = (row.functionalProcess.toLowerCase().trim() === funcName.toLowerCase().trim());
                                            }
                                            if (!skipCurrent) {
                                                cleanedData.push(row);
                                            }
                                        }
                                        tableData = [...cleanedData, ...repairData];
                                        console.log(`  ✅ "${funcName}" JSON补拆成功 (${repairData.length}行)`);
                                    } else {
                                        console.warn(`  ⚠️ "${funcName}" JSON补拆缺少类型 (E:${hasE} R:${hasR} W:${hasW} X:${hasX})`);
                                    }
                                }
                            } catch (jsonErr) {
                                console.warn(`  ⚠️ "${funcName}" JSON解析失败: ${jsonErr.message}`);
                            }
                        } else {
                            console.warn(`  ⚠️ "${funcName}" 补拆回复中未找到JSON数组`);
                        }
                    }
                } catch (singleErr) {
                    console.warn(`  ⚠️ "${funcName}" 补拆失败: ${singleErr.message}`);
                }
            }
        }

        // ═══ V4 专用：检测被AI跳过（未输出）的功能过程，自动补拆 ═══
        if (isV4Flash && refNames.length > 0) {
            const parsedProcessNamesNorm = new Set(
                tableData.filter(r => r.dataMovementType === 'E' && r.functionalProcess)
                    .map(r => normalizeProcessName(r.functionalProcess))
            );
            const skippedProcesses = refNames.filter(name =>
                !parsedProcessNamesNorm.has(normalizeProcessName(name))
            );

            if (skippedProcesses.length > 0) {
                console.warn(`⚠️ V4检测 (批次${batchIndex + 1}): AI跳过了 ${skippedProcesses.length} 个功能过程，自动补拆: ${skippedProcesses.join('、')}`);

                // 从batchFunctions文本中解析每个功能过程的触发事件和功能用户
                const batchFuncInfoMap = {};
                for (const text of batchFunctions) {
                    const nameMatch = text.match(/##\s*功能过程[：:]\s*(.+)/);
                    const triggerMatch = text.match(/##\s*触发事件[：:]\s*(.+)/);
                    const userMatch = text.match(/##\s*功能用户[：:]\s*(.+)/);
                    if (nameMatch) {
                        batchFuncInfoMap[nameMatch[1].trim()] = {
                            triggerEvent: triggerMatch ? triggerMatch[1].trim() : '',
                            functionalUser: userMatch ? userMatch[1].trim() : ''
                        };
                    }
                }

                for (const funcName of skippedProcesses) {
                    try {
                        const { prompt: v4RepairPrompt, policy: repairPolicy } = buildCosmicRepairPrompt(funcName, useEnhancedExperience);

                        const v4Repair = await callAIWithRetry({
                            messages: [{ role: 'user', content: v4RepairPrompt }],
                            model: modelName,
                            temperature: 0.3,
                            max_tokens: 2000
                        });

                        if (v4Repair?.choices?.[0]?.message?.content) {
                            const jsonMatch = v4Repair.choices[0].message.content.match(/\[[\s\S]*\]/);
                            if (jsonMatch) {
                                const parsed = JSON.parse(jsonMatch[0]);
                                if (Array.isArray(parsed) && parsed.length >= repairPolicy.minRows && isCosmicRepairValid(parsed, repairPolicy)) {

                                    const funcInfo = batchFuncInfoMap[funcName] || {};
                                    const funcLevels = functionLevelMap?.[funcName] || {};

                                    const repairData = parsed.map(item => ({
                                        functionalUser: funcInfo.functionalUser || '',
                                        triggerEvent: funcInfo.triggerEvent || '',
                                        functionalProcess: item.dmt === 'E' ? funcName : '',
                                        subProcessDesc: item.subProcess || '',
                                        dataMovementType: item.dmt,
                                        dataGroup: item.dataGroup || '待补充',
                                        dataAttributes: item.dataAttributes || '待补充',
                                        functionDescription: item.functionDescription || '',
                                        level1: funcLevels.level1 || headingContext?.level1 || '',
                                        level2: funcLevels.level2 || headingContext?.level2 || '',
                                        level3: funcLevels.level3 || headingContext?.level3 || ''
                                    }));

                                    tableData = [...tableData, ...repairData];
                                    console.log(`  ✅ V4补拆跳过的 "${funcName}" 成功 (${repairData.length}行)`);
                                } else {
                                    console.warn(`  ⚠️ V4补拆 "${funcName}" JSON结构不完整`);
                                }
                            }
                        }
                    } catch (err) {
                        console.warn(`  ⚠️ V4补拆 "${funcName}" 失败: ${err.message}`);
                    }
                }
            }
        }

        tableData = applyEnhancedExperienceTemplatePruning(tableData, useEnhancedExperience);
        tableData = limitSubprocessesPerFunction(ensureFunctionDescriptions(tableData, refFunctions));

        console.log(`✅ 批次 ${batchIndex + 1}/${totalBatches} 完成: ${tableData.length} 条子过程` + (headingContext?.level1 ? `，层级: ${headingContext.level1}` : ''));
        res.json({
            success: true,
            reply,
            tableData,
            count: tableData.length,
            batchIndex,
            totalBatches
        });
    } catch (error) {
        console.error(`COSMIC分段拆分失败 (批次 ${req.body.batchIndex + 1}):`, error.message);
        const errMsg = error.message || '未知错误';
        res.status(500).json({ error: `COSMIC分段拆分失败 (批次 ${(req.body.batchIndex || 0) + 1}): ` + errMsg });
    }
});

// ═══════════════════════ 循环分析（一键完成模式） ═══════════════════════

app.post('/api/continue-analyze', async (req, res) => {
    try {
        const { documentContent, previousResults = [], round = 1, targetFunctions = 30, understanding = null, userGuidelines = '', userConfig = null, coverageVerification: prevCoverage = null, extractionMode = 'precise', useEnhancedExperience = false } = req.body;

        const completedFunctions = [...new Set(previousResults.map(r => r.functionalProcess).filter(Boolean))];
        const modelName = getModelName(userConfig);
        const isQuantityMode = extractionMode === 'quantity';
        const completenessRule = getCosmicCompletenessRule(useEnhancedExperience);

        // 仅数量优先模式才使用目标数量
        let effectiveTarget = null;
        if (isQuantityMode) {
            effectiveTarget = (understanding?.totalEstimatedFunctions && understanding.totalEstimatedFunctions > targetFunctions)
                ? Math.ceil(understanding.totalEstimatedFunctions * 1.1)
                : targetFunctions;
            if (effectiveTarget !== targetFunctions) {
                console.log(`📊 目标功能数已动态调整: ${targetFunctions} → ${effectiveTarget}（基于文档理解预估）`);
            }
        }

        // 构建理解上下文
        let understandingContext = '';
        if (understanding) {
            const ctxParts = [];

            // 模块功能
            const modules = understanding.coreModules || [];
            if (modules.length > 0) {
                const modulesList = modules.map(m => {
                    const functions = m.estimatedFunctions || [];
                    const funcList = Array.isArray(functions) && functions.length > 0 && typeof functions[0] === 'object'
                        ? functions.map(f => `${f.functionName} (${f.triggerType})`).join('、')
                        : (Array.isArray(functions) ? functions.join('、') : '');
                    return `- ${m.moduleName}: ${funcList}`;
                }).join('\n');
                ctxParts.push(`功能模块：\n${modulesList}`);
            }

            // 业务实体
            if (understanding.businessEntities && understanding.businessEntities.length > 0) {
                const entityList = understanding.businessEntities.map(e => {
                    let desc = `- ${e.entityName}`;
                    if (e.hasLifecycle && e.lifecycleStates) desc += `（状态：${e.lifecycleStates.join('→')}）`;
                    return desc;
                }).join('\n');
                ctxParts.push(`业务实体：\n${entityList}`);
            }

            // KPI指标
            if (understanding.kpiAndMetrics && understanding.kpiAndMetrics.length > 0) {
                const metricsList = understanding.kpiAndMetrics.map(m => `- ${m.metricName}${m.hasThreshold ? '（有阈值预警）' : ''}`).join('\n');
                ctxParts.push(`KPI指标（每个指标的采集/计算/预警可能是独立功能）：\n${metricsList}`);
            }

            // 汇总/报表
            if (understanding.aggregationAndReports && understanding.aggregationAndReports.length > 0) {
                const aggList = understanding.aggregationAndReports.map(a => `- ${a.name}（${a.type}，维度：${(a.dimensions || []).join('、')}）`).join('\n');
                ctxParts.push(`汇总/报表需求（每个都是独立功能）：\n${aggList}`);
            }

            // 业务规则
            if (understanding.businessRules && understanding.businessRules.length > 0) {
                const rulesList = understanding.businessRules.map(r => `- ${r.ruleName}：${r.ruleDescription}`).join('\n');
                ctxParts.push(`业务规则：\n${rulesList}`);
            }

            if (ctxParts.length > 0) {
                understandingContext = '\n\n【文档业务分析参考】\n' + ctxParts.join('\n');
            }
        }

        let userPrompt = '';
        if (round === 1) {
            let guidelinesContext = userGuidelines ? `\n用户特定要求：${userGuidelines}` : '';
            const targetHint = isQuantityMode
                ? `，目标约 ${effectiveTarget} 个功能过程`
                : `，请完整无遗漏地提取文档中所有功能过程，数量以文档实际内容为准`;
            userPrompt = `以下是功能文档内容：
${guidelinesContext}
${documentContent}
${understandingContext}

请对文档中的功能进行COSMIC拆分${targetHint}。

**输出格式**：只输出Markdown表格，不要额外说明。

|功能用户|触发事件|功能过程|子过程描述|数据移动类型|数据组|数据属性|功能描述|
|:---|:---|:---|:---|:---|:---|:---|:---|

${completenessRule} 功能描述只在E行填写。`;
        } else {
            // 关键修复：第2轮及之后也要传递文档内容，否则AI看不到原文
            // 构建遗漏功能提示（如果有覆盖度验证结果）
            let missedHint = '';
            if (prevCoverage?.missedFunctions?.length > 0) {
                const missedList = prevCoverage.missedFunctions.map((f, i) => {
                    if (typeof f === 'object') return `${i + 1}. ${f.functionName}（${f.reason || ''}）`;
                    return `${i + 1}. ${f}`;
                }).join('\n');
                missedHint = `\n\n## 覆盖度审查发现的遗漏功能（请优先补充这些！）：\n${missedList}`;
            }

            const targetRequirement = isQuantityMode
                ? `- 目标 ${effectiveTarget} 个功能过程，当前还差 ${Math.max(0, effectiveTarget - completedFunctions.length)} 个`
                : `- 请完整提取文档中所有尚未覆盖的功能过程，不设数量限制，以文档实际内容为准`;

            userPrompt = `继续分析文档中尚未拆分的功能过程。

## 原始需求文档（请仔细阅读，找出尚未拆分的功能）：
${documentContent ? documentContent.substring(0, 16000) : '（文档内容未提供）'}
${understandingContext}

## 已完成的功能过程（共${completedFunctions.length}个，请勿重复）：
${completedFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n')}
${missedHint}

## 要求
${targetRequirement}
- 请仔细逐段阅读文档，找出上面"已完成"列表中未覆盖的功能
- ${completenessRule}
- 输出表格必须包含"功能描述"列，功能描述只在E行填写，内容要描述业务处理过程
- 只输出Markdown表格，不要其他说明
- 如果文档中的所有功能确实都已完成，回复"[ALL_DONE]"`;
        }

        console.log(`📊 第 ${round} 轮分析，已完成 ${completedFunctions.length} 个功能过程...`);
        const activeSplitPrompt = getCosmicSplitPrompt(modelName, userConfig?.model || null, { useEnhancedExperience });

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: activeSplitPrompt },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 32000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            console.error('❌ AI返回空响应:', JSON.stringify(completion, null, 2).substring(0, 500));
            return res.status(500).json({ error: 'AI返回了空响应，请重试或切换模型' });
        }
        let reply = completion.choices[0].message.content;

        // V3.2 截断检测与自动续传
        if (completion.choices[0].finish_reason === 'length') {
            console.warn(`⚠️ 第 ${round} 轮输出被截断，尝试续传...`);
            try {
                const continueCompletion = await callAIWithRetry({
                    messages: [
                        { role: 'system', content: activeSplitPrompt },
                        { role: 'user', content: userPrompt },
                        { role: 'assistant', content: reply },
                        { role: 'user', content: '你的输出被截断了，请从上次中断的位置继续输出剩余的Markdown表格行。不要重复已输出的内容，直接续写表格。' }
                    ],
                    model: modelName,
                    temperature: 0.3,
                    max_tokens: 16000
                });
                if (continueCompletion?.choices?.[0]?.message?.content) {
                    reply += '\n' + continueCompletion.choices[0].message.content;
                    console.log('✅ 续传成功');
                }
            } catch (continueErr) {
                console.warn('⚠️ 续传失败:', continueErr.message);
            }
        }

        // 判断是否完成
        let isDone = false;
        if (reply.includes('[ALL_DONE]') || reply.includes('已完成') || reply.includes('全部拆分')) {
            isDone = true;
        }
        // V3.2 兼容：检测表格中是否有有效的 DMT 标记（E/R/W/X 及其变体）
        const hasValidTable = reply.includes('|') && (/\|\s*[ERWX]\s*\|/i.test(reply) || /\|\s*(Entry|Read|Write|Exit|输入|读|写|输出)\s*\|/i.test(reply));
        if (!hasValidTable && round > 1) isDone = true;
        // 仅数量优先模式才检查目标数
        if (isQuantityMode && effectiveTarget && completedFunctions.length >= effectiveTarget && !isDone) {
            console.log(`📊 已达到目标数 ${effectiveTarget}，但继续检查是否有遗漏...`);
        }
        if (round >= 15) isDone = true;
        if (reply.length < 100 && round > 1) isDone = true;

        // ═══ 自动覆盖度验证（分析即将结束时自动检查遗漏） ═══
        let coverageResult = null;
        if (isDone && round > 1 && documentContent) {
            const currentRoundData = parseMarkdownTable(reply);
            const currentRoundFunctions = [...new Set(currentRoundData.map(r => r.functionalProcess).filter(Boolean))];
            const allFunctions = [...new Set([...completedFunctions, ...currentRoundFunctions])];

            if (allFunctions.length > 0) {
                try {
                    console.log(`🔍 执行自动覆盖度验证（共 ${allFunctions.length} 个功能过程）...`);
                    const verifyCompletion = await callAIWithRetry({
                        messages: [
                            { role: 'system', content: COVERAGE_VERIFICATION_PROMPT },
                            { role: 'user', content: `## 原始需求文档：\n${documentContent}\n\n## 已提取的功能过程列表（共${allFunctions.length}个）：\n${allFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n请严格审查以上功能过程列表是否完整覆盖了需求文档中的所有功能。` }
                        ],
                        model: modelName,
                        temperature: 0.1,
                        max_tokens: 8000
                    });

                    if (verifyCompletion?.choices?.[0]?.message?.content) {
                        const verifyReply = verifyCompletion.choices[0].message.content;
                        try {
                            const jsonMatch = verifyReply.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                coverageResult = JSON.parse(jsonMatch[0]);
                                if (!coverageResult.vagueFunctions) coverageResult.vagueFunctions = [];
                                const missedCount = coverageResult.missedFunctions?.length || 0;
                                const vagueCount = coverageResult.vagueFunctions?.length || 0;
                                console.log(`📊 覆盖度验证: ${coverageResult.coverageScore}分, 遗漏${missedCount}个, 笼统${vagueCount}个`);

                                if (coverageResult.coverageScore < 85 && missedCount > 0 && round < 14) {
                                    console.log('⚠️ 覆盖度不足，将继续补充分析...');
                                    isDone = false;
                                } else {
                                    console.log('✅ 覆盖度验证通过');
                                }
                            }
                        } catch (e) {
                            console.warn('覆盖度验证JSON解析失败:', e.message);
                        }
                    }
                } catch (e) {
                    console.warn('自动覆盖度验证调用失败, 跳过:', e.message);
                }
            }
        }

        res.json({
            success: true, reply, round, isDone,
            completedFunctions: completedFunctions.length,
            targetFunctions: effectiveTarget,
            coverageVerification: coverageResult
        });
    } catch (error) {
        console.error('分析失败:', error);
        res.status(500).json({ error: '分析失败: ' + error.message });
    }
});

// ═══════════════════════ 覆盖度验证 ═══════════════════════

app.post('/api/verify-coverage', async (req, res) => {
    try {
        const { documentContent, extractedFunctions = [], userConfig = null } = req.body;

        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }
        if (extractedFunctions.length === 0) {
            return res.status(400).json({ error: '缺少已提取的功能过程列表' });
        }

        console.log(`🔍 开始覆盖度验证，已提取 ${extractedFunctions.length} 个功能过程...`);
        const modelName = getModelName(userConfig);

        const functionListText = extractedFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n');

        const userPrompt = `## 原始需求文档：
${documentContent}

## 已提取的功能过程列表（共${extractedFunctions.length}个）：
${functionListText}

请严格审查以上功能过程列表是否完整覆盖了需求文档中的所有功能。`;

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: COVERAGE_VERIFICATION_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.1,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;

        // 尝试解析JSON
        let verification = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                verification = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn('覆盖度验证JSON解析失败');
            verification = {
                coverageScore: 0,
                totalDocumentFunctions: extractedFunctions.length,
                extractedCount: extractedFunctions.length,
                missedFunctions: [],
                vagueFunctions: [],
                suggestions: ['JSON解析失败，请重试']
            };
        }

        // 确保vagueFunctions字段存在
        if (!verification.vagueFunctions) {
            verification.vagueFunctions = [];
        }

        console.log(`✅ 覆盖度验证完成: ${verification.coverageScore}分, 遗漏${verification.missedFunctions?.length || 0}个功能, 笼统描述${verification.vagueFunctions?.length || 0}个`);
        if (verification.vagueFunctions.length > 0) {
            console.log(`   ⚠️ 以下功能描述过于笼统，需要细化：`);
            verification.vagueFunctions.forEach((vf, i) => {
                console.log(`      ${i + 1}. ${vf.functionName} → ${vf.suggestion}`);
            });
        }
        res.json({ success: true, verification });
    } catch (error) {
        console.error('覆盖度验证失败:', error);
        res.status(500).json({ error: '覆盖度验证失败: ' + error.message });
    }
});

// ═══════════════════════ 补充提取 ═══════════════════════

app.post('/api/extract-supplementary', async (req, res) => {
    try {
        const { documentContent, existingFunctions = [], missedFunctions = [], vagueFunctions = [], userConfig = null } = req.body;

        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log(`🔄 开始补充提取，已有 ${existingFunctions.length} 个功能，遗漏 ${missedFunctions.length} 个，笼统 ${vagueFunctions.length} 个...`);
        const modelName = getModelName(userConfig);

        const existingListText = existingFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n');
        const missedListText = missedFunctions.map((f, i) => {
            if (typeof f === 'object') {
                return `${i + 1}. ${f.functionName}（原因：${f.reason || ''}，分类：${f.category || ''}，文档依据：${f.documentEvidence || ''}）`;
            }
            return `${i + 1}. ${f}`;
        }).join('\n');

        // 构建笼统功能细化提示
        let vagueHint = '';
        if (vagueFunctions.length > 0) {
            const vagueListText = vagueFunctions.map((vf, i) => {
                if (typeof vf === 'object') {
                    return `${i + 1}. "${vf.functionName}" → 建议细化为：${vf.suggestion}`;
                }
                return `${i + 1}. ${vf}`;
            }).join('\n');
            vagueHint = `\n\n## 描述过于笼统需要细化的功能（请替换为更具体的业务功能过程）：\n${vagueListText}\n\n注意：以上笼统功能需要拆分为绑定具体业务对象的多个功能过程。例如"定时汇总数据"应拆分为"定时汇总质差小区KPI指标数据"、"定时汇总地市流量统计数据"等。`;
        }

        const userPrompt = `## 原始需求文档：
${documentContent}

## 已提取的功能过程（共${existingFunctions.length}个，不要重复这些）：
${existingListText}

## 覆盖度审查发现的遗漏功能（请针对这些进行补充提取）：
${missedListText}${vagueHint}

请补充提取上述遗漏的功能过程，同时再次仔细扫描文档看是否有其他遗漏。特别注意数据汇总/统计/报表类功能是否被充分细化拆分。`;

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: SUPPLEMENTARY_EXTRACTION_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 16000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;
        const functions = extractFunctionsFromText(reply);

        console.log(`✅ 补充提取到 ${functions.length} 个新功能过程`);
        res.json({
            success: true,
            functionList: reply,
            functions,
            count: functions.length
        });
    } catch (error) {
        console.error('补充提取失败:', error);
        res.status(500).json({ error: '补充提取失败: ' + error.message });
    }
});

// ═══════════════════════ 表格解析 ═══════════════════════

app.post('/api/parse-table', (req, res) => {
    try {
        const { markdown } = req.body;
        const tableData = limitSubprocessesPerFunction(ensureFunctionDescriptions(parseMarkdownTable(markdown)));
        res.json({ success: true, tableData, count: tableData.length });
    } catch (error) {
        res.status(500).json({ error: '表格解析失败: ' + error.message });
    }
});

// ═══════════════════════ 流式对话 ═══════════════════════

app.post('/api/chat/stream', async (req, res) => {
    let heartbeatTimer = null;
    let streamStarted = false;
    try {
        const {
            messages = [],
            conversationHistory = [],
            documentContent = '',
            userGuidelines = '',
            userConfig = null,
            tableData = [],
            functionListText = '',
            parsedFunctions = []
        } = req.body;
        const modelName = getModelName(userConfig);
        const instruction = [...messages]
            .reverse()
            .find(message => message?.role === 'user' && message?.content)?.content;
        if (!instruction) {
            return res.status(400).json({ error: '缺少用户对话指令' });
        }

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        streamStarted = true;

        const streamStartedAt = Date.now();
        let activitySequence = 0;
        const sendEvent = (payload) => {
            if (res.writableEnded || res.destroyed) return;
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        const sendActivity = ({ id, title, detail, status = 'running', meta = null }) => {
            sendEvent({
                type: 'activity',
                activity: {
                    id,
                    sequence: ++activitySequence,
                    title,
                    detail,
                    status,
                    meta,
                    elapsedMs: Date.now() - streamStartedAt
                }
            });
        };
        const streamText = async (text) => {
            const characters = Array.from(String(text || ''));
            const chunkSize = Math.max(24, Math.ceil(characters.length / 60));
            for (let index = 0; index < characters.length; index += chunkSize) {
                sendEvent({
                    type: 'content',
                    content: characters.slice(index, index + chunkSize).join('')
                });
                // Let the browser paint incremental output instead of receiving
                // one large buffered write after planning has completed.
                await new Promise(resolve => setTimeout(resolve, 18));
            }
        };

        heartbeatTimer = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) {
                res.write(`: keep-alive ${Date.now() - streamStartedAt}\n\n`);
            }
        }, 12000);
        heartbeatTimer.unref?.();

        const functionsForConversation = Array.isArray(parsedFunctions) && parsedFunctions.length > 0
            ? parsedFunctions
            : extractFunctionsFromText(functionListText);
        sendActivity({
            id: 'context',
            title: '读取当前任务上下文',
            detail: `已载入需求文档、${functionsForConversation.length} 个功能过程和 ${tableData.length} 条 COSMIC 数据移动。`,
            status: 'done',
            meta: {
                hasDocument: Boolean(documentContent),
                functionCount: functionsForConversation.length,
                cosmicRowCount: tableData.length
            }
        });
        sendActivity({
            id: 'planning',
            title: '理解指令并生成执行方案',
            detail: 'AI 正在结合当前文档、功能清单和最近对话判断用户意图。',
            status: 'running'
        });
        const plan = await createConversationPlan({
            instruction,
            conversationHistory,
            documentContent,
            parsedFunctions: functionsForConversation,
            tableData,
            userGuidelines,
            userConfig,
            modelName,
            callAIWithRetry
        });
        const plannedChangeCount = plan.documentPatches.length
            + plan.functionChanges.length
            + plan.cosmicTargets.length;
        sendActivity({
            id: 'planning',
            title: '理解指令并生成执行方案',
            detail: plan.needsClarification
                ? '发现需要用户确认的信息，已生成澄清答复，暂不修改数据。'
                : `已识别意图“${plan.intent}”，生成 ${plannedChangeCount} 项可执行变更。`,
            status: plan.needsClarification ? 'warning' : 'done',
            meta: {
                intent: plan.intent,
                needsClarification: plan.needsClarification,
                documentChanges: plan.documentPatches.length,
                functionChanges: plan.functionChanges.length,
                cosmicChanges: plan.cosmicTargets.length
            }
        });
        sendActivity({
            id: 'validation',
            title: '校验并整理变更',
            detail: '正在检查修改目标、原文匹配和 COSMIC 联动范围。',
            status: 'running'
        });
        const mutation = plan.needsClarification
            ? {
                documentContent,
                functions: functionsForConversation,
                functionListText,
                cosmicTargets: [],
                changeSummary: {
                    documentApplied: 0,
                    documentSkipped: 0,
                    functionsApplied: 0,
                    functionsSkipped: 0,
                    cosmicRequested: 0
                },
                warnings: []
            }
            : applyConversationPlan({
                documentContent,
                parsedFunctions: functionsForConversation,
                plan
            });

        const appliedCount = mutation.changeSummary.documentApplied
            + mutation.changeSummary.functionsApplied;
        const requestedCosmic = mutation.changeSummary.cosmicRequested;
        const statusLines = [];
        if (mutation.changeSummary.documentApplied > 0) {
            statusLines.push(`需求文档已应用 ${mutation.changeSummary.documentApplied} 处修改`);
        }
        if (mutation.changeSummary.functionsApplied > 0) {
            statusLines.push(`功能清单已应用 ${mutation.changeSummary.functionsApplied} 项修改`);
        }
        if (requestedCosmic > 0) {
            statusLines.push(`将使用原COSMIC拆分流程更新 ${requestedCosmic} 个功能过程`);
        }
        if (mutation.warnings.length > 0) {
            statusLines.push(`有 ${mutation.warnings.length} 项未自动应用，已保留原内容`);
        }
        const answer = statusLines.length > 0
            ? `${plan.answer}\n\n${statusLines.map(line => `- ${line}`).join('\n')}`
            : plan.answer;

        sendActivity({
            id: 'validation',
            title: '校验并整理变更',
            detail: mutation.warnings.length > 0
                ? `已完成校验；${mutation.warnings.length} 项未通过精确匹配，将保持原内容。`
                : '变更目标和联动范围校验完成。',
            status: mutation.warnings.length > 0 ? 'warning' : 'done',
            meta: mutation.changeSummary
        });
        sendActivity({
            id: 'answer',
            title: '生成前台答复',
            detail: '正在把处理结论增量输出到页面。',
            status: 'running'
        });
        await streamText(answer);
        sendActivity({
            id: 'answer',
            title: '生成前台答复',
            detail: `答复已输出，共 ${Array.from(answer).length} 个字符。`,
            status: 'done'
        });
        if (appliedCount > 0 || requestedCosmic > 0 || mutation.warnings.length > 0) {
            sendActivity({
                id: 'handoff',
                title: '准备同步到当前工作区',
                detail: requestedCosmic > 0
                    ? `已打包状态变更，前端将继续调用原 COSMIC 流程更新 ${requestedCosmic} 个功能过程。`
                    : '已打包状态变更，前端将同步更新文档和功能清单。',
                status: 'done',
                meta: mutation.changeSummary
            });
            sendEvent({
                type: 'action',
                action: {
                    type: 'state_update',
                    intent: plan.intent,
                    documentContent: mutation.documentContent,
                    functions: mutation.functions,
                    functionListText: mutation.functionListText,
                    cosmicTargets: mutation.cosmicTargets,
                    changeSummary: mutation.changeSummary,
                    warnings: mutation.warnings
                }
            });
        }

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('流式对话失败:', error.message);
        if (!streamStarted && !res.headersSent) {
            return res.status(500).json({ error: '调用AI失败: ' + error.message });
        }
        if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify({
                type: 'error',
                activity: {
                    id: 'request',
                    title: 'AI 处理失败',
                    detail: error.message,
                    status: 'error'
                },
                error: '调用AI失败: ' + error.message
            })}\n\n`);
            res.end();
        }
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
});

// ═══════════════════════ 导出Excel ═══════════════════════

app.post('/api/export-excel', async (req, res) => {
    try {
        const { tableData, filename = 'COSMIC拆分结果', sequenceDiagrams, exportTemplate = 'standard' } = req.body;

        if (!tableData || tableData.length === 0) {
            return res.status(400).json({ error: '没有可导出的数据' });
        }

        // 检查是否有功能描述数据
        const hasDescription = tableData.some(r => r.functionDescription);
        const exportTableData = hasDescription ? ensureFunctionDescriptions(orderCosmicTableData(tableData)) : orderCosmicTableData(tableData);
        const orderedSequenceDiagrams = orderSequenceDiagrams(sequenceDiagrams, exportTableData);

        if (exportTemplate === 'assessment') {
            const workbook = buildCosmicAssessmentWorkbook(ExcelJS, exportTableData, filename);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`);
            await workbook.xlsx.write(res);
            res.end();
            return;
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('COSMIC拆分结果');

        // 检测是否有层级字段（level1/level2/level3）
        const hasLevels = exportTableData.some(r => r.level1 || r.level2 || r.level3);

        // 设置表头
        let headers;
        if (hasDescription) {
            headers = hasLevels
                ? ['一级标题', '二级标题', '三级标题', '功能用户', '触发事件', '功能过程', '子过程描述', '数据移动类型', '数据组', '数据属性', '功能描述']
                : ['功能用户', '触发事件', '功能过程', '子过程描述', '数据移动类型', '数据组', '数据属性', '功能描述'];
        } else {
            headers = hasLevels
                ? ['一级标题', '二级标题', '三级标题', '功能用户', '触发事件', '功能过程', '子过程描述', '数据移动类型', '数据组', '数据属性']
                : ['功能用户', '触发事件', '功能过程', '子过程描述', '数据移动类型', '数据组', '数据属性'];
        }
        const headerRow = worksheet.addRow(headers);

        // 表头样式
        headerRow.eachCell((cell, colNumber) => {
            // 层级列用区别色（深紫色）
            const isLevelCol = hasLevels && colNumber <= 3;
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: isLevelCol ? 'FF4C1D95' : 'FF1A1A2E' }
            };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = {
                top: { style: 'thin' },
                bottom: { style: 'thin' },
                left: { style: 'thin' },
                right: { style: 'thin' }
            };
        });

        // 设置列宽
        if (hasDescription) {
            if (hasLevels) {
                worksheet.columns = [
                    { width: 22 }, // 一级标题
                    { width: 22 }, // 二级标题
                    { width: 22 }, // 三级标题
                    { width: 28 }, // 功能用户
                    { width: 14 }, // 触发事件
                    { width: 24 }, // 功能过程
                    { width: 28 }, // 子过程描述
                    { width: 14 }, // 数据移动类型
                    { width: 24 }, // 数据组
                    { width: 40 }, // 数据属性
                    { width: 54 }, // 功能描述
                ];
            } else {
                worksheet.columns = [
                    { width: 28 }, // 功能用户
                    { width: 14 }, // 触发事件
                    { width: 24 }, // 功能过程
                    { width: 28 }, // 子过程描述
                    { width: 14 }, // 数据移动类型
                    { width: 24 }, // 数据组
                    { width: 40 }, // 数据属性
                    { width: 54 }, // 功能描述
                ];
            }
        } else {
            if (hasLevels) {
                worksheet.columns = [
                    { width: 22 }, // 一级标题
                    { width: 22 }, // 二级标题
                    { width: 22 }, // 三级标题
                    { width: 28 }, // 功能用户
                    { width: 14 }, // 触发事件
                    { width: 24 }, // 功能过程
                    { width: 28 }, // 子过程描述
                    { width: 14 }, // 数据移动类型
                    { width: 24 }, // 数据组
                    { width: 40 }, // 数据属性
                ];
            } else {
                worksheet.columns = [
                    { width: 28 }, // 功能用户
                    { width: 14 }, // 触发事件
                    { width: 24 }, // 功能过程
                    { width: 28 }, // 子过程描述
                    { width: 14 }, // 数据移动类型
                    { width: 24 }, // 数据组
                    { width: 40 }, // 数据属性
                ];
            }
        }

        // 预处理：让没有层级的行继承所属功能过程的层级
        // 构建每个功能过程的层级映射
        let inheritL1 = '', inheritL2 = '', inheritL3 = '';
        for (let i = 0; i < exportTableData.length; i++) {
            const row = exportTableData[i];
            if (row.dataMovementType === 'E' && row.functionalProcess) {
                // E行：如果本行有层级就用本行的，否则继承上一个有层级的功能过程
                if (row.level1 || row.level2 || row.level3) {
                    inheritL1 = row.level1 || '';
                    inheritL2 = row.level2 || '';
                    inheritL3 = row.level3 || '';
                } else {
                    // 继承上一个有层级的功能过程的层级
                    row.level1 = inheritL1;
                    row.level2 = inheritL2;
                    row.level3 = inheritL3;
                }
            } else {
                // 非E行：继承当前功能过程的层级
                if (!row.level1 && !row.level2 && !row.level3) {
                    row.level1 = inheritL1;
                    row.level2 = inheritL2;
                    row.level3 = inheritL3;
                }
            }
        }

        // 填充数据
        let currentFuncUser = '';
        let currentTrigger = '';
        let currentProcess = '';
        let prevL1 = '';
        let prevL2 = '';
        let prevL3 = '';
        const descriptionColIndex = hasDescription ? (hasLevels ? 11 : 8) : -1;
        const descriptionMergeRanges = [];
        let currentDescriptionMerge = null;

        exportTableData.forEach((row) => {
            const funcUser = row.functionalUser || currentFuncUser;
            const trigger = row.triggerEvent || currentTrigger;
            const process = row.functionalProcess || '';

            if (row.functionalUser) currentFuncUser = row.functionalUser;
            if (row.triggerEvent) currentTrigger = row.triggerEvent;
            if (row.functionalProcess) currentProcess = row.functionalProcess;

            let dataRow;
            if (hasLevels) {
                // E行展示层级：每个功能过程都显示（仅在与上一个功能过程层级相同时才省略一级/二级标题，三级标题始终显示）
                const isE = row.dataMovementType === 'E';
                const l1 = row.level1 || '';
                const l2 = row.level2 || '';
                const l3 = row.level3 || '';
                const showL1 = (isE && l1 && l1 !== prevL1) ? l1 : '';
                const showL2 = (isE && l2 && l2 !== prevL2) ? l2 : '';
                // 三级标题：每个功能过程都显示，确保每行都能看到所属模块
                const showL3 = (isE && l3) ? l3 : '';
                if (isE && l1) prevL1 = l1;
                if (isE && l2) prevL2 = l2;
                if (isE && l3) prevL3 = l3;

                if (hasDescription) {
                    dataRow = worksheet.addRow([
                        showL1,
                        showL2,
                        showL3,
                        isE ? funcUser : '',
                        isE ? trigger : '',
                        process,
                        row.subProcessDesc || '',
                        row.dataMovementType || '',
                        row.dataGroup || '',
                        row.dataAttributes || '',
                        isE ? row.functionDescription || '' : ''
                    ]);
                } else {
                    dataRow = worksheet.addRow([
                        showL1,
                        showL2,
                        showL3,
                        isE ? funcUser : '',
                        isE ? trigger : '',
                        process,
                        row.subProcessDesc || '',
                        row.dataMovementType || '',
                        row.dataGroup || '',
                        row.dataAttributes || ''
                    ]);
                }
            } else {
                if (hasDescription) {
                    dataRow = worksheet.addRow([
                        row.dataMovementType === 'E' ? funcUser : '',
                        row.dataMovementType === 'E' ? trigger : '',
                        process,
                        row.subProcessDesc || '',
                        row.dataMovementType || '',
                        row.dataGroup || '',
                        row.dataAttributes || '',
                        row.dataMovementType === 'E' ? row.functionDescription || '' : ''
                    ]);
                } else {
                    dataRow = worksheet.addRow([
                        row.dataMovementType === 'E' ? funcUser : '',
                        row.dataMovementType === 'E' ? trigger : '',
                        process,
                        row.subProcessDesc || '',
                        row.dataMovementType || '',
                        row.dataGroup || '',
                        row.dataAttributes || ''
                    ]);
                }
            }

            if (row.dataMovementType === 'E' && row.functionalProcess) {
                if (currentDescriptionMerge && hasDescription) descriptionMergeRanges.push(currentDescriptionMerge);
                currentDescriptionMerge = hasDescription ? { start: dataRow.number, end: dataRow.number } : null;
            } else if (currentDescriptionMerge && hasDescription) {
                currentDescriptionMerge.end = dataRow.number;
            }

            // 数据行样式
            const dmtColIndex = hasLevels ? 8 : 5; // 数据移动类型列索引
            dataRow.eachCell((cell, colNumber) => {
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
                };

                // E行背景色
                if (row.dataMovementType === 'E') {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F7FF' } };
                }

                // 层级列（一级/二级/三级标题）浅紫色背景
                if (hasLevels && colNumber <= 3 && row.dataMovementType === 'E') {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F3FF' } };
                    cell.font = { bold: false, color: { argb: 'FF5B21B6' }, size: 10 };
                }

                // 数据移动类型列颜色
                if (colNumber === dmtColIndex) {
                    const colors = { E: 'FF3B82F6', R: 'FF10B981', W: 'FFF59E0B', X: 'FF8B5CF6' };
                    cell.font = { bold: true, color: { argb: colors[row.dataMovementType] || 'FF000000' } };
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }

                if (hasDescription && colNumber === descriptionColIndex) {
                    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
                    cell.font = { size: 10, color: { argb: 'FF334155' } };
                }
            });
        });
        if (currentDescriptionMerge && hasDescription) descriptionMergeRanges.push(currentDescriptionMerge);

        if (hasDescription) {
            for (const range of descriptionMergeRanges) {
                if (range.end > range.start) {
                    worksheet.mergeCells(range.start, descriptionColIndex, range.end, descriptionColIndex);
                }
                const cell = worksheet.getCell(range.start, descriptionColIndex);
                cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
                cell.font = { size: 10, color: { argb: 'FF334155' } };
            }
        }

        // 冻结表头
        worksheet.views = [{ state: 'frozen', ySplit: 1 }];

        // ═══════════ 时序图工作表（如有） ═══════════
        if (orderedSequenceDiagrams && orderedSequenceDiagrams.length > 0) {
            console.log(`📊 正在嵌入 ${orderedSequenceDiagrams.length} 张时序图到Excel...`);
            const ws2 = workbook.addWorksheet('功能时序图');

            // 设置列宽（图片要跨越多列，给足宽度）
            ws2.columns = [
                { width: 4 },   // A: 序号
                { width: 30 },  // B: 功能过程名
                { width: 12 },  // C: ERWX统计
                { width: 12 },  // D
                { width: 12 },  // E
                { width: 12 },  // F
                { width: 12 },  // G
                { width: 12 },  // H
                { width: 12 },  // I
                { width: 12 },  // J
                { width: 12 },  // K
                { width: 12 },  // L
            ];

            // 标题行
            const titleRow = ws2.addRow(['', '📊 COSMIC 功能时序图集', '', '', '', '', '', '', '', '', '', '']);
            ws2.mergeCells(`B${titleRow.number}:L${titleRow.number}`);
            titleRow.getCell(2).font = { bold: true, size: 16, color: { argb: 'FF6C5CE7' } };
            titleRow.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
            titleRow.height = 36;

            const subtitleRow = ws2.addRow(['', `共 ${orderedSequenceDiagrams.length} 个功能过程`, '', '', '', '', '', '', '', '', '', '']);
            ws2.mergeCells(`B${subtitleRow.number}:L${subtitleRow.number}`);
            subtitleRow.getCell(2).font = { size: 11, color: { argb: 'FF636E72' } };
            subtitleRow.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
            subtitleRow.height = 24;

            // 空行
            ws2.addRow([]);

            // 构建功能过程 → 统计信息映射
            const processStats = {};
            let curProc = '';
            exportTableData.forEach(row => {
                if (row.functionalProcess) curProc = row.functionalProcess;
                if (!processStats[curProc]) processStats[curProc] = { E: 0, R: 0, W: 0, X: 0, total: 0 };
                if (row.dataMovementType) {
                    processStats[curProc][row.dataMovementType] = (processStats[curProc][row.dataMovementType] || 0) + 1;
                    processStats[curProc].total++;
                }
            });

            // 逐个插入时序图
            for (let i = 0; i < orderedSequenceDiagrams.length; i++) {
                const diag = orderedSequenceDiagrams[i];
                const currentRow = ws2.rowCount + 1;

                // ── 功能过程标题行 ──
                const cleanName = (diag.processName || '').replace(/\[.*?\]\s*/, '').trim();
                const headerR = ws2.addRow(['', `${i + 1}. ${cleanName}`, '', '', '', '', '', '', '', '', '', '']);
                ws2.mergeCells(`B${headerR.number}:L${headerR.number}`);
                headerR.getCell(2).font = { bold: true, size: 13, color: { argb: 'FF1A1A2E' } };
                headerR.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0FF' } };
                headerR.getCell(2).alignment = { vertical: 'middle' };
                headerR.getCell(2).border = {
                    bottom: { style: 'medium', color: { argb: 'FF6C5CE7' } }
                };
                headerR.height = 28;

                // ── ERWX 统计行 ──
                const stats = processStats[diag.processName] || { E: 0, R: 0, W: 0, X: 0, total: 0 };
                const statsR = ws2.addRow(['', `E×${stats.E}  R×${stats.R}  W×${stats.W}  X×${stats.X}  │  共 ${stats.total} CFP`, '', '', '', '', '', '', '', '', '', '']);
                ws2.mergeCells(`B${statsR.number}:L${statsR.number}`);
                statsR.getCell(2).font = { size: 10, color: { argb: 'FF636E72' } };
                statsR.getCell(2).alignment = { vertical: 'middle' };
                statsR.height = 20;

                // ── 插入图片 ──
                try {
                    const imageId = workbook.addImage({
                        base64: diag.imageBase64,
                        extension: 'png',
                    });

                    // 计算图片在 Excel 中的行数
                    // 每个 Excel 行约 15px，图片原始高度(px) / 15 = 需要的行数
                    const imgWidth = diag.width || 800;
                    const imgHeight = diag.height || 400;

                    // 目标宽度约 700px（B-L列的总宽度），保持比例
                    const targetWidthPx = 700;
                    const scale = Math.min(1, targetWidthPx / imgWidth);
                    const displayHeight = imgHeight * scale;
                    const rowsNeeded = Math.max(12, Math.ceil(displayHeight / 15) + 2);

                    // 图片起始行（当前工作表最后一行的下一行）
                    const imgStartRow = ws2.rowCount;

                    // 预先添加空行让图片有位置
                    for (let r = 0; r < rowsNeeded; r++) {
                        ws2.addRow([]);
                    }

                    // 使用 tl/br 锚定方式放置图片
                    ws2.addImage(imageId, {
                        tl: { col: 1, row: imgStartRow },
                        br: { col: 11, row: imgStartRow + rowsNeeded - 1 },
                    });

                    console.log(`  ✅ 时序图 ${i + 1}/${orderedSequenceDiagrams.length}: ${cleanName} (${rowsNeeded} 行)`);
                } catch (imgErr) {
                    console.warn(`  ⚠️ 时序图 ${i + 1} 嵌入失败:`, imgErr.message);
                    const errR = ws2.addRow(['', `⚠️ 时序图嵌入失败: ${imgErr.message}`, '', '', '', '', '', '', '', '', '', '']);
                    ws2.mergeCells(`B${errR.number}:L${errR.number}`);
                    errR.getCell(2).font = { color: { argb: 'FFE74C3C' }, size: 10 };
                }

                // ── 间隔空行 ──
                ws2.addRow([]);
                ws2.addRow([]);
            }

            // 冻结标题
            ws2.views = [{ state: 'frozen', ySplit: 3 }];
        }

        // 发送文件
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('导出Excel失败:', error);
        res.status(500).json({ error: '导出Excel失败: ' + error.message });
    }
});

// ═══════════════════════ 导出Word（借鉴omega-cosmic DocBuilder） ═══════════════════════

app.post('/api/export-word', async (req, res) => {
    try {
        const {
            tableData,
            filename = 'COSMIC功能规格说明书',
            sequenceDiagrams,
            documentName,
            exportTemplate = 'hierarchy'
        } = req.body;

        if (!tableData || tableData.length === 0) {
            return res.status(400).json({ error: '没有可导出的数据' });
        }

        // 检查是否有功能描述数据
        const hasDescription = tableData.some(r => r.functionDescription);
        const exportTableData = hasDescription ? ensureFunctionDescriptions(orderCosmicTableData(tableData)) : orderCosmicTableData(tableData);
        const orderedSequenceDiagrams = orderSequenceDiagrams(sequenceDiagrams, exportTableData);
        const hasSequenceDiagrams = Boolean(orderedSequenceDiagrams?.some(diagram => diagram?.imageBase64));
        const isHierarchyTemplate = exportTemplate !== 'business-spec';

        console.log(`📝 开始生成Word文档，共 ${exportTableData.length} 行数据...`);

        const {
            Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun,
            AlignmentType, BorderStyle, Table, TableRow, TableCell, WidthType,
            VerticalAlign, TableOfContents
        } = docx;

        const font = '微软雅黑';
        const cleanFilename = String(documentName || filename || 'XX项目需求')
            .replace(/^COSMIC功能规格说明书[_-]?/, '')
            .replace(/^COSMIC拆分[_-]?/, '')
            .replace(/\.(docx|xlsx|xlsm|xls)$/i, '')
            .trim();
        const projectTitle = cleanFilename || 'XX项目需求';
        const requirementTitle = /需求/.test(projectTitle) ? projectTitle : `${projectTitle}需求`;
        const now = new Date();
        const issueMonth = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`;

        // ── 1. 将 tableData 按功能过程分组 ──
        const functionGroups = [];
        let currentGroup = null;
        let currentFuncUser = '';
        let currentTrigger = '';
        let currentL1 = '';
        let currentL2 = '';
        let currentL3 = '';
        let currentL4 = '';

        for (const row of exportTableData) {
            if (row.level1) currentL1 = row.level1;
            if (row.level2) currentL2 = row.level2;
            if (row.level3) currentL3 = row.level3;
            if (row.level4) currentL4 = row.level4;

            if (row.dataMovementType === 'E' && row.functionalProcess) {
                if (row.functionalUser) currentFuncUser = row.functionalUser;
                if (row.triggerEvent) currentTrigger = row.triggerEvent;
                currentGroup = {
                    functionalProcess: row.functionalProcess,
                    functionalUser: currentFuncUser,
                    triggerEvent: currentTrigger,
                    functionDescription: row.functionDescription || '',
                    cleanName: row.functionalProcess.replace(/\[.*?\]\s*/, '').trim(),
                    level1: row.level1 || currentL1 || '',
                    level2: row.level2 || currentL2 || '',
                    level3: row.level3 || currentL3 || '',
                    level4: row.level4 || currentL4 || '',
                    rows: [row]
                };
                functionGroups.push(currentGroup);
            } else if (currentGroup) {
                currentGroup.rows.push(row);
            }
        }

        const uniqueFuncs = functionGroups.map(g => g.functionalProcess);
        const totalCfp = exportTableData.length;
        const eCount = exportTableData.filter(r => r.dataMovementType === 'E').length;
        const rCount = exportTableData.filter(r => r.dataMovementType === 'R').length;
        const wCount = exportTableData.filter(r => r.dataMovementType === 'W').length;
        const xCount = exportTableData.filter(r => r.dataMovementType === 'X').length;

        // ── 2. 构建时序图映射 ──
        const diagramMap = new Map();
        if (orderedSequenceDiagrams && orderedSequenceDiagrams.length > 0) {
            for (const diag of orderedSequenceDiagrams) {
                if (diag.processName) {
                    diagramMap.set(diag.processName, diag);
                    diagramMap.set(normalizeProcessName(diag.processName), diag);
                }
            }
        }

        const paragraph = (text, options = {}) => new Paragraph({
            children: [new TextRun({
                text: String(text || ''),
                bold: Boolean(options.bold),
                italics: Boolean(options.italics),
                size: options.size || 21,
                color: options.color || '333333',
                font
            })],
            alignment: options.alignment,
            heading: options.heading,
            spacing: options.spacing || { after: 120, line: 300 },
            indent: options.indent,
            border: options.border
        });

        const heading = (text, level, color = '1A1A2E') => paragraph(stripManualHeadingNumber(text), {
            bold: true,
            size: level === 1 ? 32 : level === 2 ? 27 : level === 3 ? 23 : 21,
            color,
            heading: level === 1
                ? HeadingLevel.HEADING_1
                : level === 2
                    ? HeadingLevel.HEADING_2
                    : level === 3
                        ? HeadingLevel.HEADING_3
                        : HeadingLevel.HEADING_4,
            spacing: { before: level === 1 ? 560 : level === 4 ? 260 : 320, after: 180 }
        });

        const tableCell = (text, options = {}) => new TableCell({
            children: [paragraph(text, {
                bold: options.bold,
                size: options.size || 18,
                color: options.color || '333333',
                alignment: options.alignment,
                spacing: { after: 0, line: 260 }
            })],
            width: options.width ? { size: options.width, type: WidthType.DXA } : undefined,
            margins: { top: 90, bottom: 90, left: 120, right: 120 },
            verticalAlign: VerticalAlign.CENTER,
            shading: options.fill ? { fill: options.fill } : undefined
        });

        const simpleTable = (headers, rows, widths = []) => new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
                new TableRow({
                    tableHeader: true,
                    children: headers.map((header, index) => tableCell(header, {
                        bold: true,
                        color: 'FFFFFF',
                        fill: '1F4E78',
                        alignment: AlignmentType.CENTER,
                        width: widths[index]
                    }))
                }),
                ...rows.map(row => new TableRow({
                    children: row.map((cell, index) => tableCell(cell, {
                        alignment: index === 0 ? AlignmentType.CENTER : undefined,
                        width: widths[index]
                    }))
                }))
            ]
        });

        const moduleSummaryMap = new Map();
        for (const group of functionGroups) {
            const key = [group.level1 || '', group.level2 || '', group.level3 || '', group.level4 || ''].join('\u0001');
            if (!moduleSummaryMap.has(key)) {
                moduleSummaryMap.set(key, {
                    level1: group.level1 || '未指定',
                    level2: group.level2 || '未指定',
                    level3: group.level3 || '未指定',
                    level4: group.level4 || '',
                    funcCount: 0,
                    cfp: 0
                });
            }
            const item = moduleSummaryMap.get(key);
            item.funcCount += 1;
            item.cfp += group.rows.length;
        }
        const moduleSummaryRows = [...moduleSummaryMap.values()].map((item, index) => [
            String(index + 1),
            item.level1,
            item.level2,
            item.level4 || item.level3,
            String(item.funcCount),
            String(item.cfp)
        ]);

        const docChildren = [];
        const appendSequenceDiagram = (group, { includeSteps = false } = {}) => {
            const diagram = diagramMap.get(group.functionalProcess)
                || diagramMap.get(normalizeProcessName(group.functionalProcess));
            if (!diagram?.imageBase64) return false;

            docChildren.push(paragraph('关键时序图/业务逻辑图', {
                bold: true,
                size: 20,
                color: '1F4E78',
                spacing: { before: 180, after: 120 }
            }));
            try {
                const imgBuffer = Buffer.from(diagram.imageBase64, 'base64');
                const imgWidth = diagram.width || 800;
                const imgHeight = diagram.height || 400;
                const maxWidth = 550;
                const scale = Math.min(1, maxWidth / imgWidth);
                const displayWidth = Math.round(imgWidth * scale);
                const displayHeight = Math.round(imgHeight * scale);

                docChildren.push(new Paragraph({
                    children: [new ImageRun({
                        data: imgBuffer,
                        transformation: { width: displayWidth, height: displayHeight },
                        type: 'png'
                    })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 200 }
                }));
            } catch (imgErr) {
                console.warn(`  ⚠️ 时序图嵌入失败 (${group.cleanName}):`, imgErr.message);
                docChildren.push(paragraph(`[时序图嵌入失败: ${imgErr.message}]`, { color: 'E74C3C' }));
            }

            if (includeSteps) {
                docChildren.push(paragraph('本时序图步骤如下：', { bold: true }));
                group.rows.forEach((row, index) => {
                    const dmtLabels = { E: '进入', R: '读取', W: '写入', X: '退出' };
                    const dmtLabel = dmtLabels[row.dataMovementType] || row.dataMovementType;
                    docChildren.push(paragraph(`${index + 1}）${row.subProcessDesc || ''}（${dmtLabel}${row.dataGroup ? ` - ${row.dataGroup}` : ''}）`, {
                        indent: { left: 480 },
                        spacing: { after: 60, line: 280 }
                    }));
                });
            }
            return true;
        };

        // 封面：参考“XX项目需求 / 业务需求说明书 / 公司 / 年月”模板。
        docChildren.push(
            paragraph(requirementTitle, {
                bold: true,
                size: 42,
                color: '1F4E78',
                alignment: AlignmentType.CENTER,
                spacing: { before: 900, after: 360 }
            }),
            paragraph('业务需求说明书', {
                bold: true,
                size: 34,
                color: '333333',
                alignment: AlignmentType.CENTER,
                spacing: { after: 720 }
            }),
            paragraph(`功能过程 ${uniqueFuncs.length} 个    CFP ${totalCfp}    E/R/W/X ${eCount}/${rCount}/${wCount}/${xCount}`, {
                size: 21,
                color: '666666',
                alignment: AlignmentType.CENTER,
                spacing: { after: 900 }
            }),
            paragraph('COSMIC 拆分智能分析系统', {
                size: 22,
                color: '666666',
                alignment: AlignmentType.CENTER,
                spacing: { before: 900, after: 120 }
            }),
            paragraph(issueMonth, {
                size: 21,
                color: '666666',
                alignment: AlignmentType.CENTER,
                spacing: { after: 600 }
            }),
            new Paragraph({
                children: [new TextRun({ text: '', font })],
                border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1F4E78' } },
                spacing: { after: 360 }
            }),
            paragraph('目录', { bold: true, size: 28, color: '1F4E78', spacing: { before: 300, after: 120 } }),
            new TableOfContents('目录', { hyperlink: true, headingStyleRange: isHierarchyTemplate ? '1-4' : '1-3' })
        );

        if (isHierarchyTemplate) {
            let lastLevel1 = '';
            let lastLevel2Key = '';
            let lastLevel3Key = '';

            for (const group of functionGroups) {
                const level1 = sanitizeText(group.level1) || '未指定一级模块';
                const level2 = sanitizeText(group.level2) || '未指定二级模块';
                // 用户指定第三级目录取“四级模块”。兼容目前附件中仍命名为
                // “三级模块”的旧模板：没有 level4 时回退到 level3。
                const level3 = sanitizeText(group.level4 || group.level3) || '未指定四级模块';
                const level2Key = `${level1}\u0001${level2}`;
                const level3Key = `${level2Key}\u0001${level3}`;

                if (level1 !== lastLevel1) {
                    docChildren.push(heading(level1, 1));
                    lastLevel1 = level1;
                    lastLevel2Key = '';
                    lastLevel3Key = '';
                }
                if (level2Key !== lastLevel2Key) {
                    docChildren.push(heading(level2, 2));
                    lastLevel2Key = level2Key;
                    lastLevel3Key = '';
                }
                if (level3Key !== lastLevel3Key) {
                    docChildren.push(heading(level3, 3));
                    lastLevel3Key = level3Key;
                }

                docChildren.push(heading(group.cleanName || group.functionalProcess, 4, '1F4E78'));
                const functionDescription = group.functionDescription || buildFunctionDescription(
                    group.functionalProcess,
                    group.rows,
                    '',
                    group.functionalUser,
                    group.triggerEvent
                );
                docChildren.push(paragraph(normalizeFunctionDescription(functionDescription, group.functionalProcess)));
                appendSequenceDiagram(group);
            }
        } else {
        docChildren.push(heading('1. 需求说明', 1));
        docChildren.push(heading('1.1. 总体描述', 2));
        docChildren.push(paragraph(`本文档参考《附件1XX项目需求说明书V1.0.0》模板生成，基于已导入的 COSMIC 功能点拆分结果形成业务需求说明书。文档覆盖 ${uniqueFuncs.length} 个功能需求，合计 ${totalCfp} CFP，并为每个功能需求保留${hasSequenceDiagrams ? '关键时序图/业务逻辑图、' : ''}功能描述和数据移动步骤。`));
        docChildren.push(heading('1.2. 建设目标', 2));
        docChildren.push(paragraph('1）形成与功能模块层级一致的业务需求说明，便于评审、开发、测试和规模度量引用。'));
        docChildren.push(paragraph('2）将 COSMIC 拆分中的功能过程、功能用户、触发事件、数据移动类型和数据组转化为可交付的需求描述。'));
        if (hasSequenceDiagrams) {
            docChildren.push(paragraph('3）嵌入关键时序图/业务逻辑图，直观说明用户、系统和数据库之间的交互过程。'));
        }
        docChildren.push(heading('1.3. 建设必要性', 2));
        docChildren.push(paragraph('通过统一的需求说明书模板承载拆分结果，可以减少人工整理表格和文档的重复工作，提高需求材料、规模评估材料和后续研发材料之间的一致性。'));
        docChildren.push(heading('1.4. 系统现状', 2));
        docChildren.push(heading('1.4.1. 系统概况', 3));
        docChildren.push(paragraph(`本次导入数据已识别 ${moduleSummaryRows.length || 1} 个功能模块组合，涉及 ${uniqueFuncs.length} 个功能过程。`));
        docChildren.push(heading('1.4.2. 系统已实现功能', 3));
        docChildren.push(paragraph('已实现或待建设功能以“需求功能清单”为准，清单中保留一级模块、二级模块、三级模块和对应功能需求名称。'));
        docChildren.push(heading('1.4.3. 存在问题', 3));
        docChildren.push(paragraph(`现有拆分表偏向规模评估口径，缺少面向阅读和评审的业务需求说明结构，因此需要转换为${hasSequenceDiagrams ? '带时序图和' : '带'}功能描述的需求说明书。`));

        docChildren.push(heading('2. 功能架构图', 1));
        docChildren.push(paragraph('功能架构图应分层分域展示一级、二级、三级模块。当前版本根据 COSMIC 拆分表中的模块字段自动生成模块清单，可在定稿时替换或补充正式架构图。'));
        if (moduleSummaryRows.length > 0) {
            docChildren.push(simpleTable(
                ['序号', '一级模块', '二级模块', '三级模块', '功能过程数', 'CFP'],
                moduleSummaryRows,
                [700, 2200, 2200, 2600, 1000, 900]
            ));
        }

        docChildren.push(heading('3. 功能需求', 1));
        for (let fi = 0; fi < functionGroups.length; fi++) {
            const group = functionGroups[fi];
            const funcNumber = `3.${fi + 1}`;
            docChildren.push(heading(`${funcNumber}. ${group.cleanName || group.functionalProcess}（新增）`, 2));
            docChildren.push(paragraph(`一级模块：${group.level1 || '未指定'}    二级模块：${group.level2 || '未指定'}    三级模块：${group.level3 || '未指定'}`, { color: '666666', size: 19 }));
            docChildren.push(paragraph(`功能用户：${group.functionalUser || '未指定'}    触发事件：${group.triggerEvent || '未指定'}`, { color: '666666', size: 19 }));

            appendSequenceDiagram(group, { includeSteps: true });

            docChildren.push(heading(`${funcNumber}.${hasSequenceDiagrams ? 2 : 1}. 功能描述`, 3, '1F4E78'));
            const functionDescription = group.functionDescription || buildFunctionDescription(
                group.functionalProcess,
                group.rows,
                '',
                group.functionalUser,
                group.triggerEvent
            );
            docChildren.push(paragraph(functionDescription));
        }

        docChildren.push(heading(`3.${functionGroups.length + 1}. 需求功能清单`, 2));
        docChildren.push(simpleTable(
            ['序号', '功能需求', '一级模块', '二级模块', '三级模块', 'CFP'],
            functionGroups.map((group, index) => [
                String(index + 1),
                group.cleanName || group.functionalProcess,
                group.level1 || '未指定',
                group.level2 || '未指定',
                group.level3 || '未指定',
                String(group.rows.length)
            ]),
            [700, 2600, 1800, 1800, 2300, 800]
        ));

        docChildren.push(heading('4. 附加值调整因子说明', 1));
        docChildren.push(paragraph('本章节参考模板保留附加值调整因子说明结构，具体取值可由评估人员结合项目实际情况确认。'));
        docChildren.push(heading('4.1. 需求变更规模因子', 2));
        docChildren.push(simpleTable(
            ['需求变更规模因子(CF)', '描述', '调整因子'],
            [
                ['匡算', '项目投资阶段初步计算投资，是最粗略的投资测算。', '2.00'],
                ['概算', '项目可研阶段，根据有代表性的资料综合测算。', '1.50'],
                ['预算', '项目立项或采购阶段形成的相对明确测算。', '1.20'],
                ['结算', '项目实施完成后，按实际交付范围进行确认。', '1.00']
            ],
            [1800, 5600, 1200]
        ));
        docChildren.push(heading('4.2. 应用领域', 2));
        docChildren.push(simpleTable(
            ['应用类型', '描述', '调整因子'],
            [
                ['业务处理', '办公自动化系统、日常管理及业务处理应用软件等。', '1.0'],
                ['应用集成', '企业服务总线、应用集成等。', '1.2'],
                ['实时控制', '对实时性、可靠性要求较高的控制类系统。', '1.4']
            ],
            [1800, 5600, 1200]
        ));
        docChildren.push(heading('4.3. 质量及特性', 2));
        docChildren.push(simpleTable(
            ['质量特性', '判断标准', '建议取值'],
            [
                ['分布式处理', '通过网络进行客户端/服务器及网络基础应用分布处理和传输。', '按项目确认'],
                ['性能', '应答时间或处理率对高峰时间或业务时间较重要。', '按项目确认'],
                ['可靠性', '发生故障时修复难度、经济损失或业务影响较高。', '按项目确认']
            ],
            [1800, 5600, 1200]
        ));
        }

        // ── 6. 生成并发送文档 ──
        const doc = new Document({
            creator: 'COSMIC 拆分智能分析系统',
            title: requirementTitle,
            description: '业务需求说明书 - 自动生成',
            styles: {
                default: {
                    document: {
                        run: { font: '微软雅黑', size: 21 }
                    }
                }
            },
            sections: [{
                properties: {
                    page: {
                        margin: { top: 1440, right: 1080, bottom: 1440, left: 1080 }
                    }
                },
                children: docChildren
            }]
        });

        const rawBuffer = await Packer.toBuffer(doc);
        const buffer = await applyAutoHeadingNumbering(rawBuffer);

        console.log(`✅ Word文档生成成功，大小: ${(buffer.length / 1024).toFixed(1)} KB`);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.docx`);
        res.send(buffer);
    } catch (error) {
        console.error('导出Word失败:', error);
        res.status(500).json({ error: '导出Word失败: ' + error.message });
    }
});

// ═══════════════════════ COSMIC 模块识别 ═══════════════════════

app.post('/api/cosmic/recognize-modules', async (req, res) => {
    try {
        const { documentContent, userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log('📑 开始COSMIC模块层级识别...');
        const modelName = getModelName(userConfig);

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: COSMIC_MODULE_RECOGNITION_PROMPT },
                { role: 'user', content: `请分析以下需求文档的功能模块层级结构：\n\n${documentContent}` }
            ],
            model: modelName,
            temperature: 0.1,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;

        let moduleData = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                moduleData = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn('COSMIC模块识别JSON解析失败:', e.message);
            moduleData = { modules: [], totalEstimated: 0, summary: '解析失败' };
        }
        moduleData = await recoverModuleData({
            moduleData,
            documentContent,
            modelName,
            methodLabel: 'COSMIC'
        });
        if (moduleData?.collapsedFrom) {
            console.log(`   folded overly detailed modules: ${moduleData.collapsedFrom} -> ${moduleData.modules.length}`);
        }

        console.log(`✅ COSMIC模块识别完成: ${moduleData?.modules?.length || 0} 个模块节点`);
        res.json({ success: true, moduleData });
    } catch (error) {
        console.error('COSMIC模块识别失败:', error);
        res.status(500).json({ error: 'COSMIC模块识别失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 模块识别 ═══════════════════════

app.post('/api/nesma/recognize-modules', async (req, res) => {
    try {
        const { documentContent, userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log('📑 开始NESMA模块层级识别...');
        const modelName = getModelName(userConfig);

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: NESMA_MODULE_RECOGNITION_PROMPT },
                { role: 'user', content: `请分析以下需求文档的功能模块层级结构：\n\n${documentContent}` }
            ],
            model: modelName,
            temperature: 0.1,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;

        let moduleData = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                moduleData = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn('NESMA模块识别JSON解析失败:', e.message);
            moduleData = { modules: [], totalEstimated: 0, summary: '解析失败' };
        }
        moduleData = await recoverModuleData({
            moduleData,
            documentContent,
            modelName,
            methodLabel: 'NESMA'
        });
        if (moduleData?.collapsedFrom) {
            console.log(`   folded overly detailed modules: ${moduleData.collapsedFrom} -> ${moduleData.modules.length}`);
        }

        console.log(`✅ NESMA模块识别完成: ${moduleData?.modules?.length || 0} 个模块节点`);
        res.json({ success: true, moduleData });
    } catch (error) {
        console.error('NESMA模块识别失败:', error);
        res.status(500).json({ error: 'NESMA模块识别失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 功能点提取 ═══════════════════════

/**
 * 重用程度 → 调整系数映射
 * 参考："软件开发计价模型" 10/7/4/5/4
 */
const REUSE_COEFFICIENTS = {
    '低': 1.0,       // 完全新开发
    '中': 0.667,     // 部分复用
    '高': 0.333,     // 高度复用
};

/**
 * 重用程度按 低:中:高 = 1:3:6 的比例循环分配
 * 序列: 低 中 中 中 高 高 高 高 高 高 （每10个一个周期，共 1低3中6高）
 */
const REUSE_LEVEL_PATTERN = [
    '低', '中', '中', '中', '高', '高', '高', '高', '高', '高'
];
let _reuseLevelCounter = 0;
function nextReuseLevel() {
    const level = REUSE_LEVEL_PATTERN[_reuseLevelCounter % REUSE_LEVEL_PATTERN.length];
    _reuseLevelCounter++;
    return level;
}
/**
 * 每次解析新表格前重置计数器，使比例从头计算
 */
function resetReuseLevelCounter() {
    _reuseLevelCounter = 0;
}

/**
 * NESMA 功能点权重表（类别 × 复杂度 → UFP）
 */
const FP_WEIGHTS = {
    ILF: { '低': 7, '中': 10, '高': 15 },
    EIF: { '低': 5, '中': 7, '高': 10 },
    EI: { '低': 3, '中': 4, '高': 6 },
    EO: { '低': 4, '中': 5, '高': 7 },
    EQ: { '低': 3, '中': 4, '高': 6 },
};

/**
 * 解析NESMA功能点Markdown表格
 * 支持三种格式：
 *   - v3格式（7列）：一级模块 | 二级模块 | 三级模块 | 业务功能 | 功能点类型 | 功能需求描述 | 外部接口需求描述
 *   - v2格式（4列）：功能模块 | 子功能 | 功能点计数项名称 | 类别
 *   - v1格式（12列）：编号|一级模块|二级模块|三级模块|四级模块|功能点计数项名称|类别|...
 */
function parseNesmaTable(markdown) {
    if (!markdown) return [];
    resetReuseLevelCounter(); // 每次解析新表格时，重置比例计数器
    const tableData = [];
    const lines = markdown.split('\n');
    let headerFound = false;
    let formatVersion = 0; // 0=未确定, 1=v1旧格式, 2=v2四列, 3=v3七列
    let hasReuseColumn = false;
    let currentLevel1 = '';   // 一级模块
    let currentLevel2 = '';   // 二级模块
    let currentLevel3 = '';   // 三级模块

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;

        // 检查表头 — 判断格式版本
        if (!headerFound && (trimmed.includes('业务功能') || trimmed.includes('功能点类型') || trimmed.includes('功能需求描述') ||
            trimmed.includes('功能点计数项名称') || trimmed.includes('功能模块') || trimmed.includes('子功能') ||
            trimmed.includes('编号') || trimmed.includes('一级模块') || trimmed.includes('类别'))) {
            headerFound = true;
            hasReuseColumn = trimmed.includes('重用程度');

            // v3格式（含"业务功能"或"功能需求描述"或"外部接口需求描述"，含/不含"迁移维度"）
            if (trimmed.includes('业务功能') || trimmed.includes('功能需求描述') || trimmed.includes('外部接口需求描述') || trimmed.includes('迁移维度')) {
                formatVersion = 3;
            }
            // v2格式：包含"功能模块"或"子功能"，不包含"编号"/"一级模块"
            else if ((trimmed.includes('功能模块') || trimmed.includes('子功能')) && !trimmed.includes('编号') && !trimmed.includes('一级模块')) {
                formatVersion = 2;
            }
            // v1格式
            else {
                formatVersion = 1;
            }
            continue;
        }

        // 跳过分隔行 — 整行去掉 |, -, :, 空格后应为空
        if (trimmed.replace(/[\s|:\-]/g, '').length === 0) continue;
        if (!headerFound) continue;

        // 解析数据行
        const cells = trimmed.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(c => c.trim());

        if (formatVersion === 3) {
            // ═══ v3格式（7列）：一级模块 | 二级模块 | 三级模块 | 业务功能 | 功能点类型 | 功能需求描述 | 外部接口需求描述 ═══
            // ═══ v3+格式（8列）：一级模块 | 二级模块 | 三级模块 | 业务功能 | 功能点类型 | 迁移维度 | 功能需求描述 | 外部接口需求描述 ═══
            if (cells.length < 5) continue;

            let l1 = cells[0] || '';
            let l2 = cells[1] || '';
            let l3 = cells[2] || '';
            let funcName = cells[3] || '';
            let category = (cells[4] || '').toUpperCase().trim();
            let migrationDimension = '';
            let funcDescription = '';
            let interfaceDescription = '';

            // 根据列数判断是否包含「迁移维度」列
            if (cells.length >= 8) {
                // 8列格式（国产化迁移模式）
                migrationDimension = cells[5] || '';
                funcDescription = cells[6] || '';
                interfaceDescription = cells[7] || '';
            } else {
                // 标准7列格式
                funcDescription = cells[5] || '';
                interfaceDescription = cells[6] || '';
            }

            // 验证类别
            const validCategories = ['ILF', 'EIF', 'EI', 'EO', 'EQ'];
            if (!validCategories.includes(category)) continue;

            // 模块名称继承（同一模块下后续行留空）
            if (l1) currentLevel1 = l1;
            if (l2) currentLevel2 = l2;
            if (l3) currentLevel3 = l3;

            // 默认复杂度为 低
            const complexity = '低';
            const fpCount = (FP_WEIGHTS[category] && FP_WEIGHTS[category][complexity]) || 0;
            const reuseLevel = nextReuseLevel(); // 按 低:中:高=1:3:6 比例分配
            const reuseCoeff = REUSE_COEFFICIENTS[reuseLevel] || 1.0;
            const afp = Math.round(fpCount * reuseCoeff * 1000) / 1000;

            tableData.push({
                id: String(tableData.length + 1),
                level1: sanitizeText(currentLevel1) || '无',
                level2: sanitizeText(currentLevel2) || '无',
                level3: sanitizeText(currentLevel3) || '无',
                funcModule: sanitizeText(currentLevel1) || '',
                subFunction: sanitizeText(currentLevel2) || '',
                level4: sanitizeText(currentLevel3) || '无',
                funcName: sanitizeText(funcName) || '',
                category: category,
                complexity: complexity,
                fpCount: fpCount,
                det: 0,
                retFtr: 0,
                reuseLevel: reuseLevel,
                afp: afp,
                modType: '新增',
                migrationDimension: sanitizeText(migrationDimension) || '',
                funcDescription: sanitizeText(funcDescription) || '',
                interfaceDescription: sanitizeText(interfaceDescription) || ''
            });
        } else if (formatVersion === 2) {
            // ═══ v2格式：功能模块 | 子功能 | 功能点计数项名称 | 类别 ═══
            let funcModule, subFunc, funcName, category;
            if (cells.length >= 4) {
                funcModule = cells[0] || '';
                subFunc = cells[1] || '';
                funcName = cells[2] || '';
                category = (cells[3] || '').toUpperCase().trim();
            } else if (cells.length === 3) {
                funcModule = '';
                subFunc = cells[0] || '';
                funcName = cells[1] || '';
                category = (cells[2] || '').toUpperCase().trim();
            } else {
                continue;
            }

            const validCategories = ['ILF', 'EIF', 'EI', 'EO', 'EQ'];
            if (!validCategories.includes(category)) continue;

            if (funcModule) currentLevel1 = funcModule;
            if (subFunc) currentLevel2 = subFunc;

            const complexity = '低';
            const fpCount = (FP_WEIGHTS[category] && FP_WEIGHTS[category][complexity]) || 0;
            const reuseLevel = nextReuseLevel(); // 按 低:中:高=1:3:6 比例分配
            const reuseCoeff = REUSE_COEFFICIENTS[reuseLevel] || 1.0;
            const afp = Math.round(fpCount * reuseCoeff * 1000) / 1000;

            tableData.push({
                id: String(tableData.length + 1),
                funcModule: sanitizeText(currentLevel1) || '',
                subFunction: sanitizeText(currentLevel2) || '',
                level1: sanitizeText(currentLevel1) || '无',
                level2: sanitizeText(currentLevel2) || '无',
                level3: '无',
                level4: '无',
                funcName: sanitizeText(funcName) || '',
                category: category,
                complexity: complexity,
                fpCount: fpCount,
                det: 0,
                retFtr: 0,
                reuseLevel: reuseLevel,
                afp: afp,
                modType: '新增',
                funcDescription: '',
                interfaceDescription: ''
            });
        } else {
            // ═══ v1格式：编号|一级模块|二级模块|三级模块|四级模块|功能点计数项名称|类别|... ═══
            if (cells.length < 8) continue;

            const [id, level1, level2, level3, level4, funcName, category, ...rest] = cells;

            const validCategories = ['ILF', 'EIF', 'EI', 'EO', 'EQ'];
            const cleanCategory = (category || '').toUpperCase().trim();
            if (!validCategories.includes(cleanCategory)) continue;

            const complexity = rest[0]?.trim() || '中';
            const fpCount = parseInt(rest[1]?.trim()) || 0;
            const det = parseInt(rest[2]?.trim()) || 0;
            const retFtr = parseInt(rest[3]?.trim()) || 0;

            let reuseLevel, modType;
            if (hasReuseColumn) {
                reuseLevel = rest[4]?.trim() || '低';
                modType = rest[5]?.trim() || '新增';
            } else {
                reuseLevel = '低';
                modType = rest[4]?.trim() || '新增';
            }

            const validReuse = ['低', '中', '高'];
            if (!validReuse.includes(reuseLevel)) reuseLevel = '低';

            const reuseCoeff = REUSE_COEFFICIENTS[reuseLevel] || 1.0;
            const afp = Math.round(fpCount * reuseCoeff * 1000) / 1000;

            tableData.push({
                id: sanitizeText(id) || String(tableData.length + 1),
                subFunction: '',
                level1: sanitizeText(level1) || '无',
                level2: sanitizeText(level2) || '无',
                level3: sanitizeText(level3) || '无',
                level4: sanitizeText(level4) || '无',
                funcName: sanitizeText(funcName) || '',
                category: cleanCategory,
                complexity: complexity,
                fpCount: fpCount,
                det: det,
                retFtr: retFtr,
                reuseLevel: reuseLevel,
                afp: afp,
                modType: sanitizeText(modType) || '新增',
                funcDescription: '',
                interfaceDescription: ''
            });
        }
    }
    return tableData;
}

app.post('/api/nesma/extract-functions', async (req, res) => {
    try {
        const {
            documentContent, chapterContent = '', chapterName = '', userGuidelines = '',
            previousResults = [], moduleStructure = null,
            extractionMode = 'precise',
            targetFpCount = null,   // 数量优先：总目标功能点数
            quantityPlan = null,    // 数量优先：每个三级模块的目标数量 [{level1,level2,level3,target}]
            userConfig = null
        } = req.body;
        const content = chapterContent || documentContent;
        if (!content) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        const chapterInfo = chapterName ? `（${chapterName}）` : '';
        const modeLabel = extractionMode === 'quantity' ? '「数量优先」' : extractionMode === 'guochanhua' ? '「国产化迁移」' : '「精准」';
        console.log(`📋 开始NESMA功能点提取${chapterInfo}（${modeLabel}模式）...`);
        const modelName = getModelName(userConfig);

        // 根据模式选择提示词
        let activePrompt;
        if (extractionMode === 'quantity') {
            activePrompt = NESMA_QUANTITY_PRIORITY_PROMPT;
        } else if (extractionMode === 'guochanhua') {
            activePrompt = NESMA_GUOCHANHUA_MIGRATION_PROMPT;
        } else {
            activePrompt = NESMA_FUNCTION_EXTRACTION_PROMPT;
        }

        // ── 自动分批阈值：数量优先/国产化每批2个模块，精准模式≤10个模块 ──
        const BATCH_SIZE = (extractionMode === 'quantity' || extractionMode === 'guochanhua') ? 2 : 10;

        // ── 确定活跃模块列表 ──
        let activeMods = [];
        if (moduleStructure && moduleStructure.modules && moduleStructure.modules.length > 0) {
            const relevantModules = chapterName
                ? getRelevantModulesForChapter(moduleStructure.modules, chapterName)
                : moduleStructure.modules;

            activeMods = relevantModules.length > 0 ? relevantModules : moduleStructure.modules;
        }

        // ── 建立 quantityPlan 映射（level3 → target）──
        const planMap = {};
        if (quantityPlan && quantityPlan.length > 0) {
            quantityPlan.forEach(p => {
                const key = (p.level3 || '').trim();
                if (key) planMap[key] = p.target;
            });
        }

        // ────────────────────────────────────────────────────────────────
        // 辅助函数：为一批模块（batchMods）构造 prompt 并调用一次 AI
        // ────────────────────────────────────────────────────────────────
        const extractOneBatch = async (batchMods, batchIndex, totalBatches, accumulated) => {
            let prompt = `请从以下需求文档中提取NESMA功能点：\n\n${content}`;

            if (batchMods.length > 0) {
                if (extractionMode === 'quantity' && quantityPlan && quantityPlan.length > 0) {
                    // 数量优先 + 规划：按精确目标数量拆，不超出不少于
                    const modListWithTarget = batchMods.map(m => {
                        const objs = m.businessObjects?.length > 0 ? `（业务对象：${m.businessObjects.join('、')}）` : '';
                        const l3key = (m.level3 || '').trim();
                        let target = planMap[l3key];
                        if (!target) {
                            for (const [key, val] of Object.entries(planMap)) {
                                if (l3key.includes(key) || key.includes(l3key)) { target = val; break; }
                            }
                        }
                        const targetStr = target ? `【🎯 精确目标：${target} 个功能点，请严格控制，不多不少】` : '';
                        return `  - [${m.level1}] > [${m.level2}] > [${m.level3}]${objs} ${targetStr}`;
                    }).join('\n');
                    const batchTotal = batchMods.reduce((s, m) => {
                        const l3key = (m.level3 || '').trim();
                        let t = planMap[l3key];
                        if (!t) { for (const [k, v] of Object.entries(planMap)) { if (l3key.includes(k) || k.includes(l3key)) { t = v; break; } } }
                        return s + (t || 10);
                    }, 0);
                    prompt += `\n\n## 📊 按计划数量拆分·本批次模块（批次${batchIndex + 1}/${totalBatches}，本批合计目标 ${batchTotal} 个功能点）\n\n仅需提取以下${batchMods.length}个三级模块的功能点：\n\n${modListWithTarget}\n\n📋 执行要求（必须严格遵守）：\n1. **每个三级模块的功能点数量必须精确等于目标数，上下浮动不超过2个**\n2. 先规划该模块下有哪些业务实体，再按 ILF + EI(CRUD) + EQ(查询/筛选) + EO(统计) 四类展开\n3. 筛选维度（时间/状态/类型/区域）按需拆分，不要无限展开\n4. **禁止为了凑数量而重复或拆出明显无意义的功能点**\n5. 若目标数较小（< 10），优先保证ILF + 基础CRUD + 一个查询即可`;
                } else if (extractionMode === 'quantity' && targetFpCount) {
                    const modList = batchMods.map(m => {
                        const objs = m.businessObjects?.length > 0 ? `（业务对象：${m.businessObjects.join('、')}）` : '';
                        return `  - [${m.level1}] > [${m.level2}] > [${m.level3}]${objs}`;
                    }).join('\n');
                    const perModTarget = Math.round(targetFpCount / (activeMods.length || 1));
                    prompt += `\n\n## 📊 按计划数量拆分·本批次模块（批次${batchIndex + 1}/${totalBatches}，每模块目标约 ${perModTarget} 个）\n${modList}\n\n以上每个三级模块请按约 ${perModTarget} 个功能点展开，不要过多也不要过少。`;
                } else if (extractionMode === 'guochanhua') {
                    // 国产化迁移模式：为每个模块注入7大迁移维度要求
                    const modList = batchMods.map(m => {
                        const objs = m.businessObjects?.length > 0 ? `（业务对象：${m.businessObjects.join('、')}）` : '';
                        return `  - [${m.level1}] > [${m.level2}] > [${m.level3}]${objs}`;
                    }).join('\n');
                    prompt += `\n\n## 🏗️ 国产化迁移功能点提取·本批次模块（批次${batchIndex + 1}/${totalBatches}，仅处理以下${batchMods.length}个模块）\n\n${modList}\n\n## ⚡ 执行要求（必须严格遵守）：\n1. 先提取每个三级模块的**标准业务功能点**（ILF/EIF + CRUD(EI) + 查询(EQ) + 统计(EO)），「迁移维度」列填「原有业务」\n2. 然后为每个三级模块按以下7大维度**逐一判断并展开迁移功能点**（与模块业务对象相关的维度必须包含，每个适用维度至少3~6个功能点）：\n   - **维度1：采集数据迁移** — 该模块有数据采集/传感器/监控数据时必须展开\n   - **维度2：ETL迁移配置** — 该模块有数据清洗/转换/数据管道时必须展开\n   - **维度3：数据汇总迁移** — 该模块有统计汇总/聚合计算时必须展开\n   - **维度4：外部接口迁移** — 该模块有第三方接口/数据交换时必须展开\n   - **维度5：流程引擎迁移** — 该模块有审批流程/工单流转/BPM时必须展开\n   - **维度6：前端应用迁移** — 所有含前端页面的模块必须展开（国产化浏览器/OS适配）\n   - **维度7：报表引擎迁移** — 该模块有数据可视化/图表/报表输出时必须展开\n3. 迁移功能点名称必须结合文档中具体业务名称，禁止使用泛化名称（如"数据迁移"）\n4. 输出8列表格：一级模块 | 二级模块 | 三级模块 | 业务功能 | 功能点类型 | 迁移维度 | 功能需求描述 | 外部接口需求描述`;
                } else {
                    const modList = batchMods.map(m => {
                        const objs = m.businessObjects?.length > 0 ? `（业务对象：${m.businessObjects.join('、')}）` : '';
                        const est = m.estimatedFunctionPoints ? `，预估约${m.estimatedFunctionPoints}个功能点` : '';
                        return `  - [${m.level1}] > [${m.level2}] > [${m.level3}]${objs}${est}`;
                    }).join('\n');
                    prompt += `\n\n## ⚠️ 模块覆盖脚手架（批次${batchIndex + 1}/${totalBatches}，仅处理以下${batchMods.length}个模块）\n${modList}\n\n每个三级模块须有 ILF/EIF + CRUD(EI) + 查询(EQ) + 统计(EO)。`;
                }
            }

            // ⚠️ 多批次模式下不向 AI 注入已累积列表！
            // 每批已按模块限定范围，AI 不会越界重复；大量"已提取"列表会挤占 token 导致产出减少。
            // 批次间去重由代码层的 existingNames Set 完成。
            // 仅首批注入 previousResults（跨轮补充场景），且最多传 50 条防止撑爆。
            if (batchIndex === 0 && previousResults.length > 0) {
                const prevNames = previousResults.map(r => r.funcName).filter(Boolean);
                const sample = prevNames.slice(0, 50);
                prompt += `\n\n## 上一轮已有记录（请勿重复，共${prevNames.length}条）：\n${sample.map((n, i) => `${i + 1}. ${n}`).join('\n')}${prevNames.length > 50 ? `\n...（剩余${prevNames.length - 50}条略）` : ''}`;
            }

            if (userGuidelines) {
                prompt += `\n\n用户特殊要求：${userGuidelines}`;
            }

            const completion = await callAIWithRetry({
                messages: [
                    { role: 'system', content: activePrompt },
                    { role: 'user', content: prompt }
                ],
                model: modelName,
                temperature: 0.3,
                max_tokens: (extractionMode === 'quantity' || extractionMode === 'guochanhua') ? 16384 : 16000
            });

            if (!completion?.choices?.[0]?.message?.content) {
                throw new Error(`批次 ${batchIndex + 1} AI返回了空响应`);
            }
            return completion.choices[0].message.content;
        };

        // ────────────────────────────────────────────────────────────────
        // 主提取逻辑：模块数 ≤ BATCH_SIZE → 单次；否则自动分批
        // ────────────────────────────────────────────────────────────────
        let allTableData = [];
        let allReplies = [];

        if (activeMods.length === 0 || activeMods.length <= BATCH_SIZE) {
            // 单批次
            console.log(`📌 单批次提取: ${activeMods.length} 个模块`);
            const reply = await extractOneBatch(activeMods, 0, 1, []);
            allTableData = parseNesmaTable(reply);
            allReplies.push(reply);
        } else {
            // 多批次自动分批
            const totalBatches = Math.ceil(activeMods.length / BATCH_SIZE);
            console.log(`🔀 模块数(${activeMods.length}) > 阈值(${BATCH_SIZE})，自动分为 ${totalBatches} 批...`);

            for (let bi = 0; bi < totalBatches; bi++) {
                const batchMods = activeMods.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE);
                console.log(`  📦 批次 ${bi + 1}/${totalBatches}: [${batchMods.map(m => m.level3 || m.level2).join('] [')}]`);
                try {
                    const reply = await extractOneBatch(batchMods, bi, totalBatches, allTableData);
                    const batchData = parseNesmaTable(reply);
                    // 数量优先模式：用 "三级模块|功能名" 联合去重，避免跨模块同名功能点被误删
                    // 精准模式：仅用功能名去重（兼容原逻辑）
                    const buildDedupeKey = (r) => {
                        const l3 = (r.level3 || r.level4 || '').trim();
                        const name = (r.funcName || '').toLowerCase().trim();
                        return extractionMode === 'quantity' ? `${l3}||${name}` : name;
                    };
                    const existingKeys = new Set(allTableData.map(buildDedupeKey));
                    const newRows = batchData.filter(r => !existingKeys.has(buildDedupeKey(r)));
                    allTableData = [...allTableData, ...newRows];
                    allReplies.push(reply);
                    console.log(`  ✅ 批次 ${bi + 1} 完成: +${newRows.length} 个（累计 ${allTableData.length} 个）`);
                } catch (batchErr) {
                    console.error(`  ❌ 批次 ${bi + 1} 失败: ${batchErr.message}，跳过继续...`);
                }
                // 批次间间隔 1.5 秒，避免限流
                if (bi < totalBatches - 1) await new Promise(r => setTimeout(r, 1500));
            }
            // 重新编号
            allTableData.forEach((r, i) => { r.id = String(i + 1); });
        }

        console.log(`✅ NESMA功能点提取完成，共解析到 ${allTableData.length} 个功能点（共 ${allReplies.length} 批次）`);
        res.json({
            success: true,
            reply: allReplies.join('\n\n---批次分隔---\n\n'),
            tableData: allTableData,
            count: allTableData.length,
            batches: allReplies.length
        });
    } catch (error) {
        console.error('NESMA功能点提取失败:', error);
        res.status(500).json({ error: 'NESMA功能点提取失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 表格解析 ═══════════════════════

app.post('/api/nesma/parse-table', (req, res) => {
    try {
        const { markdown } = req.body;
        const tableData = parseNesmaTable(markdown);
        res.json({ success: true, tableData, count: tableData.length });
    } catch (error) {
        res.status(500).json({ error: 'NESMA表格解析失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 覆盖度验证 ═══════════════════════

app.post('/api/nesma/verify-coverage', async (req, res) => {
    try {
        const { documentContent, extractedFunctions = [], userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log(`🔍 开始NESMA覆盖度验证，已提取 ${extractedFunctions.length} 个功能点...`);
        const modelName = getModelName(userConfig);

        const funcListText = extractedFunctions.map((f, i) => {
            const path = [f.level1 || f.funcModule, f.level2 || f.subFunction, f.level3].filter(Boolean).join(' > ');
            const desc = f.funcDescription ? ` | 说明：${f.funcDescription.substring(0, 50)}` : '';
            return `${i + 1}. [${f.category}] ${f.funcName}（模块：${path}${desc}）`;
        }).join('\n');

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: NESMA_COVERAGE_VERIFICATION_PROMPT },
                { role: 'user', content: `## 原始需求文档：\n${documentContent}\n\n## 已提取的NESMA功能点（共${extractedFunctions.length}个，含三级模块路径和描述）：\n${funcListText}\n\n请严格审查功能点覆盖度，重点检查：1.每个ILF是否有配套EI和EO/EQ；2.是否有未覆盖的三级模块；3.文档中未体现的EQ子类（导出、推送、筛选）。` }
            ],
            model: modelName,
            temperature: 0.1,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;

        let verification = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) verification = JSON.parse(jsonMatch[0]);
        } catch (e) {
            verification = { coverageScore: 0, missedFunctions: [], suggestions: ['JSON解析失败，请重试'] };
        }

        console.log(`✅ NESMA覆盖度验证完成: ${verification?.coverageScore || 0}分, 遗漏${verification?.missedFunctions?.length || 0}个`);
        res.json({ success: true, verification });
    } catch (error) {
        console.error('NESMA覆盖度验证失败:', error);
        res.status(500).json({ error: 'NESMA覆盖度验证失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 补充提取 ═══════════════════════

app.post('/api/nesma/extract-supplementary', async (req, res) => {
    try {
        const { documentContent, existingFunctions = [], missedFunctions = [], moduleStructure = null, userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log(`🔄 开始NESMA补充提取，遗漏 ${missedFunctions.length} 个...`);
        const modelName = getModelName(userConfig);

        const existingNames = existingFunctions.map((f, i) => `${i + 1}. [${f.category}] ${f.funcName}`).join('\n');
        const missedNames = missedFunctions.map((f, i) => {
            if (typeof f === 'object') return `${i + 1}. [${f.category || '?'}] ${f.functionName}（${f.reason || ''}）所属模块：${f.parentModule || '未知'}`;
            return `${i + 1}. ${f}`;
        }).join('\n');

        let userPrompt = `## 原始需求文档：\n${documentContent}\n\n## 已提取的功能点（不要重复）：\n${existingNames}\n\n## 遗漏的功能点（请补充提取）：\n${missedNames}\n\n请补充提取上述遗漏的NESMA功能点。`;

        // 注入模块脚手架，帮助AI定位遗漏功能点所在的模块
        if (moduleStructure && moduleStructure.modules?.length > 0) {
            const modList = moduleStructure.modules.map(m =>
                `  - [${m.level1}] > [${m.level2}] > [${m.level3}]`
            ).join('\n');
            userPrompt += `\n\n## 模块覆盖脚手架（遗漏功能点可能属于以下模块）：\n${modList}`;
        }

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: NESMA_FUNCTION_EXTRACTION_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 16000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应' });
        }
        const reply = completion.choices[0].message.content;
        const tableData = parseNesmaTable(reply);

        console.log(`✅ NESMA补充提取到 ${tableData.length} 个功能点`);
        res.json({ success: true, tableData, count: tableData.length });
    } catch (error) {
        console.error('NESMA补充提取失败:', error);
        res.status(500).json({ error: 'NESMA补充提取失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 导出Excel ═══════════════════════

app.post('/api/nesma/export-excel', async (req, res) => {
    try {
        const { tableData, filename = 'NESMA功能点拆分结果', adjustmentFactors = {} } = req.body;
        if (!tableData || tableData.length === 0) {
            return res.status(400).json({ error: '没有可导出的数据' });
        }

        const workbook = new ExcelJS.Workbook();
        const reuseCoeff = { '低': 1.0, '中': 0.667, '高': 0.333 };
        const categoryColors = {
            'ILF': 'FF1E88E5', 'EIF': 'FF43A047', 'EI': 'FFFB8C00', 'EO': 'FF8E24AA', 'EQ': 'FF00ACC1'
        };

        // ═══════════ Sheet 1: 规模估算（参考Excel标准工作量模型格式） ═══════════
        const worksheet = workbook.addWorksheet('规模估算');

        const totalUFP = tableData.reduce((sum, r) => sum + (r.fpCount || 0), 0);
        const totalAFP = tableData.reduce((sum, r) => {
            const coeff = reuseCoeff[r.reuseLevel || '低'] || 1.0;
            return sum + (r.fpCount || 0) * coeff;
        }, 0);
        const roundedAFP = Math.round(totalAFP * 100) / 100;

        // 汇总信息行
        const sr0 = worksheet.addRow(['', '软件开发计价模型', '', '"软件开发计价模型"：10/7/4/5/4']);
        sr0.getCell(2).font = { bold: true, size: 11 };
        sr0.getCell(4).font = { size: 10, color: { argb: 'FF666666' } };
        const sr1 = worksheet.addRow(['', totalUFP, '', 'UFP,单位：FP']);
        sr1.getCell(2).font = { bold: true, size: 14, color: { argb: 'FF008000' } };
        sr1.getCell(2).numFmt = '#,##0.00';
        sr1.getCell(4).font = { bold: true, color: { argb: 'FFFF0000' } };
        const sr2 = worksheet.addRow(['', roundedAFP, '', 'AFP,单位：FP']);
        sr2.getCell(2).font = { bold: true, size: 14, color: { argb: 'FFFF0000' } };
        sr2.getCell(2).numFmt = '#,##0.00';
        sr2.getCell(4).font = { bold: true, color: { argb: 'FFFF0000' } };
        // 背景色
        sr1.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
        sr2.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
        sr2.getCell(2).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };

        // 表头行 — 检测是否有国产化迁移数据，动态调整列数
        const hasMigrationData = tableData.some(r => r.migrationDimension && r.migrationDimension !== '' && r.migrationDimension !== '原有业务');
        const headers = hasMigrationData
            ? ['一级模块', '二级模块', '三级模块', '业务功能', '功能点类型', '迁移维度', '功能需求描述', '外部接口需求描述', 'UFP', '重用程度', '修改类型', 'AFP']
            : ['一级模块', '二级模块', '三级模块', '业务功能', '功能点类型', '功能需求描述', '外部接口需求描述', 'UFP', '重用程度', '修改类型', 'AFP'];
        const headerRow = worksheet.addRow(headers);
        const headerRowNum = worksheet.lastRow.number;

        headerRow.eachCell((cell, colNumber) => {
            // 迁移维度列用绿色表头
            const isMigCol = hasMigrationData && colNumber === 6;
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isMigCol ? 'FF10B981' : 'FF0D4F8B' } };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
        });

        if (hasMigrationData) {
            worksheet.columns = [
                { width: 18 }, // 一级模块
                { width: 20 }, // 二级模块
                { width: 20 }, // 三级模块
                { width: 30 }, // 业务功能
                { width: 10 }, // 功能点类型
                { width: 14 }, // 迁移维度
                { width: 38 }, // 功能需求描述
                { width: 32 }, // 外部接口需求描述
                { width: 8 },  // UFP
                { width: 10 }, // 重用程度
                { width: 10 }, // 修改类型
                { width: 10 }, // AFP
            ];
        } else {
            worksheet.columns = [
                { width: 20 }, // 一级模块
                { width: 22 }, // 二级模块
                { width: 22 }, // 三级模块
                { width: 32 }, // 业务功能
                { width: 10 }, // 功能点类型
                { width: 40 }, // 功能需求描述
                { width: 36 }, // 外部接口需求描述
                { width: 8 },  // UFP
                { width: 10 }, // 重用程度
                { width: 10 }, // 修改类型
                { width: 10 }, // AFP
            ];
        }

        // 迁移维度颜色（Excel背景色）
        const migDimBgColors = {
            '采集数据迁移': 'FFE0F2FE',
            'ETL迁移配置': 'FFF3E8FF',
            '数据汇总迁移': 'FFFFF7E0',
            '外部接口迁移': 'FFFEE2E2',
            '流程引擎迁移': 'FFFCE7F3',
            '前端应用迁移': 'FFE6FFFA',
            '报表引擎迁移': 'FFFFF3E0',
        };

        // 填充数据 — 各级模块只在每组第一行显示，后续行留空

        let prevL1 = '';
        let prevL2 = '';
        let prevL3 = '';
        tableData.forEach((row) => {
            const l1 = row.level1 || row.funcModule || '';
            const showL1 = (l1 && l1 !== '无' && l1 !== prevL1) ? l1 : '';
            if (l1 && l1 !== '无') prevL1 = l1;

            const l2 = row.level2 || row.subFunction || '';
            const showL2 = (l2 && l2 !== '无' && l2 !== prevL2) ? l2 : '';
            if (l2 && l2 !== '无') prevL2 = l2;

            const l3 = row.level3 || row.level4 || '';
            const showL3 = (l3 && l3 !== '无' && l3 !== prevL3) ? l3 : '';
            if (l3 && l3 !== '无') prevL3 = l3;

            const rl = row.reuseLevel || '低';
            const coeff = reuseCoeff[rl] || 1.0;
            const afpVal = Math.round((row.fpCount || 0) * coeff * 1000) / 1000;

            const migDim = row.migrationDimension || '';
            const isMigRow = hasMigrationData && migDim && migDim !== '原有业务' && migDim !== '';
            const dataRow = hasMigrationData
                ? worksheet.addRow([showL1, showL2, showL3, row.funcName, row.category, migDim || '原有业务', row.funcDescription || '', row.interfaceDescription || '', row.fpCount || 0, rl, row.modType || '新增', afpVal])
                : worksheet.addRow([showL1, showL2, showL3, row.funcName, row.category, row.funcDescription || '', row.interfaceDescription || '', row.fpCount || 0, rl, row.modType || '新增', afpVal]);

            dataRow.eachCell((cell, colNumber) => {
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
                };
                // 类别列颜色（国产化模式下类别在第5列）
                const catCol = 5;
                if (colNumber === catCol) {
                    cell.font = { bold: true, color: { argb: categoryColors[row.category] || 'FF000000' } };
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
                // 迁移维度列背景色
                if (hasMigrationData && colNumber === 6) {
                    const bgColor = migDimBgColors[migDim] || 'FFF0FFF4';
                    if (isMigRow) {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
                        cell.font = { bold: true, color: { argb: 'FF10B981' }, size: 10 };
                        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                    }
                }
                // 居中列（随有无迁移列调整）
                const centerCols = hasMigrationData ? [5, 6, 9, 10, 11, 12] : [5, 8, 9, 10, 11];
                if (centerCols.includes(colNumber)) {
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
                const afpColNum = hasMigrationData ? 12 : 11;
                if (colNumber === afpColNum) cell.numFmt = '#,##0.000';
            });
        });

        // 汇总尾行
        worksheet.addRow([]);
        const catCounts = {};
        tableData.forEach(r => { catCounts[r.category] = (catCounts[r.category] || 0) + 1; });
        const catSummary = `ILF:${catCounts['ILF'] || 0} EIF:${catCounts['EIF'] || 0} EI:${catCounts['EI'] || 0} EO:${catCounts['EO'] || 0} EQ:${catCounts['EQ'] || 0}`;
        // 根据有无迁移列调整占位
        const footerRow = hasMigrationData
            ? worksheet.addRow(['', '', '', `总计: ${tableData.length}个功能点 | ${catSummary}`, '', '', '', '', totalUFP, '', '', roundedAFP])
            : worksheet.addRow(['', '', '', `总计: ${tableData.length}个功能点 | ${catSummary}`, '', '', '', totalUFP, '', '', roundedAFP]);
        footerRow.getCell(4).font = { bold: true, size: 11 };
        const ufpCol = hasMigrationData ? 9 : 8;
        const afpFooterCol = hasMigrationData ? 12 : 11;
        footerRow.getCell(ufpCol).font = { bold: true, size: 12, color: { argb: 'FF0D4F8B' } };
        footerRow.getCell(ufpCol).numFmt = '#,##0';
        footerRow.getCell(afpFooterCol).font = { bold: true, size: 12, color: { argb: 'FF1E88E5' } };
        footerRow.getCell(afpFooterCol).numFmt = '#,##0.00';
        worksheet.views = [{ state: 'frozen', ySplit: headerRowNum }];



        // ═══════════ Sheet 2: 调整因子 ═══════════
        const ws2 = workbook.addWorksheet('调整因子');
        ws2.addRow(['调整因子列表']).getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0D4F8B' } };
        ws2.addRow([]);
        const afHeaders = ['调整因子', '选项', '描述', '系数值'];
        const afHeaderRow = ws2.addRow(afHeaders);
        afHeaderRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D4F8B' } };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
        });
        const af = adjustmentFactors;
        const factors = [
            ['规模计数时机', af.countingTiming || '项目早期', '项目处于需求规划、需求调研阶段', af.countingTimingValue || 1.39],
            ['应用类型', af.appType || '业务处理', '办公自动化系统、日常管理及业务处理用软件等', af.appTypeValue || 1.0],
            ['开发语言', af.devLanguage || 'JAVA/C++/C#', '', af.devLanguageValue || 1.0],
            ['开发团队背景', af.teamBackground || '有相关行业经验', '', af.teamBackgroundValue || 0.8],
            ['分布式处理', af.distributedProcessing || '客户端/服务器分布式处理', '', af.distributedProcessingValue || 0],
            ['性能', af.performance || '应答时间/处理率很重要', '', af.performanceValue || 0],
            ['可靠性', af.reliability || '故障带来较多不便', '', af.reliabilityValue || 0],
            ['多重站点', af.multiSite || '需考虑不同站点运行', '', af.multiSiteValue || 0],
        ];
        factors.forEach(f => {
            const row = ws2.addRow(f);
            row.eachCell((cell) => {
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
                };
            });
        });
        ws2.columns = [{ width: 18 }, { width: 36 }, { width: 50 }, { width: 12 }];

        // ═══════════ Sheet 3: 详细清单（完整7列+UFP/AFP） ═══════════
        const ws3 = workbook.addWorksheet('详细清单');
        const detailHeaders = ['编号', '一级模块', '二级模块', '三级模块', '业务功能', '功能点类型', '功能需求描述', '外部接口需求描述', 'UFP', '重用程度', '修改类型', 'AFP'];
        const dHeaderRow = ws3.addRow(detailHeaders);
        dHeaderRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D4F8B' } };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
        });
        ws3.columns = [
            { width: 6 },  // 编号
            { width: 20 }, // 一级模块
            { width: 22 }, // 二级模块
            { width: 22 }, // 三级模块
            { width: 32 }, // 业务功能
            { width: 10 }, // 功能点类型
            { width: 40 }, // 功能需求描述
            { width: 36 }, // 外部接口需求描述
            { width: 8 },  // UFP
            { width: 10 }, // 重用程度
            { width: 10 }, // 修改类型
            { width: 10 }, // AFP
        ];
        let prevDL1 = '';
        let prevDL2 = '';
        let prevDL3 = '';
        tableData.forEach((row) => {
            const rl = row.reuseLevel || '低';
            const coeff = reuseCoeff[rl] || 1.0;
            const afpVal = Math.round((row.fpCount || 0) * coeff * 1000) / 1000;

            const l1 = row.level1 || row.funcModule || '';
            const showL1 = (l1 && l1 !== '无' && l1 !== prevDL1) ? l1 : '';
            if (l1 && l1 !== '无') prevDL1 = l1;

            const l2 = row.level2 || row.subFunction || '';
            const showL2 = (l2 && l2 !== '无' && l2 !== prevDL2) ? l2 : '';
            if (l2 && l2 !== '无') prevDL2 = l2;

            const l3 = row.level3 || row.level4 || '';
            const showL3 = (l3 && l3 !== '无' && l3 !== prevDL3) ? l3 : '';
            if (l3 && l3 !== '无') prevDL3 = l3;

            const dRow = ws3.addRow([
                row.id, showL1, showL2, showL3, row.funcName, row.category,
                row.funcDescription || '', row.interfaceDescription || '',
                row.fpCount, rl, row.modType, afpVal
            ]);
            dRow.eachCell((cell, colNumber) => {
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
                };
                if ([1, 6, 9, 10, 11, 12].includes(colNumber)) {
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
                if (colNumber === 6) {
                    cell.font = { bold: true, color: { argb: categoryColors[row.category] || 'FF000000' } };
                }
                if (colNumber === 12) cell.numFmt = '#,##0.000';
            });
        });
        ws3.views = [{ state: 'frozen', ySplit: 1 }];

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('NESMA导出Excel失败:', error);
        res.status(500).json({ error: 'NESMA导出Excel失败: ' + error.message });
    }
});

// ═══════════════════════ SPA回退路由 ═══════════════════════

if (process.env.NODE_ENV === 'production') {
    app.get('*', (req, res) => {
        const indexPath = path.join(__dirname, '..', 'client', 'dist', 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            res.status(404).json({ error: 'Frontend not built. Run npm run build first.' });
        }
    });
}

// ═══════════════════════ 启动服务 ═══════════════════════

(async () => {
    try {
        // 初始化 PostgreSQL 数据库表结构
        await initDatabase();
        console.log('✅ 数据库就绪');
    } catch (err) {
        console.error('⚠️ 数据库初始化失败，登录/历史功能将不可用:', err.message);
    }

    // ═══════════ 补充功能描述 ═══════════
    app.post('/api/supplement-description', async (req, res) => {
        try {
            const { tableData, userConfig = null } = req.body;

            if (!tableData || tableData.length === 0) {
                return res.status(400).json({ error: '没有可补充的数据' });
            }

            console.log('🔄 补充功能描述中...');
            const generationResult = await generateFunctionDescriptionsWithAI(tableData, userConfig, {
                forceRegenerate: true
            });
            const supplementedCount = generationResult.generatedCount + generationResult.fallbackCount;

            console.log(`✅ 功能描述补充完成，共补充 ${supplementedCount} 个`);

            res.json({
                success: true,
                tableData: generationResult.tableData,
                supplementedCount,
                descriptionGeneration: {
                    source: generationResult.generatedCount > 0 ? 'ai-regenerated' : 'local-fallback',
                    generatedCount: generationResult.generatedCount,
                    fallbackCount: generationResult.fallbackCount,
                    error: generationResult.error
                }
            });
        } catch (error) {
            console.error('❌ 补充功能描述失败:', error);
            res.status(500).json({
                error: error.message || '补充功能描述失败'
            });
        }
    });

    app.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════════════════════╗
║         AI 智能分析与办公文档处理系统 v2.1              ║
╠══════════════════════════════════════════════════════════╣
║  🌐 服务地址: http://localhost:${PORT}                    ║
║  🤖 当前模型: ${currentModel.padEnd(40)}║
║  📡 API平台: SenseNova (api.sensenova.cn)              ║
║  🔑 API密钥: ${process.env.SENSENOVA_API_KEY ? '已配置 ✅' : '未配置 ❌'}                               ║
║  🐘 数据库:  PostgreSQL (Render)                        ║
╚══════════════════════════════════════════════════════════╝
      `);
    });
})();
