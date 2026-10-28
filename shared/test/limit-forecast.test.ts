import { expect, test } from 'bun:test'
import { LimitForecast } from '../limit-forecast'
import table from './limit-forecast.json'

test('when the 5-hour window runs out, as the Swift side computes it', () => {
  for (const { name, readings, ask, runsOut } of table.cases) {
    const forecast = new LimitForecast()
    for (const r of readings) forecast.record([{ usedPercent: r.usedPercent, resetsAt: r.resetsAt }], Date.parse(r.at))
    const end = forecast.runsOut({ usedPercent: ask.usedPercent, resetsAt: ask.resetsAt }, Date.parse(ask.at))
    expect([name, end?.toISOString().replace('.000Z', 'Z') ?? null]).toEqual([name, runsOut])
  }
})
