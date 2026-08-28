package migrations

import (
	"context"

	"github.com/mayswind/ezbookkeeping/pkg/datastore"
)

func validateSchemaV012PreflightWithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceMigrationPreflightWithContext(c, db, schemaBeansThroughV011(), schemaBeansV012())
}

func verifySchemaV012WithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceTablesWithContext(c, db, schemaBeansThroughV012(), schemaExact)
}

func verifySchemaV012(db *datastore.Database) error {
	return verifySchemaV012WithContext(context.Background(), db)
}
