package cardcycle

import (
	"github.com/gaohongxiang/catledger/pkg/core"
)

func (s *Service) SaveRule(c core.Context, request SaveRuleRequest) (*RuleView, error) {
	if s == nil || request.Uid < 1 || request.LedgerAccountId < 1 || !isCardCycleDay(request.StatementDay) ||
		!isCardCycleDay(request.DueDay) || !isServiceCivilDate(request.EffectiveFrom) || !isValidIdempotencyKey(request.IdempotencyKey) {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	account, err := s.loadCreditCard(c, request.Uid, request.LedgerAccountId)
	if err != nil {
		return nil, err
	}
	if account.Hidden {
		return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}

	var saved *CycleRule
	now := s.now().Unix()
	if now < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	err = s.repository.DoTransaction(c, request.Uid, func(tx *RepositoryTransaction) error {
		rules, listErr := tx.ListRules(request.LedgerAccountId)
		if listErr != nil {
			return persistError(listErr)
		}
		var active *CycleRule
		nextNumber := int64(1)
		for _, rule := range rules {
			if rule == nil {
				return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
			}
			if rule.RuleNumber >= nextNumber {
				nextNumber = rule.RuleNumber + 1
			}
			if rule.Status == RULE_STATUS_ACTIVE {
				if active != nil {
					if _, supersedeErr := tx.UpdateRuleStatus(active.RuleId, RULE_STATUS_SUPERSEDED); supersedeErr != nil {
						return persistError(supersedeErr)
					}
				}
				active = rule
			}
		}
		if active != nil && active.StatementDay == request.StatementDay && active.DueDay == request.DueDay &&
			active.EffectiveFrom == request.EffectiveFrom {
			saved = active
			return nil
		}
		if active != nil {
			updated, supersedeErr := tx.UpdateRuleStatus(active.RuleId, RULE_STATUS_SUPERSEDED)
			if supersedeErr != nil {
				return persistError(supersedeErr)
			}
			if !updated {
				return serviceError(ErrServicePersistenceFailed, SERVICE_ERROR_PERSISTENCE)
			}
		}
		rule := &CycleRule{
			Uid: request.Uid, LedgerAccountId: request.LedgerAccountId, RuleNumber: nextNumber,
			StatementDay: request.StatementDay, DueDay: request.DueDay, EffectiveFrom: request.EffectiveFrom,
			Status: RULE_STATUS_ACTIVE, CreatedUnixTime: now, RuleId: s.generateId(),
		}
		if rule.RuleId < 1 {
			return serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
		}
		if insertErr := tx.InsertRule(rule); insertErr != nil {
			return persistError(insertErr)
		}
		saved = rule
		return nil
	})
	if err != nil {
		return nil, err
	}
	return ruleView(saved), nil
}

func isValidIdempotencyKey(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && char != '-' && char != '_' && char != '.' && char != ':' {
			return false
		}
	}
	return true
}

func (s *Service) loadCreditCard(c core.Context, uid int64, accountId int64) (*AccountSnapshot, error) {
	account, err := s.loadAccount(c, uid, accountId)
	if err != nil {
		return nil, err
	}
	if !account.CreditCard {
		return nil, serviceError(ErrServiceAccountRejected, SERVICE_ERROR_ACCOUNT_REJECTED)
	}
	return account, nil
}

func (s *Service) loadAccount(c core.Context, uid int64, accountId int64) (*AccountSnapshot, error) {
	if s == nil || s.accounts == nil || uid < 1 || accountId < 1 {
		return nil, serviceError(ErrServiceInvalidRequest, SERVICE_ERROR_INVALID_REQUEST)
	}
	account, err := s.accounts.GetAccount(c, uid, accountId)
	if err != nil {
		return nil, persistError(err)
	}
	if account == nil || account.AccountId != accountId {
		return nil, serviceError(ErrServiceAccountNotFound, SERVICE_ERROR_ACCOUNT_MISSING)
	}
	return account, nil
}

func (s *Service) activeRule(c core.Context, uid int64, ledgerAccountId int64) (*CycleRule, error) {
	rules, err := s.repository.ListRules(c, uid, ledgerAccountId)
	if err != nil {
		return nil, persistError(err)
	}
	var active *CycleRule
	for _, rule := range rules {
		if rule != nil && rule.Status == RULE_STATUS_ACTIVE {
			active = rule
		}
	}
	return active, nil
}
