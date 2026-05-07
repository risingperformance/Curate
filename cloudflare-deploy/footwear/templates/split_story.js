// ─── Template: split_story ────────────────────────────────────────────────
//
// Image or video on one side, copy and CTA on the other, optional inline
// product card. Content slots:
//   - media_url           (required)
//   - media_position      (required: 'left' | 'right')
//   - heading             (required)
//   - body                (required)
//   - inline_product_id   (optional, uuid)
//   - cta                 (optional, { label, target })

(function () {
  'use strict';

  var PRODUCT_IMG_BASE =
    'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/product-images/';

  async function render(content, services, container) {
    var ehtml = services.escapeHtml || defaultEscapeHtml;
    var eattr = services.escapeAttr || defaultEscapeAttr;
    var supa  = services.supa;
    var cart  = services.cart;

    var mediaUrl = content.media_url       || '';
    var mediaPos = content.media_position  || 'left';
    var heading  = content.heading         || '';
    var body     = content.body            || '';
    var inlineId = content.inline_product_id || null;
    var cta      = content.cta             || null;
    var ctaLabel  = cta && cta.label  || '';
    var ctaTarget = cta && cta.target || '';

    var isVideo = /\.(mp4|webm)(\?|$)/i.test(mediaUrl);
    var mediaHtml = mediaUrl
      ? (isVideo
          ? '<video class="ss-media" controls playsinline src="' + eattr(mediaUrl) + '"></video>'
          : '<img class="ss-media" alt="" src="' + eattr(mediaUrl) + '">')
      : '<div class="ss-media ss-media-empty">No media configured.</div>';

    var ctaHtml = (ctaLabel && ctaTarget)
      ? '<a class="ss-cta btn btn-primary" data-fw-cta-target="' + eattr(ctaTarget) + '">' + ehtml(ctaLabel) + '</a>'
      : '';

    container.innerHTML = ''
      + '<div class="ss ss-' + (mediaPos === 'right' ? 'right' : 'left') + '">'
      +   '<div class="ss-media-col">' + mediaHtml + '</div>'
      +   '<div class="ss-text-col">'
      +     '<div class="ss-heading">' + ehtml(heading) + '</div>'
      +     '<div class="ss-body">' + ehtml(body).replace(/\n/g, '<br>') + '</div>'
      +     '<div class="ss-inline-product" id="ss-inline-product"></div>'
      +     (ctaHtml ? '<div class="ss-actions">' + ctaHtml + '</div>' : '')
      +   '</div>'
      + '</div>';

    var listeners = [];
    var ctaEl = container.querySelector('.ss-cta');
    if (ctaEl) {
      var handler = function (ev) {
        ev.preventDefault();
        handleCta(ctaEl.dataset.fwCtaTarget, services);
      };
      ctaEl.addEventListener('click', handler);
      listeners.push({ el: ctaEl, evt: 'click', fn: handler });
    }

    // Inline product card (optional). Uses the same shared card helper
    // so it matches the catalogue visually, and the inline size grid lets
    // the rep add quantities without a modal.
    if (inlineId && supa && cart && cart.renderProductCard) {
      var prodRes = await supa.from('products')
                              .select('id, sku, base_sku, name:product_name, sizes:available_sizes, width, exclusive, silo, energy, colour, is_new, is_top_seller, aud_ws_price, aud_rrp_price, nzd_ws_price, nzd_rrp_price')
                              .eq('id', inlineId)
                              .single();
      if (!prodRes.error && prodRes.data) {
        var p = prodRes.data;
        var holder = container.querySelector('#ss-inline-product');
        holder.innerHTML = cart.renderProductCard(p);
        var card = holder.querySelector('.pcard');
        if (card) cart.wireProductCard(card, p);
      }
    }

    return function cleanup() {
      listeners.forEach(function (l) {
        try { l.el.removeEventListener(l.evt, l.fn); } catch (e) { /* node may be gone */ }
      });
      var v = container.querySelector('video.ss-media');
      if (v) {
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
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
    window.fwApp.slideRenderer.register('split_story', render);
  }
})();
