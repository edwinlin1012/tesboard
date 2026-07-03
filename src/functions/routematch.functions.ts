/**
 * On-demand route-matching backfill — snaps each drive's stored GPS breadcrumb to
 * the road network via Mapbox (see server/mapmatch) and caches the result on
 * `drive_session.route_geometry`, so the lifetime map can draw road-shaped lines.
 *
 * Kept OFF the 2-min cron (Mapbox is a metered API): the dashboard's "Snap to
 * roads" button loops this a few drives per call until `remaining` is 0, exactly
 * like the elevation / reverse-geocode backfills. A drive is attempted once —
 * `route_match_status` records the outcome ('matched' | 'low' | 'failed' |
 * 'insufficient') so it isn't re-tried — except on a transient (429/5xx) blip,
 * where the batch stops early and leaves the drive un-attempted for next time.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { driveSession, vehicleSnapshot } from '../server/schema'
import { serverEnv } from '../server/env'
import { mapMatch } from '../server/mapmatch'
import { downsampleSeries } from '../lib/drive-detail-vm'
import { simplifyPath } from '../lib/map-vm'

/** Drives matched per invocation — the UI loops, so keep each call rate-limit-friendly. */
const MAX_DRIVES = 4
/** Need at least this many fixes to bother matching (else it's just endpoints). */
const MIN_POINTS = 4
/** Cap fixes sent per drive (≤3 Mapbox chunks); long burst-polled drives get thinned. */
const MAX_FIXES = 300

export interface RouteMatchBackfillResult {
  /** False when MAPBOX_TOKEN is unset — the feature is unavailable; nothing was attempted. */
  configured: boolean
  /** Drives road-matched + stored this run. */
  matched: number
  /** Drives attempted but left on the straight-line fallback (no match / too few fixes). */
  failed: number
  /** Drives still un-attempted after this run. */
  remaining: number
  /** True if the run stopped early on a transient rate-limit/5xx — caller should wait then retry. */
  paused: boolean
}

export const backfillRouteMatch = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<RouteMatchBackfillResult> =>
    withDb((db) => backfillRouteMatchCore(db, context.userId)),
  )

async function countRemaining(db: Db, userId: string): Promise<number> {
  const r = await db
    .select({ c: count() })
    .from(driveSession)
    .where(
      and(
        eq(driveSession.user_id, userId),
        isNotNull(driveSession.ended_at),
        isNull(driveSession.route_match_status),
      ),
    )
  return r[0]?.c ?? 0
}

async function setStatus(db: Db, userId: string, id: number, status: string): Promise<void> {
  await db
    .update(driveSession)
    .set({ route_match_status: status, route_matched_at: new Date().toISOString() })
    .where(and(eq(driveSession.id, id), eq(driveSession.user_id, userId)))
}

/** Exported for the Bearer-guarded /api/cron/route-match trigger (scripted re-snaps). */
export async function backfillRouteMatchCore(db: Db, userId: string): Promise<RouteMatchBackfillResult> {
  const token = serverEnv.mapboxToken()
  if (!token) return { configured: false, matched: 0, failed: 0, remaining: await countRemaining(db, userId), paused: false }

  const drives = await db
    .select({ id: driveSession.id, vin: driveSession.vin, started_at: driveSession.started_at, ended_at: driveSession.ended_at })
    .from(driveSession)
    .where(
      and(
        eq(driveSession.user_id, userId),
        isNotNull(driveSession.ended_at),
        isNull(driveSession.route_match_status),
      ),
    )
    .orderBy(desc(driveSession.started_at))
    .limit(MAX_DRIVES)

  let matched = 0
  let failed = 0
  let paused = false
  for (const d of drives) {
    const snaps = await db
      .select({ lat: vehicleSnapshot.latitude, lng: vehicleSnapshot.longitude })
      .from(vehicleSnapshot)
      .where(
        and(
          eq(vehicleSnapshot.user_id, userId),
          eq(vehicleSnapshot.vin, d.vin),
          isNotNull(vehicleSnapshot.latitude),
          isNotNull(vehicleSnapshot.longitude),
          gte(vehicleSnapshot.recorded_at, d.started_at),
          lte(vehicleSnapshot.recorded_at, d.ended_at ?? d.started_at),
        ),
      )
      .orderBy(asc(vehicleSnapshot.recorded_at))

    let coords = snaps
      .filter((s): s is { lat: number; lng: number } => s.lat != null && s.lng != null)
      .map((s) => [s.lat, s.lng] as [number, number])
    if (coords.length > MAX_FIXES) coords = downsampleSeries(coords, MAX_FIXES)

    if (coords.length < MIN_POINTS) {
      await setStatus(db, userId, d.id, 'insufficient')
      failed++
      continue
    }

    const r = await mapMatch(coords, token)
    if (!r.ok) {
      if (r.transient) {
        paused = true
        break // rate-limited / blip — leave un-attempted and let the caller retry
      }
      await setStatus(db, userId, d.id, 'failed')
      failed++
      continue
    }

    // Store every successful match. Mapbox reports low confidence on sparse (2-min
    // cadence) drives even when the road shape is fine, so a confidence floor would
    // throw away most real matches — a road-shaped line always beats a straight one.
    // The full-overview geometry is dense (a vertex every few metres); simplify at a
    // 5m tolerance so storage stays lean while curves/turns keep their shape.
    await db
      .update(driveSession)
      .set({ route_geometry: simplifyPath(r.geometry, 5), route_match_status: 'matched', route_matched_at: new Date().toISOString() })
      .where(and(eq(driveSession.id, d.id), eq(driveSession.user_id, userId)))
    matched++
  }

  return { configured: true, matched, failed, remaining: await countRemaining(db, userId), paused }
}
