package organizer

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/gaohongxiang/catledger/pkg/models"
	"github.com/gaohongxiang/catledger/pkg/personalfinance/importing"
)

func TestCategoryIndexReusesMatureSourceAndLocalizedFallbacks(t *testing.T) {
	food := &models.TransactionCategory{CategoryId: 11, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "Food"}
	transit := &models.TransactionCategory{CategoryId: 12, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "Public Transit"}
	index := newCategoryIndex([]*models.TransactionCategory{food, transit}, nil)

	assert.Equal(t, int64(11), index.lookup(importing.SOURCE_TYPE_ALIPAY, "餐饮美食", models.CATEGORY_TYPE_EXPENSE).categoryId)
	assert.Equal(t, int64(12), index.lookup(importing.SOURCE_TYPE_ALIPAY, "交通出行", models.CATEGORY_TYPE_EXPENSE).categoryId)
	assert.Zero(t, index.lookup(importing.SOURCE_TYPE_WECHAT, "商户消费", models.CATEGORY_TYPE_EXPENSE).categoryId)
}

func TestCategoryIndexMatchesAlipayCategoriesToChineseLedgerLeaves(t *testing.T) {
	categories := []*models.TransactionCategory{
		{CategoryId: 11, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "食品"},
		{CategoryId: 12, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "衣服"},
		{CategoryId: 13, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "家居用品"},
		{CategoryId: 14, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "电子产品"},
		{CategoryId: 15, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "私家车费用"},
		{CategoryId: 16, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "美容美发"},
		{CategoryId: 17, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "宠物花费"},
		{CategoryId: 18, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "培训课程"},
		{CategoryId: 19, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "保险支出"},
		{CategoryId: 20, Type: models.CATEGORY_TYPE_INCOME, ParentCategoryId: 2, Name: "投资收入"},
	}
	index := newCategoryIndex(categories, nil)

	tests := []struct {
		source       string
		categoryType models.TransactionCategoryType
		want         int64
	}{
		{source: "餐饮美食", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 11},
		{source: "服饰装扮", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 12},
		{source: "日用百货", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 13},
		{source: "家居家装", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 13},
		{source: "数码电器", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 14},
		{source: "爱车养车", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 15},
		{source: "美容美发", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 16},
		{source: "宠物", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 17},
		{source: "教育培训", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 18},
		{source: "保险", categoryType: models.CATEGORY_TYPE_EXPENSE, want: 19},
		{source: "投资理财", categoryType: models.CATEGORY_TYPE_INCOME, want: 20},
	}
	for _, test := range tests {
		t.Run(test.source, func(t *testing.T) {
			assert.Equal(t, test.want, index.lookup(importing.SOURCE_TYPE_ALIPAY, test.source, test.categoryType).categoryId)
		})
	}

	assert.Zero(t, index.lookup(importing.SOURCE_TYPE_ALIPAY, "投资理财", models.CATEGORY_TYPE_EXPENSE).categoryId)
	assert.Zero(t, index.lookup(importing.SOURCE_TYPE_ALIPAY, "商业服务", models.CATEGORY_TYPE_EXPENSE).categoryId)
	group := &planningGroup{rows: []*planningRow{{
		source: &PlanningSource{Source: &FinanceUpdateSource{SourceTypeSnapshot: string(importing.SOURCE_TYPE_ALIPAY)}},
		row:    &importing.RawImportRow{RawTransactionType: "服饰装扮"},
	}}}
	assert.Equal(t, int64(12), index.mapped(group, ECONOMIC_NATURE_EXPENSE).categoryId)
}

func TestCategoryIndexPrefersConfirmedAliasAndRejectsTypeMismatch(t *testing.T) {
	categories := []*models.TransactionCategory{
		{CategoryId: 21, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "Food"},
		{CategoryId: 31, Type: models.CATEGORY_TYPE_INCOME, ParentCategoryId: 2, Name: "Salary"},
	}
	aliases := []*CategoryAliasMapping{{
		SourceType: importing.SOURCE_TYPE_WECHAT, AliasKey: categoryAliasKey("美团平台商户"),
		AliasKeyVersion: CATEGORY_ALIAS_VERSION_V1, LedgerCategoryId: 21,
	}}
	index := newCategoryIndex(categories, aliases)

	assert.Equal(t, int64(21), index.lookup(importing.SOURCE_TYPE_WECHAT, "美团平台商户", models.CATEGORY_TYPE_EXPENSE).categoryId)
	assert.Zero(t, index.lookup(importing.SOURCE_TYPE_WECHAT, "美团平台商户", models.CATEGORY_TYPE_INCOME).categoryId)
}

func TestCategoryIndexDoesNotGuessWhenEvidenceRulesConflict(t *testing.T) {
	index := newCategoryIndex([]*models.TransactionCategory{
		{CategoryId: 41, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "Food"},
		{CategoryId: 42, Type: models.CATEGORY_TYPE_EXPENSE, ParentCategoryId: 1, Name: "Clothing"},
	}, []*CategoryAliasMapping{
		{SourceType: importing.SOURCE_TYPE_WECHAT, AliasKey: categoryAliasKey("商户甲"), AliasKeyVersion: CATEGORY_ALIAS_VERSION_V1, LedgerCategoryId: 41},
		{SourceType: importing.SOURCE_TYPE_ALIPAY, AliasKey: categoryAliasKey("商户乙"), AliasKeyVersion: CATEGORY_ALIAS_VERSION_V1, LedgerCategoryId: 42},
	})
	group := &planningGroup{rows: []*planningRow{
		{source: &PlanningSource{Source: &FinanceUpdateSource{SourceTypeSnapshot: string(importing.SOURCE_TYPE_WECHAT)}}, row: &importing.RawImportRow{RawCounterparty: "商户甲"}},
		{source: &PlanningSource{Source: &FinanceUpdateSource{SourceTypeSnapshot: string(importing.SOURCE_TYPE_ALIPAY)}}, row: &importing.RawImportRow{RawCounterparty: "商户乙"}},
	}}

	assert.Zero(t, index.mapped(group, ECONOMIC_NATURE_EXPENSE).categoryId)
}
