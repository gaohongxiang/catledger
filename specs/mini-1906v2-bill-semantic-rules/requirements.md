# MINI-1906V2 账单字段与语义规则体系需求

> 状态：需求修订候选，等待复审与用户确认；尚未进入设计或实现。
>
> 基线：MINI-1906V1 本地修复候选 `3e83a9e2f872efdc5c7b1199f35314a60f69c430`
>
> 目标：先解决“账单怎样被完整、正确识别”，并将“认证整账导入”和“用户辅助导入”分成两个诚实的产品承诺；不以发布降级机制代替来源语义覆盖。

## 1. 问题定义

当前支付宝、微信账单已经能够解析并进入 `Evidence → EconomicEvent → FinanceUpdate → ReviewIssue → Transaction / Account` 主链路，但来源语义仍由多个局部函数分别判断：状态归一、交易动作、账户引用、资金端点和 planner 各自只读取部分字段。真实账单因此暴露出以下结构性问题：

- 状态中的“成功”可能属于资金结算，也可能属于零金额免押/解冻等非资金生命周期；
- 支付方式为 `/` 只说明来源明确留空，不能单独推出账户未知；交易状态可能已经说明到账零钱；
- 同一原始“转账收入”可能是普通收入、本人转账、借款到账、退款到账或提现到账，最终经济性质需要关系和账户证据；
- 历史账户决定如果绑定某一版规范字符串，规范化规则变化后可能失联；
- 测试覆盖已知样本，尚不能回答一份新账单中是否存在未识别列、未登记枚举、未覆盖字段组合或无归宿行。

本阶段要建立一套来源语义规则体系，使每份当前上传文件的全部字段、全部记录和全部可达语义组合都能被自动盘点；系统只把完整、唯一的语义结论交给 EconomicEvent，不能用宽泛兜底把未知伪装成已识别。

ezBookkeeping 的实现证明了“每种来源使用独立 adapter、统一转换成交易表、再由用户批量映射账户和分类”是一条实用路径，但它通过跳过未知状态/类型/转账表达来缩小问题，并不证明整份账单已完整识别。本阶段吸收它的 adapter、自定义列映射、映射文件复用和导入前批量校正能力，同时保留本项目不可静默丢行、不可绕过来源身份、不可直接污染正式账户与交易的边界。

## 2. 产品结果

1. 用户上传已支持的支付宝或微信账单后，系统应基于整行字段组合正确识别资金效果、来源动作、账户端点和关系，而不是依赖单个字段或泛关键词。
2. 用户不需要人工逐行检查。系统应把数百行压缩为有限的语义签名，并只呈现真正未覆盖或冲突的组合。
3. 用户进入最终确认前，应能看到本文件的记录总数、各类归宿、未知组合数和规则冲突数；不存在悄悄消失的行。
4. 同一组合可批量处理，但一次用户决定不得自动提升为其他用户的全局来源规则。
5. 系统应清楚区分“认证整账导入”和“用户辅助导入”：前者承诺整份账单覆盖与控制核对，后者只承诺用户明确选择且通过完整性门禁的交易，不得显示成整账已覆盖。
6. 后续新增银行时，优先通过可复用映射模板接入字段结构，再逐步补齐来源 adapter、字段字典、原始枚举映射、产品语义规则和控制公式，不在通用 planner 中继续堆机构字符串。
7. 同一份不可变 Evidence 在相同 profile、规则、用户决定和账户映射状态下应可重放出相同的规范结果；重新分析只产生新运行，不原地改写旧运行。
8. 新语义引擎正式接管某个 profile 前，应以稳定键逐条比较新旧事件、关系和账户影响，任何未受审财务差异都阻止切换。

## 3. 术语

### 3.1 DecodedDocument 与 ProfileAssessment

`DecodedDocument` 是 CSV/XLSX 的确定性容器解码结果，保留工作表、表格区域、单元格位置、公式/隐藏状态和结构诊断，不解释收入、退款或账户。`ProfileAssessment` 记录 profile 的唯一匹配、结构冲突、模板漂移和能力状态；相似度或用户手选来源不能覆盖结构冲突。

这两个名称描述逻辑边界，不要求首期各自建立数据库实体；原始内容仍只保存在 Evidence 或受控原始快照中。

### 3.2 FieldObservation

对来源单元格的不可变观测，至少包含原始快照引用、位置、规范列键、解析值、观测状态、所属 profile 和解析器版本。它只陈述来源写了什么，不表达账本结论，也不重复复制已经保存在 Evidence 中的敏感原文。

### 3.3 SourceToken

在具体模板上下文中，对原始枚举的有限归一结果。`/`、空字符串、字段缺失、解析失败和未知枚举必须分别表达。

### 3.4 SemanticClaim 与 SemanticResolution

`SemanticClaim` 是某个阶段对一个输出槽位作出的候选结论，至少包含 `value`、`authorityClass`、`ruleId`、`reads`、Evidence 引用、规则版本和状态。多个规则可以对同一槽位产生 claim。

唯一确定性的 `SemanticResolver` 负责形成 `SemanticResolution`：同一权威等级的同值 claim 合并 provenance，不同值形成冲突；跨权威等级只按明确类型顺序处理，不使用隐藏数字优先级、注册顺序或最后写入。`SemanticResolution` 至少区分 `resolved`、`needs_user`、`unsupported`、`conflict` 和 `invalid`。

### 3.5 SemanticSignature

由模板、规范交易族、原始方向状态、状态语义、金额类别、支付方式类别和身份字段存在性组成的有限组合键。商户、商品和备注等无界文本不直接进入完整笛卡尔积，只能通过已命名、受约束的模式产生附加证据。

### 3.6 RowRole、SelectionDisposition 与 GateStatus

每条来源记录必须分别表达三个互不替代的状态：

- `RowRole`：`money_primary`、`non_financial`、`supporting`、`duplicate` 或 `undetermined`；
- `SelectionDisposition`：`selected`、`user_excluded` 或 `not_selected`；
- `GateStatus`：`ready`、`blocked`、`quarantined` 或 `invalid`。

用户排除只改变本次选择，不能把 `unsupported`、`conflict` 或 `needs_user` 提升为 `resolved`。已解决语义的记录可以被用户排除且不破坏语义覆盖，但不得被描述为已经入账。

### 3.7 SemanticCoverageReport 与范围声明

对单个文件或批次的字段、枚举、签名、记录角色、语义解决、用户选择、门禁和资金影响覆盖结果。`UNKNOWN` 可以算已处置，但不能算语义识别成功。

报告必须分别声明：

- `InterpretationScope = full_statement | selected_subset`：系统解释了整份账单还是只承诺选中子集；
- `PostingScope = all_postable | selected_events`：本次准备提交全部可入账事件还是用户选择的事件。

“整账语义完整”和“全部记录均已入账”是两种不同承诺。

### 3.8 ProfileManifest

一个具体来源模板版本的可审核契约，至少声明容器类型、文件前导标记、工作表约束、表头集合、必需/可选/允许扩展列、字段职责、金额/日期/币种约定、有限 token 域、控制字段和 adapter 版本。它用于证明“这是哪个模板”，不能只用相似度分数猜测。

### 3.9 ImportLane 与 adapter 认证生命周期

用户运行时只有两条通道：

- `CERTIFIED_STATEMENT`：内置且已认证的整账 adapter，允许声明整份账单覆盖完整；
- `GUIDED_MAPPING`：用户为 CSV/XLSX 建立可复用的声明式映射，只允许导入逐笔事实已经完整确认的选中记录；

维护者 adapter 不是运行时通道，而是 `draft → tested → shadow → certified` 的离线认证生命周期。两个运行时通道最终都必须输出同一种 FieldObservation、SemanticClaim、SemanticResolution、覆盖报告和 LedgerImpact，并经过同一 EconomicEvent 与 posting 门禁。

### 3.10 UserMappingProfile

用户范围、可版本化、可导入导出的声明式映射，至少包含模板指纹、列映射、日期/金额/币种/方向约定、原始交易类型映射和可选默认账户引用。它不是全局平台规则，不能执行任意代码，也不能绕过未知行和关系门禁。

### 3.11 InterpretationRun 与 DecisionSnapshot

`InterpretationRun` 表示对一组不可变 Evidence 执行的一次完整解释。它冻结用户范围、Evidence 集、容器/profile/adapter/规则/引擎版本、用户决定快照、参与推导的账户身份/映射/分类别名状态摘要、规范结果摘要和父运行引用。重新解析、规则升级或决定变化必须产生新 Run，不得原地覆盖旧 Run。

`DecisionSnapshot` 是当前 Run 实际采用的追加式人工决定集合。首期应优先复用现有 FinanceAction 审计事实，不预先决定新增一套重复的用户决定表。

### 3.12 LedgerImpact 与控制结果

`LedgerImpact` 是候选事件在现有 Account 余额语义下的纯领域影响向量，用于预览、守恒校验、黄金差分和原子 posting 输入；它不是新账本表，也不改变 Transaction 的正式权威。控制结果至少区分 `pass`、`fail`、`not_provided`、`not_applicable`、`uncomputable` 和 `partial_coverage`。

## 4. 总体规则顺序

来源语义必须按以下阶段形成，不允许一个巨型规则直接从原始行生成正式交易：

```text
Immutable Evidence
  → DecodedDocument / ProfileAssessment
  → 选择 ImportLane
  → 完整 FieldObservation
  → SourceToken
  → SourceActionClaim
  → SettlementClaim / MoneyEffectClaim
  → AccountEndpointClaim
  → RelationClaim
  → EconomicNatureClaim
  → SemanticResolver
  → EventAssemblyResult
  → Coverage / Control / LedgerImpact Gate
  → ReviewPlan
  → 冻结 InterpretationRun
  → FinanceUpdate
```

`SourceActionClaim` 表达来源声称的动作，不能过早等同于最终 `EconomicNature`。例如来源“转账收入”先形成 `TRANSFER_RECEIPT`，待账户身份和跨来源关系确定后，才能成为收入、本人转账、借款或退款。

## 5. 验收需求

### R1. 全字段观测

- 当系统解码一个候选文件时，应先恢复工作表、候选表格区域、每个表头、每个数据单元格及其来源位置，不得只投影已知列；
- 原始值应只保存在 Evidence 或受控原始快照中；FieldObservation 应通过稳定位置和摘要引用原值，不得为“全字段观测”重复保存敏感内容；
- 对模板中的每个字段，系统应将其职责声明为 `semantic`、`account`、`identity`、`relation`、`control`、`display` 或 `certified_ignored`；
- 当出现未登记列时，系统应将其记录为 `unknown_field`，不得无声忽略；只有模板明确允许的扩展位置和已证明不参与财务语义的列才可继续处理；
- 当两个别名列同时出现且值相互冲突时，系统应形成结构冲突，不得选择第一个或最后一个覆盖；
- 当必需表头缺失、重复表头进入数据区、XLSX 公式参与关键字段或工作表选择不明确时，系统应阻止语义完成。

### R2. 原始枚举词典

- 每个具体 profile 应分别登记交易类型、收支值、交易状态、支付方式类别及其他有限枚举的原始 token；
- 原始 token 应归入明确规范概念、显式空值、当前不适用或未知枚举，不得使用宽泛“其他”吸收未见值；
- `/`、空字符串、字段缺失和解析失败应是四种不同观测；
- 状态 token 不得脱离来源 profile、交易动作、方向和金额直接升级为结算结论；特别是不得以“包含成功”作为全局正常资金状态兜底；
- 新文件实际 token 集合与已登记 token 集合的差异应进入覆盖报告。

### R3. 金额与方向观测

- 支付宝、微信当前 profile 可声明人民币和“非负金额 + 独立收支字段”的来源约定，但该约定不得成为未来银行 profile 的全局规则；
- 金额观测至少区分 `positive`、`zero`、`negative`、`invalid`，不得由零金额单独推出非资金事件；
- 来源方向至少区分收入、支出、中性、显式空值、缺失和未知；来源方向只是 claim 输入，不自动等同于最终账户影响；
- 后续银行 profile 应能分别表达有符号金额、借贷双列、本外币金额和逐行余额，不修改支付宝/微信规则。

### R4. 来源动作与资金效果联合判断

- 当系统判断一行是否发生资金变化时，应同时读取 profile、交易类型、方向、状态和金额类别；
- 当系统判断来源动作时，应使用完整 FieldObservation，并按来源 profile 的决策表输出消费、转账收取、转账付出、退款到账、原交易退款状态、还款、借款、充值、提现、收益、费用、非资金生命周期或未知；
- 原消费行的“部分退款/全部退款”状态应形成原消费状态 claim，不得使原消费本身变成退款到账；
- 独立退款资金行应形成退款到账 claim，并通过关系阶段寻找原消费；
- 支付宝零金额、中性方向、`信用借还` 和精确免押/解冻状态的严格合取可以形成非资金 claim；任一必要条件失效时不得继续排除；
- 失败、关闭、取消、处理中和其他状态必须由具体 profile 的明确状态域解释；未知状态不得因包含“完成”或“成功”等子串自动通过。

### R5. 账户端点联合判断

- 系统应在来源动作和资金效果确定后，结合方向、支付方式、状态、交易对方和商品说明推导资金端点；
- 普通支出和收入可以使用已识别支付方式作为相应账户端，但支付方式仅为来源引用，不直接创建正式 Account；
- 当微信记录属于转账收取、方向为收入、支付方式为空或 `/`、状态精确说明已存入零钱且金额为正时，系统应形成派生微信零钱到账端 claim；每个必要条件变化都不得继续命中；
- 对提现、充值、余额宝转入转出和信用卡还款，系统应按动作语义分别确定 source 与 destination，不能让“支付方式”在所有动作中固定代表同一端；
- 泛称银行卡、信用卡或缺少稳定定位的账户引用不得自动映射到现实账户；
- 账户显示文本和规范字符串不得自动成为永久 ReferenceConcept。只有来源稳定标识、银行主体与稳定定位、用户明确绑定或已证明等价的规范变体才能建立稳定概念。

### R6. 关系和最终经济性质

- 系统应在来源动作之后，使用来源交易号、订单号、商户订单号、账户端点、金额和时间建立退款、相同事件、本人转账、还款分配和重复 claim；
- 稳定官方标识和已认证强关系可自动关联；金额、时间、商户、商品和备注等弱证据只能形成候选，不得自动合并；
- 同额、同日、同商户的两笔独立交易必须能够保持独立；
- 最终 EconomicNature 应结合 SourceAction、Settlement、AccountEndpoint 和 RelationClaims 产生，不得仅由来源的“收入/支出/转账”文字决定；
- 退款、本人转账、借款到账和提现到账不得降级为普通收入或支出以绕过关系问题。

### R7. 分阶段规则与冲突

- 每条规则应显式声明 `id`、`profile`、`stage`、`reads`、`when`、`emits` 和版本；
- 规则只能产生 SemanticClaim，不得直接写入最终 SemanticResolution、EconomicEvent、Account 或 Transaction；
- 多条规则可以对同一行、同一 `stage + outputField` 产生 claim；每个槽位只能由唯一确定性的 SemanticResolver 形成最终 resolution；
- 同一权威等级的同值 claim 应合并 provenance、reads 和 rule refs；不同值必须形成 `rule_conflict`；
- 权威等级只允许使用显式类型顺序：当前事件人工决定、当前批次决定、用户精确 ReferenceConcept 绑定、用户 AccountIdentity 绑定、经审核的等价 alias、认证确定性规则、启发式候选；同一等级不同结果必须冲突；
- 没有规则为必需槽位提供结论时，应形成 `rule_gap`；Resolver 按明确权威等级处理后仍存在同级不同结论时，应形成 `rule_conflict`；
- 不允许依赖数字优先级、代码顺序、对象插入顺序或“最后一个覆盖前一个”解决同级冲突；
- 如果新规则替代旧规则，应显式声明版本化、无环的替代关系，并由覆盖检查证明影响范围；规则依赖必须形成可静态检查的无环图；
- planner 只消费规范 claim，不得包含来源专属原始字符串判断。

### R8. 单文件五类覆盖

- 字段处置覆盖必须为 100%：每列属于已映射、认证忽略或未知；
- 枚举处置覆盖必须为 100%：每个实际有限 token 属于规范概念、显式空值、不适用或未知；
- 可达组合处置覆盖必须为 100%：每个实际 SemanticSignature 获得确定结论、需要确认、明确不支持或冲突终态；
- 行角色覆盖必须为 100%：每条数据记录恰好属于一种 RowRole，同时分别具有 SemanticResolution、SelectionDisposition 和 GateStatus；
- 对准备入账的资金事件，关键语义解决覆盖和完整 LedgerImpact 覆盖必须为 100%，未知关键行和规则冲突必须为 0；
- `unknown`、`quarantined` 和 `invalid` 可以计入处置覆盖，不得计入语义识别成功率；用户排除不得提高语义解决率；
- CoverageReport 应按语义签名聚合数量和金额影响，使用户或维护者只需检查未覆盖组合而不是逐行扫描。
- 报告必须分别输出 `InterpretationScope` 和 `PostingScope`；只有全部来源区域已观察、疑似资金行关键语义全部 resolved、非资金行具有认证依据、关键未知与冲突为 0、强关系闭合、LedgerImpact 守恒且适用控制通过时，才能声明 `full_statement`；
- `selected_subset` 只能承诺明确选中的事件已解决关键语义并通过财务门禁，必须持续展示原始、选中、未选、排除、未知和隔离数量，不得显示“整份账单已完整识别”。

### R9. 文件与整批复核

- 输入数据行数应严格等于各 RowRole 的互斥数量之和；无法确定角色或结构无效的记录使用 `undetermined`，并由 SemanticResolution 与 GateStatus 说明原因；选择状态和门禁状态应分别对同一批行守恒，不能与 RowRole 混加；
- 系统应核对重复来源身份、退款关系、本人转账双端、还款端点和聚合还款金额守恒；
- 当来源提供记录数、总收入、总支出、期初、期末或逐行余额时，应按 profile 声明的作用域、币种、公式版本和硬/软等级核对，并记录证据引用、期望值、实际值与差额；
- 没有控制总数时应标记 `not_provided`，不能显示为核对通过；不能计算或只覆盖部分记录时应分别标记 `uncomputable` 或 `partial_coverage`；
- 逐行识别完成不代表整批闭合；存在未决强关系、半笔转账、半笔退款或未守恒还款时不得标记 FinanceUpdate ready。

### R9A. 事件最小完备集与 LedgerImpact

- 系统应为每一种 EconomicNature 冻结 posting 前的最小完备集和确定性 LedgerImpact 投影；
- 普通支出必须确定金额、币种、日期、支出性质和流出账户；普通收入必须确定金额、币种、日期、收入性质和流入账户；
- 本人转账必须确定金额、币种、日期以及两个不同的流出/流入账户；退款必须确定金额、币种、日期、到账账户以及原支出或明确待关联状态；
- 信用还款必须确定付款资产账户、目标负债账户、金额和日期；聚合还款必须确定付款账户、全部目标负债账户、逐项金额且合计严格守恒；
- 非资金生命周期必须由认证 profile 的严格联合规则证明没有余额影响；未知类型、未知状态或零金额本身均不足以证明非资金；
- 每个 LedgerImpact 至少表达 `accountRole`、`accountId | accountDraftId`、`deltaMinor`、`currency`、`cashFlowClass`、`reportingClass`、`relationRole` 和 provenance；
- 系统必须分别计算 `ledgerPostability` 与 `reportingCompleteness`。分类、商户标准化等非余额事实缺失可以不阻止余额正确的 posting，但必须进入数据质量报告。

### R10. 用户处理未覆盖组合

- 未覆盖组合应按 profile、规范交易族、方向、状态、支付方式类别和账户产品类型聚类；
- 同一语义签名出现多行时，应展示影响行数、合计金额和脱敏样例，一次决定可应用到明确作用域；
- 用户决定至少区分单事件、当前批次、精确来源引用和现实账户身份；默认作用域应尽可能窄；
- 用户决定应作为追加式审计事实保存，通过 DecisionSnapshot 固定到 InterpretationRun；修改决定应新增取代关系，不原地抹去旧决定；
- 用户决定不能直接提升为全局平台规则；全局规则必须经过脱敏最小复现、正负例、覆盖和冲突检查；
- 用户仍无法安全回答的组合应保持隔离，不得用“用户点了整批确认”绕过关键未知。
- 已证明等价的 ReferenceAlias 可以继承历史绑定；ReferenceConcept 拆分后不得自动传播旧绑定，合并时若原绑定不同必须产生冲突，旧 alias 与决定继续保留审计。

### R11. 规则覆盖测试

- 每条关键规则必须有正例，以及逐个破坏每个必要谓词的 near-miss 反例；
- 规则测试应覆盖零值、正值、方向变化、状态变化、支付方式变化、来源变化和身份字段缺失；
- 规则编译或覆盖检查应检测必需槽位空洞、同槽位冲突和未声明覆盖；
- 对已登记的有限规范域，应生成可达组合测试；商户、商品和备注等无界文本只测试受约束模式和反例，不做无意义笛卡尔积；
- 新旧规则应按 Evidence 稳定键输出 canonical 差分，至少比较 SemanticResolution、RowRole、事件 merge/split、EconomicNature、账户端点、金额/币种/日期精度、关系集合、ReviewIssue、控制结果、可入账性和 LedgerImpact；
- 金额、币种、资金/非资金、方向、账户端、事件 merge/split、退款/还款关系或可入账性发生变化时均属于财务差异；总笔数或总额相同不能证明无差异；
- 财务差异只有在版本化、逐项受审的 AcceptedDiffManifest 中明确批准后才可进入切换候选；该清单首期可以是仓库内受审测试制品，不要求成为运行时业务表；
- 合成输入生成器不得复用生产分类函数生成预期答案。

### R12. 兼容当前正式账本边界

- 本阶段不改变 Transaction / Account 权威边界，不新增 JournalEntry / Posting；
- 新语义层只能生成 claim、resolution、候选事件、覆盖/控制报告、LedgerImpact 和 ReviewIssue，无正式账本写权限；
- FinanceUpdate 整批原子入账、幂等、用户隔离和 Evidence 不可变继续有效；
- FinanceUpdate 必须引用一个冻结的 active InterpretationRun；posting 只能消费该 Run 已冻结的结果，不得在事务中临时套用另一版规则；
- 规则版本升级只影响新分析或经明确重建的未入账批次，不得后台重写已入账 Transaction；
- 所有 Run、决定、映射、报告和唯一约束必须包含服务端认证上下文确定的 uid；不得接受客户端传入 uid 作为权威，也不得跨用户复用账户绑定或稳定诊断指纹；
- 本需求确认前不修改 schema、公共接口、生产代码、开发云或体验版。

### R13. 私有真实账单枚举盘点

- 系统或本地诊断工具应能从用户主动选择的真实账单中提取字段名、有限枚举值和 SemanticSignature 计数；
- 诊断结果不得包含姓名、完整账户标识、商户、商品、备注、交易号、精确交易内容或原始文件；
- 真实账单观察到但尚未写入脱敏夹具的 token 应标注来源等级，不得冒充已认证规则；
- 字段字典的“待盘点”项只有在私有诊断、脱敏最小复现和规则测试完成后才能改为“已认证”。

### R14. 模板认证与能力等级

- 当文件与唯一一个 ProfileManifest 的前导标记、容器、表头和必需约束全部一致时，系统才可自动进入 `CERTIFIED_STATEMENT`；
- 当多个 profile 同时匹配、只达到相似匹配或出现未声明结构变化时，系统应要求用户选择候选或转入 `GUIDED_MAPPING`，但用户选择不得覆盖结构冲突；
- 当用户手动选择来源类型时，系统仍应验证该 profile 的结构契约，不得因用户选择而忽略缺失必需列、重复列或工作表冲突；
- 每个 profile 应显示 `certified`、`compatible`、`changed` 或 `unsupported` 能力状态，并记录 profile、adapter、token dictionary 和 rule policy 版本；profile 逻辑上应分清容器、模板结构、产品语义和控制公式，但首期可以在一个 manifest 中分区表达；
- 只有 `CERTIFIED_STATEMENT` 同时达到字段、枚举、实际签名、RowRole、关键语义、LedgerImpact 和适用控制公式门禁后，才可显示“整份账单已完整识别/已核对”；
- `GUIDED_MAPPING` 即使所有选中交易均可入账，也只能显示“已确认选中交易”，不得显示整份账单完整。

### R15. 长尾账单的声明式映射通道

- 当用户上传尚无认证 adapter 的结构化 CSV/XLSX 时，系统应允许用户把来源列映射为时间、金额、币种、来源方向、来源动作、账户引用、交易标识、关系标识、说明和控制字段；
- 系统应自动建议列角色、日期格式和金额格式，但用户未确认的建议不得成为永久规则；
- 系统应盘点交易类型、方向、状态等有限原始 token，并允许用户按 token 批量映射，不能要求逐行重复操作；
- UserMappingProfile 应支持 JSON 导入导出、版本校验和模板指纹核对；当文件指纹变化时应进入兼容性检查，不能直接套用旧映射；
- 声明式转换只允许白名单操作，包括修剪、空值分类、日期/金额解析、枚举映射、固定值和受约束的字符串提取；小程序和云函数不得执行用户提供的 JavaScript、表达式求值或动态代码；
- 若专业用户使用外部脚本预先转换文件，转换结果仍应作为新来源进入相同的观测、身份、覆盖、复核和 posting 门禁，不能直接写 Transaction；
- 缺少稳定来源交易标识的映射格式应明确提示跨文件防重能力受限，并至少保留文件摘要、物理行定位和用户确认范围。
- 首版 Guided Mapping 只允许形成普通收入、普通支出、用户明确选择两个不同账户的本人转账、认证非资金记录和本次排除；
- 首版 Guided Mapping 不得自动形成退款关系、信用卡还款、聚合还款、贷款、分期或跨来源事件合并；这些记录必须进入专用 ReviewIssue 或等待认证 adapter；
- 用户映射只能产生受限 claim、账户草稿、映射意图和 ReviewIssue，不得直接创建正式 Account、Category、Transaction 或永久全局规则。

### R16. 导入预览、批量修正与提交边界

- 当解析完成时，系统应先生成不可入账的预览，逐笔显示规则结论、来源账户引用、经济性质、关系状态和阻塞原因；
- 相同原始账户引用、分类引用、有限 token 或 SemanticSignature 应支持批量映射/排除，批量操作的匹配条件和影响行数必须可预览；
- 系统不得在解析阶段创建正式 Account、Category 或 Transaction；账户和分类只能形成草稿或映射意图，并在正式 posting 事务内按可达集合物化；
- 用户只能提交 `ready` 且明确选中的事件；未知或冲突记录必须继续隔离，或由用户执行可审计的明确排除，不能因“全选/确认导入”隐式跳过；
- 当存在未解决、冲突或无认证依据的记录时，CoverageReport 应持续显示语义整账不完整；已解决但被用户明确排除的记录不降低语义解决率，但必须使 posting 范围显示为 selected events，并持续展示来源总数、选中数、排除数、未知数和最终交易数；
- 整批 posting 应继续使用幂等键和数据库事务；请求级防重不能替代来源身份唯一约束，另一次会话重复上传同一账单仍不得重复入账。

### R17. InterpretationRun 重放与 profile 权威切换

- 当相同的 EvidenceSet、ProfileManifest、adapter、RuleBundle、语义引擎、DecisionSnapshot 和参与推导的账户身份/映射/分类别名状态摘要被重新执行时，系统应产生相同的规范 ResultDigest；生成时间、随机 UUID 和展示顺序不得进入规范摘要；
- 重新分析、规则升级或用户决定变化时，系统应创建带 parentRunId 的新 InterpretationRun，不得原地覆盖旧 Run；
- 每个 profile 的引擎状态必须独立属于 `legacy_authoritative`、`v2_shadow`、`v2_authoritative` 或 `disabled`；影子运行不得修改权威 EconomicEvent、FinanceUpdate 决定或正式账本；
- 任何未批准财务差异、关键 unknown、规则冲突、控制硬失败或不守恒 LedgerImpact 都必须阻止该 profile 切换为 `v2_authoritative`；
- 回滚只影响后续新 Run；冻结但未提交的问题 Run 可以暂停并要求重新整理，已入账 Transaction 不得因规则回滚自动重算；
- 旧引擎应至少保留一个稳定发布周期，并在对应 profile 的金标、near-miss、真实身份验收和回滚演练全部通过后才删除旧字符串路径。

### R18. 资源、安全与隐私边界

- ContainerDecoder 必须限制文件大小、工作表数、列数、单元格数、单元格长度、压缩展开量和解析耗时；达到上限时应安全终止当前文件，不得返回部分可信结果；
- 规则执行必须确定性、无网络、无文件系统写入、无当前时间和无随机数；不得执行 JavaScript、表达式求值或动态代码；
- 允许的字符串提取和模式匹配必须是白名单操作，并在设计阶段冻结长度、复杂度、每行 claim 数、每事件关系候选数和每批签名数上限；
- adapter 只能随受审代码进入 draft/tested/shadow/certified 生命周期；首期不支持用户上传 adapter 或远程动态规则包；
- 原始值不得进入普通日志或遥测；未知 token、商户、商品、备注、完整账户标识、交易号、精确金额和精确时间只能留在用户 Evidence 或经用户预览并授权、带期限的最小诊断材料中；
- 诊断摘要不得产生可跨用户关联的稳定低熵指纹；诊断材料的用途、权限、撤回和自动删除期限必须在实现前冻结。

## 6. 当前 profile 范围

首轮需求只覆盖现有四个 profile：

- 微信支付 CSV；
- 微信支付 XLSX；
- 支付宝 App CSV；
- 支付宝 Web CSV。

微信 CSV 与 XLSX 可以共享产品语义规则，但容器、工作表和定位证据必须分别记录。支付宝 App 与 Web 可以共享部分语义枚举，但模板字段和来源动作不得假定完全相同。

首轮可发布范围只包含四个认证 profile；`GUIDED_MAPPING` 只在本阶段冻结受限数据契约与安全边界，不作为支付宝/微信 V2 切换的前置交付。银行格式只有在单独建立 ProfileManifest、控制公式、脱敏夹具和正反例，并经过 `draft → tested → shadow → certified` 后，才能从辅助通道晋升为认证整账通道。

## 7. 非目标

- 需求阶段不直接实现规则引擎、字段剖析器或目录重构；
- 不承诺支付宝、微信未来所有模板已经认证；
- 不新增银行、信用卡、贷款、PDF、OCR 或多币种实现；
- 不使用运行时 LLM 决定账务语义；
- 不建立通用 ReferenceConcept 本体图谱；首期只处理等价 alias、拆分不继承和合并冲突三种必要迁移语义；
- 不实现远程动态规则下发、用户上传 adapter 或运行时第三方 adapter；
- 不在小程序、WebView 或云函数中执行用户提供的自定义 JavaScript；
- 不要求每个逻辑中间层都建立独立数据库表，也不重复保存 Evidence 已有的原始字段值；
- 不把发布灰度、熔断和遥测当作来源识别规则的替代品；
- 不部署云函数、不迁移数据库、不上传体验版。

## 8. 需求确认门禁

进入设计阶段前必须确认：

1. 是否同意完整行联合判断取代分散的单字段判断；
2. 是否同意 SourceAction 与最终 EconomicNature 分离；
3. 是否同意唯一性按 `stage + outputField` 判断，而不是整行只能命中一条规则；
4. 是否同意同一槽位允许多条 claim，并由唯一 Resolver 合并同值、拒绝同级异值；
5. 是否同意分别表达 SemanticResolution、RowRole、SelectionDisposition 和 GateStatus；
6. 是否同意分别表达 InterpretationScope 与 PostingScope，用户排除不得提高未知语义解决率；
7. 是否同意 FinanceUpdate 只消费冻结且可重放的 InterpretationRun；
8. 是否同意按事件类型冻结最小完备集和纯领域 LedgerImpact，而不新增 JournalEntry / Posting；
9. 是否同意通过 canonical golden diff 和 profile 级权威状态完成新旧切换；
10. 是否同意先为四个现有 profile 完成字段字典和私有枚举盘点，再实现正式切换；
11. 是否同意 planner 最终不再读取来源专属原始字符串；
12. 是否同意区分“认证整账导入”和“用户辅助导入”，并禁止辅助通道宣称整账完整；
13. 是否同意 Guided Mapping 首版只支持普通收入、普通支出、明确双端转账、认证非资金和本次排除；
14. 是否同意维护者 adapter 是离线认证生命周期而不是第三条用户运行通道；
15. 是否同意任何通道都必须经过同一 Evidence、来源身份、SemanticResolution、EconomicEvent、CoverageReport、LedgerImpact 和 posting 门禁；
16. 是否同意 V2 需求与总体设计冻结后先完成 A1，A1 完成前任何 profile 不得切换为 V2 权威。
