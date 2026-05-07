// ─── Deck view ────────────────────────────────────────────────────────────
//
// Shows one slide at a time. Navigation: prev/next buttons, keyboard
// arrows, and touch swipe on mobile. Each slide is rendered by
// slide-renderer.js which dispatches to the right template module.
//
// The cart summary is mounted once and persists across slide
// transitions; the cart module repaints it whenever lines change.
//
// Section 4.4 of the AW27 footwear brief.

(function () {
  'use strict';

  window.fwApp       = window.fwApp || {};
  window.fwApp.views = window.fwApp.views || {};

  // View-local cache of full slide rows for the deck. Keyed by id.
  var slideMeta = {};
  // View-local cache of slide-level product attachments for the strip
  // (Phase 2). Map of slide_id -> array of full product rows in display
  // order. Populated once per renderDeck() and consumed by
  // mountCurrentSlide() to write state.currentSlideProducts.
  var slideProductsBySlideId = {};

  // Per-template product_strip_behavior lookup (Phase 4). 'auto' or
  // 'hidden'. Populated in renderDeck() and consumed by mountCurrentSlide()
  // to write state.currentSlideStripBehavior. In review mode the flag
  // arrives baked into each slide entry from the RPC payload, so this
  // map stays empty and we read off the slide instead.
  var stripBehaviorByTemplate = {};

  // The hydrated view and the review RPC return raw DB column names
  // (product_name, available_sizes). cart.renderProductCard expects the
  // apparel-style aliases (name, sizes) that the existing product_grid
  // template gets via Supabase column aliasing in its .select() call.
  // The strip uses two different fetch paths neither of which can alias,
  // so we add the two aliases on the client side.
  function aliasProductFields(p) {
    if (!p) return p;
    if (p.product_name && !p.name)        p.name  = p.product_name;
    if (p.available_sizes && !p.sizes)    p.sizes = p.available_sizes;
    return p;
  }
  // Lifecycle: cleanup function returned by the currently mounted template
  var currentCleanup = null;
  // Touch swipe state
  var touchStartX = null;
  var touchStartY = null;
  // Pointer Events state (mouse + pen + touch via the unified API). We
  // track non-touch pointers here; touch keeps using the touchstart/end
  // path above so we don't double-trigger on touchscreens.
  var pointerStartX = null;
  var pointerStartY = null;

  async function renderDeck() {
    var c     = window.fwApp;
    var supa  = c.supa;
    var panel = document.getElementById('view-deck');

    var order = (c.state.slideOrder || []).slice();
    if (order.length === 0) {
      panel.innerHTML = ''
        + '<div class="placeholder-card">'
        +   '<div class="placeholder-card-title">No slides to show</div>'
        +   '<p class="placeholder-card-body">The deck is empty. Restore at least one slide, or jump straight into the full catalogue to build the order.</p>'
        +   '<div class="placeholder-card-actions" style="margin-top:18px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">'
        +     '<button class="btn btn-outline" id="d-back">Back to reorder</button>'
        +     (c.state.reviewMode ? '' : '<button class="btn btn-primary" id="d-cat">Browse catalogue</button>')
        +   '</div>'
        + '</div>';
      var backBtn = document.getElementById('d-back');
      if (backBtn) backBtn.addEventListener('click', function () { c.setView('reorder'); });
      var catBtn = document.getElementById('d-cat');
      if (catBtn) catBtn.addEventListener('click', function () { c.setView('catalogue'); });
      return;
    }

    panel.innerHTML = '<div class="placeholder-card"><div class="placeholder-card-body">Loading deck...</div></div>';

    // In review mode the customer is anonymous, so direct SELECTs against
    // footwear_slides would fail RLS. The bootstrapReviewMode() flow has
    // already cached every needed slide via the get_footwear_review_payload
    // RPC; use that.
    if (c.state.reviewMode && c.state.preloadedSlides) {
      slideMeta = c.state.preloadedSlides;
    } else {
      var metaRes = await supa.from('footwear_slides')
                              .select('id, slide_key, title, template_key, content')
                              .in('id', order);
      if (metaRes.error) {
        panel.innerHTML = '<div class="placeholder-card"><div class="placeholder-card-body">Could not load deck: ' + c.escapeHtml(metaRes.error.message || '') + '</div></div>';
        return;
      }
      slideMeta = {};
      (metaRes.data || []).forEach(function (s) { slideMeta[s.id] = s; });
    }

    // Per-template strip behavior lookup (Phase 4). Rep mode: fetch the
    // table once per renderDeck. Review mode: behavior arrives on each
    // slide entry from the RPC, so leave the map empty.
    stripBehaviorByTemplate = {};
    if (!c.state.reviewMode) {
      var tmplRes = await supa.from('slide_templates')
                              .select('template_key, product_strip_behavior');
      if (!tmplRes.error && tmplRes.data) {
        tmplRes.data.forEach(function (t) {
          stripBehaviorByTemplate[t.template_key] = t.product_strip_behavior || 'auto';
        });
      }
    }

    // Slide-level product attachments for the deck strip (Phase 2). Only
    // fetched when the feature flag is on; otherwise leave the cache empty
    // so the rest of the view behaves exactly as before.
    slideProductsBySlideId = {};
    if (c.state.flags && c.state.flags.slideStrip) {
      if (c.state.reviewMode && c.state.preloadedSlideProducts) {
        // Anon customer: build from the RPC payload caches; no extra fetch.
        Object.keys(c.state.preloadedSlideProducts).forEach(function (sid) {
          var rows = (c.state.preloadedSlideProducts[sid] || [])
            .slice()
            .sort(function (a, b) { return a.display_order - b.display_order; })
            .map(function (sp) {
              var product = c.state.preloadedProducts && c.state.preloadedProducts[sp.product_id];
              if (!product) return null;
              return aliasProductFields(Object.assign({}, product, { _display_order: sp.display_order }));
            })
            .filter(Boolean);
          if (rows.length) slideProductsBySlideId[sid] = rows;
        });
      } else {
        // Authenticated rep: one round trip to the hydrated view, scoped to
        // the slides actually in this deck.
        var hpRes = await supa.from('footwear_slide_products_hydrated')
                              .select('slide_id, display_order, product')
                              .in('slide_id', order);
        if (hpRes.error) {
          // Non-fatal: log it and carry on with an empty strip cache.
          console.warn('deck: could not load slide product strip:', hpRes.error.message || hpRes.error);
        } else {
          (hpRes.data || []).forEach(function (row) {
            if (!slideProductsBySlideId[row.slide_id]) slideProductsBySlideId[row.slide_id] = [];
            var p = row.product || {};
            p._display_order = row.display_order;
            slideProductsBySlideId[row.slide_id].push(aliasProductFields(p));
          });
          // Sort each slide's product list by display_order.
          Object.keys(slideProductsBySlideId).forEach(function (sid) {
            slideProductsBySlideId[sid].sort(function (a, b) {
              return (a._display_order || 0) - (b._display_order || 0);
            });
          });
        }
      }
    }

    // Initialise current slide index if not set or out of range
    if (typeof c.state.currentSlideIndex !== 'number' ||
        c.state.currentSlideIndex < 0 ||
        c.state.currentSlideIndex >= order.length) {
      c.state.currentSlideIndex = 0;
    }

    // Build the deck shell. The slide is mounted into #deck-slide; a
    // pill of clickable position dots floats at the bottom of the slide
    // for jump-style navigation. The cart summary lives in the global
    // #fw-app-footer below the views, repainted by cart.js on every
    // cart change. Keyboard arrows and touch swipes still work for
    // sequential navigation; the dot pill is the visible affordance.
    panel.innerHTML = ''
      + '<div class="deck-shell" id="deck-shell">'
      +   '<div class="deck-stage" id="deck-stage">'
      +     '<div id="deck-slide" class="deck-slide"></div>'
      +     '<div class="deck-position" id="deck-position"></div>'
      +     '<div class="deck-dots" id="deck-dots" role="tablist"></div>'
      +   '</div>'
      // Edge arrows are siblings of the stage so they pin to the shell
      // (full viewport width) rather than the letterboxed 2:1 stage.
      +   '<button class="deck-arrow deck-arrow-prev" id="deck-arrow-prev" type="button" aria-label="Previous slide" hidden>'
      +     '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">'
      +       '<polyline points="15 5 8 12 15 19" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
      +     '</svg>'
      +   '</button>'
      +   '<button class="deck-arrow deck-arrow-next" id="deck-arrow-next" type="button" aria-label="Next slide" hidden>'
      +     '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">'
      +       '<polyline points="9 5 16 12 9 19" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
      +     '</svg>'
      +   '</button>'
      + '</div>';

    // Wire the edge arrows. They call the same goPrev / goNext used by
    // keyboard arrows and the dot pill, so animations and behaviour stay
    // consistent. Visibility is updated on every slide mount below.
    var arrowPrev = document.getElementById('deck-arrow-prev');
    var arrowNext = document.getElementById('deck-arrow-next');
    if (arrowPrev) arrowPrev.addEventListener('click', goPrev);
    if (arrowNext) arrowNext.addEventListener('click', goNext);

    // Keyboard navigation. Listen on document so it works regardless of focus.
    // We remove the listener in cleanup when the deck unmounts.
    document.addEventListener('keydown', onKeyDown);

    // Touch swipe on the stage (legacy handlers, kept for safety)
    var stage = document.getElementById('deck-stage');
    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchend',   onTouchEnd,   { passive: true });

    // Pointer Events: handles mouse drag, pen, and touch in one API. We
    // exclude pointerType === 'touch' inside the handlers so the legacy
    // touch path above stays the source of truth on touchscreens.
    stage.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerup',     onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);

    // Suppress the browser's native image-drag (and text selection drag)
    // inside the stage so a swipe across an <img> does not trigger
    // drag-and-drop and steal the pointer events.
    stage.addEventListener('dragstart', preventStageDrag);

    if (c.cart && typeof c.cart.paintSummary === 'function') c.cart.paintSummary();

    mountCurrentSlide();
  }

  // direction: 'next' | 'prev' | undefined. When provided, the new
  // slide is animated in via a CSS keyframe so the user sees a clear
  // transition instead of an instant swap.
  function mountCurrentSlide(direction) {
    var c = window.fwApp;
    var order = c.state.slideOrder || [];
    var idx = c.state.currentSlideIndex;
    var sid = order[idx];
    var slide = slideMeta[sid];

    // Publish the current slide's product attachments so the footer trigger
    // (Phase 2.2) can decide whether to render the pill. The cache is empty
    // when the feature flag is off, so this is harmless either way.
    c.state.currentSlideProducts = slideProductsBySlideId[sid] || [];

    // Publish the current template's strip behavior (Phase 4). In review
    // mode it travels on the slide row; in rep mode we look it up via the
    // template_key. Default to 'auto' when neither path produces a value.
    var behavior = 'auto';
    if (slide) {
      if (c.state.reviewMode && slide.product_strip_behavior) {
        behavior = slide.product_strip_behavior;
      } else if (slide.template_key && stripBehaviorByTemplate[slide.template_key]) {
        behavior = stripBehaviorByTemplate[slide.template_key];
      }
    }
    c.state.currentSlideStripBehavior = behavior;

    // Repaint the footer so the centre column reflects the new slide. Also
    // close any open strip drawer left over from the previous slide so the
    // user is not staring at the wrong slide's products.
    if (c.slideStrip && typeof c.slideStrip.close === 'function') {
      c.slideStrip.close();
    } else {
      document.body.classList.remove('fw-strip-open');
    }
    if (c.cart && typeof c.cart.paintSummary === 'function') c.cart.paintSummary();

    // Tear down whatever was mounted previously.
    if (typeof currentCleanup === 'function') {
      try { currentCleanup(); } catch (e) { console.warn('Slide cleanup threw:', e); }
    }
    currentCleanup = null;

    var slideEl = document.getElementById('deck-slide');
    var posEl   = document.getElementById('deck-position');
    if (posEl) posEl.textContent = (idx + 1) + ' / ' + order.length;

    // Show edge arrows only when there is a slide in that direction.
    var arrowPrev = document.getElementById('deck-arrow-prev');
    var arrowNext = document.getElementById('deck-arrow-next');
    if (arrowPrev) arrowPrev.hidden = idx <= 0;
    if (arrowNext) arrowNext.hidden = idx >= order.length - 1;

    paintDots();

    // Reset any animation class from the previous mount before re-rendering.
    slideEl.classList.remove('deck-slide-anim-next', 'deck-slide-anim-prev');

    if (!slide) {
      slideEl.innerHTML = ''
        + '<div class="deck-slide-fallback">'
        +   '<div class="deck-slide-fallback-title">Slide unavailable</div>'
        +   '<p class="deck-slide-fallback-body">This slide could not be loaded. Skip past it using the position dots below.</p>'
        + '</div>';
    } else {
      var services = buildServices();
      currentCleanup = c.slideRenderer.renderSlide(slide, slideEl, services);
    }

    // Animate the new slide in based on travel direction. Force a reflow
    // before adding the class so the browser restarts the animation
    // even when the same class would otherwise be re-applied.
    if (direction === 'next' || direction === 'prev') {
      // eslint-disable-next-line no-unused-expressions
      slideEl.offsetWidth;
      slideEl.classList.add(direction === 'next' ? 'deck-slide-anim-next' : 'deck-slide-anim-prev');
    }
  }

  // Paint the position-dots pill at the bottom of the slide. Each dot
  // is a button that jumps directly to the corresponding slide. The
  // active dot elongates so the rep / customer can read position at a
  // glance. After the last slide we append a "transition" affordance
  // (Browse catalogue in rep mode, Review summary in review mode) so
  // the user always has a forward path.
  function paintDots() {
    var c = window.fwApp;
    var order = c.state.slideOrder || [];
    var idx = c.state.currentSlideIndex;
    var dotsEl = document.getElementById('deck-dots');
    if (!dotsEl) return;

    var html = order.map(function (sid, i) {
      return '<button class="deck-dot' + (i === idx ? ' deck-dot-active' : '') + '"'
        + ' data-deck-dot="' + i + '"'
        + ' role="tab" aria-selected="' + (i === idx ? 'true' : 'false') + '"'
        + ' aria-label="Slide ' + (i + 1) + ' of ' + order.length + '"></button>';
    }).join('');

    var atEnd = idx === order.length - 1;
    var transitionLabel = c.state.reviewMode ? 'Review summary' : 'Browse catalogue';
    if (atEnd) {
      html += '<button class="deck-dot-jump" data-deck-jump="forward" type="button">'
        + c.escapeHtml(transitionLabel) + ' &rarr;</button>';
    }

    dotsEl.innerHTML = html;

    dotsEl.querySelectorAll('[data-deck-dot]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = parseInt(btn.getAttribute('data-deck-dot'), 10);
        if (!isNaN(i)) jumpTo(i);
      });
    });
    var jumpBtn = dotsEl.querySelector('[data-deck-jump]');
    if (jumpBtn) jumpBtn.addEventListener('click', function () {
      goNext();
    });
  }

  function buildServices() {
    var c = window.fwApp;
    return {
      cart: c.cart,
      toast: c.toast,
      escapeHtml: c.escapeHtml,
      escapeAttr: c.escapeAttr,
      supa: c.supa,
      nav: { next: goNext, prev: goPrev, jumpTo: jumpTo },
    };
  }

  function goNext() {
    var c = window.fwApp;
    var order = c.state.slideOrder || [];
    // Past the last slide:
    //   - review mode: go to the customer summary screen
    //   - rep mode:    flow into the full footwear catalogue
    if (c.state.currentSlideIndex >= order.length - 1) {
      if (c.state.reviewMode) c.setView('summary');
      else                    c.setView('catalogue');
      return;
    }
    c.state.currentSlideIndex++;
    mountCurrentSlide('next');
  }

  function goPrev() {
    var c = window.fwApp;
    if (c.state.currentSlideIndex <= 0) return;
    c.state.currentSlideIndex--;
    mountCurrentSlide('prev');
  }

  function jumpTo(idx) {
    var c = window.fwApp;
    var order = c.state.slideOrder || [];
    if (idx < 0 || idx >= order.length) return;
    var prev = c.state.currentSlideIndex;
    c.state.currentSlideIndex = idx;
    // Direction hint based on which way the index moved so dot taps
    // also get the matching slide-in animation.
    var dir = idx > prev ? 'next' : (idx < prev ? 'prev' : null);
    mountCurrentSlide(dir);
  }

  // ── Keyboard ──
  function onKeyDown(ev) {
    // Only react if the deck is the active view.
    if (window.fwApp.state.activeView !== 'deck') return;
    // Don't fight typing inside an input
    var tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key === 'ArrowLeft')  { ev.preventDefault(); goPrev(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); goNext(); }
  }

  // ── Touch swipe ──
  function onTouchStart(ev) {
    if (!ev.touches || ev.touches.length === 0) return;
    touchStartX = ev.touches[0].clientX;
    touchStartY = ev.touches[0].clientY;
  }
  function onTouchEnd(ev) {
    if (touchStartX == null) return;
    var t = (ev.changedTouches && ev.changedTouches[0]) || null;
    if (!t) { touchStartX = null; return; }
    var dx = t.clientX - touchStartX;
    var dy = t.clientY - touchStartY;
    touchStartX = null;
    touchStartY = null;
    // Horizontal swipe only; ignore vertical scrolls.
    if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx > 0) goPrev();
    else        goNext();
  }

  // ── Pointer Events (mouse + pen) ──
  // pointerdown is on the stage; pointerup/cancel are on document so the
  // gesture completes even if the pointer leaves the stage during drag.
  function onPointerDown(ev) {
    if (ev.pointerType === 'touch') return;
    pointerStartX = ev.clientX;
    pointerStartY = ev.clientY;
  }
  function onPointerUp(ev) {
    if (ev.pointerType === 'touch') return;
    if (pointerStartX == null) return;
    var dx = ev.clientX - pointerStartX;
    var dy = ev.clientY - pointerStartY;
    pointerStartX = null;
    pointerStartY = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx > 0) goPrev();
    else        goNext();
  }
  function onPointerCancel() {
    pointerStartX = null;
    pointerStartY = null;
  }

  // Stops the browser starting a native drag-and-drop when the user
  // begins a swipe on an image inside a slide. Without this, dragging
  // a full-bleed background image (e.g. the title_page template) hands
  // the gesture off to drag-and-drop and our pointer/touch handlers
  // never see the move.
  function preventStageDrag(ev) {
    ev.preventDefault();
  }

  window.fwApp.views.deck = renderDeck;
})();
