package migrations

import (
	"context"

	"github.com/gaohongxiang/catledger/pkg/datastore"
)

func validateSchemaV011PreflightWithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceMigrationPreflightWithContext(c, db, schemaBeansThroughV010(), schemaBeansV011())
}

func verifySchemaV011WithContext(c context.Context, db *datastore.Database) error {
	return verifyPersonalFinanceTablesWithContext(c, db, schemaBeansThroughV011(), schemaExact)
}
