// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════
// TEAM_PIN removed -- now using Supabase Auth (email/password)
const SB_URL          = window.__SUPABASE_CONFIG.url;
// Key loaded from server-side config (/supabase-config)
const SB_KEY          = window.__SUPABASE_CONFIG.key;
// Email via Supabase Edge Function (API key stored server-side)
const EMAIL_EDGE_FN = SB_URL + '/functions/v1/send-order-email';

const sb = window.supabase.createClient(SB_URL, SB_KEY);

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
let me = { name: '', email: '' };
let slots          = [];
let bookings       = [];
let customers      = [];
let templates      = [];
let calDate        = new Date();
let calSelDate     = null;
let slotFilter     = 'all';
let inviteSelCust  = null;
let custMatches    = [];
let invitePreSlot  = null;
let quickSelCust   = null;
let quickMatches   = [];
let selectedTplId  = null;

// ═══════════════════════════════════════════════
// BACK TO PREBOOK — Supabase Auth session is shared via
// localStorage, so no credentials needed in the URL.
// ═══════════════════════════════════════════════
function goBackToPrebook(ev) {
  if (ev) ev.preventDefault();
  window.location.href = 'index.html?from=diary';
}

// ═══════════════════════════════════════════════
// SSO BYPASS — when launched from the prebook landing page,
// the Supabase Auth session is shared via localStorage,
// so we resolve the user from the session (no credentials in URL).
// ═══════════════════════════════════════════════
(async function bypassFromPrebook() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('from') !== 'prebook') return;

  // Clean credentials from URL (strip query params from address bar)
  if (window.history.replaceState) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  // Resolve user from shared Supabase Auth session
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return; // no session -- fall through to normal login screen

  const userEmail = session.user.email;
  const { data: sp } = await sb.from('salespeople').select('name, email, role, country').eq('email', userEmail).single();
  if (!sp) return; // no salesperson record -- fall through to login

  // Hide login screen, set identity, render
  window._diaryBypassActive = true;
  document.getElementById('login-screen').style.display = 'none';
  me = { name: sp.name, email: sp.email };

  document.getElementById('app').style.display = 'block';
  const initials = sp.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  const initEl = document.getElementById('sb-initials');
  const nameEl = document.getElementById('sb-name');
  if (initEl) initEl.textContent = initials;
  if (nameEl) nameEl.textContent = sp.name;

  // Defer data load until the rest of the script has parsed
  setTimeout(() => {
    if (typeof loadData === 'function')      loadData();
    if (typeof loadCustomers === 'function') loadCustomers();
  }, 0);
})();

// ═══════════════════════════════════════════════
// SUPABASE AUTH LOGIN
// ═══════════════════════════════════════════════
(function initAuthLogin() {
  const form    = document.getElementById('login-form');
  const emailEl = document.getElementById('login-email');
  const passEl  = document.getElementById('login-password');
  const forgotEl= document.getElementById('login-forgot');
  const errEl   = document.getElementById('login-error');

  // Check for existing session on page load (skip if SSO bypass already handled login).
  // Login screen is hidden by default; only reveal it if there's no usable session,
  // so users coming from the home screen go straight to the diary without a flash.
  async function checkExistingSession() {
    if (window._diaryBypassActive) return;
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      await loginWithSession(session);
    } else {
      document.getElementById('login-screen').classList.add('visible');
      emailEl.focus();
    }
  }

  // Resolve authenticated user to salesperson record
  async function loginWithSession(session) {
    const userEmail = session.user.email;
    const { data: sp, error } = await sb
      .from('salespeople').select('*').eq('email', userEmail).single();

    if (error || !sp) {
      // Auth session exists but no salesperson record. Surface the login
      // screen so the error message is actually visible.
      document.getElementById('login-screen').classList.add('visible');
      errEl.textContent = 'Account not linked to a salesperson. Contact your admin.';
      await sb.auth.signOut();
      return;
    }

    me = { name: sp.name || '', email: sp.email || userEmail };

    document.getElementById('login-screen').classList.add('gone');
    document.getElementById('app').style.display = 'block';

    // Update sidebar AM card
    const initials = me.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    document.getElementById('sb-initials').textContent = initials;
    document.getElementById('sb-name').textContent     = me.name;

    loadData();
    loadCustomers();
  }

  // Sign in with email & password
  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!email || !password) return;

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    errEl.textContent = 'Signing in...';

    const { data, error } = await sb.auth.signInWithPassword({ email, password });

    if (error) {
      btn.disabled = false;
      errEl.textContent = error.message === 'Invalid login credentials'
        ? 'Incorrect email or password. Please try again.'
        : 'Sign-in failed. Please try again or contact support.';
      return;
    }

    await loginWithSession(data.session);
    btn.disabled = false;
  });

  // Forgot password
  forgotEl.addEventListener('click', async function(e) {
    e.preventDefault();
    const email = emailEl.value.trim();
    if (!email) {
      errEl.textContent = 'Enter your email address, then tap Forgot password.';
      return;
    }
    errEl.textContent = 'Sending reset link...';
    const { error } = await sb.auth.resetPasswordForEmail(email);
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

// Legacy enterApp kept as no-op for any stray references
function enterApp() {}

// ═══════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════
async function loadData() {
  const [{ data: sd }, { data: bd }] = await Promise.all([
    sb.from('appointment_slots').select('*').eq('am_name', me.name).order('date').order('start_time'),
    sb.from('appointment_bookings').select('*').eq('am_name', me.name).order('date').order('start_time')
  ]);
  slots    = sd || [];
  bookings = bd || [];
  renderCal();
  renderSlots();
  renderBookings();
  renderSidebarMetrics();
  renderSidebarBookings();
  // Default the day-pane to today on first load so the user lands on a
  // populated timeline rather than the "Select a date" empty state.
  if (!calSelDate) {
    selectDay(new Date().toISOString().slice(0, 10));
  }
  await loadTemplates();
}

async function loadTemplates() {
  const { data, error } = await sb.from('email_templates').select('*').order('created_at');
  if (error) {
    toast('Could not load email templates. Please refresh and try again.', 'error');
  }
  templates = data || [];
  // Templates are now edited in the admin portal; the diary only needs
  // the loaded list to populate the Send Invitation picker (rendered
  // on demand by renderTemplatePicker when the invite modal opens).
}

async function loadCustomers() {
  const { data } = await sb.from('customers').select('account_code,account_name,contact_first,contact_last,contact_email').order('account_name');
  customers = data || [];
}

// ═══════════════════════════════════════════════
// SIDEBAR METRICS + BOOKINGS
// ═══════════════════════════════════════════════
function renderSidebarMetrics() {
  const y = calDate.getFullYear();
  const m = calDate.getMonth();
  const monthSlots = slots.filter(s => {
    const [sy, sm] = s.date.split('-').map(Number);
    return sy === y && sm - 1 === m;
  });
  const total   = monthSlots.length;
  const booked  = monthSlots.filter(s => s.status === 'booked').length;
  const avail   = monthSlots.filter(s => s.status === 'available').length;
  const cancel  = monthSlots.filter(s => s.status === 'cancelled').length;

  const mn = calDate.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
  document.getElementById('sb-month-label').textContent = mn;
  document.getElementById('m-total').textContent  = total;
  document.getElementById('m-booked').textContent = booked;
  document.getElementById('m-avail').textContent  = avail;
  document.getElementById('m-cancel').textContent = cancel;

  // Quick-stats bar was removed from the calendar view — guard the writes
  // so older code doesn't throw when the elements aren't in the DOM.
  const qConf   = document.getElementById('qs-conf');
  const qAvail  = document.getElementById('qs-avail');
  const qCancel = document.getElementById('qs-cancel');
  if (qConf)   qConf.textContent   = booked;
  if (qAvail)  qAvail.textContent  = avail;
  if (qCancel) qCancel.textContent = cancel;
}

function renderSidebarBookings() {
  const el    = document.getElementById('sb-bookings-list');
  const today = new Date().toISOString().slice(0,10);
  const upcoming = bookings
    .filter(b => b.status === 'confirmed' && b.date >= today)
    .slice(0, 6);

  let html = '<div class="sb-section-head">Upcoming Bookings</div>';
  if (upcoming.length === 0) {
    html += '<div style="text-align:center;padding:16px 0;color:rgba(255,255,255,0.22);font-size:11px">No upcoming bookings.</div>';
  } else {
    upcoming.forEach(b => {
      const d  = new Date(b.date + 'T00:00:00');
      const dl = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      html += `<div class="sb-bk-item confirmed" data-action="showDetail" data-id="${b.id}">
        <div class="sb-bk-time">${fmt(b.start_time)}</div>
        <div class="sb-bk-body">
          <div class="sb-bk-cust">${escHtml(b.customer_name)}</div>
          <div class="sb-bk-meta">${dl}${b.location ? ' - ' + escHtml(b.location) : ''}</div>
        </div>
        <div class="sb-bk-badge confirmed">Conf</div>
      </div>`;
    });
  }

  // Show available slots too (those without bookings)
  const availSlots = slots.filter(s => s.status === 'available' && s.date >= today).slice(0, 3);
  if (availSlots.length > 0) {
    html += '<div class="sb-section-head" style="margin-top:12px">Open Slots</div>';
    availSlots.forEach(s => {
      const d  = new Date(s.date + 'T00:00:00');
      const dl = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      html += `<div class="sb-bk-item avail" data-action="openInvite" data-id="${s.id}">
        <div class="sb-bk-time">${fmt(s.start_time)}</div>
        <div class="sb-bk-body">
          <div class="sb-bk-cust">Available slot</div>
          <div class="sb-bk-meta">${dl}${s.location ? ' - ' + escHtml(s.location) : ''}</div>
        </div>
        <div class="sb-bk-badge avail">Open</div>
      </div>`;
    });
  }

  el.innerHTML = html;
}

// ═══════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════
function switchTab(name, btn) {
  ['calendar','slots','bookings'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = (t === name) ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  // (Calendar nav buttons now live inside the calendar card itself,
  // so they hide/show automatically with the tab.)

  const labels = { calendar: 'Calendar', slots: 'Manage Slots', bookings: 'Confirmed Bookings' };
  document.getElementById('topbar-title').textContent = labels[name] || '';
}

// ═══════════════════════════════════════════════
// CALENDAR (MONTH VIEW)
// ═══════════════════════════════════════════════
function moveMonth(d) {
  calDate.setMonth(calDate.getMonth() + d);
  renderCal();
  renderSidebarMetrics();
}

function goToday() {
  calDate = new Date();
  const key = new Date().toISOString().slice(0,10);
  calSelDate = key;
  renderCal();
  renderSidebarMetrics();
  selectDay(key);
}

function renderCal() {
  const today = new Date();
  const y = calDate.getFullYear();
  const m = calDate.getMonth();

  const monthName = calDate.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
  document.getElementById('cal-card-title').textContent = monthName;
  document.getElementById('topbar-title').textContent   =
    document.querySelector('.tab-btn.active')?.textContent || 'Calendar';

  // Count bookings for subtitle
  const bookedThisMonth = bookings.filter(b => {
    const [by, bm] = b.date.split('-').map(Number);
    return by === y && bm - 1 === m && b.status === 'confirmed';
  }).length;
  document.getElementById('cal-card-sub').textContent =
    `${bookedThisMonth} confirmed booking${bookedThisMonth !== 1 ? 's' : ''} this month - click a date to view details`;

  const firstDOW = new Date(y, m, 1).getDay();
  const leadDays = (firstDOW + 6) % 7; // Mon-based
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays    = new Date(y, m, 0).getDate();

  const body = document.getElementById('cal-body');
  body.innerHTML = '';

  const toKey = (yr, mo, dy) =>
    `${yr}-${String(mo+1).padStart(2,'0')}-${String(dy).padStart(2,'0')}`;

  // Leading cells (prev month)
  for (let i = leadDays - 1; i >= 0; i--) {
    const cell = document.createElement('div');
    cell.className = 'cal-day other-month';
    cell.innerHTML = `<div class="day-num">${prevDays - i}</div>`;
    body.appendChild(cell);
  }

  // This month
  for (let d = 1; d <= daysInMonth; d++) {
    const key    = toKey(y, m, d);
    const isTd   = today.getFullYear()===y && today.getMonth()===m && today.getDate()===d;
    const isSel  = calSelDate === key;
    const daySlots = slots.filter(s => s.date === key && s.status !== 'cancelled');

    const cell = document.createElement('div');
    cell.className = 'cal-day' +
      (isTd  ? ' today'    : '') +
      (isSel ? ' selected' : '');
    cell.onclick = () => selectDay(key);

    // Day number
    const num = document.createElement('div');
    num.className = 'day-num';
    num.textContent = d;
    cell.appendChild(num);

    // Chips
    if (daySlots.length > 0) {
      const chipsDiv = document.createElement('div');
      chipsDiv.className = 'day-chips';
      daySlots.slice(0, 2).forEach(s => {
        const chip = document.createElement('div');
        chip.className = `day-chip ${s.status}`;

        const bk = (s.status === 'booked')
          ? bookings.find(b => b.slot_id === s.id && b.status === 'confirmed')
          : null;

        const timeEl = document.createElement('div');
        timeEl.className = 'day-chip-time';
        timeEl.textContent = fmt(s.start_time);
        chip.appendChild(timeEl);

        const mainEl = document.createElement('div');
        mainEl.className = 'day-chip-text';
        mainEl.textContent = bk
          ? (bk.customer_name || 'Booked')
          : (s.status === 'booked' ? 'Booked' : 'Available');
        chip.appendChild(mainEl);

        if (s.location) {
          const locEl = document.createElement('div');
          locEl.className = 'day-chip-loc';
          locEl.textContent = s.location;
          chip.appendChild(locEl);
        }

        // Hover popup with full details
        chip.addEventListener('mouseenter', e => showChipPopup(e.currentTarget, s, bk));
        chip.addEventListener('mouseleave', hideChipPopup);

        chipsDiv.appendChild(chip);
      });
      if (daySlots.length > 2) {
        const more = document.createElement('div');
        more.className = 'day-more';
        more.textContent = `+${daySlots.length - 2} more`;
        chipsDiv.appendChild(more);
      }
      cell.appendChild(chipsDiv);
    }

    body.appendChild(cell);
  }

  // Trailing cells
  const total    = leadDays + daysInMonth;
  const trailing = (7 - (total % 7)) % 7;
  for (let d = 1; d <= trailing; d++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day other-month';
    cell.innerHTML = `<div class="day-num">${d}</div>`;
    body.appendChild(cell);
  }
}

// Hours to render in the day timeline (8 AM through 5 PM).
const TIMELINE_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
function timelineHourLabel(h) {
  if (h === 12) return '12 PM';
  if (h > 12)   return (h - 12) + ' PM';
  return h + ' AM';
}
function statusClass(status) {
  return status === 'booked' ? 'booked' : 'avail';
}
function durationMin(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

function selectDay(key) {
  calSelDate = key;
  renderCal();

  const d         = new Date(key + 'T00:00:00');
  const fullLbl   = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const eyebrow   = d.toLocaleDateString('en-AU', { weekday: 'long' })
                  + ' · '
                  + d.toLocaleDateString('en-AU', { month: 'short' });
  const todayKey  = new Date().toISOString().slice(0, 10);
  const isPast    = key < todayKey;

  const daySlots = slots
    .filter(s => s.date === key && s.status !== 'cancelled')
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  const confirmed = daySlots.filter(s => s.status === 'booked').length;
  const available = daySlots.filter(s => s.status === 'available').length;

  document.getElementById('detail-day-title').textContent = fullLbl;
  document.getElementById('detail-day-sub').textContent   = eyebrow;

  // Build the hour-by-hour timeline. Each row is keyed to a wall-clock
  // hour. Slots that start within that hour stack inside the row's
  // content column. Hours with no slot show a "+ Add slot" placeholder
  // (or a dimmed dash for past dates).
  const slotsByHour = {};
  TIMELINE_HOURS.forEach(h => slotsByHour[h] = []);
  daySlots.forEach(s => {
    const h = parseInt(s.start_time.split(':')[0], 10);
    if (slotsByHour[h]) slotsByHour[h].push(s);
    else {
      // Out-of-range slot (e.g. 7 AM or 7 PM): tack onto nearest bound.
      const target = h < TIMELINE_HOURS[0] ? TIMELINE_HOURS[0]
                   : TIMELINE_HOURS[TIMELINE_HOURS.length - 1];
      slotsByHour[target].push(s);
    }
  });

  const summary = daySlots.length === 0
    ? 'No slots yet on this day'
    : `${confirmed} confirmed${available ? ' · ' + available + ' available' : ''}`;

  let html = `<div class="ddp-meta-line">${summary}</div>`;
  html += '<div class="ddp-timeline">';

  TIMELINE_HOURS.forEach(hour => {
    const inHour = slotsByHour[hour];
    let inner;
    if (inHour.length === 0) {
      inner = isPast
        ? '<div class="ddp-row-empty disabled">&mdash;</div>'
        : `<div class="ddp-row-empty" data-action="openCreateSlotAt" data-date="${key}" data-hour="${hour}">+ Add slot</div>`;
    } else {
      inner = inHour.map(s => {
        const bk = s.status === 'booked'
          ? bookings.find(b => b.slot_id === s.id && b.status === 'confirmed')
          : null;
        const cls   = statusClass(s.status);
        const title = bk ? escHtml(bk.customer_name)
                         : (s.location ? escHtml(s.location) : 'Available');
        const dur   = durationMin(s.start_time, s.end_time);
        const isOnHour = /:00$/.test(s.start_time);
        const metaParts = [];
        if (!isOnHour) metaParts.push(fmt(s.start_time));
        if (bk) {
          if (bk.customer_email) metaParts.push(escHtml(bk.customer_email));
          if (s.location)        metaParts.push(escHtml(s.location));
        } else if (s.location && !isOnHour) {
          metaParts.push(escHtml(s.location));
        }
        if (dur) metaParts.push(dur + ' min');
        const meta = metaParts.join(' · ');
        const status = bk
          ? '<div class="ds-status booked">● Confirmed</div>'
          : '<div class="ds-status avail">No invitation sent yet</div>';
        const action = bk
          ? `data-action="showDetail" data-id="${bk.id}"`
          : `data-action="openInvite" data-id="${s.id}"`;
        return `<div class="detail-slot timeline ${cls}" ${action}>
          <div class="ds-bar ${cls}"></div>
          <div class="ds-body">
            <div class="ds-name">${title}</div>
            ${meta ? `<div class="ds-meta">${meta}</div>` : ''}
            ${status}
          </div>
        </div>`;
      }).join('');
    }
    html += `<div class="ddp-row">
      <div class="ddp-hour">${timelineHourLabel(hour)}</div>
      <div class="ddp-row-content">${inner}</div>
    </div>`;
  });

  html += '</div>';
  document.getElementById('day-detail-body').innerHTML = html;
}

// ═══════════════════════════════════════════════
// SLOT RENDERING
// ═══════════════════════════════════════════════
function setSlotFilter(f, btn) {
  slotFilter = f;
  document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  renderSlots();
}

function renderSlots() {
  const g = document.getElementById('slots-grid');
  let list = slots.filter(s => s.status !== 'cancelled');
  if (slotFilter === 'available') list = list.filter(s => s.status === 'available');
  if (slotFilter === 'booked')    list = list.filter(s => s.status === 'booked');
  if (list.length === 0) {
    g.innerHTML = `<div class="empty" style="grid-column:1/-1">
      <div class="empty-icon">&#128336;</div>
      <div class="empty-title">No slots yet</div>
      <div class="empty-desc">Create booking slots to start scheduling appointments.</div>
    </div>`;
    return;
  }
  g.innerHTML = list.map(s => slotCardHTML(s)).join('');
}

function slotCardHTML(slot) {
  const d  = new Date(slot.date + 'T00:00:00');
  const dl = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const bmap = { available:'badge-avail', booked:'badge-booked', cancelled:'badge-cancel' };
  const lmap = { available:'Available', booked:'Booked', cancelled:'Cancelled' };
  let actions = '';
  if (slot.status === 'available') {
    actions = `<button class="btn btn-gold btn-sm" data-action="openInvite" data-id="${slot.id}">Send Invite</button>
               <button class="btn btn-ghost btn-sm" data-action="doCancel" data-id="${slot.id}">Cancel</button>`;
  } else if (slot.status === 'booked') {
    const b = bookings.find(bk => bk.slot_id === slot.id && bk.status === 'confirmed');
    if (b) actions = `<button class="btn btn-ghost btn-sm" data-action="showDetail" data-id="${b.id}">View Booking</button>`;
  }
  return `<div class="slot-card ${slot.status}">
    <div class="slot-time">${fmt(slot.start_time)} &ndash; ${fmt(slot.end_time)}</div>
    <div class="slot-date">${dl}</div>
    ${slot.location ? `<div class="slot-loc">&#128205; ${escHtml(slot.location)}</div>` : ''}
    ${slot.notes    ? `<div class="slot-note">${escHtml(slot.notes)}</div>` : ''}
    <span class="slot-badge ${bmap[slot.status]}">${lmap[slot.status]}</span>
    <div class="slot-actions">${actions}</div>
  </div>`;
}

// ═══════════════════════════════════════════════
// BOOKINGS RENDERING
// ═══════════════════════════════════════════════
function renderBookings() {
  const el    = document.getElementById('bookings-list');
  const today = new Date().toISOString().slice(0,10);
  const twoDays = new Date(Date.now() + 2 * 86400000).toISOString().slice(0,10);
  const conf  = bookings.filter(b => b.status === 'confirmed');
  if (conf.length === 0) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">&#9989;</div>
      <div class="empty-title">No confirmed bookings yet</div>
      <div class="empty-desc">Bookings appear here once customers confirm their time slot.</div>
    </div>`;
    return;
  }
  el.innerHTML = conf.map(b => {
    const d  = new Date(b.date + 'T00:00:00');
    const dl = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const past    = b.date < today;
    const needRem = !past && b.date <= twoDays && !b.reminder_sent;
    return `<div class="booking-row${past ? ' past' : ''}">
      <div class="bk-icon">&#128100;</div>
      <div class="bk-info">
        <div class="bk-name">${escHtml(b.customer_name)}${b.account_code ? ` <span style="font-weight:400;font-size:11px;color:var(--muted)">${escHtml(b.account_code)}</span>` : ''}</div>
        <div class="bk-sub">${dl} &middot; ${fmt(b.start_time)} &ndash; ${fmt(b.end_time)}</div>
        ${b.location ? `<div class="bk-sub">&#128205; ${escHtml(b.location)}</div>` : ''}
        <div class="bk-sub">&#9993; ${escHtml(b.customer_email)}</div>
      </div>
      <div class="bk-right">
        <span class="bk-badge bk-confirm">Confirmed</span>
        ${needRem ? `<span class="remind-tag">Reminder soon</span>` : ''}
        <button class="btn btn-ghost btn-sm" data-action="showDetail" data-id="${b.id}">Details</button>
      </div>
    </div>`;
  }).join('');
}

function showDetail(bookingId) {
  const b = bookings.find(x => x.id === bookingId);
  if (!b) return;
  const d  = new Date(b.date + 'T00:00:00');
  const dl = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('detail-body').innerHTML = `
    <div style="display:grid;gap:16px">
      <div>
        <label>Customer</label>
        <div style="font-size:15px;font-weight:700">${escHtml(b.customer_name)}</div>
        ${b.account_code ? `<div style="font-size:12px;color:var(--muted)">${escHtml(b.account_code)}</div>` : ''}
        <div style="font-size:12px;color:var(--muted)">${escHtml(b.customer_email)}</div>
      </div>
      <div>
        <label>Date &amp; Time</label>
        <div style="font-size:14px;font-weight:600">${dl}</div>
        <div style="font-size:13px;color:var(--muted)">${fmt(b.start_time)} &ndash; ${fmt(b.end_time)}</div>
      </div>
      ${b.location ? `<div><label>Location</label><div style="font-size:13px">${escHtml(b.location)}</div></div>` : ''}
      ${b.notes    ? `<div><label>Notes</label><div style="font-size:13px;color:var(--muted)">${escHtml(b.notes)}</div></div>` : ''}
      <div style="padding:12px 14px;background:var(--off);border-radius:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-outline-gold btn-sm" data-action="dlICS" data-id="${b.id}">&#128197; Download .ics</button>
        <a class="btn btn-ghost btn-sm" href="${gcalLink(b)}" target="_blank" style="text-decoration:none">+ Google Calendar</a>
      </div>
    </div>`;
  const cancelBtn = document.getElementById('cancel-bk-btn');
  cancelBtn.onclick = null;
  cancelBtn.removeEventListener('click', cancelBtn._boundCancelHandler);
  cancelBtn._boundCancelHandler = () => cancelBooking(bookingId);
  cancelBtn.addEventListener('click', cancelBtn._boundCancelHandler);
  openM('m-detail');
}

// ═══════════════════════════════════════════════
// CREATE SLOT
// ═══════════════════════════════════════════════
function openCreateSlot(prefillDate, prefillStartHour) {
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('c-date').min   = today;
  document.getElementById('c-date').value = prefillDate || '';
  if (prefillStartHour !== undefined && prefillStartHour !== null && !Number.isNaN(prefillStartHour)) {
    const h = parseInt(prefillStartHour, 10);
    const pad = (n) => String(n).padStart(2, '0');
    document.getElementById('c-start').value = `${pad(h)}:00`;
    document.getElementById('c-end').value   = `${pad(Math.min(h + 1, 23))}:00`;
  } else {
    document.getElementById('c-start').value = '09:00';
    document.getElementById('c-end').value   = '10:00';
  }
  document.getElementById('c-loc').value   = '';
  document.getElementById('c-notes').value = '';
  openM('m-create');
}

async function saveSlot() {
  const date  = document.getElementById('c-date').value;
  const start = document.getElementById('c-start').value;
  const end   = document.getElementById('c-end').value;
  const loc   = document.getElementById('c-loc').value.trim();
  const notes = document.getElementById('c-notes').value.trim();
  if (!date || !start || !end) { toast('Date and times are required.', 'error'); return; }
  if (end <= start) { toast('End time must be after start time.', 'error'); return; }
  const { data, error } = await sb.from('appointment_slots').insert({
    am_name: me.name, am_email: me.email,
    date, start_time: start, end_time: end, location: loc, notes, status: 'available'
  }).select().single();
  if (error) { toast('Error saving slot. Please try again.', 'error'); return; }
  slots.push(data);
  slots.sort((a,b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
  closeM('m-create');
  renderCal(); renderSlots(); renderSidebarMetrics(); renderSidebarBookings();
  if (calSelDate === date) selectDay(date);
  toast('Slot created!', 'success');
}

async function doCancel(slotId) {
  if (!confirm('Cancel this slot? It will no longer be available for booking.')) return;
  const { error } = await sb.from('appointment_slots').update({ status: 'cancelled' }).eq('id', slotId);
  if (error) { toast('Error cancelling slot.', 'error'); return; }
  const s = slots.find(x => x.id === slotId);
  if (s) s.status = 'cancelled';
  renderCal(); renderSlots(); renderSidebarMetrics(); renderSidebarBookings();
  if (calSelDate) selectDay(calSelDate);
  toast('Slot cancelled.', 'success');
}

// ═══════════════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════════════
// Template editing (renderTemplates / openCreateTemplate / saveTemplate /
// deleteTemplate) moved to the admin portal under Settings -> Templates.
// The diary still loads the template list (loadTemplates above) so
// renderTemplatePicker below can populate the Send Invitation modal.

// Populate template picker inside the invite modal
function renderTemplatePicker() {
  // Treat is_active undefined/null as active. Only exclude when explicitly false.
  // (Defends against the column being missing in older email_templates schemas.)
  const active = templates.filter(t => t.is_active !== false);
  const picker = document.getElementById('tpl-picker');
  if (!picker) return;
  if (active.length === 0) {
    const msg = templates.length === 0
      ? 'No templates found. Create one in the admin portal under Settings -> Templates.'
      : 'All templates are marked inactive. Activate one in the admin portal under Settings -> Templates.';
    picker.innerHTML = `<div style="text-align:center;padding:14px;color:var(--muted);font-size:12px">${msg}</div>`;
    selectedTplId = null;
    return;
  }
  picker.innerHTML = active.map(t => `
    <label class="tpl-select-row${selectedTplId === t.id ? ' selected' : ''}" id="tpl-row-${t.id}">
      <input type="radio" name="tpl-sel" value="${t.id}" ${selectedTplId === t.id ? 'checked' : ''} data-action="tplSelect" data-tpl-id="${t.id}" data-index="${t.id}">
      <div class="tpl-select-name">${escHtml(t.name)}</div>
    </label>`).join('');

  // Auto-select first if nothing selected yet
  if (!selectedTplId && active.length > 0) {
    onTplSelect(active[0].id);
    picker.querySelector('input[type=radio]').checked = true;
  } else if (selectedTplId) {
    updateSubjectPreview();
  }
}

function onTplSelect(id) {
  selectedTplId = id;
  document.querySelectorAll('.tpl-select-row').forEach(r => r.classList.remove('selected'));
  const row = document.getElementById('tpl-row-' + id);
  if (row) row.classList.add('selected');
  updateSubjectPreview();
  renderInvitePreview();
}

function updateSubjectPreview() {
  const tpl = templates.find(t => t.id === selectedTplId);
  const preview = document.getElementById('tpl-subject-preview');
  const span    = document.getElementById('tpl-subject-text');
  if (tpl && preview && span) {
    span.textContent = tpl.email_subject;
    preview.style.display = 'block';
  } else if (preview) {
    preview.style.display = 'none';
  }
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function replacePlaceholders(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
}

// ═══════════════════════════════════════════════
// SEND INVITATION
// ═══════════════════════════════════════════════
function openInvite(slotId) {
  invitePreSlot = slotId;
  inviteSelCust = null;
  custMatches   = [];
  document.getElementById('cust-q').value               = '';
  document.getElementById('cust-results').style.display = 'none';
  document.getElementById('cust-sel-display').style.display = 'none';
  document.getElementById('inv-first').value            = '';
  document.getElementById('inv-last').value             = '';
  document.getElementById('inv-email').value            = '';
  document.getElementById('link-preview-wrap').style.display = 'none';
  renderTemplatePicker();

  // Pre-fill from quick search if customer was already selected there
  if (quickSelCust) {
    inviteSelCust = quickSelCust;
    document.getElementById('cust-q').value = quickSelCust.account_name;
    const full = [quickSelCust.contact_first, quickSelCust.contact_last].filter(Boolean).join(' ');
    const disp = document.getElementById('cust-sel-display');
    disp.innerHTML = `<strong>${escHtml(quickSelCust.account_name)}</strong> (${escHtml(quickSelCust.account_code)})${full ? ' &middot; ' + escHtml(full) : ''}`;
    disp.style.display = 'block';
    document.getElementById('inv-first').value = quickSelCust.contact_first || '';
    document.getElementById('inv-last').value  = quickSelCust.contact_last  || '';
    if (quickSelCust.contact_email) document.getElementById('inv-email').value = quickSelCust.contact_email;
  }

  const avail = slots.filter(s => s.status === 'available');
  const picker = document.getElementById('slot-picker');
  if (avail.length === 0) {
    picker.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:12px;text-align:center">No available slots. Create some first.</div>';
  } else {
    picker.innerHTML = avail.map(s => {
      const d  = new Date(s.date + 'T00:00:00');
      const dl = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      const chk = s.id === slotId ? 'checked' : '';
      return `<label class="sp-opt">
        <input type="checkbox" value="${s.id}" ${chk} data-action="updateSlotPreview">
        <div>
          <div class="sp-time">${fmt(s.start_time)} &ndash; ${fmt(s.end_time)}</div>
          <div class="sp-info">${dl}${s.location ? ' &middot; ' + escHtml(s.location) : ''}</div>
        </div>
      </label>`;
    }).join('');
  }
  previewLink();
  renderInvitePreview();
  openM('m-invite');
}

function openInviteFromQuick() {
  openInvite(null);
}

function custSearch(q) {
  const res = document.getElementById('cust-results');
  document.getElementById('cust-sel-display').style.display = 'none';
  inviteSelCust = null;
  if (!q || q.length < 2) { res.style.display = 'none'; return; }
  custMatches = customers.filter(c =>
    (c.account_name||'').toLowerCase().includes(q.toLowerCase()) ||
    (c.account_code||'').toLowerCase().includes(q.toLowerCase()) ||
    ((c.contact_first||'') + ' ' + (c.contact_last||'')).toLowerCase().includes(q.toLowerCase())
  ).slice(0, 8);
  if (custMatches.length === 0) { res.style.display = 'none'; return; }
  res.innerHTML = custMatches.map((c, i) => {
    const full = [c.contact_first, c.contact_last].filter(Boolean).join(' ');
    return `<div class="cust-opt" data-action="pickCust" data-index="${i}">
      <div class="cust-name">${escHtml(c.account_name)}</div>
      <div class="cust-sub">${escHtml(c.account_code)}${full ? ' &middot; ' + escHtml(full) : ''}${c.contact_email ? ' &middot; ' + escHtml(c.contact_email) : ''}</div>
    </div>`;
  }).join('');
  res.style.display = 'block';
}

function pickCust(idx) {
  inviteSelCust = custMatches[idx];
  document.getElementById('cust-results').style.display = 'none';
  document.getElementById('cust-q').value = inviteSelCust.account_name;
  const full = [inviteSelCust.contact_first, inviteSelCust.contact_last].filter(Boolean).join(' ');
  const disp = document.getElementById('cust-sel-display');
  disp.innerHTML = `<strong>${escHtml(inviteSelCust.account_name)}</strong> (${escHtml(inviteSelCust.account_code)})${full ? ' &middot; ' + escHtml(full) : ''}`;
  disp.style.display = 'block';
  document.getElementById('inv-first').value = inviteSelCust.contact_first || '';
  document.getElementById('inv-last').value  = inviteSelCust.contact_last  || '';
  if (inviteSelCust.contact_email) document.getElementById('inv-email').value = inviteSelCust.contact_email;
  renderInvitePreview();
}

// Quick search (sidebar invite shortcut)
function quickCustSearch(q) {
  const res = document.getElementById('quick-cust-results');
  document.getElementById('quick-cust-sel').style.display = 'none';
  quickSelCust = null;
  if (!q || q.length < 2) { res.style.display = 'none'; return; }
  quickMatches = customers.filter(c =>
    (c.account_name||'').toLowerCase().includes(q.toLowerCase()) ||
    (c.account_code||'').toLowerCase().includes(q.toLowerCase())
  ).slice(0, 6);
  if (quickMatches.length === 0) { res.style.display = 'none'; return; }
  res.innerHTML = quickMatches.map((c, i) => {
    const full = [c.contact_first, c.contact_last].filter(Boolean).join(' ');
    return `<div class="cust-opt" data-action="pickQuickCust" data-index="${i}">
      <div class="cust-name">${escHtml(c.account_name)}</div>
      <div class="cust-sub">${escHtml(c.account_code)}${full ? ' &middot; ' + escHtml(full) : ''}</div>
    </div>`;
  }).join('');
  res.style.display = 'block';
}

function pickQuickCust(idx) {
  quickSelCust = quickMatches[idx];
  document.getElementById('quick-cust-results').style.display = 'none';
  document.getElementById('quick-cust-q').value = quickSelCust.account_name;
  const full = [quickSelCust.contact_first, quickSelCust.contact_last].filter(Boolean).join(' ');
  const disp = document.getElementById('quick-cust-sel');
  disp.innerHTML = `<strong>${escHtml(quickSelCust.account_name)}</strong> (${escHtml(quickSelCust.account_code)})${full ? ' &middot; ' + escHtml(full) : ''}`;
  disp.style.display = 'block';
}

// Build the table rows for the invite email's slot list.
// Used by both the live preview (renderInvitePreview) and the real send.
function buildInviteSlotRows(offered) {
  return offered.map(s => {
    const d  = new Date(s.date + 'T00:00:00');
    const dl = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee">${dl}</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${fmt(s.start_time)}&ndash;${fmt(s.end_time)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${escHtml(s.location||'')}</td></tr>`;
  }).join('');
}

// Live render the email preview iframe + subject/to bar from current modal state.
function renderInvitePreview() {
  const iframe = document.getElementById('inv-email-iframe');
  if (!iframe) return; // older HTML without preview pane

  const tpl = templates.find(t => t.id === selectedTplId);
  const fname = (document.getElementById('inv-first')?.value || '').trim();
  const lname = (document.getElementById('inv-last')?.value  || '').trim();
  const custName = [fname, lname].filter(Boolean).join(' ')
    || (inviteSelCust ? inviteSelCust.account_name : 'Customer');
  const email = (document.getElementById('inv-email')?.value || '').trim()
    || (inviteSelCust?.contact_email || 'customer@example.com');

  // Subject + to line
  const subjectEl = document.getElementById('inv-preview-subject');
  const toEl      = document.getElementById('inv-preview-to');
  if (subjectEl) {
    subjectEl.textContent = tpl
      ? replacePlaceholders(tpl.email_subject || '', { customer_name: custName, am_name: me?.name || '' })
      : '(pick a template)';
  }
  if (toEl) toEl.textContent = email;

  // Selected slots
  const selIds = [...document.querySelectorAll('#slot-picker input[type=checkbox]:checked')].map(cb => cb.value);
  const offered = slots.filter(s => selIds.includes(s.id));
  let slotRows = buildInviteSlotRows(offered);
  if (!slotRows) {
    slotRows = `<tr><td colspan="3" style="padding:14px;color:#999;text-align:center;font-style:italic">No slots selected yet</td></tr>`;
  }

  const html = inviteEmailHTML(custName, me?.name || '', slotRows, '#preview', tpl);
  iframe.srcdoc = html;
}

function previewLink() {
  const chk  = [...document.querySelectorAll('#slot-picker input[type=checkbox]:checked')];
  const wrap = document.getElementById('link-preview-wrap');
  // Update the live email preview alongside the legacy link box.
  renderInvitePreview();
  if (!wrap) return;
  if (chk.length > 0) {
    const base = window.location.href.replace(/[^/]*$/, '') + 'booking.html';
    const linkEl = document.getElementById('link-preview');
    if (linkEl) linkEl.textContent = base + '?token=(generated when you click Send)';
    wrap.style.display = 'block';
  } else {
    wrap.style.display = 'none';
  }
}

async function sendInvite() {
  console.log('[diary] sendInvite click');
  const sendBtn = document.getElementById('m-invite-send');
  const email   = document.getElementById('inv-email').value.trim();
  const selIds  = [...document.querySelectorAll('#slot-picker input[type=checkbox]:checked')].map(cb => cb.value);
  const firstName = document.getElementById('inv-first').value.trim();
  const lastName  = document.getElementById('inv-last').value.trim();
  const custName  = [firstName, lastName].filter(Boolean).join(' ')
    || (inviteSelCust ? inviteSelCust.account_name : 'Valued Customer');

  const tpl = templates.find(t => t.id === selectedTplId);

  // Helper: inline banner inside the modal so the user always sees the
  // error even if the toast scrolls offscreen behind the modal.
  const banner = document.getElementById('m-invite-error') || (() => {
    const b = document.createElement('div');
    b.id = 'm-invite-error';
    b.style.cssText = 'margin:0 26px 12px;padding:10px 14px;border-radius:7px;background:#fef0f0;border:1px solid #f4c0bd;color:var(--red);font-size:12px;font-weight:600;display:none';
    document.querySelector('#m-invite .modal-ftr').insertAdjacentElement('beforebegin', b);
    return b;
  })();
  const showError = (msg) => { banner.textContent = msg; banner.style.display = 'block'; toast(msg, 'error'); };
  const clearError = () => { banner.style.display = 'none'; };

  if (!tpl)           { showError('Please select an email template.'); return; }
  if (!email)         { showError('Please enter a customer email address.'); return; }
  if (!selIds.length) { showError('Please select at least one appointment slot to offer.'); return; }
  if (!me || !me.name) { showError('Session expired. Please refresh and sign in again.'); return; }

  clearError();
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.dataset.origText = sendBtn.textContent;
    sendBtn.textContent = 'Sending...';
  }
  const restoreBtn = () => {
    if (sendBtn) {
      sendBtn.disabled = false;
      if (sendBtn.dataset.origText) sendBtn.textContent = sendBtn.dataset.origText;
    }
  };

  const { data: inv, error } = await sb.from('booking_invitations').insert({
    am_name: me.name, am_email: me.email,
    customer_email: email, customer_name: custName,
    account_code: inviteSelCust?.account_code || null,
    slot_ids: selIds, status: 'pending',
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
  }).select().single();

  if (error) {
    console.error('[diary] booking_invitations insert failed', error);
    showError('Could not create invitation: ' + (error.message || 'database error'));
    restoreBtn();
    return;
  }

  const bookUrl = window.location.href.replace(/[^/]*$/, '') + 'booking.html#token=' + inv.token;
  const offered = slots.filter(s => selIds.includes(s.id));
  const slotRows = offered.map(s => {
    const d  = new Date(s.date + 'T00:00:00');
    const dl = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee">${dl}</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${fmt(s.start_time)}&ndash;${fmt(s.end_time)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${escHtml(s.location||'')}</td></tr>`;
  }).join('');

  const html = inviteEmailHTML(custName, me.name, slotRows, bookUrl, tpl);
  const emailSubject = replacePlaceholders(tpl.email_subject, { customer_name: custName, am_name: me.name });

  try {
    // Use authenticated session token (not anon key)
    const { data: { session: _emailSess } } = await sb.auth.getSession();
    const _emailTok = _emailSess?.access_token || SB_KEY;

    const res = await fetch(EMAIL_EDGE_FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + _emailTok
      },
      body: JSON.stringify({
        to:             email,
        to_name:        custName,
        subject:        emailSubject,
        html:           html,
        from_name:      'FJ Curate',
        reply_to:       me.email,
        reply_to_name:  me.name
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || res.statusText);
    }
    toast('Invitation sent to ' + email + '!', 'success');
    closeM('m-invite');
    restoreBtn();
    quickSelCust = null;
    const qInput = document.getElementById('quick-cust-q');
    if (qInput) qInput.value = '';
    const qSel = document.getElementById('quick-cust-sel');
    if (qSel) qSel.style.display = 'none';
  } catch (err) {
    console.error('[diary] sendInvite email failed', err);
    try { await navigator.clipboard?.writeText(bookUrl); } catch (_) {}
    showError('Email failed: ' + (err?.message || 'unknown error') + '. Booking link copied to clipboard.');
    restoreBtn();
  }
}

// ═══════════════════════════════════════════════
// CANCEL BOOKING
// ═══════════════════════════════════════════════
async function cancelBooking(id) {
  if (!confirm('Cancel this booking? The customer will not be automatically notified.')) return;
  const b = bookings.find(x => x.id === id);
  if (!b) return;
  await Promise.all([
    sb.from('appointment_slots').update({ status: 'available' }).eq('id', b.slot_id),
    sb.from('appointment_bookings').update({ status: 'cancelled' }).eq('id', id)
  ]);
  const s = slots.find(x => x.id === b.slot_id);
  if (s) s.status = 'available';
  b.status = 'cancelled';
  closeM('m-detail');
  renderCal(); renderSlots(); renderBookings(); renderSidebarMetrics(); renderSidebarBookings();
  if (calSelDate) selectDay(calSelDate);
  toast('Booking cancelled. Slot is now available again.', 'success');
}

// ═══════════════════════════════════════════════
// ICS + GOOGLE CALENDAR
// ═══════════════════════════════════════════════
function makeICS(b) {
  const sd = b.date.replace(/-/g,'');
  const st = b.start_time.replace(/:/g,'').slice(0,6);
  const et = b.end_time.replace(/:/g,'').slice(0,6);
  const stamp = new Date().toISOString().replace(/[-:.]/g,'').slice(0,15)+'Z';
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//FJ Curate//Appointment Diary//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:fj-${b.id}@footjoy.com.au`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${sd}T${st}`,
    `DTEND:${sd}T${et}`,
    'SUMMARY:FJ Curate Appointment',
    `DESCRIPTION:Appointment with ${b.am_name} (FJ Curate)\\n${b.customer_name}`,
    `LOCATION:${b.location||''}`,
    'STATUS:CONFIRMED',
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
}

function dlICS(id) {
  const b = bookings.find(x => x.id === id);
  if (!b) return;
  const blob = new Blob([makeICS(b)], { type: 'text/calendar;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'footjoy-appointment.ics' });
  a.click(); URL.revokeObjectURL(a.href);
}

function gcalLink(b) {
  const ds = b.date.replace(/-/g,'');
  const st = b.start_time.replace(/:/g,'').slice(0,4)+'00';
  const et = b.end_time.replace(/:/g,'').slice(0,4)+'00';
  const p  = new URLSearchParams({
    action: 'TEMPLATE', text: 'FJ Curate Appointment',
    dates: `${ds}T${st}/${ds}T${et}`,
    details: `Appointment with ${b.am_name} from FJ Curate.`,
    location: b.location||''
  });
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

// ═══════════════════════════════════════════════
// EMAIL HTML
// ═══════════════════════════════════════════════
function inviteEmailHTML(custName, amName, slotRows, bookUrl, tpl) {
  // Substitute placeholders in intro text (escape names to prevent HTML injection in emails)
  const intro = replacePlaceholders(tpl?.intro_text || '<p>Hi {{customer_name}},</p><p><strong>{{am_name}}</strong> from FJ Curate would like to meet with you. Please choose a time below.</p>', {
    customer_name: escHtml(custName),
    am_name: escHtml(amName)
  });
  const heading = escHtml(tpl?.heading || 'Prebook Appointment Invitation');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#111111;padding:28px 32px;text-align:center">
    <img src="https://mlwzpgtdgfaczgxipbsq.supabase.co/storage/v1/object/public/logos/fj-curate-logo-w.png" alt="FJ Curate" style="height:36px;width:auto;display:block;margin:0 auto 12px">
    <div style="font-size:18px;font-weight:700;color:rgba(255,255,255,0.85);line-height:1.3">${heading}</div>
  </div>
  <div style="padding:32px;font-size:14px;color:#333;line-height:1.7">
    ${intro}
    <table style="width:100%;border-collapse:collapse;margin:24px 0 28px;font-size:14px">
      <tr style="background:#111111;color:#fff">
        <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Date</th>
        <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Time</th>
        <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Location</th>
      </tr>
      ${slotRows}
    </table>
    <div style="text-align:center;margin:32px 0">
      <a href="${bookUrl}" style="background:#e8b84b;color:#111111;padding:15px 36px;border-radius:8px;font-weight:700;font-size:16px;text-decoration:none;display:inline-block">Choose Your Time &rarr;</a>
    </div>
    <p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px;margin-top:16px">
      This invitation link is valid for 30 days. If you have any questions, please reply to this email to reach ${escHtml(amName)} directly.
    </p>
  </div>
</div>
</body></html>`;
}

// ═══════════════════════════════════════════════
// MODAL HELPERS
// ═══════════════════════════════════════════════
function openM(id)  { document.getElementById(id).classList.add('open'); }
function closeM(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-bg').forEach(bg => {
  // Use mousedown so the check fires before any synthetic click from browser UI (autocomplete etc.)
  // Only close if the mousedown started AND ended on the backdrop itself (not inside the modal)
  let downOnBg = false;
  bg.addEventListener('mousedown', e => { downOnBg = !e.target.closest('.modal'); });
  bg.addEventListener('mouseup',   e => {
    if (downOnBg && !e.target.closest('.modal')) bg.classList.remove('open');
    downOnBg = false;
  });
});

// ═══════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════
function toast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast show ' + (type || '');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ═══════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════
function fmt(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hr = parseInt(h, 10);
  return (hr % 12 || 12) + ':' + m + (hr >= 12 ? 'pm' : 'am');
}

function durationLabel(start, end) {
  if (!start || !end) return '—';
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h)      return `${h} hour${h > 1 ? 's' : ''}`;
  return `${m} min`;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Calendar chip hover popup ──
function showChipPopup(target, slot, booking) {
  const pop = document.getElementById('chip-popup');
  if (!pop) return;

  const isBooked   = !!booking;
  const statusText = isBooked ? 'Confirmed' : 'Available';
  const statusCls  = isBooked ? 'booked'    : 'avail';
  const title      = isBooked
    ? (booking.customer_name || 'Booking')
    : 'Available Slot';

  const attendee = isBooked
    ? (booking.customer_contact || booking.customer_name || '—')
    : '—';

  // The "account" label tries account_code → account_name → customer_name
  const account = isBooked
    ? (booking.account_code
        ? booking.account_code
        : (booking.account_name || booking.customer_name || '—'))
    : '—';

  const location = slot.location || (isBooked ? booking.location : '') || '—';
  const duration = durationLabel(slot.start_time, slot.end_time);
  const timeRange = `${fmt(slot.start_time)} – ${fmt(slot.end_time)}`;

  const rows = [
    ['Time',     timeRange],
    ['Length',   duration],
  ];
  if (isBooked) {
    rows.push(['Attendee', attendee]);
    rows.push(['Account',  account]);
  }
  rows.push(['Location', location]);

  pop.innerHTML = `
    <span class="chip-popup-status ${statusCls}">${escHtml(statusText)}</span>
    <div class="chip-popup-name">${escHtml(title)}</div>
    ${rows.map(([k, v]) => `
      <div class="chip-popup-row">
        <span class="k">${escHtml(k)}</span>
        <span class="v" title="${escHtml(v)}">${escHtml(v)}</span>
      </div>
    `).join('')}
  `;

  // Position above the chip if there's room, else below
  pop.classList.add('show');
  const r = target.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const margin = 8;
  let top = r.top - pr.height - margin;
  if (top < 8) top = r.bottom + margin;
  let left = r.left + (r.width / 2) - (pr.width / 2);
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  pop.style.top  = top  + 'px';
  pop.style.left = left + 'px';
}

function hideChipPopup() {
  const pop = document.getElementById('chip-popup');
  if (pop) pop.classList.remove('show');
}

// ═══════════════════════════════════════════════
// EVENT DELEGATION (replaces inline onclick/onchange)
// ═══════════════════════════════════════════════
document.addEventListener('click', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'showDetail') showDetail(el.dataset.id);
  else if (action === 'openInvite') openInvite(el.dataset.id);
  else if (action === 'openCreateSlot') openCreateSlot(el.dataset.id);
  else if (action === 'openCreateSlotAt') openCreateSlot(el.dataset.date, el.dataset.hour);
  else if (action === 'doCancel') doCancel(el.dataset.id);
  else if (action === 'dlICS') dlICS(el.dataset.id);
  else if (action === 'pickCust') pickCust(parseInt(el.dataset.index, 10));
  else if (action === 'pickQuickCust') pickQuickCust(parseInt(el.dataset.index, 10));
  // openCreateTemplate / deleteTemplate / switchToTemplatesTab removed
  // when the Templates tab moved to the admin portal (May 2026).
});

document.addEventListener('change', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'tplSelect') onTplSelect(el.dataset.tplId);
  else if (el.dataset.action === 'updateSlotPreview') previewLink();
});

// ═══════════════════════════════════════════════
// DIRECT EVENT LISTENERS (static elements)
// ═══════════════════════════════════════════════

// Back to home (hamburger menu item)
const fjBackBtn = document.getElementById('fj-back-home-btn');
if (fjBackBtn) fjBackBtn.addEventListener('click', goBackToPrebook);
// Legacy sidebar back button (kept for older HTML; no-op when removed)
const sbBack = document.getElementById('sb-back-btn');
if (sbBack) sbBack.addEventListener('click', goBackToPrebook);

// Sign out (hamburger menu item)
const fjSignOut = document.getElementById('fj-sign-out-btn');
if (fjSignOut) fjSignOut.addEventListener('click', async () => {
  await sb.auth.signOut();
  window.location.reload();
});

// Hamburger menu open/close
const fjMenuBtn = document.getElementById('fj-menu-btn');
const fjMenu    = document.getElementById('fj-menu');
if (fjMenuBtn && fjMenu) {
  fjMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = fjMenu.hasAttribute('hidden');
    if (isHidden) {
      fjMenu.removeAttribute('hidden');
      fjMenuBtn.setAttribute('aria-expanded', 'true');
      // Populate identity if available
      const nameEl  = document.getElementById('fj-menu-name');
      const emailEl = document.getElementById('fj-menu-email');
      if (typeof me !== 'undefined' && me) {
        if (nameEl)  nameEl.textContent  = me.name  || '';
        if (emailEl) emailEl.textContent = me.email || '';
      }
    } else {
      fjMenu.setAttribute('hidden', '');
      fjMenuBtn.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('click', (e) => {
    if (!fjMenu.hasAttribute('hidden') && !fjMenu.contains(e.target) && e.target !== fjMenuBtn) {
      fjMenu.setAttribute('hidden', '');
      fjMenuBtn.setAttribute('aria-expanded', 'false');
    }
  });
}

// New slot buttons (header pill + Manage Slots tab + legacy sidebar)
const headerNewSlot = document.getElementById('header-new-slot-btn');
if (headerNewSlot) headerNewSlot.addEventListener('click', () => openCreateSlot(null));
const sbNewSlot = document.getElementById('sb-new-slot-btn');
if (sbNewSlot) sbNewSlot.addEventListener('click', () => openCreateSlot(null));
const slotsNewBtn = document.getElementById('slots-new-btn');
if (slotsNewBtn) slotsNewBtn.addEventListener('click', () => openCreateSlot(null));

// Tab buttons
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    switchTab(this.dataset.tab, this);
  });
});

// Calendar navigation
document.getElementById('cal-prev-month').addEventListener('click', () => moveMonth(-1));
document.getElementById('cal-next-month').addEventListener('click', () => moveMonth(1));
document.getElementById('cal-today-btn').addEventListener('click', goToday);

// Send invitation panel action
document.getElementById('panel-open-invite-btn').addEventListener('click', () => openInvite(null));

// Quick customer search
document.getElementById('quick-cust-q').addEventListener('input', function() {
  quickCustSearch(this.value);
});
document.getElementById('quick-invite-btn').addEventListener('click', openInviteFromQuick);

// Filter pills
document.querySelectorAll('.filter-pills .pill').forEach(pill => {
  pill.addEventListener('click', function() {
    setSlotFilter(this.dataset.filter, this);
  });
});

// (Template editor moved to the admin portal under Settings -> Templates;
//  the +New Template button and m-template modal are no longer here.)

// Modal close buttons
document.getElementById('m-create-close').addEventListener('click', () => closeM('m-create'));
document.getElementById('m-create-cancel').addEventListener('click', () => closeM('m-create'));
document.getElementById('m-create-save').addEventListener('click', saveSlot);

document.getElementById('m-invite-close').addEventListener('click', () => closeM('m-invite'));
document.getElementById('m-invite-cancel').addEventListener('click', () => closeM('m-invite'));
document.getElementById('m-invite-send').addEventListener('click', sendInvite);

document.getElementById('m-detail-close').addEventListener('click', () => closeM('m-detail'));
document.getElementById('m-detail-close-btn').addEventListener('click', () => closeM('m-detail'));

// Customer search in invite modal
document.getElementById('cust-q').addEventListener('input', function() {
  custSearch(this.value);
});

// Live email preview: re-render when the user edits the customer fields.
['inv-first', 'inv-last', 'inv-email'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', renderInvitePreview);
});

// F07: Idle timeout - sign out after 30 minutes of inactivity
(function() {
  var IDLE_LIMIT = 30 * 60 * 1000;
  var idleTimer;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function() {
      sb.auth.signOut().then(function() { window.location.reload(); });
    }, IDLE_LIMIT);
  }
  ['mousemove','keydown','click','scroll','touchstart'].forEach(function(evt) {
    document.addEventListener(evt, resetIdle, { passive: true });
  });
  resetIdle();
})();
