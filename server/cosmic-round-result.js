function createRoundError(message, code) {
    const error = new Error(message);
    error.status = 502;
    error.code = code;
    return error;
}

function describeContinueAnalysisRound({
    reply = '',
    tableData = [],
    completedFunctionCount = 0,
    isDone = false,
    round = 1
} = {}) {
    const normalizedReply = String(reply || '');
    const normalizedRows = Array.isArray(tableData) ? tableData : [];
    const doneMarker = normalizedReply.includes('[ALL_DONE]');
    const hasTable = normalizedRows.some(row => (
        row?.dataMovementType === 'E' && row?.functionalProcess
    ));

    if (normalizedRows.length > 0 && !hasTable) {
        throw createRoundError(
            `第 ${round} 轮表格没有可识别的功能过程`,
            'INVALID_COSMIC_TABLE'
        );
    }
    if (!hasTable && !doneMarker) {
        throw createRoundError(
            `第 ${round} 轮未返回有效的COSMIC表格`,
            'INVALID_COSMIC_TABLE'
        );
    }
    if (!hasTable && doneMarker && completedFunctionCount === 0) {
        throw createRoundError(
            '模型在尚无任何拆分结果时提前返回完成标记',
            'EMPTY_ONE_KEY_RESULT'
        );
    }

    const resultKind = hasTable
        ? (doneMarker ? 'table_and_done_marker' : 'table')
        : 'done_marker';
    const action = isDone
        ? 'complete'
        : (hasTable ? 'merge-and-continue' : 'continue-without-new-rows');

    return {
        tableData: normalizedRows,
        hasTable,
        doneMarker,
        resultKind,
        action
    };
}

module.exports = {
    describeContinueAnalysisRound
};
