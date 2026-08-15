package cardcycle

// RuleStatus 表示一条常规账单规则 revision 是否仍为当前有效规则。
type RuleStatus string

const (
	RULE_STATUS_ACTIVE     RuleStatus = "active"
	RULE_STATUS_SUPERSEDED RuleStatus = "superseded"
)

// BalanceReviewStatus 表示正式账户当前余额是否已经用户核对。
type BalanceReviewStatus string

const (
	BALANCE_REVIEW_UNVERIFIED BalanceReviewStatus = "unverified"
	BALANCE_REVIEW_VERIFIED   BalanceReviewStatus = "verified"
)

const (
	minimumCardCycleDay = int64(1)
	maximumCardCycleDay = int64(28)
	emptyCivilDate      = ""
)

func isRuleStatus(value RuleStatus) bool {
	return value == RULE_STATUS_ACTIVE || value == RULE_STATUS_SUPERSEDED
}

func isBalanceReviewStatus(value BalanceReviewStatus) bool {
	return value == BALANCE_REVIEW_UNVERIFIED || value == BALANCE_REVIEW_VERIFIED
}

func isCardCycleDay(value int64) bool {
	return value >= minimumCardCycleDay && value <= maximumCardCycleDay
}
