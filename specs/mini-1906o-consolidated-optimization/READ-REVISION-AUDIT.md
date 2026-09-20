# data_revision 覆盖审计

审计基线e1bfe4c2及READ-2候选；动态完成状态只在主看板。API/import部署目录独立，不跨目录require。data_revision已有字段，本轮无迁移/授权资源变更。

| 写入口 | 当前事务入口与覆盖证据 |
| --- | --- |
| accounts.create/createBatch/update/archive/correctBalance | account-service → API ledger-transaction；账户、期初/校正交易与修订同事务 |
| categories.create/update/archive/restore/reorder/assignTransactions | category-service → API ledger-transaction；分类及映射同事务 |
| transactions.create/update/delete/deleteMany/linkRefund/setCategory | transaction-command-service / transaction-batch-delete / transaction-category → API ledger-transaction；退款和整组删除同事务 |
| profile.update | profile-service → API ledger-transaction；资料与修订同事务，同键返回原昵称结果 |
| loans.create/update | loan-service → API ledger-transaction；资料和分期初始计划同事务 |
| loans.record/correct/reverse | loan-payment-service / loan-payment-maintenance → API ledger-transaction；付款、分配、正式交易、计划恢复同事务 |
| loans.bookRepayment/assignRepayment/releaseRepayment | repayment-booking-service / explicit-repayment-service → API ledger-transaction；本息费、关系、事务回滚沿用原实现 |
| loans.savePeriod/allocatePeriods/generatePlan | loan-period-service / loan-schedule-service → API ledger-transaction；计划虽不改总账也推进修订 |
| imports.prepareMany/parseFile/discardFile | import-service → import-transaction；文件持久化、解析成功/失败、来源重开同事务；已review_ready/committed只读返回不推进 |
| financeUpdates.prepare/organize/abandon/setRepayment | finance-update-core / review-issue-service → import-transaction；整理和版本同事务 |
| reviewIssues.resolve/resolveAccountMappings/refreshAccountGroups | review-issue-service → import-transaction；账户创建、用户决定、规则升级与修订同事务 |
| financeUpdates.post/undo、economicEvents.correct | finance-update-posting / finance-update-maintenance → import-transaction；正式交易/退款/余额/贷款/证据关系及修订同事务 |
| imports.cleanupFile（内部） | 同一importId/fileID派生稳定UUID，在import-transaction冻结清理结果；修复原每次随机请求导致post/abandon重放额外推进的问题 |
| bootstrap | user-repository独立初始化事务，锁身份及用户；只在补默认分类时递增，重复登录不推进；返回锁内版本+本次补齐增量 |
| dataExports.start/finish | 导出元数据事务不改变业务缓存数据，保留冻结data_revision与一致性检查；无需推进业务修订 |
| commandResult、读取、试算、undoImpact/correctionImpact | 无业务写入、不推进；修订校验本身为只读事务 |
| 显式迁移/离线维护 | 不在运行时偷偷建表或修账。本轮仅在隔离库验证；未来任何改写缓存业务数据的维护须在停写窗口同事务推进受影响用户修订，并使已打开客户端重新确认。未授权执行真实维护。 |

两个通用写入口均先锁可信用户、插入唯一幂等回执、执行业务、递增修订、写冻结结果、commit；重复键先rollback并释放连接，再读取原结果。业务失败与递增均回滚。新请求即便最终业务值相同，仍允许保守推进；同原请求重放绝不推进。导入清理是独立提交后事实，其稳定请求不重复推进。

本轮定向证据：read-revision-db.test.js使用独立API/import权限，覆盖同快照并发写、unchanged只4条控制/身份SQL且0聚合、超过2^53版本、错误版本格式、跨用户、参数伪造、API失败回滚与资料重放、导入入账/清理重放/撤销及余额恢复。既有全量MySQL覆盖分类、退款、贷款/还款计划、并发与失败回滚；当前运行结果及SHA由主看板记录，不能将本审计表当成云端已经升级。
