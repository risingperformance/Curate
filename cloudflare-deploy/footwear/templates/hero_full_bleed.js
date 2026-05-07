// ─── Template: hero_full_bleed ─────────────────────────────────────────────
//
// Full-bleed background image or video with overlaid title and subtitle,
// plus an optional CTA. Content slots:
//   - background_url   (required)
//   - background_type  (required: 'image' | 'video')
//   - title            (required)
//   - subtitle         (optional)
//   - cta_label        (optional)
//   - cta_target       (optional)

(function () {
  'use strict';

  function render(content, services, container) {
    var ehtml = services.escapeHtml || defaultEscapeHtml;
    var eattr = services.escapeAttr || defaultEscapeAttr;

    var bgUrl  = content.background_url  || '';
    var bgType = content.background_type || 'image';
    var title  = content.title           || '';
    var sub    = content.subtitle        || '';
    var ctaLabel  = content.cta_label  || '';
    var ctaTarget = content.cta_target || '';

    var bgHtml = '';
    if (bgType === 'video' && bgUrl) {
      bgHtml = ''
        + '<video class="hfb-bg" autoplay loop muted playsinline'
        + ' src="' + eattr(bgUrl) + '">'
        + '</video>';
    } else if (bgUrl) {
      bgHtml = '<img class="hfb-bg" alt="" src="' + eattr(bgUrl) + '">';
    } else {
      bgHtml = '<div class="hfb-bg hfb-bg-empty"></div>';
    }

    var ctaHtml = (ctaLabel && ctaTarget)
      ? '<a class="hfb-cta" data-fw-cta-target="' + eattr(ctaTarget) + '">' + ehtml(ctaLabel) + '</a>'
      : '';

    container.innerHTML = ''
      + '<div class="hfb">'
      +   bgHtml
      +   '<div class="hfb-overlay">'
      +     '<div class="hfb-title">' + ehtml(title) + '</div>'
      +     (sub ? '<div class="hfb-sub">' + ehtml(sub) + '</div>' : '')
      +     ctaHtml
      +   '</div>'
      + '</div>';

    var listeners = [];
    var ctaEl = container.querySelector('.hfb-cta');
    if (ctaEl) {
      var handler = function (ev) {
        ev.preventDefault();
        handleCta(ctaEl.dataset.fwCtaTarget, services);
      };
      ctaEl.addEventListener('click', handler);
      listeners.push({ el: ctaEl, evt: 'click', fn: handler });
    }

    var video = container.querySelector('video.hfb-bg');

    return function cleanup() {
      listeners.forEach(function (l) { l.el.removeEventListener(l.evt, l.fn); });
      if (video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) { /* ignore */ }
      }
    };
  }

  // CTA targets can be a URL or an internal action like
  // 'add_to_cart:{product_id}'. The URL case opens in a new tab.
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
    window.fwApp.slideRenderer.register('hero_full_bleed', render);
  }
})();
