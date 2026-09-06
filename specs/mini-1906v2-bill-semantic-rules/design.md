# MINI-1906V2 账单整行语义识别设计

> 状态：设计已按本地候选实现；真实账单盘点、关系层进一步物理拆分和 V2C 差分切换尚未完成。
>
> 目标：建立唯一的账单整行语义入口，不建设通用规则平台，不改变正式账本模型。

## 1. 设计结论

本阶段采用以下固定链路：

```text
账单文件
  → Source Adapter
  → Row Semantic Resolver
  → Relation Resolver
  → EconomicEvent Builder
  → 现有 FinanceUpdate → Transaction
```

核心约束：

1. 一个来源模板由一个版本化 Profile 负责读取字段和解释整行组合；
2. 来源动作、最终经济性质、资金状态和最终行归宿分别表达；
3. 关系层以后不再读取支付宝、微信原始字符串；
4. 无匹配、冲突或账户影响不完整的行不能变成 ready 事件；
5. 复用现有 Evidence、EconomicEvent、ReviewIssue、FinanceUpdate 和 `plan_version`，本阶段不新增数据表；
6. 首期规则是受测试的 JavaScript 数据与纯函数，不引入 DSL、动态插件或远程规则。

## 2. 当前问题与改动位置

| 当前位置 | 当前职责混合 | V2 后职责 |
| --- | --- | --- |
| `parsers/platform.js` | 模板猜测、已知列投影、逐行规范化 | 容器读取、Profile 唯一匹配、记录分类、RawBillRow 输出 |
| `parsers/normalize.js` | 金额日期解析、宽泛状态与资金效果判断 | 只保留确定性的格式解析和观测状态 |
| `source-action.js` | 按来源字符串推断动作 | 兼容入口；来源规则迁入对应 Profile |
| `source-funds.js` | 按动作和零散字段推断账户端点 | 兼容入口；端点规则迁入整行 Resolver |
| `organizer-planner.js` | 再次读取来源字段并决定经济性质 | 只消费 RowSemantic、关系结果和账户映射 |
| `organizer-model.js` | 通用门禁与部分来源兜底 | 只保留来源无关的经济性质和完整性门禁 |

V2 不在旧逻辑外再包一层；每个 Profile 切换完成后，删除该 Profile 已迁移的旧字符串分支。

## 3. Source Adapter

### 3.1 Profile 边界

首期四个 Profile：

```text
wechat_csv
wechat_xlsx
alipay_app_csv
alipay_web_csv
```

CSV 与 XLSX 即使共享微信字段语义，也分别维护容器和模板版本。Profile 是仓库内普通模块，最小结构为：

```js
{
  profileId,
  profileVersion,
  adapterVersion,
  policyVersion,
  container,
  markers,
  requiredHeaders,
  optionalHeaders,
  allowedExtraHeaders,
  fieldAliases,
  fieldRoles,
  formats,
  tokenDomains,
  rowRules
}
```

手动选择平台只缩小候选。必需列缺失、别名列相互冲突或多个 Profile 同时满足时，Adapter 返回结构问题，不取最高分继续处理。

### 3.2 文件记录分类

Adapter 输出：

```js
{
  profileId,
  profileVersion,
  dataRows,
  controlFields,
  metadataRows,
  decorativeRows,
  diagnostics
}
```

- `dataRows`：交易记录，进入语义解析并参与行数守恒；
- `controlFields`：账期、声明行数、汇总、余额；
- `metadataRows`：来源账户、导出信息等；
- `decorativeRows`：空行、说明、分隔线、重复页眉和页脚。

Adapter 不因第一条空行或分隔线无条件结束文件。无法证明是装饰行的非空记录必须作为未知数据候选暴露，不能静默丢弃。

### 3.3 RawBillRow

```js
{
  rowId,
  sourceLocator,
  profileId,
  profileVersion,
  occurredAt,
  amount,
  currency,
  transactionType,
  direction,
  status,
  paymentMethod,
  counterparty,
  item,
  note,
  identityRefs,
  rawFields,
  observations
}
```

`observations` 区分 `VALUE`、`EXPLICIT_SLASH`、`EXPLICIT_BLANK`、`COLUMN_MISSING`、`PARSE_FAILURE` 和 `UNKNOWN_TOKEN`。原始值继续只保存在现有 Evidence/raw snapshot；这里保存引用和解析结果，不建立重复的敏感数据副本。

## 4. Row Semantic Resolver

### 4.1 输出契约

```js
{
  rowId,
  resolutionStatus,
  moneyEffect,
  sourceAction,
  settlement,
  amountMinor,
  currency,
  fromAccountRef,
  toAccountRef,
  paymentComponents,
  identityRefs,
  ruleIds,
  issues
}
```

`resolutionStatus`：

```text
RESOLVED / UNKNOWN / CONFLICT / INVALID
```

`moneyEffect`：

```text
FINANCIAL / NON_FINANCIAL / FAILED / CLOSED / PENDING / UNKNOWN
```

`sourceAction`：

```text
PURCHASE / RECEIPT / TRANSFER_SENT / TRANSFER_RECEIVED /
REFUND_CREDIT / TOP_UP / WITHDRAWAL / REPAYMENT / BORROW / FEE / YIELD
```

最终行归宿和 `EconomicNature` 不属于 Row Semantic Resolver。

### 4.2 分阶段但不分散

同一 Resolver 内按固定阶段执行：

```text
资金效果
  → 来源动作
  → 结算状态
  → 账户端点
  → 单行完整性
```

每个阶段评估全部适用规则：

- 零条命中：必需结果为 `UNKNOWN`；
- 多条同值命中：合并 `ruleIds`；
- 多条不同值命中：`CONFLICT`；
- 不按数组顺序、注册顺序或最后写入选结果。

规则至少声明 `ruleId`、`reads`、条件和输出。首期直接写成 Profile 内的对象和纯函数，由共享 evaluator 执行。

### 4.3 组合支付

支付方式先解析为全部成分：

```js
paymentComponents: [{
  reference,
  componentKind, // financial / certified_discount / unknown
  amountMinor
}]
```

处理规则固定为：

1. 恰好一个资金账户，其余均为已认证优惠成分：使用该资金账户；
2. 多个资金账户且每项金额完整：生成分项账户影响，分项合计必须等于总额；
3. 多个资金账户但分项金额不完整：产生阻断问题；
4. 任一未知成分可能承担资金：不得取第一个账户。

首期 Profile 没有可靠逐项金额来源时，只实现第 1、3、4 条，不猜分摊。

## 5. Relation Resolver 与最终归宿

Relation Resolver 只读取标准行语义、稳定来源标识和现有正式交易候选，负责：

- 退款对应原消费；
- 同一资金移动的多来源证据；
- 信用卡还款及已有聚合还款分配；
- 重复 Evidence；
- 只提示不自动采用的弱关系候选。

自动关系必须来自稳定官方标识或已认证强关系。金额、日期、商户、商品和备注只能产生候选。

最终归宿由唯一纯函数生成：

```js
deriveRowDisposition(rowSemantic, relationResult, userDecision)
```

可能结果：

```text
MONEY_EVENT / NON_FINANCIAL / DUPLICATE_EVIDENCE /
NEEDS_REVIEW / USER_EXCLUDED / INVALID
```

Row Resolver 不写归宿；Relation Resolver 只写关系结论；ReviewIssue 操作只记录现有用户决定。覆盖报告统一调用该纯函数；posting 复用覆盖守恒校验，事件生成仍由 Builder 和 postability 完成，避免覆盖层反向修改事件。

## 6. EconomicNature 与 Builder

Relation Resolver 根据来源动作、端点和关系确定：

```text
EXPENSE / INCOME / INTERNAL_TRANSFER / REFUND /
REPAYMENT / BORROW / FEE
```

示例：

```text
WITHDRAWAL        → INTERNAL_TRANSFER
TOP_UP            → INTERNAL_TRANSFER
TRANSFER_RECEIVED → INCOME / INTERNAL_TRANSFER / BORROW / REFUND
REPAYMENT         → REPAYMENT
BORROW            → BORROW
FEE               → FEE
YIELD             → INCOME
```

这里直接复用现有 `ECONOMIC_NATURE` 值，不新增同义枚举；既有 `BALANCE_ADJUSTMENT` 仍保留给原有流程，但不由首轮账单 Profile 自动产生。

Builder 只接收 `RESOLVED + FINANCIAL` 且已经确定 `EconomicNature` 的结果，并生成现有 EconomicEvent。非资金、失败、关闭、处理中、未知和冲突行只保留 Evidence/问题/归宿。

新增使用已有语义的银行模板不得修改 Builder。只有首次出现确实无法由上述类型表达的新经济事件时，才扩展通用枚举和 Builder；通用模块永远不读取机构名称或机构 token。

## 7. 覆盖、界面结果与一致性

### 7.1 三个门禁

1. `dataRows.length` 等于六类最终归宿数量之和；
2. 所有选中资金事件通过现有金额、日期、币种、账户端点和关系门禁；
3. 认证 Profile 没有关键未知 token、未知组合、规则冲突或未解决资金行。

### 7.2 两个用户可见结果

```js
{
  statementFullyRecognized,
  selectedEventsReadyToPost
}
```

文案规则：

- `statementFullyRecognized = true`：显示“整份账单已识别”；
- 否则显示“仍有 N 条需要确认”，并列出未知、冲突或无效数量；
- `selectedEventsReadyToPost = true`：显示“已选择 N 条，可入账”；
- 有已识别但排除的记录：同时显示“资金记录 N 条，按你的规则排除 M 条，本次入账 K 条”；
- 只有 posting 成功后才显示“已入账 K 条”；不使用含糊的“完整导入”。

本阶段只定义状态和文案，不改变现有页面视觉系统。

### 7.3 预览与提交一致

不新增 `InterpretationRun` 或摘要表。现有来源 batch/row 通过迁移 0009 保存文件分析、行语义和字段观测；历史列可空。以下稳定摘要仍为 V2C 设计目标，当前 posting 已落地版本及证据门禁：

- `plan_version` 作为整理算法兼容版本，Profile/Adapter/规则策略变化影响整理结果时必须同步升级；来源分析分别保存这些具体版本；FinanceUpdate `version` 继续作为客户端 expected token；
- 分析摘要由 Evidence 身份集合、Profile 版本、规则版本、行语义、关系结果和已应用用户决定的稳定排序结果计算，用于诊断与新旧差分，不代替事务锁和 `version`；
- posting 继续消费已持久化 EconomicEvent；
- posting 在锁内按已持久化事件集合重新执行现有完整性门禁；`version` 或 `plan_version` 变化时拒绝提交并要求重新整理。

随机 ID、显示顺序和原始敏感文本不得进入稳定摘要。

## 8. 代码边界

目标文件布局：

```text
cloudfunctions/catledger-import/src/
  parsers/
    platform.js                 容器读取与 Profile 选择入口
  profiles/
    index.js                    Profile 注册与唯一匹配
    wechat-csv.js
    wechat-xlsx.js
    alipay-app.js
    alipay-web.js
  row-semantic-resolver.js      共享分阶段 evaluator
  relation-resolver.js          标准行关系解析入口
  economic-event-builder.js     标准语义到现有 EconomicEvent
  coverage-report.js            唯一归宿与两个产品结果
```

不为每个内部中间值新建文件或数据库实体。现有 `payment-account.js` 的确定性账户引用解析、现有退款/还款关系能力和现有 posting 门禁优先复用。

公共导入接口保持兼容。若覆盖字段需要返回客户端，只以可选字段扩展并同步 `shared/catledger-import.json`。

## 9. 分阶段切换

### V2A：统一输入

- 建立四个 Profile 和唯一匹配；
- 输出记录分类与 RawBillRow；
- 报告未知列和未知 token；
- 旧逻辑仍是生产结果，V2A 不改变 EconomicEvent。

### V2B：统一语义

- 建立 RowSemantic 纯函数和冲突合并；
- 先迁移微信，再迁移支付宝整行规则；
- 建立 Relation Resolver 和来源无关 Builder；
- 每条规则先有正例、逐条件 near-miss 和冲突测试。

### V2C：差分与切换

- 测试/诊断路径双跑新旧结果，不双写正式事件；
- 按稳定 Evidence 身份比较动作、金额、账户端点、关系、经济性质和可入账性；
- 人工确认预期差异后按 Profile 切换；
- 一个 Profile 稳定后，只删除它对应的旧字符串逻辑。

不建设运行时动态规则模式、差异审批平台或远程开关系统。

## 10. 测试设计

每个 Profile 至少覆盖：

- 必需列、可选列、未知列、重复冲突列和错误 Profile；
- data/control/metadata/decorative 分类与数据行守恒；
- 每个实际 token 的已知、显式空、未知和解析失败；
- 每条关键联合规则的正例与逐条件 near-miss；
- 零规则、同值多规则和异值多规则；
- 微信“已存入零钱”、支付宝零金额生命周期、小荷包旧键；
- 唯一资金账户加优惠、多资金账户有分项和无分项；
- 退款、同额独立交易、转账、还款、重复 Evidence；
- 用户排除已识别行与排除未知行的不同覆盖结果；
- 新旧稳定差分、重复整理、版本变化和提交冲突；
- 跨用户隔离、日志脱敏和失败不产生正式交易。

V2C 完成前执行根目录、`catledger-api`、`catledger-import` 非数据库和 MySQL 8 测试、生产依赖审计、JavaScript/JSON 语法与 `git diff --check`。真实文件只由用户主动选择使用，不进入仓库或普通日志。

## 11. 明确不做

- 通用规则 DSL、动态插件和远程规则包；
- 新的运行快照、Claim、Token 或覆盖数据库表；
- 用户自定义列映射和 JSON 映射；
- 银行通用导入、PDF、OCR 和 AI；
- 新的 JournalEntry / Posting；
- 为未来贷款、多币种或证券预先扩展当前 Builder。

## 12. 设计验收

进入编码前只需确认：

1. 四个 Profile 是首轮唯一来源范围；
2. `SourceAction`、`EconomicNature`、资金状态和最终归宿边界冻结；
3. 组合支付不再默认取第一个账户；
4. 行数守恒只计算明确识别出的交易数据行；
5. “整份账单已识别”和“本次选择可入账”分开展示；
6. 本阶段不新增领域表、新账本或通用规则平台；V2-REVIEW 通过迁移 0009 为现有来源表增加三个可空分析列。

### 组合支付人工决定补充（2026-09-05）

用户已允许核对支付详情后手工补齐。payment-resolution.js 为唯一人工分项验证器，原始 paymentComponents/paymentSourceDirection 与人工 paymentResolution 分开存于 field_sources_json；旧 v26 事件在详情及保存读取时从不可变 Evidence/ImportRow.semantic_json 补齐成分，不重建批次或清除已有决定。现有 apply_fields 增加唯一 paymentResolution 字段，禁止与其他字段混写。验证、正式分项及限制详见入账逻辑说明“人工组合支付决定”章节；最终 posting、幂等和 uid 事务边界不变。


账户归组契约：新增 reviewIssues.refreshAccountGroups(requestId,updateId,version)，field_sources_json.paymentAccountReferences/paymentAccountGroupsVersion 保存来源引用与升级标记；ReviewIssueMember.memberRole 扩展 payment_component_N/payment_target。复用普通账户批量确认与草稿机制，paymentAccounts 可在内部按组部分保存，完整 paymentResolution 门禁不变。见入账逻辑 COMBO-09 和规划 21.17。
