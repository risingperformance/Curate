// ─── Slide renderer ────────────────────────────────────────────────────────
//
// Each template module registers a render function under its
// template_key. deck.js calls renderSlide(slide, container, services)
// which dispatches to the registered template, passing the slide's
// content payload and a small services object (cart, toast, nav).
//
// Templates return either nothing or a cleanup function that the
// renderer invokes when the slide is unmounted (e.g. when the user
// navigates to the next slide). This is the only required contract;
// templates are otherwise black boxes.
//
// Section 4.4 of the AW27 footwear brief.

(function () {
  'use strict';

  window.fwApp = window.fwApp || {};

  var registry = {};   // template_key -> render fn

  function register(templateKey, renderFn) {
    if (typeof templateKey !== 'string' || !templateKey) {
      console.error('slide-renderer: register called without a template_key.');
      return;
    }
    if (typeof renderFn !== 'function') {
      console.error('slide-renderer: render fn for ' + templateKey + ' is not a function.');
      return;
    }
    registry[templateKey] = renderFn;
  }

  function has(templateKey) { return Object.prototype.hasOwnProperty.call(registry, templateKey); }

  // Render a slide into a target container. Returns a cleanup function;
  // callers MUST call it before mounting another slide so the previous
  // template can release event listeners, pause videos, etc.
  function renderSlide(slide, container, services) {
    if (!container) return function noop() {};

    container.innerHTML = '';
    container.className = 'deck-slide';
    if (slide && slide.template_key) {
      container.classList.add('tpl-' + slide.template_key);
    }

    var renderFn = slide && registry[slide.template_key];
    if (typeof renderFn !== 'function') {
      container.innerHTML = ''
        + '<div class="deck-slide-fallback">'
        +   '<div class="deck-slide-fallback-title">Template not available</div>'
        +   '<p class="deck-slide-fallback-body">'
        +     'No renderer is registered for template <code>'
        +     escapeText(slide ? slide.template_key : '(missing)')
        +     '</code>. Skip to the next slide.'
        +   '</p>'
        + '</div>';
      return function noop() {};
    }

    var content = (slide && slide.content) || {};
    try {
      var maybeCleanup = renderFn(content, services || {}, container, slide);
      return typeof maybeCleanup === 'function' ? maybeCleanup : function noop() {};
    } catch (e) {
      console.error('slide-renderer: template ' + slide.template_key + ' threw during render.', e);
      container.innerHTML = ''
        + '<div class="deck-slide-fallback">'
        +   '<div class="deck-slide-fallback-title">Could not render this slide</div>'
        +   '<p class="deck-slide-fallback-body">'
        +     escapeText((e && e.message) || 'Template error.')
        +   '</p>'
        + '</div>';
      return function noop() {};
    }
  }

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  window.fwApp.slideRenderer = {
    register:    register,
    has:         has,
    renderSlide: renderSlide,
    keys:        function () { return Object.keys(registry); },
  };
})();
