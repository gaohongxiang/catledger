# 招财猫记账本 · CatLedger

<p align="center"><img src="assets/brand/catledger-logo-master.png" alt="招财猫记账本 Logo" width="160"></p>

面向个人用户的微信原生记账小程序：把银行、支付宝、微信支付账单解析、去重、核对后整批入账，同时支持手工交易、账户、分类、统计、贷款和信用卡分期。只有正式交易影响账本，来源证据和计划不重复计钱。

**第一次看项目，先读[项目逻辑说明](docs/招财猫记账本入账逻辑说明.md)。** 它按业务顺序解释架构和判断；贷款章节明确区分当前实现与新目标。

| 目的 | 入口 |
| --- | --- |
| 找全部文档 | [文档导航](docs/README.md) |
| 看贷款/分期、漏月补费、不补历史的目标和 Astra 实施指令 | [贷款与分期改造方案](docs/贷款与分期改造方案.md) |
| 当前任务、验收、分支与部署状态 | [实施规划](docs/招财猫记账本实施规划.md) |
| 配置项目、测试和交付 | [开发与验证](docs/开发与验证.md) |
| 修改代码前核对职责与约束 | [AGENTS](AGENTS.md)、[架构设计](docs/招财猫记账本架构设计.md) |
| 追溯旧方案和修复证据 | [归档](docs/归档/README.md)、[阶段规格](specs/README.md) |

## 技术与目录

微信原生 WXML/WXSS/JavaScript；两个事件云函数；CloudBase MySQL 与私有云存储。不运行微服务集群，不把模型输出当权威账本，不替用户执行真实资金操作。

```text
miniprogram/                       原生客户端
cloudfunctions/catledger-api/       身份、正式账本、统计、贷款、导出
cloudfunctions/catledger-import/    上传、解析、整理、核对、入账
shared/                            公共接口契约
migrations/                        显式、可重入的向前迁移
scripts/、test/                    工程工具与验证
assets/brand/                      品牌母图
docs/                              手册、目标方案、任务状态与历史索引
specs/                             阶段规格与固定验证材料
```

## 开始与本次工作分支

用微信开发者工具打开仓库根目录，按[开发与验证](docs/开发与验证.md)准备个人配置和依赖。云迁移、部署、上传须核对环境与授权，不因打开工程自动执行。凭据、原始账单和个人配置不提交。

**本次统一在 docs 工作与验收，不再开重复文档或阶段分支；用户验收后才合入 main。** backup-docs 是原文临时备份，验收后确认不需要再删，不作为开发分支。旧重复引用的实际清理结果只在实施规划维护。旧 Web 版的 catledger-web 与 web-v2-final 另行保留，不因本次文档备份清理删除。

方案已写不代表功能已实现；当前状态只看实施规划。项目采用 [MIT License](LICENSE)，保留上游版权与 Git 历史。
