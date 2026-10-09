const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// 只隔离展示层边界：标签由现有 eventView 提供，不在这里复制性质识别规则。
const filename = path.join(__dirname, '../miniprogram/pages/import-workbench/presentation.js')
const source = fs.readFileSync(filename, 'utf8')
function presentation() {
  const model = {
    eventView: event => Object.assign({}, event, { natureLabel: event.projectedNatureLabel }),
    issueView: issue => issue,
    reviewIssueRows: issues => issues,
    reviewIssueGroups: issues => [{ key: 'group', issueType: 'same_event', issues }],
    categoryIssueCards: issues => issues
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, require: name => {
    assert.equal(name, './model')
    return model
  } }, { filename })
  return module.exports
}
function event(label) {
  return { eventId: 'event-1', economicNature: 'repayment', projectedNatureLabel: label,
    amountText: '100.00', displayTitle: '合成交易', pendingIssue: {
      issueId: 'issue-1', label: '转入账户待确认', decisionText: '缺失提示保持原文',
      memberCount: 3, candidateCount: 1
    } }
}

for (const label of ['收入', '支出', '内部转账', '借款', '还款', '退款', '费用',
  '余额调整', '待确认', '分期本金出账', '分期利息', '分期手续费']) {
  test('待核对复用已有性质标签：' + label, () => {
    const input = event(label)
    const before = JSON.stringify(input)
    const result = presentation().pendingCard(input, false)
    assert.equal(result.natureLabel, label)
    assert.equal(result.batchDecision, '处理')
    assert.equal(result.subjects[0].natureLabel, label)
    assert.equal(result.label, (label === '待确认' ? '' : label + '｜') + '转入账户待确认' + (label === '待确认' ? ' · 性质待确认' : '') + '（同组 2 笔）')
    assert.equal(result.decisionText, '', '不再发送已隐藏的重复说明')
    assert.equal(result.scopeCount, 2)
    assert.equal(result.groupCount, undefined)
    assert.equal(result.eventId, input.eventId)
    assert.equal(result.issueId, input.pendingIssue.issueId)
    assert.equal(JSON.stringify(input), before)
  })
}

test('没有性质或未关联问题时保留明确回退和原查看入口', () => {
  const input = event(undefined)
  delete input.pendingIssue
  const result = presentation().pendingCard(input, false)
  assert.equal(result.natureLabel, '性质待确认')
  assert.equal(result.batchDecision, '查看详情')
  assert.equal(result.label, '性质待确认')
})

test('修正性质后以新投影刷新，不复用旧标签', () => {
  const view = presentation(), input = event('支出')
  const before = view.pendingCard(input, false)
  const after = view.pendingCard(Object.assign({}, input, { projectedNatureLabel: '退款' }), false)
  assert.equal(before.batchDecision, '处理')
  assert.match(before.label, /^支出｜/)
  assert.equal(after.batchDecision, '处理')
  assert.match(after.label, /^退款｜/)
  assert.equal(before.eventId, after.eventId)
})

test('分类卡片保留原收支类别和操作文案', () => {
  const view = presentation()
  const input = Object.assign(event('分期利息'), { economicNature: 'fee' })
  assert.equal(view.pendingCard(input, true).natureLabel, '支出')
  assert.equal(view.pendingCard(input, true).batchDecision, '分类')
  delete input.pendingIssue
  assert.equal(view.pendingCard(input, true).batchDecision, '去核对')
})

function reviewIssues(labels) {
  return [{ issueId: 'issue-1', issueType: 'same_event', label: '判断是否同一笔',
    decisionText: '保留原核对提示', batchDecision: '核对', subjectCount: labels.length,
    subjects: labels.map((label, index) => Object.assign(event(label), { eventId: 'event-' + index })) }]
}
function fallbackCard(view, labels) {
  return view.reviewLists({ hydratedIssues: reviewIssues(labels) }, {}, {
    activeReviewTab: 'review', activeReviewStatus: 'pending'
  }, 0).reviewGroups[0].issues[0]
}

test('兼容问题列表也显示性质，不改变原核对提示', () => {
  const result = fallbackCard(presentation(), ['退款', '退款'])
  assert.equal(result.batchDecision, '处理')
  assert.equal(result.label, '判断是否同一笔｜退款（同组 2 笔）')
  assert.equal(result.decisionText, '')
  assert.equal(result.subjects.length, 2)
})

test('混合性质或部分未知的旧问题组不能用首笔性质代表整组', () => {
  const view = presentation()
  assert.equal(fallbackCard(view, ['支出', '退款']).label, '判断是否同一笔｜多种性质（同组 2 笔）')
  assert.equal(fallbackCard(view, ['支出', undefined]).label, '判断是否同一笔｜多种性质（同组 2 笔）')
})

test('已核对记录仍使用原性质展示，不附加待核对操作', () => {
  const result = presentation().reviewLists({ reviewedEvents: [event('分期本金出账')] }, {}, {
    activeReviewTab: 'review', activeReviewStatus: 'completed'
  }, 0)
  assert.equal(result.reviewedEvents[0].natureLabel, '分期本金出账')
  assert.equal(result.reviewedEvents[0].batchDecision, undefined)
})
