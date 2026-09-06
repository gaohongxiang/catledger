# 全页面交付核对

## 基线与整合

产品基线 `main@1b37788ced1b3ca4cdf4f8a9275bc94db2ec6f62`；继承 `PR8@512cd6f213e19f907d1510b8bd14f711d91afead`，对照 `PR7@3344cf42ef242fcd3e4dc525ae4100416000e9fe`。唯一交付分支为 `codex/mini-1906ui-all-pages`；用户要求不创建新 PR、不合并 main、不部署。

| 来源 | 保留或取舍 |
| --- | --- |
| PR7 首页、白色列表及清秀字感 | 与 PR8 相同目标，统一到全局排版，不重复叠加覆盖规则 |
| PR7 成功文件继续 | 保留 selected 状态下移除最后一个排队文件后的继续入口 |
| PR7 核对解释 | 保留 issueFieldsReason、paymentValidationHint，只解释原模型结论，不决定保存权限 |
| PR7 证据展开 | 保留 issueSourceExpanded / toggleIssueSource，原始记录仍在同一滚动面板内 |
| PR7 recordSummaryExpanded | 不引入；由 PR8 record-summary 组件唯一管理展开 |
| PR7 纵向新账户表单 | 不采用；用户后续明确要求三项同行 |
| PR8 三项同行和陶橘新建段 | 完整保留原事件、类型值、名称输入与确认门禁 |
| PR8 记录统计组件、排除/重复可见 | 完整保留，核对数与分类数不混加 |
| 两 PR 中的临时校验工作流 | 不进入最终源码树；仓库原有 verify.yml 不改 |

## 本地已执行

- `node --test test/*.test.js`：192 项通过，0 失败、0 跳过。
- `npm run check`、`git diff --check`：通过。
- 新增 `test/ui-all-pages.test.js` 22 项，含 11 个页面注册与事件/WXML结构核对，及真实 Page 方法的首次失败/成功/刷新失败、月份切换、统计零值、付款门禁、分类拖拽行高、编辑准备失败/停用账户等回归。
- 使用固定 `miniprogram-compiler@0.2.3` 内的 wcc/wcsc 离线编译：14 个 WXML、15 个 WXSS 通过。可复现命令：`node scripts/check-ui-templates.js <隔离工具目录/node_modules/miniprogram-compiler>`。工具不属于运行时依赖，也不是最新微信开发者工具的替代品。
- 由实际 WXML/WXSS 与合成数据生成浏览器映射：78 个页面/状态组合 × 6 主题 × 4 屏宽（320/375/390/430）＝1872 个场景；另加登录/记账入口各主题屏宽共48个场景。检查表达式、横向越界、金额省略/裁切与三控件同行，全部通过。布局证据不表示真实上传、支付、登录或财务写入已经执行。
- 暖橘图标通过已有 `generate-theme-icons.js` 从原矢量轮廓重生成；其他五主题和收入/支出语义色保持不变。

## 远端已执行

2026-09-06 在干净 Node 18 / MySQL 8.4 环境完成 [全页面最终整合验证](https://github.com/gaohongxiang/catledger/actions/runs/34056281490)。该运行从固定 PR8 基线还原经过摘要校验的候选文件，验证完整源码树 `598910abf84cd7b29dba88e54321ef33cb199f10`，全部检查通过后才向指定新分支推送实现提交 `1e80cec762b72aded93652f9b5c922f8a326a652`；其第二父提交为 PR7 HEAD，PR8 为第一父链祖先，两份历史均保留。

| 检查 | 结果 |
| --- | --- |
| 根目录测试 | 192/192，0 失败、0 跳过 |
| API 测试 | 73/73，0 失败、0 跳过 |
| 导入服务测试 | 220/220，0 失败、0 跳过 |
| 合计 | 485/485，0 失败、0 跳过 |
| 静态检查 | 470 个文件、93 个运行时模块通过 |
| 两函数生产依赖审计 | 均为 0 漏洞 |
| wcc / wcsc 离线编译 | 14 个 WXML / 15 个 WXSS 通过 |
| 候选文件与源码树摘要、diff 空白检查 | 通过 |

验证产物 `ui-all-final-validation` 包含 test.log、check.log、templates.log、两支审计日志和 published.json。工作流运行的触发提交是临时准备提交，实际通过验证并推送的源码树和实现提交以上述 published.json 为准；不得把准备提交误写成最终界面代码。此次文档提交只补充验证记录，随后由仓库既有验证工作流再次检查最终分支。

验证受保护路径：cloudfunctions、shared、migrations、所有既有 model.js、服务调用模块保持原内容。更改的 Page JavaScript 仅涉及显示状态、图表选中项、提示、展开及与视觉行高对应的拖拽命中，不改变 API 请求结构、金额转换、来源语义或正式账务规则。全部临时快照、传输和验证工作流已从交付源码树移除，原有 verify.yml 未修改。

## 未执行与回退

没有微信开发者工具、iOS/Android 微信运行时以及真实身份终端，未执行真机字体、系统字号、键盘与安全区、真实上传及财务写入验收。所有请求/计算回归使用隔离 MySQL 与合成数据。完整产品发布不由本次界面分支交付替代。

不合并、不部署、不上传体验版。回退为界面与文档提交回退，没有数据迁移；旧 PR 关闭后历史提交仍保留，两个源分支不作远端删除。
