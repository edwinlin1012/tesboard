/**
 * Single-drive detail. Powers the dedicated drive page (/dashboard/drives/$id):
 * the aggregate drive row + resolved start/end place names, the per-sample
 * telemetry stream the poller stored during the drive (battery / speed /
 * elevation / cabin + outside temperature), the GPS breadcrumb for the map, and
 * an *estimated* energy cost (drives aren't billed — it's energy × rate × loss,
 * the same model home charging uses). Read-only; scoped to the user's rows.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { address, driveSession, electricityRate, geofence, vehicleSnapshot } from '../server/schema'
import { addressLabel } from '../server/geo'
import { parseTouSchedule, touWeightedRate } from '../server/cost'
import { fillElevations } from '../server/elevation'
import { downsampleSeries } from '../lib/drive-detail-vm'
import type { DriveSession, ElectricityRate } from '../types/db'
import type { DriveWithLocation } from './drives.functions'

/** One downsampled telemetry sample taken during the drive (canonical raw units). */
export interface DriveSampleRaw {
  /** Elapsed minutes from the drive's start. */
  tMin: number
  /** State of charge (%). */
  battery: number | null
  /** Speed (mph — as Tesla reports it). */
  speedMph: number | null
  /** Elevation (m). Import-only; null on live-polled drives. */
  elevationM: number | null
  /** Cabin (interior) temperature (°C). */
  insideC: number | null
  /** Outside (exterior) temperature (°C). */
  outsideC: number | null
  /** Instantaneous drive power (kW); negative = regen. */
  powerKw: number | null
  /** GPS fix at this sample, when the snapshot carried one (drives the replay). */
  lat: number | null
  lng: number | null
}

export interface DriveDetailPayload {
  drive: DriveWithLocation | null
  /** Per-sample telemetry within the drive window, ordered + downsampled. */
  samples: DriveSampleRaw[]
  /** Ordered [lat, lng] GPS breadcrumb (falls back to endpoints). */
  points: [number, number][]
  /** Whether `points` is a real sampled trail (≥2 fixes) vs just endpoints. */
  sampled: boolean
  /** Estimated energy cost; null when no electricity rate is configured. */
  estCost: { amount: number; currency: string; rate: number } | null
}

/** Cap the per-sample payload so a long imported drive can't ship thousands of rows. */
const MAX_SAMPLES = 360

export const getDriveDetail = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ driveId: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<DriveDetailPayload> =>
    withDb((db) => getDriveDetailCore(db, context.userId, data.driveId)),
  )

export async function getDriveDetailCore(
  db: Db,
  userId: string,
  driveId: number,
): Promise<DriveDetailPayload> {
  const rows = await db
    .select()
    .from(driveSession)
    .where(and(eq(driveSession.id, driveId), eq(driveSession.user_id, userId)))
    .limit(1)
  const drive = rows[0] as DriveSession | undefined
  if (!drive) return { drive: null, samples: [], points: [], sampled: false, estCost: null }

  // Resolve start/end place names (named geofence wins over reverse-geocoded
  // address), mirroring getDrivesCore. Scoped to the user, batched by id.
  const addrIds = [
    ...new Set([drive.start_address_id, drive.end_address_id].filter((x): x is number => x != null)),
  ]
  const geoIds = [
    ...new Set([drive.start_geofence_id, drive.end_geofence_id].filter((x): x is number => x != null)),
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
  const driveWithLoc: DriveWithLocation = {
    ...drive,
    startLocation: placeFor(drive.start_address_id, drive.start_geofence_id),
    endLocation: placeFor(drive.end_address_id, drive.end_geofence_id),
  }

  // Telemetry stream for the drive window, oldest-first.
  const snaps = await db
    .select({
      id: vehicleSnapshot.id,
      at: vehicleSnapshot.recorded_at,
      batt: vehicleSnapshot.battery_level,
      ubatt: vehicleSnapshot.usable_battery_level,
      speed: vehicleSnapshot.speed,
      ele: vehicleSnapshot.elevation_m,
      inT: vehicleSnapshot.inside_temp,
      outT: vehicleSnapshot.outside_temp,
      lat: vehicleSnapshot.latitude,
      lng: vehicleSnapshot.longitude,
      pwr: vehicleSnapshot.power_kw,
    })
    .from(vehicleSnapshot)
    .where(
      and(
        eq(vehicleSnapshot.user_id, userId),
        eq(vehicleSnapshot.vin, drive.vin),
        gte(vehicleSnapshot.recorded_at, drive.started_at),
        lte(vehicleSnapshot.recorded_at, drive.ended_at ?? drive.started_at),
      ),
    )
    .orderBy(asc(vehicleSnapshot.recorded_at))

  // Auto-resolve elevation for this drive's GPS fixes that don't have it yet
  // (the Fleet API has no altitude). Bounded to this drive's window — a couple of
  // Open-Meteo requests at most — and idempotent, so the elevation chart fills in
  // the first time the drive is opened instead of waiting on a manual backfill.
  const needElev = snaps
    .filter((s) => s.ele == null && s.lat != null && s.lng != null)
    .map((s) => ({ id: s.id, lat: s.lat as number, lng: s.lng as number }))
  if (needElev.length > 0) {
    const { byId } = await fillElevations(db, userId, needElev, 4)
    for (const s of snaps) {
      const e = byId.get(s.id)
      if (e != null) s.ele = e
    }
  }

  const startMs = new Date(drive.started_at).getTime()

  // GPS breadcrumb (same coarse poll-cadence trail as getDriveRoute). Fall back
  // to whatever endpoints the drive row carries when fewer than two fixes exist.
  const gps = snaps
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => [s.lat as number, s.lng as number] as [number, number])
  let points: [number, number][] = gps
  let sampled = gps.length >= 2
  if (!sampled) {
    const ends: [number, number][] = []
    if (drive.start_lat != null && drive.start_lng != null) ends.push([drive.start_lat, drive.start_lng])
    if (drive.end_lat != null && drive.end_lng != null) ends.push([drive.end_lat, drive.end_lng])
    points = ends
    sampled = false
  }

  const raw: DriveSampleRaw[] = snaps.map((s) => ({
    tMin: Math.max(0, (new Date(s.at).getTime() - startMs) / 60000),
    battery: s.batt ?? s.ubatt ?? null,
    speedMph: s.speed ?? null,
    elevationM: s.ele ?? null,
    insideC: s.inT ?? null,
    outsideC: s.outT ?? null,
    powerKw: s.pwr ?? null,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
  }))
  const samples = downsampleSeries(raw, MAX_SAMPLES)

  // Estimated cost: drives aren't billed, so this is the grid energy the drive
  // consumed (battery kWh × loss factor) priced at the home rate — TOU-weighted
  // over the drive window when configured, else the flat rate. Honest estimate.
  let estCost: DriveDetailPayload['estCost'] = null
  if (drive.energy_used_kwh != null && drive.energy_used_kwh > 0) {
    const rateRows = await db
      .select()
      .from(electricityRate)
      .where(eq(electricityRate.user_id, userId))
      .limit(1)
    const rate = rateRows[0] as ElectricityRate | undefined
    if (rate) {
      const loss = rate.loss_factor ?? 1.1
      const tou = parseTouSchedule(rate.tou_schedule)
      // TOU is time-weighted across the drive window, so it only makes sense for
      // a closed drive. An in-progress drive (no ended_at) would collapse to the
      // single start-instant rate, so fall back to the flat rate instead.
      let unitRate: number | null =
        tou && drive.ended_at ? touWeightedRate(tou, drive.started_at, drive.ended_at) : null
      if (unitRate == null) unitRate = rate.flat_rate ?? null
      if (unitRate != null && rate.currency) {
        estCost = {
          amount: drive.energy_used_kwh * unitRate * loss,
          currency: rate.currency,
          rate: unitRate,
        }
      }
    }
  }

  return { drive: driveWithLoc, samples, points, sampled, estCost }
}
