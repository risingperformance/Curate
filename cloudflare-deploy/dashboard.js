const SUPA_URL = window.__SUPABASE_CONFIG.url;
const SUPA_KEY = window.__SUPABASE_CONFIG.key;
const supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);
// PIN-based login removed Apr 2026 -- now using Supabase Auth (email/password)
const SUPA_IMG_BASE = 'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/product-images/FJ_';

let allOrders    = [];
let allLines     = [];
let allDrafts    = [];
let targets      = {};
let nationalTargets = { AU: 0, NZ: 0 };
let allCustomers = {};  // keyed by account_name (lowercase)
let baseSkuMap   = {};  // sku -> base_sku for image lookups
let includePrebook = false;

// ── XSS HELPERS ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeAttr(str) { return escapeHtml(String(str)).replace(/"/g, '&quot;'); }

// ── SUPABASE AUTH LOGIN ─────────────────────────────────────────────────────
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
  // Verify user is a salesperson
  const { data: sp } = await supa.from('salespeople').select('name, role').eq('email', email).single();
  if (!sp) {
    errEl.textContent = 'Account not linked to a salesperson. Contact your admin.';
    await supa.auth.signOut();
    return;
  }
  unlockDashboard();
}

async function handleSignOut() {
  await supa.auth.signOut();
  window.location.reload();
}

function unlockDashboard() {
  const screen = document.getElementById('login-screen');
  screen.classList.add('unlocked');
  setTimeout(() => { screen.style.display = 'none'; loadAll(); }, 500);
}

// Check for existing session on page load
(async function() {
  const { data: { session } } = await supa.auth.getSession();
  if (session) {
    // Verify still a valid salesperson
    const { data: sp } = await supa.from('salespeople').select('name, role').eq('email', session.user.email).single();
    if (sp) { unlockDashboard(); return; }
    await supa.auth.signOut();
  }
  // No session - show login, focus email field
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

// ── TABS ─────────────────────────────────────────────────────────────────────
function showTab(id) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  document.querySelector(`.tab-btn[data-tab="${id}"]`).classList.add('active');
}

// ── LOAD DATA ────────────────────────────────────────────────────────────────
async function loadAll() {
  document.getElementById('last-updated').textContent = 'Refreshing…';

  const [ordersRes, linesRes, targetsRes, customersRes, draftsRes, historyRes, productsRes, salespeopleRes] = await Promise.all([
    supa.from('orders').select('*').order('order_date', { ascending: false }),
    supa.from('order_lines').select('*'),
    supa.from('sales_targets').select('*'),
    supa.from('customers').select('*'),
    supa.from('draft_orders').select('*').order('created_at', { ascending: false }),
    supa.from('customer_season_history').select('*'),
    supa.from('products').select('sku, base_sku'),
    supa.from('salespeople').select('name, country')
  ]);

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

  // Build history lookup: account_code → same season type from prior year
  // e.g. current AW27 compares to AW26 (not SS26)
  const currentDashSeason = 'AW27';
  const seasonPrefix = currentDashSeason.replace(/\d+$/, ''); // 'AW'
  const seasonYear = parseInt(currentDashSeason.replace(/^\D+/, '')); // 27
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

  // Filter lines by collection
  let lines = collFilter ? allLines.filter(l => l.collection_id === collFilter) : [...allLines];

  // Further filter by customer group
  if (groupOrderIds) {
    lines = lines.filter(l => groupOrderIds.has(l.order_id));
  }

  const skuMap = {};
  lines.forEach(l => {
    if (!skuMap[l.sku]) skuMap[l.sku] = {
      sku: l.sku, desc: l.product_name, collection: l.collection_id,
      accounts: new Set(), units: 0, dollars: 0
    };
    const order = window._orderLookup[l.order_id];
    if (order) skuMap[l.sku].accounts.add(order.account_name);
    skuMap[l.sku].units   += (l.quantity || 0);
    skuMap[l.sku].dollars += (l.line_total || (l.unit_price || 0) * (l.quantity || 0));
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
           <img class="thumb-img" src="${imgUrl}" alt="${escapeAttr(r.desc)}" loading="lazy" data-img-fallback="thumb">
           <div class="thumb-hover"><img src="${imgUrl}" alt="${escapeAttr(r.desc)}" data-img-fallback="thumb-hover"></div>
         </div>`
      : `<div class="thumb-placeholder">👕</div>`;
    const metricVal = byDollars ? `$${Math.round(r.dollars).toLocaleString()}` : r.units.toLocaleString();
    const escapedSku = r.sku.replace(/'/g, "\\'");

    tbody.innerHTML += `
      <tr class="product-row" data-action="toggleProductDetail" data-sku="${escapedSku}">
        <td><span class="rank-badge ${rankCls}">${rank}</span></td>
        <td style="padding:6px 10px">${thumbCell}</td>
        <td style="font-family:monospace;font-size:12px">${r.sku}</td>
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
      <tr class="order-row${count > 1 ? '' : ''}" data-action="toggleOrderDetail" data-key="${acctKey}" style="cursor:pointer">
        <td style="font-weight:600">${escapeHtml(g.account_name)}${countBadge}</td>
        <td>${escapeHtml(g.account_manager)}</td>
        <td>${escapeHtml(g.country)}</td>
        <td class="right" style="font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700">${g.totalUnits.toLocaleString()}</td>
        <td class="right" style="font-size:12px;color:var(--mid)">$${Math.round(g.totalValue).toLocaleString()}</td>
        <td class="right" style="font-size:13px;color:var(--mid)">${g.prior.toLocaleString()}</td>
        <td class="right ${diffCls}" style="font-size:13px">${diffText}</td>
        <td style="font-size:12px;color:var(--mid)">${dateStr}</td>
        <td><span class="status-badge ${statusCls}">${status}</span></td>
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
      <td style="color:var(--mid)">${oid}</td>
      <td>${o.country || '—'}</td>
      <td class="right" style="font-weight:700">${units.toLocaleString()}</td>
      <td class="right" style="color:var(--mid)">$${Math.round(value).toLocaleString()}</td>
      <td style="font-size:12px;color:var(--mid)">${date}</td>
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

    // Calculate units from order_data snapshot
    const od = d.order_data || {};
    let units = 0;
    Object.values(od).forEach(item => {
      const sizes = item.sizes || {};
      units += Object.values(sizes).reduce((a, b) => a + b, 0);
    });

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

    const draftUrl = `index.html#draft=${encodeURIComponent(d.token)}&from=dashboard`;

    tbody.innerHTML += `
      <tr id="draft-row-${d.token}">
        <td style="font-weight:600">${escapeHtml(accountName)}</td>
        <td>${escapeHtml(managerName)}</td>
        <td class="right">${units.toLocaleString()}</td>
        <td style="font-size:12px;color:var(--mid)">${createdStr}</td>
        <td style="font-size:12px;color:var(--mid)">${expiresStr}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="draft-actions">
            ${!isExpired ? `<a class="btn-open-draft" href="${draftUrl}" target="_blank">✏️ Open</a>` : ''}
            <button class="btn-delete-draft" data-action="deleteDraft" data-token="${d.token}">✕</button>
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
  const { error } = await supa.from('draft_orders').delete().eq('token', token);
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
  document.getElementById('target-admin-panel').classList.toggle('active');
}

async function saveTargets() {
  document.getElementById('target-save-status').textContent = 'Saving…';
  const orderReps = new Set(allOrders.filter(o => o.account_manager).map(o => o.account_manager));
  const allReps = [...new Set([...Object.keys(targets), ...orderReps])];
  const rows = allReps.map(rep => ({
    name: rep,
    target: parseFloat(document.getElementById('target-' + rep.replace(/\s+/g,'_')).value) || 0,
    season: 'AW27'
  }));
  const { error } = await supa.from('sales_targets').upsert(rows, { onConflict: 'name,season' });
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

// Login button
document.getElementById('login-btn').addEventListener('click', handleLogin);

// Header buttons
document.getElementById('btn-refresh-load').addEventListener('click', loadAll);
document.getElementById('btn-sign-out').addEventListener('click', handleSignOut);

// Tab buttons
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    const tabId = this.dataset.tab;
    showTab(tabId);
  });
});

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
