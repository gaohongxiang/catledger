const test = require('node:test')
const assert = require('node:assert/strict')
const XLSX = require('../cloudfunctions/catledger-import/node_modules/xlsx')
const { parseEvidenceFile } = require('../cloudfunctions/catledger-import/src/parsers')
const { buildRowIdentity, buildSourceProfile } = require('../cloudfunctions/catledger-import/src/identity')
const { getRowSemantic } = require('../cloudfunctions/catledger-import/src/row-semantic-resolver')
const { confirmedBinding } = require('../cloudfunctions/catledger-import/src/account-binding')
const { buildOrganizePlan } = require('../cloudfunctions/catledger-import/src/organizer-planner')
const ownership = require('../cloudfunctions/catledger-import/src/account-ownership')
const { funds, preservesBankProjectionAccounts } = require('../cloudfunctions/catledger-import/src/funds-route')
const { prepare } = require('../cloudfunctions/catledger-import/src/review/editor-policy')
const { transactionDrafts } = require('../cloudfunctions/catledger-import/src/finance-update-posting')
const bankMappingView = require('../miniprogram/packages/finance/pages/import-workbench/bank-mapping')
const { refreshEventSemantic } = require('../cloudfunctions/catledger-import/src/semantic-plan-upgrade')
const { FIELD_MASK } = require('../cloudfunctions/catledger-import/src/manual-field-mask')
const { planAccountIssueUpgrade } = require('../cloudfunctions/catledger-import/src/account-plan-upgrade')

const ownNumber = '9900000000001122', otherNumber = '8800000000001122'
const source = { accountId: '00000000-0000-4000-8000-000000000101', name: '合成付款卡1122', type: 'bank', currency: 'CNY' }
const destination = { accountId: '00000000-0000-4000-8000-000000000102', name: '合成收款卡1122', type: 'bank', currency: 'CNY' }
const accounts = [source, destination]
const header = ['交易日期', '交易金额', '收支', '交易类型', '本方账号', '对方户名', '对方账号', '流水号', '摘要', '备注']
const ledger = account => ({ kind: 'ledger', accountId: account.accountId })
const external = { kind: 'external' }

async function parseContent(content, extension = 'csv', overrides = {}) {
  const input = { content, extension, timezoneOffsetMinutes: -480 }
  const preview = (await parseEvidenceFile(input)).bankPreview
  const bankMapping = { ...preview.suggested, schemaVersion: 1, sheetIndex: preview.sheetIndex,
    headerRow: preview.headerRow, headerToken: preview.headerToken, ...overrides }
  const document = await parseEvidenceFile({ ...input, bankMapping })
  const parsed = document.rows[0]
  const row = { ...parsed.raw, ...parsed.normalized,
    rowId: 'synthetic-bank-row', batchId: 'synthetic-bank-batch', importId: 'synthetic-bank-file',
    sourceType: 'bank', sourceFormat: 'bank_' + extension, parseState: parsed.parseState, identityState: 'new',
    rawTransactionType: parsed.raw.transactionType, rawStatus: parsed.raw.status,
    paymentMethod: parsed.raw.paymentMethod, paymentMethodKey: parsed.bankPaymentKey,
    counterpartyAccountNumberReliable: parsed.observations.counterpartyAccount.numberReliable,
    sourceDirection: parsed.normalized.direction, semantic: parsed.semantic }
  return { document, parsed, row, semantic: getRowSemantic(row), bankMapping, preview }
}

async function fixture({ direction = '收入', type = '转账', own = ownNumber, other = otherNumber,
  counterparty = '合成甲', item = '', note = '', extension = 'csv', statementKind } = {}) {
  const record = ['2026-11-01 09:30:00', '100.00', direction, type, own, counterparty, other,
    'SYNTHETIC-BANK-ENDPOINT-1', item, note]
  let content
  if (extension === 'csv') content = Buffer.from([header, record].map(row => row.join(',')).join('\n'))
  else {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header, record]), '合成账户明细')
    content = XLSX.write(book, { type: 'buffer', bookType: extension === 'xls' ? 'biff8' : 'xlsx' })
  }
  return parseContent(content, extension, statementKind ? { statementKind } : {})
}

function mapping(reference, account, kind = 'account', scope = 'batch') {
  return { sourceType: 'bank', paymentMethodKey: reference.bindingKey, mappingAction: kind,
    mappingScope: scope, accountId: kind === 'account' ? account.accountId : null,
    binding: confirmedBinding(reference) }
}

function plan(row, paymentMappings = []) {
  return buildOrganizePlan({ updateId: 'synthetic-bank-update', rows: [row], accounts, paymentMappings })
}

function assigned(facts, sourceKind = 'account', destinationKind = 'account') {
  const projection = facts.semantic.fundsProjection
  return plan(facts.row, [projection.from && mapping(projection.from, source, sourceKind),
    projection.to && mapping(projection.to, destination, destinationKind)].filter(Boolean))
}

function assertDraft(event, type, from, to) {
  const drafts = transactionDrafts(event)
  assert.equal(drafts.length, 1)
  assert.deepEqual([drafts[0].type, drafts[0].sourceAccountId, drafts[0].destinationAccountId, drafts[0].amountMinor],
    [type, from, to, '10000'])
}

test('银行对方户名与账号分别采集，完整号码只提供待确认引用', async () => {
  const facts = await fixture()
  assert.equal(facts.bankMapping.columns.counterparty, 5)
  assert.equal(facts.bankMapping.columns.counterpartyAccount, 6)
  assert.equal(facts.parsed.raw.counterparty, '合成甲')
  assert.equal(facts.parsed.raw.counterpartyAccount, otherNumber)
  assert.equal(facts.parsed.rawFields.find(field => field.name === '对方账号').value, otherNumber)
  assert.equal(facts.parsed.observations.counterpartyAccount.numberReliable, true)
  const projection = facts.semantic.fundsProjection
  assert.equal(projection.accountOrder, 'actual')
  assert.equal(projection.from.value, otherNumber)
  assert.equal(projection.to.value, ownNumber)
  assert.notEqual(projection.from.bindingKey, projection.to.bindingKey, '同尾号的两张完整卡不能合成一张')
  assert.equal(projection.from.binding.scopeKind, 'instrument')
  assert.equal(projection.from.binding.reusable, true)
  const review = plan(facts.row), view = ownership.read(review.events[0])
  assert.equal(review.events[0].status, 'needs_action')
  assert.equal(view.source.kind, 'unknown')
  assert.equal(view.destination.kind, 'unknown')
  assert.equal(review.issues.filter(issue => issue.status === 'open' && issue.issueType === 'account_mapping').length, 2)
})

test('银行列映射页面确认与人工调整都保留独立对方账号字段', async () => {
  const facts = await fixture()
  const sheet = bankMappingView.view('synthetic-client', '合成银行.csv', facts.preview)
  const field = sheet.fields.find(item => item.key === 'counterpartyAccount')
  assert.equal(field.label, '对方卡号或账号')
  assert.equal(field.status, 'auto')
  assert.equal(bankMappingView.payload(sheet).value.columns.counterpartyAccount, 6)
  const preview = { ...facts.preview, suggested: { ...facts.preview.suggested,
    columns: { ...facts.preview.suggested.columns, counterpartyAccount: undefined } } }
  const manual = bankMappingView.view('synthetic-client', '合成银行.csv', preview,
    { ...preview.suggested, columns: { ...preview.suggested.columns, counterpartyAccount: 6 } })
  assert.equal(manual.fields.find(item => item.key === 'counterpartyAccount').status, 'manual')
  assert.equal(bankMappingView.payload(manual).value.columns.counterpartyAccount, 6)
})

for (const direction of ['收入', '支出']) {
  test(direction + '银行转账：确认两个实际端点后，规划与入账方向一致', async () => {
    const facts = await fixture({ direction })
    const event = assigned(facts).events[0]
    assert.equal(event.status, 'ready')
    assert.equal(event.economicNature, 'internal_transfer')
    assert.equal(event.sourceDirection, direction === '收入' ? 'income' : 'expense')
    assert.deepEqual(funds(event), { sourceAccountId: source.accountId, destinationAccountId: destination.accountId, reverse: false })
    assert.deepEqual(ownership.read(event).source, ledger(source))
    assert.deepEqual(ownership.read(event).destination, ledger(destination))
    assertDraft(event, 'transfer', source.accountId, destination.accountId)
  })

  test(direction + '银行转账：本方也可属于外部，归属决定收入、支出或不计入', async () => {
    const facts = await fixture({ direction })
    const incoming = assigned(facts, 'external', 'account').events[0]
    assert.equal(incoming.economicNature, 'income')
    assertDraft(incoming, 'income', null, destination.accountId)
    const outgoing = assigned(facts, 'account', 'external').events[0]
    assert.equal(outgoing.economicNature, 'expense')
    assertDraft(outgoing, 'expense', source.accountId, null)
    const outside = assigned(facts, 'external', 'external').events[0]
    assert.equal(outside.status, 'excluded')
    assert.equal(ownership.read(outside).noLedgerImpact, true)
    for (const event of [incoming, outgoing, outside]) {
      assert.equal(event.sourceDirection, facts.row.direction, '归属决定不能改写账单原方向')
      assert.equal(event.fieldSources.accountOwnership.businessNature, 'internal_transfer')
    }
  })

  test(direction + '银行转账：编辑保存及收支改选往返，不翻转付款与收款端', async () => {
    const facts = await fixture({ direction })
    const original = assigned(facts).events[0]
    const saved = prepare(original, { editorVersion: 1, fields: { note: '合成核对备注' } })
    assertDraft(saved, 'transfer', source.accountId, destination.accountId)
    const incoming = prepare(saved, { editorVersion: 1, decisions: {
      accountOwnership: { source: external, destination: ledger(destination) } } })
    assertDraft(incoming, 'income', null, destination.accountId)
    const outgoing = prepare(incoming, { editorVersion: 1, decisions: {
      accountOwnership: { source: ledger(source), destination: external } } })
    assertDraft(outgoing, 'expense', source.accountId, null)
    const restored = prepare(outgoing, { editorVersion: 1, decisions: {
      accountOwnership: { source: ledger(source), destination: ledger(destination) } } })
    assertDraft(restored, 'transfer', source.accountId, destination.accountId)
    assert.equal(restored.sourceDirection, original.sourceDirection)
    assert.equal(restored.fieldSources.editorOverrides.note, '合成核对备注')
  })
}

test('明确工资和消费的对方即使有卡号，仍只确认本方账户', async () => {
  for (const [direction, type, item, nature] of [
    ['收入', '工资', '', 'income'], ['支出', '消费', '', 'expense'],
    ['收入', '转账', '代发工资', 'income'], ['支出', '其他', '消费', 'expense']
  ]) {
    const facts = await fixture({ direction, type, item })
    assert.equal(facts.semantic.fundsProjection, null)
    const initial = plan(facts.row)
    assert.equal(initial.events[0].economicNature, nature)
    assert.equal(initial.issues.filter(issue => issue.issueType === 'account_mapping').length, 1)
    const view = ownership.read(initial.events[0])
    assert.equal(view[nature === 'income' ? 'source' : 'destination'].kind, 'external')
    assert.equal(view[nature === 'income' ? 'destination' : 'source'].kind, 'unknown')
  }
})

test('只有方向、户名或自由备注不推断银行交易性质；矛盾转入转出保持待核对', async () => {
  for (const options of [
    { type: '其他' }, { type: '', counterparty: '工资', note: '工资' },
    { type: '转入', direction: '支出' }, { type: '转出', direction: '收入' },
    { type: '转账', note: '退汇' }
  ]) {
    const facts = await fixture(options), event = plan(facts.row).events[0]
    assert.equal(facts.semantic.fundsProjection, null)
    assert.equal(event.economicNature, 'unknown')
    assert.equal(event.status, 'needs_action')
    assert.ok(event.reasonCodes.includes('economic_nature_required'))
  }
})

test('明确转账缺少必要账户仍保留待办，户名不会变成账户引用', async () => {
  for (const direction of ['收入', '支出']) {
    for (const options of [{ other: '' }, { other: '老妈(合成甲)' }, { own: '' }, { own: '', other: '' }]) {
      const facts = await fixture({ direction, ...options }), projection = facts.semantic.fundsProjection
      assert.ok(projection)
      const hasOther = options.other == null
      const other = direction === '收入' ? projection.from : projection.to
      assert.equal(Boolean(other), hasOther)
      const review = assigned(facts), event = review.events[0], view = ownership.read(event)
      assert.equal(event.economicNature, 'internal_transfer')
      assert.equal(event.status, 'needs_action')
      assert.ok(view.source.kind === 'unknown' || view.destination.kind === 'unknown')
      assert.equal(view.noLedgerImpact, false)
      assert.ok(review.issues.some(issue => issue.status === 'open' && issue.blocking))
    }
  }
})

test('只有尾号不能从历史认领；完整卡号也必须有用户确认过的绑定', async () => {
  for (const other of ['****1122', '1122', otherNumber]) {
    const facts = await fixture({ other }), reference = facts.semantic.fundsProjection.from
    const otherFile = getRowSemantic({ ...facts.row, importId: 'synthetic-bank-another-file' }).fundsProjection.from
    const confirmed = mapping(reference, source, 'account', 'history')
    const unconfirmed = { ...confirmed, binding: reference.binding }
    const unconfirmedPlan = plan(facts.row, [unconfirmed])
    assert.equal(ownership.read(unconfirmedPlan.events[0]).source.kind, 'unknown')
    if (other === otherNumber) {
      assert.equal(reference.bindingKey, otherFile.bindingKey)
      assert.equal(ownership.read(plan(facts.row, [confirmed]).events[0]).source.accountId, source.accountId)
    } else {
      assert.notEqual(reference.bindingKey, otherFile.bindingKey)
      assert.equal(reference.binding.reusable, false)
      assert.equal(ownership.read(plan(facts.row, [confirmed]).events[0]).source.kind, 'unknown')
    }
  }
})

test('同尾号本方与对方分开确认；不同来源行的弱对方也不互相认领', async () => {
  const facts = await fixture({ own: '****1122', other: '****1122' }), projection = facts.semantic.fundsProjection
  assert.equal(projection.to.binding.scopeKind, 'file')
  assert.equal(projection.from.binding.scopeKind, 'row')
  assert.notEqual(projection.from.bindingKey, projection.to.bindingKey)
  const initial = plan(facts.row)
  assert.equal(initial.issues.filter(issue => issue.issueType === 'account_mapping').length, 2)
  const partial = plan(facts.row, [mapping(projection.from, null, 'external')]).events[0]
  assert.equal(partial.status, 'needs_action')
  assert.equal(ownership.read(partial).source.kind, 'external')
  assert.equal(ownership.read(partial).destination.kind, 'unknown')
  const otherRow = { ...facts.row, rowId: 'synthetic-bank-another-row', counterparty: '合成乙' }
  const otherProjection = getRowSemantic(otherRow).fundsProjection
  assert.equal(otherProjection.to.bindingKey, projection.to.bindingKey, '同文件本方仍可合并核对')
  assert.notEqual(otherProjection.from.bindingKey, projection.from.bindingKey, '同尾号对方没有同一账户证据')
  assert.equal(ownership.read(plan(otherRow, [mapping(projection.from, null, 'external')]).events[0]).source.kind, 'unknown')
  const confirmed = assigned(facts, 'external', 'account').events[0]
  assert.equal(confirmed.economicNature, 'income')
  assertDraft(confirmed, 'income', null, destination.accountId)
})

test('Excel 数值对方账号不能获得完整号码的可复用身份，本方来源身份不受影响', async () => {
  for (const extension of ['xls', 'xlsx']) {
    const facts = await fixture({ extension, other: Number(otherNumber) })
    const reference = facts.semantic.fundsProjection.from
    assert.equal(facts.parsed.observations.counterpartyAccount.numberReliable, false)
    assert.equal(reference.binding.scopeKind, 'row')
    assert.equal(reference.binding.reusable, false)
    assert.equal(buildRowIdentity({ sourceType: 'bank', sourceProfileKey: 'unbound',
      fileSha256: '1'.repeat(64), row: facts.parsed }).kind, 'source_transaction_id')
  }
})

test('信用卡账单的本方类型不传播给对方账户', async () => {
  const facts = await fixture({ statementKind: 'credit' })
  assert.equal(facts.semantic.fundsProjection.to.expectedAccountType, 'credit')
  assert.notEqual(facts.semantic.fundsProjection.from.expectedAccountType, 'credit')
})

test('旧语义版本重新计算两端时仍保留原始对方账号和可靠性', async () => {
  const facts = await fixture()
  const recomputed = getRowSemantic({ ...facts.row, semantic: {
    ...facts.parsed.semantic, profileVersion: 'bank-profile-v4', policyVersion: 'bank-policy-v4', fundsProjection: null } })
  assert.deepEqual(recomputed.fundsProjection, facts.semantic.fundsProjection)
  assert.equal(facts.document.descriptor.parserVersion, 'bank-parser-v4')
  assert.equal(facts.document.descriptor.normalizationVersion, 'bank-normalization-v4')
})

test('旧转入只确认了本方账户时，升级搬动同一账户和人工位，不把收款方变付款方', async () => {
  const facts = await fixture(), base = plan(facts.row).events[0]
  const current = { ...base, economicNature: 'unknown', flowDirection: 'inflow',
    ledgerAccountId: destination.accountId, counterpartyLedgerAccountId: null,
    manualFieldMask: FIELD_MASK.ledgerAccountId | FIELD_MASK.note, reasonCodes: ['economic_nature_required'],
    fieldSources: { ...base.fieldSources, fundsProjection: null, editorOverrides: { version: 1, note: '已核对本方' } } }
  const row = { ...facts.row, semantic: { ...facts.parsed.semantic, profileVersion: 'bank-profile-v4', policyVersion: 'bank-policy-v4',
    sourceAction: null, fromAccountRef: null, toAccountRef: facts.parsed.semantic.ledgerAccountRef, fundsProjection: null,
    legacy: { kind: 'unknown', transactionType: 'unknown', economicEffect: 'normal' } } }
  const original = JSON.stringify(current), next = refreshEventSemantic(current, [row])
  assert.equal(next.fieldSources.fundsProjection.accountOrder, 'actual')
  assert.equal(next.ledgerAccountId, null)
  assert.equal(next.counterpartyLedgerAccountId, destination.accountId)
  assert.equal(next.manualFieldMask, FIELD_MASK.counterpartyLedgerAccountId | FIELD_MASK.note)
  assert.equal(ownership.read(next).source.kind, 'unknown')
  assert.deepEqual(ownership.read(next).destination, ledger(destination))
  assert.equal(preservesBankProjectionAccounts(current, next), true)
  assert.equal(preservesBankProjectionAccounts(current, { ...next, counterpartyLedgerAccountId: source.accountId }), false)
  assert.equal(preservesBankProjectionAccounts(current, { ...next, ledgerAccountId: source.accountId }), false)
  assert.equal(preservesBankProjectionAccounts(current, { ...next, manualFieldMask: 0 }), false)
  assert.equal(JSON.stringify(current), original)
})

test('旧人工收入、两端和归属决定保持原契约；不明观察方向留下核对', async () => {
  const facts = await fixture(), base = plan(facts.row).events[0]
  const row = { ...facts.row, semantic: { ...facts.parsed.semantic, profileVersion: 'bank-profile-v4', policyVersion: 'bank-policy-v4',
    sourceAction: null, fromAccountRef: null, toAccountRef: facts.parsed.semantic.ledgerAccountRef, fundsProjection: null,
    legacy: { kind: 'unknown', transactionType: 'unknown', economicEffect: 'normal' } } }
  const ordinary = { ...base, economicNature: 'income', flowDirection: 'inflow', ledgerAccountId: destination.accountId,
    counterpartyLedgerAccountId: null, manualFieldMask: FIELD_MASK.ledgerAccountId | FIELD_MASK.economicNature | FIELD_MASK.flowDirection,
    fieldSources: { ...base.fieldSources, fundsProjection: null } }
  const movement = { ...ordinary, economicNature: 'internal_transfer', flowDirection: 'neutral',
    counterpartyLedgerAccountId: source.accountId, manualFieldMask: ordinary.manualFieldMask | FIELD_MASK.counterpartyLedgerAccountId }
  const explicit = ownership.apply(movement, { source: ledger(source), destination: ledger(destination) }, { accounts })
  for (const current of [ordinary, movement, explicit]) {
    const next = refreshEventSemantic(current, [row])
    assert.equal(next.fieldSources.fundsProjection, null)
    assert.equal(next.economicNature, current.economicNature)
    assert.equal(next.ledgerAccountId, current.ledgerAccountId)
    assert.equal(next.counterpartyLedgerAccountId, current.counterpartyLedgerAccountId)
    assert.equal(next.manualFieldMask, current.manualFieldMask)
    assertDraft(next, current === ordinary ? 'income' : 'transfer', current === ordinary ? null : source.accountId, destination.accountId)
  }
  const unclear = { ...ordinary, economicNature: 'unknown', sourceDirection: null, manualFieldMask: FIELD_MASK.ledgerAccountId }
  const next = refreshEventSemantic(unclear, [row])
  assert.ok(next.reasonCodes.includes('core_fields_conflict'))
  assert.equal(next.ledgerAccountId, destination.accountId)
  assert.equal(next.counterpartyLedgerAccountId, null)
  assert.equal(next.fieldSources.fundsProjection, null)
})

test('旧银行事项随观察端迁移角色，只新增未确认的另一端，并承接原决定', async () => {
  for (const direction of ['收入', '支出']) {
    const facts = await fixture({ direction }), base = plan(facts.row).events[0]
    for (const confirmed of [true, false]) {
      const current = { ...base, economicNature: 'unknown', flowDirection: direction === '收入' ? 'inflow' : 'outflow',
        ledgerAccountId: confirmed ? (direction === '收入' ? destination.accountId : source.accountId) : null,
        counterpartyLedgerAccountId: null, manualFieldMask: confirmed ? FIELD_MASK.ledgerAccountId : 0,
        reasonCodes: ['economic_nature_required'], fieldSources: { ...base.fieldSources, fundsProjection: null } }
      const row = { ...facts.row, semantic: { ...facts.parsed.semantic, profileVersion: 'bank-profile-v4', policyVersion: 'bank-policy-v4',
        sourceAction: null, fundsProjection: null, legacy: { kind: 'unknown', transactionType: 'unknown', economicEffect: 'normal' } } }
      const next = refreshEventSemantic(current, [row])
      const upgrade = planAccountIssueUpgrade({ updateId: base.updateId, previousEvents: [current], events: [next],
        issues: [{ issueId: 'legacy-account-issue', issueType: 'account_mapping', status: confirmed ? 'resolved' : 'open' }],
        members: [{ issueId: 'legacy-account-issue', objectType: 'event', objectId: base.eventId, memberRole: 'subject' }] })
      const ownRole = direction === '收入' ? 'mapping_to' : 'mapping_from', otherRole = direction === '收入' ? 'mapping_from' : 'mapping_to'
      assert.equal(upgrade.issues.length, 2)
      assert.deepEqual(upgrade.supersededIssueIds, ['legacy-account-issue'])
      assert.equal(upgrade.accountIssueMappings.length, 1)
      const carriedId = upgrade.accountIssueMappings[0].toIssueId
      assert.equal(upgrade.accountIssueMappings[0].fromIssueId, 'legacy-account-issue')
      assert.equal(upgrade.members.find(member => member.issueId === carriedId).memberRole, ownRole)
      assert.equal(upgrade.issues.find(issue => issue.issueId === carriedId).status, confirmed ? 'resolved' : 'open')
      assert.equal(upgrade.members.find(member => member.issueId !== carriedId).memberRole, otherRole)
      assert.equal(upgrade.issues.find(issue => issue.issueId !== carriedId).status, 'open')
      const stable = planAccountIssueUpgrade({ updateId: base.updateId, previousEvents: [next], events: [next],
        issues: upgrade.issues, members: upgrade.members })
      assert.equal(stable.issues.length, 0, '第二次检查不能重复创建缺端卡')
    }
  }
})

test('新双端提取不改变旧来源身份、去重键或核心摘要', async () => {
  // c9b96f4 对以下合成 CSV 生成的固定回归值；升级只能完善语义，不能制造第二条来源。
  const previous = [
    { own: ownNumber, bankAccountIdentity: '3eb85bba907e050ccae7da7baf9cbe9f3fc14e3e5c78adebdc4717b8b2220a6f',
      bankPaymentKey: 'f7755877cb32ee2771f26907c826d7f1836f8199f5a02e32374217d134d86541',
      kind: 'source_transaction_id', identityKey: '8dd241481a26e6a384e784af76c329893fb2e5e66cc3832ed31989eea9659a19' },
    { own: '****1122', bankAccountIdentity: null,
      bankPaymentKey: '1ccc0a06af1f7c90b6c9c6fd6dfac22c8a257409431e82e28813cd14c662f02a',
      kind: 'physical_record', identityKey: '396022cd5fcac3bab46baeff5535ae626dfdc5236d0bf0861329b0f2c7cc1980' }
  ]
  for (const expected of previous) {
    const content = Buffer.from('交易日期,交易金额,收支,交易类型,本方账号,对方户名,对方账号,流水号\n' +
      '2026-11-01 09:30:00,100.00,收入,转账,' + expected.own + ',合成甲,' + otherNumber + ',SYNTHETIC-BANK-ENDPOINT-1')
    const { parsed } = await parseContent(content)
    const identity = buildRowIdentity({ sourceType: 'bank', fileSha256: '1'.repeat(64), row: parsed,
      sourceProfileKey: buildSourceProfile({ sourceType: 'bank', candidate: { kind: 'missing' } }).profileKey })
    assert.equal(parsed.sourceLocator, 'CSV:2-2')
    assert.equal(parsed.bankAccountIdentity, expected.bankAccountIdentity)
    assert.equal(parsed.bankPaymentKey, expected.bankPaymentKey)
    assert.equal(identity.kind, expected.kind)
    assert.equal(identity.identityKey, expected.identityKey)
    assert.equal(identity.coreDigest, '4c72610869ba50dcbe8226801c5572cc9a9eba2e30d04f2d78384e865d32f41e')
  }
})

test('没有 actual 标记的旧转入来源继续使用原存储方向', () => {
  const event = { economicNature: 'internal_transfer', sourceDirection: 'income', amountMinor: '10000',
    ledgerAccountId: destination.accountId, counterpartyLedgerAccountId: source.accountId, fieldSources: {} }
  assert.equal(funds(event).reverse, true)
  assertDraft(event, 'transfer', source.accountId, destination.accountId)
})
