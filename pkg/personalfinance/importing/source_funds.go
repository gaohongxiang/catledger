package importing

// SourceFundsMovementKind 表示来源账单已经能确定的资金关系，不创建第二套账本语义。
type SourceFundsMovementKind string

const (
	SOURCE_FUNDS_MOVEMENT_INTERNAL_TRANSFER SourceFundsMovementKind = "internal_transfer"
	SOURCE_FUNDS_MOVEMENT_REPAYMENT         SourceFundsMovementKind = "repayment"
)

// SourceFundsAccountReferenceKind 区分账单归属账户与账单行里的付款账户别名。
// statement_account 由批次冻结的来源账户映射解析；payment_account 由付款方式映射解析。
type SourceFundsAccountReferenceKind string

const (
	SOURCE_FUNDS_ACCOUNT_STATEMENT SourceFundsAccountReferenceKind = "statement_account"
	SOURCE_FUNDS_ACCOUNT_PAYMENT   SourceFundsAccountReferenceKind = "payment_account"
)

type SourceFundsAccountReference struct {
	Kind SourceFundsAccountReferenceKind
	Raw  string
}

// SourceFundsProjection 是来源解析器对一条资金动作给出的双边投影。
// 它只携带内存中的账户引用，原始文本不会写入经济事件。
type SourceFundsProjection struct {
	Kind        SourceFundsMovementKind
	From        SourceFundsAccountReference
	To          SourceFundsAccountReference
	RuleVersion RuleVersion
}

// SourceFundsProjector 由各来源转换器复用自己的成熟动作规则实现。
// organizer 只消费投影，不重复识别“充值、提现、还款”等来源文案。
type SourceFundsProjector interface {
	ProjectSourceFunds(sourceType SourceType, row *RawImportRow) (SourceFundsProjection, bool)
}
