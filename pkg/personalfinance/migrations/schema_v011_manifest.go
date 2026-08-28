package migrations

import "strings"

func canonicalSchemaManifestV011() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v011\n")
	for _, bean := range schemaBeansV011() {
		appendBeanManifest(&builder, bean)
	}
	builder.WriteString("installment-contract-draft=installment-contract-draft-v1\n")
	return builder.String()
}
