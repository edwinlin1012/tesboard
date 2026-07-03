import { describe, expect, it } from 'vitest'
import { buildDriveDetail, downsampleSeries, fmtClockStamp, fmtElapsedMin } from './drive-detail-vm'
import type { DriveDetailPayload, DriveSampleRaw } from '../functions/drive-detail.functions'
import type { DriveWithLocation } from '../functions/drives.functions'

const KM_PER_MI = 1.60934

function drive(over: Partial<DriveWithLocation> = {}): DriveWithLocation {
  return {
    id: 1,
    vin: 'V1',
    user_id: 'u1',
    started_at: '2026-06-18T14:00:00Z',
    ended_at: '2026-06-18T14:30:00Z',
    start_odometer: 1000,
    end_odometer: 1020,
    distance_mi: 20,
    duration_s: 1800,
    start_lat: 1,
    start_lng: 2,
    end_lat: 3,
    end_lng: 4,
    start_battery_level: 80,
    end_battery_level: 62,
    start_range_mi: 240,
    end_range_mi: 186,
    energy_used_kwh: 6,
    wh_per_mi: 300,
    outside_temp_avg: 18,
    inside_temp_avg: 21,
    speed_max_mph: 70,
    power_max_kw: 120,
    power_min_kw: -40,
    ascent: 150,
    descent: 90,
    start_snapshot_id: null,
    end_snapshot_id: null,
    start_address_id: null,
    end_address_id: null,
    start_geofence_id: null,
    end_geofence_id: null,
    import_source: 'live',
    source_pk: null,
    route_geometry: null,
    route_match_status: null,
    route_matched_at: null,
    created_at: '2026-06-18T14:30:00Z',
    startLocation: 'Home',
    endLocation: 'Work',
    ...over,
  }
}

function sample(over: Partial<DriveSampleRaw> = {}): DriveSampleRaw {
  return { tMin: 0, battery: null, speedMph: null, elevationM: null, insideC: null, outsideC: null, powerKw: null, lat: null, lng: null, ...over }
}

function payload(over: Partial<DriveDetailPayload> = {}): DriveDetailPayload {
  return { drive: drive(), samples: [], points: [], sampled: false, estCost: null, ...over }
}

describe('downsampleSeries', () => {
  it('returns a copy unchanged when at or under the cap', () => {
    const rows = [1, 2, 3]
    const out = downsampleSeries(rows, 5)
    expect(out).toEqual([1, 2, 3])
    expect(out).not.toBe(rows)
  })

  it('strides down to the cap and keeps first + last', () => {
    const rows = Array.from({ length: 100 }, (_, i) => i)
    const out = downsampleSeries(rows, 10)
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out[0]).toBe(0)
    expect(out[out.length - 1]).toBe(99)
  })

  it('drops consecutive duplicates introduced by rounding', () => {
    const rows = [0, 0, 0, 1]
    expect(downsampleSeries(rows, 3)).toEqual([0, 1])
  })
})

describe('fmtElapsedMin', () => {
  it('formats sub-hour as minutes', () => {
    expect(fmtElapsedMin(0)).toBe('0m')
    expect(fmtElapsedMin(12.4)).toBe('12m')
    expect(fmtElapsedMin(59)).toBe('59m')
  })
  it('formats hours + minutes', () => {
    expect(fmtElapsedMin(60)).toBe('1h')
    expect(fmtElapsedMin(64)).toBe('1h 4m')
    expect(fmtElapsedMin(125)).toBe('2h 5m')
  })
  it('clamps negatives to zero', () => {
    expect(fmtElapsedMin(-5)).toBe('0m')
  })
})

describe('fmtClockStamp', () => {
  it('renders an absolute date + time at a tz (UTC)', () => {
    const ms = new Date('2026-06-18T14:05:00Z').getTime()
    expect(fmtClockStamp(ms, 'UTC')).toBe('Jun 18, 2:05 PM')
  })
  it('adds elapsed minutes onto a start instant', () => {
    const start = new Date('2026-06-18T14:00:00Z').getTime()
    expect(fmtClockStamp(start + 51 * 60000, 'UTC')).toBe('Jun 18, 2:51 PM')
  })
  it('returns empty string for an invalid timestamp', () => {
    expect(fmtClockStamp(NaN, 'UTC')).toBe('')
  })
})

describe('buildDriveDetail', () => {
  it('reports not-found for a null drive', () => {
    const vm = buildDriveDetail(payload({ drive: null }))
    expect(vm.found).toBe(false)
    expect(vm.series.battery).toEqual([])
  })

  it('computes distance, duration and average speed in canonical units', () => {
    const vm = buildDriveDetail(payload())
    expect(vm.distKm).toBeCloseTo(20 * KM_PER_MI, 1) // 20 mi → ~32.2 km
    expect(vm.durMin).toBe(30)
    // 32.19 km over 0.5 h ≈ 64 km/h
    expect(vm.avgKph).toBe(Math.round((20 * KM_PER_MI) / 0.5))
  })

  it('prefers the recorded peak for max speed, else the highest sample', () => {
    const recorded = buildDriveDetail(payload({ samples: [sample({ speedMph: 50 })] }))
    expect(recorded.maxKph).toBe(Math.round(70 * KM_PER_MI)) // speed_max_mph wins

    const fromSamples = buildDriveDetail(
      payload({ drive: drive({ speed_max_mph: null }), samples: [sample({ speedMph: 55 })] }),
    )
    expect(fromSamples.maxKph).toBe(Math.round(55 * KM_PER_MI))
  })

  it('builds per-metric series and drops null samples', () => {
    const vm = buildDriveDetail(
      payload({
        samples: [
          sample({ tMin: 0, battery: 80, speedMph: 0, insideC: 20, outsideC: 15 }),
          sample({ tMin: 10, battery: 70, speedMph: 60, elevationM: 120 }),
          sample({ tMin: 20, speedMph: 40, elevationM: 140 }),
        ],
      }),
    )
    expect(vm.series.battery).toEqual([
      { x: 0, y: 80 },
      { x: 10, y: 70 },
    ])
    expect(vm.series.speedKph).toHaveLength(3)
    expect(vm.series.speedKph[1].y).toBeCloseTo(60 * KM_PER_MI, 1)
    expect(vm.series.elevationM).toEqual([
      { x: 10, y: 120 },
      { x: 20, y: 140 },
    ])
    expect(vm.peakElevM).toBe(140)
    expect(vm.series.insideC).toEqual([{ x: 0, y: 20 }])
    expect(vm.series.outsideC).toEqual([{ x: 0, y: 15 }])
  })

  it('builds the power series and derives peak power + peak regen from samples', () => {
    const vm = buildDriveDetail(
      payload({
        drive: drive({ power_max_kw: null, power_min_kw: null }),
        samples: [
          sample({ tMin: 0, powerKw: 0 }),
          sample({ tMin: 5, powerKw: 80 }), // drawing power
          sample({ tMin: 10, powerKw: -28 }), // regen
        ],
      }),
    )
    expect(vm.series.powerKw).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 80 },
      { x: 10, y: -28 },
    ])
    expect(vm.peakPowerKw).toBe(80)
    expect(vm.peakRegenKw).toBe(28) // most-negative power, as a positive magnitude
  })

  it('prefers the stored power aggregates and reports no regen when never negative', () => {
    const vm = buildDriveDetail(payload({ drive: drive({ power_max_kw: 150, power_min_kw: 5 }), samples: [sample({ powerKw: 40 })] }))
    expect(vm.peakPowerKw).toBe(150) // stored max wins
    expect(vm.peakRegenKw).toBeNull() // min power 5 kW ≥ 0 → no regen captured
  })

  it('passes the estimated cost through, rounded to cents', () => {
    const vm = buildDriveDetail(payload({ estCost: { amount: 1.8369, currency: 'USD', rate: 0.28 } }))
    expect(vm.estCost).toEqual({ amount: 1.84, currency: 'USD' })
  })

  it('leaves estCost null when none was computed', () => {
    expect(buildDriveDetail(payload()).estCost).toBeNull()
  })

  it('titles by place and builds a same-day time range (UTC)', () => {
    const vm = buildDriveDetail(payload(), 'UTC')
    expect(vm.title).toBe('Home → Work')
    expect(vm.subtitle).toBe('Jun 18 · 2:00 PM – 2:30 PM')
  })

  it('collapses a same start/end place to one name', () => {
    const vm = buildDriveDetail(payload({ drive: drive({ startLocation: 'Home', endLocation: 'Home' }) }), 'UTC')
    expect(vm.title).toBe('Home')
  })

  it('falls back to a date title when no place is known', () => {
    const vm = buildDriveDetail(
      payload({ drive: drive({ startLocation: null, endLocation: null }) }),
      'UTC',
    )
    expect(vm.title).toBe('Jun 18 · 2:00 PM')
  })

  it('uses the stored ascent/descent when present', () => {
    const vm = buildDriveDetail(
      payload({ samples: [sample({ tMin: 0, elevationM: 100 }), sample({ tMin: 10, elevationM: 200 })] }),
    )
    expect(vm.ascentM).toBe(150) // drive() fixture's stored ascent wins
    expect(vm.descentM).toBe(90)
  })

  it('derives ascent/descent from the elevation series when not stored (live drive)', () => {
    const vm = buildDriveDetail(
      payload({
        drive: drive({ ascent: null, descent: null }),
        samples: [
          sample({ tMin: 0, elevationM: 100 }),
          sample({ tMin: 5, elevationM: 130 }), // +30
          sample({ tMin: 10, elevationM: 110 }), // -20
          sample({ tMin: 15, elevationM: 140 }), // +30
        ],
      }),
    )
    expect(vm.ascentM).toBe(60) // 30 + 30
    expect(vm.descentM).toBe(20)
    expect(vm.peakElevM).toBe(140)
  })

  it('computes rated range used and range efficiency %', () => {
    // 240 → 186 rated mi = 54 mi ≈ 86.9 km used; 20 mi driven ≈ 32.2 km.
    const vm = buildDriveDetail(payload())
    expect(vm.ratedUsedKm).toBeCloseTo(54 * KM_PER_MI, 1)
    expect(vm.rangeEffPct).toBe(Math.round(((20 * KM_PER_MI) / (54 * KM_PER_MI)) * 100)) // 37%
  })

  it('leaves range efficiency null without range readings', () => {
    const vm = buildDriveDetail(payload({ drive: drive({ start_range_mi: null, end_range_mi: null }) }))
    expect(vm.ratedUsedKm).toBeNull()
    expect(vm.rangeEffPct).toBeNull()
  })

  it('formats trip endpoint stamps with weekday (UTC)', () => {
    const vm = buildDriveDetail(payload(), 'UTC')
    expect(vm.startStamp).toBe('Thu, Jun 18 · 2:00 PM')
    expect(vm.endStamp).toBe('Thu, Jun 18 · 2:30 PM')
  })

  it('converts efficiency to Wh/km', () => {
    const vm = buildDriveDetail(payload())
    expect(vm.effWhKm).toBe(Math.round(300 / KM_PER_MI)) // 300 Wh/mi → ~186 Wh/km
  })
})
