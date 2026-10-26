import { describe, expect, test } from 'bun:test'
import { cpuLoad, parsePmset, parseSysBattery, parseWin32Battery, readHealth } from '../src/service/health'

describe('machine health', () => {
  test('CPU load is the busy share between two samples', () => {
    expect(cpuLoad({ busy: 100, total: 1000 }, { busy: 400, total: 2000 })).toBe(0.3)
    expect(cpuLoad({ busy: 100, total: 1000 }, { busy: 100, total: 1000 })).toBe(0)
  })

  test('macOS battery from pmset', () => {
    const onAC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t87%; charging; 1:02 remaining present: true"
    expect(parsePmset(onAC)).toEqual({ percent: 87, charging: true })
    const onBattery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t42%; discharging; 3:10 remaining present: true"
    expect(parsePmset(onBattery)).toEqual({ percent: 42, charging: false })
    expect(parsePmset("Now drawing from 'AC Power'")).toBeNull()
  })

  test('Linux and Windows batteries', () => {
    expect(parseSysBattery('64\n', 'Discharging\n')).toEqual({ percent: 64, charging: false })
    expect(parseSysBattery('100\n', 'Full\n')).toEqual({ percent: 100, charging: true })
    expect(parseSysBattery('', '')).toBeNull()
    expect(parseWin32Battery('{"EstimatedChargeRemaining":55,"BatteryStatus":2}')).toEqual({ percent: 55, charging: true })
    expect(parseWin32Battery('')).toBeNull()
  })

  test('a real report on this machine', () => {
    const { health, sample } = readHealth({ busy: 0, total: 0 })
    expect(health.memoryTotal).toBeGreaterThan(0)
    expect(health.memoryUsed).toBeGreaterThan(0)
    expect(health.cpu).toBeGreaterThanOrEqual(0)
    expect(health.cpu).toBeLessThanOrEqual(1)
    expect(sample.total).toBeGreaterThan(0)
  })
})
