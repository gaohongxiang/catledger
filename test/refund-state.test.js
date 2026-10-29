const test = require('node:test')
const assert = require('node:assert/strict')
const state = require('../miniprogram/packages/finance/pages/import-workbench/refund-state')

test('退款状态文案：本次草稿选择优先于已保存关系', () => {
  const saved = { status: 'confirmed', autoLinked: true }
  assert.equal(state.statusText(saved, null), '系统已自动关联')
  assert.equal(state.statusText(saved, { mode: 'link' }), '已选择原消费')
  assert.equal(state.statusText(saved, { mode: 'pending' }), '已设为暂记待关联')
  assert.equal(state.statusText(saved, { mode: 'unlinked' }), '已清除关联')
  assert.equal(state.statusText({ status: 'ambiguous' }, null), '已关联多笔原消费')
  assert.equal(state.statusText({ status: 'pending' }, null), '已暂记待关联')
  assert.equal(state.statusText(null, null), '待关联原消费')
})

test('退款状态行区分“还有候选可选”和“当前没有候选项”', () => {
  // 列表里还有候选但还没选：提示用户下一步是选一笔，而不是已经无事可做。
  assert.equal(state.statusText(null, null, { candidateCount: 2 }), '待选原消费')
  assert.equal(state.statusText(null, null, { candidateCount: 0 }), '待关联原消费')
  // 金额/时间变化后旧列表已清空，还没重新核对，不能冒充“没有候选”。
  assert.equal(state.statusText(null, null, { stale: true, candidateCount: 0 }), '原消费待核对')
  // 状态四、五优先于“未选择”，与五态表的标题一致。
  assert.equal(state.statusText(null, null, { conflict: true, candidateCount: 2 }), '原单已关闭')
  assert.equal(state.statusText(null, null, { blocked: 'amount' }), '可退金额不足')
  assert.equal(state.statusText(null, null, { blocked: 'invalid' }), '原消费关系需重核')
  // 本次草稿选择仍然优先于已保存状态和候选。
  assert.equal(state.statusText({ status: 'confirmed' }, { mode: 'link' }, { candidateCount: 2 }), '已选择原消费')
})

test('清除动作：草稿暂记/已清除可撤销，已保存关系仍需显式清除', () => {
  assert.deepEqual(state.clearAction(null, null), { visible: false, label: '', target: '' })
  assert.deepEqual(state.clearAction({ status: 'confirmed' }, null), { visible: true, label: '清除关联', target: 'saved' })
  // 本次草稿选择不另设「取消选择」按钮：提示移到候选标题行，再点卡片即取消。
  assert.deepEqual(state.clearAction({ status: 'confirmed' }, { mode: 'link' }), { visible: false, label: '', target: '' })
  // 草稿已暂记时“暂记待关联”让位，这个按钮就是唯一的撤销入口。
  assert.deepEqual(state.clearAction(null, { mode: 'pending' }), { visible: true, label: '取消暂记', target: 'draft' })
  assert.deepEqual(state.clearAction({ status: 'confirmed' }, { mode: 'unlinked' }), { visible: true, label: '撤销清除', target: 'draft' })
})

test('暂记按钮是用户的决定：不受候选、读取状态或草稿选择影响', () => {
  // 有候选时也能选“这些都不是，先不关联”；暂记不再等两个范围都读空。
  assert.equal(state.pendingAction({}).enabled, true)
  assert.match(state.pendingAction({}).reason, /补关联/)
  assert.equal(state.pendingAction({ draftLink: true }).enabled, true)
  assert.match(state.pendingAction({ draftLink: true }).reason, /选中的原消费不会生效/)
  // 草稿已暂记时不再重复显示按钮，撤销由「取消暂记」承担。
  assert.equal(state.pendingAction({ draftPending: true }).visible, false)
  // 来源冲突（原单已关闭）没有“以后补关联”的原消费，正确结果是按已退回处理。
  assert.equal(state.pendingAction({ conflict: true }).visible, false)
  assert.equal(state.pendingAction({ conflict: true }).enabled, false)
})
