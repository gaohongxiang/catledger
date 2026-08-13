package calculation

import "fmt"

// CivilDate 是不携带时区的公历日期，避免服务器时区和 DST 改变还款日。
type CivilDate struct {
	Year  int
	Month int
	Day   int
}

// ParseCivilDate 严格解析 YYYY-MM-DD，不接受时区、时间或宽松补零。
func ParseCivilDate(value string) (CivilDate, error) {
	if len(value) != 10 || value[4] != '-' || value[7] != '-' {
		return CivilDate{}, fmt.Errorf("invalid civil date format")
	}

	for index := 0; index < len(value); index++ {
		if index == 4 || index == 7 {
			continue
		}
		if value[index] < '0' || value[index] > '9' {
			return CivilDate{}, fmt.Errorf("invalid civil date digit")
		}
	}

	date := CivilDate{
		Year:  decimalDigits(value[0:4]),
		Month: decimalDigits(value[5:7]),
		Day:   decimalDigits(value[8:10]),
	}
	if !date.Valid() {
		return CivilDate{}, fmt.Errorf("invalid civil date value")
	}
	return date, nil
}

func decimalDigits(value string) int {
	result := 0
	for index := 0; index < len(value); index++ {
		result = result*10 + int(value[index]-'0')
	}
	return result
}

// Valid 判断日期是否位于四位公历年份范围内。
func (date CivilDate) Valid() bool {
	return date.Year >= 1 && date.Year <= 9999 &&
		date.Month >= 1 && date.Month <= 12 &&
		date.Day >= 1 && date.Day <= daysInMonth(date.Year, date.Month)
}

func (date CivilDate) String() string {
	if !date.Valid() {
		return ""
	}
	return fmt.Sprintf("%04d-%02d-%02d", date.Year, date.Month, date.Day)
}

// AddMonths 从当前日期的原始日锚点直接偏移月份；目标月缺少该日时取月末。
// 调用方应始终对首次还款日调用本方法，而不是把上期结果继续链式偏移。
func (date CivilDate) AddMonths(months int64) (CivilDate, error) {
	if !date.Valid() || months < 0 {
		return CivilDate{}, fmt.Errorf("invalid civil date month offset")
	}

	baseMonth := int64(date.Year-1)*12 + int64(date.Month-1)
	targetMonth := baseMonth + months
	if targetMonth < baseMonth {
		return CivilDate{}, fmt.Errorf("civil date month overflow")
	}

	year := targetMonth/12 + 1
	month := targetMonth%12 + 1
	if year > 9999 {
		return CivilDate{}, fmt.Errorf("civil date year overflow")
	}

	day := date.Day
	lastDay := daysInMonth(int(year), int(month))
	if day > lastDay {
		day = lastDay
	}
	return CivilDate{Year: int(year), Month: int(month), Day: day}, nil
}

func daysInMonth(year, month int) int {
	switch month {
	case 2:
		if isLeapYear(year) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	default:
		return 31
	}
}

func isLeapYear(year int) bool {
	return year%400 == 0 || (year%4 == 0 && year%100 != 0)
}
