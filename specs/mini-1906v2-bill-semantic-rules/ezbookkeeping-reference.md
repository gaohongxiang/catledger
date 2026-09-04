# ezBookkeeping 导入实现对照与取舍

> 调查基线：`mayswind/ezbookkeeping` `main@42b7013a90f7505d91a318961ba63250da519433`（2026-09-05 拉取）。
>
> 用途：记录 MINI-1906V2 需求取舍；不是对上游项目的完整评价，也不把上游当前行为当成本项目业务规则。

## 1. 上游实际模型

ezBookkeeping 使用三层导入方式：

1. 微信、支付宝、京东金融及 OFX/QIF/CAMT/MT940 等来源各自实现 adapter；
2. adapter 把来源字段压入统一 `TransactionDataTable`；
3. 前端预览解析结果，按原始账户名、分类名和标签名批量映射后，只提交已选择且有效的交易。

对于未知结构化文件，上游另提供自定义列映射、原始交易类型映射、日期/金额格式检测、映射 JSON 导入导出，以及在浏览器沙箱中执行自定义 JavaScript 的高级通道。最终交易使用一个数据库事务批量创建，请求会话 ID 只防止同一提交重复执行。

## 2. 微信与支付宝的关键行为

### 2.1 微信

- 收入行的支付方式为空或 `/` 时直接使用微信零钱，不要求状态同时证明“已存入零钱”；
- 中性 `/` 行只识别零钱充值、零钱提现和信用卡还款，其他转账类别直接跳过；
- 收入行状态包含退款时转为负数支出；
- 未建立退款关系、来源证据实体或跨文件来源身份。

### 2.2 支付宝

- 只接受固定的收支值和状态白名单，未知状态直接跳过；
- 中性交易通过商品说明的收益、买入、卖出、充值、提现、转入、转出、转账、还款等字符串分支确定账户端；
- 未知中性商品表达直接跳过；
- 退款使用负数支出表达，不建立 `refund_of` 关系。

## 3. 值得吸收的能力

| 上游能力 | 本项目采用方式 |
| --- | --- |
| 每个来源一个 adapter | 建立版本化 ProfileManifest 和来源 adapter，禁止通用 planner 出现机构字符串 |
| 统一 TransactionDataTable | 建立保留完整字段的 RawBillRow，再由唯一 Row Semantic Resolver 生成标准结果 |
| 自定义列和交易类型映射 | 记录为后续能力，不进入本期微信、支付宝重构 |
| 日期和金额格式自动检测 | 当前由 profile 明确声明；自动建议后续再做 |
| 映射 JSON 导入导出 | 延后，不作为四个现有 profile 的前置 |
| 按原始名称批量替换 | 只吸收批量处理体验；账户决定继续绑定稳定来源引用键 |
| 导入前逐笔检查 | 保留预览，但默认聚合真正未知的组合，避免要求用户扫描每一行 |
| 最终批量事务 | 延续 FinanceUpdate 整批 posting，并覆盖账户草稿、映射和关系副作用 |

## 4. 明确不采用的行为

- 不静默跳过未知类型、状态、转账表达或结构变化；
- 不因微信收入的支付方式为空就无条件认定微信零钱；
- 不用负数支出替代退款关系和原消费统计语义；
- 不用原始账户显示名称充当现实账户身份；
- 不把请求级重复提交保护当作来源级防重；
- 不在小程序、WebView 或云函数中执行用户自定义 JavaScript；
- 不让解析器直接创建正式 Account、Category 或 Transaction；
- 不把“选中交易均有效”描述成“整份账单已完整识别”。

## 5. 本阶段采用范围

本阶段只吸收 ezBookkeeping 的来源 adapter、中间行模型、预览和批量映射思路，用于收口微信与支付宝现有字符串判断。

用户自定义列映射、JSON 映射配置和长尾银行导入延后处理，不阻塞四个现有 profile。维护者为新来源增加普通代码 profile 和测试，不建设运行时 adapter 平台。

产品只需诚实区分：

- 当前认证模板的整份账单是否仍有未知或冲突；
- 用户最终选择了哪些已经识别的事件入账。

已识别后被用户排除的记录不等于未知；未知记录被排除后也不能被描述为整账完整。

## 6. 上游证据位置

- `pkg/converters/transaction_data_converters.go`
- `pkg/converters/wechat/wechat_pay_transaction_data_row_parser.go`
- `pkg/converters/alipay/alipay_transaction_data_row_parser.go`
- `pkg/converters/converter/data_table_transaction_data_importer.go`
- `src/core/import_transaction.ts`
- `src/views/desktop/transactions/import/tabs/ImportTransactionDefineColumnTab.vue`
- `src/views/desktop/transactions/import/tabs/ImportTransactionCheckDataTab.vue`
- `src/views/desktop/transactions/import/tabs/ImportTransactionExecuteCustomScriptTab.vue`
- `pkg/services/transactions.go`
