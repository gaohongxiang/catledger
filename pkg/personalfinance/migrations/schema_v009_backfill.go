package migrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/models"
	"github.com/mayswind/ezbookkeeping/pkg/utils"
)

const legacyBackfillReasonV009 = `["legacy_posted_evidence_backfill"]`

type legacyEvidenceLinkV009 struct {
	Uid                        int64
	RowId                      int64
	TransactionId              int64
	Role                       string
	TransactionUpdatedUnixTime int64
	CreatedUnixTime            int64
}

type legacyUserGraphV009 struct {
	uid   int64
	links []legacyEvidenceLinkV009
}

type legacyEventGroupV009 struct {
	eventId int64
	links   []legacyEvidenceLinkV009
	rowIds  []int64
	txIds   []int64
}

func backfillOrganizerPostedEvidenceV009(c context.Context, db *datastore.Database) (err error) {
	if db == nil {
		return fmt.Errorf("backfill organizer evidence: database is nil")
	}
	sess := db.NewSessionWithContext(c)
	defer sess.Close()
	if err = sess.Begin(); err != nil {
		return fmt.Errorf("begin organizer evidence backfill: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = sess.Rollback()
		}
	}()

	graphs, err := loadLegacyEvidenceGraphsV009(sess)
	if err != nil {
		return err
	}
	for _, graph := range graphs {
		if err = backfillLegacyUserGraphV009(sess, graph); err != nil {
			return err
		}
	}
	if err = sess.Commit(); err != nil {
		return fmt.Errorf("commit organizer evidence backfill: %w", err)
	}
	committed = true
	return nil
}

func loadLegacyEvidenceGraphsV009(sess *xorm.Session) ([]legacyUserGraphV009, error) {
	rawLinks := make([]rawRowTransactionLinkV002, 0)
	if err := sess.Find(&rawLinks); err != nil {
		return nil, fmt.Errorf("read legacy posting evidence links: %w", err)
	}
	reconciliationLinks := make([]reconciliationTransactionLinkV003, 0)
	if err := sess.Find(&reconciliationLinks); err != nil {
		return nil, fmt.Errorf("read legacy reconciliation evidence links: %w", err)
	}
	cases := make([]reconciliationCaseV003, 0)
	if err := sess.Find(&cases); err != nil {
		return nil, fmt.Errorf("read legacy reconciliation cases: %w", err)
	}
	currentDecisions := make(map[string]struct{}, len(cases))
	for _, item := range cases {
		if item.CurrentDecisionId != nil {
			currentDecisions[legacyOwnerIdKeyV009(item.Uid, *item.CurrentDecisionId)] = struct{}{}
		}
	}

	byUid := make(map[int64][]legacyEvidenceLinkV009)
	seen := make(map[string]struct{})
	appendLink := func(link legacyEvidenceLinkV009) {
		key := strconv.FormatInt(link.Uid, 10) + ":" + strconv.FormatInt(link.RowId, 10) + ":" +
			strconv.FormatInt(link.TransactionId, 10) + ":" + link.Role
		if link.Uid < 1 || link.RowId < 1 || link.TransactionId < 1 {
			return
		}
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		byUid[link.Uid] = append(byUid[link.Uid], link)
	}
	for _, link := range rawLinks {
		appendLink(legacyEvidenceLinkV009{
			Uid: link.Uid, RowId: link.RowId, TransactionId: link.TransactionId, Role: link.RelationRole,
			TransactionUpdatedUnixTime: link.TransactionUpdatedUnixTime, CreatedUnixTime: link.CreatedUnixTime,
		})
	}
	for _, link := range reconciliationLinks {
		if _, active := currentDecisions[legacyOwnerIdKeyV009(link.Uid, link.DecisionId)]; !active {
			continue
		}
		appendLink(legacyEvidenceLinkV009{
			Uid: link.Uid, RowId: link.RowId, TransactionId: link.TransactionId, Role: link.RelationRole,
			TransactionUpdatedUnixTime: link.TransactionUpdatedUnixTime, CreatedUnixTime: link.CreatedUnixTime,
		})
	}

	uids := make([]int64, 0, len(byUid))
	for uid := range byUid {
		uids = append(uids, uid)
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
	graphs := make([]legacyUserGraphV009, 0, len(uids))
	for _, uid := range uids {
		links := byUid[uid]
		sort.Slice(links, func(i, j int) bool {
			if links[i].RowId != links[j].RowId {
				return links[i].RowId < links[j].RowId
			}
			if links[i].TransactionId != links[j].TransactionId {
				return links[i].TransactionId < links[j].TransactionId
			}
			return links[i].Role < links[j].Role
		})
		graphs = append(graphs, legacyUserGraphV009{uid: uid, links: links})
	}
	return graphs, nil
}

func backfillLegacyUserGraphV009(sess *xorm.Session, graph legacyUserGraphV009) error {
	groups := buildLegacyEventGroupsV009(graph.links)
	if len(groups) == 0 {
		return nil
	}
	updateId := groups[0].eventId
	createdUnixTime := groups[0].links[0].CreatedUnixTime
	rows := make(map[int64]*rawImportRowV001)
	batches := make(map[int64]*importBatchV001)
	batchIds := make([]int64, 0)
	transactions := make(map[int64]*models.Transaction)
	accounts := make(map[int64]*models.Account)

	for _, group := range groups {
		if group.eventId < updateId {
			updateId = group.eventId
		}
		for _, link := range group.links {
			if link.CreatedUnixTime > 0 && (createdUnixTime < 1 || link.CreatedUnixTime < createdUnixTime) {
				createdUnixTime = link.CreatedUnixTime
			}
		}
		for _, rowId := range group.rowIds {
			row := new(rawImportRowV001)
			found, err := sess.Where("uid=? AND row_id=?", graph.uid, rowId).Get(row)
			if err != nil {
				return fmt.Errorf("read legacy raw evidence uid=%d row=%d: %w", graph.uid, rowId, err)
			}
			if !found {
				return fmt.Errorf("read legacy raw evidence uid=%d row=%d: row is missing", graph.uid, rowId)
			}
			rows[rowId] = row
			if _, exists := batches[row.BatchId]; !exists {
				batch := new(importBatchV001)
				found, err = sess.Where("uid=? AND batch_id=?", graph.uid, row.BatchId).Get(batch)
				if err != nil {
					return fmt.Errorf("read legacy evidence batch uid=%d batch=%d: %w", graph.uid, row.BatchId, err)
				}
				if !found {
					return fmt.Errorf("read legacy evidence batch uid=%d batch=%d: batch is missing", graph.uid, row.BatchId)
				}
				batches[row.BatchId] = batch
				batchIds = append(batchIds, row.BatchId)
			}
		}
		for _, transactionId := range group.txIds {
			transaction := new(models.Transaction)
			found, err := sess.Where("uid=? AND transaction_id=?", graph.uid, transactionId).Get(transaction)
			if err != nil {
				return fmt.Errorf("read legacy linked transaction uid=%d transaction=%d: %w", graph.uid, transactionId, err)
			}
			if !found {
				return fmt.Errorf("read legacy linked transaction uid=%d transaction=%d: transaction is missing", graph.uid, transactionId)
			}
			transactions[transactionId] = transaction
			for _, accountId := range []int64{transaction.AccountId, transaction.RelatedAccountId} {
				if accountId < 1 {
					continue
				}
				if _, exists := accounts[accountId]; exists {
					continue
				}
				account := new(models.Account)
				found, err = sess.Where("uid=? AND account_id=?", graph.uid, accountId).Get(account)
				if err != nil {
					return fmt.Errorf("read legacy linked account uid=%d account=%d: %w", graph.uid, accountId, err)
				}
				if !found {
					return fmt.Errorf("read legacy linked account uid=%d account=%d: account is missing", graph.uid, accountId)
				}
				accounts[accountId] = account
			}
		}
	}
	if createdUnixTime < 1 {
		return fmt.Errorf("legacy evidence graph uid=%d has no creation time", graph.uid)
	}

	sort.Slice(batchIds, func(i, j int) bool { return batchIds[i] < batchIds[j] })
	actionDigest := legacyDigestV009("legacy-action", graph.uid, []int64{updateId})
	action := &financeActionV009{
		Uid: graph.uid, UpdateId: updateId, AppliedUpdateVersion: 1, ActionType: "legacy_backfill",
		IdempotencyKeyDigest: actionDigest, IdempotencyKeyVersion: "idempotency-key-v1",
		RequestDigest: actionDigest, RequestDigestVersion: "finance-action-request-v1", Status: "applied",
		ReasonCodesJson: legacyBackfillReasonV009, CreatedUnixTime: createdUnixTime,
		CompletedUnixTime: &createdUnixTime, UpdatedUnixTime: createdUnixTime, ActionId: updateId,
	}
	if err := insertV009IfMissing(sess, graph.uid, "action_id", updateId, action); err != nil {
		return err
	}
	update := &financeUpdateV009{
		Uid: graph.uid, Status: "posted", Version: 1, PlanVersion: "organizer-legacy-backfill-v1",
		CurrentActionId: &updateId, SourceCount: int64(len(batchIds)), ValidEvidenceCount: int64(len(rows)),
		DuplicateEvidenceCount: int64(len(rows) - len(groups)), FinalEventCount: int64(len(groups)),
		PostedEventCount: int64(len(groups)), CreatedUnixTime: createdUnixTime, UpdatedUnixTime: createdUnixTime, UpdateId: updateId,
	}
	if err := insertV009IfMissing(sess, graph.uid, "update_id", updateId, update); err != nil {
		return err
	}
	for order, batchId := range batchIds {
		batch := batches[batchId]
		source := &financeUpdateSourceV009{
			Uid: graph.uid, UpdateId: updateId, SourceOrder: int64(order), FileId: batch.FileId, BatchId: batchId,
			SourceAccountId: batch.SourceAccountId, SourceTypeSnapshot: batch.SourceTypeSnapshot,
			ParserVersion: batch.ParserVersion, NormalizationVersion: batch.NormalizationVersion,
			IdentityKeyVersion: batch.IdentityKeyVersion, CreatedUnixTime: createdUnixTime, SourceId: batchId,
		}
		if err := insertV009IfMissing(sess, graph.uid, "source_id", batchId, source); err != nil {
			return err
		}
	}
	for _, group := range groups {
		if err := insertLegacyEventGroupV009(sess, graph.uid, updateId, createdUnixTime, group, transactions, accounts); err != nil {
			return err
		}
	}
	return nil
}

func insertLegacyEventGroupV009(sess *xorm.Session, uid int64, updateId int64, createdUnixTime int64, group legacyEventGroupV009, transactions map[int64]*models.Transaction, accounts map[int64]*models.Account) error {
	primaryId := preferredLegacyTransactionV009(group.links)
	primary := transactions[primaryId]
	if primary == nil {
		return fmt.Errorf("legacy event %d has no primary transaction", group.eventId)
	}
	direction, nature := legacyTransactionSemanticsV009(primary.Type)
	accountId := primary.AccountId
	var counterpartId *int64
	if primary.RelatedAccountId > 0 {
		value := primary.RelatedAccountId
		counterpartId = &value
	}
	eventUnixTime := utils.GetUnixTimeFromTransactionTime(primary.TransactionTime)
	timezone := primary.TimezoneUtcOffset
	amount := primary.Amount
	if amount < 0 {
		amount = -amount
	}
	var categoryId *int64
	if primary.CategoryId > 0 {
		value := primary.CategoryId
		categoryId = &value
	}
	currency := ""
	if account := accounts[accountId]; account != nil {
		currency = account.Currency
	}
	event := &economicEventV009{
		Uid: uid, UpdateId: updateId, EventKey: legacyDigestV009("legacy-event", uid, group.txIds),
		EventKeyVersion: "economic-event-key-v1", Status: "posted", Version: 1, FlowDirection: direction,
		EconomicNature: nature, LedgerAccountId: &accountId, CounterpartyLedgerAccountId: counterpartId,
		EventUnixTime: &eventUnixTime, TimezoneUtcOffset: &timezone, Amount: &amount, Currency: currency,
		CategoryId: categoryId, RuleVersion: "organizer-legacy-backfill-v1",
		FieldSourcesJson: `{"legacy":"transaction"}`, ReasonCodesJson: legacyBackfillReasonV009,
		CreatedUnixTime: createdUnixTime, UpdatedUnixTime: createdUnixTime, EventId: group.eventId,
	}
	if err := insertV009IfMissing(sess, uid, "event_id", group.eventId, event); err != nil {
		return err
	}
	for index, rowId := range group.rowIds {
		role := "supporting"
		if index == 0 {
			role = "primary"
		} else if len(group.rowIds) > len(group.txIds) {
			role = "duplicate"
		}
		evidence := &economicEventEvidenceV009{
			Uid: uid, UpdateId: updateId, EventId: group.eventId, RowId: rowId, EvidenceRole: role,
			CreatedUnixTime: createdUnixTime, EvidenceId: rowId,
		}
		if err := insertV009IfMissing(sess, uid, "evidence_id", rowId, evidence); err != nil {
			return err
		}
	}
	roles := preferredLegacyRolesV009(group.links)
	for _, transactionId := range group.txIds {
		transaction := transactions[transactionId]
		link := &economicEventTransactionV009{
			Uid: uid, UpdateId: updateId, EventId: group.eventId, TransactionId: transactionId,
			Role: roles[transactionId], RuleVersion: "event-transaction-link-v1",
			TransactionUpdatedUnixTime: transaction.UpdatedUnixTime, CreatedUnixTime: createdUnixTime, LinkId: transactionId,
		}
		if err := insertV009IfMissing(sess, uid, "link_id", transactionId, link); err != nil {
			return err
		}
	}
	return nil
}

func buildLegacyEventGroupsV009(links []legacyEvidenceLinkV009) []legacyEventGroupV009 {
	parent := make(map[int64]int64)
	var findRoot func(int64) int64
	findRoot = func(value int64) int64 {
		root := parent[value]
		if root == value {
			return value
		}
		root = findRoot(root)
		parent[value] = root
		return root
	}
	rowTransactions := make(map[int64][]int64)
	for _, link := range links {
		if _, exists := parent[link.TransactionId]; !exists {
			parent[link.TransactionId] = link.TransactionId
		}
		rowTransactions[link.RowId] = append(rowTransactions[link.RowId], link.TransactionId)
	}
	for _, transactionIds := range rowTransactions {
		for index := 1; index < len(transactionIds); index++ {
			left := findRoot(transactionIds[0])
			right := findRoot(transactionIds[index])
			if left != right {
				if left < right {
					parent[right] = left
				} else {
					parent[left] = right
				}
			}
		}
	}
	groupLinks := make(map[int64][]legacyEvidenceLinkV009)
	for _, link := range links {
		root := findRoot(link.TransactionId)
		groupLinks[root] = append(groupLinks[root], link)
	}
	groups := make([]legacyEventGroupV009, 0, len(groupLinks))
	for _, groupedLinks := range groupLinks {
		rowSet := make(map[int64]struct{})
		txSet := make(map[int64]struct{})
		for _, link := range groupedLinks {
			rowSet[link.RowId] = struct{}{}
			txSet[link.TransactionId] = struct{}{}
		}
		rowIds := sortedLegacyIdsV009(rowSet)
		txIds := sortedLegacyIdsV009(txSet)
		groups = append(groups, legacyEventGroupV009{eventId: txIds[0], links: groupedLinks, rowIds: rowIds, txIds: txIds})
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].eventId < groups[j].eventId })
	return groups
}

func preferredLegacyTransactionV009(links []legacyEvidenceLinkV009) int64 {
	preferredId := int64(0)
	preferredPriority := -1
	for _, link := range links {
		priority := legacyRolePriorityV009(link.Role)
		if priority > preferredPriority || (priority == preferredPriority && (preferredId == 0 || link.TransactionId < preferredId)) {
			preferredId = link.TransactionId
			preferredPriority = priority
		}
	}
	return preferredId
}

func preferredLegacyRolesV009(links []legacyEvidenceLinkV009) map[int64]string {
	roles := make(map[int64]string)
	for _, link := range links {
		current, exists := roles[link.TransactionId]
		if !exists || legacyRolePriorityV009(link.Role) > legacyRolePriorityV009(current) {
			roles[link.TransactionId] = link.Role
		}
	}
	return roles
}

func legacyRolePriorityV009(role string) int {
	switch role {
	case "refund_transaction":
		return 4
	case "primary":
		return 3
	case "transfer_counterpart":
		return 2
	case "refund_original":
		return 1
	default:
		return 0
	}
}

func legacyTransactionSemanticsV009(transactionType models.TransactionDbType) (string, string) {
	switch transactionType {
	case models.TRANSACTION_DB_TYPE_INCOME:
		return "inflow", "income"
	case models.TRANSACTION_DB_TYPE_EXPENSE:
		return "outflow", "expense"
	case models.TRANSACTION_DB_TYPE_TRANSFER_OUT, models.TRANSACTION_DB_TYPE_TRANSFER_IN:
		return "neutral", "internal_transfer"
	default:
		return "neutral", "balance_adjustment"
	}
}

func insertV009IfMissing(sess *xorm.Session, uid int64, idColumn string, id int64, value any) error {
	if uid < 1 || id < 1 || !isSafeCatalogIdentifier(idColumn) {
		return fmt.Errorf("invalid v009 backfill identity")
	}
	exists, err := sess.Where("uid=? AND "+idColumn+"=?", uid, id).Exist(value)
	if err != nil {
		return fmt.Errorf("check v009 backfill %T: %w", value, err)
	}
	if exists {
		return nil
	}
	inserted, err := sess.Insert(value)
	if err != nil {
		return fmt.Errorf("insert v009 backfill %T: %w", value, err)
	}
	if inserted != 1 {
		return fmt.Errorf("v009 backfill %T was not inserted", value)
	}
	return nil
}

func sortedLegacyIdsV009(values map[int64]struct{}) []int64 {
	ids := make([]int64, 0, len(values))
	for id := range values {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func legacyOwnerIdKeyV009(uid int64, id int64) string {
	return strconv.FormatInt(uid, 10) + ":" + strconv.FormatInt(id, 10)
}

func legacyDigestV009(kind string, uid int64, ids []int64) string {
	parts := make([]string, len(ids))
	for index, id := range ids {
		parts[index] = strconv.FormatInt(id, 10)
	}
	digest := sha256.Sum256([]byte(kind + "|" + strconv.FormatInt(uid, 10) + "|" + strings.Join(parts, ",")))
	return hex.EncodeToString(digest[:])
}
