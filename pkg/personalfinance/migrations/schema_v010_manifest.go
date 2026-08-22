package migrations

import "strings"

func canonicalSchemaManifestV010() string {
	var builder strings.Builder
	builder.WriteString("pf-schema-v010\n")

	for _, bean := range schemaBeansV010() {
		appendBeanManifest(&builder, bean)
	}

	builder.WriteString("plan=organizer-plan-v2\n")
	builder.WriteString("review-issue-key=review-issue-key-v1\n")
	builder.WriteString("review-issue-member-key=review-issue-member-key-v1\n")
	builder.WriteString("review-issue-rule=review-issue-v1\n")
	return builder.String()
}
