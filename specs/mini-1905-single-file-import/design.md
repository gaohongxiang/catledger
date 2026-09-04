# MINI-1905/1906 多账单统一导入设计

## 1. 设计冻结结论

1. MINI-1905 与 MINI-1906 使用同一条实现主线，不再验收一个独立的单文件最终产品。
2. `origin/catledger-web` 的 Go 领域代码和测试定义业务等价基线；当前 CloudBase 解析、存储、身份与事务基础继续复用，但逐行 `post/skip/linked` 只作为临时兼容层。
3. 最终主链路固定为：`ImportFile / ImportBatch / RawRow → FinanceUpdate → EconomicEvent / Evidence / Relation → ReviewIssue → Postability → FinanceAction / posting → Transaction`。
4. 原规划器中只依赖金额、时间、文本、对方、尾号或数量平衡的“高置信自动合并”不迁移为自动决定，而迁移为 `same_event` 候选。这是本次需求明确要求的安全收紧；共享且核验通过的稳定关联号或已冻结官方强关系仍可自动归组。
5. 小程序整理页在服务端模型、迁移、API 和测试完成后重做；当前“将入账 / 不新建”页面不再继续打磨。
6. `financeUpdates.post` 是导入流程唯一的正式账本写屏障：其前只能写文件、批次、FinanceUpdate、事件、关系、Issue、Action 和 FinanceUpdate 范围草稿；正式 Account、账户映射、永久忽略规则、Transaction 及其余额/统计依据不得提前变化。

## 2. 原逻辑到 CloudBase 的迁移矩阵

| 原分支基线 | 原业务语义 | 当前 CloudBase 现状 | 冻结后的迁移目标 |
| --- | --- | --- | --- |
| `importing.ImportFile`、`lifecycle.go` | 用户范围内容摘要、对象生命周期、可恢复删除 | `catledger_import_files`、私有云路径、解析恢复和清理已具备 | 保留表与存储网关；多选时每份文件仍独立，成功入账后按更新统一触发清理 |
| `ImportBatch`、`ImportBatchIssue`、`reparse.go` | 一次不可变解析运行、规则版本、账期、文件级问题 | `catledger_import_batches` 已保留核心摘要；文件级问题只在错误码/行 JSON 中 | 扩展批次规则版本与计数；新增 `catledger_import_batch_issues`，重解析产生新批次而非覆盖 |
| `SourceAccount`、`payment_account.go` | 账单主体与正式账户分离，支付工具映射可复用 | `catledger_import_source_profiles` 与 `catledger_import_account_mappings` 已分离；规范化规则已迁移 | 保留并补齐来源账户状态、发现方式和正式账户候选；继续保留“本次忽略/永久忽略”差异 |
| `source_funds.go`、`card_header.go` | 从账单头和支付工具投影转账/还款资金两端，不能把账单来源当资金账户 | 当前解析保留 payment method，但复杂资金移动直接 skip，批次没有结构化账单头 | 在批次补账单头安全摘要；`source-funds-projector` 只生成账户候选和规则版本，最终两端由 planner/postability 裁决 |
| `SourceIdentity`、`dedup_service.go` | 同来源身份唯一裁决、核心摘要冲突、同物理行不误并 | `catledger_source_identities`、唯一键、核心摘要与并发测试已具备 | 保留；补齐规则版本和冲突计数，稳定身份只做同来源去重，不代替跨来源归组 |
| `RawImportRow`、支付宝/微信 evidence parser | 原始行不可变、统一规范化投影、问题与版本 | `catledger_import_rows` 和四种解析器已具备主要字段 | 保留解析器和行表；补齐 eligibility、disposition、映射账户快照及 identity/core/fingerprint 版本 |
| `FinanceUpdate` | 一次多文件财务更新，是默认整理和入账单位 | 缺失；当前 `import_id` 同时承担文件和提交单位 | 新增 `catledger_finance_updates`；状态迁移 `draft/organizing/review/posting/posted/failed/undone/abandoned` 与版本/守恒计数 |
| `FinanceUpdateSource` | 冻结更新所含批次、顺序和规则快照 | 缺失；查询只取单文件最新批次 | 新增 `catledger_finance_update_sources`，唯一约束覆盖 `(uid, update_id, source_order)`、`(uid, update_id, batch_id)` 和活动批次占用 |
| `planner.go` | 跨来源身份组、强关系、转账/还款配对、退款关系、分类建议、守恒 | `persistDocumentRows` 固定“一条有效行一个事件”；无跨文件计划 | 迁移为纯 Node.js `organizer-planner`；输入全部冻结来源，输出事件、证据、关系和候选组，不直接写正式账本 |
| `EconomicEvent` | 中性语义投影、字段来源、原因码和服务端状态 | `catledger_economic_events` 只有 `batch_id/event_type/state/digest` | 以 `0006` 原地扩展为完整事件模型；`batch_id` 仅保留旧数据锚点，权威归属改为 `update_id` |
| `EconomicEventEvidence` | 多来源证据归一事件，角色可变但证据不删 | `catledger_event_evidence` 可关联行，但缺 update、独立 ID、字段掩码和一行一事件约束 | 原地扩展；增加 `evidence_id/update_id/field_mask`，唯一约束保证同一更新的一行只归属一个事件 |
| `EconomicEventRelation` | `refund_of/transfer_between/repayment_of/debt_disbursement_of` 的 proposed/confirmed/rejected/undone | 完全缺失；复杂语义被默认 skip | 新增 `catledger_economic_event_relations`，保存版本、人工标记、金额、原因码和双端用户外键 |
| `SameEventCandidateGroups`、`mergeHighConfidenceSameEvents` | 强证据可并；歧义组转用户决定 | 当前没有跨来源候选 | 稳定共享标识可自动并；金额/时间/文本等弱规则只构建 `same_event` ReviewIssue 成员与分数，不自动并 |
| `review_issue_builder.go` | 一个 `needs_action` 事件恰好投影到一个实际问题；相同决定可安全分组 | 缺失；客户端自行把行分成“待确认/将入账/不新建” | 迁移为 `review-issue-builder`，服务端持久化 Issue 和 Member；列表只返回安全摘要，详情再下钻证据 |
| `ReviewIssue` / `ReviewIssueMember` | 稳定、分页、带成员版本的问题审计 | 缺失 | 新增 `catledger_review_issues`、`catledger_review_issue_members`，完整保留 8 种类型、open/resolved/superseded 和 subject/candidate/supporting |
| `review_issue_resolution.go` | 8 种决定、CAS、幂等、证据移动、关系确认、后续问题 | 缺失；`imports.commit` 接受任意完整行决定数组 | 迁移为 `review-issue-service`；客户端提交事实和显式决定，服务端重新派生事件状态与新问题 |
| `FinanceAction` | 整理、人工决定、入账、纠错、撤销的幂等审计 | 只有通用 mutation receipt 和单文件 posting | 新增 `catledger_finance_actions`；receipt 继续作为入口重放层，Action 保存领域版本和结果状态 |
| `importing/posting.go` | 早期单批次逐行 posting、精确身份复用和行—交易链接 | 当前 `ledger-writer.js` 基本迁移了这一层 | 仅保留身份复用、行级审计和幂等测试素材；最终业务入口由 organizer `posting.go` 的 FinanceUpdate 原子语义替代 |
| `postability.go` | 唯一 ready 裁决；账户、方向、关系和阻塞原因统一检查 | `canPost` 只允许普通收支/手续费，客户端决定 post | 迁移为纯 `postability` 模块；整理、问题解决、最终 posting 三处都调用，客户端永远不能设 ready |
| `posting.go` | 锁定完整更新，拒绝 needs_action，事务内复核 ready，整批写交易和链接 | `commitImport` 只锁单文件并逐行 post/skip | 迁移为 `finance-update-posting`；一笔 MySQL 事务覆盖全部来源事件、关系、正式交易、事件链接和状态 |
| `EconomicEventTransaction` | 事件与新建/历史正式交易的稳定角色链接 | `catledger_import_transaction_links` 同时混合行、事件和交易 | 新增 `catledger_economic_event_transactions` 作为事件权威链接；旧表保留行级审计和兼容回填 |
| `correction.go`、`rebuild.go`、`undo.go`、`abandon.go` | corrected、重建、撤销和放弃都保留审计，已修改账本拒绝静默覆盖 | 当前只有单文件 discard，尚无完整更新纠错/撤销 | 在同一连续方案中先完成 posting，再迁移影响预览、整批 rebuild/undo 与 abandon；不用删交易冒充撤销，也不省略 corrected 终态 |
| `PaymentAccountSetupDialog.vue` | 账户候选、已有账户、本次忽略、永久忽略、创建账户 | 旧单文件页面会在入账前调用 `accounts.createBatch`，违反整批写屏障 | 保留账户分组和决定语义；新账户与映射先写 FinanceUpdate 草稿，posting 事务内才创建正式 Account 并提升映射，不再调用预创建接口 |
| `organizer/mobile/ResultsPage.vue` | 结果计数、ReviewIssue 卡片、同一笔/多笔独立、证据下钻 | 当前原生小程序只有简化行列表 | 后端冻结后按同一问题语义做原生移动端适配，不机械复制 Vue/F7 页面 |

## 3. 当前 MINI-1905 代码分层结论

### 3.1 直接保留

- `parsers/` 的内容探测、CSV 混合换行、受限 XLSX、金额与时区规范化及合成夹具。
- `storage-gateway.js` 的用户隔离随机路径、精确对象校验、临时对象下载与删除。
- `identity.js` 的来源档案、稳定身份、核心摘要、物理记录身份和支付工具摘要；版本值需与新 planner 统一注册。
- `database.js`、`database-errors.js`、`import-transaction.js` 的连接池、可信用户映射、事务、有限重试和幂等 receipt。
- `catledger_import_files/batches/source_profiles/source_identities/import_rows` 的证据基础，以及账户/分类映射表。
- 小程序的登录门禁、云函数调用策略、上传恢复和主题令牌；`accounts.createBatch` 仅保留普通账本 API 兼容，不再属于导入主链路。

### 3.2 保留后扩展

- `import-service.js`：保留 prepare/parse/cleanup，用批量准备和按文件查询扩展；不再承担最终账本提交。
- `import-repository.js`：保留文件、批次、身份和行持久化；移除创建最终经济事件与系统 `post/skip` 决定的职责。
- `import-query.js`：保留文件摘要和证据读取；新增 FinanceUpdate、Issue、事件详情和游标查询。
- `catledger_economic_events`、`catledger_event_evidence`：通过 `0006` 扩展并回填，不修改已应用迁移。
- `catledger_import_transaction_links`：保留旧行级追溯，但新业务以事件—交易链接为权威。

### 3.3 临时简化层，实施时替换

- `rowOutcome()` 的 `pending/linked/ignored + post/skip/reuse` 投影。
- `persistDocumentRows()` 中“一条有效行立即创建一个最终 event 和一条 decision”的逻辑。
- `validateDecisions()`、`canPost()` 与 `commitImport()` 的逐行提交模型。
- `catledger_import_decisions` 作为最终用户决定权威的用途；该表保留旧审计，不再接收新 ReviewIssue 决定。
- `catledger_import_postings` 以 `import_id` 为整批单位的用途；新入账由 `FinanceAction(post_all_ready)` 和 `FinanceUpdate` 驱动。
- 小程序 `model.js` 对复杂语义默认 skip，以及“将入账 / 不新建”三分组最终界面。

## 4. 目标模块边界

```text
catledger-import Event Function
  import-file-service
    -> storage-gateway / parser-registry / import-evidence-repository

  finance-update-service
    -> finance-update-repository
    -> organizer-planner             纯函数：全部来源 -> plan
    -> relation-planner              强关系确认、弱关系候选
    -> review-issue-builder          needs_action -> 一问题一决定
    -> postability                   服务端唯一 ready 裁决
    -> review-issue-service          CAS + 幂等 + 决定应用
    -> finance-update-posting        单事务写正式账本
    -> organizer-query               更新/Issue/证据安全投影

catledger-api
  -> 继续拥有正式 Account / Category / Transaction 规则
  -> 暴露同事务 ledger writer，禁止 organizer 重写一套余额规则
```

`catledger-import` 仍是一个 Node.js 18 事件函数，不引入云托管或常驻服务。为保证正式交易与 organizer 状态同事务提交，账本写入规则抽成两个部署包各自内聚、测试共享契约等价的 session writer；运行时不跨函数调用，也不跨目录引用部署外文件。

## 5. 状态机与服务端门禁

### 5.1 文件与批次

```text
file: awaiting_upload -> available -> parsed
                    \-> failed -> available/parsed
                    \-> discarded
parsed/committed -> cleanup_pending -> content_deleted

batch: parsing -> ready | failed | discarded
```

文件失败只改变自身；解析后的选择入口仍允许追加文件，`imports.prepareMany` 只准备新增的 queued 文件，不重复准备已 ready 或 failed 的来源。内容摘要命中既有文件时，服务端先区分账本生命周期：`committed` 才返回“已经入账”；未入账且未被活动更新占用时返回原不可变批次供当前文件行继续；仍被 `draft / failed / review` FinanceUpdate 占用时，在解析事务中先写 `replace_unposted_update` Action 并把旧更新标为 `abandoned`，再返回原不可变批次进入本次流程。客户端不显示“继续旧进度”，也不弹确认。`financeUpdates.prepare` 内部创建 FinanceUpdate 时只接收当前用户、状态为 ready、尚未被活动更新占用的批次；至少一份 ready 即可继续，全部失败只关闭“下一步”，不关闭重试、删除和追加入口。

### 5.2 FinanceUpdate

```text
draft -> organizing -> review -> posting -> posted
  |          |           |
  +----------+-----------+-> failed（可按动作规则恢复）
  +-----------------------> abandoned
posted -> corrected / undone（后续纠错或撤销动作）
```

`organizing` 和 `posting` 是事务内 CAS 状态，不作为跨请求进程锁。任何重试都以 `uid + update_id + expected_version + idempotency digest` 裁决。

### 5.3 EconomicEvent 与 ReviewIssue

- 初始事件只能由 planner 产生 `ready / needs_action / excluded`。
- `needs_action` 必须恰好有一个 open blocking Issue；解决后服务端重新调用 postability，得到 `ready / needs_action / excluded / posted`。
- `posted / corrected` 是终态事实投影，不能由客户端字段修改。
- 解决一个 Issue 后仍有其他阻塞原因时，原 Issue 变 `resolved`，新 Issue 使用新 key 和成员版本创建。

### 5.4 正式账本写屏障与放弃

- 账户步骤选择已有账户时只记录事件字段和映射草稿；选择新建账户时先生成稳定的未来账户 UUID，保存到 `catledger_finance_update_account_drafts`，正式 `catledger_accounts` 中仍不存在该行。
- `catledger_finance_update_account_mapping_drafts` 只保存本更新明确确认的支付工具映射意图；organize、ReviewIssue resolve 和返回上一步均不得更新 `catledger_import_account_mappings`。
- 已解决的 `account_mapping` 在 posting 前允许通过双版本 CAS 修订；修订必须锁定更新与问题，更新本批映射草稿，重算受影响事件，并 supersede 后重新生成尚未完成的后续问题。若相同事件已有其他 resolved 业务问题则返回冲突，禁止静默覆盖用户决定。
- `financeUpdates.post` 在同一事务中物化账户草稿、锁定全部账户和分类、提升映射草稿、写正式交易与链接并完成 Update；任一步失败，物化账户和映射也随交易一起回滚。
- `financeUpdates.abandon` 只以 CAS 把未入账 Update 设为 `abandoned` 并释放来源；文件证据、事件、Issue、Action 和草稿作为审计保留，正式账户域和交易域零写入。客户端成功后清空工作台，重新从文件选择开始。

## 6. 整理与关系规则

1. 先按同来源稳定身份归组；不稳定物理身份保持逐行独立。
2. 再检查跨来源共享稳定引用。只有来源不同、核心字段相容、稳定引用经过相应解析器规则核验时自动合并，并保存规则版本与 `auto_same_event` 原因。
3. 金额、币种、方向、时间窗口、文本、对方、尾号和日期桶只计算候选分数；即使一一匹配也只生成 `same_event` Issue，不自动合并。
4. 转账/还款要求两端账户不同、等额同币种、方向相反并命中明确业务语义；候选不唯一时全部保留为 Issue 成员。
5. 退款关系必须验证时间顺序、币种、原支出性质和累计金额；只有唯一强关系自动 confirmed，其余 proposed 或 Issue。
6. 已有正式交易通过来源身份链接或用户 `link_existing_transaction` 处理；不能靠近似文本自动复用。
7. 所有 planner 输出都校验证据、事件、状态计数和成员覆盖守恒后才持久化；失败时整个 plan 事务回滚，原解析证据不变。

## 7. ReviewIssue 类型与决定适用性

| 类型 | 典型阻塞 | 主要合法决定 |
| --- | --- | --- |
| `account_mapping` | 正式账户缺失 | `apply_fields`、`exclude_events` |
| `shared_fields` | 金额、时间、方向、性质或分类所需事实缺失 | `apply_fields`、`discard_evidence`、`exclude_events` |
| `same_event` | 弱线索产生多个同一事件候选 | `confirm_same`、`confirm_distinct`、`discard_evidence`、`link_existing_transaction` |
| `refund_relation` | 原支出未知、不唯一、无效或超额 | `link_refund`、`link_existing_transaction`、`exclude_events` |
| `transfer_accounts` | 转账/还款一端缺失或候选歧义 | `apply_fields`、`confirm_distinct`、`exclude_events` |
| `identity_conflict` | 稳定身份核心字段冲突或弱身份需确认 | `confirm_distinct`、`discard_evidence`、`link_existing_transaction`、`exclude_events` |
| `field_conflict` | 同一强关系证据核心字段冲突 | `apply_fields`、`discard_evidence`、`exclude_events` |
| `installment_origin` | 本金来源或组成不明 | `confirm_installment_principal`、`apply_fields`、`exclude_events` |

服务端以原 `review_issue_resolution.go` 的决定校验为基线；表中“主要合法决定”是 UI 可展示集合，不放宽服务端验证。

## 8. MySQL 迁移冻结

### 8.1 新增表

| 表 | 关键字段与唯一约束 |
| --- | --- |
| `catledger_finance_updates` | `(uid, update_id)` 主键；status/version/plan_version/current_action_id/守恒计数；`(uid,status,updated_at,update_id)` 游标索引 |
| `catledger_finance_update_sources` | `(uid, source_id)`；唯一 `(uid,update_id,source_order)`、`(uid,update_id,batch_id)`；`released_at` 与生成列 `active_batch_key` 保证同一批次最多属于一个未放弃更新，放弃后可重用；文件、批次、来源档案和规则快照均带 uid 外键 |
| `catledger_import_batch_issues` | `(uid, issue_id)`；唯一 `(uid,batch_id,issue_order)`；只保存稳定 code/severity/field |
| `catledger_economic_event_relations` | `(uid, relation_id)`；唯一 `(uid,relation_key)`；source/target event 均带 uid 外键和状态/版本 |
| `catledger_economic_event_transactions` | `(uid, link_id)`；唯一 `(uid,event_id,transaction_id,role)`；保存交易版本快照与创建角色 |
| `catledger_finance_actions` | `(uid, action_id)`；唯一 `(uid,idempotency_key_digest)`；保存 request digest、expected/applied update version 和状态 |
| `catledger_review_issues` | `(uid, issue_id)`；唯一 `(uid,update_id,issue_key)`；status/type/version/blocking/count/reason/action |
| `catledger_review_issue_members` | `(uid, member_id)`；唯一 `(uid,issue_id,member_key)`；object type/id/version、role、score、排序 |
| `catledger_finance_update_account_drafts` | `(uid,draft_account_id)`；唯一 `(uid,update_id,normalized_name)`；保存未来正式账户 UUID、名称、类型、性质、币种和决定 Action，只有 posting 事务可物化 |
| `catledger_finance_update_account_mapping_drafts` | `(uid,draft_mapping_id)`；唯一 `(uid,update_id,event_id,source_type,payment_method_key)`；保存更新范围映射意图，不属于正式可复用规则 |

### 8.2 扩展既有表

- `catledger_import_source_profiles`：补 `ledger_account_id/status/discovery_method/key_version` 所需一致性约束。
- `catledger_import_batches`：补 core digest、fingerprint、parse option、raw snapshot 等版本及 duplicate/conflict 计数；保留现有批次 ID。
- `catledger_import_rows`：补 semantic eligibility、disposition、ledger account snapshot、identity/core/fingerprint 版本；原始 JSON 不改写。
- `catledger_economic_events`：补 `update_id/event_key/status/version/flow_direction/economic_nature/ledger_account_id/counterparty_ledger_account_id/time/amount/currency/category/manual_field_mask/field_sources_json/reason_codes_json`。旧 `batch_id` 改为可空兼容锚点，`event_type/state/event_core_digest` 降为兼容字段；新查询只以 update、evidence 和 relation 为权威。
- `catledger_event_evidence`：补 `evidence_id/update_id/field_mask`，增加 `(uid,update_id,row_id)` 唯一约束。
- `catledger_import_decisions`、`catledger_import_postings`、`catledger_import_transaction_links` 不删除；新流程停止写入前两者，最后一表仅保留行级追溯。

### 8.3 迁移与回填

`0006_unified_finance_updates.sql` 必须使用 `information_schema` 检查表、列、索引和约束，可从任意已完成步骤安全重跑。回填规则：

1. 已提交的单文件批次创建一个 `posted` FinanceUpdate，事件链接从既有 transaction link 回填，绝不新建交易。
2. `review_ready` 且没有正式链接的旧系统 event/decision 视为可重建投影；保留原始行和身份，在首次 `organize` 时按新 plan 原子替换临时投影。
3. `linked` 旧事件映射为已有正式交易链接；`ignored` 保留为 excluded 审计，不能重新入账。
4. 回填后执行用户隔离、外键、唯一键、守恒和孤儿链接检查；失败即停止部署，不先上新函数。

## 9. 公共动作冻结

### 9.1 文件阶段

| action | 类型 | 输入 | 输出 |
| --- | --- | --- | --- |
| `imports.prepareMany` | 幂等写 | `requestId, files[{clientFileId,fileName,size}]` | 独立 `importId/cloudPath/version` 列表与限制 |
| `imports.parseFile` | 幂等写 | `requestId, importId, fileID, timezoneOffsetMinutes` | 文件、批次、摘要、错误状态 |
| `imports.getFile` | 只读 | `importId` | 文件、最新批次、文件问题和恢复状态 |
| `imports.discardFile` | 幂等版本写 | `requestId, importId, version` | 文件与清理状态 |

### 9.2 FinanceUpdate 与 ReviewIssue

| action | 类型 | 输入 | 输出 |
| --- | --- | --- | --- |
| `financeUpdates.organize` | 幂等版本写 | `requestId, updateId, expectedVersion` | review Update、计数、Issue 摘要 |
| `financeUpdates.get` | 只读 | `updateId` | Update、来源摘要、计数、是否可入账 |
| `reviewIssues.list` | 只读 | `updateId,status?,type?,cursor?,pageSize?` | Issue 与 Member 安全摘要 |
| `reviewIssues.get` | 只读 | `issueId` | Issue、成员事件、关系、交易链接和按需证据 |
| `reviewIssues.resolve` | 幂等版本写 | 原 8 种决定所需字段、update/issue expected version | 新 Update、Issue、事件、关系、Action、replayed |
| `financeUpdates.post` | 幂等版本写 | `requestId,updateId,expectedVersion,mode=all_ready` | posted Update、Action、创建/复用计数 |
| `financeUpdates.abandon` | 幂等版本写 | `requestId,updateId,expectedVersion` | abandoned Update 与来源释放结果 |
| `economicEvents.correctionImpact` | 只读 | `updateId,eventId` | 交易缺失、外部修改、共享关系和整批重建影响 |
| `economicEvents.correct` | 幂等版本写 | `requestId,updateId,eventId,expected versions,correction` | corrected Update/Event、替换链接、Action |
| `financeUpdates.undoImpact` | 只读 | `updateId` | 是否可安全撤销及交易/关系影响 |
| `financeUpdates.undo` | 幂等版本写 | `requestId,updateId,expectedVersion` | undone Update、Action 与完整影响 |

新增领域失败码固定为 `SOURCE_BATCH_IN_USE`、`FINANCE_UPDATE_NOT_FOUND`、`FINANCE_UPDATE_VERSION_CONFLICT`、`FINANCE_UPDATE_STATE_CONFLICT`、`REVIEW_ISSUE_NOT_FOUND`、`REVIEW_ISSUE_VERSION_CONFLICT`、`REVIEW_ISSUE_DECISION_INVALID`、`UNRESOLVED_REVIEW_ISSUES`、`EVENT_NOT_POSTABLE`、`LEDGER_REBUILD_CONFLICT`。现有认证、文件、格式、幂等、数据库瞬时错误码继续保留；响应只返回稳定公开码，不返回原因正文或 SQL。

旧 `imports.prepare/parse/get/commit/discard`、分离的 `financeUpdates.create` 和单项 `reviewIssues.reviseAccountMapping` 已从公共契约、函数注册与客户端恢复白名单移除。历史表和内部实现只为既有数据保留；对外只有一个 FinanceUpdate 写入模型，正式交易只能由 `financeUpdates.post` 原子生成。

## 10. 原子入账与正式账本适配

1. 锁定 `FinanceUpdate`、本次 `FinanceAction` 和全部 Source 快照，校验版本、状态和守恒。
2. 读取全部事件、关系、Issue 和已有交易链接；存在 open blocking Issue 或 needs_action 立即拒绝。
3. 在同一事务内对每个 ready 事件重新执行 postability；客户端或旧数据伪造的 ready 不能越过门禁。
4. 按 ID 排序锁定正式账户、分类、原支出和已有交易，复用 `catledger-api` 的交易类型、退款约束、转账双端和余额语义。
5. 先把本 Update 的账户草稿物化为零余额正式账户；名称冲突或任何后续错误均使这些账户随事务回滚。
6. 创建普通收支、转账/还款双端或退款交易，写事件—交易链接和必要的行级审计链接，并把本更新的映射草稿提升为正式可复用规则。
7. 在锁定账户和未提交事务内比较 `cash` 入账前后余额：不允许新增或加深负数；触发时抛出 `INSUFFICIENT_CASH_BALANCE` 并回滚本 Update 的所有正式写入。
8. 逐事件 CAS 到 posted，更新 Update 计数和 Action 到 applied；任一步失败时账户、映射、交易、链接和状态整笔回滚。
9. 事务提交后再尝试清理各来源文件；失败登记 cleanup pending，不修改 posted 结果。

## 11. 测试迁移清单

### 11.1 继续保留的现有测试

- 支付宝 App/Web、微信 CSV/XLSX 内容探测、编码、混合换行、金额日期、行列上限和合成夹具。
- 支付工具规范化、分类建议、文件路径校验、身份字段拒绝、日志隐私。
- 用户隔离、同来源重复/冲突、并发裁决、事务回滚、网络和 MySQL 有界恢复。
- 小程序登录门禁、恢复状态、云调用策略和主题结构。

### 11.2 从原分支等价迁移的核心场景

- FinanceUpdate 来源冻结、幂等重放、非 ready 批次拒绝和来源占用释放。
- 证据守恒、关闭/失败记录审计、身份冲突隔离、同额同日多重性。
- 强稳定引用自动归组；弱金额/时间/文本与银行日期桶只生成候选，不自动归组。
- 转账、信用卡还款、平台钱包转银行卡、还款来源/目标唯一与歧义场景。
- 退款唯一关系、部分退款、累计超额、无唯一原支出和手工 link。
- ReviewIssue 分组、不同来源账户不误分组、一个事件一个问题、成员版本、后续 Issue。
- 8 种 ReviewIssue 决定的适用性、CAS、幂等和事务回滚。
- postability 普通收支/转账/还款/退款门禁，客户端伪造 ready 被拒绝。
- 全更新原子 posting、重复重放、已有交易链接、任一账本写失败整体回滚。
- 手工新建/修改/删除和 FinanceUpdate posting 都覆盖现金不可透支；导入触发余额门禁时不留交易、映射、链接或状态半成品。
- 新账户和账户映射在 ReviewIssue 解决后仍只存在草稿表；posting 成功时与交易一同生效，posting 失败或整批 abandon 时正式账户、映射、交易和余额逐项不变。
- posted 事件纠错重建、外部修改阻断、整批撤销影响预览和任一步失败回滚。
- 已提交旧单文件回填不重复交易；未提交旧投影重建不丢证据。

### 11.3 MySQL 与契约门禁

- `0006` 首次执行、逐步骤中断后重跑、checksum、索引/外键/检查约束和最小权限。
- 运行账号必须对参与锁定读取的 `catledger_finance_update_sources`、`catledger_import_transaction_links` 具备 `SELECT, INSERT, UPDATE`；测试和部署验收须区分“解析失败”与 `persist_file` 阶段的数据库权限失败。
- 两用户相同文件、批次号、身份、事件候选和幂等键完全隔离。
- `shared/catledger-import.json`、服务端动作注册和小程序静态调用无漂移。
- 账户步骤复用单文件版本已经确认的分组行布局：支付方式与影响条数在上，处理方式、新账户名称和类型在同一行，底部统一确认；多文件只改变分组数据来源，不重写账户交互。新账户仍只写 FinanceUpdate 草稿，不能恢复旧版提前创建正式账户的实现。
- 根目录静态测试、函数单元测试、MySQL 8 集成测试、`git diff --check`、CloudBase 代码审查和开发者工具预览。

## 12. 实施顺序与冻结门禁

实施严格按“迁移与回填测试 → 文件多选生命周期 → FinanceUpdate/organizer → ReviewIssue/postability → API → 原子 posting → 小程序替换 → 全量验证”推进。共享表、公共动作、状态和幂等契约由当前主负责人串行修改。

用户已明确确认直接实现并另行授权更新云函数。当前 worktree 已按本设计创建 `0006`、`0007`、公共动作、服务端模块和原生小程序工作台；开发云迁移、最小权限和 `catledger-import` 更新已完成，仍不提交、不合并、不推送。真实微信身份下的模拟器与真机闭环属于下一道验收门禁。

## 13. 账户身份三层模型

账户归属统一拆为三个不可混用的概念：

1. `AccountIdentity` 表达用户现实中的物理账户。带银行主体与稳定尾号的银行卡使用跨来源可携带身份；支付宝余额、余额宝、微信零钱等平台账户使用来源隔离身份；缺少稳定定位的银行卡泛称不得跨来源合并。
2. `PaymentReference` 表达一份账单中的精确来源引用，主键语义仍为 `sourceType + paymentMethodKey`，用于证据追溯、映射草稿和最终正式映射，不能拿它直接决定界面分组。
3. `AccountDecisionGroup` 表达用户只需作出一次的决定。planner 先按 `AccountIdentity` 聚合全部 `PaymentReference`，再按固定优先级裁决有效账户；一个决定保存时展开到组内每个精确来源引用。

规划、已确认账户展示、资金双端、历史映射、本批选择、增量重算和 posting 必须共用上述身份解析与优先级函数。最高优先级出现不同账户时视为身份映射冲突，整组退回一个开放问题；不得按来源拆开，也不得依赖数组顺序覆盖。计划版本升级后，未入账旧计划由现有版本门禁整体重建，正式账本数据不迁移。

### 13.1 聚合账户引用与还款分配

`PaymentReference` 再区分 `atomic` 与 `aggregate`。`atomic` 才能形成 `AccountIdentity` 和可复用映射；`aggregate` 只描述来源账单把多个真实账户合并展示的事实。支付宝`花呗｜信用购`属于聚合引用，不能降级成名为“支付宝花呗｜信用购”的第三个正式账户。

规划器从同一 FinanceUpdate 内已识别的原子账户中，为聚合引用产生确定性候选：支付宝花呗及具体机构信用购优先，其余活动的信用卡/消费信贷账户只作补充选择。ReviewIssue 保存版本化 `repaymentAllocations[{accountId, amountMinor}]`，服务端同时校验 UUID、账户唯一、正整数分、活动状态、人民币、负债类型、不得等于付款账户以及合计严格等于事件金额。一个聚合还款事件在 posting 时投影为一笔或多笔正式 transfer，每笔使用 `repayment_allocation` 链接回同一事件；锁定、现金余额校验、失败回滚、撤销和重复入账判断都覆盖全部分配交易。当前纠错入口只接受单交易事件，聚合还款需先整批撤销后重新导入，避免部分重建。
