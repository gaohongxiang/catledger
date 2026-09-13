# PERF V2 读取与回执契约

本契约由 PERF-0 冻结，接线与验证事实只记实施规划 0.5。

## 读取

- `financeUpdates.summary({updateId})`：`protocolVersion=2, update, viewVersion, sources, coverage, posting, totals, issueCounts, freshness`。只投影汇总；完整逐行覆盖校验仍在正式写屏障内。
- `economicEvents.list({updateId,viewVersion?,cursor?,pageSize?,status?,issueId?})`：`protocolVersion,viewVersion,items,nextCursor,total`。稳定 `event_id` 键集；摘要提供全量计数，页面不从当前页重算总量。
- `reviewIssues.list({protocolVersion:2,updateId,viewVersion?,cursor?,pageSize?,status?,issueType?})`：相同页封装，按 `issue_id` 排序。问题不嵌入全部成员 ID。
- `reviewIssues.members({updateId,issueId,viewVersion?,cursor?,pageSize?})`：成员页。整组命令使用 issueId + issueVersion + updateVersion，服务端解析冻结成员全集；部分选择最多100个显式成员，隐藏的未处理成员继续阻塞。
- `economicEvents.evidence({protocolVersion:2,eventId,viewVersion?,cursor?,pageSize?})`：证据元数据页；原始字段单独用 `economicEvents.detail({updateId,eventId,evidenceId?,viewVersion?,cursor?})` 分段读取。详情游标固定对象、版本及偏移，单段不超过16KiB字符预算，完整内容最终可重建。
- `financeUpdates.options({updateId,kind,cursor?,pageSize?,viewVersion?})`：账户、分类、账户草稿分别读取，禁止嵌入逐事件映射全集。

每个读取用一致性只读事务。HMAC沿用API可信 subjectHash 作为服务端签名密钥（不回显/不持久化到客户端），并绑定 uid、批次、批次版本、计划版本、活动领域版本、规范化筛选、排序及末项键。篡改/跨用户/跨筛选为 `INVALID_CURSOR`，版本过期为 `STALE_VIEW`；客户端清除旧页后重读，不能拼接不同版本。

页默认40、最多100，完整UTF-8 JSON≤256KiB；逐项加入前检查封装与下一游标预算。单项大字段改成明确 `detailRequired` 引用，不截掉原证据；读取详情可取得完整内容。回执≤32KiB、摘要≤64KiB、普通命令≤64KiB。旧完整视图只支持完整JSON≤256KiB；超限显式 `PAGINATION_REQUIRED`，不返回半批结果。

## 命令与恢复

`prepare/organize/refreshAccountGroups/resolveAccountMappings/resolve/post/undo/correct/abandon` 接受显式 `resultMode:'receipt'`。回执包含 `protocolVersion,receiptId,action,updateId,appliedVersion,status,counts,posting?,invalidates`，不附整个批次。回执保存与账务/草稿写入同一事务；同一requestId和内容重放得到原始操作结果，与后续账本变化无关。旧V1引用回执继续按旧协议解释，不伪造历史V2事实。

收到成功回执即确认操作成功；随后摘要或当前页刷新失败只表示“已保存/已入账，明细待刷新”。响应丢失使用原requestId查询/重放，禁止生成新ID自动重复入账。服务端保留当前用户锁顺序、最终版本/身份/账户/分类/退款/现金与证据守恒检查及整批事务。

## 性能门禁

五文件普通合成交易 n，C=ceil(n/100)：prepareUpdate ≤120+8C，resolveAccounts ≤120+12C，post ≤160+8C 条 SQL（含事务控制）。异常关系另报真实数量和调用次数；不得混入普通场景掩盖线性重复扫描。批量SQL最多100行、6000占位符、512KiB估算字节，仍在同一事务。1000/5000/24990分别测量，最终各至少3次。24990的三个核心阶段均≤20秒，post用户锁≤10秒；不因未达标放宽预算。

SQL观测只输出指纹摘要、源码调用位置、调用数/返回行数/耗时；不输出SQL正文、绑定值、账户或交易。CPU与堆内存指标为进程测量，不能冒充云端或真机延迟。

## 兼容与部署

先部署兼容旧客户端的后端，再更新客户端。能力探测只对UNSUPPORTED_ACTION降级；大批次旧服务显示需升级，不下载全集。回滚先客户端，V2回执与证据保留，迁移只前向修复。本次无云部署/云迁移/真实账本写入授权，先完成本地与CI，云端及真机另记未验证。

## PERF-0 本机测量证据

2026-09-13，交接代码cc2ed15a + 测量模块；macOS/Node24.14.1、独立Docker MySQL8.4、五份各200行业务合成文件，CPU profile开启，首次动作，非云端/真机。全量632项（根300/API97/import235）通过，0失败/跳过；静态522文件/101模块；两函数生产依赖审计0。

| 1000行阶段 | 毫秒 | SQL数 | SQL等待毫秒 | 用户锁毫秒 | JSON字节 |
| --- | ---: | ---: | ---: | ---: | ---: |
| prepareUpdate | 919 | 74 | 779 | 0 | 856615 |
| resolveAccounts | 2828 | 9034 | 2550 | 0 | 2440679 |
| post | 3047 | 6071 | 2803 | 3032 | 2448735 |

resolveAccounts热点为review-issue-service.createFollowUpIssue的存在性检查1000次/828ms；post热点为existingTransactionForEvent历史复用1000次/1386ms。CPU profile显示relation-resolver的候选比较值得在上限复核，不能将小规模采样外推为上限结论。观测器堆栈采集自身也有成本，耗时不直接替代无profile的历史基线。复现：`node scripts/benchmark-import.js --database --rows 1000`，环境保护不变；输出保存在本机临时日志，不提交原始数据。

PERF-1选择字段：`exclude_events.selection={mode:all|include|all_except,eventIds?:最多100个}`绑定issueVersion与updateVersion。未给selection表示完整问题组；旧eventIds在V2表示include且不能为空。部分排除只移出已排除成员并提升问题版本，余下成员仍保留阻塞问题；完整来源证据及事件均保留。其它决定作用于锁定问题的全部成员，不接受selection字段。账户归属批量命令V2必传updateVersion与每项issueVersion。

## PERF-1 本机证据

同环境1000条、无CPU profile：prepare 311ms/62 SQL/969字节；summary首读43ms/15 SQL/3731字节；账户归属2286ms/9022 SQL/982字节；事件首屏8ms/9 SQL/33590字节；post1553ms/6061 SQL/用户锁1535ms/1021字节。正式交易数1000完整保留。该批只解决传输和返回路径，逐笔SQL仍待PERF-2；不代表上限或云端验收。

本批全量634项（根300/API97/import237）全部通过，无失败/跳过；静态526文件/104运行模块，两函数生产依赖审计0。121成员反例验证分页无遗漏、部分排除后余下120成员仍阻塞、跨筛选/过期游标拒绝、长原文分段重建和后续入账后首次回执不变。


## PERF-2 执行证据

同一隔离MySQL8.4、五文件/24990条普通合成账单，2026-09-13单次无CPU profile：prepareUpdate 9411ms/1031 SQL/975字节；resolveAccounts 6998ms/1775 SQL/988字节；post 7127ms/1561 SQL/锁7096ms/1028字节。三个动作CPU分别6899/3288/2473ms；SQL等待4142/5859/6353ms；堆前后85→306、355→90、92→274MB（十进制，非峰值）。最终三次分布由PERF-5重新测量，不把此单次当最终门禁。

历史复用初版集合查询仍退化：EXPLAIN显示prior_evidence和linked选择PRIMARY且仅使用uid，24990测试在执行超过123秒时主动中止、整批回滚。修复后使用已有idx_catledger_event_evidence_update_event(uid,update_id)、idx_catledger_import_rows_identity(uid,identity_id)、idx_catledger_event_evidence_row(uid,row_id)、uk_catledger_event_transaction_role(uid,event_id)，保留STRAIGHT_JOIN规定起点。成员版本更新由反复扫描问题组改成一次读取成员后按主键分块，整理从14154ms降至6998ms。证据数量只GROUP BY event_id，不再GROUP BY大JSON。无需新增索引或迁移；EXPLAIN的估算基数不冒充实际行数。

复现：`node scripts/benchmark-import.js --database --rows 24990 --inspect-plan`。脚本强制本机*_test库，输出仅指纹/调用点/访问路径/计数；SQL正文、参数、原始账单不输出。核心SQL约为4C+31、7C+25、6C+61，均低于冻结上限；新增块字节与占位符门禁、第二块中断回滚及原请求重试断言。

PERF-2最终全量635项（根301/API97/import237）通过，0失败/跳过；静态528文件/105运行模块通过，两函数生产依赖审计0。


## PERF-3 提交与恢复契约

V2账务校验不减，完整展示不进入写事务。旧协议最大40事件/有效证据，事务中128KiB来源/目录保守检查；仅保存视图引用+appliedResult，提交后释放连接再读展示。最终旧响应仍限256KiB。提交后读取失败返回appliedResult并加refreshRequired=true/refreshError=REFRESH_REQUIRED，明确操作已成功；未升级的历史引用仍按旧语义读取。相同requestId内容不同仍冲突，V2回执在撤销后重放不变化。

PERF-3全量636项（根301/API97/import238）通过，无失败/跳过；静态528文件/105运行模块。新增故障验证使用真实隔离MySQL、connectionLimit=1，commit成功后模拟响应丢失并重放，三个并发相同post均返回首次回执；undo后无活动交易且原post回执不变。旧协议展示超时返回已保存状态，原请求恢复后可读完整小视图。

同环境1000条：prepare220ms/71 SQL/969字节，organize无变化4ms/8 SQL/970字节，resolve256ms/95 SQL/982字节，post237ms/121 SQL/锁216ms/1021字节。


## PERF-4 原生工作台读取契约

`imports.capabilities` 为经服务端身份校验的只读动作，返回 `protocolVersion:2/workbenchVersion:1/pageSize:40/resultMode:receipt`。新版首次 prepare 前探测；不支持时明确提示升级导入服务，不下载旧协议全集。恢复直接读取 summary，并保留旧计划 organize/账户归组 refresh 的显式版本检查。

summary 增加 `workbench`：账户步骤摘要、核对/分类标签计数、重复证据数、最终收支整数分汇总和受影响/新建账户数。成员与事件仍在服务端完整参与 coverage、ready 与阻塞判断，当前页不参与整批门禁计算。汇总从轻事件、开放问题成员 ID 与聚合查询生成，不调用 getUpdateView。

- `economicEvents.list` 增加 `view=active|review_pending|review_completed|category_pending|category_completed|category_none|expense`、`accountId`、`query`；与 status/nature/issueId 同时作用。账户过滤覆盖主/对手账户与付款、还款分配。
- `reviewIssues.list` 增加 `group=accounts|review|category` 与 query；账户包含 open/resolved，核对组排除账户/分类组。搜索在服务端匹配该组成员来源标题/交易对方。
- `reviewIssues.members/get` 增加 `memberKind=event|relation`；get 单独给出主体，候选翻页不会替换正在编辑的对象。
- `financeUpdates.options` 增加名称 query、单个 id、最多100个精确 ids；kind 扩展 new_accounts/affected_accounts，后者返回整批就绪事件关联数量。上述筛选全部规范化并绑定签名游标。

工作台实际入口为 `index.js` 的共享编辑控件加 `paged.enhance`：prepare/organize/整理使用小回执后读摘要；post 首先显示提交事实，明细读取失败显示“已入账，明细待刷新”。草稿在发送前保存 resultMode、requestId、updateVersion 和 issueVersion，恢复按原请求重放。已保存决定的摘要刷新失败不重新发送决定。普通待同步草稿显式限192KiB，请求限64KiB；达到上限提示先同步，绝不丢弃用户选择。

`import-view-session` 每个工作台最多缓存3个响应页，同查询合并、最多8个并行读取，每条分页历史最多8个游标；更早历史可回首页。主列表40项，成员/候选/证据8项，目录可搜索与分页并按ID保留选择，完整原文每段2048字符且不累计拼接进页面。超长预览显示省略标记，完整原始内容仍可分段读取。批量“不计入”显式 `selection:{mode:all}` 指向被冻结的问题组，不发送可见页ID；同银行批量辅助只列当前问题页，展示整组笔数并由服务器重验完整成员。

版本变化清除响应页；同步提示独立更新。同批次旧响应、关弹层、onHide/onUnload 和会话变化均设回填屏障。客户端不保存完整业务批次到 `_businessData`、草稿view、最终明细或证据私有数组。

PERF-4 本地验证：644/644（根309/API97/import238），无失败/跳过；静态533文件/106运行模块；两份生产依赖审计0漏洞。24990条工作台VM测量：主列表最大单次setData 13,410字节，page.data最大17,783字节；同版本重复同步0读取/0业务派生，当前页40事件、3页LRU。长字段、大组、末页、目录搜索、组决定与提交后刷新失败单独回归通过。数据为合成输入，VM数值不是原生设备/真实网络指标，原生检查和三轮服务器基准在PERF-5完成。


## PERF-5 验证与原文展示修正

V2传输字段、签名游标和2048字符分段保持不变。原生单段完整JSON是源列数组时，以列名/值显示；重复列有独立显示键，空值保持原文，跨段不解析或累计。原文与来源在同一滚动区，分页按钮在窄屏保持单行。实现 presentation.evidencePartFields/paged.changeEvidencePart，回归 import-paged-workbench.test。

入账原有FOR UPDATE权限契约补齐 import_rows 的最小 UPDATE(row_id)，不开放原文字段UPDATE；独立API/import角色实际执行121条跨块故障、并发、重放、撤销、余额/退款/统计和隔离反例。云端现有权限已只读核对满足。647项全量回归、三规模各三次、原生十页与实际合成入账结果见 [PERF5-ACCEPTANCE.md](PERF5-ACCEPTANCE.md)；真实云新版尚未部署，真机样本未完成。
