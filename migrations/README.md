# migrations

这里保存 CloudBase MySQL 的显式迁移。迁移从 `0001` 开始，编号连续、forward-only、可重入，并由 `catledger_schema_migrations` 校验文件 SHA-256。

首版迁移建立用户、微信身份摘要映射和默认分类表。`0004`～`0005` 建立单文件解析证据链与支付工具规则；`0006` 新增 FinanceUpdate、跨来源关系、ReviewIssue、FinanceAction 和整批 posting，并把旧已提交单文件回填为只引用既有交易的历史更新；`0007` 增加 FinanceUpdate 内的账户映射草稿，确保整理阶段只写导入域草稿；`0008` 让同一草稿表以 `mapping_action` 安全表达账户映射或永久忽略，并继续保证正式规则只能随整批 posting 事务一同生效。MySQL DDL 会隐式提交，因此迁移必须使用 `IF NOT EXISTS` 或 `information_schema` 守卫；迁移记录只在全部语句成功后写入，失败后修复环境并重跑，不修改已经登记的迁移文件。

本地执行入口是 `cloudfunctions/catledger-api` 下的 `npm run migrate`。连接信息只通过 `CATLEDGER_DB_HOST`、`CATLEDGER_DB_PORT`、`CATLEDGER_DB_USER`、`CATLEDGER_DB_PASSWORD`、`CATLEDGER_DB_NAME` 环境变量提供，禁止提交真实值。

回滚首版 schema 会删除用户、身份映射和分类数据，只允许在无业务数据的开发环境人工执行；生产环境使用后续 forward-only 迁移修正。

## 运行账号最小权限

迁移账号与云函数运行账号必须分离。`catledger_app` 仍按实际 SQL 授予最小权限，不授予库级管理员权限。除直接写入的表外，下列能力也必须显式纳入运行权限契约：

- `catledger_finance_update_sources`：表级 `SELECT, INSERT, UPDATE`；
- `catledger_import_transaction_links`：表级 `SELECT, INSERT, UPDATE`；
- `catledger_review_issue_members`：既有 `SELECT, INSERT, DELETE`，并仅对 `object_version` 增加列级 `UPDATE`。

前两项并非业务代码会修改只追加关系，而是 MySQL 对包含它们的 `SELECT ... FOR UPDATE` 锁定读取要求相应写权限；应用代码仍不得改写既有来源或交易链接。第三项用于账户归属批处理保存事件后同步 ReviewIssueMember 的乐观并发版本，缺少时 `resolveAccountMappings` 会整体回滚并返回 `ER_COLUMNACCESS_DENIED_ERROR`。部署或迁移后必须以云函数运行账号执行 `npm run check:db-permissions`，并由迁移账号用 `SHOW GRANTS FOR 'catledger_app'@'%'` 复核；不得只验证表是否存在和云函数是否 Active。
