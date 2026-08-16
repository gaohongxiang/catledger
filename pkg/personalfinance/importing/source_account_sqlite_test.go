package importing_test

import (
	"strings"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
)

func TestSourceAccountServicePreservesIdentityAndClearsLedgerMapping(t *testing.T) {
	repository, database := newSQLiteDedupRepository(t, 1)
	candidate, sourceKey := dedupSourceAccountEvidence(t)
	ledgerAccountId := int64(801)
	account := &importing.SourceAccount{
		Uid:                     501,
		SourceType:              importing.SOURCE_TYPE_ALIPAY,
		SourceAccountKey:        sourceKey,
		SourceAccountKeyVersion: importing.SOURCE_ACCOUNT_KEY_VERSION_V1,
		LedgerAccountId:         &ledgerAccountId,
		Status:                  importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
		MaskedDisplayName:       "o***@e******.com",
		DiscoveryMethod:         candidate.DiscoveryMethod,
		CreatedUnixTime:         100,
		UpdatedUnixTime:         100,
		SourceAccountId:         601,
	}
	insertRepositoryBeans(t, database, account)

	nextId := int64(9000)
	service, err := importing.NewSourceAccountService(repository, func() int64 {
		nextId++
		return nextId
	})
	if err != nil {
		t.Fatalf("create source account service: %v", err)
	}

	updated, err := service.SaveSourceAccount(nil, importing.SourceAccountSaveRequest{
		Uid:             account.Uid,
		SourceAccountId: account.SourceAccountId,
		SourceType:      account.SourceType,
		DisplayName:     "renamed profile",
		Status:          importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("update source account: %v", err)
	}

	persisted, err := repository.FindSourceAccountById(nil, account.Uid, account.SourceAccountId)
	if err != nil {
		t.Fatalf("reload source account: %v", err)
	}

	if updated.LedgerAccountId != nil || persisted.LedgerAccountId != nil ||
		persisted.SourceAccountKey != sourceKey || persisted.SourceType != account.SourceType ||
		persisted.DiscoveryMethod != account.DiscoveryMethod || persisted.MaskedDisplayName != "renamed profile" {
		t.Fatalf("presentation update changed frozen source identity: %+v", persisted)
	}

	created, err := service.SaveSourceAccount(nil, importing.SourceAccountSaveRequest{
		Uid:         account.Uid,
		SourceType:  importing.SOURCE_TYPE_WECHAT,
		DisplayName: "13800138000",
		Status:      importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create manual source account: %v", err)
	}

	if created.SourceAccountId != 9001 || created.SourceAccountKey == sourceKey ||
		len(created.SourceAccountKey) != 64 || created.SourceAccountKey != strings.ToLower(created.SourceAccountKey) ||
		created.MaskedDisplayName != "138****8000" ||
		created.DiscoveryMethod != importing.SOURCE_ACCOUNT_DISCOVERY_USER_SELECTED {
		t.Fatalf("manual source account identity is unsafe: %+v", created)
	}

	unmappedBank, err := service.SaveSourceAccount(nil, importing.SourceAccountSaveRequest{
		Uid: account.Uid, SourceType: importing.SOURCE_TYPE_BANK, DisplayName: "bank profile", Status: importing.SOURCE_ACCOUNT_STATUS_ACTIVE,
	})
	if err != nil || unmappedBank == nil || unmappedBank.LedgerAccountId != nil || unmappedBank.SourceType != importing.SOURCE_TYPE_BANK {
		t.Fatalf("unmapped manual bank source account was rejected: %+v %v", unmappedBank, err)
	}

	firstCeb, err := service.EnsureCebCreditSourceAccount(nil, account.Uid)
	if err != nil || firstCeb == nil || firstCeb.LedgerAccountId != nil || firstCeb.MaskedDisplayName != "光大信用卡" {
		t.Fatalf("CEB identity scope was not created: %+v %v", firstCeb, err)
	}
	secondCeb, err := service.EnsureCebCreditSourceAccount(nil, account.Uid)
	if err != nil || secondCeb == nil || secondCeb.SourceAccountId != firstCeb.SourceAccountId || secondCeb.SourceAccountKey != firstCeb.SourceAccountKey {
		t.Fatalf("CEB identity scope was not reused: first=%+v second=%+v err=%v", firstCeb, secondCeb, err)
	}

	wechatCandidate := importing.SourceAccountCandidate{
		Kind:            importing.SOURCE_ACCOUNT_EVIDENCE_DISPLAY_ONLY,
		DisplayName:     "微信昵称",
		DiscoveryMethod: importing.SOURCE_ACCOUNT_DISCOVERY_WECHAT_PREAMBLE_NICKNAME,
	}
	firstWechat, err := service.ResolveDisplaySourceAccount(nil, account.Uid, importing.SOURCE_TYPE_WECHAT, wechatCandidate)
	if err != nil || firstWechat == nil || firstWechat.MaskedDisplayName != "微**称" {
		t.Fatalf("wechat original identity was not created: %+v %v", firstWechat, err)
	}
	secondWechat, err := service.ResolveDisplaySourceAccount(nil, account.Uid, importing.SOURCE_TYPE_WECHAT, wechatCandidate)
	if err != nil || secondWechat == nil || secondWechat.SourceAccountId != firstWechat.SourceAccountId {
		t.Fatalf("wechat original identity was not reused: first=%+v second=%+v err=%v", firstWechat, secondWechat, err)
	}

	fileSHA := strings.Repeat("a", 64)
	firstFile, err := service.EnsureFileSourceAccount(nil, account.Uid, importing.SOURCE_TYPE_BANK, importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV, fileSHA)
	if err != nil || firstFile == nil || firstFile.DiscoveryMethod != importing.SOURCE_ACCOUNT_DISCOVERY_FILE_SCOPE {
		t.Fatalf("file original identity was not created: %+v %v", firstFile, err)
	}
	secondFile, err := service.EnsureFileSourceAccount(nil, account.Uid, importing.SOURCE_TYPE_BANK, importing.EVIDENCE_FORMAT_BANK_GENERIC_CSV, fileSHA)
	if err != nil || secondFile == nil || secondFile.SourceAccountId != firstFile.SourceAccountId {
		t.Fatalf("file original identity was not reused: first=%+v second=%+v err=%v", firstFile, secondFile, err)
	}
}
