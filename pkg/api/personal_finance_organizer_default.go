package api

import (
	"errors"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/organizer"
	"github.com/mayswind/ezbookkeeping/pkg/services"
	"github.com/mayswind/ezbookkeeping/pkg/uuid"
)

type personalFinanceOrganizerApplication struct {
	repository *organizer.Repository
	evidence   *importing.Repository
	create     *organizer.CreateEngine
	organize   *organizer.Engine
	posting    *organizer.PostingEngine
	correction *organizer.CorrectionEngine
	undo       *organizer.UndoEngine
	rebuild    *organizer.RebuildEngine
}

func InitializePersonalFinanceOrganizerApi() error {
	store := datastore.Container.UserDataStore
	repository, err := organizer.NewRepository(store)
	if err != nil {
		return err
	}
	evidence, err := importing.NewRepository(store)
	if err != nil {
		return err
	}
	create, err := organizer.NewCreateEngine(repository, evidence, uuid.Container)
	if err != nil {
		return err
	}
	engine, err := organizer.NewEngine(repository, evidence, services.Accounts, uuid.Container)
	if err != nil {
		return err
	}
	posting, err := organizer.NewPostingEngine(repository, services.Transactions, uuid.Container)
	if err != nil {
		return err
	}
	correction, err := organizer.NewCorrectionEngine(repository, uuid.Container)
	if err != nil {
		return err
	}
	undo, err := organizer.NewUndoEngine(repository, services.Transactions, uuid.Container)
	if err != nil {
		return err
	}
	rebuild, err := organizer.NewRebuildEngine(repository, services.Transactions, uuid.Container)
	if err != nil {
		return err
	}
	application := &personalFinanceOrganizerApplication{
		repository: repository, evidence: evidence, create: create, organize: engine,
		posting: posting, correction: correction, undo: undo, rebuild: rebuild,
	}
	PersonalFinanceOrganizer, err = NewPersonalFinanceOrganizerApi(application)
	return err
}

func (a *personalFinanceOrganizerApplication) CreateUpdate(c core.Context, uid int64, batchIds []int64, idempotencyKey string) (*organizerUpdateDetail, error) {
	result, err := a.create.Create(c, organizer.CreateUpdateRequest{Uid: uid, BatchIds: batchIds, IdempotencyKey: idempotencyKey})
	if err != nil {
		return nil, err
	}
	return &organizerUpdateDetail{Update: result.Update, Sources: result.Sources}, nil
}

func (a *personalFinanceOrganizerApplication) ListUpdates(c core.Context, uid int64, status organizer.UpdateStatus, cursor *organizer.UpdateCursor, limit int) (*organizer.UpdatePage, error) {
	return a.repository.ListUpdates(c, uid, status, cursor, limit)
}

func (a *personalFinanceOrganizerApplication) GetUpdate(c core.Context, uid int64, updateId int64) (*organizerUpdateDetail, error) {
	update, err := a.repository.FindUpdateById(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	if update == nil {
		return nil, organizer.ErrOrganizeUpdateNotFound
	}
	sources, err := a.repository.ListSources(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	return &organizerUpdateDetail{Update: update, Sources: sources}, nil
}

func (a *personalFinanceOrganizerApplication) Organize(c core.Context, request organizer.OrganizeRequest) (*organizer.OrganizeResult, error) {
	return a.organize.Organize(c, request)
}

func (a *personalFinanceOrganizerApplication) ListEvents(c core.Context, uid int64, updateId int64, status organizer.EventStatus, cursor *organizer.EventCursor, limit int) (*organizerEventPage, error) {
	update, err := a.repository.FindUpdateById(c, uid, updateId)
	if err != nil {
		return nil, err
	}
	if update == nil {
		return nil, organizer.ErrOrganizeUpdateNotFound
	}
	page, err := a.repository.ListEventsPage(c, uid, updateId, status, cursor, limit)
	if err != nil {
		return nil, err
	}
	result := &organizerEventPage{Items: make([]*organizerEventListItem, 0, len(page.Items)), NextCursor: page.NextCursor}
	if len(page.Items) < 1 {
		return result, nil
	}
	eventIds := make([]int64, 0, len(page.Items))
	for _, event := range page.Items {
		if event != nil {
			eventIds = append(eventIds, event.EventId)
		}
	}
	if len(eventIds) < 1 {
		return result, nil
	}
	evidence, err := a.repository.ListEvidenceForEvents(c, uid, eventIds)
	if err != nil {
		return nil, err
	}
	rowIds := make([]int64, 0, len(evidence))
	for _, link := range evidence {
		if link != nil {
			rowIds = append(rowIds, link.RowId)
		}
	}
	rows := make([]*importing.RawImportRow, 0)
	if len(rowIds) > 0 {
		rows, err = a.evidence.FindRawImportRowsByIds(c, uid, rowIds)
		if err != nil {
			return nil, err
		}
	}
	rowsById := make(map[int64]*importing.RawImportRow, len(rows))
	for _, row := range rows {
		if row != nil {
			rowsById[row.RowId] = row
		}
	}
	summaries := make(map[int64]*organizerEventSummary, len(page.Items))
	selectedRoles := make(map[int64]organizer.EvidenceRole, len(page.Items))
	for _, link := range evidence {
		if link == nil {
			continue
		}
		summary := summaries[link.EventId]
		if summary == nil {
			summary = &organizerEventSummary{}
			summaries[link.EventId] = summary
		}
		summary.EvidenceCount++
		row := rowsById[link.RowId]
		selectedRole, selected := selectedRoles[link.EventId]
		if row == nil || (selected && (selectedRole == organizer.EVIDENCE_ROLE_PRIMARY || link.EvidenceRole != organizer.EVIDENCE_ROLE_PRIMARY)) {
			continue
		}
		selectedRoles[link.EventId] = link.EvidenceRole
		summary.Counterparty = row.RawCounterparty
		summary.Item = row.RawItem
		summary.PaymentMethod = row.RawPaymentMethod
		summary.Note = row.RawNote
	}
	for _, event := range page.Items {
		if event == nil {
			continue
		}
		item := &organizerEventListItem{Event: event}
		if summary := summaries[event.EventId]; summary != nil {
			item.Summary = *summary
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}

func (a *personalFinanceOrganizerApplication) GetEventEvidence(c core.Context, uid int64, eventId int64) (*organizerEventEvidenceDetail, error) {
	event, err := a.repository.FindEventById(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	if event == nil {
		return nil, organizer.ErrCorrectionEventConflict
	}
	evidence, err := a.repository.ListEvidence(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	rows := make([]*importing.RawImportRow, 0, len(evidence))
	for _, link := range evidence {
		if link == nil {
			continue
		}
		row, rowErr := a.evidence.FindRawImportRowById(c, uid, link.RowId)
		if rowErr != nil {
			return nil, rowErr
		}
		if row == nil {
			return nil, organizer.ErrCorrectionEventConflict
		}
		rows = append(rows, row)
	}
	relations, err := a.repository.ListRelations(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	links, err := a.repository.ListEventTransactions(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	return &organizerEventEvidenceDetail{Event: event, Evidence: evidence, Rows: rows, Relations: relations, Links: links}, nil
}

func (a *personalFinanceOrganizerApplication) InspectEventCorrection(c core.Context, uid int64, updateId int64, eventId int64) (*organizer.UndoImpact, error) {
	event, err := a.repository.FindEventById(c, uid, eventId)
	if err != nil {
		return nil, err
	}
	if event == nil || event.UpdateId != updateId {
		return nil, organizer.ErrCorrectionEventConflict
	}
	if event.Status != organizer.EVENT_STATUS_POSTED {
		return &organizer.UndoImpact{CanUndo: true, ReasonCodes: []string{}}, nil
	}
	return a.rebuild.Inspect(c, uid, updateId, eventId)
}

func (a *personalFinanceOrganizerApplication) CorrectEvent(c core.Context, request organizer.CorrectEventRequest) (*organizerMutationResult, error) {
	event, err := a.repository.FindEventById(c, request.Uid, request.EventId)
	if err != nil {
		return nil, err
	}
	if event == nil || event.UpdateId != request.UpdateId {
		return nil, organizer.ErrCorrectionEventConflict
	}
	if event.Status == organizer.EVENT_STATUS_POSTED {
		result, rebuildErr := a.rebuild.Rebuild(c, request)
		if rebuildErr != nil && !errors.Is(rebuildErr, organizer.ErrRebuildActionRequired) {
			return nil, rebuildErr
		}
		if result == nil {
			return nil, rebuildErr
		}
		return &organizerMutationResult{Update: result.Update, Event: result.Event, Action: result.Action, Impact: result.Impact, Replayed: result.Replayed}, rebuildErr
	}
	result, err := a.correction.Correct(c, request)
	if err != nil {
		return nil, err
	}
	return &organizerMutationResult{Update: result.Update, Event: result.Event, Action: result.Action, Replayed: result.Replayed}, nil
}

func (a *personalFinanceOrganizerApplication) Post(c core.Context, request organizer.PostRequest) (*organizer.PostResult, error) {
	return a.posting.Post(c, request)
}

func (a *personalFinanceOrganizerApplication) InspectUndo(c core.Context, uid int64, updateId int64) (*organizer.UndoImpact, error) {
	return a.undo.Inspect(c, uid, updateId)
}

func (a *personalFinanceOrganizerApplication) Undo(c core.Context, request organizer.UndoRequest) (*organizer.UndoResult, error) {
	return a.undo.Undo(c, request)
}
