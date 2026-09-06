# MINI-1906V1 真实账单语义修复设计

## 1. 设计边界

修复继续使用现有主链路：

```text
不可变 Evidence
  → 来源动作/资金端推导
  → 账户身份与历史规则裁决
  → EconomicEvent / ReviewIssue
  → 用户可修改的 FinanceUpdate
  → Transaction / Account（本任务不改变）
```

不新增 schema。所有兼容和推导均由纯领域函数完成；旧批次通过 `PLAN_VERSION` 重建，因此不要求重新解析或改写原始行。

## 2. 账户键兼容

`catledger_import_account_mappings.payment_method_key` 保留原值。仓储读取启用历史规则后，为具有稳定 `payment_method_hint` 的记录额外派生当前 `buildPaymentMethodKey`：

- 原记录：`mappingScope=history`；
- 派生记录：`mappingScope=history_alias`；
- 优先级：`inferred < history_alias < history < batch < event`。

这样旧批次仍按原键恢复，新批次可命中规范键；以后写入的新版精确规则自然覆盖兼容候选。无法派生稳定键时不生成别名。

## 3. 单端账本账户引用

在 `source-funds` 增加 `ledgerAccountReferenceForRow`，统一返回普通收入/支出的账本账户引用：

1. 原支付方式可识别时返回原引用；
2. 微信外部转账、收入方向、支付方式为空或 `/` 且状态明确“已存入零钱”时，返回派生微信零钱引用；
3. 其他情况返回空。

Planner 的名称精确推断、历史映射、账户分组、事件 `paymentMethodKey` 与 `fieldSources.ledgerAccountReference` 全部使用同一函数。原始支付方式继续只存在于 Evidence；`fieldSources` 记录派生规则，供界面、修改和审计使用。

## 4. 非资金记录

`source-action` 增加严格的 `isNonFinancialSourceRecord`。只有支付宝、零金额、中性方向、原始类型 `信用借还`，且状态属于冻结的免押下单/解冻成功集合时返回真。

Planner 在账户解析前把完全由此类证据组成的事件标记为 `excluded`，原因码为 `source_non_financial`。这条规则直接读取不可变行字段，所以旧解析批次重建后也能生效。客户端只根据原因码显示“非资金记录”，不从文案再次猜测。

## 5. 长期忽略与可修改性

`resolveAccountMappings` 继续负责冲突和优先级，planner 使用其 `ignoredIdentityKeys` 判定历史忽略。命中后：

- 事件自动 `excluded`，保留 `source_account_ignored_default` 审计原因；
- 生成一条非阻塞、已解决的 `account_mapping`，账户步骤显示“以后不计入”，不要求再次保存；
- `fieldSources.ledgerAccountReference` 让既有 revise 流程能按精确引用改选账户；
- 用户改选后重算事件，最终 posting 才提升新规则。

## 6. 版本、接口和测试

- `PLAN_VERSION` 升级为下一连续版本，强制未入账计划重建；
- 公共 action 和 JSON 字段保持兼容，只增加内部 `fieldSources` 与结构化原因；
- 先增加四组失败测试：旧键/精确键优先级、历史忽略自动排除且可修改、微信零钱到账推导、支付宝非资金排除；
- 再运行导入函数全套测试、MySQL 8 集成、根目录测试、生产依赖审计、JS/JSON/WXML 检查和 `git diff --check`。
