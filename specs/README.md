# 阶段规格与历史证据导航

**这里不是理解当前产品的第一入口。** 先读[项目逻辑说明](../docs/招财猫记账本入账逻辑说明.md)；当前任务、待验收与授权只看[实施规划](../docs/招财猫记账本实施规划.md)。

本目录保留 38 个既有阶段目录及其原始需求、设计、任务、交接、测试基线和证据。目录存在不代表已经实施，任务勾选不证明最新代码或手机已验收。旧方案可能已被后续阶段替代，不能从旧交接文件直接取得新的执行/发布授权。

2026-09-26 文档整理仅增加本导航，未移动、删减或批量修改下面目录。要读当时 docs 的旧章节和相对链接，进入[整理前完整快照](https://github.com/gaohongxiang/catledger/tree/b804bfc405d3cabff5ff277732d657d3020efb47/specs)，而不是要求现行手册恢复所有历史锚点。

## 1. 核心账本与初始边界

| 阶段 | 用途 |
| --- | --- |
| [mini-1904-ledger-core](mini-1904-ledger-core/) | 核心账户、分类、交易和统计的阶段契约 |
| [mini-1904a-core-closure](mini-1904a-core-closure/) | 核心实现收口 |
| [mini-1904b-ui-system](mini-1904b-ui-system/) | 初始界面体系与交互约束 |
| [mini-1904c-core-layering](mini-1904c-core-layering/) | 常规账本分层 |
| [mini-1906-financial-clarity](mini-1906-financial-clarity/) | 阶段财务口径与流程设计；不要由目录名推断全部未来能力已实现 |
| [mini-1906a-ledger-integrity](mini-1906a-ledger-integrity/) | 原完整性总纲，含后续演进设计，不整体作为当前执行计划 |
| [mini-1906a1-ledger-integrity-closure](mini-1906a1-ledger-integrity-closure/) | 完整性阶段收口与维护边界 |

## 2. 来源、语义与导入验收

| 阶段 | 用途 |
| --- | --- |
| [mini-1905-single-file-import](mini-1905-single-file-import/) | 单文件解析、证据和导入基础 |
| [mini-1905-refund-relation-policy](mini-1905-refund-relation-policy/) | 退款强弱证据与候选策略 |
| [mini-1906v-import-acceptance](mini-1906v-import-acceptance/) | 真实导入验收范围与阶段记录 |
| [mini-1906v1-import-semantic-repair](mini-1906v1-import-semantic-repair/) | 验收发现的语义修复 |
| [mini-1906v2-bill-semantic-rules](mini-1906v2-bill-semantic-rules/) | 来源 profile、标准语义与文件/行观测 |
| [mini-1906o-consolidated-optimization](mini-1906o-consolidated-optimization/) | 汇总优化的阶段范围、基线与验证 |
| [mini-1913-bank-import](mini-1913-bank-import/) | 银行账单解析与列映射 |
| [mini-1915-import-modularization](mini-1915-import-modularization/) | 一期模块化、有限减复杂度与固定性能/行为证据 |

## 3. 明细、选择与界面演进

| 阶段 | 用途 |
| --- | --- |
| [mini-1906tx-manage](mini-1906tx-manage/) | 交易管理与导入历史的早期阶段 |
| [mini-1906tx-selectall](mini-1906tx-selectall/) | 全选行为阶段设计 |
| [mini-1906tx-unified](mini-1906tx-unified/) | 手工与导入账目统一管理 |
| [mini-1911-select-all](mini-1911-select-all/) | 全筛选范围选择与大批量边界 |
| [mini-1906ui-all-pages](mini-1906ui-all-pages/) | 全页界面整理 |
| [mini-1906ui-entry](mini-1906ui-entry/) | 中央记账等入口设计 |
| [mini-1906ui-home-sample](mini-1906ui-home-sample/) | 首页方案与样例 |
| [mini-1906ui-import-refinement](mini-1906ui-import-refinement/) | 导入展示与交互细化 |
| [mini-1906ui-request-efficiency](mini-1906ui-request-efficiency/) | 请求效率与相关验证 |
| [mini-1909c-two-level-categories](mini-1909c-two-level-categories/) | 两级分类 |
| [mini-1909ui-b0](mini-1909ui-b0/) | 界面 B0 阶段原始材料 |
| [mini-1909ui-b1](mini-1909ui-b1/) | 界面 B1 阶段原始材料 |
| [mini-1909ui-b2](mini-1909ui-b2/) | 界面 B2 阶段原始材料 |
| [mini-1909ui-b3](mini-1909ui-b3/) | 界面 B3 阶段原始材料 |
| [mini-1909ui-b4](mini-1909ui-b4/) | 界面 B4 阶段原始材料 |
| [mini-1909ui-b5](mini-1909ui-b5/) | 界面 B5 阶段原始材料 |
| [mini-1909ui-b6](mini-1909ui-b6/) | 界面 B6 阶段原始材料 |

## 4. 贷款、负债设置与分期

| 阶段 | 用途 |
| --- | --- |
| [mini-1908d-schedule-generation](mini-1908d-schedule-generation/) | 分期参数与计划生成 |
| [mini-1908e-explicit-repayment](mini-1908e-explicit-repayment/) | 明确实际本息费及暂缓关联 |
| [mini-1908f-installment-entry](mini-1908f-installment-entry/) | 分期新增入口与资料 |
| [mini-1910-liability-settings](mini-1910-liability-settings/) | 负债账单日、还款日、额度 |
| [mini-1912-loan-detail](mini-1912-loan-detail/) | 贷款详情阶段改造；当前分期入口以后续 MINI-1914 为准 |
| [mini-1914-installment-flow](mini-1914-installment-flow/) | 当前分期方案、连续进度、费用来源与删除重建 |

## 5. 使用规则

修改当前行为时先看对应现行逻辑与源码，再查这些规格的原始约束和验收证据。任何待办重新启动都需要当前明确范围、负责人和授权，不能照着旧 unchecked 列表自动执行。

未来复杂任务可以在这里新增必要规格，小 bug 复用既有任务和提交记录；不要再为普通文案、样式或单点修复机械增加五份模板文档。文档规则见[维护约定](../docs/文档维护.md)，历史原文清单见[归档](../docs/归档/README.md)。
