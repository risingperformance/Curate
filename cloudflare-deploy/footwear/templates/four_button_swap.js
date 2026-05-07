// ─── Template: four_button_swap ────────────────────────────────────────────
//
// Same as three_button_swap but with four vertically-stacked buttons in
// the left column. Title at the top, four icon-and-label buttons on the
// left, swappable content area on the right. Clicking a button makes it
// active and replaces the content area with that button's media + text.
//
// Content slots:
//   - title    (required)
//   - buttons  (required): exactly 4 button objects
//       label, icon (optional), media_url, media_type, body_title (optional), body_text (optional)
//
// Library icon keys match three_button_swap: book-open, shoe, trending-up,
// stars, flask, play, target, lightbulb, award, chart, camera, megaphone.

(function () {
  'use strict';

  // Same library set as three_button_swap. Kept in this file so the two
  // templates stay independently registerable -- if a future change
  // moves icons into a shared file, both can import from there.
  var LIB_ICONS = {
    'book-open':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M2 4.5h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z"/>' +
        '<path d="M22 4.5h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z"/>' +
      '</svg>',
    'shoe':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M2 16h17l3 3H2z"/>' +
        '<path d="M2 16V9a3 3 0 0 1 3-3h3l2 4 7 1 5 5z"/>' +
        '<path d="M8 6l1 2"/><path d="M11 7l1 2"/>' +
      '</svg>',
    'trending-up':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="3 17 9 11 13 15 21 7"/>' +
        '<polyline points="14 7 21 7 21 14"/>' +
      '</svg>',
    'stars':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<polygon points="6 4 7.4 7 10.5 7.4 8.2 9.6 8.8 12.7 6 11.2 3.2 12.7 3.8 9.6 1.5 7.4 4.6 7"/>' +
        '<polygon points="18 4 19.4 7 22.5 7.4 20.2 9.6 20.8 12.7 18 11.2 15.2 12.7 15.8 9.6 13.5 7.4 16.6 7"/>' +
        '<polygon points="12 13 13.4 16 16.5 16.4 14.2 18.6 14.8 21.7 12 20.2 9.2 21.7 9.8 18.6 7.5 16.4 10.6 16"/>' +
      '</svg>',
    'flask':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M9 3h6"/>' +
        '<path d="M10 3v6.5L4.5 18A2.5 2.5 0 0 0 6.7 22h10.6a2.5 2.5 0 0 0 2.2-3.5L14 9.5V3"/>' +
        '<path d="M7 14h10"/>' +
      '</svg>',
    'play':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="12" r="9"/>' +
        '<polygon points="10 8.5 16 12 10 15.5" fill="currentColor"/>' +
      '</svg>',
    'target':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="12" r="9"/>' +
        '<circle cx="12" cy="12" r="5"/>' +
        '<circle cx="12" cy="12" r="1.5" fill="currentColor"/>' +
      '</svg>',
    'lightbulb':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M9 18h6"/>' +
        '<path d="M10 21h4"/>' +
        '<path d="M12 3a6 6 0 0 0-4 10.5c.7.6 1.2 1.5 1.2 2.5V17h5.6V16c0-1 .5-1.9 1.2-2.5A6 6 0 0 0 12 3z"/>' +
      '</svg>',
    'award':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="9" r="6"/>' +
        '<polyline points="8.5 13.5 7 22 12 19 17 22 15.5 13.5"/>' +
      '</svg>',
    'chart':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<line x1="3" y1="20" x2="21" y2="20"/>' +
        '<rect x="5" y="13" width="3" height="7"/>' +
        '<rect x="10.5" y="9" width="3" height="11"/>' +
        '<rect x="16" y="5" width="3" height="15"/>' +
      '</svg>',
    'camera':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="6.5" width="18" height="13" rx="2"/>' +
        '<path d="M9 6.5L10.5 4h3L15 6.5"/>' +
        '<circle cx="12" cy="13" r="3.5"/>' +
      '</svg>',
    'megaphone':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 11v2a2 2 0 0 0 2 2h2l8 4V5L7 9H5a2 2 0 0 0-2 2z"/>' +
        '<path d="M19 8a4 4 0 0 1 0 8"/>' +
      '</svg>'
  };

  function renderIcon(spec, eattr) {
    if (!spec) return '';
    if (spec.indexOf('library:') === 0) {
      var key = spec.slice('library:'.length);
      var svg = LIB_ICONS[key];
      if (svg) return '<span class="fbs-icon">' + svg + '</span>';
      return '';
    }
    return '<span class="fbs-icon"><img alt="" src="' + eattr(spec) + '"></span>';
  }

  function render(content, services, container) {
    var ehtml = services.escapeHtml || defaultEscapeHtml;
    var eattr = services.escapeAttr || defaultEscapeAttr;

    var title   = content.title   || '';
    var buttons = Array.isArray(content.buttons) ? content.buttons.slice(0, 4) : [];
    while (buttons.length < 4) buttons.push({});

    var state = { active: 0 };
    var listeners = [];
    var activeVideo = null;

    function buildButton(btn, idx) {
      var active = idx === state.active;
      var cls = 'fbs-btn' + (active ? ' fbs-btn-active' : '');
      return '<button class="' + cls + '" data-fw-fbs-idx="' + idx + '" type="button">'
           +   renderIcon(btn.icon || '', eattr)
           +   '<span class="fbs-btn-label">' + ehtml(btn.label || '') + '</span>'
           + '</button>';
    }

    function buildContent(btn) {
      var url  = btn.media_url  || '';
      var type = btn.media_type || 'image';
      var bodyTitle = btn.body_title || '';
      var bodyText  = btn.body_text  || '';

      var media = '';
      if (type === 'video' && url) {
        // Controls are shown so reps can scrub and unmute. Without
        // `muted` browsers may block autoplay; if so the user just
        // taps play and audio is on by default.
        media = '<video class="fbs-media" controls autoplay loop playsinline preload="metadata"'
              + ' src="' + eattr(url) + '"></video>';
      } else if (url) {
        media = '<img class="fbs-media" alt="" src="' + eattr(url) + '">';
      } else {
        media = '<div class="fbs-media fbs-media-empty">No media set.</div>';
      }

      var overlay = '';
      if (bodyTitle || bodyText) {
        overlay = '<div class="fbs-overlay">'
                +   (bodyTitle ? '<div class="fbs-overlay-title">' + ehtml(bodyTitle) + '</div>' : '')
                +   (bodyText  ? '<div class="fbs-overlay-text">'  + ehtml(bodyText)  + '</div>' : '')
                + '</div>';
      }

      return media + overlay;
    }

    function paint() {
      if (activeVideo) {
        try { activeVideo.pause(); } catch (e) { /* ignore */ }
        activeVideo = null;
      }

      container.innerHTML = ''
        + '<div class="fbs">'
        +   '<div class="fbs-title">' + ehtml(title) + '</div>'
        +   '<div class="fbs-body">'
        +     '<div class="fbs-col">'
        +       buttons.map(buildButton).join('')
        +     '</div>'
        +     '<div class="fbs-content">'
        +       buildContent(buttons[state.active] || {})
        +     '</div>'
        +   '</div>'
        + '</div>';

      activeVideo = container.querySelector('.fbs-content video.fbs-media');

      while (listeners.length) {
        var l = listeners.pop();
        l.el.removeEventListener(l.evt, l.fn);
      }
      container.querySelectorAll('[data-fw-fbs-idx]').forEach(function (btnEl) {
        var handler = function () {
          var idx = parseInt(btnEl.dataset.fwFbsIdx, 10);
          if (isNaN(idx) || idx === state.active) return;
          state.active = idx;
          paint();
        };
        btnEl.addEventListener('click', handler);
        listeners.push({ el: btnEl, evt: 'click', fn: handler });
      });
    }

    paint();

    return function cleanup() {
      while (listeners.length) {
        var l = listeners.pop();
        l.el.removeEventListener(l.evt, l.fn);
      }
      if (activeVideo) {
        try { activeVideo.pause(); activeVideo.removeAttribute('src'); activeVideo.load(); }
        catch (e) { /* ignore */ }
        activeVideo = null;
      }
    };
  }

  function defaultEscapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function defaultEscapeAttr(s) { return defaultEscapeHtml(s).replace(/"/g, '&quot;'); }

  if (window.fwApp && window.fwApp.slideRenderer) {
    window.fwApp.slideRenderer.register('four_button_swap', render);
  }
})();
