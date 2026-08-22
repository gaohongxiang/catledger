package organizer

import (
	"fmt"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
)

type ReviewIssueCursor struct {
	UpdatedUnixTime int64
	IssueId         int64
}

type ReviewIssuePage struct {
	Items      []*ReviewIssue
	NextCursor *ReviewIssueCursor
}

func (tx *RepositoryTransaction) InsertReviewIssue(value *ReviewIssue) error {
	if err := tx.validate(); err != nil || !isValidNewReviewIssue(value, tx.uid) {
		return fmt.Errorf("invalid review issue insert")
	}
	return insertOne(tx.session, value, "review issue")
}

func (tx *RepositoryTransaction) InsertReviewIssueMember(value *ReviewIssueMember) error {
	if err := tx.validate(); err != nil || !isValidReviewIssueMember(value, tx.uid) {
		return fmt.Errorf("invalid review issue member insert")
	}
	return insertOne(tx.session, value, "review issue member")
}

func (tx *RepositoryTransaction) FindReviewIssueById(issueId int64) (*ReviewIssue, error) {
	if err := tx.validate(); err != nil || issueId < 1 {
		return nil, fmt.Errorf("invalid review issue transaction lookup")
	}
	return findReviewIssueById(tx.session, tx.uid, issueId)
}

func (tx *RepositoryTransaction) ListReviewIssues(updateId int64) ([]*ReviewIssue, error) {
	if err := tx.validate(); err != nil || updateId < 1 {
		return nil, fmt.Errorf("invalid review issue transaction list")
	}
	items := make([]*ReviewIssue, 0)
	if err := tx.session.Where("uid=? AND update_id=?", tx.uid, updateId).Asc("issue_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list review issues: %w", err)
	}
	return items, nil
}

func (tx *RepositoryTransaction) ListReviewIssueMembers(issueId int64) ([]*ReviewIssueMember, error) {
	if err := tx.validate(); err != nil || issueId < 1 {
		return nil, fmt.Errorf("invalid review issue member transaction list")
	}
	return listReviewIssueMembers(tx.session, tx.uid, issueId)
}

func (tx *RepositoryTransaction) UpdateReviewIssueCAS(expectedVersion int64, next *ReviewIssue) (bool, error) {
	if err := tx.validate(); err != nil || !isValidReviewIssueCAS(next, tx.uid, expectedVersion) {
		return false, fmt.Errorf("invalid review issue CAS")
	}
	updated, err := tx.session.Where("uid=? AND issue_id=? AND version=?", tx.uid, next.IssueId, expectedVersion).
		Cols("status", "version", "blocking", "dependency_issue_id", "summary_code", "member_count", "candidate_count", "resolution_action_id", "updated_unix_time").
		MustCols("dependency_issue_id", "resolution_action_id").Update(next)
	if err != nil {
		return false, fmt.Errorf("update review issue CAS: %w", err)
	}
	return updated == 1, nil
}

// ReplaceReviewIssueProjection removes only the rebuildable issue projection.
// Economic events, evidence and user-confirmed relations remain untouched.
func (tx *RepositoryTransaction) ReplaceReviewIssueProjection(updateId int64) error {
	if err := tx.validate(); err != nil || updateId < 1 {
		return fmt.Errorf("invalid review issue projection replacement")
	}
	if _, err := tx.session.Where("uid=? AND update_id=?", tx.uid, updateId).Delete(new(ReviewIssueMember)); err != nil {
		return fmt.Errorf("delete review issue members: %w", err)
	}
	if _, err := tx.session.Where("uid=? AND update_id=?", tx.uid, updateId).Delete(new(ReviewIssue)); err != nil {
		return fmt.Errorf("delete review issues: %w", err)
	}
	return nil
}

func (r *Repository) FindReviewIssueById(c core.Context, uid int64, issueId int64) (*ReviewIssue, error) {
	if uid < 1 || issueId < 1 {
		return nil, fmt.Errorf("invalid review issue lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return findReviewIssueById(sess, uid, issueId)
}

func (r *Repository) ListReviewIssues(c core.Context, uid int64, updateId int64, status ReviewIssueStatus, issueType ReviewIssueType, cursor *ReviewIssueCursor, limit int) (*ReviewIssuePage, error) {
	if uid < 1 || updateId < 1 || limit < 1 || limit > maximumRepositoryPageSize ||
		(status != "" && !isReviewIssueStatus(status)) || (issueType != "" && !isReviewIssueType(issueType)) ||
		(cursor != nil && (cursor.UpdatedUnixTime < 1 || cursor.IssueId < 1)) {
		return nil, fmt.Errorf("invalid review issue page")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	query := sess.Where("uid=? AND update_id=?", uid, updateId)
	if status != "" {
		query = query.And("status=?", status)
	}
	if issueType != "" {
		query = query.And("type=?", issueType)
	}
	if cursor != nil {
		query = query.And("(updated_unix_time<? OR (updated_unix_time=? AND issue_id<?))", cursor.UpdatedUnixTime, cursor.UpdatedUnixTime, cursor.IssueId)
	}
	items := make([]*ReviewIssue, 0, limit+1)
	if err = query.Desc("updated_unix_time", "issue_id").Limit(limit + 1).Find(&items); err != nil {
		return nil, fmt.Errorf("list review issue page: %w", err)
	}
	page := &ReviewIssuePage{Items: items}
	if len(items) > limit {
		last := items[limit-1]
		page.Items = items[:limit]
		page.NextCursor = &ReviewIssueCursor{UpdatedUnixTime: last.UpdatedUnixTime, IssueId: last.IssueId}
	}
	return page, nil
}

func (r *Repository) ListReviewIssueMembers(c core.Context, uid int64, issueId int64) ([]*ReviewIssueMember, error) {
	if uid < 1 || issueId < 1 {
		return nil, fmt.Errorf("invalid review issue member lookup")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return listReviewIssueMembers(sess, uid, issueId)
}

func (r *Repository) ListReviewIssueMembersForIssues(c core.Context, uid int64, issueIds []int64) ([]*ReviewIssueMember, error) {
	if uid < 1 || len(issueIds) < 1 || len(issueIds) > maximumRepositoryPageSize {
		return nil, fmt.Errorf("invalid review issue member batch list")
	}
	seen := make(map[int64]struct{}, len(issueIds))
	for _, issueId := range issueIds {
		if issueId < 1 {
			return nil, fmt.Errorf("invalid review issue member batch list")
		}
		if _, exists := seen[issueId]; exists {
			return nil, fmt.Errorf("duplicate review issue member batch id")
		}
		seen[issueId] = struct{}{}
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	items := make([]*ReviewIssueMember, 0)
	if err = sess.Where("uid=?", uid).In("issue_id", issueIds).Asc("issue_id", "sort_order", "member_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list review issue member batch: %w", err)
	}
	return items, nil
}

func findReviewIssueById(sess *xorm.Session, uid int64, issueId int64) (*ReviewIssue, error) {
	value := new(ReviewIssue)
	has, err := sess.Where("uid=? AND issue_id=?", uid, issueId).Get(value)
	if err != nil {
		return nil, fmt.Errorf("find review issue: %w", err)
	}
	if !has {
		return nil, nil
	}
	return value, nil
}

func listReviewIssueMembers(sess *xorm.Session, uid int64, issueId int64) ([]*ReviewIssueMember, error) {
	items := make([]*ReviewIssueMember, 0)
	if err := sess.Where("uid=? AND issue_id=?", uid, issueId).Asc("sort_order", "member_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list review issue members: %w", err)
	}
	return items, nil
}

func isValidNewReviewIssue(value *ReviewIssue, uid int64) bool {
	return value != nil && value.Uid == uid && uid > 0 && value.UpdateId > 0 && value.IssueId > 0 && len(value.IssueKey) == 64 &&
		value.IssueKeyVersion == REVIEW_ISSUE_KEY_VERSION_V1 && isReviewIssueType(value.Type) && value.Status == REVIEW_ISSUE_STATUS_OPEN &&
		value.Version == 1 && value.Blocking && value.DependencyIssueId == nil && value.SummaryCode != "" && len(value.SummaryCode) <= 64 &&
		value.MemberCount > 0 && value.CandidateCount >= 0 && value.ResolutionActionId == nil && value.CreatedUnixTime > 0 && value.UpdatedUnixTime >= value.CreatedUnixTime
}

func isValidReviewIssueCAS(value *ReviewIssue, uid int64, expectedVersion int64) bool {
	return value != nil && value.Uid == uid && uid > 0 && value.UpdateId > 0 && value.IssueId > 0 && len(value.IssueKey) == 64 &&
		value.IssueKeyVersion == REVIEW_ISSUE_KEY_VERSION_V1 && isReviewIssueType(value.Type) && isReviewIssueStatus(value.Status) &&
		expectedVersion > 0 && value.Version == expectedVersion+1 && value.SummaryCode != "" && len(value.SummaryCode) <= 64 &&
		value.MemberCount > 0 && value.CandidateCount >= 0 && value.CreatedUnixTime > 0 && value.UpdatedUnixTime >= value.CreatedUnixTime
}

func isValidReviewIssueMember(value *ReviewIssueMember, uid int64) bool {
	if value == nil || value.Uid != uid || uid < 1 || value.UpdateId < 1 || value.IssueId < 1 || value.MemberId < 1 ||
		len(value.MemberKey) != 64 || value.MemberKeyVersion != REVIEW_ISSUE_MEMBER_VERSION_V1 || !isReviewIssueMemberRole(value.Role) ||
		value.ObjectVersion < 1 || value.SortOrder < 0 || value.RecommendationScore < 0 || value.ReasonCodesJson == "" || value.CreatedUnixTime < 1 {
		return false
	}
	references := 0
	for _, reference := range []*int64{value.EventId, value.EvidenceId, value.RelationId, value.TransactionId} {
		if reference != nil {
			if *reference < 1 {
				return false
			}
			references++
		}
	}
	return references == 1 && value.Role == REVIEW_ISSUE_MEMBER_ROLE_EVENT && value.EventId != nil
}
