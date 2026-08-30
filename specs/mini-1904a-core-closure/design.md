# MINI-1904A 设计：核心账本收口

## 1. 边界

继续使用微信原生小程序、`catledger-api` Event Function 和 CloudBase MySQL。服务端仍以 `cloud.getWXContext().OPENID` 派生可信身份；客户端登录面板只是产品层主动许可，不作为服务端身份凭据。

## 2. 数据模型

迁移 `0003_category_management_and_refunds.sql`：

- 分类增加 `normalized_name`、活动名称生成列、`version`，用 `(uid, kind, active_name_key)` 保证活动分类不重名；历史分类保持原主键与交易外键。
- 交易增加 `original_transaction_id`，使用 `(uid, original_transaction_id)` 索引和同用户自关联外键；仅 `refund` 使用该字段。
- 迁移只补字段、索引和外键，不物理改写交易含义，可重复执行。

## 3. API

- `categories.list/create/update/archive/restore/reorder`
- `transactions.refundable`
- `transactions.create/update` 扩展 `refund` 和 `originalTransactionId`

分类写接口均使用 `requestId`；单项修改携带 `version`。排序提交当前方向所有活动分类的 `{categoryId, version}`，服务端锁定并验证集合后统一更新。

退款服务锁定原支出、相关退款和账户；分类沿用原支出分类，客户端不得覆盖。原支出的有效退款总额是所有未删除 `refund` 之和。

## 4. 统计口径

- 收入：仅 `income`。
- 支出：`expense - refund`，允许月内退款对应跨月原支出，因此月度净支出可出现负数。
- 分类：退款归入所关联原支出的分类并以负额聚合。
- 账户余额：退款作为目标账户流入；净值无需特殊分支。
- 列表保留退款独立行并返回原支出摘要，便于审计。

## 5. 客户端与视觉

分类页采用现有“克制的编辑式账本”语义令牌：紧凑行、轻分隔、行尾编辑/停用，底部面板完成新建改名，排序使用明确的上移/下移操作。退款在现有记账类型中增加一项，先选原支出，再选到账账户。

受保护页面复用自定义 tabBar 的登录面板能力；页面不复制登录 UI，只调用统一门禁。若页面没有 tabBar 实例，则安全返回上一页并由来源入口触发，避免任何未授权云调用。

“我的”移除账本设置行，保留主题、数据与隐私、关于招财猫记账本和退出登录。

## 6. 安全、依赖与验证

- SQL 全部参数化并限定 `uid`；查询其他用户 ID 与不存在 ID 返回相同公开错误。
- 不返回 OPENID、`event`、`context`、环境变量或数据库绑定值。
- `wx-server-sdk@4.0.2` 当前没有无破坏性直接升级；不按审计建议盲降到 2.5.3。通过限制 SDK 使用面、拒绝递归身份字段和不接受任意 URL 降低可达性，并把正式发布前升级/替换作为硬门禁。
- 单元测试、MySQL 集成测试、迁移重放、JS/JSON/WXML/WXSS 编译、开发者工具交互和 CloudBase 语义审查共同验收。
