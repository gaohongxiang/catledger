# 招财猫记账本 · CatLedger

<p align="center">
  <img src="assets/brand/catledger-logo-master.png" alt="招财猫记账本 Logo" width="160">
</p>

招财猫记账本是一款面向中国用户的微信小程序记账工具。它以支付宝、微信支付等账单的批量导入与整理为核心，同时支持手动记账、账户与分类、财务总览，以及贷款和分期管理。

> `main` 是微信小程序主线；任务、部署、验收和授权边界统一查阅 [实施规划](docs/招财猫记账本实施规划.md)。旧 Web 版保存在 `catledger-web` 分支与 `web-v2-final` 标签。

## 技术方向

- 微信原生小程序：WXML、WXSS、JavaScript
- 微信云开发：事件云函数、MySQL、私有云存储
- 不使用云托管，不维护桌面客户端或移动 Web
- 原始账单只作短期处理证据，正式结构化数据进入 MySQL
- 金额、余额、统计和后续情景测算由确定性程序完成，AI 不作为账本权威

## 目录

- `miniprogram/`：小程序客户端
- `cloudfunctions/catledger-api/`：身份、账户、分类、手工交易、查询和统计
- `cloudfunctions/catledger-import/`：账单上传意图、解析、整理、待确认和整批入账
- `shared/`：跨端公共请求、响应与业务契约
- `migrations/`：连续、forward-only、可重入的 MySQL 显式迁移
- `specs/`：按阶段冻结的需求、设计和任务
- `assets/brand/`：项目级品牌母图和使用说明
- `docs/`：需求、业务规则、架构、实施规划与现行说明

## 开始开发

1. 安装微信开发者工具。
2. 导入仓库根目录，使用项目 AppID 或个人测试配置。
3. 个人环境配置、AppSecret、云密钥和数据库凭据不得提交。
4. 在两支云函数中配置 `CATLEDGER_DB_HOST`、`CATLEDGER_DB_PORT`、`CATLEDGER_DB_USER`、`CATLEDGER_DB_PASSWORD`、`CATLEDGER_DB_NAME` 私有环境变量。
5. 先执行 `migrations/` 中的显式迁移，再按需部署云函数。
6. 开工前先阅读 `AGENTS.md` 和 `docs/招财猫记账本实施规划.md` 的当前看板与第 19 章。

云函数本地检查：

```shell
cd cloudfunctions/catledger-api
npm install
npm test
npm run audit:prod

cd ../catledger-import
npm install
npm test
npm run audit:prod
```

迁移命令只读取本机或云函数私有环境变量：

```shell
cd cloudfunctions/catledger-api
npm run migrate
```

## 文档入口

- [文档索引](docs/README.md)：需求、业务规则、架构和现行说明。
- [实施规划](docs/招财猫记账本实施规划.md)：唯一当前状态与历史验证记录。
- [MINI-1915 一期规格](specs/mini-1915-import-modularization/README.md)：导入模块化及有限减复杂度边界。

## Web 版

需要查看或维护旧 Web 版时，请切换到 `catledger-web`：

```shell
git switch catledger-web
```

`web-v2-final` 是迁移前的不可变归档点。旧版构建、Docker、8080/8082 预览和完整文档都保留在该分支中。

## 分支约定

- `main`：微信小程序稳定主线；
- `catledger-web`：Web 最终归档，只做必要维护；
- `codex/<task-id>-<short-name>`：本地任务分支，验收合入后删除；
- `web-v2-final`：迁移前 Web 产品标签；
- `archive/ezbookkeeping-sync-final`：旧上游同步分支的历史归档标签。

仓库不设置 `develop` 或长期小程序开发分支，避免同一产品出现多条事实主线。

## 开源许可

本项目采用 [MIT License](LICENSE)。在保留版权和许可声明的前提下，可以修改、分发和用于商业用途。原 ezBookkeeping 上游的版权与许可声明继续保留在许可证和 Git 历史中。
