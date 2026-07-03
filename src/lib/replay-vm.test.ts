import { describe, expect, it } from 'vitest'
import {
  bearingBetween,
  buildReplayTrack,
  fmtReplayClock,
  metersBetween,
  pathUpTo,
  positionAt,
  sampleAt,
} from './replay-vm'

// ~1° lng at the equator ≈ 111.32 km; keep test coords near lat 0 so the local
// plane is nearly Cartesian and expected values are easy to reason about.
const fix = (tMin: number, lat: number, lng: number) => ({ tMin, lat, lng })

describe('metersBetween / bearingBetween', () => {
  it('measures ~111.3 km per degree of longitude at the equator', () => {
    expect(metersBetween([0, 0], [0, 1])).toBeCloseTo(111_320, -3)
  })
  it('bearing east is 90°, north is 0°, west is 270°', () => {
    expect(bearingBetween([0, 0], [0, 1])).toBeCloseTo(90)
    expect(bearingBetween([0, 0], [1, 0])).toBeCloseTo(0)
    expect(bearingBetween([0, 0], [0, -1])).toBeCloseTo(270)
  })
})

describe('buildReplayTrack', () => {
  it('returns null with fewer than two GPS fixes', () => {
    expect(buildReplayTrack([], null)).toBeNull()
    expect(buildReplayTrack([fix(0, 0, 0)], null)).toBeNull()
    expect(buildReplayTrack([{ tMin: 0, lat: null, lng: null }, fix(1, 0, 0.1)], null)).toBeNull()
  })

  it('returns null for a stationary drive (zero-length path)', () => {
    expect(buildReplayTrack([fix(0, 1, 1), fix(5, 1, 1)], null)).toBeNull()
  })

  it('dedupes non-increasing timestamps', () => {
    const track = buildReplayTrack([fix(0, 0, 0), fix(0, 0, 0.05), fix(2, 0, 0.1)], null)
    expect(track).not.toBeNull()
    expect(track!.fixes.length).toBe(2)
    expect(track!.durMin).toBe(2)
  })

  it('uses the breadcrumb as the path when no route is given', () => {
    const track = buildReplayTrack([fix(0, 0, 0), fix(10, 0, 0.1)], null)!
    expect(track.path).toEqual([
      [0, 0],
      [0, 0.1],
    ])
    expect(track.lengthM).toBeCloseTo(11_132, -2)
    expect(track.offsets[0]).toBe(0)
    expect(track.offsets[1]).toBeCloseTo(track.lengthM)
  })

  it('falls back to the breadcrumb when fixes sit far from the route', () => {
    // Route is ~1.1 km north of every fix → distrust the match.
    const route: [number, number][] = [
      [0.01, 0],
      [0.01, 0.1],
    ]
    const track = buildReplayTrack([fix(0, 0, 0), fix(10, 0, 0.1)], route)!
    expect(track.path).toEqual([
      [0, 0],
      [0, 0.1],
    ])
  })
})

describe('positionAt', () => {
  it('lerps position in time on a straight two-fix track', () => {
    const track = buildReplayTrack([fix(0, 0, 0), fix(10, 0, 0.1)], null)!
    const mid = positionAt(track, 5)
    expect(mid.lat).toBeCloseTo(0)
    expect(mid.lng).toBeCloseTo(0.05)
    expect(mid.bearing).toBeCloseTo(90)
  })

  it('clamps before the first and after the last fix', () => {
    const track = buildReplayTrack([fix(2, 0, 0), fix(10, 0, 0.1)], null)!
    expect(positionAt(track, 0).lng).toBeCloseTo(0)
    expect(positionAt(track, 99).lng).toBeCloseTo(0.1)
  })

  it('follows the road shape between sparse fixes when a route is present', () => {
    // L-shaped route: east 0.1°, then north 0.1°. Fixes only at the ends —
    // halfway in time the car must be at the corner, not on the hypotenuse.
    const route: [number, number][] = [
      [0, 0],
      [0, 0.1],
      [0.1, 0.1],
    ]
    const track = buildReplayTrack([fix(0, 0, 0), fix(10, 0.1, 0.1)], route)!
    expect(track.path).toBe(route)
    const mid = positionAt(track, 5)
    expect(mid.lat).toBeCloseTo(0, 3)
    expect(mid.lng).toBeCloseTo(0.1, 3)
    // First half heads east, second half heads north.
    expect(positionAt(track, 2.5).bearing).toBeCloseTo(90, 0)
    expect(positionAt(track, 7.5).bearing).toBeCloseTo(0, 0)
  })

  it('keeps offsets monotonic on an out-and-back drive', () => {
    // Route goes east then back west over the same line; fixes trace it in time.
    const track = buildReplayTrack(
      [fix(0, 0, 0), fix(5, 0, 0.1), fix(10, 0, 0.001)],
      [
        [0, 0],
        [0, 0.1],
        [0, 0],
      ],
    )!
    for (let i = 1; i < track.offsets.length; i++) {
      expect(track.offsets[i]).toBeGreaterThanOrEqual(track.offsets[i - 1])
    }
    // Late in the drive the car is heading back west.
    expect(positionAt(track, 9).bearing).toBeCloseTo(270, 0)
  })
})

describe('pathUpTo', () => {
  it('returns the traveled vertices plus the interpolated playhead point', () => {
    const route: [number, number][] = [
      [0, 0],
      [0, 0.1],
      [0.1, 0.1],
    ]
    const track = buildReplayTrack([fix(0, 0, 0), fix(10, 0.1, 0.1)], route)!
    const mid = positionAt(track, 5)
    const head = pathUpTo(track, mid.offsetM)
    expect(head.length).toBeGreaterThanOrEqual(2)
    expect(head[0]).toEqual([0, 0])
    const tip = head[head.length - 1]
    expect(tip[0]).toBeCloseTo(mid.lat)
    expect(tip[1]).toBeCloseTo(mid.lng)
  })
})

describe('sampleAt / fmtReplayClock', () => {
  it('picks the nearest sample by tMin', () => {
    const samples = [{ tMin: 0 }, { tMin: 2 }, { tMin: 10 }]
    expect(sampleAt(samples, 1.2)?.tMin).toBe(2)
    expect(sampleAt(samples, 50)?.tMin).toBe(10)
    expect(sampleAt([], 1)).toBeNull()
  })
  it('formats elapsed minutes as a clock', () => {
    expect(fmtReplayClock(0)).toBe('0:00')
    expect(fmtReplayClock(12.5)).toBe('12:30')
    expect(fmtReplayClock(62.05)).toBe('1:02:03')
  })
})
