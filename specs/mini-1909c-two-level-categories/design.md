# 设计与来源

参考 ezBookkeeping e136e5175dad12bd34fef292326a04df6bcb2516 的 src/consts/category.ts 和 TreeViewSelectionSheet.vue（MIT）。复用分层目录、折叠与搜索思路，原生实现；不引入 Vue/Go/字体包。与原项目的差异：父类可以直接记账，不增转账分类域。

保留原 16 个一级分类；参考原模板补子类，并补“通讯”“金融保险”一级。服饰/家居用品合入现有购物，工资/奖金等保持原一级。贷款本金继续由还款业务处理，租房分类不混入房贷本金。预设只在已存在的 bootstrap 写事务内补齐；停用父类不补子类，重名自定义项不接管。

0022 新增 parent_id，复合外键约束用户/收支类型，自身引用 CHECK，同级活动名称唯一。服务拒绝第三级；更新不允许移动父级。所有目录增加 parentId；公共交易分类包含 parentId/parentName/systemKey。统计在同一快照按叶子聚合后 rollup，父类 children 返回直接“未细分”和二级列表，金额用 BigInt。父类筛选 SQL 条件包含 c.parent_id，沿用读取版本游标。

UI：目的为低成本细分与准确查看收支；沿用 editorial 账本风格与六主题，默认 #FAF8F4 / #29231E / #CF7439 / #746A60，PingFang SC / Source Han Sans SC。列表左对齐、紧凑标题按钮；层级通过缩进/展开呈现，不再加大块操作按钮。使用项目既有 SVG 线性图标，补齐同风格资源；品牌调色和字体优先于通用技能限制。分类选择封装原生组件，保留 slot 触发器及索引 change 事件以接入旧页面。

发布顺序：0022 显式迁移→两支函数→小程序；本任务本地实现不隐含云迁移授权。新客户端不加旧协议 fallback。
