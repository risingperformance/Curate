// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const SUPA_URL = window.__SUPABASE_CONFIG.url;
const SUPA_KEY = window.__SUPABASE_CONFIG.key;
// Legacy JWT key removed Apr 2026 -- now using publishable key above
const supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);
// PIN login removed Apr 2026 -- now using Supabase Auth (email/password).
// Only salespeople with role = 'admin' are granted portal access.

// Table definitions — tells the portal the primary key and display config for each
const TABLES = {
  customers: {
    label: 'Customers',
    pk: 'account_code',
    orderBy: 'account_name',
    bulkOrderable: true,
  },
  products: {
    label: 'Products',
    pk: 'sku',          // semantic key: shown with 🔑, used for CSV upsert onConflict
    rowKey: 'id',       // unique row id: used for inline edit state tracking, save, delete
    orderBy: 'sku',
    bulkOrderable: true,
  },
  salespeople: {
    label: 'Salespeople',
    pk: null, // will be auto-detected
    orderBy: null,
    bulkOrderable: true,
  },
  collections: {
    label: 'Collections',
    pk: 'collection_id',
    orderBy: 'tab_order',
    bulkOrderable: true,
  },
  subsections: {
    label: 'Subsections',
    pk: 'subsection_id',
    orderBy: 'sort_order',
    bulkOrderable: true,
  },
  seasons: {
    label: 'Seasons',
    pk: 'season_id',
    orderBy: 'season_id',
    bulkOrderable: true,
  },
  // sales_targets is one physical table with a category column; the admin
  // surfaces it as two virtual sub-tabs (one filtered to apparel, one to
  // footwear). loadTable / saveChanges / deleteRow / commitCsvUpload all
  // honour cfg.physicalTable, cfg.filter, and cfg.defaults.
  sales_targets_apparel: {
    label: 'Sales Targets',
    physicalTable: 'sales_targets',
    pk: 'name,season,category',           // CSV upsert onConflict
    rowKey: ['name', 'season', 'category'],
    orderBy: 'name',
    bulkOrderable: true,
    filter:    { category: 'apparel' },
    defaults:  { category: 'apparel' },
    hiddenCols: ['category'],
  },
  sales_targets_footwear: {
    label: 'Sales Targets',
    physicalTable: 'sales_targets',
    pk: 'name,season,category',
    rowKey: ['name', 'season', 'category'],
    orderBy: 'name',
    bulkOrderable: true,
    filter:    { category: 'footwear' },
    defaults:  { category: 'footwear' },
    hiddenCols: ['category'],
  },
  program_rules: {
    label: 'Program Rules',
    pk: 'program_key',
    rowKey: 'id',
    orderBy: 'sort_order',
    bulkOrderable: true,
  },
  program_products: {
    label: 'Program Products',
    pk: 'program_key,sku',
    rowKey: 'id',
    orderBy: 'program_key,sort_order',
    bulkOrderable: true,
  },
};

const IMAGE_BUCKETS = [
  { id: 'product-images',  label: 'Product Images', icon: '👕' },
  { id: 'logos',           label: 'Logos',          icon: '🎨' },
  { id: 'seasonal-images', label: 'Seasonal Images', icon: '🌿' },
  { id: 'pos_images',      label: 'POS Images',     icon: '🛍️' },
];

// Top-level admin sections (introduced AW27 footwear, Section 2). Each
// section owns zero or more sub-tabs from the TABLES config above.
const SECTIONS = {
  customers: {
    label: 'Customers',
    defaultTab: 'customers',
    tabs: ['customers'],
  },
  apparel: {
    label: 'Apparel',
    defaultTab: 'products',
    tabs: ['products', 'collections', 'subsections', 'seasons',
           'sales_targets_apparel', 'program_rules', 'program_products'],
  },
  footwear: {
    label: 'Footwear',
    defaultTab: 'sales_targets_footwear',
    tabs: ['sales_targets_footwear', 'slides', 'questionnaire'],
  },
  settings: {
    label: 'Settings',
    defaultTab: 'salespeople',
    tabs: ['salespeople', 'images'],
  },
};

// Reverse lookup: which section does a given tab belong to?
const TAB_TO_SECTION = (() => {
  const m = {};
  for (const [section, cfg] of Object.entries(SECTIONS)) {
    for (const t of cfg.tabs) m[t] = section;
  }
  return m;
})();

// URL slug <-> internal tab key, scoped per section so the same slug can
// live under more than one section (e.g. 'sales-targets' under both
// /apparel and /footwear, 'products' likewise once Section 3 lands).
const TAB_SLUGS_BY_SECTION = {
  customers: { 'customers': 'customers' },
  apparel: {
    'products':         'products',
    'collections':      'collections',
    'subsections':      'subsections',
    'seasons':          'seasons',
    'sales-targets':    'sales_targets_apparel',
    'program-rules':    'program_rules',
    'program-products': 'program_products',
  },
  footwear: {
    'sales-targets':    'sales_targets_footwear',
    'slides':           'slides',
    'questionnaire':    'questionnaire',
  },
  settings: {
    'users':            'salespeople',
    'brand-assets':     'images',
  },
};

// Each tab key has exactly one display slug (used when we build URLs).
const TAB_KEY_TO_SLUG = (() => {
  const m = {};
  for (const slugs of Object.values(TAB_SLUGS_BY_SECTION)) {
    for (const [slug, key] of Object.entries(slugs)) {
      m[key] = slug;
    }
  }
  return m;
})();

// In-memory state
const state = {
  data: {},        // { customers: [...], products: [...], ... }
  columns: {},     // { customers: ['account_code', 'account_name', ...], ... }
  dirty: {},       // { tableName: { rowKey: { col: newValue } } }
  newRows: {},     // { tableName: [ {col: val} ] }
  activeSection: 'customers',
  activeTab: 'customers',
  lastTabBySection: {},  // remembers last visited sub-tab per section
  search: {},      // { tableName: searchString }
  sort: {},        // { tableName: { col: 'name', dir: 'asc' | 'desc' } | null }
  colWidths: {},   // { tableName: { col: pixels } }
  imageCounts: {}, // { 'product-images': 123, ... }
  activeBucket: 'product-images',
  bucketFiles: {}, // { bucketName: [fileList] }
};

// ═══════════════════════════════════════════════════════════════════════════════
// LOCAL PREFERENCE PERSISTENCE (sort + column widths)
// ═══════════════════════════════════════════════════════════════════════════════
const PREF_KEY = 'fj-admin-prefs-v1';
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw);
    if (prefs.sort) state.sort = prefs.sort;
    if (prefs.colWidths) state.colWidths = prefs.colWidths;
  } catch (e) { /* ignore corrupt prefs */ }
}
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      sort: state.sort,
      colWidths: state.colWidths,
    }));
  } catch (e) { /* ignore quota errors */ }
}
loadPrefs();

// ═══════════════════════════════════════════════════════════════════════════════
// SUPABASE AUTH LOGIN (admin-only)
// PIN-based login removed Apr 2026 -- now using Supabase Auth (email/password)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleLogin() {
  const emailEl = document.getElementById('login-email');
  const passEl  = document.getElementById('login-password');
  const errEl   = document.getElementById('login-error');
  const email   = emailEl.value.trim();
  const password = passEl.value;
  if (!email || !password) { errEl.textContent = 'Please enter email and password.'; return; }

  errEl.textContent = 'Signing in...';
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = error.message === 'Invalid login credentials'
      ? 'Incorrect email or password. Please try again.'
      : 'Sign-in failed. Please try again or contact support.';
    return;
  }
  // Verify user is a salesperson with admin role
  const { data: sp } = await supa.from('salespeople').select('name, role, email').eq('email', email).single();
  if (!sp) {
    errEl.textContent = 'Account not linked to a salesperson. Contact your admin.';
    await supa.auth.signOut();
    return;
  }
  if (sp.role !== 'admin') {
    errEl.textContent = 'This account does not have admin access.';
    await supa.auth.signOut();
    return;
  }
  unlockAdmin();
}

async function handleSignOut() {
  await supa.auth.signOut();
  window.location.reload();
}

function unlockAdmin() {
  document.getElementById('login-screen').classList.add('unlocked');
  setTimeout(() => {
    document.getElementById('login-screen').style.display = 'none';
    init();
  }, 500);
}

// Check for existing session on page load
(async function() {
  const { data: { session } } = await supa.auth.getSession();
  if (session) {
    const { data: sp } = await supa.from('salespeople').select('name, role, email').eq('email', session.user.email).single();
    if (sp && sp.role === 'admin') {
      unlockAdmin();
      return;
    }
    // Not admin or not a salesperson -- sign out and show login
    await supa.auth.signOut();
  }
  // No session -- show login, focus email field
  document.getElementById('login-email').focus();

  // Enter key submits form
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('login-email').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-password').focus();
  });

  // Forgot password
  document.getElementById('login-forgot').addEventListener('click', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    const email = document.getElementById('login-email').value.trim();
    if (!email) { errEl.textContent = 'Enter your email address, then tap Forgot password.'; return; }
    errEl.textContent = 'Sending reset link...';
    const { error } = await supa.auth.resetPasswordForEmail(email);
    if (error) { errEl.textContent = 'Could not send reset link. Please check your email and try again.'; }
    else { errEl.textContent = 'Password reset email sent. Check your inbox.'; }
  });
})();

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  setupImageTab();
  await setupTabs();
}

// Wires the section + sub-tab buttons, restores section/tab from the URL,
// and sets up popstate handling for browser back/forward.
async function setupTabs() {
  document.querySelectorAll('.section-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activateSection(btn.dataset.section);
    });
  });

  document.querySelectorAll('.subtab-bar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab);
    });
  });

  window.addEventListener('popstate', () => {
    const loc = parseLocation();
    activateSection(loc.section, { skipUrl: true, initialTab: loc.tab });
  });

  const initial = parseLocation();
  await activateSection(initial.section, { skipUrl: true, initialTab: initial.tab });
}

// Switch top-level section. Activates the section's preferred sub-tab
// (caller-provided initialTab > last-visited > section default).
async function activateSection(section, opts = {}) {
  const cfg = SECTIONS[section];
  if (!cfg) return;

  document.querySelectorAll('.section-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.section === section);
  });
  document.querySelectorAll('.subtab-bar').forEach(bar => {
    bar.hidden = bar.dataset.section !== section;
  });
  state.activeSection = section;

  let targetTab = opts.initialTab;
  if (!targetTab || TAB_TO_SECTION[targetTab] !== section) {
    targetTab = state.lastTabBySection[section] || cfg.defaultTab;
  }
  await activateTab(targetTab, { skipUrl: opts.skipUrl });
}

// Switch sub-tab (and panel). If the tab belongs to a different section,
// switch sections first.
async function activateTab(tab, opts = {}) {
  const section = TAB_TO_SECTION[tab];
  if (!section) return;

  if (section !== state.activeSection) {
    return activateSection(section, { skipUrl: opts.skipUrl, initialTab: tab });
  }

  document.querySelectorAll('.subtab-bar .tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panelEl = document.getElementById(`panel-${tab}`);
  if (panelEl) panelEl.classList.add('active');

  state.activeTab = tab;
  state.lastTabBySection[section] = tab;

  if (!opts.skipUrl) updateLocation();

  if (tab === 'images') {
    loadBucketFiles(state.activeBucket);
  } else if (TABLES[tab]) {
    if (!state.data[tab]) await loadTable(tab);
    renderTable(tab);
  } else if (window.curateFootwear && typeof window.curateFootwear[tab] === 'function') {
    // Tabs that aren't backed by the generic data grid (questionnaire,
    // slides, etc.) register a renderer on window.curateFootwear[tab] from
    // admin-footwear.js. Each renderer is responsible for filling its
    // panel-${tab} div.
    await window.curateFootwear[tab]();
  }
}

function refreshActiveTab() {
  const tab = state.activeTab;
  if (tab === 'images') {
    loadBucketFiles(state.activeBucket);
  } else if (TABLES[tab]) {
    loadTable(tab).then(() => renderTable(tab));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// URL ROUTING
// Path form (preferred, requires _redirects):
//   /admin                       -> Customers
//   /admin/customers             -> Customers
//   /admin/apparel               -> Apparel default sub-tab
//   /admin/apparel/products      -> Apparel > Products
//   /admin/footwear              -> Footwear placeholder
//   /admin/settings/users        -> Settings > Users
// Hash form (fallback when loaded as /admin.html):
//   admin.html#apparel/products
// ═══════════════════════════════════════════════════════════════════════════════

function parseLocation() {
  const path = window.location.pathname.replace(/\/$/, '');
  const m = /^\/admin(?:\/([^\/]+))?(?:\/([^\/]+))?$/.exec(path);
  if (m) {
    const section = (m[1] === undefined) ? 'customers'
                  : SECTIONS[m[1]] ? m[1] : null;
    if (section) {
      const slugMap = TAB_SLUGS_BY_SECTION[section] || {};
      const tab = m[2] && slugMap[m[2]] ? slugMap[m[2]] : null;
      return { section, tab };
    }
  }

  const hash = window.location.hash.replace(/^#/, '');
  if (hash) {
    const [hs, hsub] = hash.split('/');
    if (SECTIONS[hs]) {
      const slugMap = TAB_SLUGS_BY_SECTION[hs] || {};
      const tab = hsub && slugMap[hsub] ? slugMap[hsub] : null;
      return { section: hs, tab };
    }
  }

  return { section: 'customers', tab: 'customers' };
}

function updateLocation() {
  const section = state.activeSection;
  const tab = state.activeTab;
  const cfg = SECTIONS[section];
  const tabSlug = TAB_KEY_TO_SLUG[tab];
  const showsSubInUrl = tab && tab !== cfg.defaultTab && tabSlug;

  const isPathMode = /^\/admin(?:\/|$)/.test(window.location.pathname);
  let nextUrl;
  if (isPathMode) {
    nextUrl = `/admin/${section}` + (showsSubInUrl ? `/${tabSlug}` : '');
    if (window.location.pathname === nextUrl) return;
  } else {
    const hash = `#${section}` + (showsSubInUrl ? `/${tabSlug}` : '');
    nextUrl = window.location.pathname + window.location.search + hash;
    if (window.location.hash === hash) return;
  }

  try {
    history.pushState(null, '', nextUrl);
  } catch (e) {
    // pushState may refuse cross-origin URLs. Fail open: drop the URL
    // update rather than throw inside a click handler.
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════════

async function loadTable(tableName) {
  const cfg = TABLES[tableName];
  const physicalTable = cfg.physicalTable || tableName;
  let query = supa.from(physicalTable).select('*');
  if (cfg.filter) {
    for (const [col, val] of Object.entries(cfg.filter)) {
      query = query.eq(col, val);
    }
  }
  if (cfg.orderBy) query = query.order(cfg.orderBy, { ascending: true });
  const { data, error } = await query;
  if (error) {
    toast('Error loading ' + cfg.label + '. Please refresh and try again.', 'error');
    return;
  }
  state.data[tableName] = data || [];
  state.dirty[tableName] = {};
  state.newRows[tableName] = [];
  // Detect columns from first row, fall back to empty
  if (data && data.length > 0) {
    state.columns[tableName] = Object.keys(data[0]);
    // Auto-detect PK if not set
    if (!cfg.pk) {
      const firstCol = state.columns[tableName][0];
      cfg.pk = firstCol;
    }
    // Build column type map by scanning all rows (so null cells inherit type from siblings)
    const typeMap = {};
    for (const col of state.columns[tableName]) {
      for (const row of data) {
        const v = row[col];
        if (v === null || v === undefined) continue;
        if (typeof v === 'boolean') { typeMap[col] = 'bool'; break; }
        if (typeof v === 'object') { typeMap[col] = 'json'; break; }
        if (typeof v === 'number') { typeMap[col] = 'number'; break; }
        typeMap[col] = 'string'; break;
      }
    }
    if (!state.colTypes) state.colTypes = {};
    state.colTypes[tableName] = typeMap;
  } else {
    state.columns[tableName] = [];
  }
  document.getElementById('last-updated').textContent =
    'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function renderTable(tableName) {
  const cfg = TABLES[tableName];
  const panel = document.getElementById(`panel-${tableName}`);
  const rows = state.data[tableName] || [];
  // state.columns keeps the full column list so addNewRow / saveChanges
  // know about audit columns like 'category'. The visible col list filters
  // out cfg.hiddenCols so the user does not see or have to set the column
  // that is auto-applied by the sub-tab's filter/defaults.
  const allCols = state.columns[tableName] || [];
  const hidden = new Set(cfg.hiddenCols || []);
  const cols = allCols.filter(c => !hidden.has(c));
  const searchTerm = (state.search[tableName] || '').toLowerCase();
  const newRowCount = (state.newRows[tableName] || []).length;
  const dirtyCount = Object.keys(state.dirty[tableName] || {}).length;
  const pendingCount = newRowCount + dirtyCount;

  // Preserve scroll positions across the full innerHTML replace. Without this,
  // toggling a checkbox (or any cell edit) re-renders and jumps the viewport
  // back to the top, forcing the user to scroll to find the row they just edited.
  const prevGridWrap = panel.querySelector('.grid-wrap');
  const prevGridScrollTop = prevGridWrap ? prevGridWrap.scrollTop : 0;
  const prevGridScrollLeft = prevGridWrap ? prevGridWrap.scrollLeft : 0;
  const prevWindowScrollY = window.scrollY;
  const prevWindowScrollX = window.scrollX;

  // Filter rows by search
  const filtered = searchTerm
    ? rows.filter(r => Object.values(r).some(v =>
        v !== null && String(v).toLowerCase().includes(searchTerm)))
    : rows.slice();

  // Apply user-selected sort (header click). Falls back to DB order (cfg.orderBy) when unset.
  const sortState = state.sort[tableName];
  if (sortState && sortState.col) {
    const { col, dir } = sortState;
    const mult = dir === 'desc' ? -1 : 1;
    filtered.sort((a, b) => compareVals(a[col], b[col]) * mult);
  }

  panel.innerHTML = `
    <div class="section-title">${cfg.label}</div>
    <div class="section-sub">
      Edit rows inline, add new rows, or upload a CSV to bulk-update. Primary key: <b>${cfg.pk || '(auto)'}</b>
    </div>

    <div class="toolbar">
      <input type="text" class="search-box" placeholder="Search..." id="search-${tableName}"
             value="${escapeAttr(state.search[tableName] || '')}">
      <button class="btn btn-outline" data-action="addNewRow" data-table="${tableName}">+ Add Row</button>
      <label class="btn btn-outline" style="cursor:pointer;margin:0;">
        📥 Upload CSV
        <input type="file" accept=".csv" style="display:none" data-action="csvUpload" data-table="${tableName}">
      </label>
      <button class="btn btn-outline" data-action="downloadCsv" data-table="${tableName}">📤 Download CSV</button>
      <button class="btn btn-primary" data-action="saveChanges" data-table="${tableName}" ${pendingCount === 0 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
        Save ${pendingCount > 0 ? `(${pendingCount})` : ''}
      </button>
      <span class="row-count">
        ${filtered.length} of ${rows.length} rows
        ${pendingCount > 0 ? `<span class="status-pill status-info" style="margin-left:8px;">${pendingCount} unsaved</span>` : ''}
      </span>
    </div>

    ${cols.length === 0 ? `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <div>Table is empty. Add a row or upload a CSV.</div>
      </div>
    ` : `
      <div class="grid-wrap">
        <table class="data-grid">
          <thead>
            <tr>
              ${(() => {
                const pkSet = new Set(getPkCols(cfg));
                const widths = state.colWidths[tableName] || {};
                const activeSort = state.sort[tableName] || {};
                return cols.map(c => {
                  const isPk = pkSet.has(c);
                  const width = widths[c];
                  const styleAttr = width ? `style="width:${width}px;min-width:${width}px;max-width:${width}px;"` : '';
                  const sorted = activeSort.col === c;
                  const arrow = sorted
                    ? `<span class="sort-arrow">${activeSort.dir === 'desc' ? '▼' : '▲'}</span>`
                    : `<span class="sort-arrow inactive">⇅</span>`;
                  return `<th class="${isPk ? 'pk ' : ''}sortable" data-col="${escapeAttr(c)}" ${styleAttr}
                            data-action="toggleSort" data-table="${tableName}" data-col="${escapeAttr(c)}">
                    ${c}${isPk ? ' 🔑' : ''}${arrow}
                    <div class="col-resizer" data-col="${escapeAttr(c)}" data-table="${tableName}"
                         data-action="colResize"></div>
                  </th>`;
                }).join('');
              })()}
              <th class="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${(state.newRows[tableName] || []).map((row, idx) => renderNewRow(tableName, row, idx, cols)).join('')}
            ${filtered.map(row => renderRow(tableName, row, cols, cfg.pk)).join('')}
          </tbody>
        </table>
      </div>
    `}
  `;

  // Restore scroll positions that were captured before the innerHTML replace.
  const newGridWrap = panel.querySelector('.grid-wrap');
  if (newGridWrap) {
    newGridWrap.scrollTop = prevGridScrollTop;
    newGridWrap.scrollLeft = prevGridScrollLeft;
  }
  window.scrollTo(prevWindowScrollX, prevWindowScrollY);

  // Wire up search
  const searchEl = document.getElementById(`search-${tableName}`);
  if (searchEl) {
    searchEl.addEventListener('input', e => {
      state.search[tableName] = e.target.value;
      renderTable(tableName);
      // Restore focus & cursor
      const newSearch = document.getElementById(`search-${tableName}`);
      if (newSearch) {
        newSearch.focus();
        newSearch.setSelectionRange(newSearch.value.length, newSearch.value.length);
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROW KEY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
// Supports three shapes for cfg.rowKey / cfg.pk:
//   - undefined: fall back to cfg.pk
//   - string (e.g. 'id'): single-column row key
//   - string[] (e.g. ['name','season']): composite row key, joined with '|' (null-safe)

function getRowKeyCols(cfg) {
  const rk = cfg.rowKey || cfg.pk;
  if (!rk) return [];
  if (Array.isArray(rk)) return rk;
  // Accept comma-separated composite strings (e.g. 'name,season').
  return rk.includes(',') ? rk.split(',').map(s => s.trim()) : [rk];
}

function getPkCols(cfg) {
  const pk = cfg.pk;
  if (!pk) return [];
  if (Array.isArray(pk)) return pk;
  return pk.includes(',') ? pk.split(',').map(s => s.trim()) : [pk];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SORT & COLUMN RESIZE
// ═══════════════════════════════════════════════════════════════════════════════

// Cell value comparator: nulls sink, numbers numeric, strings case-insensitive.
function compareVals(a, b) {
  const aNull = a === null || a === undefined || a === '';
  const bNull = b === null || b === undefined || b === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;   // nulls always at bottom
  if (bNull) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a === b) ? 0 : (a ? -1 : 1);
  // Try numeric string comparison
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na - nb;
  return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
}

// Click header: cycle sort asc → desc → off
function toggleSort(tableName, col, ev) {
  // Ignore clicks that originated on the resizer handle
  if (ev && ev.target && ev.target.classList && ev.target.classList.contains('col-resizer')) return;
  const cur = state.sort[tableName];
  let next;
  if (!cur || cur.col !== col) next = { col, dir: 'asc' };
  else if (cur.dir === 'asc') next = { col, dir: 'desc' };
  else next = null; // third click clears sort (back to DB order)
  if (next) state.sort[tableName] = next;
  else delete state.sort[tableName];
  savePrefs();
  renderTable(tableName);
}

// Drag a column resizer. Pointer events capture drag reliably even outside the <th>.
function startColResize(ev, tableName, col) {
  ev.preventDefault();
  ev.stopPropagation();
  const th = ev.currentTarget.closest('th');
  if (!th) return;
  const startX = ev.clientX;
  const startWidth = th.getBoundingClientRect().width;
  const handle = ev.currentTarget;
  handle.classList.add('active');
  document.body.classList.add('col-resizing');

  function onMove(e) {
    const delta = e.clientX - startX;
    const newWidth = Math.max(40, Math.round(startWidth + delta));
    th.style.width = newWidth + 'px';
    th.style.minWidth = newWidth + 'px';
    th.style.maxWidth = newWidth + 'px';
    if (!state.colWidths[tableName]) state.colWidths[tableName] = {};
    state.colWidths[tableName][col] = newWidth;
  }
  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    handle.classList.remove('active');
    document.body.classList.remove('col-resizing');
    savePrefs();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function computeRowKey(row, cfg) {
  return getRowKeyCols(cfg).map(c => String(row[c] == null ? '' : row[c])).join('|');
}

function findRowByKey(rows, rowKey, cfg) {
  return (rows || []).find(r => computeRowKey(r, cfg) === rowKey);
}

function isRowKeyCol(col, cfg) {
  return getRowKeyCols(cfg).includes(col);
}

function renderRow(tableName, row, cols, pkCol) {
  const cfg = TABLES[tableName];
  const rowKey = computeRowKey(row, cfg);
  const rowDirty = (state.dirty[tableName] || {})[rowKey] || {};
  const isDirty = Object.keys(rowDirty).length > 0;
  const pkSet = new Set(getPkCols(cfg));

  return `
    <tr data-pk="${escapeAttr(rowKey)}" class="${isDirty ? 'editing' : ''}">
      ${cols.map(c => {
        const origVal = row[c];
        const dirtyVal = rowDirty[c];
        const currentVal = c in rowDirty ? dirtyVal : origVal;
        const isPk = pkSet.has(c);
        const isReadOnly = isPk || isRowKeyCol(c, cfg);
        return `<td>${renderCell(tableName, rowKey, c, currentVal, isReadOnly, false, isPk)}</td>`;
      }).join('')}
      <td class="actions-col">
        ${isDirty ? `<button class="btn btn-outline btn-sm" data-action="revertRow" data-table="${tableName}" data-key="${escapeAttr(escapeJs(rowKey))}">↺ Revert</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="deleteRowConfirm" data-table="${tableName}" data-key="${escapeAttr(escapeJs(rowKey))}">🗑</button>
      </td>
    </tr>
  `;
}

function renderNewRow(tableName, row, idx, cols) {
  return `
    <tr data-new-idx="${idx}" class="new-row">
      ${cols.map(c => `<td>${renderCell(tableName, `__new_${idx}`, c, row[c] || '', false, true)}</td>`).join('')}
      <td class="actions-col">
        <button class="btn btn-outline btn-sm" data-action="removeNewRow" data-table="${tableName}" data-idx="${idx}">✕ Cancel</button>
      </td>
    </tr>
  `;
}

function renderCell(tableName, rowKey, col, value, isReadOnly, isNewRow, isPk) {
  // Back-compat: if caller only passed isPk (5 args), treat it as isReadOnly
  if (isPk === undefined) isPk = isReadOnly;
  // Handle nulls
  const displayVal = value === null || value === undefined ? '' : value;

  // For read-only columns (pk and/or rowKey) of existing rows, render as plain text
  if (isReadOnly && !isNewRow) {
    return `<span class="cell-truncate" title="${escapeAttr(String(displayVal))}">${escapeHtml(String(displayVal))}</span>`;
  }

  // Detect type from column type map (scanned across all rows), falling back to value-based detection
  const colType = ((state.colTypes || {})[tableName] || {})[col];
  const isBool = colType === 'bool' || (colType === undefined && typeof value === 'boolean');
  const isJson = colType === 'json' || (colType === undefined && value !== null && typeof value === 'object');
  const isNum = colType === 'number' || (colType === undefined && typeof value === 'number');

  if (isBool) {
    const checked = value === true || value === 'true';
    return `<input type="checkbox" class="cell-input bool" ${checked ? 'checked' : ''}
      data-action="updateCell" data-table="${escapeAttr(tableName)}" data-row-key="${escapeAttr(rowKey)}" data-col="${escapeAttr(col)}" data-new-row="${isNewRow}" data-cell-type="bool">`;
  }

  if (isJson) {
    const jsonStr = (value === null || value === undefined) ? '' : (typeof value === 'string' ? value : JSON.stringify(value));
    return `<input type="text" class="cell-input" value="${escapeAttr(jsonStr)}"
      title="JSON value"
      data-action="updateCell" data-table="${escapeAttr(tableName)}" data-row-key="${escapeAttr(rowKey)}" data-col="${escapeAttr(col)}" data-new-row="${isNewRow}" data-cell-type="json">`;
  }

  if (isNum) {
    return `<input type="number" step="any" class="cell-input num" value="${escapeAttr(String(displayVal))}"
      data-action="updateCell" data-table="${escapeAttr(tableName)}" data-row-key="${escapeAttr(rowKey)}" data-col="${escapeAttr(col)}" data-new-row="${isNewRow}" data-cell-type="number">`;
  }

  // String
  return `<input type="text" class="cell-input" value="${escapeAttr(String(displayVal))}"
    data-action="updateCell" data-table="${escapeAttr(tableName)}" data-row-key="${escapeAttr(rowKey)}" data-col="${escapeAttr(col)}" data-new-row="${isNewRow}" data-cell-type="string">`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CELL EDITING
// ═══════════════════════════════════════════════════════════════════════════════

function updateCell(tableName, rowKey, col, value, isNewRow, type) {
  // Type coercion
  if (type === 'number') {
    value = value === '' ? null : Number(value);
  } else if (type === 'json') {
    if (value === '' || value === null || value === undefined) { value = null; }
    else { try { value = JSON.parse(value); } catch { toast('Invalid JSON', 'error'); return; } }
  }

  if (isNewRow) {
    const idx = parseInt(rowKey.replace('__new_', ''));
    state.newRows[tableName][idx][col] = value;
  } else {
    if (!state.dirty[tableName]) state.dirty[tableName] = {};
    if (!state.dirty[tableName][rowKey]) state.dirty[tableName][rowKey] = {};

    // Check if it's actually different from original
    const cfgCell = TABLES[tableName];
    const origRow = findRowByKey(state.data[tableName], rowKey, cfgCell);
    if (origRow && JSON.stringify(origRow[col]) === JSON.stringify(value)) {
      delete state.dirty[tableName][rowKey][col];
      if (Object.keys(state.dirty[tableName][rowKey]).length === 0) {
        delete state.dirty[tableName][rowKey];
      }
    } else {
      state.dirty[tableName][rowKey][col] = value;
    }
  }
  // Re-render to update status indicators (but not cell values to preserve focus)
  updateToolbarCounts(tableName);
}

function updateToolbarCounts(tableName) {
  renderTable(tableName);
}

function revertRow(tableName, rowKey) {
  delete state.dirty[tableName][rowKey];
  renderTable(tableName);
  toast('Changes reverted', 'info');
}

function addNewRow(tableName) {
  if (!state.newRows[tableName]) state.newRows[tableName] = [];
  const cfg = TABLES[tableName];
  const cols = state.columns[tableName];
  const blank = {};
  cols.forEach(c => blank[c] = '');
  // Pre-fill cfg.defaults so virtual sub-tabs (e.g. sales_targets_apparel)
  // start with the right category set. The user does not see the hidden
  // column but the value is in state and travels through saveChanges.
  if (cfg.defaults) Object.assign(blank, cfg.defaults);
  state.newRows[tableName].push(blank);
  renderTable(tableName);
  toast('Fill in the highlighted row, then click Save', 'info');
}

function removeNewRow(tableName, idx) {
  state.newRows[tableName].splice(idx, 1);
  renderTable(tableName);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAVE CHANGES
// ═══════════════════════════════════════════════════════════════════════════════

async function saveChanges(tableName) {
  const cfg = TABLES[tableName];
  const dirtyRows = state.dirty[tableName] || {};
  const newRows = (state.newRows[tableName] || []).filter(r =>
    Object.values(r).some(v => v !== '' && v !== null && v !== undefined));

  const updates = [];
  const inserts = [];

  // Build update payloads (merged with original)
  for (const [rowKey, changes] of Object.entries(dirtyRows)) {
    const origRow = findRowByKey(state.data[tableName], rowKey, cfg);
    if (origRow) {
      updates.push({ ...origRow, ...changes });
    }
  }

  // Clean new rows: convert empty strings to null, and omit id/created_at if blank
  // so the database defaults (gen_random_uuid / now()) auto-populate them
  // Auto-convert 'sizes' column: comma-separated values become a JSON array
  const autoFieldsSave = ['id', 'created_at'];
  for (const row of newRows) {
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      if (autoFieldsSave.includes(k) && (!v || v === '')) continue;
      if (k === 'sizes' && v && typeof v === 'string' && !v.startsWith('[')) {
        clean[k] = JSON.stringify(v.split(',').map(s => s.trim()));
        continue;
      }
      clean[k] = v === '' ? null : v;
    }
    inserts.push(clean);
  }

  if (updates.length === 0 && inserts.length === 0) {
    toast('Nothing to save', 'info');
    return;
  }

  toast(`Saving ${updates.length + inserts.length} row(s)...`, 'info');

  // Updates go via rowKey (unique row id) so we only touch the edited row even
  // when the semantic pk (e.g. sku) is shared. Inserts go via pk so new rows
  // let the DB generate the rowKey (e.g. uuid id).
  const rowKeyCols = getRowKeyCols(cfg);
  const rowKeyConflict = rowKeyCols.join(','); // Supabase accepts comma-separated composite keys
  const physicalTable = cfg.physicalTable || tableName;

  // Apply cfg.defaults (e.g. category=apparel for the apparel sales-targets
  // sub-tab) to any insert that does not explicitly provide them. This keeps
  // virtual-table sub-tabs from accidentally writing rows that violate NOT
  // NULL or land outside the filter.
  if (cfg.defaults) {
    for (const row of inserts) {
      for (const [k, v] of Object.entries(cfg.defaults)) {
        if (row[k] === undefined || row[k] === null || row[k] === '') row[k] = v;
      }
    }
    // Also defend updates: if the updated row dropped the filter column,
    // restore it to the configured default rather than write a row that
    // would disappear from this view.
    for (const row of updates) {
      for (const [k, v] of Object.entries(cfg.defaults)) {
        if (row[k] === undefined || row[k] === null || row[k] === '') row[k] = v;
      }
    }
  }

  let saveError = null;
  if (updates.length > 0) {
    const { error } = await supa.from(physicalTable).upsert(updates, { onConflict: rowKeyConflict });
    if (error) saveError = error;
  }
  if (!saveError && inserts.length > 0) {
    const { error } = await supa.from(physicalTable).upsert(inserts, { onConflict: cfg.pk });
    if (error) saveError = error;
  }
  const error = saveError;
  const all = [...updates, ...inserts];

  if (error) {
    toast('Save failed. Please try again.', 'error');
    return;
  }

  toast(`Saved ${all.length} row(s)`, 'success');
  state.dirty[tableName] = {};
  state.newRows[tableName] = [];
  await loadTable(tableName);
  renderTable(tableName);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE ROW
// ═══════════════════════════════════════════════════════════════════════════════

function deleteRowConfirm(tableName, rowKey) {
  const cfg = TABLES[tableName];
  // Show the semantic pk value (e.g. sku) in the prompt, not the internal rowKey (e.g. uuid)
  const row = findRowByKey(state.data[tableName], rowKey, cfg);
  let label = rowKey;
  if (row) {
    const pkCols = typeof cfg.pk === 'string' && cfg.pk.includes(',') ? cfg.pk.split(',') : [cfg.pk];
    label = pkCols.map(c => String(row[c] == null ? '' : row[c])).join(' / ');
  }
  openModal(`
    <h3>Delete row?</h3>
    <p>Are you sure you want to delete <b>${escapeHtml(label)}</b> from <b>${cfg.label}</b>? This cannot be undone.</p>
    <div class="modal-actions">
      <button class="btn btn-outline" data-action="closeModal">Cancel</button>
      <button class="btn btn-danger" data-action="deleteRow" data-table="${tableName}" data-key="${escapeAttr(escapeJs(rowKey))}">Delete</button>
    </div>
  `);
}

async function deleteRow(tableName, rowKey) {
  const cfg = TABLES[tableName];
  const row = findRowByKey(state.data[tableName], rowKey, cfg);
  if (!row) {
    closeModal();
    toast('Row not found (may have been reloaded)', 'error');
    return;
  }
  // Delete by matching every row-key column, so composite keys (e.g. name+season) work.
  const physicalTable = cfg.physicalTable || tableName;
  let query = supa.from(physicalTable).delete();
  for (const col of getRowKeyCols(cfg)) {
    query = query.eq(col, row[col]);
  }
  const { error } = await query;
  closeModal();
  if (error) {
    toast('Delete failed. Please try again.', 'error');
    return;
  }
  toast('Row deleted', 'success');
  await loadTable(tableName);
  renderTable(tableName);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSV UPLOAD / DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════════════

function handleCsvUpload(event, tableName) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = ''; // reset for re-upload

  // F24: File size limit (5 MB)
  const MAX_CSV_SIZE = 5 * 1024 * 1024;
  if (file.size > MAX_CSV_SIZE) {
    toast('CSV file exceeds 5 MB limit. Please split into smaller files.', 'error');
    return;
  }

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false, // we'll coerce ourselves
    complete: function(results) {
      if (results.errors.length > 0) {
        toast('CSV parse error. Please check the file format and try again.', 'error');
        return;
      }
      reviewCsvUpload(tableName, results.data, results.meta.fields);
    }
  });
}

function reviewCsvUpload(tableName, rows, csvCols) {
  const cfg = TABLES[tableName];
  const tableCols = state.columns[tableName];
  const missing = tableCols.filter(c => !csvCols.includes(c));
  const extra = csvCols.filter(c => !tableCols.includes(c));
  const pkCols = getPkCols(cfg);
  const missingPkCols = pkCols.filter(c => !csvCols.includes(c));
  const pkPresent = missingPkCols.length === 0;
  const pkDisplay = pkCols.join(', ');

  openModal(`
    <h3>Review CSV Upload</h3>
    <p>Uploading <b>${rows.length}</b> row(s) to <b>${cfg.label}</b>. This will upsert: matching rows (by <b>${pkDisplay}</b>) will be updated, new rows will be inserted.</p>

    ${!pkPresent ? `
      <div class="status-pill status-err" style="display:block;padding:10px;margin-bottom:12px;">
        ⚠️ Primary key column${missingPkCols.length > 1 ? 's' : ''} <b>${missingPkCols.join(', ')}</b> not found in CSV. Upload cannot proceed.
      </div>
    ` : ''}

    ${extra.length > 0 ? `
      <div class="status-pill status-err" style="display:block;padding:10px;margin-bottom:12px;">
        ⚠️ Columns in CSV not in table (will cause error): <b>${extra.join(', ')}</b>
      </div>
    ` : ''}

    ${missing.length > 0 ? `
      <div class="status-pill status-info" style="display:block;padding:10px;margin-bottom:12px;">
        ℹ️ Columns in table not in CSV (will keep existing values on update, be null on insert): ${missing.join(', ')}
      </div>
    ` : ''}

    <div style="font-size:12px;color:var(--mid);margin-bottom:12px;">
      Preview (first 3 rows):
    </div>
    <div style="max-height:180px;overflow:auto;background:var(--bg);padding:10px;border-radius:6px;font-family:monospace;font-size:11px;">
      ${rows.slice(0, 3).map(r => JSON.stringify(r)).join('<br><br>')}
    </div>

    <div class="modal-actions">
      <button class="btn btn-outline" data-action="closeModal">Cancel</button>
      <button class="btn btn-primary" data-action="commitCsvUpload" data-table="${tableName}" ${(!pkPresent || extra.length > 0) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
        Upsert ${rows.length} Row${rows.length === 1 ? '' : 's'}
      </button>
    </div>
  `);

  state._pendingCsv = { tableName, rows };
}

async function commitCsvUpload(tableName) {
  const pending = state._pendingCsv;
  if (!pending || pending.tableName !== tableName) return;
  const cfg = TABLES[tableName];

  // F24: Sanitise CSV values - strip leading formula injection characters (=, +, -, @, tab, CR)
  function sanitiseCsvValue(val) {
    if (typeof val !== 'string') return val;
    return val.replace(/^[\t\r\n]*[=+\-@]+/, function(m) { return m.replace(/[=+\-@]/g, ''); });
  }

  // Clean empty strings to null; omit id and created_at if blank so DB defaults apply
  // Auto-convert 'sizes' column: comma-separated values become a JSON array
  const autoFields = ['id', 'created_at'];
  const clean = pending.rows.map(r => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (autoFields.includes(k) && (!v || v === '')) continue;
      if (k === 'sizes' && v && typeof v === 'string' && !v.startsWith('[')) {
        out[k] = JSON.stringify(v.split(',').map(s => s.trim()));
        continue;
      }
      const sanitised = sanitiseCsvValue(v);
      out[k] = sanitised === '' ? null : sanitised;
    }
    // Backfill cfg.defaults (e.g. category=apparel) for rows whose CSV did
    // not include the column. Lets the user upload a CSV that omits the
    // category column and trust the active sub-tab to set it.
    if (cfg.defaults) {
      for (const [k, v] of Object.entries(cfg.defaults)) {
        if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
      }
    }
    return out;
  });

  closeModal();
  toast(`Upserting ${clean.length} rows...`, 'info');

  // Chunk to avoid payload limits (1000 per batch)
  const physicalTable = cfg.physicalTable || tableName;
  const chunkSize = 500;
  let upserted = 0;
  for (let i = 0; i < clean.length; i += chunkSize) {
    const chunk = clean.slice(i, i + chunkSize);
    const { error } = await supa.from(physicalTable).upsert(chunk, { onConflict: cfg.pk });
    if (error) {
      toast(`Upsert failed at row ${i}. Please check your data and try again.`, 'error');
      return;
    }
    upserted += chunk.length;
  }

  toast(`Upserted ${upserted} rows`, 'success');
  delete state._pendingCsv;
  await loadTable(tableName);
  renderTable(tableName);
}

function downloadCsv(tableName) {
  const rows = state.data[tableName] || [];
  if (rows.length === 0) { toast('No data to export', 'error'); return; }
  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${tableName}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV downloaded', 'success');
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

function setupImageTab() {
  const panel = document.getElementById('panel-images');
  panel.innerHTML = `
    <div class="section-title">Image Library</div>
    <div class="section-sub">
      Browse and manage images in Supabase Storage. Uploading will overwrite files with the same name.
    </div>

    <div class="bucket-selector" id="bucket-selector">
      ${IMAGE_BUCKETS.map(b => `
        <button class="bucket-btn ${b.id === state.activeBucket ? 'active' : ''}" data-bucket="${b.id}">
          <span>${b.icon}</span>
          <span>${b.label}</span>
          <span class="bucket-btn-count" id="bucket-count-${b.id}">...</span>
        </button>
      `).join('')}
    </div>

    <div class="dropzone" id="image-dropzone">
      <div class="dropzone-title">⬇ Drag &amp; drop images or a whole folder here</div>
      <div class="dropzone-sub">
        Files are uploaded to the <b id="dropzone-bucket-label">${state.activeBucket}</b> bucket.
        Folders are walked recursively — only filenames are preserved (paths are flattened).
      </div>
      <label class="btn btn-gold" style="cursor:pointer;margin:0;">
        ⬆ Or choose files
        <input type="file" id="image-file-input" accept="image/*" multiple style="display:none" data-action="imageInputChange">
      </label>
    </div>

    <div class="toolbar">
      <input type="text" class="search-box" placeholder="Filter files by name..." id="image-search">
      <button class="btn btn-outline" id="btn-refresh-images" data-action="refreshBucketFiles">↻ Refresh</button>
      <span class="row-count" id="image-count"></span>
    </div>

    <div id="image-container"></div>
  `;

  document.querySelectorAll('.bucket-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeBucket = btn.dataset.bucket;
      document.querySelectorAll('.bucket-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const label = document.getElementById('dropzone-bucket-label');
      if (label) label.textContent = state.activeBucket;
      loadBucketFiles(state.activeBucket);
    });
  });

  document.getElementById('image-search').addEventListener('input', e => {
    renderBucketFiles(state.activeBucket, e.target.value);
  });

  // ── Drag & drop wiring ──
  const dropzone = document.getElementById('image-dropzone');
  let dragCounter = 0; // track nested enter/leave events reliably

  // Global document-level handlers: prevent the browser's default "navigate to
  // dropped file" behavior on drops that miss the dropzone. Without these, a
  // slightly-missed drop would load the image file in the tab, losing state.
  // These are idempotent so re-running setupImageTab doesn't double-bind.
  if (!window.__fjDropGlobalBound) {
    window.__fjDropGlobalBound = true;
    ['dragover', 'drop'].forEach(evt => {
      window.addEventListener(evt, e => {
        // Only preventDefault if this is a file drag (not text/link drags).
        if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) {
          e.preventDefault();
        }
      });
    });
  }

  ['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
  });

  dropzone.addEventListener('dragenter', e => {
    dragCounter++;
    dropzone.classList.add('drag');
  });
  dropzone.addEventListener('dragleave', e => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropzone.classList.remove('drag');
    }
  });
  dropzone.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    dropzone.classList.remove('drag');

    const result = await extractFilesFromDrop(e.dataTransfer);
    if (result.totalCount === 0) {
      toast('No files were detected in the drop. Try choosing files with the button instead.', 'error');
      return;
    }
    if (result.images.length === 0) {
      toast(`${result.totalCount} file(s) dropped but none were images (accepted: jpg, png, gif, webp, avif, svg, bmp, tiff, heic, heif).`, 'error');
      return;
    }
    if (result.images.length < result.totalCount) {
      toast(`Skipped ${result.totalCount - result.images.length} non-image file(s).`, 'info');
    }
    await uploadFilesToBucket(state.activeBucket, result.images);
  });

  // Prefetch counts for all buckets
  IMAGE_BUCKETS.forEach(b => {
    supa.storage.from(b.id).list('', { limit: 1000 }).then(({ data }) => {
      state.imageCounts[b.id] = (data || []).length;
      const el = document.getElementById(`bucket-count-${b.id}`);
      if (el) el.textContent = (data || []).length;
    });
  });
}

async function loadBucketFiles(bucket) {
  const container = document.getElementById('image-container');
  container.innerHTML = '<div class="empty-state"><div class="loader"></div> Loading images...</div>';

  const { data, error } = await supa.storage.from(bucket).list('', {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' }
  });

  if (error) {
    toast('Failed to load image bucket. Please refresh and try again.', 'error');
    container.innerHTML = `<div class="empty-state">Could not load images. Please refresh.</div>`;
    return;
  }

  state.bucketFiles[bucket] = (data || []).filter(f => f.name && !f.name.startsWith('.'));
  state.imageCounts[bucket] = state.bucketFiles[bucket].length;
  const countEl = document.getElementById(`bucket-count-${bucket}`);
  if (countEl) countEl.textContent = state.bucketFiles[bucket].length;

  renderBucketFiles(bucket);
}

function renderBucketFiles(bucket, filter = '') {
  const container = document.getElementById('image-container');
  const files = state.bucketFiles[bucket] || [];
  const filtered = filter
    ? files.filter(f => f.name.toLowerCase().includes(filter.toLowerCase()))
    : files;

  const countEl = document.getElementById('image-count');
  if (countEl) countEl.textContent = `${filtered.length} of ${files.length} files`;

  if (filtered.length === 0) {
    if (files.length === 0) {
      // Could be empty OR a missing SELECT policy — show helpful guidance
      container.innerHTML = `
        <div class="image-empty" style="text-align:left;padding:28px;">
          <div style="font-size:14px;font-weight:600;color:var(--navy);margin-bottom:8px;">No files listed</div>
          <div style="font-size:12.5px;color:var(--mid);margin-bottom:14px;line-height:1.6;">
            This could mean the bucket is empty — or that the SELECT policy on <code>storage.objects</code>
            is missing. A public bucket lets anyone fetch a file by URL, but listing the bucket contents
            via the API requires an explicit SELECT policy for the <b>anon</b> role.
          </div>
          <div style="font-size:12px;color:var(--mid);margin-bottom:6px;">Run this in the Supabase SQL editor:</div>
          <pre style="background:#0a1628;color:#fff;padding:12px;border-radius:6px;font-size:11px;white-space:pre-wrap;overflow-x:auto;">CREATE POLICY "Allow anon to list ${bucket}"
ON storage.objects FOR SELECT TO anon
USING (bucket_id = '${bucket}');</pre>
          <div style="font-size:11.5px;color:var(--mid);margin-top:10px;">
            After running, click <b>Refresh</b> above. If the bucket really is empty, uploading any file will prove the write policies work.
          </div>
        </div>
      `;
    } else {
      container.innerHTML = `<div class="image-empty">No files match your filter.</div>`;
    }
    return;
  }

  container.innerHTML = `
    <div class="image-grid">
      ${filtered.map((f, i) => {
        const publicUrl = `${SUPA_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(f.name)}`;
        // Supabase list() exposes byte size in metadata.size (or occasionally size directly).
        const sizeBytes = (f.metadata && f.metadata.size) || f.size || 0;
        const sizeLabel = sizeBytes ? formatBytes(sizeBytes) : '—';
        const dimId = `img-dim-${i}`;
        return `
          <div class="image-tile">
            <img class="image-tile-img" src="${publicUrl}" loading="lazy"
                 data-img-fallback="admin-tile" data-dim-id="${dimId}">
            <div class="image-tile-name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</div>
            <div class="image-tile-meta">
              <span title="File size">${sizeLabel}</span>
              <span id="${dimId}" class="dim-pending" title="Pixel dimensions">— × —</span>
            </div>
            <div class="image-tile-actions">
              <button class="btn btn-outline btn-sm" data-action="copyImageUrl" data-url="${escapeAttr(escapeJs(publicUrl))}">📋 URL</button>
              <button class="btn btn-danger btn-sm" data-action="deleteImageConfirm" data-bucket="${bucket}" data-name="${escapeAttr(escapeJs(f.name))}">🗑</button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Human-readable byte count. Uses binary (KiB/MiB) boundaries but displays KB/MB
// labels since most users expect that convention.
function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Called by each <img> onload to fill in pixel dimensions once the browser
// has decoded the image. Kept minimal so it doesn't block rendering.
function setImageDim(elId, w, h) {
  const el = document.getElementById(elId);
  if (!el || !w || !h) return;
  el.textContent = `${w} × ${h}`;
  el.classList.remove('dim-pending');
}

// ── Walk a DataTransfer from a drop event, extracting all File objects
//    (including those inside dropped folders, recursively). ──
//
// Returns { images: File[], totalCount: number } so the caller can tell the
// difference between "no files dropped at all" (probably a drag source
// problem) and "files dropped but none were images" (wrong filter / format).
async function extractFilesFromDrop(dataTransfer) {
  const files = [];
  // Snapshot immediately — DataTransferItemList / FileList become invalid after
  // the drop handler's synchronous portion returns, which matters for async folder walks.
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const rawFiles = dataTransfer.files ? Array.from(dataTransfer.files) : [];

  // Prefer items API (supports folders). Fall back to files list if items
  // didn't yield anything (e.g. Safari in some versions, or non-file drags).
  const entries = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) {
      entries.push(entry);
    } else {
      // Safari / older browsers — grab as File directly
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  for (const entry of entries) {
    await walkFileEntry(entry, files);
  }

  // Belt-and-braces fallback: if the items API gave us nothing but a plain
  // file list is available, use that. Covers older browsers and unusual drag
  // sources (e.g. some image editors).
  if (files.length === 0 && rawFiles.length > 0) {
    for (const f of rawFiles) files.push(f);
  }

  const totalCount = files.length;

  // Filter to images only (by MIME or extension). Includes HEIC/HEIF for iPhone photos.
  const imageExt = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic|heif)$/i;
  const images = files.filter(f =>
    (f.type && f.type.startsWith('image/')) || imageExt.test(f.name)
  );

  return { images, totalCount };
}

// Recursively walk a FileSystemEntry (used for folder drops)
function walkFileEntry(entry, acc) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        file => { acc.push(file); resolve(); },
        () => resolve()
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async (entries) => {
          if (entries.length === 0) { resolve(); return; }
          for (const e of entries) { await walkFileEntry(e, acc); }
          readBatch(); // readEntries returns at most ~100 per call
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

// Thin wrapper for the <input type="file"> change event
function handleImageInputChange(event) {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (files.length === 0) return;
  uploadFilesToBucket(state.activeBucket, files);
}

async function uploadFilesToBucket(bucket, files) {
  if (!files || files.length === 0) return;

  // Show per-file progress modal
  openModal(`
    <h3>Uploading ${files.length} file(s)</h3>
    <p>Target bucket: <b>${bucket}</b></p>
    <div id="upload-progress" style="max-height:300px;overflow-y:auto;background:var(--bg);padding:12px;border-radius:6px;font-family:monospace;font-size:12px;">
      ${files.map((f, i) => `
        <div id="upload-row-${i}" style="padding:4px 0;display:flex;gap:8px;align-items:center;">
          <span class="loader" style="width:10px;height:10px;border-width:1.5px;"></span>
          <span style="flex:1;color:var(--mid);">${escapeHtml(f.name)}</span>
          <span id="upload-status-${i}" style="font-size:11px;color:var(--mid);">waiting...</span>
        </div>
      `).join('')}
    </div>
    <div id="upload-summary" style="margin-top:14px;font-size:13px;"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" id="upload-close-btn" data-action="closeModal" disabled style="opacity:0.5;cursor:not-allowed;">Close</button>
    </div>
  `);

  let success = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const row = document.getElementById(`upload-row-${i}`);
    const statusEl = document.getElementById(`upload-status-${i}`);
    if (statusEl) statusEl.textContent = 'uploading...';

    const { data, error } = await supa.storage.from(bucket).upload(file.name, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || 'image/jpeg',
    });

    if (row) {
      const spinner = row.querySelector('.loader');
      if (spinner) spinner.remove();
    }

    if (error) {
      failed++;
      errors.push({ name: file.name, status: error.statusCode });
      if (statusEl) {
        statusEl.textContent = '✗ Upload failed';
        statusEl.style.color = 'var(--red)';
      }
    } else {
      success++;
      if (statusEl) {
        statusEl.textContent = '✓ uploaded';
        statusEl.style.color = 'var(--green)';
      }
    }
  }

  // Summary + policy guidance if relevant
  const summaryEl = document.getElementById('upload-summary');
  const closeBtn = document.getElementById('upload-close-btn');
  if (closeBtn) { closeBtn.disabled = false; closeBtn.style.opacity = '1'; closeBtn.style.cursor = 'pointer'; }

  if (failed === 0) {
    if (summaryEl) summaryEl.innerHTML = `<span class="status-pill status-ok" style="padding:8px 12px;">✓ All ${success} file(s) uploaded successfully</span>`;
    toast(`Uploaded ${success} file(s)`, 'success');
  } else {
    // Detect common error types
    const firstErr = errors[0];
    const msg = (firstErr.message || '').toLowerCase();
    let guidance = '';
    if (msg.includes('row-level security') || msg.includes('rls') || msg.includes('policy') || msg.includes('unauthorized') || msg.includes('not authorized') || firstErr.status === 403) {
      guidance = `
        <div class="status-pill status-err" style="display:block;padding:12px;margin-top:10px;line-height:1.5;">
          <b>⚠️ Storage policy missing</b><br>
          The <code>${bucket}</code> bucket has no INSERT policy for the anon role. To allow uploads, add a policy in Supabase:
          <br><br>
          <b>Supabase Dashboard → Storage → ${bucket} → Policies → New policy</b>
          <br>
          Choose "For full customization" → allow <code>INSERT</code> and <code>UPDATE</code> for the <code>anon</code> role with target role <code>anon</code>, USING expression <code>true</code>, WITH CHECK expression <code>true</code>.
          <br><br>
          Or run this SQL in the SQL editor (includes SELECT for listing):
          <pre style="background:#1a1a2e;color:#fff;padding:10px;border-radius:4px;margin-top:6px;font-size:10.5px;white-space:pre-wrap;">CREATE POLICY "Allow anon to list ${bucket}"
ON storage.objects FOR SELECT TO anon
USING (bucket_id = '${bucket}');

CREATE POLICY "Allow anon uploads to ${bucket}"
ON storage.objects FOR INSERT TO anon
WITH CHECK (bucket_id = '${bucket}');

CREATE POLICY "Allow anon updates to ${bucket}"
ON storage.objects FOR UPDATE TO anon
USING (bucket_id = '${bucket}');

CREATE POLICY "Allow anon deletes from ${bucket}"
ON storage.objects FOR DELETE TO anon
USING (bucket_id = '${bucket}');</pre>
        </div>
      `;
    }
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="status-pill ${success === 0 ? 'status-err' : 'status-info'}" style="padding:8px 12px;">
          ${success} succeeded, ${failed} failed
        </div>
        ${guidance}
        ${errors.length > 0 ? `
          <details style="margin-top:10px;font-size:12px;">
            <summary style="cursor:pointer;color:var(--mid);">Show all errors</summary>
            <div style="background:var(--bg);padding:10px;border-radius:4px;margin-top:6px;font-family:monospace;font-size:11px;">
              ${errors.map(e => `<div style="padding:3px 0;"><b>${escapeHtml(e.name)}</b>: ${escapeHtml(e.message || 'unknown error')}</div>`).join('')}
            </div>
          </details>
        ` : ''}
      `;
    }
    toast(`${success} uploaded, ${failed} failed`, failed === files.length ? 'error' : 'info');
  }

  loadBucketFiles(bucket);
}

function deleteImageConfirm(bucket, fileName) {
  openModal(`
    <h3>Delete image?</h3>
    <p>Delete <b>${escapeHtml(fileName)}</b> from <b>${bucket}</b>? This cannot be undone.</p>
    <div class="modal-actions">
      <button class="btn btn-outline" data-action="closeModal">Cancel</button>
      <button class="btn btn-danger" data-action="deleteImage" data-bucket="${bucket}" data-name="${escapeAttr(escapeJs(fileName))}">Delete</button>
    </div>
  `);
}

async function deleteImage(bucket, fileName) {
  const { data, error } = await supa.storage.from(bucket).remove([fileName]);
  closeModal();
  if (error) {
    toast('Delete failed. Please try again.', 'error');
    return;
  }
  // Supabase returns success with empty data array if no matching row / policy blocked
  if (!data || data.length === 0) {
    toast('Delete blocked — likely a missing DELETE policy on this bucket. See upload dialog for SQL to fix.', 'error');
    return;
  }
  toast('Image deleted', 'success');
  loadBucketFiles(bucket);
}

function copyImageUrl(url) {
  navigator.clipboard.writeText(url).then(() => toast('URL copied to clipboard', 'success'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function openModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target.id === 'modal-overlay') closeModal();
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════════

function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(str) { return escapeHtml(String(str)).replace(/"/g, '&quot;'); }
function escapeJs(str) { return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// ═══════════════════════════════════════════════════════════════════════════════
// SPECIFIC EVENT LISTENERS (refactored from inline handlers)
// ═══════════════════════════════════════════════════════════════════════════════

// Login button
const loginBtn = document.getElementById('login-btn');
if (loginBtn) {
  loginBtn.addEventListener('click', handleLogin);
}

// Refresh tab button
const btnRefresh = document.getElementById('btn-refresh');
if (btnRefresh) {
  btnRefresh.addEventListener('click', refreshActiveTab);
}

// Sign out button
const btnSignout = document.getElementById('btn-signout');
if (btnSignout) {
  btnSignout.addEventListener('click', handleSignOut);
}

// Upload close button
const uploadCloseBtn = document.getElementById('upload-close-btn');
if (uploadCloseBtn) {
  uploadCloseBtn.addEventListener('click', closeModal);
}

// File input for images
const imageFileInput = document.getElementById('image-file-input');
if (imageFileInput) {
  imageFileInput.addEventListener('change', handleImageInputChange);
}

// Column resizer - pointer down event delegation
document.addEventListener('pointerdown', function(e) {
  const resizer = e.target.closest('[data-action="colResize"]');
  if (!resizer) return;
  e.preventDefault();
  e.stopPropagation();
  const tableName = resizer.dataset.table;
  const col = resizer.dataset.col;
  startColResize(e, tableName, col);
});

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT DELEGATION (replaces inline onclick/onchange)
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('click', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const t = el.dataset.table;
  if (a === 'addNewRow') addNewRow(t);
  else if (a === 'downloadCsv') downloadCsv(t);
  else if (a === 'saveChanges') saveChanges(t);
  else if (a === 'toggleSort') toggleSort(t, el.dataset.col, e);
  else if (a === 'revertRow') revertRow(t, el.dataset.key);
  else if (a === 'deleteRowConfirm') deleteRowConfirm(t, el.dataset.key);
  else if (a === 'removeNewRow') removeNewRow(t, parseInt(el.dataset.idx, 10));
  else if (a === 'deleteRow') deleteRow(t, el.dataset.key);
  else if (a === 'commitCsvUpload') commitCsvUpload(t);
  else if (a === 'copyImageUrl') copyImageUrl(el.dataset.url);
  else if (a === 'deleteImageConfirm') deleteImageConfirm(el.dataset.bucket, el.dataset.name);
  else if (a === 'deleteImage') deleteImage(el.dataset.bucket, el.dataset.name);
  else if (a === 'closeModal') closeModal();
  else if (a === 'refreshBucketFiles') loadBucketFiles(state.activeBucket);
});

document.addEventListener('change', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'csvUpload') handleCsvUpload(e, el.dataset.table);
  else if (a === 'imageInputChange') handleImageInputChange(e);
  else if (a === 'updateCell') {
    const val = el.type === 'checkbox' ? el.checked : el.value;
    const cellType = el.dataset.cellType;
    const isNew = el.dataset.newRow === 'true';
    if (cellType === 'bool') updateCell(el.dataset.table, el.dataset.rowKey, el.dataset.col, val, isNew);
    else if (cellType === 'json') updateCell(el.dataset.table, el.dataset.rowKey, el.dataset.col, val, isNew, 'json');
    else if (cellType === 'number') updateCell(el.dataset.table, el.dataset.rowKey, el.dataset.col, val, isNew, 'number');
    else updateCell(el.dataset.table, el.dataset.rowKey, el.dataset.col, val, isNew);
  }
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

// Image load/error handlers (replaces inline onload/onerror on admin tiles)
document.addEventListener('load', function(e) {
  if (e.target.tagName !== 'IMG') return;
  var dimId = e.target.dataset.dimId;
  if (dimId) setImageDim(dimId, e.target.naturalWidth, e.target.naturalHeight);
}, true);

document.addEventListener('error', function(e) {
  if (e.target.tagName !== 'IMG') return;
  var fb = e.target.dataset.imgFallback;
  if (!fb) return;
  e.target.removeAttribute('data-img-fallback');
  if (fb === 'admin-tile') {
    var placeholder = document.createElement('div');
    placeholder.className = 'image-tile-placeholder';
    placeholder.textContent = '(not an image)';
    e.target.parentElement.replaceChild(placeholder, e.target);
  }
}, true);

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED API for admin-footwear.js (and any future per-domain admin script).
// admin-footwear.js is loaded after admin.js and reads from window.curate
// rather than redeclaring its own Supabase client and helper functions.
// ═══════════════════════════════════════════════════════════════════════════════
window.curate = {
  supa,
  toast,
  openModal,
  closeModal,
  escapeHtml,
  escapeAttr,
  escapeJs,
};
