package organizer

import (
	"fmt"
	"sort"

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

func (tx *RepositoryTransaction) FindReviewIssueById(issueId int64) (*ReviewIssue, error) {
	if err := tx.validate(); err != nil || issueId < 1 {
		return nil, fmt.Errorf("invalid review issue transaction lookup")
	}
	return findReviewIssueById(tx.session, tx.uid, issueId)
}

func findReviewIssueById(sess *xorm.Session, uid int64, issueId int64) (*ReviewIssue, error) {
	value := new(ReviewIssue)
	found, err := sess.Where("uid=? AND issue_id=?", uid, issueId).Get(value)
	if err != nil {
		return nil, fmt.Errorf("find review issue: %w", err)
	}
	if !found {
		return nil, nil
	}
	return value, nil
}

func (r *Repository) ListReviewIssues(c core.Context, uid int64, updateId int64) ([]*ReviewIssue, error) {
	if uid < 1 || updateId < 1 {
		return nil, fmt.Errorf("invalid review issue list")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	items := make([]*ReviewIssue, 0)
	if err = sess.Where("uid=? AND update_id=?", uid, updateId).Asc("issue_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list review issues: %w", err)
	}
	return items, nil
}

func (r *Repository) ListReviewIssuesPage(c core.Context, uid int64, updateId int64, status ReviewIssueStatus, issueType ReviewIssueType, cursor *ReviewIssueCursor, limit int) (*ReviewIssuePage, error) {
	if uid < 1 || updateId < 1 || (status != "" && !isReviewIssueStatus(status)) || (issueType != "" && !isReviewIssueType(issueType)) ||
		limit < 1 || limit > maximumRepositoryPageSize || (cursor != nil && (cursor.UpdatedUnixTime < 1 || cursor.IssueId < 1)) {
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
		query = query.And("issue_type=?", issueType)
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
		page.Items = items[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = &ReviewIssueCursor{UpdatedUnixTime: last.UpdatedUnixTime, IssueId: last.IssueId}
	}
	return page, nil
}

func (r *Repository) ListReviewIssueMembers(c core.Context, uid int64, issueId int64) ([]*ReviewIssueMember, error) {
	if uid < 1 || issueId < 1 {
		return nil, fmt.Errorf("invalid review issue member list")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	return listReviewIssueMembers(sess, uid, issueId)
}

func (tx *RepositoryTransaction) ListReviewIssueMembers(issueId int64) ([]*ReviewIssueMember, error) {
	if err := tx.validate(); err != nil || issueId < 1 {
		return nil, fmt.Errorf("invalid review issue member transaction list")
	}
	return listReviewIssueMembers(tx.session, tx.uid, issueId)
}

func listReviewIssueMembers(sess *xorm.Session, uid int64, issueId int64) ([]*ReviewIssueMember, error) {
	items := make([]*ReviewIssueMember, 0)
	if err := sess.Where("uid=? AND issue_id=?", uid, issueId).Asc("sort_order", "member_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list review issue members: %w", err)
	}
	return items, nil
}

func (r *Repository) ListReviewIssueMembersForIssues(c core.Context, uid int64, issueIds []int64) ([]*ReviewIssueMember, error) {
	if uid < 1 || len(issueIds) < 1 || len(issueIds) > maximumRepositoryPageSize {
		return nil, fmt.Errorf("invalid review issue member batch list")
	}
	ids, ok := uniquePositiveReviewIssueIds(issueIds)
	if !ok {
		return nil, fmt.Errorf("invalid review issue member batch list")
	}
	database, err := r.database(uid)
	if err != nil {
		return nil, err
	}
	sess := database.NewPrivacySession(c)
	defer sess.Close()
	items := make([]*ReviewIssueMember, 0)
	if err = sess.Where("uid=?", uid).In("issue_id", ids).Asc("issue_id", "sort_order", "member_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list review issue members in batch: %w", err)
	}
	return items, nil
}

func (tx *RepositoryTransaction) ListOpenBlockingReviewIssuesForEvent(eventId int64) ([]*ReviewIssue, error) {
	if err := tx.validate(); err != nil || eventId < 1 {
		return nil, fmt.Errorf("invalid event review issue lookup")
	}
	members := make([]*ReviewIssueMember, 0)
	if err := tx.session.Where("uid=? AND object_type=? AND object_id=?", tx.uid, REVIEW_OBJECT_TYPE_EVENT, eventId).
		Asc("issue_id", "member_id").Find(&members); err != nil {
		return nil, fmt.Errorf("list event review issue members: %w", err)
	}
	if len(members) == 0 {
		return []*ReviewIssue{}, nil
	}
	issueIds := make([]int64, 0, len(members))
	for _, member := range members {
		issueIds = append(issueIds, member.IssueId)
	}
	issueIds, ok := uniquePositiveReviewIssueIds(issueIds)
	if !ok {
		return nil, fmt.Errorf("invalid event review issue membership")
	}
	items := make([]*ReviewIssue, 0, len(issueIds))
	if err := tx.session.Where("uid=? AND status=? AND blocking=?", tx.uid, REVIEW_ISSUE_STATUS_OPEN, true).
		In("issue_id", issueIds).Asc("issue_id").Find(&items); err != nil {
		return nil, fmt.Errorf("list open event review issues: %w", err)
	}
	return items, nil
}

func (tx *RepositoryTransaction) CountOpenBlockingReviewIssuesForEvent(eventId int64) (int64, error) {
	items, err := tx.ListOpenBlockingReviewIssuesForEvent(eventId)
	return int64(len(items)), err
}

func (tx *RepositoryTransaction) UpdateReviewIssueCAS(expectedVersion int64, next *ReviewIssue) (bool, error) {
	if err := tx.validate(); err != nil || !isValidReviewIssueCAS(next, tx.uid, expectedVersion) {
		return false, fmt.Errorf("invalid review issue CAS")
	}
	updated, err := tx.session.Where("uid=? AND issue_id=? AND version=?", tx.uid, next.IssueId, expectedVersion).
		Cols("status", "version", "blocking", "primary_reason_code", "member_count", "candidate_count",
			"resolved_action_id", "rule_version", "reason_codes_json", "updated_unix_time").
		MustCols("resolved_action_id").Update(next)
	if err != nil {
		return false, fmt.Errorf("update review issue CAS: %w", err)
	}
	return updated == 1, nil
}

func (tx *RepositoryTransaction) ReplaceReviewIssues(updateId int64) error {
	if err := tx.validate(); err != nil || updateId < 1 {
		return fmt.Errorf("invalid review issue replacement")
	}
	update, err := tx.FindUpdateById(updateId)
	if err != nil {
		return err
	}
	if update == nil || update.PostedEventCount != 0 || update.Status != UPDATE_STATUS_ORGANIZING {
		return fmt.Errorf("review issue replacement is not allowed")
	}
	if _, err = tx.session.Where("uid=? AND update_id=?", tx.uid, updateId).Delete(new(ReviewIssueMember)); err != nil {
		return fmt.Errorf("delete review issue members: %w", err)
	}
	if _, err = tx.session.Where("uid=? AND update_id=?", tx.uid, updateId).Delete(new(ReviewIssue)); err != nil {
		return fmt.Errorf("delete review issues: %w", err)
	}
	return nil
}

func uniquePositiveReviewIssueIds(values []int64) ([]int64, bool) {
	seen := make(map[int64]struct{}, len(values))
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value < 1 {
			return nil, false
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, len(result) > 0
}

func isValidNewReviewIssue(value *ReviewIssue, uid int64) bool {
	return value != nil && value.Uid == uid && value.UpdateId > 0 && value.IssueId > 0 &&
		value.Status == REVIEW_ISSUE_STATUS_OPEN && isReviewIssueType(value.IssueType) &&
		isLowerHexSHA256(value.IssueKey) && value.IssueKeyVersion == REVIEW_ISSUE_KEY_VERSION_V1 && value.Version == 1 &&
		value.Blocking && value.PrimaryReasonCode != "" && len(value.PrimaryReasonCode) <= 64 &&
		value.MemberCount > 0 && value.CandidateCount >= 0 && value.CandidateCount <= value.MemberCount &&
		value.ResolvedActionId == nil && value.RuleVersion == REVIEW_ISSUE_RULE_VERSION_V1 && value.ReasonCodesJson != "" &&
		value.CreatedUnixTime > 0 && value.UpdatedUnixTime == value.CreatedUnixTime
}

func isValidReviewIssueMember(value *ReviewIssueMember, uid int64) bool {
	return value != nil && value.Uid == uid && value.UpdateId > 0 && value.IssueId > 0 && value.MemberId > 0 &&
		isLowerHexSHA256(value.MemberKey) && value.MemberKeyVersion == REVIEW_ISSUE_MEMBER_KEY_VERSION_V1 &&
		isReviewIssueMemberRole(value.Role) && isReviewObjectType(value.ObjectType) && value.ObjectId > 0 && value.ObjectVersion > 0 &&
		value.SortOrder >= 0 && value.Score >= 0 && value.ReasonCodesJson != "" && value.CreatedUnixTime > 0
}

func isValidReviewIssueCAS(value *ReviewIssue, uid int64, expectedVersion int64) bool {
	if value == nil || value.Uid != uid || value.UpdateId < 1 || value.IssueId < 1 || expectedVersion < 1 ||
		value.Version != expectedVersion+1 || !isReviewIssueStatus(value.Status) || !isReviewIssueType(value.IssueType) ||
		!isLowerHexSHA256(value.IssueKey) || value.IssueKeyVersion != REVIEW_ISSUE_KEY_VERSION_V1 ||
		value.PrimaryReasonCode == "" || len(value.PrimaryReasonCode) > 64 || value.MemberCount < 1 ||
		value.CandidateCount < 0 || value.CandidateCount > value.MemberCount || value.RuleVersion != REVIEW_ISSUE_RULE_VERSION_V1 ||
		value.ReasonCodesJson == "" || value.CreatedUnixTime < 1 || value.UpdatedUnixTime < value.CreatedUnixTime {
		return false
	}
	if value.Status == REVIEW_ISSUE_STATUS_OPEN {
		return value.Blocking && value.ResolvedActionId == nil
	}
	return !value.Blocking && value.ResolvedActionId != nil && *value.ResolvedActionId > 0
}
