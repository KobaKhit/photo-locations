import { useMemo, useState, useCallback, useEffect } from 'react'
import DeckGL from '@deck.gl/react'
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import { HexagonLayer } from '@deck.gl/aggregation-layers'
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
import type { Hotspot, PhotoPoint } from './flickr'

type Props = {
  points: PhotoPoint[]
  hotspots: Hotspot[]
  mostViewed: PhotoPoint[]
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

type DisplayMode = 'hex' | 'points'
type ProjectionMode = 'mercator' | 'equal-earth'
type XY = [number, number]
type Rgba = [number, number, number, number]
type ProjectedPoint = { source: PhotoPoint; position: XY; color: Rgba }
type ProjectedHotspot = { source: Hotspot; position: XY }
type EqualEarthBin = {
  polygon: XY[]
  count: number
  color: Rgba
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

const equalEarth = geoEqualEarth().scale(140).translate([0, 0])

function project(lon: number, lat: number): XY {
  return equalEarth([lon, lat]) as XY
}

const WORLD_COUNTRIES = (() => {
  const topology = countries110m as unknown as Topology<{
    countries: GeometryCollection
  }>
  return feature(
    topology,
    topology.objects.countries,
  ) as FeatureCollection<Polygon | MultiPolygon>
})()

function buildWorldPolygons(): XY[][][] {
  const polygons: XY[][][] = []

  for (const country of WORLD_COUNTRIES.features) {
    if (country.geometry.type === 'Polygon') {
      polygons.push(
        country.geometry.coordinates.map((ring) =>
          ring.map(([lon, lat]) => project(lon, lat)),
        ),
      )
    } else {
      for (const polygon of country.geometry.coordinates) {
        polygons.push(
          polygon.map((ring) =>
            ring.map(([lon, lat]) => project(lon, lat)),
          ),
        )
      }
    }
  }
  return polygons
}

const WORLD_POLYGONS = buildWorldPolygons()

function buildEqualEarthBins(
  points: ProjectedPoint[],
  radius = 2.2,
): EqualEarthBin[] {
  type Bin = { q: number; r: number; count: number }
  const bins = new Map<string, Bin>()
  const sqrt3 = Math.sqrt(3)

  // Pointy-top axial hex coordinates, rounded through cube space.
  for (const point of points) {
    const [x, y] = point.position
    const q = (sqrt3 / 3 * x - y / 3) / radius
    const r = (2 / 3 * y) / radius
    const cubeX = q
    const cubeZ = r
    const cubeY = -cubeX - cubeZ
    let rx = Math.round(cubeX)
    let ry = Math.round(cubeY)
    let rz = Math.round(cubeZ)
    const dx = Math.abs(rx - cubeX)
    const dy = Math.abs(ry - cubeY)
    const dz = Math.abs(rz - cubeZ)
    if (dx > dy && dx > dz) rx = -ry - rz
    else if (dy > dz) ry = -rx - rz
    else rz = -rx - ry

    const key = `${rx},${rz}`
    const bin = bins.get(key)
    if (bin) bin.count += 1
    else bins.set(key, { q: rx, r: rz, count: 1 })
  }

  const counts = [...bins.values()]
    .map((bin) => bin.count)
    .sort((a, b) => a - b)
  const cap = counts[Math.floor(counts.length * 0.97)] ?? 1

  return [...bins.values()].map((bin) => {
    const cx = radius * sqrt3 * (bin.q + bin.r / 2)
    const cy = radius * 1.5 * bin.r
    const polygon = Array.from({ length: 6 }, (_, i): XY => {
      const angle = ((60 * i - 30) * Math.PI) / 180
      return [
        cx + radius * 0.91 * Math.cos(angle),
        cy + radius * 0.91 * Math.sin(angle),
      ]
    })
    const normalized =
      Math.log1p(Math.min(bin.count, cap)) / Math.log1p(cap)
    const colorIndex = Math.min(
      DENSITY_COLORS.length - 1,
      Math.floor(normalized * DENSITY_COLORS.length),
    )
    return {
      polygon,
      count: bin.count,
      color: DENSITY_COLORS[colorIndex],
    }
  })
}

/** Hex radius in meters — tighter as you zoom in. */
function hexRadiusMeters(zoom: number): number {
  if (zoom < 2.5) return 90000
  if (zoom < 4) return 45000
  if (zoom < 5.5) return 20000
  if (zoom < 7) return 8000
  return 3000
}

type HoverInfo = {
  x: number
  y: number
  preview: MapFocus
} | null

export function MapView({
  points,
  hotspots,
  mostViewed,
  downloadedAt,
  focus = null,
  selectedFocus = null,
  panRequest = null,
  onSelectFocus,
}: Props) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>('hex')
  const [projectionMode, setProjectionMode] =
    useState<ProjectionMode>('mercator')
  const [exporting, setExporting] = useState(false)

  const exportHighRes = useCallback(async () => {
    if (exporting || points.length === 0) return
    setExporting(true)
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
      await downloadHighResMap(points, hotspots, mostViewed, {
        displayMode,
        projectionMode,
        downloadedAt,
        selectedFocus,
      })
    } catch (error) {
      console.error('High-resolution export failed', error)
      window.alert('Could not render the 8K image. Please try again.')
    } finally {
      setExporting(false)
    }
  }, [
    displayMode,
    downloadedAt,
    exporting,
    hotspots,
    mostViewed,
    points,
    projectionMode,
    selectedFocus,
  ])

  return (
    <div className="map-root">
      {projectionMode === 'mercator' ? (
        <MercatorMap
          points={points}
          hotspots={hotspots}
          displayMode={displayMode}
          focus={focus}
          panRequest={panRequest}
          onSelectFocus={onSelectFocus}
        />
      ) : (
        <EqualEarthMap
          points={points}
          hotspots={hotspots}
          displayMode={displayMode}
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
        <ToggleGroup
          label="View"
          options={[
            { value: 'hex', label: 'Hex density' },
            { value: 'points', label: 'Points' },
          ]}
          value={displayMode}
          onChange={(value) => setDisplayMode(value as DisplayMode)}
        />
        <ToggleGroup
          label="Projection"
          options={[
            { value: 'mercator', label: 'Mercator' },
            { value: 'equal-earth', label: 'Equal Earth' },
          ]}
          value={projectionMode}
          onChange={(value) => setProjectionMode(value as ProjectionMode)}
        />
        <button
          type="button"
          className="export-button"
          onClick={exportHighRes}
          disabled={exporting || points.length === 0}
          title="Download an 8K PNG matching the selected view and projection"
        >
          {exporting ? 'Rendering…' : 'Export 8K'}
        </button>
        <div className="density-legend" aria-hidden="true">
          <span className="density-legend__label">Density</span>
          <div
            className="density-legend__ramp"
            style={{
              background: `linear-gradient(90deg, ${DENSITY_COLORS.map(
                ([r, g, b]) => `rgb(${r},${g},${b})`,
              ).join(', ')})`,
            }}
          />
          <div className="density-legend__ends">
            <span>Low</span>
            <span>High</span>
          </div>
        </div>
      </div>

      <p className="map-hint">
        {displayMode === 'hex'
          ? 'Hex density · Inferno scale · brighter = more photos'
          : 'Points · amber→hot · brighter = denser area'}
      </p>
      <p className="map-credit">
        Built by kobakhit · © Natural Earth · © OSM · © CARTO · Flickr · deck.gl
      </p>
    </div>
  )
}

type MapModeProps = Pick<
  Props,
  'points' | 'hotspots' | 'focus' | 'panRequest' | 'onSelectFocus'
> & {
  displayMode: DisplayMode
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
  displayMode,
  focus,
  panRequest,
  onSelectFocus,
}: MapModeProps) {
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW)
  const [hover, setHover] = useState<HoverInfo>(null)
  const pointColors = useMemo(() => buildPointDensityColors(points), [points])

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
    const z = viewState.zoom
    const showRawPoints = displayMode === 'points'

    const hexes = new HexagonLayer<PhotoPoint>({
      id: 'photo-hex',
      data: points,
      getPosition: (d) => [d.lon, d.lat],
      radius: hexRadiusMeters(z),
      coverage: 0.92,
      extruded: false,
      // Cap extremes so Europe doesn't steal the whole color scale
      upperPercentile: 97,
      lowerPercentile: 0,
      colorRange: DENSITY_COLORS,
      opacity: 0.9,
      pickable: false,
      gpuAggregation: true,
      visible: !showRawPoints,
      updateTriggers: {
        radius: z,
      },
    })

    const dots = new ScatterplotLayer<PhotoPoint>({
      id: 'photo-dots',
      data: points,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 0.85,
      radiusUnits: 'pixels',
      radiusMinPixels: 0.6,
      radiusMaxPixels: 1.35,
      getFillColor: (_d, { index }) => pointColors[index],
      visible: showRawPoints,
      pickable: false,
      updateTriggers: {
        getFillColor: pointColors,
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
    })

    return [hexes, dots, pins, ...buildFocusLayers(focus)]
  }, [points, hotspots, pointColors, viewState.zoom, displayMode, focus])

  const onHover = useCallback((info: PickingInfo<Hotspot | MapFocus>) => {
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
    (info: PickingInfo<Hotspot | MapFocus>) => {
      const layerId = info.layer?.id
      if (info.object && layerId === 'hotspot-pins') {
        onSelectFocus?.(focusFromHotspot(info.object as Hotspot))
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
  displayMode,
  focus,
  panRequest,
  onSelectFocus,
}: MapModeProps) {
  const [viewState, setViewState] = useState<OrthographicViewState>(
    EQUAL_EARTH_INITIAL,
  )
  const [hover, setHover] = useState<HoverInfo>(null)

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
    const colors = buildPointDensityColors(points)
    return points.map((source, index) => ({
      source,
      position: project(source.lon, source.lat),
      color: colors[index],
    }))
  }, [points])
  const projectedHotspots = useMemo<ProjectedHotspot[]>(
    () =>
      hotspots.map((source) => ({
        source,
        position: project(source.lon, source.lat),
      })),
    [hotspots],
  )
  const equalEarthBins = useMemo(
    () => buildEqualEarthBins(projectedPoints),
    [projectedPoints],
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

    const hexes = new PolygonLayer<EqualEarthBin>({
      id: 'equal-earth-hex',
      data: equalEarthBins,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPolygon: (d) => d.polygon,
      getFillColor: (d) => d.color,
      getLineColor: [10, 12, 14, 100],
      lineWidthMinPixels: 0.25,
      stroked: true,
      filled: true,
      opacity: 0.9,
      visible: displayMode === 'hex',
      pickable: false,
    })

    const dots = new ScatterplotLayer<ProjectedPoint>({
      id: 'equal-earth-points',
      data: projectedPoints,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPosition: (d) => d.position,
      getRadius: 0.85,
      radiusUnits: 'pixels',
      radiusMinPixels: 0.6,
      radiusMaxPixels: 1.35,
      getFillColor: (d) => d.color,
      visible: displayMode === 'points',
      pickable: false,
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
    })

    return [
      land,
      hexes,
      dots,
      pins,
      ...buildFocusLayers(focus, { cartesian: true }),
    ]
  }, [
    displayMode,
    equalEarthBins,
    focus,
    projectedHotspots,
    projectedPoints,
  ])

  const onHover = useCallback(
    (info: PickingInfo<ProjectedHotspot | MapFocus>) => {
      const layerId = info.layer?.id
      if (info.object && layerId === 'equal-earth-pins') {
        setHover({
          x: info.x,
          y: info.y,
          preview: focusFromHotspot((info.object as ProjectedHotspot).source),
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
    (info: PickingInfo<ProjectedHotspot | MapFocus>) => {
      const layerId = info.layer?.id
      if (info.object && layerId === 'equal-earth-pins') {
        onSelectFocus?.(
          focusFromHotspot((info.object as ProjectedHotspot).source),
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
}

function ToggleGroup({
  label,
  options,
  value,
  onChange,
}: ToggleGroupProps) {
  return (
    <fieldset className="toggle-group">
      <legend>{label}</legend>
      <div>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? 'is-active' : ''}
            aria-pressed={value === option.value}
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
    displayMode: DisplayMode
    projectionMode: ProjectionMode
    downloadedAt?: string
    selectedFocus?: MapFocus | null
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

  if (options.displayMode === 'points') {
    drawExportPoints(context, points, projection)
  } else {
    drawExportHexes(context, points, projection)
  }

  drawExportHotspots(context, hotspots, projection)
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
  drawExportDensityLegend(context, 260, 300)

  drawExportControls(context, width, options)
  await drawExportPanels(context, width, height, hotspots, mostViewed)
  if (options.selectedFocus?.photo) {
    await drawExportPhotoPeek(context, height, options.selectedFocus)
  }

  context.textAlign = 'right'
  context.fillStyle = '#75818a'
  context.font = '400 22px Arial, sans-serif'
  context.fillText(
    'Built by kobakhit · Source: Flickr · boundaries: Natural Earth · rendered at 7680 × 4320',
    width - 220,
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
  link.download = `flickr-2026-${options.displayMode}-${options.projectionMode}-8k.png`
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
) {
  const colors = buildPointDensityColors(points)
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

function drawExportHexes(
  context: CanvasRenderingContext2D,
  points: PhotoPoint[],
  projection: GeoProjection,
) {
  type Bin = { q: number; r: number; count: number }
  const radius = 10
  const sqrt3 = Math.sqrt(3)
  const bins = new Map<string, Bin>()

  for (const point of points) {
    const xy = projection([point.lon, point.lat])
    if (!xy) continue
    const q = (sqrt3 / 3 * xy[0] - xy[1] / 3) / radius
    const r = (2 / 3 * xy[1]) / radius
    const cubeX = q
    const cubeZ = r
    const cubeY = -cubeX - cubeZ
    let rx = Math.round(cubeX)
    let ry = Math.round(cubeY)
    let rz = Math.round(cubeZ)
    const dx = Math.abs(rx - cubeX)
    const dy = Math.abs(ry - cubeY)
    const dz = Math.abs(rz - cubeZ)
    if (dx > dy && dx > dz) rx = -ry - rz
    else if (dy > dz) ry = -rx - rz
    else rz = -rx - ry
    const key = `${rx},${rz}`
    const bin = bins.get(key)
    if (bin) bin.count += 1
    else bins.set(key, { q: rx, r: rz, count: 1 })
  }

  const sortedCounts = [...bins.values()]
    .map((bin) => bin.count)
    .sort((a, b) => a - b)
  const cap = sortedCounts[Math.floor(sortedCounts.length * 0.97)] ?? 1
  const grouped: XY[][] = Array.from(
    { length: DENSITY_COLORS.length },
    () => [],
  )

  for (const bin of bins.values()) {
    const normalized =
      Math.log1p(Math.min(bin.count, cap)) / Math.log1p(cap)
    const index = Math.min(
      DENSITY_COLORS.length - 1,
      Math.floor(normalized * DENSITY_COLORS.length),
    )
    grouped[index].push([
      radius * sqrt3 * (bin.q + bin.r / 2),
      radius * 1.5 * bin.r,
    ])
  }

  context.save()
  grouped.forEach((centers, colorIndex) => {
    const [red, green, blue] = DENSITY_COLORS[colorIndex]
    context.beginPath()
    for (const [cx, cy] of centers) {
      for (let i = 0; i < 6; i++) {
        const angle = ((60 * i - 30) * Math.PI) / 180
        const x = cx + radius * 0.9 * Math.cos(angle)
        const y = cy + radius * 0.9 * Math.sin(angle)
        if (i === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.closePath()
    }
    context.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.92)`
    context.fill()
  })
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

function drawExportDensityLegend(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
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
  context.fillText('Low density', x, y + 52)
  context.textAlign = 'right'
  context.fillText('High density', x + rampWidth, y + 52)
  context.textAlign = 'start'
}

function drawExportControls(
  context: CanvasRenderingContext2D,
  width: number,
  options: {
    displayMode: DisplayMode
    projectionMode: ProjectionMode
  },
) {
  const x = width - 1860
  const y = 90
  const panelWidth = 1600
  const panelHeight = 165
  drawPanel(context, x, y, panelWidth, panelHeight)

  drawExportToggle(
    context,
    x + 45,
    y + 38,
    'VIEW',
    ['Hex density', 'Points'],
    options.displayMode === 'hex' ? 0 : 1,
  )
  drawExportToggle(
    context,
    x + 650,
    y + 38,
    'PROJECTION',
    ['Mercator', 'Equal Earth'],
    options.projectionMode === 'mercator' ? 0 : 1,
  )

  context.fillStyle = 'rgba(255, 210, 60, 0.12)'
  context.strokeStyle = 'rgba(255, 210, 60, 0.6)'
  context.lineWidth = 2
  context.fillRect(x + 1280, y + 66, 265, 65)
  context.strokeRect(x + 1280, y + 66, 265, 65)
  context.fillStyle = '#ffd23c'
  context.font = '600 27px Arial, sans-serif'
  context.textAlign = 'center'
  context.fillText('Export 8K', x + 1412, y + 108)
  context.textAlign = 'start'
}

function drawExportToggle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  options: [string, string],
  selected: number,
) {
  context.fillStyle = '#8b969e'
  context.font = '500 19px Arial, sans-serif'
  context.fillText(label, x, y)
  const buttonY = y + 22
  const buttonWidth = 245
  options.forEach((option, index) => {
    context.fillStyle =
      index === selected ? '#ffd23c' : 'rgba(255,255,255,0.035)'
    context.fillRect(x + index * buttonWidth, buttonY, buttonWidth, 65)
    context.strokeStyle = 'rgba(255,255,255,0.16)'
    context.lineWidth = 2
    context.strokeRect(x + index * buttonWidth, buttonY, buttonWidth, 65)
    context.fillStyle = index === selected ? '#161616' : '#9ba6ad'
    context.font = '500 25px Arial, sans-serif'
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
