type Props = {
  photoCount?: number
  asOfLabel?: string | null
  roleCounts?: {
    local: number
    tourist: number
    unknown: number
  } | null
}

export function AboutPage({ photoCount, asOfLabel, roleCounts }: Props) {
  return (
    <main className="about">
      <header className="about__header">
        <p className="about__eyebrow">Photo Geography · 2026</p>
        <h1 className="about__title">About this map</h1>
        <p className="about__lede">
          An interactive atlas of geotagged Flickr photos from 2026: raw
          density, world population, photos per resident, Flickr-user share,
          and local vs tourist views.
        </p>
        <p className="about__meta">
          {photoCount !== undefined && photoCount > 0
            ? `${photoCount.toLocaleString()} geotagged photos`
            : 'Flickr geotagged photos'}
          {asOfLabel ? ` · As of ${asOfLabel}` : ''}
          {' · Built by '}
          <a href="https://kobakhit.com" rel="noreferrer">
            kobakhit
          </a>
        </p>
      </header>

      <section className="about__section">
        <h2>What you are looking at</h2>
        <p>
          Public Flickr photos with a date taken in 2026 and a geographic tag.
          Use the map controls to change how that sample is shown.
        </p>
        <ul>
          <li>
            <strong>Photos</strong>: raw geotagged photo density. Best for busy
            / famous places on Flickr.
          </li>
          <li>
            <strong>Pop</strong>: GHSL resident population (2020), for comparing
            photography to where people live.
          </li>
          <li>
            <strong>Capita</strong>: photos per resident, empirically
            stabilized. Over-photographed relative to who lives there (parks,
            coasts, deserts). Not tourist volume.
          </li>
          <li>
            <strong>Flickr</strong>: photos divided by Flickr accounts whose
            inferred home country is that country. Corrects for Flickr’s uneven
            user base versus census population.
          </li>
          <li>
            <strong>Who</strong>: All / Local / Tourist / Unknown, using Eric
            Fischer’s place-duration method.
          </li>
        </ul>
        <p>
          Also available: Hex or Points, Mercator or Equal Earth, Dark or Light.
          Hottest clusters list dense neighborhoods and show distinct
          photographer counts beside photo totals. Capita and Flickr modes
          switch that list to their stabilized rates. Most viewed is raw Flickr
          view count.
        </p>
      </section>

      <section className="about__section">
        <h2>Data</h2>
        <p>
          <strong>Photos:</strong> Flickr public search API, geotagged only,
          date taken in 2026 through the latest crawl. Sampled worldwide by
          bounding-box tiles (including Hawaii, Iceland, Azores, and Caribbean).
          Downloads can resume or update incrementally. Near-(0,&nbsp;0) “Null
          Island” geotags are dropped.
        </p>
        <p>
          <strong>Population:</strong>{' '}
          <a
            href="https://human-settlement.emergency.copernicus.eu/"
            rel="noreferrer"
          >
            GHSL GHS-POP R2023A
          </a>{' '}
          (European Commission JRC), resident population for 2020, aggregated to
          a 0.25° grid aligned with the photo cells.
        </p>
        <p>
          Place names: offline Nominatim reverse geocoding. Map stack: MapLibre,
          deck.gl, D3 Equal Earth, Natural Earth / OSM / CARTO basemap.
        </p>
      </section>

      <section className="about__section">
        <h2>Capita methodology</h2>
        <p>
          A naive photos ÷ residents map lights up empty deserts: one photo in a
          near-empty cell outranks thousands in a city. Capita uses Empirical
          Bayes (Gamma-Poisson) shrinkage toward the global mean rate μ:
        </p>
        <p className="about__formula">r̃ᵢ = (nᵢ + C·μ) / (pᵢ + C)</p>
        <p>
          where nᵢ is photos, pᵢ is resident population (with a modest floor), μ
          is the global mean photos per resident, and C is prior strength from
          method of moments on well-supported cells. Cells and hexes with fewer
          than 5 photos are omitted from Capita coloring and rankings.
        </p>
        <p>
          Read Capita as “over-photographed for how few people live here.” For
          famous destinations, prefer Photos or Tourist.
        </p>
      </section>

      <section className="about__section">
        <h2>Flickr-share methodology</h2>
        <p>
          Capita uses census residents. Flickr-share instead divides by the
          number of Flickr accounts whose home country (most unique upload
          months in this dataset) matches the photo’s country. That reduces the
          “countries with many Flickr users look busy” artifact without claiming
          tourist visitor counts.
        </p>
      </section>

      <section className="about__section">
        <h2>Local vs tourist</h2>
        <p>
          Adapted from{' '}
          <a
            href="https://www.flickr.com/photos/walkingsf/albums/72157624209158632/"
            rel="noreferrer"
          >
            Eric Fischer’s Locals and Tourists
          </a>
          . A photographer is <strong>local</strong> to a city-scale 0.1° cell
          when their photos there span at least 30 days. A shorter visit is{' '}
          <strong>tourist</strong> only when that photographer has a confirmed
          local cell elsewhere. Everything else is <strong>unknown</strong>.
        </p>
        {roleCounts ? (
          <p>
            In the current sample:{' '}
            {roleCounts.local.toLocaleString()} local,{' '}
            {roleCounts.tourist.toLocaleString()} tourist,{' '}
            {roleCounts.unknown.toLocaleString()} unknown.
          </p>
        ) : null}
        <p>
          The January–August 2026 window supplies more than six months of
          history, but a 0.1° cell is not an official city boundary, and
          infrequent posters or long-stay visitors can be mislabeled. Use it as
          a relative lens, not a census of residents.
        </p>
      </section>

      <section className="about__section">
        <h2>Caveats and mitigations</h2>
        <ul>
          <li>
            <strong>Flickr is not a random sample</strong> of Earth’s
            photographers. Coverage follows Flickr’s user base and vacation
            patterns. Mitigations: Flickr-share and Local / Tourist / Unknown.
            Remaining: no other photo platforms.
          </li>
          <li>
            <strong>Tile sampling</strong> once under-represented islands;
            Hawaii, Iceland, Azores, and Caribbean are in the live dataset.
            Remaining: some Pacific and polar regions can still look sparse
            next to densely tiled continents.
          </li>
          <li>
            <strong>Resident population</strong> is a poor exposure for tourist
            sites. Capita is explicitly not tourist volume. Prefer Photos,
            Tourist, or Flickr for busy destinations. Remaining: no official
            visitor-count denominator.
          </li>
          <li>
            <strong>Photo count ≠ unique visitors</strong>. Hotspots show
            distinct photographer counts beside photo totals. Near-(0,&nbsp;0)
            geotags are dropped. Remaining: other bad geotags can persist;
            popularity is still not beauty.
          </li>
        </ul>
      </section>

      <section className="about__section">
        <h2>Links</h2>
        <ul className="about__links">
          <li>
            <a href="#/">Back to map</a>
          </li>
          <li>
            <a href="https://kobakhit.com/photo-locations/" rel="noreferrer">
              Live map
            </a>
          </li>
          <li>
            <a
              href="https://github.com/KobaKhit/photo-locations"
              rel="noreferrer"
            >
              Source code
            </a>
          </li>
          <li>
            <a
              href="https://human-settlement.emergency.copernicus.eu/"
              rel="noreferrer"
            >
              GHSL population data
            </a>
          </li>
          <li>
            <a
              href="https://www.flickr.com/photos/walkingsf/albums/72157624209158632/"
              rel="noreferrer"
            >
              Eric Fischer, Locals and Tourists
            </a>
          </li>
        </ul>
      </section>
    </main>
  )
}
