// ─── Template: heading_with_media ──────────────────────────────────────────
//
// Top-aligned heading in heavy bold uppercase, with a single image or
// video filling the rest of the slide below it. Matches the wireframe
// for "AEONIK FONT - 100 CHARACTERS" (single media variant).
//
// Content slots:
//   - title       (required)
//   - media_url   (required)
//   - media_type  (required: 'image' | 'video')
//
// Title is rendered uppercase via CSS so authors can write Title Case in
// the admin and the slide will still match the wireframe.

(function () {
  'use strict';

  function render(content, services, container) {
    var ehtml = services.escapeHtml || defaultEscapeHtml;
    var eattr = services.escapeAttr || defaultEscapeAttr;

    var title     = content.title      || '';
    var mediaUrl  = content.media_url  || '';
    var mediaType = content.media_type || 'image';

    var mediaHtml = '';
    if (mediaType === 'video' && mediaUrl) {
      mediaHtml = ''
        + '<video class="hwm-media" controls playsinline preload="metadata"'
        + ' src="' + eattr(mediaUrl) + '"></video>';
    } else if (mediaUrl) {
      mediaHtml = '<img class="hwm-media" alt="" src="' + eattr(mediaUrl) + '">';
    } else {
      mediaHtml = '<div class="hwm-media hwm-media-empty">No media set.</div>';
    }

    container.innerHTML = ''
      + '<div class="hwm">'
      +   '<div class="hwm-title">' + ehtml(title) + '</div>'
      +   '<div class="hwm-media-wrap">' + mediaHtml + '</div>'
      + '</div>';

    var video = container.querySelector('video.hwm-media');
    return function cleanup() {
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
    window.fwApp.slideRenderer.register('heading_with_media', render);
  }
})();
