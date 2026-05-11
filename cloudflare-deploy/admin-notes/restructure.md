# Moved

This file has moved to `/docs/admin-notes/restructure.md` (outside the
GitHub Pages publish path).

GH03 — May 2026: internal admin notes were inadvertently being served
publicly at `https://risingperformance.github.io/Curate/cloudflare-deploy/admin-notes/restructure.md`.
The notes have been relocated; this folder can be deleted from the deploy
path:

```
git rm -r cloudflare-deploy/admin-notes/
git commit -m "Remove admin-notes from deploy path (GH03)"
```
