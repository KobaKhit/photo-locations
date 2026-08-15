# Most Photographed Places · 2026

Flickr geotagged photo density map for 2026. Built by kobakhit.

**Live:** https://kobakhit.github.io/photo-locations/  
**Repo:** https://github.com/KobaKhit/photo-locations

Two-step workflow: download geotagged Flickr photos to disk, then visualize them.

## 1. Download data

```bash
npm install
npm run download
```

Writes `public/data/photos-2026.json` (tracked with Git LFS). Safe to re-run — finished tiles are skipped.

Clone with LFS:

```bash
git lfs install
git clone https://github.com/KobaKhit/photo-locations.git
```

## 2. Visualize

```bash
npm run dev
```

Open the URL Vite prints. The map reads only the saved JSON — no live Flickr calls in the browser.

## Deploy

```bash
npm run deploy
```

Builds and pushes `dist/` to the `gh-pages` branch (GitHub Pages).

## Env

Set `FLICKR_KEY` in `.env` (see `.env.example`). Never commit `.env`.
