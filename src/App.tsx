import { useEffect, useMemo, useState } from 'react'
import {
  MapView,
  focusFromHotspot,
  focusFromPhoto,
  type MapFocus,
  type MapPanRequest,
} from './MapView'
import {
  findHotspots,
  findMostViewed,
  loadDataset,
  loadPopulationRates,
  resolvePlaceNames,
  type Hotspot,
  type PhotoPoint,
  type PopulationRateDataset,
} from './flickr'
import './App.css'

export default function App() {
  const [points, setPoints] = useState<PhotoPoint[]>([])
  const [hotspots, setHotspots] = useState<Hotspot[]>([])
  const [populationRates, setPopulationRates] =
    useState<PopulationRateDataset | null>(null)
  const [meta, setMeta] = useState<{
    count: number
    estimatedTotal: number | null
    downloadedAt?: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hoverFocus, setHoverFocus] = useState<MapFocus | null>(null)
  const [selectedFocus, setSelectedFocus] = useState<MapFocus | null>(null)
  const [panRequest, setPanRequest] = useState<MapPanRequest | null>(null)

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
        })
        // This optional precomputed layer should never block the core map.
        loadPopulationRates()
          .then((rates) => {
            if (!cancelled) setPopulationRates(rates)
          })
          .catch((rateError) => {
            console.warn('Population-normalized grid unavailable', rateError)
          })

        const rawHotspots = findHotspots(data.points, 12)
        setHotspots(rawHotspots)
        const named = await resolvePlaceNames(rawHotspots)
        if (!cancelled) setHotspots(named)
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

  return (
    <div className="app">
      <MapView
        points={points}
        hotspots={hotspots}
        mostViewed={mostViewed}
        populationRates={populationRates}
        downloadedAt={meta?.downloadedAt}
        focus={focus}
        selectedFocus={selectedFocus}
        panRequest={panRequest}
        onSelectFocus={selectFocus}
      />

      <header className="hud">
        <h1 className="hud__title">Most photographed places 2026</h1>
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

      {!loading && !error && hotspots.length > 0 && (
        <aside className="side-panels">
          <section className="legend">
            <p className="legend__title">Hottest clusters</p>
            <ol className="legend__list">
              {hotspots.slice(0, 7).map((h) => {
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
                      <span className="legend__count">{h.count}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </section>

          {mostViewed.length > 0 && (
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
