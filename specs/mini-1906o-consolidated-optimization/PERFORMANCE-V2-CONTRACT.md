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
