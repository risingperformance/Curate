// ─── Cart ──────────────────────────────────────────────────────────────────
//
// Cart state lives on window.fwApp.state.cartItems as the brief specifies:
// an array of cart-line objects. All template modules add to / remove
// from / inspect the cart through this module's API.
//
// Cart line shape (May 2026 parity pass):
//   { product_id, size, width, quantity,
//     unit_price,   // snapshot of WS price in rep's country
//     exclusive,    // product attribute, snapshotted
//     silo,         // product attribute, snapshotted
//     outsole,      // product attribute, snapshotted
//     energy }      // product attribute, snapshotted
//
// All snapshot fields are captured at add-to-cart time, not at submit,
// so the order detail reflects what the rep actually showed the
// customer at point of sale even if the product is later renamed,
// re-tagged, or deleted.
//
// Legacy lines (saved before snapshotting was introduced) omit some
// or all snapshot fields. The dashboard treats missing unit_price as
// 0 for value totals and surfaces a "value not tracked" note when
// any legacy line is included.
//
// Cart UX:
//   - cart.openPicker(product, anchorEl) opens a size + quantity picker
//     for one product. On Save, lines are written into cartItems and the
//     draft row is updated.
//   - The floating cart summary lives in deck.js and reads cart.count().
//   - cart.openReview() opens the Review-order modal with all lines, +/-
//     adjustments per line, remove buttons, and the Submit button.
//   - cart.submit() POSTs to /functions/v1/send-footwear-order-email and
//     flips the draft status to 'submitted'.
//
// Section 4.4 / 4.5 of the AW27 footwear brief. Sizes and widths flow via
// dataset attributes per 4.5; we never build inline onclick="..." with
// raw size strings.

(function () {
  'use strict';

  window.fwApp = window.fwApp || {};

  // ── Cart helpers ────────────────────────────────────────────────────────
  function items() {
    var c = window.fwApp;
    if (!Array.isArray(c.state.cartItems)) c.state.cartItems = [];
    return c.state.cartItems;
  }

  function count() {
    return items().reduce(function (sum, it) { return sum + (Number(it.quantity) || 0); }, 0);
  }

  function lineCount() { return items().length; }

  // Styles count for the footer chip. A "style" is one base_sku, so
  // multiple width variants (Narrow, Medium, Wide) of the same style
  // count as one style and not three. Falls back to product_id when
  // base_sku cannot be resolved (catalogue not yet loaded), which means
  // the style count is at worst the line count and never undercounts.
  function styleCount() {
    var arr = items();
    var lookup = window.fwApp.catalogue && window.fwApp.catalogue.getProductById;
    var seen = Object.create(null);
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      var p = lookup ? lookup(it.product_id) : null;
      var key = (p && p.base_sku) || it.product_id;
      if (key != null) seen[key] = true;
    }
    return Object.keys(seen).length;
  }

  function findIndex(productId, size, width) {
    var arr = items();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].product_id === productId
       && (arr[i].size  || null) === (size  || null)
       && (arr[i].width || null) === (width || null)) return i;
    }
    return -1;
  }

  // Snapshot the per-line product data we want to preserve on each
  // cart_item. Captured at add-to-cart time so the order detail stays
  // accurate even if the product is later renamed or its attributes
  // change. Returns nulls when the catalogue isn't loaded yet or the
  // product is unknown; the caller decides whether to write each
  // field. priceForCountry is hoisted from later in the same IIFE.
  function snapshotProductData(productId) {
    var empty = { unit_price: null, exclusive: null, silo: null, outsole: null, energy: null };
    var cat = window.fwApp && window.fwApp.catalogue;
    if (!cat || !cat.getProductById) return empty;
    var p = cat.getProductById(productId);
    if (!p) return empty;
    var pricing = priceForCountry(p);
    var n = Number(pricing && pricing.ws);
    return {
      unit_price: isFinite(n) ? n : null,
      exclusive:  p.exclusive || null,
      silo:       p.silo      || null,
      outsole:    p.outsole   || null,
      energy:     p.energy    || null
    };
  }

  function getQty(productId, size, width) {
    var i = findIndex(productId, size, width);
    return i >= 0 ? (Number(items()[i].quantity) || 0) : 0;
  }

  function add(productId, size, width, qty) {
    qty = Number(qty) || 0;
    if (qty <= 0 || !productId) return;
    var arr = items();
    var i = findIndex(productId, size, width);
    if (i >= 0) {
      arr[i].quantity = (Number(arr[i].quantity) || 0) + qty;
      // Backfill any snapshot field that was missing on an existing
      // line (legacy drafts saved before snapshotting was wired up).
      // We only overwrite null/undefined — never the rep's existing
      // snapshot, in case the underlying product was edited since.
      var snap = snapshotProductData(productId);
      if (arr[i].unit_price == null && snap.unit_price != null) arr[i].unit_price = snap.unit_price;
      if (arr[i].exclusive  == null && snap.exclusive  != null) arr[i].exclusive  = snap.exclusive;
      if (arr[i].silo       == null && snap.silo       != null) arr[i].silo       = snap.silo;
      if (arr[i].outsole    == null && snap.outsole    != null) arr[i].outsole    = snap.outsole;
      if (arr[i].energy     == null && snap.energy     != null) arr[i].energy     = snap.energy;
    } else {
      var snapNew = snapshotProductData(productId);
      arr.push({
        product_id: productId,
        size: size || null,
        width: width || null,
        quantity: qty,
        unit_price: snapNew.unit_price,
        exclusive:  snapNew.exclusive,
        silo:       snapNew.silo,
        outsole:    snapNew.outsole,
        energy:     snapNew.energy
      });
    }
    schedulePersist();
    paintSummary();
  }

  function setQuantity(productId, size, width, qty) {
    qty = Number(qty) || 0;
    var arr = items();
    var i = findIndex(productId, size, width);
    if (i < 0) {
      if (qty > 0) add(productId, size, width, qty);
      return;
    }
    if (qty <= 0) {
      arr.splice(i, 1);
    } else {
      arr[i].quantity = qty;
      // Same legacy backfill as add(): if the rep edits the qty of a
      // line that was saved before snapshotting was introduced, fill
      // in any null snapshot fields so downstream totals and order
      // detail stay accurate.
      var snap = snapshotProductData(productId);
      if (arr[i].unit_price == null && snap.unit_price != null) arr[i].unit_price = snap.unit_price;
      if (arr[i].exclusive  == null && snap.exclusive  != null) arr[i].exclusive  = snap.exclusive;
      if (arr[i].silo       == null && snap.silo       != null) arr[i].silo       = snap.silo;
      if (arr[i].outsole    == null && snap.outsole    != null) arr[i].outsole    = snap.outsole;
      if (arr[i].energy     == null && snap.energy     != null) arr[i].energy     = snap.energy;
    }
    schedulePersist();
    paintSummary();
  }

  function remove(productId, size, width) {
    setQuantity(productId, size, width, 0);
  }

  function clear() {
    var c = window.fwApp;
    c.state.cartItems = [];
    schedulePersist();
    paintSummary();
  }

  // ── Persistence ─────────────────────────────────────────────────────────
  var persistTimer = null;
  function schedulePersist() {
    // Review mode is read-only for the customer; never write.
    if (window.fwApp.state.reviewMode) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 400);
  }
  async function persistNow() {
    persistTimer = null;
    var c = window.fwApp;
    if (!c.persistDraft) return;
    var saveRes = await c.persistDraft({ cart_items: c.state.cartItems });
    if (saveRes.error) {
      c.toast('Could not save cart: ' + (saveRes.error.message || 'unknown error'), 'error');
    }
  }

  // ── Fixed footer (mirrors the apparel form's #app-footer) ─────────────
  // The element lives in index.html as #fw-app-footer; we paint into it
  // whenever the cart mutates. The footer carries the customer name, a
  // unit / line counter, and the action cluster (fullscreen, save,
  // review). It is fixed to the bottom of the viewport; views beneath
  // it leave 80px of bottom padding so nothing is hidden.
  function paintSummary() {
    var el = document.getElementById('fw-app-footer');
    if (!el) return;
    var c = window.fwApp;
    var n = count();
    var styles = styleCount();
    var ehtml = c.escapeHtml || function (s) { return String(s == null ? '' : s); };

    var customerName = (c.state.customer && (c.state.customer.account_name || c.state.customer.account_code)) || '';
    var leftHtml = ''
      + '<div class="footer-left">'
      +   '<div class="footer-stat">'
      +     '<div class="footer-stat-label">Customer</div>'
      +     '<div class="footer-stat-value">' + (customerName ? ehtml(customerName) : '&mdash;') + '</div>'
      +   '</div>'
      +   '<div class="footer-stat">'
      +     '<div class="footer-stat-label">Pairs</div>'
      +     '<div class="footer-stat-value">' + n + '</div>'
      +   '</div>'
      +   '<div class="footer-stat">'
      +     '<div class="footer-stat-label">Styles</div>'
      +     '<div class="footer-stat-value">' + styles + '</div>'
      +   '</div>'
      + '</div>';

    // Centre column: slide product strip trigger (Phase 2 + 4). Renders
    // only when (a) the feature flag is on, (b) the current view is the
    // deck, (c) the active slide has at least one product attached, and
    // (d) the active template's product_strip_behavior is not 'hidden'.
    // Hidden on the catalogue view (which has its own browsing) and
    // naturally absent on questionnaire / reorder / summary because the
    // footer itself is hidden on those views.
    var slideProducts = (c.state && c.state.currentSlideProducts) || [];
    var stripFlagOn   = !!(c.state && c.state.flags && c.state.flags.slideStrip);
    var onDeckView    = c.state && c.state.activeView === 'deck';
    var behaviorOk    = !c.state || c.state.currentSlideStripBehavior !== 'hidden';
    var showTrigger   = stripFlagOn && onDeckView && behaviorOk && slideProducts.length > 0;
    var centerHtml    = '<div class="footer-center">';
    if (showTrigger) {
      var label = 'Products on this slide (' + slideProducts.length + ')';
      centerHtml += ''
        + '<button class="footer-trigger"'
        +        ' data-fw-cart="strip-toggle"'
        +        ' type="button"'
        +        ' aria-label="' + ehtml(label) + '"'
        +        ' aria-pressed="false"'
        +        ' aria-expanded="false"'
        +        ' aria-controls="fw-strip-drawer">'
        +   '<span class="footer-trigger-icon" aria-hidden="true">P</span>'
        +   '<span class="footer-trigger-label">' + ehtml(label) + '</span>'
        + '</button>';
    }
    centerHtml += '</div>';

    // Review mode collapses the action cluster to a single Review summary
    // button; the customer cannot edit selections.
    if (c.state.reviewMode) {
      el.innerHTML = leftHtml
        + centerHtml
        + '<div class="footer-actions">'
        +   '<button class="btn btn-fs" data-fw-cart="fullscreen" title="Toggle fullscreen" aria-label="Toggle fullscreen">&#9974;</button>'
        +   '<button class="btn-submit" data-fw-cart="review-summary">&#10003; Review summary</button>'
        + '</div>';
      wireFooter(el);
      return;
    }

    var reviewDisabled = n === 0 ? ' disabled' : '';
    el.innerHTML = leftHtml
      + centerHtml
      + '<div class="footer-actions">'
      // Save / Clear moved to the header hamburger menu.
      +   '<button class="btn btn-outline btn-fs" data-fw-cart="fullscreen" title="Toggle fullscreen" aria-label="Toggle fullscreen">&#9974;</button>'
      +   '<button class="btn-submit" data-fw-cart="review"' + reviewDisabled + '>&#10003; Review order</button>'
      + '</div>';

    wireFooter(el);

    // Notify cross-view listeners that depend on cart contents (e.g. the
    // catalogue's My Selections tab + count badge). paintSummary runs
    // after every mutation so this is the natural pulse to ride.
    var cat = window.fwApp.catalogue;
    if (cat && typeof cat.onCartChanged === 'function') {
      try { cat.onCartChanged(); } catch (e) { /* ignore */ }
    }
  }

  // Wire button handlers after each repaint. Buttons identify their
  // intent via data-fw-cart so the markup stays declarative.
  function wireFooter(el) {
    var c = window.fwApp;
    el.querySelectorAll('[data-fw-cart]').forEach(function (btn) {
      var action = btn.getAttribute('data-fw-cart');
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (action === 'review')          openReview();
        else if (action === 'review-summary') c.setView('summary');
        else if (action === 'fullscreen') toggleFullscreen();
        else if (action === 'clear')      handleClear();
        else if (action === 'save')       handleSave();
        else if (action === 'strip-toggle') handleStripToggle(btn);
      });
    });
  }

  // Phase 2.3: delegate to the slide-product-strip module. The module
  // owns the drawer DOM, body class, and trigger aria-pressed sync, so
  // this handler is intentionally tiny. A small fallback covers the
  // unlikely case that slide-product-strip.js failed to load.
  function handleStripToggle(btn) {
    var c = window.fwApp;
    if (c.slideStrip && typeof c.slideStrip.toggle === 'function') {
      c.slideStrip.toggle();
      return;
    }
    var willOpen = !document.body.classList.contains('fw-strip-open');
    document.body.classList.toggle('fw-strip-open', willOpen);
    if (btn) btn.setAttribute('aria-pressed', willOpen ? 'true' : 'false');
    console.warn('[fw] slideStrip module not loaded; using body-class fallback');
  }

  // Confirm-then-clear so a stray click does not torch the cart.
  function handleClear() {
    var c = window.fwApp;
    if (!items().length) return;
    if (!window.confirm('Clear every selection in your cart?')) return;
    clear();
    if (c.toast) c.toast('Cart cleared.', 'info');
  }

  // Save just nudges the draft to persist immediately so the rep gets
  // confirmation that their progress has been written. If a brand-new
  // draft would be blocked by the persist gate (no customer / no units)
  // we tell the rep specifically rather than show "Draft saved."
  async function handleSave() {
    var c = window.fwApp;
    if (typeof c.persistDraft !== 'function') return;

    // Pre-check the gate when there is no active draft yet so the rep
    // gets a meaningful message instead of a misleading success toast.
    if (!c.state.activeDraftId && typeof c.canSaveDraft === 'function') {
      var gate = c.canSaveDraft();
      if (!gate.ok) {
        if (gate.reason === 'no-customer') {
          c.toast && c.toast('Pick a customer first, then add at least one item.', 'info');
        } else if (gate.reason === 'no-units') {
          c.toast && c.toast('Add at least one item to your cart before saving.', 'info');
        } else {
          c.toast && c.toast('Cannot save yet.', 'info');
        }
        return;
      }
    }

    try {
      var res = await c.persistDraft({ cart_items: items() });
      if (res && res.error) {
        c.toast && c.toast('Save failed: ' + (res.error.message || res.error), 'error');
      } else if (res && res.skipped) {
        // Race: gate became false between check and call. Surface a
        // generic info toast rather than an incorrect success.
        c.toast && c.toast('Draft was not saved. Pick a customer and add an item.', 'info');
      } else {
        c.toast && c.toast('Draft saved.', 'success');
      }
    } catch (e) {
      c.toast && c.toast('Save failed: ' + (e && e.message || ''), 'error');
    }
  }

  // Toggle browser fullscreen, mirroring the apparel form's behaviour.
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      var el = document.documentElement;
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(function () { /* user gesture missing or unsupported */ });
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(function () { /* ignore */ });
      }
    }
  }

  // Section 5: rep grabs a #review={token} link they can text/email to a
  // customer. Native navigator.clipboard + a fallback selection trick if
  // clipboard is unavailable (some browsers gate clipboard.writeText to
  // user-gesture contexts).
  function openShareModal() {
    var c = window.fwApp;
    if (!c.state.activeShareToken) {
      c.toast('No share link is available yet. Save the draft first.', 'error');
      return;
    }
    var url = window.location.origin + window.location.pathname + '#review=' + c.state.activeShareToken;
    openModalRaw(''
      + '<div class="modal-card share-modal">'
      +   '<div class="picker-head">'
      +     '<div class="picker-eyebrow">Share with your customer</div>'
      +     '<div class="picker-title">AW27 Footwear review link</div>'
      +   '</div>'
      +   '<p class="share-body">Send this URL to your customer. They can review the deck and order without signing in. Their save will mark this draft as reviewed.</p>'
      +   '<input type="text" class="share-url" id="share-url-input" readonly value="' + c.escapeAttr(url) + '">'
      +   '<div class="picker-actions">'
      +     '<button class="btn btn-outline" data-fw-cart="picker-cancel">Close</button>'
      +     '<button class="btn btn-primary" id="share-copy-btn">Copy link</button>'
      +   '</div>'
      + '</div>');

    var modal = document.getElementById('app-modal');
    if (!modal) return;
    var input = modal.querySelector('#share-url-input');
    if (input) input.addEventListener('focus', function () { input.select(); });
    var copyBtn = modal.querySelector('#share-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async function () {
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = 'Copied';
          setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 1600);
        } catch (e) {
          // Fallback: select the input so the rep can Cmd/Ctrl+C
          input.focus();
          input.select();
          c.toast('Tap Copy in your browser menu, or Cmd/Ctrl + C with the URL selected.', 'info');
        }
      });
    }
    modal.querySelector('[data-fw-cart="picker-cancel"]').addEventListener('click', closeModalRaw);
  }

  // ── Picker modal: "Add to cart" for one product ─────────────────────────
  // product expected shape: { id, sku, name, sizes (jsonb array), width? }
  function openPicker(product) {
    if (!product || !product.id) return;
    // Defensive: in review mode, Add buttons are hidden via CSS, but if
    // an external caller still asks us to open the picker, refuse rather
    // than silently writing through to a draft the customer cannot save.
    if (window.fwApp.state.reviewMode) return;
    var c = window.fwApp;
    var sizes = parseSizesField(product.sizes);
    if (sizes.length === 0) sizes = ['OS'];

    var existingForProduct = items().filter(function (it) { return it.product_id === product.id; });
    var qtyBySize = {};
    existingForProduct.forEach(function (it) {
      var key = (it.size || '') + '|' + (it.width || '');
      qtyBySize[key] = it.quantity;
    });

    var width = product.width || null;

    var sizesHtml = sizes.map(function (size) {
      var key = size + '|' + (width || '');
      var qty = qtyBySize[key] || 0;
      return ''
        + '<div class="picker-row" data-size="' + c.escapeAttr(size) + '" data-width="' + c.escapeAttr(width || '') + '">'
        +   '<span class="picker-size-label">' + c.escapeHtml(size) + '</span>'
        +   '<div class="picker-qty">'
        +     '<button class="picker-qty-btn" data-fw-cart="qty-step" data-dir="down" aria-label="Decrease">&minus;</button>'
        +     '<input class="picker-qty-input" type="number" min="0" step="1" inputmode="numeric" value="' + qty + '" data-fw-cart="qty-input">'
        +     '<button class="picker-qty-btn" data-fw-cart="qty-step" data-dir="up" aria-label="Increase">+</button>'
        +   '</div>'
        + '</div>';
    }).join('');

    openModalRaw(''
      + '<div class="modal-card picker-modal">'
      +   '<div class="picker-head">'
      +     '<div class="picker-eyebrow">' + c.escapeHtml(product.sku || '') + (width ? ' &middot; Width ' + c.escapeHtml(width) : '') + '</div>'
      +     '<div class="picker-title">' + c.escapeHtml(product.name || product.sku || '') + '</div>'
      +   '</div>'
      +   '<div class="picker-rows">' + sizesHtml + '</div>'
      +   '<div class="picker-actions">'
      +     '<button class="btn btn-outline" data-fw-cart="picker-cancel">Cancel</button>'
      +     '<button class="btn btn-primary" data-fw-cart="picker-save" data-product-id="' + c.escapeAttr(product.id) + '">Save</button>'
      +   '</div>'
      + '</div>');

    // Wire qty +/- and input listeners
    var modal = document.getElementById('app-modal');
    if (!modal) return;
    modal.querySelectorAll('[data-fw-cart="qty-step"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row   = btn.closest('.picker-row');
        var input = row.querySelector('[data-fw-cart="qty-input"]');
        var cur   = parseInt(input.value, 10) || 0;
        cur += btn.dataset.dir === 'up' ? 1 : -1;
        if (cur < 0) cur = 0;
        input.value = cur;
      });
    });
    modal.querySelectorAll('[data-fw-cart="qty-input"]').forEach(function (input) {
      input.addEventListener('input', function () {
        var n = parseInt(input.value, 10);
        if (isNaN(n) || n < 0) input.value = 0;
      });
    });
    modal.querySelector('[data-fw-cart="picker-cancel"]').addEventListener('click', closeModalRaw);
    modal.querySelector('[data-fw-cart="picker-save"]').addEventListener('click', function (ev) {
      var productId = ev.target.dataset.productId;
      var rows = modal.querySelectorAll('.picker-row');
      rows.forEach(function (row) {
        var size  = row.dataset.size  || null;
        var w     = row.dataset.width || null;
        var input = row.querySelector('[data-fw-cart="qty-input"]');
        var qty   = parseInt(input.value, 10) || 0;
        setQuantity(productId, size, w || null, qty);
      });
      closeModalRaw();
      window.fwApp.toast('Cart updated.', 'success');
    });
  }

  // Sizes can land in the products row as either a JSONB array, a JSON
  // string, or a comma-separated text fallback. Parse defensively.
  function parseSizesField(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') {
      var s = value.trim();
      if (s.startsWith('[')) {
        try { return JSON.parse(s).map(String); } catch (e) { /* fall through */ }
      }
      return s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    }
    return [];
  }

  // ── Review modal ────────────────────────────────────────────────────────
  // Mirrors the apparel review layout (May 2026 parity pass): orders are
  // grouped by delivery month, then by silo (Athletic / Classic /
  // Other), and each (product, width) combination becomes a single row
  // with the sizes ordered, units, WS price, RRP, and line total.
  // Per-month subtotals and a grand total at the bottom give the rep a
  // quick read on the order before submitting. Read-only by design;
  // "Keep editing" returns the rep to the cart for adjustments.
  async function openReview() {
    var c = window.fwApp;
    if (count() === 0) {
      c.toast('Your cart is empty. Add at least one product before submitting.', 'error');
      return;
    }

    // Pull the richer product columns we need for the rebuilt review:
    // delivery_months for month grouping, silo/energy/exclusive for
    // badges, and country-aware pricing for WS / RRP figures.
    var ids = [];
    items().forEach(function (it) { if (ids.indexOf(it.product_id) < 0) ids.push(it.product_id); });
    var prodRes = await c.supa.from('products')
      .select('id, sku, base_sku, name:product_name, silo, energy, exclusive, outsole, delivery_months, aud_ws_price, aud_rrp_price, nzd_ws_price, nzd_rrp_price')
      .in('id', ids);
    if (prodRes.error) {
      c.toast('Could not load product details: ' + prodRes.error.message, 'error');
      return;
    }
    var byId = {};
    (prodRes.data || []).forEach(function (p) { byId[p.id] = p; });

    // Resolve display context: customer header line + currency.
    var customer = c.state.customer || {};
    var currencyCode = ((c.state.currentUser && c.state.currentUser.country) || 'AUD').toUpperCase() === 'NZD' ? 'NZD' : 'AUD';
    var dateLabel = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

    // ── Group: month -> silo -> (product_id, width) -> aggregated row ──
    function normalizeMonths(v) {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
      return [String(v)].filter(Boolean);
    }
    var MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
    function monthSortKey(label) {
      if (!label) return 9999999;
      var m = /([a-z]+)\s*(\d{4})/i.exec(label);
      if (!m) return 9999999;
      var name = m[1].toLowerCase();
      var month = MONTHS[name] || MONTHS[name.slice(0, 3)];
      if (!month) return 9999999;
      return parseInt(m[2], 10) * 100 + month;
    }
    function siloRank(s) {
      if (s === 'Athletic') return 1;
      if (s === 'Classic')  return 2;
      return 3;
    }

    var monthMap = {};
    items().forEach(function (it) {
      var qty = Number(it.quantity) || 0;
      if (qty <= 0) return;
      var p = byId[it.product_id];
      if (!p) return;

      var months = normalizeMonths(p.delivery_months);
      var month = months[0] || 'Unscheduled';
      var silo  = ((it.silo || p.silo || '') + '').trim() || 'Other';

      if (!monthMap[month]) {
        monthMap[month] = { month: month, sortKey: monthSortKey(month), siloMap: {} };
      }
      var mEntry = monthMap[month];
      if (!mEntry.siloMap[silo]) {
        mEntry.siloMap[silo] = { silo: silo, groups: {} };
      }
      var sEntry = mEntry.siloMap[silo];

      var gkey = it.product_id + '::' + (it.width || '');
      if (!sEntry.groups[gkey]) {
        sEntry.groups[gkey] = {
          product:   p,
          width:     it.width || null,
          sizes:     {},                            // size -> qty
          pairs:     0,
          unitPrice: Number(it.unit_price) || 0,    // snapshot wins
          energy:    (it.energy != null ? it.energy : p.energy),
          exclusive: (it.exclusive != null ? it.exclusive : p.exclusive)
        };
      }
      var g = sEntry.groups[gkey];
      var sizeKey = it.size || '-';
      g.sizes[sizeKey] = (g.sizes[sizeKey] || 0) + qty;
      g.pairs += qty;
    });

    var monthGroups = Object.values(monthMap)
      .sort(function (a, b) { return a.sortKey - b.sortKey; })
      .map(function (mEntry) {
        return {
          month: mEntry.month,
          silos: Object.values(mEntry.siloMap)
            .sort(function (a, b) {
              return siloRank(a.silo) - siloRank(b.silo) || a.silo.localeCompare(b.silo);
            })
            .map(function (sEntry) {
              return { silo: sEntry.silo, groups: Object.values(sEntry.groups) };
            })
        };
      });

    // ── Render ────────────────────────────────────────────────────────────
    var grandPairs = 0, grandValue = 0;
    var html = ''
      + '<div class="modal-card review-modal">'
      +   '<div class="review-modal-header">'
      +     '<div class="picker-eyebrow">Review your order</div>'
      +     '<div class="picker-title">AW27 Footwear</div>'
      +     '<div class="review-order-meta">'
      +       '<span><strong>Account:</strong> ' + c.escapeHtml(customer.account_name || '-') + '</span>'
      +       '<span><strong>Manager:</strong> ' + c.escapeHtml(customer.account_manager || '-') + '</span>'
      +       '<span><strong>' + c.escapeHtml(dateLabel) + '</strong></span>'
      +       '<span><strong>Currency:</strong> ' + currencyCode + '</span>'
      +     '</div>'
      +   '</div>'
      +   '<div class="review-modal-scroll">';

    monthGroups.forEach(function (m) {
      var monthPairs = 0, monthValue = 0;
      html += '<div class="review-month-heading">' + c.escapeHtml(m.month) + '</div>';

      m.silos.forEach(function (silo) {
        html += '<div class="review-subsection-heading">' + c.escapeHtml(silo.silo) + '</div>';
        html += '<table class="review-table">'
             +   '<thead><tr>'
             +     '<th>Product</th>'
             +     '<th>SKU</th>'
             +     '<th>Width</th>'
             +     '<th>Sizes Ordered</th>'
             +     '<th style="text-align:right">Pairs</th>'
             +     '<th style="text-align:right">WS</th>'
             +     '<th style="text-align:right">RRP</th>'
             +     '<th style="text-align:right">Line Total</th>'
             +   '</tr></thead>'
             +   '<tbody>';

        silo.groups.forEach(function (g) {
          var p = g.product;
          // Country-aware live prices, falling back to the cart-line
          // snapshot when the live row is missing the relevant column.
          var wsLive  = currencyCode === 'NZD' ? Number(p.nzd_ws_price)  : Number(p.aud_ws_price);
          var rrpLive = currencyCode === 'NZD' ? Number(p.nzd_rrp_price) : Number(p.aud_rrp_price);
          var ws  = isFinite(wsLive)  && wsLive  > 0 ? wsLive  : g.unitPrice;
          var rrp = isFinite(rrpLive) && rrpLive > 0 ? rrpLive : 0;
          var lineTotal = ws * g.pairs;
          monthPairs += g.pairs;
          monthValue += lineTotal;

          // Sizes formatted as "8 x 2  9 x 1  10.5 x 3", sorted by
          // numeric size when possible.
          var sortedSizes = Object.keys(g.sizes).sort(function (a, b) {
            var an = parseFloat(a), bn = parseFloat(b);
            if (isNaN(an) || isNaN(bn)) return String(a).localeCompare(String(b));
            return an - bn;
          });
          var sizeStr = sortedSizes
            .map(function (s) { return s + ' x ' + g.sizes[s]; })
            .join('   ');

          var energyBadge = isEnergyOn(g.energy)
            ? ' <span class="review-energy-badge">Energy</span>' : '';
          var exclusiveBadge = g.exclusive
            ? ' <span class="review-exclusive-badge">' + c.escapeHtml(g.exclusive) + '</span>' : '';

          html += '<tr>'
               +   '<td class="rev-name"><strong>' + c.escapeHtml(p.name || p.sku || '-') + '</strong>' + energyBadge + exclusiveBadge + '</td>'
               +   '<td><span class="rev-sku">' + c.escapeHtml(p.sku || '-') + '</span></td>'
               +   '<td>' + c.escapeHtml(g.width || '-') + '</td>'
               +   '<td style="white-space:nowrap;letter-spacing:0.5px">' + c.escapeHtml(sizeStr) + '</td>'
               +   '<td style="text-align:right">' + g.pairs + '</td>'
               +   '<td style="text-align:right">$' + ws.toFixed(2) + '</td>'
               +   '<td style="text-align:right">' + (rrp > 0 ? '$' + rrp.toFixed(2) : '-') + '</td>'
               +   '<td style="text-align:right"><strong>$' + lineTotal.toFixed(2) + '</strong></td>'
               + '</tr>';
        });

        html += '</tbody></table>';
      });

      html += '<div class="review-month-subtotal">'
           +   '<span>' + c.escapeHtml(m.month) + ' subtotal</span>'
           +   '<span><strong>' + monthPairs + '</strong> pairs &middot; <strong>' + currencyCode + ' $' + monthValue.toFixed(2) + '</strong></span>'
           + '</div>';

      grandPairs += monthPairs;
      grandValue += monthValue;
    });

    html += '<table class="review-table review-grand-total">'
         +   '<tfoot><tr>'
         +     '<td colspan="4" style="text-align:right">Grand total</td>'
         +     '<td style="text-align:right">' + grandPairs + '</td>'
         +     '<td></td><td></td>'
         +     '<td style="text-align:right">' + currencyCode + ' $' + grandValue.toFixed(2) + '</td>'
         +   '</tr></tfoot>'
         + '</table>';

    html += '</div>'  // close review-modal-scroll
         + '<div class="review-totals">'
         +   '<span>Total products: <b>' + lineCount() + '</b></span>'
         +   '<span>Total pairs: <b>' + grandPairs + '</b></span>'
         + '</div>'
         + '<div class="picker-actions">'
         +   '<button class="btn btn-outline" data-fw-cart="picker-cancel">Keep editing</button>'
         +   '<button class="btn btn-primary" data-fw-cart="rev-submit">Submit order</button>'
         + '</div>'
         + '</div>';  // close review-modal

    openModalRaw(html);

    var modal = document.getElementById('app-modal');
    if (!modal) return;
    modal.querySelector('[data-fw-cart="picker-cancel"]').addEventListener('click', closeModalRaw);
    modal.querySelector('[data-fw-cart="rev-submit"]').addEventListener('click', submit);
  }

  // ── Email body builder ──────────────────────────────────────────────────
  // Composes a plain HTML summary of the cart so we can reuse the
  // apparel form's send-order-email edge function (which expects
  // { subject, html } and forwards to Brevo). Keeps the markup minimal
  // and inline-styled so most email clients render it consistently.
  function buildFootwearOrderEmailHtml(c) {
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    var customer = c.state.customer || {};
    var rep      = c.state.currentUser || {};
    var cart     = c.state.cartItems || [];
    var lookup   = (c.catalogue && typeof c.catalogue.getProductById === 'function')
                     ? c.catalogue.getProductById : function () { return null; };

    // Group cart by product. Each group lists its size+width breakdown.
    var groups = {};
    cart.forEach(function (it) {
      var pid = it.product_id || '_unknown';
      if (!groups[pid]) groups[pid] = { product: lookup(pid), items: [] };
      groups[pid].items.push(it);
    });

    var totalPairs   = 0;
    var totalStyles  = Object.keys(groups).length;
    var rowsHtml = Object.keys(groups).map(function (pid) {
      var g  = groups[pid];
      var p  = g.product || {};
      var sizesText = g.items
        .map(function (it) {
          totalPairs += Number(it.quantity || 0);
          return esc((it.size || '-') + (it.width ? ' ' + it.width : '')) + ': ' + (it.quantity || 0);
        })
        .join(' &middot; ');
      var groupUnits = g.items.reduce(function (s, it) { return s + Number(it.quantity || 0); }, 0);
      return ''
        + '<tr>'
        +   '<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">' + esc(p.sku || pid) + '</td>'
        +   '<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb"><strong>' + esc(p.name || p.product_name || '(unnamed)') + '</strong>'
        +     (p.colour ? '<br><span style="font-size:12px;color:#6b7280">' + esc(p.colour) + '</span>' : '')
        +   '</td>'
        +   '<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px">' + sizesText + '</td>'
        +   '<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700">' + groupUnits + '</td>'
        + '</tr>';
    }).join('');

    var dateStr = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });

    return ''
      + '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
      + '<body style="margin:0;padding:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#111827">'
      +   '<div style="max-width:760px;margin:0 auto;padding:24px">'
      +     '<div style="background:#0a1834;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">'
      +       '<div style="font-size:11px;letter-spacing:3px;color:#c8a84b">FOOTJOY CURATE</div>'
      +       '<div style="font-family:Georgia,serif;font-size:24px;margin-top:6px">Footwear Prebook Order</div>'
      +     '</div>'
      +     '<div style="background:#fff;padding:20px 24px;border:1px solid #e5e7eb;border-top:0">'
      +       '<table style="width:100%;font-size:13px;color:#374151;border-collapse:collapse">'
      +         '<tr>'
      +           '<td style="padding:4px 0"><strong>Account</strong></td>'
      +           '<td style="padding:4px 0;text-align:right">' + esc(customer.account_name || customer.account_code || '-') + '</td>'
      +         '</tr>'
      +         '<tr>'
      +           '<td style="padding:4px 0"><strong>Account manager</strong></td>'
      +           '<td style="padding:4px 0;text-align:right">' + esc(customer.account_manager || rep.name || '-') + '</td>'
      +         '</tr>'
      +         '<tr>'
      +           '<td style="padding:4px 0"><strong>Submitted</strong></td>'
      +           '<td style="padding:4px 0;text-align:right">' + esc(dateStr) + '</td>'
      +         '</tr>'
      +         '<tr>'
      +           '<td style="padding:4px 0"><strong>Pairs</strong></td>'
      +           '<td style="padding:4px 0;text-align:right">' + totalPairs + '</td>'
      +         '</tr>'
      +         '<tr>'
      +           '<td style="padding:4px 0"><strong>Styles</strong></td>'
      +           '<td style="padding:4px 0;text-align:right">' + totalStyles + '</td>'
      +         '</tr>'
      +       '</table>'
      +     '</div>'
      +     '<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-top:0">'
      +       '<thead><tr style="background:#fafafa;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b7280">'
      +         '<th style="padding:10px;border-bottom:1px solid #e5e7eb">SKU</th>'
      +         '<th style="padding:10px;border-bottom:1px solid #e5e7eb">Product</th>'
      +         '<th style="padding:10px;border-bottom:1px solid #e5e7eb">Sizes</th>'
      +         '<th style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right">Units</th>'
      +       '</tr></thead>'
      +       '<tbody>' + rowsHtml + '</tbody>'
      +     '</table>'
      +     '<div style="padding:14px 24px;font-size:12px;color:#6b7280">Submitted via FootJoy Curate &middot; Draft id ' + esc(c.state.activeDraftId || '-') + '</div>'
      +   '</div>'
      + '</body></html>';
  }

  // ── Submit ──────────────────────────────────────────────────────────────
  async function submit() {
    var c = window.fwApp;
    var btn = document.querySelector('[data-fw-cart="rev-submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

    // Flush any pending cart persistence
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    var saveRes = await c.persistDraft({ cart_items: c.state.cartItems });
    if (saveRes.error) {
      c.toast('Could not save cart before submitting: ' + (saveRes.error.message || ''), 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Submit order'; }
      return;
    }

    // Build the email payload. We share the apparel form's send-order-email
    // edge function which expects { subject, html } and forwards to Brevo.
    var customer = c.state.customer || {};
    var subject  = 'FootJoy Footwear Prebook Order — '
                 + (customer.account_name || customer.account_code || 'Customer')
                 + ' — ' + new Date().toLocaleDateString('en-AU');
    var html     = buildFootwearOrderEmailHtml(c);

    // Use the Supabase client's invoke() so it handles the Authorization
    // header correctly across legacy anon JWT and new publishable key
    // formats. invoke returns { data, error } and surfaces non-2xx as
    // an error with .context (the original Response).
    var emailRes;
    try {
      var inv = await c.supa.functions.invoke('send-order-email', {
        body: { subject: subject, html: html },
      });
      if (inv.error) {
        var status = (inv.error.context && inv.error.context.status) || 0;
        var bodyText = '';
        try { bodyText = inv.error.context && (await inv.error.context.text()); }
        catch (e) { /* ignore */ }
        emailRes = { ok: false, status: status, body: bodyText || inv.error.message };
      } else {
        emailRes = { ok: true, status: 200, body: '' };
      }
    } catch (e) {
      emailRes = { ok: false, status: 0, body: (e && e.message) || 'Network error' };
    }

    // Mark the draft as submitted regardless of email outcome, and at
    // the same time populate the parity columns the dashboard needs
    // (country, customer_group, total_units, total_value, submitted_at).
    // These were added in the May 2026 parity migration. Writing them
    // here means the dashboard reads direct columns instead of having
    // to synthesise totals from cart_items on every page load.
    var lineItems   = Array.isArray(c.state.cartItems) ? c.state.cartItems : [];
    var totalUnits  = lineItems.reduce(function (s, it) {
                        return s + (Number(it.quantity) || 0);
                      }, 0);
    var totalValue  = lineItems.reduce(function (s, it) {
                        var q = Number(it.quantity)   || 0;
                        var p = Number(it.unit_price) || 0;
                        return s + q * p;
                      }, 0);
    var repCountry  = (c.state.currentUser && c.state.currentUser.country) || null;
    var custGroup   = (c.state.customer    && c.state.customer.group)      || null;

    var statusRes = await c.persistDraft({
      status:          'submitted',
      country:         repCountry,
      customer_group:  custGroup,
      total_units:     totalUnits,
      total_value:     totalValue,
      submitted_at:    new Date().toISOString()
    });
    if (statusRes.error) {
      c.toast('Could not mark draft as submitted: ' + (statusRes.error.message || ''), 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Submit order'; }
      return;
    }

    if (!emailRes.ok) {
      var msg = 'Order saved, but the confirmation email could not be sent. ';
      if (emailRes.status === 401 || emailRes.status === 403) {
        msg += '(Auth status ' + emailRes.status + '. Operations team can pull the order from the database.)';
      } else if (emailRes.status === 404) {
        msg += '(Edge function not found. Operations team can pull the order from the database.)';
      } else {
        msg += '(status ' + emailRes.status + ').';
      }
      c.toast(msg, 'warn');
    }

    closeModalRaw();
    showSubmittedScreen();
  }

  function showSubmittedScreen() {
    var main = document.getElementById('app-main');
    if (!main) return;
    main.innerHTML = ''
      + '<div class="submitted-card">'
      +   '<div class="submitted-eyebrow">Order submitted</div>'
      +   '<div class="submitted-title">Thanks. Your selection is on its way.</div>'
      +   '<p class="submitted-body">A confirmation email is sailing toward you. The draft is saved so you can review it later from the dashboard.</p>'
      +   '<button class="btn btn-primary" data-fw-cart="reset">Start another order</button>'
      + '</div>';
    var resetBtn = main.querySelector('[data-fw-cart="reset"]');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        // Reset session-scoped state by signing out and re-showing login.
        if (window.fwApp.signOut) window.fwApp.signOut();
        else window.location.reload();
      });
    }
  }

  // ── Modal plumbing ──────────────────────────────────────────────────────
  // Lightweight modal that does not depend on admin.js's openModal.
  // Mounts a single <div id="app-modal"> overlay if missing.
  function ensureModalRoot() {
    var root = document.getElementById('app-modal');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'app-modal';
    root.className = 'app-modal-overlay';
    root.addEventListener('click', function (ev) {
      if (ev.target === root) closeModalRaw();
    });
    document.body.appendChild(root);
    return root;
  }
  function openModalRaw(html) {
    var root = ensureModalRoot();
    root.innerHTML = html;
    root.classList.add('app-modal-open');
  }
  function closeModalRaw() {
    var root = document.getElementById('app-modal');
    if (!root) return;
    root.classList.remove('app-modal-open');
    root.innerHTML = '';
  }

  // ── Product card (shared between split_story, the catalogue, and the slide product strip) ───────────
  // Renders a footwear product card matching the apparel pattern: image
  // + badges (New, Width, Exclusive), SKU, name, colour, wholesale + RRP
  // pricing, an inline size grid, and Add 1 to all / Clear actions.
  // Tap a size to increment its quantity in the cart, right-click (or
  // long-press on touch) to decrement, double-click to type a quantity.
  //
  // The product object should expose: id, sku, base_sku, name, sizes
  // (array or json-array string), width, exclusive, colour, is_new,
  // is_top_seller, aud_ws_price, aud_rrp_price, nzd_ws_price, nzd_rrp_price.

  var PRODUCT_IMG_BASE = 'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/product-images/';

  // Remembers the rep's last-selected variant per consolidated style.
  // Keyed by base_sku (or sku when base_sku is missing). The catalogue
  // calls paintBody() on a lot of interactions (accordion toggles,
  // search, newOnly, tab switches) and each call re-runs
  // renderProductCard from scratch — without this map, every repaint
  // would snap the card back to Medium.
  var activeVariantByBaseSku = {};

  function priceForCountry(product) {
    var country = (window.fwApp.state.currentUser && window.fwApp.state.currentUser.country) || 'AUD';
    if (country === 'NZD') {
      return { ws: product.nzd_ws_price, rrp: product.nzd_rrp_price, code: 'NZD' };
    }
    return { ws: product.aud_ws_price, rrp: product.aud_rrp_price, code: 'AUD' };
  }

  function fmtPrice(n) {
    if (n === null || n === undefined || n === '') return null;
    var num = Number(n);
    if (isNaN(num)) return null;
    return '$' + num.toFixed(2);
  }

  // Strict truthiness for the energy text column. Boolean true counts;
  // strings count when they normalise to an affirmative token. Anything
  // else (null, empty, "false", "no", arbitrary text) is off.
  function isEnergyOn(v) {
    if (v === true) return true;
    if (typeof v !== 'string') return false;
    var s = v.trim().toLowerCase();
    return s === 'true' || s === 't' || s === 'yes' || s === 'y' || s === '1';
  }

  // Map the products.width code (M/W/N/XW) to the badge label shown on
  // the card. W is the catalogue default and renders nothing. Unknown
  // codes pass through verbatim so we never silently hide data.
  function widthDisplayLabel(w) {
    if (w == null) return null;
    var s = String(w).trim().toUpperCase();
    if (s === '' || s === 'W') return null;
    if (s === 'M')  return 'Medium';
    if (s === 'N')  return 'Narrow';
    if (s === 'XW') return 'X Wide';
    return s;
  }

  // Pill label: same map as widthDisplayLabel but also returns "Wide"
  // for W (instead of null), because in the consolidated-card width
  // toggle every width — including the default Wide — needs a visible
  // label.
  function pillLabelFor(w) {
    if (w == null || w === '') return 'Standard';
    var s = String(w).trim().toUpperCase();
    if (s === 'M')  return 'Medium';
    if (s === 'N')  return 'Narrow';
    if (s === 'W')  return 'Wide';
    if (s === 'XW') return 'X Wide';
    return s;
  }

  // Sum pairs across every size of one product variant. Used to keep
  // each width pill's count live as the rep adjusts quantities.
  function totalPairsFor(variant) {
    var v = variant || {};
    var sizes = parseSizesField(v.sizes);
    var w = v.width || null;
    var total = 0;
    sizes.forEach(function (s) { total += getQty(v.id, s, w); });
    return total;
  }

  function renderProductCard(product) {
    var c     = window.fwApp;
    var ehtml = c.escapeHtml;
    var eattr = c.escapeAttr;

    // Width consolidation: when the catalogue groups sibling rows that
    // share a base_sku, every variant arrives with a ._variants array
    // attached and `product` is the currently active variant for the
    // card. The width toggle below the price lets the rep flip between
    // siblings without spawning a separate card per width.
    //
    // Before reading width-dependent fields off `product`, honour the
    // rep's previous pill choice for this style (kept across
    // re-renders by activeVariantByBaseSku). Swap to the remembered
    // variant if one is recorded for this base_sku.
    var variants    = (product._variants && product._variants.length > 1) ? product._variants : null;
    var multiWidth  = !!variants;
    if (multiWidth) {
      var baseKey = product.base_sku || product.sku;
      var savedId = baseKey ? activeVariantByBaseSku[baseKey] : null;
      if (savedId && savedId !== product.id) {
        for (var i = 0; i < variants.length; i++) {
          if (variants[i].id === savedId) { product = variants[i]; break; }
        }
      }
    }

    var sizes = parseSizesField(product.sizes);
    var width = product.width || null;
    var price = priceForCountry(product);
    var imgUrl = PRODUCT_IMG_BASE + 'FJ_' + (product.base_sku || product.sku) + '_01.jpg';

    // Badges + SKU sit on a single row above the name, mirroring the
    // apparel card structure. Silo (footwear product line) sits right
    // after the New badge so the line name is the first thing the eye
    // hits when scanning a row of cards.
    //
    // Width badge follows the catalogue convention: W is the default
    // (no badge), M -> Medium, N -> Narrow, XW -> X Wide. Anything
    // else renders the raw value verbatim so we don't silently hide
    // unknown codes. When the card carries a width toggle (multiWidth)
    // the width badge is suppressed — the toggle already conveys which
    // width the size grid maps to.
    var silo = (product.silo || '').trim();
    var widthLabel = widthDisplayLabel(width);
    var badges = ''
      + (product.is_new        ? '<span class="pcard-badge pcard-badge-new">New</span>'         : '')
      + (silo                  ? '<span class="pcard-badge pcard-badge-silo">' + ehtml(silo) + '</span>' : '')
      + (product.is_top_seller ? '<span class="pcard-badge pcard-badge-top">Top Seller</span>' : '')
      + (product.exclusive     ? '<span class="pcard-badge pcard-badge-excl">' + ehtml(product.exclusive) + '</span>' : '')
      + ((widthLabel && !multiWidth) ? '<span class="pcard-badge pcard-badge-width">' + ehtml(widthLabel) + '</span>' : '');

    // Energy is a footwear-only flag. The DB column is text so admins can
    // type "true"/"yes"/etc; we only light up the badge when the value is
    // affirmatively true. Empty, "false", or any other label leaves the
    // tag off.
    var energyHtml = isEnergyOn(product.energy)
      ? '<span class="pcard-energy-flag">Energy</span>'
      : '';

    var sizesHtml = sizes.map(function (s) {
      var qty = getQty(product.id, s, width);
      var label = qty > 0 ? String(qty) : '—';
      return ''
        + '<div class="size-col">'
        +   '<span class="size-label">' + ehtml(s) + '</span>'
        +   '<button class="size-btn' + (qty > 0 ? ' size-btn-active' : '') + '"'
        +          ' data-fw-cart-size="' + eattr(s) + '" type="button">' + label + '</button>'
        + '</div>';
    }).join('');

    var priceHtml = '';
    var ws  = fmtPrice(price.ws);
    var rrp = fmtPrice(price.rrp);
    if (ws) {
      priceHtml = '<div class="pcard-price">' + ws
                + (rrp ? '<span class="pcard-rrp">RRP ' + rrp + '</span>' : '')
                + '</div>';
    }

    var detailsHtml = product.colour
      ? '<div class="pcard-details">' + ehtml(product.colour) + '</div>'
      : '';

    // Build the width-pill toggle when this product has siblings. Each
    // pill is a two-line button: width label on top, per-width total
    // pairs below. Inline grid-template-columns var lets the same CSS
    // class handle 2-width and 3-width products.
    var widthToggleHtml = '';
    var widthSkuLineHtml = '';
    var addAllLabel = '+ Add 1 to all';
    if (multiWidth) {
      var pillsHtml = variants.map(function (v) {
        var isActive = v.id === product.id;
        var total    = totalPairsFor(v);
        return ''
          + '<button class="pcard-width-pill' + (isActive ? ' active' : '') + '"'
          +        ' type="button"'
          +        ' data-fw-cart-action="pick-width"'
          +        ' data-fw-variant-id="' + eattr(v.id) + '"'
          +        ' aria-pressed="' + (isActive ? 'true' : 'false') + '">'
          +   '<span class="pcard-width-pill-label">' + ehtml(pillLabelFor(v.width)) + '</span>'
          +   '<span class="pcard-width-pill-count' + (total === 0 ? ' empty' : '') + '">' + total + '</span>'
          + '</button>';
      }).join('');
      widthToggleHtml = ''
        + '<div class="pcard-width-toggle" style="--w-cols:' + variants.length + '">'
        +   pillsHtml
        + '</div>';
      var sizesAvailable = sizes.length + ' size' + (sizes.length === 1 ? '' : 's') + ' available';
      widthSkuLineHtml = '<div class="pcard-width-sku">SKU ' + ehtml(product.sku || '') + ' &middot; ' + sizesAvailable + '</div>';
      addAllLabel = '+ Add 1 to all ' + pillLabelFor(width);
    }

    return ''
      + '<div class="pcard" data-fw-product-id="' + eattr(product.id) + '"'
      +     (multiWidth ? ' data-fw-base-sku="' + eattr(product.base_sku || product.sku || '') + '"' : '')
      +   '>'
      +   '<div class="pcard-img-wrap">'
      +     '<img class="pcard-img" alt="" src="' + eattr(imgUrl) + '" data-fw-img-fallback="pcard">'
      +     energyHtml
      +   '</div>'
      +   '<div class="pcard-meta-row">'
      +     badges
      +     '<span class="pcard-sku">' + ehtml(product.sku || '') + '</span>'
      +   '</div>'
      +   '<div class="pcard-name">' + ehtml(product.name || '') + '</div>'
      +   detailsHtml
      +   priceHtml
      +   widthToggleHtml
      +   widthSkuLineHtml
      +   (sizes.length > 0
          ? '<div class="pcard-sizes">' + sizesHtml + '</div>'
            + '<div class="pcard-actions">'
            +   '<button class="pcard-add-all" data-fw-cart-action="add-all" type="button">' + ehtml(addAllLabel) + '</button>'
            +   '<button class="pcard-clear"   data-fw-cart-action="clear"   type="button">Clear</button>'
            + '</div>'
          : '<div class="pcard-no-sizes">No sizes available for this product.</div>')
      + '</div>';
  }

  function paintSizeButtonsForCard(cardEl, product) {
    var width = product.width || null;
    cardEl.querySelectorAll('.size-btn').forEach(function (btn) {
      var size = btn.dataset.fwCartSize;
      var qty  = getQty(product.id, size, width);
      btn.textContent = qty > 0 ? String(qty) : '—';
      btn.classList.toggle('size-btn-active', qty > 0);
    });
    paintWidthPillsForCard(cardEl, product);
  }

  // Update each width pill's count display in place. No-op on cards
  // that don't carry a width toggle (single-width products). Called
  // after every size mutation so the per-width totals stay live as the
  // rep adds or clears pairs without needing to re-render the card.
  function paintWidthPillsForCard(cardEl, product) {
    if (!product || !product._variants || product._variants.length <= 1) return;
    product._variants.forEach(function (v) {
      var pill = cardEl.querySelector('.pcard-width-pill[data-fw-variant-id="' + (v.id || '').replace(/"/g, '\\"') + '"]');
      if (!pill) return;
      var countEl = pill.querySelector('.pcard-width-pill-count');
      if (!countEl) return;
      var total = totalPairsFor(v);
      countEl.textContent = String(total);
      countEl.classList.toggle('empty', total === 0);
    });
  }

  function wireProductCard(cardEl, product) {
    var c = window.fwApp;

    // If the card was rendered for a different variant than the rep
    // the catalogue handed us (because the rep had previously picked
    // another width for this style), resolve to the actual variant the
    // DOM is showing. Keeps size-button click handlers writing
    // quantities under the right product_id + width.
    if (product._variants && product._variants.length > 1) {
      var domId = cardEl.dataset && cardEl.dataset.fwProductId;
      if (domId && domId !== product.id) {
        for (var pi = 0; pi < product._variants.length; pi++) {
          if (product._variants[pi].id === domId) { product = product._variants[pi]; break; }
        }
      }
    }

    var width = product.width || null;
    var sizes = parseSizesField(product.sizes);

    // Image fallback for missing FJ_{sku}_01.jpg
    var imgEl = cardEl.querySelector('img[data-fw-img-fallback="pcard"]');
    if (imgEl) {
      imgEl.addEventListener('error', function () {
        var holder = document.createElement('div');
        holder.className = 'pcard-img pcard-img-empty';
        imgEl.parentNode.replaceChild(holder, imgEl);
      }, { once: true });
    }

    if (c.state.reviewMode) return;  // read-only in customer review

    cardEl.querySelectorAll('.size-btn').forEach(function (btn) {
      var size = btn.dataset.fwCartSize;

      // Click = increment (desktop). Skip if the click was triggered by
      // a synthetic touch event so we don't double-increment.
      btn.addEventListener('click', function (ev) {
        if (ev.sourceCapabilities && ev.sourceCapabilities.firesTouchEvents) return;
        var current = getQty(product.id, size, width);
        setQuantity(product.id, size, width, current + 1);
        paintSizeButtonsForCard(cardEl, product);
      });

      // Right-click = decrement
      btn.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        var current = getQty(product.id, size, width);
        setQuantity(product.id, size, width, Math.max(0, current - 1));
        paintSizeButtonsForCard(cardEl, product);
      });

      // Double-click = open the type-a-quantity popup
      btn.addEventListener('dblclick', function (ev) {
        ev.preventDefault();
        // Undo the increment from the second click of the dblclick
        var current = getQty(product.id, size, width);
        setQuantity(product.id, size, width, Math.max(0, current - 1));
        showQtyPopup(product, size);
      });

      // Touch: tap = increment, long-press = popup, swipe-down = decrement
      var pressTimer = null;
      var pressFired = false;
      var startY = 0;
      btn.addEventListener('touchstart', function (ev) {
        pressFired = false;
        startY = ev.touches[0].clientY;
        pressTimer = setTimeout(function () {
          pressFired = true;
          showQtyPopup(product, size);
          pressTimer = null;
        }, 500);
      }, { passive: true });
      btn.addEventListener('touchmove', function (ev) {
        if (!pressTimer) return;
        if (ev.touches[0].clientY - startY > 24) {
          clearTimeout(pressTimer); pressTimer = null;
          pressFired = true;
          var current = getQty(product.id, size, width);
          setQuantity(product.id, size, width, Math.max(0, current - 1));
          paintSizeButtonsForCard(cardEl, product);
        }
      }, { passive: true });
      btn.addEventListener('touchend', function (ev) {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        if (pressFired) return;
        ev.preventDefault();
        var current = getQty(product.id, size, width);
        setQuantity(product.id, size, width, current + 1);
        paintSizeButtonsForCard(cardEl, product);
      });
      btn.addEventListener('touchcancel', function () {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      });
    });

    var addAllBtn = cardEl.querySelector('[data-fw-cart-action="add-all"]');
    if (addAllBtn) {
      addAllBtn.addEventListener('click', function () {
        sizes.forEach(function (s) {
          var current = getQty(product.id, s, width);
          setQuantity(product.id, s, width, current + 1);
        });
        paintSizeButtonsForCard(cardEl, product);
      });
    }

    var clearBtn = cardEl.querySelector('[data-fw-cart-action="clear"]');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        sizes.forEach(function (s) { setQuantity(product.id, s, width, 0); });
        paintSizeButtonsForCard(cardEl, product);
      });
    }

    // Width pills: clicking flips the active variant. We re-render the
    // card so the size grid, SKU line, Add label, and the active pill
    // state all swap together. The replaced card is re-wired so the
    // new size buttons / pills / Add / Clear all work.
    cardEl.querySelectorAll('[data-fw-cart-action="pick-width"]').forEach(function (pill) {
      pill.addEventListener('click', function (ev) {
        ev.preventDefault();
        var variantId = pill.dataset.fwVariantId;
        if (!variantId || !product._variants) return;
        var newActive = null;
        for (var i = 0; i < product._variants.length; i++) {
          if (product._variants[i].id === variantId) { newActive = product._variants[i]; break; }
        }
        if (!newActive || newActive.id === product.id) return;
        // Persist the rep's choice so later catalogue re-renders
        // (accordion toggles, search, tab switches) keep the same
        // active width instead of snapping back to Medium.
        var baseKeyClick = newActive.base_sku || newActive.sku;
        if (baseKeyClick) activeVariantByBaseSku[baseKeyClick] = newActive.id;
        var temp = document.createElement('div');
        temp.innerHTML = renderProductCard(newActive);
        var newCardEl = temp.firstElementChild;
        if (!newCardEl || !cardEl.parentNode) return;
        cardEl.parentNode.replaceChild(newCardEl, cardEl);
        wireProductCard(newCardEl, newActive);
      });
    });
  }

  // Quantity popup: lightweight modal with a number input, used for
  // long-press / double-click on a size button.
  function showQtyPopup(product, size) {
    var c = window.fwApp;
    var width = product.width || null;
    var current = getQty(product.id, size, width);
    openModalRaw(''
      + '<div class="modal-card qty-popup">'
      +   '<div class="picker-head">'
      +     '<div class="picker-eyebrow">' + c.escapeHtml(product.sku || '') + (width ? ' &middot; Width ' + c.escapeHtml(width) : '') + '</div>'
      +     '<div class="picker-title">' + c.escapeHtml(product.name || '') + ' &mdash; size ' + c.escapeHtml(size) + '</div>'
      +   '</div>'
      +   '<input type="number" class="qty-popup-input" min="0" step="1" inputmode="numeric" value="' + current + '" autofocus>'
      +   '<div class="picker-actions">'
      +     '<button class="btn btn-outline" data-fw-cart="picker-cancel">Cancel</button>'
      +     '<button class="btn btn-primary" data-fw-cart="qty-popup-save">Save</button>'
      +   '</div>'
      + '</div>');

    var modal = document.getElementById('app-modal');
    if (!modal) return;
    var input = modal.querySelector('.qty-popup-input');
    if (input) { input.focus(); input.select(); }

    function commit() {
      var qty = parseInt(input.value, 10) || 0;
      setQuantity(product.id, size, width, Math.max(0, qty));
      var card = document.querySelector('.pcard[data-fw-product-id="' + cssEscapeId(product.id) + '"]');
      if (card) paintSizeButtonsForCard(card, product);
      closeModalRaw();
    }
    if (input) input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { closeModalRaw(); }
    });
    modal.querySelector('[data-fw-cart="qty-popup-save"]').addEventListener('click', commit);
    modal.querySelector('[data-fw-cart="picker-cancel"]').addEventListener('click', closeModalRaw);
  }

  function cssEscapeId(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  // ── Public API ──────────────────────────────────────────────────────────
  window.fwApp.cart = {
    items:                  items,
    count:                  count,
    add:                    add,
    setQuantity:            setQuantity,
    remove:                 remove,
    clear:                  clear,
    handleClear:            handleClear,
    handleSave:             handleSave,
    openPicker:             openPicker,
    openReview:             openReview,
    submit:                 submit,
    paintSummary:           paintSummary,
    renderProductCard:      renderProductCard,
    wireProductCard:        wireProductCard,
    paintSizeButtonsForCard: paintSizeButtonsForCard,
  };
})();
