import { useMemo, useState, useCallback, useEffect } from 'react'
import DeckGL from '@deck.gl/react'
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import { Map as MapLibreMap } from 'react-map-gl/maplibre'
import {
  COORDINATE_SYSTEM,
  FlyToInterpolator,
  OrthographicView,
  type MapViewState,
  type OrthographicViewState,
  type PickingInfo,
} from '@deck.gl/core'
import {
  geoEqualEarth,
  geoGraticule10,
  geoMercator,
  geoPath,
  type GeoProjection,
} from 'd3-geo'
import { feature } from 'topojson-client'
import countries110m from 'world-atlas/countries-110m.json'
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { GeometryCollection, Topology } from 'topojson-specification'
import 'maplibre-gl/dist/maplibre-gl.css'
import type {
  Hotspot,
  PhotoPoint,
  PopulationRateDataset,
} from './flickr'

type Props = {
  points: PhotoPoint[]
  hotspots: Hotspot[]
  mostViewed: PhotoPoint[]
  populationRates: PopulationRateDataset | null
  downloadedAt?: string
  focus?: MapFocus | null
  selectedFocus?: MapFocus | null
  panRequest?: MapPanRequest | null
  onSelectFocus?: (focus: MapFocus) => void
}

export type MapFocusPhoto = {
  id: string
  title: string
  url?: string
  views?: number
  flickrUrl: string
}

export type MapFocus = {
  id: string
  lon: number
  lat: number
  label: string
  color?: string
  subtitle?: string
  photo?: MapFocusPhoto
}

export type MapPanRequest = {
  key: number
  mode: 'focus' | 'reset'
  lon?: number
  lat?: number
}

export function flickrPhotoUrl(id: string): string {
  return `https://www.flickr.com/photo.gne?id=${id}`
}

export function focusFromHotspot(h: Hotspot): MapFocus {
  return {
    id: `hotspot:${h.lat},${h.lon}`,
    lon: h.lon,
    lat: h.lat,
    label: h.placeName,
    color: h.color,
    subtitle: `${h.count.toLocaleString()} photos in this area`,
    photo: {
      id: h.sample.id,
      title: h.sample.title || 'Untitled',
      url: h.sample.url,
      views: h.sample.views,
      flickrUrl: flickrPhotoUrl(h.sample.id),
    },
  }
}

export function focusFromPhoto(p: PhotoPoint, color = '#ffd23c'): MapFocus {
  return {
    id: `photo:${p.id}`,
    lon: p.lon,
    lat: p.lat,
    label: p.title || 'Untitled',
    color,
    subtitle: `${p.views.toLocaleString()} views`,
    photo: {
      id: p.id,
      title: p.title || 'Untitled',
      url: p.url,
      views: p.views,
      flickrUrl: flickrPhotoUrl(p.id),
    },
  }
}

const INITIAL_VIEW: MapViewState = {
  longitude: 10,
  latitude: 22,
  zoom: 1.7,
  pitch: 0,
  bearing: 0,
  minZoom: 1.2,
  maxZoom: 14,
}

const EQUAL_EARTH_INITIAL: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 0,
  minZoom: -0.5,
  maxZoom: 8,
}

const BASEMAP = {
  version: 8 as const,
  name: 'dark',
  sources: {
    carto: {
      type: 'raster' as const,
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap © CARTO',
    },
  },
  layers: [
    {
      id: 'carto-dark',
      type: 'raster' as const,
      source: 'carto',
      minzoom: 0,
      maxzoom: 20,
    },
  ],
}

type ViewMode = 'hex' | 'points'
type MetricMode = 'photos' | 'population' | 'per-capita'
type ProjectionMode = 'mercator' | 'equal-earth'
type XY = [number, number]
type Rgba = [number, number, number, number]
type ProjectedPoint = { source: PhotoPoint; position: XY; color: Rgba }
type ProjectedHotspot = { source: Hotspot; position: XY }
type MetricField = 'photos' | 'population' | 'photosPerThousand'

function metricField(metric: MetricMode): MetricField {
  if (metric === 'population') return 'population'
  if (metric === 'per-capita') return 'photosPerThousand'
  return 'photos'
}

function cellCenterKey(lat: number, lon: number, cellDegrees: number): string {
  const cy =
    Math.floor(lat / cellDegrees) * cellDegrees + cellDegrees / 2
  const cx =
    Math.floor(lon / cellDegrees) * cellDegrees + cellDegrees / 2
  return `${cy.toFixed(3)},${cx.toFixed(3)}`
}

function metricLegendLabels(metric: MetricMode): {
  title: string
  low: string
  high: string
} {
  if (metric === 'population') {
    return { title: 'Population', low: 'Low', high: 'High' }
  }
  if (metric === 'per-capita') {
    return { title: 'Per capita', low: 'Low', high: 'High' }
  }
  return { title: 'Density', low: 'Low', high: 'High' }
}

function metricHint(viewMode: ViewMode, metric: MetricMode): string {
  if (viewMode === 'hex') {
    if (metric === 'population') {
      return 'Shared hex grid · GHSL resident population (2020)'
    }
    if (metric === 'per-capita') {
      return 'Same hexes · photos per 1,000 residents'
    }
    return 'Same hexes · brighter = more photos'
  }
  if (metric === 'population') {
    return 'One point per 0.25° cell · GHSL resident population (2020)'
  }
  if (metric === 'per-capita') {
    return 'Points colored by photos per 1,000 residents · GHSL 2020'
  }
  return 'Points · amber→hot · brighter = denser area'
}

/**
 * Truncated Inferno (matplotlib / SciPy) for dark basemaps.
 * Skips near-black stops so sparse cells stay visible; low→high = dim→bright.
 * Perceptually uniform + colorblind-safer than rainbow/jet; greyscale-friendly.
 * @see https://bids.github.io/colormap/
 */
const DENSITY_COLORS: Rgba[] = [
  [55, 14, 94, 195],
  [105, 23, 110, 210],
  [158, 47, 89, 220],
  [208, 72, 54, 230],
  [240, 135, 33, 240],
  [249, 191, 57, 250],
  [252, 246, 164, 255],
]

/**
 * Points share Inferno’s warm half only — sparse dots stay luminous amber/gold
 * on dark land/ocean; denser cells climb toward yellow-white.
 */
const POINT_COLORS: Rgba[] = [
  [255, 196, 110, 125],
  [248, 150, 55, 155],
  [240, 110, 45, 180],
  [250, 175, 50, 210],
  [252, 230, 130, 235],
]

/** Color each point from local geographic density (no glow). */
function buildPointDensityColors(
  points: PhotoPoint[],
  cellDeg = 0.7,
): Rgba[] {
  const counts = new Map<string, number>()
  const keys = new Array<string>(points.length)

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]
    const key = `${Math.floor(point.lat / cellDeg)},${Math.floor(point.lon / cellDeg)}`
    keys[i] = key
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const ranked = [...counts.values()].sort((a, b) => a - b)
  const cap = ranked[Math.floor(ranked.length * 0.97)] ?? 1

  return points.map((_, i) => {
    const count = counts.get(keys[i]) ?? 1
    // Sparse cells stay near the original amber; only denser cells climb the ramp.
    const t = Math.min(1, Math.pow(count / cap, 0.55))
    const colorIndex = Math.min(
      POINT_COLORS.length - 1,
      Math.floor(t * POINT_COLORS.length),
    )
    return POINT_COLORS[colorIndex]
  })
}

function colorFromMetricValue(value: number, cap: number): Rgba {
  const normalized = Math.log1p(Math.min(value, cap)) / Math.log1p(cap)
  const colorIndex = Math.min(
    DENSITY_COLORS.length - 1,
    Math.floor(normalized * DENSITY_COLORS.length),
  )
  return DENSITY_COLORS[colorIndex]
}

function cellsForMetric(
  dataset: PopulationRateDataset,
  metric: MetricMode,
) {
  // Shared 0.25° tessellation for every hex metric. World pop uses the full
  // inhabited grid; photo count and per-capita share the photographed cells.
  if (metric === 'population') return dataset.cells
  return dataset.cells.filter((cell) => cell.photos > 0)
}

function metricCap(
  dataset: PopulationRateDataset,
  field: MetricField,
  metric: MetricMode,
): number {
  const sorted = cellsForMetric(dataset, metric)
    .map((cell) => cell[field])
    .sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.97)] ?? 1
}

/**
 * Shared hex tessellation for every metric. Photos and population are binned
 * into the same hexes so switching metric only changes the color, never the
 * geometry. Population lands via 2×2 sub-samples of each source cell so hexes
 * fill evenly instead of catching one centroid each.
 */
const HEX_SCREEN_RADIUS = 4.2
const HEX_COVERAGE = 0.94
const SQRT3 = Math.sqrt(3)

type HexAggregates = {
  radius: number
  q: number[]
  r: number[]
  photos: number[]
  population: number[]
}

type MetricHex = {
  polygon: [number, number][]
  color: Rgba
}

/** Hex radius in binning-space units, floored at the population grain. */
function hexRadius(
  unitsPerDegree: number,
  zoom: number,
  cellDegrees: number,
): number {
  const screenRadius = HEX_SCREEN_RADIUS / 2 ** zoom
  return Math.max(screenRadius, cellDegrees * unitsPerDegree)
}

/**
 * Past this on-screen resolution a 0.25° hex is wider than the interesting
 * detail, so hex view hands off to the individual photos instead.
 */
const HEX_DETAIL_PIXELS_PER_DEGREE = 150

function isBeyondHexDetail(
  unitsPerDegree: number,
  zoom: number,
  cellDegrees: number,
): boolean {
  if (!cellDegrees) return false
  return unitsPerDegree * 2 ** zoom > HEX_DETAIL_PIXELS_PER_DEGREE
}

function toFlatPositions(
  points: PhotoPoint[],
  toSpace: (lon: number, lat: number) => XY,
): Float64Array {
  const out = new Float64Array(points.length * 2)
  for (let i = 0; i < points.length; i += 1) {
    const [x, y] = toSpace(points[i].lon, points[i].lat)
    out[i * 2] = x
    out[i * 2 + 1] = y
  }
  return out
}

/** Flat [x, y, population] triples, 2×2 sub-samples per source cell. */
function toFlatPopulationSamples(
  dataset: PopulationRateDataset | null,
  toSpace: (lon: number, lat: number) => XY,
): Float64Array | null {
  if (!dataset) return null
  const offset = dataset.cellDegrees / 4
  const out = new Float64Array(dataset.cells.length * 4 * 3)
  let at = 0
  for (const cell of dataset.cells) {
    const share = cell.population / 4
    for (const dLon of [-offset, offset]) {
      for (const dLat of [-offset, offset]) {
        const [x, y] = toSpace(cell.lon + dLon, cell.lat + dLat)
        out[at] = x
        out[at + 1] = y
        out[at + 2] = share
        at += 3
      }
    }
  }
  return out
}

function aggregateHexes(
  radius: number,
  photoPositions: Float64Array,
  populationSamples: Float64Array | null,
): HexAggregates {
  const index = new Map<number, number>()
  const q: number[] = []
  const r: number[] = []
  const photos: number[] = []
  const population: number[] = []

  // Pointy-top axial coordinates, rounded through cube space. Returns -1 for
  // samples the projection dropped (clipped or undefined).
  const binAt = (x: number, y: number): number => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1
    const fq = ((SQRT3 / 3) * x - y / 3) / radius
    const fr = ((2 / 3) * y) / radius
    const fy = -fq - fr
    let rx = Math.round(fq)
    let ry = Math.round(fy)
    let rz = Math.round(fr)
    const dx = Math.abs(rx - fq)
    const dy = Math.abs(ry - fy)
    const dz = Math.abs(rz - fr)
    if (dx > dy && dx > dz) rx = -ry - rz
    else if (dy > dz) ry = -rx - rz
    else rz = -rx - ry

    const key = (rx + 1e6) * 4e6 + (rz + 1e6)
    let at = index.get(key)
    if (at === undefined) {
      at = q.length
      index.set(key, at)
      q.push(rx)
      r.push(rz)
      photos.push(0)
      population.push(0)
    }
    return at
  }

  for (let i = 0; i < photoPositions.length; i += 2) {
    const at = binAt(photoPositions[i], photoPositions[i + 1])
    if (at >= 0) photos[at] += 1
  }
  if (populationSamples) {
    for (let i = 0; i < populationSamples.length; i += 3) {
      const at = binAt(populationSamples[i], populationSamples[i + 1])
      if (at >= 0) population[at] += populationSamples[i + 2]
    }
  }

  return { radius, q, r, photos, population }
}

function buildMetricHexes(
  aggregates: HexAggregates,
  metric: MetricMode,
  populationFloor: number,
  toVertex: (x: number, y: number) => [number, number],
): MetricHex[] {
  const { radius, q, r, photos, population } = aggregates
  const keep: number[] = []
  const values: number[] = []

  for (let i = 0; i < q.length; i += 1) {
    // World pop covers every inhabited hex; the photo metrics need photos.
    if (metric === 'population') {
      if (population[i] <= 0) continue
      keep.push(i)
      values.push(population[i])
      continue
    }
    if (photos[i] <= 0) continue
    keep.push(i)
    values.push(
      metric === 'per-capita'
        ? (photos[i] * 1_000) / Math.max(population[i], populationFloor)
        : photos[i],
    )
  }

  const sorted = [...values].sort((a, b) => a - b)
  const cap = sorted[Math.floor(sorted.length * 0.97)] ?? 1

  return keep.map((i, n) => {
    const cx = radius * SQRT3 * (q[i] + r[i] / 2)
    const cy = radius * 1.5 * r[i]
    const polygon = Array.from({ length: 6 }, (_, v) => {
      const angle = ((60 * v - 30) * Math.PI) / 180
      return toVertex(
        cx + radius * HEX_COVERAGE * Math.cos(angle),
        cy + radius * HEX_COVERAGE * Math.sin(angle),
      )
    })
    return { polygon, color: colorFromMetricValue(values[n], cap) }
  })
}

/** Web Mercator world space (512 units at zoom 0) — zoom independent. */
const MERCATOR_WORLD = 512
const MERCATOR_UNITS_PER_DEGREE = MERCATOR_WORLD / 360
const MERCATOR_MAX_LAT = 85.051129

function toMercatorWorld(lon: number, lat: number): XY {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat))
  const phi = (clamped * Math.PI) / 180
  return [
    ((lon + 180) / 360) * MERCATOR_WORLD,
    (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) *
      MERCATOR_WORLD,
  ]
}

function fromMercatorWorld(x: number, y: number): [number, number] {
  const n = Math.PI * (1 - (2 * y) / MERCATOR_WORLD)
  return [
    (x / MERCATOR_WORLD) * 360 - 180,
    (180 / Math.PI) * Math.atan(Math.sinh(n)),
  ]
}

/** Color photo points by the selected population-grid metric. */
function buildPointMetricColors(
  points: PhotoPoint[],
  dataset: PopulationRateDataset | null,
  metric: MetricMode,
): Rgba[] {
  if (!dataset || metric === 'photos') {
    return buildPointDensityColors(points)
  }

  const field = metricField(metric)
  const cap = metricCap(dataset, field, metric)
  const lookup = new Map<string, number>()
  for (const cell of cellsForMetric(dataset, metric)) {
    lookup.set(cellCenterKey(cell.lat, cell.lon, dataset.cellDegrees), cell[field])
  }

  return points.map((point) => {
    const value =
      lookup.get(cellCenterKey(point.lat, point.lon, dataset.cellDegrees)) ?? 0
    return colorFromMetricValue(Math.max(value, 0), cap)
  })
}

/** One colored dot per inhabited cell — Points view for World pop. */
function buildPopulationPointColors(
  dataset: PopulationRateDataset | null,
): Rgba[] {
  if (!dataset) return []
  const cap = metricCap(dataset, 'population', 'population')
  // Opaque + lifted low end so sparse regions don't vanish into black land.
  return dataset.cells.map((cell) => {
    const [r, g, b] = colorFromMetricValue(cell.population, cap)
    return [
      Math.min(255, Math.round(r + (255 - r) * 0.12)),
      Math.min(255, Math.round(g + (255 - g) * 0.1)),
      Math.min(255, Math.round(b + (255 - b) * 0.08)),
      255,
    ]
  })
}

/**
 * Break the regular 0.25° lattice so Equal Earth / Mercator don't show
 * dark horizontal scanlines between latitude rows.
 */
function jitterCellCenter(
  lat: number,
  lon: number,
  cellDegrees: number,
): [number, number] {
  const hash = Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453
  const u = hash - Math.floor(hash)
  const v = hash * 7.13 - Math.floor(hash * 7.13)
  const amp = cellDegrees * 0.42
  return [lon + (u - 0.5) * 2 * amp, lat + (v - 0.5) * 2 * amp]
}

/** Screen radius that nearly fills one population cell at the current zoom. */
function populationPointRadiusPx(
  unitsPerDegree: number,
  zoom: number,
  cellDegrees: number,
): number {
  const cellPx = cellDegrees * unitsPerDegree * 2 ** zoom
  // Overlap neighbors so latitude rows don't leave dark bands.
  return Math.max(1.4, cellPx * 0.72)
}

const equalEarth = geoEqualEarth().scale(140).translate([0, 0])

function project(lon: number, lat: number): XY {
  return equalEarth([lon, lat]) as XY
}

/** Projected world units per degree of longitude at the equator. */
const EQUAL_EARTH_UNITS_PER_DEGREE = Math.abs(
  project(1, 0)[0] - project(0, 0)[0],
)

const WORLD_COUNTRIES = (() => {
  const topology = countries110m as unknown as Topology<{
    countries: GeometryCollection
  }>
  return feature(
    topology,
    topology.objects.countries,
  ) as FeatureCollection<Polygon | MultiPolygon>
})()

/**
 * Cut a ring wherever it jumps the antimeridian. Without this, Russia, Fiji
 * and Antarctica project into straight bands spanning the whole map.
 */
function splitRingAtAntimeridian(
  ring: [number, number][],
): [number, number][][] {
  const last = ring[ring.length - 1]
  const isClosed =
    ring.length > 1 && last[0] === ring[0][0] && last[1] === ring[0][1]
  const vertices = isClosed ? ring.slice(0, -1) : ring
  if (vertices.length < 3) return [ring]

  const parts: [number, number][][] = []
  let current: [number, number][] = [vertices[0]]

  // Includes the implicit closing edge, which is itself often the seam.
  for (let i = 1; i <= vertices.length; i += 1) {
    const previous = vertices[i - 1]
    const point = vertices[i % vertices.length]
    if (Math.abs(point[0] - previous[0]) <= 180) {
      current.push(point)
      continue
    }

    // Walk each side out to its own edge of the dateline so both halves
    // close along the meridian instead of streaking across the map.
    const goingEast = previous[0] > 0
    const edge = goingEast ? 180 : -180
    const unwrappedLon = point[0] + (goingEast ? 360 : -360)
    const span = unwrappedLon - previous[0]
    // Rings that already carry vertices on both sides of the dateline give a
    // zero-length span; interpolating there would yield NaN vertices.
    const t = span === 0 ? 0 : (edge - previous[0]) / span
    const seamLat = previous[1] + t * (point[1] - previous[1])
    current.push([edge, seamLat])
    parts.push(current)
    current = [[-edge, seamLat], point]
  }

  if (parts.length === 0) return [vertices]
  // The trailing run wraps around to where the first part started.
  parts[0] = [...current.slice(0, -1), ...parts[0]]
  return parts
}

function buildWorldPolygons(): XY[][][] {
  const polygons: XY[][][] = []

  // Every ring becomes its own polygon: land is a single flat color, so
  // dropping hole semantics costs nothing and keeps split rings closed.
  const addRings = (rings: [number, number][][]) => {
    for (const ring of rings) {
      for (const part of splitRingAtAntimeridian(ring)) {
        if (part.length < 3) continue
        polygons.push([part.map(([lon, lat]) => project(lon, lat))])
      }
    }
  }

  for (const country of WORLD_COUNTRIES.features) {
    if (country.geometry.type === 'Polygon') {
      addRings(country.geometry.coordinates as [number, number][][])
    } else {
      for (const polygon of country.geometry.coordinates) {
        addRings(polygon as [number, number][][])
      }
    }
  }
  return polygons
}

const WORLD_POLYGONS = buildWorldPolygons()

type HoverInfo = {
  x: number
  y: number
  preview: MapFocus
} | null

export function MapView({
  points,
  hotspots,
  mostViewed,
  populationRates,
  downloadedAt,
  focus = null,
  selectedFocus = null,
  panRequest = null,
  onSelectFocus,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('hex')
  const [metricMode, setMetricMode] = useState<MetricMode>('photos')
  const [projectionMode, setProjectionMode] =
    useState<ProjectionMode>('mercator')
  const [showHottestMarkers, setShowHottestMarkers] = useState(true)
  const [showMostViewedMarkers, setShowMostViewedMarkers] = useState(true)
  const [exporting, setExporting] = useState(false)
  const legend = metricLegendLabels(metricMode)

  const exportHighRes = useCallback(async () => {
    if (exporting || points.length === 0) return
    setExporting(true)
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
      await downloadHighResMap(points, hotspots, mostViewed, {
        viewMode,
        metricMode,
        projectionMode,
        downloadedAt,
        selectedFocus,
        populationRates,
        showHottestMarkers,
        showMostViewedMarkers,
      })
    } catch (error) {
      console.error('High-resolution export failed', error)
      window.alert('Could not render the 8K image. Please try again.')
    } finally {
      setExporting(false)
    }
  }, [
    viewMode,
    metricMode,
    downloadedAt,
    exporting,
    hotspots,
    mostViewed,
    points,
    projectionMode,
    populationRates,
    selectedFocus,
    showHottestMarkers,
    showMostViewedMarkers,
  ])

  return (
    <div className="map-root">
      {projectionMode === 'mercator' ? (
        <MercatorMap
          points={points}
          hotspots={hotspots}
          mostViewed={mostViewed}
          populationRates={populationRates}
          viewMode={viewMode}
          metricMode={metricMode}
          showHottestMarkers={showHottestMarkers}
          showMostViewedMarkers={showMostViewedMarkers}
          focus={focus}
          panRequest={panRequest}
          onSelectFocus={onSelectFocus}
        />
      ) : (
        <EqualEarthMap
          points={points}
          hotspots={hotspots}
          mostViewed={mostViewed}
          populationRates={populationRates}
          viewMode={viewMode}
          metricMode={metricMode}
          showHottestMarkers={showHottestMarkers}
          showMostViewedMarkers={showMostViewedMarkers}
          focus={focus}
          panRequest={panRequest}
          onSelectFocus={onSelectFocus}
        />
      )}

      {selectedFocus?.photo && (
        <PhotoPeek
          focus={selectedFocus}
          onClose={() => onSelectFocus?.(selectedFocus)}
        />
      )}

      <div className="map-controls" aria-label="Map display controls">
        <div className="map-controls__row">
          <ToggleGroup
            label="View"
            compact
            options={[
              { value: 'hex', label: 'Hex' },
              { value: 'points', label: 'Points' },
            ]}
            value={viewMode}
            onChange={(value) => setViewMode(value as ViewMode)}
          />
          {populationRates && (
            <ToggleGroup
              label="Metric"
              compact
              options={[
                { value: 'photos', label: 'Photos' },
                { value: 'population', label: 'Pop' },
                { value: 'per-capita', label: 'Capita' },
              ]}
              value={metricMode}
              onChange={(value) => setMetricMode(value as MetricMode)}
            />
          )}
          <ToggleGroup
            label="Projection"
            compact
            options={[
              { value: 'mercator', label: 'Mercator' },
              { value: 'equal-earth', label: 'Equal Earth' },
            ]}
            value={projectionMode}
            onChange={(value) => setProjectionMode(value as ProjectionMode)}
          />
          <button
            type="button"
            className={`marker-chip${showHottestMarkers ? ' is-active' : ''}`}
            aria-pressed={showHottestMarkers}
            title="Toggle hottest cluster markers"
            onClick={() => setShowHottestMarkers((v) => !v)}
          >
            Hottest
          </button>
          <button
            type="button"
            className={`marker-chip${showMostViewedMarkers ? ' is-active' : ''}`}
            aria-pressed={showMostViewedMarkers}
            title="Toggle most-viewed photo markers"
            onClick={() => setShowMostViewedMarkers((v) => !v)}
          >
            Most viewed
          </button>
          <button
            type="button"
            className="export-button"
            onClick={exportHighRes}
            disabled={exporting || points.length === 0}
            title="Download an 8K PNG matching the selected view and projection"
          >
            {exporting ? 'Rendering…' : 'Export 8K'}
          </button>
        </div>
        <div className="density-legend" aria-hidden="true">
          <span className="density-legend__label">{legend.title}</span>
          <div
            className="density-legend__ramp"
            style={{
              background: `linear-gradient(90deg, ${DENSITY_COLORS.map(
                ([r, g, b]) => `rgb(${r},${g},${b})`,
              ).join(', ')})`,
            }}
          />
          <div className="density-legend__ends">
            <span>{legend.low}</span>
            <span>{legend.high}</span>
          </div>
        </div>
      </div>

      <p className="map-hint">{metricHint(viewMode, metricMode)}</p>
      <p className="map-credit">
        Built by kobakhit · © Natural Earth · © OSM · © CARTO · Flickr · deck.gl
        · population: GHSL GHS-POP R2023A (EC JRC)
      </p>
    </div>
  )
}

type MapModeProps = Pick<
  Props,
  | 'points'
  | 'hotspots'
  | 'mostViewed'
  | 'populationRates'
  | 'focus'
  | 'panRequest'
  | 'onSelectFocus'
> & {
  viewMode: ViewMode
  metricMode: MetricMode
  showHottestMarkers: boolean
  showMostViewedMarkers: boolean
}

function focusFillColor(focus: MapFocus): Rgba {
  if (!focus.color) return [255, 210, 60, 255]
  const c = hexToRgb(focus.color)
  return [c[0], c[1], c[2], 255]
}

function buildFocusLayers(
  focus: MapFocus | null | undefined,
  options?: { cartesian?: boolean },
) {
  if (!focus) return []
  const data = [focus]
  const getPosition = options?.cartesian
    ? (d: MapFocus) => project(d.lon, d.lat)
    : (d: MapFocus) => [d.lon, d.lat] as XY
  const fill = focusFillColor(focus)
  const coordinateSystem = options?.cartesian
    ? COORDINATE_SYSTEM.CARTESIAN
    : undefined
  const coreId = options?.cartesian ? 'focus-core-ee' : 'focus-core'

  return [
    new ScatterplotLayer<MapFocus>({
      id: options?.cartesian ? 'focus-halo-ee' : 'focus-halo',
      data,
      getPosition,
      coordinateSystem,
      getRadius: 22,
      radiusUnits: 'pixels',
      getFillColor: [fill[0], fill[1], fill[2], 55],
      stroked: true,
      getLineColor: [255, 255, 255, 160],
      lineWidthMinPixels: 1.5,
      pickable: false,
    }),
    new ScatterplotLayer<MapFocus>({
      id: coreId,
      data,
      getPosition,
      coordinateSystem,
      getRadius: 8,
      radiusUnits: 'pixels',
      getFillColor: fill,
      stroked: true,
      getLineColor: [255, 255, 255, 240],
      lineWidthMinPixels: 2,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 200],
    }),
  ]
}

function MercatorMap({
  points,
  hotspots,
  mostViewed,
  populationRates,
  viewMode,
  metricMode,
  showHottestMarkers,
  showMostViewedMarkers,
  focus,
  panRequest,
  onSelectFocus,
}: MapModeProps) {
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW)
  const [hover, setHover] = useState<HoverInfo>(null)
  const pointColors = useMemo(
    () => buildPointMetricColors(points, populationRates, metricMode),
    [points, populationRates, metricMode],
  )
  const populationPointColors = useMemo(
    () => buildPopulationPointColors(populationRates),
    [populationRates],
  )
  const populationPointPositions = useMemo(() => {
    if (!populationRates) return [] as [number, number][]
    const cellDeg = populationRates.cellDegrees
    return populationRates.cells.map(
      (cell) => jitterCellCenter(cell.lat, cell.lon, cellDeg),
    )
  }, [populationRates])
  const populationPointRadius = useMemo(
    () =>
      populationPointRadiusPx(
        MERCATOR_UNITS_PER_DEGREE,
        viewState.zoom,
        populationRates?.cellDegrees ?? 0.25,
      ),
    [populationRates?.cellDegrees, viewState.zoom],
  )
  const photoWorldPositions = useMemo(
    () => toFlatPositions(points, toMercatorWorld),
    [points],
  )
  const populationWorldSamples = useMemo(
    () => toFlatPopulationSamples(populationRates, toMercatorWorld),
    [populationRates],
  )
  // Quantized so panning/zooming doesn't re-bin a million samples every frame.
  const hexAggregates = useMemo(() => {
    const zoomStep = Math.round(viewState.zoom * 2) / 2
    const radius = hexRadius(
      MERCATOR_UNITS_PER_DEGREE,
      zoomStep,
      populationRates?.cellDegrees ?? 0,
    )
    return aggregateHexes(radius, photoWorldPositions, populationWorldSamples)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    photoWorldPositions,
    populationWorldSamples,
    populationRates?.cellDegrees,
    Math.round(viewState.zoom * 2) / 2,
  ])
  const metricHexes = useMemo(
    () =>
      buildMetricHexes(
        hexAggregates,
        metricMode,
        populationRates?.populationFloor ?? 1_000,
        fromMercatorWorld,
      ),
    [hexAggregates, metricMode, populationRates?.populationFloor],
  )
  // Hexes only in hex view (until deep zoom). Points view always shows points —
  // World pop uses one dot per inhabited cell (also used as the hex handoff).
  const beyondHexDetail = isBeyondHexDetail(
    MERCATOR_UNITS_PER_DEGREE,
    viewState.zoom,
    populationRates?.cellDegrees ?? 0,
  )
  const showHexes = viewMode === 'hex' && !beyondHexDetail
  const showPhotoPoints =
    metricMode !== 'population' &&
    (viewMode === 'points' || beyondHexDetail)
  const showPopulationPoints =
    metricMode === 'population' &&
    !!populationRates &&
    (viewMode === 'points' || beyondHexDetail)

  useEffect(() => {
    if (!panRequest) return
    if (panRequest.mode === 'reset') {
      setViewState({
        ...INITIAL_VIEW,
        transitionDuration: 900,
        transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
      })
      return
    }
    const { lon, lat } = panRequest
    if (lon == null || lat == null) return
    setViewState((prev) => ({
      ...prev,
      longitude: lon,
      latitude: lat,
      zoom: Math.max(prev.zoom, 4.2),
      transitionDuration: 900,
      transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
    }))
  }, [panRequest])

  const layers = useMemo(() => {
    const hexes = new PolygonLayer<MetricHex>({
      id: 'photo-hex',
      data: metricHexes,
      getPolygon: (d) => d.polygon,
      getFillColor: (d) => d.color,
      // Hexes are only a few pixels wide, so any outline would hide the fill.
      stroked: false,
      filled: true,
      opacity: 0.92,
      visible: showHexes,
      pickable: false,
      updateTriggers: {
        getFillColor: metricMode,
      },
    })

    const dots = new ScatterplotLayer<PhotoPoint>({
      id: 'photo-dots',
      data: points,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 0.85,
      radiusUnits: 'pixels',
      radiusMinPixels: 0.6,
      // Slightly fatter once hex view hands off, so photos stay legible.
      radiusMaxPixels: beyondHexDetail ? 2.8 : 1.35,
      getFillColor: (_d, { index }) => pointColors[index],
      visible: showPhotoPoints,
      pickable: false,
      updateTriggers: {
        getFillColor: pointColors,
      },
    })

    const populationDots = new ScatterplotLayer<{
      position: [number, number]
      color: Rgba
    }>({
      id: 'population-dots',
      data: populationPointPositions.map((position, index) => ({
        position,
        color: populationPointColors[index],
      })),
      getPosition: (d) => d.position,
      getRadius: populationPointRadius,
      radiusUnits: 'pixels',
      radiusMinPixels: 1,
      radiusMaxPixels: 8,
      getFillColor: (d) => d.color,
      visible: showPopulationPoints,
      pickable: false,
      updateTriggers: {
        getRadius: populationPointRadius,
        getFillColor: populationPointColors,
      },
    })

    const pins = new ScatterplotLayer<Hotspot>({
      id: 'hotspot-pins',
      data: hotspots,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 5,
      radiusUnits: 'pixels',
      radiusMinPixels: 4,
      radiusMaxPixels: 7,
      getFillColor: (d) => {
        const c = hexToRgb(d.color)
        return [c[0], c[1], c[2], 255]
      },
      getLineColor: [255, 255, 255, 220],
      lineWidthMinPixels: 1.5,
      stroked: true,
      filled: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 180],
      visible: showHottestMarkers,
    })

    // Amber diamonds via filled circles with a dark ring — distinct from the
    // multicolored hottest-cluster pins.
    const mostViewedPins = new ScatterplotLayer<PhotoPoint>({
      id: 'most-viewed-pins',
      data: mostViewed,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6,
      radiusUnits: 'pixels',
      radiusMinPixels: 5,
      radiusMaxPixels: 8,
      getFillColor: [255, 210, 60, 255],
      getLineColor: [20, 24, 28, 230],
      lineWidthMinPixels: 1.75,
      stroked: true,
      filled: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 200],
      visible: showMostViewedMarkers,
    })

    return [
      hexes,
      dots,
      populationDots,
      pins,
      mostViewedPins,
      ...buildFocusLayers(focus),
    ]
  }, [
    points,
    hotspots,
    mostViewed,
    pointColors,
    populationPointColors,
    populationPointPositions,
    populationPointRadius,
    metricHexes,
    metricMode,
    beyondHexDetail,
    showHexes,
    showPhotoPoints,
    showPopulationPoints,
    showHottestMarkers,
    showMostViewedMarkers,
    focus,
  ])

  const onHover = useCallback((info: PickingInfo<Hotspot | PhotoPoint | MapFocus>) => {
    const layerId = info.layer?.id
    if (info.object && layerId === 'hotspot-pins') {
      const hotspot = info.object as Hotspot
      setHover({
        x: info.x,
        y: info.y,
        preview: focusFromHotspot(hotspot),
      })
      return
    }
    if (info.object && layerId === 'most-viewed-pins') {
      setHover({
        x: info.x,
        y: info.y,
        preview: focusFromPhoto(info.object as PhotoPoint),
      })
      return
    }
    if (
      info.object &&
      (layerId === 'focus-core' || layerId === 'focus-core-ee')
    ) {
      setHover({
        x: info.x,
        y: info.y,
        preview: info.object as MapFocus,
      })
      return
    }
    setHover(null)
  }, [])

  const onClick = useCallback(
    (info: PickingInfo<Hotspot | PhotoPoint | MapFocus>) => {
      const layerId = info.layer?.id
      if (info.object && layerId === 'hotspot-pins') {
        onSelectFocus?.(focusFromHotspot(info.object as Hotspot))
        return
      }
      if (info.object && layerId === 'most-viewed-pins') {
        onSelectFocus?.(focusFromPhoto(info.object as PhotoPoint))
        return
      }
      if (
        info.object &&
        (layerId === 'focus-core' || layerId === 'focus-core-ee')
      ) {
        onSelectFocus?.(info.object as MapFocus)
      }
    },
    [onSelectFocus],
  )

  return (
    <>
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: next }) =>
          setViewState(next as MapViewState)
        }
        controller
        layers={layers}
        onHover={onHover}
        onClick={onClick}
        getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'grab')}
      >
        <MapLibreMap mapStyle={BASEMAP} attributionControl={false} />
      </DeckGL>

      {hover && <MarkerTooltip hover={hover} />}
    </>
  )
}

function EqualEarthMap({
  points,
  hotspots,
  mostViewed,
  populationRates,
  viewMode,
  metricMode,
  showHottestMarkers,
  showMostViewedMarkers,
  focus,
  panRequest,
  onSelectFocus,
}: MapModeProps) {
  const [viewState, setViewState] = useState<OrthographicViewState>(
    EQUAL_EARTH_INITIAL,
  )
  const [hover, setHover] = useState<HoverInfo>(null)
  // Hexes only in hex view. Points view always shows points — World pop uses
  // one projected dot per inhabited cell (also the hex deep-zoom handoff).
  const beyondHexDetail = isBeyondHexDetail(
    EQUAL_EARTH_UNITS_PER_DEGREE,
    Number(viewState.zoom ?? 0),
    populationRates?.cellDegrees ?? 0,
  )
  const showHexes = viewMode === 'hex' && !beyondHexDetail
  const showPhotoPoints =
    metricMode !== 'population' &&
    (viewMode === 'points' || beyondHexDetail)
  const showPopulationPoints =
    metricMode === 'population' &&
    !!populationRates &&
    (viewMode === 'points' || beyondHexDetail)

  useEffect(() => {
    if (!panRequest) return
    if (panRequest.mode === 'reset') {
      setViewState({
        ...EQUAL_EARTH_INITIAL,
        transitionDuration: 700,
      })
      return
    }
    const { lon, lat } = panRequest
    if (lon == null || lat == null) return
    const [x, y] = project(lon, lat)
    setViewState((prev) => ({
      ...prev,
      target: [x, y, 0],
      zoom: Math.max(Number(prev.zoom ?? 0), 1.8),
      transitionDuration: 700,
    }))
  }, [panRequest])

  const projectedPoints = useMemo<ProjectedPoint[]>(() => {
    const colors = buildPointMetricColors(points, populationRates, metricMode)
    return points.map((source, index) => ({
      source,
      position: project(source.lon, source.lat),
      color: colors[index],
    }))
  }, [points, populationRates, metricMode])
  const projectedPopulationDots = useMemo(() => {
    if (!populationRates) return []
    const colors = buildPopulationPointColors(populationRates)
    const cellDeg = populationRates.cellDegrees
    return populationRates.cells.map((cell, index) => {
      const [lon, lat] = jitterCellCenter(cell.lat, cell.lon, cellDeg)
      return {
        position: project(lon, lat),
        color: colors[index],
      }
    })
  }, [populationRates])
  const populationPointRadius = useMemo(
    () =>
      populationPointRadiusPx(
        EQUAL_EARTH_UNITS_PER_DEGREE,
        Number(viewState.zoom ?? 0),
        populationRates?.cellDegrees ?? 0.25,
      ),
    [populationRates?.cellDegrees, viewState.zoom],
  )
  const projectedHotspots = useMemo<ProjectedHotspot[]>(
    () =>
      hotspots.map((source) => ({
        source,
        position: project(source.lon, source.lat),
      })),
    [hotspots],
  )
  const projectedMostViewed = useMemo(
    () =>
      mostViewed.map((source) => ({
        source,
        position: project(source.lon, source.lat),
      })),
    [mostViewed],
  )
  const photoProjectedPositions = useMemo(
    () => toFlatPositions(points, project),
    [points],
  )
  const populationProjectedSamples = useMemo(
    () => toFlatPopulationSamples(populationRates, project),
    [populationRates],
  )
  const hexAggregates = useMemo(() => {
    const zoomStep = Math.round(Number(viewState.zoom ?? 0) * 2) / 2
    const radius = hexRadius(
      EQUAL_EARTH_UNITS_PER_DEGREE,
      zoomStep,
      populationRates?.cellDegrees ?? 0,
    )
    return aggregateHexes(
      radius,
      photoProjectedPositions,
      populationProjectedSamples,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    photoProjectedPositions,
    populationProjectedSamples,
    populationRates?.cellDegrees,
    Math.round(Number(viewState.zoom ?? 0) * 2) / 2,
  ])
  const metricHexes = useMemo(
    () =>
      buildMetricHexes(
        hexAggregates,
        metricMode,
        populationRates?.populationFloor ?? 1_000,
        // Already in Equal Earth space; hand the vertex through untouched.
        (x, y) => [x, y],
      ),
    [hexAggregates, metricMode, populationRates?.populationFloor],
  )

  const layers = useMemo(() => {
    const land = new PolygonLayer<XY[][]>({
      id: 'equal-earth-land',
      data: WORLD_POLYGONS,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPolygon: (d) => d,
      getFillColor: [20, 24, 27, 255],
      getLineColor: [68, 73, 76, 180],
      lineWidthMinPixels: 0.5,
      stroked: true,
      filled: true,
      pickable: false,
    })

    const hexes = new PolygonLayer<MetricHex>({
      id: 'equal-earth-hex',
      data: metricHexes,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPolygon: (d) => d.polygon,
      getFillColor: (d) => d.color,
      stroked: false,
      filled: true,
      opacity: 0.92,
      visible: showHexes,
      pickable: false,
      updateTriggers: {
        getFillColor: metricMode,
      },
    })

    const dots = new ScatterplotLayer<ProjectedPoint>({
      id: 'equal-earth-points',
      data: projectedPoints,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPosition: (d) => d.position,
      getRadius: 0.85,
      radiusUnits: 'pixels',
      radiusMinPixels: 0.6,
      radiusMaxPixels: beyondHexDetail ? 2.8 : 1.35,
      getFillColor: (d) => d.color,
      visible: showPhotoPoints,
      pickable: false,
      updateTriggers: {
        getFillColor: metricMode,
      },
    })

    const populationDots = new ScatterplotLayer<{
      position: XY
      color: Rgba
    }>({
      id: 'equal-earth-population-dots',
      data: projectedPopulationDots,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPosition: (d) => d.position,
      getRadius: populationPointRadius,
      radiusUnits: 'pixels',
      radiusMinPixels: 1,
      radiusMaxPixels: 8,
      getFillColor: (d) => d.color,
      visible: showPopulationPoints,
      pickable: false,
      updateTriggers: {
        getRadius: populationPointRadius,
      },
    })

    const pins = new ScatterplotLayer<ProjectedHotspot>({
      id: 'equal-earth-pins',
      data: projectedHotspots,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPosition: (d) => d.position,
      getRadius: 5,
      radiusUnits: 'pixels',
      radiusMinPixels: 4,
      radiusMaxPixels: 7,
      getFillColor: (d) => {
        const color = hexToRgb(d.source.color)
        return [color[0], color[1], color[2], 255]
      },
      getLineColor: [255, 255, 255, 220],
      lineWidthMinPixels: 1.5,
      stroked: true,
      filled: true,
      pickable: true,
      autoHighlight: true,
      visible: showHottestMarkers,
    })

    const mostViewedPins = new ScatterplotLayer<{
      source: PhotoPoint
      position: XY
    }>({
      id: 'equal-earth-most-viewed',
      data: projectedMostViewed,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPosition: (d) => d.position,
      getRadius: 6,
      radiusUnits: 'pixels',
      radiusMinPixels: 5,
      radiusMaxPixels: 8,
      getFillColor: [255, 210, 60, 255],
      getLineColor: [20, 24, 28, 230],
      lineWidthMinPixels: 1.75,
      stroked: true,
      filled: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 200],
      visible: showMostViewedMarkers,
    })

    return [
      land,
      hexes,
      dots,
      populationDots,
      pins,
      mostViewedPins,
      ...buildFocusLayers(focus, { cartesian: true }),
    ]
  }, [
    beyondHexDetail,
    focus,
    metricHexes,
    metricMode,
    projectedHotspots,
    projectedMostViewed,
    projectedPoints,
    projectedPopulationDots,
    populationPointRadius,
    showHexes,
    showPhotoPoints,
    showPopulationPoints,
    showHottestMarkers,
    showMostViewedMarkers,
  ])

  const onHover = useCallback(
    (
      info: PickingInfo<
        ProjectedHotspot | { source: PhotoPoint; position: XY } | MapFocus
      >,
    ) => {
      const layerId = info.layer?.id
      if (info.object && layerId === 'equal-earth-pins') {
        setHover({
          x: info.x,
          y: info.y,
          preview: focusFromHotspot((info.object as ProjectedHotspot).source),
        })
        return
      }
      if (info.object && layerId === 'equal-earth-most-viewed') {
        setHover({
          x: info.x,
          y: info.y,
          preview: focusFromPhoto(
            (info.object as { source: PhotoPoint }).source,
          ),
        })
        return
      }
      if (info.object && layerId === 'focus-core-ee') {
        setHover({
          x: info.x,
          y: info.y,
          preview: info.object as MapFocus,
        })
        return
      }
      setHover(null)
    },
    [],
  )

  const onClick = useCallback(
    (
      info: PickingInfo<
        ProjectedHotspot | { source: PhotoPoint; position: XY } | MapFocus
      >,
    ) => {
      const layerId = info.layer?.id
      if (info.object && layerId === 'equal-earth-pins') {
        onSelectFocus?.(
          focusFromHotspot((info.object as ProjectedHotspot).source),
        )
        return
      }
      if (info.object && layerId === 'equal-earth-most-viewed') {
        onSelectFocus?.(
          focusFromPhoto((info.object as { source: PhotoPoint }).source),
        )
        return
      }
      if (info.object && layerId === 'focus-core-ee') {
        onSelectFocus?.(info.object as MapFocus)
      }
    },
    [onSelectFocus],
  )

  return (
    <>
      <DeckGL
        views={new OrthographicView({ id: 'equal-earth', flipY: true })}
        viewState={viewState}
        onViewStateChange={({ viewState: next }) =>
          setViewState(next as OrthographicViewState)
        }
        controller
        layers={layers}
        onHover={onHover}
        onClick={onClick}
        getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'grab')}
      />
      {hover && <MarkerTooltip hover={hover} />}
    </>
  )
}

function MarkerTooltip({ hover }: { hover: NonNullable<HoverInfo> }) {
  const { preview } = hover
  return (
    <div
      className="deck-tooltip"
      style={{ left: hover.x + 12, top: hover.y + 12 }}
    >
      {preview.photo?.url ? (
        <img src={preview.photo.url} alt="" />
      ) : null}
      <strong>{preview.label}</strong>
      {preview.subtitle ? <span>{preview.subtitle}</span> : null}
      {preview.photo?.title && preview.photo.title !== preview.label ? (
        <span className="deck-tooltip__sample">{preview.photo.title}</span>
      ) : null}
      {preview.photo ? (
        <span className="deck-tooltip__hint">Click for Flickr link</span>
      ) : null}
    </div>
  )
}

function PhotoPeek({
  focus,
  onClose,
}: {
  focus: MapFocus
  onClose: () => void
}) {
  const photo = focus.photo
  if (!photo) return null

  return (
    <aside className="photo-peek" aria-label="Selected photo">
      {photo.url ? (
        <a
          href={photo.flickrUrl}
          target="_blank"
          rel="noreferrer"
          className="photo-peek__image-link"
        >
          <img src={photo.url} alt={photo.title} />
        </a>
      ) : null}
      <div className="photo-peek__body">
        <p className="photo-peek__place">{focus.label}</p>
        <p className="photo-peek__title">{photo.title}</p>
        {focus.subtitle ? (
          <p className="photo-peek__meta">{focus.subtitle}</p>
        ) : null}
        <div className="photo-peek__actions">
          <a
            href={photo.flickrUrl}
            target="_blank"
            rel="noreferrer"
            className="photo-peek__link"
          >
            Open on Flickr
          </a>
          <button type="button" className="photo-peek__close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </aside>
  )
}

type ToggleGroupProps = {
  label: string
  options: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
  compact?: boolean
}

function ToggleGroup({
  label,
  options,
  value,
  onChange,
  compact = false,
}: ToggleGroupProps) {
  return (
    <fieldset
      className={`toggle-group${compact ? ' toggle-group--compact' : ''}`}
    >
      <legend>{label}</legend>
      <div>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? 'is-active' : ''}
            aria-pressed={value === option.value}
            title={`${label}: ${option.label}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function formatAsOfDate(iso?: string): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

async function downloadHighResMap(
  points: PhotoPoint[],
  hotspots: Hotspot[],
  mostViewed: PhotoPoint[],
  options: {
    viewMode: ViewMode
    metricMode: MetricMode
    projectionMode: ProjectionMode
    downloadedAt?: string
    selectedFocus?: MapFocus | null
    populationRates?: PopulationRateDataset | null
    showHottestMarkers?: boolean
    showMostViewedMarkers?: boolean
  },
): Promise<void> {
  const width = 7680
  const height = 4320
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is unavailable')

  const projection = createExportProjection(
    options.projectionMode,
    width,
    height,
  )
  const path = geoPath(projection, context)

  // Flat, print-friendly foundation — darker land so points punch through.
  context.fillStyle = '#05070a'
  context.fillRect(0, 0, width, height)

  // Mercator only: soft ocean plate. Equal Earth skips the rounded Sphere
  // outline so the map sits flush on the flat canvas.
  if (options.projectionMode === 'mercator') {
    context.beginPath()
    path({ type: 'Sphere' })
    context.fillStyle = '#0a0e12'
    context.fill()
    context.strokeStyle = '#3a454d'
    context.lineWidth = 3
    context.stroke()
  }

  context.beginPath()
  path(geoGraticule10())
  context.strokeStyle = 'rgba(90, 105, 115, 0.18)'
  context.lineWidth = 1
  context.stroke()

  context.beginPath()
  path(WORLD_COUNTRIES)
  context.fillStyle = '#12171c'
  context.fill()
  context.strokeStyle = '#3f4a52'
  context.lineWidth = 1.5
  context.stroke()

  // Hex view shares one tessellation across metrics. Points view always draws
  // points — World pop uses one dot per inhabited 0.25° cell.
  if (options.viewMode === 'hex') {
    drawExportHexes(
      context,
      points,
      projection,
      options.metricMode,
      options.populationRates ?? null,
    )
  } else if (
    options.metricMode === 'population' &&
    options.populationRates
  ) {
    drawExportPopulationPoints(context, options.populationRates, projection)
  } else {
    drawExportPoints(context, points, projection, {
      metricMode: options.metricMode,
      populationRates: options.populationRates,
    })
  }

  if (options.showHottestMarkers !== false) {
    drawExportHotspots(context, hotspots, projection)
  }
  if (options.showMostViewedMarkers !== false) {
    drawExportMostViewed(context, mostViewed, projection)
  }
  if (options.selectedFocus) {
    drawExportFocusMarker(context, options.selectedFocus, projection)
  }

  // Header mirrors the live map.
  const asOf = formatAsOfDate(options.downloadedAt)
  context.textBaseline = 'alphabetic'
  context.fillStyle = '#ffd23c'
  context.font = '800 72px Arial, sans-serif'
  context.fillText('Most photographed places 2026', 260, 210)
  context.fillStyle = '#9ba6ad'
  context.font = '400 28px Arial, sans-serif'
  context.fillText(
    [
      'Source: Flickr',
      `${points.length.toLocaleString()} geotagged photos`,
      asOf ? `As of ${asOf}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    260,
    268,
  )
  const legend = metricLegendLabels(options.metricMode)
  drawExportDensityLegend(
    context,
    260,
    300,
    `Low ${legend.title.toLowerCase()}`,
    `High ${legend.title.toLowerCase()}`,
  )

  drawExportControls(context, width, options)
  await drawExportPanels(context, width, height, hotspots, mostViewed)
  if (options.selectedFocus?.photo) {
    await drawExportPhotoPeek(context, height, options.selectedFocus)
  }

  context.textAlign = 'left'
  context.fillStyle = '#75818a'
  context.font = '400 22px Arial, sans-serif'
  context.fillText(
    'Built by kobakhit · Flickr · GHSL GHS-POP R2023A · Natural Earth · 7680 × 4320',
    220,
    height - 90,
  )
  context.textAlign = 'start'

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result)
      else reject(new Error('PNG encoding failed'))
    }, 'image/png')
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `flickr-2026-${options.viewMode}-${options.metricMode}-${options.projectionMode}-8k.png`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function createExportProjection(
  mode: ProjectionMode,
  width: number,
  height: number,
): GeoProjection {
  // Fill the 16:9 canvas for every export mode. Full-world extents that are
  // taller/square than 16:9 leave empty gutters if we only fitExtent the Sphere.
  const padX = 24
  const padY = 32

  if (mode === 'equal-earth') {
    const projection = geoEqualEarth().fitWidth(width - padX * 2, {
      type: 'Sphere',
    })
    // Nudge larger than fitWidth so poles crop slightly and land dominates.
    projection.scale(projection.scale() * 1.16)
    projection.translate([width / 2, height / 2 + 18])
    projection.clipExtent([
      [padX, padY],
      [width - padX, height - padY],
    ])
    return projection
  }

  // Mercator: fill width; clip latitudes beyond roughly ±72°.
  const scale = (width - padX * 2) / (2 * Math.PI)
  return geoMercator()
    .scale(scale)
    .translate([width / 2, height / 2 + 18])
    .clipExtent([
      [padX, padY],
      [width - padX, height - padY],
    ])
}

function drawExportPoints(
  context: CanvasRenderingContext2D,
  points: PhotoPoint[],
  projection: GeoProjection,
  options?: {
    metricMode?: MetricMode
    populationRates?: PopulationRateDataset | null
  },
) {
  const colors = buildPointMetricColors(
    points,
    options?.populationRates ?? null,
    options?.metricMode ?? 'photos',
  )
  const pointSize = 3.6
  const half = pointSize / 2
  // Batch by color so we don't set fillStyle ~300k times.
  const buckets = new Map<string, XY[]>()
  for (let i = 0; i < points.length; i += 1) {
    const xy = projection([points[i].lon, points[i].lat])
    if (!xy) continue
    const [r, g, b, a] = colors[i]
    const key = `${r},${g},${b},${a}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(xy)
    else buckets.set(key, [xy])
  }

  context.save()
  for (const [key, coords] of buckets) {
    const [r, g, b, a] = key.split(',').map(Number)
    context.fillStyle = `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`
    for (const xy of coords) {
      context.fillRect(xy[0] - half, xy[1] - half, pointSize, pointSize)
    }
  }
  context.restore()
}

function drawExportPopulationPoints(
  context: CanvasRenderingContext2D,
  dataset: PopulationRateDataset,
  projection: GeoProjection,
) {
  const colors = buildPopulationPointColors(dataset)
  const origin = projection([0, 0])
  const eastward = projection([dataset.cellDegrees, 0])
  const northward = projection([0, dataset.cellDegrees])
  const spacingX =
    origin && eastward ? Math.abs(eastward[0] - origin[0]) : 5
  const spacingY =
    origin && northward ? Math.abs(northward[1] - origin[1]) : spacingX
  // Cover the cell so Equal Earth latitude rows don't leave dark scanlines.
  const pointSize = Math.max(4.5, Math.min(spacingX, spacingY) * 1.15)
  const half = pointSize / 2
  const buckets = new Map<string, XY[]>()
  for (let i = 0; i < dataset.cells.length; i += 1) {
    const cell = dataset.cells[i]
    const [lon, lat] = jitterCellCenter(
      cell.lat,
      cell.lon,
      dataset.cellDegrees,
    )
    const xy = projection([lon, lat])
    if (!xy) continue
    const [r, g, b, a] = colors[i]
    const key = `${r},${g},${b},${a}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(xy)
    else buckets.set(key, [xy])
  }

  context.save()
  for (const [key, coords] of buckets) {
    const [r, g, b, a] = key.split(',').map(Number)
    context.fillStyle = `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`
    for (const xy of coords) {
      context.beginPath()
      context.arc(xy[0], xy[1], half, 0, Math.PI * 2)
      context.fill()
    }
  }
  context.restore()
}

/** Hex size for exports, chosen to match the default world view on screen. */
const EXPORT_HEX_DEGREES = 0.8

function drawExportHexes(
  context: CanvasRenderingContext2D,
  points: PhotoPoint[],
  projection: GeoProjection,
  metric: MetricMode,
  dataset: PopulationRateDataset | null,
) {
  const toSpace = (lon: number, lat: number): XY =>
    (projection([lon, lat]) as XY | null) ?? [NaN, NaN]
  const origin = projection([0, 0])
  const eastward = projection([1, 0])
  const pixelsPerDegree =
    origin && eastward ? Math.abs(eastward[0] - origin[0]) : 21
  const radius =
    Math.max(EXPORT_HEX_DEGREES, dataset?.cellDegrees ?? 0) * pixelsPerDegree

  const hexes = buildMetricHexes(
    aggregateHexes(
      radius,
      toFlatPositions(points, toSpace),
      toFlatPopulationSamples(dataset, toSpace),
    ),
    metric,
    dataset?.populationFloor ?? 1_000,
    (x, y) => [x, y],
  )

  // Batch by color so the 8K canvas isn't restyled per hex.
  const grouped = new Map<string, [number, number][][]>()
  for (const hex of hexes) {
    const [r, g, b] = hex.color
    const key = `${r},${g},${b}`
    const bucket = grouped.get(key)
    if (bucket) bucket.push(hex.polygon)
    else grouped.set(key, [hex.polygon])
  }

  context.save()
  for (const [key, polygons] of grouped) {
    context.beginPath()
    for (const polygon of polygons) {
      polygon.forEach(([x, y], i) => {
        if (i === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.closePath()
    }
    context.fillStyle = `rgba(${key}, 0.92)`
    context.fill()
  }
  context.restore()
}

function drawExportFocusMarker(
  context: CanvasRenderingContext2D,
  focus: MapFocus,
  projection: GeoProjection,
) {
  const xy = projection([focus.lon, focus.lat])
  if (!xy) return
  const [x, y] = xy
  const [r, g, b] = focus.color ? hexToRgb(focus.color) : [255, 210, 60]

  context.beginPath()
  context.arc(x, y, 28, 0, Math.PI * 2)
  context.fillStyle = `rgba(${r},${g},${b},0.22)`
  context.fill()
  context.strokeStyle = 'rgba(255,255,255,0.7)'
  context.lineWidth = 3
  context.stroke()

  context.beginPath()
  context.arc(x, y, 12, 0, Math.PI * 2)
  context.fillStyle = `rgb(${r},${g},${b})`
  context.fill()
  context.strokeStyle = '#ffffff'
  context.lineWidth = 3
  context.stroke()
}

async function drawExportPhotoPeek(
  context: CanvasRenderingContext2D,
  height: number,
  focus: MapFocus,
) {
  const photo = focus.photo
  if (!photo) return

  const x = 180
  const width = 980
  const imageHeight = 620
  const bodyHeight = 280
  const heightTotal = imageHeight + bodyHeight
  const y = height - heightTotal - 160

  drawPanel(context, x, y, width, heightTotal)

  const bitmap = await loadPhotoBitmap(photo.url)
  if (bitmap) {
    // Cover-fit into the image area.
    const scale = Math.max(width / bitmap.width, imageHeight / bitmap.height)
    const drawW = bitmap.width * scale
    const drawH = bitmap.height * scale
    const dx = x + (width - drawW) / 2
    const dy = y + (imageHeight - drawH) / 2
    context.save()
    context.beginPath()
    context.rect(x, y, width, imageHeight)
    context.clip()
    context.drawImage(bitmap, dx, dy, drawW, drawH)
    context.restore()
    bitmap.close()
  } else {
    context.fillStyle = '#20272d'
    context.fillRect(x, y, width, imageHeight)
  }

  const textX = x + 48
  const bodyTop = y + imageHeight + 58
  context.fillStyle = '#8b969e'
  context.font = '700 26px Arial, sans-serif'
  context.fillText(focus.label.toUpperCase(), textX, bodyTop)

  context.fillStyle = '#eef1f3'
  context.font = '600 36px Arial, sans-serif'
  context.fillText(
    truncateCanvasText(context, photo.title, width - 96),
    textX,
    bodyTop + 55,
  )

  if (focus.subtitle) {
    context.fillStyle = '#8b969e'
    context.font = '400 26px Arial, sans-serif'
    context.fillText(focus.subtitle, textX, bodyTop + 100)
  }

  context.fillStyle = '#ffd23c'
  context.font = '600 28px Arial, sans-serif'
  context.fillText('Open on Flickr', textX, bodyTop + 160)
}

function drawExportHotspots(
  context: CanvasRenderingContext2D,
  hotspots: Hotspot[],
  projection: GeoProjection,
) {
  context.font = '500 30px Arial, sans-serif'
  context.textBaseline = 'middle'
  for (const hotspot of hotspots.slice(0, 10)) {
    const xy = projection([hotspot.lon, hotspot.lat])
    if (!xy) continue
    const [x, y] = xy
    context.beginPath()
    context.arc(x, y, 8, 0, Math.PI * 2)
    context.fillStyle = hotspot.color
    context.fill()
    context.strokeStyle = '#ffffff'
    context.lineWidth = 2
    context.stroke()

    const label = hotspot.placeName.split(',')[0]
    context.lineWidth = 7
    context.strokeStyle = 'rgba(8, 11, 14, 0.9)'
    context.strokeText(label, x + 16, y)
    context.fillStyle = '#e8ecef'
    context.fillText(label, x + 16, y)
  }
}

function drawExportMostViewed(
  context: CanvasRenderingContext2D,
  photos: PhotoPoint[],
  projection: GeoProjection,
) {
  context.font = '500 28px Arial, sans-serif'
  context.textBaseline = 'middle'
  for (const photo of photos) {
    const xy = projection([photo.lon, photo.lat])
    if (!xy) continue
    const [x, y] = xy
    context.beginPath()
    context.arc(x, y, 9, 0, Math.PI * 2)
    context.fillStyle = '#ffd23c'
    context.fill()
    context.strokeStyle = '#14181c'
    context.lineWidth = 2.5
    context.stroke()

    const label = (photo.title || 'Untitled').slice(0, 28)
    context.lineWidth = 7
    context.strokeStyle = 'rgba(8, 11, 14, 0.9)'
    context.strokeText(label, x + 16, y)
    context.fillStyle = '#ffd23c'
    context.fillText(label, x + 16, y)
  }
}

function drawExportDensityLegend(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  lowLabel = 'Low density',
  highLabel = 'High density',
) {
  const rampWidth = 520
  const rampHeight = 22
  const gradient = context.createLinearGradient(x, y, x + rampWidth, y)
  DENSITY_COLORS.forEach(([r, g, b], index) => {
    gradient.addColorStop(
      index / Math.max(DENSITY_COLORS.length - 1, 1),
      `rgb(${r},${g},${b})`,
    )
  })
  context.fillStyle = gradient
  context.fillRect(x, y, rampWidth, rampHeight)
  context.strokeStyle = 'rgba(255,255,255,0.2)'
  context.lineWidth = 1
  context.strokeRect(x, y, rampWidth, rampHeight)

  context.fillStyle = '#8b969e'
  context.font = '500 22px Arial, sans-serif'
  context.fillText(lowLabel, x, y + 52)
  context.textAlign = 'right'
  context.fillText(highLabel, x + rampWidth, y + 52)
  context.textAlign = 'start'
}

function drawExportControls(
  context: CanvasRenderingContext2D,
  width: number,
  options: {
    viewMode: ViewMode
    metricMode: MetricMode
    projectionMode: ProjectionMode
    showHottestMarkers?: boolean
    showMostViewedMarkers?: boolean
  },
) {
  const x = width - 2100
  const y = 90
  const panelWidth = 1840
  const panelHeight = 250
  drawPanel(context, x, y, panelWidth, panelHeight)

  drawExportToggle(
    context,
    x + 45,
    y + 38,
    'VIEW',
    ['Hex density', 'Points'],
    options.viewMode === 'hex' ? 0 : 1,
    175,
  )
  drawExportToggle(
    context,
    x + 420,
    y + 38,
    'METRIC',
    ['Photo count', 'World pop', 'Per capita'],
    options.metricMode === 'photos'
      ? 0
      : options.metricMode === 'population'
        ? 1
        : 2,
    155,
  )
  drawExportToggle(
    context,
    x + 910,
    y + 38,
    'PROJECTION',
    ['Mercator', 'Equal Earth'],
    options.projectionMode === 'mercator' ? 0 : 1,
    165,
  )
  drawExportToggle(
    context,
    x + 1265,
    y + 38,
    'HOTTEST',
    ['Show', 'Hide'],
    options.showHottestMarkers === false ? 1 : 0,
    120,
  )
  drawExportToggle(
    context,
    x + 1525,
    y + 38,
    'MOST VIEWED',
    ['Show', 'Hide'],
    options.showMostViewedMarkers === false ? 1 : 0,
    120,
  )

  context.fillStyle = 'rgba(255, 210, 60, 0.12)'
  context.strokeStyle = 'rgba(255, 210, 60, 0.6)'
  context.lineWidth = 2
  context.fillRect(x + 1520, y + 148, 265, 65)
  context.strokeRect(x + 1520, y + 148, 265, 65)
  context.fillStyle = '#ffd23c'
  context.font = '600 27px Arial, sans-serif'
  context.textAlign = 'center'
  context.fillText('Export 8K', x + 1652, y + 190)
  context.textAlign = 'start'
}

function drawExportToggle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  options: string[],
  selected: number,
  buttonWidth = 245,
) {
  context.fillStyle = '#8b969e'
  context.font = '500 19px Arial, sans-serif'
  context.fillText(label, x, y)
  const buttonY = y + 22
  options.forEach((option, index) => {
    context.fillStyle =
      index === selected ? '#ffd23c' : 'rgba(255,255,255,0.035)'
    context.fillRect(x + index * buttonWidth, buttonY, buttonWidth, 65)
    context.strokeStyle = 'rgba(255,255,255,0.16)'
    context.lineWidth = 2
    context.strokeRect(x + index * buttonWidth, buttonY, buttonWidth, 65)
    context.fillStyle = index === selected ? '#161616' : '#9ba6ad'
    context.font = '500 22px Arial, sans-serif'
    context.textAlign = 'center'
    context.fillText(
      option,
      x + index * buttonWidth + buttonWidth / 2,
      buttonY + 42,
    )
  })
  context.textAlign = 'start'
}

async function drawExportPanels(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  hotspots: Hotspot[],
  mostViewed: PhotoPoint[],
) {
  const panelWidth = 1180
  const gap = 36
  const rowHeight = 78
  const padding = 48
  const hotspotCount = 7
  const viewedCount = 7
  const panelHeight = 150 + rowHeight * Math.max(hotspotCount, viewedCount)
  const y = height - panelHeight - 150
  const rightX = width - panelWidth - 160
  const leftX = rightX - panelWidth - gap

  drawPanel(context, leftX, y, panelWidth, panelHeight)
  drawPanel(context, rightX, y, panelWidth, panelHeight)

  drawPanelTitle(context, 'HOTTEST CLUSTERS', leftX + padding, y + 62)
  hotspots.slice(0, hotspotCount).forEach((hotspot, index) => {
    const rowY = y + 125 + index * rowHeight
    context.beginPath()
    context.arc(leftX + padding + 12, rowY - 7, 12, 0, Math.PI * 2)
    context.fillStyle = hotspot.color
    context.fill()
    drawPanelRow(
      context,
      hotspot.placeName,
      hotspot.count.toLocaleString(),
      leftX + padding + 45,
      rowY,
      panelWidth - padding * 2 - 45,
    )
  })

  drawPanelTitle(context, 'MOST VIEWED', rightX + padding, y + 62)
  const bitmaps = await Promise.all(
    mostViewed.slice(0, viewedCount).map((photo) => loadPhotoBitmap(photo.url)),
  )
  mostViewed.slice(0, viewedCount).forEach((photo, index) => {
    const rowY = y + 125 + index * rowHeight
    const bitmap = bitmaps[index]
    if (bitmap) {
      context.drawImage(bitmap, rightX + padding, rowY - 45, 58, 58)
      bitmap.close()
    } else {
      context.fillStyle = '#20272d'
      context.fillRect(rightX + padding, rowY - 45, 58, 58)
    }
    drawPanelRow(
      context,
      photo.title || 'Untitled',
      photo.views.toLocaleString(),
      rightX + padding + 82,
      rowY,
      panelWidth - padding * 2 - 82,
    )
  })
}

function drawPanel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  context.fillStyle = 'rgba(8, 12, 16, 0.84)'
  context.fillRect(x, y, width, height)
  context.strokeStyle = 'rgba(255,255,255,0.12)'
  context.lineWidth = 2
  context.strokeRect(x, y, width, height)
}

function drawPanelTitle(
  context: CanvasRenderingContext2D,
  title: string,
  x: number,
  y: number,
) {
  context.fillStyle = '#8b969e'
  context.font = '700 25px Arial, sans-serif'
  context.fillText(title, x, y)
}

function drawPanelRow(
  context: CanvasRenderingContext2D,
  label: string,
  value: string,
  x: number,
  y: number,
  availableWidth: number,
) {
  context.font = '500 28px Arial, sans-serif'
  const valueWidth = context.measureText(value).width
  const maxLabelWidth = availableWidth - valueWidth - 35
  context.fillStyle = '#e8ecef'
  context.fillText(truncateCanvasText(context, label, maxLabelWidth), x, y)
  context.fillStyle = '#8b969e'
  context.textAlign = 'right'
  context.fillText(value, x + availableWidth, y)
  context.textAlign = 'start'
}

function truncateCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (context.measureText(text).width <= maxWidth) return text
  let shortened = text
  while (
    shortened.length > 1 &&
    context.measureText(`${shortened}…`).width > maxWidth
  ) {
    shortened = shortened.slice(0, -1)
  }
  return `${shortened}…`
}

async function loadPhotoBitmap(
  url?: string,
): Promise<ImageBitmap | null> {
  if (!url) return null
  try {
    const response = await fetch(url, { mode: 'cors' })
    if (!response.ok) return null
    return await createImageBitmap(await response.blob())
  } catch {
    return null
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ]
}
