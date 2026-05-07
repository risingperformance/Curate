// ─── Template: video_focus ─────────────────────────────────────────────────
//
// Single-video player with caption and optional CTA. Content slots:
//   - video_url   (required)
//   - poster_url  (optional)
//   - caption     (optional)
//   - cta_label   (optional)
//   - cta_target  (optional)

(function () {
  'use strict';

  function render(content, services, container) {
    var ehtml = services.escapeHtml || defaultEscapeHtml;
    var eattr = services.escapeAttr || defaultEscapeAttr;

    var url   = content.video_url  || '';
    var poster = content.poster_url || '';
    var caption = content.caption  || '';
    var ctaLabel  = content.cta_label  || '';
    var ctaTarget = content.cta_target || '';

    var ctaHtml = (ctaLabel && ctaTarget)
      ? '<a class="vf-cta btn btn-primary" data-fw-cta-target="' + eattr(ctaTarget) + '">' + ehtml(ctaLabel) + '</a>'
      : '';

    var posterAttr = poster ? (' poster="' + eattr(poster) + '"') : '';

    container.innerHTML = ''
      + '<div class="vf">'
      +   '<div class="vf-stage">'
      +     (url
          ? ('<video class="vf-video" controls playsinline' + posterAttr + ' src="' + eattr(url) + '"></video>')
          : '<div class="vf-empty">No video URL configured.</div>')
      +   '</div>'
      +   (caption ? '<div class="vf-caption">' + ehtml(caption) + '</div>' : '')
      +   (ctaHtml ? '<div class="vf-actions">' + ctaHtml + '</div>' : '')
      + '</div>';

    var listeners = [];
    var ctaEl = container.querySelector('.vf-cta');
    if (ctaEl) {
      var handler = function (ev) {
        ev.preventDefault();
        handleCta(ctaEl.dataset.fwCtaTarget, services);
      };
      ctaEl.addEventListener('click', handler);
      listeners.push({ el: ctaEl, evt: 'click', fn: handler });
    }

    var video = container.querySelector('video.vf-video');

    return function cleanup() {
      listeners.forEach(function (l) { l.el.removeEventListener(l.evt, l.fn); });
      if (video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) { /* ignore */ }
      }
    };
  }

  function handleCta(target, services) {
    if (!target) return;
    if (/^https?:\/\//i.test(target)) {
      window.open(target, '_blank', 'noopener,noreferrer');
      return;
    }
    var m = /^add_to_cart:(.+)$/.exec(target);
    if (m && services && services.cart) {
      services.cart.add(m[1].trim(), null, null, 1);
      if (services.toast) services.toast('Added to cart.', 'success');
      return;
    }
    if (services && services.toast) services.toast('CTA target not understood: ' + target, 'info');
  }

  function defaultEscapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function defaultEscapeAttr(s) { return defaultEscapeHtml(s).replace(/"/g, '&quot;'); }

  if (window.fwApp && window.fwApp.slideRenderer) {
    window.fwApp.slideRenderer.register('video_focus', render);
  }
})();
