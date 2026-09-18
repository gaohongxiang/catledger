function npv(rate, cashflows) {
  let total = 0
  for (let index = 0; index < cashflows.length; index += 1) {
    total += cashflows[index] / Math.pow(1 + rate, index)
  }
  return total
}

function monthlyIrr(cashflows) {
  if (!cashflows || cashflows.length < 2 || !(cashflows[0] > 0)) return 0
  if (Math.abs(npv(0, cashflows)) < 0.000001 || npv(0, cashflows) > 0) return 0
  let low = 0
  let high = 1
  let highValue = npv(high, cashflows)
  while (highValue < 0 && high < 1024) {
    high *= 2
    highValue = npv(high, cashflows)
  }
  if (highValue < 0) return 0
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const middle = (low + high) / 2
    if (npv(middle, cashflows) > 0) high = middle
    else low = middle
  }
  return (low + high) / 2
}

module.exports = { monthlyIrr }
