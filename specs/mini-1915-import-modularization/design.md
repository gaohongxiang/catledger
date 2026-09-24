# MINI-1915 一期设计：减复杂度，不重写系统

当前状态见 [实施规划](../../docs/招财猫记账本实施规划.md)。范围见 [README](README.md)，行为约束见 [requirements](requirements.md)，顺序见 [tasks](tasks.md)。一期包含原导入模块化和有边界的文档、相关测试、缓存整理；P0～P5 是一期内部步骤，不是多个产品版本。模块名为建议，职责和真实消费者优先，不预建全部文件。

## 1. 保留的架构与问题证据

```text
原生页面 → 请求 / 草稿 / 分页服务 → 云函数 handler
  ├─ catledger-api：账户 / 分类 / 交易 / 贷款 / 分期 / 统计
  └─ catledger-import：解析 → 来源语义 → 事件/关系 → 核对 → 正式入账
两个独立云函数 → 可信身份、MySQL 事务与约束
```

保留 parsers、静态 profiles、row-semantic-resolver、rule-evaluator、organizer-planner/model 和正式入账实现；普通 API 已有命令/查询/统计及贷款/分期边界，不整体重拆。来源证据、事件、正式交易不是应当合并的重复数据权威。

| 基线证据（路径相对根目录） | 本期处理 |
| --- | --- |
| `cloudfunctions/catledger-import/src/review-issue-service.js` | 规则、SQL、保存、投影、历史同步与五工厂方法集中；提取真实职责 |
| `cloudfunctions/catledger-import/src/finance-update-core.js`、`semantic-plan-upgrade.js` | 依赖总服务的历史同步、字段规则、读写事件和收尾；解除倒置 |
| `cloudfunctions/catledger-import/src/finance-update-read.js`、`finance-update-maintenance.js` | 分别依赖事件读取/有效投影、字段应用；迁移真实消费者 |
| `miniprogram/pages/import-workbench/index.js`、`paged.js` | Page(enhance(...)) 覆盖方法和生命周期；改成明确处理者与状态所有权 |
| `miniprogram/services/read-cache.js`、`read-policy.js`、`catledger-api.js`、`read-snapshot-store.js` | 标签、修订、写屏障和展示快照职责交叠但不等价；先测量，不能直接删机制 |
| `README.md`、`docs/README.md`、`docs/招财猫记账本实施规划.md` | 多处当前状态存在历史漂移风险；让入口引用唯一状态记录 |
| `test/import-account-compact.test.js`、`test/import-paged-workbench.test.js` | 实现/样式断言与真实页面行为测试并存；按保护目标整理，不一概删静态测试 |
| `cloudfunctions/catledger-import/src/economic-event-builder.js` | 银行身份特例和方向回退；仅审计，默认不改语义 |

这是基于修订起点的种子清单，不是完成 P0 的宣称。Astra 重新搜索全部运行时、测试、WXML 和动态装配消费者；静态循环检查不等于职责或副作用已分离。

## 2. 后端目标与函数接缝

位置为 `cloudfunctions/catledger-import/src/review/`，随迁移建立模块；不按每个函数/SQL 拆层。

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| policy.js | 字段掩码、字段应用、原因解除、决定/问题类型校验，保留原对象行为 | SQL、连接池、存储、来源原文解释 |
| event-store.js | 同一连接内读取/归一化事件、引用目录、关系上下文和带业务校验的原保存函数 | 新事务、选择用户决定、把保存简化为无校验 CRUD |
| issue-store.js | 问题/成员版本存取；保留后续问题占用检查、分类和退款上下文 | 另造分类规则、账户映射总编排、正式入账 |
| reconciliation.js | 有效投影、投影刷新、失效历史关联恢复、候选同步、草稿可达性和批次收尾 | 新事务、改查重规则、统一所有入口的自动收尾 |
| account-mapping.js | 单项/批量账户确认、修订、refreshAccountGroups 的事务内步骤 | 新网络入口、逐项外部命令、独立物化正式账户 |
| event-decisions.js | 字段、同笔/不同笔、排除、舍弃证据、退款及历史关联的现有分支 | 来源重解释、通用插件或分派框架 |
| repayment.js | setRepayment 步骤，调用既有 explicit-repayment/分项规则 | 新本金利息计算器、第二套费用入账 |
| 原 review-issue-service.js | 工厂、原幂等事务和入口校验/锁顺序、显式装配 | 再堆大段场景 SQL、内部兼容转导出 |

存取模块不要求通用 CRUD。薄工厂有公开契约和事务职责，应保留；没有独立职责的纯转发文件不新增。单笔/批量保存先原样移，不同时设计新仓储接口。

### 2.1 五工厂方法、四对应公开入口

依据 [action-registry](../../cloudfunctions/catledger-import/src/action-registry.js)、[import-service](../../cloudfunctions/catledger-import/src/import-service.js)、[review-issue-service](../../cloudfunctions/catledger-import/src/review-issue-service.js)。

| 工厂方法 | 基线入口 | 场景及保留点 |
| --- | --- | --- |
| resolveAccountMappings | reviewIssues.resolveAccountMappings / reviewIssueResolveAccountMappings | account-mapping；批量 resolve/revise、排序锁、可操作项筛选、映射索引、一次收尾 |
| reviseAccountMapping | 内部 reviewIssueReviseAccountMapping，未注册同名公开 action | account-mapping；P0 查明实际消费者，不顺手删除或公开 |
| refreshAccountGroups | reviewIssues.refreshAccountGroups / reviewIssueRefreshAccountGroups | account-mapping；旧引用展开、分组、旧问题替代/重开、映射、成员/事件版本；无候选直接返回 |
| resolve | reviewIssues.resolve / reviewIssueResolve | 普通决定与账户相关步骤显式归属；不提前/延后前置校验，不改变分支次序 |
| setRepayment | financeUpdates.setRepayment / financeUpdateSetRepayment | repayment；保留明确还款、历史核对和分期费用交界 |

不能把五个工厂方法误当作应新增五个接口，也不能因顶层函数已搬家就算边界完成。普通 resolve 仍含账户相关行为，只有实际共享的事务内步骤才能复用，不能互调公开命令或嵌套幂等事务。

### 2.2 必须保留的保存与收尾副作用

原位置均为 review-issue-service.js。P0 为每项补原位置、全部调用者、参数/返回与对象修改、SQL/锁、失败点和测试。

| 函数/能力 | 不可遗漏的行为 | 阶段/目标 |
| --- | --- | --- |
| FIELD_MASK、applyFields、resolvedReasons、validateDecision、assertDecisionMatchesIssue | 掩码值、字段允许集、优先级、错误码、校验次序和对象行为 | P1-A / policy |
| domainEvent、selectDomainEvents | uid/update 过滤、ID 去重排序分块、forUpdate 位置、数值/JSON 归一化、旧支付证据补齐 | P1-B / event-store |
| eventContext、loadReferenceCatalog、validateEventReferences | 关系/交易上下文、账户/草稿/分类/分配校验、原锁范围、批量目录复用 | P1-B / event-store |
| finalizeSavedEvent | 修改 next，重算可入账状态/原因，事件版本 +1，lastUserActionId/lastSemanticActionId | P1-B / event-store 内部 helper；不另造保存服务 |
| saveEvent | 引用校验或 preserveReferences 路径、单事件上下文、版本条件 UPDATE/冲突、actionSource | P1-B / event-store |
| saveEvents | 批量目录/上下文加载、逐事件校验、批量更新；不循环 saveEvent，也不自动接管语义升级 | P1-B / event-store |
| selectIssue、selectMembers、成员版本同步 | uid/批次范围、状态条件、版本比较及原顺序 | P1-B / issue-store |
| createFollowUpIssue(s) | 候选筛选、问题占用、分类/退款上下文、问题键、成员顺序、阻断性，不只是 INSERT | P1-B / issue-store |
| effectiveProjectedEvents(FromIndex) | 有效映射与人工掩码优先级；只读函数不得变成写收尾 | P1-B / reconciliation |
| refreshProjectedEvents | 作用范围、问题替代、保存和后续问题顺序；不逐项全批刷新 | P1-B / reconciliation |
| restoreStaleHistoricalLinks、包装层 synchronizeHistoricalReviews | 先恢复失效关联，再调用 historical-duplicates 候选同步，保留变化标记 | P1-B / reconciliation |
| recalculateUpdateCounts | 历史同步 → 草稿可达性 → 计数 → 预期版本的批次更新，含 duplicateEvidenceDelta | P1-B / reconciliation；不是廉价读统计 |
| 映射草稿、runAccountMappingBatch、账户分组刷新 | 原正式账户/草稿边界、映射索引、成员版本、无行动路径和一次批次收尾 | P2 / account-mapping |

maintenance 改用 policy；旧语义升级分别使用 policy/event-store/issue-store/reconciliation，保留 saveEvent 的 `{ preserveReferences: true, actionSource: 'semantic' }`；read 只取事件/有效投影；core 必须使用含恢复步骤的历史同步包装层，不能误接到底层同名函数。

### 2.3 依赖、事务与迁移纪律

```text
import-service / action-registry
  → review-issue-service（原命令事务入口）
    → account-mapping / event-decisions / repayment
      → reconciliation → event-store / issue-store
        → policy / organizer-model / 既有规则与底层存取
core / read / maintenance / semantic-plan-upgrade
  → 按函数职责直接使用公共能力，不经过核对命令入口
```

公共模块不反向 require 总服务/场景，规则不依赖存取。只传实际需要的连接、可信 uid 和参数，不传万能服务容器。每个命令保留 executeIdempotentMutation、请求摘要、用户锁、回执以及本入口原锁/版本/写入顺序；子模块不取新连接、不 commit。无候选可以没有业务行动/升版，但幂等回执不移除。core 原计数流程不强制换成核对收尾。

正式入账只作为集成验证对象，版本门禁、未决问题、逐行归宿、来源身份、锁内历史复查、账户物化、分期和交易写入不重排。finance-update-repository 继续管批次/计划通用存取，不变成新总服务。

P1-A 只移纯规则，P1-B 才移存取/收尾，P2 才拆场景。同提交更新消费者和测试，不加旧内部路径转导出/兼容包装/双实现。搬迁、语义修复、缓存减法和测试去重分开提交。

## 3. 页面边界与异步所有权

保留 Page、WXML 事件名、布局/导航。仅按真实流程建立模块，不创建控制器基类或全局 store。

| 所有者 | 权威状态/职责 | 协作边界 |
| --- | --- | --- |
| index.js | Page、初始视图、WXML 显式装配 | 不靠 Object.assign/spread 顺序覆盖冲突 |
| runtime | 页面活动 epoch、生命周期、订阅/定时器/分页器释放、共享 UI 协调 | 不复制服务端版本、草稿或分页状态机 |
| 既有 import-view-session | 读版本、游标、分页缓存/去重 | 流程持有局部分页器/令牌，不新建版本权威 |
| 既有 import-draft-session | 草稿队列、在途请求、幂等 requestId、postFlight/恢复 | 页面只调用/订阅，不因卸载清除待恢复事实 |
| upload-flow | 文件、进度节流、重试、银行映射接续 | 复用 bank-mapping/bank-suggestion 和上传协议 |
| account-review | 账户分组、目录、UI 草稿/弹层 | 持久决定仍归 draft-session，账户 ID 不随分页漂移 |
| transaction-review | 核对项、历史候选、表单、原文 | 复用 inline-evidence；取消读不等于取消已发命令 |
| posting-flow | 最终摘要、入账按钮、成功事实及明细刷新 | 不管理第二份 postFlight |
| presentation / 必要的 model | 纯展示转换 | 不读写会话，不把原始全集放入 data |

busy、currentIssue、待应用后台视图在 P0 逐项指定 owner。流程显式申请共享变更，不互相偷偷清空，过期 finally 不解锁新操作；不把全套 page/state 作为万能上下文跨模块传递。

读响应检查用户会话、页面、批次、视图版本和局部令牌；失效停止渲染。写响应先按原命令协议确认或保留原请求恢复，再决定页面是否显示。验收必须包含“已发入账 → 离开页面 → 服务端成功 → 原请求恢复 → 重新进入已入账”，不得生成第二笔入账。退出登录仍按原隔离/清理规则，不为回执跨用户写状态。

拆除 enhance：P0 完整列覆盖/生命周期/绑定/定时器；P3 先显式装配生命周期与请求适配，保留 this/回调/主题/登录顺序；P4 每迁一流程就删旧覆盖，最后 enhance 为零。实例状态按页面创建，不做模块单例。boundedSetData 只包装一次，view-patch 差异更新保留；编辑时延后投影、关闭后应用、同层原文/重试和写成读失败的展示不变。

## 4. 一期新增的有限减法

### 4.1 文档收敛

P0 修订现有根 README、docs/README 及实施规划的 MINI-1915 当前条目：入口仅保留定位、稳定结构、启动/安全方式和指针，不再维护多份“当前阶段/部署版本/测试总数”。不能把本期尚未完成写成现行实现。任务状态与证据落到既有实施规划/任务记录，specs 负责边界与验收，交接只指向规格。

发现过期事实时区分历史证据与现状：历史保留日期/SHA及链接，当前状态以实际记录核对，不猜版本。小修只更新受影响文件，不机械新增多份模板；不大搬历史目录、不破坏链接、不删迁移/审计记录，不新建第二个状态台账。

### 4.2 相关测试整理

范围只含本期触及的导入、页面、规则及缓存测量测试。P0 为拟删除/合并项记录保护目标与替代入口；先补行为验证，再移除纯内部位置/表达式约束的重复断言。真正保护布局、可访问性、禁用门禁和 WXML 绑定的静态断言仍可保留。

不能按测试数删减、全库替换框架或为绿色结果放松断言。复用 test/helpers/paged-workbench 等真实入口辅助；身份、金额、来源关系、回滚/幂等、历史核对、恢复、分页和隐私正反用例不能丢。替代测试先在正确基线上通过，并用对应错误输入/受控行为破坏证明其能捕捉原风险；不需要新建全库变异测试平台。

### 4.3 缓存：必做测量，条件性改代码

仅检查客户端现有链路 `catledger-api → read-cache/read-policy/read-metadata/read-snapshot-store` 及其页面使用者；复用 read-observer 和测试记录，不新增遥测系统。import-view-session/draft-session 的职责仍按第 3 节保留，不把它们合并进普通 API 缓存。

基线代码中 tag 参与写屏障/局部失效，全局 dataRevision 用于跨响应的新旧判断，持久快照只展示而非账本权威。不能从两处都标记 dirty 就推断可以删一处；写前/写后失效、knownRevision/unchanged 的完整响应恢复和前台验证也有不同语义。

| 必测场景 | 必须记录/验证 |
| --- | --- |
| 冷启动、同页热读、tab 往返 | 命中/展示快照、请求/响应字节、派生/setData 次数，不把旧快照冒充新鲜数据 |
| 同 key 并发与迟到旧读 | 去重次数、tag/revision 前后、旧结果拒绝、订阅/回调执行次数 |
| 写后返回、写失败/超时重试 | 原读屏障和失效时机、正确重读、原命令恢复，不吞错误或制造第二次写入 |
| 重新前台、换用户/环境 | 原重验/新鲜度窗口、隔离与快照清理，旧响应不污染新会话 |

只接受可证明等价的局部冗余消除，例如相同有效上下文中重复订阅/调度/派生/刷新；先证明“去掉哪一步仍保留所有必要副作用和回调”，不能按例子直接删除。每个候选必须有触发、原开销、保留路径、前后计数、行为回归及回退；不能通过绕过 organize/历史核对/锁内复查节省请求。

不改服务端 revision/公开协议、快照 schema、新鲜度/TTL/前台策略；不新增 SQLite、Redis、离线库、缓存层。保留 force、knownRevision/unchanged、写屏障、身份/环境隔离及恢复语义。需要重做一致性协议或跨端改造就退出本期，写后续判定。没有安全收益时输出“测量完成，保留现状”，不是缓存优化失败，也不是性能提升证据。

文件所有权在 P0 登记；实际缓存小改放在 P5 单独提交，不能与导入搬迁或测试删减同时做。无证据的条件项不阻塞其他已验收职责交付。

## 5. 验证、来源范围与一期出口

| 风险 | 既有入口（相对根目录） | 本期重点 |
| --- | --- | --- |
| 语义/身份/同额独立 | `cloudfunctions/catledger-import/test/{row-semantic-resolver,organizer-planner,semantic-safety,bank-parser}.test.js` | 纯规则结果及来源归宿 |
| 旧计划/人工覆盖 | `cloudfunctions/catledger-import/test/semantic-plan-upgrade.test.js`、`test/import-draft-session.test.js` | preserveReferences、semantic 来源、掩码与原请求 |
| 历史核对 | `test/import-history-review-db.test.js`、`test/import-history-review-ui.test.js` | 先恢复再同步、候选变化、同笔/不同笔、锁内复查 |
| 保存/账户分组 | P0 查明现有相关测试 | 单笔/批量差异、引用/冲突、分组无候选与重复运行、收尾次数 |
| 正式入账/分期 | `cloudfunctions/catledger-import/test/finance-update-posting.test.js`、`test/{explicit-repayment,loan-sources,installment-flow-db}.test.js` | 回滚、幂等、来源及费用只计一次 |
| 银行/单文件 | `test/bank-import-db.test.js`、`test/import-bank-mapping.test.js` | 上传/映射恢复与失败隔离 |
| 页面/原文 | `test/{import-paged-workbench,import-inline-evidence,import-recovery,import-account-choice,import-account-compact}.test.js` | 真实 Page、this/回调/生命周期、迟到读和持久写恢复 |
| 资源与缓存 | `cloudfunctions/catledger-import/test/performance-v2.test.js`、`test/import-paged-workbench.test.js`；普通缓存测试由 P0 定位 | 硬预算+实际开销，第 4.3 节场景及条件项证据 |
| 项目交界 | `test/{runtime-roles-db,data-export,read-revision-db,transaction-management}.test.js` | 权限、导出、修订、维护和其他功能 |

前后比较优先固定既有测试 ID/时钟注入；否则生成 ID 统一一一映射并保留全部关系/外键，不删 ID 或随意排序掩盖错绑。业务日期、金额、账户、状态/原因、版本、错误码及确定性身份键/摘要保留。

[performance-contract.js](../../cloudfunctions/catledger-import/src/performance-contract.js) 是现有硬预算入口：请求 64 KiB、回执 32 KiB、摘要 64 KiB、分页 256 KiB，SQL 按原参数/字节分块。已有页面测试检查单次 setData ≤64 KiB、data ≤256 KiB；view-session 最多 3 个响应页、8 个历史游标；24990 条合成批次不驻留全集。它们是现有条件，不代表所有生产场景已经实测。

同时比较实际 SQL/云请求/字节/派生/setData，不接受无解释增长。耗时记录同环境与冷/热条件，不凭单次墙钟承诺提速。金融异常按实际规模计数，不隐藏额外查询。P1-A 验证规则/消费者加载/边界；P1-B/P2 受影响数据库与事务；P3/P4 页面/原生合成；缓存条件项独立验证；P5 全量工程/单元/隔离数据库及精确 CI。具体命令以根 package.json、scripts/ 和 verify.yml 为准，记录本地与 CI 环境差异。

来源规则默认仅审计：银行身份冲突全链路和收入/支出/退款/费用/借款/还款/转账/余额调整/未知方向回退分别记录。不强行合并不同回退；改变语义/字段/摘要/版本退出本期。两函数 repayment-booking、installment-items 维持既有一致性与独立打包，不加跨包 require 或私有包流水线。不可变分录、影子双写、历史回填、未来情景/AI 不作为本期前置，不自动执行。

一期验收必须能展示：公共反向依赖解除、enhance 为零、状态 owner 明确、公开入口及业务图等价、文档只有一个当前状态入口、相关测试保护目标未减、缓存有测量/判定、资源不退步。缓存没有代码改动须如实写“保留”，不能用文件数量或删代码数量替代上述结果。

## 6. 协作与回退

Astra 单一协调公共契约、事务/幂等、页面共享状态及缓存；沿 `codex/mini-1915-import-modularization` 一个任务分支，以小提交分段。先核对实际工程路径与本机未提交修改；必要时隔离 worktree，不强切用户主目录、不覆盖并行成果。

每个变更列原职责、消费者、行为证据、资源差异和剩余风险。后续依赖前项时按逆依赖正常 revert，不声称能任意撤回前置而继续运行；不清数据库、不删草稿、不 force push。文档/测试/缓存各自可回退，不用巨型提交打包。

当前为一期计划整合；Astra 收到用户转交指令后按其范围实施/验证/提交/推送。未另授权不合并 main、不部署、不迁移云数据库、不新增云资源、不上传/审核/发布或写真实账目。交付候选不等于用户主目录或手机已更新；必要验收缺失时标明待验收。
