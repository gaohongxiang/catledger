# 历史原文与迁移对照

这里是**完整原文入口**，不是用一份摘要取代旧材料。整理前固定提交为：

`b804bfc405d3cabff5ff277732d657d3020efb47`

[打开当时的整个仓库](https://github.com/gaohongxiang/catledger/tree/b804bfc405d3cabff5ff277732d657d3020efb47) · [打开旧 docs 全目录](https://github.com/gaohongxiang/catledger/tree/b804bfc405d3cabff5ff277732d657d3020efb47/docs) · [打开旧 specs 全目录](https://github.com/gaohongxiang/catledger/tree/b804bfc405d3cabff5ff277732d657d3020efb47/specs)

## 1. 怎样保证不丢信息

本次审阅分支以这个提交为祖先，用户的 `backup-docs` 仍保留该提交；没有覆盖备份或重写 Git 历史。所有原文字节都能从该提交读取，包括已被后续逻辑替代、尚未实施、仍待验收和曾经相互矛盾的段落。

归档使用**固定提交链接**，不是会随 main 改变的链接，也不是只保留一个总结。当前工作树不再重复放置整套旧正文，以免搜索结果中同时出现两份“当前逻辑”。需要旧页内锚点、旧相对链接、当时源码和验证上下文时，直接在固定提交中阅读。

38 个既有阶段规格目录及其文件仍原位保留；本轮只增加 [specs 总导航](../../specs/README.md)，不批量改其状态、任务勾选或历史授权。未解决的问题不会因为归档而自动变成已解决。

## 2. 旧文档去哪里找，现行内容去哪里读

| 整理前原文（固定提交，全文） | 现行归属与处理 |
| --- | --- |
| [仓库 README](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/README.md) | [仓库入口](../../README.md)：定位、目录和阅读链接；开发命令转入专门手册 |
| [AGENTS](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/AGENTS.md) | [项目规则](../../AGENTS.md)：保留安全、事务、分支和发布边界，修正文档职责指针 |
| [文档 README](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/README.md) | [文档导航](../README.md)：按问题选入口，不复制任务状态 |
| [入账逻辑说明](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/招财猫记账本入账逻辑说明.md) | [项目逻辑说明](../招财猫记账本入账逻辑说明.md)：架构到业务步骤的完整主线；阶段日志归档 |
| [用户需求](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/招财猫记账本用户需求.md) | [当前需求与范围](../招财猫记账本用户需求.md)：用户目标、当前范围、候选方向分开 |
| [业务规则与验收](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/招财猫记账本业务规则与验收.md) | [规则与验收矩阵](../招财猫记账本业务规则与验收.md)：不变式、关键反例和测试入口 |
| [架构设计](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/招财猫记账本架构设计.md) | [架构与代码导航](../招财猫记账本架构设计.md)：现行模块、数据、事务、会话和契约入口 |
| [实施规划全文](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/招财猫记账本实施规划.md) | [当前任务与验收状态](../招财猫记账本实施规划.md)：只保留当前看板、剩余项和历史交付指针；原第 19 章等在固定原文 |
| [小程序基础](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/现行说明/小程序基础.md) | [客户端会话与读取](../现行说明/小程序基础.md)及[开发与验证](../开发与验证.md) |
| [已入账账单维护](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/现行说明/已入账账单维护.md) | [维护专题](../现行说明/已入账账单维护.md)：当前 UI 与保留后台接口分开 |
| [数据生命周期](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/现行说明/数据生命周期.md) | [数据专题](../现行说明/数据生命周期.md)：原件、结构化来源、导出、快照与恢复边界 |
| [界面视觉与导入状态](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/现行说明/界面视觉与导入状态.md) | [界面专题](../现行说明/界面视觉与导入状态.md)：现行导航和状态表达；不保留逐次发布日志 |
| [账单语义与工程验证](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/现行说明/账单语义与工程验证.md) | [语义专题](../现行说明/账单语义与工程验证.md)及开发手册；特定真实文件盘点留历史 |
| [贷款管理](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/现行说明/贷款管理.md) | [贷款专题](../现行说明/贷款管理.md)：当前分期、实际借还和旧普通贷款兼容边界 |
| [账户与资金分配架构审查](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/现行说明/账户与资金分配架构审查.md) | 旧路径仅保留历史指针；现行账户与分配进入主逻辑/架构 |
| [不可穷举与发布策略问题书](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/账单导入不可穷举与发布策略问题书.md) | 历史评审，旧路径指向完整原文，不改写当时问题 |
| [不可穷举与发布策略答复](https://github.com/gaohongxiang/catledger/blob/b804bfc405d3cabff5ff277732d657d3020efb47/docs/账单导入不可穷举与发布策略评审答复.md) | 历史答复，未实施建议不冒充现行功能 |

## 3. 原始内容核验清单

以下来自固定提交的 Git tree 元数据。bytes 为原 UTF-8 文件大小，SHA 为原始 blob，不是新正文的摘要。旧 `docs/` 共 15 个 Markdown 文件、1,014,833 bytes。可在完整仓库中用 `git show <固定提交>:<路径>` 阅读或比对，不需要切换、重置或覆盖当前工作区。

| 原路径 | bytes | 原始 blob SHA |
| --- | ---: | --- |
| README.md | 3670 | `fc9e5c572a6ca9491119463c4b48e738c84c75e6` |
| AGENTS.md | 5180 | `54c02b83debd24ca8f9b5c635052d7c61c79c2df` |
| docs/README.md | 3306 | `3c93336cdd728b09fa65512f8a749dcebee7f6d0` |
| docs/招财猫记账本业务规则与验收.md | 77554 | `c18a25188e69b509e8e0e30f6b3ebeffaaa52f41` |
| docs/招财猫记账本入账逻辑说明.md | 352908 | `25b034ce8be5475beb2e99123e2731872a594688` |
| docs/招财猫记账本实施规划.md | 321105 | `d03f6a57cba4be5ec998061ec24cbe1050ec552f` |
| docs/招财猫记账本架构设计.md | 20686 | `bc92051494c2ae952d2902cce23a3a1fd8648eb2` |
| docs/招财猫记账本用户需求.md | 54503 | `542e280650d3743d127d6c995b87a852636653ba` |
| docs/现行说明/小程序基础.md | 51507 | `aa9dcaa60c182e3170b9b71e987fe975c07f94d9` |
| docs/现行说明/已入账账单维护.md | 9257 | `477b3c5992db7c00ccbf249ec38b741960bfe3a7` |
| docs/现行说明/数据生命周期.md | 5325 | `02c12cd63a98811846aded2be0f24eaf6df17751` |
| docs/现行说明/界面视觉与导入状态.md | 12798 | `a15e6d828b202fb6c00828fdca8494cca9af016c` |
| docs/现行说明/账单语义与工程验证.md | 26185 | `d3452c02459468dae10da00297b655341a8b7e09` |
| docs/现行说明/账户与资金分配架构审查.md | 9558 | `03d2139177fdb93a5fb6b387e3ae6b04f9d8321f` |
| docs/现行说明/贷款管理.md | 21311 | `e8517ac32eadb7e2b762e6ddca0edf7a5cc83868` |
| docs/账单导入不可穷举与发布策略评审答复.md | 30203 | `65f49845c869c33b5f0b380b7ecc3033cad731d6` |
| docs/账单导入不可穷举与发布策略问题书.md | 18627 | `859b3ce96336ab59d5f8556b0cc0fa68c20bb316` |

原 docs tree：`ea13b7197b025ac4ef897ef69723efc91efee60f`；原 specs tree：`19815ac3e360115968643953d3bb50e463e0849c`。

## 4. 这次纠正了哪些阅读歧义

| 原来容易误读的地方 | 新文档处理 |
| --- | --- |
| 底部导航的历史“账本”方案与实际“统计”入口混杂 | 按 app.json 与 custom-tab-bar 写现行导航，旧方案留原文 |
| 旧维护页说明与后来普通明细编辑/混选删除并列 | 明确当前 UI、保留接口与历史页面三者区别 |
| 贷款各阶段都写“当前入口”，分期又在顶部覆盖下文 | 以现行“一笔分期、一张逐期表”为主，单列普通旧贷款兼容能力 |
| 完整识别、所选范围可入账、用户排除混成成功率 | 在主逻辑和规则中分别解释，未知不被排除美化 |
| 语义版本、迁移编号、导出 schemaVersion 多份重复 | 说明各自含义并链接源码、迁移与清单，历史值留在固定记录 |
| 代码通过、上传成功和手机验收混在叙事中 | 唯一当前状态表保留未验收边界，不替用户勾选 |
| 未来预测/AI/复式分录与现状写在同一架构图 | 从现状图移出，保留为未启动候选，不丢历史设计 |

本轮文档整理不裁决每一个历史提案是否应实施，也不自动修复基线代码缺陷。未迁入现行正文的细节仍可按原文和阶段规格追溯；若验收发现需要常用查阅的遗漏，在对应现行章节补入，不再恢复整段修复日志。
