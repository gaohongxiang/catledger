package billflow

import "github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"

// RuleVersion 标识会影响整理任务持久结果或幂等语义的规则版本。
type RuleVersion string

const (
	AUTO_POST_VERSION_V1              RuleVersion = "auto-post-v1"
	HIGH_CONFIDENCE_WINDOW_VERSION_V1 RuleVersion = "high-confidence-window-v1"
	CATEGORY_ALIAS_VERSION_V1         RuleVersion = "category-alias-v1"
	IDEMPOTENCY_KEY_VERSION_V1        RuleVersion = "idempotency-key-v1"
	ACTION_REQUEST_DIGEST_VERSION_V1  RuleVersion = "billflow-action-request-v1"
	HIGH_CONFIDENCE_WINDOW_SECONDS    int64       = 48 * 60 * 60
)

// TaskStatus 表示逻辑整理任务的生命周期。
type TaskStatus string

const (
	TASK_STATUS_RECEIVING        TaskStatus = "receiving"
	TASK_STATUS_ACCOUNTS_PENDING TaskStatus = "accounts_pending"
	TASK_STATUS_PROCESSING       TaskStatus = "processing"
	TASK_STATUS_AWAITING_CONFIRM TaskStatus = "awaiting_confirm"
	TASK_STATUS_READY            TaskStatus = "ready"
	TASK_STATUS_FAILED           TaskStatus = "failed"
)

// ConfirmPolicy 决定账户解决后是否立即写入正式账本。
type ConfirmPolicy string

const (
	CONFIRM_POLICY_CONFIRM_THEN_POST ConfirmPolicy = "confirm_then_post"
	CONFIRM_POLICY_AUTO_POST         ConfirmPolicy = "auto_post"
)

// ActionType 是追加式整理命令类型。
type ActionType string

const (
	ACTION_TYPE_CREATE_TASK              ActionType = "create_task"
	ACTION_TYPE_APPLY_ACCOUNTS           ActionType = "apply_accounts"
	ACTION_TYPE_RUN_ORGANIZE             ActionType = "run_organize"
	ACTION_TYPE_CONFIRM_POST             ActionType = "confirm_post"
	ACTION_TYPE_RESOLVE_TODO             ActionType = "resolve_todo"
	ACTION_TYPE_UNDO_POST                ActionType = "undo_post"
	ACTION_TYPE_CONFIRM_INSTALLMENT      ActionType = "confirm_installment"
	ACTION_TYPE_SAVE_INSTALLMENT_DETAILS ActionType = "save_installment_details"
	ACTION_TYPE_SAVE_BALANCE_REVIEW      ActionType = "save_balance_review"
	ACTION_TYPE_SAVE_CARD_RULE           ActionType = "save_card_rule"
)

// ActionStatus 表示持久幂等命令的执行状态。
type ActionStatus string

const (
	ACTION_STATUS_READY           ActionStatus = "ready"
	ACTION_STATUS_APPLYING        ActionStatus = "applying"
	ACTION_STATUS_APPLIED         ActionStatus = "applied"
	ACTION_STATUS_ACTION_REQUIRED ActionStatus = "action_required"
	ACTION_STATUS_FAILED          ActionStatus = "failed"
)

// TodoKind 是整理任务例外待办的稳定码。
type TodoKind string

const (
	TODO_KIND_UNRESOLVED_PAYMENT_ACCOUNT TodoKind = "unresolved_payment_account"
	TODO_KIND_IDENTITY_CONFLICT          TodoKind = "identity_conflict"
	TODO_KIND_CORE_FIELD_CONFLICT        TodoKind = "core_field_conflict"
	TODO_KIND_LEDGER_MISMATCH            TodoKind = "ledger_mismatch"
	TODO_KIND_CROSS_SOURCE_AMBIGUOUS     TodoKind = "cross_source_ambiguous"
	TODO_KIND_TRANSFER_UNCLEAR           TodoKind = "transfer_unclear"
	TODO_KIND_REFUND_UNCLEAR             TodoKind = "refund_unclear"
	TODO_KIND_REPAYMENT_UNCLEAR          TodoKind = "repayment_unclear"
	TODO_KIND_INSTALLMENT_CANDIDATE      TodoKind = "installment_candidate"
	TODO_KIND_UNCATEGORIZED              TodoKind = "uncategorized"
)

// TodoStatus 表示待办是否仍需用户处理。
type TodoStatus string

const (
	TODO_STATUS_OPEN      TodoStatus = "open"
	TODO_STATUS_RESOLVED  TodoStatus = "resolved"
	TODO_STATUS_DISMISSED TodoStatus = "dismissed"
)

// SubjectKind 标识待办主体引用的实体类型。
type SubjectKind string

const (
	SUBJECT_KIND_RAW_ROW               SubjectKind = "raw_row"
	SUBJECT_KIND_SOURCE_IDENTITY       SubjectKind = "source_identity"
	SUBJECT_KIND_RECONCILIATION_CASE   SubjectKind = "reconciliation_case"
	SUBJECT_KIND_INSTALLMENT_CANDIDATE SubjectKind = "installment_candidate"
	SUBJECT_KIND_PAYMENT_ALIAS         SubjectKind = "payment_alias"
	SUBJECT_KIND_TRANSACTION           SubjectKind = "transaction"
)

func isTaskStatus(value TaskStatus) bool {
	switch value {
	case TASK_STATUS_RECEIVING, TASK_STATUS_ACCOUNTS_PENDING, TASK_STATUS_PROCESSING,
		TASK_STATUS_AWAITING_CONFIRM, TASK_STATUS_READY, TASK_STATUS_FAILED:
		return true
	default:
		return false
	}
}

func isConfirmPolicy(value ConfirmPolicy) bool {
	return value == CONFIRM_POLICY_CONFIRM_THEN_POST || value == CONFIRM_POLICY_AUTO_POST
}

func isActionType(value ActionType) bool {
	switch value {
	case ACTION_TYPE_CREATE_TASK, ACTION_TYPE_APPLY_ACCOUNTS, ACTION_TYPE_RUN_ORGANIZE,
		ACTION_TYPE_CONFIRM_POST, ACTION_TYPE_RESOLVE_TODO, ACTION_TYPE_UNDO_POST,
		ACTION_TYPE_CONFIRM_INSTALLMENT, ACTION_TYPE_SAVE_INSTALLMENT_DETAILS,
		ACTION_TYPE_SAVE_BALANCE_REVIEW, ACTION_TYPE_SAVE_CARD_RULE:
		return true
	default:
		return false
	}
}

func isActionStatus(value ActionStatus) bool {
	switch value {
	case ACTION_STATUS_READY, ACTION_STATUS_APPLYING, ACTION_STATUS_APPLIED,
		ACTION_STATUS_ACTION_REQUIRED, ACTION_STATUS_FAILED:
		return true
	default:
		return false
	}
}

func isTodoKind(value TodoKind) bool {
	switch value {
	case TODO_KIND_UNRESOLVED_PAYMENT_ACCOUNT, TODO_KIND_IDENTITY_CONFLICT, TODO_KIND_CORE_FIELD_CONFLICT,
		TODO_KIND_LEDGER_MISMATCH, TODO_KIND_CROSS_SOURCE_AMBIGUOUS, TODO_KIND_TRANSFER_UNCLEAR,
		TODO_KIND_REFUND_UNCLEAR, TODO_KIND_REPAYMENT_UNCLEAR, TODO_KIND_INSTALLMENT_CANDIDATE,
		TODO_KIND_UNCATEGORIZED:
		return true
	default:
		return false
	}
}

func isTodoStatus(value TodoStatus) bool {
	return value == TODO_STATUS_OPEN || value == TODO_STATUS_RESOLVED || value == TODO_STATUS_DISMISSED
}

func isSubjectKind(value SubjectKind) bool {
	switch value {
	case SUBJECT_KIND_RAW_ROW, SUBJECT_KIND_SOURCE_IDENTITY, SUBJECT_KIND_RECONCILIATION_CASE,
		SUBJECT_KIND_INSTALLMENT_CANDIDATE, SUBJECT_KIND_PAYMENT_ALIAS, SUBJECT_KIND_TRANSACTION:
		return true
	default:
		return false
	}
}

func isSourceType(value importing.SourceType) bool {
	return value == importing.SOURCE_TYPE_ALIPAY || value == importing.SOURCE_TYPE_WECHAT || value == importing.SOURCE_TYPE_BANK
}
