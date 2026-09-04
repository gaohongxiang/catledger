# MINI-1906A 账本完整性与可逆入账内核设计

> 本设计在 MINI-1905/1906 的 FinanceUpdate、EconomicEvent、ReviewIssue、Transaction 和 Account 边界上演进，不推翻导入领域模型。

## 1. 设计结论

采用“用户可理解的 Transaction + 内部不可变复式分录”双层模型：

```text
ImportFile / ImportBatch / ImportRow
                ↓
FinanceUpdate ─→ EconomicEvent ─→ ReviewIssue
                ↓
           Transaction
                ↓
           JournalEntry
                ↓
             Posting
                ↓
        余额 / 收支 / 净值 / 对账
```

- `FinanceUpdate` 仍是一次导入整理和原子提交的工作单元；
- `EconomicEvent` 仍表达现实中发生了什么，并连接多份证据与一笔或多笔交易；
- `Transaction` 仍是用户看到和操作的业务单据；
- `JournalEntry / Posting` 成为余额和统计的最终计算事实；
- 已生效事实只通过反向分录撤销，不物理删除、不原地改写金额。

## 2. 先行缺口收口

在引入新表前先修复现有边界，形成稳定迁移基线。

### 2.1 账户草稿

`financeUpdates.post` 不再扫描并物化全部未物化草稿，而是先从冻结的事件端点、账户映射草稿和有效分配中计算 `reachableDraftIds`。只有可达草稿可以物化。修改账户决定或放弃批次时，仓储层将不可达草稿标记为 `superseded`；既有历史数据通过相同可达性规则兼容，不依赖客户端清理。

### 2.2 修正与现金余额保护

`economicEvents.correctionImpact` 返回旧影响、新影响、账户差额和冲突集合。`correct` 在同一事务中重新锁定事件、关联交易、账户和动作，复用 posting 的现金负余额门禁。影响预览与最终执行使用同一规则版本和请求摘要。

### 2.3 撤销副作用

撤销策略冻结为：

- 正式金额影响：必须用冲销分录完全撤回；
- 批次新建且从未被其他正式交易使用的账户：标记停用，不物理删除；
- 已被其他交易使用的账户：保留启用状态；
- 来源账户映射和分类别名：保留有独立使用证据的绑定，否则标记为由该批次撤回；
- 原始证据、FinanceAction 和关系：永久保留审计状态；
- 云存储原文件：遵循既有保留/清理策略，撤销不尝试恢复已清理文件。

### 2.4 多交易经济事件

维护操作以 EconomicEvent 的完整有效 `EventTransaction` 集合为单位。聚合还款允许重新分配并原子重建；其他尚未冻结重建规则的多交易事件只允许整批撤销后重新整理。

## 3. 数据模型

新增迁移编号在执行前按主线最新迁移顺序确定，禁止回改 `0001`～`0008`。

### 3.1 `catledger_ledger_accounts`

内部科目，不直接等同于用户 Account。

关键字段：

- `id`, `uid`；
- `account_class`：`ASSET / LIABILITY / EQUITY / INCOME / EXPENSE / CLEARING`；
- `normal_side`：`DEBIT / CREDIT`；
- `user_account_id`：资产或负债科目可关联正式 Account；
- `category_id`：收入或支出科目可关联分类；
- `system_key`：期初余额、余额调整、未知清算等受控系统科目；
- `currency`, `status`, `created_at`, `updated_at`。

`uid + user_account_id`、`uid + category_id + account_class` 和 `uid + system_key + currency` 使用条件等价的唯一约束策略，禁止跨用户引用。

### 3.2 `catledger_journal_entries`

关键字段：

- `id`, `uid`, `transaction_id`；
- `economic_event_id`，手工交易允许为空；
- `entry_type`：原始入账、冲销、替代、迁移回填；
- `status`：只允许 `draft → posted` 或 `draft → void`；
- `reversal_of_entry_id`；
- `occurred_at`, `currency`, `rule_version`, `idempotency_key`；
- `created_at`, `posted_at`。

posted 后业务字段不可更新。撤销通过新 Entry 指向 `reversal_of_entry_id`。

### 3.3 `catledger_postings`

关键字段：

- `id`, `uid`, `journal_entry_id`, `ledger_account_id`；
- `side`：`DEBIT / CREDIT`；
- `amount_minor`：大于零的整数；
- `category_id`、`sequence_no`、`created_at`。

同一 Entry、币种内的借方和贷方必须相等。跨行守恒由领域服务在持锁事务内验证，Entry 只有在验证通过后才能转为 posted；数据库约束负责正金额、枚举、唯一性、外键和用户隔离。

### 3.4 交易投影示例

| 业务 | 借方 | 贷方 |
| --- | --- | --- |
| 现金支出 | 支出分类科目 | 资产账户科目 |
| 信用账户消费 | 支出分类科目 | 负债账户科目 |
| 收入到账 | 资产账户科目 | 收入分类科目 |
| 资产间转账 | 目标资产科目 | 来源资产科目 |
| 信用卡还款 | 负债账户科目 | 资产账户科目 |
| 余额校正增加 | 资产账户科目 | 余额调整权益科目 |
| 退款到账 | 资产账户科目 | 原支出分类科目或原分录反向 |

聚合还款可以由一个 Transaction 业务组或一个 EconomicEvent 下的多笔 Transaction 产生多个平衡 Entry，但必须共享同一原子动作和完整追溯关系。

## 4. 服务边界

### 4.1 `ledger-posting-domain`

纯领域模块，把已验证 Transaction 投影为 LedgerEntry 草稿，负责：

- 交易类型到内部科目的确定性映射；
- 金额、币种和借贷守恒；
- 退款、冲销和替代关系；
- 规则版本及稳定摘要。

### 4.2 `ledger-posting-repository`

只负责 uid 范围内加锁、插入、状态转换和读取，不自行决定业务语义。

### 4.3 正式写入适配器

手工交易命令和 `financeUpdates.post` 共用一个 `postFormalTransaction` 适配器。在同一 MySQL 事务中完成：

1. 校验业务交易；
2. 创建或复用 Transaction；
3. 生成并验证 JournalEntry / Posting；
4. 执行现金余额安全门禁；
5. 写关系、映射提升和动作回执；
6. 提交事务。

任何正式写入口直接插入 Transaction 而未生成分录时视为契约违规。

## 5. 修正与撤销流程

```text
影响预览
  → 锁定事件/交易/分录/账户/动作
  → 核对 expectedVersion 与完整关联集合
  → 创建旧分录的反向 Entry
  → 创建替代 Transaction/Entry（纯撤销时省略）
  → 执行现金余额和守恒检查
  → 更新关系状态与动作回执
  → 原子提交
```

旧 Transaction 保留审计记录并进入 `reversed` 等等价状态；现有 `deleted_at` 在迁移兼容期继续读取，但新流程不再把软删除本身视为余额撤销依据。

## 6. 迁移与切换

### 阶段 A：修复基线

完成账户草稿、修正门禁、撤销副作用和多交易维护测试。此阶段仍由 Transaction 计算余额。

### 阶段 B：建表与历史回填

- 新增内部科目、Entry、Posting 和迁移进度表；
- 按 `uid + transaction_id + rule_version` 幂等回填；
- 对异常旧数据生成隔离报告，不猜测账户或分类。

### 阶段 C：影子写入与比对

- 所有新交易同时写 Transaction 和分录；
- 用户读取仍走旧口径；
- 后台按用户、账户、月份、分类计算旧新差异，只保存计数和金额摘要。

### 阶段 D：切换读取

只有全量和增量零差异、真实微信身份回归通过后，余额和统计才能切到 Posting。切换使用服务端版本开关，允许紧急回到旧读取，但不删除分录。

### 阶段 E：关闭旁路

移除旧直写路径和旧余额计算权威；保留兼容读取直到至少一个稳定发布周期结束。

## 7. API 与小程序

- 保留现有 Transaction 和 FinanceUpdate 公共主模型；
- `correctionImpact / correct / undoImpact / undo` 返回完整事件级影响，不暴露内部科目 ID；
- 小程序增加影响预览、冲突说明、确认和完成态；
- 多交易事件不显示单笔编辑入口；
- API 错误继续使用稳定公开错误码，内部守恒细节只进入脱敏日志。

## 8. 一致性、安全与并发

- 新表所有主键关系、唯一约束和查询均包含 `uid`；
- OPENID 只从 `cloud.getWXContext()` 获取并经既有身份摘要处理；
- Entry、Posting、Transaction、FinanceAction 和映射提升共享调用方事务；
- 幂等重放返回首次回执；相同键不同摘要返回冲突；
- posted Entry 内容不可修改，数据库账号不授予应用侧删除权限；
- 日志只记录规则版本、对象摘要、计数、差额和阶段，不记录原始账单值。

## 9. 测试策略

至少覆盖：

- 每种交易类型的借贷投影和金额守恒；
- 账户草稿从新建改为既有账户后的不可达物化回归；
- 修正造成或加深现金负数时整体回滚；
- 普通事件与聚合还款的冲销、替代、重放和并发；
- 撤销后账户、映射、别名和关系状态；
- 历史回填可重入、断点恢复、跨用户隔离；
- 旧新余额、月度收支、每日统计、分类排行零差异；
- 云函数超时、死锁重试、提交结果不确定恢复；
- 小程序真实微信身份下的影响预览、确认和刷新闭环。

## 10. 回滚策略

- 迁移只新增表、索引和兼容字段，保持 forward-only、可重入；
- 读取切换前可停止影子任务，旧功能继续工作；
- 读取切换后可通过版本开关暂时回到 Transaction 口径；
- 已 posted 分录和迁移审计不得删除；发现错误时以新迁移和冲销修复；
- 不回退已经提升的数据隔离、幂等和正式账本写屏障。

## 11. 后续扩展边界

- AccountIdentity 主数据：在独立规格中增加来源引用、绑定有效期、合并和换卡，不改变 Posting 的账户守恒；
- 对账：把银行余额快照和差异事件连接到 LedgerAccount，不直接改余额；
- 贷款：Transaction 保留一次还款语义，Posting 分拆本金、利息和费用；
- 多币种：每币种分别守恒，汇兑通过明确桥接和汇差 Entry 表达；
- 期间结账：通过期间锁定阻止回写，修正进入开放期间。
