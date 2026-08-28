package organizer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

const CATEGORY_ALIAS_VERSION_V1 RuleVersion = "category-alias-v1"

var forbiddenCategoryNames = map[string]struct{}{
	"商户消费": {}, "扫二维码付款": {}, "充值": {}, "提现": {}, "转账": {}, "红包": {},
	"微信红包": {}, "转账退款": {}, "零钱提现": {}, "零钱充值": {}, "信用卡还款": {},
	"不计收支": {}, "二维码收款": {}, "其他": {},
}

var alipayCategoryLeafFallbacks = map[string]string{
	"餐饮美食": "Food",
	"服饰装扮": "Clothing",
	"日用百货": "Houseware",
	"家居家装": "Houseware",
	"数码电器": "Electronics",
	"交通出行": "Public Transit",
	"爱车养车": "Personal Car Expense",
	"美容美发": "Hair Cuts & Salon",
	"宠物":   "Pet Expense",
	"教育培训": "Training Courses",
	"医疗健康": "Diagnosis & Treatment",
	"保险":   "Insurance Expense",
	"投资理财": "Investment Income",
}

var localizedDefaultCategoryAliases = map[string]string{
	"食品": "Food", "衣服": "Clothing", "美容美发": "Hair Cuts & Salon",
	"家居用品": "Houseware", "电子产品": "Electronics",
	"公共交通": "Public Transit", "私家车费用": "Personal Car Expense",
	"快递费": "Express Fee", "电话费": "Telephone Bill",
	"宠物花费": "Pet Expense", "培训课程": "Training Courses",
	"检查治疗": "Diagnosis & Treatment", "保险支出": "Insurance Expense",
	"投资收入": "Investment Income",
}

type categoryMatch struct {
	categoryId int64
	sourceRef  string
}

type categoryIndex struct {
	leaves  map[models.TransactionCategoryType]map[string]int64
	aliases map[string]int64
	types   map[int64]models.TransactionCategoryType
}

func newCategoryIndex(categories []*models.TransactionCategory, aliases []*CategoryAliasMapping) *categoryIndex {
	index := &categoryIndex{
		leaves: map[models.TransactionCategoryType]map[string]int64{
			models.CATEGORY_TYPE_INCOME: {}, models.CATEGORY_TYPE_EXPENSE: {}, models.CATEGORY_TYPE_TRANSFER: {},
		},
		aliases: make(map[string]int64), types: make(map[int64]models.TransactionCategoryType),
	}
	for _, category := range categories {
		if category == nil || category.CategoryId < 1 || category.Deleted || category.Hidden || category.ParentCategoryId == models.LevelOneTransactionCategoryParentId {
			continue
		}
		if _, ok := index.leaves[category.Type]; !ok {
			continue
		}
		categoryName := canonicalCategoryName(category.Name)
		index.leaves[category.Type][categoryName] = category.CategoryId
		for localized, defaultName := range localizedDefaultCategoryAliases {
			if categoryName == canonicalCategoryName(localized) || categoryName == canonicalCategoryName(defaultName) {
				index.leaves[category.Type][canonicalCategoryName(localized)] = category.CategoryId
				index.leaves[category.Type][canonicalCategoryName(defaultName)] = category.CategoryId
			}
		}
		index.types[category.CategoryId] = category.Type
	}
	for _, alias := range aliases {
		if alias == nil || alias.AliasKeyVersion != CATEGORY_ALIAS_VERSION_V1 || !isLowerHexSHA256(alias.AliasKey) {
			continue
		}
		if _, ok := index.types[alias.LedgerCategoryId]; !ok {
			continue
		}
		index.aliases[string(alias.SourceType)+"\x00"+alias.AliasKey] = alias.LedgerCategoryId
	}
	return index
}

func canonicalCategoryName(value string) string {
	normalized := strings.TrimSpace(norm.NFKC.String(value))
	var builder strings.Builder
	for _, char := range normalized {
		if unicode.IsSpace(char) || char == '-' || char == '—' {
			continue
		}
		builder.WriteRune(unicode.ToLower(char))
	}
	return builder.String()
}

func categoryAliasKey(value string) string {
	canonical := strings.TrimSpace(norm.NFKC.String(value))
	digest := sha256.Sum256([]byte(string(CATEGORY_ALIAS_VERSION_V1) + "\x00" + canonical))
	return hex.EncodeToString(digest[:])
}

func isForbiddenCategoryName(value string) bool {
	_, forbidden := forbiddenCategoryNames[canonicalCategoryName(value)]
	return forbidden
}

func categoryAliasCandidates(row *importing.RawImportRow, sourceType importing.SourceType) []string {
	if row == nil {
		return nil
	}
	seen := make(map[string]struct{})
	result := make([]string, 0, 3)
	for _, value := range []string{sourceCategoryName(row, sourceType), strings.TrimSpace(row.RawCounterparty), strings.TrimSpace(row.RawItem)} {
		canonical := canonicalCategoryName(value)
		if canonical == "" || isForbiddenCategoryName(value) {
			continue
		}
		if _, exists := seen[canonical]; exists {
			continue
		}
		seen[canonical] = struct{}{}
		result = append(result, strings.TrimSpace(value))
	}
	return result
}

func sourceCategoryName(row *importing.RawImportRow, sourceType importing.SourceType) string {
	if row == nil || (sourceType != importing.SOURCE_TYPE_ALIPAY && sourceType != importing.SOURCE_TYPE_WECHAT) {
		return ""
	}
	return strings.TrimSpace(row.RawTransactionType)
}

func sourceCategoryLeafFallback(sourceType importing.SourceType, value string) string {
	if sourceType != importing.SOURCE_TYPE_ALIPAY {
		return ""
	}
	return alipayCategoryLeafFallbacks[canonicalCategoryName(value)]
}

func evidenceCategoryLeafFallback(sourceType importing.SourceType, row *importing.RawImportRow) string {
	if row == nil {
		return ""
	}
	text := canonicalCategoryName(row.RawCounterparty + " " + row.RawItem)
	switch sourceType {
	case importing.SOURCE_TYPE_WECHAT:
		switch {
		case strings.Contains(text, "美团"):
			return "食品"
		case strings.Contains(text, "寄件") || strings.Contains(text, "快递"):
			return "快递费"
		case strings.Contains(text, "保险") || strings.Contains(text, "保费"):
			return "保险支出"
		}
	case importing.SOURCE_TYPE_BANK:
		if strings.Contains(text, "电话") {
			return "电话费"
		}
	}
	return ""
}

func categoryTypeForNature(nature EconomicNature) models.TransactionCategoryType {
	switch nature {
	case ECONOMIC_NATURE_INCOME:
		return models.CATEGORY_TYPE_INCOME
	case ECONOMIC_NATURE_EXPENSE, ECONOMIC_NATURE_FEE:
		return models.CATEGORY_TYPE_EXPENSE
	default:
		return 0
	}
}

func (index *categoryIndex) lookup(sourceType importing.SourceType, value string, categoryType models.TransactionCategoryType) categoryMatch {
	if index == nil || value == "" || categoryType == 0 || isForbiddenCategoryName(value) {
		return categoryMatch{}
	}
	if id := index.aliases[string(sourceType)+"\x00"+categoryAliasKey(value)]; id > 0 && index.types[id] == categoryType {
		return categoryMatch{categoryId: id, sourceRef: "rule:" + string(CATEGORY_ALIAS_VERSION_V1)}
	}
	if id := index.leaves[categoryType][canonicalCategoryName(value)]; id > 0 {
		return categoryMatch{categoryId: id, sourceRef: "source:category"}
	}
	if fallback := sourceCategoryLeafFallback(sourceType, value); fallback != "" {
		if id := index.leaves[categoryType][canonicalCategoryName(fallback)]; id > 0 {
			return categoryMatch{categoryId: id, sourceRef: "rule:source-category-fallback-v1"}
		}
	}
	return categoryMatch{}
}

func (index *categoryIndex) mapped(group *planningGroup, nature EconomicNature) categoryMatch {
	categoryType := categoryTypeForNature(nature)
	if index == nil || group == nil || categoryType == 0 {
		return categoryMatch{}
	}
	result := categoryMatch{}
	for _, item := range group.rows {
		sourceType := importing.SourceType(item.source.Source.SourceTypeSnapshot)
		rowMatch := categoryMatch{}
		for _, candidate := range categoryAliasCandidates(item.row, sourceType) {
			if rowMatch = index.lookup(sourceType, candidate, categoryType); rowMatch.categoryId > 0 {
				break
			}
		}
		if rowMatch.categoryId == 0 {
			if fallback := evidenceCategoryLeafFallback(sourceType, item.row); fallback != "" {
				if id := index.leaves[categoryType][canonicalCategoryName(fallback)]; id > 0 {
					rowMatch = categoryMatch{categoryId: id, sourceRef: "rule:evidence-category-v1"}
				}
			}
		}
		if rowMatch.categoryId == 0 {
			continue
		}
		if result.categoryId > 0 && result.categoryId != rowMatch.categoryId {
			return categoryMatch{}
		}
		result = rowMatch
	}
	return result
}

func maskedCategoryAliasDisplay(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > 128 {
		return string(runes[:128])
	}
	return string(runes)
}

func buildCategoryAliases(c core.Context, repository *Repository, evidence EvidenceReader, ids IdentifierGenerator, uid int64,
	sources []*FinanceUpdateSource, eventIds []int64, categoryId int64, now int64) ([]*CategoryAliasMapping, error) {
	if repository == nil || evidence == nil || ids == nil || uid < 1 || categoryId < 1 || len(eventIds) < 1 || now < 1 {
		return nil, nil
	}
	items, err := listCategoryEvidenceForEvents(c, repository, uid, eventIds)
	if err != nil {
		return nil, err
	}
	wantedRows := make(map[int64]struct{}, len(items))
	for _, item := range items {
		wantedRows[item.RowId] = struct{}{}
	}
	seen := make(map[string]struct{})
	result := make([]*CategoryAliasMapping, 0)
	for _, source := range sources {
		rows, loadErr := evidence.ListRawImportRows(c, uid, source.BatchId)
		if loadErr != nil {
			return nil, loadErr
		}
		sourceType := importing.SourceType(source.SourceTypeSnapshot)
		for _, row := range rows {
			if _, ok := wantedRows[row.RowId]; !ok {
				continue
			}
			for _, name := range categoryAliasCandidates(row, sourceType) {
				key := string(sourceType) + "\x00" + categoryAliasKey(name)
				if _, exists := seen[key]; exists {
					continue
				}
				seen[key] = struct{}{}
				mappingId := ids.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
				if mappingId < 1 {
					return nil, fmt.Errorf("invalid category alias mapping id")
				}
				result = append(result, &CategoryAliasMapping{
					Uid: uid, SourceType: sourceType, AliasKey: categoryAliasKey(name), AliasKeyVersion: CATEGORY_ALIAS_VERSION_V1,
					LedgerCategoryId: categoryId, MaskedDisplayName: maskedCategoryAliasDisplay(name),
					CreatedUnixTime: now, UpdatedUnixTime: now, MappingId: mappingId,
				})
			}
		}
	}
	return result, nil
}

// categoryAliasKeysForEvents 从不可变来源证据生成批量分类比较键。
// 来源类型属于键的一部分，因此支付宝与微信中的同名商户不会跨来源套用。
func categoryAliasKeysForEvents(c core.Context, repository *Repository, evidence EvidenceReader, uid int64,
	sources []*FinanceUpdateSource, eventIds []int64) (map[int64]map[string]struct{}, error) {
	result := make(map[int64]map[string]struct{}, len(eventIds))
	if repository == nil || evidence == nil || uid < 1 || len(eventIds) < 1 {
		return result, nil
	}
	items, err := listCategoryEvidenceForEvents(c, repository, uid, eventIds)
	if err != nil {
		return nil, err
	}
	eventsByRow := make(map[int64][]int64, len(items))
	for _, item := range items {
		if item != nil {
			eventsByRow[item.RowId] = append(eventsByRow[item.RowId], item.EventId)
		}
	}
	for _, source := range sources {
		if source == nil {
			continue
		}
		rows, loadErr := evidence.ListRawImportRows(c, uid, source.BatchId)
		if loadErr != nil {
			return nil, loadErr
		}
		sourceType := importing.SourceType(source.SourceTypeSnapshot)
		for _, row := range rows {
			if row == nil {
				continue
			}
			eventIdsForRow := eventsByRow[row.RowId]
			if len(eventIdsForRow) < 1 {
				continue
			}
			for _, name := range categoryAliasCandidates(row, sourceType) {
				key := string(sourceType) + "\x00" + categoryAliasKey(name)
				for _, eventId := range eventIdsForRow {
					if result[eventId] == nil {
						result[eventId] = make(map[string]struct{})
					}
					result[eventId][key] = struct{}{}
				}
			}
		}
	}
	return result, nil
}

func listCategoryEvidenceForEvents(c core.Context, repository *Repository, uid int64, eventIds []int64) ([]*EconomicEventEvidence, error) {
	if repository == nil || uid < 1 || len(eventIds) < 1 {
		return nil, nil
	}
	result := make([]*EconomicEventEvidence, 0)
	for start := 0; start < len(eventIds); start += maximumRepositoryPageSize {
		end := start + maximumRepositoryPageSize
		if end > len(eventIds) {
			end = len(eventIds)
		}
		items, err := repository.ListEvidenceForEvents(c, uid, eventIds[start:end])
		if err != nil {
			return nil, err
		}
		result = append(result, items...)
	}
	return result, nil
}
