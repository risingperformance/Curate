// ── Legacy draft URL redirect ───────────────────────────────────────────────
// Old emails and dashboard links point at /index.html#draft=<token>, but the
// root is now a router; the apparel order form lives at /apparel/. Redirect
// before any other module work happens so the user never sees the landing
// flicker on a draft-link visit. Show the draft loading screen briefly so
// the navigation isn't a blank flash.
(function() {
  var hash = window.location.hash || '';
  if (hash.indexOf('draft=') !== -1) {
    var ls = document.getElementById('login-screen');
    var dl = document.getElementById('draft-loading-screen');
    if (ls) ls.style.display = 'none';
    if (dl) dl.style.display = '';
    window.location.replace('apparel/index.html' + hash);
  }
})();

// ── Session check promise: init() will await this to avoid race conditions ──
var _sessionReady;
var sessionCheckDone = new Promise(function(resolve) { _sessionReady = resolve; });

// ── Post-login redirect target (?next=) ─────────────────────────────────────
// Protected pages (dashboard, admin, appointment-diary, etc.) redirect here
// when the user is not signed in, with ?next=<page>. After a successful login
// we bounce back to that page. The allowlist guards against open-redirect
// attacks: anything that is not an exact, relative match for one of these
// strings is rejected.
var ALLOWED_NEXT_PAGES = new Set([
  'dashboard.html',
  'admin.html',
  'appointment-diary.html'
]);
function safeNextUrl(raw) {
  if (!raw) return null;
  var decoded;
  try { decoded = decodeURIComponent(raw); } catch (_) { return null; }
  // Reject absolute / protocol-relative / scheme-prefixed targets outright.
  if (/^([a-z]+:)?\/\//i.test(decoded)) return null;
  if (/^[a-z]+:/i.test(decoded)) return null;   // javascript:, data:, etc.
  if (decoded.startsWith('/')) return null;     // we use relative paths only
  // Split filename from query/hash and check the filename against the allowlist.
  var pathOnly = decoded.split(/[?#]/)[0];
  if (!ALLOWED_NEXT_PAGES.has(pathOnly)) return null;
  return decoded;
}

// AUTH12 — currentUser is module-scoped (was on window). Reduces XSS exfil
// surface and prevents client-side role tampering via DevTools.
var currentUser = null;
function getCurrentUser() { return currentUser || {}; }

(function() {
  const screen  = document.getElementById('login-screen');
  const form    = document.getElementById('login-form');
  const emailEl = document.getElementById('login-email');
  const passEl  = document.getElementById('login-password');
  const btnEl   = document.getElementById('login-btn');
  const forgotEl= document.getElementById('login-forgot');
  const errEl   = document.getElementById('login-error');

  document.getElementById('login-logo').src =
    'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/logos/fj-curate-logo-w.png';

  // ── Check for existing session on page load ──
  // Also handles SSO bypass from diary (from=diary) -- Supabase Auth
  // session is shared via localStorage, so no credentials in URL needed.
  // The CSS hides #login-screen by default. revealLogin shows it once
  // we know the user is unauthenticated, which avoids the brief login
  // flash for reps coming back from an order form.
  function revealLogin() {
    if (screen) screen.classList.add('visible');
    if (emailEl) emailEl.focus();
  }

  async function checkExistingSession() {
    var hash = window.location.hash || '';
    var isDraftLink = hash.indexOf('draft=') !== -1;
    try {
      const { data: { session } } = await supa.auth.getSession();
      if (session) {
        if (isDraftLink) {
          // Rep opening a draft link -- resolve user but skip landing page.
          // init() will handle showing the order form.
          var userEmail = session.user.email;
          var { data: sp } = await supa.from('salespeople').select('*').eq('email', userEmail).single();
          if (sp) {
            currentUser = {
              name: sp.name || '', email: sp.email || userEmail,
              role: sp.role || 'rep', country: sp.country || null
            };
          }
          if (screen) screen.style.display = 'none';
        } else {
          await loginWithSession(session);
        }
      } else if (!isDraftLink) {
        revealLogin();
      }
    } catch (e) {
      // Network / auth blip -- show the login so the user can recover.
      if (!isDraftLink) revealLogin();
    } finally {
      // Signal to init() that session check is complete
      _sessionReady();
    }
  }

  // Safety net: if checkExistingSession is somehow stuck (script error,
  // very slow network), show the login after 4s so the user is never
  // left staring at a black screen.
  setTimeout(function () {
    if (currentUser) return;
    var s = document.getElementById('login-screen');
    if (s && !s.classList.contains('visible') && s.style.display !== 'none') {
      s.classList.add('visible');
    }
  }, 4000);

  // ── Resolve authenticated user to salesperson record ──
  async function loginWithSession(session) {
    const userEmail = session.user.email;

    // Look up the salesperson record by email
    const { data: sp, error } = await supa
      .from('salespeople')
      .select('*')
      .eq('email', userEmail)
      .single();

    if (error || !sp) {
      // Auth succeeded but no salesperson record found
      errEl.textContent = 'Account not linked to a salesperson. Contact your admin.';
      await supa.auth.signOut();
      return;
    }

    currentUser = {
      name:    sp.name || '',
      email:   sp.email || userEmail,
      role:    sp.role || 'rep',
      country: sp.country || null
    };

    // If we arrived here via ?next=<page>, bounce the signed-in user back to
    // the page they originally tried to open (validated against an allowlist).
    var qNext = new URLSearchParams(window.location.search).get('next');
    var nextTarget = safeNextUrl(qNext);
    if (nextTarget) {
      window.location.replace(nextTarget);
      return;
    }

    errEl.textContent = '';
    screen.classList.add('fade-out');
    setTimeout(() => {
      screen.style.display = 'none';
      showSeasonLanding();
    }, 500);
  }

  // ── Sign in with email & password ──
  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    const email = emailEl.value.trim();
    const password = passEl.value;

    if (!email || !password) return;

    btnEl.disabled = true;
    errEl.textContent = 'Signing in...';

    const { data, error } = await supa.auth.signInWithPassword({ email, password });

    if (error) {
      btnEl.disabled = false;
      errEl.textContent = error.message === 'Invalid login credentials'
        ? 'Incorrect email or password. Please try again.'
        : 'Sign-in failed. Please try again or contact support.';
      return;
    }

    await loginWithSession(data.session);
    btnEl.disabled = false;
  });

  // ── Forgot password flow ──
  forgotEl.addEventListener('click', async function(e) {
    e.preventDefault();
    const email = emailEl.value.trim();
    if (!email) {
      errEl.textContent = 'Enter your email address, then tap Forgot password.';
      return;
    }
    errEl.textContent = 'Sending reset link...';
    const { error } = await supa.auth.resetPasswordForEmail(email);
    if (error) {
      errEl.textContent = 'Could not send reset link. Please check your email and try again.';
    } else {
      errEl.style.color = '#4a4';
      errEl.textContent = 'Password reset email sent. Check your inbox.';
      setTimeout(() => { errEl.style.color = ''; }, 5000);
    }
  });

  window.addEventListener('DOMContentLoaded', function() { checkExistingSession(); });
})();

async function signOut() {
  await supa.auth.signOut();
  // Hard reload after sign-out wipes any in-memory caches (top products,
  // appointment lists, draft data) that would otherwise persist as stale
  // PII addressable via DevTools on a shared / kiosk device. Other staff
  // pages (admin, dashboard, diary) already do this. AUTH13 fix May 2026.
  window.location.reload();
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

// renderBookingDiaryCard removed: the dashboard layout uses the
// "Next 5 Appointments" panel instead, populated by fetchNextAppointments
// in loadDashboardSideData.

async function showSeasonLanding() {
  const landing = document.getElementById('season-landing');
  landing.style.display = 'flex';

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

  // Fetch apparel + footwear drafts in parallel. The two tables have
  // different shapes (token vs share_token, order_data vs cart_items)
  // so they're normalised into a single shape below.
  const [apparelDraftsRes, footwearDraftsRes] = await Promise.all([
    supa.from('draft_orders')
        .select('*')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }),
    // footwear_drafts has no expires_at column. RLS limits SELECT to
    // the rep's own drafts (created_by = auth.uid()) plus admins.
    supa.from('footwear_drafts')
        .select('*')
        .eq('status', 'draft')
        .order('created_at', { ascending: false })
  ]);

  // DB01 — Once migration_DB01_draft_orders_rls.sql is applied, RLS is the
  // server-side fence (created_by = auth.uid() OR _dr_is_privileged()). This
  // JS-side filter is retained as defence-in-depth and to keep behaviour
  // sensible on legacy rows that have created_by = NULL. Admins/managers see
  // all drafts; reps see only those whose customer_data.manager matches them.
  const cu = currentUser || {};
  const isAdminUser = (cu.role === 'admin' || cu.role === 'manager');
  const myName = (cu.name || '').trim().toLowerCase();
  const visibleApparelDrafts = (apparelDraftsRes.data || []).filter(d => {
    if (isAdminUser) return true;
    const cd = d.customer_data || {};
    const am = (cd.manager || cd.account_manager || cd.am || cd.salesperson || '').trim().toLowerCase();
    return am && am === myName;
  });
  const visibleFootwearDrafts = footwearDraftsRes.data || [];

  const draftsBySeason = {};
  visibleApparelDrafts.forEach(d => {
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
      modified: d.created_at,
      category: 'apparel'
    });
  });
  visibleFootwearDrafts.forEach(d => {
    // footwear_drafts.season_id was added in May 2026; older rows were
    // backfilled to 'AW27-shoe'. The fallback below covers any draft
    // saved before that migration ran in case there's row drift.
    const sid = d.season_id || 'AW27-shoe';
    if (!draftsBySeason[sid]) draftsBySeason[sid] = [];
    const cd = d.customer_data || {};
    const items = Array.isArray(d.cart_items) ? d.cart_items : [];
    const units = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    draftsBySeason[sid].push({
      token: d.share_token,
      account: cd.account_name || cd.customer || cd.account || 'Unnamed',
      units,
      modified: d.created_at,
      category: 'footwear'
    });
  });

  // Greeting name from currentUser if available
  const cuName = (currentUser && currentUser.name) || '';
  const greetEl = document.getElementById('dash-greeting-name');
  if (greetEl) greetEl.textContent = cuName ? `Welcome back, ${cuName.split(' ')[0]}.` : 'Welcome back.';

  // Render season cards (dashboard layout: drafts in an accordion, two
  // action buttons per card)
  const container = document.getElementById('season-cards-container');
  container.innerHTML = seasons.map(s => {
    const isActive = s.status === 'active';
    const tagLabel = isActive ? 'Open' : 'Closed';
    const tagCls = isActive ? '' : 'dash-scard-tag-closed';
    const imgUrl = SEASONAL_IMG_BASE + encodeURIComponent(s.season_id) + '.jpg';
    const seasonDrafts = draftsBySeason[s.season_id] || [];
    const dc = seasonDrafts.length;
    const sid = s.season_id;

    const draftRows = seasonDrafts.length
      ? seasonDrafts.map(d => {
          const mod = d.modified ? new Date(d.modified).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';
          return `
            <div class="dash-draft-row" data-action="openDraftFromLanding" data-token="${escapeAttr(d.token)}" data-category="${escapeAttr(d.category || 'apparel')}">
              <div>
                <div class="dash-draft-name">${escapeHtml(d.account)}</div>
                <div class="dash-draft-meta">Last edited ${mod}</div>
              </div>
              <div class="dash-draft-units">${d.units} units</div>
              <button class="dash-draft-del" data-action="confirmDeleteDraft" data-token="${escapeAttr(d.token)}" data-account="${escapeAttr(d.account)}" data-category="${escapeAttr(d.category || 'apparel')}" title="Delete draft">&times;</button>
            </div>`;
        }).join('')
      : '<div class="dash-drafts-empty">No drafts yet for this season.</div>';

    const newOrderAction = isActive
      ? `data-action="selectSeason" data-id="${escapeAttr(sid)}" data-category="${escapeAttr(s.category || 'apparel')}"`
      : 'disabled';

    return `
      <article class="dash-scard" id="dash-scard-${escapeAttr(sid)}">
        <div class="dash-scard-head">
          <div class="dash-scard-img" style="background-image:url('${escapeAttr(imgUrl)}')"></div>
          <div class="dash-scard-body">
            <span class="dash-scard-tag ${tagCls}">${tagLabel}</span>
            <div class="dash-scard-title">${escapeHtml(s.season_name)}</div>
            <div class="dash-scard-actions">
              <button class="dash-scard-btn dash-scard-btn-secondary" data-action="toggleDashDrafts" data-id="${escapeAttr(sid)}" type="button">
                Drafts <span class="count">${dc}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <button class="dash-scard-btn dash-scard-btn-primary" type="button" ${newOrderAction}>
                + New order
              </button>
            </div>
          </div>
        </div>
        <div class="dash-scard-drafts">
          <div class="dash-scard-drafts-header">
            <span>Drafts in progress</span>
          </div>
          ${draftRows}
        </div>
      </article>
    `;
  }).join('');

  // Kick off side data loads (don't block landing render on them)
  loadDashboardSideData();
}

// ── Dashboard side data: stats, top products, appointments ──────────────────
async function loadDashboardSideData() {
  // Resolve open apparel + footwear seasons (the stats reference these)
  const openSeasons = (await supa.from('seasons')
    .select('season_id, category')
    .eq('status', 'active')).data || [];
  const openApparelSeason  = (openSeasons.find(s => s.category === 'apparel')  || {}).season_id || null;
  const openFootwearSeason = (openSeasons.find(s => s.category === 'footwear') || {}).season_id || null;

  // Fire requests in parallel
  const [apptsRes, fwOrdersRes, apOrdersRes, topProductsRes, appt5Res, milestoneRes] = await Promise.all([
    appointmentsThisWeek(),
    countSubmittedFootwearOrders(openFootwearSeason),
    countSubmittedApparelOrders(openApparelSeason),
    fetchTopProducts(openApparelSeason, openFootwearSeason),
    fetchNextAppointments(5),
    fetchNextMilestone()
  ]);

  // Stats
  setText('stat-appts', apptsRes.count);
  setText('stat-appts-sub', apptsRes.sub);
  setText('stat-fw-orders', fwOrdersRes.count);
  setText('stat-fw-orders-sub', fwOrdersRes.sub);
  setText('stat-ap-orders', apOrdersRes.count);
  setText('stat-ap-orders-sub', apOrdersRes.sub);
  renderNextMilestone(milestoneRes);

  // Top products: server-side RPC returns rows already aggregated and
  // ranked. Re-shape into the { apparel: [], footwear: [] } shape the
  // renderer expects.
  window._dashTopProducts = { apparel: [], footwear: [] };
  (topProductsRes || []).forEach(r => {
    const list = window._dashTopProducts[r.category];
    if (!list) return;
    list.push({
      name:  r.product_name || '(unnamed)',
      sub:   r.colour || '',
      sku:   r.sku || '',
      units: Number(r.units || 0)
    });
  });
  renderTopProducts('apparel');

  // Appointments
  renderNextAppointments(appt5Res);
}

async function appointmentsThisWeek() {
  const today = new Date();
  const weekStart = new Date(today); weekStart.setHours(0,0,0,0);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);
  const res = await supa.from('appointment_bookings')
    .select('id', { count: 'exact', head: true })
    .gte('date', weekStart.toISOString().slice(0, 10))
    .lt('date',  weekEnd.toISOString().slice(0, 10));
  return { count: res.count || 0, sub: 'Across the team' };
}

async function countSubmittedFootwearOrders(seasonId) {
  if (!seasonId) return { count: 0, sub: 'No open footwear season' };
  // footwear_drafts.status = 'submitted' marks a confirmed order
  const res = await supa.from('footwear_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('season_id', seasonId)
    .eq('status', 'submitted');
  return { count: res.count || 0, sub: seasonId + ' season' };
}

async function countSubmittedApparelOrders(seasonId) {
  if (!seasonId) return { count: 0, sub: 'No open apparel season' };
  // The apparel form writes confirmed orders to the orders table.
  const res = await supa.from('orders')
    .select('order_id', { count: 'exact', head: true })
    .eq('season_id', seasonId);
  return { count: res.count || 0, sub: seasonId + ' season' };
}

// Server-side aggregation via the get_top_products_by_season RPC.
// Returns rows: { category, rank, sku, product_name, colour, units }.
// Falls back to an empty array on RPC failure so the panel just renders
// the "No submitted orders yet" empty state instead of breaking.
async function fetchTopProducts(openApparelSeason, openFootwearSeason) {
  if (!openApparelSeason && !openFootwearSeason) return [];
  const res = await supa.rpc('get_top_products_by_season', {
    p_apparel_season:  openApparelSeason  || '__none__',
    p_footwear_season: openFootwearSeason || '__none__',
    p_limit:           10
  });
  if (res.error) {
    console.warn('Top products RPC failed:', res.error);
    return [];
  }
  return res.data || [];
}

function renderTopProducts(cat) {
  const list = document.getElementById('prod-list');
  if (!list) return;
  const top = (window._dashTopProducts && window._dashTopProducts[cat]) || [];
  if (!top.length) {
    list.innerHTML = '<div class="dash-empty">No submitted orders yet.</div>';
    return;
  }
  const PRODUCT_IMG_BASE = 'https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/product-images/';
  list.innerHTML = top.map((p, i) => {
    const imgUrl = p.sku ? PRODUCT_IMG_BASE + 'FJ_' + encodeURIComponent(p.sku) + '_01.jpg' : '';
    return `
    <div class="dash-prow">
      <div class="dash-prank">${i + 1}</div>
      <div class="dash-pthumb">
        ${imgUrl ? `<img src="${escapeAttr(imgUrl)}" alt="" data-img-fallback="product">` : ''}
      </div>
      <div>
        <div class="dash-pname">${escapeHtml(p.name || '(unnamed)')}</div>
        <div class="dash-psub">${p.sub ? escapeHtml(p.sub) + ' &middot; ' : ''}SKU ${escapeHtml(p.sku || '-')}</div>
      </div>
      <div class="dash-punits">${p.units.toLocaleString()}<small>Units</small></div>
    </div>`;
  }).join('');
}

async function fetchNextAppointments(n) {
  // DB07 — filter to the rep's own bookings (admins/managers see everyone).
  // RLS may already enforce this server-side, but mirroring it client-side
  // tightens the cross-rep PII bound on the home dashboard.
  const today = new Date().toISOString().slice(0, 10);
  const u = currentUser || {};
  const isAdmin = u.role === 'admin';
  let q = supa.from('appointment_bookings')
    .select('id, date, start_time, end_time, customer_name, am_name, location, account_code')
    .gte('date', today)
    .order('date', { ascending: true })
    .order('start_time', { ascending: true })
    .limit(n);
  if (!isAdmin && u.name) q = q.eq('am_name', u.name);
  const res = await q;
  const rows = res.data || [];

  // Enrich each row with its customer's account_name so the dashboard can
  // show "Lenny Good · ABC Golf Club" rather than just the contact name.
  // A second round-trip beats a PostgREST embed here because we don't rely
  // on a formally-declared foreign key between the two tables.
  const codes = Array.from(new Set(rows.map(r => r.account_code).filter(Boolean)));
  if (codes.length > 0) {
    const { data: custs } = await supa
      .from('customers')
      .select('account_code, account_name')
      .in('account_code', codes);
    const nameByCode = {};
    (custs || []).forEach(c => { nameByCode[c.account_code] = c.account_name; });
    rows.forEach(r => {
      if (r.account_code && nameByCode[r.account_code]) {
        r.account_name = nameByCode[r.account_code];
      }
    });
  }
  return rows;
}

function renderNextAppointments(rows) {
  const el = document.getElementById('appts-list');
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="dash-empty">No upcoming appointments.</div>';
    return;
  }
  const fmtDay = d => new Date(d).toLocaleDateString('en-AU', { day: '2-digit' });
  const fmtMon = d => new Date(d).toLocaleDateString('en-AU', { month: 'short' });
  const fmtTime = t => {
    if (!t) return '';
    const [h, m] = t.split(':');
    const hh = parseInt(h, 10);
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const hh12 = ((hh + 11) % 12) + 1;
    return hh12 + ':' + m + ' ' + ampm;
  };
  el.innerHTML = rows.map(r => {
    const contact = escapeHtml(r.customer_name || '-');
    const account = r.account_name ? ' &middot; ' + escapeHtml(r.account_name) : '';
    return `
    <div class="dash-appt">
      <div class="dash-appt-date">
        <div class="dash-appt-day">${fmtDay(r.date)}</div>
        <div class="dash-appt-month">${fmtMon(r.date)}</div>
      </div>
      <div>
        <div class="dash-appt-name">${contact}${account}</div>
        <div class="dash-appt-meta">${escapeHtml(r.am_name || '')}${r.location ? ' &middot; ' + escapeHtml(r.location) : ''}</div>
      </div>
      <div class="dash-appt-time">${fmtTime(r.start_time)}<small>${escapeHtml(r.location || '')}</small></div>
    </div>`;
  }).join('');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ── Next milestone (admin-managed) ─────────────────────────────────────────
async function fetchNextMilestone() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await supa.from('milestones')
    .select('milestone_date, title, description, season_id')
    .eq('status', 'active')
    .gte('milestone_date', today)
    .order('milestone_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (res && res.data) || null;
}

function renderNextMilestone(m) {
  if (!m) {
    setText('stat-milestone', 'Coming soon');
    setText('stat-milestone-date', '');
    setText('stat-milestone-sub', 'Set a milestone in Admin / Settings to highlight an upcoming deadline.');
    return;
  }
  setText('stat-milestone', m.title || '(untitled milestone)');
  // Compact date shown next to the "Next milestone" label (e.g. 14 Jun)
  const dateChip = m.milestone_date
    ? new Date(m.milestone_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
    : '';
  setText('stat-milestone-date', dateChip);
  // Days remaining for the sub line
  let daysLine = '';
  if (m.milestone_date) {
    const diffMs = new Date(m.milestone_date) - new Date(new Date().toISOString().slice(0, 10));
    const days = Math.max(0, Math.round(diffMs / 86400000));
    if (days === 0) daysLine = ' · Today';
    else if (days === 1) daysLine = ' · Tomorrow';
    else daysLine = ' · ' + days + ' days to go';
  }
  setText('stat-milestone-sub', (m.description || '') + daysLine);
}

// Toggle the dash season card's drafts accordion.
function toggleDashDrafts(seasonId) {
  const card = document.getElementById('dash-scard-' + seasonId);
  if (card) card.classList.toggle('open');
}

// ── Home-screen hamburger menu ─────────────────────────────────────────────
function toggleDashMenu() {
  const menu = document.getElementById('dash-menu');
  const btn  = document.getElementById('dash-menu-btn');
  if (!menu || !btn) return;
  if (menu.hidden) {
    populateDashMenu();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  } else {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
}
function closeDashMenu() {
  const menu = document.getElementById('dash-menu');
  const btn  = document.getElementById('dash-menu-btn');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
function populateDashMenu() {
  const u = currentUser || {};
  const nameEl  = document.getElementById('dash-menu-profile-name');
  const emailEl = document.getElementById('dash-menu-profile-email');
  const adminEl = document.getElementById('dash-menu-admin');
  if (nameEl)  nameEl.textContent  = u.name ? 'Signed in as ' + u.name : 'Signed in';
  if (emailEl) emailEl.textContent = u.email || '-';
  if (adminEl) adminEl.hidden = !(u.role === 'admin');
}
// Close on outside click.
document.addEventListener('click', function (ev) {
  const menu = document.getElementById('dash-menu');
  if (!menu || menu.hidden) return;
  if (ev.target.closest('#dash-menu') || ev.target.closest('#dash-menu-btn')) return;
  closeDashMenu();
});
// Close on Escape.
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') closeDashMenu();
});

// Apparel / Footwear toggle for the Top 10 Products panel.
document.addEventListener('click', function (ev) {
  const btn = ev.target.closest('#prod-toggle button[data-cat]');
  if (!btn) return;
  document.querySelectorAll('#prod-toggle button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderTopProducts(btn.dataset.cat);
});

function toggleDraftList(seasonId) {
  const list = document.getElementById('draft-list-' + seasonId);
  const arrow = document.getElementById('draft-arrow-' + seasonId);
  if (list) list.classList.toggle('open');
  if (arrow) arrow.classList.toggle('open');
}

function openDraftFromLanding(token, category) {
  // Each form lives in its own subfolder. The draft hash is the same
  // shape (#draft=<token>) for both; each form looks up the token in
  // its own table (draft_orders for apparel, footwear_drafts for
  // footwear). Auth carries over via the shared Supabase session.
  const target = (category || '').toLowerCase() === 'footwear'
    ? 'footwear/index.html'
    : 'apparel/index.html';
  window.location.assign(target + '#draft=' + encodeURIComponent(token) + '&from=dashboard');
}

function confirmDeleteDraft(token, accountName, category) {
  const overlay = document.createElement('div');
  overlay.className = 'draft-delete-overlay';
  overlay.innerHTML = `
    <div class="draft-delete-modal">
      <h3>Delete Draft</h3>
      <p>Are you sure you want to delete the draft order for <strong style="color:#fff">${escapeHtml(accountName)}</strong>? This cannot be undone.</p>
      <div class="draft-delete-actions">
        <button class="btn-delete-cancel" data-action="closeDraftDeleteOverlay">Cancel</button>
        <button class="btn-delete-confirm" data-action="executeDraftDelete" data-token="${token}" data-category="${escapeAttr(category || 'apparel')}">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function executeDraftDelete(token, btnEl) {
  btnEl.textContent = 'Deleting…';
  btnEl.disabled = true;
  const category = (btnEl.dataset.category || 'apparel').toLowerCase();
  let error;
  if (category === 'footwear') {
    ({ error } = await supa.from('footwear_drafts').delete().eq('share_token', token));
  } else {
    ({ error } = await supa.from('draft_orders').delete().eq('token', token));
  }
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
  // The root is now a pure router: every season hands off to its own form.
  // Auth carries over via the shared Supabase session on the same domain,
  // so each form's checkExistingSession picks up the user without a second
  // login.
  const target = (category || '').toLowerCase() === 'footwear'
    ? 'footwear/index.html'
    : 'apparel/index.html';
  window.location.href = target + '#season=' + encodeURIComponent(seasonId);
}


// ═══════════════════════════════════════════════════════════════════════════════
// EVENT DELEGATION (landing actions only; the apparel form has its own
// dispatcher inside apparel/index-app.js)
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('click', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;

  // Some draft-list actions sit inside a clickable card; stop the bubble so
  // the parent does not also handle the click.
  if (['openDraftFromLanding','confirmDeleteDraft','toggleDraftList'].includes(a)) {
    e.stopPropagation();
  }

  if      (a === 'openDraftFromLanding')    openDraftFromLanding(el.dataset.token, el.dataset.category);
  else if (a === 'confirmDeleteDraft')      confirmDeleteDraft(el.dataset.token, el.dataset.account, el.dataset.category);
  else if (a === 'toggleDashDrafts')        toggleDashDrafts(el.dataset.id);
  else if (a === 'toggleDashMenu')          toggleDashMenu();
  else if (a === 'toggleDraftList')         toggleDraftList(el.dataset.id);
  else if (a === 'selectSeason')            selectSeason(el.dataset.id, el.dataset.category);
  else if (a === 'executeDraftDelete')      executeDraftDelete(el.dataset.token, el);
  else if (a === 'closeDraftDeleteOverlay') el.closest('.draft-delete-overlay').remove();
  else if (a === 'signOut')                 signOut();
});

// ─── Image error fallback (season cards on the landing) ────────────────────
document.addEventListener('error', function(e) {
  if (e.target.tagName !== 'IMG') return;
  var fb = e.target.dataset.imgFallback;
  if (!fb) return;
  e.target.removeAttribute('data-img-fallback'); // prevent infinite loop
  if (fb === 'season') {
    e.target.style.background = '#1f2937';
    e.target.style.minHeight = '200px';
    e.target.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  } else if (fb === 'hide') {
    e.target.style.display = 'none';
  }
}, true); // capture phase so it fires for img errors

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
