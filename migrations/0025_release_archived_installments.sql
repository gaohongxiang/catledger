-- MINI-1914：修复旧版删除只归档、未解除来源/编号绑定的记录。
-- 仅改变已归档分期的管理关系，保留原始来源、身份、正式交易和金额。
-- 可重入；用户行锁与业务写入相同，保证同一用户的导入/关联不会交错。
START TRANSACTION;

UPDATE catledger_users u
SET u.data_revision=u.data_revision+1
WHERE EXISTS (
  SELECT 1 FROM catledger_loans l
  WHERE l.uid=u.uid AND l.archived_at IS NOT NULL
    AND (EXISTS (SELECT 1 FROM catledger_installment_items i WHERE i.uid=l.uid AND i.loan_id=l.loan_id)
      OR EXISTS (SELECT 1 FROM catledger_installment_bindings b WHERE b.uid=l.uid AND b.loan_id=l.loan_id))
);

UPDATE catledger_installment_items i
JOIN catledger_loans l ON l.uid=i.uid AND l.loan_id=i.loan_id
SET i.loan_id=NULL,i.version=i.version+1
WHERE l.archived_at IS NOT NULL;

DELETE b FROM catledger_installment_bindings b
JOIN catledger_loans l ON l.uid=b.uid AND l.loan_id=b.loan_id
WHERE l.archived_at IS NOT NULL;

COMMIT;
