// ─── Template: title_page ──────────────────────────────────────────────────
//
// Full-bleed background image or video with a large white title overlaid
// in the upper-left and a black call-to-action button below it. Clicking
// the button calls services.nav.next() which advances the deck to the
// next slide (or, on the final slide, hands off to the catalogue or the
// review summary, depending on viewer mode).
//
// Content slots:
//   - title            (required)
//   - background_url   (required)
//   - background_type  (required: 'image' | 'video')
//   - button_label     (optional: defaults to 'Continue')

(function () {
  'use strict';

  function render(content, services, container) {
    var ehtml = services.escapeHtml || defaultEscapeHtml;
    var eattr = services.escapeAttr || defaultEscapeAttr;

    var title    = content.title           || '';
    var bgUrl    = content.background_url  || '';
    var bgType   = content.background_type || 'image';
    var btnLabel = content.button_label    || 'Continue';

    var bgHtml = '';
    if (bgType === 'video' && bgUrl) {
      bgHtml = ''
        + '<video class="tp-bg" autoplay loop muted playsinline'
        + ' src="' + eattr(bgUrl) + '"></video>';
    } else if (bgUrl) {
      bgHtml = '<img class="tp-bg" alt="" src="' + eattr(bgUrl) + '">';
    } else {
      bgHtml = '<div class="tp-bg tp-bg-empty"></div>';
    }

    container.innerHTML = ''
      + '<div class="tp">'
      +   bgHtml
      +   '<div class="tp-overlay">'
      +     '<div class="tp-title">' + ehtml(title) + '</div>'
      +     '<button class="tp-cta" type="button">' + ehtml(btnLabel) + '</button>'
      +   '</div>'
      + '</div>';

    var listeners = [];
    var ctaEl = container.querySelector('.tp-cta');
    if (ctaEl) {
      var handler = function (ev) {
        ev.preventDefault();
        if (services.nav && typeof services.nav.next === 'function') {
          services.nav.next();
        }
      };
      ctaEl.addEventListener('click', handler);
      listeners.push({ el: ctaEl, evt: 'click', fn: handler });
    }

    var video = container.querySelector('video.tp-bg');

    return function cleanup() {
      listeners.forEach(function (l) { l.el.removeEventListener(l.evt, l.fn); });
      if (video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); }
        catch (e) { /* ignore */ }
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
    window.fwApp.slideRenderer.register('title_page', render);
  }
})();
