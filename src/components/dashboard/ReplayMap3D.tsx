import { useEffect, useRef, useState } from 'react'
import type * as MapLibre from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { cn } from '../../lib/utils'
import { fmtReplayClock, pathUpTo, positionAt, type ReplayTrack } from '../../lib/replay-vm'

/**
 * 3D replayable drive map (MapLibre GL). Free, keyless sources end to end:
 * OpenFreeMap vector basemap (positron / dark by theme) + AWS Terrarium
 * elevation tiles for 3D terrain. The car marker animates along the replay
 * track (see replay-vm.ts) with a chase camera; a scrubber + speed control sit
 * under the map and a HUD overlays live readouts at the playhead.
 *
 * MapLibre touches `window`, so it's dynamically imported inside the effect —
 * it never enters the SSR/Workers bundle (same pattern as LeafletMap).
 */

const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron'
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark'
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const SPEEDS = [4, 16, 60]
const FOLLOW_ZOOM = 15
const FOLLOW_PITCH = 58

/** One HUD readout at the playhead (already formatted in the user's units). */
export interface ReplayReadout {
  label: string
  value: string
}

function lerpAngle(a: number, b: number, k: number): number {
  const d = ((b - a + 540) % 360) - 180
  return (a + d * k + 360) % 360
}

function lineGeoJson(latLngs: [number, number][]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: latLngs.map(([lat, lng]) => [lng, lat]) },
  }
}

/** The rotatable car marker: a heading arrow in the section accent color. */
function carElement(color: string): HTMLDivElement {
  const el = document.createElement('div')
  el.innerHTML = `
    <svg width="34" height="34" viewBox="0 0 34 34">
      <circle cx="17" cy="17" r="12" fill="${color}" stroke="#fff" stroke-width="2.5"/>
      <path d="M17 9.5 L22 20 L17 17.4 L12 20 Z" fill="#fff"/>
    </svg>`
  el.style.width = '34px'
  el.style.height = '34px'
  el.style.cursor = 'default'
  return el
}

export function ReplayMap3D({
  track,
  color,
  isDark,
  height = 300,
  readoutsAt,
}: {
  track: ReplayTrack
  color: string
  isDark: boolean
  height?: number
  /** Formatted HUD readouts for a playhead time (speed / power / battery …). */
  readoutsAt?: (tMin: number) => ReplayReadout[]
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibre.Map | null>(null)
  const markerRef = useRef<MapLibre.Marker | null>(null)
  const readyRef = useRef(false)

  // Playback state. The playhead lives in a ref so the rAF loop never forces a
  // React render; `tick` mirrors it into state ~10×/s for the slider + HUD.
  const tRef = useRef(0)
  const playingRef = useRef(false)
  const followRef = useRef(true)
  const camBearingRef = useRef(0)
  const [tick, setTick] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [follow, setFollow] = useState(true)
  const [speedIdx, setSpeedIdx] = useState(1)
  const speedRef = useRef(SPEEDS[1])

  const readoutsRef = useRef(readoutsAt)
  readoutsRef.current = readoutsAt

  /** Paint the playhead onto the map (marker, traveled line, chase cam). */
  function renderPlayhead(ease = false) {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    const pos = positionAt(track, tRef.current)
    markerRef.current?.setLngLat([pos.lng, pos.lat])
    if (pos.bearing != null) markerRef.current?.setRotation(pos.bearing)
    const progress = map.getSource('replay-progress') as MapLibre.GeoJSONSource | undefined
    progress?.setData(lineGeoJson(pathUpTo(track, pos.offsetM)))
    if (followRef.current) {
      camBearingRef.current =
        pos.bearing != null ? lerpAngle(camBearingRef.current, pos.bearing, ease ? 1 : 0.08) : camBearingRef.current
      if (ease) {
        map.easeTo({
          center: [pos.lng, pos.lat],
          bearing: camBearingRef.current,
          zoom: FOLLOW_ZOOM,
          pitch: FOLLOW_PITCH,
          duration: 700,
        })
      } else {
        map.jumpTo({ center: [pos.lng, pos.lat], bearing: camBearingRef.current })
      }
    }
  }

  // Build the map once per (track, theme). Theme switches are rare enough that
  // a full rebuild (with the right style) beats juggling setStyle re-adds.
  useEffect(() => {
    let cancelled = false
    let raf = 0
    let lastTs = 0

    async function init() {
      const mod = await import('maplibre-gl')
      const ml = ((mod as unknown as { default?: typeof MapLibre }).default ?? mod) as typeof MapLibre
      if (cancelled || !containerRef.current) return

      const start = positionAt(track, 0)
      const map = new ml.Map({
        container: containerRef.current,
        style: isDark ? STYLE_DARK : STYLE_LIGHT,
        center: [start.lng, start.lat],
        zoom: 13,
        pitch: FOLLOW_PITCH,
        attributionControl: { compact: true },
        maxPitch: 70,
      })
      mapRef.current = map

      map.on('load', () => {
        if (cancelled) return
        // 3D terrain: free Terrarium DEM tiles (Mapzen / AWS Open Data).
        map.addSource('dem', {
          type: 'raster-dem',
          tiles: [DEM_TILES],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 14,
          attribution: 'Terrain © <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen/AWS</a>',
        })
        map.setTerrain({ source: 'dem', exaggeration: 1.3 })
        map.addLayer({
          id: 'hillshade',
          type: 'hillshade',
          source: 'dem',
          paint: { 'hillshade-exaggeration': isDark ? 0.25 : 0.35 },
        })

        // Full route (muted) + traveled portion (accent) + car marker on top.
        map.addSource('replay-route', { type: 'geojson', data: lineGeoJson(track.path) })
        map.addLayer({
          id: 'replay-route',
          type: 'line',
          source: 'replay-route',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': color, 'line-width': 4, 'line-opacity': isDark ? 0.35 : 0.3 },
        })
        map.addSource('replay-progress', { type: 'geojson', data: lineGeoJson(pathUpTo(track, 0)) })
        map.addLayer({
          id: 'replay-progress',
          type: 'line',
          source: 'replay-progress',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': color, 'line-width': 4.5, 'line-opacity': 0.95 },
        })

        markerRef.current = new ml.Marker({
          element: carElement(color),
          rotationAlignment: 'map',
          pitchAlignment: 'map',
        })
          .setLngLat([start.lng, start.lat])
          .setRotation(start.bearing ?? 0)
          .addTo(map)

        // Frame the whole drive, keeping the tilted camera.
        const lats = track.path.map((p) => p[0])
        const lngs = track.path.map((p) => p[1])
        map.fitBounds(
          [
            [Math.min(...lngs), Math.min(...lats)],
            [Math.max(...lngs), Math.max(...lats)],
          ],
          { padding: 48, maxZoom: 15.5, duration: 0 },
        )

        readyRef.current = true
        renderPlayhead()
      })

      // Any manual pan/rotate hands the camera back to the user. Camera moves
      // we make ourselves (jumpTo/easeTo) also emit these events but carry no
      // originalEvent — only user gestures do.
      const releaseFollow = (e: { originalEvent?: unknown }) => {
        if (!e.originalEvent) return
        followRef.current = false
        setFollow(false)
      }
      map.on('dragstart', releaseFollow)
      map.on('rotatestart', releaseFollow)

      const loop = (ts: number) => {
        raf = requestAnimationFrame(loop)
        const dt = lastTs ? Math.min(0.5, (ts - lastTs) / 1000) : 0
        lastTs = ts
        if (playingRef.current) {
          tRef.current += (dt * speedRef.current) / 60
          if (tRef.current >= track.durMin) {
            tRef.current = track.durMin
            playingRef.current = false
            setPlaying(false)
          }
          renderPlayhead()
        }
        setTick((v) => (Math.abs(tRef.current - v) > track.durMin / 600 ? tRef.current : v))
      }
      raf = requestAnimationFrame(loop)
    }

    init()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      readyRef.current = false
      markerRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, isDark, color])

  function togglePlay() {
    if (!playingRef.current && tRef.current >= track.durMin) tRef.current = 0
    playingRef.current = !playingRef.current
    setPlaying(playingRef.current)
    if (playingRef.current && followRef.current) renderPlayhead(true)
  }

  function scrubTo(tMin: number) {
    tRef.current = Math.min(track.durMin, Math.max(0, tMin))
    setTick(tRef.current)
    renderPlayhead()
  }

  function cycleSpeed() {
    const next = (speedIdx + 1) % SPEEDS.length
    setSpeedIdx(next)
    speedRef.current = SPEEDS[next]
  }

  function toggleFollow() {
    followRef.current = !followRef.current
    setFollow(followRef.current)
    if (followRef.current) renderPlayhead(true)
  }

  const readouts = readoutsRef.current?.(tick) ?? []

  return (
    <div className="flex flex-col gap-2">
      <div className="relative w-full overflow-hidden rounded-2xl border border-border" style={{ height }}>
        {/* MapLibre's stylesheet forces `position: relative` on its container,
            so size it explicitly instead of stretching with absolute inset. */}
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {readouts.length > 0 && (
          <div className="pointer-events-none absolute left-2.5 top-2.5 flex flex-col gap-1 rounded-xl bg-background/80 px-2.5 py-2 backdrop-blur">
            {readouts.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-3">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
                  {r.label}
                </span>
                <span className="text-[12px] font-bold tabular-nums text-foreground">{r.value}</span>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={toggleFollow}
          title={follow ? 'Free camera' : 'Follow the car'}
          style={follow ? { color, borderColor: color } : undefined}
          className={cn(
            'absolute right-2.5 top-2.5 rounded-[30px] border bg-background/80 px-2.5 py-1 text-[10px] font-semibold backdrop-blur',
            !follow && 'border-border text-muted-foreground',
          )}
        >
          {follow ? 'Following' : 'Follow'}
        </button>
      </div>

      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={togglePlay}
          title={playing ? 'Pause' : 'Play'}
          style={{ backgroundColor: color }}
          className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-white"
        >
          {playing ? (
            <svg width="11" height="12" viewBox="0 0 11 12" fill="currentColor">
              <rect x="1" y="0.5" width="3.2" height="11" rx="1" />
              <rect x="6.8" y="0.5" width="3.2" height="11" rx="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2.5 1.2 L10.8 6 L2.5 10.8 Z" />
            </svg>
          )}
        </button>
        <span className="flex-none text-[10.5px] font-semibold tabular-nums text-muted-foreground">
          {fmtReplayClock(tick)} / {fmtReplayClock(track.durMin)}
        </span>
        <input
          type="range"
          min={0}
          max={track.durMin}
          step={track.durMin / 1000}
          value={tick}
          onChange={(e) => scrubTo(Number(e.target.value))}
          aria-label="Replay position"
          style={{ accentColor: color }}
          className="h-1.5 min-w-0 flex-1 cursor-pointer"
        />
        <button
          type="button"
          onClick={cycleSpeed}
          title="Playback speed"
          className="flex-none rounded-[30px] border border-border px-2.5 py-1 text-[10.5px] font-bold tabular-nums text-muted-foreground"
        >
          {SPEEDS[speedIdx]}×
        </button>
      </div>
    </div>
  )
}
