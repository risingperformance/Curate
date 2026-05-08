// ─── Cart ──────────────────────────────────────────────────────────────────
//
// Cart state lives on window.fwApp.state.cartItems as the brief specifies:
// an array of { product_id, size, width, quantity }. All template modules
// add to / remove from / inspect the cart through this module's API.
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
    } else {
      arr.push({ product_id: productId, size: size || null, width: width || null, quantity: qty });
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
    if (qty <= 0) arr.splice(i, 1);
    else arr[i].quantity = qty;
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
  async function openReview() {
    var c = window.fwApp;
    if (count() === 0) {
      c.toast('Your cart is empty. Add at least one product before submitting.', 'error');
      return;
    }

    // Look up product details for every line
    var ids = [];
    items().forEach(function (it) { if (ids.indexOf(it.product_id) < 0) ids.push(it.product_id); });
    // product_name is the actual column; alias to name for the JS view code.
    var prodRes = await c.supa.from('products').select('id, sku, name:product_name, width').in('id', ids);
    if (prodRes.error) {
      c.toast('Could not load product details: ' + prodRes.error.message, 'error');
      return;
    }
    var byId = {};
    (prodRes.data || []).forEach(function (p) { byId[p.id] = p; });

    var rowsHtml = items().map(function (it, idx) {
      var p = byId[it.product_id];
      var name = p ? (p.name || p.sku || it.product_id) : it.product_id;
      var sku  = p ? p.sku : '';
      var widthLabel = it.width ? ('Width ' + it.width) : '';
      return ''
        + '<tr>'
        +   '<td class="rev-name"><b>' + c.escapeHtml(name) + '</b><br><span class="rev-sku">' + c.escapeHtml(sku) + '</span></td>'
        +   '<td>' + c.escapeHtml(it.size || '-') + '</td>'
        +   '<td>' + c.escapeHtml(widthLabel || '-') + '</td>'
        +   '<td>'
        +     '<input type="number" class="rev-qty" min="0" step="1" inputmode="numeric" value="' + (Number(it.quantity) || 0) + '"'
        +     ' data-fw-cart="rev-qty" data-idx="' + idx + '">'
        +   '</td>'
        +   '<td>'
        +     '<button class="btn btn-sm" data-fw-cart="rev-remove" data-idx="' + idx + '">Remove</button>'
        +   '</td>'
        + '</tr>';
    }).join('');

    openModalRaw(''
      + '<div class="modal-card review-modal">'
      +   '<div class="picker-head">'
      +     '<div class="picker-eyebrow">Review your order</div>'
      +     '<div class="picker-title">AW27 Footwear</div>'
      +   '</div>'
      +   '<div class="review-table-wrap">'
      +     '<table class="review-table">'
      +       '<thead><tr>'
      +         '<th>Product</th><th>Size</th><th>Width</th><th>Qty</th><th></th>'
      +       '</tr></thead>'
      +       '<tbody>' + rowsHtml + '</tbody>'
      +     '</table>'
      +   '</div>'
      +   '<div class="review-totals">'
      +     '<span>Total products: <b>' + lineCount() + '</b></span>'
      +     '<span>Total pairs: <b>' + count() + '</b></span>'
      +   '</div>'
      +   '<div class="picker-actions">'
      +     '<button class="btn btn-outline" data-fw-cart="picker-cancel">Keep editing</button>'
      +     '<button class="btn btn-primary" data-fw-cart="rev-submit">Submit order</button>'
      +   '</div>'
      + '</div>');

    var modal = document.getElementById('app-modal');
    if (!modal) return;

    modal.querySelectorAll('[data-fw-cart="rev-qty"]').forEach(function (input) {
      input.addEventListener('change', function () {
        var idx = parseInt(input.dataset.idx, 10);
        var qty = parseInt(input.value, 10) || 0;
        var line = items()[idx];
        if (!line) return;
        setQuantity(line.product_id, line.size, line.width, qty);
        if (qty <= 0) {
          openReview();   // re-render after removal
        }
      });
    });
    modal.querySelectorAll('[data-fw-cart="rev-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx, 10);
        var line = items()[idx];
        if (!line) return;
        remove(line.product_id, line.size, line.width);
        openReview();
      });
    });
    modal.querySelector('[data-fw-cart="picker-cancel"]').addEventListener('click', closeModalRaw);
    modal.querySelector('[data-fw-cart="rev-submit"]').addEventListener('click', submit);
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

    // Get the auth token to attach as Authorization. Edge functions
    // protected with verify_jwt require this.
    var session = await c.supa.auth.getSession();
    var token   = session && session.data && session.data.session && session.data.session.access_token;

    var emailRes;
    try {
      var resp = await fetch(c.EMAIL_EDGE_FN, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': token ? ('Bearer ' + token) : '',
        },
        body: JSON.stringify({
          draft_id:     c.state.activeDraftId,
          share_token:  c.state.activeShareToken,
          rep_email:    (c.state.currentUser || {}).email,
          rep_name:     (c.state.currentUser || {}).name,
          cart_items:   c.state.cartItems,
        }),
      });
      var bodyText = '';
      try { bodyText = await resp.text(); } catch (e) { /* ignore */ }
      emailRes = { ok: resp.ok, status: resp.status, body: bodyText };
    } catch (e) {
      emailRes = { ok: false, status: 0, body: (e && e.message) || 'Network error' };
    }

    if (!emailRes.ok) {
      var msg = 'Order email did not send. ';
      if (emailRes.status === 404) {
        msg += 'The send-footwear-order-email edge function is not deployed yet at ' + c.EMAIL_EDGE_FN
            +  '. Your order is saved as a draft. Engineering needs to deploy the function before submission can complete.';
      } else if (emailRes.status === 401 || emailRes.status === 403) {
        msg += 'Auth was rejected by the edge function (status ' + emailRes.status + '). Check the verify_jwt setting on the function.';
      } else {
        msg += '(status ' + emailRes.status + ') ' + emailRes.body;
      }
      c.toast(msg, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Submit order'; }
      return;
    }

    // Mark the draft as submitted now that the email landed.
    var statusRes = await c.persistDraft({ status: 'submitted' });
    if (statusRes.error) {
      // Email went out but status update failed; surface the inconsistency.
      c.toast('Order email sent, but could not update draft status: ' + (statusRes.error.message || ''), 'error');
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

  function renderProductCard(product) {
    var c     = window.fwApp;
    var ehtml = c.escapeHtml;
    var eattr = c.escapeAttr;

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
    // unknown codes.
    var silo = (product.silo || '').trim();
    var widthLabel = widthDisplayLabel(width);
    var badges = ''
      + (product.is_new        ? '<span class="pcard-badge pcard-badge-new">New</span>'         : '')
      + (silo                  ? '<span class="pcard-badge pcard-badge-silo">' + ehtml(silo) + '</span>' : '')
      + (product.is_top_seller ? '<span class="pcard-badge pcard-badge-top">Top Seller</span>' : '')
      + (product.exclusive     ? '<span class="pcard-badge pcard-badge-excl">' + ehtml(product.exclusive) + '</span>' : '')
      + (widthLabel            ? '<span class="pcard-badge pcard-badge-width">' + ehtml(widthLabel) + '</span>' : '');

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

    return ''
      + '<div class="pcard" data-fw-product-id="' + eattr(product.id) + '">'
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
      +   (sizes.length > 0
          ? '<div class="pcard-sizes">' + sizesHtml + '</div>'
            + '<div class="pcard-actions">'
            +   '<button class="pcard-add-all" data-fw-cart-action="add-all" type="button">+ Add 1 to all</button>'
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
  }

  function wireProductCard(cardEl, product) {
    var c = window.fwApp;
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
