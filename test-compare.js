/**
 * 并发对比测试：OpenRouter DeepSeek V4 Flash (free) vs 火山引擎 DeepSeek-V3.2
 * 用同一段文档 + 同一个 COSMIC 提示词，同时调用两个平台，对比结果
 */

const OpenAI = require('openai');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ═══════════ 配置 ═══════════

const IFLOW_CONFIG = {
    name: 'OpenRouter DeepSeek V4 Flash (free)',
    apiKey: process.env.OPENROUTER_API_KEY || process.env.IFLOW_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash:free'
};

const VOLCENGINE_CONFIG = {
    name: '火山引擎 DeepSeek-V3.2',
    apiKey: process.env.VOLCENGINE_API_KEY,
    baseURL: process.env.VOLCENGINE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    model: process.env.VOLCENGINE_MODEL || 'deepseek-v3-2-251201'
};

// ═══════════ 测试文档（精简版，覆盖多种功能类型） ═══════════

const TEST_DOCUMENT = `
3.1 用户管理模块
系统提供完整的用户管理功能。管理员可以在用户管理页面查看所有已注册的用户列表，支持按用户名、手机号、注册时间进行筛选。
管理员可以新增用户，填写用户名、密码、手机号、所属部门等信息后提交创建。
管理员可以修改用户信息，包括手机号、所属部门、用户状态（启用/禁用）等。
管理员可以删除用户账号（逻辑删除）。
用户可以登录系统，系统验证用户名和密码后返回登录凭证。
用户可以修改自己的密码。

3.2 工单管理模块
用户可以创建问题工单，填写工单标题、问题描述、关联设备、优先级（紧急/高/中/低）等信息。
工单创建后状态为"待分配"。组长可以将工单分配给具体处理人，状态变为"处理中"。
处理人完成处理后提交处理结果，状态变为"待审核"。
组长审核工单，可以审核通过（状态变为"已完成"）或驳回（状态回到"处理中"）。
用户可以查看工单列表，支持按状态、优先级、创建时间筛选。
用户可以查看工单详情，包括处理历史记录。
系统支持导出工单数据为Excel文件。

3.3 数据统计模块
系统每天凌晨2点自动汇总各部门的工单完成情况，生成部门工单统计数据。
系统每周一自动生成上周的工单处理时效分析数据，计算平均处理时长、超时率等指标。
用户可以在统计页面查看各类统计图表。
系统每天检查超时未处理的工单，自动发送预警短信给相关负责人。
`;

// ═══════════ COSMIC 提示词（精简版） ═══════════

const SYSTEM_PROMPT = `你是一个顶级Cosmic拆分专家。请从以下需求文档中提取所有功能过程列表。

# 触发事件识别
1. 用户触发：系统页面实际存在的按钮功能
2. 时钟触发：定时任务、自动流转
3. 接口调用触发：接口作为被调用方

# 功能用户对应规则
- 用户触发 → 发起者：用户 接收者：用户
- 时钟触发 → 发起者：定时触发器 接收者：本系统
- 接口调用触发 → 发起者：调用方系统 接收者：本系统

# 输出格式
每个功能过程用##标记：

##触发事件：用户触发
##功能用户：发起者：用户 接收者：用户
##功能过程：创建问题工单
##功能过程描述：用户在页面上填写工单信息并提交

要求：宁可多提取，不可遗漏。逐段逐句阅读文档。`;

// ═══════════ 测试函数 ═══════════

async function callPlatform(config) {
    const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL
    });

    const startTime = Date.now();

    try {
        const completion = await client.chat.completions.create({
            model: config.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `请分析以下需求文档，提取所有功能过程：\n\n${TEST_DOCUMENT}` }
            ],
            temperature: 0.3,
            max_tokens: 4000,
            stream: false
        });

        const endTime = Date.now();
        const elapsed = ((endTime - startTime) / 1000).toFixed(1);
        const content = completion.choices?.[0]?.message?.content || '';
        const usage = completion.usage || {};

        // 统计提取到的功能过程数
        const funcMatches = content.match(/##功能过程：/g);
        const funcCount = funcMatches ? funcMatches.length : 0;

        // 统计触发类型分布
        const userTrigger = (content.match(/用户触发/g) || []).length;
        const clockTrigger = (content.match(/时钟触发/g) || []).length;
        const interfaceTrigger = (content.match(/接口.*触发/g) || []).length;

        return {
            platform: config.name,
            model: config.model,
            success: true,
            elapsed: `${elapsed}s`,
            elapsedMs: endTime - startTime,
            funcCount,
            triggerDist: { 用户触发: userTrigger, 时钟触发: clockTrigger, 接口触发: interfaceTrigger },
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0,
            contentLength: content.length,
            content  // 原始内容，用于详细对比
        };
    } catch (error) {
        const endTime = Date.now();
        return {
            platform: config.name,
            model: config.model,
            success: false,
            elapsed: `${((endTime - startTime) / 1000).toFixed(1)}s`,
            elapsedMs: endTime - startTime,
            error: `${error.status || error.code || '?'} - ${error.message?.substring(0, 200)}`
        };
    }
}

function extractFunctionNames(content) {
    const names = [];
    const lines = content.split('\n');
    for (const line of lines) {
        const match = line.match(/##\s*功能过程[：:]\s*(.+)/);
        if (match) names.push(match[1].trim());
    }
    return names;
}

// ═══════════ 主流程 ═══════════

async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  COSMIC 拆分 - OpenRouter vs 火山引擎 并发对比测试');
    console.log('═══════════════════════════════════════════════════════');
    console.log();
    console.log(`📄 测试文档长度: ${TEST_DOCUMENT.length} 字符`);
    console.log(`🕐 开始时间: ${new Date().toLocaleTimeString()}`);
    console.log();

    // 检查 API Key
    if (!IFLOW_CONFIG.apiKey) {
        console.error('❌ 缺少 OPENROUTER_API_KEY');
        return;
    }
    if (!VOLCENGINE_CONFIG.apiKey) {
        console.error('❌ 缺少 VOLCENGINE_API_KEY');
        return;
    }

    console.log('🚀 并发调用中...\n');

    // 并发调用
    const [iflowResult, volcResult] = await Promise.all([
        callPlatform(IFLOW_CONFIG),
        callPlatform(VOLCENGINE_CONFIG)
    ]);

    // ═══════════ 输出结果 ═══════════

    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║                    对比结果                          ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log();

    // 基础信息
    const table = [
        ['指标', iflowResult.platform, volcResult.platform],
        ['─────', '──────────', '──────────'],
        ['模型名', iflowResult.model, volcResult.model],
        ['状态', iflowResult.success ? '✅ 成功' : '❌ 失败', volcResult.success ? '✅ 成功' : '❌ 失败'],
        ['响应时间', iflowResult.elapsed, volcResult.elapsed],
    ];

    if (iflowResult.success && volcResult.success) {
        const speedDiff = ((iflowResult.elapsedMs - volcResult.elapsedMs) / 1000).toFixed(1);
        const faster = iflowResult.elapsedMs < volcResult.elapsedMs ? 'OpenRouter' : '火山';

        table.push(
            ['功能过程数', String(iflowResult.funcCount), String(volcResult.funcCount)],
            ['触发类型分布',
                `用户:${iflowResult.triggerDist.用户触发} 时钟:${iflowResult.triggerDist.时钟触发} 接口:${iflowResult.triggerDist.接口触发}`,
                `用户:${volcResult.triggerDist.用户触发} 时钟:${volcResult.triggerDist.时钟触发} 接口:${volcResult.triggerDist.接口触发}`
            ],
            ['Prompt Tokens', String(iflowResult.promptTokens), String(volcResult.promptTokens)],
            ['Completion Tokens', String(iflowResult.completionTokens), String(volcResult.completionTokens)],
            ['Total Tokens', String(iflowResult.totalTokens), String(volcResult.totalTokens)],
            ['输出长度(字符)', String(iflowResult.contentLength), String(volcResult.contentLength)]
        );

        // 打印表格
        for (const row of table) {
            console.log(`  ${row[0].padEnd(18)} │ ${row[1].padEnd(25)} │ ${row[2]}`);
        }

        console.log();
        console.log(`  ⚡ 速度对比: ${faster}更快，快 ${Math.abs(speedDiff)} 秒`);
        console.log(`  📊 功能数差距: ${Math.abs(iflowResult.funcCount - volcResult.funcCount)} 个 (${iflowResult.funcCount} vs ${volcResult.funcCount})`);

        // 提取功能名称对比
        const iflowFuncs = extractFunctionNames(iflowResult.content);
        const volcFuncs = extractFunctionNames(volcResult.content);

        console.log();
        console.log('──────────────────────────────────────────────────────');
        console.log('  📋 OpenRouter 提取的功能过程:');
        iflowFuncs.forEach((f, i) => console.log(`     ${i + 1}. ${f}`));

        console.log();
        console.log('  📋 火山引擎提取的功能过程:');
        volcFuncs.forEach((f, i) => console.log(`     ${i + 1}. ${f}`));

        // 差异分析
        const iflowSet = new Set(iflowFuncs.map(f => f.toLowerCase()));
        const volcSet = new Set(volcFuncs.map(f => f.toLowerCase()));

        const onlyIflow = iflowFuncs.filter(f => !volcSet.has(f.toLowerCase()));
        const onlyVolc = volcFuncs.filter(f => !iflowSet.has(f.toLowerCase()));

        if (onlyIflow.length > 0 || onlyVolc.length > 0) {
            console.log();
            console.log('──────────────────────────────────────────────────────');
            console.log('  🔍 差异分析（仅一方提取到的功能）:');
            if (onlyIflow.length > 0) {
                console.log(`     仅 OpenRouter 有 (${onlyIflow.length}个):`);
                onlyIflow.forEach(f => console.log(`       + ${f}`));
            }
            if (onlyVolc.length > 0) {
                console.log(`     仅火山有 (${onlyVolc.length}个):`);
                onlyVolc.forEach(f => console.log(`       + ${f}`));
            }
        }
    } else {
        for (const row of table) {
            console.log(`  ${row[0].padEnd(18)} │ ${row[1].padEnd(25)} │ ${row[2]}`);
        }
        if (!iflowResult.success) console.log(`\n  ❌ OpenRouter错误: ${iflowResult.error}`);
        if (!volcResult.success) console.log(`\n  ❌ 火山错误: ${volcResult.error}`);
    }

    console.log();
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  🕐 完成时间: ${new Date().toLocaleTimeString()}`);
    console.log('═══════════════════════════════════════════════════════');
}

main().catch(err => console.error('测试脚本错误:', err));
