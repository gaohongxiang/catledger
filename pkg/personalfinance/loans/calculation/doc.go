// Package calculation 实现 loan-calculation-v1 的纯 Go 权威计算内核。
//
// 首版只处理每月一期的 flat、equal_payment、equal_principal 和
// interest_only，支持 rate/repayment 两种依据、必付费用和三种互斥优惠。
// 金额使用最小货币单位整数，比例使用 pptr，所有金额公式使用 math/big
// 有理数和 half-up 舍入。本包不读取数据库或正式账本，也不实现自定义计划、
// XIRR、提前还款或不规则频率。
package calculation
