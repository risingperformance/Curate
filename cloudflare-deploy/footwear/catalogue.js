// ─── Catalogue view ───────────────────────────────────────────────────────
//
// Full footwear catalogue, organised by collection then subsection then
// item number. Reps land here from the deck and use it to build the cart
// when a product they want is not on a slide. Review-mode customers also
// see this view (read-only, same fw-mode-review CSS that disables
// add-to-cart on every other product card).
//
// Layout mirrors the apparel order form: a top tab bar where each tab is
// one collection, then inside the active panel a stack of accordion
// blocks (one per subsection) that expand/collapse independently. The
// view re-uses cart.renderProductCard / wireProductCard so cards look
// and behave identically to the ones inside the split_story template and
// the slide product strip drawer.
// The cart summary lives in the global #fw-app-footer mounted in
// index.html, so cart.js can repaint it on every cart change without
// the catalogue having to manage its own footer DOM.

(function () {
  'use strict';

  window.fwApp       = window.fwApp || {};
  window.fwApp.views = window.fwApp.views || {};

  // Lazy-loaded structure: { collections: [...] } where each collection has
  // { id, name, delivery, subsections: [{ id, name, products: [...] }] }.
  // Cached on module so re-entering the view doesn't re-query.
  var dataCache = null;
  // Outstanding load promise so concurrent renderCatalogue() calls share a fetch.
  var loadPromise = null;
  // Currently active collection (drives which tab panel is visible).
  var activeCollectionId = null;
  // Subsections the user has explicitly collapsed. Default = open.
  // Keys are "{collectionId}|{subsectionId}".
  var collapsedSubs = Object.create(null);
  // Currently filtered query string (search box).
  var filterQuery = '';
  // "Show new only" toggle: when true, only products with is_new === true
  // are rendered. Persists across deck/catalogue toggles for the session.
  var newOnly = false;

  // Sentinel id for the "My selections" pseudo-tab: when activeCollectionId
  // matches this string, paintBody renders cart products grouped by
  // delivery month instead of one collection's subsections.
  var SELECTIONS_ID = '__selections__';

  function viewEl() { return document.getElementById('view-catalogue'); }
  function subKey(colId, subId) { return colId + '|' + subId; }

  // ── Public renderer ────────────────────────────────────────────────────
  async function renderCatalogue() {
    var c     = window.fwApp;
    var panel = viewEl();
    if (!panel) return;

    // Initial shell while we fetch. Toolbar card up top groups the
    // back button, title, controls, and tab bar, mirroring the apparel
    // form's "Order Information" card style.
    panel.innerHTML = ''
      + '<div class="cat-shell">'
      +   '<div class="cat-toolbar">'
      +     '<div class="cat-header">'
      +       '<button class="cat-back" id="cat-back-btn" type="button">'
      +         '<span class="cat-back-arrow" aria-hidden="true">&larr;</span>'
      +         '<span>Back to deck</span>'
      +       '</button>'
      +       '<div class="cat-title-block">'
      +         '<div class="cat-eyebrow">Step 4</div>'
      +         '<div class="cat-title">Footwear catalogue</div>'
      +       '</div>'
      +       '<div class="cat-controls">'
      +         '<label class="cat-toggle" for="cat-new-only">'
      +           '<input type="checkbox" id="cat-new-only" class="cat-toggle-input">'
      +           '<span class="cat-toggle-track"><span class="cat-toggle-thumb"></span></span>'
      +           '<span class="cat-toggle-label">Show new only</span>'
      +         '</label>'
      +         '<div class="cat-search-wrap">'
      +           '<input type="search" class="cat-search" id="cat-search" placeholder="Search by name, SKU or colour" autocomplete="off">'
      +         '</div>'
      +       '</div>'
      +     '</div>'
      +     '<div class="cat-tabs" id="cat-tabs" role="tablist"></div>'
      +   '</div>'
      +   '<div class="cat-body" id="cat-body">'
      +     '<div class="placeholder-card"><div class="placeholder-card-body">Loading catalogue...</div></div>'
      +   '</div>'
      + '</div>';

    var backBtn = document.getElementById('cat-back-btn');
    if (backBtn) backBtn.addEventListener('click', function () {
      var order = (c.state.slideOrder || []);
      c.setView(order.length > 0 ? 'deck' : 'reorder');
    });

    // Load (or use cached) structured data
    if (!dataCache) {
      if (!loadPromise) loadPromise = loadCatalogue();
      var res = await loadPromise;
      loadPromise = null;
      if (res.error) {
        document.getElementById('cat-body').innerHTML = ''
          + '<div class="placeholder-card">'
          +   '<div class="placeholder-card-title">Could not load catalogue</div>'
          +   '<p class="placeholder-card-body">' + c.escapeHtml(res.error) + '</p>'
          + '</div>';
        return;
      }
      dataCache = res.data;
    }

    // Default the active collection to the first one with content. Reset
    // if a previously-active id was filtered out by newOnly/search.
    var visible = visibleCollections();
    if (!findCollection(visible, activeCollectionId)) {
      activeCollectionId = visible.length > 0 ? visible[0].id : null;
    }

    paintTabs();
    paintBody();
    wireSearch();
    wireNewOnlyToggle();

    if (c.cart && typeof c.cart.paintSummary === 'function') c.cart.paintSummary();
  }

  // ── Data loading ───────────────────────────────────────────────────────
  // Collections + subsections come from their tables. Products are
  // filtered to category='footwear', status in ('active','sold_out'),
  // sorted by item_number which is also the final tie-break inside a
  // subsection. Three queries in parallel.
  async function loadCatalogue() {
    var c    = window.fwApp;
    var supa = c.supa;
    if (!supa) return { error: 'Supabase client not ready.' };

    // Review-mode shortcut: customers run anon and the products RLS may not
    // allow it. The review payload from migration 0011 does not currently
    // include the full catalogue, so we surface a graceful empty state.
    // Reps use this view, customers view it read-only via preloadedProducts
    // if available.
    if (c.state.reviewMode) {
      if (c.state.preloadedProducts) {
        return { data: buildFromPreloaded(c.state.preloadedProducts) };
      }
      return { data: { collections: [] } };
    }

    var results;
    try {
      // Footwear form scopes collections to category='footwear' and the
      // active footwear season. If a season picker is added later, swap the
      // hardcoded 'AW27-shoe' for the selected season ID.
      var footwearSeason = (c.state && c.state.seasonId) || 'AW27-shoe';
      results = await Promise.all([
        supa.from('collections')
            .select('collection_id, collection_name, delivery_season, season_id, category, tab_order, status')
            .eq('status', 'active')
            .eq('category', 'footwear')
            .eq('season_id', footwearSeason)
            .order('tab_order, collection_name', { ascending: true }),
        supa.from('subsections')
            .select('subsection_id, subsection_name, collection_id, sort_order, status')
            .order('collection_id, sort_order', { ascending: true }),
        supa.from('products')
            .select('id, sku, base_sku, item_number, name:product_name, sizes:available_sizes, width, exclusive, silo, outsole, energy, colour, is_new, is_top_seller, aud_ws_price, aud_rrp_price, nzd_ws_price, nzd_rrp_price, collection_id, subsection_id, delivery_months, status, category')
            .eq('category', 'footwear')
            .in('status', ['active', 'sold_out'])
            .order('item_number', { ascending: true })
      ]);
    } catch (e) {
      return { error: (e && e.message) || 'Network error while loading catalogue.' };
    }

    var colsRes = results[0], subsRes = results[1], prodsRes = results[2];
    if (colsRes.error)  return { error: colsRes.error.message  || 'Could not load collections.' };
    if (subsRes.error)  return { error: subsRes.error.message  || 'Could not load subsections.' };
    if (prodsRes.error) return { error: prodsRes.error.message || 'Could not load products.' };

    var subsByCollection = {};
    var subsById = {};
    (subsRes.data || []).forEach(function (s) {
      subsById[s.subsection_id] = s;
      var key = s.collection_id || '__none__';
      if (!subsByCollection[key]) subsByCollection[key] = [];
      subsByCollection[key].push(s);
    });

    // Group products by collection, then by subsection. Products with no
    // collection or no subsection fall into __none__ buckets that get
    // rendered as "Other".
    var productsByCol = {};
    (prodsRes.data || []).forEach(function (p) {
      var cid = p.collection_id || '__none__';
      var sid = p.subsection_id || '__none__';
      if (!productsByCol[cid]) productsByCol[cid] = {};
      if (!productsByCol[cid][sid]) productsByCol[cid][sid] = [];
      productsByCol[cid][sid].push(p);
    });

    // Stable sort within each subsection bucket by item_number then sku.
    Object.keys(productsByCol).forEach(function (cid) {
      Object.keys(productsByCol[cid]).forEach(function (sid) {
        productsByCol[cid][sid].sort(function (a, b) {
          var ai = Number(a.item_number); var bi = Number(b.item_number);
          if (!isNaN(ai) && !isNaN(bi) && ai !== bi) return ai - bi;
          return String(a.sku || '').localeCompare(String(b.sku || ''));
        });
        // After sorting, collapse rows that share a base_sku into a
        // single representative product carrying the sibling variants
        // on a ._variants array. The product card uses that to render
        // a width-pill toggle instead of repeating the same shoe image
        // and metadata three times.
        productsByCol[cid][sid] = dedupeByBaseSku(productsByCol[cid][sid]);
      });
    });

    // Build the ordered collections list. Skip empty collections so we
    // don't show tabs that go to nothing.
    var collections = [];
    (colsRes.data || []).forEach(function (col) {
      var cid = col.collection_id;
      if (!productsByCol[cid]) return;

      // Subsections in their declared sort order, with any orphan subsection_ids
      // (in products but not in subsections table) appended.
      var declaredOrder = (subsByCollection[cid] || [])
        .slice()
        .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); })
        .map(function (s) { return s.subsection_id; });
      var orphans = Object.keys(productsByCol[cid])
        .filter(function (sid) { return sid !== '__none__' && declaredOrder.indexOf(sid) < 0; });
      var sectionOrder = declaredOrder.concat(orphans);
      if (productsByCol[cid]['__none__']) sectionOrder.push('__none__');

      var subsections = sectionOrder
        .filter(function (sid) {
          return productsByCol[cid][sid] && productsByCol[cid][sid].length > 0;
        })
        .map(function (sid) {
          var subRow = subsById[sid];
          return {
            id:       sid,
            name:     subRow ? subRow.subsection_name : (sid === '__none__' ? 'Other' : sid),
            products: productsByCol[cid][sid]
          };
        });

      if (subsections.length === 0) return;
      collections.push({
        id:          cid,
        name:        col.collection_name || cid,
        delivery:    col.delivery_season || '',
        subsections: subsections
      });
    });

    // Bucket for products whose collection isn't in the active list.
    if (productsByCol['__none__']) {
      var orphanCol = {
        id:   '__none__',
        name: 'Other',
        delivery: '',
        subsections: Object.keys(productsByCol['__none__']).map(function (sid) {
          var subRow = subsById[sid];
          return {
            id: sid,
            name: subRow ? subRow.subsection_name : (sid === '__none__' ? 'Uncategorised' : sid),
            products: productsByCol['__none__'][sid]
          };
        })
      };
      if (orphanCol.subsections.some(function (s) { return s.products.length > 0; })) {
        collections.push(orphanCol);
      }
    }

    // Display order: Men's first, Women's second, Junior third, anything
    // else after that. Within each rank we keep the relative DB order
    // (Array.sort is stable in modern browsers).
    collections.sort(function (a, b) { return tabRank(a.name) - tabRank(b.name); });

    // Index every product by id so the My Selections view can resolve
    // cart entries to full product rows in O(1) without rescanning the
    // collections tree.
    var byId = {};
    (prodsRes.data || []).forEach(function (p) { byId[p.id] = p; });

    return { data: { collections: collections, productsById: byId } };
  }

  function tabRank(name) {
    var n = (name || '').toLowerCase();
    // Check 'women' before 'men' since 'women' contains 'men'.
    if (n.indexOf('women') >= 0) return 1;
    if (n.indexOf('men')   >= 0) return 0;
    if (n.indexOf('junior') >= 0) return 2;
    return 3;
  }

  // ── My-Selections helpers ──────────────────────────────────────────────

  // Walk the cart and collapse to one entry per product_id, summing
  // quantities across sizes/widths. Used by the My Selections tab to
  // know which product cards to render and as the count badge.
  function selectedProductIds() {
    var c = window.fwApp;
    var items = (c.state && Array.isArray(c.state.cartItems)) ? c.state.cartItems : [];
    var totals = {};
    items.forEach(function (it) {
      var pid = it && it.product_id;
      var qty = Number(it && it.quantity) || 0;
      if (!pid || qty <= 0) return;
      totals[pid] = (totals[pid] || 0) + qty;
    });
    return totals;
  }

  function countSelections() {
    return Object.keys(selectedProductIds()).length;
  }

  // Group cart products by delivery month, sort months chronologically,
  // sort products within each month by item_number then sku. Honours
  // the search query and the "Show new only" toggle so the user can
  // narrow down a long selection list. Returns:
  //   [ { key, label, products, units }, ... ]
  // where key is a stable id used for accordion collapse state.
  function buildSelectionGroups() {
    if (!dataCache) return [];
    var byId = dataCache.productsById || {};
    var totals = selectedProductIds();
    var pids = Object.keys(totals);
    if (pids.length === 0) return [];

    var q = (filterQuery || '').toLowerCase();
    var groupsByKey = {};

    pids.forEach(function (pid) {
      var p = byId[pid];
      if (!p) return;
      if (newOnly && !p.is_new) return;
      if (q && !matches(p, q)) return;

      var label = primaryDeliveryLabel(p);
      var key   = primaryDeliveryKey(p);
      if (!groupsByKey[key]) groupsByKey[key] = { key: key, label: label, sortKey: deliverySortKey(label), products: [], units: 0 };
      groupsByKey[key].products.push(p);
      groupsByKey[key].units += totals[pid];
    });

    var groups = Object.keys(groupsByKey).map(function (k) { return groupsByKey[k]; });

    // Sort groups by chronological delivery key. Unscheduled bucket
    // (sortKey == null) is pushed to the end.
    groups.sort(function (a, b) {
      if (a.sortKey == null && b.sortKey == null) return a.label.localeCompare(b.label);
      if (a.sortKey == null) return 1;
      if (b.sortKey == null) return -1;
      return a.sortKey - b.sortKey;
    });

    // Sort products within each group by item_number, then sku. After
    // sorting, collapse rows that share a base_sku so My Selections
    // shows one consolidated card per style with a width toggle, the
    // same as the regular catalogue panels do.
    groups.forEach(function (g) {
      g.products.sort(function (a, b) {
        var ai = Number(a.item_number); var bi = Number(b.item_number);
        if (!isNaN(ai) && !isNaN(bi) && ai !== bi) return ai - bi;
        return String(a.sku || '').localeCompare(String(b.sku || ''));
      });
      g.products = dedupeByBaseSku(g.products);
    });

    return groups;
  }

  // Collapse rows that share a base_sku into a single representative
  // product. Variant rows are attached as ._variants on every member so
  // any one of them can serve as the "active variant" the card is
  // showing. Width preference for the rep: Medium > Wide > Narrow > X
  // Wide > anything else, falling back to the first row when widths
  // are missing entirely.
  //
  // Rows with no base_sku (or a unique base_sku) pass through unchanged
  // as a single-variant group — the card renderer suppresses the
  // toggle when ._variants has only one entry.
  var WIDTH_RANK = { 'M': 1, 'W': 2, 'N': 3, 'XW': 4 };
  function widthSortKey(p) {
    var w = String((p && p.width) || '').trim().toUpperCase();
    return WIDTH_RANK[w] || 99;
  }
  function dedupeByBaseSku(products) {
    var groups = {};
    var order  = [];
    products.forEach(function (p) {
      var key = p.base_sku || p.sku || p.id;
      if (!groups[key]) {
        groups[key] = [p];
        order.push(key);
      } else {
        groups[key].push(p);
      }
    });
    return order.map(function (k) {
      var variants = groups[k].slice().sort(function (a, b) {
        var av = widthSortKey(a), bv = widthSortKey(b);
        if (av !== bv) return av - bv;
        return String(a.sku || '').localeCompare(String(b.sku || ''));
      });
      // Attach the variants list to every member so the card can render
      // any one of them as the active variant and still know its
      // siblings (for the pill toggle).
      variants.forEach(function (v) { v._variants = variants; });
      return variants[0];
    });
  }

  // Pick a single delivery month label per product. Most footwear ships
  // in one month; if multiple, use the earliest. If none, fall back to
  // an "Unscheduled" bucket so the product still appears.
  function primaryDeliveryLabel(p) {
    var months = normalizeDeliveryMonths(p.delivery_months);
    if (months.length === 0) return 'Unscheduled';
    if (months.length === 1) return months[0];
    // Multiple months: return the earliest by sort key.
    var best = months[0]; var bestKey = deliverySortKey(best);
    for (var i = 1; i < months.length; i++) {
      var k = deliverySortKey(months[i]);
      if (k != null && (bestKey == null || k < bestKey)) { best = months[i]; bestKey = k; }
    }
    return best;
  }

  function primaryDeliveryKey(p) {
    return primaryDeliveryLabel(p);
  }

  function normalizeDeliveryMonths(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    return [String(value)].filter(Boolean);
  }

  // Map a "Month YYYY" label to a numeric sort key (YYYYMM). Returns
  // null if the label can't be parsed so callers can sort it last.
  var MONTH_LOOKUP = {
    jan:1,  january:1,
    feb:2,  february:2,
    mar:3,  march:3,
    apr:4,  april:4,
    may:5,
    jun:6,  june:6,
    jul:7,  july:7,
    aug:8,  august:8,
    sep:9,  sept:9, september:9,
    oct:10, october:10,
    nov:11, november:11,
    dec:12, december:12
  };
  function deliverySortKey(label) {
    if (!label) return null;
    var m = /([a-z]+)\s*(\d{4})/i.exec(label);
    if (!m) return null;
    var name = m[1].toLowerCase();
    var month = MONTH_LOOKUP[name] || MONTH_LOOKUP[name.slice(0,3)];
    if (!month) return null;
    var year = parseInt(m[2], 10);
    if (isNaN(year)) return null;
    return year * 100 + month;
  }

  function selectionsEmptyMessage() {
    var c = window.fwApp;
    var hasSelections = countSelections() > 0;
    if (!hasSelections) {
      return 'Pick a tab on the left to start adding footwear. Anything you put in your cart will show up here grouped by delivery month.';
    }
    if (filterQuery && newOnly) {
      return 'No new selections matched "' + c.escapeHtml(filterQuery) + '". Clear the search or turn off "Show new only".';
    }
    if (filterQuery) {
      return 'No selections matched "' + c.escapeHtml(filterQuery) + '". Clear the search to see everything you have added.';
    }
    if (newOnly) {
      return 'None of your selected products are tagged new. Turn off "Show new only" to see them.';
    }
    return 'Add at least one pair to see it here.';
  }

  // Fallback used in review mode when only the cart's products were
  // preloaded. Builds a single ungrouped section so the customer can at
  // least re-inspect the lines they were sent.
  function buildFromPreloaded(preloaded) {
    var prods = Object.keys(preloaded || {}).map(function (id) { return preloaded[id]; });
    if (prods.length === 0) return { collections: [], productsById: {} };
    return {
      collections: [{
        id: '__preloaded__',
        name: 'Selections',
        delivery: '',
        subsections: [{
          id: '__all__', name: 'In your order', products: prods
        }]
      }],
      productsById: preloaded
    };
  }

  // ── Painting ───────────────────────────────────────────────────────────
  function paintTabs() {
    var c    = window.fwApp;
    var bar  = document.getElementById('cat-tabs');
    if (!bar || !dataCache) return;

    var visible = visibleCollections();
    var collectionTabs = visible.map(function (col) {
      var count = col.subsections.reduce(function (acc, s) { return acc + s.products.length; }, 0);
      var isActive = col.id === activeCollectionId;
      return ''
        + '<button class="cat-tab' + (isActive ? ' cat-tab-active' : '') + '"'
        +        ' role="tab" aria-selected="' + (isActive ? 'true' : 'false') + '"'
        +        ' data-cat-tab="' + c.escapeAttr(col.id) + '" type="button">'
        +   '<span class="cat-tab-name">' + c.escapeHtml(col.name) + '</span>'
        +   '<span class="cat-tab-count">' + count + '</span>'
        + '</button>';
    }).join('');

    // "My selections" tab pinned to the right. Active state has a black
    // fill (apparel pattern); count pill shows how many distinct
    // products are currently in the cart.
    var selCount = countSelections();
    var selActive = activeCollectionId === SELECTIONS_ID;
    var selTab = ''
      + '<button class="cat-tab cat-tab-selections' + (selActive ? ' cat-tab-active' : '') + '"'
      +        ' role="tab" aria-selected="' + (selActive ? 'true' : 'false') + '"'
      +        ' data-cat-tab="' + SELECTIONS_ID + '" type="button">'
      +   '<span class="cat-tab-check" aria-hidden="true">' + (selActive ? '&#9745;' : '&#9744;') + '</span>'
      +   '<span class="cat-tab-name">My selections</span>'
      +   (selCount > 0 ? '<span class="cat-tab-count">' + selCount + '</span>' : '')
      + '</button>';

    bar.innerHTML = collectionTabs + selTab;

    bar.querySelectorAll('[data-cat-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cid = btn.getAttribute('data-cat-tab');
        if (!cid || cid === activeCollectionId) return;
        activeCollectionId = cid;
        paintTabs();
        paintBody();
      });
    });
  }

  function paintBody() {
    var c    = window.fwApp;
    var body = document.getElementById('cat-body');
    if (!body || !dataCache) return;

    if (activeCollectionId === SELECTIONS_ID) {
      paintSelectionsBody(body);
      return;
    }

    var visible = visibleCollections();
    if (visible.length === 0) {
      body.innerHTML = ''
        + '<div class="placeholder-card">'
        +   '<div class="placeholder-card-title">No matches</div>'
        +   '<p class="placeholder-card-body">' + emptyStateMessage() + '</p>'
        + '</div>';
      return;
    }

    var col = findCollection(visible, activeCollectionId) || visible[0];
    activeCollectionId = col.id;

    body.innerHTML = renderPanelHtml(col);

    // Wire each card to the cart helpers
    if (c.cart && typeof c.cart.wireProductCard === 'function') {
      col.subsections.forEach(function (sub) {
        sub.products.forEach(function (p) {
          var card = findCardFor(body, p);
          if (card) c.cart.wireProductCard(card, p);
        });
      });
    }

    wireAccordionToggles(body);
  }

  // Locate the rendered card for a given representative product. For
  // single-width products we match on data-fw-product-id; for
  // consolidated multi-width products the card may have been rendered
  // for a different active variant (the rep's previous pill choice for
  // this style), so we fall back to matching on data-fw-base-sku.
  function findCardFor(body, p) {
    if (p && p._variants && p._variants.length > 1) {
      var baseKey = p.base_sku || p.sku;
      if (baseKey) {
        var byBase = body.querySelector('.pcard[data-fw-base-sku="' + cssEscape(baseKey) + '"]');
        if (byBase) return byBase;
      }
    }
    return body.querySelector('.pcard[data-fw-product-id="' + cssEscape(p.id) + '"]');
  }

  // Render the "My selections" panel: only products with at least one
  // pair in the cart, grouped into accordions by delivery month, sorted
  // chronologically. Within each month, products are sorted by
  // item_number (then sku) to match the rest of the catalogue.
  function paintSelectionsBody(body) {
    var c    = window.fwApp;
    var groups = buildSelectionGroups();

    if (groups.length === 0) {
      body.innerHTML = ''
        + '<div class="placeholder-card">'
        +   '<div class="placeholder-card-title">No selections yet</div>'
        +   '<p class="placeholder-card-body">' + selectionsEmptyMessage() + '</p>'
        + '</div>';
      return;
    }

    var sectionsHtml = groups.map(function (g) {
      var key = subKey(SELECTIONS_ID, g.key);
      // Same source-of-truth rule as the catalogue panels: respect the
      // user's persisted collapse state regardless of filter activity.
      var collapsed = !!collapsedSubs[key];
      var cardsHtml = g.products.map(function (p) {
        return c.cart && c.cart.renderProductCard ? c.cart.renderProductCard(p) : '';
      }).join('');
      return ''
        + '<div class="cat-section" data-cat-section="' + c.escapeAttr(key) + '">'
        +   '<button class="cat-section-head" data-cat-sub-toggle="' + c.escapeAttr(key) + '" type="button"'
        +          ' aria-expanded="' + (collapsed ? 'false' : 'true') + '">'
        +     '<span class="cat-section-icon' + (collapsed ? ' cat-section-icon-closed' : '') + '" aria-hidden="true">&#9662;</span>'
        +     '<span class="cat-section-name">' + c.escapeHtml(g.label) + '</span>'
        +     '<span class="cat-section-meta">'
        +       g.products.length + ' style' + (g.products.length === 1 ? '' : 's') + ' &middot; '
        +       g.units + ' pair' + (g.units === 1 ? '' : 's')
        +     '</span>'
        +   '</button>'
        +   '<div class="cat-section-body' + (collapsed ? '' : ' cat-section-body-open') + '">'
        +     '<div class="cat-grid">' + cardsHtml + '</div>'
        +   '</div>'
        + '</div>';
    }).join('');

    body.innerHTML = '<div class="cat-panel" data-cat-panel="' + SELECTIONS_ID + '">' + sectionsHtml + '</div>';

    if (c.cart && typeof c.cart.wireProductCard === 'function') {
      groups.forEach(function (g) {
        g.products.forEach(function (p) {
          var card = findCardFor(body, p);
          if (card) c.cart.wireProductCard(card, p);
        });
      });
    }

    wireAccordionToggles(body);
  }

  function wireAccordionToggles(body) {
    body.querySelectorAll('[data-cat-sub-toggle]').forEach(function (head) {
      head.addEventListener('click', function () {
        var key = head.getAttribute('data-cat-sub-toggle');
        if (!key) return;
        // Toggle the user's persisted collapsed state. The toggle works
        // regardless of whether a search or new-only filter is active;
        // filtering only affects which products appear inside each
        // section.
        if (collapsedSubs[key]) delete collapsedSubs[key];
        else                    collapsedSubs[key] = true;
        paintBody();
      });
    });
  }

  function renderPanelHtml(col) {
    var c = window.fwApp;

    var subsHtml = col.subsections.map(function (sub) {
      var key = subKey(col.id, sub.id);
      // The user's persisted collapsed state is the only source of truth.
      // Filters (search / new-only) only affect which products render
      // inside each section; they do not force sections open or closed.
      var collapsed = !!collapsedSubs[key];
      var cardsHtml = sub.products.map(function (p) {
        return c.cart && c.cart.renderProductCard
          ? c.cart.renderProductCard(p)
          : '';
      }).join('');
      return ''
        + '<div class="cat-section" data-cat-section="' + c.escapeAttr(key) + '">'
        +   '<button class="cat-section-head" data-cat-sub-toggle="' + c.escapeAttr(key) + '" type="button"'
        +          ' aria-expanded="' + (collapsed ? 'false' : 'true') + '">'
        +     '<span class="cat-section-icon' + (collapsed ? ' cat-section-icon-closed' : '') + '" aria-hidden="true">&#9662;</span>'
        +     '<span class="cat-section-name">' + c.escapeHtml(sub.name) + '</span>'
        +     '<span class="cat-section-meta">' + sub.products.length + ' product' + (sub.products.length === 1 ? '' : 's') + '</span>'
        +   '</button>'
        +   '<div class="cat-section-body' + (collapsed ? '' : ' cat-section-body-open') + '">'
        +     '<div class="cat-grid">' + cardsHtml + '</div>'
        +   '</div>'
        + '</div>';
    }).join('');

    return ''
      + '<div class="cat-panel" data-cat-panel="' + c.escapeAttr(col.id) + '">'
      +   subsHtml
      + '</div>';
  }

  function emptyStateMessage() {
    var c = window.fwApp;
    if (filterQuery && newOnly) {
      return 'No new footwear matched "' + c.escapeHtml(filterQuery) + '". Clear the search or turn off "Show new only".';
    }
    if (filterQuery) {
      return 'No footwear matched "' + c.escapeHtml(filterQuery) + '". Clear the search to see everything.';
    }
    if (newOnly) {
      return 'No new footwear yet. Turn off "Show new only" to see the full catalogue.';
    }
    return 'No footwear is available in the catalogue yet.';
  }

  // ── Search wiring ──────────────────────────────────────────────────────
  function wireSearch() {
    var input = document.getElementById('cat-search');
    if (!input) return;
    // Restore the persisted query when the view re-mounts so the input
    // and the filtered body stay in sync across deck/catalogue toggles.
    if (filterQuery) input.value = filterQuery;
    var debounceTimer = null;
    input.addEventListener('input', function () {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        filterQuery = input.value.trim();
        rerenderForFilters();
      }, 120);
    });
  }

  // "Show new only" toggle: filters products to is_new === true on top
  // of any active search query. Persists in module state so toggling
  // between deck and catalogue keeps the chosen filter.
  function wireNewOnlyToggle() {
    var input = document.getElementById('cat-new-only');
    if (!input) return;
    input.checked = newOnly;
    input.addEventListener('change', function () {
      newOnly = !!input.checked;
      rerenderForFilters();
    });
  }

  function rerenderForFilters() {
    // After a filter change the active tab may have lost all its content;
    // hop to the first visible one so the rep is never staring at an empty
    // panel they cannot tell apart from a real empty state.
    var visible = visibleCollections();
    if (!findCollection(visible, activeCollectionId) && visible.length > 0) {
      activeCollectionId = visible[0].id;
    }
    paintTabs();
    paintBody();
  }

  // ── Filtering ──────────────────────────────────────────────────────────
  // Returns a deep-cloned, filtered collections list based on filterQuery
  // and the "Show new only" toggle. When neither filter is active, the
  // raw cache is returned unchanged.
  function visibleCollections() {
    if (!dataCache) return [];
    var q = (filterQuery || '').toLowerCase();
    if (!q && !newOnly) return dataCache.collections;

    return dataCache.collections.map(function (col) {
      var subsections = col.subsections.map(function (sub) {
        var products = sub.products.filter(function (p) {
          if (newOnly && !p.is_new) return false;
          if (q && !matches(p, q)) return false;
          return true;
        });
        return { id: sub.id, name: sub.name, products: products };
      }).filter(function (sub) { return sub.products.length > 0; });
      return { id: col.id, name: col.name, delivery: col.delivery, subsections: subsections };
    }).filter(function (col) { return col.subsections.length > 0; });
  }

  function matches(p, q) {
    var hay = [
      p.name,
      p.sku,
      p.base_sku,
      p.colour,
      p.exclusive,
      p.silo,
      String(p.item_number || '')
    ].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function filtersActive() { return !!(filterQuery || newOnly); }

  function findCollection(list, id) {
    if (!id || !list) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  // ── Cart change reaction ───────────────────────────────────────────────
  // cart.js calls this every time the cart mutates (add / remove /
  // setQuantity / clear). The selections tab and the tab count badge
  // both depend on cart contents, so we re-render here.
  function onCartChanged() {
    if (!viewEl()) return;
    // Always refresh the tab strip so the My Selections count stays
    // current (works whether the catalogue view is the one on screen
    // or not -- when hidden, the tab bar simply re-renders into the
    // hidden view's DOM, ready for next show).
    if (document.getElementById('cat-tabs')) paintTabs();
    if (activeCollectionId === SELECTIONS_ID) paintBody();
  }

  // ── Public API ─────────────────────────────────────────────────────────
  // Forces the next renderCatalogue() to re-fetch from the database. Call
  // after sign-out so a different rep does not see the previous one's cache.
  function invalidate() {
    dataCache = null;
    loadPromise = null;
    activeCollectionId = null;
    collapsedSubs = Object.create(null);
    filterQuery = '';
    newOnly = false;
  }

  // Lookup helper used by cart.js (and any other code) to resolve a
  // product id to its full row, including base_sku. Falls back to the
  // review-mode preloaded cache when the rep-mode dataCache hasn't been
  // built yet (e.g. cart counts visible before the catalogue is opened).
  function getProductById(productId) {
    if (productId == null) return null;
    if (dataCache && dataCache.productsById && dataCache.productsById[productId]) {
      return dataCache.productsById[productId];
    }
    var c = window.fwApp;
    if (c && c.state && c.state.preloadedProducts && c.state.preloadedProducts[productId]) {
      return c.state.preloadedProducts[productId];
    }
    return null;
  }

  window.fwApp.views.catalogue = renderCatalogue;
  window.fwApp.catalogue = {
    invalidate:      invalidate,
    onCartChanged:   onCartChanged,
    getProductById:  getProductById,
    // Exposed for other views (slide-product-strip, templates, future
    // surfaces) so they can collapse multi-width product lists into a
    // single card with a width pill toggle, the same way the
    // catalogue does. Mutates each input variant to attach
    // ._variants; returns one rep variant per base_sku.
    dedupeByBaseSku: dedupeByBaseSku
  };
})();
