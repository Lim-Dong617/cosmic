/**
 * 多文档深度对比测试：OpenRouter DeepSeek V4 Flash (free) vs 火山引擎
 * 
 * 测试目的：
 * 1. 用4个不同领域/复杂度的文档测试
 * 2. 每文档2轮，观察稳定性
 * 3. temperature=0 最大化可复现性
 * 4. 汇总跨文档的差异模式
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { callAI } = require('./server/ai-client');

// ═══════════ 平台配置 ═══════════

const PLATFORMS = {
    iflow: {
        name: 'SenseNova DeepSeek V4 Flash',
        short: 'SenseNova',
        apiKey: process.env.SENSENOVA_API_KEY || process.env.OPENROUTER_API_KEY || process.env.IFLOW_API_KEY,
        baseURL: process.env.SENSENOVA_BASE_URL || 'https://token.sensenova.cn/v1',
        model: process.env.SENSENOVA_MODEL || 'deepseek-v4-flash'
    },
    volcengine: {
        name: '火山引擎 (volcengine)',
        short: '火山',
        apiKey: process.env.VOLCENGINE_API_KEY,
        baseURL: process.env.VOLCENGINE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding',
        model: process.env.VOLCENGINE_MODEL || 'deepseek-v4-pro-260425'
    }
};

// ═══════════ 4个不同领域的测试文档 ═══════════

const TEST_DOCS = {
    // 文档A：电商订单系统（混合触发，含支付接口）
    '电商订单': `3.1 商品浏览
用户可以在首页浏览推荐商品列表。用户可以按分类、价格区间、销量等条件搜索商品。用户可以查看商品详情页，包含商品图片、价格、库存、评价等信息。

3.2 购物车管理
用户可以将商品加入购物车，选择数量和规格。用户可以修改购物车中商品的数量。用户可以从购物车中删除商品。用户可以查看购物车商品列表和总金额。

3.3 订单管理
用户可以从购物车中选择商品提交订单，填写收货地址和备注。用户提交订单后系统扣减库存。用户可以查看自己的订单列表，支持按状态筛选。用户可以取消未支付的订单，系统恢复库存。
商家可以对已支付订单进行发货操作，填写物流单号。用户确认收货后订单完成。

3.4 支付与退款
用户选择支付方式后，系统调用第三方支付接口完成支付。支付平台回调通知系统支付结果，系统更新订单状态。
用户可以申请退款，填写退款原因。商家审核退款申请，通过后系统调用支付接口完成退款。

3.5 评价管理
用户可以对已完成的订单进行评价，填写评分和评价内容。用户可以查看商品的评价列表。商家可以回复用户的评价。`,

    // 文档B：医院挂号系统（有排班、接口对接）
    '医院挂号': `2.1 医生排班管理
管理员可以设置医生的出诊排班，包括科室、医生、日期、时段、可预约人数等信息。管理员可以临时停诊某个排班。系统每天凌晨自动生成未来7天的排班数据。

2.2 患者预约挂号
患者可以按科室、医生、日期查询可用号源。患者选择号源后提交预约挂号，需填写患者姓名、身份证号、手机号。系统生成挂号单，包含就诊序号。
患者可以取消未就诊的预约，系统释放号源。患者可以查看自己的预约记录。

2.3 签到与叫号
患者到达医院后在自助机上扫码签到。系统将已签到患者加入候诊队列。医生点击叫号按钮，系统按序号呼叫下一位患者，在大屏和语音播报。

2.4 费用结算
医生开具处方后，系统自动计算费用。患者在收费窗口支付费用。系统与医保接口对接，支持医保实时结算。每天晚上系统自动汇总当日收费数据生成日报。

2.5 报表统计
管理员可以查看各科室的挂号量统计。管理员可以查看医生工作量排名。系统每月1日自动生成上月的运营分析报告。`,

    // 文档C：物流调度系统（偏复杂，多接口多定时）
    '物流调度': `4.1 运单管理
客户可以在线下单，填写寄件人信息、收件人信息、货物描述、重量。系统根据重量和距离自动计算运费。系统生成运单号，状态为"待取件"。
客户可以查询运单状态。客户可以修改收件人信息（仅限未揽收状态）。

4.2 调度分配
系统根据快递员位置和运单地址自动匹配最近的快递员。调度员可以手动将运单分配给指定快递员。快递员接受运单后状态变为"已揽收"。
快递员可以批量扫描揽收多个运单。

4.3 运输跟踪
快递员每到一个中转站进行扫描签到，系统记录运单轨迹。系统每2小时自动更新运单预计到达时间。
运单到达目的站点后状态变为"待派送"。快递员完成派送后拍照签收，状态变为"已签收"。

4.4 异常处理
快递员可以标记运单异常（破损、丢失、拒收等），填写异常描述和拍照。系统自动通知客户运单异常情况。客服可以处理客户投诉，关联运单号。

4.5 对账结算
系统每天凌晨汇总前一天的运费收入。系统每月与合作商家进行对账。系统接收银行回调确认到账信息。财务可以导出结算报表。`,

    // 文档D：简单权限系统（小而精，验证简单文档的差异）
    '权限系统': `1.1 角色管理
管理员可以创建角色，填写角色名称和描述。管理员可以为角色分配权限菜单。管理员可以修改角色信息。管理员可以删除未使用的角色。

1.2 用户授权
管理员可以为用户分配角色。管理员可以查看用户的权限列表。系统在用户登录时验证权限并生成权限令牌。

1.3 操作审计
系统记录所有用户的关键操作日志，包括操作时间、操作人、操作内容。管理员可以查询操作日志，支持按时间范围、操作人筛选。系统每月自动清理超过6个月的日志数据。`
};

// ═══════════ 阶段1 提示词：功能过程提取 ═══════════

const PHASE1_SYSTEM = `你是一个顶级Cosmic拆分专家。请从以下需求文档中提取所有功能过程列表。

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

// ═══════════ 阶段2 提示词：COSMIC ERWX 拆分 ═══════════

const PHASE2_SYSTEM = `你是一个顶级Cosmic拆分专家。请对以下功能过程进行COSMIC子过程拆分。

# COSMIC四种数据移动类型
- E(Entry/输入): 从功能用户到功能过程的数据移动
- R(Read/读取): 从持久存储到功能过程的数据移动
- W(Write/写入): 从功能过程到持久存储的数据移动
- X(Exit/输出): 从功能过程到功能用户的数据移动

# 规则
1. 每个功能过程至少包含2个数据移动（1个E+1个X，或1个E+1个W）
2. 读取数据库获取信息 → R
3. 保存数据到数据库 → W
4. 接收用户输入 → E
5. 返回结果给用户 → X
6. 每个数据移动必须指明"数据组"和"数据属性（3个以上）"

# 输出格式
##功能过程：XXX
| 子过程描述 | 类型 | 数据组 | 数据属性 |
|---|---|---|---|
| 接收XXX请求 | E | XXX请求 | 属性1、属性2、属性3 |
| 读取XXX数据 | R | XXX表 | 属性1、属性2、属性3 |
| 保存XXX记录 | W | XXX表 | 属性1、属性2、属性3 |
| 返回XXX结果 | X | XXX响应 | 属性1、属性2、属性3 |`;

// ═══════════ 核心调用函数 ═══════════

async function callPlatform(platformKey, systemPrompt, userMessage, temperature = 0) {
    const config = PLATFORMS[platformKey];

    const startTime = Date.now();
    try {
        const completion = await callAI({
            model: config.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            temperature: temperature,
            max_tokens: 8000,
            stream: false,
            apiKey: config.apiKey,
            baseUrl: config.baseURL
        });

        const elapsed = Date.now() - startTime;
        const content = completion.choices?.[0]?.message?.content || '';
        const usage = completion.usage || {};

        return {
            platform: platformKey,
            success: true,
            elapsed,
            content,
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0,
            finishReason: completion.choices?.[0]?.finish_reason || 'unknown'
        };
    } catch (error) {
        return {
            platform: platformKey,
            success: false,
            elapsed: Date.now() - startTime,
            error: `[${error.status || error.code || '?'}] ${(error.message || '').substring(0, 300)}`,
            content: ''
        };
    }
}

// ═══════════ 解析工具 ═══════════

function extractFunctions(content) {
    const funcs = [];
    const lines = content.split('\n');
    let current = {};

    for (const line of lines) {
        const triggerMatch = line.match(/##\s*触发事件[：:]\s*(.+)/);
        const userMatch = line.match(/##\s*功能用户[：:]\s*(.+)/);
        const funcMatch = line.match(/##\s*功能过程[：:]\s*(.+)/);
        const descMatch = line.match(/##\s*功能过程描述[：:]\s*(.+)/);

        if (triggerMatch) current.trigger = triggerMatch[1].trim();
        if (userMatch) current.funcUser = userMatch[1].trim();
        if (funcMatch) current.funcName = funcMatch[1].trim();
        if (descMatch) {
            current.desc = descMatch[1].trim();
            if (current.funcName) {
                funcs.push({ ...current });
            }
            current = {};
        }
    }
    // 处理没有描述的最后一个
    if (current.funcName && !funcs.find(f => f.funcName === current.funcName)) {
        funcs.push({ ...current });
    }
    return funcs;
}

function extractERWX(content) {
    const processes = [];
    const sections = content.split(/##\s*功能过程[：:]/);

    for (let i = 1; i < sections.length; i++) {
        const section = sections[i];
        const nameMatch = section.match(/^(.+?)[\n|]/);
        const name = nameMatch ? nameMatch[1].trim() : `过程${i}`;

        const rows = [];
        const rowPattern = /\|\s*(.+?)\s*\|\s*([ERWX])\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/g;
        let match;
        while ((match = rowPattern.exec(section)) !== null) {
            rows.push({
                desc: match[1].trim(),
                type: match[2].trim(),
                dataGroup: match[3].trim(),
                dataAttrs: match[4].trim()
            });
        }

        const e = rows.filter(r => r.type === 'E').length;
        const r = rows.filter(r => r.type === 'R').length;
        const w = rows.filter(r => r.type === 'W').length;
        const x = rows.filter(r => r.type === 'X').length;

        processes.push({ name, rows, e, r, w, x, total: rows.length });
    }
    return processes;
}

function compareFuncLists(list1, list2, name1, name2) {
    const set1 = new Set(list1.map(f => f.funcName));
    const set2 = new Set(list2.map(f => f.funcName));

    const common = list1.filter(f => set2.has(f.funcName)).map(f => f.funcName);
    const only1 = list1.filter(f => !set2.has(f.funcName)).map(f => f.funcName);
    const only2 = list2.filter(f => !set1.has(f.funcName)).map(f => f.funcName);

    // 模糊匹配：名称相似但不完全相同的
    const fuzzyMatches = [];
    for (const f1 of only1) {
        for (const f2 of only2) {
            if (f1.includes(f2) || f2.includes(f1) ||
                similarity(f1, f2) > 0.6) {
                fuzzyMatches.push({ [name1]: f1, [name2]: f2 });
            }
        }
    }

    return { common, only1, only2, fuzzyMatches };
}

function similarity(s1, s2) {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;

    let matches = 0;
    for (const char of shorter) {
        if (longer.includes(char)) matches++;
    }
    return matches / longer.length;
}

// ═══════════ 打印工具 ═══════════

function hr(char = '═', len = 70) {
    return char.repeat(len);
}

function log(msg = '') {
    console.log(msg);
    outputLines.push(msg);
}

let outputLines = [];

// ═══════════ 主测试流程（多文档批量测试） ═══════════

async function main() {
    const ROUNDS = 2; // 每个文档每个平台测试轮数
    const docNames = Object.keys(TEST_DOCS);

    log(hr());
    log('   COSMIC 拆分 - OpenRouter vs 火山引擎 多文档对比测试');
    log(hr());
    log();
    log(`📄 测试文档: ${docNames.length} 个 (${docNames.join('、')})`);
    log(`🔄 每文档: ${ROUNDS} 轮 × 2平台 = ${ROUNDS * 2} 次调用`);
    log(`📊 总计: ${docNames.length * ROUNDS * 2} 次 AI 调用`);
    log(`🌡️ Temperature: 0 (最大化可复现性)`);
    log(`📋 OpenRouter模型: ${PLATFORMS.iflow.model}`);
    log(`📋 火山模型: ${PLATFORMS.volcengine.model}`);
    log(`🕐 开始时间: ${new Date().toLocaleString()}`);
    log();

    // 检查 API Keys
    for (const [key, config] of Object.entries(PLATFORMS)) {
        if (!config.apiKey) {
            log(`❌ 缺少 ${key} API Key`);
            return;
        }
        log(`✅ ${config.name} API Key: 已配置`);
    }
    log();

    // 保存所有文档的测试结果用于最终汇总
    const allDocResults = {};

    // ═══════════ 逐文档测试 ═══════════
    for (let docIdx = 0; docIdx < docNames.length; docIdx++) {
        const docName = docNames[docIdx];
        const docContent = TEST_DOCS[docName];

        log(hr('━'));
        log(`  📄 文档 ${docIdx + 1}/${docNames.length}：${docName} (${docContent.length}字符)`);
        log(hr('━'));
        log();

        const docResults = { iflow: [], volcengine: [] };
        const userMsg = `请分析以下需求文档，提取所有功能过程：\n\n${docContent}`;

        for (let round = 1; round <= ROUNDS; round++) {
            log(`  🔄 第 ${round}/${ROUNDS} 轮...`);

            for (const platformKey of ['iflow', 'volcengine']) {
                const config = PLATFORMS[platformKey];
                log(`     ⏳ ${config.short}...`);

                const result = await callPlatform(platformKey, PHASE1_SYSTEM, userMsg, 0);
                docResults[platformKey].push(result);

                if (result.success) {
                    const funcs = extractFunctions(result.content);
                    log(`     ✅ ${config.short}: ${(result.elapsed / 1000).toFixed(1)}s, ${funcs.length}个功能过程, ${result.totalTokens}tk`);
                } else {
                    log(`     ❌ ${config.short}: ${result.error}`);
                }

                // 间隔2秒避免限流
                await new Promise(r => setTimeout(r, 2000));
            }
            log();
        }

        // 分析本文档的结果
        log(`  ── ${docName} 分析 ──`);
        log();

        // 各平台轮次一致性
        for (const platformKey of ['iflow', 'volcengine']) {
            const config = PLATFORMS[platformKey];
            const allFuncs = docResults[platformKey]
                .filter(r => r.success)
                .map(r => extractFunctions(r.content));

            if (allFuncs.length >= 2) {
                const counts = allFuncs.map(f => f.length);
                const names = allFuncs.map(fl => fl.map(f => f.funcName).sort().join('|'));
                const isConsistent = new Set(names).size === 1;
                const countConsistent = new Set(counts).size === 1;

                log(`  ${config.short} 轮次一致性: 数量${countConsistent ? '✅' : '⚠️'}(${counts.join(',')}) 名称${isConsistent ? '✅' : '⚠️'}`);

                if (!isConsistent) {
                    for (let a = 0; a < allFuncs.length; a++) {
                        for (let b = a + 1; b < allFuncs.length; b++) {
                            const diff = compareFuncLists(allFuncs[a], allFuncs[b], `轮${a + 1}`, `轮${b + 1}`);
                            if (diff.only1.length > 0) diff.only1.forEach(n => log(`     仅轮${a + 1}: ${n}`));
                            if (diff.only2.length > 0) diff.only2.forEach(n => log(`     仅轮${b + 1}: ${n}`));
                        }
                    }
                }
            }
        }

        // 跨平台对比（取第1轮）
        const iflowFuncs = docResults.iflow[0]?.success ? extractFunctions(docResults.iflow[0].content) : [];
        const volcFuncs = docResults.volcengine[0]?.success ? extractFunctions(docResults.volcengine[0].content) : [];

        if (iflowFuncs.length > 0 && volcFuncs.length > 0) {
            const diff = compareFuncLists(iflowFuncs, volcFuncs, 'OpenRouter', '火山');
            log();
            log(`  跨平台对比(第1轮): 共同${diff.common.length}个, 仅OpenRouter${diff.only1.length}个, 仅火山${diff.only2.length}个`);

            if (diff.only1.length > 0) {
                log(`     仅OpenRouter: ${diff.only1.join('、')}`);
            }
            if (diff.only2.length > 0) {
                log(`     仅火山: ${diff.only2.join('、')}`);
            }
            if (diff.fuzzyMatches.length > 0) {
                diff.fuzzyMatches.forEach(m => log(`     ≈ OpenRouter「${m['OpenRouter']}」≈ 火山「${m['火山']}」`));
            }

            // 触发类型
            const iTriggers = {}, vTriggers = {};
            iflowFuncs.forEach(f => { const t = f.trigger || '?'; iTriggers[t] = (iTriggers[t] || 0) + 1; });
            volcFuncs.forEach(f => { const t = f.trigger || '?'; vTriggers[t] = (vTriggers[t] || 0) + 1; });
            log(`     触发分布 — OpenRouter:${JSON.stringify(iTriggers)} 火山:${JSON.stringify(vTriggers)}`);

            // 列出所有功能过程
            log();
            log(`  OpenRouter提取(${iflowFuncs.length}个):`);
            iflowFuncs.forEach((f, i) => log(`     ${i + 1}. ${f.funcName} [${f.trigger || '?'}]`));
            log(`  火山提取(${volcFuncs.length}个):`);
            volcFuncs.forEach((f, i) => log(`     ${i + 1}. ${f.funcName} [${f.trigger || '?'}]`));
        }

        // 响应时间
        const iTimes = docResults.iflow.filter(r => r.success).map(r => r.elapsed);
        const vTimes = docResults.volcengine.filter(r => r.success).map(r => r.elapsed);
        if (iTimes.length > 0 && vTimes.length > 0) {
            const iAvg = Math.round(iTimes.reduce((s, t) => s + t, 0) / iTimes.length);
            const vAvg = Math.round(vTimes.reduce((s, t) => s + t, 0) / vTimes.length);
            log();
            log(`  ⏱️ 响应: OpenRouter ${(iAvg / 1000).toFixed(1)}s | 火山 ${(vAvg / 1000).toFixed(1)}s | 火山快 ${(iAvg / vAvg).toFixed(1)}倍`);
        }

        log();

        // 保存本文档结果
        allDocResults[docName] = {
            docLen: docContent.length,
            iflowFuncs,
            volcFuncs,
            diff: iflowFuncs.length > 0 && volcFuncs.length > 0
                ? compareFuncLists(iflowFuncs, volcFuncs, 'OpenRouter', '火山')
                : null,
            iflowAvgTime: iTimes.length > 0 ? Math.round(iTimes.reduce((s, t) => s + t, 0) / iTimes.length) : 0,
            volcAvgTime: vTimes.length > 0 ? Math.round(vTimes.reduce((s, t) => s + t, 0) / vTimes.length) : 0,
            iflowConsistent: docResults.iflow.filter(r => r.success).map(r => extractFunctions(r.content).length),
            volcConsistent: docResults.volcengine.filter(r => r.success).map(r => extractFunctions(r.content).length),
            rawResults: docResults
        };

        // 保存原始响应
        const rawDir = path.join(__dirname, 'data', 'compare-raw');
        if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
        for (const platformKey of ['iflow', 'volcengine']) {
            for (let i = 0; i < docResults[platformKey].length; i++) {
                const r = docResults[platformKey][i];
                if (r.success) {
                    const safeDocName = docName.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
                    fs.writeFileSync(
                        path.join(rawDir, `${safeDocName}_${platformKey}_r${i + 1}.txt`),
                        r.content, 'utf-8'
                    );
                }
            }
        }
    }

    // ╔═══════════════════════════════════════════╗
    // ║  跨文档汇总报告                               ║
    // ╚═══════════════════════════════════════════╝

    log(hr('━'));
    log('  📊 跨文档汇总报告');
    log(hr('━'));
    log();

    // 汇总表格
    log('  ┌──────────┬──────┬──────┬──────┬──────┬──────────┬──────────┐');
    log('  │ 文档      │ 字符 │OR数  │火山数│共同数│仅OR      │仅火山    │');
    log('  ├──────────┼──────┼──────┼──────┼──────┼──────────┼──────────┤');

    let totalCommon = 0, totalOnlyI = 0, totalOnlyV = 0;

    for (const docName of docNames) {
        const dr = allDocResults[docName];
        const iCount = dr.iflowFuncs.length;
        const vCount = dr.volcFuncs.length;
        const common = dr.diff ? dr.diff.common.length : 0;
        const onlyI = dr.diff ? dr.diff.only1.length : 0;
        const onlyV = dr.diff ? dr.diff.only2.length : 0;
        totalCommon += common;
        totalOnlyI += onlyI;
        totalOnlyV += onlyV;

        log(`  │ ${docName.padEnd(8)} │ ${String(dr.docLen).padEnd(4)} │ ${String(iCount).padEnd(4)} │ ${String(vCount).padEnd(4)} │ ${String(common).padEnd(4)} │ ${String(onlyI).padEnd(8)} │ ${String(onlyV).padEnd(8)} │`);
    }

    log('  ├──────────┼──────┼──────┼──────┼──────┼──────────┼──────────┤');
    log(`  │ 合计      │      │      │      │ ${String(totalCommon).padEnd(4)} │ ${String(totalOnlyI).padEnd(8)} │ ${String(totalOnlyV).padEnd(8)} │`);
    log('  └──────────┴──────┴──────┴──────┴──────┴──────────┴──────────┘');
    log();

    // 响应时间汇总
    log('  ⏱️ 响应时间汇总:');
    log('  ┌──────────┬──────────┬──────────┬──────────┐');
    log('  │ 文档      │ OR(s)    │ 火山(s)  │ 倍数     │');
    log('  ├──────────┼──────────┼──────────┼──────────┤');

    for (const docName of docNames) {
        const dr = allDocResults[docName];
        const iSec = (dr.iflowAvgTime / 1000).toFixed(1);
        const vSec = (dr.volcAvgTime / 1000).toFixed(1);
        const ratio = dr.volcAvgTime > 0 ? (dr.iflowAvgTime / dr.volcAvgTime).toFixed(1) : 'N/A';
        log(`  │ ${docName.padEnd(8)} │ ${iSec.padEnd(8)} │ ${vSec.padEnd(8)} │ ${(ratio + 'x').padEnd(8)} │`);
    }

    log('  └──────────┴──────────┴──────────┴──────────┘');
    log();

    // 一致性汇总
    log('  🔄 平台内轮次一致性汇总:');
    for (const docName of docNames) {
        const dr = allDocResults[docName];
        const iCons = new Set(dr.iflowConsistent).size === 1 ? '✅' : '⚠️';
        const vCons = new Set(dr.volcConsistent).size === 1 ? '✅' : '⚠️';
        log(`     ${docName}: OpenRouter${iCons}(${dr.iflowConsistent.join(',')}) 火山${vCons}(${dr.volcConsistent.join(',')})`);
    }
    log();

    // 差异模式分析
    log('  🔬 差异模式分析:');
    log('  ─────────────────────────────────');

    const matchRate = totalCommon > 0
        ? ((totalCommon / (totalCommon + totalOnlyI + totalOnlyV)) * 100).toFixed(1)
        : '0';

    log(`     跨平台第1轮完全匹配率: ${matchRate}% (${totalCommon}/${totalCommon + totalOnlyI + totalOnlyV})`);
    log(`     仅OpenRouter额外提取: ${totalOnlyI}个`);
    log(`     仅火山额外提取: ${totalOnlyV}个`);
    log();

    // 收集所有差异项
    const allDiffItems = [];
    for (const docName of docNames) {
        const dr = allDocResults[docName];
        if (dr.diff) {
            dr.diff.only1.forEach(n => allDiffItems.push({ doc: docName, platform: 'OpenRouter', name: n }));
            dr.diff.only2.forEach(n => allDiffItems.push({ doc: docName, platform: '火山', name: n }));
        }
    }

    if (allDiffItems.length > 0) {
        log('  所有差异项汇总:');
        allDiffItems.forEach(d => {
            log(`     [${d.doc}] 仅${d.platform}: ${d.name}`);
        });
    } else {
        log('  🎉 所有文档第1轮两平台提取结果完全一致！');
    }
    log();

    // 结论
    log('  💡 结论:');
    log(`     1. 跨平台匹配率: ${matchRate}%`);

    const allIflowTimes = docNames.map(n => allDocResults[n].iflowAvgTime).filter(t => t > 0);
    const allVolcTimes = docNames.map(n => allDocResults[n].volcAvgTime).filter(t => t > 0);
    if (allIflowTimes.length > 0 && allVolcTimes.length > 0) {
        const avgIflow = Math.round(allIflowTimes.reduce((s, t) => s + t, 0) / allIflowTimes.length);
        const avgVolc = Math.round(allVolcTimes.reduce((s, t) => s + t, 0) / allVolcTimes.length);
        log(`     2. 平均速度: OpenRouter ${(avgIflow / 1000).toFixed(1)}s vs 火山 ${(avgVolc / 1000).toFixed(1)}s, 火山快 ${(avgIflow / avgVolc).toFixed(1)}倍`);
    }

    const allConsistent = docNames.every(n => {
        const dr = allDocResults[n];
        return new Set(dr.iflowConsistent).size === 1 && new Set(dr.volcConsistent).size === 1;
    });
    log(`     3. 平台内一致性: ${allConsistent ? '全部一致 ✅' : '部分文档有轮次差异 ⚠️'}`);
    log();

    log(hr());
    log(`  🕐 完成时间: ${new Date().toLocaleString()}`);
    log(hr());

    // 保存报告
    const outputFile = path.join(__dirname, 'test-deep-compare-output.txt');
    fs.writeFileSync(outputFile, outputLines.join('\n'), 'utf-8');
    log(`\n  📁 测试报告已保存到: ${outputFile}`);
    log(`  📁 原始 AI 响应已保存到: data/compare-raw/`);
}

main().catch(err => {
    console.error('测试脚本错误:', err);
    process.exit(1);
});
