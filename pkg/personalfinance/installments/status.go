package installments

// RuleVersion 标识会影响分期候选身份或检测结果的规则版本。
type RuleVersion string

const (
	CANDIDATE_KEY_VERSION_V1 RuleVersion = "installment-candidate-key-v1"
	DETECT_VERSION_V1        RuleVersion = "installment-detect-v1"
)

// CandidateStatus 表示待确认分期候选的生命周期。
type CandidateStatus string

const (
	CANDIDATE_STATUS_PENDING         CandidateStatus = "pending"
	CANDIDATE_STATUS_NEEDS_DETAILS   CandidateStatus = "needs_details"
	CANDIDATE_STATUS_LINKED          CandidateStatus = "linked"
	CANDIDATE_STATUS_CONVERTED       CandidateStatus = "converted"
	CANDIDATE_STATUS_DISMISSED       CandidateStatus = "dismissed"
	CANDIDATE_STATUS_ACTION_REQUIRED CandidateStatus = "action_required"
)

// PurchaseRelation 描述候选与原消费正式交易的关系。
type PurchaseRelation string

const (
	PURCHASE_RELATION_UNRESOLVED        PurchaseRelation = "unresolved"
	PURCHASE_RELATION_LINK_EXISTING     PurchaseRelation = "link_existing"
	PURCHASE_RELATION_MISSING_CANDIDATE PurchaseRelation = "missing_candidate"
)

// RepaymentMethod 与贷款合同还款法对齐；未知时持久化空字符串。
type RepaymentMethod string

const (
	REPAYMENT_METHOD_UNKNOWN          RepaymentMethod = ""
	REPAYMENT_METHOD_FLAT             RepaymentMethod = "flat"
	REPAYMENT_METHOD_EQUAL_PAYMENT    RepaymentMethod = "equal_payment"
	REPAYMENT_METHOD_EQUAL_PRINCIPAL  RepaymentMethod = "equal_principal"
	REPAYMENT_METHOD_INTEREST_ONLY    RepaymentMethod = "interest_only"
	REPAYMENT_METHOD_STATEMENT_CUSTOM RepaymentMethod = "statement_or_custom"
)

// MemberKind 表示候选成员引用的证据实体类型。
type MemberKind string

const (
	MEMBER_KIND_SOURCE_IDENTITY MemberKind = "source_identity"
	MEMBER_KIND_RAW_ROW         MemberKind = "raw_row"
)

// MemberRole 表示证据在分期候选中的稳定角色。
type MemberRole string

const (
	MEMBER_ROLE_INSTALLMENT_CHARGE MemberRole = "installment_charge"
	MEMBER_ROLE_ORIGINAL_PURCHASE  MemberRole = "original_purchase"
	MEMBER_ROLE_FEE                MemberRole = "fee"
)

func isCandidateStatus(value CandidateStatus) bool {
	switch value {
	case CANDIDATE_STATUS_PENDING, CANDIDATE_STATUS_NEEDS_DETAILS, CANDIDATE_STATUS_LINKED,
		CANDIDATE_STATUS_CONVERTED, CANDIDATE_STATUS_DISMISSED, CANDIDATE_STATUS_ACTION_REQUIRED:
		return true
	default:
		return false
	}
}

func isPurchaseRelation(value PurchaseRelation) bool {
	return value == PURCHASE_RELATION_UNRESOLVED || value == PURCHASE_RELATION_LINK_EXISTING ||
		value == PURCHASE_RELATION_MISSING_CANDIDATE
}

func isRepaymentMethod(value RepaymentMethod) bool {
	switch value {
	case REPAYMENT_METHOD_UNKNOWN, REPAYMENT_METHOD_FLAT, REPAYMENT_METHOD_EQUAL_PAYMENT,
		REPAYMENT_METHOD_EQUAL_PRINCIPAL, REPAYMENT_METHOD_INTEREST_ONLY, REPAYMENT_METHOD_STATEMENT_CUSTOM:
		return true
	default:
		return false
	}
}

func isMemberKind(value MemberKind) bool {
	return value == MEMBER_KIND_SOURCE_IDENTITY || value == MEMBER_KIND_RAW_ROW
}

func isMemberRole(value MemberRole) bool {
	return value == MEMBER_ROLE_INSTALLMENT_CHARGE || value == MEMBER_ROLE_ORIGINAL_PURCHASE || value == MEMBER_ROLE_FEE
}
