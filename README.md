# 猫账 · CatLedger

<p align="center">
  <img src="docs/assets/brand/catledger-logo-master.png" alt="猫账 Logo" width="160">
</p>

猫账是一款面向中国用户的轻量、自托管个人财务应用，重点解决日常记账、支付宝/微信/银行账单整理，以及贷款和分期管理。项目基于 [ezBookkeeping](https://github.com/mayswind/ezbookkeeping) 持续演进；应用包名、命令和运行目录统一使用 `catledger`，并继续兼容 ezBookkeeping 导入导出文件格式。

[![MIT 许可证](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## 项目简介

CatLedger 适合部署在个人服务器、NAS、树莓派或其他低功耗设备上。它同时提供桌面端和移动端界面，并支持 PWA，可添加到手机主屏幕后像普通应用一样使用。

本项目保留完整的多用户能力，每个用户的数据相互隔离，适合个人自建，也适合为家人或其他用户提供独立的记账服务。

## 功能特性

- **开源与自托管**
  - 账户、交易和原始账单由你自己掌控
  - 支持多用户及用户间数据隔离
- **轻量部署**
  - 资源占用较低，可运行在低配置设备上
  - 支持 Docker
  - 支持 SQLite、MySQL 和 PostgreSQL
  - 支持 Windows、macOS、Linux，以及 x86、AMD64、ARM 等架构
- **个人记账**
  - 支持二级账户和二级分类
  - 支持手动记一笔、批量账单整理、搜索和筛选
  - 支持交易附件、标准统计和财务总览
  - 支持贷款、分期和还款计划管理
- **中国账单整理**
  - 支持支付宝、微信支付及结构化银行账单
  - 原始账单、整理结果和正式交易相互关联，方便核对与追溯
  - 重复记录、账户映射和异常交易由统一整理流程处理
- **移动端与桌面端**
  - 针对不同屏幕尺寸优化界面
  - 支持 PWA 和深色模式
- **AI 扩展能力**
  - 支持图片记账相关能力
  - 支持 MCP（Model Context Protocol）集成
  - 提供 CatLedger Agent Skill 和命令行 API 工具
- **本地化与国际化**
  - 内置简体中文和 English 界面，默认使用简体中文
  - 支持多币种、多个汇率来源和自动更新
  - 支持多时区及日期、数字、货币格式设置
- **安全能力**
  - 支持两步验证（2FA）和 OIDC 外部认证
  - 支持登录限流
  - 支持 PIN 码或 WebAuthn 应用锁
- **数据导入与导出**
  - 兼容 CSV、OFX、QFX、QIF、IIF、Camt.052、Camt.053、MT940、GnuCash、Firefly III、Beancount 等格式

为了让个人记账主流程更清晰，CatLedger 有意精简了部分 ezBookkeeping 上游功能；具体以当前界面和[现行说明](docs/现行说明/)为准。

## 安装与运行

### 使用 Docker

先在仓库根目录构建镜像，再启动容器：

```shell
./build.sh docker -t catledger:latest
docker run --name catledger -p 8080:8080 catledger:latest
```

启动后访问 `http://localhost:8080/`。如需持久化数据和用于正式环境，请按自己的部署方式挂载配置、数据、存储和日志目录。

### 使用二进制包

从本仓库构建 CatLedger 发布包，解压后运行：

Linux / macOS：

```shell
./catledger server run
```

Windows：

```powershell
.\catledger.exe server run
```

CatLedger 默认监听 `8080` 端口，可通过 `http://{服务器地址}:8080/` 访问。

### 从源代码构建

请先安装 [Go](https://go.dev/)、[GCC](https://gcc.gnu.org/)、[Node.js](https://nodejs.org/)、[npm](https://www.npmjs.com/) 以及项目构建所需的系统工具。

Linux / macOS：

```shell
./build.sh package -o catledger.tar.gz
```

构建产物为 `catledger.tar.gz`。

Windows 命令提示符：

```bat
.\build.bat package -o catledger.zip
```

Windows PowerShell：

```powershell
.\build.ps1 package -Output catledger.zip
```

构建产物为 `catledger.zip`。

如需构建 Docker 镜像，请先安装 [Docker](https://www.docker.com/)，然后运行：

```shell
./build.sh docker
```

## 参与贡献

欢迎提交错误报告、功能建议、文档改进和代码贡献。

- 发现问题时，请在 GitHub [提交 Issue](https://github.com/gaohongxiang/catledger/issues)。
- 贡献代码时，请 Fork 本仓库并提交 Pull Request。
- 修改用户界面文案时，需要同步维护 `zh_Hans` 和 `en` 两套语言资源。

CatLedger 基于 ezBookkeeping 二次开发，上游贡献者可在 [ezBookkeeping Contributor Graph](https://github.com/mayswind/ezbookkeeping/graphs/contributors) 中查看。

## 文档

当前产品行为、数据流程和扩展方式见 [`docs/现行说明`](docs/现行说明/)，产品规划和工程状态见 [`docs/个人财务实施规划.md`](docs/个人财务实施规划.md)。

## 开源许可

本项目采用 [MIT License](LICENSE)。在保留版权和许可声明的前提下，可以修改、分发和用于商业用途；上游项目的版权与署名继续保留在许可证文件和 Git 历史中。
