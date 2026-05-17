const SUPA_URL = window.__SUPABASE_CONFIG.url;
const SUPA_KEY = window.__SUPABASE_CONFIG.key;
const supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);

// Auth gate: if there is no Supabase session token in localStorage, redirect
// to the root login with ?next=<this page> so it bounces back after sign-in.
// Runs synchronously before any other dashboard code so the user never sees
// a half-rendered dashboard shell.
(function authGate() {
  try {
    var key = 'sb-' + new URL(SUPA_URL).hostname.split('.')[0] + '-auth-token';
    if (!localStorage.getItem(key)) {
      var page = (location.pathname.split('/').pop() || 'index.html');
      var nextVal = page + location.search + location.hash;
      location.replace('index.html?next=' + encodeURIComponent(nextVal));
    }
  } catch(e) { /* ignore */ }
})();
// PIN-based login removed Apr 2026 -- now using Supabase Auth (email/password)
const SUPA_IMG_BASE = 'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/product-images/FJ_';

let allOrders    = [];
let allLines     = [];
let allDrafts    = [];
let targets      = {};
let nationalTargets = { AU: 0, NZ: 0 };
let allCustomers = {};  // keyed by account_name (lowercase)
let baseSkuMap   = {};  // sku -> base_sku for image lookups
let openSeasonIds = new Set();  // active seasons -> Top Products filter
let includePrebook = false;

// ── PRODUCT TYPE + SEASON STATE ─────────────────────────────────────────────
// productType drives which data the view tabs render. Apparel pulls from
// the orders/order_lines tables; Footwear (wired in Phase 3) pulls from
// footwear_drafts. The active season filters all data queries; each
// product type remembers its last-viewed season independently. State is
// persisted in localStorage so a refresh restores the rep's choice.
//
// Convention for splitting seasons by product type: any season_id that
// ends with '-shoe' is a footwear season; everything else is apparel.
// This matches the migration note in index-app.js (May 2026 backfill set
// older footwear_drafts to 'AW27-shoe').
let productType = 'apparel'; // 'apparel' | 'footwear'
let currentSeason = null;     // active season_id for the active type
let seasonsByType = { apparel: [], footwear: [] }; // populated from the seasons table
const LS_PRODUCT_KEY = 'dashboard.productType';
const LS_SEASON_KEY = function (type) { return 'dashboard.season.' + type; };

function isFootwearSeason(id) { return typeof id === 'string' && /-shoe$/i.test(id); }

// Restore the rep's last product-type pick from localStorage so the
// first loadAll reads the right state. Season picks are restored
// per-type later, inside resolveActiveSeason(), once the seasons list
// has been pulled from the DB.
try {
  const _storedType = localStorage.getItem(LS_PRODUCT_KEY);
  if (_storedType === 'apparel' || _storedType === 'footwear') productType = _storedType;
} catch (e) { /* ignore */ }

// Sort season_ids newest first. AW28 > SS28 > AW27 > SS27 etc. We pull a
// 2-digit trailing number; ties on number favour AW over SS (AW is later
// in the calendar year for golf prebook). Anything we can't parse sorts
// to the end.
function compareSeasons(a, b) {
  function parts(id) {
    var clean = String(id || '').replace(/-shoe$/i, '');
    var m = clean.match(/^([A-Za-z]+)(\d+)$/);
    if (!m) return { prefix: 'zz', year: -1 };
    return { prefix: m[1].toUpperCase(), year: parseInt(m[2], 10) };
  }
  var A = parts(a), B = parts(b);
  if (A.year !== B.year) return B.year - A.year;
  if (A.prefix === B.prefix) return 0;
  if (A.prefix === 'AW') return -1;
  if (B.prefix === 'AW') return 1;
  return A.prefix.localeCompare(B.prefix);
}

// AUTH12 — currentUser is module-scoped (was on window). Reduces XSS exfil
// surface and prevents client-side role tampering via DevTools.
let currentUser = null;
function getCurrentUser() { return currentUser || {}; }

// ── XSS HELPERS ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeAttr(str) { return escapeHtml(String(str)).replace(/"/g, '&quot;'); }

// ── SIGN OUT / DASHBOARD UNLOCK ─────────────────────────────────────────────
// Login itself lives on /index.html. dashboard.js only ever runs for users
// who already have a session (the authGate IIFE at the top of this file
// redirects out otherwise). So there is no handleLogin here anymore.

async function handleSignOut() {
  // After signOut(), the Supabase token is cleared from localStorage. The
  // reload triggers the authGate IIFE again, which sees no token and
  // redirects to the root login.
  await supa.auth.signOut();
  window.location.reload();
}

function unlockDashboard() {
  // AUTH20 - reveal Edit Targets only for admin / manager (still RLS-gated server-side).
  applyRoleVisibility();
  loadAll();
}

function applyRoleVisibility() {
  const u = currentUser || {};
  const isPrivileged = u.role === 'admin' || u.role === 'manager';
  const editBtn = document.getElementById('toggle-target-admin');
  if (editBtn) editBtn.hidden = !isPrivileged;
  // Slide Analytics tab follows the same role gate plus a footwear
  // product-type gate. updateSlideAnalyticsTabVisibility owns the
  // combined check; we just trigger a re-evaluation here.
  updateSlideAnalyticsTabVisibility();
}

// ── SLIDE ANALYTICS ─────────────────────────────────────────────────────────
// Visibility: (role admin or manager) AND (productType is footwear).
// Reps never see the tab; apparel mode never shows it. If the user is
// already viewing the tab when conditions change (e.g. they switch to
// apparel), bounce them back to the Leaderboard.
function updateSlideAnalyticsTabVisibility() {
  const u = currentUser || {};
  const isPrivileged = u.role === 'admin' || u.role === 'manager';
  const isFootwear   = productType === 'footwear';
  const tabBtn = document.getElementById('tab-btn-slide-analytics');
  if (!tabBtn) return;
  const shouldShow = isPrivileged && isFootwear;
  tabBtn.classList.toggle('tab-btn-hidden', !shouldShow);
  if (!shouldShow && tabBtn.classList.contains('active')) {
    showTab('leaderboard');
  }
}

// In-memory cache. Cleared on season change and on manual refresh so
// the tab feels instant when toggling between it and the Leaderboard.
let slideAnalyticsCache  = null;   // { season, rows }
let slideAnalyticsFilter = 'all';  // 'all' | 'top' | 'bad'

async function loadSlideAnalytics(force) {
  const loadingEl = document.getElementById('slide-analytics-loading');
  const cardEl    = document.getElementById('slide-analytics-card');
  if (!loadingEl || !cardEl) return;

  if (!force && slideAnalyticsCache && slideAnalyticsCache.season === currentSeason) {
    renderSlideAnalytics(slideAnalyticsCache.rows);
    return;
  }

  loadingEl.style.display = '';
  loadingEl.textContent = 'Loading…';
  cardEl.style.display = 'none';

  // currentSeason can be null if the seasons list hasn't loaded yet.
  // The RPC requires a season id; fall back to the canonical AW27 shoe
  // season so a fast tab-click before loadAll resolves doesn't error.
  const season = currentSeason || 'AW27-shoe';

  const { data, error } = await supa.rpc('get_footwear_slide_leaderboard', {
    p_season_id:              season,
    p_account_manager_filter: null,
    p_customer_group_filter:  null
  });

  if (error) {
    loadingEl.textContent = 'Could not load slide analytics: ' + (error.message || 'unknown error');
    cardEl.style.display = 'none';
    return;
  }

  slideAnalyticsCache = { season: season, rows: data || [] };
  renderSlideAnalytics(slideAnalyticsCache.rows);
}

function renderSlideAnalytics(rows) {
  const loadingEl = document.getElementById('slide-analytics-loading');
  const cardEl    = document.getElementById('slide-analytics-card');
  const bodyEl    = document.getElementById('slide-analytics-body');
  if (!bodyEl) return;

  const filtered = filterSlideRows(rows || [], slideAnalyticsFilter);

  if ((rows || []).length === 0) {
    loadingEl.style.display = '';
    loadingEl.textContent = 'No slide telemetry yet for this season. As reps run presentations the data will appear here.';
    cardEl.style.display = 'none';
    return;
  }
  if (filtered.length === 0) {
    loadingEl.style.display = '';
    loadingEl.textContent = 'No slides match this filter.';
    cardEl.style.display = 'none';
    return;
  }

  loadingEl.style.display = 'none';
  cardEl.style.display = '';

  bodyEl.innerHTML = filtered.map(function (r) {
    var products = (r.products_count != null && r.products_count > 0) ? r.products_count : null;
    return ''
      + '<tr>'
      +   '<td>'
      +     '<div class="slide-cell">'
      +       '<div class="slide-thumb"></div>'
      +       '<div class="slide-name">' + escapeHtml(r.slide_title || r.slide_key || 'Untitled slide') + '</div>'
      +     '</div>'
      +   '</td>'
      +   '<td class="num">' + fmtSlideNum(r.impressions) + '</td>'
      +   '<td class="num">' + fmtSlideTime(r.avg_duration_ms) + '</td>'
      +   '<td class="num">' + fmtSlideRate(r.skip_rate_pct) + '</td>'
      +   '<td class="num">' + (products === null ? 'N/A' : products) + '</td>'
      +   '<td class="num">' + (products === null ? 'N/A' : fmtSlideNum(r.pairs_from_slide)) + '</td>'
      +   '<td class="num">' + fmtSlideNum(r.total_order_pairs) + '</td>'
      +   '<td class="num">' + yoyBadge(r.avg_yoy_growth_pct) + '</td>'
      +   '<td class="num">' + fmtSlideRate(r.attach_rate_pct) + '</td>'
      +   '<td class="num">' + engageCell(r.engagement_pct) + '</td>'
      + '</tr>';
  }).join('');
}

function filterSlideRows(rows, filter) {
  if (filter === 'top') return rows.filter(function (r) { return yoyBand(r.avg_yoy_growth_pct) === 'good'; });
  if (filter === 'bad') return rows.filter(function (r) { return yoyBand(r.avg_yoy_growth_pct) === 'bad'; });
  return rows;
}
function yoyBand(g) {
  if (g === null || g === undefined) return 'na';
  var v = Number(g);
  if (isNaN(v)) return 'na';
  if (v >= 10) return 'good';
  if (v >= -5) return 'mid';
  return 'bad';
}
function yoyBadge(g) {
  if (g === null || g === undefined) {
    return '<span class="yoy-badge na">N/A</span>';
  }
  var v = Number(g);
  if (isNaN(v)) return '<span class="yoy-badge na">N/A</span>';
  var cls   = yoyBand(v);
  var arrow = v > 0.5 ? '▲' : v < -0.5 ? '▼' : '-';
  var sign  = v > 0 ? '+' : '';
  return '<span class="yoy-badge ' + cls + '">' + arrow + ' ' + sign + v.toFixed(1) + '%</span>';
}
function engageCell(eng) {
  if (eng === null || eng === undefined) {
    return '<div class="engage-cell na"><span class="engage-num">N/A</span></div>';
  }
  var e = Number(eng);
  if (isNaN(e)) return '<div class="engage-cell na"><span class="engage-num">N/A</span></div>';
  var cls = e >= 60 ? '' : e >= 30 ? 'mid' : 'bad';
  return '<div class="engage-cell">'
    + '<div class="engage-bar"><div class="engage-fill ' + cls + '" style="width: ' + Math.max(0, Math.min(100, e)) + '%;"></div></div>'
    + '<span class="engage-num">' + e.toFixed(0) + '%</span>'
    + '</div>';
}
function fmtSlideNum(n) {
  if (n === null || n === undefined) return 'N/A';
  return Number(n).toLocaleString();
}
function fmtSlideTime(ms) {
  if (ms === null || ms === undefined) return 'N/A';
  return Math.round(Number(ms) / 1000) + 's';
}
function fmtSlideRate(r) {
  if (r === null || r === undefined) return 'N/A';
  return Number(r).toFixed(1) + '%';
}

// Shared redirect helper: send the user to the root login with a ?next= back
// to this page. Used when the session is missing or stale.
function redirectToRootLogin() {
  var page = (location.pathname.split('/').pop() || 'index.html');
  var nextVal = page + location.search + location.hash;
  location.replace('index.html?next=' + encodeURIComponent(nextVal));
}

// Check for existing session on page load
(async function() {
  const { data: { session } } = await supa.auth.getSession();
  if (session) {
    // Verify still a valid salesperson
    const { data: sp } = await supa.from('salespeople').select('name, email, role, country').eq('email', session.user.email).single();
    if (sp) {
      currentUser = {
        name:    sp.name    || '',
        email:   sp.email   || session.user.email,
        role:    sp.role    || 'rep',
        country: sp.country || null
      };
      unlockDashboard();
      return;
    }
    await supa.auth.signOut();
  }
  // No session (token expired, deleted, or salesperson row gone): kick back to
  // the canonical login on the root. ?next= will bring them straight back here.
  redirectToRootLogin();
})();

// ── TABS ─────────────────────────────────────────────────────────────────────
function showTab(id) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  document.querySelector(`.tab-btn[data-tab="${id}"]`).classList.add('active');
}

// ── LOAD DATA ────────────────────────────────────────────────────────────────
// loadAll routes to the right loader based on productType. The season
// dropdown is rebuilt on every load from the seasons table so admins
// who add/remove seasons see them appear without a code change.
//
// loadGeneration guards against fast tab/season switches: a stale
// in-flight loader that resolves after a fresher one has started would
// otherwise overwrite the global allOrders/allLines with the wrong data.
// Each loader checks its captured generation against the global at
// the points where it would mutate state and bails out if newer work
// is already in flight.
let loadGeneration = 0;

async function loadAll() {
  const myGen = ++loadGeneration;
  document.getElementById('last-updated').textContent = 'Refreshing…';
  resetKpisForSwitch();
  await refreshSeasonsList();
  if (myGen !== loadGeneration) return;
  resolveActiveSeason();
  updateSeasonDropdown();
  updateProductChromeForType();
  if (productType === 'footwear') {
    await loadFootwear(myGen);
    return;
  }
  await loadApparel(myGen);
}

// Blank the KPI tiles so a rapid tab switch doesn't show stale numbers
// while the new loader runs. The renderers will repopulate them.
function resetKpisForSwitch() {
  ['stat-accounts','stat-units','stat-value','stat-orders'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
  const nv = document.getElementById('stat-value-note');
  if (nv) nv.style.display = 'none';
}

// Pull the full seasons list and bucket by apparel / footwear by the
// '-shoe' suffix convention. Results live on seasonsByType.
async function refreshSeasonsList() {
  const res = await supa.from('seasons').select('season_id, status');
  const rows = res.data || [];
  const apparel = [], footwear = [];
  rows.forEach(r => {
    if (!r.season_id) return;
    if (isFootwearSeason(r.season_id)) footwear.push(r.season_id);
    else apparel.push(r.season_id);
  });
  apparel.sort(compareSeasons);
  footwear.sort(compareSeasons);
  seasonsByType = { apparel: apparel, footwear: footwear };
  // Active seasons still drive the Top Products "this season" filter.
  openSeasonIds = new Set(rows.filter(r => r.status === 'active').map(r => r.season_id));
}

// Decide which season is active for the current productType. Order of
// preference: explicit user pick in localStorage, then the most recent
// season for that product type, else null (no seasons configured).
function resolveActiveSeason() {
  const list = seasonsByType[productType] || [];
  if (!list.length) { currentSeason = null; return; }
  let stored = null;
  try { stored = localStorage.getItem(LS_SEASON_KEY(productType)); } catch (e) { /* ignore */ }
  if (stored && list.indexOf(stored) >= 0) { currentSeason = stored; return; }
  currentSeason = list[0]; // already sorted newest-first
}

// Refresh the dropdown's <option>s for the active product type. Keeps
// the rep's selection in sync with the underlying state.
function updateSeasonDropdown() {
  const sel = document.getElementById('season-select');
  if (!sel) return;
  const list = seasonsByType[productType] || [];
  if (!list.length) {
    sel.innerHTML = '<option value="">No seasons</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = list.map(id =>
    '<option value="' + escapeAttr(id) + '"' + (id === currentSeason ? ' selected' : '') + '>' + escapeHtml(id) + '</option>'
  ).join('');
}

// Tracks whether the active footwear data set includes any lines saved
// before the unit_price snapshot was added (Phase 1). When true, the
// Value KPI tile shows a small note explaining that legacy drafts are
// excluded from the dollar total. Reset by loadFootwear on each call.
let footwearHasLegacyLines = false;

// Reflect the active product type in the pill UI. The view tabs and
// panels are shared between Apparel and Footwear; the active loader is
// what differs. The Phase-2 placeholder card stays hidden under either
// product type now that the footwear loader is wired (Phase 3+).
function updateProductChromeForType() {
  document.querySelectorAll('.product-pill').forEach(btn => {
    const isActive = btn.dataset.product === productType;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  const ph = document.getElementById('footwear-placeholder');
  if (ph) ph.hidden = true;
  updateLabelsForProductType();
}

// Swap copy across the page to match the active product type. Targets
// already compare to units everywhere (so the leaderboard/national
// progress logic doesn't need to branch), but the surfaced labels
// ("Pairs" vs "Units") and the legacy-drafts note need to follow the
// active type.
function updateLabelsForProductType() {
  const isFootwear = productType === 'footwear';
  const unitsWord  = isFootwear ? 'Pairs' : 'Units';

  const unitsLabelEl = document.getElementById('stat-units-label');
  if (unitsLabelEl) unitsLabelEl.textContent = 'Total ' + unitsWord;

  const valueLabelEl = document.getElementById('stat-value-label');
  if (valueLabelEl) valueLabelEl.textContent = 'Total Value';

  const valueNoteEl = document.getElementById('stat-value-note');
  if (valueNoteEl) {
    valueNoteEl.style.display = (isFootwear && footwearHasLegacyLines) ? '' : 'none';
  }

  // Table headers that use the units/pairs vocabulary swap together.
  const lbHdr = document.getElementById('leaderboard-units-header');
  if (lbHdr) lbHdr.textContent = unitsWord;
  const ordersHdr = document.getElementById('orders-units-header');
  if (ordersHdr) {
    // Preserve the sort icon child element rather than blowing it away.
    ordersHdr.firstChild.nodeValue = unitsWord;
  }
  const draftsHdr = document.getElementById('drafts-units-header');
  if (draftsHdr) draftsHdr.textContent = unitsWord;

  // Page <title>: include the active season + product so external
  // bookmarks read sensibly.
  if (currentSeason) {
    const productWord = isFootwear ? 'Footwear' : 'Apparel';
    document.title = 'FootJoy — ' + productWord + ' Dashboard ' + currentSeason;
  }
}

// Apparel-side loader. Pulled out of loadAll so the footwear loader can
// live as a sibling in Phase 3 without touching this code path. The
// loadGen argument lets a stale loader bail before it overwrites the
// global state with data the rep has already moved on from.
async function loadApparel(loadGen) {
  // DB06 — explicit select lists driven by the real schema (verified May
  // 2026 via information_schema). Customer-facing PII columns continue
  // to flow through escapeHtml / escapeAttr at every render site.
  // Season filter: orders and sales_targets are constrained to the
  // active season picked in the dropdown. Falls back to no-filter only
  // if no season is set (empty seasons table).
  const seasonFilter = currentSeason;

  let ordersQuery = supa.from('orders').select(
    'order_id, account_manager, account_name, country, order_date, ' +
    'total_units, total_value, status, customer_group, season_id'
  ).order('order_date', { ascending: false });
  if (seasonFilter) ordersQuery = ordersQuery.eq('season_id', seasonFilter);

  let targetsQuery = supa.from('sales_targets').select('name, season, category, target').eq('category', 'apparel');
  if (seasonFilter) targetsQuery = targetsQuery.eq('season', seasonFilter);

  const [ordersRes, linesRes, targetsRes, customersRes, draftsRes, historyRes, productsRes, salespeopleRes] = await Promise.all([
    ordersQuery,
    // order_lines columns: id, order_id, line_number, sku, product_name,
    //   collection_id, subsection_id, quantity, unit_price, line_total,
    //   size_breakdown, status, product_id, cresting_*, user_id.
    supa.from('order_lines').select(
      'id, order_id, sku, product_name, collection_id, quantity, unit_price, line_total'
    ),
    targetsQuery,
    // customers: keep select('*') for now. The leaderboard relies on
    // "Group" (capital G in the CREATE TABLE — PostgREST returns it
    // lowercase as 'group'). All other returned columns are admin- or
    // rep-relevant and are render-escaped at the call sites.
    supa.from('customers').select('*'),
    supa.from('draft_orders').select(
      'token, customer_data, order_data, created_at, expires_at'
    ).order('created_at', { ascending: false }),
    // customer_season_history columns: id, account_code, season_id,
    //   prebook_units, refill_units, total_units, mens_units,
    //   womens_units, junior_units, accessories_units, total_value,
    //   created_at. (No account_name; no plain "season" column.)
    supa.from('customer_season_history').select(
      'account_code, season_id, prebook_units, total_units, total_value'
    ),
    supa.from('products').select('sku, base_sku'),
    supa.from('salespeople').select('name, country')
  ]);

  // Race guard: bail if a newer loadAll has started since this one
  // dispatched its Promise.all.
  if (typeof loadGen === 'number' && loadGen !== loadGeneration) return;

  allOrders    = ordersRes.data  || [];
  allLines     = linesRes.data   || [];
  allDrafts    = draftsRes.data  || [];

  baseSkuMap = {};
  (productsRes.data || []).forEach(p => { if (p.base_sku) baseSkuMap[p.sku] = p.base_sku; });

  allCustomers = {};

  // Build salesperson -> country map from salespeople table
  const salespersonCountry = {};
  (salespeopleRes.data || []).forEach(s => {
    if (s.name) salespersonCountry[s.name] = (s.country || '').toUpperCase();
  });

  // Build targets and sum national totals by country
  targets = {};
  nationalTargets = { AU: 0, NZ: 0 };
  (targetsRes.data || []).forEach(b => {
    if (b.target != null) {
      targets[b.name] = b.target;
      const country = salespersonCountry[b.name] || '';
      if (country === 'AU') nationalTargets.AU += (b.target || 0);
      if (country === 'NZ') nationalTargets.NZ += (b.target || 0);
    }
  });

  // Build history lookup: account_code → same season-prefix from prior
  // year. AW27 compares to AW26 (not SS26). Falls back to 'AW27' if no
  // season is set, preserving the previous hardcoded behaviour.
  const currentDashSeason = currentSeason || 'AW27';
  const seasonPrefix = currentDashSeason.replace(/\d+$/, ''); // 'AW'
  const seasonYearMatch = currentDashSeason.match(/(\d+)$/);
  const seasonYear = seasonYearMatch ? parseInt(seasonYearMatch[1], 10) : 27;
  const priorSeasonId = seasonPrefix + (seasonYear - 1); // 'AW26'

  const historyByAccount = {};
  (historyRes.data || []).forEach(h => {
    if (h.season_id !== priorSeasonId) return;
    historyByAccount[h.account_code] = h;
  });

  // Build customer lookup keyed by lowercase account_name
  (customersRes.data || []).forEach(c => {
    const key = (c.account_name || '').toLowerCase();
    const hist = historyByAccount[c.account_code] || {};
    allCustomers[key] = {
      account_name: c.account_name || '',
      account_manager: c.account_manager || '',
      cma_key: c.cma_key || '',
      previous_total_units: hist.total_units || 0,
      previous_prebook: hist.prebook_units || 0,
      group: c.Group || c.group || ''
    };
  });

  // Build order_id → order lookup for line joins
  window._orderLookup = {};
  allOrders.forEach(o => { window._orderLookup[o.order_id] = o; });

  const t = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('last-updated').textContent = 'Updated ' + t;

  renderNationalTargets();
  renderSummaryStats();
  renderLeaderboard();
  renderTopProducts();
  renderOrders();
  renderDrafts();
  populateFilters();
  populateTargetInputs();
  updateLabelsForProductType();
}

// ── FOOTWEAR LOADER ─────────────────────────────────────────────────────────
// Sibling of loadApparel. The footwear order model differs from apparel
// (orders + order_lines) in that submitted orders live as
// footwear_drafts rows with a `cart_items` JSON column. We synthesize
// allOrders / allLines in the apparel shape so the existing renderers
// can be reused as-is. Targets and customer_season_history are pulled
// the same way, just with the appropriate filters.
//
// Country resolution: footwear_drafts has no country column. We map the
// draft's account_manager (rep name) through the salespeople table to
// pick up AU/NZ, then convert to AUD/NZD to match the apparel
// convention used by renderNationalTargets and the orders table.
async function loadFootwear(loadGen) {
  const seasonFilter = currentSeason;

  // After the May 2026 parity migration, footwear_drafts carries
  // country / customer_group / total_units / total_value / submitted_at
  // as real columns. Legacy submitted rows leave these NULL; the
  // synthesis fallback below covers them. The query still orders by
  // updated_at — for legacy rows submitted_at was backfilled from
  // updated_at, and for new rows the two are written together, so the
  // ordering is identical either way.
  let submittedQuery = supa.from('footwear_drafts')
    .select(
      'id, season_id, status, cart_items, customer_data, ' +
      'country, customer_group, total_units, total_value, submitted_at, ' +
      'created_by, created_at, updated_at'
    )
    .eq('status', 'submitted')
    .order('updated_at', { ascending: false });
  if (seasonFilter) submittedQuery = submittedQuery.eq('season_id', seasonFilter);

  let draftsListQuery = supa.from('footwear_drafts')
    .select('id, share_token, season_id, cart_items, customer_data, created_at')
    .eq('status', 'draft')
    .order('created_at', { ascending: false });
  if (seasonFilter) draftsListQuery = draftsListQuery.eq('season_id', seasonFilter);

  let targetsQuery = supa.from('sales_targets').select('name, season, category, target').eq('category', 'footwear');
  if (seasonFilter) targetsQuery = targetsQuery.eq('season', seasonFilter);

  const [submittedRes, draftsListRes, targetsRes, customersRes, historyRes, productsRes, salespeopleRes] = await Promise.all([
    submittedQuery,
    draftsListQuery,
    targetsQuery,
    supa.from('customers').select('*'),
    supa.from('customer_season_history').select(
      'account_code, season_id, prebook_units, total_units, total_value'
    ),
    // Footwear loader pulls richer product columns so lines can be
    // rebuilt from cart_items. exclusive / silo / outsole / energy are
    // also pulled so legacy cart_items (no snapshot fields) can fall
    // back to the current product attribute instead of showing blanks.
    supa.from('products').select('id, sku, base_sku, product_name, collection_id, exclusive, silo, outsole, energy'),
    supa.from('salespeople').select('name, country')
  ]);

  // Race guard mirrors loadApparel: if a fresher loadAll has started
  // while we were waiting on the network, drop this run.
  if (typeof loadGen === 'number' && loadGen !== loadGeneration) return;

  const submitted = submittedRes.data || [];
  const products  = productsRes.data  || [];

  // Product lookups
  const productById = {};
  products.forEach(p => { if (p.id) productById[p.id] = p; });

  baseSkuMap = {};
  products.forEach(p => { if (p.base_sku && p.sku) baseSkuMap[p.sku] = p.base_sku; });

  // Salesperson -> country (AU/NZ). Mapped to currency code (AUD/NZD)
  // when synthesizing the order rows so renderNationalTargets and the
  // orders-table country filter work without changes.
  const salespersonCountry = {};
  (salespeopleRes.data || []).forEach(s => {
    if (s.name) salespersonCountry[s.name] = (s.country || '').toUpperCase();
  });
  function countryForRep(name) {
    const c = salespersonCountry[name] || '';
    if (c === 'AU') return 'AUD';
    if (c === 'NZ') return 'NZD';
    return '';
  }

  // Synthesize allOrders from submitted footwear_drafts. Prefer the
  // direct header columns (post-parity-migration) when present; fall
  // back to deriving the same values from cart_items + customer_data
  // for legacy rows that pre-date the migration. order_id uses the
  // draft uuid so the existing renderers (which key off order_id) can
  // join lines to orders without collision risk.
  allOrders = submitted.map(d => {
    const cd    = d.customer_data || {};
    const items = Array.isArray(d.cart_items) ? d.cart_items : [];

    const directUnits = d.total_units;
    const totalUnits  = (directUnits != null) ? Number(directUnits)
                                              : items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);

    const directValue = d.total_value;
    const totalValue  = (directValue != null) ? Number(directValue)
                                              : items.reduce((s, it) => {
                                                  const q = Number(it.quantity)   || 0;
                                                  const p = Number(it.unit_price) || 0;
                                                  return s + q * p;
                                                }, 0);

    // Country: direct column wins. salespeople.country stores 'AU'/'NZ';
    // direct column may already be the rep's country code in either
    // form (the cart writes state.currentUser.country, which can be
    // either 'AU'/'NZ' or 'AUD'/'NZD' depending on profile). Normalise
    // to 'AUD'/'NZD' so renderNationalTargets matches apparel rows.
    let country = d.country;
    if (!country) country = countryForRep(cd.account_manager);
    if (country === 'AU') country = 'AUD';
    if (country === 'NZ') country = 'NZD';

    return {
      order_id:        d.id,
      account_manager: cd.account_manager || '',
      account_name:    cd.account_name    || '',
      country:         country || '',
      order_date:      d.submitted_at || d.updated_at || d.created_at,
      total_units:     totalUnits,
      total_value:     totalValue,
      status:          'submitted',
      customer_group:  d.customer_group || '',
      season_id:       d.season_id
    };
  });

  // Synthesize allLines from the cart_items JSON. line_total = qty *
  // unit_price; missing unit_price (legacy drafts pre-Phase-1) treated
  // as zero, and we flag the data set so the Value KPI can surface a
  // small note that legacy lines are excluded from the dollar total.
  allLines = [];
  footwearHasLegacyLines = false;
  submitted.forEach(d => {
    const items = Array.isArray(d.cart_items) ? d.cart_items : [];
    items.forEach((it, idx) => {
      const p   = productById[it.product_id] || {};
      const qty = Number(it.quantity)   || 0;
      const hasPrice = it.unit_price != null && isFinite(Number(it.unit_price));
      const pr  = hasPrice ? Number(it.unit_price) : 0;
      if (!hasPrice && qty > 0) footwearHasLegacyLines = true;
      allLines.push({
        id:            d.id + ':' + idx,
        order_id:      d.id,
        sku:           p.sku          || '',
        product_name:  p.product_name || '',
        collection_id: p.collection_id || null,
        quantity:      qty,
        unit_price:    pr,
        line_total:    qty * pr,
        // Snapshot fields preserved at add-to-cart time. Fall back to
        // the live product attribute when the cart_item predates the
        // snapshot work (legacy drafts).
        size:          it.size      || null,
        width:         it.width     || null,
        exclusive:     it.exclusive || p.exclusive || null,
        silo:          it.silo      || p.silo      || null,
        outsole:       it.outsole   || p.outsole   || null,
        energy:        it.energy    || p.energy    || null
      });
    });
  });

  // Synthesize the draft list for the Drafts tab. Shape mirrors apparel
  // draft_orders so renderDrafts can iterate without branching. The
  // _productType tag lets renderDrafts route the Open link to the
  // right form and pull units from cart_items rather than the apparel
  // order_data shape.
  allDrafts = (draftsListRes.data || []).map(d => {
    const items = Array.isArray(d.cart_items) ? d.cart_items : [];
    const totalUnits = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    return {
      token:         d.share_token,
      customer_data: d.customer_data || {},
      order_data:    { totalUnits: totalUnits },
      created_at:    d.created_at,
      expires_at:    null,
      _productType:  'footwear',
      _totalUnits:   totalUnits
    };
  });

  // Build targets + national totals using the same rules as apparel.
  // Footwear targets are stored in units (pairs) per admin convention,
  // matching the existing renderer's units-based comparison.
  targets = {};
  nationalTargets = { AU: 0, NZ: 0 };
  (targetsRes.data || []).forEach(b => {
    if (b.target == null) return;
    targets[b.name] = b.target;
    const country = salespersonCountry[b.name] || '';
    if (country === 'AU') nationalTargets.AU += (b.target || 0);
    if (country === 'NZ') nationalTargets.NZ += (b.target || 0);
  });

  // Customer history: prior-season comparison. Strip the '-shoe' suffix
  // before computing the prior year so AW27-shoe compares to AW26-shoe.
  const cleanSeason   = (currentSeason || 'AW27-shoe').replace(/-shoe$/i, '');
  const seasonPrefix  = cleanSeason.replace(/\d+$/, '');
  const yearMatch     = cleanSeason.match(/(\d+)$/);
  const seasonYear    = yearMatch ? parseInt(yearMatch[1], 10) : 27;
  const priorSeasonId = seasonPrefix + (seasonYear - 1) + '-shoe';

  const historyByAccount = {};
  (historyRes.data || []).forEach(h => {
    if (h.season_id !== priorSeasonId) return;
    historyByAccount[h.account_code] = h;
  });

  allCustomers = {};
  (customersRes.data || []).forEach(c => {
    const key  = (c.account_name || '').toLowerCase();
    const hist = historyByAccount[c.account_code] || {};
    allCustomers[key] = {
      account_name:        c.account_name || '',
      account_manager:     c.account_manager || '',
      cma_key:             c.cma_key || '',
      previous_total_units: hist.total_units || 0,
      previous_prebook:     hist.prebook_units || 0,
      group:                c.Group || c.group || ''
    };
  });

  // order_id -> order lookup (used by line-level expand views)
  window._orderLookup = {};
  allOrders.forEach(o => { window._orderLookup[o.order_id] = o; });

  const t = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('last-updated').textContent = 'Updated ' + t;

  renderNationalTargets();
  renderSummaryStats();
  renderLeaderboard();
  renderTopProducts();
  renderOrders();
  renderDrafts();
  populateFilters();
  populateTargetInputs();
  updateLabelsForProductType();
}

// ── SUMMARY STATS ────────────────────────────────────────────────────────────
function renderSummaryStats() {
  const submitted = allOrders.filter(o => o.status === 'submitted');
  const accounts  = new Set(submitted.map(o => o.account_name)).size;
  const units     = submitted.reduce((s, o) => s + (o.total_units || 0), 0);
  const value     = submitted.reduce((s, o) => s + parseFloat(o.total_value || 0), 0);
  document.getElementById('stat-accounts').textContent = accounts;
  document.getElementById('stat-units').textContent    = units.toLocaleString();
  document.getElementById('stat-value').textContent    = '$' + Math.round(value).toLocaleString();
  document.getElementById('stat-orders').textContent   = submitted.length;
}

// ── NATIONAL TARGETS ─────────────────────────────────────────────────────────
function renderNationalTargets() {
  const submitted = allOrders.filter(o => o.status === 'submitted');

  // AU progress -- orders where country is AUD
  const auUnits = submitted
    .filter(o => o.country === 'AUD')
    .reduce((s, o) => s + (o.total_units || 0), 0);
  const auValue = submitted
    .filter(o => o.country === 'AUD')
    .reduce((s, o) => s + parseFloat(o.total_value || 0), 0);

  // NZ progress -- orders where country is NZD
  const nzUnits = submitted
    .filter(o => o.country === 'NZD')
    .reduce((s, o) => s + (o.total_units || 0), 0);
  const nzValue = submitted
    .filter(o => o.country === 'NZD')
    .reduce((s, o) => s + parseFloat(o.total_value || 0), 0);

  const auTarget = nationalTargets.AU;
  const nzTarget = nationalTargets.NZ;

  function updateCard(prefix, units, value, target) {
    const pct      = target > 0 ? (units / target) * 100 : 0;
    const barPct   = Math.min(pct, 100);
    const over     = pct > 100;
    const complete = pct >= 100;
    const cls      = over ? 'over' : complete ? 'complete' : '';
    const remaining = Math.max(0, target - units);

    const pctEl    = document.getElementById(`nat-${prefix}-pct`);
    const barEl    = document.getElementById(`nat-${prefix}-bar`);
    const detailEl = document.getElementById(`nat-${prefix}-detail`);

    pctEl.textContent  = target > 0 ? pct.toFixed(0) + '%' : '-';
    pctEl.className    = 'national-target-pct' + (cls ? ' ' + cls : '');
    barEl.style.width  = barPct.toFixed(1) + '%';
    barEl.className    = 'national-target-bar-fill' + (cls ? ' ' + cls : '');

    if (target > 0) {
      const currSymbol = prefix === 'au' ? 'A$' : 'NZ$';
      detailEl.innerHTML =
        `<strong>${units.toLocaleString()}</strong> of <strong>${target.toLocaleString()}</strong> units` +
        (over
          ? ` &nbsp;&middot;&nbsp; <span style="color:#7b3fcf;font-weight:700">+${(units - target).toLocaleString()} over target</span>`
          : ` &nbsp;&middot;&nbsp; ${remaining.toLocaleString()} units to go`) +
        ` &nbsp;&middot;&nbsp; ${currSymbol}${Math.round(value).toLocaleString()} WS value`;
    } else {
      detailEl.textContent = 'No target set';
    }
  }

  updateCard('au', auUnits, auValue, auTarget);
  updateCard('nz', nzUnits, nzValue, nzTarget);
}

// ── LEADERBOARD ──────────────────────────────────────────────────────────────
let leaderboardView = 'target';

function setLeaderboardView(view) {
  leaderboardView = view;
  document.querySelectorAll('#leaderboard-view-toggle button').forEach(b => {
    b.classList.toggle('active', b.textContent.toLowerCase() === view);
  });
  renderLeaderboard();
}

function renderLeaderboard() {
  const submitted = allOrders.filter(o => o.status === 'submitted');
  const repMap = {};

  Object.keys(targets).forEach(name => {
    repMap[name] = { rep: name, accounts: new Set(), units: 0, value: 0, ordersByAccount: {} };
  });

  submitted.forEach(o => {
    const rep = o.account_manager || 'Unassigned';
    if (!repMap[rep]) repMap[rep] = { rep, accounts: new Set(), units: 0, value: 0, ordersByAccount: {} };
    repMap[rep].accounts.add(o.account_name);
    repMap[rep].units += (o.total_units || 0);
    repMap[rep].value += parseFloat(o.total_value || 0);
    // Track best (latest/largest) order per account for growth calc
    const acctKey = (o.account_name || '').toLowerCase();
    if (!repMap[rep].ordersByAccount[acctKey] || (o.total_units || 0) > repMap[rep].ordersByAccount[acctKey]) {
      repMap[rep].ordersByAccount[acctKey] = o.total_units || 0;
    }
  });

  // Calculate growth stats per rep
  Object.values(repMap).forEach(r => {
    let totalDiff = 0;
    let totalPrior = 0;
    let accountCount = 0;
    Object.entries(r.ordersByAccount).forEach(([acctKey, currentUnits]) => {
      const cust = allCustomers[acctKey];
      const prior = cust?.previous_prebook || 0;
      totalDiff += (currentUnits - prior);
      totalPrior += prior;
      accountCount++;
    });
    r.avgDiff = accountCount > 0 ? totalDiff / accountCount : 0;
    r.totalDiff = totalDiff;
    r.totalPrior = totalPrior;
    r.growthPct = totalPrior > 0 ? (totalDiff / totalPrior) * 100 : (totalDiff > 0 ? 100 : 0);
    r.growthAccounts = accountCount;
  });

  const rows = Object.values(repMap).sort((a, b) => {
    if (leaderboardView === 'growth') return b.avgDiff - a.avgDiff;
    const ta = targets[a.rep] || 0;
    const tb = targets[b.rep] || 0;
    if (ta > 0 && tb > 0) return (b.units / tb) - (a.units / ta);
    if (ta > 0) return -1;
    if (tb > 0) return 1;
    return b.units - a.units;
  });

  // For growth view, find max absolute avg diff to scale bars
  const maxAbsDiff = Math.max(1, ...rows.map(r => Math.abs(r.avgDiff)));

  const lastColHeader = document.getElementById('leaderboard-last-col');
  if (lastColHeader) lastColHeader.textContent = leaderboardView === 'growth' ? 'Avg Growth vs Prior' : 'Progress to Target';

  const tbody = document.getElementById('leaderboard-body');
  tbody.innerHTML = '';

  rows.forEach((r, i) => {
    const rank    = i + 1;
    const rankCls = rank <= 3 ? 'rank-' + rank : 'rank-other';

    let lastCell = '';

    if (leaderboardView === 'growth') {
      const avg = r.avgDiff;
      const sign = avg > 0 ? 'positive' : avg < 0 ? 'negative' : 'neutral';
      const barWidthPct = (Math.abs(avg) / maxAbsDiff) * 50; // 50% = max half

      let barStyle, centerPct;
      if (avg >= 0) {
        centerPct = 50;
        barStyle = `left:50%;width:${barWidthPct.toFixed(1)}%`;
      } else {
        centerPct = 50;
        barStyle = `left:${(50 - barWidthPct).toFixed(1)}%;width:${barWidthPct.toFixed(1)}%`;
      }

      const avgDisplay = avg >= 0 ? `+${Math.round(avg)}` : `${Math.round(avg)}`;
      const totalDisplay = r.totalDiff >= 0 ? `+${r.totalDiff}` : `${r.totalDiff}`;
      const pctSign = r.growthPct >= 0 ? '+' : '';
      const pctDisplay = `${pctSign}${r.growthPct.toFixed(0)}%`;

      lastCell = `
        <td class="growth-bar-wrap">
          <div class="growth-bar-track">
            <div class="growth-bar-center" style="left:50%"></div>
            <div class="growth-bar-fill ${sign}" style="${barStyle}"></div>
          </div>
          <div class="growth-label">
            <span class="growth-val ${sign}" style="font-weight:700">${pctDisplay}</span>
            &nbsp;&middot;&nbsp; Avg <span class="growth-val ${sign}">${avgDisplay}</span> units/account
            &nbsp;&middot;&nbsp; Total <span class="growth-val ${sign}">${totalDisplay}</span> across ${r.growthAccounts} account${r.growthAccounts !== 1 ? 's' : ''}
          </div>
        </td>`;
    } else {
      const target  = targets[r.rep] || 0;
      const pct     = target > 0 ? (r.units / target) * 100 : 0;
      const barPct  = Math.min(pct, 100);
      const over    = pct > 100;
      const complete = pct >= 100;
      const barCls  = over ? 'over' : complete ? 'complete' : '';

      lastCell = `
        <td class="progress-wrap">
          ${target > 0 ? `
            <div class="progress-bar-bg">
              <div class="progress-bar-fill ${barCls}" style="width:${barPct.toFixed(1)}%"></div>
            </div>
            <div class="progress-pct ${over ? 'over' : ''}">${r.units.toLocaleString()} / ${target.toLocaleString()} units (${pct.toFixed(0)}%)</div>
          ` : `<span style="font-size:11px;color:var(--mid)">No target set</span>`}
        </td>`;
    }

    tbody.innerHTML += `
      <tr>
        <td><span class="rank-badge ${rankCls}">${rank}</span></td>
        <td style="font-weight:600">${escapeHtml(r.rep)}</td>
        <td class="right">${r.accounts.size}</td>
        <td class="right" style="font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700">${r.units.toLocaleString()}</td>
        <td class="right" style="font-size:12px;color:var(--mid)">$${Math.round(r.value).toLocaleString()}</td>
        ${lastCell}
      </tr>`;
  });

  if (!rows.length) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--mid);padding:40px">No submitted orders yet</td></tr>';
  document.getElementById('leaderboard-loading').style.display = 'none';
  document.getElementById('leaderboard-table').style.display   = '';
}

// ── TOP PRODUCTS ─────────────────────────────────────────────────────────────
let topMetric = 'units';

function setTopMetric(metric) {
  topMetric = metric;
  document.getElementById('toggle-units').classList.toggle('active', metric === 'units');
  document.getElementById('toggle-dollars').classList.toggle('active', metric === 'dollars');
  renderTopProducts();
}

function productImgUrl(sku) { return sku ? SUPA_IMG_BASE + (baseSkuMap[sku] || sku) + '_01.jpg' : null; }

function thumbFallback(el) {
  if (el.src.endsWith('.jpg')) {
    el.src = el.src.replace('.jpg', '.png');
  } else {
    el.onerror = null;
    const wrap = el.closest('.thumb-wrap');
    if (wrap) wrap.innerHTML = '<div class="thumb-placeholder">👕</div>';
  }
}

function renderTopProducts() {
  const collFilter  = document.getElementById('collection-filter').value;
  const groupFilter = document.getElementById('group-filter').value;
  const byDollars   = topMetric === 'dollars';

  // Open seasons filter: only count orders whose season_id is currently
  // active. If the seasons table is empty (legacy install) we fall back
  // to all-time so the dashboard still renders something useful.
  const openSeasonOrderIds = openSeasonIds.size
    ? new Set(allOrders.filter(o => openSeasonIds.has(o.season_id)).map(o => o.order_id))
    : null;

  // Build set of order_ids whose customer belongs to the selected group
  let groupOrderIds = null;
  if (groupFilter) {
    groupOrderIds = new Set();
    allOrders.forEach(o => {
      // Use customer_group from order (new orders) or fallback to customers table lookup
      const grp = o.customer_group || allCustomers[(o.account_name || '').toLowerCase()]?.group || '';
      if (grp === groupFilter) groupOrderIds.add(o.order_id);
    });
  }

  // Filter lines: collection -> open-season -> customer-group, in that order.
  let lines = collFilter ? allLines.filter(l => l.collection_id === collFilter) : [...allLines];
  if (openSeasonOrderIds) {
    lines = lines.filter(l => openSeasonOrderIds.has(l.order_id));
  }
  if (groupOrderIds) {
    lines = lines.filter(l => groupOrderIds.has(l.order_id));
  }

  // Group by base_sku so different colourways/widths of the same product
  // roll up to one row. Falls back to sku when no base_sku is mapped.
  const skuMap = {};
  lines.forEach(l => {
    const groupKey = baseSkuMap[l.sku] || l.sku;
    if (!skuMap[groupKey]) skuMap[groupKey] = {
      sku: groupKey, desc: l.product_name, collection: l.collection_id,
      accounts: new Set(), units: 0, dollars: 0,
      memberSkus: new Set()
    };
    skuMap[groupKey].memberSkus.add(l.sku);
    const order = window._orderLookup[l.order_id];
    if (order) skuMap[groupKey].accounts.add(order.account_name);
    skuMap[groupKey].units   += (l.quantity || 0);
    skuMap[groupKey].dollars += (l.line_total || (l.unit_price || 0) * (l.quantity || 0));
  });

  const rows = Object.values(skuMap).sort((a, b) => byDollars ? b.dollars - a.dollars : b.units - a.units);

  document.getElementById('top-products-title').textContent = byDollars ? 'Top Products by Wholesale $' : 'Top Products by Units';
  document.getElementById('top-metric-header').textContent  = byDollars ? 'Total WS $' : 'Total Units';

  const tbody = document.getElementById('top-products-body');
  tbody.innerHTML = '';

  // Store filtered lines globally for detail expansion
  window._topProductLines = lines;

  rows.forEach((r, i) => {
    const rank    = i + 1;
    const rankCls = rank <= 3 ? 'rank-' + rank : 'rank-other';
    const imgUrl  = productImgUrl(r.sku);
    const thumbCell = imgUrl
      ? `<div class="thumb-wrap">
           <img class="thumb-img" src="${escapeAttr(imgUrl)}" alt="${escapeAttr(r.desc)}" loading="lazy" data-img-fallback="thumb">
           <div class="thumb-hover"><img src="${escapeAttr(imgUrl)}" alt="${escapeAttr(r.desc)}" data-img-fallback="thumb-hover"></div>
         </div>`
      : `<div class="thumb-placeholder">👕</div>`;
    const metricVal = byDollars ? `$${Math.round(r.dollars).toLocaleString()}` : r.units.toLocaleString();

    tbody.innerHTML += `
      <tr class="product-row" data-action="toggleProductDetail" data-sku="${escapeAttr(r.sku)}">
        <td><span class="rank-badge ${rankCls}">${rank}</span></td>
        <td style="padding:6px 10px">${thumbCell}</td>
        <td style="font-family:monospace;font-size:12px">${escapeHtml(r.sku)}</td>
        <td style="font-weight:500">${escapeHtml(r.desc || '—')}</td>
        <td style="font-size:12px;color:var(--mid)">${escapeHtml(r.collection || '—')}</td>
        <td class="right">${r.accounts.size}</td>
        <td class="right" style="font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700">${metricVal}</td>
      </tr>`;
  });

  if (!rows.length) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--mid);padding:40px">No order lines yet</td></tr>';
  document.getElementById('top-products-loading').style.display = 'none';
  document.getElementById('top-products-table').style.display   = '';
}

// ── EXPANDABLE PRODUCT DETAIL ───────────────────────────────────────────────
function toggleProductDetail(sku, rowEl) {
  const existing = rowEl.nextElementSibling;

  // If already expanded, collapse it
  if (existing && existing.classList.contains('product-detail-row')) {
    existing.remove();
    rowEl.classList.remove('expanded');
    return;
  }

  // Collapse any other open detail
  document.querySelectorAll('.product-detail-row').forEach(r => {
    r.previousElementSibling?.classList.remove('expanded');
    r.remove();
  });

  rowEl.classList.add('expanded');

  // Find all lines for this SKU from the current filtered set
  const lines = (window._topProductLines || []).filter(l => l.sku === sku);

  // Group by customer account, collecting size breakdown
  const custMap = {};
  const allSizes = new Set();

  lines.forEach(l => {
    const order = window._orderLookup[l.order_id];
    const acctName = order ? order.account_name : 'Unknown';

    if (!custMap[acctName]) custMap[acctName] = { account: acctName, sizes: {}, total: 0, dollars: 0 };

    // Parse size_breakdown string like "S:2,M:3,L:1"
    const breakdown = l.size_breakdown || '';
    if (breakdown) {
      breakdown.split(',').forEach(pair => {
        const [size, qty] = pair.split(':');
        if (size && qty) {
          const trimSize = size.trim();
          const numQty = parseInt(qty.trim()) || 0;
          allSizes.add(trimSize);
          custMap[acctName].sizes[trimSize] = (custMap[acctName].sizes[trimSize] || 0) + numQty;
        }
      });
    }

    custMap[acctName].total   += (l.quantity || 0);
    custMap[acctName].dollars += (l.line_total || (l.unit_price || 0) * (l.quantity || 0));
  });

  const customers = Object.values(custMap).sort((a, b) => b.total - a.total);

  // Sort sizes in a sensible order (try numeric first, then alpha)
  const sortedSizes = [...allSizes].sort((a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    // Try common size ordering
    const sizeOrder = ['XXS','XS','S','M','L','XL','XXL','2XL','3XL','4XL'];
    const ai = sizeOrder.indexOf(a.toUpperCase()), bi = sizeOrder.indexOf(b.toUpperCase());
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  // Build size header columns
  const sizeHeaders = sortedSizes.map(s => `<th class="right">${s}</th>`).join('');

  // Build customer rows
  let customerRows = '';
  const sizeTotals = {};
  sortedSizes.forEach(s => { sizeTotals[s] = 0; });
  let grandTotal = 0;
  let grandDollars = 0;

  customers.forEach(c => {
    const sizeCells = sortedSizes.map(s => {
      const qty = c.sizes[s] || 0;
      sizeTotals[s] += qty;
      return `<td class="right">${qty || ''}</td>`;
    }).join('');

    const custData = allCustomers[(c.account || '').toLowerCase()];
    const group = custData?.group || '';

    grandTotal   += c.total;
    grandDollars += c.dollars;

    customerRows += `<tr>
      <td style="font-weight:600">${escapeHtml(c.account)}</td>
      <td style="color:var(--mid)">${escapeHtml(group)}</td>
      ${sizeCells}
      <td class="right" style="font-weight:700">${c.total}</td>
      <td class="right" style="color:var(--mid)">$${Math.round(c.dollars).toLocaleString()}</td>
    </tr>`;
  });

  // Totals row
  const totalSizeCells = sortedSizes.map(s =>
    `<td class="right" style="font-weight:700">${sizeTotals[s] || ''}</td>`
  ).join('');

  const detailHtml = `
    <tr class="product-detail-row">
      <td colspan="7">
        <div class="product-detail-inner">
          <div class="detail-section-title">Customer Breakdown — ${customers.length} Account${customers.length !== 1 ? 's' : ''}</div>
          <table class="detail-customer-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Group</th>
                ${sizeHeaders}
                <th class="right">Total Qty</th>
                <th class="right">Value</th>
              </tr>
            </thead>
            <tbody>
              ${customerRows}
              <tr class="detail-total-row">
                <td colspan="2" style="font-weight:700">Total</td>
                ${totalSizeCells}
                <td class="right" style="font-weight:700">${grandTotal}</td>
                <td class="right" style="font-weight:700">$${Math.round(grandDollars).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </td>
    </tr>`;

  rowEl.insertAdjacentHTML('afterend', detailHtml);
}

// Position hover previews near cursor
document.addEventListener('mousemove', e => {
  document.querySelectorAll('.thumb-hover').forEach(el => {
    const pad = 16, w = 260, h = 260;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > window.innerWidth)  x = e.clientX - w - pad;
    if (y + h > window.innerHeight) y = e.clientY - h - pad;
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
  });
});

// ── ALL ORDERS ───────────────────────────────────────────────────────────────
let orderSortCol = 'account';
let orderSortDir = 'asc';

function sortOrders(col) {
  if (orderSortCol === col) {
    orderSortDir = orderSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    orderSortCol = col;
    // Default to desc for numeric columns, asc for text
    orderSortDir = ['units','value','prior','diff','date'].includes(col) ? 'desc' : 'asc';
  }
  // Update header styling
  document.querySelectorAll('#orders-table th.sortable').forEach(th => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.sort === orderSortCol) th.classList.add(orderSortDir);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = th.dataset.sort === orderSortCol ? (orderSortDir === 'asc' ? '▲' : '▼') : '▲▼';
  });
  renderOrders();
}

function renderOrders() {
  const repFilter = document.getElementById('rep-filter').value;
  let orders = [];

  if (includePrebook) {
    const submittedMap = {};
    allOrders.filter(o => o.status === 'submitted').forEach(o => {
      const key = (o.account_name || '').toLowerCase();
      if (!submittedMap[key]) submittedMap[key] = [];
      submittedMap[key].push(o);
    });

    Object.entries(allCustomers).forEach(([key, data]) => {
      if ((data.previous_prebook || data.previous_total_units) > 0) {
        if (submittedMap[key]) {
          orders = orders.concat(submittedMap[key]);
        } else {
          orders.push({
            order_id: null,
            account_name: data.account_name,
            account_manager: data.account_manager,
            country: '—',
            status: 'no-order',
            total_units: 0,
            total_value: 0,
            order_date: null,
            _prior: data.previous_prebook || data.previous_total_units
          });
        }
      }
    });

    Object.values(submittedMap).forEach(orderList => {
      orderList.forEach(o => {
        const key = (o.account_name || '').toLowerCase();
        if (!allCustomers[key]) orders.push(o);
      });
    });
  } else {
    orders = allOrders.filter(o => o.status === 'submitted');
  }

  if (repFilter) orders = orders.filter(o => o.account_manager === repFilter);

  // Enrich orders with computed fields
  orders.forEach(o => {
    o._currentUnits = o.total_units || 0;
    o._currentValue = parseFloat(o.total_value || 0);
    const custKey = (o.account_name || '').toLowerCase();
    o._prior = o._prior || (allCustomers[custKey]?.previous_prebook || 0);
    o._diff = o._currentUnits - o._prior;
  });

  // ── GROUP by account name ──
  const grouped = {};
  orders.forEach(o => {
    const key = (o.account_name || '—').toLowerCase();
    if (!grouped[key]) {
      grouped[key] = {
        account_name: o.account_name || '—',
        account_manager: o.account_manager || '—',
        country: o.country || '—',
        totalUnits: 0,
        totalValue: 0,
        prior: o._prior || 0,
        latestDate: o.order_date || '',
        status: o.status,
        orders: []
      };
    }
    const g = grouped[key];
    g.totalUnits += o._currentUnits;
    g.totalValue += o._currentValue;
    // Keep the latest date
    if (o.order_date && o.order_date > g.latestDate) g.latestDate = o.order_date;
    // If any order is submitted, the group is submitted
    if (o.status === 'submitted') g.status = 'submitted';
    // Use first non-empty manager/country
    if (o.account_manager && g.account_manager === '—') g.account_manager = o.account_manager;
    if (o.country && o.country !== '—' && g.country === '—') g.country = o.country;
    g.orders.push(o);
  });

  // Convert to array and compute diff
  let rows = Object.values(grouped);
  rows.forEach(g => {
    g.diff = g.totalUnits - g.prior;
  });

  // Sort
  const dir = orderSortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let va, vb;
    switch (orderSortCol) {
      case 'account': va = a.account_name || ''; vb = b.account_name || ''; return dir * va.localeCompare(vb);
      case 'manager': va = a.account_manager || ''; vb = b.account_manager || ''; return dir * va.localeCompare(vb);
      case 'country': va = a.country || ''; vb = b.country || ''; return dir * va.localeCompare(vb);
      case 'units':   return dir * (a.totalUnits - b.totalUnits);
      case 'value':   return dir * (a.totalValue - b.totalValue);
      case 'prior':   return dir * (a.prior - b.prior);
      case 'diff':    return dir * (a.diff - b.diff);
      case 'date':    va = a.latestDate || ''; vb = b.latestDate || ''; return dir * va.localeCompare(vb);
      case 'status':  va = a.status || ''; vb = b.status || ''; return dir * va.localeCompare(vb);
      default: return 0;
    }
  });

  // Store for expand/collapse
  window._groupedOrders = {};
  rows.forEach(g => { window._groupedOrders[(g.account_name || '').toLowerCase()] = g; });

  const tbody = document.getElementById('orders-body');
  tbody.innerHTML = '';

  rows.forEach(g => {
    const diffCls  = g.diff > 0 ? 'diff-positive' : g.diff < 0 ? 'diff-negative' : 'diff-zero';
    const diffText = g.diff > 0 ? `+${g.diff}` : g.diff === 0 && g.totalUnits === 0 ? '—' : String(g.diff);
    const status    = g.status === 'submitted' ? 'Submitted' : 'No Order';
    const statusCls = g.status === 'submitted' ? 'status-submitted' : 'status-draft';
    const dateStr   = g.latestDate || '—';
    const count     = g.orders.length;
    const countBadge = count > 1 ? `<span class="order-count-badge">(${count})</span>` : '';
    const acctKey   = (g.account_name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');

    tbody.innerHTML += `
      <tr class="order-row${count > 1 ? '' : ''}" data-action="toggleOrderDetail" data-key="${escapeAttr(acctKey)}" style="cursor:pointer">
        <td style="font-weight:600">${escapeHtml(g.account_name)}${countBadge}</td>
        <td>${escapeHtml(g.account_manager)}</td>
        <td>${escapeHtml(g.country)}</td>
        <td class="right" style="font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700">${g.totalUnits.toLocaleString()}</td>
        <td class="right" style="font-size:12px;color:var(--mid)">$${Math.round(g.totalValue).toLocaleString()}</td>
        <td class="right" style="font-size:13px;color:var(--mid)">${g.prior.toLocaleString()}</td>
        <td class="right ${diffCls}" style="font-size:13px">${diffText}</td>
        <td style="font-size:12px;color:var(--mid)">${escapeHtml(dateStr)}</td>
        <td><span class="status-badge ${statusCls}">${escapeHtml(status)}</span></td>
      </tr>`;
  });

  if (!rows.length) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--mid);padding:40px">No orders</td></tr>';
  document.getElementById('orders-loading').style.display = 'none';
  document.getElementById('orders-table').style.display   = '';
}

function toggleOrderDetail(acctKey, rowEl) {
  const existing = rowEl.nextElementSibling;

  // If already expanded, collapse
  if (existing && existing.classList.contains('order-detail-row')) {
    existing.remove();
    rowEl.classList.remove('expanded');
    return;
  }

  // Collapse any other open detail
  document.querySelectorAll('.order-detail-row').forEach(r => {
    r.previousElementSibling?.classList.remove('expanded');
    r.remove();
  });

  // Find the grouped data
  const g = Object.values(window._groupedOrders || {}).find(g =>
    (g.account_name || '').toLowerCase().replace(/[^a-z0-9]/g, '_') === acctKey
  );
  if (!g || g.orders.length < 1) return;

  rowEl.classList.add('expanded');

  // Build detail rows for each individual order
  let orderRows = '';
  g.orders.forEach((o, idx) => {
    const units = o._currentUnits || 0;
    const value = o._currentValue || 0;
    const date  = o.order_date || '—';
    const oid   = o.order_id || '—';
    orderRows += `<tr>
      <td style="font-weight:600">Order ${idx + 1}</td>
      <td style="color:var(--mid)">${escapeHtml(oid)}</td>
      <td>${escapeHtml(o.country || '—')}</td>
      <td class="right" style="font-weight:700">${units.toLocaleString()}</td>
      <td class="right" style="color:var(--mid)">$${Math.round(value).toLocaleString()}</td>
      <td style="font-size:12px;color:var(--mid)">${escapeHtml(date)}</td>
    </tr>`;
  });

  const detailHtml = `
    <tr class="order-detail-row">
      <td colspan="9">
        <div class="order-detail-inner">
          <div class="detail-section-title">Order Breakdown — ${g.orders.length} Order${g.orders.length !== 1 ? 's' : ''}</div>
          <table class="order-detail-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Order ID</th>
                <th>Country</th>
                <th class="right">Units</th>
                <th class="right">Value</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              ${orderRows}
            </tbody>
          </table>
        </div>
      </td>
    </tr>`;

  rowEl.insertAdjacentHTML('afterend', detailHtml);
}

function toggleIncludePrebook() {
  includePrebook = !includePrebook;
  const btn = document.getElementById('toggle-prebook-customers');
  btn.textContent = includePrebook
    ? 'Show: All Customers (Prior Season + Orders)'
    : 'Show: Submitted Orders Only';
  btn.style.background = includePrebook ? 'var(--gold)' : 'var(--white)';
  renderOrders();
}

// ── DRAFTS ───────────────────────────────────────────────────────────────────
function renderDrafts() {
  const now   = new Date();
  const tbody = document.getElementById('drafts-body');
  tbody.innerHTML = '';

  allDrafts.forEach(d => {
    const cd = d.customer_data || {};
    const accountName  = cd.customer || cd.account_name || '—';
    const managerName  = cd.manager || cd.account_manager || '—';

    // Units source depends on the draft's product type. Apparel drafts
    // store order_data keyed by SKU with a sizes map; footwear drafts
    // (synthesized in loadFootwear) expose _totalUnits directly.
    let units = 0;
    if (d._productType === 'footwear') {
      units = Number(d._totalUnits) || 0;
    } else {
      const od = d.order_data || {};
      Object.values(od).forEach(item => {
        const sizes = (item && item.sizes) || {};
        units += Object.values(sizes).reduce((a, b) => a + b, 0);
      });
    }

    const createdStr = d.created_at
      ? new Date(d.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';
    const expiresAt  = d.expires_at ? new Date(d.expires_at) : null;
    const isExpired  = expiresAt && expiresAt < now;
    const expiresStr = expiresAt
      ? expiresAt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
      : '—';

    const statusBadge = isExpired
      ? '<span class="status-badge status-expired">Expired</span>'
      : '<span class="status-badge status-draft">Active</span>';

    // Route the Open link to the right form based on product type.
    const formPath = d._productType === 'footwear' ? 'footwear/index.html' : 'apparel/index.html';
    const draftUrl = `${formPath}#draft=${encodeURIComponent(d.token)}&from=dashboard`;

    tbody.innerHTML += `
      <tr id="draft-row-${escapeAttr(d.token)}">
        <td style="font-weight:600">${escapeHtml(accountName)}</td>
        <td>${escapeHtml(managerName)}</td>
        <td class="right">${units.toLocaleString()}</td>
        <td style="font-size:12px;color:var(--mid)">${escapeHtml(createdStr)}</td>
        <td style="font-size:12px;color:var(--mid)">${escapeHtml(expiresStr)}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="draft-actions">
            ${!isExpired ? `<a class="btn-open-draft" href="${escapeAttr(draftUrl)}" target="_blank">✏️ Open</a>` : ''}
            <button class="btn-delete-draft" data-action="deleteDraft" data-token="${escapeAttr(d.token)}">✕</button>
          </div>
        </td>
      </tr>`;
  });

  if (!allDrafts.length) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--mid);padding:40px">No shared drafts</td></tr>';
  document.getElementById('drafts-loading').style.display = 'none';
  document.getElementById('drafts-table').style.display   = '';
}

async function deleteDraft(token) {
  if (!confirm('Delete this shared draft? This cannot be undone.')) return;
  // Look up which table the draft belongs to via its product-type tag.
  // Apparel: draft_orders.token. Footwear: footwear_drafts.share_token.
  const draft = allDrafts.find(d => d.token === token);
  const isFootwear = draft && draft._productType === 'footwear';
  const table  = isFootwear ? 'footwear_drafts' : 'draft_orders';
  const column = isFootwear ? 'share_token'     : 'token';
  const { error } = await supa.from(table).delete().eq(column, token);
  if (error) {
    alert('Error deleting draft. Please try again.');
  } else {
    allDrafts = allDrafts.filter(d => d.token !== token);
    renderDrafts();
  }
}

// ── FILTERS ──────────────────────────────────────────────────────────────────
function populateFilters() {
  const orderReps = new Set(allOrders.filter(o => o.account_manager).map(o => o.account_manager));
  const allReps = [...new Set([...Object.keys(targets), ...orderReps])].sort();
  const repSel = document.getElementById('rep-filter');
  repSel.innerHTML = '<option value="">All Reps</option>' +
    allReps.map(r => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`).join('');

  const colls = [...new Set(allLines.filter(l => l.collection_id).map(l => l.collection_id))].sort();
  const collSel = document.getElementById('collection-filter');
  collSel.innerHTML = '<option value="">All Collections</option>' +
    colls.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');

  // Populate customer group filter (from orders + customers table)
  const groupSet = new Set();
  allOrders.forEach(o => { if (o.customer_group) groupSet.add(o.customer_group); });
  Object.values(allCustomers).forEach(c => { if (c.group) groupSet.add(c.group); });
  const groups = [...groupSet].sort();
  const groupSel = document.getElementById('group-filter');
  groupSel.innerHTML = '<option value="">All Customer Groups</option>' +
    groups.map(g => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join('');
}

// ── TARGETS ──────────────────────────────────────────────────────────────────
function populateTargetInputs() {
  const container = document.getElementById('target-inputs');
  const orderReps = new Set(allOrders.filter(o => o.account_manager).map(o => o.account_manager));
  const allReps = [...new Set([...Object.keys(targets), ...orderReps])].sort();

  container.innerHTML = allReps.map(rep => `
    <div class="target-input-row">
      <label>${escapeHtml(rep)}</label>
      <input type="number" id="target-${rep.replace(/\s+/g,'_')}" value="${targets[rep] || ''}" placeholder="Units target">
    </div>`).join('');
}

function toggleTargetPanel() {
  // DB16 — refuse to open the panel for non-privileged users even if the
  // toggle button was somehow revealed (DevTools removing the hidden attr).
  // RLS on sales_targets remains the actual server-side fence.
  const u = currentUser || {};
  if (u.role !== 'admin' && u.role !== 'manager') return;
  document.getElementById('target-admin-panel').classList.toggle('active');
}

async function saveTargets() {
  // AUTH20 — defence-in-depth: refuse client-side if not privileged. RLS is the
  // server-side fence, but blocking here surfaces a clearer error and prevents
  // pointless DB round-trips from a tampered-DOM rep.
  const u = currentUser || {};
  if (u.role !== 'admin' && u.role !== 'manager') {
    document.getElementById('target-save-status').textContent = 'Only managers and admins can edit targets.';
    return;
  }
  document.getElementById('target-save-status').textContent = 'Saving…';
  // Targets are saved under the active product type's category and the
  // active season. The leaderboard's Edit Targets panel only writes the
  // category currently in view, so admins editing footwear targets won't
  // accidentally overwrite apparel rows and vice versa.
  const targetSeason   = currentSeason || 'AW27';
  const targetCategory = productType   || 'apparel';
  const orderReps = new Set(allOrders.filter(o => o.account_manager).map(o => o.account_manager));
  const allReps = [...new Set([...Object.keys(targets), ...orderReps])];
  const rows = allReps.map(rep => ({
    name: rep,
    target: parseFloat(document.getElementById('target-' + rep.replace(/\s+/g,'_')).value) || 0,
    season: targetSeason,
    category: targetCategory,
  }));
  const { error } = await supa.from('sales_targets').upsert(rows, { onConflict: 'name,season,category' });
  if (error) {
    document.getElementById('target-save-status').textContent = '✗ Could not save targets. Please try again.';
  } else {
    rows.forEach(r => { targets[r.name] = r.target; });
    document.getElementById('target-save-status').textContent = '✓ Saved';
    renderLeaderboard();
    setTimeout(() => { document.getElementById('target-save-status').textContent = ''; }, 3000);
  }
}

// ═══════════════════════════════════════════════
// EVENT LISTENERS (CSP-compliant, no unsafe-inline)
// ═══════════════════════════════════════════════

// Header buttons (legacy; the visible UI is the hamburger menu, but the
// hidden buttons keep their listeners in case other code triggers them).
document.getElementById('btn-refresh-load').addEventListener('click', function () {
  // Manual refresh invalidates the slide analytics cache too so a
  // subsequent click on the tab re-pulls from the RPC.
  slideAnalyticsCache = null;
  loadAll();
});
document.getElementById('btn-sign-out').addEventListener('click', handleSignOut);

// ── Hamburger menu ─────────────────────────────────────────────────────────
function toggleHeaderMenu() {
  var menu = document.getElementById('header-menu');
  var btn  = document.getElementById('header-menu-btn');
  if (!menu || !btn) return;
  if (menu.hidden) {
    var u = currentUser || {};
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
var menuTriggerBtn = document.getElementById('header-menu-btn');
if (menuTriggerBtn) {
  menuTriggerBtn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    toggleHeaderMenu();
  });
}
document.querySelectorAll('[data-dash-menu]').forEach(function (item) {
  item.addEventListener('click', function (ev) {
    ev.stopPropagation();
    var act = item.getAttribute('data-dash-menu');
    closeHeaderMenu();
    if      (act === 'home')    window.location.assign('index.html');
    else if (act === 'refresh') { slideAnalyticsCache = null; loadAll(); }
    else if (act === 'signout') handleSignOut();
  });
});
document.addEventListener('click', function (ev) {
  var menu = document.getElementById('header-menu');
  if (!menu || menu.hidden) return;
  if (ev.target.closest('#header-menu') || ev.target.closest('#header-menu-btn')) return;
  closeHeaderMenu();
});
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') closeHeaderMenu();
});

// Tab buttons
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    const tabId = this.dataset.tab;
    showTab(tabId);
    // Slide analytics loads on demand the first time the tab is shown,
    // and uses an in-memory cache for subsequent clicks. The other
    // tabs load via loadAll(); this one is on its own loader so we
    // don't pay for it on every page load.
    if (tabId === 'slide-analytics') {
      loadSlideAnalytics(false);
    }
  });
});

// Slide analytics filter pills (All / Top / Underperformers).
document.querySelectorAll('#slide-filter-pills .slide-filter-pill').forEach(function (pill) {
  pill.addEventListener('click', function () {
    document.querySelectorAll('#slide-filter-pills .slide-filter-pill').forEach(function (p) {
      p.classList.remove('active');
    });
    pill.classList.add('active');
    slideAnalyticsFilter = pill.getAttribute('data-filter') || 'all';
    if (slideAnalyticsCache) {
      renderSlideAnalytics(slideAnalyticsCache.rows);
    }
  });
});

// Product-type pills (Apparel | Footwear). On change, persist the
// choice and trigger a fresh loadAll, which will pick the right loader
// (apparel for now; footwear in Phase 3) and update the season
// dropdown to that type's seasons + last-viewed selection.
document.querySelectorAll('.product-pill').forEach(btn => {
  btn.addEventListener('click', function () {
    const type = this.dataset.product;
    if (type !== 'apparel' && type !== 'footwear') return;
    if (type === productType) return;
    productType = type;
    try { localStorage.setItem(LS_PRODUCT_KEY, type); } catch (e) { /* ignore */ }
    // Re-evaluate slide analytics tab visibility; productType is one
    // of its gates. If the user is on the slide tab and switches to
    // apparel, the helper bounces them back to Leaderboard.
    updateSlideAnalyticsTabVisibility();
    loadAll();
  });
});

// Season dropdown. Selection is per-product-type and remembered in
// localStorage so a refresh comes back to the same season the rep was
// last viewing.
const _seasonSelEl = document.getElementById('season-select');
if (_seasonSelEl) {
  _seasonSelEl.addEventListener('change', function () {
    const val = this.value;
    if (!val) return;
    currentSeason = val;
    try { localStorage.setItem(LS_SEASON_KEY(productType), val); } catch (e) { /* ignore */ }
    // Invalidate the slide analytics cache so the next visit refetches
    // for the newly-selected season.
    slideAnalyticsCache = null;
    loadAll();
  });
}

// Leaderboard view toggle
document.querySelectorAll('#leaderboard-view-toggle button').forEach(btn => {
  btn.addEventListener('click', function() {
    const view = this.dataset.view;
    setLeaderboardView(view);
  });
});

// Target admin toggle
document.getElementById('toggle-target-admin').addEventListener('click', toggleTargetPanel);

// Save targets button
document.getElementById('btn-save-targets').addEventListener('click', saveTargets);

// Top products metric toggle
document.querySelectorAll('#top-products-toggle button').forEach(btn => {
  btn.addEventListener('click', function() {
    const metric = this.dataset.metric;
    setTopMetric(metric);
  });
});

// Collection and group filter selects
document.getElementById('collection-filter').addEventListener('change', renderTopProducts);
document.getElementById('group-filter').addEventListener('change', renderTopProducts);

// Toggle prebook customers button
document.getElementById('toggle-prebook-customers').addEventListener('click', toggleIncludePrebook);

// Rep filter select
document.getElementById('rep-filter').addEventListener('change', renderOrders);

// Sortable table headers in orders table
document.querySelectorAll('#orders-table th.sortable').forEach(th => {
  th.addEventListener('click', function() {
    const col = this.dataset.sort;
    sortOrders(col);
  });
});

// ═══════════════════════════════════════════════
// EVENT DELEGATION (for dynamically generated rows)
// ═══════════════════════════════════════════════
document.addEventListener('click', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'toggleProductDetail') toggleProductDetail(el.dataset.sku, el);
  else if (action === 'toggleOrderDetail') toggleOrderDetail(el.dataset.key, el);
  else if (action === 'deleteDraft') deleteDraft(el.dataset.token);
});

// F07: Idle timeout - sign out after 30 minutes of inactivity
(function() {
  var IDLE_LIMIT = 30 * 60 * 1000;
  var idleTimer;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function() { handleSignOut(); }, IDLE_LIMIT);
  }
  ['mousemove','keydown','click','scroll','touchstart'].forEach(function(evt) {
    document.addEventListener(evt, resetIdle, { passive: true });
  });
  resetIdle();
})();

// Image error handlers (replaces inline onerror on thumbnails)
document.addEventListener('error', function(e) {
  if (e.target.tagName !== 'IMG') return;
  var fb = e.target.dataset.imgFallback;
  if (!fb) return;
  e.target.removeAttribute('data-img-fallback');
  if (fb === 'thumb') {
    thumbFallback(e.target);
  } else if (fb === 'thumb-hover') {
    // Try .png fallback
    if (e.target.src.endsWith('.jpg')) {
      e.target.src = e.target.src.replace('.jpg', '.png');
    }
  }
}, true);
