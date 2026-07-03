/**
 * Drive records for the dashboard. Built by the poller from vehicle_data
 * snapshots (the Fleet API has no native trip endpoint), read here from Postgres.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { rangeVinFilter, vinFilter, type VinFilter } from './vin'
import { address, driveSession, geofence, vehicleSnapshot } from '../server/schema'
import { addressLabel } from '../server/geo'
import { groupRoutes, simplifyPath, type LatLng, type RouteWindow } from '../lib/map-vm'
import { downsampleSeries } from '../lib/drive-detail-vm'
import type { DriveSession } from '../types/db'

/** A drive row augmented with resolved start/end place names (geofence > address). */
export type DriveWithLocation = DriveSession & {
  startLocation: string | null
  endLocation: string | null
}

export interface DriveStats {
  driveCount: number
  totalMiles: number
  totalEnergyKwh: number
  avgWhPerMi: number | null
}

export interface DrivesPayload {
  drives: DriveWithLocation[]
  stats: DriveStats
}

export const getDrives = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<DrivesPayload> =>
    withDb((db) => getDrivesCore(db, context.userId, data)),
  )

/**
 * Every drive_session column EXCEPT the road-matched `route_geometry` blob. List
 * reads (the dashboard aggregate, drive history, exports) must use this: with
 * full-overview matching the geometry averages dozens of points per drive, and
 * parsing + re-serializing it for hundreds of rows blows the Workers Free-plan
 * ~10ms CPU cap (error 1102). Only getDriveRoutes (the map) reads the geometry.
 */
const { route_geometry: _routeGeometry, ...driveListColumns } = getTableColumns(driveSession)
export { driveListColumns }

export async function getDrivesCore(
  db: Db,
  userId: string,
  data: VinFilter,
): Promise<DrivesPayload> {
    const vin = data?.vin
    const rows = await db
      .select(driveListColumns)
      .from(driveSession)
      .where(
        and(
          eq(driveSession.user_id, userId),
          isNotNull(driveSession.ended_at),
          vin ? eq(driveSession.vin, vin) : undefined,
        ),
      )
      .orderBy(desc(driveSession.started_at))
      .limit(500)

    // route_geometry is deliberately not selected; null it to satisfy the row type.
    const baseDrives = rows.map((r) => ({ ...r, route_geometry: null })) as DriveSession[]

    // Resolve place names for the start/end of each drive. A named geofence (Home,
    // Work) wins over the reverse-geocoded street address. Both lookups are scoped
    // to the user's own rows and batched by id.
    const addrIds = [
      ...new Set(
        baseDrives.flatMap((d) => [d.start_address_id, d.end_address_id]).filter((x): x is number => x != null),
      ),
    ]
    const geoIds = [
      ...new Set(
        baseDrives.flatMap((d) => [d.start_geofence_id, d.end_geofence_id]).filter((x): x is number => x != null),
      ),
    ]

    const addrRows = addrIds.length
      ? await db
          .select({
            id: address.id,
            name: address.name,
            road: address.road,
            neighbourhood: address.neighbourhood,
            city: address.city,
            display_name: address.display_name,
          })
          .from(address)
          .where(and(eq(address.user_id, userId), inArray(address.id, addrIds)))
      : []
    const geoRows = geoIds.length
      ? await db
          .select({ id: geofence.id, name: geofence.name })
          .from(geofence)
          .where(and(eq(geofence.user_id, userId), inArray(geofence.id, geoIds)))
      : []

    const addrMap = new Map(addrRows.map((a) => [a.id, a]))
    const geoMap = new Map(geoRows.map((g) => [g.id, g.name]))
    const placeFor = (addrId: number | null, geoId: number | null): string | null => {
      if (geoId != null) {
        const g = geoMap.get(geoId)
        if (g) return g
      }
      const a = addrId != null ? addrMap.get(addrId) : undefined
      return a ? addressLabel(a) : null
    }

    const drives: DriveWithLocation[] = baseDrives.map((d) => ({
      ...d,
      startLocation: placeFor(d.start_address_id, d.start_geofence_id),
      endLocation: placeFor(d.end_address_id, d.end_geofence_id),
    }))

    let totalMiles = 0
    let totalEnergyKwh = 0
    for (const d of drives) {
      totalMiles += d.distance_mi ?? 0
      totalEnergyKwh += d.energy_used_kwh ?? 0
    }
    const avgWhPerMi = totalMiles > 0 ? Math.round((totalEnergyKwh * 1000) / totalMiles) : null
    return {
      drives,
      stats: {
        driveCount: drives.length,
        totalMiles: Math.round(totalMiles * 10) / 10,
        totalEnergyKwh: Math.round(totalEnergyKwh * 100) / 100,
        avgWhPerMi,
      },
    }
}

export interface DriveRoute {
  /** Ordered [lat, lng] breadcrumb sampled by the poller during the drive. */
  points: [number, number][]
  /** Whether the points are a real GPS trail (≥2 sampled snapshots) vs just endpoints. */
  sampled: boolean
}

/**
 * Reconstruct a drive's route from the GPS points the poller stored during it.
 * The Fleet API has no trip/route endpoint, so this is the ordered, non-null
 * `vehicle_snapshot` lat/lng within the drive window — a coarse breadcrumb at the
 * poll cadence, not a road-matched line. Falls back to the drive's start/end
 * coords when fewer than two snapshots carried a fix. Scoped to the user's rows.
 */
export const getDriveRoute = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ driveId: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<DriveRoute> =>
    withDb(async (db) => {
    const userId = context.userId

    const rows = await db
      .select()
      .from(driveSession)
      .where(and(eq(driveSession.id, data.driveId), eq(driveSession.user_id, userId)))
      .limit(1)
    const drive = rows[0] as DriveSession | undefined
    if (!drive) return { points: [], sampled: false }

    const snaps = await db
      .select({ lat: vehicleSnapshot.latitude, lng: vehicleSnapshot.longitude })
      .from(vehicleSnapshot)
      .where(
        and(
          eq(vehicleSnapshot.user_id, userId),
          eq(vehicleSnapshot.vin, drive.vin),
          isNotNull(vehicleSnapshot.latitude),
          gte(vehicleSnapshot.recorded_at, drive.started_at),
          lte(vehicleSnapshot.recorded_at, drive.ended_at ?? drive.started_at),
        ),
      )
      .orderBy(asc(vehicleSnapshot.recorded_at))

    const points = snaps
      .filter((s): s is { lat: number; lng: number } => s.lat != null && s.lng != null)
      .map((s) => [s.lat, s.lng] as [number, number])

    if (points.length >= 2) return { points, sampled: true }

    // Fallback: whatever endpoints the drive row carries.
    const ends: [number, number][] = []
    if (drive.start_lat != null && drive.start_lng != null) ends.push([drive.start_lat, drive.start_lng])
    if (drive.end_lat != null && drive.end_lng != null) ends.push([drive.end_lat, drive.end_lng])
    return { points: ends, sampled: false }
  }))

export interface VisitedMap {
  /** Deduped [lat, lng] cells the car has been seen at — a lifetime "visited" scatter. */
  points: [number, number][]
  /** Snapshots scanned before grid-deduping (capped). */
  scanned: number
}

/**
 * TeslaMate "Visited (lifetime driving map)" parity. The Fleet API has no path
 * endpoint, so this is every non-null `vehicle_snapshot` GPS fix the poller stored,
 * snapped to a ~11 m grid (4 decimal places) and deduped to unique cells. That
 * bounds the payload and renders as a heat/track scatter of everywhere the car
 * has been — at the 2-min poll cadence, not a road-matched trace. Scoped to the
 * user's rows; a recent window is scanned to keep the read bounded.
 */
export const getVisitedMap = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<VisitedMap> =>
    withDb(async (db) => {
    const userId = context.userId
    const vin = data?.vin

    const rows = await db
      .select({ lat: vehicleSnapshot.latitude, lng: vehicleSnapshot.longitude })
      .from(vehicleSnapshot)
      .where(
        and(
          eq(vehicleSnapshot.user_id, userId),
          vin ? eq(vehicleSnapshot.vin, vin) : undefined,
          isNotNull(vehicleSnapshot.latitude),
          isNotNull(vehicleSnapshot.longitude),
        ),
      )
      .orderBy(desc(vehicleSnapshot.recorded_at))
      .limit(100_000)

    const seen = new Set<string>()
    const points: [number, number][] = []
    for (const r of rows) {
      if (r.lat == null || r.lng == null) continue
      // ~11 m grid: round to 4 dp and dedupe to one point per cell.
      const key = `${r.lat.toFixed(4)},${r.lng.toFixed(4)}`
      if (seen.has(key)) continue
      seen.add(key)
      points.push([r.lat, r.lng])
    }
    return { points, scanned: rows.length }
  }))

export interface DriveRoutesMap {
  /** One ordered [lat,lng] polyline per drive (downsampled at the poll cadence). */
  routes: LatLng[][]
  /** How many drive paths were drawn. */
  driveCount: number
}

/**
 * Lifetime drive map: every drive rendered as its own GPS polyline. The Fleet API
 * has no path endpoint, so this groups stored `vehicle_snapshot` fixes into each
 * drive's [started_at, ended_at] window (parked fixes between drives are dropped so
 * the map shows trips, not teleport lines). Coarse at the 2-min poll cadence, not
 * road-matched. Scoped to the user's rows; bounded by a snapshot scan cap.
 */
export const getDriveRoutes = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(rangeVinFilter)
  .handler(async ({ data, context }): Promise<DriveRoutesMap> =>
    withDb(async (db) => {
      const userId = context.userId
      const vin = data?.vin
      const from = data?.from ?? null
      const to = data?.to ?? null

      // All closed drives (open/in-progress have no end → skip) within the selected
      // window, oldest-first, with any cached road-matched geometry. A road-matched
      // drive renders straight from that stored line; the rest fall back to the raw
      // straight-line breadcrumb.
      const driveRows = await db
        .select({
          started_at: driveSession.started_at,
          ended_at: driveSession.ended_at,
          route_geometry: driveSession.route_geometry,
          route_match_status: driveSession.route_match_status,
        })
        .from(driveSession)
        .where(
          and(
            eq(driveSession.user_id, userId),
            vin ? eq(driveSession.vin, vin) : undefined,
            isNotNull(driveSession.ended_at),
            from ? gte(driveSession.started_at, from) : undefined,
            to ? lte(driveSession.started_at, to) : undefined,
          ),
        )
        .orderBy(asc(driveSession.started_at))

      const matchedRoutes: LatLng[][] = []
      const windows: RouteWindow[] = []
      for (const d of driveRows) {
        if (d.ended_at == null) continue
        const geom = d.route_geometry
        if (geom && geom.length >= 2) {
          // Trim payload with a shape-preserving simplify (15m tolerance), NOT a
          // uniform stride — a stride drops corner vertices and the "road-matched"
          // line visibly cuts across blocks. Stride cap only as a runaway guard.
          const simplified = simplifyPath(geom, 15)
          matchedRoutes.push(simplified.length > 400 ? downsampleSeries(simplified, 400) : simplified)
        } else if (d.route_match_status == null) {
          // Un-attempted (e.g. a new drive not yet snapped) → straight-line breadcrumb
          // until "Snap to roads" runs. Drives that WERE attempted but couldn't match
          // ('failed' / 'insufficient' — too GPS-sparse) are intentionally NOT drawn, so
          // the lifetime map shows road-shaped routes instead of straight lines that cut
          // across blocks.
          windows.push({ startMs: new Date(d.started_at).getTime(), endMs: new Date(d.ended_at).getTime() })
        }
      }

      // GPS fixes only for the UN-matched windows. Burst polling makes drives dense
      // (a fix every ~20-30s), so a lifetime map would otherwise pull tens of
      // thousands of rows into the Worker. Thin to ~1 fix / 2 min and return epoch
      // ms straight from Postgres (DISTINCT ON keeps the earliest fix per 120s
      // bucket). groupRoutes drops fixes outside these windows — including any inside
      // an already-matched drive — so matched drives are never double-drawn.
      let fallbackRoutes: LatLng[][] = []
      if (windows.length) {
        const startIso = new Date(windows[0].startMs).toISOString()
        const endIso = new Date(windows[windows.length - 1].endMs).toISOString()
        const vinClause = vin ? sql`and ${vehicleSnapshot.vin} = ${vin}` : sql``
        const thinned = (await db.execute(sql`
            select distinct on (floor(extract(epoch from ${vehicleSnapshot.recorded_at}) / 120))
              ${vehicleSnapshot.latitude} as lat,
              ${vehicleSnapshot.longitude} as lng,
              extract(epoch from ${vehicleSnapshot.recorded_at}) * 1000 as at_ms
            from ${vehicleSnapshot}
            where ${vehicleSnapshot.user_id} = ${userId}
              and ${vehicleSnapshot.latitude} is not null
              and ${vehicleSnapshot.longitude} is not null
              and ${vehicleSnapshot.recorded_at} >= ${startIso}
              and ${vehicleSnapshot.recorded_at} <= ${endIso}
              ${vinClause}
            order by floor(extract(epoch from ${vehicleSnapshot.recorded_at}) / 120), ${vehicleSnapshot.recorded_at}
            limit 20000
          `)) as unknown as Array<{ lat: number; lng: number; at_ms: number }>
        const snaps = thinned.map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), atMs: Number(r.at_ms) }))
        fallbackRoutes = groupRoutes(snaps, windows, { maxPerPath: 60, maxPaths: 1500 })
      }

      const routes = [...matchedRoutes, ...fallbackRoutes]
      return { routes, driveCount: routes.length }
    }),
  )
