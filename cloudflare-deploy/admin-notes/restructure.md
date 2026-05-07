# Admin Portal Restructure Design (Section 2.2 and 2.3)

The brief calls for four top-level tabs that segment the admin by domain.
This note records the structural and UX decisions we made before the code
landed. Pair it with `inventory.md`.

## Top-level structure

```
Admin Portal
  Customers    (shared)
  Apparel      (sub-nav)
    Products
    Collections
    Subsections
    Seasons
    Sales Targets
    Program Rules
    Program Products
  Footwear     (sub-nav, populated in Sections 3 and 4)
  Settings     (sub-nav)
    Users        (existing salespeople data grid)
    Brand Assets (existing images manager)
```

Customers stays a single-pane section. Apparel and Footwear use a sub-tab
pattern so the two domains feel symmetric, exactly as the brief specifies.
Settings reuses the same sub-tab pattern.

## URL routing

Each top-level tab has a stable URL slug, and sub-tabs append to it. On
the GitHub host these are hash fragments, not paths:

```
admin.html#customers
admin.html#apparel               (default sub-tab is Products)
admin.html#apparel/products
admin.html#apparel/collections
admin.html#apparel/subsections
admin.html#apparel/seasons
admin.html#apparel/sales-targets
admin.html#apparel/program-rules
admin.html#apparel/program-products
admin.html#footwear
admin.html#footwear/sales-targets
admin.html#settings              (default sub-tab is Users)
admin.html#settings/users
admin.html#settings/brand-assets
```

Implementation detail: the site is hosted on GitHub (Pages or comparable
static serve), which does not support `_redirects` files or arbitrary URL
rewrites. So path-based deep links like `/admin/apparel/products` cannot
be served on a hard refresh. Routing is hash-based:

```
admin.html#customers
admin.html#apparel/products
admin.html#footwear
admin.html#settings/users
```

`admin.js` reads `window.location.hash` on load to pick the initial section
and sub-tab, and pushes a new hash on every tab change via `history.pushState`.
Browser back/forward triggers `popstate`, which re-reads the hash and
re-activates the right section/sub-tab.

The path-mode parsing in `parseLocation()` and `updateLocation()` is
dormant code that only activates when `window.location.pathname` starts
with `/admin/`. If hosting ever moves to a host that supports rewrites
(Cloudflare Pages, Netlify, a custom worker), drop a `_redirects`-style
rule for `/admin/* -> /admin.html` and the path-mode code will start
producing clean URLs without any other change.

## Visual language

Same buttons, same data-grid styles, same headers across all four tabs. The
only thing that changes between tabs is the data behind them. From the
brief's 2.3:

> Avoid a single global product list with a category filter; the Apparel and
> Footwear tabs each have their own product list. This prevents mixed bulk
> operations and reinforces the mental model.

Section 2 keeps Products under Apparel only. The category filter and the
parallel Footwear Products sub-tab land in Section 3. We do not introduce a
"global products with category dropdown" intermediate state at any point.

> Customer detail pages show both apparel drafts and footwear drafts in
> separate, labeled sections.

Customer detail pages do not exist in the admin today. When they are built,
they will follow the segmentation rule above. For now this is a deferred
intent recorded in `inventory.md`.

## Why nested tabs over a sidebar

We considered three patterns: nested tab bars (chosen), a left sidebar with
a content pane, and an accordion. Nested tabs:

- Match the existing visual language (the current admin already has a tab
  bar at the top), so the diff is small and operators do not need to relearn.
- Keep horizontal real estate for wide data grids.
- Make the four-domain split visually loud, which matters when an admin is
  jumping between Apparel and Footwear in the same session.

A left sidebar would have been the better choice if the admin had many
nested levels, but the deepest path here is two levels, so a tab pattern
fits.

## Where the code lives

```
cloudflare-deploy/
  admin.html         top-level section bar + per-section sub-tab bars
  admin.js           SECTIONS config + section/sub-tab routing + existing
                     TABLES-driven data grid (unchanged below the routing layer)
  admin-notes/
    inventory.md     tab-by-tab mapping (this file's sibling)
    restructure.md   this note
```

The directory is named `cloudflare-deploy/` for historical reasons (the
site used to deploy through Cloudflare). It now ships through GitHub.
Renaming the directory is a separate change that needs the deploy
configuration updated in lockstep.

The existing `TABLES` config and the data-grid rendering code (loadTable,
renderTable, all the cell editing helpers) are untouched. The routing layer
is the only thing that changed. That keeps the regression surface tiny.
