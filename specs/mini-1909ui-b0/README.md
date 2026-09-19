# MINI-1909UI-B0 视觉地基收敛

## 目标

Editorial × Luxury 重设计的地基批次：把视觉令牌收敛回 `specs/mini-1904b-ui-system/design.md` 契约，并建立共享组件层，为 B1（灾难页改造）与 B2（主页面精修）提供统一基座。

## 范围

- 字阶收敛为契约五档：`--font-caption 24 / --font-body 28 / --font-section 32 / --font-title 40 / --font-display 56`（rpx），删除 `--font-body-small`；字重只用 400/500/600。
- 圆角归一到契约三档：12/18/24rpx（六主题 `registry.js` 统一），999rpx 胶囊与 50% 圆形保留。
- 动效时长收敛到 120/180/240ms（`--layout-motion-fast/normal/slow`）。
- 主橙唯一值 `#BE5B24`：app.json tabBar、各页 WXSS、hero 渐变（`--theme-hero-start/end`）与组件全部走 `--theme-accent` 系 token；app.wxss 全部 var() fallback 对齐 warm-ledger 主题值。
- 标题真宋体：`.serif-title` 使用 `Songti SC / STSong / Noto Serif CJK SC`（iOS 生效，安卓回落系统衬线/黑体，不加载网络字体）。
- 新建共享组件：`section-header`（小眉题+发丝线+大标题）、`list-row`、`empty-state`、`ui-state`、`chevron-icon`；消灭 14 类约 30 处 CSS 手绘图标与 `✓`/`＋` 字符图标，新增 Lucide 资产 chevron/check/close/search/plus。

## 边界

- 不动业务逻辑、WXML 业务结构（wx:if/wx:for/事件/数据字段）、云函数、迁移。
- `pages/import-workbench/` 与孤儿页 `pages/import-maintenance/` 不在本批（import-workbench 由 B3 单列）。
- `statistics/model.js` 图表色与统计热力图色阶保留字面量（JS 无法取 CSS 变量 / 无语义 token 对应）。

## 验证

- `npm run check`、`npm run test` 全绿；`test/ui-system.test.js`、`test/home-visual-sample.test.js`、`test/core-closure.test.js` 断言同步到新字阶变量与组件结构。
- 六主题渲染观感走查在微信开发者工具进行（模拟器逐主题核验）。
