package reconciliation

// RuleVersion 标识会影响持久化对账结果的规则版本。
type RuleVersion string

const (
	CASE_KEY_VERSION_V1         RuleVersion = "reconciliation-case-key-v1"
	CANDIDATE_RULE_VERSION_V1   RuleVersion = "reconciliation-candidate-v1"
	CANDIDATE_RULE_VERSION_V2   RuleVersion = "reconciliation-candidate-v2"
	CANDIDATE_RULE_VERSION_V3   RuleVersion = "reconciliation-candidate-v3"
	CANDIDATE_RULE_VERSION_V4   RuleVersion = "reconciliation-candidate-v4"
	EXPLANATION_VERSION_V1      RuleVersion = "reconciliation-explanation-v1"
	EXPLANATION_VERSION_V2      RuleVersion = "reconciliation-explanation-v2"
	EXPLANATION_VERSION_V3      RuleVersion = "reconciliation-explanation-v3"
	EXPLANATION_VERSION_V4      RuleVersion = "reconciliation-explanation-v4"
	IDEMPOTENCY_KEY_VERSION_V1  RuleVersion = "idempotency-key-v1"
	DECISION_REQUEST_VERSION_V1 RuleVersion = "reconciliation-request-v1"
	TRANSACTION_LINK_VERSION_V1 RuleVersion = "reconciliation-link-v1"
)

// CaseStatus 表示人工对账 case 的生命周期状态。
type CaseStatus string

const (
	CASE_STATUS_OPEN            CaseStatus = "open"
	CASE_STATUS_RESOLVED        CaseStatus = "resolved"
	CASE_STATUS_ACTION_REQUIRED CaseStatus = "action_required"
	CASE_STATUS_DEFERRED        CaseStatus = "deferred"
)

// MemberKind 表示 case 成员引用的证据实体类型。
type MemberKind string

const (
	MEMBER_KIND_SOURCE_IDENTITY MemberKind = "source_identity"
	MEMBER_KIND_RAW_ROW         MemberKind = "raw_row"
)

// MemberRole 由候选规则保存成员在当前 case 中的稳定角色。
// 角色值由候选生成契约定义，模型层不推测来源或会计语义。
type MemberRole string

// DecisionType 表示用户对一个对账 case 作出的追加式决定。
type DecisionType string

const (
	DECISION_TYPE_SAME_EVENT        DecisionType = "same_event"
	DECISION_TYPE_INTERNAL_TRANSFER DecisionType = "internal_transfer"
	DECISION_TYPE_REFUND_REVERSAL   DecisionType = "refund_reversal"
	DECISION_TYPE_INDEPENDENT       DecisionType = "independent"
	DECISION_TYPE_DEFER             DecisionType = "defer"
	DECISION_TYPE_REOPEN            DecisionType = "reopen"
)

// DecisionStatus 表示持久幂等决定命令的执行状态。
type DecisionStatus string

const (
	DECISION_STATUS_READY           DecisionStatus = "ready"
	DECISION_STATUS_APPLYING        DecisionStatus = "applying"
	DECISION_STATUS_APPLIED         DecisionStatus = "applied"
	DECISION_STATUS_ACTION_REQUIRED DecisionStatus = "action_required"
	DECISION_STATUS_DEFERRED        DecisionStatus = "deferred"
	DECISION_STATUS_FAILED          DecisionStatus = "failed"
)

// TransactionRelationRole 表示对账证据对应正式账本事件的角色。
type TransactionRelationRole string

const (
	TRANSACTION_RELATION_ROLE_PRIMARY              TransactionRelationRole = "primary"
	TRANSACTION_RELATION_ROLE_TRANSFER_COUNTERPART TransactionRelationRole = "transfer_counterpart"
	TRANSACTION_RELATION_ROLE_REFUND_ORIGINAL      TransactionRelationRole = "refund_original"
	TRANSACTION_RELATION_ROLE_REFUND_TRANSACTION   TransactionRelationRole = "refund_transaction"
)

// TransactionCreationMethod 表示正式交易是复用既有事件还是由对账决定创建。
type TransactionCreationMethod string

const (
	TRANSACTION_CREATION_METHOD_ATTACHED_EXISTING      TransactionCreationMethod = "attached_existing"
	TRANSACTION_CREATION_METHOD_RECONCILIATION_CREATED TransactionCreationMethod = "reconciliation_created"
)

// LedgerEffectType 表示决定产生且需要留痕的可撤销账本效果。
type LedgerEffectType string

const (
	LEDGER_EFFECT_TYPE_CREATED      LedgerEffectType = "created"
	LEDGER_EFFECT_TYPE_SOFT_DELETED LedgerEffectType = "soft_deleted"
	LEDGER_EFFECT_TYPE_RESTORED     LedgerEffectType = "restored"
)
