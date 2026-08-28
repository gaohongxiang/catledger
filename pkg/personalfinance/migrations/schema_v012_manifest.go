package migrations

import "strings"

func canonicalSchemaManifestV012() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v012\n")
	for _, bean := range schemaBeansV012() {
		appendBeanManifest(&builder, bean)
	}
	builder.WriteString("loan-opening-progress-baseline=loan-opening-progress-baseline-v1\n")
	return builder.String()
}
