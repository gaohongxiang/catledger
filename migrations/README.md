# migrations

这里保存 CloudBase MySQL 的显式迁移。迁移从 `0001` 开始，编号连续、forward-only、可重入，并由 `catledger_schema_migrations` 校验文件 SHA-256。

首版迁移建立用户、微信身份摘要映射和默认分类表。`0004`～`0005` 建立单文件解析证据链与支付工具规则；`0006` 新增 FinanceUpdate、跨来源关系、ReviewIssue、FinanceAction 和整批 posting，并把旧已提交单文件回填为只引用既有交易的历史更新；`0007` 增加 FinanceUpdate 内的账户映射草稿，确保整理阶段只写导入域草稿；`0008` 让同一草稿表以 `mapping_action` 安全表达账户映射或永久忽略，并继续保证正式规则只能随整批 posting 事务一同生效。MySQL DDL 会隐式提交，因此迁移必须使用 `IF NOT EXISTS` 或 `information_schema` 守卫；迁移记录只在全部语句成功后写入，失败后修复环境并重跑，不修改已经登记的迁移文件。

本地执行入口是 `cloudfunctions/catledger-api` 下的 `npm run migrate`。连接信息只通过 `CATLEDGER_DB_HOST`、`CATLEDGER_DB_PORT`、`CATLEDGER_DB_USER`、`CATLEDGER_DB_PASSWORD`、`CATLEDGER_DB_NAME` 环境变量提供，禁止提交真实值。

回滚首版 schema 会删除用户、身份映射和分类数据，只允许在无业务数据的开发环境人工执行；生产环境使用后续 forward-only 迁移修正。

## 运行账号最小权限

迁移账号与云函数运行账号必须分离。`catledger_app` 仍按实际 SQL 授予最小权限，不授予库级管理员权限。除直接写入的表外，下列能力也必须显式纳入运行权限契约：

- `catledger_finance_update_sources`：表级 `SELECT, INSERT, UPDATE`；
- `catledger_import_rows`：`SELECT, INSERT`，以及最小列级 `UPDATE(row_id)`，供入账的 `SELECT ... FOR UPDATE` 锁读取；不授予原文字段改写权限。已有表级UPDATE的账号也满足锁读取契约，本轮不自动改变云授权；
- `catledger_review_issue_members`：既有 `SELECT, INSERT, DELETE`，并仅对 `object_version` 增加列级 `UPDATE`；
- `discarded-update.js`的8张派生/草稿表：表级`DELETE`，用于回收abandoned批次。

来源表的UPDATE用于MySQL的`SELECT ... FOR UPDATE`锁定读取；应用代码仍不得改写既有来源。ReviewIssueMember的列级UPDATE用于账户归属批处理保存事件后同步乐观并发版本，缺少时resolveAccountMappings整体回滚并返回ER_COLUMNACCESS_DENIED_ERROR。部署或迁移后必须执行运行权限检查：可在VPC可连接环境以应用账号运行`npm run check:db-permissions`，或由管理SQL读取`SHOW GRANTS FOR 'catledger_app'@'%'`，将原始授权行交给同一`assertRuntimePermissions`检查；随后用真实微信会话核对云函数读取。0012后撤回退出旧表的授权，不得只验证表存在和函数Active。

PERF-5新增 `test/runtime-roles-db.test.js`：每轮独立库、12个迁移及重跑，API/import两个表/列级DML账号运行真实handler，覆盖121条跨块失败回滚、并发回执、身份隔离、余额统计、退款、撤销和废弃清理。DDL、正式交易物理DELETE、成员身份及原文列UPDATE的反向拒绝同步验证。清单在 `scripts/runtime-role-grants.js`；默认进入 `npm run test:db`。云端现有账号只读授权检查通过；本机成功不代表已部署新版。

## 0011 用户UID缩短



`0011_short_user_ids.sql` 在原29张用户业务表上完成一次UID值迁移，列仍保留CHAR(36)容量，主键、唯一键、外键及运行账号权限不变。先部署使用`crypto.randomInt`生成10位UID的catledger-api，再用迁移账号执行。执行器支持标准`DELIMITER`指令，`CREATE PROCEDURE`和`CALL`各作为完整语句发送；临时过程使用SQL SECURITY INVOKER，运行时云函数账号不增加迁移权限。

临时过程复用`catledger:schema-migrations`连接锁，在单事务中锁定身份/用户行、为旧UUID分配互不冲突的10位数字、更新所有uid列，并显式保持ON UPDATE时间列原值。原10位ID直接保留。仅当前连接暂时关闭即时外键检查；提交前检查所有表UID覆盖并逐个验证全部外键。重新开启foreign_key_checks不会自动检查历史行，因此不能省略逐约束验证，参见[MySQL外键文档](https://dev.mysql.com/doc/refman/8.0/en/create-table-foreign-keys.html)。任何错误回滚整个数据事务，恢复连接设置、释放锁并删除临时映射；重跑已经完成的迁移不会重新编号。

对象路径、文件ID、幂等结果、摘要、业务实体ID和版本不改变。已有私有对象仍由迁移后的uid找到导入记录，并按其存储的精确路径校验；新上传路径使用新uid签发。切换期间已开始的写事务先完成；尚未取得用户外键锁的旧请求可能整体失败，刷新后用原requestId重试。部署回退可退回兼容字符串UID的函数代码；数据不倒迁旧UUID，必要修复继续用后续forward-only迁移。

验证入口：API `test/helpers/short-user-id-migration.js` 通过现有 `integration.test.js` 注册，包含29表非空合成账本前后逐项比对、已有短ID稳定、重复执行、存储路径、两套导入流程幂等重放、跨用户隔离、外键故障回滚、分配冲突及并发写入排空。`test/migration-runner.test.js`覆盖存储过程分句。开发云执行前后只能记录汇总校验结果，不输出旧新UID对应或业务明细。

0011早期执行记录：2026-09-10两种执行方式曾发生连接中断，并与实例内存告警、近期重启重合；后续已按下述分段契约完成开发云切换。`short-user-id-native.js`为同事务原生连接适配器，本地完整迁移回归5项通过；运行`CATLEDGER_TEST_NATIVE_UID_MIGRATION=1`可切换现有API迁移用例。匹配云端资源与数据规模的验证完成前禁止直接重跑，当前状态与证据见规划MINI-1904F。


MINI-1904F 当前执行契约修订：受0.5核实例的内存限制，云端旧UID采用维护窗口分段迁移。先持久化加密的旧/新UID映射至一次性函数私密配置，再锁定既有catledger_app账号并确认其现存连接为0，之后才开始每段最多128行提交，包含大体积结果的catledger_mutation_receipts每段仅1行；在全部29表UID覆盖及72个外键验证通过、0011校验和登记之前，不恢复业务账号。单次失败仅回滚当前段，已完成段依据固定映射幂等续跑，维护锁保持；不能把中断当作可恢复访问。外部业务在整个维护期无法读取中间状态。恢复访问后删除函数、临时账号和加密映射，不留下第二身份。实现入口migrations/short-user-id-native.js的commitChunks/fixedMappings，默认模式仍保留全事务；维护模式中断恢复及其余回归在0.5核/1GB隔离MySQL共6项通过。该修订替代先前云端必须单个大事务完成UID迁移的执行方式，不改变正常账单整批入账原子性。


2026-09-10最终开发云切换已完成：1个旧用户改为10位UID，29表79944行的数量与迁移前一致且UID格式全部通过，72个外键验证通过；账户、分类、正式交易及用户表非UID字段和可信身份归属聚合指纹与迁移前完全一致。0011原checksum已登记。真实微信会话已确认10位UID、页面显示与app会话同值、无加载错误。catledger_app已解锁，临时函数/账号/存储过程均已清理。缓存调整尝试未生效，最终仍为原256MB；未扩容或购买。 分段执行曾在大结果表中断，固定加密映射保证前22表不重做；将该表改为每段1行后续跑完成。6项原生迁移回归（包括257行分段边界、维护中断恢复）在0.5核/1GB MySQL通过，前序583项全量回归结论保持。Git未提交、合并或推送，小程序未重新上传；主线和真机仍待验收。


## 0012 导入存储精简

开发版直接替换旧导入结构：已有旧单文件正式交易/来源一次回填到FinanceUpdate和EconomicEventTransaction；不为现代posted文件再建历史更新。删除import_decisions/import_postings/import_transaction_links/import_batch_issues，保留25张用户表。解析不再写旧初始事件。所有导入回执转换为receiptVersion=1的小型value或finance-update-view/review-issue-view引用，去重键保持；API账本回执不变。abandoned更新只保留摘要、来源及动作，清理派生图和草稿，另删除update_id为空的旧事件与Evidence关系。

维护执行：先暂停应用账号并排空连接，核对旧链接可完整转入、正式账本/来源摘要及迁移checksum；按0012相同WHERE条件小批量压缩JSON、清理废弃明细，再完成SQL和迁移登记，验证25表、外键和数据后恢复访问。SQL每步可重入，DDL不可整体回滚；中断继续维护并重跑剩余条件，不能在新旧结构混合时开放应用。不需要新增迁移账号、临时函数或扩大整个schema权限。应用账号仅补齐两张账户草稿表的DELETE，并撤回退出4表的旧授权。当前小规格开发库按每条20行压缩回执、每条128行清理派生记录，最多16条独立SQL一轮、轮间3秒；出现连接中断先核对实例及剩余数量，再恢复剩余批次。不能把小批SQL组装成一个大事务。

回归：catledger-import/test/helpers/storage-compaction.js测试旧交易逐字段保留、关联重建、回执压缩、源行保留、4表退出、删表中途中断恢复与重复执行。云端核对只返回计数、摘要和结构，不输出真实账单内容。

开发云0012已于2026-09-11完成，25表、59组外键、12个迁移checksum、来源计数与5张权威表指纹均已验证；完整数量、资源中断恢复和真实微信会话证据见实施规划MINI-1906DB1。


`0013_loan_metadata.sql`：独立贷款资料；uid 范围主键和负债账户外键。仅新表，不推导/迁移已有账户余额或创建正式交易。当前候选只在合成隔离库验证，云端执行另需授权。


`0014_loan_payments.sql`：实际借还、逐贷款构成和 Transaction 关系。每用户活动正式交易唯一关联；保留已撤销批次和冻结贷款版本。原子金额/总账/本金校验在贷款服务，迁移仅建表，不推导既有真实交易或改余额。仅在本机隔离库验证；本机最小角色 DML 见 scripts/runtime-role-grants.js，不代表云权限已变更。


## 0015～0017 贷款来源、期次与导出

`0015_loan_source_maintenance.sql` 增加来源占用、被替换交易审计和付款更正关系；`0016_loan_periods.sql` 增加期次、计划修订和实际付款分配。仅建新表，不推导真实贷款或改写既有账务。

`0017_data_exports.sql` 增加用户 `data_revision`（初值 0）和每用户至多一个导出任务；修订随业务事务递增，临时任务不递增。云管理 SQL 若不保持会话，先查询 information_schema，再以等价单条 ALTER 执行缺失列，随后执行 CREATE TABLE；不得把 PREPARE 的会话变量拆到独立连接。全部结构核对成功后才登记原迁移文件 checksum。权限清单以 `scripts/runtime-role-grants.js` 为准，新增表只补必要 DML。用户已于 2026-09-14 授权本轮 0013～0017 云迁移和部署，执行证据另见实施规划 C1 收口记录。

`0018_loan_schedule_params.sql`（MINI-1908D）在 `catledger_loans` 增加 9 个结构化分期参数列（schedule_method/schedule_terms/measurement_kind/quote_type/rate_ppm/repayment_minor/fee_per_term_minor/fee_upfront_minor/first_payment_date）和 `ck_catledger_loans_schedule` CHECK（参数组同空同有、测算依据配对、installment 仅限 flat、一次性费用小于本金基准）。利率存 ppm 整数、金额存整数分，不推导或改写既有贷款、期次与账务。每列和约束均以 information_schema 守卫，可重入；沿用 0017 的 PREPARE 单连接执行约定。应用账号对 `catledger_loans` 为表级 DML，新列不扩权。已于2026-09-19在开发云执行并登记 checksum，见实施规划 MINI-1908D 记录。

`0019_user_nickname.sql` 为 `catledger_users` 增加可空 `nickname`，已有用户初始仍为空，由用户下次登录时确认一次；此后登录直接读取账号昵称，“我的”可修改。昵称不参与身份、唯一约束或账本归属。迁移以 information_schema 守卫，可在同一连接重跑；应用账号对用户表已有表级 `SELECT, UPDATE`，无需扩大权限。发布顺序为迁移、`catledger-api`、小程序客户端；前两项已于2026-09-20在开发云完成，小程序开发版按用户要求暂不上传，证据见实施规划。

`0020_explicit_repayment.sql`：增加实际还款确认明细；不回填或修改历史转账。复用现有付款及交易关系；待办由 active 且无贷款分配确定。API/import 最小权限与导出清单同步。云执行和部署状态以 MINI-1908E 任务证据为准。

`0021_installment_setup.sql`：贷款表增加可空 JSON installment_setup_json（原始本金、历史已还、分类、优惠）；先加 schedule_v2 CHECK 再删旧 schedule CHECK，保留旧参数约束，新增 JSON 结构/历史范围约束，一次性费用与原本金比较（旧 NULL setup 仍与本金基准比较）。information_schema 守卫保证可重入；已有资料、计划、实际交易不回填。部署顺序迁移→API→客户端；云管理 SQL 不保持连接时用核验后的等价单条 ALTER，全部校验后登记原文件 SHA-256。已有贷款表级权限覆盖新列，不扩权。验证见 installment-entry.test.js、runtime-roles-db.test.js；状态见 MINI-1908F。

`0022_category_hierarchy.sql`：分类增加可空 parent_id 与生成的 parent_scope，同用户同 kind 外键为 RESTRICT、自引用 CHECK，同级活动名称唯一；先加新唯一键再移除旧全局名称唯一键，每一步均以 information_schema 守卫。父级层数由持用户锁的服务校验；不回填分类归属或交易、不恢复停用分类。导出清单包含 parent_id；已有表级权限无需扩权。先迁移→API/import→小程序，云执行需另获明确授权；本地状态见 MINI-1909C。
