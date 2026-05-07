// ─── Slide product strip ──────────────────────────────────────────────────
//
// Phase 2 of the slide-product-strip refactor. The drawer is a single
// fixed-position panel that sits above the cart-summary footer and slides
// up when opened. It renders one full product card per attached product
// on the active slide using cart.renderProductCard, so reps can browse
// images, badges, sizes, and Add CTAs without leaving the slide.
//
// Each card in the strip is the SAME shared product card the catalogue
// uses (cart.renderProductCard + cart.wireProductCard); the strip just
// provides the horizontal layout and the open/close drawer chrome.
// Templates remain ignorant of the strip; the drawer is owned by the
// deck framework via this module.
//
// In review mode, the rail gets the `pcard-readonly` modifier class,
// which hides the size buttons and Add/Clear actions via CSS. The cart
// is read-only for customers in that mode.
//
// Public API on window.fwApp.slideStrip:
//   open(products)  - render and show the drawer with the given product list
//   close()         - hide the drawer
//   toggle()        - open if closed, close if open. Reads the active
//                     slide's products from window.fwApp.state.currentSlideProducts.
//   isOpen()        - boolean
//   paint(products) - replace the drawer's contents without changing
//                     open/closed state. Useful when the active slide
//                     changes while the drawer is open.

(function () {
  'use strict';

  window.fwApp = window.fwApp || {};

  var DRAWER_ID = 'fw-strip-drawer';

  var drawerEl    = null;        // lazily created on first open
  var railEl      = null;        // the horizontal rail inside the drawer
  var openState   = false;
  var listeners   = { doc: false };

  // Lazily build the drawer DOM. We only attach it to the body the first
  // time it is opened so the page footprint stays empty when the flag is
  // off or the user never reaches the deck.
  function ensureDrawer() {
    if (drawerEl) return drawerEl;
    drawerEl = document.createElement('div');
    drawerEl.id = DRAWER_ID;
    drawerEl.className = 'fw-strip-drawer';
    drawerEl.setAttribute('role', 'region');
    drawerEl.setAttribute('aria-label', 'Slide products');
    drawerEl.setAttribute('aria-hidden', 'true');
    drawerEl.hidden = true;

    drawerEl.innerHTML = '<div class="fw-strip-rail" role="list"></div>';
    railEl = drawerEl.querySelector('.fw-strip-rail');

    document.body.appendChild(drawerEl);

    if (!listeners.doc) {
      document.addEventListener('click',   onDocClick, true);
      document.addEventListener('keydown', onKeyDown);
      listeners.doc = true;
    }

    attachDragScroll(railEl);

    return drawerEl;
  }

  // ── Drag-to-scroll on the rail ──────────────────────────────────────────
  // Browsers natively scroll an overflow-x: auto element with touch but
  // not with a mouse drag. This handler implements click-and-drag scroll
  // for mouse / pen, and is also a backstop for touch in case native
  // scroll is suppressed by an outer container.
  //
  // A small movement threshold (~6px) prevents accidental hijacks when
  // the user just taps a size button or a card.
  function attachDragScroll(rail) {
    var startX = 0;
    var startScroll = 0;
    var active = false;
    var dragging = false;

    rail.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;       // ignore right/middle clicks
      active = true;
      dragging = false;
      startX = ev.clientX;
      startScroll = rail.scrollLeft;
    });

    rail.addEventListener('pointermove', function (ev) {
      if (!active) return;
      var dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < 6) return;     // below threshold, still a tap
        dragging = true;
        rail.classList.add('is-dragging');
        try { rail.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      }
      rail.scrollLeft = startScroll - dx;
      ev.preventDefault();
    });

    function endDrag(ev) {
      if (!active) return;
      active = false;
      if (dragging) {
        rail.classList.remove('is-dragging');
        try {
          if (rail.hasPointerCapture && rail.hasPointerCapture(ev.pointerId)) {
            rail.releasePointerCapture(ev.pointerId);
          }
        } catch (e) { /* ignore */ }
      }
      dragging = false;
    }
    rail.addEventListener('pointerup',     endDrag);
    rail.addEventListener('pointercancel', endDrag);

    // Suppress the click that would otherwise fire on a child after a
    // drag finishes (e.g. clicking a size button mid-drag should not
    // increment its quantity).
    rail.addEventListener('click', function (ev) {
      if (rail.classList.contains('was-dragging')) {
        ev.stopPropagation();
        ev.preventDefault();
        rail.classList.remove('was-dragging');
      }
    }, true);

    // When a drag ends, briefly mark the rail so the next click is
    // suppressed by the capture-phase listener above.
    rail.addEventListener('pointerup', function () {
      if (dragging) {
        rail.classList.add('was-dragging');
        setTimeout(function () { rail.classList.remove('was-dragging'); }, 50);
      }
    });
  }

  // ── Public: open ────────────────────────────────────────────────────────
  function open(products) {
    var d = ensureDrawer();
    paint(products);
    d.hidden = false;
    // Force a layout flush so the transition plays from the off-screen
    // starting position (transform: translateY(100%) in CSS).
    void d.offsetWidth;
    d.classList.add('is-open');
    d.setAttribute('aria-hidden', 'false');
    openState = true;
    document.body.classList.add('fw-strip-open');
    syncTriggerPressed(true);
  }

  // ── Public: close ───────────────────────────────────────────────────────
  function close() {
    if (!openState) {
      // Make sure the body class is also clean even if we were never open.
      document.body.classList.remove('fw-strip-open');
      syncTriggerPressed(false);
      return;
    }
    if (drawerEl) {
      drawerEl.classList.remove('is-open');
      drawerEl.setAttribute('aria-hidden', 'true');
      // Hide after the slide-down animation. The class is the source of
      // truth for visibility while the transition runs; `hidden` finalises
      // the state for assistive tech and tab order once it completes.
      setTimeout(function () {
        if (drawerEl && !openState) drawerEl.hidden = true;
      }, 280);
    }
    openState = false;
    document.body.classList.remove('fw-strip-open');
    syncTriggerPressed(false);
  }

  // ── Public: toggle ──────────────────────────────────────────────────────
  function toggle() {
    if (openState) {
      close();
      return;
    }
    var c = window.fwApp;
    var products = (c.state && c.state.currentSlideProducts) || [];
    open(products);
  }

  // ── Public: paint ───────────────────────────────────────────────────────
  // Render the drawer contents. Safe to call before opening; safe to call
  // while open to refresh the contents in place.
  function paint(products) {
    ensureDrawer();
    var c        = window.fwApp;
    var cart     = c && c.cart;
    var isReview = !!(c && c.state && c.state.reviewMode);

    var list = Array.isArray(products) ? products : [];

    // Stamp the readonly modifier on the rail in review mode so the CSS
    // rule .pcard-readonly .pcard-sizes/.pcard-actions hides them across
    // every card in the rail. Stamp it back off when leaving review mode.
    if (railEl) {
      railEl.classList.toggle('pcard-readonly', isReview);
    }

    if (!list.length) {
      railEl.innerHTML = '<div class="fw-strip-empty">No products attached to this slide.</div>';
      return;
    }
    if (!cart || typeof cart.renderProductCard !== 'function') {
      railEl.innerHTML = '<div class="fw-strip-empty">Could not render the strip (cart module missing).</div>';
      return;
    }

    // Render the same .pcard markup the catalogue uses, then wire each
    // card with cart.wireProductCard so size buttons and Add CTAs work
    // exactly as they do in the catalogue.
    railEl.innerHTML = list.map(function (p) {
      return cart.renderProductCard(p);
    }).join('');

    if (typeof cart.wireProductCard === 'function') {
      list.forEach(function (p) {
        if (!p || !p.id) return;
        var card = railEl.querySelector('.pcard[data-fw-product-id="' + cssEscape(p.id) + '"]');
        if (card) {
          try { cart.wireProductCard(card, p); } catch (e) {
            console.warn('slide-strip: wireProductCard threw:', e);
          }
        }
      });
    }
  }

  // ── Public: isOpen ──────────────────────────────────────────────────────
  function isOpen() { return openState; }

  // ── Internals ───────────────────────────────────────────────────────────

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  // Keep the trigger pill's aria state in sync with the drawer, regardless
  // of how it opened or closed (click, escape, outside-click, slide change,
  // view change). aria-pressed conveys toggle state; aria-expanded conveys
  // disclosure state to AT that read disclosure widgets specifically.
  function syncTriggerPressed(open) {
    document.querySelectorAll('[data-fw-cart="strip-toggle"]').forEach(function (btn) {
      btn.setAttribute('aria-pressed',  open ? 'true' : 'false');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Outside-click closes. Capture-phase so we see clicks before they hit
  // the drawer's own listeners. Ignore clicks on the drawer itself and
  // on the trigger pill (the trigger handles its own toggle).
  function onDocClick(ev) {
    if (!openState) return;
    var t = ev.target;
    if (drawerEl && drawerEl.contains(t)) return;
    if (t && t.closest && t.closest('[data-fw-cart="strip-toggle"]')) return;
    close();
  }

  // Escape closes the drawer. Don't fight typing inside an input.
  // Return focus to the trigger so keyboard users don't lose their place
  // when the focused element (e.g. a size button inside the drawer) gets
  // hidden by the close.
  function onKeyDown(ev) {
    if (!openState) return;
    if (ev.key !== 'Escape') return;
    var tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    ev.preventDefault();
    close();
    var trigger = document.querySelector('[data-fw-cart="strip-toggle"]');
    if (trigger) trigger.focus();
  }

  window.fwApp.slideStrip = {
    open:    open,
    close:   close,
    toggle:  toggle,
    paint:   paint,
    isOpen:  isOpen,
  };
})();
