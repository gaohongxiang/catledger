package api

import (
	"errors"
	"time"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/billflow"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/installments"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
	"github.com/mayswind/ezbookkeeping/pkg/services"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

var PersonalFinanceBillflow *PersonalFinanceBillflowApi

func InitializePersonalFinanceBillflowApi() error {
	if PersonalFinanceInstallments == nil {
		return errors.New("personal finance installments must be initialized before billflow")
	}
	store := datastore.Container.UserDataStore
	generateId := func() int64 {
		return uuid.Container.GenerateUuid(uuid.UUID_TYPE_PERSONAL_FINANCE)
	}
	repository, err := billflow.NewRepository(store)
	if err != nil {
		return err
	}
	evidence, err := importing.NewRepository(store)
	if err != nil {
		return err
	}
	payments, err := importing.NewPaymentAccountService(evidence, generateId)
	if err != nil {
		return err
	}
	poster, err := importing.NewPostingService(evidence, services.PersonalFinancePostingAuthorization, services.Transactions, generateId)
	if err != nil {
		return err
	}
	candidates, err := reconciliation.NewCandidateService(store, uuid.Container)
	if err != nil {
		return err
	}
	cases, err := reconciliation.NewCaseService(store)
	if err != nil {
		return err
	}
	decisions, err := reconciliation.NewDecisionService(store, services.PersonalFinancePostingAuthorization, services.Transactions, generateId)
	if err != nil {
		return err
	}
	installmentRepository, err := installments.NewRepository(store)
	if err != nil {
		return err
	}
	if PersonalFinanceLoans == nil || PersonalFinanceLoans.settlements == nil {
		return errors.New("personal finance loans must be initialized before billflow")
	}
	contracts, ok := PersonalFinanceLoans.settlements.(installments.ContractGateway)
	if !ok {
		return errors.New("personal finance loan service does not support installment contract commands")
	}
	authorizer, err := services.NewPersonalFinanceLoanSettlementAuthorizer(services.Users, services.Accounts)
	if err != nil {
		return err
	}
	ledger, err := services.NewPersonalFinanceLoanLedgerAdapter(services.Transactions, authorizer)
	if err != nil {
		return err
	}
	installmentService, err := installments.NewService(installmentRepository, evidence, contracts, ledger, generateId)
	if err != nil {
		return err
	}
	undo, err := billflow.NewStoreUndoGateway(store, services.Transactions)
	if err != nil {
		return err
	}
	service, err := billflow.NewService(
		repository, evidence, payments, poster,
		&billflowReconciler{candidates: candidates, cases: cases, decisions: decisions},
		installmentService, &billflowAccountFactory{accounts: services.Accounts},
		billflowCategoryCatalog{}, undo, generateId,
	)
	if err != nil {
		return err
	}
	PersonalFinanceBillflow, err = NewPersonalFinanceBillflowApi(service)
	return err
}

type billflowReconciler struct {
	candidates *reconciliation.CandidateService
	cases      *reconciliation.CaseService
	decisions  *reconciliation.DecisionService
}

func (r *billflowReconciler) GenerateCandidates(c core.Context, request reconciliation.GenerateCandidatesRequest) (*reconciliation.GenerateCandidatesResult, error) {
	return r.candidates.GenerateCandidates(c, request)
}
func (r *billflowReconciler) GetCase(c core.Context, uid int64, caseId int64) (*reconciliation.CaseDetail, error) {
	return r.cases.GetCase(c, uid, caseId)
}
func (r *billflowReconciler) ListCases(c core.Context, request reconciliation.ListCasesRequest) (*reconciliation.CasePage, error) {
	return r.cases.ListCases(c, request)
}
func (r *billflowReconciler) DecideCase(c core.Context, request reconciliation.DecideCaseRequest, clientTimezone *time.Location) (*reconciliation.DecisionResult, error) {
	return r.decisions.DecideCase(c, request, clientTimezone)
}

type billflowAccountFactory struct {
	accounts *services.AccountService
}

func (f *billflowAccountFactory) CreateAccount(c core.Context, uid int64, spec billflow.CreateAccountSpec) (int64, error) {
	account := &models.Account{
		Uid: uid, Name: spec.Name, Category: spec.Category, Type: models.ACCOUNT_TYPE_SINGLE_ACCOUNT,
		Icon: 1, Color: "1976D2", Currency: spec.Currency,
	}
	if spec.Category == models.ACCOUNT_CATEGORY_CREDIT_CARD && spec.CreditCardStatementDate >= 1 && spec.CreditCardStatementDate <= 28 {
		statementDate := spec.CreditCardStatementDate
		account.Extend = &models.AccountExtend{CreditCardStatementDate: &statementDate}
	}
	if err := f.accounts.CreateAccounts(c, account, 0, nil, nil, time.UTC); err != nil {
		return 0, err
	}
	return account.AccountId, nil
}

func (f *billflowAccountFactory) LoadAccount(c core.Context, uid int64, accountId int64) (*billflow.AccountSnapshot, error) {
	account, err := f.accounts.GetAccountByAccountId(c, uid, accountId)
	if err != nil {
		if errors.Is(err, errs.ErrAccountNotFound) {
			return nil, nil
		}
		return nil, err
	}
	if account == nil {
		return nil, nil
	}
	return &billflow.AccountSnapshot{
		AccountId: account.AccountId, Currency: account.Currency, Hidden: account.Hidden,
		Deleted: account.Deleted, Category: account.Category,
	}, nil
}

type billflowCategoryCatalog struct{}

func (billflowCategoryCatalog) ListVisibleLeafCategories(c core.Context, uid int64) ([]billflow.CategoryLeaf, error) {
	categories, err := services.TransactionCategories.GetAllCategoriesByUid(c, uid, 0, -1)
	if err != nil {
		return nil, err
	}
	parentIDs := map[int64]struct{}{}
	for _, category := range categories {
		if category != nil && category.ParentCategoryId > 0 {
			parentIDs[category.ParentCategoryId] = struct{}{}
		}
	}
	leaves := make([]billflow.CategoryLeaf, 0)
	for _, category := range categories {
		if category == nil || category.Hidden {
			continue
		}
		_, isParent := parentIDs[category.CategoryId]
		if category.ParentCategoryId > 0 || !isParent {
			leaves = append(leaves, billflow.CategoryLeaf{CategoryId: category.CategoryId, Name: category.Name})
		}
	}
	return leaves, nil
}
