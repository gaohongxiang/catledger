-- 只更新仍使用原预设名称的活动分类；保留 ID、父级、用户自定义名称及旧账关联。
-- 单条多表 UPDATE 原子推进分类版本和用户修订，重跑由旧名称条件保证不重复推进。
UPDATE catledger_categories meal
JOIN catledger_users owner ON owner.uid = meal.uid
JOIN catledger_categories parent ON parent.uid = meal.uid AND parent.category_id = meal.parent_id
LEFT JOIN catledger_categories sibling
  ON sibling.uid = meal.uid AND sibling.kind = meal.kind AND sibling.parent_id = meal.parent_id
 AND sibling.archived_at IS NULL AND sibling.normalized_name = '美食' AND sibling.category_id <> meal.category_id
SET meal.name = '美食', meal.normalized_name = '美食', meal.version = meal.version + 1,
    owner.data_revision = owner.data_revision + 1
WHERE meal.system_key = 'food__meal' AND meal.is_system_default = 1 AND meal.kind = 'expense'
  AND meal.name = '吃饭' AND meal.normalized_name = '吃饭' AND meal.archived_at IS NULL
  AND parent.system_key = 'food' AND parent.kind = 'expense' AND parent.parent_id IS NULL
  AND sibling.category_id IS NULL;
