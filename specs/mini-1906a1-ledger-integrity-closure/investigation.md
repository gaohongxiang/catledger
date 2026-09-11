# MINI-1906A1 调查与红灯基线

> 历史归档：本文记录 2026-09-04 的调查状态，不代表当前实现、门禁或授权。当前状态以《招财猫记账本实施规划》0.3、0.5 和第 19 章为准。
>
> 原失败测试完整保存在提交 `d6604ee400386b761510c86f495f8ae8a0ab2f47` 的 `cloudfunctions/catledger-import/test/ledger-integrity-regression.test.js`。该测试依赖旧接口与旧 SQL 模拟，本次仅将调查文档纳入现行文件；可达草稿、现金门禁、完整集合维护及撤销副作用由现行 `maintenance-policy.test.js` 和 `integration.test.js` 回归覆盖。

> 状态：仅完成调查与失败测试，未开始 A1 生产实现。
>
> 原因：MINI-1906V 尚无真实微信身份完整验收证据，实施规划仍将其标记为“未开始”。

## 1. 已核对基线

| 项目 | 调查结果 |
| --- | --- |
| 当前仓库提交 | `be21fcb2320f1726eca058495632a012b8f1753b` |
| 被验收的统一导入代码基线 | `52147e19`；当前提交只在其上增加规划文档 |
| 开发云环境 | 状态正常，MySQL 实例运行中 |
| 数据库迁移 | 已登记 `0001`～`0008`，八个 checksum 与当前仓库文件逐一相同 |
| `catledger-api` | Event Function，Node.js 18.15，`Active / Available`，20 秒、512 MiB、VPC 已绑定、5 个数据库配置键、无触发器、无层 |
| `catledger-import` | Event Function，Node.js 18.15，`Active / Available`，60 秒、512 MiB、VPC 已绑定、5 个数据库配置键、公网出站开启、无触发器、无层 |
| 小程序体验版 | 仓库记录为 `0.19.30`；本次未上传，也未从微信开发者工具独立复核版本 |
| MINI-1906V | 未完成；缺少按 V1～V7 形成的真实身份脱敏验收记录 |

本次只执行只读平台查询，没有部署函数、执行迁移、修改云数据或上传体验版。函数环境变量只核对键名和数量，未读取值。

## 2. 当前正式写入口

### 2.1 `catledger-api`

- 账户：`accounts.create`、`accounts.createBatch`、`accounts.update`、`accounts.archive`、`accounts.correctBalance`；
- 分类：`categories.create`、`categories.update`、`categories.archive`、`categories.restore`、`categories.reorder`、`categories.assignTransactions`；
- 交易：`transactions.create`、`transactions.update`、`transactions.delete`、`transactions.linkRefund`。

手工交易通过 `transaction-command-service.js` 写 `catledger_transactions`，创建、修改和删除已经调用 `cash-balance-guard.js`。余额校正仍以 `origin=system` 的标准 Transaction 表达。

### 2.2 `catledger-import`

- 文件与解析：`imports.prepareMany`、`imports.parseFile`、`imports.discardFile`；
- 整理：`financeUpdates.prepare`、`financeUpdates.organize`、`financeUpdates.abandon`；
- 问题处理：`reviewIssues.resolve`、`reviewIssues.resolveAccountMappings`；
- 正式入账：`financeUpdates.post`；
- 入账后维护：`economicEvents.correct`、`financeUpdates.undo`。

其中只有 `financeUpdates.post` 可以把导入候选跨越写屏障变成正式账户、正式映射和正式交易。

## 3. 当前余额与统计读取入口

- `accounts.list` 从未删除 Transaction 的资金端汇总账户账面余额；
- `transactions.list` 从 `catledger_transactions` 读取明细和月度汇总；
- `dashboard.get` 从 Account + Transaction 的同一只读快照读取净资产、最近交易和近半年收支；
- `statistics.get` 从 Transaction 的同一只读快照读取月度、每日、分类、退款冲减和数据质量统计。

因此当前代码仍满足“Transaction 是余额和统计唯一权威”，没有 JournalEntry / Posting 表或读取路径。

## 4. 四个缺口的代码证据

### 4.1 不可达账户草稿

`account-draft.js::materializeAccountDrafts` 当前按 `(uid, update_id, materialized_at IS NULL)` 锁定整个批次的全部草稿，逐个插入 `catledger_accounts`，然后把整个结果集标记为已物化。函数没有接收或计算 `reachableDraftIds`。

`finance-update-posting.js` 在最终 ready 事件已经锁定后直接调用该函数，因此用户先新建草稿、再改选已有账户或排除事件时，旧草稿仍可能进入正式账户。

红灯测试 `A1-R2` 传入一个可达 ID 和一个孤儿 ID，当前实现实际插入两个账户。

### 4.2 修正缺少现金门禁

`finance-update-maintenance.js::correct` 当前锁定 Update、EconomicEvent 和关联 Transaction，校验账户、分类与退款依赖后直接更新正式交易。它没有：

- 读取旧交易的 source、destination 和 amount 完整影响；
- 计算 `reverse(old) + apply(new)`；
- 查询现金账户当前余额；
- 调用与手工交易等价的现金不可透支策略。

红灯测试 `A1-R3` 构造现金余额 50 分、旧支出 100 分改为 200 分的场景。当前实现没有查询余额，而是到达不安全的 Transaction 更新点。

### 4.3 撤销副作用不完整

`finance-update-maintenance.js::undoImpact` 目前只返回 created/reused/dependent Transaction 数量。`undo` 只处理：

- 本批 created Transaction 软删除；
- EconomicEvent 状态；
- 已确认 EconomicEventRelation 状态；
- FinanceAction 与 FinanceUpdate 状态。

当前没有处理或预览：

- 本批物化但未被其他事实使用的 Account；
- 本批提升的 `catledger_import_account_mappings`；
- 本批提升的 `catledger_import_category_mappings`；
- EventTransaction 自身的撤回审计状态。

现有正式 Account、账户映射和分类别名表也没有 FinanceUpdate/action 来源字段，无法仅凭当前值安全证明归属。这是后续 `0009` 必须补充明确来源与撤回状态、而不能根据名称或时间猜测的原因。

红灯测试 `A1-R4` 要求撤销预览至少提供上述四类 `sideEffectSummary`，当前结果不存在该字段。

### 4.4 多交易事件缺少集合令牌

`linkedTransactions` 会读取当前事件全部关系，但 `correctionImpactResult` 只返回 Transaction ID 列表；没有：

- role、creationMethod、transactionVersion、deleted 状态组成的完整集合；
- `policyVersion`；
- 规范化集合摘要与 `expectedToken`；
- 稳定冲突原因和允许操作。

`correct` 当前以 `created.length !== 1` 直接返回通用 `CONFLICT`。这避免了现阶段直接局部修改聚合还款，但不能解释“必须整批撤销”，也不能证明预览到执行之间集合未变化。现阶段不应在规格和测试尚未冻结时擅自实现聚合重建。

红灯测试 `A1-R5` 固定了最小安全输出：完整 Transaction 集合版本、`correction-policy-v1`、非空 expected token，以及 `EVENT_REQUIRES_BATCH_UNDO` 冲突原因。

## 5. 当前锁顺序与 A1 要求的差异

当前 `correct` 大体按 Update → EconomicEvent → EventTransaction/Transaction → Account → refund dependency → FinanceAction 执行，但缺少集合摘要核对和现金余额锁定。

当前 `undo` 按 Update → EventTransaction/Transaction → refund dependency → EconomicEvent/Relation → FinanceAction 执行，尚未进入 Account、账户映射和分类别名。因此生产实现开始前必须把统一锁序固定为：

```text
FinanceUpdate
  → EconomicEvent
  → EventTransaction / Transaction
  → Account
  → refund dependencies
  → account mappings / category mappings
  → FinanceAction / mutation receipt
```

同类 ID 必须排序后锁定。任何执行路径无法证明集合完整、来源归属或 expected token 一致时，应返回 `CONFLICT`，不得猜测或局部继续。

## 6. 红灯结果与继续门禁

新增测试：

`cloudfunctions/catledger-import/test/ledger-integrity-regression.test.js`

当前结果：4 项执行、0 通过、4 失败，分别对应 A1-R2、A1-R3、A1-R4、A1-R5。测试都调用现有生产函数或其公开领域结果，没有使用占位失败断言。

在 MINI-1906V 完成前：

- 不新增 `0009`；
- 不修改生产代码或 `shared/catledger-import.json`；
- 不勾选 A1 tasks；
- 不部署、不迁移、不上传体验版；
- 只保留本调查和四个红灯测试作为后续 TDD 起点。
