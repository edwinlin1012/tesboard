import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { useSuspenseQuery } from '@tanstack/react-query'
import { AccentChip, BackHeader, BatteryGlyph, Card, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { Chart, DASH, Divider, SectionCard, StatTile, TileRow, fmtMoney } from '../../components/dashboard/detail'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { ReplayMap3D, type ReplayReadout } from '../../components/dashboard/ReplayMap3D'
import { buildReplayTrack, sampleAt } from '../../lib/replay-vm'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION } from '../../components/dashboard/theme'
import { cn } from '../../lib/utils'
import { driveDetailQuery } from '../../lib/queries'
import { exportDriveGpx } from '../../functions/export.functions'
import { buildDriveDetail, fmtClockStamp, fmtElapsedMin } from '../../lib/drive-detail-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { downloadString } from '../../lib/download'
import {
  distUnit,
  effFromWhKm,
  effSuffix,
  elevUnit,
  fmtDist,
  fmtElev,
  fmtSpeed,
  fmtTemp,
  speedUnit,
  tempUnit,
} from '../../lib/units'

export const Route = createFileRoute('/dashboard/drives_/$driveId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(driveDetailQuery(Number(params.driveId))),
  component: DriveDetailPage,
})

const COLOR = SECTION.drives
const START_DOT = '#34c759'

function DriveDetailPage() {
  const payload = useSuspenseQuery(driveDetailQuery(Number(Route.useParams().driveId))).data
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const tz = useDisplayTz()
  const vm = buildDriveDetail(payload, tz)

  // Chart x = elapsed minutes from the drive start; render ticks + hover as the
  // absolute clock time instead (tz-safe via useDisplayTz).
  const startMs = payload.drive ? new Date(payload.drive.started_at).getTime() : 0
  const fmtX = (min: number) => fmtClockStamp(startMs + min * 60000, tz)

  // 3D replay: timestamped GPS fixes + the map-matched route (when present)
  // become a position-over-time track; null when the drive isn't animatable.
  const track = useMemo(
    () => buildReplayTrack(payload.samples, payload.drive?.route_geometry ?? null),
    [payload],
  )
  const [mapMode, setMapMode] = useState<'3d' | '2d'>('3d')

  const readoutsAt = useCallback(
    (tMin: number): ReplayReadout[] => {
      const s = sampleAt(payload.samples, tMin)
      if (!s) return []
      const out: ReplayReadout[] = []
      if (s.speedMph != null) out.push({ label: 'Speed', value: `${fmtSpeed(u, s.speedMph * 1.60934)} ${speedUnit(u)}` })
      if (s.powerKw != null) out.push({ label: 'Power', value: `${Math.round(s.powerKw)} kW` })
      if (s.battery != null) out.push({ label: 'Battery', value: `${s.battery}%` })
      if (s.elevationM != null) out.push({ label: 'Elev', value: `${fmtElev(u, s.elevationM)} ${elevUnit(u)}` })
      return out
    },
    [payload, u],
  )

  const fetchGpx = useServerFn(exportDriveGpx)
  const [gpxBusy, setGpxBusy] = useState(false)
  async function downloadGpx() {
    if (!payload.drive || gpxBusy) return
    setGpxBusy(true)
    try {
      const f = await fetchGpx({ data: { driveId: payload.drive.id } })
      if (f.body) downloadString(f.filename, f.mime, f.body)
    } finally {
      setGpxBusy(false)
    }
  }

  const headerTitle = vm.endPlace ? `To ${vm.endPlace}` : vm.title

  // Cost per distance unit, derived from the estimate.
  const distSel = fmtDist(u, vm.distKm, 2)
  const costPerDist =
    vm.estCost && distSel > 0 ? { amount: vm.estCost.amount / distSel, currency: vm.estCost.currency } : null

  return (
    <div className="evd-view flex flex-col gap-[14px]">
      <BackHeader to="/dashboard/drives" title={headerTitle} subtitle={vm.found ? vm.subtitle : undefined} />

      {!vm.found ? (
        <EmptyCard
          title="Drive not found"
          body="This drive doesn’t exist or isn’t one of yours. It may have been removed, or the link is stale."
        />
      ) : (
        <>
          {/* Map + GPX export */}
          {vm.hasGps && (
            <Card radius={22} className="p-[14px]">
              {track && mapMode === '3d' ? (
                <ReplayMap3D track={track} color={COLOR} isDark={isDark} height={300} readoutsAt={readoutsAt} />
              ) : (
                <LeafletMap points={payload.points} color={COLOR} isDark={isDark} height={240} />
              )}
              <div className="mt-2 flex items-center justify-between gap-2.5">
                <span className="min-w-0 truncate pl-0.5 text-[10px] font-medium text-muted-foreground">
                  {payload.sampled
                    ? `Sampled GPS · ${payload.points.length} points`
                    : 'Approximate (start/end only — no breadcrumb yet)'}
                </span>
                <div className="flex flex-none items-center gap-2">
                  {track && (
                    <button
                      type="button"
                      onClick={() => setMapMode(mapMode === '3d' ? '2d' : '3d')}
                      title={mapMode === '3d' ? 'Switch to the flat 2D map' : 'Switch to the 3D replay'}
                      style={{ color: COLOR, borderColor: COLOR }}
                      className="flex-none cursor-pointer whitespace-nowrap rounded-[30px] border bg-transparent px-3 py-[5px] text-[11px] font-semibold"
                    >
                      {mapMode === '3d' ? '2D map' : '3D replay'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={downloadGpx}
                    disabled={gpxBusy}
                    title="Download this drive as a GPX track"
                    style={{ color: COLOR, borderColor: COLOR }}
                    className={cn(
                      'flex-none whitespace-nowrap rounded-[30px] border bg-transparent px-3 py-[5px] text-[11px] font-semibold',
                      gpxBusy ? 'cursor-default opacity-60' : 'cursor-pointer opacity-100',
                    )}
                  >
                    {gpxBusy ? 'Exporting…' : 'Export GPX'}
                  </button>
                </div>
              </div>
            </Card>
          )}

          {/* Trip: From → To + distance/duration */}
          <Card radius={22} className="flex flex-col gap-4 p-[18px]">
            <div className="flex flex-col">
              <Endpoint stamp={vm.startStamp} battery={vm.batteryStart} place={vm.startPlace} color={START_DOT} isDark={isDark} connector />
              <Endpoint stamp={vm.endStamp} battery={vm.batteryEnd} place={vm.endPlace} color={COLOR} isDark={isDark} />
            </div>
            <Divider />
            <TileRow>
              <StatTile icon={ICON.gauge} label="Distance" value={`${fmtDist(u, vm.distKm, 1)}`} unit={distUnit(u)} accent={COLOR} />
              <StatTile icon={ICON.clock} label="Duration" value={fmtElapsedMin(vm.durMin)} accent={COLOR} />
            </TileRow>
          </Card>

          {/* Costs */}
          <SectionCard title="Costs">
            <TileRow>
              <StatTile icon={ICON.charging} fill label="Electric cost" value={fmtMoney(vm.estCost)} accent={SECTION.charging} />
              <StatTile icon={ICON.dollar} label={`Cost / ${distUnit(u)}`} value={fmtMoney(costPerDist)} accent={SECTION.charging} />
            </TileRow>
          </SectionCard>

          {/* Energy */}
          <SectionCard title="Energy">
            <TileRow>
              <StatTile icon={ICON.battery} fill label="Total used" value={vm.kwh != null ? `${vm.kwh}` : DASH} unit={vm.kwh != null ? 'kWh' : ''} accent={SECTION.insights} />
              <StatTile icon={ICON.leaf} label="Average" value={vm.effWhKm != null ? `${effFromWhKm(u, vm.effWhKm)}` : DASH} unit={vm.effWhKm != null ? effSuffix(u) : ''} accent={SECTION.insights} />
            </TileRow>
          </SectionCard>

          {/* Speed */}
          <SectionCard title="Speed">
            <TileRow>
              <StatTile icon={ICON.gauge} label="Average" value={`${fmtSpeed(u, vm.avgKph)}`} unit={speedUnit(u)} accent={COLOR} />
              <StatTile icon={ICON.gauge} label="Max" value={vm.maxKph != null ? `${fmtSpeed(u, vm.maxKph)}` : DASH} unit={vm.maxKph != null ? speedUnit(u) : ''} accent={COLOR} />
            </TileRow>
            <Chart points={vm.series.speedKph} color={COLOR} formatX={fmtX} formatY={(kph) => `${fmtSpeed(u, kph)}`} unitY={speedUnit(u)} empty="No speed samples recorded for this drive." />
          </SectionCard>

          {/* Power / regen */}
          <SectionCard title="Power">
            <TileRow>
              <StatTile icon={ICON.charging} fill label="Peak power" value={vm.peakPowerKw != null ? `${vm.peakPowerKw}` : DASH} unit={vm.peakPowerKw != null ? 'kW' : ''} accent={COLOR} />
              <StatTile icon={ICON.leaf} label="Peak regen" value={vm.peakRegenKw != null ? `${vm.peakRegenKw}` : DASH} unit={vm.peakRegenKw != null ? 'kW' : ''} accent={SECTION.insights} />
            </TileRow>
            <Chart points={vm.series.powerKw} color={COLOR} formatX={fmtX} formatY={(kw) => `${Math.round(kw)}`} unitY="kW" baseline={0} empty="No power samples recorded for this drive (regen needs denser data than 2-min polling)." />
          </SectionCard>

          {/* Battery */}
          <SectionCard title="Battery">
            <TileRow>
              <StatTile
                icon={ICON.battery}
                fill
                glyph={vm.batteryStart != null ? <BatteryGlyph pct={vm.batteryStart} color={COLOR} /> : undefined}
                label="Start"
                value={vm.batteryStart != null ? `${vm.batteryStart}` : DASH}
                unit={vm.batteryStart != null ? '%' : ''}
                accent={COLOR}
              />
              <StatTile
                icon={ICON.battery}
                fill
                glyph={vm.batteryEnd != null ? <BatteryGlyph pct={vm.batteryEnd} color={COLOR} /> : undefined}
                label="End"
                value={vm.batteryEnd != null ? `${vm.batteryEnd}` : DASH}
                unit={vm.batteryEnd != null ? '%' : ''}
                accent={COLOR}
              />
            </TileRow>
            <Chart points={vm.series.battery} color={COLOR} formatX={fmtX} formatY={(pct) => `${Math.round(pct)}`} unitY="%" empty="No battery readings recorded for this drive." />
          </SectionCard>

          {/* Elevation */}
          <SectionCard title="Elevation">
            <TileRow>
              <StatTile icon={ICON.analytics} label="Total" value={vm.ascentM != null ? `+${fmtElev(u, vm.ascentM)}` : DASH} unit={vm.ascentM != null ? elevUnit(u) : ''} accent={SECTION.insights} />
              <StatTile icon={ICON.mountain} label="Peak" value={vm.peakElevM != null ? `${fmtElev(u, vm.peakElevM)}` : DASH} unit={vm.peakElevM != null ? elevUnit(u) : ''} accent={SECTION.insights} />
            </TileRow>
            <Chart points={vm.series.elevationM} color={SECTION.insights} formatX={fmtX} formatY={(m) => `${fmtElev(u, m)}`} unitY={elevUnit(u)} empty="No elevation for this drive (no GPS fixes recorded, or the lookup was unavailable)." />
          </SectionCard>

          {/* Range efficiency */}
          <SectionCard title="Range efficiency">
            <TileRow>
              <StatTile icon={ICON.battery} fill label="Used" value={vm.ratedUsedKm != null ? `${fmtDist(u, vm.ratedUsedKm, 1)}` : DASH} unit={vm.ratedUsedKm != null ? distUnit(u) : ''} accent={SECTION.insights} />
              <StatTile icon={ICON.leaf} label="Efficiency" value={vm.rangeEffPct != null ? `${vm.rangeEffPct}` : DASH} unit={vm.rangeEffPct != null ? '%' : ''} accent={SECTION.insights} />
            </TileRow>
          </SectionCard>

          {/* Cabin temperatures */}
          <SectionCard title="Interior temperature">
            <StatTile icon={ICON.thermometer} label="Average" value={vm.insideAvgC != null ? `${fmtTemp(u, vm.insideAvgC)}` : DASH} unit={vm.insideAvgC != null ? tempUnit(u) : ''} accent={SECTION.charging} />
            <Chart points={vm.series.insideC} color={SECTION.charging} formatX={fmtX} formatY={(c) => `${fmtTemp(u, c)}`} unitY={tempUnit(u)} empty="No interior-temperature samples for this drive." />
          </SectionCard>

          <SectionCard title="Exterior temperature">
            <StatTile icon={ICON.thermometer} label="Average" value={vm.outsideAvgC != null ? `${fmtTemp(u, vm.outsideAvgC)}` : DASH} unit={vm.outsideAvgC != null ? tempUnit(u) : ''} accent={SECTION.analytics} />
            <Chart points={vm.series.outsideC} color={SECTION.analytics} formatX={fmtX} formatY={(c) => `${fmtTemp(u, c)}`} unitY={tempUnit(u)} empty="No exterior-temperature samples for this drive." />
          </SectionCard>
        </>
      )}
    </div>
  )
}

/** One end of the trip: pin + "stamp · battery%" over a bold place name. The
 *  start endpoint draws a dotted connector down toward the end pin. */
function Endpoint({
  stamp,
  battery,
  place,
  color,
  isDark,
  connector = false,
}: {
  stamp: string | null
  battery: number | null
  place: string | null
  color: string
  isDark: boolean
  connector?: boolean
}) {
  return (
    <div className="flex min-w-0 gap-[14px]">
      <div className="flex flex-none flex-col items-center pt-0.5">
        <AccentChip color={color} isDark={isDark}>
          <Icon d={ICON.pin} size={16} color={color} />
        </AccentChip>
        {connector && (
          <span className="mt-[5px] mb-[-3px] min-h-4 flex-1 border-l-2 border-dotted border-border" />
        )}
      </div>
      <div className={cn('flex min-w-0 flex-col gap-[3px]', connector && 'pb-[18px]')}>
        <span className="flex min-w-0 items-center gap-[5px] text-[11.5px] font-semibold text-muted-foreground">
          <span className="truncate">{stamp || '—'}</span>
          {battery != null && (
            <span className="inline-flex flex-none items-center gap-[3px]">
              <span>·</span>
              <BatteryGlyph pct={battery} color={color} size={17} />
              <span>{battery}%</span>
            </span>
          )}
        </span>
        <span className="truncate text-[15px] font-bold text-foreground">
          {place ?? 'Unknown location'}
        </span>
      </div>
    </div>
  )
}
