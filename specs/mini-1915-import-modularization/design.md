# MINI-1915 拆分设计

方案已按评审修订，实施未开始。基线与授权见 [README](README.md)，验收见 [requirements](requirements.md)。文件名是建议，真实职责、依赖、副作用和可验证性优先于目录形式；不是预建全部文件的要求。

## 1. 保留的架构与真实问题

```text
原生页面 → 客户端请求 / 草稿 / 分页服务 → 云函数 handler
  ├─ catledger-api：账户 / 分类 / 交易 / 贷款 / 分期 / 统计
  └─ catledger-import：解析 → 来源语义 → 事件/关系 → 核对 → 正式入账
两云函数独立部署 → 可信身份、MySQL 事务与约束
```

保留 parsers、静态 profiles、row-semantic-resolver、rule-evaluator、organizer-planner、organizer-model 及正式入账实现。常规 API 的交易命令/查询/统计与贷款/分期已有边界，不整体再拆。两个目标是解除公共能力依赖高层核对入口，以及让页面实际处理者和状态归属可直接定位。

| 基线证据（相对项目根目录） | 现状 |
| --- | --- |
| `cloudfunctions/catledger-import/src/review-issue-service.js` | 规则、SQL、事件保存、投影、历史同步、五个工厂方法集中 |
| `cloudfunctions/catledger-import/src/finance-update-core.js` | 从核对总服务引入历史同步 |
| `cloudfunctions/catledger-import/src/semantic-plan-upgrade.js` | 从总服务引入字段掩码、读写事件、后续问题、计数；保存使用旧引用保护和语义操作来源 |
| `cloudfunctions/catledger-import/src/finance-update-read.js` | 从总服务引入事件读取和有效账户投影 |
| `cloudfunctions/catledger-import/src/finance-update-maintenance.js` | 从总服务引入字段应用 |
| `miniprogram/pages/import-workbench/index.js` / `paged.js` | `Page(paged.enhance(...))`，后者覆盖方法并包裹生命周期，运行顺序不直观 |
| `cloudfunctions/catledger-import/src/economic-event-builder.js` | 银行身份特例及与旧语义升级不完全相同的方向推导；本轮仅审计，不默认修改 |

以上是修订基线的种子清单，不冒充已完成 P0。接手时重新搜索运行时、测试、WXML 和动态装配的全部消费者。已有工程检查覆盖字面量 CommonJS 循环及部署边界，不能代替函数副作用或动态页面覆盖检查。

## 2. 后端模块边界

目标位于 `cloudfunctions/catledger-import/src/review/`；实际迁移到哪个职责时才创建文件。

| 模块 | 职责 | 禁止承接 |
| --- | --- | --- |
| `policy.js` | 字段掩码、字段应用、原因解除、决定及问题类型校验；保留确定性输入输出和原对象修改行为 | SQL、连接池、服务工厂、来源原文解释 |
| `event-store.js` | 同一连接内读取/归一化事件、引用目录和关系上下文，原样承接有业务校验的保存操作 | 自建事务、选择用户决定、丢弃保存中的业务副作用 |
| `issue-store.js` | 问题/成员存取与版本条件写入；原样组合后续问题的占用检查、既有分类及退款上下文 | 另造分类规则、账户映射总编排、正式入账 |
| `reconciliation.js` | 有效投影、投影刷新、失效历史关联恢复、候选同步、草稿可达性和批次收尾；读/写函数明确区分 | 开新事务、变更查重窗口、无条件统一各入口收尾 |
| `account-mapping.js` | 单项/批量账户确认、修订和 `refreshAccountGroups` 的事务内步骤；复用既有索引与草稿能力 | 新网络入口、逐项外部命令、独立物化正式账户 |
| `event-decisions.js` | 字段、同笔/不同笔、排除、舍弃证据、退款及历史关联的原分支 | 重新解释来源字段、建立通用插件或分派框架 |
| `repayment.js` | `setRepayment` 事务内步骤，继续调用 explicit-repayment 和既有分项规则 | 新的本金利息计算器或费用入账路线 |
| 原 `review-issue-service.js` | `createReviewIssueService`、原命令事务入口、各入口的校验/锁顺序和显式场景装配 | 重新堆回大段场景 SQL；新增内部兼容转导出 |

存取模块不强求通用 CRUD，也不为每条 SQL 套一层。单笔与批量保存先保留原操作语义；抽取原函数比同时设计新仓储接口更优先。`reconciliation` 是事务内协作能力，不是另一个服务入口。

### 2.1 五个工厂方法与公开接口不是同一份清单

以 [action-registry.js](../../cloudfunctions/catledger-import/src/action-registry.js)、[import-service.js](../../cloudfunctions/catledger-import/src/import-service.js) 和 [review-issue-service.js](../../cloudfunctions/catledger-import/src/review-issue-service.js) 为证据。

| 工厂方法 | 基线调用/暴露方式 | 场景归属与迁移约束 |
| --- | --- | --- |
| `resolveAccountMappings` | `reviewIssues.resolveAccountMappings`，经 `reviewIssueResolveAccountMappings` | account-mapping；保留批量 resolve/revise、排序锁定、可操作项筛选、映射索引和一次批次收尾 |
| `reviseAccountMapping` | 内部 service 属性 `reviewIssueReviseAccountMapping`；没有同名公开 action | account-mapping；P0 查明所有实际消费者，保留原内部方法，不为它加网络入口或在搬迁时删除 |
| `refreshAccountGroups` | `reviewIssues.refreshAccountGroups`，经 `reviewIssueRefreshAccountGroups` | account-mapping；保留旧引用展开、分组、旧问题替代、映射和成员/事件版本；无候选时直接返回 |
| `resolve` | `reviewIssues.resolve`，经 `reviewIssueResolve` | 显式定位普通决定和账户相关步骤；公共前置检查与分支先后不变，不在路由时提前/延后校验 |
| `setRepayment` | `financeUpdates.setRepayment`，经 `financeUpdateSetRepayment` | repayment；保留明确还款、历史核对和分期费用复用的交界 |

因此本轮涉及四个已注册公开入口及一个内部 service 方法。当前普通 resolve 也有账户相关行为；并非把每个顶层方法整块挪到一处就算职责清晰。只抽取真实共享的事务内步骤，不让这些命令互相调用、嵌套幂等事务或顺带统一旧分支。

### 2.2 函数接缝与副作用表

原位置除另注外均为 `review-issue-service.js`。P0 补齐实际调用者、参数、返回/对象修改、SQL/锁、失败点和对应测试；以下不可省略。

| 函数/能力 | 必须保留的契约 | 迁移位置/阶段 |
| --- | --- | --- |
| `FIELD_MASK`、`applyFields`、`resolvedReasons`、`validateDecision`、`assertDecisionMatchesIssue` | 掩码值、字段允许集、原优先级、错误码、校验次序与对象行为不变 | policy / P1-A |
| `domainEvent`、`selectDomainEvents` | uid/update 过滤、ID 去重排序分块、forUpdate 位置、数值/JSON 归一化及旧支付证据补齐 | event-store / P1-B |
| `eventContext`、`loadReferenceCatalog`、`validateEventReferences` | 关系/交易上下文；账户、草稿、分类、分配合法性；原锁定范围与批量目录复用 | event-store / P1-B |
| `finalizeSavedEvent` | 可入账重算、状态/原因合并、原事件版本 +1、lastUserActionId / lastSemanticActionId；当前会修改 next | 先作为 event-store 内部确定性 helper / P1-B，不为拆层再造保存服务 |
| `saveEvent` | 原引用校验或 preserveReferences 路径、单事件上下文、版本条件 UPDATE 和冲突错误；保留 actionSource | event-store / P1-B |
| `saveEvents` | 一次加载批量引用目录和上下文、逐事件规则校验、批量更新；不改成循环 saveEvent，不扩展为自动接管语义升级 | event-store / P1-B |
| `selectIssue`、`selectMembers`、成员版本更新 | uid/批次范围、问题与成员状态条件、版本比较和原 SQL 顺序 | issue-store / P1-B |
| `createFollowUpIssue(s)` | 当前确实包含候选筛选、现有问题占用检查、分类及退款上下文，不是单纯 INSERT；保留问题键、成员顺序和阻断性 | issue-store / P1-B，复用已有规则，不重写分类 |
| `effectiveProjectedEvents(FromIndex)` | 读取有效映射并应用原人工掩码优先级；不得因复用收尾函数而变成写操作 | reconciliation / P1-B |
| `refreshProjectedEvents` | 保留作用范围、问题替代、事件保存与后续问题顺序；不能把原单次调用改成逐项全批刷新 | reconciliation / P1-B |
| `restoreStaleHistoricalLinks`、包装层 `synchronizeHistoricalReviews` | 先恢复失效关联，再调用 historical-duplicates 的候选同步；保留返回的变化标记 | reconciliation / P1-B |
| `recalculateUpdateCounts` | 历史同步 → 草稿可达性 → 计数 → 带预期版本的批次更新；含 duplicateEvidenceDelta，不是读统计 | reconciliation / P1-B |
| 账户草稿/映射、`runAccountMappingBatch`、账户分组刷新 | 原正式账户/草稿边界、映射索引更新、成员版本、无行动路径及批次统一收尾 | account-mapping / P2 |

重点消费者迁移：maintenance 的字段应用转向 policy；semantic-plan-upgrade 分别使用 policy、event-store、issue-store、reconciliation，保留 `saveEvent(..., { preserveReferences: true, actionSource: 'semantic' })`；read 仅使用事件读取与有效投影；core 使用含恢复步骤的历史同步包装层。不得把旧计划升级误接到仅用户决定的保存路径。

### 2.3 依赖与事务

```text
import-service / action-registry
  → review-issue-service（原事务入口）
    → account-mapping / event-decisions / repayment
      → reconciliation → event-store / issue-store
        → policy / organizer-model / 既有底层规则与存取
core / read / maintenance / semantic-plan-upgrade
  → 按函数职责直接使用上述公共能力，不经过核对命令入口
```

规则不能依赖存取或场景；公共能力不能反向 require 总服务。各模块直接使用必要的既有依赖，不传通用容器或完整服务对象。所有写入使用调用方传入的同一 `connection` 和可信 `uid`，场景不取得新连接或自行 commit。

工厂保留每个操作的 `executeIdempotentMutation`、请求摘要、用户锁及回执关系。版本检查、问题/事件锁、行动创建和写入顺序按各入口原实现保留，不强行套成一个通用模板。无候选/无可操作项可以没有新业务行动和版本变化，但原幂等回执协议不能被移除。收尾次数按入口记录，不把 core 的原有计数流程强制替换成核对收尾函数。

正式入账文件只作为集成验证对象：版本门禁、未决问题、逐行归宿、来源身份、锁内历史复查、账户物化、分期和正式交易写入均不重排。

### 2.4 迁移纪律

P1-A 只搬纯规则；P1-B 才搬 SQL 和事务内协作；P2 才拆场景。每次同提交更新实际运行时消费者和测试，不为旧导入路径增加转导出、兼容包装或双实现。正式工厂保留不是兼容层。先原样移动再评价命名；不要把搬迁、去重、批量化、业务修复混成一个提交。`finance-update-repository.js` 继续管理批次/计划的通用持久化，不成为新总服务。

## 3. 前端边界与状态所有权

保留原生 Page、WXML 事件名、布局与既有服务。按实际流程建立 runtime、upload-flow、account-review、transaction-review、posting-flow；必要时合并过细文件，不创建控制器基类或全局状态框架。

| 状态/能力 | 唯一所有者 | 协作边界 |
| --- | --- | --- |
| Page 注册、初始视图、WXML 事件装配 | index.js | 事件显式转给对应流程，不依赖覆盖顺序 |
| 页面活动 epoch、生命周期、订阅与资源释放 | runtime | 只协调 UI 生命周期，不复制服务端版本、草稿或分页状态机 |
| 读视图版本、游标、分页缓存与读请求去重 | 既有 import-view-session | runtime 持有/释放实例，各流程持有其分页器/局部读令牌；不另造版本权威 |
| 草稿队列、在途请求、幂等 requestId、postFlight 与恢复 | 既有 import-draft-session | 页面可订阅、发起 flush/post，但不能因卸载随意清除待恢复事实或新建替代请求 |
| 上传文件、进度节流、重试和银行列映射接续 | upload-flow | 复用 bank-mapping/bank-suggestion 与既有上传协议；生命周期释放由 runtime 协调 |
| 账户分组、目录选择、账户 UI 草稿与弹层 | account-review | 持久决定仍交给 draft-session，账户 ID 不随分页/目录索引漂移 |
| 当前核对项、历史候选、编辑表单与原文 | transaction-review | 复用 inline-evidence；关闭/翻页取消对应读取，不取消已发命令事实 |
| 最终摘要、入账按钮、成功事实展示与明细刷新 | posting-flow | 调用原 draft-session 的提交/恢复，不再管理第二份 postFlight |
| 展示转换 | presentation 与按真实消费者迁移的 model | 纯转换，不读写会话；不将原始全集放入 data |
| busy、待应用后台视图等共享字段 | P0 指定的页面/runtime 协调入口 | 流程显式申请变更，不互相暗中清空；过期 finally 不能解锁新操作 |

### 3.1 请求结果分两条路线

读响应回填前检查用户会话、页面、批次、读视图版本和局部令牌；失效就停止渲染。写响应则先遵循现有命令/草稿协议确认事实或保留原请求恢复，再决定当前页面是否渲染。页面隐藏/卸载不代表服务端命令被撤销。

示例验收：入账已发出 → 页面离开 → 服务端成功 → 原恢复机制确认或下次重放同一请求 → 重新进入得到已入账事实。不得让旧页面覆盖新页面，亦不得生成第二个入账请求。退出登录按既有身份隔离和清理规则处理，不为保留旧回执跨用户写状态。

runtime 仅包装/协调，不能替换 import-draft-session、import-view-session、read-cache、view-patch。存储格式与原请求身份保持不变。基线未满足的恢复不变式先登记独立缺陷，不能借拆分悄悄改行为。

### 3.2 拆除 enhance

1. P0 列出 index/paged 的同名方法、实际执行者、原方法调用顺序、WXML 绑定、分页器、订阅和定时器；种子包括生命周期、request、applyUpdateView、postUpdate、关闭弹层包装和 startAnother，不把种子当完整清单。
2. P3 显式装配生命周期与请求适配，仅协调一次；保留 this、回调、主题绑定、登录处理、取消/恢复顺序。新流程实例按页面创建，不把可变状态做成模块单例。
3. 按流程迁移方法及读分页能力；移出一组就移除其旧覆盖。过渡期剩余覆盖必须有清单，不新增覆盖、不执行新旧两份方法，也不保留已废弃的内部别名。
4. P4 全部归属明确后删除 enhance。保留 boundedSetData，且只能包装一次；维持 view-patch 的差异更新。补重复生命周期/事件名、WXML 未绑定处理函数的检查。
5. 编辑中延后后台投影、弹层关闭后的应用顺序、同层原文与失败重试、已入账而明细失败的展示保持。页面测试继续加载真实入口，不只测试拼装后的假对象。

## 4. 来源和共享规则：审计，不作为必做抽取

P5 默认列出银行身份冲突从解析、身份持久化到事件构建的分支，以及两处资金方向推导的差异。收入、支出、退款、费用、借款、还款、内部转账、余额调整及未知均按原代码记录；不能因代码相似就合并不同回退。

来源规则代码提取不影响本任务完成。只有能证明某个现有依赖阻碍本次目标边界，才单列小提交及等价证据；需要改语义、字段、摘要或版本的内容退出本轮，形成后续任务。本轮不引入插件引擎、AI 模型、私有包或生成构建流水线。两个独立云函数中的 repayment-booking、installment-items 继续由既有一致性检查约束，不跨包 require。

## 5. 验证方法

复用原测试及隔离 MySQL；先映射已有覆盖，再补缺失的保存/事务/恢复接缝。不因新增文件就重复造测试。静态检查用于依赖和方法归属；业务正确性由真实行为断言证明。

| 风险 | 既有入口（相对根目录） | 增补重点 |
| --- | --- | --- |
| 语义、身份、同额独立 | `cloudfunctions/catledger-import/test/{row-semantic-resolver,organizer-planner,semantic-safety,bank-parser}.test.js` | 规则提取输入输出不变 |
| 旧计划与人工覆盖 | `cloudfunctions/catledger-import/test/semantic-plan-upgrade.test.js`、`test/import-draft-session.test.js` | preserveReferences、semantic 操作来源、原掩码和恢复请求 |
| 历史核对 | `test/import-history-review-db.test.js`、`test/import-history-review-ui.test.js` | 失效关联恢复后再同步、候选变化、同笔/不同笔确认及锁内复查 |
| 事件保存与账户分组 | P0 定位现有相关单元/数据库入口 | 单笔/批量差异、引用与冲突、刷新无候选/再次运行、旧分组展开及批量收尾次数 |
| 正式入账与分期 | `cloudfunctions/catledger-import/test/finance-update-posting.test.js`、`test/{explicit-repayment,loan-sources,installment-flow-db}.test.js` | 回滚、幂等、来源与费用只计一次 |
| 银行与单文件隔离 | `test/bank-import-db.test.js`、`test/import-bank-mapping.test.js` | 上传/映射恢复不变，坏文件不污染其他文件 |
| 页面与原文 | `test/{import-paged-workbench,import-inline-evidence,import-recovery,import-account-choice,import-account-compact}.test.js` | this/回调/生命周期；迟到读、编辑保护、后台/卸载后的原写请求恢复 |
| 资源预算 | `cloudfunctions/catledger-import/test/performance-v2.test.js`、`test/import-paged-workbench.test.js` | 硬上限与实际开销双检查，24990 条合成批次不驻留全集 |
| 项目交界 | `test/{runtime-roles-db,data-export,read-revision-db,transaction-management}.test.js` | 最小权限、导出、修订和已入账维护 |

等价比较优先固定现有测试中的 ID/时钟注入；否则为生成的事件、问题、行动等 ID 建立类别内一致的一一映射，所有关系、外键和来源归属跟随映射。不得直接删 ID 或乱序排序导致错绑被掩盖。保留业务日期、金额、账户、状态/原因、版本、错误码和确定性键/摘要；只剔除列明的非业务噪声。

[performance-contract.js](../../cloudfunctions/catledger-import/src/performance-contract.js) 是硬预算来源：请求 64 KiB、回执 32 KiB、摘要 64 KiB、分页响应 256 KiB，SQL 分块按原参数/字节限制。页面既有测试验证单次 setData ≤64 KiB、data ≤256 KiB；view-session 最多 3 个响应页、8 个历史游标，24990 条夹具不保留全集。这些是现有入口的预算/测试条件，不是所有场景已实测的宣称。

另记录同输入实际 SQL/云请求次数、响应字节、派生计算和 setData 次数；纯结构变更不得带来无解释增长。耗时需要同环境可比样本，不能拿一次测量作优化证明。金融异常按实际异常规模统计，不把额外查询藏入普通场景预算。

P1-A 验证纯规则、消费模块加载与边界；P1-B/P2 跑受影响数据库与事务回归；P3/P4 跑真实页面行为、原生编译/合成交互；P5 执行全量工程、单元和隔离数据库门禁。精确命令以仓库根目录 `package.json`、`scripts/` 及 `.github/workflows/verify.yml` 为准，CI 当前为 Node 18 / MySQL 8.4。相同未变化的通过项不机械重复；不同代码 SHA、失败、未解疑点或最终集成门禁不能省略。

## 6. 协作、交付和回退

Astra 接手后是唯一主实施负责人，串行协调公共契约、事务、幂等与页面共享状态。沿用 `codex/mini-1915-import-modularization` 一个任务分支，以小提交而非长期子分支区分阶段。

先核对真实目录 `/Users/gaohongxiang/projects/catledger` 和工具窗口。已有修改不覆盖；必要时在同一任务分支的隔离 worktree 验证，不能强切正在使用的主目录。禁止 reset --hard、force push、危险 rebase、删除用户草稿或运行真实财务写入。

每个提交记录职责移动、消费者、验收和剩余风险；后续提交依赖前项时按逆依赖顺序正常 revert，不宣称任意撤回前置提交仍可运行。无需数据回滚或迁移。代码交付同步入账逻辑说明、架构、现行说明与实施规划；其余任务状态不改。

当前文档提交和用户转交后的任务分支实施不自动授权合并 main、部署云函数、迁移、上传、审核或发布。未获授权时交付可集成候选、精确 SHA、CI 和未完成验证；合并/本机主目录同步另按授权执行，不把候选推送说成手机已更新。
