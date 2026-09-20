# MINI-1906O-READ 当前读取契约与测量口径

本文件定义单一协议与预算，动态状态仅在实施规划。基线代码 dbef581c（业务 080c9972），实际基线见 READ-BASELINE.json；观测补丁随 READ-0 提交。既有导入 V2 回执与分页不变。

## 单一接口

调用仍为 `{action,data}`；条件读取可在信封附 `knownRevision`（规范十进制字符串，不放业务 data、不接受 uid）。所有受缓存的 API 读取成功 `data` 包含 `readVersion:1, uid, dataRevision, unchanged`。`unchanged:false` 附该动作完整数据；`unchanged:true` 仅含元数据，表示本次同一个只读一致性快照的修订与 knownRevision 相等。无匹配完整本地快照时客户端必须用同一动作、不带 knownRevision 重读，不能当空结果或旧协议回退。

新增 `reads.validate`，data 为 `{}`；响应为 `{readVersion:1,uid,dataRevision,unchanged:false}`。前台恢复合并一次轻读取，以可信身份、用户 active 状态和修订为依据。它不返回账目、不作能力协商。修订未变仅可重新确认确属该修订的完整快照；不同修订结果不得重贴新标签。跨前台读取先共享校验屏障；变化时按需取当前页面。

所有缓存读取在单连接 REPEATABLE READ 只读事务内完成身份/修订和业务查询。元数据只能来自同一快照。写事务和业务数据同次提交递增 data_revision；幂等重放返回冻结结果而不递增。版本全程字符串。新旧客户端/云函数须协调到同一候选，部署切换单独授权；协议缺失/不匹配明确报错，无探测或 fallback。

`transactions.list` 首屏（无 cursor）必含既有期间/导入范围 summary；cursor 页完全省略 summary。签名游标携带 dataRevision 与规范化筛选摘要；版本不同报 `READ_SNAPSHOT_CHANGED`，客户端丢弃续页并重取首屏。摘要仍按原期间/日期/导入范围口径，不随搜索、账户、分类、来源筛选偷偷改变。持有基页 token 和相同修订才追加。

展示快照独立于 peek/isFresh；普通失效标脏，peek 仍只返回新鲜值。展示旧值需“正在更新/更新失败”状态；表单选择、余额判定、正式写入不从旧快照裁决。身份确认前禁止展示财务快照。

持久化键含环境、服务端确认 uid、结构版本、规范化动作/查询。最多 12 项/512 KiB，每项 96 KiB、期限24小时；只允许首页、目录、账户、分类、统计和有界流水（最多3页），不存原始证据。落盘在任务中合并排队，执行前再次核对会话与身份范围；单次存储使用有界同步操作，避免异步I/O在退出清理后反向写回。写失败降级内存；缓存清理仅操作专用键，不碰 pending-ledger-write。

## 优化前证据与预算

Apple M2 Max/macOS arm64/Node 24.14.1/一次性 MySQL8.4，回环 TCP，每规模3份；固定合成分布、4账户，包含转账、软删除、退款、贷款与导入关系。不宣称 p95。50,000行中位数：首页105.10ms、统计187.40ms、流水首屏64.92ms、第二页67.77ms。第二页仍1次 summary；同次样本首页102.15/103.22ms、统计176.95/179.29ms耗在 SQL；连接获取<0.1ms，身份<0.6ms，序列化<0.3ms。当前本机主要后端成本为聚合/列表SQL，不能推断真实云端网络占比。

真实页面逻辑的 VM 测量固定每次请求40ms合成传输等待：后台返回1次重读、贷款返回1次强刷；第二页最大setData23358B，第十页116439B。冷启动85.1ms含2次请求、写后84.4ms含2次请求；弱网2次尝试385.1ms，旧首页保留。以上均非手机耗时。

冻结验收预算：同会话命中0网络；未变前台仅1次合并校验、0聚合SQL；贷款已确认新鲜时0读取；流水第二页以后summary SQL=0；每次30行追加最大setData<=24KiB且不随既有长度增长；快照<=12项/512KiB/24h。相同环境三样本中位数以不退化超过25%为观察线（微秒级噪声不作硬门禁），第二页SQL耗时应下降；不能以提前显示旧值替代最新数据预算。

真机待验收预算（不是通过声明）：正常网络同会话恢复/交互目标200ms内，已确认身份后旧快照展示200ms内；冷启动最新数据2s内，未变前台最新确认1s内，写后最新数据1.5s内；弱网失败保留历史并明确未更新。应记录设备/网络/冷热状态及至少30独立样本后评估p95，未满足先分析分段而非延长TTL。

## 复现与隐私

在本机一次性MySQL设置 CATLEDGER_TEST_DB_*（仅localhost/127.0.0.1、名称以_test结尾）；运行 `node scripts/benchmark-reads.js --output=<指标文件>`。脚本每档创建并回收自己的库/角色，拒绝云地址。`--client-only`只跑VM。复用 performance-observer/query-plans；SQL只输出指纹/源码位置/次数/耗时，参数和响应不落盘。mappingAndOtherMs为扣除SQL/连接后的残差，包含映射、控制流和观测开销，不冒充纯映射CPU。

开发者工具可在隔离合成会话中启用 `require('services/read-observer').enable(true)`，使用 snapshot()取白名单指标；关闭后清空，最多300项。request为调用往返（含平台/网络/处理），setData回调为数据桥接代理；可见帧及真实交互另测，不伪造。

2026-09-21只读版本核对：主目录窗口实际为pages/transactions/index，主目录HEAD080c9972；手机包版本未取得。环境cloud1-d6gqxki3s97cc4ee9，RuntimeMode=nosql且mysql=true；本项目保持现有MySQL。API Active/Available、Nodejs18.15、512MB/20s、ModTime2026-09-20 21:56:33；import Active/Available、Nodejs18.15、512MB/60s、ModTime21:11:03。两者均$LATEST，平台详情未给源码SHA；这些不是候选已部署证据。未调用真实账本、未部署/上传。
