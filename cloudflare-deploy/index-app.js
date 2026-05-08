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
            window.currentUser = {
              name: sp.name || '', email: sp.email || userEmail,
              role: sp.role || 'rep', country: sp.country || null
            };
          }
          screen.style.display = 'none';
        } else {
          await loginWithSession(session);
        }
      } else if (!isDraftLink) {
        emailEl.focus();
      }
    } finally {
      // Signal to init() that session check is complete
      _sessionReady();
    }
  }

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

    window.currentUser = {
      name:    sp.name || '',
      email:   sp.email || userEmail,
      role:    sp.role || 'rep',
      country: sp.country || null
    };

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
  window.currentUser = null;
  // Hide landing + app, show login screen
  const landing = document.getElementById('season-landing');
  if (landing) { landing.style.display = 'none'; }
  document.getElementById('app-header').style.display = 'none';
  document.getElementById('app-main').style.display = 'none';
  document.getElementById('app-footer').style.display = 'none';
  const login = document.getElementById('login-screen');
  login.classList.remove('fade-out');
  login.style.display = '';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').textContent = '';
  document.getElementById('login-email').focus();
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

  // Apparel needs JS-side filtering to the current user (RLS on
  // draft_orders is open to all authenticated). Footwear is already
  // filtered by RLS so we render whatever comes back.
  const cu = window.currentUser || {};
  const isAdminUser = (cu.role === 'admin');
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
            <div class="season-draft-info" data-action="openDraftFromLanding" data-token="${d.token}" data-category="${escapeAttr(d.category || 'apparel')}">
              <div class="season-draft-acct">${escapeHtml(d.account)}</div>
              <div class="season-draft-detail">${d.units} units &middot; ${mod}</div>
            </div>
            <button class="season-draft-delete" data-action="confirmDeleteDraft" data-token="${d.token}" data-account="${escapeAttr(d.account)}" data-category="${escapeAttr(d.category || 'apparel')}" title="Delete draft">&times;</button>
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
