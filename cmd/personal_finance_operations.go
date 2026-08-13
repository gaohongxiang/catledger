package cmd

import (
	"errors"

	"github.com/urfave/cli/v3"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/log"
	"github.com/mayswind/ezbookkeeping/pkg/personalfinance/importing"
	"github.com/mayswind/ezbookkeeping/pkg/services"
)

func init() {
	Database.Commands = append(Database.Commands, &cli.Command{
		Name:   "check-personal-finance",
		Usage:  "Check personal finance consistency and object inventory while the web server is stopped",
		Action: bindAction(checkPersonalFinanceConsistency),
		Flags: []cli.Flag{
			&cli.Int64Flag{Name: "uid", Required: true, Usage: "User ID to check"},
		},
	})
}

func checkPersonalFinanceConsistency(c *core.CliContext) error {
	if _, err := initializeSystem(c); err != nil {
		return err
	}
	uid := c.Int64("uid")
	if uid < 1 {
		return errors.New("uid must be positive")
	}
	repository, err := importing.NewRepository(datastore.Container.UserDataStore)
	if err != nil {
		return err
	}
	service, err := importing.NewLifecycleService(repository, services.PersonalFinanceImportFilesStorage, services.PersonalFinanceImportFilesStorage)
	if err != nil {
		return err
	}
	report, err := service.CheckUserConsistency(c, uid)
	if err != nil {
		log.CliErrorf(c, "[database.checkPersonalFinanceConsistency] user consistency check failed")
		return err
	}
	log.CliInfof(c, "[database.checkPersonalFinanceConsistency] user aggregation files=%d batches=%d rows=%d batch_count_mismatches=%d orphan_relations=%d missing_transactions=%d content_mismatches=%d content_check_failures=%d",
		report.ImportFileCount, report.ImportBatchCount, report.RawImportRowCount, report.BatchCountMismatchCount,
		report.OrphanBatchCount+report.OrphanRawRowCount+report.OrphanSourceIdentityCount+report.OrphanPostingCount+report.OrphanBatchIssueCount+report.OrphanEvidenceLinkCount,
		report.MissingOrDeletedTransactionCount, report.FileContentMismatchCount, report.FileContentCheckFailureCount)
	inventory, err := service.CheckStorageInventory(c)
	if err != nil {
		log.CliErrorf(c, "[database.checkPersonalFinanceConsistency] object inventory is unsupported or unavailable")
		return err
	}
	log.CliInfof(c, "[database.checkPersonalFinanceConsistency] storage aggregation registered_final=%d unregistered_final=%d temporary=%d",
		inventory.RegisteredFinalObjectCount, inventory.UnregisteredFinalObjectCount, inventory.TemporaryObjectCount)
	if !report.Healthy() {
		return errors.New("personal finance user consistency check found issues")
	}
	if inventory.UnregisteredFinalObjectCount != 0 || inventory.TemporaryObjectCount != 0 {
		return errors.New("personal finance object inventory found unregistered or temporary objects")
	}
	log.CliInfof(c, "[database.checkPersonalFinanceConsistency] all personal finance checks passed")
	return nil
}
