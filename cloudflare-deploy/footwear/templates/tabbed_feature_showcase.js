// ─── Template: tabbed_feature_showcase ─────────────────────────────────────
//
// Top tab nav with up to three tabs. Each tab has a hero image, an
// optional sidebar of click-to-swap items, and an optional media grid.
// Content slot:
//   - tabs (required, array of objects)
//       label, hero_url, sidebar_items?, media_grid?
//
// Internal state:
//   - active tab index
//   - within an active tab, an "active sidebar item" can swap the hero
//     to that item's target_url

(function () {
  'use strict';

  function render(content, services, container) {
    var ehtml = services.escapeHtml || defaultEscapeHtml;
    var eattr = services.escapeAttr || defaultEscapeAttr;

    var tabs = Array.isArray(content.tabs) ? content.tabs : [];
    var state = {
      activeTabIdx:     0,
      heroOverrideByTab: {}, // tabIdx -> url override from a sidebar click
      activeSidebarBy:  {},  // tabIdx -> sidebar item idx
    };

    var listeners = [];

    function paint() {
      if (tabs.length === 0) {
        container.innerHTML = '<div class="tfs-empty">No tabs configured.</div>';
        return;
      }
      var tab = tabs[state.activeTabIdx] || tabs[0];

      var heroUrl = state.heroOverrideByTab[state.activeTabIdx] || tab.hero_url || '';
      var sidebarItems = Array.isArray(tab.sidebar_items) ? tab.sidebar_items : [];
      var mediaGrid    = Array.isArray(tab.media_grid)    ? tab.media_grid    : [];
      var activeSidebar = state.activeSidebarBy[state.activeTabIdx];

      var tabsNav = tabs.map(function (t, i) {
        return '<button class="tfs-tab' + (i === state.activeTabIdx ? ' tfs-tab-active' : '') + '"'
             + ' data-fw-tab-idx="' + i + '">'
             + ehtml(t.label || ('Tab ' + (i + 1)))
             + '</button>';
      }).join('');

      var sidebarHtml = sidebarItems.length > 0
        ? '<aside class="tfs-sidebar">' + sidebarItems.map(function (item, i) {
            var cls = 'tfs-sb-item' + (activeSidebar === i ? ' tfs-sb-item-active' : '');
            return '<button class="' + cls + '" data-fw-sb-idx="' + i + '">'
                 + '<div class="tfs-sb-label">' + ehtml(item.label || '') + '</div>'
                 + (item.caption ? '<div class="tfs-sb-caption">' + ehtml(item.caption) + '</div>' : '')
                 + '</button>';
          }).join('') + '</aside>'
        : '';

      var mediaHtml = mediaGrid.length > 0
        ? '<div class="tfs-media-grid">' + mediaGrid.map(function (m) {
            if (!m || !m.url) return '';
            if (m.type === 'video') {
              return '<div class="tfs-media-cell"><video controls playsinline src="' + eattr(m.url) + '"></video>'
                   + (m.caption ? '<div class="tfs-media-caption">' + ehtml(m.caption) + '</div>' : '')
                   + '</div>';
            }
            return '<div class="tfs-media-cell"><img alt="" src="' + eattr(m.url) + '">'
                 + (m.caption ? '<div class="tfs-media-caption">' + ehtml(m.caption) + '</div>' : '')
                 + '</div>';
          }).join('') + '</div>'
        : '';

      var heroHtml = heroUrl
        ? '<img class="tfs-hero" alt="" src="' + eattr(heroUrl) + '">'
        : '<div class="tfs-hero tfs-hero-empty">No hero image.</div>';

      container.innerHTML = ''
        + '<div class="tfs">'
        +   '<nav class="tfs-tabs">' + tabsNav + '</nav>'
        +   '<div class="tfs-body">'
        +     sidebarHtml
        +     '<div class="tfs-stage">'
        +       heroHtml
        +       mediaHtml
        +     '</div>'
        +   '</div>'
        + '</div>';

      // Wire tab buttons
      container.querySelectorAll('[data-fw-tab-idx]').forEach(function (btn) {
        var handler = function () {
          var idx = parseInt(btn.dataset.fwTabIdx, 10);
          if (isNaN(idx) || idx === state.activeTabIdx) return;
          state.activeTabIdx = idx;
          paint();
        };
        btn.addEventListener('click', handler);
        listeners.push({ el: btn, evt: 'click', fn: handler });
      });

      // Wire sidebar items: click swaps the hero to the item's target_url
      container.querySelectorAll('[data-fw-sb-idx]').forEach(function (btn) {
        var handler = function () {
          var i = parseInt(btn.dataset.fwSbIdx, 10);
          if (isNaN(i)) return;
          var item = sidebarItems[i];
          state.activeSidebarBy[state.activeTabIdx] = i;
          state.heroOverrideByTab[state.activeTabIdx] = (item && item.target_url) || tab.hero_url || '';
          paint();
        };
        btn.addEventListener('click', handler);
        listeners.push({ el: btn, evt: 'click', fn: handler });
      });
    }

    paint();

    return function cleanup() {
      listeners.forEach(function (l) {
        try { l.el.removeEventListener(l.evt, l.fn); } catch (e) { /* node may be gone */ }
      });
      // Pause any videos in the media grid
      container.querySelectorAll('video').forEach(function (v) {
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
      });
    };
  }

  function defaultEscapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function defaultEscapeAttr(s) { return defaultEscapeHtml(s).replace(/"/g, '&quot;'); }

  if (window.fwApp && window.fwApp.slideRenderer) {
    window.fwApp.slideRenderer.register('tabbed_feature_showcase', render);
  }
})();
