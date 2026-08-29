# 猫账 · CatLedger

<p align="center">
  <img src="docs/assets/brand/catledger-logo-master.png" alt="猫账 Logo" width="160">
</p>

猫账是一款面向中国用户的轻量、自托管个人财务应用，重点解决日常记账、支付宝/微信/银行账单整理，以及贷款和分期管理。项目基于 [ezBookkeeping](https://github.com/mayswind/ezbookkeeping) 持续演进；应用包名、命令和运行目录统一使用 `catledger`，并继续兼容 ezBookkeeping 导入导出文件格式。

[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## Introduction
CatLedger is a lightweight, self-hosted personal finance app designed primarily for users in China. It supports manual bookkeeping, statement organization for Alipay, WeChat Pay and banks, standard financial statistics, and loan or installment tracking. It is resource-efficient and runs on devices such as Raspberry Pi, NAS, and microservers.

CatLedger offers tailored interfaces for both mobile and desktop devices. With support for PWA (Progressive Web Apps), you can even add it to your mobile home screen and use it like a native app.

## Features
- **Open Source & Self-Hosted**
    - Your accounts, transactions and original statements remain under your control
    - Multiple users with isolated data
- **Lightweight & Fast**
    - Minimal resource usage, runs smoothly even on low-resource devices
- **Easy Installation**
    - Docker support
    - Supports SQLite, MySQL, PostgreSQL
    - Cross-platform (Windows, macOS, Linux)
    - Works on x86, amd64, ARM architectures
- **User-Friendly Interface**
    - UI optimized for both mobile and desktop
    - PWA support for native-like mobile experience
    - Dark mode
- **AI-Powered Features**
    - Receipt image recognition
    - MCP (Model Context Protocol) support for AI integration
    - CatLedger Agent Skill and command-line API tools
- **Powerful Bookkeeping**
    - Two-level accounts and categories
    - Manual transaction entry and batch statement organization
    - Alipay, WeChat Pay and structured bank statement support
    - Transaction list, standard statistics and financial overview
    - Loan, installment and repayment-plan tracking
    - Image attachments for transactions
    - Search and filtering
- **Localization & Internationalization**
    - Simplified Chinese and English interfaces
    - Multiple exchange rate sources with automatic updates
    - Multi-timezone support
    - Custom formats for dates, numbers and currencies
- **Security**
    - Two-factor authentication (2FA)
    - OIDC external authentication
    - Login rate limiting
    - Application lock (PIN code / WebAuthn)
- **Data Import & Export**
    - Supports CSV, OFX, QFX, QIF, IIF, Camt.052, Camt.053, MT940, GnuCash, Firefly III, Beancount and more

CatLedger intentionally removes some upstream functions to keep the main bookkeeping flow focused.

## Installation
### Run with Docker

Build the local CatLedger image first, then start it:

    $ ./build.sh docker -t catledger:latest
    $ docker run -p8080:8080 catledger:latest

### Install from Binary
Build or download a CatLedger release package from this repository.

**Linux / macOS**

    $ ./catledger server run

**Windows**

    > .\catledger.exe server run

By default, CatLedger listens on port 8080. You can then visit `http://{YOUR_HOST_ADDRESS}:8080/` .

### Build from Source
Make sure you have [Golang](https://golang.org/), [GCC](https://gcc.gnu.org/), [Node.js](https://nodejs.org/) and [NPM](https://www.npmjs.com/) installed. Then download the source code, and follow these steps:

**Linux / macOS**

    $ ./build.sh package -o catledger.tar.gz

All the files will be packaged in `catledger.tar.gz`.

**Windows**

    > .\build.bat package -o catledger.zip

or

    PS > .\build.ps1 package -Output catledger.zip

All the files will be packaged in `catledger.zip`.

You can also build a Docker image. Make sure you have [Docker](https://www.docker.com/) installed, then follow these steps:

**Linux**

    $ ./build.sh docker

## Contributing
We welcome contributions of all kinds.

If you find a bug, please [submit an issue](https://github.com/gaohongxiang/catledger/issues) on GitHub.

If you would like to contribute code, you can fork the repository and open a pull request.

Improvements to documentation, feature suggestions, and other forms of feedback are also appreciated.

CatLedger is derived from ezBookkeeping; upstream contributors are recorded in its [Contributor Graph](https://github.com/mayswind/ezbookkeeping/graphs/contributors).

## Translating
CatLedger currently ships Simplified Chinese and English interfaces. UI changes must keep both locale files synchronized.

## Documentation
当前产品行为与架构说明见 [`docs/现行说明`](docs/现行说明/)。

## License
[MIT](LICENSE). Upstream copyright and attribution are retained in the license notices and repository history.
