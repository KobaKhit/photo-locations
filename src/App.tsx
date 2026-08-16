import { useEffect, useMemo, useState } from 'react'
import { AboutPage } from './About'
import {
  MapView,
  focusFromHotspot,
  focusFromPhoto,
  type AudienceMode,
  type MapFocus,
  type MapPanRequest,
} from './MapView'
import {
  applyPlaceLabels,
  findPerCapitaHotspots,
  findFlickrShareHotspots,
  findHotspots,
  findMostViewed,
  loadDataset,
  loadHotspotPlaceLabels,
  loadPopulationRates,
  resolvePlaceNames,
  type Hotspot,
  type HotspotPlaceLabels,
  type PhotoPoint,
  type PopulationRateDataset,
} from './flickr'
import './App.css'

type Route = 'map' | 'about'

function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '').toLowerCase()
  return raw === 'about' || raw.startsWith('about/') ? 'about' : 'map'
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => routeFromHash())
  const [points, setPoints] = useState<PhotoPoint[]>([])
  const [hotspots, setHotspots] = useState<Hotspot[]>([])
  const [perCapitaHotspots, setPerCapitaHotspots] = useState<Hotspot[]>([])
  const [metricMode, setMetricMode] = useState<
    'photos' | 'population' | 'per-capita' | 'flickr-share'
  >('photos')
  const [audienceMode, setAudienceMode] = useState<AudienceMode>('all')
  const [populationRates, setPopulationRates] =
    useState<PopulationRateDataset | null>(null)
  const [placeLabels, setPlaceLabels] = useState<HotspotPlaceLabels>({})
  const [flickrShareHotspots, setFlickrShareHotspots] = useState<Hotspot[]>([])
  const [audienceHotspots, setAudienceHotspots] = useState<Hotspot[]>([])
  const [meta, setMeta] = useState<{
    count: number
    estimatedTotal: number | null
    downloadedAt?: string
    roleCounts?: {
      local: number
      tourist: number
      unknown: number
    }
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hoverFocus, setHoverFocus] = useState<MapFocus | null>(null)
  const [selectedFocus, setSelectedFocus] = useState<MapFocus | null>(null)
  const [panRequest, setPanRequest] = useState<MapPanRequest | null>(null)
  const [showHottestMarkers, setShowHottestMarkers] = useState(true)
  const [showMostViewedMarkers, setShowMostViewedMarkers] = useState(true)

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    document.title =
      route === 'about'
        ? 'About · Most Photographed Places 2026'
        : 'Most Photographed Places · 2026'
    document.documentElement.dataset.page = route
  }, [route])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        setError(null)
        const data = await loadDataset()
        if (cancelled) return
        setPoints(data.points)
        setMeta({
          count: data.count,
          estimatedTotal: data.estimatedTotal,
          downloadedAt: data.downloadedAt,
          roleCounts: data.roleCounts,
        })

        const placeLabels = await loadHotspotPlaceLabels().catch(() => ({}))
        if (!cancelled) setPlaceLabels(placeLabels)

        // This optional precomputed layer should never block the core map.
        loadPopulationRates()
          .then((rates) => {
            if (cancelled) return
            setPopulationRates(rates)
            const rawPerCapitaHotspots = applyPlaceLabels(
              findPerCapitaHotspots(data.points, rates, 12),
              placeLabels,
            )
            setPerCapitaHotspots(rawPerCapitaHotspots)
            resolvePlaceNames(rawPerCapitaHotspots).then((named) => {
              if (!cancelled) {
                setPerCapitaHotspots(applyPlaceLabels(named, placeLabels))
              }
            })
            if (rates.flickrUsersByCountry) {
              const rawFlickr = applyPlaceLabels(
                findFlickrShareHotspots(data.points, rates, 12),
                placeLabels,
              )
              setFlickrShareHotspots(rawFlickr)
              resolvePlaceNames(rawFlickr).then((named) => {
                if (!cancelled) {
                  setFlickrShareHotspots(applyPlaceLabels(named, placeLabels))
                }
              })
            }
          })
          .catch((rateError) => {
            console.warn('Population-normalized grid unavailable', rateError)
          })

        const rawHotspots = applyPlaceLabels(
          findHotspots(data.points, 12),
          placeLabels,
        )
        setHotspots(rawHotspots)
        const named = await resolvePlaceNames(rawHotspots)
        if (!cancelled) setHotspots(applyPlaceLabels(named, placeLabels))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load photos')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const mostViewed = useMemo(() => findMostViewed(points, 7), [points])
  const hasAudienceRoles = useMemo(
    () => points.some((point) => point.role !== undefined),
    [points],
  )
  const mapPoints = useMemo(() => {
    if (!hasAudienceRoles || audienceMode === 'all') return points
    return points.filter((point) => point.role === audienceMode)
  }, [points, audienceMode, hasAudienceRoles])

  useEffect(() => {
    if (!hasAudienceRoles || audienceMode === 'all') {
      setAudienceHotspots([])
      return
    }
    let cancelled = false
    const raw = applyPlaceLabels(findHotspots(mapPoints, 12), placeLabels)
    setAudienceHotspots(raw)
    resolvePlaceNames(raw).then((named) => {
      if (!cancelled) setAudienceHotspots(applyPlaceLabels(named, placeLabels))
    })
    return () => {
      cancelled = true
    }
  }, [mapPoints, audienceMode, hasAudienceRoles, placeLabels])

  useEffect(() => {
    if (!populationRates?.flickrUsersByCountry) return
    let cancelled = false
    const raw = applyPlaceLabels(
      findFlickrShareHotspots(mapPoints, populationRates, 12),
      placeLabels,
    )
    setFlickrShareHotspots(raw)
    resolvePlaceNames(raw).then((named) => {
      if (!cancelled) {
        setFlickrShareHotspots(applyPlaceLabels(named, placeLabels))
      }
    })
    return () => {
      cancelled = true
    }
  }, [mapPoints, populationRates, placeLabels])

  const visibleHotspots =
    metricMode === 'per-capita'
      ? perCapitaHotspots
      : metricMode === 'flickr-share'
        ? flickrShareHotspots
        : audienceMode !== 'all' && hasAudienceRoles
          ? audienceHotspots
          : hotspots

  const hotspotTitle =
    metricMode === 'per-capita'
      ? 'Highest per resident (stabilized)'
      : metricMode === 'flickr-share'
        ? 'Highest per Flickr user'
        : audienceMode === 'tourist'
          ? 'Hottest tourist clusters'
          : audienceMode === 'local'
            ? 'Hottest local clusters'
            : audienceMode === 'unknown'
              ? 'Clusters with unknown photographer status'
            : 'Hottest clusters'

  const asOfLabel = useMemo(() => {
    if (!meta?.downloadedAt) return null
    const date = new Date(meta.downloadedAt)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }, [meta?.downloadedAt])

  const focus = hoverFocus ?? selectedFocus

  const selectFocus = (next: MapFocus) => {
    if (selectedFocus?.id === next.id) {
      setSelectedFocus(null)
      setPanRequest({ key: Date.now(), mode: 'reset' })
      return
    }
    setSelectedFocus(next)
    setPanRequest({
      key: Date.now(),
      mode: 'focus',
      lon: next.lon,
      lat: next.lat,
    })
  }

  const focusHotspot = (h: Hotspot, pan: boolean) => {
    const next = focusFromHotspot(h)
    if (pan) selectFocus(next)
    else setHoverFocus(next)
  }

  const focusPhoto = (p: PhotoPoint, pan: boolean) => {
    const next = focusFromPhoto(p)
    if (pan) selectFocus(next)
    else setHoverFocus(next)
  }

  if (route === 'about') {
    return (
      <div className="app app--about">
        <nav className="about-nav">
          <a className="about-nav__back" href="#/">
            ← Map
          </a>
          <span className="about-nav__current">About</span>
        </nav>
        <AboutPage
          photoCount={points.length || meta?.count}
          asOfLabel={asOfLabel}
          roleCounts={meta?.roleCounts ?? null}
        />
      </div>
    )
  }

  return (
    <div className="app">
      <MapView
        points={mapPoints}
        hotspots={visibleHotspots}
        mostViewed={mostViewed}
        populationRates={populationRates}
        downloadedAt={meta?.downloadedAt}
        focus={focus}
        selectedFocus={selectedFocus}
        panRequest={panRequest}
        onSelectFocus={selectFocus}
        onMetricModeChange={setMetricMode}
        audienceMode={audienceMode}
        onAudienceModeChange={setAudienceMode}
        hasAudienceRoles={hasAudienceRoles}
        showHottestMarkers={showHottestMarkers}
        showMostViewedMarkers={showMostViewedMarkers}
        onShowHottestMarkersChange={setShowHottestMarkers}
        onShowMostViewedMarkersChange={setShowMostViewedMarkers}
      />

      <header className="hud">
        <div className="hud__row">
          <h1 className="hud__title">Most photographed places 2026</h1>
          <a className="hud__about" href="#/about">
            About
          </a>
        </div>
        <p className="hud__sub">
          Source: Flickr
          {points.length > 0
            ? ` · ${points.length.toLocaleString()} geotagged photos`
            : ''}
          {asOfLabel ? ` · As of ${asOfLabel}` : ''}
        </p>
      </header>

      {(loading || error) && (
        <div className="status" role="status">
          {error ? (
            <>
              <p className="status__error">{error}</p>
              <p className="status__meta">In a terminal: npm run download</p>
            </>
          ) : (
            <p className="status__label">Loading saved dataset…</p>
          )}
        </div>
      )}

      {!loading &&
        !error &&
        ((showHottestMarkers && visibleHotspots.length > 0) ||
          (showMostViewedMarkers && mostViewed.length > 0)) && (
        <aside className="side-panels">
          {showHottestMarkers && visibleHotspots.length > 0 && (
            <section className="legend">
              <p className="legend__title">{hotspotTitle}</p>
              <ol className="legend__list">
                {visibleHotspots.slice(0, 7).map((h) => {
                  const id = `hotspot:${h.lat},${h.lon}`
                  const active = focus?.id === id
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className={`legend__item${active ? ' is-active' : ''}`}
                        onMouseEnter={() => focusHotspot(h, false)}
                        onMouseLeave={() => setHoverFocus(null)}
                        onFocus={() => focusHotspot(h, false)}
                        onBlur={() => setHoverFocus(null)}
                        onClick={() => focusHotspot(h, true)}
                      >
                        <span
                          className="legend__swatch"
                          style={{ background: h.color }}
                        />
                        <span className="legend__name" title={h.placeName}>
                          {h.placeName}
                        </span>
                        <span
                          className="legend__count"
                          title={
                            h.photographers !== undefined
                              ? `${h.count.toLocaleString()} photos · ${h.photographers.toLocaleString()} photographers`
                              : undefined
                          }
                        >
                          {h.photosPerThousand === undefined
                            ? h.photographers !== undefined
                              ? `${h.count.toLocaleString()} · ${h.photographers.toLocaleString()}p`
                              : h.count.toLocaleString()
                            : metricMode === 'flickr-share'
                              ? `${h.photosPerThousand.toFixed(2)}/user`
                              : `${h.photosPerThousand.toFixed(1)}/1k`}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </section>
          )}

          {showMostViewedMarkers && mostViewed.length > 0 && (
            <section className="legend legend--views">
              <p className="legend__title">Most viewed</p>
              <ol className="legend__list legend__list--views">
                {mostViewed.slice(0, 5).map((p) => {
                  const id = `photo:${p.id}`
                  const active = focus?.id === id
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={`legend__item${active ? ' is-active' : ''}`}
                        onMouseEnter={() => focusPhoto(p, false)}
                        onMouseLeave={() => setHoverFocus(null)}
                        onFocus={() => focusPhoto(p, false)}
                        onBlur={() => setHoverFocus(null)}
                        onClick={() => focusPhoto(p, true)}
                      >
                        {p.url ? (
                          <img className="legend__thumb" src={p.url} alt="" />
                        ) : (
                          <span className="legend__thumb legend__thumb--empty" />
                        )}
                        <span className="legend__name" title={p.title}>
                          {p.title || 'Untitled'}
                        </span>
                        <span className="legend__count">
                          {p.views.toLocaleString()}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </section>
          )}
        </aside>
      )}
    </div>
  )
}
