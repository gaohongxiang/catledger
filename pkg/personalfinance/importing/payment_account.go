package importing

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

const maximumPaymentAccountDisplayRunes = 128

var paymentAccountMaskRunPattern = regexp.MustCompile(`[xX]{2,}`)
var paymentAccountLongDigitRunPattern = regexp.MustCompile(`[0-9]{8,}`)

var (
	ErrPaymentAccountRequestInvalid         = errors.New("personal finance payment account request is invalid")
	ErrPaymentAccountBatchNotFound          = errors.New("personal finance payment account batch is not found")
	ErrPaymentAccountRowNotFound            = errors.New("personal finance payment account row is not found")
	ErrPaymentAccountAliasUnavailable       = errors.New("personal finance payment account alias is unavailable")
	ErrPaymentAccountLedgerUnavailable      = errors.New("personal finance payment account ledger account is unavailable")
	ErrPaymentAccountPersistenceUnavailable = errors.New("personal finance payment account persistence is unavailable")
	ErrPaymentAccountExclusionUnavailable   = errors.New("personal finance payment account exclusion is unavailable")
)

// PaymentAccountMapping 把聚合支付账单中的付款方式映射到正式账本账户。
// 它不代表账单归属身份，也不参与来源交易身份计算。
type PaymentAccountMapping struct {
	Uid               int64       `xorm:"BIGINT UNIQUE(UQE_pf_payacct_map_uid_type_currency_key) INDEX(IDX_pf_payacct_map_uid_ledger_updated) NOT NULL"`
	SourceType        SourceType  `xorm:"VARCHAR(32) UNIQUE(UQE_pf_payacct_map_uid_type_currency_key) NOT NULL"`
	Currency          string      `xorm:"VARCHAR(3) UNIQUE(UQE_pf_payacct_map_uid_type_currency_key) NOT NULL"`
	AliasKey          string      `xorm:"CHAR(64) UNIQUE(UQE_pf_payacct_map_uid_type_currency_key) NOT NULL"`
	AliasKeyVersion   RuleVersion `xorm:"VARCHAR(32) NOT NULL"`
	LedgerAccountId   int64       `xorm:"BIGINT INDEX(IDX_pf_payacct_map_uid_ledger_updated) NOT NULL"`
	MaskedDisplayName string      `xorm:"VARCHAR(128) NOT NULL"`
	CreatedUnixTime   int64       `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime   int64       `xorm:"BIGINT INDEX(IDX_pf_payacct_map_uid_ledger_updated) NOT NULL"`
	MappingId         int64       `xorm:"BIGINT PK INDEX(IDX_pf_payacct_map_uid_ledger_updated) NOT NULL"`
}

func (PaymentAccountMapping) TableName() string {
	return "pf_payment_account_mapping"
}

// PaymentAccountAlias 是原始付款方式的不可逆规范键和安全显示值。
type PaymentAccountAlias struct {
	Key         string
	Version     RuleVersion
	DisplayName string
}

// PaymentAccountGroup 是一个批次内相同付款方式的汇总，不暴露 alias 明文材料。
type PaymentAccountGroup struct {
	SourceType      SourceType
	Currency        string
	DisplayName     string
	RowCount        int64
	PendingRowCount int64
	SampleRowId     int64
	LedgerAccountId *int64
	Mapped          bool
	Excluded        bool
	SkippedRowCount int64
}

type PaymentAccountConfirmRequest struct {
	Uid                   int64
	BatchId               int64
	RowId                 int64
	LedgerAccountId       int64
	LedgerAccountCurrency string
}

type PaymentAccountRowView struct {
	RowId     int64
	BatchId   int64
	UnixTime  *int64
	Amount    *int64
	Currency  string
	Direction NormalizedDirection
	Label     string
	Skipped   bool
}

type PaymentAccountSkipRequest struct {
	Uid     int64
	BatchId int64
	RowId   int64
	RowIds  []int64
}

type PaymentAccountRepository interface {
	FindImportBatchById(c core.Context, uid int64, batchId int64) (*ImportBatch, error)
	ListPaymentAccountRows(c core.Context, uid int64, batchId int64) ([]*RawImportRow, error)
	ListPaymentAccountMappings(c core.Context, uid int64, sourceType SourceType) ([]*PaymentAccountMapping, error)
	SavePaymentAccountMappingAndApply(c core.Context, mapping *PaymentAccountMapping, batchId int64, rowIds []int64) (*PaymentAccountMapping, error)
	ListPaymentAccountExclusions(c core.Context, uid int64, sourceType SourceType) ([]*PaymentAccountExclusion, error)
	SavePaymentAccountExclusion(c core.Context, exclusion *PaymentAccountExclusion) (*PaymentAccountExclusion, error)
	DeletePaymentAccountExclusion(c core.Context, uid int64, sourceType SourceType, currency string, aliasKey string) error
	UpdatePaymentAccountRowProcessing(c core.Context, uid int64, batchId int64, rowIds []int64, from ProcessingState, to ProcessingState) error
}

type PaymentAccountService struct {
	repository PaymentAccountRepository
	generateId func() int64
	now        func() time.Time
}

func NewPaymentAccountService(repository PaymentAccountRepository, generateId func() int64) (*PaymentAccountService, error) {
	if repository == nil || generateId == nil {
		return nil, ErrPaymentAccountRequestInvalid
	}

	return &PaymentAccountService{repository: repository, generateId: generateId, now: time.Now}, nil
}

// BuildPaymentAccountAlias 只为有辨识度的付款方式生成版本化摘要。
func BuildPaymentAccountAlias(raw string) (PaymentAccountAlias, bool) {
	instrument := paymentAccountInstrumentName(raw)
	canonical := canonicalPaymentAccountAlias(instrument)

	if !isReusablePaymentAccountAlias(canonical) {
		return PaymentAccountAlias{}, false
	}

	digest := sha256.Sum256([]byte(string(PAYMENT_ACCOUNT_ALIAS_VERSION_V1) + "\x00" + canonical))
	displayName := safePaymentAccountDisplayName(instrument)

	if displayName == "" {
		return PaymentAccountAlias{}, false
	}

	return PaymentAccountAlias{
		Key:         hex.EncodeToString(digest[:]),
		Version:     PAYMENT_ACCOUNT_ALIAS_VERSION_V1,
		DisplayName: displayName,
	}, true
}

func paymentAccountInstrumentName(raw string) string {
	value := strings.TrimSpace(norm.NFKC.String(raw))
	if value == "" {
		return ""
	}
	parts := strings.Split(value, "&")
	if len(parts) < 2 {
		return value
	}
	instruments := make([]string, 0, len(parts))
	droppedCoupon := false
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if isPaymentAccountCouponSegment(part) {
			droppedCoupon = true
			continue
		}
		instruments = append(instruments, part)
	}
	if droppedCoupon && len(instruments) == 1 {
		return instruments[0]
	}
	return value
}

func isPaymentAccountCouponSegment(part string) bool {
	if strings.HasSuffix(part, "券") || strings.HasSuffix(part, "红包") {
		return true
	}
	switch part {
	case "优惠", "立减", "满减", "折扣", "商家优惠", "补贴":
		return true
	default:
		return false
	}
}

func canonicalPaymentAccountAlias(raw string) string {
	value := norm.NFKC.String(strings.TrimSpace(raw))
	value = paymentAccountMaskRunPattern.ReplaceAllString(value, "")
	value = paymentAccountLongDigitRunPattern.ReplaceAllStringFunc(value, func(digits string) string {
		return digits[len(digits)-4:]
	})
	var builder strings.Builder

	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsDigit(char) {
			builder.WriteRune(unicode.ToLower(char))
		}
	}

	canonical := builder.String()
	for _, token := range []string{"末四位", "后四位", "尾号", "卡号"} {
		canonical = strings.ReplaceAll(canonical, token, "")
	}
	return canonical
}

func isReusablePaymentAccountAlias(value string) bool {
	if value == "" || utf8.RuneCountInString(value) > 255 {
		return false
	}

	switch value {
	case "无", "未知", "其他", "不详", "未提供", "银行卡", "信用卡", "贷记卡", "借记卡", "储蓄卡", "支付方式", "付款方式",
		"bankcard", "creditcard", "debitcard", "none", "unknown":
		return false
	default:
		return true
	}
}

func safePaymentAccountDisplayName(raw string) string {
	value := norm.NFKC.String(strings.TrimSpace(raw))
	var cleaned []rune
	spacePending := false

	for _, char := range value {
		if unicode.IsControl(char) || unicode.In(char, unicode.Cf) {
			continue
		}
		if unicode.IsSpace(char) {
			spacePending = len(cleaned) > 0
			continue
		}
		if spacePending {
			cleaned = append(cleaned, ' ')
			spacePending = false
		}
		cleaned = append(cleaned, char)
	}

	masked := make([]rune, 0, len(cleaned))
	for index := 0; index < len(cleaned); {
		if !unicode.IsDigit(cleaned[index]) {
			masked = append(masked, cleaned[index])
			index++
			continue
		}

		end := index + 1
		for end < len(cleaned) && unicode.IsDigit(cleaned[end]) {
			end++
		}
		if end-index >= 8 {
			masked = append(masked, '*', '*', '*', '*')
			masked = append(masked, cleaned[end-4:end]...)
		} else {
			masked = append(masked, cleaned[index:end]...)
		}
		index = end
	}

	if len(masked) > maximumPaymentAccountDisplayRunes {
		masked = masked[:maximumPaymentAccountDisplayRunes]
	}
	return strings.TrimSpace(string(masked))
}

func (s *PaymentAccountService) ListBatchPaymentAccounts(c core.Context, uid int64, batchId int64) ([]*PaymentAccountGroup, error) {
	if uid < 1 || batchId < 1 {
		return nil, ErrPaymentAccountRequestInvalid
	}

	batch, rows, mappings, exclusions, err := s.loadBatchPaymentAccounts(c, uid, batchId)
	if err != nil {
		return nil, err
	}

	return buildPaymentAccountGroups(batch, rows, mappings, exclusions), nil
}

func (s *PaymentAccountService) ConfirmBatchPaymentAccount(c core.Context, request PaymentAccountConfirmRequest) (*PaymentAccountGroup, error) {
	if request.Uid < 1 || request.BatchId < 1 || request.RowId < 1 || request.LedgerAccountId < 1 ||
		!isValidPaymentAccountCurrency(request.LedgerAccountCurrency) {
		return nil, ErrPaymentAccountRequestInvalid
	}

	unlock := lockBatchMutation(request.Uid, request.BatchId)
	defer unlock()

	batch, rows, _, _, err := s.loadBatchPaymentAccounts(c, request.Uid, request.BatchId)
	if err != nil {
		return nil, err
	}

	var sample *RawImportRow
	for _, row := range rows {
		if row != nil && row.RowId == request.RowId {
			sample = row
			break
		}
	}
	if sample == nil || sample.BatchId != request.BatchId || sample.ParseState != PARSE_STATE_VALID {
		return nil, ErrPaymentAccountRowNotFound
	}
	if sample.Currency != request.LedgerAccountCurrency {
		return nil, ErrPaymentAccountLedgerUnavailable
	}

	alias, ok := BuildPaymentAccountAlias(sample.RawPaymentMethod)
	if !ok {
		return nil, ErrPaymentAccountAliasUnavailable
	}

	rowIds := make([]int64, 0)
	rowCount := int64(0)
	pendingCount := int64(0)
	for _, row := range rows {
		if row == nil || row.ParseState != PARSE_STATE_VALID || row.Currency != sample.Currency {
			continue
		}
		candidate, candidateOK := BuildPaymentAccountAlias(row.RawPaymentMethod)
		if !candidateOK || candidate.Key != alias.Key {
			continue
		}
		rowCount++
		if row.ProcessingState == PROCESSING_STATE_PENDING {
			pendingCount++
			rowIds = append(rowIds, row.RowId)
		}
	}

	now := s.now().Unix()
	mappingId := s.generateId()
	if now < 1 || mappingId < 1 || rowCount < 1 {
		return nil, ErrPaymentAccountRequestInvalid
	}

	persisted, err := s.repository.SavePaymentAccountMappingAndApply(c, &PaymentAccountMapping{
		Uid:               request.Uid,
		SourceType:        batch.SourceTypeSnapshot,
		Currency:          sample.Currency,
		AliasKey:          alias.Key,
		AliasKeyVersion:   alias.Version,
		LedgerAccountId:   request.LedgerAccountId,
		MaskedDisplayName: alias.DisplayName,
		CreatedUnixTime:   now,
		UpdatedUnixTime:   now,
		MappingId:         mappingId,
	}, request.BatchId, rowIds)
	if err != nil || persisted == nil {
		return nil, ErrPaymentAccountPersistenceUnavailable
	}

	ledgerAccountId := persisted.LedgerAccountId
	return &PaymentAccountGroup{
		SourceType: batch.SourceTypeSnapshot, Currency: sample.Currency, DisplayName: persisted.MaskedDisplayName,
		RowCount: rowCount, PendingRowCount: pendingCount, SampleRowId: sample.RowId,
		LedgerAccountId: &ledgerAccountId, Mapped: true,
	}, nil
}

func (s *PaymentAccountService) loadBatchPaymentAccounts(c core.Context, uid int64, batchId int64) (*ImportBatch, []*RawImportRow, []*PaymentAccountMapping, []*PaymentAccountExclusion, error) {
	batch, err := s.repository.FindImportBatchById(c, uid, batchId)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	if batch == nil || batch.Uid != uid || batch.BatchId != batchId {
		return nil, nil, nil, nil, ErrPaymentAccountBatchNotFound
	}
	if batch.SourceTypeSnapshot != SOURCE_TYPE_ALIPAY && batch.SourceTypeSnapshot != SOURCE_TYPE_WECHAT {
		return batch, []*RawImportRow{}, []*PaymentAccountMapping{}, []*PaymentAccountExclusion{}, nil
	}

	rows, err := s.repository.ListPaymentAccountRows(c, uid, batchId)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	mappings, err := s.repository.ListPaymentAccountMappings(c, uid, batch.SourceTypeSnapshot)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	exclusions, err := s.repository.ListPaymentAccountExclusions(c, uid, batch.SourceTypeSnapshot)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return batch, rows, mappings, exclusions, nil
}

func buildPaymentAccountGroups(batch *ImportBatch, rows []*RawImportRow, mappings []*PaymentAccountMapping, exclusions []*PaymentAccountExclusion) []*PaymentAccountGroup {
	if batch == nil || (batch.SourceTypeSnapshot != SOURCE_TYPE_ALIPAY && batch.SourceTypeSnapshot != SOURCE_TYPE_WECHAT) {
		return []*PaymentAccountGroup{}
	}

	mappingByKey := make(map[string]*PaymentAccountMapping, len(mappings))
	for _, mapping := range mappings {
		if mapping != nil && mapping.Uid == batch.Uid && mapping.SourceType == batch.SourceTypeSnapshot &&
			mapping.AliasKeyVersion == PAYMENT_ACCOUNT_ALIAS_VERSION_V1 && isLowerHexSHA256(mapping.AliasKey) &&
			isValidPaymentAccountCurrency(mapping.Currency) && mapping.LedgerAccountId > 0 {
			mappingByKey[mapping.Currency+"\x00"+mapping.AliasKey] = mapping
		}
	}
	exclusionByKey := make(map[string]*PaymentAccountExclusion, len(exclusions))
	for _, exclusion := range exclusions {
		if exclusion != nil && exclusion.Uid == batch.Uid && exclusion.SourceType == batch.SourceTypeSnapshot &&
			exclusion.AliasKeyVersion == PAYMENT_ACCOUNT_ALIAS_VERSION_V1 && isLowerHexSHA256(exclusion.AliasKey) &&
			isValidPaymentAccountCurrency(exclusion.Currency) {
			exclusionByKey[exclusion.Currency+"\x00"+exclusion.AliasKey] = exclusion
		}
	}

	type groupEntry struct {
		group    *PaymentAccountGroup
		firstRow int64
	}
	groups := make(map[string]*groupEntry)
	for _, row := range rows {
		if row == nil || row.Uid != batch.Uid || row.BatchId != batch.BatchId || row.ParseState != PARSE_STATE_VALID || !isValidPaymentAccountCurrency(row.Currency) {
			continue
		}
		alias, ok := BuildPaymentAccountAlias(row.RawPaymentMethod)
		if !ok {
			continue
		}
		key := row.Currency + "\x00" + alias.Key
		entry := groups[key]
		if entry == nil {
			entry = &groupEntry{group: &PaymentAccountGroup{
				SourceType: batch.SourceTypeSnapshot, Currency: row.Currency, DisplayName: alias.DisplayName,
				SampleRowId: row.RowId,
			}, firstRow: row.RowNumber}
			if mapping := mappingByKey[key]; mapping != nil {
				ledgerAccountId := mapping.LedgerAccountId
				entry.group.LedgerAccountId = &ledgerAccountId
				entry.group.Mapped = true
				entry.group.DisplayName = mapping.MaskedDisplayName
			}
			if exclusion := exclusionByKey[key]; exclusion != nil {
				entry.group.Excluded = true
				entry.group.DisplayName = exclusion.MaskedDisplayName
			}
			groups[key] = entry
		}
		entry.group.RowCount++
		if row.ProcessingState == PROCESSING_STATE_PENDING {
			entry.group.PendingRowCount++
		}
		if isUserSkippedPaymentAccountRow(row) {
			entry.group.SkippedRowCount++
		}
	}

	entries := make([]*groupEntry, 0, len(groups))
	for _, entry := range groups {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].firstRow == entries[j].firstRow {
			return entries[i].group.DisplayName < entries[j].group.DisplayName
		}
		return entries[i].firstRow < entries[j].firstRow
	})
	result := make([]*PaymentAccountGroup, len(entries))
	for index, entry := range entries {
		result[index] = entry.group
	}
	return result
}

func isValidPaymentAccountCurrency(currency string) bool {
	if len(currency) != 3 {
		return false
	}
	for _, char := range currency {
		if char < 'A' || char > 'Z' {
			return false
		}
	}
	return true
}
