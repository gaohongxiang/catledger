package organizer

import (
	"fmt"

	"github.com/mayswind/ezbookkeeping/pkg/models"
)

func (tx *RepositoryTransaction) FindRelationById(relationId int64) (*EconomicEventRelation, error) {
	if err := tx.validate(); err != nil || relationId < 1 {
		return nil, fmt.Errorf("invalid economic event relation transaction lookup")
	}
	value := new(EconomicEventRelation)
	found, err := tx.session.Where("uid=? AND relation_id=?", tx.uid, relationId).Get(value)
	if err != nil {
		return nil, fmt.Errorf("find economic event relation: %w", err)
	}
	if !found {
		return nil, nil
	}
	return value, nil
}

func (tx *RepositoryTransaction) ListRefundRelationsForTarget(targetEventId int64) ([]*EconomicEventRelation, error) {
	if err := tx.validate(); err != nil || targetEventId < 1 {
		return nil, fmt.Errorf("invalid refund relation target lookup")
	}
	items := make([]*EconomicEventRelation, 0)
	if err := tx.session.Where("uid=? AND relation_type=? AND target_event_id=?", tx.uid, RELATION_TYPE_REFUND_OF, targetEventId).
		Asc("relation_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list refund relations for target: %w", err)
	}
	return items, nil
}

func (tx *RepositoryTransaction) RejectOtherProposedRefundRelations(sourceEventId int64, keptRelationId int64, now int64) error {
	if err := tx.validate(); err != nil || sourceEventId < 1 || keptRelationId < 0 || now < 1 {
		return fmt.Errorf("invalid proposed refund relation rejection")
	}
	items := make([]*EconomicEventRelation, 0)
	if err := tx.session.Where("uid=? AND relation_type=? AND source_event_id=? AND status=?", tx.uid, RELATION_TYPE_REFUND_OF, sourceEventId, RELATION_STATUS_PROPOSED).
		Asc("relation_id").Find(&items); err != nil {
		return fmt.Errorf("list proposed refund relations: %w", err)
	}
	for _, relation := range items {
		if relation.RelationId == keptRelationId {
			continue
		}
		next := *relation
		next.Status = RELATION_STATUS_REJECTED
		next.Version = relation.Version + 1
		next.Manual = true
		next.ReasonCodesJson = reasonCodesJSON([]string{"manual_refund_candidate_rejected"})
		next.UpdatedUnixTime = now
		updated, err := tx.UpdateRelationCAS(relation.Version, &next)
		if err != nil || !updated {
			return fmt.Errorf("reject proposed refund relation: %w", err)
		}
	}
	return nil
}

func (tx *RepositoryTransaction) ListEventEvidence(eventId int64) ([]*EconomicEventEvidence, error) {
	if err := tx.validate(); err != nil || eventId < 1 {
		return nil, fmt.Errorf("invalid event evidence transaction lookup")
	}
	items := make([]*EconomicEventEvidence, 0)
	if err := tx.session.Where("uid=? AND event_id=?", tx.uid, eventId).Asc("evidence_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list event evidence in transaction: %w", err)
	}
	return items, nil
}

func (tx *RepositoryTransaction) MoveEventEvidence(sourceEventId int64, targetEventId int64) (int64, error) {
	if err := tx.validate(); err != nil || sourceEventId < 1 || targetEventId < 1 || sourceEventId == targetEventId {
		return 0, fmt.Errorf("invalid event evidence move")
	}
	updated, err := tx.session.Where("uid=? AND event_id=?", tx.uid, sourceEventId).
		Cols("event_id", "evidence_role").Update(&EconomicEventEvidence{EventId: targetEventId, EvidenceRole: EVIDENCE_ROLE_SUPPORTING})
	if err != nil {
		return 0, fmt.Errorf("move event evidence: %w", err)
	}
	return updated, nil
}

func (tx *RepositoryTransaction) UpdateEvidenceRole(evidenceId int64, expectedRole EvidenceRole, nextRole EvidenceRole) (bool, error) {
	if err := tx.validate(); err != nil || evidenceId < 1 || !isEvidenceRole(expectedRole) || !isEvidenceRole(nextRole) || expectedRole == nextRole {
		return false, fmt.Errorf("invalid economic event evidence role update")
	}
	updated, err := tx.session.Where("uid=? AND evidence_id=? AND evidence_role=?", tx.uid, evidenceId, expectedRole).
		Cols("evidence_role").Update(&EconomicEventEvidence{EvidenceRole: nextRole})
	if err != nil {
		return false, fmt.Errorf("update economic event evidence role: %w", err)
	}
	return updated == 1, nil
}

func (tx *RepositoryTransaction) RejectProposedRelationsForEvents(eventIds []int64, now int64) error {
	if err := tx.validate(); err != nil || len(eventIds) < 1 || now < 1 {
		return fmt.Errorf("invalid proposed relation rejection")
	}
	ids, ok := uniquePositiveReviewIssueIds(eventIds)
	if !ok {
		return fmt.Errorf("invalid proposed relation rejection")
	}
	items := make([]*EconomicEventRelation, 0)
	query := tx.session.Where("uid=? AND status=?", tx.uid, RELATION_STATUS_PROPOSED)
	query = query.And("(source_event_id IN ("+placeholders(len(ids))+") OR target_event_id IN ("+placeholders(len(ids))+"))", appendInt64Args(ids, ids...)...)
	if err := query.Asc("relation_id").Find(&items); err != nil {
		return fmt.Errorf("list proposed event relations: %w", err)
	}
	for _, relation := range items {
		next := *relation
		next.Status = RELATION_STATUS_REJECTED
		next.Version = relation.Version + 1
		next.Manual = true
		next.ReasonCodesJson = reasonCodesJSON([]string{"manual_distinct_events"})
		next.UpdatedUnixTime = now
		updated, err := tx.UpdateRelationCAS(relation.Version, &next)
		if err != nil || !updated {
			return fmt.Errorf("reject proposed event relation: %w", err)
		}
	}
	return nil
}

func placeholders(count int) string {
	if count < 1 {
		return ""
	}
	value := "?"
	for index := 1; index < count; index++ {
		value += ",?"
	}
	return value
}

func appendInt64Args(first []int64, second ...int64) []any {
	values := make([]any, 0, len(first)+len(second))
	for _, value := range first {
		values = append(values, value)
	}
	for _, value := range second {
		values = append(values, value)
	}
	return values
}

func (tx *RepositoryTransaction) CountEventTransactionLinks(eventId int64) (int64, error) {
	if err := tx.validate(); err != nil || eventId < 1 {
		return 0, fmt.Errorf("invalid event transaction link count")
	}
	count, err := tx.session.Where("uid=? AND event_id=?", tx.uid, eventId).Count(new(EconomicEventTransaction))
	if err != nil {
		return 0, fmt.Errorf("count event transaction links: %w", err)
	}
	return count, nil
}

func (tx *RepositoryTransaction) DeleteUnpostedEvent(eventId int64) (bool, error) {
	if err := tx.validate(); err != nil || eventId < 1 {
		return false, fmt.Errorf("invalid unposted event delete")
	}
	links, err := tx.CountEventTransactionLinks(eventId)
	if err != nil {
		return false, err
	}
	if links != 0 {
		return false, fmt.Errorf("event has ledger links")
	}
	remainingEvidence, err := tx.session.Where("uid=? AND event_id=?", tx.uid, eventId).Count(new(EconomicEventEvidence))
	if err != nil {
		return false, fmt.Errorf("count remaining event evidence: %w", err)
	}
	if remainingEvidence != 0 {
		return false, fmt.Errorf("event still owns evidence")
	}
	confirmedRelations, err := tx.session.Where("uid=? AND status=? AND (source_event_id=? OR target_event_id=?)", tx.uid, RELATION_STATUS_CONFIRMED, eventId, eventId).
		Count(new(EconomicEventRelation))
	if err != nil {
		return false, fmt.Errorf("count confirmed event relations: %w", err)
	}
	if confirmedRelations != 0 {
		return false, fmt.Errorf("event has confirmed relations")
	}
	if _, err = tx.session.Where("uid=? AND status<>? AND (source_event_id=? OR target_event_id=?)", tx.uid, RELATION_STATUS_CONFIRMED, eventId, eventId).
		Delete(new(EconomicEventRelation)); err != nil {
		return false, fmt.Errorf("delete non-confirmed event relations: %w", err)
	}
	deleted, err := tx.session.Where("uid=? AND event_id=? AND status<>? AND status<>?", tx.uid, eventId, EVENT_STATUS_POSTED, EVENT_STATUS_CORRECTED).
		Delete(new(EconomicEvent))
	if err != nil {
		return false, fmt.Errorf("delete unposted event: %w", err)
	}
	return deleted == 1, nil
}

func (tx *RepositoryTransaction) FindLedgerTransaction(transactionId int64) (*models.Transaction, error) {
	if err := tx.validate(); err != nil || transactionId < 1 {
		return nil, fmt.Errorf("invalid ledger transaction lookup")
	}
	value := new(models.Transaction)
	found, err := tx.session.Where("uid=? AND transaction_id=? AND deleted=?", tx.uid, transactionId, false).Get(value)
	if err != nil {
		return nil, fmt.Errorf("find ledger transaction: %w", err)
	}
	if !found {
		return nil, nil
	}
	return value, nil
}

func (tx *RepositoryTransaction) FindEventLinkByTransactionId(transactionId int64) (*EconomicEventTransaction, error) {
	if err := tx.validate(); err != nil || transactionId < 1 {
		return nil, fmt.Errorf("invalid event transaction reverse lookup")
	}
	value := new(EconomicEventTransaction)
	found, err := tx.session.Where("uid=? AND transaction_id=?", tx.uid, transactionId).Asc("link_id").Get(value)
	if err != nil {
		return nil, fmt.Errorf("find event transaction reverse link: %w", err)
	}
	if !found {
		return nil, nil
	}
	return value, nil
}
