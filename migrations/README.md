# migrations

这里保存 CloudBase MySQL 的显式迁移。迁移从 `0001` 开始，编号连续、forward-only、可重入，并由 `catledger_schema_migrations` 校验文件 SHA-256。

首版迁移建立用户、微信身份摘要映射和默认分类表。MySQL DDL 会隐式提交，因此迁移必须使用 `IF NOT EXISTS` 等可重入写法；迁移记录只在全部语句成功后写入，失败后修复环境并重跑，不修改已经登记的迁移文件。

本地执行入口是 `cloudfunctions/catledger-api` 下的 `npm run migrate`。连接信息只通过 `CATLEDGER_DB_HOST`、`CATLEDGER_DB_PORT`、`CATLEDGER_DB_USER`、`CATLEDGER_DB_PASSWORD`、`CATLEDGER_DB_NAME` 环境变量提供，禁止提交真实值。

回滚首版 schema 会删除用户、身份映射和分类数据，只允许在无业务数据的开发环境人工执行；生产环境使用后续 forward-only 迁移修正。
