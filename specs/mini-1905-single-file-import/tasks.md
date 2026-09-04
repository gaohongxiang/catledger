# MINI-1905/1906 连续实施任务

- [x] 0. 冻结多账单统一导入设计
  - 对照 `origin/catledger-web` 的 importing、organizer、ReviewIssue、postability、posting、API、前端模型与测试场景
  - 盘点当前 MINI-1905 可保留基础、需扩展边界和临时简化层
  - 冻结领域状态、ReviewIssue 类型/决定、表、API、服务模块、回填和测试矩阵
  - 明确弱金额/时间/文本匹配只生成候选，不迁移为自动合并
  - _Requirement: R1-R7_

- [x] 1. 建立 `0006` 统一 FinanceUpdate schema
  - 新增 FinanceUpdate、Source、BatchIssue、Relation、EventTransaction、FinanceAction、ReviewIssue、ReviewIssueMember 表
  - 扩展来源档案、批次、原始行、EconomicEvent 与 EventEvidence，所有键、外键和唯一约束包含 uid
  - 保留并标记旧 decisions/postings/transaction links 的兼容用途，不修改 `0004`、`0005`
  - 实现已提交单文件回填与未提交临时投影可重建规则
  - 覆盖首次迁移、中断重跑、checksum、最小权限、孤儿关系、用户隔离和守恒检查
  - _Requirement: R2, R3, R4, R5, R6_

- [x] 2. 把单文件基础升级为多文件生命周期
  - 保留解析器、私有存储、身份摘要和恢复机制，实现 `imports.prepareMany/parseFile/getFile/discardFile`
  - 为每份选择保留独立顺序、幂等身份、摘要、错误、重试与清理状态
  - 保证单文件失败不污染其他文件，并允许用户重试或移除后继续
  - 扩展公共契约与文件阶段测试，不触碰正式账本
  - _Requirement: R1, R2, R6_

- [x] 3. 实现 FinanceUpdate 与统一 organizer planner
  - 实现 `finance-update-repository/service`，按 batchIds 冻结一个多来源更新并校验占用
  - 把原 planner 迁移为 Node.js 纯领域模块，生成 EconomicEvent、Evidence、Relation 和守恒计数
  - 迁移普通收支、手续费、转账、还款、退款、身份冲突、已有交易和分期来源门禁
  - 只对共享稳定引用或冻结官方强关系自动归组；其他近似匹配生成候选组
  - 计划持久化失败时整体回滚，原文件、批次和行证据保持不变
  - _Requirement: R2, R3, R5_

- [x] 4. 实现 ReviewIssue 与服务端 postability
  - 迁移 8 种 ReviewIssue、成员角色、原因优先级和“一事件一个打开问题”投影
  - 迁移 8 种解决决定、CAS、幂等 FinanceAction、证据移动、关系确认和后续问题生成
  - 实现统一 `EvaluatePostability` 等价模块，整理、解决问题和最终入账共用
  - 拒绝客户端直接提交 ready/posted/corrected，拒绝问题类型不适用的决定
  - _Requirement: R3, R4, R5, R6_

- [x] 5. 冻结并实现 FinanceUpdate 公共动作
  - 实现 `financeUpdates.create/organize/get/post/abandon`
  - 实现 `reviewIssues.list/get/resolve` 和事件证据按需下钻
  - 冻结 `economicEvents.correctionImpact/correct` 与 `financeUpdates.undoImpact/undo`，在 posting 后接入同一 Action/CAS 契约
  - 所有写动作使用 request digest、expected version 和用户范围幂等键
  - 更新 `shared/catledger-import.json`、服务端注册与客户端 service；`imports.commit` 仅保留为旧单文件兼容入口，不再由最终页面调用
  - 覆盖游标、公开错误、敏感字段过滤和契约漂移测试
  - _Requirement: R1, R3, R4, R5, R6_

- [x] 6. 实现整批原子 posting 与正式账本适配
  - 在一个 MySQL 事务中锁定完整 Update、事件、关系、账户、分类、原交易和 Action
  - 事务内重新执行 postability，创建普通收支、转账/还款双端与退款交易
  - 写入 EconomicEventTransaction 和必要行级审计链接，复用已有正式交易且不重复入账
  - 任一失败整体回滚；同键重放返回首次结果，提交不确定时安全恢复
  - 锁定账户后核对整批写入前后的现金余额；新增或加深负数时返回 `INSUFFICIENT_CASH_BALANCE` 并回滚全部正式写入
  - 提交后按来源执行文件清理，清理失败只进入 cleanup pending
  - 迁移 correction impact、posted 事件整批 rebuild、undo impact/undo 与 corrected/undone 状态；外部修改时拒绝静默覆盖
  - _Requirement: R3, R5, R6_

- [x] 7. 用 ReviewIssue 模型替换小程序整理页
  - 先保留登录、主题、上传恢复和支付工具候选基础；移除导入前调用 `accounts.createBatch` 的旧路径
  - 实现多文件摘要、独立失败重试/移除、账户归属、Issue 列表与证据详情
  - 每种 Issue 只展示服务端允许的决定；`same_event` 明确区分“同一笔/多笔独立”
  - 删除客户端复杂语义默认 skip 和逐行 post/skip 决定构造
  - 所有阻塞问题解决后才显示整批入账汇总与唯一确认按钮
  - _Requirement: R1, R4, R7_

- [x] 8. 迁移原测试场景并完成阶段验收
  - 保留当前解析、身份、存储、隐私、恢复和支付工具测试
  - 等价迁移原分支 FinanceUpdate、planner、ReviewIssue、postability、posting、并发和回滚场景
  - 新增安全收紧测试：金额/时间/文本或日期桶匹配只出候选，不自动合并
  - 覆盖旧已提交回填不重复、旧未提交重建、跨用户隔离和单文件失败隔离
  - 运行函数单元测试、MySQL 8 集成测试、根目录契约/静态测试、`git diff --check` 与 CloudBase 代码审查
  - 更新现行说明和实施规划；开发云迁移与函数更新已另行取得授权并完成
  - 临时 MySQL 8 已通过全量迁移、`0006` 重跑、旧已提交数据回填、API 与导入集成测试；开发者工具 WXML/WXSS 单文件编译已通过
  - 开发云已应用 `0006`、`0007`、最小权限并更新 `catledger-import`；真实微信身份模拟器业务闭环和真机验收仍待执行
  - _Requirement: R1-R7_

- [x] 9. 增加正式账本写屏障与整批放弃
  - 新增 `0007` 账户草稿和账户映射草稿表，全部主键、唯一键和外键按 uid 隔离
  - ReviewIssue 只写 FinanceUpdate 草稿；posting 同一事务物化账户、提升映射并写正式交易，失败整体回滚
  - 小程序提供新账户草稿编辑和常驻“放弃本批账单”，放弃后清空工作台并允许来源重新开始
  - 覆盖入账前正式账户/映射不变、入账后同时生效、放弃后正式数据不变和来源释放测试
  - 临时 MySQL 8 已执行 `0001`～`0007`，导入函数测试 40/40 通过
  - 把写屏障、放弃语义和“服务版本过旧”错误同步到需求、业务规则、逻辑说明、现行说明和公共契约
  - _Requirement: R4, R5, R6, R7_

- [x] 10. 修复开发云多文件持久化权限
  - 通过分阶段安全日志确认真实微信/支付宝文件均已完成下载与解析，失败点为 `persist_file` 的 `ER_TABLEACCESS_DENIED_ERROR`
  - 为两张参与 `SELECT ... FOR UPDATE` 的只追加关系表补齐最小 `UPDATE` 权限，不授予库级管理员权限
  - 固化运行账号权限清单，明确未入账的已解析文件可安全复用；再次解析时自动替换旧整理，不能按已入账重复处理
  - _Requirement: R1, R2, R5, R6_

- [x] 11. 未入账同文件重新解析直接替换旧整理
  - 同内容文件命中 `draft / failed / review` FinanceUpdate 时，在解析事务内写放弃审计并把旧更新标记为 `abandoned`
  - 复用不可变解析批次进入本次流程，不询问是否继续旧进度；已正式入账来源仍阻止重复入账
  - 删除小程序 `active_update` 状态、“继续”按钮与对应提示；响应不确定后的同请求重试回放首次替换结果，不重复写放弃 Action
  - 覆盖公共契约、页面模型和 MySQL 集成场景
  - _Requirement: R1, R5, R7_

- [x] 12. 恢复来源资金双端投影与原始证据下钻
  - 新增版本化支付宝/微信 source-funds projector，明确余额、余额宝、零钱、充值、提现和还款的双端规则
  - planner 同时读取正式映射和 FinanceUpdate 映射草稿；两端完整自动 ready，只为真正缺失的一端生成 transfer issue
  - ReviewIssue 解决后重算受影响的未入账资金事件，supersede 旧问题并保护手工字段
  - 增加 `economicEvents.evidence` 只读契约和小程序原始字段下钻
  - 小程序资金流转弹层改为只读已知端、只选择缺失端；补齐规则、契约、服务和页面回归测试
  - _Requirement: R3, R4, R6, R7_

- [x] 13. 统一账户身份、来源映射与用户决策分组
  - 用一个版本化 `AccountIdentity` 解析器区分跨来源银行卡和来源隔离的平台账户
  - 用确定性优先级裁决名称推断、历史映射、本批选择和事件手工端点，不再依赖数组覆盖顺序
  - 未匹配、已匹配、资金双端和冲突账户统一按 `AccountDecisionGroup` 生成一个账户归属项，保存时展开到全部精确来源引用
  - 升级 organizer / ReviewIssue 版本，使未入账旧计划自动重建
  - 先运行同一卡跨三来源已匹配重复、跨平台不误合并、无尾号不误合并和同级冲突回退的最小测试，再完成全量验证与文档同步
  - 仓储层返回全部映射事实，不再按查询顺序提前覆盖；planner、账户确认增量重算和整理处理共用一个优先级/冲突策略
  - 一次性 MySQL 8.4 执行 `0001`～`0008` 后导入套件 112/112，根目录契约与 UI 测试 75/75，`git diff --check` 通过
  - 下线旧单文件 commit/逐行 post-skip、分离 create 和单项账户修改的公共入口，只保留一个 FinanceUpdate 写入模型；历史表与内部代码继续兼容既有数据
  - `catledger-import` 已仅更新代码并复核 `Active / Available`，运行时、超时、内存、VPC、环境变量和公网配置不变；体验版 `0.19.17` 已上传并推送手机预览
  - _Requirement: R4, R6, R7_

- [x] 14. 区分真实账户与支付平台合并还款引用
  - `AccountIdentity` 只接收花呗、具体机构信用购等原子账户；支付宝`花呗｜信用购`标记为 aggregate，不创建第三账户或历史映射
  - 资金投影保存本批真实负债候选，ReviewIssue 支持全部归入一个账户或按整数分拆分，并验证账户类型、唯一性和金额守恒
  - posting 将一个聚合还款事件投影为多笔正式内部转账并逐笔回链，整批锁定、回滚、撤销和重复判断覆盖全部交易
  - 小程序只在聚合还款问题中显示轻量分配项；普通花呗消费、具体信用购消费和普通单账户还款交互不变
  - 先用最小失败测试复现“错误创建第三账户”，修复后原样重跑，并覆盖分类、规划、分配、投影和跨端金额计算
  - _Requirement: R3, R4, R5, R7_

## 执行门禁

- 用户确认本任务计划前，不开始任务 1。
- 任务 1 的 schema、状态和公共契约由当前主负责人串行完成；迁移冻结前不并行修改依赖模块。
- 后端任务 1～6 和范围测试通过前，不开始任务 7 的页面替换。
- 用户已明确确认本轮开发云函数与小程序体验版部署；仍不提交、不合并、不推送，不提交微信审核或正式发布。
