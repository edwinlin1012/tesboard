import { describe, expect, it } from 'vitest'
import { clusterChargePoints, groupRoutes, mergeNearbyPoints, simplifyPath, type RouteSnap, type RouteWindow } from './map-vm'
import type { ChargeWithLocation } from '../functions/charging.functions'

const snap = (atMs: number, lat: number, lng: number): RouteSnap => ({ lat, lng, atMs })
const win = (startMs: number, endMs: number): RouteWindow => ({ startMs, endMs })

describe('groupRoutes', () => {
  it('builds one polyline per drive window', () => {
    const snaps = [snap(10, 1, 1), snap(20, 2, 2), snap(110, 3, 3), snap(120, 4, 4)]
    const windows = [win(0, 50), win(100, 150)]
    const routes = groupRoutes(snaps, windows)
    expect(routes).toHaveLength(2)
    expect(routes[0]).toEqual([
      [1, 1],
      [2, 2],
    ])
    expect(routes[1]).toEqual([
      [3, 3],
      [4, 4],
    ])
  })

  it('drops parked fixes that fall between drives (no teleport lines)', () => {
    const snaps = [snap(10, 1, 1), snap(20, 2, 2), snap(70, 9, 9) /* parked gap */, snap(110, 3, 3), snap(120, 4, 4)]
    const windows = [win(0, 50), win(100, 150)]
    const routes = groupRoutes(snaps, windows)
    expect(routes).toHaveLength(2)
    expect(routes.flat()).not.toContainEqual([9, 9])
  })

  it('skips windows with fewer than two fixes', () => {
    const snaps = [snap(10, 1, 1) /* lone fix */, snap(110, 3, 3), snap(120, 4, 4)]
    const windows = [win(0, 50), win(100, 150)]
    const routes = groupRoutes(snaps, windows)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toEqual([
      [3, 3],
      [4, 4],
    ])
  })

  it('downsamples a long path to the cap, keeping first + last', () => {
    const snaps = Array.from({ length: 100 }, (_, i) => snap(i, i, i))
    const routes = groupRoutes(snaps, [win(0, 99)], { maxPerPath: 10 })
    expect(routes[0].length).toBeLessThanOrEqual(10)
    expect(routes[0][0]).toEqual([0, 0])
    expect(routes[0][routes[0].length - 1]).toEqual([99, 99])
  })

  it('returns nothing when there are no windows', () => {
    expect(groupRoutes([snap(10, 1, 1), snap(20, 2, 2)], [])).toEqual([])
  })
})

const charge = (
  id: number,
  lat: number | null,
  lng: number | null,
  startedAt = '2026-01-01T00:00:00Z',
): ChargeWithLocation => ({ id, lat, lng, started_at: startedAt } as ChargeWithLocation)

describe('clusterChargePoints', () => {
  it('merges charges within the radius into one marker carrying the visit count', () => {
    // base, ~55m NE, ~31m SW — all well inside the 150m default of each other.
    const out = clusterChargePoints([
      charge(1, 3.1, 101.7, '2026-01-01T00:00:00Z'),
      charge(2, 3.1004, 101.7003, '2026-02-01T00:00:00Z'),
      charge(3, 3.0998, 101.6998, '2026-03-01T00:00:00Z'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].count).toBe(3)
    expect(out[0].lat).toBeCloseTo(3.1, 3)
    expect(out[0].lng).toBeCloseTo(101.7, 3)
  })

  it('uses the most-recent session as the marker id and orders members newest-first', () => {
    const out = clusterChargePoints([
      charge(1, 3.1, 101.7, '2026-01-01T00:00:00Z'),
      charge(2, 3.1003, 101.7002, '2026-03-15T00:00:00Z'),
      charge(3, 3.0999, 101.6999, '2026-02-10T00:00:00Z'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('2')
    expect(out[0].members.map((m) => m.id)).toEqual(['2', '3', '1'])
    // members carry epoch ms, descending (newest first); the newest is the representative id opened on tap.
    expect(out[0].members[0].atMs).toBe(Date.parse('2026-03-15T00:00:00Z'))
    expect(out[0].members.map((m) => m.atMs)).toEqual([...out[0].members.map((m) => m.atMs)].sort((a, b) => b - a))
  })

  it('merges a ~128m home GPS-drift pair at the 150m default, but splits it at a tighter radius', () => {
    // Real shape of this account's home: Feb readings ~128m from the Mar–Jun ones.
    const home = [charge(1, 3.20896, 101.66891), charge(2, 3.20918, 101.66778)]
    expect(clusterChargePoints(home)).toHaveLength(1) // 150m default → one Home pin
    expect(clusterChargePoints(home, 100)).toHaveLength(2) // tighter radius splits it
  })

  it('keeps charges further than the radius apart as separate markers', () => {
    // ~1.1km apart → two markers, each a single visit.
    const out = clusterChargePoints([charge(1, 3.1, 101.7), charge(2, 3.11, 101.71)])
    expect(out).toHaveLength(2)
    expect(out.every((c) => c.count === 1)).toBe(true)
  })

  it('sorts markers by visit count descending', () => {
    const out = clusterChargePoints([
      charge(1, 3.2, 101.8), // lone
      charge(2, 3.1, 101.7),
      charge(3, 3.1004, 101.7003),
    ])
    expect(out.map((c) => c.count)).toEqual([2, 1])
  })

  it('skips charges without coordinates', () => {
    const out = clusterChargePoints([charge(1, null, null), charge(2, 1, 2), charge(3, 3, null)])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ lat: 1, lng: 2, count: 1, id: '2' })
  })
})

describe('mergeNearbyPoints', () => {
  it('merges points within the radius into one centroid carrying the count', () => {
    const out = mergeNearbyPoints([
      [3.1, 101.7],
      [3.1004, 101.7003],
      [3.0998, 101.6998],
    ])
    expect(out).toHaveLength(1)
    expect(out[0].count).toBe(3)
    expect(out[0].lat).toBeCloseTo(3.1, 3)
    expect(out[0].lng).toBeCloseTo(101.7, 3)
  })

  it('keeps points beyond the radius separate, sorted by count descending', () => {
    // two coincident + one ~1.1km away (well outside 150m).
    const out = mergeNearbyPoints([
      [3.1, 101.7],
      [3.1004, 101.7003],
      [3.11, 101.71],
    ])
    expect(out).toHaveLength(2)
    expect(out.map((p) => p.count)).toEqual([2, 1])
  })

  it('returns an empty array for no points', () => {
    expect(mergeNearbyPoints([])).toEqual([])
  })
})

describe('simplifyPath', () => {
  // ~0.001° lat ≈ 111m; tolerances below are in metres.
  it('collapses a straight line to its endpoints', () => {
    const line: [number, number][] = [
      [37.0, -122.0],
      [37.001, -122.0],
      [37.002, -122.0],
      [37.003, -122.0],
    ]
    expect(simplifyPath(line, 10)).toEqual([
      [37.0, -122.0],
      [37.003, -122.0],
    ])
  })

  it('keeps a corner vertex that deviates beyond the tolerance', () => {
    // An L-shape: the corner at [37.002, -122.0] sits far off the straight line
    // between the endpoints — it must survive simplification.
    const l: [number, number][] = [
      [37.0, -122.0],
      [37.001, -122.0],
      [37.002, -122.0], // corner
      [37.002, -122.001],
      [37.002, -122.002],
    ]
    const out = simplifyPath(l, 10)
    expect(out[0]).toEqual([37.0, -122.0])
    expect(out[out.length - 1]).toEqual([37.002, -122.002])
    expect(out).toContainEqual([37.002, -122.0])
  })

  it('drops wiggles smaller than the tolerance', () => {
    // ~5m lateral jitter on an otherwise straight north-bound line.
    const jitterDeg = 5 / 111_320
    const wiggly: [number, number][] = [
      [37.0, -122.0],
      [37.001, -122.0 + jitterDeg],
      [37.002, -122.0 - jitterDeg],
      [37.003, -122.0],
    ]
    expect(simplifyPath(wiggly, 15)).toEqual([
      [37.0, -122.0],
      [37.003, -122.0],
    ])
  })

  it('returns short inputs unchanged', () => {
    const two: [number, number][] = [
      [1, 1],
      [2, 2],
    ]
    expect(simplifyPath(two, 100)).toEqual(two)
    expect(simplifyPath([], 100)).toEqual([])
  })

  it('handles identical endpoints (a loop) without dividing by zero', () => {
    const loop: [number, number][] = [
      [37.0, -122.0],
      [37.002, -122.0],
      [37.002, -122.002],
      [37.0, -122.0],
    ]
    const out = simplifyPath(loop, 10)
    expect(out.length).toBeGreaterThanOrEqual(3)
    expect(out[0]).toEqual(out[out.length - 1])
  })
})
