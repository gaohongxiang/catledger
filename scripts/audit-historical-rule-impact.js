#!/usr/bin/env node
'use strict'

// 固定只读 SQL 的生成器。无数据库连接、身份参数、原始字段输出或修复动作。
// 分类是证据清点，不是错账判定；执行前先核对 preflight.schema_ready=1。
const required = {
  catledger_economic_events: { uid:'char', event_id:'char', update_id:'char', status:'varchar', economic_nature:'varchar', counterparty_ledger_account_id:'char', manual_field_mask:'bigint', field_sources_json:'json' },
  catledger_finance_updates: { uid:'char', update_id:'char', status:'varchar', plan_version:'varchar' },
  catledger_accounts: { uid:'char', account_id:'char' },
  catledger_finance_actions: { uid:'char', action_id:'char', update_id:'char', action_type:'varchar', status:'varchar', decision_json:'json' },
  catledger_event_evidence: { uid:'char', event_id:'char', row_id:'char', evidence_role:'varchar' },
  catledger_import_rows: { uid:'char', row_id:'char' },
  catledger_economic_event_transactions: { uid:'char', update_id:'char', event_id:'char', transaction_id:'char', role:'varchar', superseded_at:'datetime' },
  catledger_transactions: { uid:'char', transaction_id:'char', type:'varchar', origin:'varchar', source_account_id:'char', destination_account_id:'char', amount_minor:'bigint', original_transaction_id:'char', deleted_at:'datetime' },
  catledger_loans: { uid:'char', loan_id:'char', deleted_at:'datetime' },
  catledger_loan_charge_contracts: { uid:'char', contract_id:'char', loan_id:'char', account_id:'char' },
  catledger_loan_charges: { uid:'char', charge_id:'char', contract_id:'char', charge_key:'varchar', state:'varchar', basis:'varchar', transaction_id:'char', balance_adjustment_id:'char', covered_by_charge_id:'char', amount_minor:'bigint', charge_date:'date', plan_version:'bigint' },
  catledger_loan_charge_audit: { uid:'char', audit_id:'char', contract_id:'char', charge_id:'char', action:'varchar', snapshot_json:'json', created_at:'datetime' },
  catledger_loan_charge_sources: { uid:'char', charge_id:'char', item_id:'char' },
  catledger_installment_items: { uid:'char', item_id:'char', transaction_id:'char', source_event_id:'char', active:'tinyint' },
  catledger_loan_charge_allocations: { uid:'char', charge_id:'char', payment_id:'char' },
  catledger_loan_payments: { uid:'char', payment_id:'char', status:'varchar' }
}
const expected = Object.entries(required).flatMap(([table,columns]) => Object.entries(columns).map(([column,type]) => ({table,column,type})))
const preflight = `WITH expected AS (
  SELECT * FROM JSON_TABLE('${JSON.stringify(expected)}', '$[*]' COLUMNS(
    table_name VARCHAR(64) PATH '$.table', column_name VARCHAR(64) PATH '$.column', data_type VARCHAR(32) PATH '$.type')) j
)
SELECT /*+ MAX_EXECUTION_TIME(30000) */
  COUNT(*) AS required_column_count,
  SUM(c.column_name IS NULL) AS missing_column_count,
  SUM(c.column_name IS NOT NULL AND c.data_type<>e.data_type) AS incompatible_column_count,
  IF(SUM(c.column_name IS NULL OR c.data_type<>e.data_type)=0,1,0) AS schema_ready
FROM expected e LEFT JOIN information_schema.columns c
  ON c.table_schema=DATABASE() AND c.table_name=e.table_name AND c.column_name=e.column_name;`

// 不从当前账户映射重建历史候选。JSON_TABLE 的账号只用于用户范围内关联，永不返回。
const candidateAccount = `WITH base AS (
  SELECT e.uid,e.event_id,e.update_id,e.status,e.economic_nature,e.counterparty_ledger_account_id AS target,
    e.manual_field_mask,e.field_sources_json AS fields,u.status AS update_status,
    JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.fundsProjection.to.referenceKind')) AS reference_kind,
    JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.fundsProjection.ruleVersion')) AS funds_version,
    JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.fundsProjection.to.resolvedAccountId')) AS resolved,
    JSON_EXTRACT(e.field_sources_json,'$.fundsProjection.to.candidates') AS candidates
  FROM catledger_economic_events e LEFT JOIN catledger_finance_updates u ON u.uid=e.uid AND u.update_id=e.update_id
), aggregate_events AS (
  SELECT * FROM base WHERE reference_kind='aggregate'
), candidates AS (
  SELECT e.uid,e.event_id,COUNT(j.position) AS candidate_count,
    COUNT(NULLIF(j.account_id,'')) AS named_count,COUNT(a.account_id) AS trusted_count,
    COUNT(DISTINCT NULLIF(j.account_id,'')) AS distinct_count,
    SUM(j.account_id=e.resolved) AS matching_count
  FROM aggregate_events e LEFT JOIN JSON_TABLE(IF(JSON_TYPE(e.candidates)='ARRAY',e.candidates,JSON_ARRAY()),
    '$[*]' COLUMNS(position FOR ORDINALITY,account_id VARCHAR(64) PATH '$.accountId' NULL ON EMPTY NULL ON ERROR)) j ON TRUE
  LEFT JOIN catledger_accounts a ON a.uid=e.uid AND a.account_id=j.account_id
  GROUP BY e.uid,e.event_id
), facts AS (
  SELECT e.*,c.candidate_count,c.named_count,c.trusted_count,c.distinct_count,c.matching_count,
    (e.manual_field_mask & 2818)<>0 OR JSON_CONTAINS_PATH(e.fields,'one','$.editorOverrides.composition',
      '$.repaymentAllocations','$.repaymentAllocationVersion','$.paymentResolution','$.repaymentOwnership') AS manual_trace,
    EXISTS(SELECT 1 FROM catledger_finance_actions a WHERE a.uid=e.uid AND a.update_id=e.update_id
      AND a.action_id=JSON_UNQUOTE(JSON_EXTRACT(e.fields,'$.lastUserActionId')) AND a.status='applied'
      AND a.action_type='set_event_review' AND (e.manual_field_mask & 2)<>0
      AND JSON_UNQUOTE(JSON_EXTRACT(a.decision_json,'$.eventId'))=e.event_id
      AND JSON_UNQUOTE(JSON_EXTRACT(a.decision_json,'$.fields.counterpartyLedgerAccountId'))=e.target
      AND e.target IS NOT NULL) AS explicit_target_decision,
    (SELECT COUNT(*) FROM catledger_event_evidence v JOIN catledger_import_rows r ON r.uid=v.uid AND r.row_id=v.row_id
      WHERE v.uid=e.uid AND v.event_id=e.event_id AND v.evidence_role<>'discarded') AS source_count,
    (SELECT COUNT(*) FROM catledger_economic_event_transactions l JOIN catledger_transactions t ON t.uid=l.uid AND t.transaction_id=l.transaction_id
      WHERE l.uid=e.uid AND l.update_id=e.update_id AND l.event_id=e.event_id AND l.superseded_at IS NULL AND t.deleted_at IS NULL
        AND l.role IN ('primary','historical_primary','repayment_allocation','payment_allocation')) AS live_transactions,
    (SELECT COUNT(*) FROM catledger_economic_event_transactions l WHERE l.uid=e.uid AND l.update_id=e.update_id AND l.event_id=e.event_id) AS all_links
  FROM aggregate_events e JOIN candidates c ON c.uid=e.uid AND c.event_id=e.event_id
), classified AS (
  SELECT *,CASE
    WHEN explicit_target_decision THEN 'explicit_manual_target'
    WHEN manual_trace THEN 'manual_trace_requires_review'
    WHEN funds_version='source-funds-v9' THEN 'current_rule_projection'
    WHEN funds_version IS NULL OR funds_version<>'source-funds-v8' THEN 'unknown_rule_version'
    WHEN JSON_TYPE(candidates)<>'ARRAY' OR candidates IS NULL OR candidate_count=0 THEN 'missing_candidate_evidence'
    WHEN target IS NULL OR resolved IS NULL OR resolved='null' THEN 'no_single_account_conclusion'
    WHEN target<>resolved THEN 'target_differs_from_projection'
    WHEN trusted_count<>named_count THEN 'unverifiable_account_reference'
    WHEN distinct_count=1 AND matching_count=named_count AND named_count<candidate_count THEN 'candidate_old_partial_resolution'
    WHEN distinct_count>1 THEN 'candidate_old_stale_resolution'
    WHEN named_count=candidate_count AND distinct_count=1 AND matching_count=candidate_count THEN 'complete_same_account_candidates'
    ELSE 'unclassified_projection'
    END AS classification,
    CASE WHEN update_status IS NULL THEN 'missing_update'
      WHEN update_status IN ('undone','abandoned') OR status='excluded' THEN 'withdrawn_or_excluded'
      WHEN live_transactions>0 THEN 'linked_live_transactions'
      WHEN all_links>0 THEN 'only_deleted_or_superseded_links'
      WHEN update_status='posted' THEN 'posted_without_transaction_evidence'
      ELSE 'unposted' END AS posting_state
  FROM facts
)
SELECT /*+ MAX_EXECUTION_TIME(30000) */ classification,posting_state,COUNT(*) AS record_count,COUNT(DISTINCT uid) AS user_count,
  SUM(live_transactions) AS live_transaction_links,SUM(source_count=0) AS missing_source_event_count,
  SUM(manual_trace) AS manual_trace_event_count
FROM classified GROUP BY classification,posting_state
UNION ALL
SELECT 'coverage_all_events','all',COUNT(*),COUNT(DISTINCT uid),0,0,0 FROM base
UNION ALL
SELECT 'coverage_repayments_without_aggregate_projection','unknown_history',COUNT(*),COUNT(DISTINCT uid),0,0,0
FROM base WHERE economic_nature='repayment' AND (reference_kind IS NULL OR reference_kind<>'aggregate')
ORDER BY classification,posting_state;`

// 一次性费用旧递归的 record 审计 periodNumber=null；第一期是后续 settlement 审计。
// 历史生成证据与当前实际认领/撤销分开计数，防止后续状态掩盖历史，也不把历史候选直接判为错账。
const upfrontFee = `WITH upfront AS (
  SELECT f.*,k.account_id,k.loan_id,l.deleted_at AS loan_deleted,
    CASE WHEN f.state='covered' THEN p.charge_id ELSE f.charge_id END AS financial_charge_id,
    CASE WHEN f.state='covered' THEN p.transaction_id ELSE f.transaction_id END AS financial_transaction_id,
    CASE WHEN f.state='covered' THEN p.basis ELSE f.basis END AS financial_basis,
    CASE WHEN f.state='covered' THEN p.state ELSE f.state END AS financial_state,
    CASE WHEN f.state='covered' THEN p.amount_minor ELSE f.amount_minor END AS financial_amount
  FROM catledger_loan_charges f JOIN catledger_loan_charge_contracts k ON k.uid=f.uid AND k.contract_id=f.contract_id
  JOIN catledger_loans l ON l.uid=k.uid AND l.loan_id=k.loan_id
  LEFT JOIN catledger_loan_charges p ON p.uid=f.uid AND p.contract_id=f.contract_id AND p.charge_id=f.covered_by_charge_id
  WHERE f.charge_key='upfront:fee'
), facts AS (
  SELECT f.*,t.type AS transaction_type,t.origin,t.deleted_at AS transaction_deleted,
    t.source_account_id=f.account_id AND t.amount_minor=f.financial_amount AS financial_matches,
    EXISTS(SELECT 1 FROM catledger_loan_charge_audit a
      JOIN catledger_transactions old_t ON old_t.uid=a.uid AND old_t.transaction_id=JSON_UNQUOTE(JSON_EXTRACT(a.snapshot_json,'$.transactionId'))
      JOIN catledger_transactions b ON b.uid=a.uid AND b.transaction_id=JSON_UNQUOTE(JSON_EXTRACT(a.snapshot_json,'$.balanceAdjustmentId'))
      WHERE a.uid=f.uid AND a.contract_id=f.contract_id AND a.charge_id=f.charge_id AND a.action='confirm_historical_paid'
        AND JSON_TYPE(JSON_EXTRACT(a.snapshot_json,'$.periodNumber'))='NULL'
        AND old_t.type='expense' AND old_t.origin='loan_plan' AND old_t.source_account_id=f.account_id
        AND b.type='balance_adjustment' AND b.origin='system' AND b.destination_account_id=f.account_id AND b.amount_minor=old_t.amount_minor) AS legacy_generated,
    EXISTS(SELECT 1 FROM catledger_loan_charge_audit a WHERE a.uid=f.uid AND a.contract_id=f.contract_id AND a.charge_id=f.charge_id
      AND a.action='confirm_settlement' AND JSON_UNQUOTE(JSON_EXTRACT(a.snapshot_json,'$.periodNumber'))='1') AS first_period_settlement,
    EXISTS(SELECT 1 FROM catledger_loan_charge_audit a WHERE a.uid=f.uid AND a.contract_id=f.contract_id
      AND a.charge_id=f.financial_charge_id AND a.action IN ('adopt_historical_fee','adopt_historical_coverage','claim_payment_coverage')
      AND JSON_UNQUOTE(JSON_EXTRACT(a.snapshot_json,'$.transactionId'))=f.financial_transaction_id) OR
    EXISTS(SELECT 1 FROM catledger_loan_charge_audit a JOIN JSON_TABLE(IF(JSON_TYPE(JSON_EXTRACT(a.snapshot_json,'$.coverage'))='ARRAY',
      JSON_EXTRACT(a.snapshot_json,'$.coverage'),JSON_ARRAY()),'$[*]' COLUMNS(charge_key VARCHAR(80) PATH '$.chargeKey',transaction_id VARCHAR(64) PATH '$.transactionId')) j ON TRUE
      WHERE a.uid=f.uid AND a.contract_id=f.contract_id AND a.action='authorize' AND j.charge_key=f.charge_key AND j.transaction_id=f.financial_transaction_id) AS explicit_actual,
    EXISTS(SELECT 1 FROM catledger_loan_charge_sources s JOIN catledger_installment_items i ON i.uid=s.uid AND i.item_id=s.item_id
      JOIN catledger_loan_charge_audit a ON a.uid=s.uid AND a.contract_id=f.contract_id AND a.charge_id=s.charge_id
      WHERE s.uid=f.uid AND s.charge_id=f.financial_charge_id AND i.active=1 AND i.transaction_id=f.financial_transaction_id
        AND a.action='bank_reconcile' AND JSON_UNQUOTE(JSON_EXTRACT(a.snapshot_json,'$.transactionId'))=i.transaction_id
        AND JSON_UNQUOTE(JSON_EXTRACT(a.snapshot_json,'$.itemId'))=i.item_id) AS bank_actual,
    EXISTS(SELECT 1 FROM catledger_loan_charge_audit a JOIN catledger_loan_charge_audit auth
      ON auth.uid=a.uid AND auth.contract_id=a.contract_id AND auth.charge_id IS NULL AND auth.action='authorize' AND auth.created_at<=a.created_at
      WHERE a.uid=f.uid AND a.contract_id=f.contract_id AND a.charge_id=f.financial_charge_id AND a.action='accrue'
        AND JSON_UNQUOTE(JSON_EXTRACT(a.snapshot_json,'$.transactionId'))=f.financial_transaction_id
        AND JSON_UNQUOTE(JSON_EXTRACT(auth.snapshot_json,'$.planVersion'))=f.plan_version
        AND JSON_UNQUOTE(JSON_EXTRACT(auth.snapshot_json,'$.authorization.mode')) IN ('auto','once')
        AND f.charge_date BETWEEN JSON_UNQUOTE(JSON_EXTRACT(auth.snapshot_json,'$.authorization.fromDate')) AND JSON_UNQUOTE(JSON_EXTRACT(auth.snapshot_json,'$.authorization.throughDate'))) AS authorized_accrual,
    EXISTS(SELECT 1 FROM catledger_loan_charge_audit a WHERE a.uid=f.uid AND a.contract_id=f.contract_id AND a.charge_id=f.charge_id
      AND a.action IN ('unmark_historical_paid','suppress','cancel')) AS withdrawal_trace,
    (SELECT COUNT(*) FROM catledger_loan_charge_audit a WHERE a.uid=f.uid AND a.contract_id=f.contract_id
      AND (a.charge_id=f.charge_id OR a.charge_id=f.financial_charge_id OR a.charge_id IS NULL AND a.action='authorize')) AS audit_count,
    (SELECT COUNT(*) FROM catledger_loan_charge_sources s JOIN catledger_installment_items i ON i.uid=s.uid AND i.item_id=s.item_id
      WHERE s.uid=f.uid AND s.charge_id=f.financial_charge_id AND i.active=1) AS active_sources,
    (SELECT COUNT(*) FROM catledger_loan_charge_allocations ca JOIN catledger_loan_payments p ON p.uid=ca.uid AND p.payment_id=ca.payment_id
      WHERE ca.uid=f.uid AND ca.charge_id=f.financial_charge_id AND p.status='active') AS active_payments,
    (SELECT COUNT(*) FROM catledger_transactions r WHERE r.uid=f.uid AND r.original_transaction_id=f.financial_transaction_id
      AND r.type='refund' AND r.deleted_at IS NULL) AS live_refunds
  FROM upfront f LEFT JOIN catledger_transactions t ON t.uid=f.uid AND t.transaction_id=f.financial_transaction_id
), classified AS (
  SELECT *,CASE
    WHEN financial_transaction_id IS NOT NULL AND transaction_type='expense' AND financial_matches AND financial_basis='actual' AND explicit_actual THEN 'explicit_actual_claim'
    WHEN financial_transaction_id IS NOT NULL AND transaction_type='expense' AND financial_matches AND financial_basis='actual' AND bank_actual THEN 'bank_reconciled_actual'
    WHEN authorized_accrual AND transaction_type='expense' AND financial_matches AND origin='loan_plan' AND financial_basis='plan' THEN 'authorized_plan_accrual'
    WHEN legacy_generated THEN 'candidate_legacy_first_period_generated'
    WHEN audit_count=0 THEN 'missing_audit_evidence'
    WHEN financial_basis='actual' THEN 'actual_basis_without_complete_evidence'
    ELSE 'other_or_incomplete_evidence' END AS classification,
    CASE WHEN state IN ('suppressed','cancelled') THEN 'suppressed_or_cancelled'
      WHEN financial_transaction_id IS NOT NULL AND transaction_deleted IS NOT NULL THEN 'deleted_transaction'
      WHEN state='covered' AND financial_charge_id IS NULL THEN 'missing_coverage_parent'
      WHEN state='covered' AND transaction_type='expense' THEN 'covered_by_expense'
      WHEN financial_state='recorded' AND transaction_type='expense' THEN 'recorded_expense'
      ELSE 'no_current_recorded_expense' END AS posting_state
  FROM facts
)
SELECT /*+ MAX_EXECUTION_TIME(30000) */ classification,posting_state,COUNT(*) AS record_count,COUNT(DISTINCT uid) AS user_count,
  SUM(legacy_generated) AS legacy_generated_count,SUM(first_period_settlement) AS first_period_settlement_count,
  SUM(withdrawal_trace) AS withdrawal_trace_count,SUM(loan_deleted IS NOT NULL) AS deleted_loan_count,
  SUM(active_sources>0) AS with_active_source_count,SUM(active_payments>0) AS with_active_payment_count,
  SUM(live_refunds>0) AS with_live_refund_count,SUM(audit_count=0) AS missing_audit_count
FROM classified GROUP BY classification,posting_state
UNION ALL
SELECT 'coverage_all_upfront_fees','all',COUNT(*),COUNT(DISTINCT uid),0,0,0,0,0,0,0,0 FROM upfront
ORDER BY classification,posting_state;`

const queryBodies = Object.freeze({ preflight, 'candidate-account':candidateAccount, 'upfront-fee':upfrontFee })
// CloudBase runQuery 的只读检查要求 SELECT 开头；派生表内保留原查询和聚合边界。
// MAX_EXECUTION_TIME 必须放最外层，不能依赖子查询里的 hint。
const queries = Object.freeze(Object.fromEntries(Object.entries(queryBodies).map(([name,sql]) => [name,
  'SELECT /*+ MAX_EXECUTION_TIME(30000) */ * FROM (\n'+sql.replace(/;$/,'')+'\n) AS historical_audit'+
    (name==='preflight'?'':' ORDER BY classification,posting_state')+';'])))
const description = `历史规则影响只读清点（MySQL 8）
依次生成 --sql preflight、--sql candidate-account、--sql upfront-fee，由管理员通过只读 MCP 执行。
仅当 preflight.schema_ready=1 才执行业务查询；缺字段、类型不符或 JSON_TABLE 不支持时停止，不解释为零影响。
输出仅固定证据类别、记录数及用户数。候选是需核对范围，不是错账结论；不同类别用户数不能相加去重。
B 使用持久化候选与人工决定，不用当前映射反推历史。未保留 aggregate 投影的还款另列覆盖缺口；历史升级可能改写投影，因此零候选不能证明历史从未受影响。
C 同时保留旧生成审计与当前费用/交易/覆盖/实际认领关系；manual basis 不等于明确的一次性收费确认。已删、撤销、退款、已还依赖分别计数，不能据此直接删交易。
查询有 30 秒执行上限，不写入、不修复、不输出身份、金额或原始账单。正式修复需逐项核对另行决定。`
function main(args=process.argv.slice(2)) {
  if(args.length===1 && args[0]==='--describe') return description+'\n'
  if(args.length===2 && args[0]==='--sql' && Object.hasOwn(queries,args[1])) return queries[args[1]]+'\n'
  throw new Error('用法：node scripts/audit-historical-rule-impact.js --describe | --sql preflight|candidate-account|upfront-fee')
}
if(require.main===module) {
  try { process.stdout.write(main()) } catch(error) { process.stderr.write(error.message+'\n'); process.exitCode=1 }
}
module.exports={queries,queryBodies,required,main}
