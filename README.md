# Losinn's Watchlist

A private, on-device tracker for everything you've watched — TV, anime and films —
with real ratings attached and recommendations built from your own library.

Everything (library, scores, progress, tags, API keys) lives in your browser's
`localStorage`. Nothing is uploaded, there is no account and no backend.

## What it does

- **Track what you've watched.** Search TMDB, add a title, set a status
  (watching / completed / plan to watch / on hold / dropped), give it your own
  score out of 10, and track progress down to the episode.
- **Sections.** Anime, TV shows and Films are separated automatically (Japanese
  animation is detected from TMDB's genre + origin data), and you can add your
  own tags — `shonen`, `comfort`, `rewatch`, whatever — which become their own
  sections in the sidebar.
- **Ratings from everywhere.** IMDb score and vote count, Rotten Tomatoes
  tomatometer, Metascore and TMDB average, side by side.
- **Per-episode ratings.** A season heatmap of IMDb episode scores — instantly
  shows which season sags and which episode is the peak — plus a full table with
  IMDb and TMDB scores per episode and links straight to each episode on IMDb.
  Click any cell to set your progress to that episode.
- **Recommendations.** Every title you've rated votes for what to watch next,
  weighted by your score, cross-referenced against TMDB's recommendation graph
  and your own genre habits. Filter to anime, series or films only, and hide
  anything you're not interested in.
- **Export / import** your library as JSON.

## Setup — two free API keys

IMDb and Rotten Tomatoes don't publish public APIs, so this uses the two services
that legitimately expose that data. Since the app is static (no server to hide a
key in), you use your own keys and they stay in your browser.

1. **TMDB** — *required.* Sign up at [themoviedb.org](https://www.themoviedb.org/signup),
   go to [Settings → API](https://www.themoviedb.org/settings/api) and copy the
   **API Key (v3 auth)**. Powers search, artwork, seasons, episodes and recommendations.
2. **OMDb** — *optional but worth it.* Free key at
   [omdbapi.com](https://www.omdbapi.com/apikey.aspx) (1,000 lookups/day; activate
   it from the confirmation email). Adds the IMDb rating, Rotten Tomatoes,
   Metacritic and **per-episode IMDb scores**.

Paste both into **Settings** on first run. API responses are cached locally for
days at a time so the free OMDb quota goes a long way.

## Run locally

```bash
python serve.py
```

It picks a free port and opens your browser to it. Or just open `index.html`
directly — there's no build step.

## Publish

Double-click `publish.bat` (or run `.\publish.ps1`). First run creates the public
repo, pushes and enables GitHub Pages; later runs just push. It never commits for
you — commit first, then publish.

## Files

- `index.html` — the page
- `style.css` — all styling (self-contained)
- `app.js` — library, API layer, ratings, episode heatmap, recommendation engine
- `serve.py` — no-cache static dev server
- `publish.ps1` / `publish.bat` — one-step publish to GitHub Pages

## Notes on the data

Rotten Tomatoes scores a series (or a film) as a whole and never per episode, so
the episode heatmap is IMDb-led with TMDB's own episode averages as backup. If a
title has no IMDb entry in OMDb, the TMDB numbers still show.
