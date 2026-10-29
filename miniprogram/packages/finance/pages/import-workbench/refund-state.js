// 退款关系区的显示状态。只做“事实 + 草稿”到文案/动作的映射，不读网络、不写草稿。
// 单笔编辑器和问题面板共用这里，避免同一个“暂记待关联”在两个入口各有一套可点条件。
const SAVED = new Set(['confirmed', 'ambiguous', 'pending'])

// 状态行只描述当前关系处在哪一步，不替系统断言“已经确认没有原消费”：
// 列表里还能看到候选时是「待选原消费」；没有候选或尚未重新核对时是「待关联原消费」，
// 表示这笔退款还没有关联，而不是“系统查过了确实没有”。
function statusText(originalRefund, draft, facts = {}) {
  if (draft && draft.mode === 'link') return '已选择原消费'
  if (draft && draft.mode === 'pending') return '已设为暂记待关联'
  if (draft && draft.mode === 'unlinked') return '已清除关联'
  if (facts.conflict) return '原单已关闭'
  if (facts.blocked === 'amount') return '可退金额不足'
  if (facts.blocked === 'invalid') return '原消费关系需重核'
  const status = originalRefund && originalRefund.status
  if (status === 'confirmed') return originalRefund.autoLinked ? '系统已自动关联' : '已关联原消费'
  if (status === 'ambiguous') return '已关联多笔原消费'
  if (status === 'pending') return '已暂记待关联'
  if (facts.stale) return '原消费待核对'
  return Number(facts.candidateCount || 0) > 0 ? '待选原消费' : '待关联原消费'
}

// 可选单选组：有草稿选择时先取消草稿（回到已保存状态）；没有草稿选择时才清除已保存关系。
// 这样“再点一次已选项”不会直接拆掉账本里的关系，清除已保存关系仍是明确动作。
function clearAction(originalRefund, draft) {
  if (draft) {
    // 本次草稿选中的原消费再点一次卡片即可取消，不另设“取消选择”按钮；
    // 暂记和“已清除”仍各留一个说得清方向的撤销动作。
    if (draft.mode === 'link') return { visible: false, label: '', target: '' }
    return { visible: true, label: draft.mode === 'pending' ? '取消暂记' : '撤销清除', target: 'draft' }
  }
  if (SAVED.has(originalRefund && originalRefund.status)) return { visible: true, label: '清除关联', target: 'saved' }
  return { visible: false, label: '', target: '' }
}

// 暂记是用户的决定，不是系统资格：不管候选有多少、是否正在读、其他字段是否还有待核对项，
// 用户都可以选择“先入账、暂不冲减支出”，之后在账本里补关联。唯一不能暂记的是来源冲突
// （原单已关闭却退款成功），那时正确结果是按已退回处理，净额 0。
// 草稿已经暂记时让位给「取消暂记」，同一时刻只留一个说得清方向的动作。
function pendingAction(options = {}) {
  if (options.conflict) return { visible: false, enabled: false, reason: '' }
  if (options.draftPending) return { visible: false, enabled: false, reason: '' }
  return { visible: true, enabled: true,
    reason: options.draftLink
      ? '保存后改为暂不关联，上面选中的原消费不会生效；之后仍可在账本里补关联。'
      : '先记入账户、不冲减支出；之后可在账本里补关联。' }
}

module.exports = { statusText, clearAction, pendingAction }
