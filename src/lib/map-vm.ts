/**
 * Pure helpers for the lifetime Map views (drives + charging). Kept React-free /
 * server-free so they're unit-testable: the drives map groups raw GPS snapshots
 * into one polyline per drive, and the charging map collapses charge sessions into
 * location clusters with counts. The server fn / route feed these and the
 * LifetimeMap component renders the result.
 */
import { downsampleSeries } from './drive-detail-vm'
import type { ChargeWithLocation } from '../functions/charging.functions'

export type LatLng = [number, number]

export interface RouteSnap {
  lat: number
  lng: number
  /** Epoch ms of the snapshot (recorded_at). */
  atMs: number
}

export interface RouteWindow {
  /** Epoch ms of the drive's start / end. */
  startMs: number
  endMs: number
}

/**
 * A merged charging-location marker: every charge session within the cluster
 * radius of each other, collapsed to one point (one place). The map renders each
 * place as a plain pin — the leaflet cluster badge counts how many *places*
 * overlap at the current zoom, not sessions; `count` here only feeds the "N
 * charges" summary text, and tapping a pin opens the most-recent session (`id`).
 */
export interface ChargeCluster {
  /** Centroid (running mean) of the merged sessions. */
  lat: number
  lng: number
  /** How many charge sessions this marker merges (drives summary text, not the marker badge). */
  count: number
  /** Representative session id (the most-recent charge here) — opened when the place's pin is tapped. */
  id: string
  /** Every merged session, most-recent first (the newest is the representative `id`). */
  members: { id: string; atMs: number }[]
}

/**
 * Assign each GPS snapshot to the drive whose [start, end] window contains it,
 * producing one ordered polyline per drive. Both inputs MUST be sorted ascending
 * by time (snaps by atMs, windows by startMs); drives are non-overlapping, so a
 * single forward sweep is enough. Snapshots that fall between drives (parked) are
 * dropped — they'd draw teleport lines across the map. Each path is downsampled to
 * `maxPerPath` points and paths are capped at `maxPaths`; paths with <2 points are
 * skipped (can't draw a line from one fix).
 */
export function groupRoutes(
  snaps: RouteSnap[],
  windows: RouteWindow[],
  opts?: { maxPerPath?: number; maxPaths?: number },
): LatLng[][] {
  const maxPerPath = opts?.maxPerPath ?? 60
  const maxPaths = opts?.maxPaths ?? 1000
  const routes: LatLng[][] = []
  let wi = 0
  let cur: LatLng[] = []
  for (const s of snaps) {
    // Leave any windows this snapshot is already past, flushing their points.
    while (wi < windows.length && s.atMs > windows[wi].endMs) {
      if (cur.length >= 2) routes.push(cur)
      cur = []
      wi++
    }
    if (wi >= windows.length) break
    if (s.atMs >= windows[wi].startMs) cur.push([s.lat, s.lng])
    // else: before this window (a parked gap between drives) → skip.
  }
  if (cur.length >= 2) routes.push(cur)
  return routes.slice(0, maxPaths).map((r) => downsampleSeries(r, maxPerPath))
}

/**
 * Douglas–Peucker polyline simplification with a tolerance in metres. Unlike a
 * uniform-stride downsample (which drops vertices blindly and cuts corners off a
 * road-matched route), this keeps every point that deviates more than `toleranceM`
 * from the straight line between its kept neighbours — so curves and turns survive
 * while straight stretches collapse to their endpoints. Distances use a flat
 * equirectangular approximation (fine at street scale). Iterative, so a
 * many-thousand-point full-overview match can't blow the stack.
 */
export function simplifyPath(points: LatLng[], toleranceM: number): LatLng[] {
  if (points.length <= 2) return points
  const midLat = points[Math.floor(points.length / 2)][0]
  const mPerDegLng = Math.cos((midLat * Math.PI) / 180) * 111_320
  const mPerDegLat = 110_540
  const tol2 = toleranceM * toleranceM
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    if (b - a < 2) continue
    const [aLat, aLng] = points[a]
    const [bLat, bLng] = points[b]
    const dx = (bLng - aLng) * mPerDegLng
    const dy = (bLat - aLat) * mPerDegLat
    const len2 = dx * dx + dy * dy
    let maxD2 = -1
    let maxI = -1
    for (let i = a + 1; i < b; i++) {
      const ex = (points[i][1] - aLng) * mPerDegLng
      const ey = (points[i][0] - aLat) * mPerDegLat
      // Perpendicular distance to the a→b line (or plain distance when a === b).
      const d2 = len2 === 0 ? ex * ex + ey * ey : ((ex * dy - ey * dx) ** 2) / len2
      if (d2 > maxD2) {
        maxD2 = d2
        maxI = i
      }
    }
    if (maxD2 > tol2) {
      keep[maxI] = 1
      stack.push([a, maxI], [maxI, b])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

/** Great-circle metres between two points — a mirror of server/geo.haversineMeters,
 *  inlined to keep this client-side lib free of any server import. */
function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

interface ClusterAcc {
  sumLat: number
  sumLng: number
  lat: number
  lng: number
  ids: { id: string; at: number }[]
}

/**
 * Merge located charge sessions within `radiusMeters` of each other into one map
 * marker, so repeated charges at the same physical spot (the same Supercharger,
 * your driveway) collapse to a SINGLE pin instead of a scatter of GPS-jittered
 * dots that the zoom-based cluster layer pulls apart once you zoom in. Greedy
 * single pass: each session joins the nearest existing cluster whose centroid is
 * within the radius (centroid kept as a running mean), else it opens a new
 * cluster. Sessions without coordinates are skipped. Within a cluster the
 * representative `id` is the most-recent charge, so tapping the marker opens the
 * latest visit. Output is sorted by `count` descending (deterministic, render-friendly).
 *
 * Default radius is 150m: charges at one spot (a Supercharger, your driveway) drift
 * by GPS jitter — this user's home readings span ~128m across months — so a tighter
 * 100m would split one place into two pins, while distinct places sit ≥500m apart.
 */
export function clusterChargePoints(
  sessions: ChargeWithLocation[],
  radiusMeters = 150,
): ChargeCluster[] {
  const clusters: ClusterAcc[] = []
  for (const s of sessions) {
    if (s.lat == null || s.lng == null) continue
    let best: ClusterAcc | null = null
    let bestD = Infinity
    for (const c of clusters) {
      const d = metersBetween(s.lat, s.lng, c.lat, c.lng)
      if (d <= radiusMeters && d < bestD) {
        best = c
        bestD = d
      }
    }
    const parsed = s.started_at ? Date.parse(s.started_at) : 0
    const entry = { id: String(s.id), at: Number.isNaN(parsed) ? 0 : parsed }
    if (best) {
      best.ids.push(entry)
      best.sumLat += s.lat
      best.sumLng += s.lng
      best.lat = best.sumLat / best.ids.length
      best.lng = best.sumLng / best.ids.length
    } else {
      clusters.push({ sumLat: s.lat, sumLng: s.lng, lat: s.lat, lng: s.lng, ids: [entry] })
    }
  }
  return clusters
    .map((c) => {
      const ordered = c.ids.slice().sort((a, b) => b.at - a.at)
      return {
        lat: c.lat,
        lng: c.lng,
        count: ordered.length,
        id: ordered[0].id,
        members: ordered.map((e) => ({ id: e.id, atMs: e.at })),
      }
    })
    .sort((a, b) => b.count - a.count)
}

/** A proximity-merged map point: nearby raw points collapsed to one centroid. */
export interface MergedPoint {
  lat: number
  lng: number
  /** How many raw points merged into this centroid. */
  count: number
}

/**
 * Merge raw lat/lng points within `radiusMeters` of each other into one centroid —
 * the same greedy, running-mean pass clusterChargePoints uses, but for bare
 * coordinates (e.g. drive start/end endpoints, where most routes share the same
 * driveway / destination, so 600+ raw endpoints collapse to a handful of places).
 * Output is sorted by `count` descending. Default radius matches the charge merge
 * (150m) so a place reads the same on both maps.
 */
export function mergeNearbyPoints(points: LatLng[], radiusMeters = 150): MergedPoint[] {
  const clusters: { sumLat: number; sumLng: number; lat: number; lng: number; n: number }[] = []
  for (const [lat, lng] of points) {
    let best: (typeof clusters)[number] | null = null
    let bestD = Infinity
    for (const c of clusters) {
      const d = metersBetween(lat, lng, c.lat, c.lng)
      if (d <= radiusMeters && d < bestD) {
        best = c
        bestD = d
      }
    }
    if (best) {
      best.sumLat += lat
      best.sumLng += lng
      best.n++
      best.lat = best.sumLat / best.n
      best.lng = best.sumLng / best.n
    } else {
      clusters.push({ sumLat: lat, sumLng: lng, lat, lng, n: 1 })
    }
  }
  return clusters.map((c) => ({ lat: c.lat, lng: c.lng, count: c.n })).sort((a, b) => b.count - a.count)
}
