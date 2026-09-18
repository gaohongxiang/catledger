# MINI-1908D：还款计划测算与生成（合并「本息小记」）

状态：进行中。基线 main `eb67e419`；任务分支 `codex/mini-1908d-schedule-generation`，worktree `/Users/gaohongxiang/projects/catledger-worktrees/mini-1908d-schedule-generation`。依赖 MINI-1908C。冻结契约见 `docs/招财猫记账本实施规划.md` 19.14。

## 背景与授权决定

独立项目「本息小记」（`/Users/gaohongxiang/projects/loan-cost-calculator`）实现了 4 种还款方式 × 2 种测算依据的逐期本息费拆分算法；catledger 的贷款管理（1908A 资料 / 1908B 期次对账 / 1908C 还款关联）目前期次全靠人工逐期录入，没有计划测算与生成能力。用户已拍板：

- **完整合并**：把还款计划逻辑并入 catledger 贷款域；
- **复制自维护（vendor）**：核心算法文件（repayment-plans.js / cashflow.js / dates.js / money.js，均在对方已提交的 V1.2.0 中）复制进 catledger 改写为整数分运算，不做共享包，不受对方仓库未提交工作区影响；
- 贷款资料新增结构化分期参数，新增只读 `loans.previewPlan` 与幂等变更 `loans.generatePlan`。

## 范围与文件所有权

串行所有权（主负责人串行冻结，本批由并行代理分工实现后端、前端与文档规格）：

- `cloudfunctions/catledger-api` 贷款域：新 `src/loan-schedule/`（schedule-engine／cashflow／schedule-dates／schedule-params）、`loan-schedule-service.js`、`loan-domain.js`、`loan-service.js`、`action-registry.js`；
- `migrations/0018_loan_schedule_params.sql`（新）；
- `shared/catledger-api.json`（create/update 字段、两个新 action、failureCodes 增 LOAN_PLAN_EXISTS）；
- `miniprogram/pages/{loan-detail,loan-plan,loans}`；
- 测试 `test/loan-schedule-engine.test.js`、`test/loan-schedule-db.test.js` 及 api-contract／客户端测试；
- 贷款文档：用户需求、业务规则与验收、入账逻辑说明、现行说明/贷款管理、实施规划（0.5 / 19.14）。

## 冻结契约摘要

- 9 个分期参数字段（API camelCase）：`scheduleMethod`（flat／equal_payment／equal_principal／interest_only）、`scheduleTerms`（1～600）、`measurementKind`（rate／repayment）、`quoteType`（annual／monthly／daily／installment）、`ratePpm`（×10⁶，不用浮点）、`repaymentMinor`、`feePerTermMinor`、`feeUpfrontMinor`、`firstPaymentDate`；全部可空、全有全无，DB CHECK 与服务端校验同规则。
- `loans.previewPlan`：只读试算，返回逐期本金/利息/费用与汇总，不落库、不动账。
- `loans.generatePlan({requestId,loanId,version,confirmed})`：贷款已有任何期次（含已取消）即拒绝 `LOAN_PLAN_EXISTS`；同一用户锁事务内批量写入连续期号期次及修订快照、贷款版本 +1；不产生 Transaction、不改余额；`executeIdempotentMutation` 幂等回执。
- 生成规则：整数分逐期拆分、末期兜底收敛、日利率 360 天口径、installment 仅限 flat、等额本息按还款额二分反解期利率、firstPaymentDate 缺省按基准日/开始日/创建日 +1 月锚定并月末收敛。
- 修改参数不自动重算既有计划；生成的期次与人工录入等价，沿用既有修订与对账路径；不推算银行结清金额；普通信用卡还款不强制建分期。

## 验收条件

- 引擎测试 `test/loan-schedule-engine.test.js`：移植计算器算法用例并改整数分断言——4 方式 × 2 依据、末期兜底、每期费用、IRR 反解、月末日期收敛、600 期边界；
- 数据库测试 `test/loan-schedule-db.test.js`（真实隔离 MySQL 8.4）：0018 重入与 CHECK、create/update 参数全有全无、previewPlan 不落库、generatePlan 成功路径（期次+revision+版本）、幂等重放、已有期次含已取消拒绝、600 期批量、与 `loans.allocatePeriods` 对账衔接、用户隔离；
- `test/api-contract.test.js` 及客户端 loan-detail 表单／loan-plan 入口测试更新通过；
- `npm run check`、`npm run test`、`npm run test:db`（隔离 MySQL 8.4）、两函数 `npm run audit:prod`、`git diff --check` 全部通过；
- 原生开发者工具与真机验收单列记录，不把 VM 或 CI 称为真机。

## 明确排除项

- discount 优惠引擎、paidTerms 计数器（catledger 用真实付款+期次分配）、portfolio、export/backup、本地 store——不随算法移植；
- 贷款自动提醒、产品化利率预测／推荐、银行最终结清金额推算——保持不做；
- 合并 main、开发云执行 0018 迁移、部署 catledger-api、上传小程序——均需另行授权，本批只交付 worktree 内实现、验证与任务分支提交。
