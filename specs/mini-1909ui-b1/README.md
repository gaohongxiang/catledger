# MINI-1909UI-B1 灾难页编辑式改造

## 目标

在 B0 地基上完成七个视觉落后页面的 Editorial × Luxury 改造：loans、loan-detail、loan-payment、loan-plan、loan-link、import-history、data-privacy。

## 范围

- 拆除 `@import` 链式耦合：loan-plan → loan-payment → loan-detail、loan-link → loan-detail 三条 import 删除，各页样式独立并加本页类名前缀（`ld-` / `lp-` / `plan-` / `ll-`）。
- 页头统一 `section-header`（小眉题 + 宋体大标题 + 右侧操作 slot）。
- 说明长文收敛为浅色说明卡；表单统一 label caption + 88rpx 触控输入框（surface 底、发丝边框、radius-medium）；picker 行右端 `chevron-icon`。
- 贷款/还款/计划列表卡片化（surface + 发丝线 + radius-large），本金与期次金额走字阶并加 `.money-number`；期次行复用 `list-row` 组件。
- loans 与 loan-link 分页器改沉浸条（chevron 图标翻页，无边框）。
- import-history 状态加文字修饰类（不仅靠颜色），错误信息走 `ui-state error`。
- data-privacy 修复不存在的 `var(--page-gutter)` 引用（应为 `--layout-content-inset`）；「清除本机导出文件」改为 `.danger-button`。

## 边界

- 不改任何 JS、事件绑定、数据字段；`wx:if/wx:for` 条件多重集、`bind*` 事件集合、`data-*` 属性集合与改造前逐页 diff 一致（机器核对）。
- 分页为游标式，沉浸条不含页码（页码需改 JS，不在本批）。

## 验证

- `npm run check` 通过；`npm run test` 三套全绿（667 pass / 0 fail）；无测试断言受影响，未增删测试。
- 微信开发者工具编译预览通过；观感走查由用户确认。
