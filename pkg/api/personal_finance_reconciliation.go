package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/reconciliation"
)

const personalFinanceCandidateGenerateOperation = "generate_candidates"

type personalFinanceCandidateApplication interface {
	GenerateCandidates(c core.Context, request reconciliation.GenerateCandidatesRequest) (*reconciliation.GenerateCandidatesResult, error)
}

type personalFinanceCandidateGenerateRequest struct {
	BatchId int64 `json:"batchId,string"`
}

type personalFinanceCandidateReasonResponse struct {
	Code  string `json:"code"`
	Value int64  `json:"value"`
}

type personalFinanceCandidateCaseResponse struct {
	Id                    int64                                     `json:"id,string"`
	Status                reconciliation.CaseStatus                 `json:"status"`
	Version               int64                                     `json:"version"`
	SuggestedRelationType reconciliation.DecisionType               `json:"suggestedRelationType"`
	CandidateScore        int64                                     `json:"candidateScore"`
	ReasonCodes           []*personalFinanceCandidateReasonResponse `json:"reasonCodes"`
	CreatedUnixTime       int64                                     `json:"createdUnixTime"`
	LastEvaluatedUnixTime int64                                     `json:"lastEvaluatedUnixTime"`
	UpdatedUnixTime       int64                                     `json:"updatedUnixTime"`
}

type personalFinanceCandidateGenerateResponse struct {
	Cases                []*personalFinanceCandidateCaseResponse `json:"cases"`
	EvaluatedAnchorCount int64                                   `json:"evaluatedAnchorCount"`
	LimitReached         bool                                    `json:"limitReached"`
}

var personalFinanceCandidateReasonCodes = map[string]struct{}{
	"amount_currency_exact": {},
	"identifier_match":      {},
	"ledger_account_match":  {},
	"opposite_direction":    {},
	"payment_method_match":  {},
	"refund_signal":         {},
	"same_direction":        {},
	"text_similarity":       {},
	"time_distance_seconds": {},
	"time_proximity":        {},
	"transfer_signal":       {},
}

// ReconciliationCandidateGenerateHandler 只接收锚点批次；扫描窗口和数量限制由候选服务固定。
func (a *PersonalFinanceImportsApi) ReconciliationCandidateGenerateHandler(c *core.WebContext) (any, *errs.Error) {
	if writeErr := a.ensurePersonalFinanceImportWriteAllowed(c); writeErr != nil {
		return nil, writeErr
	}

	request := new(personalFinanceCandidateGenerateRequest)
	if err := decodePersonalFinanceCandidateGenerateRequest(c, request); err != nil {
		return nil, errs.NewIncompleteOrIncorrectSubmissionError(err)
	}

	uid := c.GetCurrentUid()
	if a.candidateServiceFactory == nil {
		log.Errorf(c, "[personal_finance_reconciliation.%s] candidate service is unavailable for user \"uid:%d\" and batch \"id:%d\"", personalFinanceCandidateGenerateOperation, uid, request.BatchId)
		return nil, errs.ErrOperationFailed
	}

	service, err := a.candidateServiceFactory()
	if err != nil || service == nil {
		log.Errorf(c, "[personal_finance_reconciliation.%s] candidate service is unavailable for user \"uid:%d\" and batch \"id:%d\"", personalFinanceCandidateGenerateOperation, uid, request.BatchId)
		return nil, errs.ErrOperationFailed
	}

	result, err := service.GenerateCandidates(c, reconciliation.GenerateCandidatesRequest{
		Uid:     uid,
		BatchId: request.BatchId,
	})
	if err != nil {
		log.Warnf(c, "[personal_finance_reconciliation.%s] candidate generation failed for user \"uid:%d\" and batch \"id:%d\"", personalFinanceCandidateGenerateOperation, uid, request.BatchId)
		return nil, errs.ErrOperationFailed
	}

	response, err := newPersonalFinanceCandidateGenerateResponse(result)
	if err != nil {
		log.Errorf(c, "[personal_finance_reconciliation.%s] candidate result validation failed for user \"uid:%d\" and batch \"id:%d\"", personalFinanceCandidateGenerateOperation, uid, request.BatchId)
		return nil, errs.ErrOperationFailed
	}

	return response, nil
}

func decodePersonalFinanceCandidateGenerateRequest(c *core.WebContext, request *personalFinanceCandidateGenerateRequest) error {
	if c == nil || c.Request == nil || c.Request.Body == nil || request == nil {
		return errors.New("candidate generate request is required")
	}

	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(request); err != nil {
		return err
	}
	if request.BatchId < 1 {
		return errors.New("candidate generate batch id must be positive")
	}

	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("candidate generate request contains multiple JSON values")
		}
		return err
	}

	return nil
}

func newPersonalFinanceCandidateGenerateResponse(result *reconciliation.GenerateCandidatesResult) (*personalFinanceCandidateGenerateResponse, error) {
	if result == nil || result.EvaluatedAnchorCount < 0 {
		return nil, errors.New("invalid candidate generation result")
	}

	cases := make([]*personalFinanceCandidateCaseResponse, 0, len(result.Cases))
	for _, candidate := range result.Cases {
		if candidate == nil || candidate.CaseId < 1 || candidate.Version < 1 || candidate.CreatedUnixTime < 1 ||
			candidate.LastEvaluatedUnixTime < 1 || candidate.UpdatedUnixTime < 1 {
			return nil, errors.New("invalid candidate case result")
		}

		reasons, err := decodePersonalFinanceCandidateReasons(candidate.ReasonCodesJson)
		if err != nil {
			return nil, fmt.Errorf("invalid candidate reasons: %w", err)
		}

		cases = append(cases, &personalFinanceCandidateCaseResponse{
			Id:                    candidate.CaseId,
			Status:                candidate.Status,
			Version:               candidate.Version,
			SuggestedRelationType: candidate.SuggestedRelationType,
			CandidateScore:        candidate.CandidateScore,
			ReasonCodes:           reasons,
			CreatedUnixTime:       candidate.CreatedUnixTime,
			LastEvaluatedUnixTime: candidate.LastEvaluatedUnixTime,
			UpdatedUnixTime:       candidate.UpdatedUnixTime,
		})
	}

	return &personalFinanceCandidateGenerateResponse{
		Cases:                cases,
		EvaluatedAnchorCount: result.EvaluatedAnchorCount,
		LimitReached:         result.LimitReached,
	}, nil
}

func decodePersonalFinanceCandidateReasons(encoded string) ([]*personalFinanceCandidateReasonResponse, error) {
	decoder := json.NewDecoder(strings.NewReader(encoded))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('[') {
		return nil, errors.New("candidate reasons must be a JSON array")
	}

	reasons := make([]*personalFinanceCandidateReasonResponse, 0)
	seenCodes := make(map[string]struct{})
	for decoder.More() {
		token, err = decoder.Token()
		if err != nil || token != json.Delim('{') {
			return nil, errors.New("candidate reason must be an object")
		}

		reason := new(personalFinanceCandidateReasonResponse)
		hasCode := false
		hasValue := false
		for decoder.More() {
			keyToken, keyErr := decoder.Token()
			if keyErr != nil {
				return nil, keyErr
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errors.New("candidate reason key must be a string")
			}

			switch key {
			case "code":
				if hasCode {
					return nil, errors.New("candidate reason code is duplicated")
				}
				hasCode = true
				if err := decoder.Decode(&reason.Code); err != nil {
					return nil, err
				}
			case "value":
				if hasValue {
					return nil, errors.New("candidate reason value is duplicated")
				}
				hasValue = true
				if err := decoder.Decode(&reason.Value); err != nil {
					return nil, err
				}
			default:
				return nil, errors.New("candidate reason contains an unknown field")
			}
		}

		token, err = decoder.Token()
		if err != nil || token != json.Delim('}') || !hasCode || !hasValue {
			return nil, errors.New("candidate reason is incomplete")
		}
		if _, ok := personalFinanceCandidateReasonCodes[reason.Code]; !ok {
			return nil, errors.New("candidate reason code is not stable")
		}
		if _, duplicated := seenCodes[reason.Code]; duplicated {
			return nil, errors.New("candidate reason code appears more than once")
		}

		seenCodes[reason.Code] = struct{}{}
		reasons = append(reasons, reason)
	}

	token, err = decoder.Token()
	if err != nil || token != json.Delim(']') || len(reasons) == 0 {
		return nil, errors.New("candidate reasons are incomplete")
	}

	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("candidate reasons contain trailing JSON")
	}

	return reasons, nil
}
