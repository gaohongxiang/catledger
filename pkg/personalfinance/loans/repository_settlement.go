package loans

import (
	"fmt"
	"sort"

	"xorm.io/xorm"

	"github.com/gaohongxiang/catledger/pkg/core"
	"github.com/gaohongxiang/catledger/pkg/datastore"
)

const maximumDashboardAllocationCount = 100000

// ListDashboardAllocations 返回所有活动分配及其主正式交易，供只读可信总览分类。
// current pointer 与 allocation 状态必须同时匹配，避免撤销关系进入实际现金流分类。
func (r *Repository) ListDashboardAllocations(c core.Context, uid int64) ([]*DashboardAllocation, error) {
	if uid < 1 {
		return nil, fmt.Errorf("invalid dashboard loan allocation owner")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	values := make([]*DashboardAllocation, 0)
	err = sess.SQL(`SELECT b.transaction_id, a.contract_id, a.allocation_id, a.component_type, a.allocated_amount
		FROM pf_loan_transaction_allocation a
		INNER JOIN pf_loan_transaction_binding b
			ON b.uid = a.uid AND b.binding_id = a.primary_binding_id
		WHERE a.uid = ? AND b.uid = ? AND a.status = ?
			AND b.current_allocation_id = a.allocation_id
		ORDER BY a.allocation_id ASC
		LIMIT 100001`, uid, uid, ALLOCATION_STATUS_ACTIVE).Find(&values)
	if err != nil {
		return nil, fmt.Errorf("list dashboard loan allocations: %w", err)
	}
	if len(values) > maximumDashboardAllocationCount {
		return nil, fmt.Errorf("dashboard loan allocation read limit reached")
	}
	seenTransactions := make(map[int64]struct{}, len(values))
	for _, value := range values {
		if value == nil || value.TransactionId < 1 || value.ContractId < 1 || value.AllocationId < 1 ||
			value.AllocatedAmount < 1 || !isComponentType(value.ComponentType) {
			return nil, fmt.Errorf("dashboard loan allocation invariant mismatch")
		}
		if _, exists := seenTransactions[value.TransactionId]; exists {
			return nil, fmt.Errorf("dashboard loan transaction is allocated more than once")
		}
		seenTransactions[value.TransactionId] = struct{}{}
	}
	return values, nil
}

// LedgerResources 只向注入的核心账本适配器暴露当前 caller-owned privacy transaction。
func (tx *RepositoryTransaction) LedgerResources() (*datastore.Database, *xorm.Session, error) {
	if err := tx.validate(); err != nil {
		return nil, nil, err
	}
	return tx.database, tx.session, nil
}

// ListActiveAllocationsForValidation 按 allocation_id 正序有界读取活动关系。
func (r *Repository) ListActiveAllocationsForValidation(c core.Context, uid int64, contractId int64) ([]*TransactionAllocation, bool, error) {
	if uid < 1 || contractId < 1 {
		return nil, false, fmt.Errorf("invalid active loan allocation validation query")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, false, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return listActiveAllocationsForValidation(sess, uid, contractId)
}

func (tx *RepositoryTransaction) ListActiveAllocationsForValidation(contractId int64) ([]*TransactionAllocation, bool, error) {
	if err := tx.validate(); err != nil || contractId < 1 {
		return nil, false, fmt.Errorf("invalid active loan allocation transaction validation query")
	}
	return listActiveAllocationsForValidation(tx.session, tx.uid, contractId)
}

func listActiveAllocationsForValidation(sess *xorm.Session, uid int64, contractId int64) ([]*TransactionAllocation, bool, error) {
	values := make([]*TransactionAllocation, 0, maximumValidatedAllocations+1)
	if err := sess.Where("uid=? AND contract_id=? AND status=?", uid, contractId, ALLOCATION_STATUS_ACTIVE).
		Asc("allocation_id").Limit(maximumValidatedAllocations + 1).Find(&values); err != nil {
		return nil, false, fmt.Errorf("list active loan allocations for validation: %w", err)
	}
	if len(values) > maximumValidatedAllocations {
		return values[:maximumValidatedAllocations], true, nil
	}
	return values, false, nil
}

// ListAllocationsByCreatedAction 返回一次 apply action 原子创建的全部分配，最多三个组件。
func (r *Repository) ListAllocationsByCreatedAction(c core.Context, uid int64, actionId int64) ([]*TransactionAllocation, bool, error) {
	if uid < 1 || actionId < 1 {
		return nil, false, fmt.Errorf("invalid loan allocation action query")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, false, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return listAllocationsByCreatedAction(sess, uid, actionId)
}

func (tx *RepositoryTransaction) ListAllocationsByCreatedAction(actionId int64) ([]*TransactionAllocation, bool, error) {
	if err := tx.validate(); err != nil || actionId < 1 {
		return nil, false, fmt.Errorf("invalid loan allocation transaction action query")
	}
	return listAllocationsByCreatedAction(tx.session, tx.uid, actionId)
}

func listAllocationsByCreatedAction(sess *xorm.Session, uid int64, actionId int64) ([]*TransactionAllocation, bool, error) {
	values := make([]*TransactionAllocation, 0, maximumSettlementComponents+1)
	if err := sess.Where("uid=? AND created_action_id=?", uid, actionId).Asc("allocation_id").
		Limit(maximumSettlementComponents + 1).Find(&values); err != nil {
		return nil, false, fmt.Errorf("list loan allocations by action: %w", err)
	}
	if len(values) > maximumSettlementComponents {
		return values[:maximumSettlementComponents], true, nil
	}
	return values, false, nil
}

// FindTransactionBindingsByIds 按 binding_id 批量读取并保持 uid 隔离。
func (r *Repository) FindTransactionBindingsByIds(c core.Context, uid int64, bindingIds []int64) (map[int64]*TransactionBinding, error) {
	if uid < 1 || !validPositiveUniqueIds(bindingIds) {
		return nil, fmt.Errorf("invalid loan transaction binding batch lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findTransactionBindingsByIds(sess, uid, bindingIds)
}

func (tx *RepositoryTransaction) FindTransactionBindingsByIds(bindingIds []int64) (map[int64]*TransactionBinding, error) {
	if err := tx.validate(); err != nil || !validPositiveUniqueIds(bindingIds) {
		return nil, fmt.Errorf("invalid loan transaction binding transaction batch lookup")
	}
	return findTransactionBindingsByIds(tx.session, tx.uid, bindingIds)
}

func findTransactionBindingsByIds(sess *xorm.Session, uid int64, bindingIds []int64) (map[int64]*TransactionBinding, error) {
	result := make(map[int64]*TransactionBinding, len(bindingIds))
	if len(bindingIds) == 0 {
		return result, nil
	}
	values := make([]*TransactionBinding, 0, len(bindingIds))
	if err := sess.Where("uid=?", uid).In("binding_id", bindingIds).Asc("binding_id").Find(&values); err != nil {
		return nil, fmt.Errorf("find loan transaction bindings by id: %w", err)
	}
	for _, value := range values {
		if value == nil || value.Uid != uid || result[value.BindingId] != nil {
			return nil, fmt.Errorf("loan transaction binding batch invariant mismatch")
		}
		result[value.BindingId] = value
	}
	return result, nil
}

// FindTransactionBindingsByTransactionIds 批量读取正式交易行的唯一并发锚点。
func (r *Repository) FindTransactionBindingsByTransactionIds(c core.Context, uid int64, transactionIds []int64) (map[int64]*TransactionBinding, error) {
	if uid < 1 || !validPositiveUniqueIds(transactionIds) {
		return nil, fmt.Errorf("invalid loan transaction binding transaction-id lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findTransactionBindingsByTransactionIds(sess, uid, transactionIds)
}

func (tx *RepositoryTransaction) FindTransactionBindingsByTransactionIds(transactionIds []int64) (map[int64]*TransactionBinding, error) {
	if err := tx.validate(); err != nil || !validPositiveUniqueIds(transactionIds) {
		return nil, fmt.Errorf("invalid loan transaction binding transaction-id transaction lookup")
	}
	return findTransactionBindingsByTransactionIds(tx.session, tx.uid, transactionIds)
}

func findTransactionBindingsByTransactionIds(sess *xorm.Session, uid int64, transactionIds []int64) (map[int64]*TransactionBinding, error) {
	result := make(map[int64]*TransactionBinding, len(transactionIds))
	if len(transactionIds) == 0 {
		return result, nil
	}
	values := make([]*TransactionBinding, 0, len(transactionIds))
	if err := sess.Where("uid=?", uid).In("transaction_id", transactionIds).Asc("transaction_id").Find(&values); err != nil {
		return nil, fmt.Errorf("find loan transaction bindings by transaction id: %w", err)
	}
	for _, value := range values {
		if value == nil || value.Uid != uid || value.TransactionId < 1 || result[value.TransactionId] != nil {
			return nil, fmt.Errorf("loan transaction binding transaction-id invariant mismatch")
		}
		result[value.TransactionId] = value
	}
	return result, nil
}

func validPositiveUniqueIds(values []int64) bool {
	if len(values) == 0 {
		return true
	}
	copyValues := append([]int64(nil), values...)
	sort.Slice(copyValues, func(i, j int) bool { return copyValues[i] < copyValues[j] })
	for index, value := range copyValues {
		if value < 1 || (index > 0 && value == copyValues[index-1]) {
			return false
		}
	}
	return true
}
