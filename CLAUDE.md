# Curate project notes for Claude

Persistent context to read at the start of every session. Keep this file
short and factual; the brief and section-specific notes live elsewhere
(e.g. `cloudflare-deploy/admin-notes/`, the AW27 footwear brief).

## Hosting

The site is hosted on **GitHub** only (GitHub Pages or a comparable static
serve from this repo). It is **not** on Cloudflare anymore. This means:

- `_redirects` files (Netlify / Cloudflare Pages convention) do not work.
  Path-based URL rewrites are unavailable; routing has to be done with hash
  fragments or with a 404.html SPA fallback if path-based deep links matter
  later.
- The `cloudflare-deploy/` directory name is a holdover from the previous
  host. Do not rename it without confirming first - build or deploy
  scripts may reference the path.

If hosting changes, update this section.

## House style

- No em dashes or en dashes anywhere in code, comments, or UI copy. Use
  regular hyphens. (Pre-existing em dashes in `admin.js` and `admin.html`
  are tech debt; do not introduce new ones.)
- All JS is external. CSP is strict; no inline `<script>` and no inline
  event handlers. New CSS-in-style is fine.
- Database row keys are uuid `id` columns where present. Never key off
  `products.sku` for row identity (use it as a semantic key only).

## Admin portal structure (after Section 2 of AW27 footwear)

Top-level sections, defined in `admin.js` `SECTIONS`:

- Customers
- Apparel (sub-tabs: Products, Collections, Subsections, Seasons, Sales
  Targets, Program Rules, Program Products)
- Footwear (sub-tabs: Sales Targets is the first one. Slide editor,
  questionnaire admin, and footwear products land in Sections 3 and 4 of
  the footwear build)
- Settings (sub-tabs: Users, Brand Assets)

URL routing is hash-based given the GitHub host: `admin.html#apparel/products`
etc. The path-mode code in `admin.js` is dormant unless a future host
supports rewrites.

## Active work

- AW27 footwear prebook: Sections 1 (DB) and 2 (admin restructure) are
  done. Brief lives in user uploads as `footwear_prebook_prompt.md`.
