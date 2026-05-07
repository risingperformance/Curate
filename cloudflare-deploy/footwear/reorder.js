// ─── Reorder view ──────────────────────────────────────────────────────────
//
// Renders the resolved deck (state.slideOrder) as draggable cards. The
// rep can:
//   - drag a card up or down, with a drop indicator above or below
//     whichever card is being hovered (insert-before / insert-after based
//     on cursor Y vs card midpoint),
//   - tap up/down arrow buttons (accessibility / touch fallback),
//   - remove a slide (moves it into excludedSlideIds),
//   - restore a previously removed slide,
//   - click "Start presentation" to save the final order and hand off to
//     the deck view.
//
// Every reorder/remove/restore writes to state.slideOrder /
// state.excludedSlideIds and schedules a debounced UPDATE on the
// existing footwear_drafts row so the brief's "real time" save guarantee
// holds without spamming the DB on every drop.
//
// Section 4.3 of the AW27 footwear brief.

(function () {
  'use strict';

  window.fwApp       = window.fwApp || {};
  window.fwApp.views = window.fwApp.views || {};

  // View-local cache of slide metadata, keyed by id. Filled on render().
  var slideMeta = {};

  // Drag state. Reset between drags.
  var draggingId = null;

  // Master-detail: which slide is currently shown in the preview pane.
  // Defaults to the first slide in the current order on entry, falls
  // back if the selected slide is removed.
  var selectedId = null;

  // Debounced draft persistence. Reorder operations can fire quickly.
  var persistTimer    = null;
  var persistDelayMs  = 400;

  async function renderReorder() {
    var c     = window.fwApp;
    var supa  = c.supa;
    var panel = document.getElementById('view-reorder');

    panel.innerHTML = '<div class="placeholder-card"><div class="placeholder-card-body">Loading slides...</div></div>';

    // Pull metadata for every slide that's either in the deck or excluded.
    var allIds = (c.state.slideOrder || [])
                   .concat(c.state.excludedSlideIds || []);

    if (allIds.length === 0) {
      panel.innerHTML = ''
        + '<div class="placeholder-card">'
        +   '<div class="placeholder-card-title">No slides in this deck yet</div>'
        +   '<p class="placeholder-card-body">'
        +     'The questionnaire produced an empty deck. Either no slides exist in the database or every slide was excluded by your answers.'
        +   '</p>'
        +   '<div style="margin-top:18px;"><button class="btn btn-primary" id="r-back">Back to questionnaire</button></div>'
        + '</div>';
      var backBtn = document.getElementById('r-back');
      if (backBtn) backBtn.addEventListener('click', function () { c.setView('questionnaire'); });
      return;
    }

    var metaRes = await supa.from('footwear_slides')
                            .select('id, slide_key, title, template_key, content, default_position')
                            .in('id', allIds);
    if (metaRes.error) {
      panel.innerHTML = '<div class="placeholder-card"><div class="placeholder-card-body">Could not load slides: ' + c.escapeHtml(metaRes.error.message || '') + '</div></div>';
      return;
    }
    slideMeta = {};
    (metaRes.data || []).forEach(function (s) { slideMeta[s.id] = s; });

    paint();
  }

  function paint() {
    var c     = window.fwApp;
    var panel = document.getElementById('view-reorder');

    var order    = (c.state.slideOrder       || []).slice();
    var excluded = (c.state.excludedSlideIds || []).slice();

    // Keep selectedId in sync with the current order. Default to the
    // first slide on entry; fall back if the previously selected slide
    // was removed or was never in the order.
    if (!selectedId || order.indexOf(selectedId) < 0) {
      selectedId = order.length > 0 ? order[0] : null;
    }

    var cardsHtml = order.map(function (sid, idx) {
      var s = slideMeta[sid];
      if (!s) {
        return ''
          + '<div class="r-card r-card-missing" data-slide-id="' + c.escapeAttr(sid) + '">'
          +   '<div class="r-card-body"><b>Missing slide</b><br>'
          +     '<span class="r-card-meta">' + c.escapeHtml(sid) + '</span>'
          +   '</div>'
          +   '<button class="r-card-remove" data-fw-action="removeSlide" data-id="' + c.escapeAttr(sid) + '" aria-label="Remove">&#10005;</button>'
          + '</div>';
      }
      var atTop    = idx === 0;
      var atBottom = idx === order.length - 1;
      var isActive = sid === selectedId;
      var thumb    = thumbnailFor(s);
      var thumbHtml = thumb
        ? '<img class="r-card-thumb" src="' + c.escapeAttr(thumb) + '" alt="">'
        : '<div class="r-card-thumb r-card-thumb-empty" aria-hidden="true">' + c.escapeHtml(initialsFor(s.title)) + '</div>';

      return ''
        + '<div class="r-card' + (isActive ? ' r-card-selected' : '') + '"'
        +      ' data-slide-id="' + c.escapeAttr(sid) + '" draggable="true" tabindex="0"'
        +      ' aria-pressed="' + (isActive ? 'true' : 'false') + '">'
        +   '<div class="r-card-handle" aria-hidden="true">&#x22EE;&#x22EE;</div>'
        +   thumbHtml
        +   '<div class="r-card-body">'
        +     '<div class="r-card-title">' + c.escapeHtml(s.title || '(untitled)') + '</div>'
        +   '</div>'
        +   '<div class="r-card-actions">'
        +     '<button class="r-card-btn" data-fw-action="moveSlide" data-id="' + c.escapeAttr(sid) + '" data-dir="up"'
        +            (atTop ? ' disabled' : '') + ' aria-label="Move up">&uarr;</button>'
        +     '<button class="r-card-btn" data-fw-action="moveSlide" data-id="' + c.escapeAttr(sid) + '" data-dir="down"'
        +            (atBottom ? ' disabled' : '') + ' aria-label="Move down">&darr;</button>'
        +     '<button class="r-card-btn r-card-remove" data-fw-action="removeSlide" data-id="' + c.escapeAttr(sid) + '" aria-label="Remove from deck">&#10005;</button>'
        +   '</div>'
        + '</div>';
    }).join('');

    var removedHtml = '';
    if (excluded.length > 0) {
      var rows = excluded.map(function (sid) {
        var s = slideMeta[sid];
        var label = s ? (s.title || s.slide_key || sid) : sid;
        var subtitle = s ? (s.slide_key || '') : '';
        var thumb = s ? thumbnailFor(s) : null;
        var thumbHtml = thumb
          ? '<img class="r-card-thumb" src="' + c.escapeAttr(thumb) + '" alt="">'
          : '<div class="r-card-thumb r-card-thumb-empty" aria-hidden="true">' + c.escapeHtml(initialsFor(label)) + '</div>';
        return ''
          + '<div class="r-card r-card-removed" data-slide-id="' + c.escapeAttr(sid) + '">'
          +   thumbHtml
          +   '<div class="r-card-body">'
          +     '<div class="r-card-title">' + c.escapeHtml(label) + '</div>'
          +     (subtitle ? '<div class="r-card-meta"><span class="r-card-key">' + c.escapeHtml(subtitle) + '</span></div>' : '')
          +   '</div>'
          +   '<button class="r-restore-btn" data-fw-action="restoreSlide" data-id="' + c.escapeAttr(sid) + '">+ Restore</button>'
          + '</div>';
      }).join('');
      removedHtml = ''
        + '<div class="r-removed-section">'
        +   '<div class="r-removed-header">'
        +     '<span class="r-removed-label">Removed slides</span>'
        +     '<span class="r-removed-count">' + excluded.length + '</span>'
        +   '</div>'
        +   '<p class="r-removed-help">Removed by your answers or by you. Click Restore to add them back to the deck.</p>'
        +   '<div class="r-removed-list">' + rows + '</div>'
        + '</div>';
    }

    // The list + the removed-slides block share the left column so the
    // left column is the only thing that scrolls. The preview pane on
    // the right and the action bar at the bottom stay in view.
    var bodyHtml = order.length === 0
      ? '<div class="placeholder-card"><div class="placeholder-card-body">All slides have been removed. Restore at least one to start the presentation.</div></div>'
      : ''
        + '<div class="r-shell">'
        +   '<div class="r-list-col">'
        +     '<div class="r-list" id="r-list">' + cardsHtml + '</div>'
        +     removedHtml
        +   '</div>'
        +   '<aside class="r-preview" id="r-preview">' + renderPreviewHtml(order) + '</aside>'
        + '</div>';

    panel.innerHTML = ''
      + '<div class="qx-intro">'
      +   '<div class="qx-intro-title">Order your deck</div>'
      +   '<div class="qx-intro-body">Drag to reorder, click to preview, remove what does not fit.</div>'
      + '</div>'
      + bodyHtml
      + '<div class="r-footer">'
      +   '<button class="r-footer-back" id="r-back-btn">'
      +     '<span class="r-footer-back-icon" aria-hidden="true">&larr;</span>'
      +     '<span>Back to questionnaire</span>'
      +   '</button>'
      +   '<button class="r-footer-start" id="r-start-btn"' + (order.length === 0 ? ' disabled' : '') + '>Start presentation</button>'
      + '</div>';

    wireListeners();
  }

  // Build the preview pane HTML for the currently selected slide.
  // Edge-to-edge gallery: the slide image fills the whole pane via
  // object-fit: cover, with a glass position pill top-right and a
  // gradient overlay at the bottom carrying the eyebrow + Playfair
  // title + monospace meta.
  function renderPreviewHtml(order) {
    var c = window.fwApp;
    if (!selectedId) {
      return '<div class="r-preview-empty">No slide selected.</div>';
    }
    var s = slideMeta[selectedId];
    if (!s) {
      return '<div class="r-preview-empty">Slide is no longer available.</div>';
    }
    var pos   = order.indexOf(selectedId) + 1;
    var total = order.length;
    var thumb = thumbnailFor(s);

    var imgHtml = thumb
      ? '<img class="r-preview-img" src="' + c.escapeAttr(thumb) + '" alt="">'
      : '<div class="r-preview-fallback">' + c.escapeHtml(initialsFor(s.title)) + '</div>';

    return ''
      + imgHtml
      + '<span class="r-preview-badge">' + pos + ' / ' + total + '</span>'
      + '<div class="r-preview-overlay">'
      +   '<div class="r-preview-eyebrow">Preview</div>'
      +   '<div class="r-preview-title">' + c.escapeHtml(s.title || '(untitled)') + '</div>'
      + '</div>';
  }

  // Update only the preview pane in place. Used after a click-to-select
  // so we don't rebuild the whole list (which would lose drag state).
  function repaintPreview() {
    var c = window.fwApp;
    var preview = document.getElementById('r-preview');
    if (!preview) return;
    var order = (c.state.slideOrder || []).slice();
    preview.innerHTML = renderPreviewHtml(order);
  }

  function setSelected(sid) {
    if (selectedId === sid) return;
    selectedId = sid;
    // Update only the active class on the cards + the preview pane to
    // avoid a full re-render (which would interrupt focus / drag state).
    document.querySelectorAll('.r-card').forEach(function (card) {
      var match = card.dataset.slideId === sid;
      card.classList.toggle('r-card-selected', match);
      card.setAttribute('aria-pressed', match ? 'true' : 'false');
    });
    repaintPreview();
  }

  function wireListeners() {
    var panel = document.getElementById('view-reorder');

    panel.querySelectorAll('[data-fw-action]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var a = el.dataset.fwAction;
        if      (a === 'moveSlide')    moveSlide(el.dataset.id, el.dataset.dir);
        else if (a === 'removeSlide')  removeSlide(el.dataset.id);
        else if (a === 'restoreSlide') restoreSlide(el.dataset.id);
      });
    });

    // Drag, click-to-select, focus, and keyboard reorder only apply to
    // active cards. Removed cards have their own Restore button via
    // data-fw-action and do not participate in these interactions.
    panel.querySelectorAll('.r-card:not(.r-card-removed)').forEach(function (card) {
      card.addEventListener('dragstart', onDragStart);
      card.addEventListener('dragover',  onDragOver);
      card.addEventListener('dragleave', onDragLeave);
      card.addEventListener('drop',      onDrop);
      card.addEventListener('dragend',   onDragEnd);

      // Click on the card (anywhere outside the action buttons) selects
      // it for the preview pane. The action buttons stop propagation so
      // they don't double up.
      card.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-fw-action]')) return;
        setSelected(card.dataset.slideId);
      });

      // Tabbing through cards also selects, so keyboard users see the
      // preview update as they move through the list.
      card.addEventListener('focus', function () {
        setSelected(card.dataset.slideId);
      });

      // Keyboard: arrow up/down with the card focused moves it.
      card.addEventListener('keydown', function (ev) {
        if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
        // Don't fight the browser's default focus traversal when modifier
        // keys are held.
        if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
        ev.preventDefault();
        moveSlide(card.dataset.slideId, ev.key === 'ArrowUp' ? 'up' : 'down');
      });
    });

    var startBtn = document.getElementById('r-start-btn');
    if (startBtn) startBtn.addEventListener('click', startPresentation);

    var backBtn = document.getElementById('r-back-btn');
    if (backBtn) backBtn.addEventListener('click', confirmBack);
  }

  // ── Drag-and-drop ──────────────────────────────────────────────────────
  function onDragStart(ev) {
    var card = ev.currentTarget;
    draggingId = card.dataset.slideId;
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', draggingId);
    }
    card.classList.add('r-card-dragging');
  }

  function onDragOver(ev) {
    if (!draggingId) return;
    var card = ev.currentTarget;
    if (card.dataset.slideId === draggingId) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';

    var rect    = card.getBoundingClientRect();
    var isAbove = ev.clientY < rect.top + rect.height / 2;
    card.classList.toggle('r-card-drop-above', isAbove);
    card.classList.toggle('r-card-drop-below', !isAbove);
  }

  function onDragLeave(ev) {
    var card = ev.currentTarget;
    card.classList.remove('r-card-drop-above');
    card.classList.remove('r-card-drop-below');
  }

  function onDrop(ev) {
    if (!draggingId) return;
    ev.preventDefault();
    var c       = window.fwApp;
    var card    = ev.currentTarget;
    var targetId = card.dataset.slideId;
    cleanupDropClasses();

    if (!targetId || targetId === draggingId) {
      draggingId = null;
      return;
    }

    var rect    = card.getBoundingClientRect();
    var isAbove = ev.clientY < rect.top + rect.height / 2;

    var order = (c.state.slideOrder || []).slice();
    var fromIdx = order.indexOf(draggingId);
    if (fromIdx < 0) { draggingId = null; return; }
    order.splice(fromIdx, 1);

    var toIdx = order.indexOf(targetId);
    if (toIdx < 0) toIdx = order.length;
    if (!isAbove) toIdx += 1;
    order.splice(toIdx, 0, draggingId);

    c.state.slideOrder = order;
    draggingId = null;
    paint();
    schedulePersist();
  }

  function onDragEnd() {
    cleanupDropClasses();
    document.querySelectorAll('.r-card-dragging').forEach(function (el) {
      el.classList.remove('r-card-dragging');
    });
    draggingId = null;
  }

  function cleanupDropClasses() {
    document.querySelectorAll('.r-card-drop-above, .r-card-drop-below').forEach(function (el) {
      el.classList.remove('r-card-drop-above');
      el.classList.remove('r-card-drop-below');
    });
  }

  // ── Up/down ────────────────────────────────────────────────────────────
  function moveSlide(sid, dir) {
    var c = window.fwApp;
    var order = (c.state.slideOrder || []).slice();
    var i = order.indexOf(sid);
    if (i < 0) return;
    var j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    c.state.slideOrder = order;
    paint();
    schedulePersist();

    // Re-focus the moved card so keyboard reordering is fluid
    window.requestAnimationFrame(function () {
      var moved = document.querySelector('.r-card[data-slide-id="' + cssEscape(sid) + '"]');
      if (moved) moved.focus();
    });
  }

  // ── Remove / restore ──────────────────────────────────────────────────
  function removeSlide(sid) {
    var c = window.fwApp;
    c.state.slideOrder       = (c.state.slideOrder       || []).filter(function (id) { return id !== sid; });
    c.state.excludedSlideIds = (c.state.excludedSlideIds || []).slice();
    if (c.state.excludedSlideIds.indexOf(sid) < 0) c.state.excludedSlideIds.push(sid);
    paint();
    schedulePersist();
  }

  function restoreSlide(sid) {
    var c = window.fwApp;
    c.state.excludedSlideIds = (c.state.excludedSlideIds || []).filter(function (id) { return id !== sid; });
    var order = (c.state.slideOrder || []).slice();
    if (order.indexOf(sid) < 0) {
      // Insert in default_position order if metadata available, else append.
      var s = slideMeta[sid];
      if (s) {
        var inserted = false;
        for (var i = 0; i < order.length; i++) {
          var other = slideMeta[order[i]];
          if (other && (other.default_position || 0) > (s.default_position || 0)) {
            order.splice(i, 0, sid);
            inserted = true;
            break;
          }
        }
        if (!inserted) order.push(sid);
      } else {
        order.push(sid);
      }
    }
    c.state.slideOrder = order;
    paint();
    schedulePersist();
  }

  // ── Persistence ───────────────────────────────────────────────────────
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, persistDelayMs);
  }

  async function persistNow() {
    persistTimer = null;
    var c = window.fwApp;
    var saveRes = await c.persistDraft({
      slide_order:        c.state.slideOrder,
      excluded_slide_ids: c.state.excludedSlideIds,
    });
    if (saveRes.error) {
      c.toast('Could not save reorder: ' + (saveRes.error.message || 'unknown error'), 'error');
    }
  }

  // ── Start presentation ────────────────────────────────────────────────
  async function startPresentation() {
    var c = window.fwApp;
    if (!c.state.slideOrder || c.state.slideOrder.length === 0) {
      c.toast('Restore at least one slide first.', 'error');
      return;
    }
    var btn = document.getElementById('r-start-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    // Flush any pending debounced save first.
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    var saveRes = await c.persistDraft({
      slide_order:        c.state.slideOrder,
      excluded_slide_ids: c.state.excludedSlideIds,
    });
    if (saveRes.error) {
      c.toast('Could not save: ' + (saveRes.error.message || 'unknown error'), 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Start presentation →'; }
      return;
    }
    c.setView('deck');
  }

  // ── Back ──────────────────────────────────────────────────────────────
  function confirmBack() {
    var c = window.fwApp;
    // Use a simple inline confirm UI rather than window.confirm so it
    // matches the rest of the form's styling. For Phase C2 a native
    // confirm is fine; replace with a styled modal if it grates.
    if (window.confirm('Going back will lose any reorder or remove changes you have made here. Continue?')) {
      // Reset to the questionnaire-derived deck. Easiest path: re-run
      // the questionnaire view, which will reset answers and re-evaluate
      // rules on the next Continue.
      c.state.slideOrder       = [];
      c.state.excludedSlideIds = [];
      c.setView('questionnaire');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  // Pick a sensible thumbnail URL out of a slide's content jsonb. The
  // shapes are template-specific; we try the common fields and fall
  // back to null (renders a letter tile).
  //
  // image_only=true filters out video URLs so we always return something
  // an <img> tag can render. This is what callers always want for the
  // small slide cards in the left column and the preview pane.
  function thumbnailFor(slide) {
    var c = slide && slide.content;
    if (!c) return null;

    function looksLikeImage(u) {
      return typeof u === 'string' && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(u);
    }
    function looksLikeMedia(u, expectedType) {
      // Accept the URL if it is image-shaped, or if the caller's media_type
      // says image (used by templates that don't put the extension in the
      // URL, like Supabase storage paths without a file extension).
      if (!u) return false;
      if (looksLikeImage(u)) return true;
      return expectedType === 'image';
    }

    // title_page + hero_full_bleed
    if (looksLikeMedia(c.background_url, c.background_type)) return c.background_url;
    if (typeof c.poster_url === 'string' && c.poster_url)    return c.poster_url;

    // heading_with_media
    if (looksLikeMedia(c.media_url, c.media_type)) return c.media_url;

    // three_button_swap / four_button_swap: walk buttons until we find
    // one with image-shaped media. Falls back to button[0] when nothing
    // matches so a video-only deck still gets a poster swatch.
    if (Array.isArray(c.buttons) && c.buttons.length) {
      for (var i = 0; i < c.buttons.length; i++) {
        var b = c.buttons[i] || {};
        if (looksLikeMedia(b.media_url, b.media_type)) return b.media_url;
      }
    }

    // tabbed_feature_showcase
    if (Array.isArray(c.tabs) && c.tabs[0] && typeof c.tabs[0].hero_url === 'string') return c.tabs[0].hero_url;

    return null;
  }

  function initialsFor(title) {
    if (!title) return '?';
    var parts = String(title).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // CSS attribute selector escape for ids (UUIDs contain hyphens which
  // are safe; keep this for forward-compat with future custom slide_keys).
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/(["\\\[\]])/g, '\\$1');
  }

  window.fwApp.views.reorder = renderReorder;
})();
