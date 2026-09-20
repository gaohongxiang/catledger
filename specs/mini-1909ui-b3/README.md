# MINI-1909UI-B3 导入工作台样式治理

## 目标

治理最后一块视觉飞地 `pages/import-workbench`（2825 行 WXSS 巨石），把硬编码全部收敛到 token 体系，不动 833 行 WXML 的业务结构。

## 范围

- **字阶**：78 处字面量/旧档全部入契约五档（24/28/32/40/56rpx），删除页内对 `--font-*` 的本地重定义。
- **圆角**：58 处入 12/18/24 三档（999rpx 胶囊、50% 圆形保留）。
- **颜色**：299 处 `--ui-*` 别名过期 hex/rgba 回退剥除（别名在 `.import-page` 必定义）；流浪 token 归位（`--theme-line-strong`/`--theme-soft`/`--theme-strong`/`--muted`/`--ink` 等并入正式语义色）；裸 `#fff` 改 `--ui-surface`/`--ui-on-accent`；卡片阴影字面量改 `var(--theme-shadow-soft)`。
- **动效**：收敛到 120/180/240ms（spinner 循环 760/900ms 保留，有测试断言）。
- **WXML 微调 16 处**（结构/事件/数据字段不动）：`›` 字符 → chevron-icon 组件（11 处）、`×` → close.svg（2 处）、CSS 手绘放大镜 → search.svg（1 处）、计数文本补 money-number。

## 边界与保留项

- JS 一行未动；共享组件未替换（视觉口径不同或带事件嵌套，按「拿不准就保留」只 token 化）。
- 保留：warm-ledger 覆盖块（测试断言）、财务语义色、支付宝/微信品牌色、`--sheet-scrim` 遮罩 token。
- 保留 3 处 `＋` 字符与 `☑/☐` 文本（固定色 SVG 无法随六主题染色，JS 不动约束下无 themeIconRoot）。
- WXSS 尾部历史覆盖段未去重（改级联顺序有视觉风险，超出本批范围）。

## 验证

- `npm run check` 通过（694 文件）；`npm run test` 全绿（668 pass / 0 fail）；`git diff --check` 干净。
- 测试同步：仅 `import-account-compact.test.js` 一条断言（白底字面量 → 语义色变量）。
- 开发者工具编译预览与六主题走查由主会话/用户完成，重点：step 条、账户决策行、final 汇总区、四个弹层。
