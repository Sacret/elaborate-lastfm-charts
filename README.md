elaborate-lastfm-charts
=======================

Amazing Last.fm charts.

A static site: the browser talks to the [Last.fm API](https://www.last.fm/api)
directly and caches weekly charts of past weeks in IndexedDB. There is no
build step and no server.

Running locally
---------------

Serve the `site` directory with any static web server:

```bash
python3 -m http.server -d site 8000
```

and open <http://localhost:8000/>.

Deployment
----------

Every push to `master` is deployed to GitHub Pages by
`.github/workflows/pages.yml`. In the repository settings, set
*Pages → Build and deployment → Source* to *GitHub Actions*.
