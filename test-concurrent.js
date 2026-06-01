/**
 * COSMIC 拆分系统 - 并发压力测试
 * 
 * 测试内容：
 * 1. Render 后端健康检查 + 冷启动唤醒
 * 2. OpenRouter DeepSeek V4 Flash (free) 并发测试（1/2/3/5并发）
 * 3. 火山引擎 DeepSeek-V3 并发测试（1/2/3/5并发）
 * 4. 混合并发：同时调用两个平台
 * 5. Render 后端并发（通过部署的服务调用 AI）
 */

const OpenAI = require('openai');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ═══════════ 配置 ═══════════

const RENDER_URL = 'https://cosmic-split-system.onrender.com';

const IFLOW_CONFIG = {
    name: 'OpenRouter DeepSeek V4 Flash (free)',
    apiKey: process.env.OPENROUTER_API_KEY || process.env.IFLOW_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash:free'
};

const VOLCENGINE_CONFIG = {
    name: '火山引擎 DeepSeek-V3',
    apiKey: process.env.VOLCENGINE_API_KEY,
    baseURL: process.env.VOLCENGINE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    model: process.env.VOLCENGINE_MODEL || 'deepseek-v3-250324'
};

// ═══════════ 测试文档（不同长度，模拟真实场景） ═══════════

const DOCS = {
    short: `用户管理模块：管理员可以新增用户，填写用户名、密码、手机号。管理员可以修改、删除用户。用户可以登录系统，修改自己的密码。`,

    medium: `3.1 用户管理模块
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
系统支持导出工单数据为Excel文件。`
};

const SYSTEM_PROMPT = `你是一个COSMIC拆分专家。请从需求文档中提取功能过程列表。
每个功能过程用##标记：
##触发事件：用户触发
##功能用户：发起者：用户 接收者：用户
##功能过程：创建问题工单
##功能过程描述：用户填写工单信息并提交

要求：宁可多提取，不可遗漏。`;

// ═══════════ 工具函数 ═══════════

function timestamp() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function color(text, code) {
    return `\x1b[${code}m${text}\x1b[0m`;
}

const GREEN = '32', RED = '31', YELLOW = '33', CYAN = '36', BOLD = '1', DIM = '2';

// ═══════════ 核心测试函数 ═══════════

/**
 * 单次 AI 平台调用
 */
async function callOnce(config, taskId, doc = DOCS.medium) {
    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    const start = Date.now();

    try {
        const completion = await client.chat.completions.create({
            model: config.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `请分析以下需求文档：\n\n${doc}` }
            ],
            temperature: 0.3,
            max_tokens: 4000,
            stream: false
        });

        const elapsed = Date.now() - start;
        const content = completion.choices?.[0]?.message?.content || '';
        const funcCount = (content.match(/##功能过程[：:]/g) || []).length;
        const tokens = completion.usage?.total_tokens || 0;

        return {
            taskId,
            success: true,
            elapsed,
            funcCount,
            tokens,
            contentLen: content.length
        };
    } catch (error) {
        return {
            taskId,
            success: false,
            elapsed: Date.now() - start,
            error: `${error.status || error.code || '?'}: ${(error.message || '').substring(0, 120)}`
        };
    }
}

/**
 * 并发测试：同时发 N 个请求
 */
async function concurrencyTest(config, concurrency, doc = DOCS.medium) {
    const tasks = [];
    for (let i = 0; i < concurrency; i++) {
        tasks.push(callOnce(config, i + 1, doc));
    }

    const start = Date.now();
    const results = await Promise.all(tasks);
    const totalTime = Date.now() - start;

    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);
    const avgElapsed = successes.length > 0
        ? Math.round(successes.reduce((s, r) => s + r.elapsed, 0) / successes.length)
        : 0;
    const maxElapsed = successes.length > 0
        ? Math.max(...successes.map(r => r.elapsed))
        : 0;
    const minElapsed = successes.length > 0
        ? Math.min(...successes.map(r => r.elapsed))
        : 0;

    return {
        concurrency,
        totalTime,
        successes: successes.length,
        failures: failures.length,
        avgElapsed,
        minElapsed,
        maxElapsed,
        results,
        failureDetails: failures.map(f => f.error)
    };
}

/**
 * Render 后端调用测试
 */
async function testRenderEndpoint(endpoint, body, label) {
    const start = Date.now();
    try {
        const res = await fetch(`${RENDER_URL}${endpoint}`, {
            method: body ? 'POST' : 'GET',
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(120000) // 2分钟超时
        });
        const elapsed = Date.now() - start;
        const data = await res.json();
        return { label, success: res.ok, elapsed, status: res.status, data };
    } catch (error) {
        return { label, success: false, elapsed: Date.now() - start, error: error.message };
    }
}

// ═══════════ 打印函数 ═══════════

function printHeader(title) {
    console.log();
    console.log(color('╔' + '═'.repeat(62) + '╗', BOLD));
    console.log(color('║', BOLD) + `  ${title}`.padEnd(62) + color('║', BOLD));
    console.log(color('╚' + '═'.repeat(62) + '╝', BOLD));
}

function printConcurrencyResult(platformName, result) {
    const statusIcon = result.failures === 0 ? '✅' : result.failures === result.concurrency ? '❌' : '⚠️';
    console.log(`  ${statusIcon} ${color(platformName, BOLD)} × ${result.concurrency} 并发`);
    console.log(`     总耗时: ${color((result.totalTime / 1000).toFixed(1) + 's', CYAN)}`);
    console.log(`     成功/失败: ${color(result.successes, GREEN)}/${color(result.failures, result.failures > 0 ? RED : GREEN)}`);
    if (result.successes > 0) {
        console.log(`     响应时间: 最快 ${color((result.minElapsed / 1000).toFixed(1) + 's', GREEN)} | 平均 ${color((result.avgElapsed / 1000).toFixed(1) + 's', YELLOW)} | 最慢 ${color((result.maxElapsed / 1000).toFixed(1) + 's', RED)}`);
        const funcCounts = result.results.filter(r => r.success).map(r => r.funcCount);
        console.log(`     功能过程数: ${funcCounts.join(', ')} (一致性: ${new Set(funcCounts).size === 1 ? color('完全一致 ✓', GREEN) : color('有差异', YELLOW)})`);
    }
    if (result.failures > 0) {
        result.failureDetails.forEach(err => {
            console.log(`     ${color('错误: ' + err, RED)}`);
        });
    }
    console.log();
}

// ═══════════ 主测试流程 ═══════════

async function main() {
    console.log(color('\n═══════════════════════════════════════════════════════════════', BOLD));
    console.log(color('     COSMIC 拆分系统 - 并发压力测试（OpenRouter V4 Flash + 火山V3）', BOLD));
    console.log(color('═══════════════════════════════════════════════════════════════\n', BOLD));
    console.log(`  ⏰ 开始时间: ${timestamp()}`);
    console.log(`  📄 测试文档: medium (${DOCS.medium.length} 字符)`);
    console.log(`  🔑 OpenRouter API: ${IFLOW_CONFIG.apiKey ? '已配置 ✅' : '❌ 缺失'}`);
    console.log(`  🔑 火山 API: ${VOLCENGINE_CONFIG.apiKey ? '已配置 ✅' : '❌ 缺失'}`);
    console.log(`  🌐 Render: ${RENDER_URL}`);

    if (!IFLOW_CONFIG.apiKey || !VOLCENGINE_CONFIG.apiKey) {
        console.error('\n❌ API 密钥未配置，请检查 .env 文件');
        return;
    }

    const allResults = {};

    // ═══════════ 阶段 1：Render 后端健康检查 ═══════════
    printHeader('阶段 1: Render 后端健康检查（唤醒冷启动）');

    console.log('  ⏳ 正在唤醒 Render 服务 (Free Plan 可能需要 30-60 秒冷启动)...');
    const health1 = await testRenderEndpoint('/api/health', null, '首次健康检查');
    if (health1.success) {
        console.log(`  ✅ 服务在线！响应时间: ${color((health1.elapsed / 1000).toFixed(1) + 's', CYAN)}`);
        console.log(`  📊 模型: ${health1.data?.model}, 平台: ${health1.data?.platform}`);
    } else {
        console.log(`  ⚠️ 服务可能在冷启动中... (${health1.error || health1.status})`);
        console.log('  ⏳ 等待10秒后重试...');
        await new Promise(r => setTimeout(r, 10000));
        const health2 = await testRenderEndpoint('/api/health', null, '重试健康检查');
        if (health2.success) {
            console.log(`  ✅ 服务已唤醒！响应时间: ${color((health2.elapsed / 1000).toFixed(1) + 's', CYAN)}`);
        } else {
            console.log(`  ❌ Render 服务不可达: ${health2.error}`);
            console.log('  📌 继续进行 API 直连测试...');
        }
    }

    // ═══════════ 阶段 2：单请求基准测试 ═══════════
    printHeader('阶段 2: 单请求基准测试（1并发）');

    console.log('  ⏳ OpenRouter × 1...');
    const iflow1 = await concurrencyTest(IFLOW_CONFIG, 1);
    printConcurrencyResult('OpenRouter DeepSeek V4 Flash', iflow1);
    allResults['iflow_1'] = iflow1;

    console.log('  ⏳ 火山引擎 × 1...');
    const volc1 = await concurrencyTest(VOLCENGINE_CONFIG, 1);
    printConcurrencyResult('火山引擎 DeepSeek-V3', volc1);
    allResults['volc_1'] = volc1;

    // ═══════════ 阶段 3：2 并发 ═══════════
    printHeader('阶段 3: 2 并发测试');

    console.log('  ⏳ OpenRouter × 2...');
    const iflow2 = await concurrencyTest(IFLOW_CONFIG, 2);
    printConcurrencyResult('OpenRouter DeepSeek V4 Flash', iflow2);
    allResults['iflow_2'] = iflow2;

    console.log('  ⏳ 火山引擎 × 2...');
    const volc2 = await concurrencyTest(VOLCENGINE_CONFIG, 2);
    printConcurrencyResult('火山引擎 DeepSeek-V3', volc2);
    allResults['volc_2'] = volc2;

    // ═══════════ 阶段 4：3 并发 ═══════════
    printHeader('阶段 4: 3 并发测试');

    console.log('  ⏳ OpenRouter × 3...');
    const iflow3 = await concurrencyTest(IFLOW_CONFIG, 3);
    printConcurrencyResult('OpenRouter DeepSeek V4 Flash', iflow3);
    allResults['iflow_3'] = iflow3;

    console.log('  ⏳ 火山引擎 × 3...');
    const volc3 = await concurrencyTest(VOLCENGINE_CONFIG, 3);
    printConcurrencyResult('火山引擎 DeepSeek-V3', volc3);
    allResults['volc_3'] = volc3;

    // ═══════════ 阶段 5：5 并发 ═══════════
    printHeader('阶段 5: 5 并发测试（压力测试）');

    console.log('  ⏳ OpenRouter × 5...');
    const iflow5 = await concurrencyTest(IFLOW_CONFIG, 5);
    printConcurrencyResult('OpenRouter DeepSeek V4 Flash', iflow5);
    allResults['iflow_5'] = iflow5;

    console.log('  ⏳ 火山引擎 × 5...');
    const volc5 = await concurrencyTest(VOLCENGINE_CONFIG, 5);
    printConcurrencyResult('火山引擎 DeepSeek-V3', volc5);
    allResults['volc_5'] = volc5;

    // ═══════════ 阶段 6：混合并发 ═══════════
    printHeader('阶段 6: 混合并发（OpenRouter3 + 火山3 同时）');

    console.log('  ⏳ OpenRouter×3 + 火山×3 同时发起...');
    const mixStart = Date.now();
    const [mixIflow, mixVolc] = await Promise.all([
        concurrencyTest(IFLOW_CONFIG, 3),
        concurrencyTest(VOLCENGINE_CONFIG, 3)
    ]);
    const mixTotal = Date.now() - mixStart;
    console.log(`  📊 混合并发总耗时: ${color((mixTotal / 1000).toFixed(1) + 's', CYAN)}`);
    printConcurrencyResult('OpenRouter（混合中）', mixIflow);
    printConcurrencyResult('火山（混合中）', mixVolc);

    // ═══════════ 阶段 7：Render 后端并发 ═══════════
    printHeader('阶段 7: Render 后端并发（通过部署服务转发）');

    console.log('  ⏳ 3 个并发请求通过 Render 调用...');
    const renderTasks = [];
    for (let i = 0; i < 3; i++) {
        renderTasks.push(
            testRenderEndpoint('/api/understand-document', {
                documentContent: DOCS.short,
                userConfig: { model: 'deepseek-v4-flash-free' }
            }, `Render任务${i + 1}`)
        );
    }
    const renderResults = await Promise.all(renderTasks);
    const renderSuccesses = renderResults.filter(r => r.success);
    const renderFails = renderResults.filter(r => !r.success);
    console.log(`  成功: ${color(renderSuccesses.length, GREEN)} / 失败: ${color(renderFails.length, renderFails.length > 0 ? RED : GREEN)}`);
    renderResults.forEach(r => {
        const icon = r.success ? '✅' : '❌';
        const time = (r.elapsed / 1000).toFixed(1);
        const detail = r.success ? `${time}s` : `${time}s - ${r.error || r.status}`;
        console.log(`     ${icon} ${r.label}: ${detail}`);
    });

    // ═══════════ 最终汇总报告 ═══════════
    printHeader('📊 最终汇总报告');

    console.log();
    console.log('  ┌──────────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐');
    console.log('  │ 平台         │ 并发数  │ 成功率  │ 平均耗时│ 最快    │ 最慢    │ 总耗时  │');
    console.log('  ├──────────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤');

    const summary = [
        ['OpenRouter V4 Flash', 'iflow'],
        ['火山 V3', 'volc']
    ];

    for (const [name, key] of summary) {
        for (const c of [1, 2, 3, 5]) {
            const r = allResults[`${key}_${c}`];
            if (!r) continue;
            const rate = `${r.successes}/${r.concurrency}`;
            const avg = r.successes > 0 ? (r.avgElapsed / 1000).toFixed(1) + 's' : 'N/A';
            const min = r.successes > 0 ? (r.minElapsed / 1000).toFixed(1) + 's' : 'N/A';
            const max = r.successes > 0 ? (r.maxElapsed / 1000).toFixed(1) + 's' : 'N/A';
            const total = (r.totalTime / 1000).toFixed(1) + 's';
            console.log(`  │ ${name.padEnd(12)} │ ${String(c).padEnd(7)} │ ${rate.padEnd(7)} │ ${avg.padEnd(7)} │ ${min.padEnd(7)} │ ${max.padEnd(7)} │ ${total.padEnd(7)} │`);
        }
        console.log('  ├──────────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤');
    }
    console.log('  └──────────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘');

    // 计算退化比例
    console.log();
    console.log(color('  📈 性能退化分析:', BOLD));
    for (const [name, key] of summary) {
        const base = allResults[`${key}_1`];
        if (!base || base.successes === 0) continue;
        const baseAvg = base.avgElapsed;
        for (const c of [2, 3, 5]) {
            const r = allResults[`${key}_${c}`];
            if (!r || r.successes === 0) continue;
            const ratio = ((r.avgElapsed / baseAvg - 1) * 100).toFixed(0);
            const rateLimit = r.failures > 0 ? color(` (${r.failures}个被限流!)`, RED) : '';
            const icon = ratio < 30 ? '🟢' : ratio < 80 ? '🟡' : '🔴';
            console.log(`     ${icon} ${name} ${c}并发 vs 单请求: 平均耗时 +${ratio}%${rateLimit}`);
        }
    }

    // 结论
    console.log();
    console.log(color('  🎯 结论:', BOLD));

    const iflow5Result = allResults['iflow_5'];
    const volc5Result = allResults['volc_5'];

    // 判断各平台最大安全并发数
    for (const [name, key] of summary) {
        let maxSafe = 0;
        for (const c of [1, 2, 3, 5]) {
            const r = allResults[`${key}_${c}`];
            if (r && r.failures === 0) maxSafe = c;
        }
        const icon = maxSafe >= 5 ? '🟢' : maxSafe >= 3 ? '🟡' : '🔴';
        console.log(`     ${icon} ${name}: 最大安全并发数 = ${maxSafe}`);
    }

    // 速度对比
    const iflowBase = allResults['iflow_1'];
    const volcBase = allResults['volc_1'];
    if (iflowBase?.successes > 0 && volcBase?.successes > 0) {
        const faster = iflowBase.avgElapsed < volcBase.avgElapsed ? 'OpenRouter' : '火山引擎';
        const diff = Math.abs(iflowBase.avgElapsed - volcBase.avgElapsed);
        console.log(`     ⚡ 单请求速度: ${faster} 更快 ${(diff / 1000).toFixed(1)} 秒`);
    }

    console.log();
    console.log(color('═══════════════════════════════════════════════════════════════', DIM));
    console.log(`  ⏰ 完成时间: ${timestamp()}`);
    console.log(color('═══════════════════════════════════════════════════════════════', DIM));
}

main().catch(err => {
    console.error('测试脚本错误:', err);
    process.exit(1);
});
