export function compareTs(a: string, b: string): number {
  const [aSeconds = '0', aMicros = '0'] = a.split('.')
  const [bSeconds = '0', bMicros = '0'] = b.split('.')
  return Number(aSeconds) - Number(bSeconds) || Number(aMicros.padEnd(6, '0')) - Number(bMicros.padEnd(6, '0'))
}

export function maxTs(...values: (string | undefined)[]): string {
  return values.reduce<string>((max, value) => (value && compareTs(value, max) > 0 ? value : max), '0')
}

export function precedingTs(ts: string): string {
  const [seconds = '0', micros = '0'] = ts.split('.')
  const previous = Number(micros) - 1
  if (previous >= 0) return `${seconds}.${String(previous).padStart(6, '0')}`
  return `${Number(seconds) - 1}.999999`
}
