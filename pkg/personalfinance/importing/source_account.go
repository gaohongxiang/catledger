package importing

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

var (
	ErrImportSourceAccountConflict = errors.New("personal finance source account conflicts with existing identity")
)

// SourceAccountRepository 是来源账户应用服务所需的最小持久层契约。
type SourceAccountRepository interface {
	FindSourceAccountById(c core.Context, uid int64, sourceAccountId int64) (*SourceAccount, error)
	FindSourceAccountByKey(c core.Context, uid int64, sourceType SourceType, sourceAccountKey string) (*SourceAccount, error)
	ListSourceAccounts(c core.Context, uid int64) ([]*SourceAccount, error)
	InsertSourceAccount(c core.Context, account *SourceAccount) error
	UpdateSourceAccountPresentation(c core.Context, uid int64, sourceAccountId int64, sourceType SourceType, maskedDisplayName string, ledgerAccountId *int64, status SourceAccountStatus, updatedUnixTime int64) (bool, error)
	LedgerAccountExists(c core.Context, uid int64, ledgerAccountId int64) (bool, error)
}

// SourceAccountSaveRequest 创建或更新一个不等同正式账本账户的来源档案。
// LedgerAccountId=0 表示不映射正式账本账户。
type SourceAccountSaveRequest struct {
	Uid             int64
	SourceAccountId int64
	SourceType      SourceType
	DisplayName     string
	LedgerAccountId int64
	Status          SourceAccountStatus
}

// SourceAccountService 管理来源账户档案及稳定 parser 证据的自动归属。
type SourceAccountService struct {
	repository SourceAccountRepository
	generateId func() int64
	now        func() time.Time
	randomHex  func(int) (string, error)
}

// NewSourceAccountService 创建来源账户服务。
func NewSourceAccountService(repository SourceAccountRepository, generateId func() int64) (*SourceAccountService, error) {
	if repository == nil || generateId == nil {
		return nil, ErrImportRequestInvalid
	}

	return &SourceAccountService{
		repository: repository,
		generateId: generateId,
		now:        time.Now,
		randomHex:  newRandomHex,
	}, nil
}

// FindSourceAccount 返回当前 uid 的来源档案；不存在时不暴露其他用户对象。
func (s *SourceAccountService) FindSourceAccount(c core.Context, uid int64, sourceAccountId int64) (*SourceAccount, error) {
	if uid < 1 || sourceAccountId < 1 {
		return nil, ErrImportRequestInvalid
	}

	account, err := s.repository.FindSourceAccountById(c, uid, sourceAccountId)
	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	return account, nil
}

// ListSourceAccounts 返回当前用户全部来源档案。
func (s *SourceAccountService) ListSourceAccounts(c core.Context, uid int64) ([]*SourceAccount, error) {
	if uid < 1 {
		return nil, ErrImportRequestInvalid
	}

	accounts, err := s.repository.ListSourceAccounts(c, uid)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	return accounts, nil
}

// SaveSourceAccount 创建人工档案或更新不改变来源身份的展示和映射字段。
func (s *SourceAccountService) SaveSourceAccount(c core.Context, request SourceAccountSaveRequest) (*SourceAccount, error) {
	displayName, err := safeManualSourceAccountDisplayName(request.DisplayName)

	if request.Uid < 1 || !isValidSourceType(request.SourceType) || request.SourceAccountId < 0 ||
		request.LedgerAccountId < 0 || !isValidSourceAccountStatus(request.Status) || err != nil {
		return nil, ErrImportRequestInvalid
	}

	ledgerAccountId, err := s.validateLedgerAccount(c, request.Uid, request.LedgerAccountId)

	if err != nil {
		return nil, err
	}
	if request.SourceType == SOURCE_TYPE_BANK && ledgerAccountId == nil {
		return nil, ErrImportRequestInvalid
	}

	now := s.now().Unix()

	if now < 1 {
		return nil, ErrImportIdentifierUnavailable
	}

	if request.SourceAccountId > 0 {
		current, findErr := s.repository.FindSourceAccountById(c, request.Uid, request.SourceAccountId)

		if findErr != nil {
			return nil, ErrImportPersistenceUnavailable
		}

		if current == nil {
			return nil, ErrImportSourceAccountNotFound
		}

		if current.SourceType != request.SourceType || current.SourceAccountKeyVersion != SOURCE_ACCOUNT_KEY_VERSION_V1 ||
			!isLowerHexSHA256(current.SourceAccountKey) {
			return nil, ErrImportSourceAccountConflict
		}

		if current.MaskedDisplayName == displayName && current.Status == request.Status &&
			equalOptionalInt64(current.LedgerAccountId, ledgerAccountId) {
			return current, nil
		}

		updated, updateErr := s.repository.UpdateSourceAccountPresentation(
			c,
			request.Uid,
			request.SourceAccountId,
			request.SourceType,
			displayName,
			ledgerAccountId,
			request.Status,
			now,
		)

		if updateErr != nil {
			return nil, ErrImportPersistenceUnavailable
		}

		if !updated {
			return nil, ErrImportSourceAccountConflict
		}

		current.MaskedDisplayName = displayName
		current.LedgerAccountId = cloneInt64Pointer(ledgerAccountId)
		current.Status = request.Status
		current.UpdatedUnixTime = now
		return current, nil
	}

	accountId := s.generateId()
	randomMaterial, randomErr := s.randomHex(32)

	if accountId < 1 || randomErr != nil {
		return nil, ErrImportIdentifierUnavailable
	}

	keyDigest := sha256.Sum256(encodeLengthPrefixed(
		string(SOURCE_ACCOUNT_KEY_VERSION_V1),
		string(request.SourceType),
		"user-selected",
		randomMaterial,
	))
	account := &SourceAccount{
		Uid:                     request.Uid,
		SourceType:              request.SourceType,
		SourceAccountKey:        hex.EncodeToString(keyDigest[:]),
		SourceAccountKeyVersion: SOURCE_ACCOUNT_KEY_VERSION_V1,
		LedgerAccountId:         ledgerAccountId,
		Status:                  request.Status,
		MaskedDisplayName:       displayName,
		DiscoveryMethod:         SOURCE_ACCOUNT_DISCOVERY_USER_SELECTED,
		CreatedUnixTime:         now,
		UpdatedUnixTime:         now,
		SourceAccountId:         accountId,
	}

	if err = s.repository.InsertSourceAccount(c, account); err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	return account, nil
}

// ResolveStableSourceAccount 查找或创建 parser 给出的稳定完整账户证据。
func (s *SourceAccountService) ResolveStableSourceAccount(c core.Context, uid int64, sourceType SourceType, candidate SourceAccountCandidate) (*SourceAccount, error) {
	if uid < 1 || candidate.Kind != SOURCE_ACCOUNT_EVIDENCE_STABLE_IDENTIFIER {
		return nil, ErrImportRequestInvalid
	}

	key, err := ComputeSourceAccountKey(sourceType, candidate)

	if err != nil {
		return nil, ErrImportRequestInvalid
	}

	existing, err := s.repository.FindSourceAccountByKey(c, uid, sourceType, key)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if existing != nil {
		if existing.Status != SOURCE_ACCOUNT_STATUS_ACTIVE || existing.SourceAccountKeyVersion != SOURCE_ACCOUNT_KEY_VERSION_V1 {
			return nil, ErrImportSourceAccountUnavailable
		}

		return existing, nil
	}

	displayName, err := SafeSourceAccountDisplayName(sourceType, candidate)
	accountId := s.generateId()
	now := s.now().Unix()

	if err != nil {
		return nil, ErrImportRequestInvalid
	}

	if accountId < 1 || now < 1 {
		return nil, ErrImportIdentifierUnavailable
	}

	account := &SourceAccount{
		Uid:                     uid,
		SourceType:              sourceType,
		SourceAccountKey:        key,
		SourceAccountKeyVersion: SOURCE_ACCOUNT_KEY_VERSION_V1,
		Status:                  SOURCE_ACCOUNT_STATUS_ACTIVE,
		MaskedDisplayName:       displayName,
		DiscoveryMethod:         candidate.DiscoveryMethod,
		CreatedUnixTime:         now,
		UpdatedUnixTime:         now,
		SourceAccountId:         accountId,
	}

	if err = s.repository.InsertSourceAccount(c, account); err == nil {
		return account, nil
	}

	// uid+source key 唯一约束裁决并发创建；只读取相同 uid/key 的赢家。
	existing, findErr := s.repository.FindSourceAccountByKey(c, uid, sourceType, key)

	if findErr != nil || existing == nil || existing.Status != SOURCE_ACCOUNT_STATUS_ACTIVE ||
		existing.SourceAccountKeyVersion != SOURCE_ACCOUNT_KEY_VERSION_V1 {
		return nil, ErrImportPersistenceUnavailable
	}

	return existing, nil
}

func (s *SourceAccountService) validateLedgerAccount(c core.Context, uid int64, ledgerAccountId int64) (*int64, error) {
	if ledgerAccountId == 0 {
		return nil, nil
	}

	exists, err := s.repository.LedgerAccountExists(c, uid, ledgerAccountId)

	if err != nil {
		return nil, ErrImportPersistenceUnavailable
	}

	if !exists {
		return nil, ErrImportRequestInvalid
	}

	return &ledgerAccountId, nil
}

func safeManualSourceAccountDisplayName(value string) (string, error) {
	value = strings.TrimSpace(norm.NFKC.String(value))

	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > 128 {
		return "", ErrImportRequestInvalid
	}

	for _, char := range value {
		if unicode.IsControl(char) {
			return "", ErrImportRequestInvalid
		}
	}

	if isPlausibleFullAccountIdentifier(value) {
		return maskSourceAccountDisplay(value), nil
	}

	return value, nil
}

func isValidSourceAccountStatus(status SourceAccountStatus) bool {
	return status == SOURCE_ACCOUNT_STATUS_ACTIVE || status == SOURCE_ACCOUNT_STATUS_DISABLED
}

func equalOptionalInt64(left *int64, right *int64) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}
