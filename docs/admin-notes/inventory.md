# Admin Portal Inventory (Section 2.1)

A snapshot of every page and feature in the admin portal as of the start of
the AW27 footwear work, tagged for the new four-tab layout introduced in
Section 2. Use this as the source of truth when deciding where a feature
belongs in the new structure.

## Existing surface area

The admin is a single SPA: `cloudflare-deploy/admin.html` plus
`cloudflare-deploy/admin.js`. Every tab is a generic data grid driven by the
`TABLES` config in `admin.js`. The Images tab is the one exception, with its
own renderer in `setupImageTab()`.

Auth: Supabase email/password. The signed-in user must have a row in
`salespeople` with `role = 'admin'`. PIN login was retired Apr 2026.

## Tab-by-tab mapping

| Existing tab     | Domain                | New top-level | Sub-tab label    | Notes                                                     |
| ---------------- | --------------------- | ------------- | ---------------- | --------------------------------------------------------- |
| customers        | shared                | Customers     | (no sub-tab)     | Single-purpose section; the top-level tab is the view.    |
| products         | shared today          | Apparel       | Products         | Section 3 will filter this to `category = 'apparel'` and add a parallel Products sub-tab under Footwear. |
| salespeople      | shared                | Settings      | Users            | Used for the admin role check; renamed in nav for clarity.|
| collections      | apparel-specific      | Apparel       | Collections      | Today's collections are apparel groupings.                |
| subsections      | apparel-specific      | Apparel       | Subsections      | Subcategories of apparel products.                        |
| seasons          | apparel-specific      | Apparel       | Seasons          | Season-level config used by apparel program logic.        |
| sales_targets    | shared (split by category) | Apparel and Footwear | Sales Targets    | Per-rep season targets. After migration 0009, sales_targets carries a category column ('apparel' or 'footwear'). The admin surfaces it as two virtual sub-tabs that share the physical table; each filters by category and pre-fills the value on insert. |
| program_rules    | apparel-specific      | Apparel       | Program Rules    | Apparel prebook program rules.                            |
| program_products | apparel-specific      | Apparel       | Program Products | Products attached to apparel programs.                    |
| images           | shared                | Settings      | Brand Assets     | Manages four buckets: product-images, logos, seasonal-images, pos_images. |

Not in the admin today: drafts (lives in `dashboard.js` for sales reps; not
surfaced in admin), customer detail pages (the customers tab is a flat data
grid; per-customer drilldown does not exist).

## Domain tags

Shared (used by customers, settings, or any future domain):

- customers
- salespeople (also gates admin auth)
- images (the `product-images` bucket serves both apparel and footwear)

Apparel-specific (today):

- products (split planned in Section 3)
- collections, subsections, seasons
- program_rules, program_products

Shared, split by category column:

- sales_targets (apparel and footwear rows in one table; admin sub-tabs
  filter on category)

Footwear-specific (today):

- The Footwear section currently has Sales Targets only (a virtual sub-tab
  filtered to category='footwear'). Slide templates, questionnaire, slide
  editor, and footwear products land in Sections 3 and 4.

## What this section does NOT change

Out of scope for Section 2, by design:

- Splitting `products` by category. Stays in Apparel only until Section 3 adds
  the Footwear Products sub-tab and filters both lists.
- Customer detail pages. Don't exist today; not building them here.
- `draft_orders` admin views. Drafts surface in the sales rep dashboard, not
  the admin. If admin-side draft browsing is wanted, that's a separate task.
- Product image bucket structure. The product-images bucket continues to
  serve both apparel and footwear. The new `footwear-media` bucket created
  in Section 1 lives alongside it and will get its own surface in Section 3.
