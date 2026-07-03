/**
 * Mapbox Map Matching — snap a drive's GPS breadcrumb onto the road network so
 * the lifetime map draws road-shaped lines instead of straight segments cutting
 * across blocks. Deliberately OFF the 2-min cron (it's a paid/limited API and the
 * cron has no slack): the dashboard's "Snap to roads" button drives a throttled
 * `backfillRouteMatch` that calls this per drive and caches the result.
 *
 * Quality is bounded by GPS density — at the 2-min baseline cadence the points are
 * km apart and Mapbox has to guess the road between them, so the caller stores the
 * geometry only when the match confidence clears a floor and otherwise leaves the
 * drive on its straight-line fallback.
 *
 * Coordinate order is the Mapbox convention (lng,lat) on the wire; this module
 * takes and returns [lat,lng] to match the rest of the app.
 */
const MAPBOX_MATCH_BASE = 'https://api.mapbox.com/matching/v5/mapbox/driving'

/** Mapbox caps a single match request at 100 coordinates. */
export const MATCH_MAX_COORDS = 100

export type MatchOutcome =
  | { ok: true; geometry: [number, number][]; confidence: number }
  /** transient=true → a 429/5xx/network blip; caller should retry later, not mark failed. */
  | { ok: false; transient: boolean }

/** Drop consecutive duplicate fixes — Mapbox 422s on repeated identical coordinates. */
function dedupeConsecutive(coords: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const c of coords) {
    const prev = out[out.length - 1]
    if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) out.push(c)
  }
  return out
}

/** Split into ≤size chunks with a 1-coord overlap so adjacent matched segments meet. */
function chunk(coords: [number, number][], size: number): [number, number][][] {
  if (coords.length <= size) return [coords]
  const chunks: [number, number][][] = []
  for (let i = 0; i < coords.length; i += size - 1) {
    chunks.push(coords.slice(i, i + size))
    if (i + size >= coords.length) break
  }
  return chunks
}

type ChunkResult =
  | { geometry: [number, number][]; confidence: number }
  | { error: 'transient' | 'permanent' }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Brief in-call retries for a 429/5xx before giving up as transient (the caller then backs off). */
const MAX_RETRIES = 1

/**
 * Snap radius (metres) sent per coordinate. Mapbox's default is 5m, which rejects
 * fixes recorded in driveways / parking lots; 25m lets those still snap to the
 * nearest road without letting the match wander to parallel streets.
 */
const SNAP_RADIUS_M = 25

async function matchChunk(coords: [number, number][], token: string, attempt = 0): Promise<ChunkResult> {
  const path = coords.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';')
  // overview=full: the 'simplified' overview thins the line to a handful of vertices
  // and the drawn route visibly cuts corners off roads; callers simplify themselves.
  const url =
    `${MAPBOX_MATCH_BASE}/${path}` +
    `?geometries=geojson&overview=full&tidy=true` +
    `&radiuses=${coords.map(() => SNAP_RADIUS_M).join(';')}` +
    `&access_token=${encodeURIComponent(token)}`
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    if (attempt < MAX_RETRIES) {
      await sleep(800)
      return matchChunk(coords, token, attempt + 1)
    }
    return { error: 'transient' }
  }
  // Rate-limited (300 req/min) or a server blip: honor Retry-After, retry once, else transient.
  if (res.status === 429 || res.status >= 500) {
    if (attempt < MAX_RETRIES) {
      const ra = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 2000) : 1200
      await sleep(waitMs)
      return matchChunk(coords, token, attempt + 1)
    }
    return { error: 'transient' }
  }
  if (!res.ok) return { error: 'permanent' }
  let body: {
    code?: string
    matchings?: { confidence?: number; geometry?: { coordinates?: [number, number][] } }[]
  }
  try {
    body = (await res.json()) as typeof body
  } catch {
    return { error: 'permanent' }
  }
  // A sparse trace often comes back SPLIT into several matchings (Mapbox breaks the
  // trace where it can't bridge a gap). Stitch them all in order — taking only the
  // first would silently drop the rest of the drive. The seam between two matchings
  // renders as one straight jump, which still beats losing the tail entirely.
  const matchings = body.matchings ?? []
  const geometry: [number, number][] = []
  let confSum = 0
  let n = 0
  for (const m of matchings) {
    const out = m?.geometry?.coordinates
    if (!Array.isArray(out)) continue
    // Mapbox returns [lng,lat]; flip to [lat,lng].
    for (const [lng, lat] of out) geometry.push([lat, lng])
    confSum += typeof m.confidence === 'number' ? m.confidence : 0
    n++
  }
  if (geometry.length < 2) return { error: 'permanent' }
  return { geometry, confidence: n > 0 ? confSum / n : 0 }
}

/**
 * Match a drive's ordered [lat,lng] fixes to roads. Chunks long drives (>100
 * fixes) and stitches the results; a transient error on any chunk aborts with
 * `transient:true` (so the drive is retried, not poisoned), a hard no-match aborts
 * with `transient:false`. Confidence is the mean across matched chunks.
 */
export async function mapMatch(rawCoords: [number, number][], token: string): Promise<MatchOutcome> {
  const coords = dedupeConsecutive(rawCoords)
  if (coords.length < 2) return { ok: false, transient: false }

  const geometry: [number, number][] = []
  let confSum = 0
  let matched = 0
  for (const ch of chunk(coords, MATCH_MAX_COORDS)) {
    if (ch.length < 2) continue
    const r = await matchChunk(ch, token)
    if ('error' in r) return { ok: false, transient: r.error === 'transient' }
    geometry.push(...r.geometry)
    confSum += r.confidence
    matched++
  }
  if (geometry.length < 2 || matched === 0) return { ok: false, transient: false }
  return { ok: true, geometry, confidence: confSum / matched }
}
