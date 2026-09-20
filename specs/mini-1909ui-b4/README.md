# MINI-1909UI-B4 暖阳手账 · 全局高级感设计规格

## 定位

在 B0–B3 规范化地基上，把 17 个页面统一升级为「高级、美观、实用」的一体视觉。不模仿单一参考，从三张标杆（CaliBaby 的软形态与陈列、DeepBlue 的编辑排版与留白、冥想 App 的情感化与色彩节奏）提炼共性，落到猫账本自己的品牌（猫 logo、暖橘、宋体标题、六主题）。

高级感公式：**克制的色彩分层 × 软形态（大圆角+柔影）× 图形内容（瓷贴/插画/水印）× 情感化文案 × 一致节奏**。

## 1. 形态系统（token 级，六主题继承）

| 项 | 现状 | B4 |
|---|---|---|
| 圆角 | 12/18/24 三档 | 12/18/24/**32** 四档：`radius-large 24`（普通卡）、新增 `radius-xl 32`（hero、大卡、弹层、瓷贴） |
| 阴影 | 卡片无阴影（1904B 契约） | **契约修订**：卡片允许极轻暖色扩散影 `shadowSoft`（加重到可见：约 `0 8rpx 28rpx rgba(主题暖色, .07)`）；弹层/FAB 用 `shadowLifted`。发丝线保留用于列表行分隔 |
| 主按钮 | radius-medium | 页面级主 CTA **胶囊化**（999rpx）；行内/次级按钮保持 18 |
| 触控 | ≥88rpx | 不变 |
| 字阶 | 24/28/32/40/56 | 不变；标题继续宋体 `.serif-title` |
| 动效 | 120/180/240ms | 不变；入场错峰沿用 B2 |

## 2. 页头统一（全 17 页）

现状两种页头并存（B0 的 eyebrow+发丝线 section-header、B1 贷款详情的徽章式）。统一为**徽章式页头**：

- 组件 `page-head`：徽章胶囊（accentSoft 底 + accentStrong 文 + 小圆点，文案 = 页面域，如「贷款资料」「账单导入」）+ 宋体大标题（40rpx/600）+ 副文案（caption/muted，一行）
- `section-header` 保留 compact 变体仅用于页内小节（如首页「账户余额」）
- 每页副文案承担该页最重要的业务提示（当前散落在页面各处的说明文字上移合并）

## 3. 图形内容系统

### 3.1 分类瓷贴 `category-tile`
- 8 个默认分类配低饱和彩色方块（32rpx 圆角 + 56rpx 图标位）：餐饮/交通/购物/住房/医疗/教育/娱乐/其他
- 色板跨主题固定（与收支语义色同策略）：陶橘/鼠尾草绿/雾蓝/薰衣草紫/麦黄/砖红/青碧/灰粉，各自配同色系深字
- 接入：明细列表行首、统计分类行、记一笔分类选择、账本分类管理

### 3.2 空态插画 `empty-cat`
- 猫 logo（assets/brand/catledger-logo.png 转浅描边 SVG 或低透明 PNG）+ 一句话文案 + 可选操作
- 替换 empty-state 纯文字版用于主场景（首页/明细/贷款/导入历史）

### 3.3 首页 hero 重做
- 时段问候：「早上好 / 下午好 / 晚上好，昵称」（6-11/11-18/18-6 三段，纯展示，不动数据）
- 净值大字（display 56rpx money-number）+ 猫水印（logo 8% 透明铺右下）
- 本月收支结余小字条（B2 已收敛的统计条移入 hero 底部）

## 4. 页面清单与要点

| 页面 | B4 动作 |
|---|---|
| index | hero 重做（问候+净值+水印+统计条）；账户/最近账目保持 list-row |
| transactions | 行首接分类瓷贴（小尺寸）；工具区保持 B2 |
| statistics | 分类构成/排行接瓷贴；图表容器圆角升 xl |
| transaction-editor | 分类选择格接瓷贴；贷款上下文卡保持 B2 |
| accounts / categories | 行首账户类型图标/分类瓷贴；页头统一 |
| profile | 头像区与页头统一；菜单不动 |
| ledger / theme / data-privacy / import-history | 页头统一 + 卡片形态继承 |
| loans / loan-detail / loan-payment / loan-plan / loan-link | 页头统一为 page-head（替换 B1 局部 ld-head）；表单卡继承新形态 |
| import-workbench | 页头统一 + 弹层圆角 xl；其余保持 B3 |

## 5. 不变量

- JS 业务逻辑、事件、数据字段不动（展示层局部状态允许，须注明）
- 六主题全部适配；收支语义色固定；触控与 reduced-motion 约束不变
- 不引入网络字体与位图大图（包体）；新增图形全部为 SVG 或已有 PNG 复用

## 6. 实施顺序

1. **B4a**：token（radius-xl、shadowSoft 加重、胶囊 CTA）+ 组件（page-head、category-tile、empty-cat）
2. **B4b**：首页 hero + 瓷贴接入（明细/统计/记一笔/分类）
3. **B4c**：全页面 page-head 统一 + 空态插画 + 扫尾
4. 验证：check/test 全绿、六主题开发者工具走查、编译预览
