const SEQUENCE_OPTIONS = ['用户->系统', '数据库->系统', '系统->数据库', '系统->用户'];

const TEMPLATE_HEADERS = [
    '修订标识',
    'OPEX-需求名称\nCAPEX-子系统',
    '一级模块',
    '二级模块',
    '三级模块',
    '功能用户',
    '功能用户需求',
    '触发事件',
    '功能过程',
    '子过程描述',
    '数据移动类型',
    '数据组',
    '数据属性',
    'CFP',
    'CFP评估师核定',
    '备注',
    '时序图',
    '功能描述'
];

const GUIDE_ROW = [
    '用于需求变更、重评等场景',
    'OPEX：与需求管理平台中上报的需求名称对应\nCAPEX：一个项目分为多个开发商开发，或者多个独立部署的系统，那么每个独立的软件系统就是本项目的一个子系统，不存在这类情况就留空',
    '本次需求需要改造的本项目（或子系统）中已有的一级业务功能名称，或者本次需求新增的本项目（或子系统）的一级业务功能名称',
    '本次需求需要改造的本项目（或子系统）中已有的二级业务功能名称，或者本次需求新增的本项目（或子系统）的二级业务功能名称',
    '本次需求需要改造的本项目（或子系统）中已有的三级业务功能名称，或者本次需求新增的本项目（或子系统）的三级业务功能名称',
    '一个（类）用户是软件块的功能性用户需求中数据的发送者或者预期的接收者。',
    '用户需求的子集。这些需求以任务和服务的形式描述软件做什么。',
    '待度量软件的功能性用户需求中可识别的一个事件，此事件使得一个或多个软件功能用户产生一个或多个数据组，每个数据组随后被一个触发输入所移动。',
    '1、体现了待度量软件的功能性用户需求基本部件的一组数据移动，该功能处理在该FUR中是独一无二的，并能独立于该FUR的其他功能处理被定义。\n2、一个功能处理可能只有一个触发输入。\n3、一个功能处理的所有数据移动的集合是满足其FUR的触发输入所有可能的响应所需的集合。',
    '1、每个功能处理由一系列子过程组成。\n2、一个子处理可以是一个数据移动或者数据运算。',
    'COSMIC规定的四种数据移动类型。包括：输入（E）输出（X）读（R）写（W）',
    '一个唯一的、非空的、无序的数据属性的集合。',
    '一个数据属性是一个已识别的数据组中最小的信息单元。',
    '表示数据移动的规模。',
    '人工作业下，此列表示人工评估师评定结果。',
    '复用和利旧现象必填；空白表示新增。',
    '谓：下一级子操作\n宾：事务\n(必填)',
    '主：发起者\n谓：子操作\n宾：对应事务\n（必填）'
];

const REQUIRED_ROW = [
    '首次提交材料时，A列应为空白',
    '来源于需求文档。\n（选填）',
    '来源于需求文档。应与功能架构图对应，每个项目应保持其功能模块划分的持续性\n（必填）',
    '来源于需求文档。应与功能架构图对应，每个项目应保持其功能模块划分的持续性\n（必填）',
    '来源于需求文档。应与功能架构图对应，每个项目应保持其功能模块划分的持续性\n（必填）',
    '只包含数据发起者和数据接受者。若数据发起者有多个，要求拆分为1对1填写。\n（必填）',
    '主：发起者\n谓：操作\n宾：事务\n（必填）',
    '操作+对象\n对象+被操作\n（必填）',
    '主：发起者\n谓：子操作\n宾：对应事务\n（必填）',
    '谓：下一级子操作\n宾：事务\n(必填)',
    '四选一（必填）',
    '人工填写\n(必填)',
    '人工填写\n(必填，可填写部分属性)',
    '每一个数据移动表示1个CFP',
    '人工填写，其中：新增=1，复用=1/3，利旧=0。',
    '复用和利旧现象必填，空白表示新增。',
    '谓：下一级子操作\n宾：事务\n(必填)',
    '主：发起者\n谓：子操作\n宾：对应事务\n（必填）'
];

function sequenceForMovement(type) {
    return {
        E: '用户->系统',
        R: '数据库->系统',
        W: '系统->数据库',
        X: '系统->用户'
    }[String(type || '').trim()] || '';
}

function actorFromFunctionalUser(functionalUser) {
    const text = String(functionalUser || '').trim();
    const match = text.match(/发起者[:：]\s*([^\n\r ]+)/);
    return match ? match[1] : (text.split(/\s+/)[0] || '用户');
}

function fillDataValidations(worksheet, startRow, endRow) {
    for (let row = startRow; row <= endRow; row++) {
        worksheet.getCell(row, 11).dataValidation = {
            type: 'list',
            allowBlank: false,
            formulae: ['"E,R,W,X"']
        };
        worksheet.getCell(row, 17).dataValidation = {
            type: 'list',
            allowBlank: false,
            formulae: [`"${SEQUENCE_OPTIONS.join(',')}"`]
        };
    }
}

function safeMerge(worksheet, startRow, col, endRow) {
    if (endRow > startRow) worksheet.mergeCells(startRow, col, endRow, col);
}

function styleRangeBorder(worksheet, startRow, endRow, startCol, endCol) {
    for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
            const cell = worksheet.getCell(row, col);
            cell.border = {
                top: { style: 'thin', color: { argb: 'FF808080' } },
                left: { style: 'thin', color: { argb: 'FF808080' } },
                bottom: { style: 'thin', color: { argb: 'FF808080' } },
                right: { style: 'thin', color: { argb: 'FF808080' } }
            };
            cell.alignment = { vertical: 'middle', wrapText: true };
            cell.font = { name: '宋体', size: row <= 3 ? 9 : 10 };
        }
    }
}

function addNotesSheet(workbook) {
    const notes = workbook.addWorksheet('填写注意事项');
    const rows = [
        ['填写注意事项', ''],
        ['1、文件命名格式：如项目较小，项目名称：COSMIC软件评估功能点拆分表.xlsx；如项目较大，项目名称-一级/二级/三级功能模块序号XXX：COSMIC软件评估功能点拆分表.xlsx（其中XXX代表模块编号，请与需求说明书保持一致）', ''],
        ['2、附件5里必含“功能时序图”、“功能拆分表”两张Sheet，Sheet表的名字不允许更改', ''],
        ['3、提交材料时，A列应为空白。当评审过程中需求发生变更时，请根据增删改的内容在A列进行对应标注', ''],
        ['4、请务必将“子过程描述”填写在J列。不允许增加列', ''],
        ['5、功能点拆分表填写完成后，请仅保留评估内容，删除作为示范的案例、定义、填写说明', ''],
        ['6、功能点拆分应基于功能时序图', ''],
        ['7、数据跨层交互是重要的判定依据', ''],
        ['8、静态判断不作为功能点', ''],
        ['9、使用了开源软件或配置已有功能作为实现途径，配置过程不能作为功能点', ''],
        ['10、建议至少一个三级功能模块提供一个时序图', ''],
        ['11、子系统是指如果存在一个项目分为多个开发商开发，或者多个独立部署的系统，那么每个独立的软件系统就是本项目的一个子系统，不存在这类情况就留空', '']
    ];
    rows.forEach(row => notes.addRow(row));
    notes.columns = [{ width: 120 }, { width: 5 }];
    notes.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    notes.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    styleRangeBorder(notes, 1, rows.length, 1, 2);
}

function addSequenceOptionSheet(workbook) {
    const sheet = workbook.addWorksheet('功能时序图');
    sheet.addRow(['时序图选项', '含义', '典型数据移动类型', '使用位置']);
    sheet.addRow(['用户->系统', '用户或外部功能用户向本系统提交请求/数据', 'E', '功能点拆分表 Q列']);
    sheet.addRow(['数据库->系统', '本系统读取已有持久化数据', 'R', '功能点拆分表 Q列']);
    sheet.addRow(['系统->数据库', '本系统写入或更新持久化数据', 'W', '功能点拆分表 Q列']);
    sheet.addRow(['系统->用户', '本系统向用户或外部功能用户返回结果/通知', 'X', '功能点拆分表 Q列']);
    sheet.columns = [{ width: 18 }, { width: 42 }, { width: 18 }, { width: 18 }];
    sheet.getRow(1).eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    styleRangeBorder(sheet, 1, 5, 1, 4);
}

function buildTemplateRows(tableData, documentName) {
    let currentFunctionalUser = '';
    let currentTrigger = '';
    let currentProcess = '';
    let currentL1 = '';
    let currentL2 = '';
    let currentL3 = '';
    let firstDataRow = true;

    return tableData.map(row => {
        if (row.level1) currentL1 = row.level1;
        if (row.level2) currentL2 = row.level2;
        if (row.level3) currentL3 = row.level3;
        if (row.functionalUser) currentFunctionalUser = row.functionalUser;
        if (row.triggerEvent) currentTrigger = row.triggerEvent;
        if (row.functionalProcess) currentProcess = row.functionalProcess;

        const isFunctionStart = row.dataMovementType === 'E' && !!row.functionalProcess;
        const process = row.functionalProcess || currentProcess || '';
        const functionalUser = row.functionalUser || currentFunctionalUser || '';
        const requirementActor = actorFromFunctionalUser(functionalUser);
        const requirement = `${requirementActor}${process}`;

        const output = [
            '',
            firstDataRow ? documentName : '',
            isFunctionStart ? (row.level1 || currentL1 || '') : '',
            isFunctionStart ? (row.level2 || currentL2 || '') : '',
            isFunctionStart ? (row.level3 || currentL3 || '') : '',
            isFunctionStart ? functionalUser : '',
            isFunctionStart ? requirement : '',
            isFunctionStart ? (row.triggerEvent || currentTrigger || '') : '',
            isFunctionStart ? process : '',
            row.subProcessDesc || '',
            row.dataMovementType || '',
            row.dataGroup || '',
            row.dataAttributes || '',
            1,
            '',
            '',
            sequenceForMovement(row.dataMovementType),
            isFunctionStart ? (row.functionDescription || row.functionalDescription || '') : ''
        ];
        firstDataRow = false;
        return { values: output, isFunctionStart };
    });
}

function mergeTemplateRegions(worksheet, dataRows, firstRow, lastRow) {
    safeMerge(worksheet, firstRow, 2, lastRow);
    safeMerge(worksheet, firstRow, 3, lastRow);

    for (const col of [4, 5]) {
        let start = firstRow;
        let current = worksheet.getCell(firstRow, col).value || '';
        for (let row = firstRow + 1; row <= lastRow + 1; row++) {
            const value = row <= lastRow ? worksheet.getCell(row, col).value : '__END__';
            if (value && value !== current) {
                safeMerge(worksheet, start, col, row - 1);
                start = row;
                current = value;
            }
            if (row === lastRow + 1) safeMerge(worksheet, start, col, lastRow);
        }
    }

    let groupStart = firstRow;
    for (let index = 1; index < dataRows.length; index++) {
        if (dataRows[index].isFunctionStart) {
            const end = firstRow + index - 1;
            for (const col of [6, 7, 8, 9, 18]) safeMerge(worksheet, groupStart, col, end);
            groupStart = firstRow + index;
        }
    }
    for (const col of [6, 7, 8, 9, 18]) safeMerge(worksheet, groupStart, col, lastRow);
}

function buildCosmicAssessmentWorkbook(ExcelJS, tableData, filename) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'COSMIC拆分系统';
    workbook.created = new Date();

    addNotesSheet(workbook);
    addSequenceOptionSheet(workbook);

    const worksheet = workbook.addWorksheet('功能点拆分表');
    worksheet.columns = [
        { width: 10 }, { width: 22 }, { width: 16 }, { width: 18 }, { width: 24 }, { width: 22 },
        { width: 30 }, { width: 18 }, { width: 32 }, { width: 36 }, { width: 10 }, { width: 26 },
        { width: 44 }, { width: 8 }, { width: 16 }, { width: 14 }, { width: 18 }, { width: 60 }
    ];

    worksheet.addRow(TEMPLATE_HEADERS);
    worksheet.addRow(GUIDE_ROW);
    worksheet.addRow(REQUIRED_ROW);
    const dataRows = buildTemplateRows(tableData, filename);
    dataRows.forEach(row => worksheet.addRow(row.values));

    const firstRow = 4;
    const lastRow = worksheet.rowCount;

    worksheet.getRow(1).height = 42;
    worksheet.getRow(2).height = 120;
    worksheet.getRow(3).height = 110;
    worksheet.getRow(1).eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAF7' } };
        cell.font = { bold: true, name: '宋体', size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    for (let row = 2; row <= 3; row++) {
        worksheet.getRow(row).eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
            cell.font = { name: '宋体', size: 9 };
            cell.alignment = { vertical: 'top', wrapText: true };
        });
    }
    for (let row = firstRow; row <= lastRow; row++) {
        worksheet.getRow(row).height = 58;
        for (const col of [1, 11, 14, 15, 16, 17]) {
            worksheet.getCell(row, col).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        }
    }

    styleRangeBorder(worksheet, 1, lastRow, 1, 18);
    fillDataValidations(worksheet, firstRow, lastRow);
    mergeTemplateRegions(worksheet, dataRows, firstRow, lastRow);
    worksheet.views = [{ state: 'frozen', ySplit: 3 }];

    return workbook;
}

module.exports = {
    buildCosmicAssessmentWorkbook
};
