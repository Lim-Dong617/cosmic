const fs = require('node:fs/promises');
const { buildWordDocument } = require('./word-export');

process.on('disconnect', () => process.exit(0));
process.once('message', async workerData => {
    let result;
    try {
        const payload = JSON.parse(await fs.readFile(workerData.inputPath, 'utf8'));
        process.send({ type: 'progress', message: `正在生成 Word（${payload.tableData?.length || 0} 行数据）…` });
        await buildWordDocument(payload, { outputPath: workerData.outputPath });
        const { size } = await fs.stat(workerData.outputPath);
        const filename = String(payload.filename || 'COSMIC功能规格说明书')
            .replace(/[\r\n/\\\x00-\x1f]/g, '_').slice(0, 180)
            + (payload.exportTemplate === 'xinjiang' ? '_新疆需求说明书' : '') + '.docx';
        result = { type: 'completed', filename, size,
            peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) };
    } catch (error) {
        result = { type: 'failed', error: {
            message: error instanceof SyntaxError ? 'Word 导出数据格式不正确，请重新导出' : error.message,
            status: error instanceof SyntaxError ? 400 : (error.status || 500),
            code: error.code || 'WORD_EXPORT_FAILED'
        } };
    } finally {
        process.send(result, () => process.disconnect());
    }
});
