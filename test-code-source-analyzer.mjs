import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const {
    analyzeCodeSource,
    extractSourceArtifact,
    normalizeAnalysisPayload
} = require('./server/code-source-analyzer');

const zip = new JSZip();
zip.file('package.json', JSON.stringify({
    name: 'demo-system',
    scripts: { start: 'node src/server.js' }
}));
zip.file('src/pages/orders.html', `
    <main>
        <h1>工单管理</h1>
        <form><input name="keyword"><button>查询工单</button></form>
    </main>
`);
zip.file('src/routes/orders.js', `
    router.get('/orders', listOrders);
    router.post('/orders', createOrder);
`);
zip.file('node_modules/example/index.js', 'should be ignored');
zip.file('dist/bundle.min.js', 'should also be ignored');

const artifact = await extractSourceArtifact(
    await zip.generateAsync({ type: 'nodebuffer' }),
    'demo.zip'
);

assert.equal(artifact.sourceType, 'zip');
assert.ok(artifact.text.includes('src/pages/orders.html'));
assert.ok(artifact.text.includes('router.post'));
assert.ok(!artifact.includedFiles.some(name => name.includes('node_modules')));
assert.ok(!artifact.includedFiles.some(name => name.includes('bundle.min.js')));

const normalized = normalizeAnalysisPayload({
    systemName: '工单系统',
    modules: [
        {
            level1: '1 工单中心',
            level2: '1.1 工单管理',
            level3: '1.1.1 工单查询',
            businessObjects: ['工单'],
            estimatedFunctions: 2
        },
        {
            level1: '1 工单中心',
            level2: '1.1 工单管理',
            level3: '1.1.1 工单查询',
            businessObjects: ['工单']
        }
    ],
    functions: [
        {
            functionName: '查询工单列表',
            triggerEvent: '用户提交查询条件',
            functionalUser: '发起者：用户 接收者：系统',
            level3: '1.1.1 工单查询'
        },
        {
            functionName: '查看工单记录',
            triggerEvent: '用户提交查询条件',
            functionalUser: '发起者：用户 接收者：系统',
            level3: '1.1.1 工单查询'
        }
    ]
});

assert.equal(normalized.modules.length, 1);
assert.equal(normalized.functions.length, 1);
assert.ok(normalized.requirementDocument.includes('工单系统功能需求说明书'));
assert.ok(normalized.functionList.includes('##功能过程：'));

const mockedAnalysis = await analyzeCodeSource({
    sourceArtifact: artifact,
    screenshotFiles: [],
    analysisMode: 'direct',
    userGuidelines: '只分析工单业务',
    userConfig: {},
    modelName: 'mock-model',
    callAIWithRetry: async () => ({
        choices: [{
            message: {
                content: JSON.stringify({
                    systemName: '工单系统',
                    summary: '处理工单查询和创建',
                    requirementDocument: '# 工单系统需求文档\n\n## 1. 工单管理',
                    modules: [{
                        level1: '1 工单中心',
                        level2: '1.1 工单管理',
                        level3: '1.1.1 工单处理',
                        businessObjects: ['工单'],
                        estimatedFunctions: 2
                    }],
                    functions: [{
                        functionName: '创建工单',
                        triggerEvent: '用户提交工单',
                        functionalUser: '发起者：用户 接收者：系统',
                        description: '系统接收工单信息并保存工单。',
                        level1: '1 工单中心',
                        level2: '1.1 工单管理',
                        level3: '1.1.1 工单处理'
                    }]
                })
            }
        }]
    })
});

assert.equal(mockedAnalysis.functions.length, 1);
assert.equal(mockedAnalysis.functions[0].functionName, '创建工单');
assert.ok(mockedAnalysis.functionList.includes('创建工单'));

console.log('code source analyzer tests passed');
