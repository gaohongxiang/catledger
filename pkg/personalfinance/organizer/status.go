package organizer

// RuleVersion 标识会影响新整理工作流持久结果的规则版本。
type RuleVersion string

const (
	PLAN_VERSION_V1                 RuleVersion = "organizer-plan-v1"
	EVENT_KEY_VERSION_V1            RuleVersion = "economic-event-key-v1"
	RELATION_KEY_VERSION_V1         RuleVersion = "economic-relation-key-v1"
	ACTION_IDEMPOTENCY_VERSION_V1   RuleVersion = "idempotency-key-v1"
	ACTION_REQUEST_VERSION_V1       RuleVersion = "finance-action-request-v1"
	EVENT_TRANSACTION_VERSION_V1    RuleVersion = "event-transaction-link-v1"
	LEGACY_BACKFILL_PLAN_VERSION_V1 RuleVersion = "organizer-legacy-backfill-v1"
)

// ManualFieldMask 按字段保存用户事实，后续自动整理只能重算未锁定字段。
const (
	MANUAL_FIELD_LEDGER_ACCOUNT              int64 = 1 << 0
	MANUAL_FIELD_COUNTERPARTY_LEDGER_ACCOUNT int64 = 1 << 1
	MANUAL_FIELD_FLOW_DIRECTION              int64 = 1 << 2
	MANUAL_FIELD_ECONOMIC_NATURE             int64 = 1 << 3
	MANUAL_FIELD_EVENT_TIME                  int64 = 1 << 4
	MANUAL_FIELD_AMOUNT                      int64 = 1 << 5
	MANUAL_FIELD_CURRENCY                    int64 = 1 << 6
	MANUAL_FIELD_CATEGORY                    int64 = 1 << 7
	MANUAL_FIELD_STATUS                      int64 = 1 << 8
	MANUAL_FIELD_ALL                               = MANUAL_FIELD_LEDGER_ACCOUNT | MANUAL_FIELD_COUNTERPARTY_LEDGER_ACCOUNT |
		MANUAL_FIELD_FLOW_DIRECTION | MANUAL_FIELD_ECONOMIC_NATURE | MANUAL_FIELD_EVENT_TIME |
		MANUAL_FIELD_AMOUNT | MANUAL_FIELD_CURRENCY | MANUAL_FIELD_CATEGORY | MANUAL_FIELD_STATUS
)

// UpdateStatus 表示用户一次财务更新的生命周期。
type UpdateStatus string

const (
	UPDATE_STATUS_DRAFT            UpdateStatus = "draft"
	UPDATE_STATUS_ORGANIZING       UpdateStatus = "organizing"
	UPDATE_STATUS_REVIEW           UpdateStatus = "review"
	UPDATE_STATUS_POSTING          UpdateStatus = "posting"
	UPDATE_STATUS_PARTIALLY_POSTED UpdateStatus = "partially_posted"
	UPDATE_STATUS_POSTED           UpdateStatus = "posted"
	UPDATE_STATUS_FAILED           UpdateStatus = "failed"
	UPDATE_STATUS_UNDONE           UpdateStatus = "undone"
)

// EventStatus 表示经济事件的整理和入账状态。
type EventStatus string

const (
	EVENT_STATUS_READY        EventStatus = "ready"
	EVENT_STATUS_NEEDS_ACTION EventStatus = "needs_action"
	EVENT_STATUS_EXCLUDED     EventStatus = "excluded"
	EVENT_STATUS_POSTED       EventStatus = "posted"
	EVENT_STATUS_CORRECTED    EventStatus = "corrected"
)

// FlowDirection 将资金方向与经济性质分开保存。
type FlowDirection string

const (
	FLOW_DIRECTION_INFLOW  FlowDirection = "inflow"
	FLOW_DIRECTION_OUTFLOW FlowDirection = "outflow"
	FLOW_DIRECTION_NEUTRAL FlowDirection = "neutral"
)

// EconomicNature 表示最终经济性质；unknown 必须进入 needs_action。
type EconomicNature string

const (
	ECONOMIC_NATURE_INCOME             EconomicNature = "income"
	ECONOMIC_NATURE_EXPENSE            EconomicNature = "expense"
	ECONOMIC_NATURE_INTERNAL_TRANSFER  EconomicNature = "internal_transfer"
	ECONOMIC_NATURE_BORROW             EconomicNature = "borrow"
	ECONOMIC_NATURE_REPAYMENT          EconomicNature = "repayment"
	ECONOMIC_NATURE_REFUND             EconomicNature = "refund"
	ECONOMIC_NATURE_FEE                EconomicNature = "fee"
	ECONOMIC_NATURE_BALANCE_ADJUSTMENT EconomicNature = "balance_adjustment"
	ECONOMIC_NATURE_UNKNOWN            EconomicNature = "unknown"
)

// EvidenceRole 表示原始行在最终事件中的证据角色。
type EvidenceRole string

const (
	EVIDENCE_ROLE_PRIMARY    EvidenceRole = "primary"
	EVIDENCE_ROLE_SUPPORTING EvidenceRole = "supporting"
	EVIDENCE_ROLE_DUPLICATE  EvidenceRole = "duplicate"
)

// RelationType 表示两个经济事件之间的业务关系。
type RelationType string

const (
	RELATION_TYPE_REFUND_OF            RelationType = "refund_of"
	RELATION_TYPE_TRANSFER_BETWEEN     RelationType = "transfer_between"
	RELATION_TYPE_REPAYMENT_OF         RelationType = "repayment_of"
	RELATION_TYPE_DEBT_DISBURSEMENT_OF RelationType = "debt_disbursement_of"
)

// RelationStatus 表示关系裁决状态。
type RelationStatus string

const (
	RELATION_STATUS_PROPOSED  RelationStatus = "proposed"
	RELATION_STATUS_CONFIRMED RelationStatus = "confirmed"
	RELATION_STATUS_REJECTED  RelationStatus = "rejected"
	RELATION_STATUS_UNDONE    RelationStatus = "undone"
)

// EventTransactionRole 表示一个事件对应正式账本交易的角色。
type EventTransactionRole string

const (
	EVENT_TRANSACTION_ROLE_PRIMARY                EventTransactionRole = "primary"
	EVENT_TRANSACTION_ROLE_TRANSFER_COUNTERPART   EventTransactionRole = "transfer_counterpart"
	EVENT_TRANSACTION_ROLE_REFUND_ORIGINAL        EventTransactionRole = "refund_original"
	EVENT_TRANSACTION_ROLE_REFUND_TRANSACTION     EventTransactionRole = "refund_transaction"
	EVENT_TRANSACTION_ROLE_HISTORICAL_PRIMARY     EventTransactionRole = "historical_primary"
	EVENT_TRANSACTION_ROLE_HISTORICAL_COUNTERPART EventTransactionRole = "historical_counterpart"
	EVENT_TRANSACTION_ROLE_HISTORICAL_REFUND      EventTransactionRole = "historical_refund"
)

// ActionType 表示资源化新工作流的命令类型。
type ActionType string

const (
	ACTION_TYPE_CREATE_UPDATE   ActionType = "create_update"
	ACTION_TYPE_ORGANIZE        ActionType = "organize"
	ACTION_TYPE_RESOLVE_EVENT   ActionType = "resolve_event"
	ACTION_TYPE_EXCLUDE_EVENT   ActionType = "exclude_event"
	ACTION_TYPE_POST_ALL_READY  ActionType = "post_all_ready"
	ACTION_TYPE_POST_READY      ActionType = "post_ready"
	ACTION_TYPE_CORRECT_EVENT   ActionType = "correct_event"
	ACTION_TYPE_UNDO            ActionType = "undo"
	ACTION_TYPE_LEGACY_BACKFILL ActionType = "legacy_backfill"
)

// ActionStatus 表示幂等命令状态。
type ActionStatus string

const (
	ACTION_STATUS_READY           ActionStatus = "ready"
	ACTION_STATUS_APPLYING        ActionStatus = "applying"
	ACTION_STATUS_APPLIED         ActionStatus = "applied"
	ACTION_STATUS_ACTION_REQUIRED ActionStatus = "action_required"
	ACTION_STATUS_FAILED          ActionStatus = "failed"
)

func isUpdateStatus(value UpdateStatus) bool {
	switch value {
	case UPDATE_STATUS_DRAFT, UPDATE_STATUS_ORGANIZING, UPDATE_STATUS_REVIEW, UPDATE_STATUS_POSTING,
		UPDATE_STATUS_PARTIALLY_POSTED, UPDATE_STATUS_POSTED, UPDATE_STATUS_FAILED, UPDATE_STATUS_UNDONE:
		return true
	default:
		return false
	}
}

func isEventStatus(value EventStatus) bool {
	switch value {
	case EVENT_STATUS_READY, EVENT_STATUS_NEEDS_ACTION, EVENT_STATUS_EXCLUDED, EVENT_STATUS_POSTED, EVENT_STATUS_CORRECTED:
		return true
	default:
		return false
	}
}

func isFlowDirection(value FlowDirection) bool {
	return value == FLOW_DIRECTION_INFLOW || value == FLOW_DIRECTION_OUTFLOW || value == FLOW_DIRECTION_NEUTRAL
}

func isEconomicNature(value EconomicNature) bool {
	switch value {
	case ECONOMIC_NATURE_INCOME, ECONOMIC_NATURE_EXPENSE, ECONOMIC_NATURE_INTERNAL_TRANSFER,
		ECONOMIC_NATURE_BORROW, ECONOMIC_NATURE_REPAYMENT, ECONOMIC_NATURE_REFUND,
		ECONOMIC_NATURE_FEE, ECONOMIC_NATURE_BALANCE_ADJUSTMENT, ECONOMIC_NATURE_UNKNOWN:
		return true
	default:
		return false
	}
}

func isEvidenceRole(value EvidenceRole) bool {
	return value == EVIDENCE_ROLE_PRIMARY || value == EVIDENCE_ROLE_SUPPORTING || value == EVIDENCE_ROLE_DUPLICATE
}

func isRelationType(value RelationType) bool {
	switch value {
	case RELATION_TYPE_REFUND_OF, RELATION_TYPE_TRANSFER_BETWEEN, RELATION_TYPE_REPAYMENT_OF, RELATION_TYPE_DEBT_DISBURSEMENT_OF:
		return true
	default:
		return false
	}
}

func isRelationStatus(value RelationStatus) bool {
	return value == RELATION_STATUS_PROPOSED || value == RELATION_STATUS_CONFIRMED || value == RELATION_STATUS_REJECTED || value == RELATION_STATUS_UNDONE
}

func isEventTransactionRole(value EventTransactionRole) bool {
	switch value {
	case EVENT_TRANSACTION_ROLE_PRIMARY, EVENT_TRANSACTION_ROLE_TRANSFER_COUNTERPART,
		EVENT_TRANSACTION_ROLE_REFUND_ORIGINAL, EVENT_TRANSACTION_ROLE_REFUND_TRANSACTION,
		EVENT_TRANSACTION_ROLE_HISTORICAL_PRIMARY, EVENT_TRANSACTION_ROLE_HISTORICAL_COUNTERPART,
		EVENT_TRANSACTION_ROLE_HISTORICAL_REFUND:
		return true
	default:
		return false
	}
}

func isActionType(value ActionType) bool {
	switch value {
	case ACTION_TYPE_CREATE_UPDATE, ACTION_TYPE_ORGANIZE, ACTION_TYPE_RESOLVE_EVENT, ACTION_TYPE_EXCLUDE_EVENT,
		ACTION_TYPE_POST_ALL_READY, ACTION_TYPE_POST_READY, ACTION_TYPE_CORRECT_EVENT, ACTION_TYPE_UNDO,
		ACTION_TYPE_LEGACY_BACKFILL:
		return true
	default:
		return false
	}
}

func isActionStatus(value ActionStatus) bool {
	switch value {
	case ACTION_STATUS_READY, ACTION_STATUS_APPLYING, ACTION_STATUS_APPLIED, ACTION_STATUS_ACTION_REQUIRED, ACTION_STATUS_FAILED:
		return true
	default:
		return false
	}
}
