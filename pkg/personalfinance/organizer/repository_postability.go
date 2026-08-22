package organizer

import "fmt"

// ListRelations returns all relations touching one event inside the caller's
// existing privacy transaction. Posting and correction use this view so the
// relation decision and event status are evaluated from one database snapshot.
func (tx *RepositoryTransaction) ListRelations(eventId int64) ([]*EconomicEventRelation, error) {
	if err := tx.validate(); err != nil || eventId < 1 {
		return nil, fmt.Errorf("invalid economic event relation transaction lookup")
	}
	items := make([]*EconomicEventRelation, 0)
	if err := tx.session.Where("uid=? AND (source_event_id=? OR target_event_id=?)", tx.uid, eventId, eventId).
		Asc("relation_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list economic event relations in transaction: %w", err)
	}
	return items, nil
}
