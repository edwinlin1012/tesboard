/**
 * Data export (TeslaMate parity: per-drive GPX + a user-facing CSV/JSON export).
 * Every fn is read-only, carries authMiddleware, and scopes by user_id. Returns
 * the file body as a string + a suggested filename; the browser turns it into a
 * download (no raw download route needed, so cookie auth via the server fn is
 * reused). Supabase already provides managed Postgres backups, so this is the
 * structured export TeslaMate's pg_dump never offered, not a DB-level backup.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, gte, isNotNull, lte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb } from '../server/db'
import { chargeSession, driveSession, vehicleSnapshot } from '../server/schema'
import { driveListColumns } from './drives.functions'
import type { ChargeSession, DriveSession } from '../types/db'

export interface ExportFile {
  filename: string
  mime: string
  body: string
}

/** RFC-4180-ish CSV: quote when the cell contains a comma, quote, or newline. */
function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const head = columns.map(csvCell).join(',')
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\n')
  return rows.length ? `${head}\n${body}\n` : `${head}\n`
}

const CHARGE_COLUMNS = [
  'id', 'vin', 'source', 'started_at', 'ended_at', 'location_name', 'lat', 'lng',
  'energy_added_kwh', 'energy_used_kwh', 'miles_added_rated', 'start_range_mi', 'end_range_mi',
  'start_battery_level', 'end_battery_level', 'outside_temp_avg', 'fast_charger_type',
  'charge_location_type', 'cost_amount', 'cost_currency', 'cost_source', 'rate_applied',
  'import_source',
] as const

const DRIVE_COLUMNS = [
  'id', 'vin', 'started_at', 'ended_at', 'start_odometer', 'end_odometer', 'distance_mi',
  'duration_s', 'start_lat', 'start_lng', 'end_lat', 'end_lng', 'start_battery_level',
  'end_battery_level', 'start_range_mi', 'end_range_mi', 'energy_used_kwh', 'wh_per_mi',
  'outside_temp_avg', 'inside_temp_avg', 'speed_max_mph', 'power_max_kw', 'power_min_kw',
  'ascent', 'descent', 'import_source',
] as const

const exportInput = z.object({
  dataset: z.enum(['charges', 'drives']),
  format: z.enum(['csv', 'json']),
  vin: z.string().optional(),
})

/** Export the user's charge or drive history as CSV or JSON. */
export const exportData = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(exportInput)
  .handler(async ({ data, context }): Promise<ExportFile> =>
    withDb(async (db) => {
      const userId = context.userId
      const vin = data.vin
      const stamp = new Date().toISOString().slice(0, 10)

      const rows =
        data.dataset === 'charges'
          ? ((await db
              .select()
              .from(chargeSession)
              .where(and(eq(chargeSession.user_id, userId), vin ? eq(chargeSession.vin, vin) : undefined))
              .orderBy(desc(chargeSession.started_at))) as ChargeSession[])
          : // driveListColumns: route_geometry stays out of exports — it's not in
            // DRIVE_COLUMNS, and hauling every drive's matched polyline through the
            // Worker busts the Free-plan CPU cap (see drives.functions).
            ((await db
              .select(driveListColumns)
              .from(driveSession)
              .where(and(eq(driveSession.user_id, userId), vin ? eq(driveSession.vin, vin) : undefined))
              .orderBy(desc(driveSession.started_at))) as Omit<DriveSession, 'route_geometry'>[])

      const columns = data.dataset === 'charges' ? CHARGE_COLUMNS : DRIVE_COLUMNS

      if (data.format === 'json') {
        return {
          filename: `tesboard-${data.dataset}-${stamp}.json`,
          mime: 'application/json',
          body: JSON.stringify(rows, null, 2),
        }
      }

      return {
        filename: `tesboard-${data.dataset}-${stamp}.csv`,
        mime: 'text/csv',
        body: toCsv([...columns], rows as unknown as Record<string, unknown>[]),
      }
    }),
  )

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Per-drive GPX (TeslaMate's /drive/:id/gpx parity). Builds a `<trk>` from the
 * ordered `vehicle_snapshot` GPS fixes recorded during the drive — a coarse
 * breadcrumb at the 2-min poll cadence, not a road-matched trace (the Fleet API
 * has no path endpoint). Includes per-point time + elevation when present.
 */
export const exportDriveGpx = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ driveId: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<ExportFile> =>
    withDb(async (db) => {
      const userId = context.userId

      const [drive] = (await db
        .select()
        .from(driveSession)
        .where(and(eq(driveSession.id, data.driveId), eq(driveSession.user_id, userId)))
        .limit(1)) as DriveSession[]
      if (!drive) {
        return { filename: 'drive.gpx', mime: 'application/gpx+xml', body: '' }
      }

      const snaps = await db
        .select({
          lat: vehicleSnapshot.latitude,
          lng: vehicleSnapshot.longitude,
          at: vehicleSnapshot.recorded_at,
          ele: vehicleSnapshot.elevation_m,
        })
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

      const pts = snaps.filter((s) => s.lat != null && s.lng != null)
      const trkpts = pts
        .map((s) => {
          const ele = s.ele != null ? `<ele>${s.ele}</ele>` : ''
          const time = s.at ? `<time>${xmlEscape(new Date(s.at).toISOString())}</time>` : ''
          return `      <trkpt lat="${s.lat}" lon="${s.lng}">${ele}${time}</trkpt>`
        })
        .join('\n')

      const name = xmlEscape(`Drive ${new Date(drive.started_at).toISOString()}`)
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="tesboard" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`
      const stamp = new Date(drive.started_at).toISOString().slice(0, 19).replace(/[:T]/g, '-')
      return { filename: `tesboard-drive-${stamp}.gpx`, mime: 'application/gpx+xml', body }
    }),
  )
