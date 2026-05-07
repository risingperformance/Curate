// ─── Summary view ──────────────────────────────────────────────────────────
//
// The customer review's terminal screen. Lists every cart line with
// product name, sku, size, width, and quantity, plus a Save button.
//
// In review mode, Save calls touch_footwear_draft_by_share_token which
// stamps updated_at on the draft so the rep sees "customer reviewed at"
// in their dashboard.
//
// In rep mode the same view is reachable but the Save button just does
// the standard persistDraft instead, and the screen is mostly used as
// a confirmation step before clicking back into the deck.
//
// Section 5.2 of the AW27 footwear brief.

(function () {
  'use strict';

  window.fwApp       = window.fwApp || {};
  window.fwApp.views = window.fwApp.views || {};

  async function renderSummary() {
    var c     = window.fwApp;
    var panel = document.getElementById('view-summary');

    var items = (c.state.cartItems || []);

    panel.innerHTML = ''
      + '<div class="summary-loading">Loading your selection...</div>';

    // Resolve product details. In review mode we have them preloaded
    // from the RPC; in rep mode we query.
    var byId;
    if (c.state.preloadedProducts) {
      byId = c.state.preloadedProducts;
    } else if (items.length > 0) {
      var ids = [];
      items.forEach(function (it) { if (ids.indexOf(it.product_id) < 0) ids.push(it.product_id); });
      // product_name is the actual column; alias to name for the JS view code.
      var prodRes = await c.supa.from('products')
                                .select('id, sku, name:product_name, width')
                                .in('id', ids);
      if (prodRes.error) {
        panel.innerHTML = '<div class="placeholder-card"><div class="placeholder-card-body">Could not load products: '
                        + c.escapeHtml(prodRes.error.message || '') + '</div></div>';
        return;
      }
      byId = {};
      (prodRes.data || []).forEach(function (p) { byId[p.id] = p; });
    } else {
      byId = {};
    }

    paint(byId);
  }

  function paint(byId) {
    var c     = window.fwApp;
    var panel = document.getElementById('view-summary');
    var items = (c.state.cartItems || []);

    var totalPairs = items.reduce(function (s, it) { return s + (Number(it.quantity) || 0); }, 0);

    var rowsHtml;
    if (items.length === 0) {
      rowsHtml = '<div class="summary-empty">No products were added to this order.</div>';
    } else {
      rowsHtml = ''
        + '<table class="summary-table">'
        +   '<thead>'
        +     '<tr>'
        +       '<th>Product</th>'
        +       '<th>Size</th>'
        +       '<th>Width</th>'
        +       '<th class="summary-qty-col">Qty</th>'
        +     '</tr>'
        +   '</thead>'
        +   '<tbody>'
        +     items.map(function (it) {
              var p     = byId[it.product_id];
              var name  = p ? (p.name || p.sku || it.product_id) : it.product_id;
              var sku   = p ? p.sku : '';
              return '<tr>'
                +   '<td><b>' + c.escapeHtml(name) + '</b><br>'
                +     '<span class="summary-sku">' + c.escapeHtml(sku) + '</span></td>'
                +   '<td>' + c.escapeHtml(it.size  || '-') + '</td>'
                +   '<td>' + c.escapeHtml(it.width || '-') + '</td>'
                +   '<td class="summary-qty-col">' + (Number(it.quantity) || 0) + '</td>'
                + '</tr>';
            }).join('')
        +   '</tbody>'
        + '</table>';
    }

    var isReview = !!c.state.reviewMode;
    var primaryLabel = isReview ? 'Save and finish' : 'Save';
    var headlineEyebrow = isReview ? 'Customer review' : 'Order summary';
    var headlineTitle   = isReview ? 'Looks good?' : 'Your selection';
    var headlineBody    = isReview
      ? 'These are the products your sales rep selected for AW27. Hit save when you have finished reviewing; your rep will be notified.'
      : 'A snapshot of every product currently in this draft. Save to keep this order in place; head back to the deck if you want to revise.';

    panel.innerHTML = ''
      + '<div class="summary">'
      +   '<div class="summary-header">'
      +     '<div class="summary-eyebrow">' + c.escapeHtml(headlineEyebrow) + '</div>'
      +     '<div class="summary-title">'  + c.escapeHtml(headlineTitle)   + '</div>'
      +     '<p class="summary-body">'      + c.escapeHtml(headlineBody)    + '</p>'
      +   '</div>'
      +   '<div class="summary-totals">'
      +     '<span><b>' + items.length + '</b> product' + (items.length === 1 ? '' : 's') + '</span>'
      +     '<span><b>' + totalPairs    + '</b> pair'    + (totalPairs    === 1 ? '' : 's') + '</span>'
      +   '</div>'
      +   '<div class="summary-rows">' + rowsHtml + '</div>'
      +   '<div class="summary-actions">'
      +     (isReview
            ? ''
            : '<button class="btn btn-outline" id="summary-back-btn">&larr; Back to deck</button>')
      +     '<button class="btn btn-primary" id="summary-save-btn">' + primaryLabel + '</button>'
      +   '</div>'
      + '</div>';

    var saveBtn = document.getElementById('summary-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', isReview ? customerSave : repSave);

    var backBtn = document.getElementById('summary-back-btn');
    if (backBtn) backBtn.addEventListener('click', function () { c.setView('deck'); });
  }

  async function customerSave() {
    var c   = window.fwApp;
    var btn = document.getElementById('summary-save-btn');
    btn.disabled    = true;
    btn.textContent = 'Saving...';

    var rpc = await c.supa.rpc('touch_footwear_draft_by_share_token', { p_token: c.state.activeShareToken });
    if (rpc.error || rpc.data !== true) {
      var msg = rpc.error
        ? rpc.error.message
        : 'The link is no longer valid.';
      c.toast('Could not save: ' + msg, 'error');
      btn.disabled    = false;
      btn.textContent = 'Save and finish';
      return;
    }

    showSubmittedScreen({
      eyebrow: 'Saved',
      title:   'Thanks for reviewing.',
      body:    'Your sales rep will be notified that you have approved this order.',
    });
  }

  async function repSave() {
    var c   = window.fwApp;
    var btn = document.getElementById('summary-save-btn');
    btn.disabled    = true;
    btn.textContent = 'Saving...';
    var saveRes = await c.persistDraft({
      cart_items:         c.state.cartItems,
      slide_order:        c.state.slideOrder,
      excluded_slide_ids: c.state.excludedSlideIds,
    });
    if (saveRes.error) {
      c.toast('Could not save: ' + (saveRes.error.message || 'unknown error'), 'error');
      btn.disabled    = false;
      btn.textContent = 'Save';
      return;
    }
    c.toast('Saved.', 'success');
    btn.disabled    = false;
    btn.textContent = 'Save';
  }

  function showSubmittedScreen(opts) {
    opts = opts || {};
    var main = document.getElementById('app-main');
    if (!main) return;
    main.innerHTML = ''
      + '<div class="submitted-card">'
      +   '<div class="submitted-eyebrow">' + window.fwApp.escapeHtml(opts.eyebrow || 'Saved') + '</div>'
      +   '<div class="submitted-title">'   + window.fwApp.escapeHtml(opts.title   || 'Thanks.') + '</div>'
      +   '<p class="submitted-body">'      + window.fwApp.escapeHtml(opts.body    || '') + '</p>'
      + '</div>';
  }

  window.fwApp.views.summary = renderSummary;
})();
