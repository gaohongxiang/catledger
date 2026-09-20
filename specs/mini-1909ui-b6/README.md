# MINI-1909UI-B6 微交互动效层

## 定位

B0–B5 完成静态视觉体系；B6 补齐交互层质感。五个动效全部经用户在 HTML 动效小样（/tmp/catledger-motion-demos.html）上确认。

## 范围（用户全选）

1. **金额数字滚动（ticker）**：首页 hero 净值、统计总额在月份/数据切换时逐位滚动过渡。新组件 `ticker-number`（property：value 字符串；数字位滚动、符号位静态）。曲线 `cubic-bezier(.22,1,.36,1)` 600ms。
2. **骨架屏**：明细/账户/统计/首页列表的「正在读取…」替换为骨架条（shimmer 扫光），数据到达就地错峰淡入。新组件 `skeleton-rows`（property：rows 行数）。
3. **按压微回弹**：三按钮体系（primary/secondary/danger）与可点卡片（list-row、候选卡）`:active` 从纯 opacity 改为 `scale(.965)` + 回弹曲线 `cubic-bezier(.34,1.56,.64,1)` 120-180ms。抽 token `--motion-press-*`。
4. **校验抖动**：login-sheet 昵称、profile 昵称、loan-detail 表单校验失败时输入框横向轻抖（360ms keyframes）+ 错误内联展示（保留既有校验逻辑，只改反馈呈现）。
5. **列表错峰入场**：明细、账户、统计排行、首页最近账目逐行上浮入场（fadeUp 380ms、间隔 70ms，内联 `animation-delay: {{index * 70}}ms`）。

## 边界

- 全部动效尊重 `prefers-reduced-motion`（app.wxss 已有全局覆盖，新增动画须确认被覆盖）
- 时长/曲线入 token，不新增色板；六主题自动继承
- 业务逻辑/事件/数据字段不动；ticker 是唯一新增展示组件逻辑
- check/test 全绿；结构断言同步不删测试

## 载体

在 B5 分支（codex/mini-1909ui-b5）上继续，PR #16 合并验收。
