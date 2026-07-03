/**
 * Pure view-model for the 3D drive replay. Turns the drive's timestamped GPS
 * fixes (+ the map-matched `route_geometry` when present) into a continuous
 * position/bearing function of elapsed time, so the map component can animate
 * a car marker smoothly:
 *
 * - With a matched route, each fix is projected onto the route polyline and the
 *   car interpolates *along the road shape* between fixes — so sparse 2-min
 *   polled drives still replay on the road instead of cutting straight lines.
 * - Without one, the fix breadcrumb itself is the path (dense telemetry drives
 *   at 10 s cadence look smooth either way).
 *
 * No React / no server imports — unit-testable (see replay-vm.test.ts).
 */

/** One timestamped GPS fix ([lat, lng], minutes from the drive start). */
export interface TrackFix {
  tMin: number
  lat: number
  lng: number
}

export interface ReplayTrack {
  /** Timestamped fixes, strictly increasing tMin. */
  fixes: TrackFix[]
  /** The polyline the car animates along ([lat, lng]; route_geometry or the breadcrumb). */
  path: [number, number][]
  /** Cumulative meters along `path` per vertex (same length as path). */
  cum: number[]
  /** Each fix's offset (m) along `path`, non-decreasing (same length as fixes). */
  offsets: number[]
  /** Replay duration = last fix's tMin. */
  durMin: number
  /** Total path length (m). */
  lengthM: number
}

export interface ReplayPos {
  lat: number
  lng: number
  /** Compass bearing (deg, 0 = north) of travel, or null when stationary. */
  bearing: number | null
  /** Offset (m) along the path — lets the map draw the traveled portion. */
  offsetM: number
}

const EARTH_M_PER_DEG_LAT = 110_540
const EARTH_M_PER_DEG_LNG = 111_320

/** Fast local-plane meters between two [lat, lng] points (fine at drive scale). */
export function metersBetween(a: [number, number], b: [number, number]): number {
  const cosLat = Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180))
  const dy = (b[0] - a[0]) * EARTH_M_PER_DEG_LAT
  const dx = (b[1] - a[1]) * EARTH_M_PER_DEG_LNG * cosLat
  return Math.hypot(dx, dy)
}

/** Compass bearing (deg, 0 = north, clockwise) from a to b, local-plane approx. */
export function bearingBetween(a: [number, number], b: [number, number]): number {
  const cosLat = Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180))
  const dy = (b[0] - a[0]) * EARTH_M_PER_DEG_LAT
  const dx = (b[1] - a[1]) * EARTH_M_PER_DEG_LNG * cosLat
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI
  return (deg + 360) % 360
}

function cumulativeMeters(path: [number, number][]): number[] {
  const cum = new Array<number>(path.length)
  cum[0] = 0
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + metersBetween(path[i - 1], path[i])
  return cum
}

/**
 * Project `p` onto the path segment [a, b]; returns the fraction along the
 * segment (clamped 0..1) and the perpendicular distance (m).
 */
function projectOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): { frac: number; distM: number } {
  const cosLat = Math.cos((a[0] * Math.PI) / 180)
  const ax = a[1] * EARTH_M_PER_DEG_LNG * cosLat
  const ay = a[0] * EARTH_M_PER_DEG_LAT
  const bx = b[1] * EARTH_M_PER_DEG_LNG * cosLat
  const by = b[0] * EARTH_M_PER_DEG_LAT
  const px = p[1] * EARTH_M_PER_DEG_LNG * cosLat
  const py = p[0] * EARTH_M_PER_DEG_LAT
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  const frac = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0
  const cx = ax + vx * frac
  const cy = ay + vy * frac
  return { frac, distM: Math.hypot(px - cx, py - cy) }
}

/** How far a fix may sit from the matched route before we distrust the match. */
const MAX_MATCH_DIST_M = 200

/**
 * Build the replay track. `samples` is the detail payload's telemetry stream
 * (only entries with a GPS fix are used); `route` is the drive's map-matched
 * `route_geometry` ([lat, lng][]) or null. Returns null when fewer than two
 * usable fixes exist (nothing to animate) or the drive never moves.
 */
export function buildReplayTrack(
  samples: Array<{ tMin: number; lat: number | null; lng: number | null }>,
  route: [number, number][] | null,
): ReplayTrack | null {
  // Usable fixes: has GPS, strictly increasing time (dedupe equal stamps).
  const fixes: TrackFix[] = []
  for (const s of samples) {
    if (s.lat == null || s.lng == null) continue
    if (fixes.length && s.tMin <= fixes[fixes.length - 1].tMin) continue
    fixes.push({ tMin: s.tMin, lat: s.lat, lng: s.lng })
  }
  if (fixes.length < 2) return null

  const breadcrumb = fixes.map((f) => [f.lat, f.lng] as [number, number])

  // Prefer the road-shaped matched route; fall back to the raw breadcrumb when
  // it's absent, degenerate, or the fixes don't actually lie near it.
  let path = route && route.length >= 2 ? route : breadcrumb
  let { offsets, meanDistM } = projectFixes(fixes, path)
  if (path !== breadcrumb && meanDistM > MAX_MATCH_DIST_M) {
    path = breadcrumb
    ;({ offsets } = projectFixes(fixes, path))
  }

  const cum = cumulativeMeters(path)
  const lengthM = cum[cum.length - 1]
  if (lengthM <= 0) return null

  // Pin the endpoints so the replay spans the whole line even when the first /
  // last fix projects slightly inside it.
  offsets[0] = 0
  offsets[offsets.length - 1] = lengthM

  return { fixes, path, cum, offsets, durMin: fixes[fixes.length - 1].tMin, lengthM }
}

/**
 * Project every fix onto `path`, forcing offsets to be non-decreasing by only
 * searching forward of the previous fix's segment — so an out-and-back drive
 * (same road twice) can't snap a later fix backwards.
 */
function projectFixes(
  fixes: TrackFix[],
  path: [number, number][],
): { offsets: number[]; meanDistM: number } {
  const cum = cumulativeMeters(path)
  const offsets = new Array<number>(fixes.length)
  let startSeg = 0
  let distSum = 0
  for (let i = 0; i < fixes.length; i++) {
    const p: [number, number] = [fixes[i].lat, fixes[i].lng]
    let best = { seg: startSeg, frac: 0, distM: Infinity }
    for (let s = startSeg; s < path.length - 1; s++) {
      const r = projectOnSegment(p, path[s], path[s + 1])
      if (r.distM < best.distM) best = { seg: s, frac: r.frac, distM: r.distM }
    }
    distSum += best.distM
    const off = cum[best.seg] + (cum[best.seg + 1] - cum[best.seg]) * best.frac
    offsets[i] = i > 0 ? Math.max(off, offsets[i - 1]) : off
    startSeg = best.seg
  }
  return { offsets, meanDistM: distSum / fixes.length }
}

/** Binary search: greatest index with arr[i] <= v (arr non-decreasing). */
function lowerIndex(arr: number[], v: number): number {
  let lo = 0
  let hi = arr.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (arr[mid] <= v) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The [lat, lng] + travel bearing at `offsetM` meters along the track's path. */
export function pointAtOffset(track: ReplayTrack, offsetM: number): ReplayPos {
  const { path, cum, lengthM } = track
  const off = Math.min(lengthM, Math.max(0, offsetM))
  let i = lowerIndex(cum, off)
  if (i >= path.length - 1) i = path.length - 2
  const a = path[i]
  const b = path[i + 1]
  const segLen = cum[i + 1] - cum[i]
  const frac = segLen > 0 ? (off - cum[i]) / segLen : 0
  const lat = a[0] + (b[0] - a[0]) * frac
  const lng = a[1] + (b[1] - a[1]) * frac
  const bearing = segLen > 0 ? bearingBetween(a, b) : null
  return { lat, lng, bearing, offsetM: off }
}

/**
 * The car's position at `tMin` elapsed minutes: linear offset interpolation in
 * time between the bracketing fixes, then a point lookup along the path.
 */
export function positionAt(track: ReplayTrack, tMin: number): ReplayPos {
  const { fixes, offsets } = track
  if (tMin <= fixes[0].tMin) return pointAtOffset(track, offsets[0])
  const last = fixes.length - 1
  if (tMin >= fixes[last].tMin) return pointAtOffset(track, offsets[last])
  const times = fixes.map((f) => f.tMin)
  const i = lowerIndex(times, tMin)
  const t0 = fixes[i].tMin
  const t1 = fixes[i + 1].tMin
  const frac = t1 > t0 ? (tMin - t0) / (t1 - t0) : 0
  return pointAtOffset(track, offsets[i] + (offsets[i + 1] - offsets[i]) * frac)
}

/**
 * The traveled portion of the path up to `offsetM` — path vertices before the
 * playhead plus the interpolated playhead point, as [lat, lng]. Used for the
 * brighter "progress" line under the car.
 */
export function pathUpTo(track: ReplayTrack, offsetM: number): [number, number][] {
  const { path, cum, lengthM } = track
  const off = Math.min(lengthM, Math.max(0, offsetM))
  const i = lowerIndex(cum, off)
  const head = path.slice(0, i + 1)
  const p = pointAtOffset(track, off)
  head.push([p.lat, p.lng])
  return head
}

/** Nearest sample (by tMin) at the playhead — powers the replay HUD readouts. */
export function sampleAt<T extends { tMin: number }>(samples: T[], tMin: number): T | null {
  if (!samples.length) return null
  let best = samples[0]
  let bestD = Math.abs(samples[0].tMin - tMin)
  for (const s of samples) {
    const d = Math.abs(s.tMin - tMin)
    if (d < bestD) {
      best = s
      bestD = d
    }
  }
  return best
}

/** "0:00" / "12:34" / "1:02:03" — elapsed mm:ss (or h:mm:ss) for the replay clock. */
export function fmtReplayClock(tMin: number): string {
  const totalS = Math.max(0, Math.round(tMin * 60))
  const h = Math.floor(totalS / 3600)
  const m = Math.floor((totalS % 3600) / 60)
  const s = totalS % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}
