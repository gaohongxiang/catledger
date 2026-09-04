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
| 统一 TransactionDataTable | 建立更早、更完整的 FieldObservation / SemanticClaim 中间层，再生成 EconomicEvent |
| 自定义列和交易类型映射 | 建立用户范围、声明式、可版本化的 UserMappingProfile |
| 日期和金额格式自动检测 | 只生成建议，用户确认或 profile 认证后生效 |
| 映射 JSON 导入导出 | 支持可审计的配置迁移，并校验模板指纹和版本 |
| 按原始名称批量替换 | 按账户引用、有限 token 和 SemanticSignature 聚类预览与批量处理 |
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

## 5. 对产品承诺的修正

本项目不再用一个模糊的“支持导入”覆盖所有能力。用户运行时分为两条通道，维护者 adapter 另走离线认证生命周期：

| 通道 | 用户得到的承诺 | 完整性口径 |
| --- | --- | --- |
| `CERTIFIED_STATEMENT` | 当前模板整份账单经过已认证规则自动整理 | 可以声明字段、枚举、行归宿、关键语义和来源控制闭合 |
| `GUIDED_MAPPING` | 用户把长尾结构化文件转换并确认成一组可入账事件 | 只声明选中交易完整；未知、排除和未映射记录持续可见 |

维护者 adapter 使用 `draft → tested → shadow → certified` 生命周期，通过认证后才进入 `CERTIFIED_STATEMENT`。这使“快速支持一家新银行”和“承诺该银行整份账单自动正确”成为两个不同阶段，避免用硬编码成功率冒充覆盖完整性。

CatLedger 还必须分别表达语义解释范围和实际提交范围：整账已经正确识别但用户排除部分已识别事件时，可以是 `FULL_STATEMENT + SELECTED_EVENTS`；排除未知行则不能把 `SELECTED_SUBSET` 提升为 `FULL_STATEMENT`。

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
