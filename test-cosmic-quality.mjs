import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  allocateQuantityPlanToChapters,
  canonicalFunctionKey,
  deduplicateFunctionObjects,
  inheritMissingFunctionLevels,
  isReferenceOnlyChapterTitle,
  orderCosmicTableData as orderClientRows,
} from "./client/src/cosmic-quality.js";

const require = createRequire(import.meta.url);
const {
  canonicalFunctionNameKey,
  keepLastDuplicateHeadingPositions,
  orderCosmicTableData: orderServerRows,
} = require("./server/cosmic-quality.js");

assert.equal(
  canonicalFunctionKey("查询漫入用户统计列表"),
  canonicalFunctionKey("查看漫入用户统计记录"),
);
assert.equal(
  canonicalFunctionNameKey("展示智能单板管理下拉菜单"),
  canonicalFunctionNameKey("展开智能单板管理下拉菜单"),
);
assert.notEqual(
  canonicalFunctionKey("执行无线参数优化计划"),
  canonicalFunctionKey("批量执行无线参数优化计划"),
);

const deduped = deduplicateFunctionObjects([
  { functionName: "查询漫入用户统计列表", sourceChapter: "7. 漫入用户统计" },
  { functionName: "查看漫入用户统计记录", sourceChapter: "7 漫入用户统计" },
  { functionName: "查看漫入用户统计记录", sourceChapter: "2. 首页综合监控大屏" },
]);
assert.deepEqual(
  deduped.map((item) => item.functionName),
  ["查询漫入用户统计列表", "查看漫入用户统计记录"],
);

const quantityPreserved = deduplicateFunctionObjects([
  { functionName: "查询漫入用户统计列表", sourceChapter: "7. 漫入用户统计" },
  { functionName: "查看漫入用户统计记录", sourceChapter: "7 漫入用户统计" },
], { semantic: false });
assert.equal(quantityPreserved.length, 2);

const splitModuleTargets = allocateQuantityPlanToChapters([
  { title: "模块A 子章1", level3: "模块A", charCount: 100 },
  { title: "模块A 子章2", level3: "模块A", charCount: 100 },
  { title: "模块B", level3: "模块B", charCount: 100 },
], [
  { level3: "模块A", target: 6 },
  { level3: "模块B", target: 4 },
], 10);
assert.deepEqual(splitModuleTargets, [3, 3, 4]);
assert.equal(splitModuleTargets.reduce((sum, value) => sum + value, 0), 10);

const parentChapterTargets = allocateQuantityPlanToChapters([
  { title: "告警管理", level2: "告警管理", charCount: 100 },
], [
  { level2: "告警管理", level3: "无线告警", target: 6 },
  { level2: "告警管理", level3: "有线告警", target: 4 },
], 10);
assert.deepEqual(parentChapterTargets, [10]);

const leveled = inheritMissingFunctionLevels([
  {
    functionName: "编辑优化计划",
    sourceChapter: "8. 无线参数优化计划",
    level1: "8 无线参数优化计划",
    level2: "8.2 优化计划表单",
    level3: "8.2.1 优化计划新增/编辑面板",
  },
  {
    functionName: "查询总用户数",
    sourceChapter: "2. 首页综合监控大屏",
    level1: "2 首页综合监控大屏",
  },
  {
    functionName: "查询业务量",
  },
]);
assert.deepEqual(
  leveled.map(({ level1, level2, level3 }) => ({ level1, level2, level3 })),
  [
    {
      level1: "8 无线参数优化计划",
      level2: "8.2 优化计划表单",
      level3: "8.2.1 优化计划新增/编辑面板",
    },
    { level1: "2 首页综合监控大屏", level2: "", level3: "" },
    { level1: "2 首页综合监控大屏", level2: "", level3: "" },
  ],
);

assert.equal(isReferenceOnlyChapterTitle("10. 功能拆分建议"), true);
assert.equal(isReferenceOnlyChapterTitle("11. 验收核对清单"), true);
assert.equal(isReferenceOnlyChapterTitle("8. 无线参数优化计划"), false);

const lines = [
  "目录",
  "1. 系统公共功能",
  "2. 首页综合监控大屏",
  "注：目录按一级功能模块编排",
  "1. 系统公共功能",
  "正文一",
  "2. 首页综合监控大屏",
  "正文二",
];
assert.deepEqual(
  keepLastDuplicateHeadingPositions(lines, [1, 2, 4, 6]),
  [4, 6],
);

const outOfOrderRows = [
  { dataMovementType: "E", functionalProcess: "后确认功能", level1: "1 模块" },
  { dataMovementType: "R", functionalProcess: "", level1: "1 模块" },
  { dataMovementType: "E", functionalProcess: "先确认功能", level1: "8 模块" },
  { dataMovementType: "X", functionalProcess: "", level1: "8 模块" },
];
assert.deepEqual(
  orderClientRows(outOfOrderRows, [
    { functionName: "先确认功能" },
    { functionName: "后确认功能" },
  ]).filter((row) => row.dataMovementType === "E").map((row) => row.functionalProcess),
  ["先确认功能", "后确认功能"],
);
assert.deepEqual(
  orderServerRows(outOfOrderRows)
    .filter((row) => row.dataMovementType === "E")
    .map((row) => row.functionalProcess),
  ["后确认功能", "先确认功能"],
);

console.log("cosmic quality tests passed");
