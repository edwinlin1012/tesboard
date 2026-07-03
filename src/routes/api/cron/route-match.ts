/**
 * POST /api/cron/route-match  (Authorization: Bearer <CRON_TRIGGER_SECRET>)
 * Run one road-matching backfill batch (a few drives) for every linked user —
 * the same work the dashboard's "Snap to roads" button does, but scriptable:
 * loop it until `remaining` is 0 (backing off when `paused` is true) to re-snap
 * after a bulk import or a matching-quality fix. Deliberately NOT on the cron
 * schedule (Mapbox is metered); this is an on-demand trigger like /api/cron/poll.
 */
import { createFileRoute } from '@tanstack/react-router'
import { getRequestHeader } from '@tanstack/react-start/server'
import { timingSafeEqual } from 'node:crypto'
import { backfillRouteMatchCore, type RouteMatchBackfillResult } from '../../../functions/routematch.functions'
import { withDb } from '../../../server/db'
import { teslaAccount } from '../../../server/schema'
import { serverEnv } from '../../../server/env'

function authorized(): boolean {
  const header = getRequestHeader('authorization') ?? ''
  const presented = header.replace(/^Bearer\s+/i, '')
  const expected = serverEnv.app().cronTriggerSecret
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const Route = createFileRoute('/api/cron/route-match')({
  server: {
    handlers: {
      POST: async () => {
        if (!authorized()) {
          return new Response('Unauthorized', { status: 401 })
        }
        const results = await withDb(async (db) => {
          const accounts = await db.select({ user_id: teslaAccount.user_id }).from(teslaAccount)
          const out: Record<string, RouteMatchBackfillResult> = {}
          for (const acct of accounts) {
            out[acct.user_id] = await backfillRouteMatchCore(db, acct.user_id)
          }
          return out
        })
        return Response.json({ ok: true, results })
      },
    },
  },
})
