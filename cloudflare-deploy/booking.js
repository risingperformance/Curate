// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════
const SB_URL          = window.__SUPABASE_CONFIG.url;
const SB_KEY          = window.__SUPABASE_CONFIG.key;
// Key loaded from server-side config (/supabase-config)
// Email via Supabase Edge Function (API key stored server-side)
const EMAIL_EDGE_FN = SB_URL + '/functions/v1/send-order-email';

const sb = window.supabase.createClient(SB_URL, SB_KEY);

// XSS helpers
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
let invitation   = null;
let availSlots   = [];
let selectedSlot = null;
let confirmedBk  = null;

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
async function init() {
  show('s-loading');
  // Read token from URL fragment (not query string) to prevent referrer leaks (F26)
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token')
             || new URLSearchParams(window.location.search).get('token'); // fallback for old links
  if (!token) { show('s-error'); document.getElementById('err-msg').textContent = 'No booking token found in this link.'; return; }

  // Load invitation
  const { data: inv, error: invErr } = await sb
    .from('booking_invitations')
    .select('*')
    .eq('token', token)
    .single();

  if (invErr || !inv) { show('s-error'); return; }
  if (inv.status === 'responded') {
    document.getElementById('err-msg').textContent = 'This invitation has already been used. Please contact your account manager if you need to change your appointment.';
    show('s-error'); return;
  }
  if (new Date(inv.expires_at) < new Date()) { show('s-expired'); return; }

  invitation = inv;

  // Load offered slots (those still available)
  const { data: sData } = await sb
    .from('appointment_slots')
    .select('*')
    .in('id', inv.slot_ids)
    .eq('status', 'available')
    .order('date').order('start_time');

  availSlots = sData || [];

  if (availSlots.length === 0) {
    document.getElementById('err-msg').textContent = 'All time slots for this invitation have been taken. Please contact your FootJoy account manager to arrange another time.';
    show('s-error'); return;
  }

  // Prefill name/email from invitation
  if (inv.customer_name)  document.getElementById('cust-name').value  = inv.customer_name;
  if (inv.customer_email) document.getElementById('cust-email').value = inv.customer_email;

  document.getElementById('from-am-msg').innerHTML =
    `<strong>${escapeHtml(inv.am_name)}</strong> from FootJoy has invited you to a prebook appointment. Please select your preferred time below.`;

  renderSlots();
  show('s-select');
}

// ═══════════════════════════════════════════════
// SLOT SELECTION
// ═══════════════════════════════════════════════
function renderSlots() {
  document.getElementById('slot-list').innerHTML = availSlots.map(s => {
    const d  = new Date(s.date + 'T00:00:00');
    const dl = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const sel = selectedSlot?.id === s.id ? 'selected' : '';
    return `<div class="slot-opt ${sel}" data-action="selectSlot" data-id="${s.id}">
      <div class="slot-radio"></div>
      <div>
        <div class="slot-time">${fmt(s.start_time)} &ndash; ${fmt(s.end_time)}</div>
        <div class="slot-meta">${dl}</div>
        ${s.location ? `<div class="slot-loc">&#128205; ${escapeHtml(s.location)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function selectSlot(id) {
  selectedSlot = availSlots.find(s => s.id === id) || null;
  renderSlots();
}

function goConfirm() {
  if (!selectedSlot) { toast('Please select a time slot first.'); return; }
  // Build summary
  const d  = new Date(selectedSlot.date + 'T00:00:00');
  const dl = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('slot-summary').innerHTML = `
    <div class="summary-row"><span class="summary-lbl">Date</span><span>${dl}</span></div>
    <div class="summary-row"><span class="summary-lbl">Time</span><span>${fmt(selectedSlot.start_time)} &ndash; ${fmt(selectedSlot.end_time)}</span></div>
    ${selectedSlot.location ? `<div class="summary-row"><span class="summary-lbl">Location</span><span>${escapeHtml(selectedSlot.location)}</span></div>` : ''}
    <div class="summary-row"><span class="summary-lbl">With</span><span>${escapeHtml(invitation.am_name)} (FootJoy)</span></div>
  `;
  show('s-confirm');
}

function goSelect() { show('s-select'); }

// ═══════════════════════════════════════════════
// CONFIRM BOOKING
// ═══════════════════════════════════════════════
async function confirmBooking() {
  const name  = document.getElementById('cust-name').value.trim();
  const email = document.getElementById('cust-email').value.trim();
  if (!name)  { toast('Please enter your name.'); return; }
  if (!email || !email.includes('@')) { toast('Please enter a valid email address.'); return; }

  const btn = document.getElementById('confirm-btn');
  btn.textContent = 'Confirming\u2026';
  btn.disabled = true;

  // DB17 \u2014 atomic SECURITY DEFINER RPC handles: token validation, slot
  // availability check, booking insert, slot/invitation status flips.
  // All race-condition-safe at the database level. Replaces the prior
  // 5-call pattern (2 read checks + insert + 2 status updates) which
  // required RLS allowing broad anon UPDATEs on slots/invitations.
  const { data: rpcRows, error: rpcErr } = await sb.rpc('confirm_booking', {
    p_token:          invitation.token,
    p_slot_id:        selectedSlot.id,
    p_customer_name:  name,
    p_customer_email: email
  });

  if (rpcErr) {
    btn.textContent = 'Confirm Booking'; btn.disabled = false;
    const code = (rpcErr.message || '').toLowerCase();
    if (code.includes('slot_not_available') || code.includes('slot_not_offered')) {
      toast('Sorry, this slot was just taken. Please go back and choose another time.');
      show('s-select'); selectedSlot = null; renderSlots(); return;
    }
    if (code.includes('invitation_already_used') || code.includes('invitation_expired') || code.includes('invitation_not_found')) {
      show('s-error');
      document.getElementById('err-msg').textContent = 'This invitation has already been used or expired. Please contact your account manager if you need to change your appointment.';
      return;
    }
    toast('There was an error confirming your booking. Please try again.');
    return;
  }

  // RPC returns one row in TABLE form.
  const rpcRow = (rpcRows && rpcRows[0]) || null;
  if (!rpcRow) {
    toast('There was an error confirming your booking. Please try again.');
    btn.textContent = 'Confirm Booking'; btn.disabled = false; return;
  }
  const bk = {
    id:             rpcRow.booking_id,
    am_name:        rpcRow.am_name,
    am_email:       rpcRow.am_email,
    customer_name:  rpcRow.customer_name,
    customer_email: rpcRow.customer_email,
    date:           rpcRow.date,
    start_time:     rpcRow.start_time,
    end_time:       rpcRow.end_time,
    location:       rpcRow.location
  };

  confirmedBk = bk;

  // Send confirmation email (non-blocking)
  sendConfirmEmail(bk, name, email).catch(() => {});

  // Show success screen
  showSuccess(bk, name);
  btn.textContent = 'Confirm Booking'; btn.disabled = false;
}

async function sendConfirmEmail(bk, custName, custEmail) {
  const d  = new Date(bk.date + 'T00:00:00');
  const dl = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const confirmHtml = confirmEmailHTML(custName, bk.am_name, dl, fmt(bk.start_time), fmt(bk.end_time), bk.location, gcalLink(bk));
  try {
    const payload = {
      to:             custEmail,
      to_name:        custName,
      subject:        'Your FootJoy Appointment is Confirmed',
      html:           confirmHtml,
      from_name:      'FootJoy Prebook',
      reply_to:       bk.am_email || undefined,
      reply_to_name:  bk.am_name || undefined,
      cc:             bk.am_email ? [{ email: bk.am_email, name: bk.am_name }] : undefined
    };
    const res = await fetch(EMAIL_EDGE_FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SB_KEY
      },
      body: JSON.stringify(payload)
    });
    /* production: error silenced */
  } catch (e) {
    /* production: error silenced */
  }
}

// ═══════════════════════════════════════════════
// SUCCESS SCREEN
// ═══════════════════════════════════════════════
function showSuccess(bk, custName) {
  const d  = new Date(bk.date + 'T00:00:00');
  const dl = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('success-msg').textContent =
    `Hi ${custName}, your appointment with ${bk.am_name} (FootJoy) has been confirmed. A confirmation email has been sent to you.`;
  document.getElementById('success-summary').innerHTML = `
    <div class="summary-row"><span class="summary-lbl">Date</span><span>${dl}</span></div>
    <div class="summary-row"><span class="summary-lbl">Time</span><span>${fmt(bk.start_time)} &ndash; ${fmt(bk.end_time)}</span></div>
    ${bk.location ? `<div class="summary-row"><span class="summary-lbl">Location</span><span>${escapeHtml(bk.location)}</span></div>` : ''}
    <div class="summary-row"><span class="summary-lbl">With</span><span>${escapeHtml(bk.am_name)} (FootJoy)</span></div>
  `;
  document.getElementById('gcal-link').href = gcalLink(bk);
  show('s-success');
}

// ═══════════════════════════════════════════════
// ICS + GOOGLE CALENDAR
// ═══════════════════════════════════════════════
function makeICS(b) {
  const sd    = b.date.replace(/-/g,'');
  const st    = b.start_time.replace(/:/g,'').slice(0,6);
  const et    = b.end_time.replace(/:/g,'').slice(0,6);
  const stamp = new Date().toISOString().replace(/[-:.]/g,'').slice(0,15)+'Z';
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//FootJoy//Prebook Diary//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:fj-${b.id}@footjoy.com.au`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${sd}T${st}`,
    `DTEND:${sd}T${et}`,
    'SUMMARY:FootJoy Prebook Appointment',
    `DESCRIPTION:Appointment with ${b.am_name} (FootJoy).`,
    `LOCATION:${b.location||''}`,
    'STATUS:CONFIRMED',
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
}

function dlICS() {
  if (!confirmedBk) return;
  const blob = new Blob([makeICS(confirmedBk)], { type: 'text/calendar;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'footjoy-appointment.ics' });
  a.click(); URL.revokeObjectURL(a.href);
}

function gcalLink(b) {
  const ds = b.date.replace(/-/g,'');
  const st = b.start_time.replace(/:/g,'').slice(0,4)+'00';
  const et = b.end_time.replace(/:/g,'').slice(0,4)+'00';
  const p  = new URLSearchParams({
    action: 'TEMPLATE',
    text:   'FootJoy Prebook Appointment',
    dates:  `${ds}T${st}/${ds}T${et}`,
    details:`Appointment with ${b.am_name} from FootJoy.`,
    location: b.location||''
  });
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

// ═══════════════════════════════════════════════
// EMAIL HTML
// ═══════════════════════════════════════════════
function confirmEmailHTML(custName, amName, dateStr, startT, endT, location, gcal) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Arial,sans-serif">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#0a1628;padding:24px 32px;text-align:center">
    <div style="font-size:11px;font-weight:700;letter-spacing:3px;color:#c9a84c;text-transform:uppercase;margin-bottom:8px">FootJoy</div>
    <div style="font-size:22px;font-weight:700;color:#fff">Appointment Confirmed &#9989;</div>
  </div>
  <div style="padding:32px">
    <p style="font-size:16px;margin-bottom:20px">Hi ${escapeHtml(custName)},</p>
    <p style="font-size:14px;color:#555;line-height:1.7;margin-bottom:24px">Your prebook appointment with <strong>${escapeHtml(amName)}</strong> from FootJoy has been confirmed. Details below:</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:28px;font-size:14px;background:#f4f6fb;border-radius:8px;overflow:hidden">
      <tr><td style="padding:12px 16px;font-weight:600;color:#6b7a99;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #dde4f0">Date</td><td style="padding:12px 16px;font-weight:700;border-bottom:1px solid #dde4f0">${escapeHtml(dateStr)}</td></tr>
      <tr><td style="padding:12px 16px;font-weight:600;color:#6b7a99;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #dde4f0">Time</td><td style="padding:12px 16px;border-bottom:1px solid #dde4f0">${escapeHtml(startT)} &ndash; ${escapeHtml(endT)}</td></tr>
      ${location ? `<tr><td style="padding:12px 16px;font-weight:600;color:#6b7a99;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #dde4f0">Location</td><td style="padding:12px 16px;border-bottom:1px solid #dde4f0">${escapeHtml(location)}</td></tr>` : ''}
      <tr><td style="padding:12px 16px;font-weight:600;color:#6b7a99;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">With</td><td style="padding:12px 16px;font-weight:700">${escapeHtml(amName)} (FootJoy)</td></tr>
    </table>
    <div style="text-align:center;margin:28px 0">
      <a href="${gcal}" style="background:#0a1628;color:#fff;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none;display:inline-block">+ Add to Google Calendar</a>
    </div>
    <p style="font-size:13px;color:#555;line-height:1.7;border-top:1px solid #eee;padding-top:16px;margin-top:16px">
      You can also download a calendar file (.ics) from the booking confirmation page, which works with Outlook, Apple Calendar, and Google Calendar.
    </p>
    <p style="font-size:12px;color:#999;margin-top:12px">If you need to reschedule, please reply to this email or contact ${escapeHtml(amName)} directly.</p>
  </div>
</div>
</body></html>`;
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function show(id) {
  ['s-loading','s-error','s-expired','s-select','s-confirm','s-success'].forEach(s => {
    document.getElementById(s).classList[s === id ? 'add' : 'remove']('show');
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function fmt(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hr = parseInt(h, 10);
  return (hr % 12 || 12) + ':' + m + (hr >= 12 ? 'pm' : 'am');
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show';
  clearTimeout(t._tid); t._tid = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ═══════════════════════════════════════════════
// EVENT DELEGATION (replaces inline onclick)
// ═══════════════════════════════════════════════
document.addEventListener('click', function(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'selectSlot') selectSlot(el.dataset.id);
});

document.getElementById('btn-go-confirm').addEventListener('click', goConfirm);
document.getElementById('btn-go-select').addEventListener('click', goSelect);
document.getElementById('confirm-btn').addEventListener('click', confirmBooking);
document.getElementById('btn-dl-ics').addEventListener('click', dlICS);

// ═══════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════
init();
