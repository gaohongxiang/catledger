# 招财猫记账本 · CatLedger

<p align="center"><img src="assets/brand/catledger-logo-master.png" alt="招财猫记账本 Logo" width="160"></p>

面向个人用户的微信原生记账小程序：把银行、支付宝、微信支付账单解析、去重、核对后整批入账，同时支持手工交易、账户、分类、统计、贷款和信用卡分期。只有正式交易影响账本，来源证据和计划不重复计钱。

**第一次看项目，先读[项目逻辑说明](docs/招财猫记账本入账逻辑说明.md)。** 它按实际业务顺序解释架构、每一步判断和失败恢复。

| 目的 | 入口 |
| --- | --- |
| 找全部现行文档 | [文档导航](docs/README.md) |
| 查看当前任务与验收、部署状态 | [实施规划](docs/招财猫记账本实施规划.md) |
| 配置项目、测试和交付 | [开发与验证](docs/开发与验证.md) |
| 修改代码前核对职责与约束 | [AGENTS](AGENTS.md)、[架构设计](docs/招财猫记账本架构设计.md) |
| 追溯旧方案和修复证据 | [归档](docs/归档/README.md)、[阶段规格](specs/README.md) |

## 技术与目录

微信原生 WXML/WXSS/JavaScript；两个事件云函数；CloudBase MySQL 与私有云存储。不运行微服务集群，不把模型输出当作权威账本，不替用户执行真实资金操作。

```text
miniprogram/                       原生客户端
cloudfunctions/catledger-api/       身份、正式账本、统计、贷款、导出
cloudfunctions/catledger-import/    上传、解析、整理、核对、入账
shared/                            公共接口契约
migrations/                        显式、可重入的向前迁移
scripts/、test/                    工程工具与验证
assets/brand/                      品牌母图
 docs/                             现行手册、任务状态与历史索引
specs/                             阶段规格与固定验证材料
```

## 开始

用微信开发者工具打开仓库根目录。先按[开发与验证](docs/开发与验证.md)准备个人配置及函数依赖，再运行检查；云端迁移、部署、上传均须核对环境和授权，不因打开项目自动执行。凭据、原始账单及个人环境配置不得提交。

`main` 是小程序主线；任务分支验收后才合并。`backup-docs` 是本次文档整理前的用户备份，不作为开发分支改写。旧 Web 版保存在 `catledger-web` 与 `web-v2-final`，旧版 Docker、端口和构建说明不适用于小程序。

项目采用 [MIT License](LICENSE)，保留上游版权与 Git 历史。当前状态不在本页另写一份，统一见实施规划。
