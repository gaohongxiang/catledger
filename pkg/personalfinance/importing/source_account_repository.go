package importing

import (
	"fmt"
	"unicode/utf8"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/models"
)

// ListSourceAccounts 按最近更新时间稳定返回当前用户的来源账户档案。
func (r *Repository) ListSourceAccounts(c core.Context, uid int64) ([]*SourceAccount, error) {
	if uid < 1 {
		return nil, fmt.Errorf("invalid source account owner")
	}

	database, _ := r.database(uid)
	accounts := make([]*SourceAccount, 0)
	sess := database.NewPrivacySession(c)
	defer sess.Close()

	if err := sess.Where("uid=?", uid).Desc("updated_unix_time", "source_account_id").Find(&accounts); err != nil {
		return nil, fmt.Errorf("list personal finance source accounts: %w", err)
	}

	return accounts, nil
}

// InsertSourceAccount 创建来源账户档案。
func (r *Repository) InsertSourceAccount(c core.Context, account *SourceAccount) error {
	if !isValidNewSourceAccount(account) {
		return fmt.Errorf("invalid personal finance source account")
	}

	database, _ := r.database(account.Uid)
	sess := database.NewPrivacySession(c)
	inserted, err := sess.Insert(account)
	sess.Close()

	if err != nil {
		return fmt.Errorf("insert personal finance source account: %w", err)
	}

	if inserted != 1 {
		return fmt.Errorf("personal finance source account was not inserted")
	}

	return nil
}

// UpdateSourceAccountPresentation 只更新不会改变历史来源身份的字段。
func (r *Repository) UpdateSourceAccountPresentation(c core.Context, uid int64, sourceAccountId int64, sourceType SourceType, maskedDisplayName string, ledgerAccountId *int64, status SourceAccountStatus, updatedUnixTime int64) (bool, error) {
	if uid < 1 || sourceAccountId < 1 || !isValidSourceType(sourceType) || !isValidSourceAccountStatus(status) ||
		maskedDisplayName == "" || !utf8.ValidString(maskedDisplayName) || utf8.RuneCountInString(maskedDisplayName) > 128 ||
		(ledgerAccountId != nil && *ledgerAccountId < 1) || updatedUnixTime < 1 {
		return false, fmt.Errorf("invalid personal finance source account presentation")
	}

	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	updated, err := sess.Where("uid=? AND source_account_id=? AND source_type=?", uid, sourceAccountId, sourceType).
		Cols("ledger_account_id", "status", "masked_display_name", "updated_unix_time").
		Update(&SourceAccount{
			LedgerAccountId:   ledgerAccountId,
			Status:            status,
			MaskedDisplayName: maskedDisplayName,
			UpdatedUnixTime:   updatedUnixTime,
		})
	sess.Close()

	if err != nil {
		return false, fmt.Errorf("update personal finance source account presentation: %w", err)
	}

	return updated == 1, nil
}

// LedgerAccountExists 校验映射目标是当前 uid 的未删除正式账本账户。
func (r *Repository) LedgerAccountExists(c core.Context, uid int64, ledgerAccountId int64) (bool, error) {
	if uid < 1 || ledgerAccountId < 1 {
		return false, fmt.Errorf("invalid ledger account lookup")
	}

	database, _ := r.database(uid)
	sess := database.NewPrivacySession(c)
	exists, err := sess.Where("uid=? AND account_id=? AND deleted=?", uid, ledgerAccountId, false).Exist(new(models.Account))
	sess.Close()

	if err != nil {
		return false, fmt.Errorf("find mapped ledger account: %w", err)
	}

	return exists, nil
}

func isValidNewSourceAccount(account *SourceAccount) bool {
	return account != nil && account.Uid > 0 && account.SourceAccountId > 0 &&
		isValidSourceType(account.SourceType) && isLowerHexSHA256(account.SourceAccountKey) &&
		account.SourceAccountKeyVersion == SOURCE_ACCOUNT_KEY_VERSION_V1 &&
		isValidSourceAccountStatus(account.Status) && account.MaskedDisplayName != "" &&
		utf8.ValidString(account.MaskedDisplayName) && utf8.RuneCountInString(account.MaskedDisplayName) <= 128 &&
		(account.LedgerAccountId == nil || *account.LedgerAccountId > 0) &&
		(account.DiscoveryMethod == SOURCE_ACCOUNT_DISCOVERY_ALIPAY_PREAMBLE_ACCOUNT ||
			account.DiscoveryMethod == SOURCE_ACCOUNT_DISCOVERY_WECHAT_PREAMBLE_NICKNAME ||
			account.DiscoveryMethod == SOURCE_ACCOUNT_DISCOVERY_USER_SELECTED ||
			account.DiscoveryMethod == SOURCE_ACCOUNT_DISCOVERY_FILE_SCOPE) &&
		account.CreatedUnixTime > 0 && account.UpdatedUnixTime >= account.CreatedUnixTime
}
