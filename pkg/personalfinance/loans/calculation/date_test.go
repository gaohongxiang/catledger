package calculation

import "testing"

func TestCivilDateMonthEndAnchor(t *testing.T) {
	tests := []struct {
		anchor string
		months int64
		want   string
	}{
		{anchor: "2026-01-31", months: 1, want: "2026-02-28"},
		{anchor: "2026-01-31", months: 2, want: "2026-03-31"},
		{anchor: "2024-01-31", months: 1, want: "2024-02-29"},
		{anchor: "2024-02-29", months: 12, want: "2025-02-28"},
		{anchor: "2026-08-30", months: 6, want: "2027-02-28"},
	}
	for _, test := range tests {
		date, err := ParseCivilDate(test.anchor)
		if err != nil {
			t.Fatalf("ParseCivilDate(%q) error = %v", test.anchor, err)
		}
		result, err := date.AddMonths(test.months)
		if err != nil {
			t.Fatalf("AddMonths(%d) error = %v", test.months, err)
		}
		if result.String() != test.want {
			t.Fatalf("%s.AddMonths(%d) = %s, want %s", test.anchor, test.months, result.String(), test.want)
		}
	}
}

func TestParseCivilDateStrict(t *testing.T) {
	invalid := []string{
		"", "2026-1-01", "2026-01-1", "2026/01/01", "2026-02-29",
		"1900-02-29", "0000-01-01", "10000-01-01", "2026-00-01", "2026-04-31",
		"2026-01-01T00:00:00Z",
	}
	for _, value := range invalid {
		if _, err := ParseCivilDate(value); err == nil {
			t.Fatalf("ParseCivilDate(%q) unexpectedly succeeded", value)
		}
	}
	valid := []string{"0001-01-01", "2000-02-29", "2026-12-31", "9999-12-31"}
	for _, value := range valid {
		date, err := ParseCivilDate(value)
		if err != nil {
			t.Fatalf("ParseCivilDate(%q) error = %v", value, err)
		}
		if date.String() != value {
			t.Fatalf("ParseCivilDate(%q).String() = %q", value, date.String())
		}
	}
}

func TestCivilDateRejectsUnsupportedOffset(t *testing.T) {
	date, err := ParseCivilDate("9999-12-31")
	if err != nil {
		t.Fatalf("ParseCivilDate() error = %v", err)
	}
	if _, err = date.AddMonths(1); err == nil {
		t.Fatal("AddMonths() unexpectedly crossed year 9999")
	}
	if _, err = date.AddMonths(-1); err == nil {
		t.Fatal("AddMonths() unexpectedly accepted a negative offset")
	}
}
