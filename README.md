# 猫账 · CatLedger

<p align="center">
  <img src="docs/assets/brand/catledger-logo-master.png" alt="猫账 Logo" width="160">
</p>

猫账是一款面向中国用户的微信小程序记账工具。它以支付宝、微信支付等账单的批量导入与整理为核心，同时支持手动记账、账户与分类、财务总览，以及后续的贷款和分期管理。

> 当前状态：小程序版正在从干净基线重新建设，`main` 是小程序主线。原 Web 版保存在 [`catledger-web`](https://github.com/gaohongxiang/catledger/tree/catledger-web) 分支和 `web-v2-final` 标签中。

## 技术方向

- 微信原生小程序：WXML、WXSS、JavaScript
- 微信云开发：云函数、MySQL、临时云存储
- 不使用云托管，不维护桌面客户端或移动 Web
- 原始账单只作短期处理证据，正式结构化数据进入 MySQL

## 目录

- `miniprogram/`：小程序客户端
- `cloudfunctions/`：业务 API 与账单导入云函数
- `shared/`：跨端共享契约
- `migrations/`：MySQL 显式迁移
- `docs/`：需求、规则、架构、计划与现行说明

## 开始开发

1. 安装微信开发者工具。
2. 导入仓库根目录，首次选择测试号或填写自己的小程序 AppID。
3. 个人环境配置不要提交到仓库。
4. 开通云开发环境和 MySQL 后，在 `catledger-api` 云函数中配置 `CATLEDGER_DB_HOST`、`CATLEDGER_DB_PORT`、`CATLEDGER_DB_USER`、`CATLEDGER_DB_PASSWORD`、`CATLEDGER_DB_NAME` 私有环境变量。
5. 先执行 `migrations/` 中的显式迁移，再部署 `catledger-api` 云函数。

当前开发版本已部署首版 MySQL 迁移和 `catledger-api` 开发版，微信开发者工具已用真实微信身份跑通用户初始化与 16 个默认分类；尚未实现账单导入，也未上传、审核或正式发布小程序版本。

云函数本地检查：

```shell
cd cloudfunctions/catledger-api
npm install
npm test
```

迁移命令只读取本机或云函数私有环境变量，不要把数据库凭据写进仓库：

```shell
cd cloudfunctions/catledger-api
npm run migrate
```

## Web 版

需要查看或维护旧 Web 版时，请切换到 `catledger-web`：

```shell
git switch catledger-web
```

`web-v2-final` 是本轮迁移前的不可变归档点。旧版的构建、Docker、8080/8082 预览和完整文档都保留在该分支中。

## 分支约定

- `main`：微信小程序稳定主线；
- `catledger-web`：Web 最终归档，只做必要维护；
- `codex/<task-id>-<short-name>`：本地任务分支，验收合入后删除；
- `web-v2-final`：迁移前 Web 产品标签；
- `archive/ezbookkeeping-sync-final`：旧上游同步分支的历史归档标签。

仓库不设置 `develop` 或长期小程序开发分支，避免同一产品出现多条事实主线。

## 开源许可

本项目采用 [MIT License](LICENSE)。在保留版权和许可声明的前提下，可以修改、分发和用于商业用途。原 ezBookkeeping 上游的版权与许可声明继续保留在许可证和 Git 历史中。
