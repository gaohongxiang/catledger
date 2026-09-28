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

`test/runtime-roles-db.test.js` 每轮使用独立库、当前全部迁移及重跑，API/import两个表/列级DML账号运行真实handler，覆盖跨块失败回滚、并发回执、身份隔离、余额统计、退款、撤销和废弃清理。DDL、账户/分类/文件/身份/审计DELETE、导入账号正式交易DELETE、成员身份及原文列UPDATE的反向拒绝同步验证。清单在 `scripts/runtime-role-grants.js`；默认进入 `npm run test:db`。本机成功不代表云端权限已调整或新版已部署。

### 普通账目永久删除的权限增量

不改变表结构，不追加空迁移，也不修改已执行迁移。API运行账号仅增加 `catledger_transactions`、`catledger_economic_event_transactions`、`catledger_review_issue_members` 三张表的 `DELETE`，分别用于普通账目与专属引用；其他表不扩大权限，来源原文、审计和贷款保护保持。已有事件原因、事件版本和批次版本列级UPDATE继续复用。若两函数共用运行账号，以实际共享账号授予此最小增量，不授予库级DELETE/DDL/GRANT OPTION；独立import账号仍无需正式交易DELETE。

[授权SQL生成脚本](../scripts/print-permanent-delete-grants.js)只输出明确库名、账号及host对应的三条GRANT，不连接或执行。运行步骤见[开发与验证](../docs/开发与验证.md#7-迁移与部署需另有授权)。隔离库验证重复执行无副作用及其他权限仍拒绝；线上授权、双函数部署和客户端发布须另行授权。本次不清旧软删除记录，也不改变导出结构版本。

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

## 0026 贷款费用生命周期

`0026_loan_charge_lifecycle.sql` 新建五张表：稳定合同 `catledger_loan_charge_contracts`、收费与覆盖/抑制 `catledger_loan_charges`、账单来源 `catledger_loan_charge_sources`、实际清偿 `catledger_loan_charge_allocations`、只追加审计 `catledger_loan_charge_audit`。所有主外键、唯一约束均含可信 uid；收费键独立于金额、请求号、方案版本和管理 loanId，交易唯一认领。迁移只有可重入 DDL，不改既有账目、不回填授权、不补历史费用。旧进度兼容由读模型保留原值并标待核对，不在迁移中伪造付款。

合成隔离 MySQL 8.4 已验证重跑、权限拒绝、并发/失败回滚和两库恢复。2026-09-26用户追加授权后，开发云 MySQL 8.0.30-cynos 已完成0026：迁移前快照10729885成功且可用，0001～0025原校验和一致，5表42列、12组外键、10个主键/唯一约束及9个强制CHECK核验通过后登记 `d269d885fae022d8385ded857192c528c8b8680a95238e36207b520c9c4895ca`。最终0001～0026全部校验和一致；较早章节的“待云执行”属于当时阶段记录，以此现状为准。

此次执行顺序为备份与既有校验和核对 → 0026结构及校验和登记 → 按 `scripts/runtime-role-grants.js` 补齐既有共享运行账号 `catledger_app` 的5张新表必要权限（审计仅 SELECT/INSERT） → 先import后API更新代码 → 核对Active/Available、配置指纹与原生真实会话。两个函数源码为 `e3f31af838e3d5defe176f56c83ec60431460428`，运行时、VPC、环境变量和触发器保持；200项运行权限要求核对通过，未授予库级DML、DDL或GRANT OPTION。原权威表聚合指纹一致、新表全部为空；无默认授权或真实账目写入。详细发布与只读验证见[实施规划](../docs/招财猫记账本实施规划.md)。客户端预览/真机验证后仍需另获上传发布授权；迁移前不能运行依赖新表的函数，两个函数不能长期混用新旧收费防重逻辑。

DDL 隐式提交，中断不能假定全部回滚；保持维护状态，核验已建对象后用同一 checksum 脚本重跑，全部成功才登记。绝不运行时自动建表或给云函数 DDL 权限。

回退优先将 `CATLEDGER_LOAN_SYNC_DISABLED=1` 配在 API 以停止新费用同步，保留原成功回执可读/可重放；必要时暂停客户端写入口。已产生收费后，保留兼容的 API/import 依赖校验及五张表，不删除费用、授权、覆盖、审计，也不能直接退回会忽略新关系的旧写入函数。修复用后续 forward-only 迁移/兼容代码。业务更正通过签名预览、依赖复查和原请求完成；真实退费是退款，取消未来计划不是退款。客户端可回退为兼容只读界面，不能借回退开放旧普通编辑/删除绕过保护。

完整导出 schemaVersion 26 包含上述非空关系，隔离恢复按原ID先父收费后覆盖子项，外键保持开启。导出/恢复测试不是生产一键恢复能力或真实恢复授权。状态与 L01～L18 证据见[实施规划](../docs/招财猫记账本实施规划.md)。

## 0027 历史费用与余额保全

`0027_installment_history_balance.sql` 仅给收费表增加可空 `balance_adjustment_id`、用户范围唯一键及指向交易的同用户外键。已有表级权限足够，不扩大运行账号权限；所有步骤以 information_schema 守卫，可重入。迁移不回填或操作真实账目，不自动选择历史已还。

历史已还保存时，缺失费用在原月记于贷款账户，配对的同额余额调整保全当前余额；来源复用不新增一对。费用和配对调整由收费关系保护，调额/撤回同步维护。完整导出升为 schemaVersion 27，成对记录及关系已加入双库恢复验证。

发布顺序：安全快照及0001～0026校验和核对 → 执行0027并核对列、唯一键、外键（直连使用同一连接；仅支持单语句的管理SQL先核对各 information_schema 守卫，再逐条执行原文件对应 ALTER） → 登记原文件校验和 → 同步发布import/API保护代码 → 客户端。DDL隐式提交，失败后核对结构并重跑，不倒迁删列。执行状态只记录在实施规划。

回退保留0027与既有账目，客户端可切兼容只读；不得回到不认识余额保全关系的旧删除/修改代码。先停新逐期写入口，必要时用 `CATLEDGER_LOAN_SYNC_DISABLED=1` 停旧授权同步，保留原回执、来源和成对保护，再用兼容修复向前恢复。禁止通过删历史费用或批量改余额回退。

## 0028 历史确认金额与实际凭证替换

`0028_installment_confirmation_facts.sql` 为费用增加 `historical_settled_minor`，为实际费用分配增加 `historical_replaced_minor`，为期次付款分配增加 `historical_principal_minor`。本金原确认金额及贷款/期次版本保存在既有 `progress_json.historyFacts`，变动追加到收费审计；不另建本金总账。三个金额列均为非负整数分，保留既有用户范围外键和唯一占用约束，最小角色的已有表级权限覆盖新列，不新增 DDL 权限。

迁移仅从0027明确绑定的有效余额保全交易恢复已证明的历史清偿金额；没有对应依据的旧本金不猜测、不清零，读取显示待核对并阻止按现计划撤回。新增确认、撤回、费用更正、真实凭证替换及失败回滚均使用同一用户锁和事务；已有回执不重写。导出 schemaVersion 28 包含新列及既有确认/审计 JSON，双库恢复须包含非零历史覆盖与替换金额。

发布需先完成快照与旧校验和核对，再执行0028、核对结构和回填结果并登记校验和，然后同步更新两函数与客户端。直连迁移器在同一连接执行；管理SQL仅支持单语句时，按原文件的 information_schema 守卫逐项执行对应ALTER，再执行原回填语句，验证通过后登记原文件校验和，不跨连接拆用PREPARE会话变量。0026、0027原文件和校验和不变。实际执行与部署证据只维护在[实施规划](../docs/招财猫记账本实施规划.md#f01f06-云端迁移与部署)。

产生新确认或替换关系后，回退先停止 `confirmInstallments`、贷款创建中的历史选择、付款登记/更正/撤销、费用变更及导入写入口；兼容读取与原回执继续可用。保留新列、审计和保护代码，采用向前修复，不切回忽略替换份额的旧写入函数，不删除关系或恢复真实快照。

## 0029 贷款整组删除与创建归属

`0029_loan_group_deletion.sql` 增加交易 `creation_provenance_json`、贷款 `deleted_at/deletion_snapshot_json`、收费 `plan_removed_at`。只扩展可空列，information_schema 守卫，可在同一连接重跑；不修改已执行迁移、不猜测回填旧归属、不操作既有账目。已有表级最小权限覆盖新列，无新DDL权限。

创建归属在新增交易时写入，后续关联／认领不改；NULL旧数据由创建链、回执和审计核实，无法证明时阻止删除。删除快照保留原本金确认、付款／期次与实际撤销／保留范围，历史有效关系退出。收费标记只代表随计划撤销，新计划明确认领合同后可释放，不复活用户单独抑制／取消。完整导出 schemaVersion 29 包含这些列，并用非空删除图验证双库恢复。

发布顺序：取得授权后备份、核对0001～0028校验和 → 执行0029并核对结构/校验和 → 同步更新import与API → 客户端验证。直连迁移器使用同一连接；管理SQL仅支持单语句时，先核对原文件的 information_schema 守卫，再逐项执行对应ALTER，验证后登记原文件校验和，不跨连接拆用PREPARE会话变量。实际迁移、部署和仍待验收项只记[实施规划](../docs/招财猫记账本实施规划.md)。DDL隐式提交，中断后核对结构并按原守卫重跑，不倒迁删列。

回退保留新列、创建归属、删除快照、软撤销账及原回执；暂停新删除和相关写入口，必要时停旧自动同步，使用兼容修复向前恢复。不能退回会恢复已删除loanId或忽略费用失效标记的旧写代码，不能用恢复原交易或真实快照抵消本次删除。
