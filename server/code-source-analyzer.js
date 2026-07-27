const path = require('path');
const JSZip = require('jszip');
const { canonicalFunctionNameKey } = require('./cosmic-quality');

const MAX_SOURCE_CHARS = 120000;
const MAX_FILE_CHARS = 24000;
const MAX_INCLUDED_FILES = 80;
const MAX_SCREENSHOTS = 8;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

const SOURCE_EXTENSIONS = new Set([
    '.html', '.htm', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
    '.vue', '.svelte', '.css', '.scss', '.sass', '.less',
    '.json', '.xml', '.yaml', '.yml', '.md', '.txt',
    '.java', '.kt', '.kts', '.py', '.go', '.php', '.rb', '.rs',
    '.cs', '.fs', '.vb', '.sql', '.graphql', '.gql',
    '.properties', '.toml', '.ini', '.conf', '.gradle'
]);

const IMPORTANT_FILENAMES = new Set([
    'package.json', 'pom.xml', 'build.gradle', 'settings.gradle',
    'requirements.txt', 'pyproject.toml', 'cargo.toml', 'go.mod',
    'readme.md', 'readme.txt', 'openapi.json', 'openapi.yaml',
    'swagger.json', 'swagger.yaml', 'docker-compose.yml', 'docker-compose.yaml'
]);

const IGNORED_PATH_PATTERN = /(^|\/)(?:node_modules|vendor|dist|build|coverage|target|bin|obj|\.git|\.idea|\.vscode|__pycache__|\.next|\.nuxt|public\/assets)(?:\/|$)/i;
const MINIFIED_FILE_PATTERN = /(?:\.min\.(?:js|css)$|(?:^|\/)(?:bundle|chunk|vendor)[.-].*\.(?:js|css)$)/i;
const IMAGE_MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
};

const cleanText = (value) => String(value || '')
    .normalize('NFKC')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .trim();

const normalizeModuleText = (value) => cleanText(value)
    .replace(/^\s*\d+(?:\.\d+)*[.、\s-]*/, '')
    .replace(/[\s_\-—–，,。；;：:（）()【】\[\]“”"'·]/g, '')
    .toLowerCase();

function isSourceFile(filename) {
    const normalized = String(filename || '').replace(/\\/g, '/');
    const basename = path.posix.basename(normalized).toLowerCase();
    return IMPORTANT_FILENAMES.has(basename) || SOURCE_EXTENSIONS.has(path.posix.extname(basename));
}

function sourceFilePriority(filename) {
    const normalized = String(filename || '').replace(/\\/g, '/').toLowerCase();
    const basename = path.posix.basename(normalized);
    let score = 0;
    if (IMPORTANT_FILENAMES.has(basename)) score += 1000;
    if (/(?:^|\/)(?:src|app|pages|views|routes|router|controllers|services|api|components)\//.test(normalized)) score += 240;
    if (/(?:route|router|controller|service|page|view|screen|form|api)/.test(basename)) score += 150;
    if (/\.(?:html?|vue|svelte|tsx|jsx)$/.test(basename)) score += 120;
    if (/\.(?:ts|js|py|java|kt|cs|go|php|rb|rs)$/.test(basename)) score += 80;
    score -= normalized.split('/').length;
    return score;
}

function sanitizeSourceText(text) {
    return cleanText(text)
        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[内嵌图片已省略]')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n');
}

function buildFileTree(names) {
    const displayed = names.slice(0, 500);
    const lines = displayed.map(name => `- ${name}`);
    if (names.length > displayed.length) {
        lines.push(`- ... 另有 ${names.length - displayed.length} 个文件未展示`);
    }
    return lines.join('\n');
}

async function extractZipSource(buffer, originalName = 'source.zip') {
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
    const allNames = Object.values(zip.files)
        .filter(entry => !entry.dir)
        .map(entry => entry.name.replace(/\\/g, '/'))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));

    const candidates = Object.values(zip.files)
        .filter(entry => !entry.dir)
        .filter(entry => {
            const normalized = entry.name.replace(/\\/g, '/');
            return !IGNORED_PATH_PATTERN.test(normalized)
                && !MINIFIED_FILE_PATTERN.test(normalized)
                && isSourceFile(normalized);
        })
        .sort((left, right) => (
            sourceFilePriority(right.name) - sourceFilePriority(left.name)
            || left.name.localeCompare(right.name, 'zh-CN')
        ));

    const sections = [];
    const includedFiles = [];
    let totalChars = 0;
    let truncated = false;

    for (const entry of candidates) {
        if (includedFiles.length >= MAX_INCLUDED_FILES || totalChars >= MAX_SOURCE_CHARS) {
            truncated = true;
            break;
        }
        const declaredSize = Number(entry?._data?.uncompressedSize) || 0;
        if (declaredSize > MAX_FILE_CHARS * 8) continue;

        let text;
        try {
            text = sanitizeSourceText(await entry.async('string'));
        } catch (error) {
            continue;
        }
        if (!text || text.includes('\uFFFD\uFFFD\uFFFD')) continue;

        const remaining = MAX_SOURCE_CHARS - totalChars;
        const clipped = text.slice(0, Math.min(MAX_FILE_CHARS, remaining));
        if (!clipped) break;
        sections.push(`\n===== 文件: ${entry.name} =====\n${clipped}`);
        includedFiles.push(entry.name);
        totalChars += clipped.length;
        if (clipped.length < text.length) truncated = true;
    }

    return {
        sourceName: originalName,
        sourceType: 'zip',
        fileCount: allNames.length,
        candidateCount: candidates.length,
        includedFiles,
        ignoredCount: Math.max(0, allNames.length - includedFiles.length),
        truncated,
        text: `# 压缩包文件树\n${buildFileTree(allNames)}\n\n# 重点源码摘录\n${sections.join('\n')}`.trim()
    };
}

function extractHtmlSource(buffer, originalName = 'page.html') {
    const raw = sanitizeSourceText(buffer.toString('utf8'));
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
        ?.replace(/<[^>]+>/g, ' ')
        ?.replace(/\s+/g, ' ')
        ?.trim() || '';
    const visibleText = raw
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const clippedHtml = raw.slice(0, MAX_SOURCE_CHARS);

    return {
        sourceName: originalName,
        sourceType: 'html',
        fileCount: 1,
        candidateCount: 1,
        includedFiles: [originalName],
        ignoredCount: 0,
        truncated: clippedHtml.length < raw.length,
        title,
        text: `# 页面标题\n${title || '未识别'}\n\n# 页面可见文本\n${visibleText.slice(0, 30000)}\n\n# HTML源码\n${clippedHtml}`.trim()
    };
}

async function extractSourceArtifact(buffer, originalName) {
    const ext = path.extname(originalName || '').toLowerCase();
    if (ext === '.zip') return extractZipSource(buffer, originalName);
    if (ext === '.html' || ext === '.htm') return extractHtmlSource(buffer, originalName);
    throw new Error(`不支持的代码源格式: ${ext || '未知'}，请上传 .zip、.html 或 .htm`);
}

function extractJsonObject(content) {
    const raw = cleanText(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
        return JSON.parse(raw);
    } catch (error) {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('AI未返回可解析的JSON对象');
        return JSON.parse(raw.slice(start, end + 1));
    }
}

function normalizeStringList(value, maxItems) {
    const seen = new Set();
    const result = [];
    for (const item of Array.isArray(value) ? value : []) {
        const text = cleanText(item);
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        result.push(text);
        if (result.length >= maxItems) break;
    }
    return result;
}

function normalizeModules(modules = []) {
    const seen = new Set();
    const result = [];
    for (const module of Array.isArray(modules) ? modules : []) {
        const level1 = cleanText(module?.level1);
        const level2 = cleanText(module?.level2);
        const level3 = cleanText(module?.level3 || module?.level2);
        const key = [level1, level2, level3].map(normalizeModuleText).join('|');
        if (!level3 || seen.has(key)) continue;
        seen.add(key);
        result.push({
            level1,
            level2,
            level3,
            businessObjects: normalizeStringList(module?.businessObjects, 12),
            estimatedFunctions: Math.max(1, Number(module?.estimatedFunctions) || 5),
            triggerTypes: normalizeStringList(module?.triggerTypes, 6)
        });
    }
    return result;
}

function normalizeFunctions(functions = []) {
    const seen = new Set();
    const result = [];
    for (const item of Array.isArray(functions) ? functions : []) {
        const functionName = cleanText(item?.functionName || item?.functionalProcess);
        const key = canonicalFunctionNameKey(functionName);
        if (!functionName || !key || seen.has(key)) continue;
        seen.add(key);
        const level3 = cleanText(item?.level3 || item?.module);
        result.push({
            triggerEvent: cleanText(item?.triggerEvent) || '用户发起业务操作',
            functionalUser: cleanText(item?.functionalUser) || '发起者：用户 接收者：用户',
            functionName,
            description: cleanText(item?.description) || `${functionName}：系统接收业务请求，处理相关业务数据并返回处理结果。`,
            level1: cleanText(item?.level1),
            level2: cleanText(item?.level2),
            level3,
            sourceChapter: cleanText(item?.sourceChapter) || level3,
            sourceEvidence: cleanText(item?.sourceEvidence)
        });
    }
    return result;
}

function buildRequirementFallback({ systemName, summary, modules, functions, assumptions = [] }) {
    const moduleLines = modules.length
        ? modules.map((module, index) => (
            `${index + 1}. ${module.level1 || '功能域'} > ${module.level2 || '功能模块'} > ${module.level3}`
        )).join('\n')
        : '1. 待进一步识别功能模块';
    const functionSections = functions.map((func, index) => (
        `### 3.${index + 1} ${func.functionName}\n`
        + `- 所属模块：${[func.level1, func.level2, func.level3].filter(Boolean).join(' > ') || '待确认'}\n`
        + `- 功能用户：${func.functionalUser}\n`
        + `- 触发事件：${func.triggerEvent}\n`
        + `- 功能说明：${func.description}\n`
        + `${func.sourceEvidence ? `- 识别依据：${func.sourceEvidence}\n` : ''}`
    )).join('\n');

    return `# ${systemName || '代码反向识别系统'}功能需求说明书

## 1. 项目概述

${summary || '本需求文档依据上传的代码、HTML页面和系统截图反向识别生成，需结合实际业务进行复核。'}

## 2. 功能架构

${moduleLines}

## 3. 功能需求

${functionSections || '暂未识别到可独立度量的业务功能过程。'}

## 4. 数据与外部接口

数据实体、接口方向和持久化边界依据代码及界面证据初步识别，后续COSMIC拆分时需进一步确认E、R、W、X数据移动。

## 5. 假设与待确认项

${normalizeStringList(assumptions, 20).map(item => `- ${item}`).join('\n') || '- 需由业务人员确认功能用户、业务边界和未在界面中展示的后台任务。'}
`;
}

function buildFunctionListText(functions = []) {
    return functions.map(func => {
        const sourcePrefix = func.sourceChapter ? `[${func.sourceChapter}] ` : '';
        return `##触发事件：${func.triggerEvent}\n`
            + `##功能用户：${func.functionalUser}\n`
            + `##功能过程：${sourcePrefix}${func.functionName}\n`
            + `##功能过程描述：${func.description}`;
    }).join('\n\n');
}

function normalizeAnalysisPayload(payload = {}) {
    const modules = normalizeModules(payload.modules);
    const functions = normalizeFunctions(payload.functions);
    const systemName = cleanText(payload.systemName) || '代码反向识别系统';
    const summary = cleanText(payload.summary);
    const assumptions = normalizeStringList(payload.assumptions, 20);
    const requirementDocument = cleanText(payload.requirementDocument)
        || buildRequirementFallback({ systemName, summary, modules, functions, assumptions });
    return {
        systemName,
        summary,
        modules,
        functions,
        assumptions,
        requirementDocument,
        functionList: buildFunctionListText(functions)
    };
}

function buildSourceAnalysisPrompt({ sourceArtifact, screenshotObservation, analysisMode, userGuidelines }) {
    const modeInstruction = analysisMode === 'direct'
        ? '本次优先形成可直接进入COSMIC拆分的完整功能过程清单，同时生成一份可追溯的需求文档。'
        : '本次优先生成结构完整的需求文档，并同步给出功能过程候选清单，供后续模块识别和COSMIC拆分使用。';
    const sourceText = sourceArtifact?.text || '未上传代码文件。';
    const screenshotText = screenshotObservation || '未上传截图或截图未能识别。';
    return `${modeInstruction}

请依据下面的代码/页面证据和截图观察结果进行软件需求反向分析。

【分析规则】
1. 只识别对功能用户有业务意义、可独立触发并产生业务结果的功能过程。
2. 不要把类、方法、组件、CSS样式、日志、异常处理、框架初始化、技术中间件直接当成功能过程。
3. API、定时任务、导入导出、审批流、统计查询等只有具备独立业务目的时才形成单独功能过程。
4. 合并同一业务目的的列表/详情/筛选/分页，以及仅名称不同但目的相同的重复功能。
5. 功能名称必须全局唯一，使用“动词+明确业务对象”，不能用“功能1/功能2”凑数。
6. 无法从证据确认的内容写入 assumptions，不得虚构具体业务规则。
7. requirementDocument 使用中文Markdown，至少包含：项目概述、用户角色、功能架构、逐项功能需求、数据实体、外部接口、非功能需求、假设与待确认项。
8. modules 是页面/面板/业务域级三级模块，不要把按钮或字段拆成模块。
9. functions 中 functionalUser 使用“发起者：xxx 接收者：xxx”的格式。

【输出格式】
只输出一个JSON对象，不要输出代码围栏或解释：
{
  "systemName": "系统名称",
  "summary": "系统业务概述",
  "requirementDocument": "# 完整Markdown需求文档",
  "modules": [
    {
      "level1": "1 一级模块",
      "level2": "1.1 二级模块",
      "level3": "1.1.1 三级模块",
      "businessObjects": ["业务对象"],
      "estimatedFunctions": 5,
      "triggerTypes": ["用户触发"]
    }
  ],
  "functions": [
    {
      "triggerEvent": "触发事件",
      "functionalUser": "发起者：用户 接收者：系统",
      "functionName": "查询业务对象",
      "description": "完整业务处理说明",
      "level1": "1 一级模块",
      "level2": "1.1 二级模块",
      "level3": "1.1.1 三级模块",
      "sourceEvidence": "对应页面、接口或源码文件"
    }
  ],
  "assumptions": ["待确认事项"]
}

【用户补充要求】
${cleanText(userGuidelines) || '无'}

【代码/HTML证据】
${sourceText}

【系统截图观察结果】
${screenshotText}`;
}

async function analyzeScreenshots(files, callAIWithRetry, userConfig = null) {
    if (!Array.isArray(files) || files.length === 0) {
        return { observation: '', warning: '' };
    }
    if (files.length > MAX_SCREENSHOTS) {
        throw new Error(`系统截图最多上传 ${MAX_SCREENSHOTS} 张`);
    }

    const imageParts = [];
    for (const file of files) {
        if (!file?.buffer) continue;
        if (file.buffer.length > MAX_SCREENSHOT_BYTES) {
            throw new Error(`截图 ${file.originalname || ''} 超过10MB限制`);
        }
        const ext = path.extname(file.originalname || '').toLowerCase();
        const mime = IMAGE_MIME_TYPES[ext] || file.mimetype;
        if (!IMAGE_MIME_TYPES[ext] || !mime) continue;
        imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${file.buffer.toString('base64')}` }
        });
    }
    if (imageParts.length === 0) return { observation: '', warning: '未找到可识别的截图' };

    const dedicatedApiKey = process.env.VISION_API_KEY || process.env.GPT_API_KEY || null;
    const dedicatedBaseUrl = process.env.VISION_BASE_URL
        || (process.env.VISION_API_KEY ? 'https://api.openai.com/v1' : process.env.GPT_BASE_URL)
        || null;
    const dedicatedModel = process.env.VISION_MODEL || 'gpt-4o-mini';
    const selectedModel = userConfig?.model || process.env.DEFAULT_MODEL;
    const useDedicatedVision = Boolean(dedicatedApiKey && dedicatedBaseUrl);

    try {
        const completion = await callAIWithRetry({
            messages: [
                {
                    role: 'system',
                    content: '你是软件界面需求分析专家。只描述截图中可观察到的业务功能、用户操作、字段、状态、导航、数据展示和可能的业务对象；不要猜测不可见实现。'
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '请逐张分析这些系统截图，并合并输出：页面名称、用户可执行操作、输入字段、查询条件、列表/图表、状态变化、业务对象、页面间流程和待确认项。'
                        },
                        ...imageParts
                    ]
                }
            ],
            model: useDedicatedVision ? dedicatedModel : selectedModel,
            apiKey: useDedicatedVision ? dedicatedApiKey : (userConfig?.apiKey || null),
            baseUrl: useDedicatedVision ? dedicatedBaseUrl : (userConfig?.baseUrl || null),
            temperature: 0.1,
            max_tokens: 6000
        }, 3);
        const observation = cleanText(completion?.choices?.[0]?.message?.content);
        return { observation, warning: observation ? '' : '截图识别服务返回了空结果' };
    } catch (error) {
        return {
            observation: '',
            warning: `截图识别失败：${error.message}`
        };
    }
}

async function analyzeCodeSource({
    sourceArtifact,
    screenshotFiles,
    analysisMode,
    userGuidelines,
    userConfig,
    modelName,
    callAIWithRetry
}) {
    const screenshotResult = await analyzeScreenshots(screenshotFiles, callAIWithRetry, userConfig);
    if (!sourceArtifact?.text && !screenshotResult.observation) {
        throw new Error(screenshotResult.warning || '没有可供分析的代码、HTML或截图内容');
    }

    const prompt = buildSourceAnalysisPrompt({
        sourceArtifact,
        screenshotObservation: screenshotResult.observation,
        analysisMode,
        userGuidelines
    });
    const completion = await callAIWithRetry({
        messages: [
            {
                role: 'system',
                content: '你是资深软件需求逆向分析师和COSMIC功能规模度量专家，擅长从代码、HTML和系统界面还原业务需求。'
            },
            { role: 'user', content: prompt }
        ],
        model: modelName,
        apiKey: userConfig?.apiKey || null,
        baseUrl: userConfig?.baseUrl || null,
        temperature: 0.15,
        max_tokens: 16000
    });
    const content = completion?.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI没有返回代码反向分析结果');

    const normalized = normalizeAnalysisPayload(extractJsonObject(content));
    if (analysisMode === 'direct' && normalized.functions.length === 0) {
        throw new Error('未从当前代码/截图中识别到可直接拆分的功能过程，请改用“先生成需求文档”模式并补充业务说明');
    }
    return {
        ...normalized,
        screenshotObservation: screenshotResult.observation,
        warnings: screenshotResult.warning ? [screenshotResult.warning] : []
    };
}

module.exports = {
    MAX_SCREENSHOTS,
    analyzeCodeSource,
    buildRequirementFallback,
    extractSourceArtifact,
    normalizeAnalysisPayload
};
