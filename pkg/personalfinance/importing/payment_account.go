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
var paymentAccountCardTailPattern = regexp.MustCompile(`[0-9]{4}`)
var cebLastFourOnlyDisplayPattern = regexp.MustCompile(`^末四位(\d{4})$`)

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

func legacyAlipayAccountBalanceAliasKey() string {
	digest := sha256.Sum256([]byte(string(PAYMENT_ACCOUNT_ALIAS_VERSION_V1) + "\x00账户余额"))
	return hex.EncodeToString(digest[:])
}

// ComparablePaymentAccountText 把付款方式收到与核对账户相同的组成规则后再比。
// 光大月结单原始值仍是「末四位xxxx」，比对时组成「光大银行信用卡(xxxx)」；不改身份键。
func ComparablePaymentAccountText(raw string) string {
	instrument := paymentAccountInstrumentName(raw)
	if instrument == "" {
		return ""
	}
	return canonicalPaymentAccountAlias(qualifyPaymentAccountDisplayName(SOURCE_TYPE_BANK, instrument))
}

// CreditCardAccountFamilyAlias 把信用卡还款对方和已映射卡号收敛到发卡行级别。
// 该别名只能用于唯一候选查找，不能替代带尾号的稳定付款账户身份。
func CreditCardAccountFamilyAlias(raw string) (string, bool) {
	canonical := strings.TrimSuffix(canonicalPaymentAccountAlias(paymentAccountInstrumentName(raw)), "还款")
	var builder strings.Builder
	for _, char := range canonical {
		if !unicode.IsDigit(char) {
			builder.WriteRune(char)
		}
	}
	family := builder.String()
	if !strings.Contains(family, "银行") || !strings.HasSuffix(family, "信用卡") || family == "银行信用卡" {
		return "", false
	}
	return family, true
}

// QualifiedPaymentAccountDisplayName 与核对账户同一套组成规则：光大月结单「末四位xxxx」显示为「光大银行信用卡(xxxx)」。
func QualifiedPaymentAccountDisplayName(sourceType SourceType, raw string) string {
	instrument := paymentAccountInstrumentName(raw)
	if instrument == "" {
		return ""
	}
	return qualifyPaymentAccountDisplayName(sourceType, safePaymentAccountDisplayName(instrument))
}

func qualifyPaymentAccountDisplayName(sourceType SourceType, displayName string) string {
	name := strings.TrimSpace(displayName)
	if name == "" {
		return name
	}
	// 支付宝 App 导出会在同一份账单中交替使用「余额」和「账户余额」。
	// 它们都是支付宝现金余额，不是两个资金池；统一采用官方全称显示。
	if sourceType == SOURCE_TYPE_ALIPAY && canonicalPaymentAccountAlias(name) == "余额" {
		return "支付宝账户余额"
	}
	prefix := ""
	switch sourceType {
	case SOURCE_TYPE_WECHAT:
		prefix = "微信"
	case SOURCE_TYPE_ALIPAY:
		prefix = "支付宝"
	case SOURCE_TYPE_BANK:
		if matches := cebLastFourOnlyDisplayPattern.FindStringSubmatch(name); len(matches) == 2 {
			return "光大银行信用卡(" + matches[1] + ")"
		}
		return name
	default:
		return name
	}
	if strings.HasPrefix(name, prefix) {
		return name
	}
	if !needsPaymentAccountSourcePrefix(sourceType, name) {
		return name
	}
	return prefix + name
}

func needsPaymentAccountSourcePrefix(sourceType SourceType, name string) bool {
	switch canonicalPaymentAccountAlias(name) {
	case "零钱", "零钱通":
		return sourceType == SOURCE_TYPE_WECHAT
	case "余额", "账户余额", "余额宝":
		return sourceType == SOURCE_TYPE_ALIPAY
	default:
		return false
	}
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
	return canonicalPaymentAccountAliasWithPrimaryCard(raw, true)
}

func canonicalPaymentAccountAliasWithPrimaryCard(raw string, normalizePrimaryCard bool) string {
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
	// 银行月结单可能把同一张卡写成「主卡6106」，聚合支付账单则只写
	// 「6106」。主卡只是卡片角色，不是账户身份的一部分。
	if normalizePrimaryCard {
		canonical = strings.ReplaceAll(canonical, "主卡", "")
	}
	for _, token := range []string{"微信支付", "微信", "支付宝"} {
		canonical = strings.TrimPrefix(canonical, token)
	}
	// 支付宝账单会按交易场景交替写「余额」和「账户余额」，两者指向同一现金余额。
	if canonical == "账户余额" {
		return "余额"
	}
	return canonical
}

func legacyPrimaryCardAliasKey(raw string) string {
	canonical := canonicalPaymentAccountAliasWithPrimaryCard(paymentAccountInstrumentName(raw), false)
	digest := sha256.Sum256([]byte(string(PAYMENT_ACCOUNT_ALIAS_VERSION_V1) + "\x00" + canonical))
	return hex.EncodeToString(digest[:])
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

	batch, err := s.repository.FindImportBatchById(c, request.Uid, request.BatchId)
	if err != nil {
		return nil, err
	}
	if batch == nil || batch.Uid != request.Uid || batch.BatchId != request.BatchId || !isPaymentAccountSourceType(batch.SourceTypeSnapshot) {
		return nil, ErrPaymentAccountBatchNotFound
	}
	rows, err := s.repository.ListPaymentAccountRows(c, request.Uid, request.BatchId)
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
		MaskedDisplayName: qualifyPaymentAccountDisplayName(batch.SourceTypeSnapshot, alias.DisplayName),
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

func isPaymentAccountSourceType(sourceType SourceType) bool {
	return sourceType == SOURCE_TYPE_ALIPAY || sourceType == SOURCE_TYPE_WECHAT || sourceType == SOURCE_TYPE_BANK
}

func usesPaymentAccountGroups(batch *ImportBatch) bool {
	if batch == nil {
		return false
	}
	switch batch.SourceTypeSnapshot {
	case SOURCE_TYPE_ALIPAY, SOURCE_TYPE_WECHAT:
		return true
	case SOURCE_TYPE_BANK:
		// 专用银行模板和通用 CSV/XLS/XLSX 都把可辨识卡片写入
		// RawPaymentMethod；空值自然不会形成核对组。
		return true
	default:
		return false
	}
}

func (s *PaymentAccountService) loadBatchPaymentAccounts(c core.Context, uid int64, batchId int64) (*ImportBatch, []*RawImportRow, []*PaymentAccountMapping, []*PaymentAccountExclusion, error) {
	batch, err := s.repository.FindImportBatchById(c, uid, batchId)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	if batch == nil || batch.Uid != uid || batch.BatchId != batchId {
		return nil, nil, nil, nil, ErrPaymentAccountBatchNotFound
	}
	if !usesPaymentAccountGroups(batch) {
		return batch, []*RawImportRow{}, []*PaymentAccountMapping{}, []*PaymentAccountExclusion{}, nil
	}

	rows, err := s.repository.ListPaymentAccountRows(c, uid, batchId)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	mappings := make([]*PaymentAccountMapping, 0)
	for _, sourceType := range []SourceType{SOURCE_TYPE_ALIPAY, SOURCE_TYPE_WECHAT, SOURCE_TYPE_BANK} {
		items, mappingErr := s.repository.ListPaymentAccountMappings(c, uid, sourceType)
		if mappingErr != nil {
			return nil, nil, nil, nil, mappingErr
		}
		mappings = append(mappings, items...)
	}
	exclusions, err := s.repository.ListPaymentAccountExclusions(c, uid, batch.SourceTypeSnapshot)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return batch, rows, mappings, exclusions, nil
}

func buildPaymentAccountGroups(batch *ImportBatch, rows []*RawImportRow, mappings []*PaymentAccountMapping, exclusions []*PaymentAccountExclusion) []*PaymentAccountGroup {
	if !usesPaymentAccountGroups(batch) {
		return []*PaymentAccountGroup{}
	}

	mappingByKey := ReusablePaymentAccountMappingsByKey(batch.Uid, batch.SourceTypeSnapshot, mappings)

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
				SourceType: batch.SourceTypeSnapshot, Currency: row.Currency,
				DisplayName: qualifyPaymentAccountDisplayName(batch.SourceTypeSnapshot, alias.DisplayName),
				SampleRowId: row.RowId,
			}, firstRow: row.RowNumber}
			if mapping := mappingByKey[key]; mapping != nil {
				ledgerAccountId := mapping.LedgerAccountId
				entry.group.LedgerAccountId = &ledgerAccountId
				entry.group.Mapped = true
				entry.group.DisplayName = qualifyPaymentAccountDisplayName(batch.SourceTypeSnapshot, mapping.MaskedDisplayName)
			}
			if exclusion := paymentAccountExclusionByKey(batch.Uid, batch.SourceTypeSnapshot, exclusions, row.Currency, alias.Key); exclusion != nil {
				entry.group.Excluded = true
				entry.group.DisplayName = qualifyPaymentAccountDisplayName(batch.SourceTypeSnapshot, exclusion.MaskedDisplayName)
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

// paymentAccountMappingByKey 同时兼容支付宝旧的「账户余额」别名。
// 若旧的「余额」与「账户余额」已被映射到不同正式账户，停止自动沿用，要求用户重新确认。
func paymentAccountMappingByKey(uid int64, sourceType SourceType, mappings []*PaymentAccountMapping) map[string]*PaymentAccountMapping {
	lookup := make(map[string]*PaymentAccountMapping, len(mappings))
	for _, mapping := range mappings {
		if mapping == nil || mapping.Uid != uid || mapping.SourceType != sourceType || mapping.AliasKeyVersion != PAYMENT_ACCOUNT_ALIAS_VERSION_V1 ||
			!isLowerHexSHA256(mapping.AliasKey) || !isValidPaymentAccountCurrency(mapping.Currency) || mapping.LedgerAccountId < 1 {
			continue
		}
		lookup[mapping.Currency+"\x00"+mapping.AliasKey] = mapping
	}
	// 兼容已经按旧 v1 规则保存的「主卡」映射；新解析统一写当前别名，
	// 旧映射只作为读兼容，不产生第二套运行语义。
	for _, mapping := range mappings {
		if mapping == nil || mapping.Uid != uid || mapping.SourceType != sourceType || mapping.AliasKeyVersion != PAYMENT_ACCOUNT_ALIAS_VERSION_V1 ||
			!strings.Contains(mapping.MaskedDisplayName, "主卡") || mapping.AliasKey != legacyPrimaryCardAliasKey(mapping.MaskedDisplayName) ||
			!isValidPaymentAccountCurrency(mapping.Currency) || mapping.LedgerAccountId < 1 {
			continue
		}
		currentAlias, ok := BuildPaymentAccountAlias(mapping.MaskedDisplayName)
		if !ok {
			continue
		}
		currentKey := mapping.Currency + "\x00" + currentAlias.Key
		current := lookup[currentKey]
		if current == nil {
			lookup[currentKey] = mapping
		} else if current.LedgerAccountId != mapping.LedgerAccountId {
			delete(lookup, currentKey)
		}
	}

	if sourceType != SOURCE_TYPE_ALIPAY {
		return lookup
	}

	legacyKey := legacyAlipayAccountBalanceAliasKey()
	currentAlias, ok := BuildPaymentAccountAlias("余额")
	if !ok {
		return lookup
	}
	for _, mapping := range mappings {
		if mapping == nil || mapping.Uid != uid || mapping.SourceType != sourceType || mapping.AliasKeyVersion != PAYMENT_ACCOUNT_ALIAS_VERSION_V1 ||
			mapping.AliasKey != legacyKey || !isValidPaymentAccountCurrency(mapping.Currency) || mapping.LedgerAccountId < 1 {
			continue
		}
		currentKey := mapping.Currency + "\x00" + currentAlias.Key
		current := lookup[currentKey]
		if current == nil {
			lookup[currentKey] = mapping
		} else if current.LedgerAccountId != mapping.LedgerAccountId {
			delete(lookup, currentKey)
		}
	}
	return lookup
}

// ReusablePaymentAccountMappingsByKey 优先使用当前来源已经确认的映射；当前
// 来源没有映射时，只沿用支付宝、微信和银行间唯一一致的可辨识银行卡映射。
// 同一别名指向不同正式账户时不选边，交给用户确认。
func ReusablePaymentAccountMappingsByKey(uid int64, sourceType SourceType, mappings []*PaymentAccountMapping) map[string]*PaymentAccountMapping {
	result := paymentAccountMappingByKey(uid, sourceType, mappings)
	type candidate struct {
		mapping    *PaymentAccountMapping
		conflicted bool
	}
	candidates := make(map[string]*candidate)
	for _, otherType := range []SourceType{SOURCE_TYPE_ALIPAY, SOURCE_TYPE_WECHAT, SOURCE_TYPE_BANK} {
		if otherType == sourceType {
			continue
		}
		for key, mapping := range paymentAccountMappingByKey(uid, otherType, mappings) {
			if result[key] != nil || !isCrossSourcePaymentAccountMapping(mapping) {
				continue
			}
			current := candidates[key]
			if current == nil {
				candidates[key] = &candidate{mapping: mapping}
				continue
			}
			if current.mapping.LedgerAccountId != mapping.LedgerAccountId {
				current.conflicted = true
			} else if mapping.MappingId > 0 && (current.mapping.MappingId < 1 || mapping.MappingId < current.mapping.MappingId) {
				current.mapping = mapping
			}
		}
	}
	for key, item := range candidates {
		if item != nil && !item.conflicted && item.mapping != nil {
			result[key] = item.mapping
		}
	}
	return result
}

func isCrossSourcePaymentAccountMapping(mapping *PaymentAccountMapping) bool {
	if mapping == nil || mapping.LedgerAccountId < 1 {
		return false
	}
	canonical := canonicalPaymentAccountAlias(mapping.MaskedDisplayName)
	if !strings.Contains(canonical, "银行") || !paymentAccountCardTailPattern.MatchString(canonical) {
		return false
	}
	for _, token := range []string{"信用卡", "贷记卡", "储蓄卡", "借记卡"} {
		if strings.Contains(canonical, token) {
			return true
		}
	}
	return false
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
