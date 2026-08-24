import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeContinueAnalysisRound } = require('./server/cosmic-round-result');

const eRow = {
    functionalProcess: '查询工单',
    dataMovementType: 'E',
    subProcessDesc: '接收查询请求'
};

function describe(overrides = {}) {
    return describeContinueAnalysisRound({
        reply: '[ALL_DONE]',
        tableData: [],
        completedFunctionCount: 6,
        isDone: true,
        round: 2,
        ...overrides
    });
}

const exactMarker = describe();
assert.equal(exactMarker.doneMarker, true);
assert.equal(exactMarker.hasTable, false);
assert.equal(exactMarker.resultKind, 'done_marker');
assert.equal(exactMarker.action, 'complete');

const markerWithEmptyTable = describe({
    reply: '[ALL_DONE]\n|功能用户|功能过程|数据移动类型|\n|:---|:---|:---|'
});
assert.deepEqual(markerWithEmptyTable, exactMarker, 'pipe characters must not change a marker-only result');

const coverageRejectedMarker = describe({ isDone: false });
assert.equal(coverageRejectedMarker.action, 'continue-without-new-rows');
assert.equal(coverageRejectedMarker.hasTable, false);

const finalRows = describe({ tableData: [eRow] });
assert.equal(finalRows.resultKind, 'table_and_done_marker');
assert.equal(finalRows.action, 'complete');
assert.deepEqual(finalRows.tableData, [eRow]);

const tableOnly = describe({ reply: '|功能用户|功能过程|数据移动类型|\n|用户|查询工单|E|', isDone: false, tableData: [eRow] });
assert.equal(tableOnly.resultKind, 'table');
assert.equal(tableOnly.action, 'merge-and-continue');

assert.throws(
    () => describe({ reply: '', tableData: [] }),
    error => error?.code === 'INVALID_COSMIC_TABLE' && error?.status === 502
);
assert.throws(
    () => describe({ completedFunctionCount: 0 }),
    error => error?.code === 'EMPTY_ONE_KEY_RESULT' && error?.status === 502
);
assert.throws(
    () => describe({ tableData: [{ dataMovementType: 'R', functionalProcess: '' }] }),
    error => error?.code === 'INVALID_COSMIC_TABLE' && error?.status === 502
);

console.log('cosmic round result tests passed');
