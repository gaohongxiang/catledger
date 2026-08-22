package migrations

import (
	"context"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
)

func validateSchemaV010PreflightWithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceMigrationPreflightWithContext(c, db, schemaBeansThroughV009(), schemaBeansV010())
}

func verifySchemaV010WithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceTablesWithContext(c, db, schemaBeansThroughV010(), schemaExact)
}

func verifySchemaV010(db *datastore.Database) error {
	return verifySchemaV010WithContext(context.Background(), db)
}
