package migrations

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"xorm.io/xorm"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/datastore"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
)

const (
	migrationLeaseSeconds      = int64(300)
	maxMigrationTextLength     = 64
	migrationRunnerIdByteCount = 16
	migrationClaimTokenBytes   = 16
	migrationHeartbeatStopWait = 5 * time.Second
)

const migrationTableBootstrapSQL = `CREATE TABLE IF NOT EXISTS pf_schema_migration (
    version BIGINT NOT NULL PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    checksum CHAR(64) NOT NULL,
    application_version VARCHAR(64) NOT NULL,
    application_commit VARCHAR(64) NOT NULL,
    runner_id CHAR(32) NOT NULL,
    claim_token CHAR(32) NOT NULL,
    first_started_unix_time BIGINT NOT NULL,
    started_unix_time BIGINT NOT NULL,
    updated_unix_time BIGINT NOT NULL,
    lease_expires_unix_time BIGINT NOT NULL,
    applied_unix_time BIGINT NULL,
    success BOOLEAN NOT NULL,
    failure_code VARCHAR(64) NOT NULL
)`

var (
	ErrMigrationRegistryInvalid  = errors.New("personal finance migration registry is invalid")
	ErrMigrationChecksumMismatch = errors.New("personal finance migration checksum mismatch")
	ErrMigrationVersionTooNew    = errors.New("personal finance schema version is newer than this application")
	ErrMigrationInProgress       = errors.New("personal finance migration is already in progress")
	ErrMigrationClaimLost        = errors.New("personal finance migration claim was lost")
	ErrMigrationSchemaInvalid    = errors.New("personal finance schema is incompatible")
)

// ApplicationInfo identifies the binary applying a schema migration.
type ApplicationInfo struct {
	Version string
	Commit  string
}

// SchemaMigration is the durable PF migration ledger record.
type SchemaMigration struct {
	Version              int64  `xorm:"BIGINT PK NOT NULL"`
	Name                 string `xorm:"VARCHAR(128) NOT NULL"`
	Checksum             string `xorm:"CHAR(64) NOT NULL"`
	ApplicationVersion   string `xorm:"VARCHAR(64) NOT NULL"`
	ApplicationCommit    string `xorm:"VARCHAR(64) NOT NULL"`
	RunnerId             string `xorm:"CHAR(32) NOT NULL"`
	ClaimToken           string `xorm:"CHAR(32) NOT NULL"`
	FirstStartedUnixTime int64  `xorm:"BIGINT NOT NULL"`
	StartedUnixTime      int64  `xorm:"BIGINT NOT NULL"`
	UpdatedUnixTime      int64  `xorm:"BIGINT NOT NULL"`
	LeaseExpiresUnixTime int64  `xorm:"BIGINT NOT NULL"`
	AppliedUnixTime      *int64 `xorm:"BIGINT NULL"`
	Success              bool   `xorm:"BOOLEAN NOT NULL"`
	FailureCode          string `xorm:"VARCHAR(64) NOT NULL"`
}

// TableName returns the fixed migration ledger table name.
func (SchemaMigration) TableName() string {
	return "pf_schema_migration"
}

type migration struct {
	version   int64
	name      string
	checksum  string
	preflight func(c context.Context, db *datastore.Database) error
	steps     []migrationStep
	verify    func(c context.Context, db *datastore.Database) error
}

// migrationStep 必须可重入，且单步预期在一个租约周期内完成。
type migrationStep struct {
	name string
	run  func(c context.Context, db *datastore.Database) error
}

type migrationClaim struct {
	version    int64
	checksum   string
	claimToken string
}

type mysqlMigrationClaimUpdate uint8

const (
	mysqlMigrationClaimRenew mysqlMigrationClaimUpdate = iota
	mysqlMigrationClaimFail
	mysqlMigrationClaimSucceed
)

type migrationRunner struct {
	context         core.Context
	applicationInfo ApplicationInfo
	runnerId        string
	databaseNow     func(db *datastore.Database, c context.Context) (int64, error)
	leaseSeconds    int64
	migrations      []migration
}

type migrationHeartbeat struct {
	stop     chan struct{}
	done     chan error
	lost     chan struct{}
	stopOnce sync.Once
	waitOnce sync.Once
	errMutex sync.RWMutex
	err      error
	cancel   context.CancelFunc
	stopped  chan struct{}
	stopErr  error
	stopWait time.Duration
}

// Upgrade applies every registered PF migration to each user data database.
func Upgrade(c core.Context, store *datastore.DataStore, applicationInfo ApplicationInfo) error {
	if store == nil || store.Count() < 1 {
		return fmt.Errorf("%w: user data store is empty", ErrMigrationRegistryInvalid)
	}

	runnerId, err := newRandomHex(migrationRunnerIdByteCount)

	if err != nil {
		return fmt.Errorf("create personal finance migration runner id: %w", err)
	}

	runner := &migrationRunner{
		context: c,
		applicationInfo: ApplicationInfo{
			Version: truncateMigrationText(applicationInfo.Version),
			Commit:  truncateMigrationText(applicationInfo.Commit),
		},
		runnerId:     runnerId,
		databaseNow:  currentDatabaseUnixTimeWithContext,
		leaseSeconds: migrationLeaseSeconds,
		migrations:   registeredMigrations(),
	}

	if err = validateMigrationRegistry(runner.migrations); err != nil {
		return err
	}

	for i := 0; i < store.Count(); i++ {
		if err = runner.upgradeDatabase(store.Get(i)); err != nil {
			return fmt.Errorf("upgrade personal finance database %d: %w", i, err)
		}
	}

	return nil
}

func registeredMigrations() []migration {
	v001Checksum := sha256.Sum256([]byte(canonicalSchemaManifestV001()))
	v001Steps := make([]migrationStep, 0, len(schemaBeansV001()))

	for _, bean := range schemaBeansV001() {
		tableName := bean.(interface{ TableName() string }).TableName()
		v001Steps = append(v001Steps, migrationStep{
			name: "create_" + tableName,
			run: func(c context.Context, db *datastore.Database) error {
				return db.SyncStructsWithStoreEngineContext(c, "InnoDB", bean)
			},
		})
	}

	v002Checksum := sha256.Sum256([]byte(canonicalSchemaManifestV002()))
	v002Steps := make([]migrationStep, 0, len(schemaBeansV002()))

	for _, bean := range schemaBeansV002() {
		tableName := bean.(interface{ TableName() string }).TableName()
		v002Steps = append(v002Steps, migrationStep{
			name: "create_" + tableName,
			run: func(c context.Context, db *datastore.Database) error {
				return db.SyncStructsWithStoreEngineContext(c, "InnoDB", bean)
			},
		})
	}

	v003Checksum := sha256.Sum256([]byte(canonicalSchemaManifestV003()))
	v003Steps := make([]migrationStep, 0, len(schemaBeansV003()))

	for _, bean := range schemaBeansV003() {
		tableName := bean.(interface{ TableName() string }).TableName()
		v003Steps = append(v003Steps, migrationStep{
			name: "create_" + tableName,
			run: func(c context.Context, db *datastore.Database) error {
				return syncFrozenSchemaBeanWithIndexes(c, db, bean)
			},
		})
	}

	v004Checksum := sha256.Sum256([]byte(canonicalSchemaManifestV004()))
	v004Steps := make([]migrationStep, 0, len(schemaBeansV004()))

	for _, bean := range schemaBeansV004() {
		tableName := bean.(interface{ TableName() string }).TableName()
		v004Steps = append(v004Steps, migrationStep{
			name: "create_" + tableName,
			run: func(c context.Context, db *datastore.Database) error {
				return syncFrozenSchemaBeanWithIndexes(c, db, bean)
			},
		})
	}

	v005Checksum := sha256.Sum256([]byte(canonicalSchemaManifestV005()))
	v005Steps := make([]migrationStep, 0, len(schemaBeansV005()))

	for _, bean := range schemaBeansV005() {
		tableName := bean.(interface{ TableName() string }).TableName()
		v005Steps = append(v005Steps, migrationStep{
			name: "create_" + tableName,
			run: func(c context.Context, db *datastore.Database) error {
				return syncFrozenSchemaBeanWithIndexes(c, db, bean)
			},
		})
	}

	v006Checksum := sha256.Sum256([]byte(canonicalSchemaManifestV006()))
	v006Steps := make([]migrationStep, 0, len(schemaBeansV006()))

	for _, bean := range schemaBeansV006() {
		bean := bean
		tableName := bean.(interface{ TableName() string }).TableName()
		v006Steps = append(v006Steps, migrationStep{
			name: "create_" + tableName,
			run: func(c context.Context, db *datastore.Database) error {
				return syncFrozenSchemaBeanWithIndexes(c, db, bean)
			},
		})
	}

	v007Checksum := sha256.Sum256([]byte(canonicalSchemaManifestV007()))
	v007Steps := make([]migrationStep, 0, len(schemaBeansV007()))

	for _, bean := range schemaBeansV007() {
		bean := bean
		tableName := bean.(interface{ TableName() string }).TableName()
		v007Steps = append(v007Steps, migrationStep{
			name: "create_" + tableName,
			run: func(c context.Context, db *datastore.Database) error {
				return syncFrozenSchemaBeanWithIndexes(c, db, bean)
			},
		})
	}

	v008Checksum := sha256.Sum256([]byte(canonicalSchemaManifestV008()))
	v008Steps := make([]migrationStep, 0, len(schemaBeansV008()))

	for _, bean := range schemaBeansV008() {
		bean := bean
		tableName := bean.(interface{ TableName() string }).TableName()
		v008Steps = append(v008Steps, migrationStep{
			name: "create_" + tableName,
			run: func(c context.Context, db *datastore.Database) error {
				return syncFrozenSchemaBeanWithIndexes(c, db, bean)
			},
		})
	}

	return []migration{
		{
			version:   1,
			name:      "initial_import_evidence_schema",
			checksum:  hex.EncodeToString(v001Checksum[:]),
			preflight: validateSchemaV001PreflightWithContext,
			steps:     v001Steps,
			verify:    verifySchemaV001WithContext,
		},
		{
			version:   2,
			name:      "posting_links_and_batch_issues",
			checksum:  hex.EncodeToString(v002Checksum[:]),
			preflight: validateSchemaV002PreflightWithContext,
			steps:     v002Steps,
			verify:    verifySchemaV002WithContext,
		},
		{
			version:   3,
			name:      "reconciliation_cases_and_decisions",
			checksum:  hex.EncodeToString(v003Checksum[:]),
			preflight: validateSchemaV003PreflightWithContext,
			steps:     v003Steps,
			verify:    verifySchemaV003WithContext,
		},
		{
			version:   4,
			name:      "loan_contracts_schedules_and_allocations",
			checksum:  hex.EncodeToString(v004Checksum[:]),
			preflight: validateSchemaV004PreflightWithContext,
			steps:     v004Steps,
			verify:    verifySchemaV004WithContext,
		},
		{
			version:   5,
			name:      "payment_account_mappings",
			checksum:  hex.EncodeToString(v005Checksum[:]),
			preflight: validateSchemaV005PreflightWithContext,
			steps:     v005Steps,
			verify:    verifySchemaV005WithContext,
		},
		{
			version:   6,
			name:      "billflow_installments_and_card_cycle",
			checksum:  hex.EncodeToString(v006Checksum[:]),
			preflight: validateSchemaV006PreflightWithContext,
			steps:     v006Steps,
			verify:    verifySchemaV006WithContext,
		},
		{
			version:   7,
			name:      "payment_account_exclusions",
			checksum:  hex.EncodeToString(v007Checksum[:]),
			preflight: validateSchemaV007PreflightWithContext,
			steps:     v007Steps,
			verify:    verifySchemaV007WithContext,
		},
		{
			version:   8,
			name:      "import_batch_card_headers",
			checksum:  hex.EncodeToString(v008Checksum[:]),
			preflight: validateSchemaV008PreflightWithContext,
			steps:     v008Steps,
			verify:    verifySchemaV008WithContext,
		},
	}
}

func validateMigrationRegistry(migrations []migration) error {
	if len(migrations) < 1 {
		return fmt.Errorf("%w: no migrations registered", ErrMigrationRegistryInvalid)
	}

	for index, item := range migrations {
		expectedVersion := int64(index + 1)

		if item.version != expectedVersion || item.name == "" || len(item.name) > 128 || len(item.checksum) != 64 || item.preflight == nil || len(item.steps) == 0 || item.verify == nil {
			return fmt.Errorf("%w: invalid migration version %d", ErrMigrationRegistryInvalid, item.version)
		}

		if _, err := hex.DecodeString(item.checksum); err != nil {
			return fmt.Errorf("%w: invalid checksum for version %d", ErrMigrationRegistryInvalid, item.version)
		}

		for _, step := range item.steps {
			if step.name == "" || step.run == nil {
				return fmt.Errorf("%w: invalid migration step for version %d", ErrMigrationRegistryInvalid, item.version)
			}
		}

	}

	return nil
}

func (r *migrationRunner) upgradeDatabase(db *datastore.Database) error {
	if db == nil {
		return fmt.Errorf("%w: database is nil", ErrMigrationRegistryInvalid)
	}

	if err := r.bootstrapMigrationTable(db); err != nil {
		return err
	}

	if err := verifyMigrationTableWithContext(r.operationContext(), db); err != nil {
		return err
	}

	records, err := r.readAllMigrationRecords(db)

	if err != nil {
		return err
	}

	if err = validateAppliedMigrations(records, r.migrations); err != nil {
		return err
	}

	if len(records) > 0 {
		latestRecord := records[len(records)-1]
		latestMigration := r.migrations[len(r.migrations)-1]

		if latestRecord.Success && latestRecord.Version == latestMigration.version {
			if err = latestMigration.verify(r.operationContext(), db); err != nil {
				return fmt.Errorf("verify applied personal finance migration %d: %w", latestMigration.version, err)
			}
		}
	}

	recordByVersion := make(map[int64]*SchemaMigration, len(records))

	for _, record := range records {
		recordByVersion[record.Version] = record
	}

	for _, item := range r.migrations {
		record := recordByVersion[item.version]

		if record != nil && record.Success {
			continue
		}

		if err = r.applyMigration(db, item, record); err != nil {
			return err
		}
	}

	return nil
}

func (r *migrationRunner) bootstrapMigrationTable(db *datastore.Database) error {
	sess := db.NewSessionWithContext(r.operationContext())
	defer sess.Close()
	bootstrapSQL := migrationTableBootstrapSQL

	if db.DatabaseType() == settings.MySqlDbType {
		bootstrapSQL += " ENGINE=InnoDB"
	}

	if _, err := sess.Exec(bootstrapSQL); err != nil {
		return fmt.Errorf("bootstrap personal finance migration table: %w", err)
	}

	return nil
}

func (r *migrationRunner) readAllMigrationRecords(db *datastore.Database) ([]*SchemaMigration, error) {
	sess := db.NewSessionWithContext(r.operationContext())
	defer sess.Close()

	records := make([]*SchemaMigration, 0, len(r.migrations))

	if err := sess.Asc("version").Find(&records); err != nil {
		return nil, fmt.Errorf("read personal finance migration records: %w", err)
	}

	return records, nil
}

func validateAppliedMigrations(records []*SchemaMigration, migrations []migration) error {
	registered := make(map[int64]migration, len(migrations))
	latestVersion := migrations[len(migrations)-1].version

	for _, item := range migrations {
		registered[item.version] = item
	}

	for index, record := range records {
		if record.Version != int64(index+1) {
			return fmt.Errorf("%w: migration history is not contiguous at version %d", ErrMigrationRegistryInvalid, record.Version)
		}

		item, exists := registered[record.Version]

		if !exists || record.Version > latestVersion {
			return fmt.Errorf("%w: database version %d, application version %d", ErrMigrationVersionTooNew, record.Version, latestVersion)
		}

		if record.Name != item.name || record.Checksum != item.checksum {
			return fmt.Errorf("%w: version %d", ErrMigrationChecksumMismatch, record.Version)
		}

		if index > 0 && (!records[index-1].Success || records[index-1].Version+1 != record.Version) {
			return fmt.Errorf("%w: migration history is not a successful prefix", ErrMigrationRegistryInvalid)
		}
	}

	return nil
}

func (r *migrationRunner) applyMigration(db *datastore.Database, item migration, existing *SchemaMigration) error {
	now, err := r.databaseNow(db, r.operationContext())

	if err != nil {
		return err
	}

	claim, alreadyApplied, err := r.claimMigration(db, item, existing, now)

	if err != nil || alreadyApplied {
		return err
	}

	heartbeat := r.startHeartbeat(db, claim)
	failureCode, err := r.runClaimedMigration(db, item, claim, heartbeat)
	heartbeatErr := heartbeat.Stop()

	if heartbeatErr != nil {
		return heartbeatErr
	}

	if err != nil {
		if markErr := r.markMigrationFailed(db, claim, failureCode); markErr != nil {
			return fmt.Errorf("apply personal finance migration %d: %v; mark failed: %w", item.version, err, markErr)
		}

		return fmt.Errorf("apply personal finance migration %d: %w", item.version, err)
	}

	if err = r.markMigrationSucceeded(db, claim); err != nil {
		return err
	}

	return nil
}

func (r *migrationRunner) runClaimedMigration(db *datastore.Database, item migration, claim *migrationClaim, heartbeat *migrationHeartbeat) (string, error) {
	if err := r.renewAndAssertMigrationClaimActive(db, claim, heartbeat); err != nil {
		return "", err
	}

	if err := item.preflight(r.operationContext(), db); err != nil {
		return "schema_preflight_failed", err
	}

	if err := r.renewAndAssertMigrationClaimActive(db, claim, heartbeat); err != nil {
		return "", err
	}

	for _, step := range item.steps {
		if err := r.renewAndAssertMigrationClaimActive(db, claim, heartbeat); err != nil {
			return "", err
		}

		if err := step.run(r.operationContext(), db); err != nil {
			return "migration_up_failed", fmt.Errorf("migration step %s: %w", step.name, err)
		}

		if err := r.renewAndAssertMigrationClaimActive(db, claim, heartbeat); err != nil {
			return "", err
		}
	}

	if err := item.verify(r.operationContext(), db); err != nil {
		return "schema_verify_failed", err
	}

	if err := r.renewAndAssertMigrationClaimActive(db, claim, heartbeat); err != nil {
		return "", err
	}

	return "", nil
}

func (r *migrationRunner) renewAndAssertMigrationClaimActive(db *datastore.Database, claim *migrationClaim, heartbeat *migrationHeartbeat) error {
	if err := heartbeat.Check(); err != nil {
		return err
	}

	return r.renewMigrationLease(db, claim)
}

func (r *migrationRunner) claimMigration(db *datastore.Database, item migration, existing *SchemaMigration, now int64) (*migrationClaim, bool, error) {
	claimToken, err := newRandomHex(migrationClaimTokenBytes)

	if err != nil {
		return nil, false, fmt.Errorf("create migration claim token: %w", err)
	}

	if existing == nil {
		record := &SchemaMigration{
			Version:              item.version,
			Name:                 item.name,
			Checksum:             item.checksum,
			ApplicationVersion:   r.applicationInfo.Version,
			ApplicationCommit:    r.applicationInfo.Commit,
			RunnerId:             r.runnerId,
			ClaimToken:           claimToken,
			FirstStartedUnixTime: now,
			StartedUnixTime:      now,
			UpdatedUnixTime:      now,
			LeaseExpiresUnixTime: now + r.leaseSeconds,
			Success:              false,
			FailureCode:          "",
		}

		sess := db.NewSessionWithContext(r.operationContext())
		_, insertErr := sess.Insert(record)
		sess.Close()

		if insertErr == nil {
			return &migrationClaim{version: item.version, checksum: item.checksum, claimToken: claimToken}, false, nil
		}

		current, readErr := r.readMigrationRecord(db, item.version)

		if readErr != nil {
			return nil, false, fmt.Errorf("claim personal finance migration %d: %w", item.version, insertErr)
		}

		if current == nil {
			return nil, false, fmt.Errorf("claim personal finance migration %d: %w", item.version, insertErr)
		}

		existing = current
	}

	if existing.Name != item.name || existing.Checksum != item.checksum {
		return nil, false, fmt.Errorf("%w: version %d", ErrMigrationChecksumMismatch, item.version)
	}

	if existing.Success {
		return nil, true, nil
	}

	if existing.FailureCode == "" && existing.LeaseExpiresUnixTime > now {
		return nil, false, fmt.Errorf("%w: version %d", ErrMigrationInProgress, item.version)
	}

	update := &SchemaMigration{
		ApplicationVersion:   r.applicationInfo.Version,
		ApplicationCommit:    r.applicationInfo.Commit,
		RunnerId:             r.runnerId,
		ClaimToken:           claimToken,
		StartedUnixTime:      now,
		UpdatedUnixTime:      now,
		LeaseExpiresUnixTime: now + r.leaseSeconds,
		Success:              false,
		FailureCode:          "",
	}

	sess := db.NewSessionWithContext(r.operationContext())
	updated, updateErr := sess.Table(new(SchemaMigration)).
		Cols("application_version", "application_commit", "runner_id", "claim_token", "started_unix_time", "updated_unix_time", "lease_expires_unix_time", "success", "failure_code").
		Where("version=? AND checksum=? AND success=? AND claim_token=? AND lease_expires_unix_time=? AND updated_unix_time=? AND failure_code=? AND (failure_code<>? OR lease_expires_unix_time<=?)",
			existing.Version, existing.Checksum, false, existing.ClaimToken, existing.LeaseExpiresUnixTime, existing.UpdatedUnixTime, existing.FailureCode, "", now).
		Update(update)
	sess.Close()

	if updateErr != nil {
		return nil, false, fmt.Errorf("take over personal finance migration %d: %w", item.version, updateErr)
	}

	if updated != 1 {
		return nil, false, fmt.Errorf("%w: version %d", ErrMigrationClaimLost, item.version)
	}

	return &migrationClaim{version: item.version, checksum: item.checksum, claimToken: claimToken}, false, nil
}

func (r *migrationRunner) readMigrationRecord(db *datastore.Database, version int64) (*SchemaMigration, error) {
	sess := db.NewSessionWithContext(r.operationContext())
	defer sess.Close()

	record := &SchemaMigration{}
	found, err := sess.ID(version).Get(record)

	if err != nil {
		return nil, fmt.Errorf("read personal finance migration %d: %w", version, err)
	}

	if !found {
		return nil, nil
	}

	return record, nil
}

func (r *migrationRunner) startHeartbeat(db *datastore.Database, claim *migrationClaim) *migrationHeartbeat {
	heartbeatContext, cancel := context.WithCancel(r.operationContext())
	heartbeat := &migrationHeartbeat{
		stop:     make(chan struct{}),
		done:     make(chan error, 1),
		lost:     make(chan struct{}),
		cancel:   cancel,
		stopped:  make(chan struct{}),
		stopWait: migrationHeartbeatStopWait,
	}
	heartbeatInterval := time.Duration(r.leaseSeconds/3) * time.Second

	if heartbeatInterval < time.Second {
		heartbeatInterval = time.Second
	}

	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()

		for {
			select {
			case <-heartbeat.stop:
				heartbeat.done <- nil
				return
			case <-ticker.C:
				if err := r.renewMigrationLeaseWithContext(db, claim, heartbeatContext); err != nil {
					if heartbeat.isStopping() && errors.Is(err, context.Canceled) {
						heartbeat.done <- nil
						return
					}

					heartbeat.markLost(err)
					heartbeat.done <- err
					return
				}
			}
		}
	}()

	return heartbeat
}

func (h *migrationHeartbeat) markLost(err error) {
	h.errMutex.Lock()
	h.err = err
	h.errMutex.Unlock()
	close(h.lost)
}

func (h *migrationHeartbeat) Check() error {
	select {
	case <-h.lost:
		h.errMutex.RLock()
		defer h.errMutex.RUnlock()
		return h.err
	default:
		return nil
	}
}

func (h *migrationHeartbeat) Stop() error {
	h.stopOnce.Do(func() {
		close(h.stop)

		if h.cancel != nil {
			h.cancel()
		}
	})

	h.waitOnce.Do(func() {
		timer := time.NewTimer(h.stopWait)
		defer timer.Stop()

		select {
		case h.stopErr = <-h.done:
		case <-timer.C:
			h.stopErr = fmt.Errorf("stop personal finance migration heartbeat: timed out")
		}

		close(h.stopped)
	})

	<-h.stopped
	return h.stopErr
}

func (h *migrationHeartbeat) isStopping() bool {
	select {
	case <-h.stop:
		return true
	default:
		return false
	}
}

func (r *migrationRunner) renewMigrationLease(db *datastore.Database, claim *migrationClaim) error {
	return r.renewMigrationLeaseWithContext(db, claim, r.operationContext())
}

func (r *migrationRunner) renewMigrationLeaseWithContext(db *datastore.Database, claim *migrationClaim, c context.Context) error {
	if db.DatabaseType() == settings.MySqlDbType {
		return r.updateMySQLLockedMigrationClaim(db, claim, mysqlMigrationClaimRenew, "", c)
	}

	sess := db.NewSessionWithContext(c)
	defer sess.Close()
	nowExpression, err := databaseUnixTimeExpression(db.DatabaseType())

	if err != nil {
		return err
	}

	minimumLeaseExpiryExpression := fmt.Sprintf("(%s)+%d", nowExpression, r.leaseSeconds)
	leaseExpression := fmt.Sprintf(
		"CASE WHEN lease_expires_unix_time>=%s THEN lease_expires_unix_time+1 ELSE %s END",
		minimumLeaseExpiryExpression, minimumLeaseExpiryExpression,
	)
	updatedExpression := monotonicDatabaseTimeExpression("updated_unix_time", nowExpression)

	updated, err := sess.Table(new(SchemaMigration)).
		SetExpr("lease_expires_unix_time", leaseExpression).
		SetExpr("updated_unix_time", updatedExpression).
		Where("version=? AND checksum=? AND success=? AND claim_token=? AND failure_code=? AND lease_expires_unix_time>"+nowExpression,
			claim.version, claim.checksum, false, claim.claimToken, "").
		Update(new(SchemaMigration))

	if err != nil {
		return fmt.Errorf("renew personal finance migration %d lease: %w", claim.version, err)
	}

	if updated != 1 {
		return fmt.Errorf("%w: version %d heartbeat", ErrMigrationClaimLost, claim.version)
	}

	return nil
}

func (r *migrationRunner) markMigrationFailed(db *datastore.Database, claim *migrationClaim, failureCode string) error {
	if db.DatabaseType() == settings.MySqlDbType {
		return r.updateMySQLLockedMigrationClaim(db, claim, mysqlMigrationClaimFail, failureCode, r.operationContext())
	}

	sess := db.NewSessionWithContext(r.operationContext())
	defer sess.Close()
	nowExpression, err := databaseUnixTimeExpression(db.DatabaseType())

	if err != nil {
		return err
	}

	updated, err := sess.Table(new(SchemaMigration)).
		SetExpr("updated_unix_time", monotonicDatabaseTimeExpression("updated_unix_time", nowExpression)).
		SetExpr("lease_expires_unix_time", nowExpression).
		Cols("failure_code").
		Where("version=? AND checksum=? AND success=? AND claim_token=? AND failure_code=? AND lease_expires_unix_time>"+nowExpression,
			claim.version, claim.checksum, false, claim.claimToken, "").
		Update(&SchemaMigration{FailureCode: failureCode})

	if err != nil {
		return fmt.Errorf("mark personal finance migration %d failed: %w", claim.version, err)
	}

	if updated != 1 {
		return fmt.Errorf("%w: version %d failed", ErrMigrationClaimLost, claim.version)
	}

	return nil
}

func (r *migrationRunner) markMigrationSucceeded(db *datastore.Database, claim *migrationClaim) error {
	if db.DatabaseType() == settings.MySqlDbType {
		return r.updateMySQLLockedMigrationClaim(db, claim, mysqlMigrationClaimSucceed, "", r.operationContext())
	}

	sess := db.NewSessionWithContext(r.operationContext())
	defer sess.Close()
	nowExpression, err := databaseUnixTimeExpression(db.DatabaseType())

	if err != nil {
		return err
	}

	updated, err := sess.Table(new(SchemaMigration)).
		SetExpr("updated_unix_time", monotonicDatabaseTimeExpression("updated_unix_time", nowExpression)).
		SetExpr("lease_expires_unix_time", nowExpression).
		SetExpr("applied_unix_time", nowExpression).
		Cols("success", "failure_code").
		Where("version=? AND checksum=? AND success=? AND claim_token=? AND failure_code=? AND lease_expires_unix_time>"+nowExpression,
			claim.version, claim.checksum, false, claim.claimToken, "").
		Update(&SchemaMigration{
			Success:     true,
			FailureCode: "",
		})

	if err != nil {
		return fmt.Errorf("complete personal finance migration %d: %w", claim.version, err)
	}

	if updated != 1 {
		return fmt.Errorf("%w: version %d completed", ErrMigrationClaimLost, claim.version)
	}

	return nil
}

// updateMySQLLockedMigrationClaim reads the database clock only after acquiring the
// ledger row lock. MySQL's zero-argument UNIX_TIMESTAMP() is fixed at statement
// start, so using it directly in a blocked UPDATE could validate an already-expired
// lease after the lock is finally granted.
func (r *migrationRunner) updateMySQLLockedMigrationClaim(db *datastore.Database, claim *migrationClaim, operation mysqlMigrationClaimUpdate, failureCode string, c context.Context) (err error) {
	sess := db.NewSessionWithContext(c)
	defer sess.Close()

	if err = sess.Begin(); err != nil {
		return fmt.Errorf("begin MySQL personal finance migration claim update: %w", err)
	}

	committed := false
	defer func() {
		if !committed {
			_ = sess.Rollback()
		}
	}()

	record := new(SchemaMigration)
	found, err := sess.ForUpdate().Where("version=?", claim.version).Get(record)

	if err != nil {
		return fmt.Errorf("lock MySQL personal finance migration %d claim: %w", claim.version, err)
	}

	now, err := currentDatabaseUnixTimeWithSession(db.DatabaseType(), sess)

	if err != nil {
		return err
	}

	if !found || record.Checksum != claim.checksum || record.Success ||
		record.ClaimToken != claim.claimToken || record.FailureCode != "" ||
		record.LeaseExpiresUnixTime <= now {
		return mysqlMigrationClaimLostError(claim.version, operation)
	}

	updatedTime := now

	if record.UpdatedUnixTime > updatedTime {
		updatedTime = record.UpdatedUnixTime
	}

	update := &SchemaMigration{UpdatedUnixTime: updatedTime}
	columns := []string{"updated_unix_time"}

	switch operation {
	case mysqlMigrationClaimRenew:
		leaseExpiry := now + r.leaseSeconds

		if record.LeaseExpiresUnixTime >= leaseExpiry {
			leaseExpiry = record.LeaseExpiresUnixTime + 1
		}

		update.LeaseExpiresUnixTime = leaseExpiry
		columns = append(columns, "lease_expires_unix_time")
	case mysqlMigrationClaimFail:
		update.LeaseExpiresUnixTime = now
		update.FailureCode = failureCode
		columns = append(columns, "lease_expires_unix_time", "failure_code")
	case mysqlMigrationClaimSucceed:
		update.LeaseExpiresUnixTime = now
		update.AppliedUnixTime = &now
		update.Success = true
		update.FailureCode = ""
		columns = append(columns, "lease_expires_unix_time", "applied_unix_time", "success", "failure_code")
	default:
		return fmt.Errorf("%w: invalid MySQL migration claim update", ErrMigrationRegistryInvalid)
	}

	updated, err := sess.Table(new(SchemaMigration)).
		Cols(columns...).
		Where("version=? AND checksum=? AND success=? AND claim_token=? AND failure_code=? AND lease_expires_unix_time=? AND updated_unix_time=?",
			claim.version, claim.checksum, false, claim.claimToken, "", record.LeaseExpiresUnixTime, record.UpdatedUnixTime).
		Update(update)

	if err != nil {
		return fmt.Errorf("update MySQL personal finance migration %d claim: %w", claim.version, err)
	}

	if updated != 1 {
		return mysqlMigrationClaimLostError(claim.version, operation)
	}

	if err = sess.Commit(); err != nil {
		return fmt.Errorf("commit MySQL personal finance migration %d claim update: %w", claim.version, err)
	}

	committed = true
	return nil
}

func mysqlMigrationClaimLostError(version int64, operation mysqlMigrationClaimUpdate) error {
	operationName := "heartbeat"

	switch operation {
	case mysqlMigrationClaimFail:
		operationName = "failed"
	case mysqlMigrationClaimSucceed:
		operationName = "completed"
	}

	return fmt.Errorf("%w: version %d %s", ErrMigrationClaimLost, version, operationName)
}

func canonicalSchemaManifestV001() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v001\n")
	appendBeanManifest(&builder, new(SchemaMigration))

	for _, bean := range schemaBeansV001() {
		appendBeanManifest(&builder, bean)
	}

	builder.WriteString("raw-fields=ordered-json-array-v1\n")
	return builder.String()
}

func canonicalSchemaManifestV002() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v002\n")

	for _, bean := range schemaBeansV002() {
		appendBeanManifest(&builder, bean)
	}

	builder.WriteString("idempotency-key=idempotency-key-v1\n")
	builder.WriteString("posting-request=posting-request-v1\n")
	builder.WriteString("posting-link=posting-link-v1\n")
	return builder.String()
}

func canonicalSchemaManifestV003() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v003\n")

	for _, bean := range schemaBeansV003() {
		appendBeanManifest(&builder, bean)
	}

	builder.WriteString("case-key=reconciliation-case-key-v1:sorted-stable-member-tokens\n")
	builder.WriteString("candidate-rule=reconciliation-candidate-v1\n")
	builder.WriteString("explanation=reconciliation-explanation-v1\n")
	builder.WriteString("decision-idempotency=idempotency-key-v1\n")
	builder.WriteString("decision-request=reconciliation-request-v1\n")
	builder.WriteString("transaction-link=reconciliation-link-v1\n")
	return builder.String()
}

func canonicalSchemaManifestV004() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v004\n")

	for _, bean := range schemaBeansV004() {
		appendBeanManifest(&builder, bean)
	}

	builder.WriteString("calculation=loan-calculation-v1\n")
	builder.WriteString("rounding=loan-rounding-half-up-v1\n")
	builder.WriteString("irr=periodic-irr-v1\n")
	builder.WriteString("action-idempotency=idempotency-key-v1\n")
	builder.WriteString("action-request=loan-action-request-v1\n")
	return builder.String()
}

func canonicalSchemaManifestV005() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v005\n")

	for _, bean := range schemaBeansV005() {
		appendBeanManifest(&builder, bean)
	}

	builder.WriteString("payment-account-alias=payment-account-alias-v1\n")
	return builder.String()
}

func canonicalSchemaManifestV006() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v006\n")

	for _, bean := range schemaBeansV006() {
		appendBeanManifest(&builder, bean)
	}

	builder.WriteString("auto-post=auto-post-v1\n")
	builder.WriteString("high-confidence-window=high-confidence-window-v1\n")
	builder.WriteString("category-alias=category-alias-v1\n")
	builder.WriteString("installment-candidate-key=installment-candidate-key-v1\n")
	builder.WriteString("installment-detect=installment-detect-v1\n")
	builder.WriteString("action-idempotency=idempotency-key-v1\n")
	builder.WriteString("action-request=billflow-action-request-v1\n")
	return builder.String()
}

func canonicalSchemaManifestV007() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v007\n")

	for _, bean := range schemaBeansV007() {
		appendBeanManifest(&builder, bean)
	}

	builder.WriteString("payment-account-exclusion=payment-account-exclusion-v1\n")
	return builder.String()
}

func canonicalSchemaManifestV008() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v008\n")

	for _, bean := range schemaBeansV008() {
		appendBeanManifest(&builder, bean)
	}

	builder.WriteString("card-statement-header=card-statement-header-v1\n")
	return builder.String()
}

func appendBeanManifest(builder *strings.Builder, bean any) {
	beanType := reflect.TypeOf(bean)

	if beanType.Kind() == reflect.Ptr {
		beanType = beanType.Elem()
	}

	tableName := reflect.New(beanType).Interface().(interface{ TableName() string }).TableName()
	builder.WriteString("table=")
	builder.WriteString(tableName)
	builder.WriteByte('\n')

	for fieldIndex := 0; fieldIndex < beanType.NumField(); fieldIndex++ {
		field := beanType.Field(fieldIndex)
		builder.WriteString(field.Name)
		builder.WriteByte('=')
		builder.WriteString(field.Tag.Get("xorm"))
		builder.WriteByte('\n')
	}
}

func currentDatabaseUnixTime(db *datastore.Database) (int64, error) {
	return currentDatabaseUnixTimeWithContext(db, context.Background())
}

func currentDatabaseUnixTimeWithContext(db *datastore.Database, c context.Context) (int64, error) {
	sess := db.NewSessionWithContext(c)
	defer sess.Close()
	return currentDatabaseUnixTimeWithSession(db.DatabaseType(), sess)
}

func currentDatabaseUnixTimeWithSession(databaseType string, sess *xorm.Session) (int64, error) {
	nowExpression, err := databaseUnixTimeExpression(databaseType)

	if err != nil {
		return 0, err
	}

	rows, err := sess.QueryString("SELECT " + nowExpression + " AS unix_time")

	if err != nil {
		return 0, fmt.Errorf("read database time: %w", err)
	}

	if len(rows) != 1 {
		return 0, fmt.Errorf("read database time: expected one row")
	}

	value, exists := rows[0]["unix_time"]

	if !exists {
		value = rows[0]["UNIX_TIME"]
	}

	now, err := strconv.ParseInt(value, 10, 64)

	if err != nil || now < 1 {
		return 0, fmt.Errorf("read database time: invalid Unix time")
	}

	return now, nil
}

func databaseUnixTimeExpression(databaseType string) (string, error) {
	switch databaseType {
	case settings.Sqlite3DbType:
		return "CAST(strftime('%s', 'now') AS INTEGER)", nil
	case settings.MySqlDbType:
		return "UNIX_TIMESTAMP()", nil
	case settings.PostgresDbType:
		return "CAST(EXTRACT(EPOCH FROM clock_timestamp()) AS BIGINT)", nil
	default:
		return "", fmt.Errorf("%w: unsupported database type %s", ErrMigrationRegistryInvalid, databaseType)
	}
}

func monotonicDatabaseTimeExpression(columnName string, nowExpression string) string {
	return fmt.Sprintf("CASE WHEN %s>%s THEN %s ELSE %s END", columnName, nowExpression, columnName, nowExpression)
}

func (r *migrationRunner) operationContext() context.Context {
	if r.context == nil {
		return context.Background()
	}

	return r.context
}

func newRandomHex(byteCount int) (string, error) {
	randomBytes := make([]byte, byteCount)

	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}

	return hex.EncodeToString(randomBytes), nil
}

func truncateMigrationText(value string) string {
	value = strings.TrimSpace(value)

	if len(value) > maxMigrationTextLength {
		return value[:maxMigrationTextLength]
	}

	return value
}
