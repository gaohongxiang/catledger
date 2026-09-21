# MINI-1909UI-B5 暖阳手账 · 视觉重音与场景化

## 定位

B0–B4 完成规范化与形态统一；B5 在用户确认的方向稿（/tmp/catledger-b5-mockup.html 三屏稿）上落「高级感」的最后三块：视觉重心、色彩节奏、场景化空态。

## 范围

### 1. 首页 hero 视觉重心（pages/index）
- 净值卡升级：暖橘渐变（heroStart→heroEnd，可加 135° 微渐变层次）、圆角 radius-xl、shadowLifted 级柔影
- 卡内迷你趋势柱：复用现有 `cashFlowTrend` 数据（近半年六根柱，白透明度层次），不加新查询
- 猫水印回归：catledger-logo.png 以 ~10-16% 透明度铺右下（用户已在方向稿确认猫回归 hero；952f06c0/b7b6c8a8 的移除针对旧位置，以方向稿为准）
- 问候语保持在卡外（b7b6c8a8 的位置），净值卡内是 净值标签+月份+大数字+迷你趋势+收支结余条

### 2. 统计页色彩节奏（pages/statistics）
- 支出/收入构成增加**彩色分段带**（stacked bar）：各分类段使用 category-tile 八色系的实色版，宽度按金额占比，圆角容器
- 图例排行行与色带同色系呼应（瓷贴已有）
- 环形图（charts.expenseRing）：色带成为主视觉后，环形图若保留则降级为小尺寸或移除，避免双重视觉竞争；二选一，报告说明
- 每日支出柱图当前日/当前月用主橙高亮，其余用浅暖灰

### 3. 空态场景化（empty-cat 组件）
- 升级为场景卡：柔和径向光圈（accentSoft 系）+ 猫 + 星点装饰 + 拟人文案 + 胶囊主按钮
- `hide-art` 场景（loans 等）保持无图，文案结构不变
- 接入页保持 B4c 的四处（index/transactions/loans/import-history）

### 4. 不做
- 昵称六字上限与资料按钮对齐：已由 main 的 952f06c0 完成，不重复
- 卡片原地展开动效：暂缓，留待后续批次

## 边界

- 业务逻辑/事件/数据字段不动；迷你趋势复用现有 cashFlowTrend，不新增查询
- 六主题：hero 渐变用 heroStart/heroEnd token；色带八色跨主题固定（与瓷贴同板）
- 触控/reduced-motion 约束不变；check/test 全绿
