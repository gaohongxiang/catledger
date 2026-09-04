# MINI-1906V2 支付宝与微信字段字典草案

> 状态：基于当前解析器、合成夹具和 2026-09-04 脱敏问题证据整理；尚未执行完整私有真实账单枚举盘点。
>
> 本字典只登记字段结构、有限枚举和字段职责，不保存真实账单、姓名、商户、商品、账号、卡尾号或交易号。

## 1. 证据等级

| 标记 | 含义 |
| --- | --- |
| `CODE` | 当前生产代码已经声明的别名、模式或行为，但不等于真实来源枚举已经完整认证 |
| `FIXTURE` | 仓库合成夹具或自动测试使用的值 |
| `REAL_REDACTED` | 用户真实账单问题中已经观察并脱敏记录的结构或 token |
| `UI_REFERENCE` | 来源应用筛选界面显示的类别，只能作为盘点线索，不能直接当作导出文件枚举 |
| `PENDING_INVENTORY` | 仍需从用户私有文件生成只含字段/枚举/签名计数的诊断结果 |

## 2. 字段职责

| 职责 | 定义 |
| --- | --- |
| `semantic` | 参与来源动作、资金效果或最终经济性质判断 |
| `account` | 提供资金账户端点或账户引用证据 |
| `identity` | 提供同来源稳定身份或防重证据 |
| `relation` | 提供退款、转账、还款或跨来源关系证据 |
| `control` | 文件主体、账期、行数、汇总和余额控制 |
| `display` | 保留供用户核对，不单独决定关键账务语义 |
| `certified_ignored` | 经 profile 明确证明没有财务意义，仍保留原始值 |

### 2.1 ProfileManifest 最小字段

每个认证模板版本必须声明以下结构，不能只登记几个表头别名：

| 清单项 | 必须表达的内容 |
| --- | --- |
| `profileId` / `profileVersion` | 稳定来源模板与版本，不随展示名称变化 |
| `container` | CSV/XLSX、编码、分隔符、工作表和公式策略 |
| `preamble` | 必需、可选和禁止冲突的文件前导标记 |
| `headers` | 必需列、可选列、允许扩展列、别名和重复列规则 |
| `fieldRoles` | 每列的职责以及是否允许作为多个 claim 的证据 |
| `formats` | 日期、金额、符号、借贷列、币种和小数精度约定 |
| `tokenDomains` | 交易类型、方向、状态及其他有限枚举的已认证集合 |
| `controls` | 声明行数、收入/支出汇总、期初期末或逐行余额公式 |
| `adapterVersion` | Observation 映射实现版本 |
| `policyVersion` | 规则集合版本与兼容/替代关系 |

用户明确选择“微信”或“支付宝”只能缩小候选范围，不能替代上述结构认证。

首期 `ProfileManifest` 只是 profile 内受测试的 JavaScript 配置对象，不建设动态规则平台、远程规则包或独立配置数据库。

## 3. 通用规范观测

### 3.1 空值状态

| 规范值 | 含义 |
| --- | --- |
| `VALUE` | 来源提供了非空值 |
| `EXPLICIT_SLASH` | 来源明确写 `/` |
| `EXPLICIT_BLANK` | 列存在但单元格为空 |
| `COLUMN_MISSING` | 模板中没有对应列 |
| `PARSE_FAILURE` | 有原始值但无法按 profile 解析 |
| `UNKNOWN_TOKEN` | 有值，但未登记在该 profile 的有限枚举域 |

### 3.2 金额观测

| 规范值 | 当前含义 |
| --- | --- |
| `POSITIVE` | 可精确解析且大于零 |
| `ZERO` | 可精确解析且等于零 |
| `NEGATIVE` | 可精确解析且小于零；当前支付宝/微信实现不接受，未来银行 profile 可声明 |
| `INVALID` | 空值、精度超限、格式非法或越界 |

### 3.3 来源方向观测

| 原始 token | 规范观测 | 证据 |
| --- | --- | --- |
| `收入`、`收` | `SOURCE_INFLOW` | `CODE` |
| `支出`、`支` | `SOURCE_OUTFLOW` | `CODE` |
| `不计收支`、`中性交易`、`中性` | `SOURCE_NEUTRAL` | `CODE` |
| `/` | `EXPLICIT_SLASH` | `CODE`, `REAL_REDACTED` |
| 空单元格 | `EXPLICIT_BLANK` | `CODE` |
| 其他 | `UNKNOWN_TOKEN` | 目标规则 |

方向观测不直接等同于最终资金影响。提现、充值、还款和本人转账可能在来源中显示中性或 `/`，但最终具有两个账户端点。

## 4. 微信支付 CSV / XLSX 字段

两个 profile 共享字段语义；XLSX 额外保存工作表名称、行列坐标、隐藏状态、公式状态和容器版本。

| 规范字段 | 当前别名 | 职责 | 表头要求 | 行值要求 | 当前处理风险 |
| --- | --- | --- | --- | --- | --- |
| `transactionTime` | `交易时间`、`交易日期` | `semantic`, `identity` | 必需 | 必须可解析 | 当前支持本地文本时间和 Excel 数值日期 |
| `transactionType` | `交易类型`、`业务类型` | `semantic` | 必需 | 不得未知后仍自动入账 | 当前分类主要靠包含关系，需迁入联合决策表 |
| `counterparty` | `交易对方`、`交易对象`、`对方` | `relation`, `display`, 条件性 `account` | 必需 | 可为空 | 提现/还款可能提供目标账户；普通商户不得当账户 |
| `item` | `商品`、`商品说明`、`商品名称` | `relation`, `display` | 必需 | 可为空 | 无界文本，只允许受约束模式 |
| `direction` | `收/支`、`收支`、`收支类型` | `semantic` | 必需 | 必须归入已知/显式空/未知 | `/` 不能全局等于账户未知 |
| `amount` | `金额(元)`、`交易金额(元)`、`金额` | `semantic`, `control` | 必需 | 必须精确解析 | 当前固定 CNY、非负金额 |
| `paymentMethod` | `支付方式`、`付款方式` | `account`, `semantic` | 必需 | 允许 `/` 或空值 | 不同动作中可能代表流出端、外部端或不适用 |
| `status` | `当前状态`、`交易状态`、`状态` | `semantic`, `account`, `relation` | 必需 | 不得未知后自动入账 | “已存入零钱”同时提供结算和到账端证据 |
| `transactionId` | `交易单号`、`微信交易单号` | `identity`, `relation` | 必需 | 资金行原则上应存在 | 当前同来源强身份 |
| `orderId` | `订单号` | `identity`, `relation` | 可选 | 可为空 | 不得覆盖 transactionId |
| `merchantOrderId` | `商户单号`、`商家单号` | `identity`, `relation` | 可选 | 可为空 | 退款和商户关系证据 |
| `note` | `备注`、`交易备注` | `display`, 弱 `relation` | 可选 | 可为空 | 不得单独决定去重、账户或事件性质 |

### 4.1 微信交易类型盘点

以下只表示当前已知线索，不表示完整认证枚举。

| 原始值或模式 | 目标 SourceAction | 证据 | 备注 |
| --- | --- | --- | --- |
| `商户消费` | `MERCHANT_PAYMENT` | `FIXTURE`, `UI_REFERENCE` | 必须结合方向、状态和金额 |
| `二维码收付款` | `QR_PAYMENT_OR_RECEIPT` | `UI_REFERENCE` | 最终收入/支出取决于方向 |
| `转账` 或受约束转账变体 | `TRANSFER` | `CODE`, `UI_REFERENCE`, `REAL_REDACTED` | 收取与付出分别判断 |
| `红包` 或受约束红包变体 | `RED_PACKET` | `CODE`, `UI_REFERENCE` | 收取、发出、退回需分别盘点 |
| `群收款` 或受约束变体 | `GROUP_COLLECTION` | `CODE`, `UI_REFERENCE` | 方向决定付款或收款 |
| `信用卡还款` | `CREDIT_CARD_REPAYMENT` | `CODE`, `UI_REFERENCE`, `REAL_REDACTED` | 来源方向可能为 `/` |
| `零钱充值`、`余额充值` | `WALLET_TOP_UP` | `CODE` | 需核对真实导出精确值 |
| `零钱提现`、`余额提现` | `WALLET_WITHDRAWAL` | `CODE`, `REAL_REDACTED` | 需结合支付方式/交易对方确定外部账户 |
| `<交易类型>-退款` 或明确退款类型 | `REFUND_CREDIT` | `CODE`, `REAL_REDACTED` | 不能与原消费退款状态混为一行 |
| `零钱通`、`理财通` 相关受约束动作 | `WEALTH_MOVEMENT` | `CODE` | 当前产品语义尚不完整，不能宽泛自动入账 |
| 其他 | `UNKNOWN_ACTION` | 目标规则 | 禁止方向兜底覆盖 |

### 4.2 微信状态 token 盘点

状态的最终含义必须结合交易类型、方向和金额；下表不是全局一对一映射。

| 原始值或模式 | 候选状态 claim | 证据 | 风险 |
| --- | --- | --- | --- |
| `支付成功` | `SETTLED` 候选 | `FIXTURE`, `REAL_REDACTED` | 仅对已认证资金动作 |
| `交易成功`、`交易完成`、`已完成` | `SETTLED` 候选 | `CODE` | 需真实枚举盘点，不得全文“成功”兜底 |
| `收款成功`、`已收钱`、`已领取` | `RECEIPT_SETTLED` 候选 | `CODE` | 与收款类动作联合判断 |
| `已转账` | `TRANSFER_SETTLED` 候选 | `CODE` | 与转出方向联合判断 |
| `已存入零钱` | `SETTLED_TO_WECHAT_BALANCE` | `REAL_REDACTED`, `CODE` | 可在严格转账收入规则中推导微信零钱 |
| `已到账`、`提现已到账` | `SETTLED_TO_EXTERNAL_ACCOUNT` 候选 | `CODE`, `REAL_REDACTED` | 必须结合提现动作和外部账户证据 |
| `还款成功` | `REPAYMENT_SETTLED` 候选 | `CODE` | 不等于普通支出 |
| `等待确认收货` | `PAYMENT_PENDING_CONFIRMATION` 候选 | `CODE` | 是否计作已发生支出需 profile 产品口径确认 |
| 包含明确退款金额的 `已退款...` | `ORIGINAL_REFUND_STATUS` 或 `REFUND_SETTLED` 候选 | `REAL_REDACTED`, `CODE` | 由交易类型和方向区分原消费与退款到账行 |
| `退款成功`、`退款完成` | `REFUND_SETTLED` 候选 | `CODE` | 必须存在退款动作证据 |
| `失败`、`未支付`、`未收款` 的精确枚举 | `FAILED` 候选 | `CODE` | 当前代码使用 contains，需收敛精确域 |
| `关闭`、`撤销`、`取消` 的精确枚举 | `CLOSED` 候选 | `CODE` | 当前代码使用 contains，需收敛精确域 |
| 其他 | `UNKNOWN_STATUS` | 目标规则 | 不能因包含“成功/完成”通过 |

### 4.3 微信支付方式类别

| 原始值或模式 | 账户引用类别 | 证据 |
| --- | --- | --- |
| `零钱`、`余额` | `WECHAT_BALANCE_REFERENCE` | `CODE`, `FIXTURE`, `REAL_REDACTED` |
| `零钱通...` | `WECHAT_WEALTH_REFERENCE` | `CODE` |
| `亲属卡...` | `WECHAT_RELATIVE_CARD_REFERENCE` | `CODE` |
| `<银行主体><储蓄卡/借记卡>(<稳定尾号>)` | `BANK_ASSET_REFERENCE` | `CODE`, `REAL_REDACTED` |
| `<银行主体><信用卡/贷记卡>(<稳定尾号>)` | `BANK_CREDIT_REFERENCE` | `CODE`, `REAL_REDACTED` |
| 银行/银行卡/信用卡泛称且无稳定定位 | `GENERIC_REFERENCE` | `CODE` |
| `/` | `EXPLICIT_SLASH` | `REAL_REDACTED` |
| 空值 | `EXPLICIT_BLANK` | `CODE` |
| 其他稳定产品引用 | `UNCLASSIFIED_EXPLICIT_REFERENCE` | 目标规则 |

### 4.4 微信首轮必须覆盖的联合规则族

| 规则族 | 至少读取字段 | 输出 |
| --- | --- | --- |
| 普通商户支出 | 类型、方向、状态、金额、支付方式 | 资金效果、支出动作、流出账户 |
| 二维码付款/收款 | 类型、方向、状态、金额、支付方式 | 付款或收款动作及相应账户端 |
| 转账付出 | 类型、方向、状态、金额、支付方式 | 转账付出 claim、流出端 |
| 转账收入到零钱 | 类型、方向、状态、金额、支付方式 | 转账收取 claim、派生微信零钱到账端 |
| 红包发出/领取/退回 | 类型、方向、状态、金额、支付方式 | 对应动作，退回不得当收入 |
| 群收款付款/收取 | 类型、方向、状态、金额、支付方式 | 对应动作和账户端 |
| 零钱充值/提现 | 类型、方向、状态、金额、支付方式、交易对方 | 双端资金移动 |
| 信用卡还款 | 类型、方向、状态、金额、支付方式、交易对方、商品 | 资产流出端、负债目标端 |
| 原消费退款状态 | 原消费类型、支出方向、退款状态、金额、订单标识 | 原消费状态 claim，不重复产生退款资金 |
| 独立退款到账 | 退款类型、收入/中性方向、退款状态、金额、订单标识 | 退款资金 claim 和关系候选 |
| 失败/关闭 | 类型、方向、状态、金额 | 无本次资金 effect 或明确终止状态 |

## 5. 支付宝 App CSV 字段

| 规范字段 | 当前别名 | 职责 | 表头要求 | 行值要求 | 当前处理风险 |
| --- | --- | --- | --- | --- | --- |
| `transactionTime` | `交易时间` | `semantic`, `identity` | 必需 | 必须可解析 | 当前支持固定本地时间格式 |
| `transactionType` | `交易分类`、`交易类型` | `semantic` | 必需 | 不得未知后方向兜底 | “交易分类”可能是消费分类，不总是动作类型 |
| `counterparty` | `交易对方` | `relation`, `display`, 条件性 `account` | 必需 | 可为空 | 提现/还款等动作中可能表达账户目标 |
| `item` | `商品说明`、`商品名称` | `semantic`, `relation`, `display` | 必需 | 可为空 | 只有指定类型允许读取动作前缀 |
| `direction` | `收/支` | `semantic` | 必需 | 必须归一或未知 | 中性动作需联合判断 |
| `amount` | `金额` | `semantic`, `control` | 必需 | 必须精确解析 | 当前固定 CNY、非负金额 |
| `paymentMethod` | `收/付款方式`、`付款方式`、`资金渠道` | `account`, `semantic` | 必需 | 允许空值 | 组合支付当前只取 `&` 前主要工具，其他成分仍须保留 Evidence |
| `status` | `交易状态` | `semantic`, `relation` | 必需 | 不得未知后自动入账 | “解冻成功”证明不能全局匹配“成功” |
| `transactionId` | `交易订单号`、`支付宝交易号`、`交易号` | `identity`, `relation` | 必需 | 资金行原则上应存在 | 别名同时出现时须检查冲突 |
| `orderId` | `订单号` | `identity`, `relation` | 可选 | 可为空 | 不得覆盖来源交易号 |
| `merchantOrderId` | `商家订单号`、`商户订单号` | `identity`, `relation` | 可选 | 可为空 | 退款关系证据 |
| `note` | `备注` | `display`, 弱 `relation` | 可选 | 可为空 | 不得单独决定经济性质 |

## 6. 支付宝 Web CSV 字段

| 规范字段 | 当前别名 | 职责 | 表头要求 | 行值要求 | 与 App 差异 |
| --- | --- | --- | --- | --- | --- |
| `transactionTime` | `交易创建时间` | `semantic`, `identity` | 必需 | 必须可解析 | 表头不同 |
| `transactionType` | `类型`、`交易类型` | `semantic` | 必需 | 不得未知后方向兜底 | 可能比 App 分类更偏动作语义，待私有盘点 |
| `counterparty` | `交易对方` | `relation`, `display`, 条件性 `account` | 必需 | 可为空 | 共享目标职责 |
| `item` | `商品名称`、`商品说明` | `semantic`, `relation`, `display` | 必需 | 可为空 | 表头顺序和命名不同 |
| `direction` | `收/支` | `semantic` | 必需 | 必须归一或未知 | 共享方向语义 |
| `amount` | `金额(元)`、`金额` | `semantic`, `control` | 必需 | 必须精确解析 | 可能带单位表头 |
| `paymentMethod` | `收/付款方式`、`付款方式`、`资金渠道` | `account`, `semantic` | 必需 | 允许空值 | 共享账户引用规则 |
| `status` | `交易状态` | `semantic`, `relation` | 必需 | 不得未知后自动入账 | 原始枚举需分别盘点 |
| `transactionId` | `交易号`、`支付宝交易号`、`交易订单号` | `identity`, `relation` | 必需 | 资金行原则上应存在 | 主别名顺序不同 |
| `orderId` | `订单号` | `identity`, `relation` | 可选 | 可为空 | 共享 |
| `merchantOrderId` | `商户订单号`、`商家订单号` | `identity`, `relation` | 可选 | 可为空 | 主别名顺序不同 |
| `note` | `备注` | `display`, 弱 `relation` | 可选 | 可为空 | 共享 |

## 7. 支付宝交易动作盘点

以下 App/Web 可共享候选概念，但原始 token 域必须分别盘点。

| 原始值或受约束模式 | 目标 SourceAction | 至少联合字段 | 证据/状态 |
| --- | --- | --- | --- |
| 普通消费分类或付款类动作 | `PAYMENT` | 类型、方向、状态、金额 | `CODE`, `FIXTURE`；当前方向兜底过宽 |
| 明确收入/收款类动作 | `RECEIPT` | 类型、方向、状态、金额 | `CODE`；需枚举盘点 |
| 明确退款类型或退款到账行 | `REFUND_CREDIT` | 类型、方向、状态、金额、订单标识 | `CODE`；需与原消费退款状态拆分 |
| `账户存取` + 商品说明 `提现-...` 或明确提现类型 | `WITHDRAWAL` | 类型、商品、方向、状态、支付方式、交易对方 | `CODE`, `FIXTURE` |
| `账户存取` + 商品说明 `充值-...` 或明确充值类型 | `TOP_UP` | 同上 | `CODE`, `FIXTURE` |
| 余额宝受约束转入/买入 | `SAVINGS_IN` | 类型、商品、方向、状态、支付方式 | `CODE` |
| 余额宝受约束转出/提现 | `SAVINGS_OUT` | 同上 | `CODE` |
| 余额宝收益发放/结转/利息 | `YIELD_RECEIPT` | 类型、商品、方向、状态、支付方式 | `CODE`, `FIXTURE` |
| `信用借还` + 还款语义 | `REPAYMENT` | 类型、商品、方向、状态、金额、支付方式、交易对方 | `CODE` |
| `信用借还` + 借款/借入语义 | `BORROW` | 同上 | `CODE` |
| 转账类动作 | `TRANSFER` | 类型、方向、状态、金额、账户端和关系 | `CODE`；最终性质不可过早固定 |
| 手续费/服务费明确类型 | `FEE` | 类型、方向、状态、金额 | `CODE` |
| 零金额、中性、`信用借还`、`芝麻免押下单成功` | `NON_FINANCIAL_LIFECYCLE` | 类型、方向、状态、金额 | `REAL_REDACTED`, V1 测试 |
| 零金额、中性、`信用借还`、`解冻成功` | `NON_FINANCIAL_LIFECYCLE` | 同上 | `REAL_REDACTED`, V1 测试 |
| 其他 | `UNKNOWN_ACTION` | 完整行 | 禁止由收入/支出方向兜底成 payment |

## 8. 支付宝账户引用类别

| 原始值或模式 | 账户引用类别 | 证据 |
| --- | --- | --- |
| `余额`、`账户余额` | `ALIPAY_BALANCE_REFERENCE` | `CODE`, `FIXTURE` |
| `余额宝...` | `ALIPAY_SAVINGS_REFERENCE` | `CODE` |
| `花呗` | `ALIPAY_HUABEI_REFERENCE` | `CODE` |
| `信用购...` | `ALIPAY_CREDIT_PURCHASE_REFERENCE` | `CODE` |
| `花呗｜信用购` 聚合表达 | `ALIPAY_AGGREGATE_CREDIT_REFERENCE` | `CODE`；不得创建虚构正式账户 |
| `借呗...`、`网商贷...` | `ALIPAY_CREDIT_REFERENCE` | `CODE` |
| `小荷包(<名称>)` | `ALIPAY_POCKET_REFERENCE_CANDIDATE` | `CODE`, `REAL_REDACTED`；同名不自动证明同一现实账户 |
| `<银行主体><储蓄卡/借记卡>(<稳定尾号>)` | `BANK_ASSET_REFERENCE` | `CODE` |
| `<银行主体><信用卡/贷记卡>(<稳定尾号>)` | `BANK_CREDIT_REFERENCE` | `CODE` |
| 银行或信用卡泛称且无稳定定位 | `GENERIC_REFERENCE` | `CODE` |
| `主支付工具 & 优惠/组合成分` | `PRIMARY_REFERENCE + SUPPORTING_COMPONENTS` | `CODE`；当前主引用只取 `&` 前部分，全部原文保留 |
| `/` | `EXPLICIT_SLASH` | 待私有盘点 |
| 空值 | `EXPLICIT_BLANK` | `CODE` |

## 9. 支付宝首轮必须覆盖的联合规则族

| 规则族 | 至少读取字段 | 输出 |
| --- | --- | --- |
| 普通支出/收入 | 类型、方向、状态、金额、支付方式 | 资金效果、付款/收款动作、单账户端 |
| 原消费退款状态 | 原消费类型、支出方向、退款状态、金额、订单标识 | 原消费状态 claim |
| 独立退款到账 | 退款类型、收入/中性方向、退款状态、金额、订单标识 | 退款资金 claim 与关系候选 |
| 账户余额充值/提现 | 类型、商品、方向、状态、支付方式、交易对方 | 双端资金移动 |
| 余额宝转入/转出 | 类型、商品、方向、状态、支付方式、交易对方 | 账户余额/银行卡与余额宝双端 |
| 余额宝收益 | 类型、商品、方向、状态、金额 | 收益收入，不能作为内部转账 |
| 花呗/信用购/借呗还款 | 类型、商品、方向、状态、金额、支付方式、交易对方 | 付款资产端、负债目标端；聚合时分配 |
| 借款到账 | 类型、商品、方向、状态、金额、资金端 | 负债增加与资产到账候选 |
| 手续费/服务费 | 类型、方向、状态、金额、支付方式 | 费用支出 |
| 外部/本人转账候选 | 类型、方向、状态、金额、账户与关系 | 来源动作，最终 EconomicNature 后置 |
| 零金额免押/解冻 | 类型、方向、状态、金额 | 非资金生命周期，不进入账户问题 |
| 失败/关闭/取消 | 类型、方向、状态、金额 | 终止状态，无本次资金 effect |

## 10. 当前实现与目标字典的差距

| 当前模块 | 当前行为 | 目标变化 |
| --- | --- | --- |
| `parsers/platform.js` | 保存全部 `rawFields`，但模板选择使用 marker、少量唯一表头和分数 | 建立精确 profile 字段清单、未知/重复列诊断和字段职责 |
| `parsers/normalize.js` | 状态通过全局 contains 归一，金额固定非负 CNY，方向未知只产生 warning | 只形成来源观测；具体 profile 联合判断状态、金额和方向 |
| `source-action.js` | 主要按交易类型，部分读取商品和方向 | 接收完整行，在分阶段决策表中输出 SourceAction/MoneyEffect claims |
| `source-funds.js` | 动作识别后再用支付方式、交易对方和少量状态补账户端 | 账户端点成为显式规则阶段，保存 reads、ruleId 和冲突 |
| `payment-account.js` | 规范显示名、引用键、账户身份和类型候选 | 保留解析能力；稳定 ReferenceConcept 不能仅由显示字符串产生 |
| `organizer-planner.js` | 仍会触碰来源引用和部分来源推导 | 只消费 SemanticClaims，不读取来源专属原始字符串 |

## 11. 私有枚举盘点输出格式

真实账单诊断只允许输出以下脱敏结构：

```json
{
  "profileCandidate": "wechat_xlsx",
  "headers": [
    { "canonicalField": "transactionType", "present": true, "unknownAlias": false }
  ],
  "tokenInventory": {
    "transactionType": [
      { "tokenCode": "known:merchant_payment", "count": 120 },
      { "tokenCode": "unknown:fingerprint", "count": 2 }
    ]
  },
  "semanticSignatures": [
    {
      "signature": "known-profile|transfer|source-inflow|settled-to-wallet|explicit-slash|positive",
      "count": 3,
      "ruleIds": ["wechat.transfer.inflow-to-balance.v1"],
      "status": "resolved"
    }
  ],
  "coverage": {
    "sourceRows": 183,
    "disposedRows": 183,
    "resolvedFinancialRows": 180,
    "unknownRows": 3,
    "conflictRows": 0
  }
}
```

不得输出 token 原文、商户、商品、备注、账号、卡尾号、交易号、精确金额或精确时间。维护者需要理解未知 token 时，必须由用户主动生成可预览、可撤回的最小脱敏诊断材料，不能从普通日志还原。

### 11.1 覆盖结论

覆盖报告只需要给出：

- profile 与规则版本；
- 原始行数以及资金、非资金、重复、待确认、用户排除和无效行数；
- 未知列、未知 token、冲突规则和关键待确认行数；
- 可入账事件中缺失账户、关系或核心字段的数量；
- 是否满足“整份账单已完整识别”。

已识别后被用户排除的记录仍算语义已识别，但不算已经入账；未知记录被排除后仍然是未知，不能提高整账完整度。

## 12. 待私有盘点清单

- 微信 CSV 与 XLSX 的真实交易类型完整集合，以及两种容器是否完全一致；
- 微信各交易类型下的状态集合、方向集合和支付方式空值形式；
- 微信原消费退款状态与独立退款到账行的订单字段关系；
- 微信红包退回、转账退回、群收款退款等边缘状态；
- 支付宝 App/Web 各自的交易分类/类型集合及交集；
- 支付宝 App/Web 的状态集合，以及原消费退款与独立退款行的区别；
- 支付宝余额、余额宝、小荷包、花呗、信用购、借呗和银行卡的原始引用模式；
- 支付宝信用借还中还款、借款、免押、解冻、费用和失败状态的组合；
- 四个 profile 的文件声明行数、收入/支出汇总、账期和来源账户信息能否形成控制字段；
- 当前真实文件中所有未使用列、重复列、尾部附加列和空列模式。
