// ── Early draft link detection (runs synchronously before any async work) ──
// If URL contains #draft=, immediately hide login screen and show loading bar.
// This runs as soon as the script is parsed - no DOMContentLoaded wait needed
// because the script tag is at the end of <body>, after these elements exist.
(function() {
  var hash = window.location.hash || '';
  var hasDraft = hash.indexOf('draft=') !== -1;
  var hasFromDashboard = hash.indexOf('from=dashboard') !== -1;
  if (hasDraft) {
    var ls = document.getElementById('login-screen');
    var dl = document.getElementById('draft-loading-screen');
    if (ls) ls.style.display = 'none';
    if (dl) dl.style.display = '';
    // Mark the page as a draft link view. CSS handles hiding the Share button.
    document.body.classList.add('draft-link');
  }
})();

// ── Read season from URL hash ───────────────────────────────────────────────
// The root landing page sets #season=<id> when redirecting here. Setting
// window._selectedSeason early lets loadReferenceData scope its queries
// without requiring the user to pick a season again on this page.
(function readSeasonFromHash() {
  var m = /[#&]season=([^&]+)/.exec(window.location.hash || '');
  if (m) window._selectedSeason = decodeURIComponent(m[1]);
})();

// ── Session check promise: init() will await this to avoid race conditions ──
var _sessionReady;
var sessionCheckDone = new Promise(function(resolve) { _sessionReady = resolve; });

// ── Auth gate: this form runs only for signed-in users ──────────────────────
// Login + season picking live at the root /index.html. Anyone landing here
// without a session is bounced back so they can sign in there. Once a session
// exists we resolve the salesperson record and reveal the form chrome.
(function() {
  document.addEventListener('DOMContentLoaded', async function() {
    try {
      const { data: { session } } = await supa.auth.getSession();
      if (!session) {
        var ret = encodeURIComponent(window.location.pathname + (window.location.hash || ''));
        window.location.replace('../index.html#return=' + ret);
        return;
      }

      // Resolve authenticated user to a salesperson row.
      var resp = await supa.from('salespeople')
        .select('*').eq('email', session.user.email).single();
      var sp = resp && resp.data;
      if (sp) {
        window.currentUser = {
          name:    sp.name || '',
          email:   sp.email || session.user.email,
          role:    sp.role || 'rep',
          country: sp.country || null
        };
      } else {
        // Authenticated but not linked to a salesperson -- send them back.
        await supa.auth.signOut();
        window.location.replace('../index.html#error=not_linked');
        return;
      }

      // Reveal the form chrome unless this is a draft link (in which case
      // init() will do the reveal once the loading bar completes).
      var isDraftLink = (window.location.hash || '').indexOf('draft=') !== -1;
      if (!isDraftLink) {
        var hdr = document.getElementById('app-header');
        var main = document.getElementById('app-main');
        var ftr = document.getElementById('app-footer');
        if (hdr)  hdr.style.display = '';
        if (main) main.style.display = '';
        if (ftr)  ftr.style.display = '';
      }
    } finally {
      // Signal to init() that the session check is complete.
      _sessionReady();
    }
  });
})();

async function signOut() {
  await supa.auth.signOut();
  window.currentUser = null;
  window.location.replace('../index.html');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPABASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = window.__SUPABASE_CONFIG.url;
const SUPABASE_ANON_KEY = window.__SUPABASE_CONFIG.key;

const { createClient } = window.supabase;
const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Email via Supabase Edge Function (API key stored server-side)
const EMAIL_EDGE_FN = SUPABASE_URL + '/functions/v1/send-order-email';

// ── XSS HELPERS ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeAttr(str) { return escapeHtml(String(str)).replace(/"/g, '&quot;'); }

// ═══════════════════════════════════════════════════════════════════════════════
// SEASON LANDING PAGE
// ═══════════════════════════════════════════════════════════════════════════════

const SEASONAL_IMG_BASE = 'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/seasonal-images/season-';

async function renderBookingDiaryCard() {
  const card    = document.getElementById('diary-card');
  const subEl   = document.getElementById('diary-head-sub');
  const ctaEl   = document.getElementById('diary-head-cta');
  const listEl  = document.getElementById('diary-list');
  if (!card || !subEl || !listEl) return;

  const cu = window.currentUser || {};
  const isAdminUser = (cu.role === 'admin');
  const myName  = (cu.name  || '').trim();
  const myEmail = (cu.email || '').trim();

  // Signal to diary that we're coming from prebook (session-based auth,
  // no credentials in URL). Supabase Auth session is shared via localStorage.
  ctaEl.href = 'appointment-diary.html?from=prebook';

  // Pull upcoming bookings for this AM (or all bookings if admin)
  const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let q = supa
    .from('appointment_bookings')
    .select('*')
    .gte('date', todayIso)
    .order('date', { ascending: true })
    .order('start_time', { ascending: true })
    .limit(5);
  if (!isAdminUser && myName) q = q.eq('am_name', myName);

  const { data: bookings, error } = await q;

  if (error) {
    subEl.textContent = 'No upcoming appointments scheduled';
    listEl.innerHTML = '';
    return;
  }

  if (!bookings || bookings.length === 0) {
    subEl.textContent = isAdminUser
      ? 'No upcoming appointments across the team'
      : 'No upcoming appointments scheduled';
    listEl.innerHTML = '';
    return;
  }

  subEl.textContent = bookings.length + ' upcoming retailer appointment' + (bookings.length === 1 ? '' : 's');

  const fmtDay = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtTime = t => {
    if (!t) return '';
    const [h, m] = t.split(':');
    const hr = parseInt(h, 10);
    const ampm = hr >= 12 ? 'PM' : 'AM';
    const hh = ((hr + 11) % 12) + 1;
    return hh + ':' + (m || '00') + ' ' + ampm;
  };
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  listEl.innerHTML = bookings.map(b => {
    const person   = b.contact_name || b.customer_contact || b.contact_first || 'Customer';
    const account  = b.account_name || b.customer_name || '—';
    const location = b.location || b.meeting_location || (b.location_type === 'onsite' ? 'On-site' : 'Showroom');
    return `
      <li>
        <div class="diary-when"><span class="day">${esc(fmtDay(b.date))}</span><span class="time">${esc(fmtTime(b.start_time))}</span></div>
        <div class="diary-person">${esc(person)}</div>
        <div class="diary-account">${esc(account)}</div>
        <div class="diary-location">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${esc(location)}
        </div>
      </li>
    `;
  }).join('');
}

async function showSeasonLanding() {
  // If a season was passed via URL hash (#season=AW27 from the root landing),
  // skip the in-app landing and go straight to the form.
  if (window._selectedSeason) {
    const landing = document.getElementById('season-landing');
    if (landing) landing.style.display = 'none';
    document.getElementById('app-header').style.display = '';
    document.getElementById('app-main').style.display = '';
    document.getElementById('app-footer').style.display = '';
    loadCustomerDB();
    return;
  }

  const landing = document.getElementById('season-landing');
  landing.style.display = 'flex';

  // Render the booking diary card (uses currentUser if available)
  renderBookingDiaryCard();

  // Fetch active seasons (both apparel and footwear show on the landing;
  // footwear cards route to the footwear form when selected)
  const { data: seasons, error: sErr } = await supa
    .from('seasons')
    .select('*')
    .in('status', ['active', 'closed'])
    .order('start_date', { ascending: false });

  if (sErr || !seasons || seasons.length === 0) {
    // No seasons table or no rows — skip landing, go straight to form
    landing.style.display = 'none';
    return;
  }

  // Fetch full draft data
  const { data: drafts } = await supa
    .from('draft_orders')
    .select('*')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  // Filter drafts for the current user (admins / dev fallback see everything)
  const cu = window.currentUser || {};
  const isAdminUser = (cu.role === 'admin');
  const myName = (cu.name || '').trim().toLowerCase();
  const visibleDrafts = (drafts || []).filter(d => {
    if (isAdminUser) return true;
    const cd = d.customer_data || {};
    const am = (cd.manager || cd.account_manager || cd.am || cd.salesperson || '').trim().toLowerCase();
    return am && am === myName;
  });

  const draftsBySeason = {};
  visibleDrafts.forEach(d => {
    const sid = d.season_id || 'unknown';
    if (!draftsBySeason[sid]) draftsBySeason[sid] = [];
    const cd = d.customer_data || {};
    const od = d.order_data || {};
    const units = Object.values(od).reduce((sum, item) => {
      return sum + Object.values(item.sizes || {}).reduce((a, b) => a + b, 0);
    }, 0);
    draftsBySeason[sid].push({
      token: d.token,
      account: cd.customer || cd.account_name || cd.account || 'Unnamed',
      units,
      modified: d.created_at
    });
  });

  const container = document.getElementById('season-cards-container');
  container.innerHTML = seasons.map(s => {
    const isActive = s.status === 'active';
    const statusClass = isActive ? 'season-status-active' : 'season-status-closed';
    const statusLabel = isActive ? 'Open' : 'Closed';
    const imgUrl = SEASONAL_IMG_BASE + encodeURIComponent(s.season_id) + '.jpg';
    const seasonDrafts = draftsBySeason[s.season_id] || [];
    const dc = seasonDrafts.length;
    const endDate = s.end_date ? new Date(s.end_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const sid = s.season_id.replace(/'/g, "\\'");

    let draftsHtml = '';
    if (dc > 0) {
      const listItems = seasonDrafts.map(d => {
        const mod = d.modified ? new Date(d.modified).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
        return `
          <div class="season-draft-item">
            <div class="season-draft-info" data-action="openDraftFromLanding" data-token="${d.token}">
              <div class="season-draft-acct">${escapeHtml(d.account)}</div>
              <div class="season-draft-detail">${d.units} units &middot; ${mod}</div>
            </div>
            <button class="season-draft-delete" data-action="confirmDeleteDraft" data-token="${d.token}" data-account="${escapeAttr(d.account)}" title="Delete draft">&times;</button>
          </div>`;
      }).join('');

      draftsHtml = `
        <div class="season-card-drafts">
          <button class="season-draft-toggle" data-action="toggleDraftList" data-id="${sid}">
            <span class="season-draft-dot"></span>
            ${dc} draft${dc > 1 ? 's' : ''} in progress
            <span class="season-draft-arrow" id="draft-arrow-${sid}">&#9656;</span>
          </button>
          <div class="season-draft-list" id="draft-list-${sid}">
            ${listItems}
          </div>
        </div>`;
    }

    return `
      <div class="season-card${isActive ? '' : ' season-closed'}" ${isActive ? `data-action="selectSeason" data-id="${sid}" data-category="${escapeAttr(s.category || 'apparel')}"` : ''}>
        <div class="season-card-status ${statusClass}">${statusLabel}</div>
        <img class="season-card-image" src="${imgUrl}" alt="${escapeAttr(s.season_name)}" data-img-fallback="season" />
        <div class="season-card-body">
          <div class="season-card-name">${escapeHtml(s.season_name)}</div>
          <div class="season-card-category">${escapeHtml(s.category || 'Apparel')}</div>
          <div class="season-card-meta">
            <div class="season-meta-row">
              <span class="season-meta-label">Closes</span>
              <span class="season-meta-value">${endDate}</span>
            </div>
          </div>
          ${draftsHtml}
          ${isActive ? '<div class="season-card-enter">Open prebook &rarr;</div>' : '<div class="season-card-enter" style="opacity:0.3">Season closed</div>'}
        </div>
      </div>
    `;
  }).join('');
}

function toggleDraftList(seasonId) {
  const list = document.getElementById('draft-list-' + seasonId);
  const arrow = document.getElementById('draft-arrow-' + seasonId);
  if (list) list.classList.toggle('open');
  if (arrow) arrow.classList.toggle('open');
}

function openDraftFromLanding(token) {
  // Navigate to the order form with the draft token, bypassing login
  // Hash change on same page doesn't reload, so set hash then reload
  window.location.hash = 'draft=' + encodeURIComponent(token) + '&from=dashboard';
  window.location.reload();
}

function confirmDeleteDraft(token, accountName) {
  const overlay = document.createElement('div');
  overlay.className = 'draft-delete-overlay';
  overlay.innerHTML = `
    <div class="draft-delete-modal">
      <h3>Delete Draft</h3>
      <p>Are you sure you want to delete the draft order for <strong style="color:#fff">${escapeHtml(accountName)}</strong>? This cannot be undone.</p>
      <div class="draft-delete-actions">
        <button class="btn-delete-cancel" data-action="closeDraftDeleteOverlay">Cancel</button>
        <button class="btn-delete-confirm" data-action="executeDraftDelete" data-token="${token}">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function executeDraftDelete(token, btnEl) {
  btnEl.textContent = 'Deleting…';
  btnEl.disabled = true;
  const { error } = await supa.from('draft_orders').delete().eq('token', token);
  const overlay = btnEl.closest('.draft-delete-overlay');
  if (overlay) overlay.remove();
  if (error) {
    alert('Failed to delete draft. Please try again.');
  } else {
    // Refresh the landing page
    showSeasonLanding();
  }
}

function selectSeason(seasonId, category) {
  // Footwear seasons live in a separate form. Auth carries over via the
  // shared Supabase session on the same domain, so the footwear form's
  // checkExistingSession picks up the user without a second login.
  if ((category || '').toLowerCase() === 'footwear') {
    window.location.href = '../footwear/index.html#season=' + encodeURIComponent(seasonId);
    return;
  }

  window._selectedSeason = seasonId;

  // Reload customer DB now that season is known so prior-season history populates
  loadCustomerDB();

  const landing = document.getElementById('season-landing');
  landing.classList.add('fade-out');
  setTimeout(() => {
    landing.style.display = 'none';
    document.getElementById('app-header').style.display = '';
    document.getElementById('app-main').style.display = '';
    document.getElementById('app-footer').style.display = '';
  }, 500);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT TO LANDING PAGE
// ═══════════════════════════════════════════════════════════════════════════════

function hasOrderChanges() {
  // Check if any sizes have qty > 0
  for (const sku of Object.keys(orderData)) {
    const sizes = orderData[sku].sizes || {};
    for (const s of Object.keys(sizes)) {
      if (sizes[s] > 0) return true;
    }
  }
  return false;
}

function handleExitToLanding() {
  if (!hasOrderChanges()) {
    exitToLanding();
    return;
  }
  showExitConfirmation();
}

function showExitConfirmation() {
  const overlay = document.createElement('div');
  overlay.className = 'exit-overlay';
  overlay.innerHTML = `
    <div class="exit-modal">
      <h3>Unsaved Order</h3>
      <p>You have items in your current order. What would you like to do?</p>
      <div class="exit-actions">
        <button class="btn-exit-save" data-action="saveAndExit">Save as Draft & Exit</button>
        <button class="btn-exit-discard" data-action="discardAndExit">Discard & Exit</button>
        <button class="btn-exit-cancel" data-action="closeExitOverlay">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function saveAndExit(btnEl) {
  btnEl.textContent = 'Saving…';
  btnEl.disabled = true;
  // Trigger the share draft save logic
  const token = crypto.randomUUID();
  const accountInput = document.getElementById('account');
  const cmakey = accountInput?.dataset?.cmakey || '';
  const rec = CUSTOMER_DB.find(r => r.cmakey === cmakey);
  const accountName = rec?.customer || accountInput?.value || 'Customer';
  const managerName = document.getElementById('account-manager')?.value || '';
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const seasonId = window._selectedSeason || null;

  // Delete any existing draft for this account + season before saving
  await supa.from('draft_orders')
    .delete()
    .eq('season_id', seasonId)
    .filter('customer_data->>cmakey', 'eq', cmakey);

  const { error } = await supa.from('draft_orders').insert({
    token,
    order_data: orderData,
    customer_data: rec || { customer: accountName, manager: managerName, cmakey },
    expires_at: expiresAt,
    season_id: seasonId
  });

  const overlay = btnEl.closest('.exit-overlay');
  if (error) {
    btnEl.textContent = 'Save as Draft & Exit';
    btnEl.disabled = false;
    alert('Failed to save draft. Please try again.');
    return;
  }
  if (overlay) overlay.remove();
  exitToLanding();
}

function showToast(message, isError) {
  const toast = document.getElementById('toast-notification');
  toast.textContent = message;
  toast.classList.toggle('toast-error', !!isError);
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 3000);
}

async function saveDraftInPlace(btnEl) {
  const accountInput = document.getElementById('account');
  const cmakey = accountInput?.dataset?.cmakey || '';
  if (!cmakey) { showToast('Please select a customer first.', true); return; }
  if (!hasOrderChanges()) { showToast('No items to save.', true); return; }

  // Header menu items contain icon + label spans; mutating textContent
  // would destroy that structure. The toast at the end provides
  // feedback in either case, so for menu items we skip the inline
  // spinner and just disable the button.
  const isMenuItem = !!(btnEl && btnEl.classList && btnEl.classList.contains('header-menu-item'));
  const origText   = isMenuItem ? null : (btnEl ? btnEl.textContent : null);
  if (btnEl) {
    if (!isMenuItem) btnEl.textContent = '💾 Saving...';
    btnEl.disabled = true;
  }

  const rec = CUSTOMER_DB.find(r => r.cmakey === cmakey);
  const accountName = rec?.customer || accountInput?.value || 'Customer';
  const managerName = document.getElementById('account-manager')?.value || '';

  let error;

  if (isCustomerDraftMode && activeDraftToken) {
    // Customer mode: update existing draft in place (preserves the token/URL)
    ({ error } = await supa.from('draft_orders')
      .update({ order_data: orderData })
      .eq('token', activeDraftToken));
  } else {
    // Rep mode: delete + re-insert (new token each time)
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const seasonId = window._selectedSeason || null;

    await supa.from('draft_orders')
      .delete()
      .eq('season_id', seasonId)
      .filter('customer_data->>cmakey', 'eq', cmakey);

    ({ error } = await supa.from('draft_orders').insert({
      token,
      order_data: orderData,
      customer_data: rec || { customer: accountName, manager: managerName, cmakey },
      expires_at: expiresAt,
      season_id: seasonId
    }));
  }

  if (btnEl) {
    if (!isMenuItem && origText !== null) btnEl.textContent = origText;
    btnEl.disabled = false;
  }

  if (error) {
    showToast('Failed to save draft. Please try again.', true);
  } else {
    showToast(isCustomerDraftMode ? '✓ Changes saved' : '✓ Draft saved for ' + accountName);
  }
}

function discardAndExit() {
  const overlay = document.querySelector('.exit-overlay');
  if (overlay) overlay.remove();
  exitToLanding();
}

function exitToLanding() {
  // The season landing now lives at the root /index.html (the apparel
  // form is a subpage under /apparel/). Bouncing back to root takes the
  // user to the season picker, where draft counts are also refreshed.
  // Reset order state in case the browser caches the form page on
  // history-back, so a return visit starts clean.
  orderData = {};
  window.location.assign('../index.html');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════════

let COLLECTIONS = [];
let CUSTOMER_DB = [];
let orderData = {};  // Key: SKU, Value: {sku, name, sizes{}, deliveryMonth, ...}
let isCustomerDraftMode = false;  // true when a customer opens a shared draft link
let activeDraftToken = null;      // token of the currently loaded draft (for in-place updates)
let globalCrestingDefaults = { logoOption: 'Recommended', position: 'Left Chest', colour: 'Match FJ (1 colour)', specialInstructions: '' };
let mySelectionsMode = false;
let currentCountry = 'AUD';
let currentTabId = null;
let currentYear = new Date().getFullYear();

// ── PROGRAMS ──
let PROGRAMS = [];          // program_rules rows (active only)
let PROGRAM_PRODUCTS = [];  // program_products rows (active only)
let PROGRAM_PRODUCTS_BY_KEY = {};  // { program_key: [products] }
let ELIGIBLE_PROGRAMS = []; // filtered for current customer
let PROGRAM_CLAIMED_KEYS = new Set(); // program_keys already ordered by this customer this season

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════════

async function loadCustomerDB() {
  try {
    const [custRes, histRes] = await Promise.all([
      supa.from('customers').select('*').eq('status', 'active').order('account_name', { ascending: true }),
      supa.from('customer_season_history').select('*')
    ]);

    if (custRes.error) throw custRes.error;

    // Build history lookup: account_code → same season type from prior year
    // e.g. current AW27 compares to AW26 (not SS26)
    const currentSeason = window._selectedSeason || '';
    const seasonPrefix = currentSeason.replace(/\d+$/, ''); // e.g. 'AW'
    const seasonYear = parseInt(currentSeason.replace(/^\D+/, '')); // e.g. 27
    const priorSeasonId = seasonPrefix + (seasonYear - 1); // e.g. 'AW26'

    const historyByAccount = {};
    (histRes.data || []).forEach(h => {
      if (h.season_id !== priorSeasonId) return;
      historyByAccount[h.account_code] = h;
    });

    CUSTOMER_DB = (custRes.data || []).map(r => {
      const hist = historyByAccount[r.account_code] || {};
      return {
        cmakey: r.cma_key || r.account_code,
        account: r.account_code,
        customer: r.account_name,
        manager: r.account_manager,
        email: r.contact_email,
        state: r.state,
        city: r.city,
        address: [r.address_1, r.address_2, r.city, r.state, r.postcode]
          .filter(Boolean).join(', '),
        previousUnits: hist.total_units || 0,
        previousMens: hist.mens_units || 0,
        previousWomens: hist.womens_units || 0,
        previousJunior: hist.junior_units || 0,
        previousAccessories: hist.accessories_units || 0,
        group: r.Group || r.group || '',
        category: r.Category || r.category || ''
      };
    });

  } catch (error) {
  }
}

async function loadReferenceData() {
  try {
    // Load collections, scoped to apparel + the selected season.
    // Falls back to AW27 if the user somehow reached the form without picking
    // a season (e.g. legacy URL or no seasons table seeded yet).
    const seasonId = window._selectedSeason || 'AW27';
    const { data: collections, error: collectionsError } = await supa
      .from('collections')
      .select('collection_id, collection_name, delivery_season, season_id, category, tab_order, status')
      .eq('status', 'active')
      .eq('category', 'apparel')
      .eq('season_id', seasonId)
      .order('tab_order, collection_name', { ascending: true });

    if (collectionsError) throw collectionsError;

    // Load subsections
    const { data: subsections, error: subsectionsError } = await supa
      .from('subsections')
      .select('subsection_id, subsection_name, collection_id, sort_order, status')
      .order('collection_id, sort_order', { ascending: true });

    if (subsectionsError) throw subsectionsError;

    // Load products (apparel form only shows apparel-category products)
    const { data: products, error: productsError } = await supa
      .from('products')
      .select(`
        sku, item_number, base_sku, product_name, colour, fit_type,
        aud_ws_price, aud_rrp_price, nzd_ws_price, nzd_rrp_price,
        available_sizes, delivery_months, is_new, is_top_seller,
        collection_id, subsection_id, status, cresting_eligible,
        size_type, leg_length
      `)
      .eq('category', 'apparel')
      .in('status', ['active', 'sold_out'])
      .order('item_number', { ascending: true });

    if (productsError) throw productsError;

    // Build hierarchical structure
    if (collections && collections.length > 0) {
      COLLECTIONS = collections.map(col => {
        // Build a lookup map: subsection_id → subsection_name
        const subsectionNameMap = {};
        (subsections || []).forEach(s => {
          subsectionNameMap[s.subsection_id] = s.subsection_name;
        });

        // Group products by their subsection_id directly (more robust)
        const colProducts = (products || [])
          .filter(p => p.collection_id === col.collection_id)
          .sort((a, b) => (a.item_number || 0) - (b.item_number || 0));
        const subsectionGroups = {};
        colProducts.forEach(p => {
          const sid = p.subsection_id || 'uncategorised';
          if (!subsectionGroups[sid]) subsectionGroups[sid] = [];
          subsectionGroups[sid].push(p);
        });

        // Sort subsections by sort_order from subsections table
        const subsectionOrder = (subsections || [])
          .filter(s => s.collection_id === col.collection_id)
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
          .map(s => s.subsection_id);

        // Add any subsection_ids from products that aren't in subsections table
        Object.keys(subsectionGroups).forEach(sid => {
          if (!subsectionOrder.includes(sid)) subsectionOrder.push(sid);
        });

        const subsectionData = subsectionOrder
          .filter(sid => subsectionGroups[sid] && subsectionGroups[sid].length > 0)
          .map(sid => {
            const subProducts = subsectionGroups[sid];

            // Determine subsection delivery: single shared month, or 'Per Selection'
            const allMonths = [...new Set(
              subProducts.flatMap(p => {
                const m = p.delivery_months;
                return Array.isArray(m) ? m : (m ? [m] : []);
              }).filter(Boolean)
            )];
            const subsectionDelivery = allMonths.length === 1 ? allMonths[0] : 'Per Selection';

            return {
              id: sid,
              name: subsectionNameMap[sid] || sid,
              delivery: subsectionDelivery,
              products: subProducts.map(p => ({
                sku: p.sku,
                name: p.product_name,
                colour: p.colour || '',
                fit: p.fit_type || '',
                isNew: p.is_new || false,
                topSeller: p.is_top_seller || false,
                aud_ws_price: p.aud_ws_price || 0,
                aud_rrp_price: p.aud_rrp_price || 0,
                nzd_ws_price: p.nzd_ws_price || 0,
                nzd_rrp_price: p.nzd_rrp_price || 0,
                available_sizes: (p.available_sizes || '').split(',').map(s => s.trim()).filter(Boolean),
                delivery_months: Array.isArray(p.delivery_months) ? p.delivery_months : (p.delivery_months ? [p.delivery_months] : []),
                subsectionDelivery: subsectionDelivery,
                cresting_eligible: p.cresting_eligible || false,
                soldOut: p.status === 'sold_out',
                collection_id: col.collection_id,
                subsection_id: sid,
                size_type: p.size_type || 'top',
                leg_length: p.leg_length || null,
                base_sku: p.base_sku || null
              }))
            };
          });

        return {
          id: col.collection_id,
          name: col.collection_name,
          delivery: col.delivery_season,
          tab_order: col.tab_order,
          subsections: subsectionData
        };
      })
      // Hide collections that have no products in this form's category
      // (e.g. shoe collections in the apparel form)
      .filter(c => c.subsections && c.subsections.length > 0);
    }

  } catch (error) {
    alert('Failed to load collections. Please refresh the page.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRAMS DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════════

async function loadProgramData() {
  try {
    const [rulesRes, prodsRes] = await Promise.all([
      supa.from('program_rules').select('*').eq('status', 'active').order('sort_order', { ascending: true }),
      supa.from('program_products').select('*').eq('status', 'active').order('sort_order', { ascending: true })
    ]);

    if (rulesRes.error) { return; }
    if (prodsRes.error) { return; }

    PROGRAMS = rulesRes.data || [];
    PROGRAM_PRODUCTS = prodsRes.data || [];

    // Index products by program_key
    PROGRAM_PRODUCTS_BY_KEY = {};
    PROGRAM_PRODUCTS.forEach(pp => {
      if (!PROGRAM_PRODUCTS_BY_KEY[pp.program_key]) PROGRAM_PRODUCTS_BY_KEY[pp.program_key] = [];
      PROGRAM_PRODUCTS_BY_KEY[pp.program_key].push(pp);
    });

  } catch (error) {
  }
}

function getEligiblePrograms(customer) {
  if (!customer || PROGRAMS.length === 0) return [];
  return PROGRAMS.filter(p => {
    // Group filter
    if (p.include_groups && p.include_groups.length > 0) {
      if (!p.include_groups.includes(customer.group)) return false;
    }
    if (p.exclude_groups && p.exclude_groups.length > 0) {
      if (p.exclude_groups.includes(customer.group)) return false;
    }
    // Category filter
    if (p.include_categories && p.include_categories.length > 0) {
      if (!p.include_categories.includes(customer.category)) return false;
    }
    if (p.exclude_categories && p.exclude_categories.length > 0) {
      if (p.exclude_categories.includes(customer.category)) return false;
    }
    return true;
  });
}

async function refreshProgramTabs() {
  const cmakey = document.getElementById('account')?.dataset?.cmakey || '';
  const customer = CUSTOMER_DB.find(r => r.cmakey === cmakey);
  ELIGIBLE_PROGRAMS = getEligiblePrograms(customer);

  // Check which once_per_season programs this customer has already claimed
  PROGRAM_CLAIMED_KEYS = new Set();
  const oncePrograms = PROGRAMS.filter(p => p.once_per_season);
  if (cmakey && oncePrograms.length > 0) {
    try {
      // Find submitted orders for this account
      const { data: custOrders } = await supa
        .from('orders')
        .select('order_id')
        .eq('account_name', customer?.customer || '')
        .eq('status', 'submitted');
      if (custOrders && custOrders.length > 0) {
        const orderIds = custOrders.map(o => o.order_id);
        const progPrefixes = oncePrograms.map(p => `PROG:${p.program_key}`);
        const { data: claimedLines } = await supa
          .from('order_lines')
          .select('collection_id')
          .in('order_id', orderIds)
          .in('collection_id', progPrefixes);
        if (claimedLines) {
          claimedLines.forEach(row => {
            const key = row.collection_id.replace('PROG:', '');
            PROGRAM_CLAIMED_KEYS.add(key);
          });
        }
      }
    } catch (e) { /* production: error silenced */ }
  }

  buildTabBar();
  renderCollections();
  renderProgramPanels();

  // Stay on current tab if it still exists, otherwise fall back to first collection
  const tabStillExists = currentTabId && document.querySelector(`.tab-btn[data-collection-id="${currentTabId}"]`);
  if (tabStillExists) {
    switchTab(currentTabId);
  } else if (COLLECTIONS.length > 0) {
    switchTab(COLLECTIONS[0].id);
  }
  updateUI();
}

function findProgramProductById(id) {
  return PROGRAM_PRODUCTS.find(pp => pp.id === id) || null;
}

function findProgramProductByKey(progKey, sku) {
  return (PROGRAM_PRODUCTS_BY_KEY[progKey] || []).find(pp => pp.sku === sku) || null;
}

function getProgramPrice(rule, pp) {
  const basePrice = currentCountry === 'NZD' ? (pp.nzd_price || 0) : (pp.aud_price || 0);
  if (rule.rule_type === 'discount' && rule.discount_pct) {
    return basePrice * (1 - rule.discount_pct / 100);
  }
  if (rule.rule_type === 'free_item') return 0;
  return basePrice; // fixed_price or pack
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT AUTOCOMPLETE
// ═══════════════════════════════════════════════════════════════════════════════

(function initAutocomplete() {
  const input = document.getElementById('account');
  const dropdown = document.getElementById('ac-dropdown');
  const managerField = document.getElementById('account-manager');

  function normalize(s) {
    return (s || '').toLowerCase().trim();
  }

  function showDropdown(query) {
    if (!query) {
      dropdown.classList.remove('visible');
      return;
    }

    const matches = CUSTOMER_DB.filter(r =>
      normalize(r.account).includes(normalize(query)) ||
      normalize(r.customer).includes(normalize(query)) ||
      normalize(r.city).includes(normalize(query))
    );

    dropdown.innerHTML = matches.map(r => `
      <li data-action="selectCustomer" data-cmakey="${escapeAttr(r.cmakey)}">
        <div class="ac-name">${escapeHtml(r.customer)}</div>
        <div class="ac-sub">${escapeHtml(r.city)}, ${escapeHtml(r.state)}</div>
      </li>
    `).join('');

    dropdown.classList.toggle('visible', matches.length > 0);
  }

  input.addEventListener('input', (e) => {
    showDropdown(e.target.value);
  });

  input.addEventListener('focus', (e) => {
    showDropdown(e.target.value);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.remove('visible'), 200);
  });

  window.selectCustomer = async function(cmakey) {
    const selected = CUSTOMER_DB.find(r => r.cmakey === cmakey);
    if (selected) {
      input.value = selected.customer;
      input.dataset.cmakey = selected.cmakey;
      managerField.value = selected.manager || '';
      dropdown.classList.remove('visible');
      // Update footer customer name
      const footerName = document.getElementById('footer-customer-name');
      if (footerName) footerName.textContent = selected.customer;
      // Refresh program tabs based on customer eligibility
      if (PROGRAMS.length > 0) await refreshProgramTabs();
    }
  };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// UI RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function buildTabBar() {
  const tabBar = document.getElementById('tab-bar');
  const tabs = COLLECTIONS.map((col, idx) => `
    <button class="tab-btn ${idx === 0 ? 'active' : ''}"
            data-collection-id="${escapeAttr(col.id)}"
            data-action="switchTab"
            data-id="${escapeAttr(col.id)}">
      ${escapeHtml(col.name)}
    </button>
  `).join('');

  // Add single Programs tab if any eligible programs exist with products (hidden in customer draft mode)
  const hasPrograms = !isCustomerDraftMode && ELIGIBLE_PROGRAMS.some(prog => (PROGRAM_PRODUCTS_BY_KEY[prog.program_key] || []).length > 0);
  const progTab = hasPrograms ? `
    <button class="tab-btn tab-btn-program"
            data-collection-id="programs"
            data-action="switchTab"
            data-id="programs">
      Programs
    </button>
  ` : '';

  tabBar.innerHTML = tabs + progTab + `
    <button class="btn-my-selections" id="btn-my-selections"
            data-action="toggleMySelections">☑ My Selections</button>
  `;
}

function renderProductCard(prod) {
  return `
    <div class="product-card${prod.soldOut ? ' sold-out' : ''}" data-sku="${prod.sku}">
      <div class="product-image">
        <img src="https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/product-images/FJ_${prod.base_sku || prod.sku}_01.jpg"
             data-img-fallback="product" />
      </div>
      <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap;">
        ${prod.soldOut ? '<span class="product-badge soldout">Sold Out</span>' : ''}
        ${prod.isNew && !prod.soldOut ? '<span class="product-badge new">New</span>' : ''}
        ${prod.topSeller && !prod.soldOut ? '<span class="product-badge topseller">Top Seller</span>' : ''}
        ${prod.fit && prod.fit.toLowerCase().includes('regular') ? '<span class="product-badge regular">Regular</span>' : ''}
        <span class="product-sku">${escapeHtml(prod.sku)}</span>
      </div>
      <div class="product-name">${escapeHtml(prod.name)}</div>
      <div class="product-details">${escapeHtml(prod.colour)}${prod.fit && !prod.fit.toLowerCase().includes('regular') ? ' • ' + escapeHtml(prod.fit) : ''}</div>
      <div class="product-price" id="price-${prod.sku}">
        ${currentCountry === 'NZD' ? '$' + prod.nzd_ws_price.toFixed(2) : '$' + prod.aud_ws_price.toFixed(2)}
        <span class="product-rrp">${currentCountry === 'NZD' ? 'RRP $' + prod.nzd_rrp_price.toFixed(2) : 'RRP $' + prod.aud_rrp_price.toFixed(2)}</span>
      </div>
      <div class="size-buttons" id="sizes-${prod.sku}">
        ${prod.available_sizes.map(size => `
          <div class="size-col">
            <span class="size-label">${size}</span>
            <button class="size-btn" data-size="${size.replace(/"/g, '&quot;')}" data-sku="${prod.sku}">—</button>
          </div>
        `).join('')}
      </div>
      ${prod.subsectionDelivery === 'Per Selection' && prod.delivery_months.length > 0 ? `
      <div class="delivery-select-wrap">
        <label class="delivery-select-label">Delivery</label>
        <select class="delivery-select" id="delivery-${prod.sku}" data-action="setDeliveryMonth" data-sku="${prod.sku}">
          ${prod.delivery_months.map(m => `<option value="${m}"${(orderData[prod.sku] && orderData[prod.sku].deliveryMonth === m) ? ' selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="card-actions">
        <button class="btn-add-all" data-action="addOneToAll" data-sku="${prod.sku}">+ Add 1 to All</button>
        <button class="btn-clear-card" data-action="clearCard" data-sku="${prod.sku}">Clear</button>
      </div>
      ${prod.cresting_eligible ? (() => {
        const c = orderData[prod.sku]?.cresting || {};
        const addLogo = c.addLogo || 'None';
        const logoOption = c.logoOption || 'Recommended';
        const position = c.position || 'Left Chest';
        const colour = c.colour || 'Match FJ (1 colour)';
        const showOption = addLogo === 'Yes';
        const showCustom = showOption && logoOption === 'Custom';
        return `
        <div class="cresting-section">
          <div class="cresting-row">
            <div class="cresting-field" id="crest-add-logo-${prod.sku}">
              <label class="cresting-label">Add Logo</label>
              <button class="cresting-toggle ${addLogo === 'Yes' ? 'cresting-active' : ''}"
                      data-action="setCrestingAddLogo"
                      data-sku="${prod.sku}">
                ${addLogo === 'Yes' ? 'Yes' : 'None'}
              </button>
            </div>
            <div class="cresting-field" style="display:${showOption ? 'flex' : 'none'}" id="crest-option-${prod.sku}">
              <label class="cresting-label">Logo Option</label>
              <button class="cresting-toggle ${logoOption === 'Custom' ? 'cresting-active' : ''}"
                      data-action="setCrestingLogoOption"
                      data-sku="${prod.sku}">
                ${logoOption === 'Custom' ? 'Custom' : 'Recommended'}
              </button>
            </div>
          </div>
          <div class="cresting-row" id="crest-custom-${prod.sku}" style="display:${showCustom ? 'flex' : 'none'}">
            <div class="cresting-field">
              <label class="cresting-label">Position</label>
              <select class="cresting-select" data-action="setCrestingField" data-sku="${prod.sku}" data-field="position">
                <option value="Left Chest"   ${position === 'Left Chest'   ? 'selected' : ''}>Left Chest</option>
                <option value="Right Chest"  ${position === 'Right Chest'  ? 'selected' : ''}>Right Chest</option>
                <option value="Left Sleeve"  ${position === 'Left Sleeve'  ? 'selected' : ''}>Left Sleeve</option>
                <option value="Right Sleeve" ${position === 'Right Sleeve' ? 'selected' : ''}>Right Sleeve</option>
              </select>
            </div>
            <div class="cresting-field">
              <label class="cresting-label">Colour</label>
              <select class="cresting-select" data-action="setCrestingField" data-sku="${prod.sku}" data-field="colour">
                <option value="Match FJ (1 colour)"     ${colour === 'Match FJ (1 colour)'     ? 'selected' : ''}>Match FJ (1 colour)</option>
                <option value="Colour Co-ordinated"     ${colour === 'Colour Co-ordinated'     ? 'selected' : ''}>Colour Co-ordinated</option>
                <option value="Full Colour"             ${colour === 'Full Colour'             ? 'selected' : ''}>Full Colour</option>
                <option value="Tonal"                   ${colour === 'Tonal'                   ? 'selected' : ''}>Tonal</option>
              </select>
            </div>
          </div>
          <div class="cresting-row cresting-row-full" id="crest-instructions-${prod.sku}" style="display:${showCustom ? 'flex' : 'none'}">
            <textarea class="cresting-instructions" rows="2"
                      placeholder="Special instructions..."
                      data-action="setCrestingField" data-sku="${prod.sku}" data-field="specialInstructions"
            >${(c.specialInstructions || '')}</textarea>
          </div>
        </div>`;
      })() : ''}
    </div>
  `;
}

function renderCollections() {
  const container = document.getElementById('collections-container');

  // Each collection becomes a tab-panel; subsections are the accordions
  container.innerHTML = COLLECTIONS.map((col, colIdx) => `
    <div class="collection-panel" data-collection-id="${col.id}" style="display:${colIdx === 0 ? 'block' : 'none'}">
      ${col.subsections.map((sub, subIdx) => `
        <div class="collection" data-subsection-id="${sub.id}">
          <div class="collection-header" data-action="toggleSubsection" data-id="${sub.id}">
            <div class="collection-header-left">
              <span class="collection-toggle-icon" id="icon-${sub.id}">▼</span>
              <div class="collection-name">${escapeHtml(sub.name)}</div>
            </div>
            <div class="collection-stats">
              <span style="font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--fj-mid);margin-right:6px">Delivery Month</span><span class="delivery-badge">${escapeHtml(sub.delivery || '')}</span>
              ${sub.products.some(p => p.cresting_eligible) ? `
                <span class="subsection-logo-wrap">
                  <span class="subsection-logo-label">Logo Embroidery</span>
                  <button class="cresting-toggle subsection-logo-toggle" id="sub-logo-${sub.id}"
                          data-action="toggleSubsectionCresting"
                          data-id="${sub.id}">Off</button>
                </span>
              ` : ''}
            </div>
          </div>
          <div class="collection-body open" id="sub-body-${sub.id}">
            <div class="product-grid">
              ${sub.products.map(prod => renderProductCard(prod)).join('')}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function renderProgramProductCard(pp, rule) {
  const progKey = pp.program_key;
  const orderKey = `prog:${progKey}:${pp.id}`;
  const rawSizes = pp.sizes || '["OS"]';
  const sizes = Array.isArray(rawSizes) ? rawSizes
    : (rawSizes.startsWith('[') ? JSON.parse(rawSizes) : rawSizes.split(',').map(s => s.trim()));
  const basePrice = currentCountry === 'NZD' ? (pp.nzd_price || 0) : (pp.aud_price || 0);
  const finalPrice = getProgramPrice(rule, pp);
  const isDiscount = rule.rule_type === 'discount' && rule.discount_pct;
  const isFree = rule.rule_type === 'free_item' || finalPrice === 0;

  const imgSrc = pp.image_url
    ? pp.image_url
    : `https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/product-images/FJ_${pp.sku}_01.jpg`;

  let priceHTML;
  if (isFree) {
    priceHTML = '<span style="color:var(--fj-green);font-weight:700">Complimentary</span>';
  } else if (isDiscount) {
    priceHTML = `<span style="text-decoration:line-through;color:var(--fj-mid);margin-right:6px">$${basePrice.toFixed(2)}</span>` +
      `<span style="color:var(--fj-green);font-weight:700">$${finalPrice.toFixed(2)}</span>` +
      `<span style="font-size:11px;color:var(--fj-mid);margin-left:4px">(${rule.discount_pct}% off)</span>`;
  } else {
    priceHTML = '$' + finalPrice.toFixed(2);
  }

  const maxQty = rule.qty_scope === 'per_product' ? rule.max_qty : null;
  const maxLabel = maxQty ? `<span style="font-size:11px;color:var(--fj-mid);margin-left:8px">Max ${maxQty} per style</span>` : '';

  return `
    <div class="product-card program-product-card" data-sku="${orderKey}" data-prog-key="${progKey}" data-prog-product-id="${pp.id}">
      <div class="product-image">
        <img src="${imgSrc}"
             data-img-fallback="product" />
      </div>
      <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap;">
        <span class="product-badge" style="background:var(--fj-green);color:white">${escapeHtml(rule.program_name)}</span>
        <span class="product-sku">${escapeHtml(pp.sku)}</span>
      </div>
      <div class="product-name">${escapeHtml(pp.style_name)}</div>
      <div class="product-details">${escapeHtml(pp.colour || '')}${pp.description ? ' - ' + escapeHtml(pp.description) : ''}</div>
      <div class="product-price">${priceHTML}${maxLabel}</div>
      <div class="size-buttons" id="sizes-${CSS.escape(orderKey)}">
        ${sizes.map(size => `
          <div class="size-col">
            <span class="size-label">${size === 'OS' ? 'Qty' : size}</span>
            <button class="size-btn" data-size="${size.replace(/"/g, '&quot;')}" data-sku="${orderKey}">${'--'}</button>
          </div>
        `).join('')}
      </div>
      <div class="card-actions">
        <button class="btn-clear-card" data-action="clearCard" data-sku="${escapeAttr(orderKey)}">Clear</button>
      </div>
    </div>
  `;
}

function renderProgramPanels() {
  const container = document.getElementById('collections-container');
  // Remove existing combined programs panel
  const existing = container.querySelector('.collection-panel[data-collection-id="programs"]');
  if (existing) existing.remove();

  // Build sections for each eligible program
  const sections = ELIGIBLE_PROGRAMS.map(prog => {
    const products = PROGRAM_PRODUCTS_BY_KEY[prog.program_key] || [];
    if (products.length === 0) return '';

    const cond = prog.conditions || {};
    const isThresholdProgram = cond.min_order_total_units || cond.min_subsection_units || prog.once_per_season;
    let thresholdHTML = '';
    if (isThresholdProgram) {
      thresholdHTML = `<div class="program-threshold-msg" id="prog-threshold-${prog.program_key}" style="background:#fff4e0;border:1px solid #f0c050;border-radius:4px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#8a6500;display:block">
        Calculating eligibility...
      </div>`;
    }

    return `
      <div class="program-section" data-prog-key="${prog.program_key}" style="margin-bottom:36px">
        <div style="margin-bottom:20px">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:700;color:var(--fj-black);margin-bottom:4px">${escapeHtml(prog.program_name)}</div>
          <div style="font-size:13px;color:var(--fj-mid)">${escapeHtml(prog.description || '')}</div>
        </div>
        ${thresholdHTML}
        <div class="product-grid">
          ${products.map(pp => renderProgramProductCard(pp, prog)).join('')}
        </div>
      </div>
    `;
  }).filter(Boolean).join('');

  if (!sections) return;

  const panelHTML = `
    <div class="collection-panel" data-collection-id="programs" style="display:none">
      ${sections}
    </div>
  `;
  container.insertAdjacentHTML('beforeend', panelHTML);
}

function switchTab(collId) {
  currentTabId = collId;

  // Update active tab button
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.collectionId === collId);
  });

  // Show/hide collection panels
  document.querySelectorAll('.collection-panel').forEach(panel => {
    panel.style.display = panel.dataset.collectionId === collId ? 'block' : 'none';
  });

  // Scroll to top of page
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleSubsection(subId) {
  const body = document.getElementById('sub-body-' + subId);
  const icon = document.getElementById('icon-' + subId);
  body.classList.toggle('open');
  icon.classList.toggle('closed');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIZE AND ORDER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function getDeliveryMonthForSku(sku) {
  const product = findProductBySku(sku);
  if (!product) return null;
  if (product.subsectionDelivery !== 'Per Selection') {
    return product.subsectionDelivery || (product.delivery_months[0] || null);
  }
  // Per Selection — read the dropdown if it exists, else fall back to first month
  const select = document.getElementById('delivery-' + sku);
  return select ? select.value : (product.delivery_months[0] || null);
}

function setDeliveryMonth(sku, month) {
  if (orderData[sku]) orderData[sku].deliveryMonth = month;
}

function toggleGlobalCresting() {
  const btn = document.getElementById('btn-global-cresting');
  const settings = document.getElementById('global-cresting-settings');
  const turningOn = !btn.classList.contains('cresting-active');

  if (!turningOn) {
    // Turning off — clear all embroidery and hide settings
    COLLECTIONS.forEach(col => {
      col.subsections.forEach(sub => {
        sub.products.forEach(prod => {
          if (!prod.cresting_eligible) return;
          setCresting(prod.sku, 'addLogo', 'None');
        });
      });
    });
    settings.classList.remove('visible');
  } else {
    // Turning on — set addLogo = 'Yes' on unset products and show settings
    COLLECTIONS.forEach(col => {
      col.subsections.forEach(sub => {
        sub.products.forEach(prod => {
          if (!prod.cresting_eligible) return;
          const currentAdd = orderData[prod.sku]?.cresting?.addLogo || 'None';
          if (currentAdd === 'None') setCresting(prod.sku, 'addLogo', 'Yes');
        });
      });
    });
    settings.classList.add('visible');
  }

  btn.classList.toggle('cresting-active', turningOn);
  btn.textContent = turningOn ? 'On' : 'Off';
}

function setGlobalCrestingDefault(field, value) {
  globalCrestingDefaults[field] = value;

  if (field === 'logoOption') {
    const isCustom = value === 'Custom';
    const optBtn = document.getElementById('btn-global-logo-option');
    optBtn.classList.toggle('cresting-active', isCustom);
    optBtn.textContent = isCustom ? 'Custom' : 'Recommended';
    document.getElementById('global-position-wrap').style.display = isCustom ? 'flex' : 'none';
    document.getElementById('global-colour-wrap').style.display = isCustom ? 'flex' : 'none';
    document.getElementById('global-instructions-wrap').style.display = isCustom ? 'flex' : 'none';
  }
}

function applyGlobalCresting() {
  const { logoOption, position, colour, specialInstructions } = globalCrestingDefaults;
  COLLECTIONS.forEach(col => {
    col.subsections.forEach(sub => {
      sub.products.forEach(prod => {
        if (!prod.cresting_eligible) return;
        setCresting(prod.sku, 'addLogo', 'Yes');
        setCresting(prod.sku, 'logoOption', logoOption);
        if (logoOption === 'Custom') {
          setCresting(prod.sku, 'position', position);
          setCresting(prod.sku, 'colour', colour);
          setCresting(prod.sku, 'specialInstructions', specialInstructions);
        }
      });
    });
  });
}

function toggleSubsectionCresting(subId, btn) {
  const turningOn = !btn.classList.contains('cresting-active');

  // Find the subsection in COLLECTIONS
  COLLECTIONS.forEach(col => {
    const sub = col.subsections.find(s => s.id === subId);
    if (!sub) return;
    sub.products.forEach(prod => {
      if (!prod.cresting_eligible) return;
      const currentAdd = orderData[prod.sku]?.cresting?.addLogo || 'None';
      if (turningOn && currentAdd === 'None') {
        setCresting(prod.sku, 'addLogo', 'Yes');
      } else if (!turningOn) {
        setCresting(prod.sku, 'addLogo', 'None');
      }
    });
  });

  btn.classList.toggle('cresting-active', turningOn);
  btn.textContent = turningOn ? 'On' : 'Off';
}

function setCresting(sku, field, value) {
  // Ensure product exists in orderData
  if (!orderData[sku]) {
    const product = findProductBySku(sku);
    orderData[sku] = {
      sku, sizes: {}, deliveryMonth: getDeliveryMonthForSku(sku),
      productName: product?.name, collectionId: product?.collection_id,
      subsectionId: product?.subsection_id, delivery_months: product?.delivery_months
    };
    (product?.available_sizes || []).forEach(s => { orderData[sku].sizes[s] = 0; });
  }
  if (!orderData[sku].cresting) {
    orderData[sku].cresting = { addLogo: 'None', logoOption: 'Recommended', position: 'Left Chest', colour: 'Match FJ (1 colour)' };
  }
  orderData[sku].cresting[field] = value;

  // Show/hide dependent dropdowns across ALL rendered instances of this card
  document.querySelectorAll(`#crest-option-${CSS.escape(sku)}`).forEach(el => {
    el.style.display = orderData[sku].cresting.addLogo === 'Yes' ? 'flex' : 'none';
  });
  const showCustom = orderData[sku].cresting.addLogo === 'Yes' && orderData[sku].cresting.logoOption === 'Custom';
  document.querySelectorAll(`#crest-custom-${CSS.escape(sku)}`).forEach(el => {
    el.style.display = showCustom ? 'flex' : 'none';
  });
  document.querySelectorAll(`#crest-instructions-${CSS.escape(sku)}`).forEach(el => {
    el.style.display = showCustom ? 'flex' : 'none';
  });
  // Update Add Logo toggle button state
  const isLogoYes = orderData[sku].cresting.addLogo === 'Yes';
  document.querySelectorAll(`.product-card[data-sku="${CSS.escape(sku)}"] #crest-add-logo-${CSS.escape(sku)} .cresting-toggle`).forEach(btn => {
    btn.classList.toggle('cresting-active', isLogoYes);
    btn.textContent = isLogoYes ? 'Yes' : 'None';
  });
  // Update Logo Option toggle button state
  const isCustom = orderData[sku].cresting.logoOption === 'Custom';
  document.querySelectorAll(`#crest-option-${CSS.escape(sku)} .cresting-toggle`).forEach(btn => {
    btn.classList.toggle('cresting-active', isCustom);
    btn.textContent = isCustom ? 'Custom' : 'Recommended';
  });
  // Sync Position and Colour select values
  document.querySelectorAll(`#crest-custom-${CSS.escape(sku)} .cresting-select`).forEach((sel, i) => {
    if (i === 0) sel.value = orderData[sku].cresting.position || 'Left Chest';
    if (i === 1) sel.value = orderData[sku].cresting.colour || 'Match FJ (1 colour)';
  });
  // Sync Special Instructions textarea
  document.querySelectorAll(`#crest-instructions-${CSS.escape(sku)} .cresting-instructions`).forEach(ta => {
    ta.value = orderData[sku].cresting.specialInstructions || '';
  });
}

// ── SIZE BUTTON INTERACTION SYSTEM ──────────────────────────────────────────
// Tap/click = increment by 1 (no cap)
// Long-press (touch, 500ms) or double-click (desktop) = open direct qty popup
// Swipe down on button (touch) or right-click (desktop) = decrement by 1

function ensureOrderEntry(sku) {
  if (!orderData[sku]) {
    // Check if this is a program product key (prog:key:uuid)
    if (sku.startsWith('prog:')) {
      const parts = sku.split(':');
      const progKey = parts[1];
      const ppId = parts[2];
      const pp = findProgramProductById(ppId);
      const rule = PROGRAMS.find(p => p.program_key === progKey);
      const sizes = pp ? (Array.isArray(pp.sizes) ? pp.sizes : (typeof pp.sizes === 'string' && pp.sizes.startsWith('[') ? JSON.parse(pp.sizes) : (pp.sizes || 'OS').split(',').map(s => s.trim()))) : ['OS'];
      orderData[sku] = {
        sku: sku,
        sizes: {},
        deliveryMonth: null,
        productName: pp?.style_name || sku,
        collectionId: null,
        subsectionId: null,
        delivery_months: [],
        _isProgram: true,
        _programKey: progKey,
        _programProductId: ppId,
        _programName: rule?.program_name || progKey
      };
      sizes.forEach(s => { orderData[sku].sizes[s] = 0; });
    } else {
      const product = findProductBySku(sku);
      orderData[sku] = {
        sku: sku,
        sizes: {},
        deliveryMonth: getDeliveryMonthForSku(sku),
        productName: product?.name,
        collectionId: product?.collection_id,
        subsectionId: product?.subsection_id,
        delivery_months: product?.delivery_months
      };
    }
  }
  if (Object.keys(orderData[sku].sizes).length === 0) {
    if (sku.startsWith('prog:')) {
      const ppId = sku.split(':')[2];
      const pp = findProgramProductById(ppId);
      const sizes = pp ? (Array.isArray(pp.sizes) ? pp.sizes : (typeof pp.sizes === 'string' && pp.sizes.startsWith('[') ? JSON.parse(pp.sizes) : (pp.sizes || 'OS').split(',').map(s => s.trim()))) : ['OS'];
      sizes.forEach(s => { orderData[sku].sizes[s] = 0; });
    } else {
      const product = findProductBySku(sku);
      if (product) {
        product.available_sizes.forEach(s => { orderData[sku].sizes[s] = 0; });
      }
    }
  }
}

function incrementSize(sku, size) {
  ensureOrderEntry(sku);
  // Enforce program max_qty
  if (sku.startsWith('prog:')) {
    const progKey = sku.split(':')[1];
    const rule = PROGRAMS.find(p => p.program_key === progKey);
    if (rule && rule.max_qty != null) {
      if (rule.qty_scope === 'per_product') {
        const currentTotal = Object.values(orderData[sku].sizes).reduce((a, b) => a + b, 0);
        if (currentTotal >= rule.max_qty) {
          showToast(`Maximum ${rule.max_qty} units per style for ${rule.program_name}`, true);
          return;
        }
      } else if (rule.qty_scope === 'per_program') {
        let progTotal = 0;
        Object.entries(orderData).forEach(([k, v]) => {
          if (k.startsWith(`prog:${progKey}:`)) {
            progTotal += Object.values(v.sizes || {}).reduce((a, b) => a + b, 0);
          }
        });
        if (progTotal >= rule.max_qty) {
          showToast(`Maximum ${rule.max_qty} total units for ${rule.program_name}`, true);
          return;
        }
      }
    }
  }
  orderData[sku].sizes[size] = (orderData[sku].sizes[size] || 0) + 1;
  updateUI();
}

function decrementSize(sku, size) {
  ensureOrderEntry(sku);
  const current = orderData[sku].sizes[size] || 0;
  orderData[sku].sizes[size] = Math.max(0, current - 1);
  updateUI();
}

function setSizeQty(sku, size, qty) {
  ensureOrderEntry(sku);
  orderData[sku].sizes[size] = Math.max(0, qty);
  updateUI();
}

function showQtyPopup(sku, size) {
  const product = findProductBySku(sku);
  const currentQty = (orderData[sku]?.sizes?.[size]) || 0;
  const overlay = document.createElement('div');
  overlay.className = 'qty-popup-overlay';
  overlay.innerHTML = `
    <div class="qty-popup">
      <div class="qty-popup-title">${product?.name || sku}</div>
      <div class="qty-popup-subtitle">Size: ${size}</div>
      <input class="qty-popup-input" type="number" inputmode="numeric" min="0" max="999" value="${currentQty}" />
      <div class="qty-popup-actions">
        <button class="qty-popup-cancel">Cancel</button>
        <button class="qty-popup-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('.qty-popup-input');
  input.focus();
  input.select();

  overlay.querySelector('.qty-popup-cancel').addEventListener('click', function() {
    overlay.remove();
  });
  overlay.querySelector('.qty-popup-save').addEventListener('click', function() {
    const val = parseInt(input.value) || 0;
    setSizeQty(sku, size, val);
    overlay.remove();
  });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      const val = parseInt(input.value) || 0;
      setSizeQty(sku, size, val);
      overlay.remove();
    } else if (e.key === 'Escape') {
      overlay.remove();
    }
  });
  // Close on overlay click (outside the popup)
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });
}

// ── Attach event listeners via delegation ──────────────────────────────────
(function initSizeInteractions() {
  let longPressTimer = null;
  let longPressFired = false;
  let touchStartY = 0;

  document.addEventListener('touchstart', function(e) {
    const btn = e.target.closest('.size-btn');
    if (!btn) return;
    longPressFired = false;
    touchStartY = e.touches[0].clientY;
    longPressTimer = setTimeout(function() {
      longPressFired = true;
      const sku = btn.dataset.sku;
      const size = btn.dataset.size;
      showQtyPopup(sku, size);
    }, 500);
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (!longPressTimer) return;
    const btn = e.target.closest('.size-btn');
    if (!btn) { clearTimeout(longPressTimer); longPressTimer = null; return; }
    const deltaY = e.touches[0].clientY - touchStartY;
    // If swiped down more than 20px, decrement
    if (deltaY > 20) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      longPressFired = true;
      decrementSize(btn.dataset.sku, btn.dataset.size);
    }
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    if (longPressFired) return;
    const btn = e.target.closest('.size-btn');
    if (!btn) return;
    e.preventDefault();
    incrementSize(btn.dataset.sku, btn.dataset.size);
  });

  document.addEventListener('touchcancel', function() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  });

  // Desktop: click = increment, dblclick = popup, contextmenu (right-click) = decrement
  document.addEventListener('click', function(e) {
    const btn = e.target.closest('.size-btn');
    if (!btn) return;
    // Skip if this was triggered by touch (touch events fire click too)
    if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
    incrementSize(btn.dataset.sku, btn.dataset.size);
  });

  document.addEventListener('dblclick', function(e) {
    const btn = e.target.closest('.size-btn');
    if (!btn) return;
    e.preventDefault();
    // Undo the extra increment from the second click
    decrementSize(btn.dataset.sku, btn.dataset.size);
    showQtyPopup(btn.dataset.sku, btn.dataset.size);
  });

  document.addEventListener('contextmenu', function(e) {
    const btn = e.target.closest('.size-btn');
    if (!btn) return;
    e.preventDefault();
    decrementSize(btn.dataset.sku, btn.dataset.size);
  });
})();

// Keep legacy function name for any other callers
function toggleSize(sku, size) {
  incrementSize(sku, size);
}

function addOneToAll(sku) {
  if (!orderData[sku]) {
    const product = findProductBySku(sku);
    orderData[sku] = {
      sku: sku,
      sizes: {},
      productName: product?.name,
      collectionId: product?.collection_id,
      subsectionId: product?.subsection_id,
      delivery_months: product?.delivery_months,
      deliveryMonth: getDeliveryMonthForSku(sku)
    };
    (product?.available_sizes || []).forEach(s => { orderData[sku].sizes[s] = 0; });
  }
  if (Object.keys(orderData[sku].sizes).length === 0) {
    const product = findProductBySku(sku);
    (product?.available_sizes || []).forEach(s => { orderData[sku].sizes[s] = 0; });
  }
  Object.keys(orderData[sku].sizes).forEach(size => {
    orderData[sku].sizes[size] = (orderData[sku].sizes[size] || 0) + 1;
  });
  updateUI();
}

function clearCard(sku) {
  if (orderData[sku]) {
    Object.keys(orderData[sku].sizes).forEach(size => {
      orderData[sku].sizes[size] = 0;
    });
    updateUI();
  }
}

function findProductBySku(sku) {
  // Program products are handled separately
  if (sku.startsWith('prog:')) return null;
  for (let col of COLLECTIONS) {
    for (let sub of col.subsections) {
      const prod = sub.products.find(p => p.sku === sku);
      if (prod) return prod;
    }
  }
  return null;
}

function applyOrderDataToCards() {
  // Update ALL matching product cards (handles both main view and My Selections)
  Object.entries(orderData).forEach(([sku, item]) => {
    document.querySelectorAll(`.product-card[data-sku="${CSS.escape(sku)}"]`).forEach(card => {
      Object.entries(item.sizes || {}).forEach(([size, qty]) => {
        card.querySelectorAll('.size-btn').forEach(btn => {
          if (btn.dataset.size === size) {
            btn.classList.toggle('active', qty > 0);
            btn.textContent = qty > 0 ? qty : '—';
          }
        });
      });
    });
  });
}

function updateUI() {
  applyOrderDataToCards();
  updateTotals();
  updateMySelections();
}

function updateTotals() {
  let totalUnits = 0;
  let totalValue = 0;

  Object.entries(orderData).forEach(([sku, item]) => {
    const quantities = Object.values(item.sizes || {});
    const itemUnits = quantities.reduce((a, b) => a + b, 0);
    totalUnits += itemUnits;

    if (sku.startsWith('prog:')) {
      // Program product pricing
      if (itemUnits > 0 && item._programKey) {
        const rule = PROGRAMS.find(p => p.program_key === item._programKey);
        const pp = findProgramProductById(item._programProductId);
        if (rule && pp) {
          totalValue += getProgramPrice(rule, pp) * itemUnits;
        }
      }
    } else {
      const product = findProductBySku(sku);
      if (product && itemUnits > 0) {
        const price = currentCountry === 'NZD'
          ? product.nzd_ws_price
          : product.aud_ws_price;
        totalValue += price * itemUnits;
      }
    }
  });

  document.getElementById('grand-units').textContent = totalUnits;
  document.getElementById('grand-total').textContent = '$' + totalValue.toFixed(2);

  // Update dynamic program thresholds
  updateProgramThresholds();
}

function updateProgramThresholds() {
  // Calculate non-program units for threshold evaluation
  let mainOrderUnits = 0;
  const unitsBySubsection = {};   // subsection_id -> total units
  Object.entries(orderData).forEach(([sku, item]) => {
    if (!sku.startsWith('prog:')) {
      const qty = Object.values(item.sizes || {}).reduce((a, b) => a + b, 0);
      mainOrderUnits += qty;
      if (item.subsectionId && qty > 0) {
        unitsBySubsection[item.subsectionId] = (unitsBySubsection[item.subsectionId] || 0) + qty;
      }
    }
  });

  ELIGIBLE_PROGRAMS.forEach(prog => {
    const cond = prog.conditions || {};
    let locked = false;
    let thresholdMsg = '';

    // Condition: once_per_season (already claimed by this customer)
    if (prog.once_per_season && PROGRAM_CLAIMED_KEYS.has(prog.program_key)) {
      locked = true;
      thresholdMsg = 'This program has already been claimed for this account this season.';
    }

    // Condition: min_order_total_units (overall order minimum)
    if (cond.min_order_total_units) {
      const needed = cond.min_order_total_units;
      const remaining = needed - mainOrderUnits;
      if (remaining > 0) {
        locked = true;
        thresholdMsg = `Add <strong>${remaining}</strong> more unit${remaining !== 1 ? 's' : ''} to your main order to unlock this program (minimum ${needed} units required).`;
      }
    }

    // Condition: min_subsection_units (units from specific subsections)
    console.log('[THRESHOLD DEBUG]', prog.program_key, 'conditions:', JSON.stringify(cond), 'type:', typeof cond, 'min_sub:', cond.min_subsection_units, 'unitsBySub:', JSON.stringify(unitsBySubsection));
    if (cond.min_subsection_units) {
      const { subsection_ids, min_units } = cond.min_subsection_units;
      console.log('[THRESHOLD MATCH]', prog.program_key, 'subsection_ids:', subsection_ids, 'min_units:', min_units, 'isArray:', Array.isArray(subsection_ids));
      if (Array.isArray(subsection_ids) && min_units) {
        const matchedUnits = subsection_ids.reduce((sum, sid) => sum + (unitsBySubsection[sid] || 0), 0);
        const remaining = min_units - matchedUnits;
        if (remaining > 0) {
          locked = true;
          // Resolve subsection names for a friendly message
          const names = subsection_ids.map(sid => {
            for (const col of COLLECTIONS) {
              const sub = (col.subsections || []).find(s => s.id === sid);
              if (sub) return sub.name;
            }
            return sid;
          });
          const nameList = names.length <= 2 ? names.join(' and ') : names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
          thresholdMsg += (thresholdMsg ? '<br>' : '') + `Add <strong>${remaining}</strong> more unit${remaining !== 1 ? 's' : ''} from <strong>${nameList}</strong> to unlock this program (minimum ${min_units} units required).`;
        }
      }
    }

    // Apply threshold state to the UI
    const el = document.getElementById(`prog-threshold-${prog.program_key}`);
    if (el) {
      if (locked) {
        el.style.display = 'block';
        el.innerHTML = thresholdMsg;
      } else {
        el.style.display = 'none';
      }
    }
    const section = document.querySelector(`.program-section[data-prog-key="${prog.program_key}"]`);
    if (section) {
      section.querySelectorAll('.size-btn').forEach(btn => {
        btn.disabled = locked;
        btn.style.opacity = locked ? '0.4' : '1';
      });
    }
  });
}

function updatePricing() {
  currentCountry = document.getElementById('country-select').value;
  renderCollections();
  renderProgramPanels();
  // Restore active tab (renderCollections resets to tab 1)
  if (currentTabId) switchTab(currentTabId);
  // Restore button states from orderData (renderCollections wipes the DOM)
  updateUI();
  updateTotals();
}

function parseMonthForSort(monthStr) {
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  // Handle separators: hyphen, space, slash
  const parts = (monthStr || '').trim().split(/[-\/\s]+/);
  for (let i = 0; i < parts.length - 1; i++) {
    const mIdx = months.indexOf(parts[i].toLowerCase().slice(0, 3));
    const yr = parseInt(parts[i + 1]) || 0;
    if (mIdx >= 0 && yr > 0) {
      // Normalise 2-digit year: 26 → 2026
      const fullYr = yr < 100 ? 2000 + yr : yr;
      return fullYr * 100 + mIdx;
    }
  }
  return 99999; // 'Unscheduled' or unknown goes last
}

function toggleMsMonth(el) {
  const body = el.nextElementSibling;
  const icon = el.querySelector('.ms-toggle-icon');
  body.classList.toggle('open');
  icon.classList.toggle('closed');
}

function updateMySelections() {
  const panel = document.getElementById('my-selections-panel');
  if (!mySelectionsMode) return;

  // Group selected SKUs by delivery month
  const grouped = {};
  Object.entries(orderData).forEach(([sku, item]) => {
    const qtys = Object.values(item.sizes || {});
    if (qtys.some(q => q > 0)) {
      const month = item.deliveryMonth || 'Unscheduled';
      if (!grouped[month]) grouped[month] = [];
      grouped[month].push(sku);
    }
  });

  if (Object.keys(grouped).length === 0) {
    panel.innerHTML = '<p class="ms-empty">No selections yet</p>';
    return;
  }

  // Sort months chronologically, Unscheduled last
  const sortedMonths = Object.keys(grouped).sort(
    (a, b) => parseMonthForSort(a) - parseMonthForSort(b)
  );

  panel.innerHTML = sortedMonths.map(month => {
    const skus = grouped[month];
    const totalUnits = skus.reduce((sum, sku) => {
      return sum + Object.values(orderData[sku]?.sizes || {}).reduce((a, b) => a + b, 0);
    }, 0);

    // Sort by item_number within the delivery month
    skus.sort((a, b) => {
      const pa = findProductBySku(a);
      const pb = findProductBySku(b);
      return (pa?.item_number || 99999) - (pb?.item_number || 99999);
    });

    const cards = skus.map(sku => {
      const prod = findProductBySku(sku);
      return prod ? renderProductCard(prod) : '';
    }).join('');

    return `
      <div class="ms-month-group">
        <div class="ms-month-header" data-action="toggleMsMonth">
          <div class="ms-month-header-left">
            <span class="ms-toggle-icon">▼</span>
            <span class="ms-month-name">${escapeHtml(month)}</span>
          </div>
          <span class="ms-month-meta">${skus.length} style${skus.length !== 1 ? 's' : ''} · ${totalUnits} unit${totalUnits !== 1 ? 's' : ''}</span>
        </div>
        <div class="ms-month-body open">
          <div class="product-grid">
            ${cards}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Restore qty button states on the freshly rendered cards (no recursion — skip updateMySelections)
  applyOrderDataToCards();
}

function toggleMySelections() {
  mySelectionsMode = !mySelectionsMode;
  document.getElementById('btn-my-selections').classList.toggle('active', mySelectionsMode);
  document.getElementById('collections-container').style.display = mySelectionsMode ? 'none' : 'block';
  document.getElementById('my-selections-panel').classList.toggle('active', mySelectionsMode);
  updateMySelections();
}

function removeSelection(sku) {
  delete orderData[sku];
  updateUI();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER SUBMISSION
// ═══════════════════════════════════════════════════════════════════════════════

async function generateNextOrderId() {
  const year = new Date().getFullYear();
  const prefix = `ORD-${year}-`;

  const { data, error } = await supa
    .from('orders')
    .select('order_id')
    .ilike('order_id', prefix + '%');

  if (error) {
    return `${prefix}000001`;
  }

  // Find the highest sequence number already used and add 1
  let maxNum = 0;
  (data || []).forEach(row => {
    const seq = parseInt(row.order_id.replace(prefix, ''), 10);
    if (!isNaN(seq) && seq > maxNum) maxNum = seq;
  });

  return prefix + String(maxNum + 1).padStart(6, '0');
}

// ── BUILD ORDER GROUPS ────────────────────────────────────────────────────────
// Returns months sorted chronologically, each with subsections and products.
function buildOrderGroups() {
  const monthMap = {};
  const programMap = {}; // Separate bucket for program items

  Object.entries(orderData).forEach(([sku, item]) => {
    const sizes = item.sizes || {};
    const totalQty = Object.values(sizes).reduce((a, b) => a + b, 0);
    if (totalQty === 0) return;

    // Handle program items separately
    if (sku.startsWith('prog:') && item._programKey) {
      const progKey = item._programKey;
      const pp = findProgramProductById(item._programProductId);
      const rule = PROGRAMS.find(p => p.program_key === progKey);
      if (!programMap[progKey]) {
        programMap[progKey] = {
          programName: item._programName || progKey,
          rule: rule,
          products: []
        };
      }
      programMap[progKey].products.push({
        sku: pp?.sku || sku,
        item,
        product: pp ? {
          sku: pp.sku,
          name: pp.style_name,
          colour: pp.colour || '',
          fit: '',
          isNew: false,
          aud_ws_price: rule ? getProgramPrice(rule, pp) : pp.aud_price,
          aud_rrp_price: pp.aud_price,
          nzd_ws_price: rule ? getProgramPrice(rule, pp) : pp.nzd_price,
          nzd_rrp_price: pp.nzd_price,
          base_sku: pp.sku
        } : null,
        _isProgramItem: true
      });
      return;
    }

    const product = findProductBySku(sku);
    const month = item.deliveryMonth || 'Unknown';
    const subsectionId = item.subsectionId || 'other';

    // Resolve subsection name from COLLECTIONS
    let subsectionName = subsectionId;
    COLLECTIONS.forEach(col => {
      col.subsections.forEach(sub => {
        if (sub.id === subsectionId) subsectionName = sub.name;
      });
    });

    if (!monthMap[month]) {
      monthMap[month] = { month, sortKey: parseMonthForSort(month), subsections: {} };
    }
    if (!monthMap[month].subsections[subsectionId]) {
      monthMap[month].subsections[subsectionId] = { name: subsectionName, products: [] };
    }
    monthMap[month].subsections[subsectionId].products.push({ sku, item, product });
  });

  const groups = Object.values(monthMap)
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(m => ({ ...m, subsections: Object.values(m.subsections) }));

  // Append program groups at the end (as a special "Programs" month)
  const progEntries = Object.values(programMap);
  if (progEntries.length > 0) {
    groups.push({
      month: 'Programs',
      sortKey: 999999, // Always last
      isPrograms: true,
      subsections: progEntries.map(pe => ({
        name: pe.programName,
        products: pe.products,
        _rule: pe.rule
      }))
    });
  }

  return groups;
}

// ── SHOW REVIEW MODAL ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMER INSIGHT POPUP
// ═══════════════════════════════════════════════════════════════════════════════

function showCustomerInsight() {
  const cmakey = document.getElementById('account').dataset.cmakey || '';
  const cust = CUSTOMER_DB.find(r => r.cmakey === cmakey);
  const customerName = cust?.customer || document.getElementById('account').value || '—';

  // Header
  document.getElementById('ci-name').textContent = customerName;
  const group = cust?.group || '';
  const groupEl = document.getElementById('ci-group');
  groupEl.textContent = group || '';
  groupEl.style.display = group ? '' : 'none';

  // Group logo
  const logoEl = document.getElementById('ci-logo');
  if (group) {
    logoEl.src = `https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/logos/ANZ_${encodeURIComponent(group)}.jpg`;
    logoEl.style.display = '';
    logoEl.onerror = function() { this.style.display = 'none'; this.onerror = null; };
  } else {
    logoEl.style.display = 'none';
  }

  // Prior season
  const priorTotal = cust?.previousUnits || 0;
  document.getElementById('ci-prior-total').textContent = priorTotal.toLocaleString();
  document.getElementById('ci-prior-breakdown').innerHTML = [
    { label: "Men's", value: cust?.previousMens || 0 },
    { label: "Women's", value: cust?.previousWomens || 0 },
    { label: 'Junior', value: cust?.previousJunior || 0 },
    { label: 'Accessories', value: cust?.previousAccessories || 0 }
  ].map(r => `<li><span>${r.label}</span><span>${r.value}</span></li>`).join('');

  // Current order breakdown. Mirrors the Prior Season layout:
  // Men's, Women's, Junior, Accessories. Rainwear is bucketed into
  // Men's to match how the customer_season_history aggregates it.
  let totalUnits   = 0;
  let mensUnits    = 0;
  let womensUnits  = 0;
  let juniorUnits  = 0;
  let accessoryUnits = 0;

  Object.entries(orderData).forEach(([sku, item]) => {
    const qty = Object.values(item.sizes || {}).reduce((a, b) => a + b, 0);
    if (qty === 0) return;
    totalUnits += qty;
    const cid = (item.collectionId || '').toLowerCase();
    if (cid === 'accessories')                                   accessoryUnits += qty;
    else if (cid === 'junior')                                   juniorUnits    += qty;
    else if (cid === 'womens' || cid.indexOf('womens') === 0)    womensUnits    += qty;
    else if (cid === 'mens-collections' || cid === 'mens-core'
          || cid.indexOf('mens') === 0 || cid === 'rainwear')    mensUnits      += qty;
    // Anything else falls outside the four buckets and is only counted
    // in the total, so the breakdown sum may be < total; that's a
    // signal the bucketing rules above need updating.
  });

  // Keep apparelUnits available for the partner-tier progress bar below;
  // it represents everything that isn't accessories.
  const apparelUnits = totalUnits - accessoryUnits;

  document.getElementById('ci-current-total').textContent = totalUnits.toLocaleString();
  document.getElementById('ci-current-breakdown').innerHTML = [
    { label: "Men's",       value: mensUnits      },
    { label: "Women's",     value: womensUnits    },
    { label: 'Junior',      value: juniorUnits    },
    { label: 'Accessories', value: accessoryUnits }
  ].map(r => `<li><span>${r.label}</span><span>${r.value}</span></li>`).join('');

  // ── PARTNER TIER PROGRESS ─────────────────────────────────────────────────
  const PARTNER_CATEGORIES = ['green grass', 'driving range'];
  const category = (cust?.category || '').toLowerCase();
  const partnerSection = document.getElementById('ci-partner-section');

  if (PARTNER_CATEGORIES.includes(category)) {
    partnerSection.style.display = '';

    const TIERS = [
      { name: 'Non Partner',           min: 0,   max: 11,  cls: 'tier-0' },
      { name: 'Pre Book Partner',       min: 12,  max: 99,  cls: 'tier-1' },
      { name: 'Apparel Partner',        min: 100, max: 199, cls: 'tier-2' },
      { name: 'Premium Apparel Partner',min: 200, max: null, cls: 'tier-3' }
    ];

    // Determine current tier index
    let tierIdx = 0;
    TIERS.forEach((t, i) => { if (apparelUnits >= t.min) tierIdx = i; });

    // Colour each segment — always clear inline style first to avoid stale gradients
    TIERS.forEach((tier, i) => {
      const seg = document.getElementById('ci-seg-' + i);
      const lbl = document.getElementById('ci-lbl-' + i);

      // Reset both class and inline style on every render
      seg.style.background = '';

      if (i < tierIdx) {
        // Fully completed tier — solid colour via CSS class
        seg.className = `ci-tier-segment ${tier.cls}`;

      } else if (i === tierIdx) {
        // Current tier — partial gradient fill
        // For the final tier (no upper bound) treat 200 units above min as 100%
        const range = (tier.max != null) ? (tier.max - tier.min + 1) : 200;
        const progress = Math.min((apparelUnits - tier.min) / range * 100, 100);
        seg.className = 'ci-tier-segment';
        const colour = getTierColour(i);
        seg.style.background = `linear-gradient(to right, ${colour} ${progress.toFixed(1)}%, #e5e7eb ${progress.toFixed(1)}%)`;

      } else {
        // Future tier — empty
        seg.className = 'ci-tier-segment inactive';
      }

      lbl.className = 'ci-tier-label' + (i === tierIdx ? ' active' : '');
    });

    // Badge
    const currentTier = TIERS[tierIdx];
    const badge = document.getElementById('ci-tier-badge');
    badge.className = `ci-tier-badge ${currentTier.cls}`;
    badge.textContent = currentTier.name;

    // Next tier callout
    const nextEl = document.getElementById('ci-tier-next');
    if (tierIdx < TIERS.length - 1) {
      const next = TIERS[tierIdx + 1];
      const needed = next.min - apparelUnits;
      nextEl.innerHTML = `<strong>${needed}</strong> more unit${needed !== 1 ? 's' : ''} to reach <strong>${next.name}</strong>  ·  ${apparelUnits} qualifying units so far`;
    } else {
      nextEl.innerHTML = `🏆 Maximum tier reached  ·  ${apparelUnits} qualifying units`;
    }
  } else {
    partnerSection.style.display = 'none';
  }

  document.getElementById('ci-overlay').classList.add('active');
}

function getTierColour(idx) {
  return ['#9ca3af', '#7dc4e0', '#3a8fc0', '#1a5f7a'][idx] || '#e5e7eb';
}

// ── REVIEW IMAGE HOVER POPUP POSITIONING ─────────────────────────────────────
function positionReviewPopup(e, sku) {
  const popup = document.getElementById('review-popup-' + sku);
  if (!popup) return;

  const PAD = 12;
  const popupW = 240;
  const popupH = 280; // approx including label

  let x = e.clientX + PAD;
  let y = e.clientY - popupH / 2;

  // Keep within right edge
  if (x + popupW > window.innerWidth - PAD) {
    x = e.clientX - popupW - PAD;
  }
  // Keep within top/bottom edges
  y = Math.max(PAD, Math.min(y, window.innerHeight - popupH - PAD));

  popup.style.left = x + 'px';
  popup.style.top  = y + 'px';
}

function showReviewModal() {
  const account = document.getElementById('account').value.trim();
  const manager = document.getElementById('account-manager').value || '—';
  const totalUnits = parseInt(document.getElementById('grand-units').textContent) || 0;

  if (!account) { alert('Please select a customer'); return; }
  if (totalUnits === 0) { alert('Please add items to order'); return; }

  const groups = buildOrderGroups();
  let grandUnits = 0, grandValue = 0;

  let html = `
    <div class="review-modal-header">
      <h2>Review Order</h2>
      <div class="review-order-meta">
        <span><strong>Account:</strong> ${escapeHtml(account)}</span>
        <span><strong>Manager:</strong> ${escapeHtml(manager)}</span>
        <span><strong>${document.getElementById('order-date-display').textContent}</strong></span>
        <span><strong>Currency:</strong> ${currentCountry}</span>
      </div>
    </div>
    <div class="review-modal-scroll">
  `;

  groups.forEach(monthGroup => {
    html += `<div class="review-month-heading">${escapeHtml(monthGroup.month)}</div>`;

    monthGroup.subsections.forEach(sub => {
      html += `<div class="review-subsection-heading">${escapeHtml(sub.name)}</div>`;
      html += `
        <table class="review-table">
          <thead><tr>
            <th>Product</th><th>SKU</th><th>Sizes Ordered</th>
            <th style="text-align:right">Units</th>
            <th style="text-align:right">WS Price</th>
            <th style="text-align:right">RRP</th>
            <th style="text-align:right">Line Total</th>
          </tr></thead>
          <tbody>
      `;

      sub.products.forEach(({ sku, item, product }) => {
        const activeSizes = Object.entries(item.sizes || {}).filter(([, q]) => q > 0);
        const sizeStr = activeSizes.map(([s, q]) => `${s}×${q}`).join('  ');
        const units = activeSizes.reduce((a, [, q]) => a + q, 0);
        const wsPrice = currentCountry === 'NZD' ? (product?.nzd_ws_price || 0) : (product?.aud_ws_price || 0);
        const rrpPrice = currentCountry === 'NZD' ? (product?.nzd_rrp_price || 0) : (product?.aud_rrp_price || 0);
        const lineTotal = wsPrice * units;
        grandUnits += units;
        grandValue += lineTotal;

        const cresting = item.cresting || {};
        let crestingNote = '';
        if (cresting.addLogo === 'Yes') {
          if (cresting.logoOption === 'Custom') {
            const parts = [cresting.position, cresting.colour];
            if (cresting.specialInstructions) parts.push(`"${escapeHtml(cresting.specialInstructions)}"`);
            crestingNote = `<div class="review-cresting-note">Logo: Custom — ${parts.map(p => escapeHtml(p)).join(' | ')}</div>`;
          } else {
            crestingNote = `<div class="review-cresting-note">Logo: Recommended</div>`;
          }
        }

        const imgSrc = `https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/product-images/FJ_${product?.base_sku || sku}_01.jpg`;

        html += `
          <tr>
            <td>
              <span class="review-product-name" data-action-hover="positionReviewPopup" data-sku="${escapeAttr(sku)}"
              >${escapeHtml(item.productName || sku)}
                <div class="review-img-popup" id="review-popup-${escapeAttr(sku)}">
                  <img src="${imgSrc}"
                       data-img-fallback="review" />
                  <div class="review-img-popup-label">${escapeHtml(item.productName || sku)}</div>
                </div>
              </span>
              ${crestingNote}
            </td>
            <td>${sku}</td>
            <td style="white-space:nowrap; letter-spacing:0.5px">${sizeStr}</td>
            <td style="text-align:right">${units}</td>
            <td style="text-align:right">$${wsPrice.toFixed(2)}</td>
            <td style="text-align:right">$${rrpPrice.toFixed(2)}</td>
            <td style="text-align:right"><strong>$${lineTotal.toFixed(2)}</strong></td>
          </tr>
        `;
      });

      html += `</tbody></table>`;
    });
  });

  html += `
    <table class="review-table" style="margin-top:16px">
      <tfoot><tr>
        <td colspan="3" style="text-align:right; font-size:11px; letter-spacing:2px; text-transform:uppercase;">Grand Total</td>
        <td style="text-align:right">${grandUnits}</td>
        <td></td><td></td>
        <td style="text-align:right">${currentCountry} $${grandValue.toFixed(2)}</td>
      </tr></tfoot>
    </table>
    </div>
  `;

  document.getElementById('review-modal-inner').innerHTML = html;
  document.getElementById('review-modal').classList.add('active');
  document.body.style.overflow = 'hidden';

  // In customer draft mode, remove Confirm & Submit and add Save instead
  if (isCustomerDraftMode) {
    var cBtn = document.getElementById('btn-confirm-submit');
    if (cBtn) cBtn.remove();
    var fr = document.querySelector('.review-modal-footer-right');
    if (fr && !fr.querySelector('.btn-save-draft-review')) {
      var sb = document.createElement('button');
      sb.className = 'btn-submit btn-save-draft-review';
      sb.textContent = '\uD83D\uDCBE Save Changes';
      sb.onclick = function() { saveDraftInPlace(sb); };
      fr.appendChild(sb);
    }
  }
}

// ── CONFIRM & SUBMIT ──────────────────────────────────────────────────────────
async function confirmSubmit() {
  const account = document.getElementById('account').value.trim();
  const manager = document.getElementById('account-manager').value || '';
  const date = document.getElementById('order-date').value || new Date().toISOString().split('T')[0];
  const comments = document.getElementById('order-comments').value || '';
  const totalUnits = parseInt(document.getElementById('grand-units').textContent) || 0;

  const btn = document.getElementById('btn-confirm-submit');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const orderId = await generateNextOrderId();

    // Calculate total value (including program items)
    let totalValue = 0;
    Object.entries(orderData).forEach(([sku, item]) => {
      const quantities = Object.values(item.sizes || {});
      const itemUnits = quantities.reduce((a, b) => a + b, 0);
      if (itemUnits <= 0) return;
      if (sku.startsWith('prog:') && item._programKey) {
        const rule = PROGRAMS.find(p => p.program_key === item._programKey);
        const pp = findProgramProductById(item._programProductId);
        if (rule && pp) totalValue += getProgramPrice(rule, pp) * itemUnits;
      } else {
        const product = findProductBySku(sku);
        if (product) {
          const price = currentCountry === 'NZD' ? product.nzd_ws_price : product.aud_ws_price;
          totalValue += price * itemUnits;
        }
      }
    });

    // Look up customer group from CUSTOMER_DB
    const cmakey = document.getElementById('account').dataset.cmakey || '';
    const custRecord = CUSTOMER_DB.find(r => r.cmakey === cmakey);
    const customerGroup = custRecord?.group || '';

    // 1. INSERT into orders
    const { error: orderError } = await supa
      .from('orders')
      .insert({
        order_id: orderId,
        pin: null,  // PINs deprecated - using Supabase Auth
        account_name: account,
        account_manager: manager,
        customer_group: customerGroup,
        country: currentCountry,
        order_date: date,
        total_units: totalUnits,
        total_value: totalValue,
        status: 'submitted'
      })
      .select()
      .single();

    if (orderError) throw new Error('Order save failed: ' + orderError.message);

    // 2. BUILD and INSERT order_lines
    const lines = [];
    Object.entries(orderData).forEach(([sku, item]) => {
      const qtys = Object.values(item.sizes || {});
      if (!qtys.some(q => q > 0)) return;
      const sizeBreakdown = Object.entries(item.sizes).map(([s, q]) => `${s}:${q}`).join(',');
      const itemUnits = qtys.reduce((a, b) => a + b, 0);

      if (sku.startsWith('prog:') && item._programKey) {
        // Program line
        const rule = PROGRAMS.find(p => p.program_key === item._programKey);
        const pp = findProgramProductById(item._programProductId);
        const unitPrice = (rule && pp) ? getProgramPrice(rule, pp) : 0;
        lines.push({
          order_id: orderId,
          sku: pp?.sku || sku,
          product_name: item.productName,
          collection_id: `PROG:${item._programKey}`,
          subsection_id: item._programName || item._programKey,
          quantity: itemUnits,
          unit_price: unitPrice,
          line_total: unitPrice * itemUnits,
          size_breakdown: sizeBreakdown,
          cresting_add_logo: 'None',
          status: 'submitted'
        });
      } else {
        // Regular collection line
        const product = findProductBySku(sku);
        const unitPrice = currentCountry === 'NZD' ? (product?.nzd_ws_price || 0) : (product?.aud_ws_price || 0);
        const cresting = item.cresting || {};
        lines.push({
          order_id: orderId,
          sku,
          product_name: item.productName,
          collection_id: item.collectionId,
          subsection_id: item.subsectionId,
          quantity: itemUnits,
          unit_price: unitPrice,
          line_total: unitPrice * itemUnits,
          size_breakdown: sizeBreakdown,
          cresting_add_logo: cresting.addLogo || 'None',
          cresting_logo_option: cresting.addLogo === 'Yes' ? (cresting.logoOption || 'Recommended') : null,
          cresting_position: cresting.addLogo === 'Yes' && cresting.logoOption === 'Custom' ? (cresting.position || 'Left Chest') : null,
          cresting_colour: cresting.addLogo === 'Yes' && cresting.logoOption === 'Custom' ? (cresting.colour || 'Match FJ (1 colour)') : null,
          cresting_special_instructions: cresting.addLogo === 'Yes' && cresting.logoOption === 'Custom' ? (cresting.specialInstructions || null) : null,
          status: 'submitted'
        });
      }
    });

    if (lines.length > 0) {
      const { error: linesError } = await supa.from('order_lines').insert(lines);
      if (linesError) throw new Error('Order lines save failed: ' + linesError.message);
    }

    // 3. Delete any drafts for this customer
    if (cmakey) {
      await supa.from('draft_orders')
        .delete()
        .filter('customer_data->>cmakey', 'eq', cmakey);
    }

    // 4. Open HTML preview + send email via EmailJS
    btn.textContent = 'Sending email…';
    try {
      const emailResult = await buildAndOpenMailto(orderId, account, manager, date, comments);
    } catch (emailErr) {
      // Non-fatal — order is already saved; warn but continue
      alert('Order saved successfully but the confirmation email failed to send.\n\nError: ' + (emailErr?.message || JSON.stringify(emailErr)));
    }

    // 5. Show success modal
    closeModal('review-modal');
    document.getElementById('success-message').textContent =
      `Order ${orderId} submitted for ${account} — ${totalUnits} units, ${currentCountry} $${totalValue.toFixed(2)}. Confirmation email sent.`;
    document.getElementById('success-modal').classList.add('active');
    document.body.style.overflow = 'hidden';

  } catch (error) {
    alert('Error submitting order. Please try again or contact support.');
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Confirm & Submit';
  }
}

// ── AS400 CODE FORMATTER ─────────────────────────────────────────────────────
function formatAS400Code(sku, size, sizeType, product) {
  const baseSku = product?.base_sku || sku;

  switch (sizeType) {
    case 'top':
      // Add sku to size with separator
      return baseSku + '-' + size;

    case 'top-old':
      // Legacy format — letter code appended directly, no separator
      return baseSku + size;

    case 'shorts':
      // Waist size stripped of quotes → e.g. 33089-32
      return baseSku + '-W' + size.replace(/"/g, '');

    case 'pants':
      // Waist + leg length → e.g. 40099-W32-L30
      const waist = size.replace(/"/g, '');
      const leg = product?.leg_length || '';
      return baseSku + '-W' + waist + (leg ? '-L' + leg : '');

    case 'womens':
      // Add sku to size with separator
      return baseSku + '-' + size;

    case 'gloves':
      // Add sku to size with separator
      return baseSku + size;

    case 'accessories':
      // Single size — just the SKU, no suffix
      return baseSku;

    case 'accessories-size':
      // Simple suffix with the size code
      return baseSku + '-' + size;

    default:
      return baseSku + '-' + size;
  }
}

// ── BUILD AND OPEN EMAIL PREVIEW + MAILTO ────────────────────────────────────
async function buildAndOpenMailto(orderId, account, manager, date, comments) {
  const groups = buildOrderGroups();
  const [y, m, d] = date.split('-');
  const displayDate = `${d}/${m}/${y}`;

  // Find customer email
  const accountInput = document.getElementById('account');
  const cmakey = accountInput.dataset.cmakey || '';
  const customerRecord = CUSTOMER_DB.find(r => r.cmakey === cmakey);
  const toEmail = customerRecord?.email || '';

  const NAVY = '#1a2744';
  const currSymbol = currentCountry === 'NZD' ? 'NZ$' : 'A$';

  // ── PER-MONTH DUAL-TABLE BUILDER ────────────────────────────────────────────
  function buildMonthsHTML(groups) {
    const SIZE_ORDER = [
      'XXS','XS','S','M','L','XL','2XL','3XL','4XL',
      '28"','30"','32"','34"','36"','38"','40"','42"','44"','46"'
    ];
    const MUTED = `font-family:Arial,sans-serif;font-size:11px;color:#444;
                   background:#f0f2f8;border-left:3px solid ${NAVY};
                   padding:7px 12px;margin:0 0 8px;border-radius:2px;display:block;`;
    let html = '';

    groups.forEach(monthGroup => {
      // Flatten all products for this month
      const allProducts = [];
      monthGroup.subsections.forEach(sub => {
        sub.products.forEach(p => allProducts.push(p));
      });
      if (allProducts.length === 0) return;

      const month = monthGroup.month;

      // Does any product this month have logo embroidery?
      const anyCresting = allProducts.some(({ item }) => (item.cresting?.addLogo || 'None') === 'Yes');

      // Collect unique sizes used this month, in canonical order
      const monthSizesSet = new Set();
      allProducts.forEach(({ item }) => {
        Object.entries(item.sizes || {}).filter(([, q]) => q > 0).forEach(([s]) => monthSizesSet.add(s));
      });
      const orderedSizes = SIZE_ORDER.filter(s => monthSizesSet.has(s));
      monthSizesSet.forEach(s => { if (!orderedSizes.includes(s)) orderedSizes.push(s); });

      // ── MONTH HEADING ──────────────────────────────────────────────────────
      html += `
      <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:${NAVY};
                  letter-spacing:1px;text-transform:uppercase;margin:32px 0 10px;
                  border-bottom:2px solid ${NAVY};padding-bottom:6px;">${month}</div>`;

      // ── TABLE 1: AS400 Entry ───────────────────────────────────────────────
      html += `
      <div style="${MUTED}">
        <strong>AS400 Entry</strong> &nbsp;—&nbsp; Copy SKU and Quantity into AS400
      </div>
      <table style="width:auto;border-collapse:collapse;font-family:Arial,sans-serif;
                    font-size:12px;margin-bottom:24px;">
        <thead>
          <tr>
            <th style="background:${NAVY};color:white;padding:6px 18px 6px 10px;text-align:center;
                       font-size:11px;font-weight:600;white-space:nowrap;">Qty</th>
            <th style="background:${NAVY};color:white;padding:6px 18px 6px 10px;text-align:left;
                       font-size:11px;font-weight:600;white-space:nowrap;">AS400 Code</th>
          </tr>
        </thead>
        <tbody>`;

      let rowIdx = 0;
      allProducts.forEach(({ sku, item, product }) => {
        const sizes = item.sizes || {};
        const sizeType = product?.size_type || 'top';

        // Emit one row per size that has quantity > 0
        Object.entries(sizes).forEach(([size, qty]) => {
          if (qty <= 0) return;
          const as400Code = formatAS400Code(sku, size, sizeType, product);
          const bg = rowIdx % 2 === 0 ? '#ffffff' : '#f9f9f9';
          rowIdx++;
          html += `
            <tr style="background:${bg};">
              <td style="padding:5px 10px;border:1px solid #ddd;text-align:center;font-weight:600;">${qty}</td>
              <td style="padding:5px 10px;border:1px solid #ddd;font-family:monospace;">${as400Code}</td>
            </tr>`;
        });
      });

      html += `
        </tbody>
      </table>`;

      // ── TABLE 2: Order Verification ────────────────────────────────────────
      // colspan for "Month Total:" label = everything except the final Line Total cell
      // columns: Product Name, SKU, Colour, ...sizes, Unit Price, Line Total[, Logo Cresting]
      const labelColspan = 3 + orderedSizes.length + 1; // up to & including Unit Price
      let monthTotal = 0;

      html += `
      <div style="${MUTED}">
        <strong>Order Verification</strong> &nbsp;—&nbsp; Check your order against this list before submitting to AS400
      </div>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;
                    font-size:12px;margin-bottom:8px;">
        <thead>
          <tr>
            <th style="background:${NAVY};color:white;padding:6px 10px;text-align:left;
                       font-size:11px;font-weight:600;">Product Name</th>
            <th style="background:${NAVY};color:white;padding:6px 10px;text-align:left;
                       font-size:11px;font-weight:600;white-space:nowrap;">SKU</th>
            <th style="background:${NAVY};color:white;padding:6px 10px;text-align:left;
                       font-size:11px;font-weight:600;">Colour</th>`;

      orderedSizes.forEach(size => {
        html += `<th style="background:${NAVY};color:white;padding:6px 8px;text-align:center;
                            font-size:11px;font-weight:600;white-space:nowrap;">${size}</th>`;
      });

      html += `
            <th style="background:${NAVY};color:white;padding:6px 10px;text-align:right;
                       font-size:11px;font-weight:600;white-space:nowrap;">Unit Price</th>
            <th style="background:${NAVY};color:white;padding:6px 10px;text-align:right;
                       font-size:11px;font-weight:600;white-space:nowrap;">Line Total</th>`;

      if (anyCresting) {
        html += `<th style="background:${NAVY};color:white;padding:6px 10px;text-align:left;
                            font-size:11px;font-weight:600;">Logo Embroidery</th>`;
      }

      html += `</tr></thead><tbody>`;

      allProducts.forEach(({ sku, item, product }, idx) => {
        const sizes = item.sizes || {};
        const totalQty = Object.values(sizes).reduce((a, b) => a + b, 0);
        if (totalQty === 0) return;

        const unitPrice = currentCountry === 'NZD'
          ? (product?.nzd_ws_price || 0)
          : (product?.aud_ws_price || 0);
        const lineTotal = unitPrice * totalQty;
        monthTotal += lineTotal;

        const bg = idx % 2 === 0 ? '#ffffff' : '#f9f9f9';
        const c = item.cresting || {};
        let crestingText = '—';
        if ((c.addLogo || 'None') === 'Yes') {
          const parts = [c.logoOption === 'Custom' ? 'Custom' : 'Recommended'];
          if (c.position) parts.push(c.position);
          if (c.colour) parts.push(c.colour);
          if (c.specialInstructions) parts.push(`"${c.specialInstructions}"`);
          crestingText = parts.join(' · ');
        }

        html += `
          <tr style="background:${bg};">
            <td style="padding:5px 10px;border:1px solid #ddd;">${item.productName || sku}</td>
            <td style="padding:5px 10px;border:1px solid #ddd;font-family:monospace;white-space:nowrap;">${sku}</td>
            <td style="padding:5px 10px;border:1px solid #ddd;white-space:nowrap;">${product?.colour || '—'}</td>`;

        orderedSizes.forEach(size => {
          const qty = sizes[size] || 0;
          html += `<td style="padding:5px 8px;border:1px solid #ddd;text-align:center;">
                     ${qty > 0 ? qty : '<span style="color:#ccc;">—</span>'}
                   </td>`;
        });

        html += `
            <td style="padding:5px 10px;border:1px solid #ddd;text-align:right;white-space:nowrap;">
              ${currSymbol}${unitPrice.toFixed(2)}
            </td>
            <td style="padding:5px 10px;border:1px solid #ddd;text-align:right;font-weight:600;white-space:nowrap;">
              ${currSymbol}${lineTotal.toFixed(2)}
            </td>`;

        if (anyCresting) {
          html += `<td style="padding:5px 10px;border:1px solid #ddd;font-size:11px;">${crestingText}</td>`;
        }

        html += `</tr>`;
      });

      // Month total footer row
      html += `
          <tr style="background:#eef0f7;">
            <td colspan="${labelColspan}"
                style="padding:7px 10px;border:1px solid #ddd;font-weight:700;
                       color:${NAVY};text-align:right;font-size:12px;">
              Month Total:
            </td>
            <td style="padding:7px 10px;border:1px solid #ddd;font-weight:700;
                       text-align:right;color:${NAVY};white-space:nowrap;font-size:13px;">
              ${currSymbol}${monthTotal.toFixed(2)}
            </td>
            ${anyCresting ? `<td style="border:1px solid #ddd;background:#eef0f7;"></td>` : ''}
          </tr>
        </tbody>
      </table>`;
    });

    return html;
  }

  // ── ASSEMBLE FULL HTML DOCUMENT ─────────────────────────────────────────────
  const monthsHTML = buildMonthsHTML(groups);

  const fullHTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>FootJoy Prebook Order — ${account} — ${displayDate}</title>
</head>
<body style="margin:0;padding:24px 32px;background:#f5f6fa;font-family:Arial,sans-serif;">

  <div style="max-width:900px;margin:0 auto;background:white;padding:32px;
              border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;
                border-bottom:3px solid ${NAVY};padding-bottom:16px;margin-bottom:20px;">
      <div>
        <div style="font-size:20px;font-weight:700;color:${NAVY};
                    letter-spacing:2px;text-transform:uppercase;">
          FootJoy Apparel — Prebook Order
        </div>
        <div style="font-size:11px;color:#888;margin-top:4px;">Order ID: ${orderId}</div>
      </div>
    </div>

    <!-- Order meta -->
    <table style="width:100%;font-size:12px;margin-bottom:24px;border-collapse:collapse;">
      <tr>
        <td style="padding:4px 0;color:#555;width:130px;">Account:</td>
        <td style="padding:4px 0;font-weight:600;color:${NAVY};">${account}</td>
        <td style="padding:4px 0;color:#555;width:120px;">Order Date:</td>
        <td style="padding:4px 0;font-weight:600;color:${NAVY};">${displayDate}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#555;">Account Manager:</td>
        <td style="padding:4px 0;font-weight:600;color:${NAVY};">${manager || '—'}</td>
        <td style="padding:4px 0;color:#555;">Comments:</td>
        <td style="padding:4px 0;color:${NAVY};">${comments || '—'}</td>
      </tr>
    </table>

    ${monthsHTML}

    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #ddd;
                font-size:10px;color:#aaa;text-align:center;">
      Generated by FootJoy Apparel Prebook Order Form
    </div>
  </div>

</body></html>`;

  // Send via Supabase Edge Function (Brevo key is server-side)
  const subject = `FootJoy Apparel Prebook Order \u2014 ${account} \u2014 ${displayDate}`;

  // Use the authenticated user's session token (not the anon key)
  const { data: { session: _emailSession } } = await supa.auth.getSession();
  const _emailToken = _emailSession?.access_token || SUPABASE_ANON_KEY;

  const response = await fetch(EMAIL_EDGE_FN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + _emailToken
    },
    body: JSON.stringify({
      subject: subject,
      html:    fullHTML
    })
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(`Email edge function error ${response.status}: ${errBody.message || response.statusText}`);
  }

  return response;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function exportToExcel() {
  const account = document.getElementById('account').value || 'Order';
  const date = document.getElementById('order-date').value || new Date().toISOString().split('T')[0];

  const data = [
    ['FOOTJOY APPAREL PREBOOK ORDER'],
    [],
    ['Account:', account],
    ['Date:', date],
    ['Country:', currentCountry],
    [],
    ['SKU', 'Product', 'Colour', 'Fit', 'Quantity', 'Unit Price', 'Line Total', 'Add Logo', 'Logo Option', 'Logo Position', 'Logo Colour', 'Logo Special Instructions']
  ];

  Object.entries(orderData).forEach(([sku, item]) => {
    const qtys = Object.values(item.sizes || {});
    if (qtys.some(q => q > 0)) {
      const itemUnits = qtys.reduce((a, b) => a + b, 0);
      let price, colour, fit;

      if (sku.startsWith('prog:') && item._programKey) {
        const rule = PROGRAMS.find(p => p.program_key === item._programKey);
        const pp = findProgramProductById(item._programProductId);
        price = (rule && pp) ? getProgramPrice(rule, pp) : 0;
        colour = pp?.colour || '';
        fit = item._programName || '';
      } else {
        const product = findProductBySku(sku);
        price = currentCountry === 'NZD'
          ? (product?.nzd_ws_price || 0)
          : (product?.aud_ws_price || 0);
        colour = product?.colour || '';
        fit = product?.fit || '';
      }

      const cresting = item.cresting || {};
      const addLogo = cresting.addLogo || 'None';
      const logoOption = addLogo === 'Yes' ? (cresting.logoOption || 'Recommended') : '';
      const isCustom = addLogo === 'Yes' && logoOption === 'Custom';
      const position = isCustom ? (cresting.position || '') : '';
      const crestColour = isCustom ? (cresting.colour || '') : '';
      const specialInstructions = isCustom ? (cresting.specialInstructions || '') : '';

      data.push([
        sku.startsWith('prog:') ? (findProgramProductById(item._programProductId)?.sku || sku) : sku,
        item.productName,
        colour,
        fit,
        itemUnits,
        price,
        price * itemUnits,
        addLogo,
        logoOption,
        position,
        crestColour,
        specialInstructions
      ]);
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Order');
  XLSX.writeFile(wb, `FJ_Order_${account}_${date}.xlsx`);
}

async function generateCustomerPDF() {
  const accountInput   = document.getElementById('account');
  const account        = accountInput.value.trim();
  const cmakey         = accountInput.dataset.cmakey || '';
  const customerRecord = CUSTOMER_DB.find(r => r.cmakey === cmakey);
  const accountCode    = customerRecord?.account || cmakey || '—';
  const manager        = document.getElementById('account-manager').value || '—';
  const dateVal        = document.getElementById('order-date-display').textContent
                           .replace(/^Order Date:\s*/i, '').trim();
  const comments     = document.getElementById('order-comments')?.value
                    || document.getElementById('comments')?.value || '';
  const groupName    = customerRecord?.group || '';

  if (!account) { alert('Please select a customer'); return; }

  const groups = buildOrderGroups();
  if (groups.length === 0) { alert('No items in order'); return; }

  const currSymbol = currentCountry === 'NZD' ? 'NZ$' : 'A$';

  const SIZE_ORDER = ['XXS','XS','S','M','L','XL','2XL','3XL','4XL',
                      '28"','30"','32"','34"','36"','38"','40"','42"','44"','46"'];
  const NAVY = '#1a2744';
  const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect fill='%23f3f4f6' width='80' height='80'/%3E%3Ctext x='40' y='44' font-size='10' fill='%23aaa' text-anchor='middle'%3ENo img%3C/text%3E%3C/svg%3E";

  // ── Season label for banner subtitle ──────────────────────────────────────
  const seasonId = window._selectedSeason || 'AW27';
  const seasonPrefix = seasonId.replace(/\d+$/, '');
  const seasonYear = parseInt(seasonId.replace(/^\D+/, ''));
  const seasonLabel = (seasonPrefix === 'AW' ? 'Autumn / Winter' : 'Spring / Summer') + ' 20' + seasonYear;
  const bannerImg = `https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/seasonal-images/season-${seasonId}-banner.jpg`;
  const fjLogoBlack = 'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/logos/FJ_logo_FullLockup_HRZ_B.jpg';
  const curateLogoBlack = 'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/logos/curate-logo-b.png';
  const groupLogoUrl = groupName ? `https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/logos/ANZ_${groupName}.jpg` : '';

  // ── Compute grand totals ──────────────────────────────────────────────────
  let grandUnits = 0, grandValue = 0;
  groups.forEach(g => g.subsections.forEach(sub => sub.products.forEach(({ item, product }) => {
    const qty = Object.values(item.sizes || {}).reduce((a, b) => a + b, 0);
    const p   = currentCountry === 'NZD' ? (product?.nzd_ws_price || 0) : (product?.aud_ws_price || 0);
    grandUnits += qty; grandValue += p * qty;
  })));

  const grandValueInclGST = grandValue * 1.1;

  // ── Build body HTML (months → subsections → strip rows) ──────────────────
  let bodyHTML = '';
  groups.forEach(monthGroup => {
    let monthUnits = 0, monthValue = 0;

    // Pre-calculate month totals for the header bar
    monthGroup.subsections.forEach(sub => sub.products.forEach(({ item, product }) => {
      const qty = Object.values(item.sizes || {}).reduce((a, b) => a + b, 0);
      const p = currentCountry === 'NZD' ? (product?.nzd_ws_price || 0) : (product?.aud_ws_price || 0);
      monthUnits += qty; monthValue += p * qty;
    }));

    const monthLabel = monthGroup.isPrograms
      ? `PROGRAMS`
      : `${monthGroup.month} &nbsp; DELIVERY`;
    let mHTML = `<div class="fpdf-month-h"><span>${monthLabel}</span><span class="fpdf-month-h-right">${monthUnits} units &nbsp;&mdash;&nbsp; ${currSymbol}${monthValue.toFixed(2)}</span></div>`;

    monthGroup.subsections.forEach(sub => {
      mHTML += `<div class="fpdf-sub-h">${escapeHtml(sub.name)}</div>`;

      // Helper: build a single strip row
      function buildStrip(sku, item, product) {
        const sizes    = item.sizes || {};
        const totalQty = Object.values(sizes).reduce((a, b) => a + b, 0);
        const wsPrice  = currentCountry === 'NZD' ? (product?.nzd_ws_price  || 0) : (product?.aud_ws_price  || 0);
        const rrp      = currentCountry === 'NZD' ? (product?.nzd_rrp_price || 0) : (product?.aud_rrp_price || 0);
        const lineTotal = wsPrice * totalQty;

        const domImg = document.querySelector(`#card-${CSS.escape(sku)} img`);
        const imgSrc = (domImg && domImg.src && !domImg.src.includes('svg')) ? domImg.src
          : `https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/product-images/FJ_${product?.base_sku || sku}_01.jpg`;

        const activeSizes = SIZE_ORDER.filter(s => (sizes[s] || 0) > 0);
        const sizesHTML = activeSizes.map(s => `
          <div class="strip-size-col">
            <div class="strip-size-lbl">${s}</div>
            <div class="strip-size-box">${sizes[s]}</div>
          </div>`).join('');

        const c = item.cresting || {};
        let crestHTML = '';
        if ((c.addLogo || 'None') === 'Yes') {
          const isCustom = c.logoOption === 'Custom';
          const parts = [isCustom ? 'Custom' : 'Recommended'];
          if (isCustom && c.position) parts.push(c.position);
          if (isCustom && c.colour)   parts.push(c.colour);
          if (isCustom && c.specialInstructions) parts.push(`"${escapeHtml(c.specialInstructions)}"`);
          crestHTML = `<div class="strip-crest">&#127991; Logo Embroidery: ${parts.map(p => escapeHtml(p)).join(' &middot; ')}</div>`;
        }

        const newBadge = product?.isNew ? '<span class="new-badge">NEW</span>' : '';

        return `
          <div class="strip">
            <img class="strip-img" src="${imgSrc}" crossorigin="anonymous"
                 data-img-fallback="strip" />
            <div class="strip-body">
              <div class="strip-top">
                <div class="strip-meta">
                  <div class="strip-sku">${escapeHtml(sku)}</div>
                  <div class="strip-name-row">${newBadge}<div class="strip-name">${escapeHtml(item.productName || sku)}</div></div>
                  <div class="strip-colour">${escapeHtml(product?.colour || '')}${product?.fit ? ' &middot; ' + escapeHtml(product.fit) : ''}</div>
                  ${crestHTML}
                </div>
                <div class="strip-sizes">${sizesHTML}</div>
              </div>
              <div class="strip-bottom">
                <div class="strip-price"><div class="strip-price-lbl">Units</div><div class="strip-price-val">${totalQty}</div></div>
                <div class="strip-price"><div class="strip-price-lbl">WS Price</div><div class="strip-price-val">${currSymbol}${wsPrice.toFixed(2)}</div></div>
                <div class="strip-price"><div class="strip-price-lbl">RRP</div><div class="strip-price-val">${currSymbol}${rrp.toFixed(2)}</div></div>
                <div class="strip-price"><div class="strip-price-lbl">Line Total</div><div class="strip-price-val lt">${currSymbol}${lineTotal.toFixed(2)}</div></div>
              </div>
            </div>
          </div>`;
      }

      const activeProds = sub.products.filter(({ item }) =>
        Object.values(item.sizes || {}).reduce((a, b) => a + b, 0) > 0);

      activeProds.forEach(({ sku, item, product }) => {
        mHTML += buildStrip(sku, item, product);
      });
    });

    bodyHTML += mHTML;
  });

  // Grand total section
  bodyHTML += `
    <div class="fpdf-grand">
      <div class="fpdf-grand-title">Order Total</div>
      <div class="fpdf-grand-row">
        <div class="fpdf-p"><div class="fpdf-pl">Total Units</div><div class="fpdf-grand-v">${grandUnits}</div></div>
        <div class="fpdf-p"><div class="fpdf-pl">Total Value</div><div class="fpdf-grand-v">${currSymbol}${grandValue.toFixed(2)}</div></div>
      </div>
      ${comments ? `<div class="fpdf-comments"><strong>Comments:</strong> ${escapeHtml(comments)}</div>` : ''}
    </div>`;

  // ── Assemble print container ────────────────────────────────────────────
  const printContainer = document.getElementById('print-container');
  printContainer.innerHTML = `
<style>
  .fpdf-root *{box-sizing:border-box;margin:0;padding:0;}
  .fpdf-root{width:794px;background:white;font-family:Arial,Helvetica,sans-serif;padding:24px;}

  /* ── V1 HEADER: Logos on white + banner with overlaid text ── */
  .v1-logo-bar{display:flex;align-items:center;justify-content:space-between;padding:0 0 14px;}
  .v1-logo-fj{height:32px;}
  .v1-logo-curate{height:20px;}
  .v1-banner-wrap{position:relative;width:100%;height:130px;overflow:hidden;margin-bottom:0;}
  .v1-banner-img{width:100%;height:100%;object-fit:cover;display:block;}
  .v1-banner-overlay{position:absolute;top:0;left:0;right:0;bottom:0;
    background:linear-gradient(to right,rgba(0,0,0,0.6) 0%,rgba(0,0,0,0.2) 50%,transparent 100%);
    display:flex;align-items:center;padding:0 24px;}
  .v1-banner-text{color:white;display:flex;flex-direction:column;gap:2px;}
  .v1-banner-title{font-size:16px;font-weight:700;letter-spacing:2px;text-transform:uppercase;}
  .v1-banner-subtitle{font-size:9px;opacity:0.7;letter-spacing:1px;text-transform:uppercase;}

  /* ── INFO BAR ── */
  .v1-info-bar{display:flex;gap:0;border:1.5px solid ${NAVY};margin-bottom:20px;}
  .v1-info-cell{flex:1;padding:10px 12px;border-right:1px solid #e0e3ea;display:flex;flex-direction:column;gap:2px;}
  .v1-info-cell:last-child{border-right:none;}
  .v1-info-cell.wide{flex:2;}
  .v1-info-cell.narrow{flex:0.6;}
  .v1-info-cell.highlight{background:#f0f2f8;}
  .v1-info-lbl{font-size:7px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;}
  .v1-info-val{font-size:11px;font-weight:700;color:${NAVY};}
  .v1-info-val-lg{font-size:14px;font-weight:700;color:${NAVY};}
  .v1-group-row{display:flex;align-items:center;gap:8px;}
  .v1-group-logo{height:22px;object-fit:contain;}

  /* ── Body ── */
  .fpdf-body{padding:0;}
  .fpdf-month-h{font-size:12px;font-weight:700;color:#fff;text-transform:uppercase;
    background:#444;padding:12px 14px 10px;margin-top:18px;letter-spacing:1.5px;
    display:flex;justify-content:space-between;line-height:1;}
  .fpdf-month-h:first-child{margin-top:0;}
  .fpdf-month-h-right{font-size:10px;font-weight:600;letter-spacing:0.5px;opacity:0.9;}
  .fpdf-sub-h{font-size:8.5px;font-weight:700;color:#999;text-transform:uppercase;
    letter-spacing:1.2px;margin:14px 0 6px;border-bottom:1px solid #eee;padding-bottom:5px;}

  /* ── Compact strip layout (Demo C) ── */
  .strip{display:flex;align-items:stretch;border:1px solid #e0e3ea;margin-bottom:5px;
    page-break-inside:avoid;min-height:80px;}
  .strip-img{width:80px;height:80px;flex-shrink:0;object-fit:cover;border-right:1px solid #eee;align-self:flex-start;}
  .strip-body{flex:1;display:flex;flex-direction:column;min-width:0;}
  .strip-top{display:flex;align-items:flex-start;gap:10px;padding:6px 10px;flex:1;}
  .strip-meta{flex:1;min-width:0;}
  .strip-sku{font-size:8px;color:#999;font-family:monospace;}
  .strip-name-row{display:flex;align-items:center;gap:4px;margin:1px 0;}
  .strip-name{font-size:10.5px;font-weight:700;color:${NAVY};line-height:1.25;}
  .strip-colour{font-size:8.5px;color:#666;}
  .new-badge{display:inline-block;background:#c8102e;color:white;
    font-size:6.5px;font-weight:800;padding:3px 4px 2px;letter-spacing:0.5px;flex-shrink:0;
    line-height:1;vertical-align:baseline;}
  .strip-crest{font-size:7.5px;color:#555;background:#f0f2f8;padding:2px 5px;margin-top:3px;
    border-left:2px solid ${NAVY};display:inline-block;}
  .strip-sizes{display:flex;gap:3px;align-items:flex-end;flex-shrink:0;padding-top:3px;}
  .strip-size-col{display:flex;flex-direction:column;align-items:center;gap:1px;}
  .strip-size-lbl{font-size:7px;color:#888;font-weight:700;}
  .strip-size-box{width:24px;border:1.5px solid ${NAVY};font-size:10px;font-weight:700;color:${NAVY};
    line-height:21px;text-align:center;padding:0;}
  .strip-bottom{display:flex;background:#f8f9fb;border-top:1px solid #eee;padding:7px 10px 5px;gap:0;}
  .strip-price{flex:1;}
  .strip-price-lbl{font-size:7px;color:#999;text-transform:uppercase;letter-spacing:0.3px;font-weight:600;
    line-height:1;margin-bottom:2px;}
  .strip-price-val{font-size:9.5px;font-weight:600;color:#333;line-height:1;}
  .strip-price-val.lt{color:${NAVY};font-weight:700;}

  /* ── Grand total box ── */
  .fpdf-grand{background:#f0f2f8;border:2px solid ${NAVY};padding:18px 22px;margin-top:10px;}
  .fpdf-grand-title{font-size:11px;font-weight:700;color:${NAVY};text-transform:uppercase;
    letter-spacing:1px;margin-bottom:8px;}
  .fpdf-grand-row{display:flex;gap:48px;}
  .fpdf-grand-v{font-size:26px;font-weight:700;color:${NAVY};line-height:1.1;margin-top:2px;}
  .fpdf-p{display:flex;flex-direction:column;gap:2px;}
  .fpdf-pl{font-size:7.5px;color:#999;text-transform:uppercase;letter-spacing:.4px;}
  .fpdf-comments{margin-top:12px;font-size:10px;color:#555;border-top:1px solid #ddd;padding-top:10px;}
</style>

<div class="fpdf-root">
  <!-- ── Logo bar ── -->
  <div class="v1-logo-bar">
    <img class="v1-logo-fj" src="${fjLogoBlack}" crossorigin="anonymous" />
    <img class="v1-logo-curate" src="${curateLogoBlack}" crossorigin="anonymous" />
  </div>

  <!-- ── Seasonal banner with overlaid text ── -->
  <div class="v1-banner-wrap">
    <img class="v1-banner-img" src="${bannerImg}" crossorigin="anonymous" data-img-fallback="banner" data-season-id="${escapeAttr(seasonId)}" />
    <div class="v1-banner-overlay">
      <div class="v1-banner-text">
        <div class="v1-banner-title">Apparel Prebook Order</div>
        <div class="v1-banner-subtitle">${seasonLabel}</div>
      </div>
    </div>
  </div>

  <!-- ── Info bar ── -->
  <div class="v1-info-bar">
    <div class="v1-info-cell wide">
      <div class="v1-info-lbl">Partner</div>
      <div class="v1-group-row">
        <div class="v1-info-val">${escapeHtml(account)}</div>
        ${groupLogoUrl ? `<img class="v1-group-logo" src="${groupLogoUrl}" crossorigin="anonymous" data-img-fallback="hide" />` : ''}
      </div>
    </div>
    <div class="v1-info-cell">
      <div class="v1-info-lbl">Account Manager</div>
      <div class="v1-info-val">${escapeHtml(manager)}</div>
    </div>
    <div class="v1-info-cell">
      <div class="v1-info-lbl">Order Date</div>
      <div class="v1-info-val">${dateVal}</div>
    </div>
    <div class="v1-info-cell narrow highlight">
      <div class="v1-info-lbl">Pieces</div>
      <div class="v1-info-val-lg">${grandUnits}</div>
    </div>
    <div class="v1-info-cell highlight">
      <div class="v1-info-lbl">Total (excl GST)</div>
      <div class="v1-info-val-lg">${currSymbol}${grandValue.toFixed(2)}</div>
    </div>
    <div class="v1-info-cell highlight">
      <div class="v1-info-lbl">Total (incl GST)</div>
      <div class="v1-info-val-lg">${currSymbol}${grandValueInclGST.toFixed(2)}</div>
    </div>
  </div>

  <!-- ── Product pages ── -->
  <div class="fpdf-body">${bodyHTML}</div>
</div>`;

  // ── Trigger browser print dialog ──────────────────────────────────────────
  // Give images a moment to load, then print.
  // The @media print CSS hides the app and shows only #print-container.
  // User chooses "Save as PDF" in the print dialog for a vector PDF.
  await new Promise(r => setTimeout(r, 600));
  window.print();

  // Clean up after print dialog closes (sync -- blocks until dialog dismissed)
  printContainer.innerHTML = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/* ── Fullscreen toggle ── */
function toggleFullScreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => {
      btn.textContent = '⛶';
      btn.title = 'Exit fullscreen';
    }).catch(() => {});
  } else {
    document.exitFullscreen().then(() => {
      btn.textContent = '⛶';
      btn.title = 'Enter fullscreen';
    }).catch(() => {});
  }
}
document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('btn-fullscreen');
  if (btn) btn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen';
});

function clearAll() {
  if (confirm('Clear all selections and reset the form?')) {
    // Reset all size buttons to default before wiping orderData
    document.querySelectorAll('.size-btn').forEach(btn => {
      btn.classList.remove('active');
      btn.textContent = '—';
    });

    // Reset order data
    orderData = {};

    // Reset account fields
    const accountInput = document.getElementById('account');
    accountInput.value = '';
    accountInput.dataset.cmakey = '';
    document.getElementById('account-manager').value = '';
    document.getElementById('order-comments').value = '';

    // Reset order date display
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('order-date').value = today;
    const [y, m, d] = today.split('-');
    document.getElementById('order-date-display').textContent = `Order Date: ${d}/${m}/${y}`;

    // Close My Selections if open
    if (mySelectionsMode) {
      mySelectionsMode = false;
      document.getElementById('btn-my-selections').classList.remove('active');
      document.getElementById('collections-container').style.display = 'block';
      document.getElementById('my-selections-panel').classList.remove('active');
    }

    // Return to first tab
    if (COLLECTIONS.length > 0) switchTab(COLLECTIONS[0].id);

    updateUI();
  }
}

function resetForm() {
  closeModal('success-modal');

  // Reset size buttons
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.textContent = '—';
  });

  // Reset order and global embroidery data
  orderData = {};
  globalCrestingDefaults = { logoOption: 'Recommended', position: 'Left Chest', colour: 'Match FJ (1 colour)', specialInstructions: '' };

  // Reset global cresting toggle UI
  const gcBtn = document.getElementById('btn-global-cresting');
  if (gcBtn) { gcBtn.classList.remove('cresting-active'); gcBtn.textContent = 'Off'; }
  const gcSettings = document.getElementById('global-cresting-settings');
  if (gcSettings) gcSettings.classList.remove('visible');

  // Reset account fields
  const accountInput = document.getElementById('account');
  accountInput.value = '';
  accountInput.dataset.cmakey = '';
  document.getElementById('account-manager').value = '';
  document.getElementById('order-comments').value = '';

  // Reset order date display
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('order-date').value = today;
  const [y, m, d] = today.split('-');
  document.getElementById('order-date-display').textContent = `Order Date: ${d}/${m}/${y}`;

  // Close My Selections if open
  if (mySelectionsMode) {
    mySelectionsMode = false;
    document.getElementById('btn-my-selections').classList.remove('active');
    document.getElementById('collections-container').style.display = 'block';
    document.getElementById('my-selections-panel').classList.remove('active');
  }

  if (COLLECTIONS.length > 0) switchTab(COLLECTIONS[0].id);
  updateUI();

  // Scroll to top so account dropdown is visible
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Focus the account input after a short delay for smooth UX
  setTimeout(() => {
    const acct = document.getElementById('account');
    if (acct) acct.focus();
  }, 400);
}

function useTemplate() {
  closeModal('success-modal');

  // Clear customer fields only — keep product selections intact
  const accountInput = document.getElementById('account');
  accountInput.value = '';
  accountInput.dataset.cmakey = '';
  document.getElementById('account-manager').value = '';
  document.getElementById('order-comments').value = '';

  // Update footer customer name
  const footerName = document.getElementById('footer-customer-name');
  if (footerName) footerName.textContent = '—';

  // Reset order date to today
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('order-date').value = today;
  const [y, m, d] = today.split('-');
  document.getElementById('order-date-display').textContent = `Order Date: ${d}/${m}/${y}`;

  // Switch to the first tab
  if (COLLECTIONS.length > 0) switchTab(COLLECTIONS[0].id);

  // Scroll to top so account dropdown is visible
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Focus the account input
  setTimeout(() => {
    const acct = document.getElementById('account');
    if (acct) acct.focus();
  }, 400);

  showToast('Template loaded — select a new customer to continue');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARE DRAFT
// NOTE: Requires a `draft_orders` table in Supabase with columns:
//   token (text, primary key), pin (text), order_data (jsonb),
//   customer_data (jsonb), created_at (timestamptz default now()),
//   expires_at (timestamptz)
// ═══════════════════════════════════════════════════════════════════════════════

function openShareDraftModal() {
  const account = document.getElementById('account').value.trim();
  const totalUnits = parseInt(document.getElementById('grand-units').textContent) || 0;
  if (!account) { alert('Please select a customer before sharing a draft.'); return; }
  if (totalUnits === 0) { alert('Please add items to the order before sharing a draft.'); return; }

  // Pre-fill email from customer record
  const cmakey = document.getElementById('account').dataset.cmakey || '';
  const rec = CUSTOMER_DB.find(r => r.cmakey === cmakey);
  document.getElementById('share-draft-email').value = rec?.email || '';
  document.getElementById('share-draft-error').textContent = '';
  const btn = document.getElementById('btn-send-draft');
  btn.textContent = 'Send Draft Link';
  btn.disabled = false;

  document.getElementById('share-draft-modal').classList.add('active');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('share-draft-email').focus(), 80);
}

async function sendDraftLink() {
  const emailInput = document.getElementById('share-draft-email');
  const email = emailInput.value.trim();
  const errEl = document.getElementById('share-draft-error');
  errEl.textContent = '';

  if (!email || !email.includes('@')) {
    errEl.textContent = 'Please enter a valid email address.';
    emailInput.focus();
    return;
  }

  // Generate unique token (12-char alphanumeric)
  const token = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') :
    Array.from(crypto.getRandomValues(new Uint8Array(9)))
         .map(b => b.toString(36)).join('')).slice(0, 12);

  // Customer info
  const accountInput = document.getElementById('account');
  const cmakey = accountInput.dataset.cmakey || '';
  const rec = CUSTOMER_DB.find(r => r.cmakey === cmakey);
  const accountName = rec?.customer || accountInput.value || 'Customer';
  const managerName = document.getElementById('account-manager').value || '';

  const draftUrl = `${window.location.origin}${window.location.pathname}#draft=${token}`;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const btn = document.getElementById('btn-send-draft');
  btn.textContent = 'Saving…';
  btn.disabled = true;

  try {
    const seasonId = window._selectedSeason || null;

    // Delete any existing draft for this account + season before saving
    await supa.from('draft_orders')
      .delete()
      .eq('season_id', seasonId)
      .filter('customer_data->>cmakey', 'eq', cmakey);

    const { error } = await supa.from('draft_orders').insert({
      token,
      order_data: orderData,
      customer_data: rec || { customer: accountInput.value, manager: managerName, cmakey },
      expires_at: expiresAt,
      season_id: seasonId
    });
    if (error) throw error;

    const subject = 'Your Draft FootJoy 2027 AW Apparel Prebook Order';
    const body =
      `Hi ${accountName},\n\n` +
      `Your draft FootJoy 2027 Autumn Winter Apparel Prebook order is ready for your review.\n\n` +
      `You can view and edit your draft order using the link below:\n\n` +
      `${draftUrl}\n\n` +
      `This link will expire in 30 days.\n\n` +
      `Please contact me if you have any questions.`;

    window.location.href =
      `mailto:${encodeURIComponent(email)}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;

    closeModal('share-draft-modal');
  } catch (err) {
    errEl.textContent = `Save failed: ${err?.message || err?.code || JSON.stringify(err)}`;
    btn.textContent = 'Send Draft Link';
    btn.disabled = false;
  }
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
  // Restore body scroll only when no modals remain open
  const anyOpen = document.querySelectorAll('.modal-overlay.active').length > 0;
  if (!anyOpen) document.body.style.overflow = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  await loadCustomerDB();
  await loadReferenceData();
  await loadProgramData();
  buildTabBar();
  renderCollections();
  renderProgramPanels();
  updateProgramThresholds();
  // Track the initially active tab
  if (COLLECTIONS.length > 0) currentTabId = COLLECTIONS[0].id;

  // Set today's date
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('order-date').value = today;
  const [y, m, d] = today.split('-');
  document.getElementById('order-date-display').textContent = `Order Date: ${d}/${m}/${y}`;

  // Check for shared draft link (uses URL fragment to avoid referrer/log leaks - F13)
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const draftToken = hashParams.get('draft');
  const fromDashboard = hashParams.get('from') === 'dashboard';

  if (draftToken) {
    // Wait for session check to finish so we know if user is a rep or customer
    await sessionCheckDone;

    // Rep: has from=dashboard flag OR is logged in (window.currentUser set by checkExistingSession)
    var isRepViewing = fromDashboard || !!window.currentUser;
    if (!isRepViewing) {
      isCustomerDraftMode = true;
    }

    // Hide login and landing, show the order form
    var loginScreen = document.getElementById('login-screen');
    if (loginScreen) { loginScreen.style.display = 'none'; }
    var seasonLanding = document.getElementById('season-landing');
    if (seasonLanding) { seasonLanding.style.display = 'none'; }
    document.getElementById('app-header').style.display = '';
    document.getElementById('app-main').style.display = '';
    document.getElementById('app-footer').style.display = '';

    // Complete the loading bar and fade out
    var draftLoader = document.getElementById('draft-loading-screen');
    if (draftLoader && draftLoader.style.display !== 'none') {
      var bar = draftLoader.querySelector('.draft-loading-bar-fill');
      if (bar) { bar.style.transition = 'width 0.3s ease'; bar.style.width = '100%'; }
      setTimeout(function() { draftLoader.classList.add('fade-out'); }, 400);
      setTimeout(function() { draftLoader.style.display = 'none'; }, 900);
    }

    loadDraftDirect(draftToken);
  }
}

// ─── DRAFT ORDER LOADING ────────────────────────────────────────────────────

async function loadDraftDirect(token) {
  const now = new Date().toISOString();
  const { data, error } = await supa
    .from('draft_orders')
    .select('*')
    .eq('token', token)
    .gt('expires_at', now)
    .single();

  if (error || !data) {
    alert('This draft link has expired or is invalid.');
    return;
  }
  activeDraftToken = token;
  loadDraftOrder(data);
}

// Draft PIN screen removed - drafts now use token-only access via handleTokenOnlyDraft()

function loadDraftOrder(draftRow) {
  // Restore order data
  orderData = draftRow.order_data || {};

  // Restore customer fields
  const cd = draftRow.customer_data || {};
  const accountInput  = document.getElementById('account');
  const managerInput  = document.getElementById('account-manager');
  accountInput.value           = cd.customer || '';
  accountInput.dataset.cmakey  = cd.cmakey   || '';
  managerInput.value           = cd.manager  || '';

  // Update footer customer name
  const footerName = document.getElementById('footer-customer-name');
  if (footerName) footerName.textContent = cd.customer || '—';

  // Re-render quantities, totals, and My Selections panel
  updateUI();

  // Restore embroidery UI state — orderData has the data but the DOM toggles/
  // dropdowns/textareas need to be synced. Replaying setCresting for each field
  // handles all the show/hide logic and input values.
  Object.entries(orderData).forEach(([sku, item]) => {
    if (item.cresting) {
      const c = item.cresting;
      ['addLogo', 'logoOption', 'position', 'colour', 'specialInstructions']
        .forEach(field => { if (c[field] !== undefined) setCresting(sku, field, c[field]); });
    }
  });

  // Show draft banner
  document.getElementById('draft-banner').classList.add('active');

  // Customer draft mode restrictions
  if (isCustomerDraftMode) {
    // 1. Lock customer fields -- cannot edit account, manager, or comments
    const acctInput = document.getElementById('account');
    if (acctInput) { acctInput.readOnly = true; acctInput.style.pointerEvents = 'none'; acctInput.style.opacity = '0.7'; }
    const mgrInput = document.getElementById('account-manager');
    if (mgrInput) { mgrInput.readOnly = true; mgrInput.style.pointerEvents = 'none'; mgrInput.style.opacity = '0.7'; }
    const commentsInput = document.getElementById('order-comments');
    if (commentsInput) { commentsInput.readOnly = true; commentsInput.style.pointerEvents = 'none'; commentsInput.style.opacity = '0.7'; }
    const acDropdown = document.getElementById('ac-dropdown');
    if (acDropdown) { acDropdown.style.display = 'none'; }

    // 2. Show privacy footer
    const privFooter = document.getElementById('privacy-footer');
    if (privFooter) privFooter.style.display = 'block';

    // 3. Hide Fullscreen + the entire hamburger menu (Share / Clear /
    //    Sign out / Customer Insight / Back to season picker are all
    //    rep-only). Customers can still save changes via the on-page
    //    save button rendered by the customer-mode flow.
    const fsBtn = document.getElementById('btn-fullscreen');
    if (fsBtn) fsBtn.classList.add('force-hidden');
    const menuBtn = document.getElementById('header-menu-btn');
    if (menuBtn) menuBtn.classList.add('force-hidden');

    // 4. Hide Confirm & Submit in review modal (Save button added when modal opens)
    const confirmBtn = document.getElementById('btn-confirm-submit');
    if (confirmBtn) confirmBtn.classList.add('force-hidden');
  }
}

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════
// HEADER MENU (hamburger dropdown)
// ═══════════════════════════════════════════════
function toggleHeaderMenu() {
  const menu = document.getElementById('header-menu');
  const btn  = document.getElementById('header-menu-btn');
  if (!menu || !btn) return;
  const isHidden = menu.hidden;
  if (isHidden) {
    populateHeaderMenuProfile();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  } else {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
}
function closeHeaderMenu() {
  const menu = document.getElementById('header-menu');
  const btn  = document.getElementById('header-menu-btn');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
function populateHeaderMenuProfile() {
  const u = window.currentUser || {};
  const nameEl  = document.getElementById('header-menu-profile-name');
  const emailEl = document.getElementById('header-menu-profile-email');
  if (nameEl)  nameEl.textContent  = u.name || 'Signed in';
  if (emailEl) emailEl.textContent = u.email || '-';
}
// Close on click outside the menu/trigger.
document.addEventListener('click', function (ev) {
  const menu = document.getElementById('header-menu');
  if (!menu || menu.hidden) return;
  if (ev.target.closest('#header-menu') || ev.target.closest('#header-menu-btn')) return;
  closeHeaderMenu();
});
// Close on Escape.
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') closeHeaderMenu();
});

// ═══════════════════════════════════════════════
// EVENT DELEGATION (replaces inline onclick)
// ═══════════════════════════════════════════════
document.addEventListener('click', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  // Actions that need stopPropagation
  if (['openDraftFromLanding','confirmDeleteDraft','toggleDraftList','toggleSubsectionCresting','toggleHeaderMenu'].includes(a)) e.stopPropagation();

  // Close the header menu after any item is clicked (except the toggle
  // itself, which is handled below).
  if (a !== 'toggleHeaderMenu') closeHeaderMenu();

  if (a === 'toggleHeaderMenu') toggleHeaderMenu();
  else if (a === 'openDraftFromLanding') openDraftFromLanding(el.dataset.token);
  else if (a === 'confirmDeleteDraft') confirmDeleteDraft(el.dataset.token, el.dataset.account);
  else if (a === 'toggleDraftList') toggleDraftList(el.dataset.id);
  else if (a === 'selectSeason') selectSeason(el.dataset.id, el.dataset.category);
  else if (a === 'executeDraftDelete') executeDraftDelete(el.dataset.token, el);
  else if (a === 'selectCustomer') selectCustomer(el.dataset.cmakey);
  else if (a === 'switchTab') switchTab(el.dataset.id);
  else if (a === 'addOneToAll') addOneToAll(el.dataset.sku);
  else if (a === 'clearCard') clearCard(el.dataset.sku);
  else if (a === 'setCrestingAddLogo') setCresting(el.dataset.sku, 'addLogo', el.classList.contains('cresting-active') ? 'None' : 'Yes');
  else if (a === 'setCrestingLogoOption') setCresting(el.dataset.sku, 'logoOption', el.classList.contains('cresting-active') ? 'Recommended' : 'Custom');
  else if (a === 'toggleSubsection') toggleSubsection(el.dataset.id);
  else if (a === 'toggleSubsectionCresting') toggleSubsectionCresting(el.dataset.id, el);
  else if (a === 'closeDraftDeleteOverlay') el.closest('.draft-delete-overlay').remove();
  else if (a === 'saveAndExit') saveAndExit(el);
  else if (a === 'discardAndExit') discardAndExit();
  else if (a === 'closeExitOverlay') el.closest('.exit-overlay').remove();
  else if (a === 'toggleMySelections') toggleMySelections();
  else if (a === 'toggleMsMonth') { const body = el.closest('.ms-month-group').querySelector('.ms-month-body'); const icon = el.querySelector('.ms-toggle-icon'); if (body.classList.contains('open')) { body.classList.remove('open'); icon.textContent = '\u25B6'; } else { body.classList.add('open'); icon.textContent = '\u25BC'; } }
  // --- Handlers from index.html static elements ---
  else if (a === 'signOut') signOut();
  else if (a === 'handleExitToLanding') handleExitToLanding();
  else if (a === 'toggleGlobalCresting') toggleGlobalCresting();
  else if (a === 'toggleGlobalLogoOption') setGlobalCrestingDefault('logoOption', el.classList.contains('cresting-active') ? 'Recommended' : 'Custom');
  else if (a === 'applyGlobalCresting') applyGlobalCresting();
  else if (a === 'closeCiOverlaySelf') { if (e.target === el) el.classList.remove('active'); }
  else if (a === 'closeCiOverlay') document.getElementById('ci-overlay').classList.remove('active');
  else if (a === 'showCustomerInsight') showCustomerInsight();
  else if (a === 'toggleFullScreen') toggleFullScreen();
  else if (a === 'clearAll') clearAll();
  else if (a === 'saveDraftInPlace') saveDraftInPlace(el);
  else if (a === 'openShareDraftModal') openShareDraftModal();
  else if (a === 'showReviewModal') showReviewModal();
  else if (a === 'closeModal') closeModal(el.dataset.modal);
  else if (a === 'printReview') { closeModal('review-modal'); generateCustomerPDF(); }
  else if (a === 'confirmSubmit') confirmSubmit();
  else if (a === 'closeDraftBanner') document.getElementById('draft-banner').classList.remove('active');
  else if (a === 'sendDraftLink') sendDraftLink();
  else if (a === 'resetForm') resetForm();
  else if (a === 'useTemplate') useTemplate();
});

document.addEventListener('change', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'setDeliveryMonth') setDeliveryMonth(el.dataset.sku, el.value);
  else if (a === 'setCrestingField') setCresting(el.dataset.sku, el.dataset.field, el.value);
  else if (a === 'updatePricing') updatePricing();
  else if (a === 'setGlobalCrestingDefault') setGlobalCrestingDefault(el.dataset.field, el.value);
});

document.addEventListener('input', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'setCrestingField') setCresting(el.dataset.sku, el.dataset.field, el.value);
  else if (el.dataset.action === 'setGlobalCrestingDefault') setGlobalCrestingDefault(el.dataset.field, el.value);
});

// ═══════════════════════════════════════════════
// IMAGE ERROR FALLBACK (replaces inline onerror)
// ═══════════════════════════════════════════════
document.addEventListener('error', function(e) {
  if (e.target.tagName !== 'IMG') return;
  var fb = e.target.dataset.imgFallback;
  if (!fb) return;
  e.target.removeAttribute('data-img-fallback'); // prevent infinite loop
  if (fb === 'season') {
    e.target.style.background = '#1f2937';
    e.target.style.minHeight = '200px';
    e.target.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  } else if (fb === 'banner') {
    // PDF banner image: try the regular season image (no -banner suffix)
    // before giving up. The CSS uses object-fit: cover so a square
    // landing image still crops cleanly into the banner frame.
    var sid = e.target.dataset.seasonId || '';
    if (sid) {
      e.target.src = 'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/seasonal-images/season-' + encodeURIComponent(sid) + '.jpg';
    }
  } else if (fb === 'product') {
    e.target.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23f3f4f6' width='100' height='100'/%3E%3C/svg%3E";
  } else if (fb === 'strip') {
    e.target.style.background = '#f3f4f6';
  } else if (fb === 'hide') {
    e.target.style.display = 'none';
  } else if (fb === 'review') {
    e.target.parentElement.parentElement.style.display = 'none';
  }
}, true); // use capture phase so it fires for img errors

// ═══════════════════════════════════════════════
// MOUSEENTER DELEGATION (replaces inline onmouseenter)
// ═══════════════════════════════════════════════
document.addEventListener('mouseenter', function(e) {
  var el = e.target.closest('[data-action-hover]');
  if (!el) return;
  if (el.dataset.actionHover === 'positionReviewPopup') positionReviewPopup(e, el.dataset.sku);
}, true); // capture phase needed for mouseenter delegation

// F07: Idle timeout - sign out after 30 minutes of inactivity (staff sessions only)
(function() {
  var IDLE_LIMIT = 30 * 60 * 1000;
  var idleTimer;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function() { signOut(); }, IDLE_LIMIT);
  }
  ['mousemove','keydown','click','scroll','touchstart'].forEach(function(evt) {
    document.addEventListener(evt, resetIdle, { passive: true });
  });
  resetIdle();
})();
