package loans

// Contract 保存贷款合同身份与生命周期，不复制正式账户余额。
type Contract struct {
	Uid                     int64           `xorm:"BIGINT INDEX(IDX_pf_loan_contract_uid_status_updated) INDEX(IDX_pf_loan_contract_uid_liability) NOT NULL"`
	Name                    string          `xorm:"VARCHAR(128) NOT NULL"`
	LenderName              string          `xorm:"VARCHAR(128) NOT NULL"`
	ContractType            ContractType    `xorm:"VARCHAR(32) NOT NULL"`
	LiabilityAccountId      int64           `xorm:"BIGINT INDEX(IDX_pf_loan_contract_uid_liability) NOT NULL"`
	Status                  ContractStatus  `xorm:"VARCHAR(32) INDEX(IDX_pf_loan_contract_uid_status_updated) INDEX(IDX_pf_loan_contract_uid_liability) NOT NULL"`
	CloseReasonCode         CloseReasonCode `xorm:"VARCHAR(32) NOT NULL"`
	DefaultPaymentAccountId *int64          `xorm:"BIGINT NULL"`
	Currency                string          `xorm:"CHAR(3) NOT NULL"`
	Note                    string          `xorm:"VARCHAR(255) NOT NULL"`
	Version                 int64           `xorm:"BIGINT NOT NULL"`
	CurrentRevisionId       int64           `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime         int64           `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime         int64           `xorm:"BIGINT INDEX(IDX_pf_loan_contract_uid_status_updated) NOT NULL"`
	ClosedUnixTime          *int64          `xorm:"BIGINT NULL"`
	ContractId              int64           `xorm:"BIGINT PK INDEX(IDX_pf_loan_contract_uid_status_updated) INDEX(IDX_pf_loan_contract_uid_liability) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (Contract) TableName() string {
	return "pf_loan_contract"
}

// ContractRevision 追加式保存一组不可变计算输入、版本和结果。
type ContractRevision struct {
	Uid                           int64           `xorm:"BIGINT UNIQUE(UQE_pf_loan_revision_uid_number) UNIQUE(UQE_pf_loan_revision_uid_action) INDEX(IDX_pf_loan_revision_uid_contract_created) NOT NULL"`
	ContractId                    int64           `xorm:"BIGINT UNIQUE(UQE_pf_loan_revision_uid_number) INDEX(IDX_pf_loan_revision_uid_contract_created) NOT NULL"`
	RevisionNumber                int64           `xorm:"BIGINT UNIQUE(UQE_pf_loan_revision_uid_number) NOT NULL"`
	PreviousRevisionId            *int64          `xorm:"BIGINT NULL"`
	ActionId                      int64           `xorm:"BIGINT UNIQUE(UQE_pf_loan_revision_uid_action) NOT NULL"`
	EffectiveDate                 string          `xorm:"CHAR(10) NOT NULL"`
	ContractDate                  string          `xorm:"CHAR(10) NOT NULL"`
	FirstDueDate                  string          `xorm:"CHAR(10) NOT NULL"`
	FundingType                   FundingType     `xorm:"VARCHAR(32) NOT NULL"`
	InputMode                     InputMode       `xorm:"VARCHAR(32) NOT NULL"`
	RepaymentMethod               RepaymentMethod `xorm:"VARCHAR(32) NOT NULL"`
	RateQuoteType                 RateQuoteType   `xorm:"VARCHAR(32) NOT NULL"`
	FrequencyType                 FrequencyType   `xorm:"VARCHAR(32) NOT NULL"`
	FrequencyInterval             int64           `xorm:"BIGINT NOT NULL"`
	PrincipalAmount               int64           `xorm:"BIGINT NOT NULL"`
	ActualDisbursementAmount      int64           `xorm:"BIGINT NOT NULL"`
	UpfrontFeeAmount              int64           `xorm:"BIGINT NOT NULL"`
	PerPeriodFeeAmount            int64           `xorm:"BIGINT NOT NULL"`
	PaymentBasisAmount            *int64          `xorm:"BIGINT NULL"`
	TermCount                     int64           `xorm:"BIGINT NOT NULL"`
	QuotedRatePptr                *int64          `xorm:"BIGINT NULL"`
	DiscountType                  DiscountType    `xorm:"VARCHAR(32) NOT NULL"`
	DiscountRatePptr              *int64          `xorm:"BIGINT NULL"`
	DiscountAmount                int64           `xorm:"BIGINT NOT NULL"`
	CalculationVersion            RuleVersion     `xorm:"VARCHAR(32) NOT NULL"`
	RoundingVersion               RuleVersion     `xorm:"VARCHAR(32) NOT NULL"`
	IrrVersion                    RuleVersion     `xorm:"VARCHAR(32) NOT NULL"`
	ScheduleDigest                string          `xorm:"CHAR(64) NOT NULL"`
	PreDiscountTotalPaymentAmount int64           `xorm:"BIGINT NOT NULL"`
	PreDiscountTotalCostAmount    int64           `xorm:"BIGINT NOT NULL"`
	TotalPaymentAmount            int64           `xorm:"BIGINT NOT NULL"`
	TotalInterestAmount           int64           `xorm:"BIGINT NOT NULL"`
	TotalFeeAmount                int64           `xorm:"BIGINT NOT NULL"`
	TotalDiscountAmount           int64           `xorm:"BIGINT NOT NULL"`
	TotalCostAmount               int64           `xorm:"BIGINT NOT NULL"`
	CostRatioPptr                 int64           `xorm:"BIGINT NOT NULL"`
	IrrStatus                     IRRStatus       `xorm:"VARCHAR(32) NOT NULL"`
	MonthlyIrrPptr                *int64          `xorm:"BIGINT NULL"`
	SimpleAprPptr                 *int64          `xorm:"BIGINT NULL"`
	EffectiveAprPptr              *int64          `xorm:"BIGINT NULL"`
	CreatedUnixTime               int64           `xorm:"BIGINT INDEX(IDX_pf_loan_revision_uid_contract_created) NOT NULL"`
	RevisionId                    int64           `xorm:"BIGINT PK INDEX(IDX_pf_loan_revision_uid_contract_created) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (ContractRevision) TableName() string {
	return "pf_loan_contract_revision"
}

// Installment 保存某一 revision 的不可变逐期结果。
type Installment struct {
	Uid                       int64  `xorm:"BIGINT UNIQUE(UQE_pf_loan_installment_uid_revision_number) INDEX(IDX_pf_loan_installment_uid_contract_due) INDEX(IDX_pf_loan_installment_uid_revision_order) NOT NULL"`
	ContractId                int64  `xorm:"BIGINT INDEX(IDX_pf_loan_installment_uid_contract_due) NOT NULL"`
	RevisionId                int64  `xorm:"BIGINT UNIQUE(UQE_pf_loan_installment_uid_revision_number) INDEX(IDX_pf_loan_installment_uid_revision_order) NOT NULL"`
	InstallmentNumber         int64  `xorm:"BIGINT UNIQUE(UQE_pf_loan_installment_uid_revision_number) INDEX(IDX_pf_loan_installment_uid_revision_order) NOT NULL"`
	DueDate                   string `xorm:"CHAR(10) INDEX(IDX_pf_loan_installment_uid_contract_due) NOT NULL"`
	BeginningPrincipalAmount  int64  `xorm:"BIGINT NOT NULL"`
	PrincipalAmount           int64  `xorm:"BIGINT NOT NULL"`
	InterestAmount            int64  `xorm:"BIGINT NOT NULL"`
	FeeAmount                 int64  `xorm:"BIGINT NOT NULL"`
	DiscountAmount            int64  `xorm:"BIGINT NOT NULL"`
	PaymentAmount             int64  `xorm:"BIGINT NOT NULL"`
	EndingPrincipalAmount     int64  `xorm:"BIGINT NOT NULL"`
	PreDiscountInterestAmount int64  `xorm:"BIGINT NOT NULL"`
	PreDiscountFeeAmount      int64  `xorm:"BIGINT NOT NULL"`
	PreDiscountPaymentAmount  int64  `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime           int64  `xorm:"BIGINT NOT NULL"`
	InstallmentId             int64  `xorm:"BIGINT PK INDEX(IDX_pf_loan_installment_uid_contract_due) INDEX(IDX_pf_loan_installment_uid_revision_order) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (Installment) TableName() string {
	return "pf_loan_installment"
}

// Action 保存一次追加式、持久幂等的贷款命令。
type Action struct {
	Uid                     int64        `xorm:"BIGINT UNIQUE(UQE_pf_loan_action_uid_key) INDEX(IDX_pf_loan_action_uid_contract_created) INDEX(IDX_pf_loan_action_uid_status_updated) NOT NULL"`
	ContractId              int64        `xorm:"BIGINT INDEX(IDX_pf_loan_action_uid_contract_created) NOT NULL"`
	ExpectedContractVersion int64        `xorm:"BIGINT NOT NULL"`
	AppliedContractVersion  int64        `xorm:"BIGINT NOT NULL"`
	ActionType              ActionType   `xorm:"VARCHAR(32) NOT NULL"`
	PreviousActionId        *int64       `xorm:"BIGINT NULL"`
	IdempotencyKeyDigest    string       `xorm:"CHAR(64) UNIQUE(UQE_pf_loan_action_uid_key) NOT NULL"`
	IdempotencyKeyVersion   RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	RequestDigest           string       `xorm:"CHAR(64) NOT NULL"`
	RequestDigestVersion    RuleVersion  `xorm:"VARCHAR(32) NOT NULL"`
	Status                  ActionStatus `xorm:"VARCHAR(32) INDEX(IDX_pf_loan_action_uid_status_updated) NOT NULL"`
	ReasonCodesJson         string       `xorm:"TEXT NOT NULL"`
	ErrorCode               string       `xorm:"VARCHAR(64) NOT NULL"`
	CreatedUnixTime         int64        `xorm:"BIGINT INDEX(IDX_pf_loan_action_uid_contract_created) NOT NULL"`
	UpdatedUnixTime         int64        `xorm:"BIGINT INDEX(IDX_pf_loan_action_uid_status_updated) NOT NULL"`
	StartedUnixTime         *int64       `xorm:"BIGINT NULL"`
	CompletedUnixTime       *int64       `xorm:"BIGINT NULL"`
	FailedUnixTime          *int64       `xorm:"BIGINT NULL"`
	ActionId                int64        `xorm:"BIGINT PK INDEX(IDX_pf_loan_action_uid_contract_created) INDEX(IDX_pf_loan_action_uid_status_updated) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (Action) TableName() string {
	return "pf_loan_action"
}

// TransactionBinding 是同一正式交易行活动分配的并发唯一锚点。
type TransactionBinding struct {
	Uid                 int64  `xorm:"BIGINT UNIQUE(UQE_pf_loan_binding_uid_transaction) INDEX(IDX_pf_loan_binding_uid_current) NOT NULL"`
	TransactionId       int64  `xorm:"BIGINT UNIQUE(UQE_pf_loan_binding_uid_transaction) NOT NULL"`
	CurrentAllocationId *int64 `xorm:"BIGINT INDEX(IDX_pf_loan_binding_uid_current) NULL"`
	Version             int64  `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime     int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime     int64  `xorm:"BIGINT NOT NULL"`
	BindingId           int64  `xorm:"BIGINT PK INDEX(IDX_pf_loan_binding_uid_current) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (TransactionBinding) TableName() string {
	return "pf_loan_transaction_binding"
}

// TransactionAllocation 保存当前和历史正式交易分配；撤销不会覆盖旧行。
type TransactionAllocation struct {
	Uid                        int64                    `xorm:"BIGINT INDEX(IDX_pf_loan_allocation_uid_contract_status) INDEX(IDX_pf_loan_allocation_uid_installment) INDEX(IDX_pf_loan_allocation_uid_action) NOT NULL"`
	ContractId                 int64                    `xorm:"BIGINT INDEX(IDX_pf_loan_allocation_uid_contract_status) INDEX(IDX_pf_loan_allocation_uid_installment) NOT NULL"`
	InstallmentId              *int64                   `xorm:"BIGINT INDEX(IDX_pf_loan_allocation_uid_installment) NULL"`
	PrimaryBindingId           int64                    `xorm:"BIGINT NOT NULL"`
	CounterpartBindingId       *int64                   `xorm:"BIGINT NULL"`
	ComponentType              ComponentType            `xorm:"VARCHAR(32) NOT NULL"`
	AllocatedAmount            int64                    `xorm:"BIGINT NOT NULL"`
	CreationMethod             AllocationCreationMethod `xorm:"VARCHAR(32) NOT NULL"`
	Status                     AllocationStatus         `xorm:"VARCHAR(32) INDEX(IDX_pf_loan_allocation_uid_contract_status) INDEX(IDX_pf_loan_allocation_uid_installment) NOT NULL"`
	TransactionUpdatedUnixTime int64                    `xorm:"BIGINT NOT NULL"`
	CounterpartUpdatedUnixTime *int64                   `xorm:"BIGINT NULL"`
	CreatedActionId            int64                    `xorm:"BIGINT INDEX(IDX_pf_loan_allocation_uid_action) NOT NULL"`
	LastActionId               int64                    `xorm:"BIGINT NOT NULL"`
	CreatedUnixTime            int64                    `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime            int64                    `xorm:"BIGINT INDEX(IDX_pf_loan_allocation_uid_contract_status) NOT NULL"`
	AllocationId               int64                    `xorm:"BIGINT PK INDEX(IDX_pf_loan_allocation_uid_contract_status) INDEX(IDX_pf_loan_allocation_uid_installment) INDEX(IDX_pf_loan_allocation_uid_action) NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (TransactionAllocation) TableName() string {
	return "pf_loan_transaction_allocation"
}
