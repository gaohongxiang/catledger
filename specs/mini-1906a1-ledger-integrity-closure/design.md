# MINI-1906A1 现有账本完整性收口设计

> 本设计修复现有 `FinanceUpdate → EconomicEvent → Transaction → Account` 链路，不引入不可变分录内核。

## 1. 总体策略

```text
先建立失败测试
    ↓
账户草稿可达性
    ↓
修正影响与现金门禁
    ↓
撤销副作用策略
    ↓
多交易事件整体维护
    ↓
真实身份回归与基线冻结
```

整个阶段继续从未删除 `Transaction` 聚合余额与统计。后续 A2/A3 才引入 JournalEntry / Posting。

## 2. 账户草稿可达性

### 2.1 当前问题

现有 `materializeAccountDrafts` 按 Update 查询全部 `materialized_at IS NULL` 草稿并创建正式账户，无法区分已被后续决定替换的旧草稿。

### 2.2 可达集合

posting 在物化前由服务端计算 `reachableDraftIds`，来源只能包括：

- 最终状态为 ready 的事件 `ledger_account_id`；
- 最终状态为 ready 的事件 `counterparty_ledger_account_id`；
- ready 聚合还款的有效 `repaymentAllocations[].accountId`；
- 最终需要提升为 `mapping_action=account` 且对应事件会正式入账的映射草稿账户。

排除、needs_action、已被修改决定替换、无有效事件引用或只属于已放弃动作的草稿不进入集合。

`materializeAccountDrafts(connection, uid, updateId, reachableDraftIds)` 必须：

1. 锁定 Update 和候选草稿；
2. 校验每个 ID 属于同一用户与 Update；
3. 只插入可达且未物化的草稿；
4. 对不可达草稿写 `superseded_at / superseded_action_id` 等价审计状态；
5. 依赖数据库唯一约束和事务幂等避免重复账户。

需要新增状态字段时使用后续连续迁移，禁止回改 `0007`。

## 3. 修正影响与现金门禁

### 3.1 统一影响模型

把旧交易和新草稿投影为账户差额：

```text
destination account  +amount
source account       -amount
```

修正影响是 `reverse(old) + apply(new)`。预览返回：

- eventId、updateId 和 expectedVersion；
- 完整关联交易及各自版本；
- 旧影响、新影响和账户净差额；
- 退款依赖或外部引用；
- 是否可修正及稳定冲突码；
- `correction-policy-v1` 等显式规则版本；
- 规范化请求摘要。

### 3.2 执行

`economicEvents.correct` 在同一事务中：

1. 锁定 Update、事件、完整 EventTransaction 集合；
2. 核对预览摘要、事件版本和交易版本；
3. 锁定受影响账户，按稳定 accountId 顺序；
4. 锁定退款原交易和依赖退款；
5. 计算当前余额及修正后余额；
6. 拒绝产生或加深现金负数；
7. 更新允许维护的交易和事件；
8. 写动作回执并提交。

影响计算应提取为纯领域函数，手工交易、首次 posting 和导入修正保持同一现金规则测试向量，即使暂时位于不同云函数代码树，也不能出现不同语义。

## 4. 撤销副作用

### 4.1 来源归属

为可撤销副作用建立明确来源：

- 新账户保留创建它的 FinanceUpdate 或 action 归属；
- 账户映射和分类别名记录创建/最后确认动作及版本；
- 撤销只处理当前批次确实创建或最后独占确认、且没有后续独立使用的对象；
- 不能凭名称、时间接近或当前值猜测归属。

### 4.2 撤销顺序

```text
影响预览
  → 锁定 Update、事件、交易、账户、映射、别名和依赖
  → 核对外部修改与引用
  → 软删除本批创建交易
  → 更新事件和关系审计状态
  → 停用仅由本批创建且未被使用的账户
  → 撤回无独立使用证据的映射/别名
  → 写幂等回执
  → 原子提交
```

原始证据不删除，云存储已清理对象不尝试恢复。已有其他交易使用的账户和已有后续动作使用的规则继续保留。

`undoImpact` 应返回各类影响计数、无法撤销原因和将保留的对象摘要，不能只返回交易数量。

## 5. 多交易 EconomicEvent

### 5.1 集合锁定

所有维护动作先读取并锁定完整有效 EventTransaction 集合，摘要至少包含：

- transactionId；
- role；
- creationMethod；
- transactionVersion；
- deleted/reversed 状态。

任何成员变化都使旧预览失效。

### 5.2 聚合还款

聚合还款允许使用新的冻结分配原子重建：

1. 核验候选仍属于该事件冻结集合；
2. 分配账户唯一且为相容负债账户；
3. 每项金额为正整数分；
4. 合计等于来源付款金额；
5. 旧交易整体软删除或进入替代状态；
6. 新交易和全部 EventTransaction 关系在同一事务创建；
7. 现金门禁和幂等回执同事务完成。

### 5.3 其他多交易事件

未冻结重建规则时：

- `correctionImpact.canCorrect=false`；
- 返回稳定原因，如 `EVENT_REQUIRES_BATCH_UNDO`；
- 小程序隐藏单笔编辑；
- 用户只能返回账本或整批撤销后重新整理。

## 6. API 与界面

保留现有动作名：

- `economicEvents.correctionImpact`
- `economicEvents.correct`
- `financeUpdates.undoImpact`
- `financeUpdates.undo`

响应可以向后兼容地增加：

- `policyVersion`
- `requestDigest`
- `accountImpacts`
- `transactionSet`
- `sideEffectSummary`
- `conflicts`
- `allowedOperations`

所有执行动作必须回传对应预览摘要或等价 expected token，避免用户确认后数据已变化仍继续执行。

小程序只展示业务影响，不暴露内部 uid、SQL、锁或未来会计科目。

## 7. 迁移与回滚

- 迁移只新增草稿状态、对象来源或撤回审计所需字段和索引；
- 编号从主线最新迁移之后连续确定；
- forward-only、可重入并校验 checksum；
- 部署前旧代码必须能容忍新增可空字段；
- 任一新流程异常时可以回退函数代码，Transaction 读取不变；
- 不删除历史草稿、Evidence、FinanceAction 或关系。

## 8. 测试策略

至少覆盖：

- 新建账户改为已有账户后的旧草稿不物化；
- 新建账户改为本次不计入、永久忽略或放弃批次；
- 多个事件共享同一可达草稿；
- 同请求重放、并发 posting 和唯一名称冲突；
- 修正支出、收入、转账、退款的账户差额；
- 修正产生或加深现金负数；
- 预览后事件或交易版本变化；
- 撤销后账户、映射和分类别名保留/撤回分支；
- 批次外退款、手工修改、后续映射和后续交易冲突；
- 聚合还款完整重建、金额不守恒和并发；
- 其他多交易事件无法局部修改；
- 跨用户隔离、死锁重试、超时恢复和日志隐私；
- 真实微信身份下账户、明细、统计和导入记录统一刷新。
