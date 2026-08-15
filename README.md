# Most Photographed Places · 2026

Two-step workflow: download geotagged Flickr photos to disk, then visualize them.

## 1. Download data

```bash
npm install
npm run download
```

Writes `public/data/photos-2026.json` (and a resume state file). Safe to re-run — finished tiles are skipped.

## 2. Visualize

```bash
npm run dev
```

Open the URL Vite prints. The map reads only the saved JSON — no live Flickr calls in the browser.

## Env

Set `FLICKR_KEY` in `.env` (see `.env.example`).
