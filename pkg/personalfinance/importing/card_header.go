package importing

import "time"

// CardHeader 保存一份信用卡月结单页眉抽出的账单日、还款日和额度。
// 未知出账日/到期日使用非 NULL 空字符串；未知额度必须为 NULL，禁止写 0 冒充未知。
type CardHeader struct {
	Uid               int64  `xorm:"BIGINT UNIQUE(UQE_pf_card_hdr_uid_batch) NOT NULL"`
	BatchId           int64  `xorm:"BIGINT UNIQUE(UQE_pf_card_hdr_uid_batch) NOT NULL"`
	StatementDate     string `xorm:"CHAR(10) NOT NULL"`
	DueDate           string `xorm:"CHAR(10) NOT NULL"`
	CreditLimitAmount *int64 `xorm:"BIGINT NULL"`
	Currency          string `xorm:"VARCHAR(3) NOT NULL"`
	CreatedUnixTime   int64  `xorm:"BIGINT NOT NULL"`
	HeaderId          int64  `xorm:"BIGINT PK NOT NULL"`
}

// TableName 返回固定的个人财务表名。
func (CardHeader) TableName() string {
	return "pf_import_batch_card_header"
}

func hasCardHeaderMetadata(metadata DocumentMetadata) bool {
	return metadata.StatementDateUnixTime != nil || metadata.DueUnixTime != nil || metadata.CreditLimitAmount != nil
}

func cardHeaderFromMetadata(uid int64, batchId int64, headerId int64, createdUnixTime int64, metadata DocumentMetadata, currency string) *CardHeader {
	if !hasCardHeaderMetadata(metadata) || headerId < 1 || uid < 1 || batchId < 1 || createdUnixTime < 1 {
		return nil
	}
	statementDate := civilDateFromUnix(metadata.StatementDateUnixTime, metadata.StatementTimezoneUtcOffset)
	dueDate := civilDateFromUnix(metadata.DueUnixTime, metadata.StatementTimezoneUtcOffset)
	headerCurrency := ""
	if metadata.CreditLimitAmount != nil {
		headerCurrency = currency
	}
	return &CardHeader{
		Uid:               uid,
		BatchId:           batchId,
		StatementDate:     statementDate,
		DueDate:           dueDate,
		CreditLimitAmount: cloneInt64Pointer(metadata.CreditLimitAmount),
		Currency:          headerCurrency,
		CreatedUnixTime:   createdUnixTime,
		HeaderId:          headerId,
	}
}

func civilDateFromUnix(unixTime *int64, offset *int16) string {
	if unixTime == nil || *unixTime < 1 {
		return ""
	}
	seconds := 0
	if offset != nil {
		seconds = int(*offset) * 60
	}
	return time.Unix(*unixTime, 0).In(time.FixedZone("statement-header", seconds)).Format(time.DateOnly)
}

func cloneCardHeader(header *CardHeader) *CardHeader {
	if header == nil {
		return nil
	}
	cloned := *header
	cloned.CreditLimitAmount = cloneInt64Pointer(header.CreditLimitAmount)
	return &cloned
}

func isValidCardHeader(header *CardHeader, batch *ImportBatch) bool {
	if header == nil || batch == nil || header.Uid != batch.Uid || header.BatchId != batch.BatchId ||
		header.HeaderId < 1 || header.CreatedUnixTime != batch.CreatedUnixTime {
		return false
	}
	if !isCardHeaderCivilDate(header.StatementDate) || !isCardHeaderCivilDate(header.DueDate) {
		return false
	}
	if header.CreditLimitAmount == nil {
		return header.Currency == ""
	}
	return *header.CreditLimitAmount >= 0 && isValidPaymentAccountCurrency(header.Currency)
}

func isCardHeaderCivilDate(value string) bool {
	if value == "" {
		return true
	}
	parsed, err := time.Parse(time.DateOnly, value)
	return err == nil && parsed.Format(time.DateOnly) == value
}
