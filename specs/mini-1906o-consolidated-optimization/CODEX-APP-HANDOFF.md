# CatLedger 联合优化：Codex App 接手说明

> 唯一任务分支：`codex/mini-1906o2-catalog-loading`
> 主线基线：`main@a4e3fab7333ce5a52aa05c6902155e4c69757d5e`
> 目标：由 Codex App 在本机完成剩余实现、全量回归和微信开发者工具验证；不要再创建第二条长期任务分支。

## 1. 接手原则

1. 先读根目录 `AGENTS.md`，再读本目录 `README.md`、`docs/招财猫记账本实施规划.md` 的 0.1～0.6 与第19章。
2. 先执行 `git status --short --branch`、`git worktree list`、`git fetch origin`，不得覆盖用户或其他会话未提交改动。
3. 继续使用 `codex/mini-1906o2-catalog-loading`；每个边界清楚的小批次独立提交并及时 push，同步源码、契约、测试和文档，不要只推计划。
4. 当前远端只包含联合优化计划和一个尚未完整接线的 `catalog-service.js` 候选。不要把它当成 O2 已完成；先检查并接入现有服务注册、共享契约和客户端。
5. 不 force push、不重置 main、不部署云函数、不迁移开发云数据库、不修改真实账本。完成候选后先 push 任务分支并等待验收；合并 main、云函数部署和正式上传另行确认。

## 2. 为什么由 Codex App 接手

剩余工作跨小程序页面、两支云函数、共享 API 契约、MySQL 回归、导入领域规则和微信开发者工具。远程 GitHub 编辑会重复拉取/覆盖完整文件，而 Codex App 能在同一个本地 worktree 中完成代码、diff、测试、提交和开发工具验证，交接成本更低。

工程量按风险分成 4 个实现包 + 1 个本机验收包；不是简单页面微调。预计会触及约 20～35 个现有/新增文件，但应以最小实现为准，不为数量而重构。

## 3. P0：O1 账务正确性收口（发布阻断）

### 3.1 跨来源桥接误合并

已隔离复现的风险：同来源两笔独立交易 A、B，另一来源 C 与 A/B 共享一个稳定参考且核心字段兼容，当前 union-find 可通过 A↔C、B↔C 的传递关系把 A/B/C 合成一组。不能因为存在桥接节点就把两个同来源强身份折叠。

要求：

- 合并判定必须满足**整组一致性**，不能只依赖两两连通性；
- 同来源/Profile 中存在多个不同强交易身份时，默认禁止自动折叠，除非业务模型显式支持该多记录事件；
- 冲突要保留全部 evidence，进入可解释 ReviewIssue/人工核对，不能丢记录；
- 结果对输入顺序稳定；
- 合法的跨来源同一真实事件仍允许自动合并；
- 对仍处于 review 的旧 FinanceUpdate 做 plan/domain version 升级或显式重组，不能只修新批次；保留已有人工决定的规则必须继续遵守。

回归至少覆盖：A/B 无 C 时两笔；加入 C 仍不少记；合法跨来源同笔；同订单多次支付；同额同日独立消费；重叠导入；重复文件；顺序置换；正式 posting 前最终屏障。

重点入口：`cloudfunctions/catledger-import/src/evidence-matching.js`、`economic-event-builder.js`、`organizer-planner.js`、domain/plan version 及相关测试。

### 3.2 退款关系双向不变量

现有新增/更新退款会检查“退款不得早于原消费”，但修改已有原支出时需要同样反向保护。例：9月1日消费、9月3日退款，再把原消费改到9月5日，必须被拒绝或通过成组修正流程处理。

要求：

- 新增退款、修改退款、修改原消费、linkRefund、维护/更正路径使用同一语义；
- 原消费有效、同用户；退款时间 >= 原消费时间；累计退款 <= 原消费金额；
- 并发新增退款和修改原消费要使用一致锁顺序并覆盖数据库回归；
- 不允许通过普通编辑绕开已经存在的退款关系；
- 导入维护路径与手动账本保持相同最终不变量，但不要通过跨云函数目录 require 形成部署耦合。

重点入口：`cloudfunctions/catledger-api/src/transaction-command-service.js`、维护/更正服务及数据库测试。

## 4. P1：O2 轻量目录与“记一笔”即时可操作

目标：选择账户/分类不再依赖余额汇总和 `bootstrap` 初始化事务；页面打开后金额、日期、备注先可编辑，必要目录完成后才允许正式提交。

### 4.1 服务端

完成并接线 `catalog.get`：

- 可信微信身份解析；
- 一个一致性只读事务返回账户/分类目录；
- 账户只含 ID/type/nature/name/currency/version/archived，不查交易表、不算余额；
- 分类返回活动分类及需要的版本字段；
- 不在日常目录读取里执行默认分类初始化写入；
- 更新 `action-registry.js`、`index.js`、`shared/catledger-api.json`、契约测试与云调用安全重试白名单。

### 4.2 客户端缓存

拆分 `accountDirectory/categoryDirectory` 与财务余额/交易/统计标签：

- 普通交易写入失效余额/交易/统计，不使账户目录因金额变化失效；
- 账户新增/更名/停用失效账户目录；分类生命周期失效分类目录；
- 导入 posting/undo/correction 可能改变结构时保守失效目录；
- 同一会话单飞、写屏障、退出 reset、旧请求隔离必须保留；
- 不建立客户端权威余额，不持久化原始账单。

### 4.3 页面

`transaction-editor`：

- create 模式进入即展示金额/日期/备注等本地字段；目录未就绪时只禁用依赖目录的 picker 和提交；
- 目录晚到不能覆盖金额、备注、当前类型或用户已选 ID；列表重排按 ID 保留；选项消失时进入待选择，不静默切到第一个；
- 普通记账不提前读取 refundable，切到退款才读；
- 无账户时引导创建账户，返回后保留草稿；
- 保存/删除服务端成功后直接返回，移除固定 350ms 人为等待；
- 页面卸载、退出或新会话后晚到响应不能导航或回填旧数据。

中央记账入口：已登录打开入口时低优先级预取目录；失败不阻断导航；未登录不读取个人目录。

明细/我的/账本结构：使用轻量目录做筛选和数量摘要，不为了名称/数量计算余额；列表主体成功时目录失败不应清空已有交易。

导入/只读交易详情：已有交易内容先显示；仅编辑分类所需目录可以随后准备。

## 5. P1：O3 其他页面读取与响应一致性

- 统计历史月份不要为了当前趋势再次读取完整 `dashboard.get`；优先把趋势终点作为 statistics 明确读模型，或提供轻量 trend 查询。保持一致性快照。
- 明细快速连续搜索/筛选采用 request generation / latest intent：旧条件响应不得覆盖新条件，也不能因已有 `_transactionsLoad` 把最后一次用户操作吞掉。
- 分页写入发生时继续保持现有“重读首屏而不是拼接旧分页”的保护。
- 账户/分类修改成功后可基于服务端返回实体做局部更新，但冲突/失败仍回读权威状态；不要为减少请求牺牲版本检查。
- 不要为了优化页面在启动时预取所有数据；只预取高概率下一步、体积小的目录。

## 6. P1：O4 导入恢复与大批次性能

在不削弱原子 posting、草稿持久化、幂等和证据可追溯的前提下：

1. `financeUpdates.get/organize/refreshAccountGroups`：让返回视图带有可判定的新鲜版本；账户目录/规则未变化时避免恢复时无条件再次刷新分组。
2. 重复记录页：不要进入 tab 后对每个候选逐个 `economicEvents.evidence` 才显示列表。摘要返回可靠 `duplicateEvidenceCount`，完整 evidence 在展开单条时按需读取；必要时做受限批量接口。
3. `applyUpdateView`：区分业务 view 变化与 draft sync 状态变化。同步中/待同步数量变化不要重新计算全部 `eventView`、分类卡、review groups、funds flow、final summary。
4. 大列表只把当前步骤需要的数据放入 page data；保留现有 `setChangedData`，同时减少 setData 之前的全量派生计算。
5. 近 5 文件、数千行和允许上限场景记录服务端阶段耗时、SQL 次数/锁时间、返回大小、客户端派生计算与 setData 大小；日志不得记录金额、账单原文、OpenID 或完整账户信息。

## 7. 完整验证门槛

每个小批次先跑对应定向测试，再跑：

```bash
npm ci --prefix cloudfunctions/catledger-api
npm ci --prefix cloudfunctions/catledger-import
npm run check
npm run test:db
npm run audit:prod --prefix cloudfunctions/catledger-api
npm run audit:prod --prefix cloudfunctions/catledger-import
```

数据库回归使用隔离测试库，不使用真实账本。GitHub Actions 当前使用 Node18/MySQL8.4；Node18 已进入 EOL，运行时升级另做兼容性验证，不能把本轮业务优化和未经确认的运行时切换绑在同一提交。

GitHub CI 全绿后，再使用本机微信开发者工具：

- 确认打开的是任务 worktree，不是旧 main；
- 编译全部页面，无 WXML/JSON/组件错误；
- 已登录打开“记一笔”立即能编辑金额；目录慢载/失败不清空草稿；
- 连续记账不重新计算账户目录；账户/分类变更后目录能正确失效；
- 切退款才读取可退款支出；
- 新建账户返回编辑器保留草稿；
- 首页/明细/统计/我的来回切换无明显白屏或错误闪烁；
- 导入恢复、重复记录展开、大批次滚动不出现状态覆盖。

真机只做开发者工具无法证明的最小集合：键盘/焦点、前后台、弱网/断网恢复、触摸滚动、真实云调用延迟。性能指标必须标明设备、网络、冷热状态；“可输入 P95 ≤ 300ms”是目标，不是既成事实。

## 8. 文档与状态

行为变化按 `AGENTS.md` 更新：用户需求/业务规则/架构设计/入账逻辑说明/现行说明/实施规划。不要把“候选、mock 通过、开发者工具通过、真机通过、已部署”混写。

完成时至少报告：

- 最终任务分支和 commit SHA；
- 各提交范围；
- 根测试/API/import/DB 测试实际数量与失败/跳过；
- GitHub CI run；
- 微信开发工具与真机分别通过/未通过项；
- 未部署项；
- 仍阻止合并 main 或正式发布的问题。
