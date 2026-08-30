# MINI-1904C 核心服务分层设计

## 模块边界

```text
index.js
  -> action-registry.js             公开 action 到处理器的唯一映射
  -> handler.js                     微信可信身份与公开错误边界
  -> transaction-service.js         兼容门面，只组合下列服务
       -> transaction-command-service.js   正式交易命令与退款规则
       -> transaction-query-service.js     明细、筛选、游标、可退款查询
       -> reporting-service.js             首页与统计聚合
       -> transaction-domain.js            纯校验、构造与公开映射
  -> ledger-read.js                 用户解析与只读一致性快照
  -> ledger-transaction.js          写入事务与幂等
```

账户查询暴露一个仅供后端内部使用的 `listAccountsForUser(connection, uid)`，使首页聚合不再嵌套调用会另取连接的公共账户服务。

## 一致性

`dashboard.get` 与 `statistics.get` 使用 `REPEATABLE READ` 和 `START TRANSACTION READ ONLY`。身份解析、账户余额、交易汇总、趋势和最近交易均使用同一连接并在成功后提交，失败时回滚。

普通单查询接口可复用 `ledger-read` 的连接和身份解析，但无需开启快照事务。所有写操作继续使用 `executeIdempotentMutation`，本次不改变写入协议。

## 契约

`action-registry.js` 是服务端公开 action 的可执行清单。自动测试比较：

- 服务端动作清单与 `shared/catledger-api.json`；
- 小程序中静态 `callApi` 动作与公共契约；
- 契约中的 read/mutation 基本字段规则。

契约仍不进入云函数运行时包，避免跨目录部署依赖；漂移由仓库测试阻断。

## 安全与回滚

- 不返回 event、context、OpenID、uid、环境变量或数据库绑定值；
- 不修改 VPC、私密变量、权限或云资源；
- 回滚只需撤销本任务分支文件变更，不涉及数据迁移。
