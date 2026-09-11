-- MINI-1906DB1：维护窗口内执行，应用账号暂停访问。

-- 旧入账记录一次转换；运行代码不维护旧表。各步可重入；云端先以相同条件分批压缩和清理。

SET @catledger_legacy_tables_available := (SELECT COUNT(*) = 3 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('catledger_import_decisions', 'catledger_import_postings', 'catledger_import_transaction_links'));

SET @catledger_legacy_step := IF(@catledger_legacy_tables_available, 'INSERT IGNORE INTO catledger_finance_updates
  (uid, update_id, status, version, plan_version, source_count,
   valid_evidence_count, duplicate_evidence_count, final_event_count,
   posted_event_count, ready_event_count, needs_action_event_count, excluded_event_count,
   created_at, updated_at)
SELECT f.uid, f.import_id, ''posted'', 1, ''legacy-backfill-v1'', COUNT(DISTINCT b.batch_id),
       COALESCE(SUM(b.valid_row_count), 0), 0,
       COUNT(DISTINCT e.event_id),
       COUNT(DISTINCT CASE WHEN e.state IN (''posted'', ''linked'') THEN e.event_id END),
       0, 0,
       COUNT(DISTINCT CASE WHEN e.state = ''ignored'' THEN e.event_id END),
       f.created_at, f.updated_at
  FROM catledger_import_files f
  JOIN catledger_import_batches b
    ON b.uid = f.uid AND b.import_id = f.import_id AND b.state = ''committed''
  LEFT JOIN catledger_economic_events e
    ON e.uid = b.uid AND e.batch_id = b.batch_id
 WHERE f.state = ''committed''
   AND EXISTS (SELECT 1 FROM catledger_import_postings p WHERE p.uid = f.uid AND p.import_id = f.import_id AND p.state = ''completed'')
 GROUP BY f.uid, f.import_id, f.created_at, f.updated_at', 'SELECT 1');
PREPARE catledger_legacy_statement FROM @catledger_legacy_step;
EXECUTE catledger_legacy_statement;
DEALLOCATE PREPARE catledger_legacy_statement;

SET @catledger_legacy_step := IF(@catledger_legacy_tables_available, 'INSERT IGNORE INTO catledger_finance_update_sources
  (uid, source_id, update_id, source_order, import_id, batch_id, source_profile_id,
   source_type_snapshot, source_format_snapshot, parser_version, normalization_version,
   identity_version, file_name_snapshot, file_content_sha256, total_row_count,
   valid_row_count, invalid_row_count, created_at)
SELECT ranked.uid, ranked.batch_id, ranked.import_id, ranked.source_order,
       ranked.import_id, ranked.batch_id, ranked.source_profile_id,
       ranked.source_type, ranked.source_format, ranked.parser_version,
       ranked.normalization_version, ranked.identity_version,
       ranked.original_file_name, ranked.content_sha256, ranked.total_row_count,
       ranked.valid_row_count, ranked.invalid_row_count, ranked.created_at
  FROM (
    SELECT b.*, f.original_file_name, f.content_sha256,
           ROW_NUMBER() OVER (PARTITION BY b.uid, b.import_id ORDER BY b.created_at, b.batch_id) - 1 AS source_order
      FROM catledger_import_batches b
      JOIN catledger_import_files f
        ON f.uid = b.uid AND f.import_id = b.import_id
     WHERE b.state = ''committed'' AND f.state = ''committed'' AND f.content_sha256 IS NOT NULL
       AND EXISTS (SELECT 1 FROM catledger_import_postings p WHERE p.uid = f.uid AND p.import_id = f.import_id AND p.state = ''completed'')
  ) ranked', 'SELECT 1');
PREPARE catledger_legacy_statement FROM @catledger_legacy_step;
EXECUTE catledger_legacy_statement;
DEALLOCATE PREPARE catledger_legacy_statement;

SET @catledger_legacy_step := IF(@catledger_legacy_tables_available, 'UPDATE catledger_economic_events event_row
JOIN catledger_import_batches batch_row
  ON batch_row.uid = event_row.uid AND batch_row.batch_id = event_row.batch_id
JOIN catledger_import_files file_row
  ON file_row.uid = batch_row.uid AND file_row.import_id = batch_row.import_id
JOIN catledger_event_evidence evidence_row
  ON evidence_row.uid = event_row.uid AND evidence_row.event_id = event_row.event_id
 AND evidence_row.evidence_role = ''primary''
JOIN catledger_import_rows source_row
  ON source_row.uid = evidence_row.uid AND source_row.row_id = evidence_row.row_id
LEFT JOIN (
  SELECT decision_row.*
    FROM catledger_import_decisions decision_row
    JOIN (
      SELECT uid, event_id, MAX(decision_version) AS decision_version
        FROM catledger_import_decisions GROUP BY uid, event_id
    ) latest
      ON latest.uid = decision_row.uid AND latest.event_id = decision_row.event_id
     AND latest.decision_version = decision_row.decision_version
) decision_row
  ON decision_row.uid = event_row.uid AND decision_row.event_id = event_row.event_id
LEFT JOIN catledger_import_transaction_links legacy_link
  ON legacy_link.uid = event_row.uid AND legacy_link.event_id = event_row.event_id
LEFT JOIN catledger_transactions transaction_row
  ON transaction_row.uid = legacy_link.uid AND transaction_row.transaction_id = legacy_link.transaction_id
 SET event_row.update_id = file_row.import_id,
     event_row.event_key = SHA2(CONCAT(''legacy-event-v1:'', event_row.event_id), 256),
     event_row.event_key_version = ''legacy-event-v1'',
     event_row.status = CASE
       WHEN event_row.state IN (''posted'', ''linked'') THEN ''posted''
       WHEN event_row.state = ''ignored'' THEN ''excluded''
       ELSE ''needs_action''
     END,
     event_row.flow_direction = CASE source_row.normalized_direction
       WHEN ''income'' THEN ''inflow''
       WHEN ''expense'' THEN ''outflow''
       ELSE ''neutral''
     END,
     event_row.economic_nature = CASE source_row.normalized_direction
       WHEN ''income'' THEN ''income''
       WHEN ''expense'' THEN ''expense''
       ELSE ''unknown''
     END,
     event_row.ledger_account_id = COALESCE(
       decision_row.account_id,
       transaction_row.source_account_id,
       transaction_row.destination_account_id
     ),
     event_row.event_local_date = source_row.normalized_local_date,
     event_row.event_local_at = source_row.normalized_local_at,
     event_row.event_utc_at = source_row.normalized_utc_at,
     event_row.timezone_offset_minutes = source_row.timezone_offset_minutes,
     event_row.amount_minor = source_row.normalized_amount_minor,
     event_row.currency = source_row.currency,
     event_row.category_id = COALESCE(decision_row.category_id, transaction_row.category_id),
     event_row.field_sources_json = JSON_OBJECT(''legacyRowId'', source_row.row_id),
     event_row.reason_codes_json = JSON_ARRAY(''legacy_single_file_backfill'')
WHERE file_row.state = ''committed'' AND event_row.update_id IS NULL
  AND EXISTS (SELECT 1 FROM catledger_import_postings p WHERE p.uid = file_row.uid AND p.import_id = file_row.import_id AND p.state = ''completed'')', 'SELECT 1');
PREPARE catledger_legacy_statement FROM @catledger_legacy_step;
EXECUTE catledger_legacy_statement;
DEALLOCATE PREPARE catledger_legacy_statement;

SET @catledger_legacy_step := IF(@catledger_legacy_tables_available, 'UPDATE catledger_event_evidence evidence_row
JOIN catledger_economic_events event_row
  ON event_row.uid = evidence_row.uid AND event_row.event_id = evidence_row.event_id
 SET evidence_row.evidence_id = COALESCE(evidence_row.evidence_id, UUID()),
     evidence_row.update_id = event_row.update_id
WHERE event_row.update_id IS NOT NULL AND evidence_row.update_id IS NULL', 'SELECT 1');
PREPARE catledger_legacy_statement FROM @catledger_legacy_step;
EXECUTE catledger_legacy_statement;
DEALLOCATE PREPARE catledger_legacy_statement;

SET @catledger_legacy_step := IF(@catledger_legacy_tables_available, 'INSERT IGNORE INTO catledger_economic_event_transactions
  (uid, link_id, update_id, event_id, transaction_id, role,
   creation_method, rule_version, transaction_version, created_at)
SELECT legacy_link.uid, legacy_link.link_id, event_row.update_id,
       legacy_link.event_id, legacy_link.transaction_id, ''historical_primary'',
       legacy_link.creation_method, ''legacy-import-link-v1'', transaction_row.version,
       legacy_link.created_at
  FROM catledger_import_transaction_links legacy_link
  JOIN catledger_economic_events event_row
    ON event_row.uid = legacy_link.uid AND event_row.event_id = legacy_link.event_id
  JOIN catledger_transactions transaction_row
    ON transaction_row.uid = legacy_link.uid AND transaction_row.transaction_id = legacy_link.transaction_id
 WHERE event_row.update_id IS NOT NULL', 'SELECT 1');
PREPARE catledger_legacy_statement FROM @catledger_legacy_step;
EXECUTE catledger_legacy_statement;
DEALLOCATE PREPARE catledger_legacy_statement;

SET @catledger_legacy_step := IF(@catledger_legacy_tables_available, 'INSERT IGNORE INTO catledger_finance_update_postings
  (uid, posting_id, update_id, request_digest, state, selected_event_count,
   created_transaction_count, reused_transaction_count, created_at, completed_at, updated_at)
SELECT posting_row.uid, posting_row.posting_id, posting_row.import_id,
       posting_row.request_digest, posting_row.state, posting_row.selected_event_count,
       posting_row.created_transaction_count, posting_row.reused_transaction_count,
       posting_row.created_at, posting_row.completed_at, posting_row.updated_at
  FROM catledger_import_postings posting_row
  JOIN catledger_finance_updates update_row
    ON update_row.uid = posting_row.uid AND update_row.update_id = posting_row.import_id
 WHERE posting_row.state = ''completed''', 'SELECT 1');
PREPARE catledger_legacy_statement FROM @catledger_legacy_step;
EXECUTE catledger_legacy_statement;
DEALLOCATE PREPARE catledger_legacy_statement;

UPDATE catledger_mutation_receipts
SET result_json = CASE
  WHEN JSON_TYPE(JSON_EXTRACT(result_json, '$.update.updateId')) = 'STRING'
   AND JSON_TYPE(JSON_EXTRACT(result_json, '$.issue.issueId')) = 'STRING'
   AND JSON_TYPE(JSON_EXTRACT(result_json, '$.members')) = 'ARRAY'
  THEN JSON_OBJECT('receiptVersion', 1, 'kind', 'review-issue-view', 'updateId', JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.update.updateId')), 'issueId', JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.issue.issueId')))
  WHEN JSON_TYPE(JSON_EXTRACT(result_json, '$.update.updateId')) = 'STRING'
   AND JSON_TYPE(JSON_EXTRACT(result_json, '$.events')) = 'ARRAY'
   AND JSON_TYPE(JSON_EXTRACT(result_json, '$.issues')) = 'ARRAY'
  THEN JSON_OBJECT('receiptVersion', 1, 'kind', 'finance-update-view', 'updateId', JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.update.updateId')))
  ELSE JSON_OBJECT('receiptVersion', 1, 'kind', 'value', 'value', result_json)
END, updated_at = updated_at
WHERE result_json IS NOT NULL
  AND (action LIKE 'imports.%' OR action LIKE 'financeUpdates.%' OR action LIKE 'reviewIssues.%' OR action LIKE 'economicEvents.%')
  AND COALESCE(JSON_EXTRACT(result_json, '$.receiptVersion'), 0) <> 1;

DELETE FROM catledger_finance_update_account_mapping_drafts
WHERE EXISTS (SELECT 1 FROM catledger_finance_updates u
  WHERE u.uid = catledger_finance_update_account_mapping_drafts.uid AND u.update_id = catledger_finance_update_account_mapping_drafts.update_id AND u.status = 'abandoned');

DELETE FROM catledger_finance_update_account_drafts
WHERE EXISTS (SELECT 1 FROM catledger_finance_updates u
  WHERE u.uid = catledger_finance_update_account_drafts.uid AND u.update_id = catledger_finance_update_account_drafts.update_id AND u.status = 'abandoned');

DELETE FROM catledger_review_issue_members
WHERE EXISTS (SELECT 1 FROM catledger_finance_updates u
  WHERE u.uid = catledger_review_issue_members.uid AND u.update_id = catledger_review_issue_members.update_id AND u.status = 'abandoned');

DELETE FROM catledger_review_issues
WHERE EXISTS (SELECT 1 FROM catledger_finance_updates u
  WHERE u.uid = catledger_review_issues.uid AND u.update_id = catledger_review_issues.update_id AND u.status = 'abandoned');

DELETE FROM catledger_economic_event_relations
WHERE EXISTS (SELECT 1 FROM catledger_finance_updates u
  WHERE u.uid = catledger_economic_event_relations.uid AND u.update_id = catledger_economic_event_relations.update_id AND u.status = 'abandoned');

DELETE FROM catledger_economic_event_transactions
WHERE EXISTS (SELECT 1 FROM catledger_finance_updates u
  WHERE u.uid = catledger_economic_event_transactions.uid AND u.update_id = catledger_economic_event_transactions.update_id AND u.status = 'abandoned');

DELETE FROM catledger_event_evidence
WHERE EXISTS (SELECT 1 FROM catledger_finance_updates u
  WHERE u.uid = catledger_event_evidence.uid AND u.update_id = catledger_event_evidence.update_id AND u.status = 'abandoned');

DELETE FROM catledger_economic_events
WHERE EXISTS (SELECT 1 FROM catledger_finance_updates u
  WHERE u.uid = catledger_economic_events.uid AND u.update_id = catledger_economic_events.update_id AND u.status = 'abandoned');

DROP TABLE IF EXISTS catledger_import_transaction_links;

DROP TABLE IF EXISTS catledger_import_decisions;

DROP TABLE IF EXISTS catledger_import_postings;

DROP TABLE IF EXISTS catledger_import_batch_issues;

DELETE FROM catledger_event_evidence WHERE update_id IS NULL;

DELETE FROM catledger_economic_events WHERE update_id IS NULL;
