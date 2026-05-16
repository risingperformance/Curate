// ─── AW27 Footwear Prebook: top-level controller ───────────────────────────
//
// Loaded last (after questionnaire.js, reorder.js, deck.js). Each view file
// registers a renderer on window.fwApp.views; this file installs the rest
// of the API (Supabase client, state, helpers, view dispatch) and kicks
// off the auth flow.
//
// Phase C1 ships authentication and the questionnaire view + draft
// persistence. Phase C2 adds reorder. Phase C3 adds the deck, the five
// template renderers, the cart, and email submission.

(function () {
  'use strict';

  window.fwApp       = window.fwApp || {};
  window.fwApp.views = window.fwApp.views || {};

  // ── Supabase ────────────────────────────────────────────────────────────
  if (!window.__SUPABASE_CONFIG) {
    console.error('footwear: window.__SUPABASE_CONFIG missing. ' +
                  'Did supabase-init.js fail to load?');
    return;
  }
  var SUPA_URL = window.__SUPABASE_CONFIG.url;
  var SUPA_KEY = window.__SUPABASE_CONFIG.key;
  var supa     = window.supabase.createClient(SUPA_URL, SUPA_KEY);

  // Footwear shares the apparel form's send-order-email edge function.
  // Both POST { subject, html } and Brevo sends to the configured
  // ORDER_RECIPIENT. Saves us a separate footwear-specific function.
  var EMAIL_EDGE_FN = SUPA_URL + '/functions/v1/send-order-email';

  // ── State ───────────────────────────────────────────────────────────────
  // Session-scoped. Survives view transitions; cleared on sign out.
  var state = {
    currentUser:           null,            // { name, email, role, country }
    activeDraftId:         null,            // footwear_drafts.id once inserted
    activeShareToken:      null,            // footwear_drafts.share_token
    questionnaireAnswers:  {},              // { question_key: [option_id, ...] }
    slideOrder:            [],              // resolved deck after rules
    excludedSlideIds:      [],              // slides removed by rules or by user
    cartItems:             [],              // [{ product_id, size, width, quantity }]
    activeView:            null,            // 'questionnaire' | 'reorder' | 'deck' | 'catalogue' | 'summary'

    // ── Section 5 fields ──────────────────────────────────────────────────
    reviewMode:            false,           // true when the URL is #review={token}
    preloadedSlides:       null,            // { id: slide_row } cache used by deck.js when reviewMode (unauth can't query footwear_slides directly)
    preloadedProducts:     null,            // { id: product_row } cache used by cart.js review summary
    preloadedSlideProducts:null,            // { slide_id: [ {product_id, display_order}, ... ] } cache for the strip in review mode

    // ── Slide product strip (Phase 2) ─────────────────────────────────────
    flags:                 { slideStrip: false }, // populated at boot from window.__FW_FLAGS plus URL/localStorage overrides
    currentSlideProducts:  [],              // products attached to the slide currently visible in the deck (full rows, sorted by display_order)
    currentSlideStripBehavior: 'auto',      // 'auto' | 'hidden'; written by deck.js per slide; consumed by cart.paintSummary (Phase 4)

    // ── Customer picker (top of questionnaire) ────────────────────────────
    customer:              null,            // { account_code, account_name, account_manager, city, state, contact_email, ... } snapshot
    customers:             null,            // cached customer list for the autocomplete (loaded once per session)

    // ── Season (set from #season= URL hash; defaults to AW27-shoe) ────────
    seasonId:              null,
  };

  // Read #season= from the URL hash so the catalogue can scope its queries
  // to the right footwear season. Set by the root landing's selectSeason
  // when a footwear season is picked.
  (function readSeason() {
    var m = /[#&]season=([^&]+)/.exec(window.location.hash || '');
    state.seasonId = m ? decodeURIComponent(m[1]) : 'AW27-shoe';
  })();

  // ── Feature flags ────────────────────────────────────────────────────────
  // Defaults come from window.__FW_FLAGS in supabase-init.js. Two overrides
  // can flip flags without redeploy:
  //   URL hash:     append &strip=1 or &strip=0 (force on/off)
  //   localStorage: localStorage.setItem('fw.flags.slideStrip', '1' | '0')
  // The URL hash wins over localStorage, which wins over the default.
  (function readFlags() {
    var def = (window.__FW_FLAGS && window.__FW_FLAGS.slideStrip) || false;
    var ls  = null;
    try { ls = localStorage.getItem('fw.flags.slideStrip'); } catch (e) { /* private mode */ }
    var hash = window.location.hash || '';
    var hashStrip = /[#&]strip=([01])/.exec(hash);

    var on = !!def;
    if (ls === '1') on = true;
    if (ls === '0') on = false;
    if (hashStrip) on = hashStrip[1] === '1';

    state.flags.slideStrip = on;
    if (on) console.info('[fw] slideStrip flag is ON');
  })();

  // ── Helpers ─────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(str) { return escapeHtml(str).replace(/"/g, '&quot;'); }

  function toast(msg, type) {
    type = type || 'info';
    var root = document.getElementById('toast-container');
    if (!root) { console.log('[' + type + '] ' + msg); return; }
    var t = document.createElement('div');
    t.className   = 'toast ' + type;
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(function () { t.remove(); }, 4500);
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  // Login + season picking live at the root /index.html. This form expects
  // an existing Supabase session; checkExistingSession bounces unsigned-in
  // visitors back to root. The hidden #login-screen placeholder still
  // exists in the HTML so element-by-id lookups elsewhere don't NPE.
  var screen = document.getElementById('login-screen');

  // Read the URL hash and decide which mode the form should boot in.
  // Hash forms:
  //   #review={token}  - unauthenticated customer review (read-only deck)
  //   #draft={token}   - authenticated rep resuming an existing draft
  //   anything else    - normal sign-in then start a new questionnaire
  function detectMode() {
    var hash = window.location.hash || '';
    var review = /[#&]review=([^&]+)/.exec(hash);
    if (review) return { mode: 'review', token: decodeURIComponent(review[1]) };
    var draft  = /[#&]draft=([^&]+)/.exec(hash);
    if (draft)  return { mode: 'draft',  token: decodeURIComponent(draft[1])  };
    return { mode: 'normal' };
  }

  async function checkExistingSession(opts) {
    opts = opts || {};
    try {
      var resp = await supa.auth.getSession();
      var session = resp && resp.data && resp.data.session;
      if (session) {
        await loginWithSession(session, opts);
        return;
      }
      // No session: bounce to root /index.html for login. The shared
      // Supabase auth session means the user only logs in once for the
      // whole site.
      var ret = encodeURIComponent(window.location.pathname + (window.location.hash || ''));
      window.location.replace('../index.html#return=' + ret);
    } catch (e) {
      window.location.replace('../index.html');
    }
  }

  async function loginWithSession(session, opts) {
    opts = opts || {};
    var userEmail = session.user.email;
    var lookup = await supa
      .from('salespeople')
      .select('name, email, role, country')
      .eq('email', userEmail)
      .single();
    var sp    = lookup.data;
    var error = lookup.error;

    if (error || !sp) {
      // Authenticated but no salesperson record. Send them to root with
      // an error flag so the root can show the right message.
      await supa.auth.signOut();
      window.location.replace('../index.html#error=not_linked');
      return;
    }

    state.currentUser = {
      name:    sp.name    || '',
      email:   sp.email   || userEmail,
      role:    sp.role    || 'rep',
      country: sp.country || null,
    };

    var headerUserEl = document.getElementById('header-user');
    if (headerUserEl) headerUserEl.textContent = state.currentUser.name || state.currentUser.email;
    document.getElementById('app-header').hidden = false;
    document.getElementById('app-main').hidden   = false;

    if (opts.resumeToken) {
      await resumeDraftAsRep(opts.resumeToken);
    } else {
      setView('questionnaire');
    }
  }

  // Rep follows a #draft={token} link. They must be authenticated; their
  // RLS policy allows reading their own draft (created_by = auth.uid())
  // and the admin SELECT policy allows admin reps to read any draft.
  async function resumeDraftAsRep(token) {
    var res = await supa.from('footwear_drafts')
                        .select('*')
                        .eq('share_token', token)
                        .maybeSingle();
    if (res.error) {
      toast('Could not load that draft: ' + (res.error.message || ''), 'error');
      setView('questionnaire');
      return;
    }
    if (!res.data) {
      toast('Draft not found or you do not have access. Starting a new questionnaire.', 'error');
      setView('questionnaire');
      return;
    }
    populateStateFromDraft(res.data);
    pickViewForResumedDraft();
  }

  // Customer follows a #review={token} link. Anonymous flow via the
  // SECURITY DEFINER RPC from migration 0011. No login screen at all.
  async function bootstrapReviewMode(token) {
    state.reviewMode = true;
    state.activeShareToken = token;
    document.body.classList.add('fw-mode-review');

    // Hide the login screen up front; we'll either show the app or an
    // inline error card on top.
    if (screen) screen.style.display = 'none';

    var rpc = await supa.rpc('get_footwear_review_payload', { p_token: token });
    if (rpc.error) {
      showReviewError('Could not load that link. Please check the URL or ask your sales rep for a fresh one.');
      return;
    }
    if (!rpc.data) {
      showReviewError('That link is no longer valid. Please ask your sales rep for a fresh one.');
      return;
    }

    var payload = rpc.data;
    var draft   = payload.draft || {};
    populateStateFromDraft(draft);

    // Cache slides and products by id so deck.js and the summary view can
    // skip RLS-restricted SELECTs that anonymous users cannot run.
    state.preloadedSlides   = {};
    (payload.slides   || []).forEach(function (s) { state.preloadedSlides[s.id]   = s; });
    state.preloadedProducts = {};
    (payload.products || []).forEach(function (p) { state.preloadedProducts[p.id] = p; });

    // Slide-level product attachments for the deck strip (Phase 2). The RPC
    // returns a flat array of {slide_id, product_id, display_order}; group
    // it by slide_id so deck.js can resolve the current slide quickly.
    state.preloadedSlideProducts = {};
    (payload.slide_products || []).forEach(function (sp) {
      if (!state.preloadedSlideProducts[sp.slide_id]) state.preloadedSlideProducts[sp.slide_id] = [];
      state.preloadedSlideProducts[sp.slide_id].push(sp);
    });

    var headerUserEl = document.getElementById('header-user');
    if (headerUserEl) headerUserEl.textContent = 'Customer review';
    var signoutBtn = document.getElementById('signout-btn');
    if (signoutBtn) signoutBtn.hidden = true;

    document.getElementById('app-header').hidden = false;
    document.getElementById('app-main').hidden   = false;

    // The customer always lands on the deck. After the last slide they
    // can hit "Review summary" which transitions to the summary view.
    if ((state.slideOrder || []).length > 0) {
      setView('deck');
    } else {
      setView('summary');
    }
  }

  function showReviewError(msg) {
    var main = document.getElementById('app-main');
    document.getElementById('app-header').hidden = false;
    main.hidden = false;
    main.innerHTML = ''
      + '<div class="placeholder-card">'
      +   '<div class="placeholder-card-title">Link unavailable</div>'
      +   '<p class="placeholder-card-body">' + escapeHtml(msg) + '</p>'
      + '</div>';
  }

  function populateStateFromDraft(d) {
    state.activeDraftId        = d.id        || null;
    state.activeShareToken     = d.share_token || state.activeShareToken;
    state.questionnaireAnswers = d.questionnaire_answers || {};
    state.slideOrder           = d.slide_order           || [];
    state.excludedSlideIds     = d.excluded_slide_ids    || [];
    state.cartItems            = d.cart_items            || [];
    state.customer             = d.customer_data         || null;
  }

  // ── Customer autocomplete ─────────────────────────────────────────────
  // Lazy-load the customer list the first time the rep opens the
  // questionnaire. Cached on state.customers so subsequent renders are
  // instant. The customers table is keyed by account_code (text); we
  // pull every column the picker needs.
  async function loadCustomers() {
    if (state.customers) return state.customers;
    // The customers table has a capital-G "Group" column (CREATE TABLE
    // quoted it). PostgREST returns it lowercase as 'group' on the row,
    // but you must request it quoted on the wire. We surface it as
    // .group on the in-memory record so the submit flow can write it
    // back onto footwear_drafts.customer_group without re-fetching.
    var res = await supa.from('customers')
                        .select('account_code, account_name, account_manager, contact_email, state, city, address_1, address_2, postcode, cma_key, "Group"')
                        .order('account_name', { ascending: true });
    if (res.error) {
      toast('Could not load customers: ' + (res.error.message || ''), 'error');
      return [];
    }
    state.customers = (res.data || []).map(function (r) {
      return {
        account_code:    r.account_code,
        account_name:    r.account_name || '',
        account_manager: r.account_manager || '',
        contact_email:   r.contact_email || '',
        city:            r.city || '',
        state:           r.state || '',
        cma_key:         r.cma_key || r.account_code,
        group:           r.Group || r.group || '',
        address:         [r.address_1, r.address_2, r.city, r.state, r.postcode]
                          .filter(Boolean).join(', '),
      };
    });
    return state.customers;
  }

  // Filter the cached list by name / account code / city. Returns at
  // most `limit` matches, ranked by start-of-string match first.
  function filterCustomers(query, limit) {
    if (!state.customers) return [];
    limit = limit || 12;
    var q = (query || '').trim().toLowerCase();
    if (!q) return state.customers.slice(0, limit);
    var startsWith = [];
    var contains   = [];
    for (var i = 0; i < state.customers.length; i++) {
      var c = state.customers[i];
      var name = (c.account_name || '').toLowerCase();
      var code = (c.account_code || '').toLowerCase();
      var city = (c.city         || '').toLowerCase();
      if (name.indexOf(q) === 0 || code.indexOf(q) === 0) startsWith.push(c);
      else if (name.indexOf(q) >= 0 || code.indexOf(q) >= 0 || city.indexOf(q) >= 0) contains.push(c);
      if (startsWith.length + contains.length > limit + 5) break;
    }
    return startsWith.concat(contains).slice(0, limit);
  }

  function pickViewForResumedDraft() {
    if ((state.cartItems   || []).length > 0) { setView('deck');          return; }
    if ((state.slideOrder  || []).length > 0) { setView('reorder');       return; }
    setView('questionnaire');
  }

  async function signOut() {
    await supa.auth.signOut();
    // The root /index.html re-shows the sign-in screen. Don't bother
    // resetting state -- this page is about to be navigated away from.
    window.location.replace('../index.html');
  }

  // Restart the form from the questionnaire after a submitted order.
  //
  // The naive approach (clear state, call setView('questionnaire')) does
  // not work because showSubmittedScreen() overwrites app-main's
  // innerHTML to render the submitted card, which wipes out the
  // view-questionnaire / view-deck / view-catalogue / view-summary
  // containers that setView() needs to toggle between. Trying to
  // rebuild that DOM in JS is fragile.
  //
  // Instead, reload the page to the same form with just the season
  // hash. The Supabase session is preserved in localStorage so the
  // rep stays signed in. Any draft= or review= token in the URL
  // hash is discarded so we don't resume into the just-submitted
  // draft. The form remounts at its initial state, which is the
  // questionnaire.
  function resetForNewOrder() {
    var url = window.location.pathname;
    if (state.seasonId) url += '#season=' + encodeURIComponent(state.seasonId);
    window.location.assign(url);
  }

  // ── View dispatch ───────────────────────────────────────────────────────
  var ALL_VIEWS = ['questionnaire', 'reorder', 'deck', 'catalogue', 'summary'];
  // Views that mount the cart and want the apparel-style fixed footer.
  // Other views hide it so questionnaire/reorder/summary keep their
  // un-cropped vertical canvas.
  var FOOTER_VIEWS = { deck: true, catalogue: true };

  function setView(viewName) {
    // Close the slide product strip drawer (Phase 2) when leaving the deck;
    // it has no business hovering above any other view. close() is a no-op
    // if the drawer was never opened.
    if (state.activeView === 'deck' && viewName !== 'deck' &&
        window.fwApp.slideStrip && typeof window.fwApp.slideStrip.close === 'function') {
      window.fwApp.slideStrip.close();
    }

    state.activeView = viewName;
    ALL_VIEWS.forEach(function (v) {
      var el = document.getElementById('view-' + v);
      if (el) el.hidden = (v !== viewName);
    });

    var footer = document.getElementById('fw-app-footer');
    if (footer) {
      var show = !!FOOTER_VIEWS[viewName];
      footer.hidden = !show;
      document.body.classList.toggle('fw-footer-visible', show);
    }

    var renderer = window.fwApp.views[viewName];
    if (typeof renderer === 'function') {
      renderer();
    } else {
      console.warn('No renderer registered for view: ' + viewName);
    }

    // Repaint the footer once the new view has mounted so the stats
    // (customer name, counts, action cluster) are in sync.
    if (window.fwApp.cart && typeof window.fwApp.cart.paintSummary === 'function') {
      window.fwApp.cart.paintSummary();
    }
  }

  // ── Draft persistence ───────────────────────────────────────────────────
  // First call inserts a row (DB generates id and share_token via defaults);
  // subsequent calls update the same row by id. RLS lets the rep INSERT and
  // UPDATE only their own drafts (via created_by = auth.uid() in 0006).
  //
  // Dedupe rule (mirrors the apparel form): when starting a new draft for
  // a customer who already has one for this season, delete the old draft
  // before inserting. RLS scopes DELETE to the rep's own rows, so we only
  // ever clear our own duplicates.
  //
  // Insert gate: a brand-new draft is only created once the rep has both
  // (a) selected a customer and (b) added at least one unit to the cart.
  // Updates to an existing draft are always allowed (so deleting items
  // back to zero doesn't lose the draft, and submission status changes
  // can flow regardless of cart state).
  function canSaveDraft() {
    var hasCustomer = !!(state.customer && state.customer.account_code);
    var unitCount = (Array.isArray(state.cartItems) ? state.cartItems : [])
      .reduce(function (sum, it) { return sum + (Number(it.quantity) || 0); }, 0);
    if (!hasCustomer) return { ok: false, reason: 'no-customer' };
    if (unitCount === 0) return { ok: false, reason: 'no-units' };
    return { ok: true };
  }

  async function persistDraft(updates) {
    if (state.activeDraftId) {
      var upRes = await supa
        .from('footwear_drafts')
        .update(updates)
        .eq('id', state.activeDraftId);
      return { error: upRes.error };
    }

    // INSERT path: silent no-op if the gate isn't satisfied. Returning
    // an empty success keeps every caller's success path simple; the
    // skipped flag is available to UI consumers that care (handleSave).
    var gate = canSaveDraft();
    if (!gate.ok) return { error: null, skipped: true, reason: gate.reason };

    var seasonId    = state.seasonId || 'AW27-shoe';
    var accountCode = state.customer && state.customer.account_code;
    if (accountCode) {
      // Sweep any prior drafts the rep has for this season + customer.
      // Errors here are non-fatal (worst case, we end up with two drafts);
      // the insert below proceeds either way.
      try {
        await supa.from('footwear_drafts')
          .delete()
          .eq('season_id', seasonId)
          .eq('status', 'draft')
          .filter('customer_data->>account_code', 'eq', accountCode);
      } catch (e) { /* ignore */ }
    }

    // First save -> insert. Don't pass created_by; the BEFORE trigger
    // (footwear_drafts_audit) sets it to auth.uid(). Tag the draft with
    // the current season so the season-picker landing can bucket it.
    var insertPayload = Object.assign(
      { status: 'draft', season_id: seasonId },
      updates
    );
    var insRes = await supa
      .from('footwear_drafts')
      .insert(insertPayload)
      .select('id, share_token')
      .single();
    if (insRes.error) return { error: insRes.error };
    if (insRes.data) {
      state.activeDraftId    = insRes.data.id;
      state.activeShareToken = insRes.data.share_token;
    }
    return { error: null };
  }

  // Login UI lives at the root /index.html, so there is no form to wire up
  // here. The signout button still hooks the local signOut helper which
  // signs out and navigates back to root.
  document.getElementById('signout-btn').addEventListener('click', signOut);

  // ── Header hamburger menu ────────────────────────────────────────────────
  function toggleHeaderMenu() {
    var menu = document.getElementById('header-menu');
    var btn  = document.getElementById('header-menu-btn');
    if (!menu || !btn) return;
    if (menu.hidden) {
      // Populate profile fields from current user / customer.
      var u = state.currentUser || {};
      var nameEl  = document.getElementById('header-menu-profile-name');
      var emailEl = document.getElementById('header-menu-profile-email');
      if (nameEl)  nameEl.textContent  = u.name  || 'Signed in';
      if (emailEl) emailEl.textContent = u.email || '-';
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    } else {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  }
  function closeHeaderMenu() {
    var menu = document.getElementById('header-menu');
    var btn  = document.getElementById('header-menu-btn');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // Click handlers on the trigger and items.
  var menuBtn = document.getElementById('header-menu-btn');
  if (menuBtn) menuBtn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    toggleHeaderMenu();
  });
  var menuEl = document.getElementById('header-menu');
  if (menuEl) {
    menuEl.querySelectorAll('[data-fw-menu]').forEach(function (item) {
      item.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var act = item.getAttribute('data-fw-menu');
        closeHeaderMenu();
        if (act === 'back-to-seasons') {
          window.location.assign('../index.html');
        } else if (act === 'save') {
          if (window.fwApp.cart && typeof window.fwApp.cart.handleSave === 'function') {
            window.fwApp.cart.handleSave();
          }
        } else if (act === 'clear') {
          if (window.fwApp.cart && typeof window.fwApp.cart.handleClear === 'function') {
            window.fwApp.cart.handleClear();
          }
        } else if (act === 'sign-out') {
          signOut();
        }
      });
    });
  }
  // Close on outside click + Escape.
  document.addEventListener('click', function (ev) {
    var menu = document.getElementById('header-menu');
    if (!menu || menu.hidden) return;
    if (ev.target.closest('#header-menu') || ev.target.closest('#header-menu-btn')) return;
    closeHeaderMenu();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeHeaderMenu();
  });

  // ── Public API exposed to view modules ──────────────────────────────────
  window.fwApp.supa             = supa;
  window.fwApp.state            = state;
  window.fwApp.escapeHtml       = escapeHtml;
  window.fwApp.escapeAttr       = escapeAttr;
  window.fwApp.toast            = toast;
  window.fwApp.setView          = setView;
  window.fwApp.persistDraft     = persistDraft;
  window.fwApp.canSaveDraft     = canSaveDraft;
  window.fwApp.signOut          = signOut;
  window.fwApp.resetForNewOrder = resetForNewOrder;
  window.fwApp.EMAIL_EDGE_FN    = EMAIL_EDGE_FN;
  window.fwApp.loadCustomers    = loadCustomers;
  window.fwApp.filterCustomers  = filterCustomers;

  // ── Kick off ────────────────────────────────────────────────────────────
  // Script tag is at the end of <body>, so the DOM exists. No
  // DOMContentLoaded wait needed.
  var modeInfo = detectMode();
  if (modeInfo.mode === 'review') {
    bootstrapReviewMode(modeInfo.token);
  } else if (modeInfo.mode === 'draft') {
    checkExistingSession({ resumeToken: modeInfo.token });
  } else {
    checkExistingSession();
  }
})();
