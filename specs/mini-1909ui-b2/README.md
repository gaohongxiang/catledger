# MINI-1909UI-B2 主页面精修

## 目标

在 B0 地基、B1 灾难页之后，精修五个主页面：index、transactions、statistics、transaction-editor、profile。

## 范围

- **首页 hero 文字色矛盾修复**：`pages/index/index.wxss` 的 warm-ledger 覆盖块曾把 `--home-hero-ink` 硬编码为深色压在暖橘 hero 底上；删除覆盖，hero 区文字全部走 `--theme-hero-ink / --theme-hero-value-ink / --theme-hero-muted`。六主题 hero 对比度核对全部 ≥4.46（见下）。
- **明细页工具区收敛**：三卡片摘要改为单行小字统计条（收支仍带文字标签与语义色）；搜索框不再常驻，改筛选行首放大镜按钮展开。
- **记一笔贷款上下文卡片化**：`.loan-context` 对齐卡片语言（28rpx 内距 + radius-large），普通记账表单不动。
- **统计页入场动效**：图表/卡片容器级透明度+上浮入场（240ms、错峰 80/160ms），`prefers-reduced-motion` 下禁用；图表内部外观不动。
- **我的页**：昵称字阶收敛 section/500，UID 等宽数字；菜单保持 list-row。

## 边界

- 业务逻辑、事件、数据字段不动；仅 transactions/index.js 增加 `searchOpen` 局部展示状态（含导入筛选复位），docs/现行说明/小程序基础.md 描述已同步。
- 六主题 registry 无需新增 token（32 个已完整）。

## 验证

- `npm run check` 通过；`npm run test` 三套全绿（668 pass / 0 fail）；新增 1 条 hero token 断言防回退。
- 微信开发者工具编译预览通过；观感走查由用户确认。
