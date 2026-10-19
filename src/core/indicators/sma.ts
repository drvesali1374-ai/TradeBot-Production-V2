/**
 * SMA — index-aligned simple moving average.
 * sma[i] = mean(x[i-period+1 .. i]); null while window incomplete.
 * Values may be raw numbers (volume SMA) — reference used candle.amount.
 */
export function calculateSMA(values: number[], period: number): (number | null)[] {
  const n = values.length
  const sma: (number | null)[] = new Array(n).fill(null)
  if (period < 1 || n < period) return sma

  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) sma[i] = sum / period
  }
  return sma
}
