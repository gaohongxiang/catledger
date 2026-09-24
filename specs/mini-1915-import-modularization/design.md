# MINI-1915 拆分设计

方案待评审，实施未开始。文件名是建议，职责、依赖方向和验收边界优先于目录形式。

## 1. 现有结构与问题证据

```text
原生页面 → 客户端请求 / 草稿 / 分页服务 → 云函数 handler
  ├─ catledger-api：账户 / 分类 / 交易 / 贷款 / 分期 / 统计
  └─ catledger-import：文件解析 → 来源语义 → 事件与关系 → 核对 → 正式入账
两云函数各自部署 → 可信身份、MySQL 事务与约束
```

保留已经存在的分层：

- `parsers/index.js` 选择 CSV/XLS/XLSX 读取及银行映射；`profiles/index.js` 静态登记来源规则及版本。
- `row-semantic-resolver.js`、`rule-evaluator.js` 处理来源解释和冲突；`economic-event-builder.js`、`relation-resolver.js`、`organizer-planner.js` 形成事件和核对计划。
- `organizer-model.js` 定义事件、问题和可入账约束；`finance-update-posting.js` 在事务中再次校验并入账。
- `catledger-api/src/transaction-service.js` 已组合命令、查询、统计及维护模块；贷款和分期也已有规则、查询与存取文件，不需要整体再拆一次。

集中问题有明确调用证据：

| 证据位置（相对项目根目录） | 问题及影响 |
| --- | --- |
| `cloudfunctions/catledger-import/src/review-issue-service.js` | 规则、数据库存取、投影刷新、五类公开操作以及大量决定分支集中；一个修改容易波及不相关路径 |
| `cloudfunctions/catledger-import/src/finance-update-core.js` | 从核对总服务导入历史同步能力，核心整理依赖高层人工核对模块 |
| `cloudfunctions/catledger-import/src/semantic-plan-upgrade.js` | 从核对总服务导入 `FIELD_MASK`、读写事件、后续问题和计数；直接拆场景会牵动旧计划恢复 |
| `cloudfunctions/catledger-import/src/finance-update-read.js`、`finance-update-maintenance.js` | 分别依赖总服务的事件读取/投影及字段应用能力，公共职责位置不合适 |
| `miniprogram/pages/import-workbench/paged.js` 的 `enhance` | `Object.assign` 覆盖 `index.js` 的方法，同时包裹生命周期；文件名难以判断真正运行的实现 |
| `cloudfunctions/catledger-import/src/economic-event-builder.js` | 通用构建器直接检查 `sourceType === 'bank'`；来源特殊规则进入核心层 |
| `economic-event-builder.js` 与 `semantic-plan-upgrade.js` | 两处资金方向推导相似，但未知性质的回退不同，不能直接去重 |

当前工程检查证明云函数字面量 CommonJS 依赖没有循环、没有跨部署包引用；它不能证明模块职责已经完全分离，也未覆盖页面 `enhance` 的动态方法覆盖。

## 2. 后端目标边界

建议先在 `cloudfunctions/catledger-import/src/review/` 建立以下职责。仅在迁移现有代码时建立对应文件，不预先生成空模块。

| 模块 | 接收什么 / 负责什么 | 不负责什么 |
| --- | --- | --- |
| `policy.js` | 已归一化事件、问题和决定；字段掩码、允许修改的字段、原因解除和决定校验 | SQL、事务、来源原文解释 |
| `event-store.js` | 调用方传入的连接、可信 uid、批次/事件 ID；读取、引用校验和保存事件 | 请求身份、独立事务、选择用户决定 |
| `issue-store.js` | 同一连接内读取问题/成员，持久化已算出的后续问题和成员版本 | 账户映射业务编排、正式入账 |
| `reconciliation.js` | 投影刷新、失效历史关系恢复、调用既有历史候选模块、草稿可达性和计数同步 | 开新事务、修改查重窗口或相似判断 |
| `account-mapping.js` | 账户确认、批量映射、修订映射的操作步骤，复用现有映射索引和草稿模块 | 复制账户校验、独立保存正式账户 |
| `event-decisions.js` | 字段确认、同笔/不同笔、排除、退款关系、历史关联等现有分支 | 重新解释银行/微信/支付宝原始字段 |
| `repayment.js` | `setRepayment` 的操作步骤，调用现有 `explicit-repayment` 与分项规则 | 新的本金利息计算器、另一套费用入账 |
| 原 `review-issue-service.js` | 保留 `createReviewIssueService` 工厂，组装操作并拥有原命令事务入口 | 堆回具体 SQL 和各场景业务分支 |

`event-store` 中的引用校验仍复用已有领域规则；无需强制把每个 SQL 或小函数单独做一层。`reconciliation` 是事务内协作能力，允许调用规则与存取；它不是面向用户的服务入口。

依赖方向：

```text
import-service / action-registry
        ↓
review-issue-service（公开命令入口、原事务）
        ↓
account-mapping / event-decisions / repayment（事务内操作）
        ↓
reconciliation → event-store / issue-store → 既有底层存取与 SQL 批处理
        ↓                  ↓
        policy / organizer-model / 既有领域规则

core / read / maintenance / semantic-plan-upgrade
        └─ 按需直接使用上述公共能力，不经过 review-issue-service
```

规则模块不能反向调用存取或场景模块。`historical-duplicates.js` 继续负责候选及确认有效性；`reconciliation` 组合“失效历史关系恢复”和“候选同步”，不要用同名简版函数替代这两个步骤。

### 事务、版本与保存顺序

1. 工厂继续调用原 `executeIdempotentMutation`，身份、用户锁、请求摘要与回执入口不动。
2. 原位置完成批次/问题/事件版本检查后，将同一 `connection`、`uid` 和本次操作上下文传给场景模块。只传实际使用的参数，不引入通用服务容器。
3. 场景模块按原顺序写行动、事件、问题、映射、关系和计数，最终通过现有 `commandResult` 返回；不得各自 `commit`。
4. 批量映射保持整个批次的事务与一次收尾刷新，不能改成逐问题调用外部接口或逐笔事务。
5. `finance-update-posting.js` 的版本门禁、未决问题、逐行归宿、来源身份、历史锁内复查、账户物化、分期与正式交易写入顺序保持原样。本轮不以“统一服务”为由改动这些操作顺序。

### 迁移方式

- P1 先提取被多处使用的纯规则、事件存取与同步能力，同时迁移其真实调用方。旧模块可短期转导出兼容测试，但新模块不得依赖旧入口。
- P2 再提取具体场景的事务内操作。先账户映射，再普通交易决定与历史核对，最后明确还款；每一步保留原对外 action 和结果。
- `finance-update-repository.js` 仍管理批次、计划及其通用存取。只随上述职责移动必要能力；禁止把总服务的所有函数一起搬进去，形成另一个大文件。
- 只有在引用检查和行为验证确认无调用方后，才删除旧导出和兼容层。

## 3. 前端目标边界

保留原生 `Page`、WXML 事件名、已有云调用服务和恢复机制。建议在 `miniprogram/pages/import-workbench/` 内按实际流程提取：

| 模块 | 职责与状态所有权 |
| --- | --- |
| `index.js` | 页面初始数据、生命周期入口和显式事件装配；可直接看出每个 WXML 事件由谁处理 |
| `runtime.js` | 页面活动状态、view epoch、会话/草稿订阅、读取取消与资源释放；生命周期只在此串行协调 |
| `upload-flow.js` | 选文件、上传/重试、解析和银行列映射接续；复用 `bank-mapping.js`、`bank-suggestion.js` |
| `account-review.js` | 账户分组确认、批量决定、目录选择及对应弹层状态 |
| `transaction-review.js` | 核对项、历史候选、交易表单与保存；复用 `inline-evidence.js`，原文继续同层显示 |
| `posting-flow.js` | 最终摘要、确认入账、回执恢复、已入账后明细刷新；复用 `final-detail.js` |
| `model.js` 及必要的视图模型 | 纯转换函数按上传、账户、核对实际消费者逐步移动；`presentation.js` 继续统一展示转换 |

默认采用小型工厂或显式函数装配，不新增“控制器基类”、全局 store 或自动发现框架。文件边界过细时允许合并，但生命周期和写入恢复所有权必须唯一。

### 拆除 `paged.enhance` 的顺序

1. 列出 `index` 与 `paged` 的同名方法、调用先后、WXML 绑定、持有的分页器及订阅；记录当前真正执行的方法。
2. 先移出生命周期和统一请求适配。页面显式调用一次加载/显示/隐藏/卸载处理；保持 `this`、回调、原始方法顺序和取消语义。
3. 每次迁移一个操作流程及对应读分页能力，删除那一组旧覆盖；过渡期允许剩余覆盖仍在原文件，但必须有清单且无新旧双重执行。
4. 所有方法归属明确后删除 `enhance`。保留确有用途的 `boundedSetData`，位置按页面桥接职责确定，不因文件拆分取消预算控制。

### 状态与异步契约

- 页面数据仍是 WXML 的视图模型；领域对象、原始大数组和完整批次不搬进 `data`。
- 唯一 runtime 管理活动页面、批次/版本 epoch 和会话；各流程仅持有自己的读取令牌，不能各自建立不相干的“当前版本”。
- `import-view-session` 继续管理游标/分页缓存；`import-draft-session` 继续管理持久请求及恢复；只封装调用，不改变其存储格式。
- 编辑中延后后台投影、关闭弹层/翻页后丢弃迟到原文、成功后保留入账事实等现有分支全部保留。
- `busy`、`currentIssue` 等共享字段在 P0 归属清单中逐项定主；流程提出状态变更，由页面/runtime 显式协调，不能互相偷偷清空。

## 4. 来源边界和共享规则

当前银行特例是具体问题，不足以支持建设通用插件引擎。

- P5 先列出银行身份冲突从解析、身份持久化到事件构建的完整真值表。能保持现有输入输出时，才把“是否阻断”的判断放回来源/身份能力；通用事件构建器消费确定结果。
- 如果需要新增持久语义字段、改变摘要或升级旧计划，退出本轮纯结构范围，单列后续任务；不直接把银行判断扩大到所有来源。
- 两处资金方向推导先对比收入、支出、退款、费用、借款、还款、内部转账及未知的现行分支。未知回退不同即保持不同；不能只因为代码相似而合并。
- `repayment-booking.js` 与 `installment-items.js` 继续在两个独立云函数包内存在，由工程检查保证一致。本轮不引入跨包 `require`、私有包发布或生成构建流程。
- 新增来源仍通过现有 profile 的版本和契约测试接入；只有真实新增来源需要时，再扩展相应能力。

## 5. 验证策略

复用既有测试，对移动后的公开行为验证；只给未覆盖的分支增加测试。依赖方向与重复方法检测适合静态检查，财务和恢复行为不以搜索字符串代替。

| 风险 | 现有主要入口（相对项目根目录） | 验收内容 |
| --- | --- | --- |
| 语义、身份、同额独立 | `cloudfunctions/catledger-import/test/{row-semantic-resolver,organizer-planner,semantic-safety,bank-parser}.test.js` | 解析结果、核对原因、来源归宿不漂移 |
| 旧计划与人工覆盖 | `cloudfunctions/catledger-import/test/semantic-plan-upgrade.test.js`、`test/import-draft-session.test.js` | 旧计划可恢复，人工决定不被重算覆盖 |
| 历史查重 | `test/import-history-review-db.test.js`、`test/import-history-review-ui.test.js` | 每次整理与入账按现行规则比对；候选变化、并发、已确认同笔和不同笔保持正确 |
| 正式入账与贷款 | `cloudfunctions/catledger-import/test/finance-update-posting.test.js`、`test/{explicit-repayment,loan-sources,installment-flow-db}.test.js` | 整批回滚、幂等、来源保留、分期费用只计一次 |
| 银行文件与单文件隔离 | `test/bank-import-db.test.js`、`test/import-bank-mapping.test.js` | XLS 等支持、映射恢复、坏文件不污染其他文件 |
| 页面与原文 | `test/{import-paged-workbench,import-inline-evidence,import-recovery,import-account-choice,import-account-compact}.test.js` | 原文直接展示、切换/关闭/退出/版本变化后的迟到响应不回填 |
| 性能与有界读取 | `cloudfunctions/catledger-import/test/performance-v2.test.js`、`review-candidate-budget.test.js`、`test/import-paged-workbench.test.js` | 保持现有 SQL、响应和缓存预算；24990 条页面夹具不保留全集 |
| 全项目交界 | `test/{runtime-roles-db,data-export,read-revision-db,transaction-management}.test.js` | 最小权限、导出、修订、已入账维护和其他功能不受影响 |

固定合成输入对比业务输出时，只能剔除明确随机 ID/运行时间等非业务噪声；保留金额、账户、日期、来源归属、决定、版本与错误码。不能通过放宽断言掩盖差异。真实账单不得进入仓库夹具或普通日志。

P1/P2 完成受影响数据库回归；P3/P4 完成页面行为和原生编译/合成交互；P5 跑全量工程检查、单元与隔离数据库门禁。每步通过后不机械重复整套验证，除非新改动、失败或未解决疑点需要。CI 使用现有 Node 18 / MySQL 8.4，与本机运行时分别记录。

## 6. 文件所有权、交付与回退

- 实施负责人在任务认领时明确，单一负责人协调 `review-issue-service`、旧计划升级、公共契约、事务和幂等边界。后端与页面阶段默认串行，不因目录不同就并行改共享状态。
- 新增持续功能工作区按项目规则使用 `codex/mini-1915-<phase>`；完成后将已验证提交同步回用户实际使用的 catledger 目录，核对微信开发者工具窗口路径。
- 每个阶段一个可独立回退的变更单元，提交说明列出移动职责、保留行为、验证和剩余风险；回退用正常 revert，不改数据库、不删除草稿、不强推。
- 后端与页面协议保持兼容。若后续发布，先完成原生与集成验证，发布证据分别记录云函数、体验版和真机；本次计划交付不包含发布。
- 收口时同步《入账逻辑说明》的代码/测试入口，《架构设计》的依赖方向，受影响《现行说明》的真实状态及实施规划证据。发现旧文档“待发布”等表述与已有发布证据冲突时明确更新当前结论，保留历史过程。
