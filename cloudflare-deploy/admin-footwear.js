// ═══════════════════════════════════════════════════════════════════════════════
// FOOTWEAR ADMIN UI
// Renders the Footwear > Questionnaire surface (and, after Phase B, the
// Slides surface). Loaded after admin.js so it can read shared helpers from
// window.curate (supa, toast, openModal, closeModal, escapeHtml, etc.) and
// register its renderers on window.curateFootwear, which admin.js's
// activateTab() dispatches into.
//
// Style notes:
//   - No inline event handlers. Every interactive element carries a
//     data-fw-action attribute; a single delegated click listener at the
//     bottom of this file routes them.
//   - Every user-controlled string is rendered via escapeHtml or as a
//     value="" via escapeAttr. innerHTML is only used with this guarantee.
//   - Reordering uses up/down arrow buttons (no drag-and-drop) so the CSP
//     stays clean and we do not vendor a DnD library.
// ═══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (!window.curate) {
    // Should not happen: admin.js runs first. Fail loud rather than silent.
    console.error('admin-footwear.js loaded before admin.js initialised window.curate');
    return;
  }

  var c           = window.curate;
  var supa        = c.supa;
  var toast       = c.toast;
  var openModal   = c.openModal;
  var closeModal  = c.closeModal;
  var escapeHtml  = c.escapeHtml;
  var escapeAttr  = c.escapeAttr;

  // ── INTERNAL STATE ─────────────────────────────────────────────────────────
  // Single in-memory cache of the four datasets the questionnaire surface
  // needs. Reloaded from Supabase on every render() call so any write
  // (in this admin or anywhere else) is reflected without a stale view.
  var state = {
    questions: [],     // footwear_questions rows
    options:   [],     // footwear_question_options rows (all questions)
    rules:     [],     // footwear_question_rules rows (all questions)
    slides:    [],     // footwear_slides rows (id, slide_key, title, is_active)
    view:      { type: 'list' },  // or { type: 'detail', questionId: <uuid> }
  };

  // ── DATA LOAD ──────────────────────────────────────────────────────────────
  async function loadAll() {
    var qP = supa.from('footwear_questions').select('*').order('display_order', { ascending: true });
    var oP = supa.from('footwear_question_options').select('*').order('display_order', { ascending: true });
    var rP = supa.from('footwear_question_rules').select('*');
    var sP = supa.from('footwear_slides')
                 .select('id, slide_key, title, is_active')
                 .order('default_position', { ascending: true });

    var results = await Promise.all([qP, oP, rP, sP]);
    var qRes = results[0], oRes = results[1], rRes = results[2], sRes = results[3];

    if (qRes.error || oRes.error || rRes.error || sRes.error) {
      toast('Could not load questionnaire data. Please refresh and try again.', 'error');
      return false;
    }
    state.questions = qRes.data || [];
    state.options   = oRes.data || [];
    state.rules     = rRes.data || [];
    state.slides    = sRes.data || [];
    return true;
  }

  // ── HELPERS ────────────────────────────────────────────────────────────────
  function panel() {
    return document.getElementById('panel-questionnaire');
  }

  // Sort by display_order ascending; stable when display_orders collide.
  function byDisplayOrder(a, b) {
    return (a.display_order || 0) - (b.display_order || 0);
  }

  function optionsForQuestion(qid) {
    return state.options
                .filter(function (o) { return o.question_id === qid; })
                .sort(byDisplayOrder);
  }

  function rulesForQuestion(qid) {
    return state.rules.filter(function (r) { return r.question_id === qid; });
  }

  function questionById(qid) {
    for (var i = 0; i < state.questions.length; i++) {
      if (state.questions[i].id === qid) return state.questions[i];
    }
    return null;
  }

  function optionById(oid) {
    for (var i = 0; i < state.options.length; i++) {
      if (state.options[i].id === oid) return state.options[i];
    }
    return null;
  }

  function slideById(sid) {
    for (var i = 0; i < state.slides.length; i++) {
      if (state.slides[i].id === sid) return state.slides[i];
    }
    return null;
  }

  // Convert a free-text label into a stable key. Used to seed the key field
  // in Add modals; the admin can override before saving. After save, keys
  // are immutable (the brief calls this out in 3.1).
  function slugifyKey(text) {
    return String(text || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
  }

  // ── RENDER DISPATCH ────────────────────────────────────────────────────────
  async function render() {
    var ok = await loadAll();
    if (!ok) return;

    // If the active detail-view question got archived/deleted out from
    // under us, fall back to the list.
    if (state.view.type === 'detail') {
      if (!questionById(state.view.questionId)) state.view = { type: 'list' };
    }

    if (state.view.type === 'detail') renderDetail();
    else renderList();
  }

  // ── LIST VIEW ──────────────────────────────────────────────────────────────
  function renderList() {
    var sorted = state.questions.slice().sort(byDisplayOrder);

    var rowsHtml = sorted.map(function (q, i) {
      var optsCount  = optionsForQuestion(q.id).length;
      var rulesCount = rulesForQuestion(q.id).length;
      var atTop      = i === 0;
      var atBottom   = i === sorted.length - 1;

      return ''
        + '<tr>'
        +   '<td class="qn-reorder-col">'
        +     '<button class="btn btn-outline btn-sm" data-fw-action="moveQuestion"'
        +            ' data-id="' + escapeAttr(q.id) + '" data-dir="up"'
        +            (atTop ? ' disabled style="opacity:0.4;cursor:not-allowed;"' : '')
        +            '>&uarr;</button> '
        +     '<button class="btn btn-outline btn-sm" data-fw-action="moveQuestion"'
        +            ' data-id="' + escapeAttr(q.id) + '" data-dir="down"'
        +            (atBottom ? ' disabled style="opacity:0.4;cursor:not-allowed;"' : '')
        +            '>&darr;</button>'
        +   '</td>'
        +   '<td>' + (q.display_order || 0) + '</td>'
        +   '<td><b>' + escapeHtml(q.prompt) + '</b><br>'
        +     '<span class="qn-key">' + escapeHtml(q.question_key) + '</span></td>'
        +   '<td>' + escapeHtml(q.question_type) + '</td>'
        +   '<td>' + optsCount + '</td>'
        +   '<td>' + rulesCount + '</td>'
        +   '<td>'
        +     '<input type="checkbox" data-fw-action="toggleQuestionActive"'
        +           ' data-id="' + escapeAttr(q.id) + '"'
        +           (q.is_active ? ' checked' : '') + '>'
        +   '</td>'
        +   '<td class="qn-actions-col">'
        +     '<button class="btn btn-outline btn-sm" data-fw-action="openQuestion"'
        +            ' data-id="' + escapeAttr(q.id) + '">Edit</button>'
        +   '</td>'
        + '</tr>';
    }).join('');

    panel().innerHTML = ''
      + '<div class="section-title">Questionnaire</div>'
      + '<div class="section-sub">Configure the questions customers answer before the deck. Each answer can include or exclude specific slides via rules.</div>'
      + '<div class="toolbar">'
      +   '<button class="btn btn-primary" data-fw-action="addQuestion">+ Add question</button>'
      +   '<span class="row-count">' + sorted.length + ' question' + (sorted.length === 1 ? '' : 's') + '</span>'
      + '</div>'
      + (sorted.length === 0
          ? '<div class="empty-state">No questions yet. Click "Add question" to start.</div>'
          : ''
            + '<div class="grid-wrap">'
            +   '<table class="data-grid qn-list">'
            +     '<thead>'
            +       '<tr>'
            +         '<th class="qn-reorder-col">Reorder</th>'
            +         '<th>Order</th>'
            +         '<th>Prompt</th>'
            +         '<th>Type</th>'
            +         '<th>Options</th>'
            +         '<th>Rules</th>'
            +         '<th>Active</th>'
            +         '<th class="qn-actions-col"></th>'
            +       '</tr>'
            +     '</thead>'
            +     '<tbody>' + rowsHtml + '</tbody>'
            +   '</table>'
            + '</div>');
  }

  // ── DETAIL VIEW ────────────────────────────────────────────────────────────
  function renderDetail() {
    var q     = questionById(state.view.questionId);
    if (!q) { state.view = { type: 'list' }; return renderList(); }
    var opts  = optionsForQuestion(q.id);
    var rules = rulesForQuestion(q.id);

    var optionsRowsHtml = opts.map(function (o, i) {
      var atTop    = i === 0;
      var atBottom = i === opts.length - 1;
      return ''
        + '<tr>'
        +   '<td class="qn-reorder-col">'
        +     '<button class="btn btn-outline btn-sm" data-fw-action="moveOption"'
        +            ' data-id="' + escapeAttr(o.id) + '" data-dir="up"'
        +            (atTop ? ' disabled style="opacity:0.4;cursor:not-allowed;"' : '')
        +            '>&uarr;</button> '
        +     '<button class="btn btn-outline btn-sm" data-fw-action="moveOption"'
        +            ' data-id="' + escapeAttr(o.id) + '" data-dir="down"'
        +            (atBottom ? ' disabled style="opacity:0.4;cursor:not-allowed;"' : '')
        +            '>&darr;</button>'
        +   '</td>'
        +   '<td><span class="qn-key">' + escapeHtml(o.option_key) + '</span></td>'
        +   '<td>' + escapeHtml(o.label) + '</td>'
        +   '<td class="qn-actions-col">'
        +     '<button class="btn btn-outline btn-sm" data-fw-action="editOption"'
        +            ' data-id="' + escapeAttr(o.id) + '">Edit</button> '
        +     '<button class="btn btn-danger btn-sm" data-fw-action="deleteOption"'
        +            ' data-id="' + escapeAttr(o.id) + '">Delete</button>'
        +   '</td>'
        + '</tr>';
    }).join('');

    var rulesItemsHtml = rules.map(function (r) {
      var opt   = optionById(r.option_id);
      var slide = slideById(r.slide_id);
      var actionWord = r.action === 'include_slide' ? 'include' : 'exclude';
      var optLabel   = opt   ? opt.label   : '(option missing)';
      var slideTitle = slide ? slide.title : '(slide missing)';
      var slideTag   = slide && !slide.is_active ? ' (inactive)' : '';
      return ''
        + '<li class="qn-rule">'
        +   '<span class="qn-rule-text">When user picks <b>'
        +     escapeHtml(optLabel)
        +     '</b>, ' + actionWord + ' slide <b>'
        +     escapeHtml(slideTitle) + '</b>'
        +     escapeHtml(slideTag)
        +   '</span>'
        +   '<button class="btn btn-danger btn-sm" data-fw-action="deleteRule" data-id="'
        +     escapeAttr(r.id) + '">Delete</button>'
        + '</li>';
    }).join('');

    panel().innerHTML = ''
      + '<div class="qn-back">'
      +   '<button class="btn btn-outline btn-sm" data-fw-action="backToList">&larr; Back to questionnaire</button>'
      + '</div>'

      // Question settings card
      + '<div class="qn-card">'
      +   '<div class="qn-card-title">Question settings</div>'
      +   '<div class="qn-key-line">Key: <code>' + escapeHtml(q.question_key) + '</code> '
      +     '<span class="qn-locked-tag">(locked after creation)</span></div>'
      +   '<div class="qn-form">'
      +     '<label>Prompt'
      +       '<input type="text" id="qn-prompt-input" value="' + escapeAttr(q.prompt) + '" maxlength="500">'
      +     '</label>'
      +     '<label>Type'
      +       '<select id="qn-type-input">'
      +         '<option value="single_select"' + (q.question_type === 'single_select' ? ' selected' : '') + '>single_select</option>'
      +         '<option value="multi_select"'  + (q.question_type === 'multi_select'  ? ' selected' : '') + '>multi_select</option>'
      +       '</select>'
      +     '</label>'
      +     '<label class="qn-active-line">'
      +       '<input type="checkbox" id="qn-active-input"' + (q.is_active ? ' checked' : '') + '>'
      +       ' Active'
      +     '</label>'
      +     '<div class="qn-form-actions">'
      +       '<button class="btn btn-primary" data-fw-action="saveQuestion" data-id="' + escapeAttr(q.id) + '">Save changes</button>'
      +     '</div>'
      +   '</div>'
      + '</div>'

      // Options card
      + '<div class="qn-card">'
      +   '<div class="qn-card-title">Options</div>'
      +   '<div class="qn-card-sub">Each option is one possible answer. After creation, the option key is locked. Order controls how options appear to the customer.</div>'
      +   '<div class="toolbar">'
      +     '<button class="btn btn-primary" data-fw-action="addOption" data-question-id="' + escapeAttr(q.id) + '">+ Add option</button>'
      +     '<span class="row-count">' + opts.length + ' option' + (opts.length === 1 ? '' : 's') + '</span>'
      +   '</div>'
      +   (opts.length === 0
          ? '<div class="empty-state">No options yet.</div>'
          : ''
            + '<div class="grid-wrap">'
            +   '<table class="data-grid qn-list">'
            +     '<thead>'
            +       '<tr>'
            +         '<th class="qn-reorder-col">Reorder</th>'
            +         '<th>Key</th>'
            +         '<th>Label</th>'
            +         '<th class="qn-actions-col"></th>'
            +       '</tr>'
            +     '</thead>'
            +     '<tbody>' + optionsRowsHtml + '</tbody>'
            +   '</table>'
            + '</div>')
      + '</div>'

      // Rules card
      + '<div class="qn-card">'
      +   '<div class="qn-card-title">Rules</div>'
      +   '<div class="qn-card-sub">Each rule attaches one option to one slide. When the customer picks the option, the deck includes or excludes the slide. The same option cannot have an include and an exclude rule on the same slide.</div>'
      +   '<div class="toolbar">'
      +     '<button class="btn btn-primary" data-fw-action="addRule" data-question-id="' + escapeAttr(q.id) + '">+ Add rule</button>'
      +     '<span class="row-count">' + rules.length + ' rule' + (rules.length === 1 ? '' : 's') + '</span>'
      +   '</div>'
      +   (rules.length === 0
          ? '<div class="empty-state">No rules yet.</div>'
          : '<ul class="qn-rule-list">' + rulesItemsHtml + '</ul>')
      + '</div>';
  }

  // ── ADD QUESTION ───────────────────────────────────────────────────────────
  function showAddQuestionModal() {
    openModal(''
      + '<h3>New question</h3>'
      + '<p>Add a question to the questionnaire. The question key is the stable identifier rules and reports will reference; pick something short and lowercase, you cannot change it later.</p>'
      + '<div class="qn-form">'
      +   '<label>Question key'
      +     '<input type="text" id="add-q-key" placeholder="e.g. priority" maxlength="60">'
      +   '</label>'
      +   '<label>Prompt'
      +     '<input type="text" id="add-q-prompt" placeholder="e.g. What matters most?" maxlength="500">'
      +   '</label>'
      +   '<label>Type'
      +     '<select id="add-q-type">'
      +       '<option value="single_select">single_select</option>'
      +       '<option value="multi_select">multi_select</option>'
      +     '</select>'
      +   '</label>'
      + '</div>'
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      +   '<button class="btn btn-primary" data-fw-action="commitAddQuestion">Create</button>'
      + '</div>');

    // Auto-suggest key from prompt as the user types, until they touch the
    // key field themselves.
    var keyEl    = document.getElementById('add-q-key');
    var promptEl = document.getElementById('add-q-prompt');
    var keyTouched = false;
    keyEl.addEventListener('input', function () { keyTouched = true; });
    promptEl.addEventListener('input', function () {
      if (!keyTouched) keyEl.value = slugifyKey(promptEl.value);
    });
  }

  async function commitAddQuestion() {
    var rawKey = document.getElementById('add-q-key').value.trim();
    var prompt = document.getElementById('add-q-prompt').value.trim();
    var type   = document.getElementById('add-q-type').value;

    // Slugify on the way in so the admin can type "Priority", "my-priority",
    // "What is your X?" etc. and we land a clean stable identifier in the
    // database. The preview span in the modal already showed the cleaned
    // form so this should not be a surprise.
    var key = slugifyKey(rawKey);

    if (!key)    { toast('Question key is required (use letters, numbers, or underscores).', 'error'); return; }
    if (!prompt) { toast('Prompt is required.', 'error'); return; }

    var nextOrder = 1;
    for (var i = 0; i < state.questions.length; i++) {
      var q = state.questions[i];
      if (q.display_order >= nextOrder) nextOrder = q.display_order + 1;
    }

    var insertRes = await supa.from('footwear_questions').insert({
      question_key:  key,
      prompt:        prompt,
      question_type: type,
      display_order: nextOrder,
      is_active:     true,
    });
    if (insertRes.error) {
      toast(prettyDbError(insertRes.error, 'Could not create question.'), 'error');
      return;
    }
    closeModal();
    toast('Question created.', 'success');
    await render();
  }

  // ── SAVE QUESTION (from detail) ───────────────────────────────────────────
  async function saveQuestion(qid) {
    var prompt = document.getElementById('qn-prompt-input').value.trim();
    var type   = document.getElementById('qn-type-input').value;
    var active = document.getElementById('qn-active-input').checked;
    if (!prompt) { toast('Prompt is required.', 'error'); return; }

    var res = await supa.from('footwear_questions')
                        .update({ prompt: prompt, question_type: type, is_active: active })
                        .eq('id', qid);
    if (res.error) { toast(prettyDbError(res.error, 'Save failed.'), 'error'); return; }
    toast('Question saved.', 'success');
    await render();
  }

  // ── TOGGLE ACTIVE FROM LIST ───────────────────────────────────────────────
  async function toggleQuestionActive(qid, isActive) {
    var res = await supa.from('footwear_questions')
                        .update({ is_active: isActive })
                        .eq('id', qid);
    if (res.error) { toast(prettyDbError(res.error, 'Update failed.'), 'error'); return; }
    await render();
  }

  // ── REORDER QUESTIONS ─────────────────────────────────────────────────────
  async function moveQuestion(qid, dir) {
    var sorted = state.questions.slice().sort(byDisplayOrder);
    var i      = sorted.findIndex(function (q) { return q.id === qid; });
    if (i < 0) return;
    var j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= sorted.length) return;
    var a = sorted[i], b = sorted[j];

    // Two-step swap. The display_order column has no unique constraint so
    // there's no risk of a transient collision, but we still reload after
    // both updates succeed to keep the UI in sync.
    var aRes = await supa.from('footwear_questions').update({ display_order: b.display_order }).eq('id', a.id);
    if (aRes.error) { toast(prettyDbError(aRes.error, 'Reorder failed.'), 'error'); return; }
    var bRes = await supa.from('footwear_questions').update({ display_order: a.display_order }).eq('id', b.id);
    if (bRes.error) { toast(prettyDbError(bRes.error, 'Reorder failed.'), 'error'); return; }
    await render();
  }

  // ── ADD OPTION ────────────────────────────────────────────────────────────
  function showAddOptionModal(qid) {
    var q = questionById(qid);
    openModal(''
      + '<h3>New option</h3>'
      + '<p>Add an option for <b>' + escapeHtml(q ? q.prompt : '') + '</b>. The option key is the stable identifier; pick something short and lowercase, you cannot change it later.</p>'
      + '<div class="qn-form">'
      +   '<label>Option key'
      +     '<input type="text" id="add-o-key" placeholder="e.g. speed" maxlength="60">'
      +   '</label>'
      +   '<label>Label'
      +     '<input type="text" id="add-o-label" placeholder="e.g. Speed" maxlength="200">'
      +   '</label>'
      + '</div>'
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      +   '<button class="btn btn-primary" data-fw-action="commitAddOption" data-question-id="' + escapeAttr(qid) + '">Create</button>'
      + '</div>');

    var keyEl   = document.getElementById('add-o-key');
    var labelEl = document.getElementById('add-o-label');
    var keyTouched = false;
    keyEl.addEventListener('input', function () { keyTouched = true; });
    labelEl.addEventListener('input', function () {
      if (!keyTouched) keyEl.value = slugifyKey(labelEl.value);
    });
  }

  async function commitAddOption(qid) {
    var rawKey = document.getElementById('add-o-key').value.trim();
    var label  = document.getElementById('add-o-label').value.trim();

    // See commitAddQuestion: we slugify rather than reject.
    var key = slugifyKey(rawKey);

    if (!key)   { toast('Option key is required (use letters, numbers, or underscores).', 'error'); return; }
    if (!label) { toast('Label is required.', 'error'); return; }

    var existing = optionsForQuestion(qid);
    var nextOrder = 1;
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].display_order >= nextOrder) nextOrder = existing[i].display_order + 1;
    }

    var res = await supa.from('footwear_question_options').insert({
      question_id:   qid,
      option_key:    key,
      label:         label,
      display_order: nextOrder,
    });
    if (res.error) { toast(prettyDbError(res.error, 'Could not create option.'), 'error'); return; }
    closeModal();
    toast('Option created.', 'success');
    await render();
  }

  // ── EDIT OPTION (label only; key is locked) ───────────────────────────────
  function showEditOptionModal(oid) {
    var o = optionById(oid);
    if (!o) return;
    openModal(''
      + '<h3>Edit option</h3>'
      + '<p>Key <code>' + escapeHtml(o.option_key) + '</code> is locked.</p>'
      + '<div class="qn-form">'
      +   '<label>Label'
      +     '<input type="text" id="edit-o-label" value="' + escapeAttr(o.label) + '" maxlength="200">'
      +   '</label>'
      + '</div>'
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      +   '<button class="btn btn-primary" data-fw-action="commitEditOption" data-id="' + escapeAttr(oid) + '">Save</button>'
      + '</div>');
  }

  async function commitEditOption(oid) {
    var label = document.getElementById('edit-o-label').value.trim();
    if (!label) { toast('Label is required.', 'error'); return; }
    var res = await supa.from('footwear_question_options').update({ label: label }).eq('id', oid);
    if (res.error) { toast(prettyDbError(res.error, 'Save failed.'), 'error'); return; }
    closeModal();
    toast('Option saved.', 'success');
    await render();
  }

  // ── DELETE OPTION ─────────────────────────────────────────────────────────
  function showDeleteOptionModal(oid) {
    var o = optionById(oid);
    if (!o) return;
    var dependentRules = state.rules.filter(function (r) { return r.option_id === oid; });
    var warn = '';
    if (dependentRules.length > 0) {
      warn = '<p style="color:var(--red);"><b>Heads up:</b> this will also delete '
           + dependentRules.length + ' rule' + (dependentRules.length === 1 ? '' : 's')
           + ' that reference this option.</p>';
    }
    openModal(''
      + '<h3>Delete option?</h3>'
      + '<p>Delete option <b>' + escapeHtml(o.label || o.option_key) + '</b>? This cannot be undone.</p>'
      + warn
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      +   '<button class="btn btn-danger" data-fw-action="commitDeleteOption" data-id="' + escapeAttr(oid) + '">Delete</button>'
      + '</div>');
  }

  async function commitDeleteOption(oid) {
    var res = await supa.from('footwear_question_options').delete().eq('id', oid);
    closeModal();
    if (res.error) { toast(prettyDbError(res.error, 'Delete failed.'), 'error'); return; }
    toast('Option deleted.', 'success');
    await render();
  }

  // ── REORDER OPTIONS ───────────────────────────────────────────────────────
  async function moveOption(oid, dir) {
    var o = optionById(oid);
    if (!o) return;
    var sorted = optionsForQuestion(o.question_id);
    var i      = sorted.findIndex(function (x) { return x.id === oid; });
    var j      = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= sorted.length) return;
    var a = sorted[i], b = sorted[j];

    var aRes = await supa.from('footwear_question_options').update({ display_order: b.display_order }).eq('id', a.id);
    if (aRes.error) { toast(prettyDbError(aRes.error, 'Reorder failed.'), 'error'); return; }
    var bRes = await supa.from('footwear_question_options').update({ display_order: a.display_order }).eq('id', b.id);
    if (bRes.error) { toast(prettyDbError(bRes.error, 'Reorder failed.'), 'error'); return; }
    await render();
  }

  // ── ADD RULE ──────────────────────────────────────────────────────────────
  function showAddRuleModal(qid) {
    var q          = questionById(qid);
    var qOptions   = optionsForQuestion(qid);
    var activeSlides = state.slides.filter(function (s) { return s.is_active; });

    if (qOptions.length === 0) {
      toast('Add at least one option before creating a rule.', 'error');
      return;
    }
    if (activeSlides.length === 0) {
      toast('No active slides exist yet. Add or activate a slide before creating a rule.', 'error');
      return;
    }

    var optionsSelect = '<select id="add-r-option">'
      + qOptions.map(function (o) {
          return '<option value="' + escapeAttr(o.id) + '">' + escapeHtml(o.label) + '</option>';
        }).join('')
      + '</select>';

    // Build a checklist of every active slide. Each row is a label
    // wrapping a checkbox so the whole row is clickable. The actual
    // checked / disabled state is decided by syncForOption() once the
    // modal is in the DOM, because it depends on the currently-selected
    // option and the existing rules in state.
    var slidesList = '<div class="qn-slide-checklist" id="add-r-slides">'
      + activeSlides.map(function (s) {
          return '<label class="qn-slide-row" data-slide-id="' + escapeAttr(s.id) + '">'
               +   '<input type="checkbox" class="add-r-slide" value="' + escapeAttr(s.id) + '">'
               +   '<span>' + escapeHtml(s.title) + '</span>'
               +   '<span class="qn-slide-row-hint" hidden>Already excluded</span>'
               + '</label>';
        }).join('')
      + '</div>';

    openModal(''
      + '<h3>New rule</h3>'
      + '<p>Pick the option, then check every slide the deck should exclude when the customer picks that option.</p>'
      + '<div class="qn-form">'
      +   '<label>When the user picks' + optionsSelect + '</label>'
      +   '<label>Exclude these slides' + slidesList + '</label>'
      +   '<div id="add-r-preview" class="qn-rule-preview"></div>'
      + '</div>'
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      +   '<button class="btn btn-primary" data-fw-action="commitAddRule" data-question-id="' + escapeAttr(qid) + '">Create rule</button>'
      + '</div>');

    // Update the row state for the currently selected option:
    // slides that already have an exclude rule for this option are
    // pre-checked AND disabled so the admin can see them but can't
    // accidentally duplicate. The "Already excluded" hint surfaces
    // beside those rows.
    function syncForOption() {
      var optEl = document.getElementById('add-r-option');
      var optionId = optEl.value;
      var existing = new Set(state.rules
        .filter(function (r) { return r.option_id === optionId && r.action === 'exclude_slide'; })
        .map(function (r) { return r.slide_id; }));
      document.querySelectorAll('#add-r-slides .qn-slide-row').forEach(function (row) {
        var slideId = row.getAttribute('data-slide-id');
        var cb      = row.querySelector('input[type="checkbox"]');
        var hint    = row.querySelector('.qn-slide-row-hint');
        if (existing.has(slideId)) {
          cb.checked  = true;
          cb.disabled = true;
          row.classList.add('disabled');
          if (hint) hint.hidden = false;
        } else {
          cb.disabled = false;
          row.classList.remove('disabled');
          if (hint) hint.hidden = true;
          // Don't auto-uncheck user-set checkboxes; only reset state
          // for rows that just changed disability.
        }
      });
    }

    function updatePreview() {
      var optEl = document.getElementById('add-r-option');
      var optText = optEl.options[optEl.selectedIndex].text;
      // Only count checkboxes the user can actually act on (skip the
      // pre-checked + disabled ones, which represent existing rules
      // and won't be re-inserted on submit).
      var picks = Array.from(document.querySelectorAll('#add-r-slides input.add-r-slide'))
        .filter(function (cb) { return cb.checked && !cb.disabled; });
      var summary;
      if (picks.length === 0) {
        summary = '(no new slides selected)';
      } else if (picks.length === 1) {
        summary = 'slide ' + picks[0].parentElement.querySelector('span').textContent;
      } else {
        summary = picks.length + ' slides';
      }
      document.getElementById('add-r-preview').textContent =
        'When user picks ' + optText + ', the deck will exclude ' + summary + '.';
    }

    document.getElementById('add-r-option').addEventListener('change', function () {
      syncForOption();
      updatePreview();
    });
    document.querySelectorAll('#add-r-slides input.add-r-slide').forEach(function (cb) {
      cb.addEventListener('change', updatePreview);
    });
    syncForOption();
    updatePreview();
  }

  async function commitAddRule(qid) {
    var optionId = document.getElementById('add-r-option').value;
    if (!optionId) {
      toast('Pick an option.', 'error');
      return;
    }
    // Pull every checked-and-enabled checkbox. Disabled boxes represent
    // rules that already exist for this option and would only trip the
    // unique-index error, so we skip them here.
    var picks = Array.from(document.querySelectorAll('#add-r-slides input.add-r-slide'))
      .filter(function (cb) { return cb.checked && !cb.disabled; })
      .map(function (cb) { return cb.value; });
    if (picks.length === 0) {
      toast('Check at least one slide to exclude.', 'error');
      return;
    }

    var rows = picks.map(function (slideId) {
      return {
        question_id: qid,
        option_id:   optionId,
        action:      'exclude_slide',
        slide_id:    slideId
      };
    });
    var res = await supa.from('footwear_question_rules').insert(rows);
    if (res.error) {
      // The DB has a unique index on (option_id, slide_id). If a
      // duplicate slips through (race against another admin or stale
      // state), translate the constraint error into something the
      // admin can act on.
      if (res.error.code === '23505') {
        toast('One of those slides already has a rule for this option. Refresh and try again.', 'error');
      } else {
        toast(prettyDbError(res.error, 'Could not create rule.'), 'error');
      }
      return;
    }
    closeModal();
    toast(rows.length === 1 ? 'Rule created.' : (rows.length + ' rules created.'), 'success');
    await render();
  }

  // ── DELETE RULE ───────────────────────────────────────────────────────────
  function showDeleteRuleModal(rid) {
    openModal(''
      + '<h3>Delete rule?</h3>'
      + '<p>Delete this rule? This cannot be undone.</p>'
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      +   '<button class="btn btn-danger" data-fw-action="commitDeleteRule" data-id="' + escapeAttr(rid) + '">Delete</button>'
      + '</div>');
  }

  async function commitDeleteRule(rid) {
    var res = await supa.from('footwear_question_rules').delete().eq('id', rid);
    closeModal();
    if (res.error) { toast(prettyDbError(res.error, 'Delete failed.'), 'error'); return; }
    toast('Rule deleted.', 'success');
    await render();
  }

  // ── ARCHIVE QUESTION (from detail; convenience same as toggle active off) ─
  // Provided as a separate path in case we later add a true delete.
  async function archiveQuestion(qid) {
    var res = await supa.from('footwear_questions').update({ is_active: false }).eq('id', qid);
    if (res.error) { toast(prettyDbError(res.error, 'Archive failed.'), 'error'); return; }
    toast('Question archived.', 'success');
    state.view = { type: 'list' };
    await render();
  }

  // ── ERROR FORMATTING ──────────────────────────────────────────────────────
  // Translate the most common Postgres / PostgREST errors into something a
  // sales admin can act on without reading SQL. Falls back to the generic
  // message for anything we have not seen.
  function prettyDbError(error, generic) {
    if (!error) return generic;
    if (error.code === '23505') {
      // unique_violation
      if (error.message && /question_key/.test(error.message))
        return 'A question with that key already exists. Pick a different key.';
      if (error.message && /option_key|footwear_question_options/.test(error.message))
        return 'An option with that key already exists in this question. Pick a different key.';
      if (error.message && /option_id.*slide_id/.test(error.message))
        return 'That option already has a rule for that slide. Delete the existing rule first.';
      return 'This change conflicts with an existing row. ' + (error.message || '');
    }
    if (error.code === '23503') {
      // foreign_key_violation
      return 'Cannot complete that change because another row depends on it.';
    }
    if (error.code === '42501') {
      // permission denied (RLS)
      return 'Your account does not have permission to make that change.';
    }
    return generic + (error.message ? ' (' + error.message + ')' : '');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDES (Phase B) ─ list, template picker, schema-driven editor
  // ═══════════════════════════════════════════════════════════════════════════

  var slideState = {
    view:          { type: 'list' },   // or { type: 'edit', isNew, slideId }
    slides:        [],
    templates:     [],                 // active rows from slide_templates
    slideProducts: [],                 // footwear_slide_products rows (all)
    // Editor working copy. Persists between renders so text typing does not
    // lose focus from full re-renders.
    editor: null, // populated on enterEditor; { template, content, common, productCache, productCacheById }
  };

  function panelSlides() { return document.getElementById('panel-slides'); }

  // ── DATA LOAD ──────────────────────────────────────────────────────────────
  async function loadSlidesData() {
    var sP  = supa.from('footwear_slides').select('*').order('default_position', { ascending: true });
    var tP  = supa.from('slide_templates').select('*').eq('is_active', true).order('display_name', { ascending: true });
    var spP = supa.from('footwear_slide_products').select('*').order('display_order', { ascending: true });

    var results = await Promise.all([sP, tP, spP]);
    if (results[0].error || results[1].error || results[2].error) {
      toast('Could not load slides data. Please refresh and try again.', 'error');
      return false;
    }
    slideState.slides        = results[0].data || [];
    slideState.templates     = results[1].data || [];
    slideState.slideProducts = results[2].data || [];
    return true;
  }

  function templateByKey(key) {
    for (var i = 0; i < slideState.templates.length; i++) {
      if (slideState.templates[i].template_key === key) return slideState.templates[i];
    }
    return null;
  }

  function slideById2(sid) {
    for (var i = 0; i < slideState.slides.length; i++) {
      if (slideState.slides[i].id === sid) return slideState.slides[i];
    }
    return null;
  }

  // ── RENDER DISPATCH ────────────────────────────────────────────────────────
  async function renderSlides() {
    var ok = await loadSlidesData();
    if (!ok) return;

    if (slideState.view.type === 'edit' && !slideState.view.isNew) {
      // If the slide we are editing was deleted out from under us, fall back.
      if (!slideById2(slideState.view.slideId)) slideState.view = { type: 'list' };
    }

    if (slideState.view.type === 'edit') renderSlideEditor();
    else renderSlideList();
  }

  // ── LIST VIEW ──────────────────────────────────────────────────────────────
  function renderSlideList() {
    var sorted = slideState.slides.slice().sort(function (a, b) {
      return (a.default_position || 0) - (b.default_position || 0);
    });

    var rowsHtml = sorted.map(function (s, i) {
      var atTop    = i === 0;
      var atBottom = i === sorted.length - 1;
      var tmpl     = templateByKey(s.template_key);
      var tmplName = tmpl ? tmpl.display_name : (s.template_key + ' (template archived)');
      return ''
        + '<tr>'
        +   '<td class="qn-reorder-col">'
        +     '<button class="btn btn-outline btn-sm" data-fw-action="moveSlide"'
        +            ' data-id="' + escapeAttr(s.id) + '" data-dir="up"'
        +            (atTop ? ' disabled style="opacity:0.4;cursor:not-allowed;"' : '')
        +            '>&uarr;</button> '
        +     '<button class="btn btn-outline btn-sm" data-fw-action="moveSlide"'
        +            ' data-id="' + escapeAttr(s.id) + '" data-dir="down"'
        +            (atBottom ? ' disabled style="opacity:0.4;cursor:not-allowed;"' : '')
        +            '>&darr;</button>'
        +   '</td>'
        +   '<td>' + (s.default_position || 0) + '</td>'
        +   '<td><b>' + escapeHtml(s.title) + '</b><br>'
        +     '<span class="qn-key">' + escapeHtml(s.slide_key) + '</span></td>'
        +   '<td>' + escapeHtml(tmplName) + '</td>'
        +   '<td>'
        +     '<input type="checkbox" data-fw-action="toggleSlideActive"'
        +           ' data-id="' + escapeAttr(s.id) + '"'
        +           (s.is_active ? ' checked' : '') + '>'
        +   '</td>'
        +   '<td class="qn-actions-col">'
        +     '<button class="btn btn-outline btn-sm" data-fw-action="editSlide" data-id="' + escapeAttr(s.id) + '">Edit</button> '
        +     '<button class="btn btn-danger btn-sm" data-fw-action="deleteSlide" data-id="' + escapeAttr(s.id) + '">Delete</button>'
        +   '</td>'
        + '</tr>';
    }).join('');

    panelSlides().innerHTML = ''
      + '<div class="section-title">Slides</div>'
      + '<div class="section-sub">Slides are the building blocks of the customer-facing deck. Each slide is rendered by a template (chosen at create time) and filled with content. The default order is overridden per draft once questionnaire rules apply.</div>'
      + '<div class="toolbar">'
      +   '<button class="btn btn-primary" data-fw-action="newSlide">+ New slide</button>'
      +   '<span class="row-count">' + sorted.length + ' slide' + (sorted.length === 1 ? '' : 's') + '</span>'
      + '</div>'
      + (sorted.length === 0
          ? '<div class="empty-state">No slides yet. Click "New slide" to start.</div>'
          : ''
            + '<div class="grid-wrap">'
            +   '<table class="data-grid qn-list">'
            +     '<thead>'
            +       '<tr>'
            +         '<th class="qn-reorder-col">Reorder</th>'
            +         '<th>Order</th>'
            +         '<th>Title</th>'
            +         '<th>Template</th>'
            +         '<th>Active</th>'
            +         '<th class="qn-actions-col"></th>'
            +       '</tr>'
            +     '</thead>'
            +     '<tbody>' + rowsHtml + '</tbody>'
            +   '</table>'
            + '</div>');
  }

  // ── REORDER SLIDES ─────────────────────────────────────────────────────────
  async function moveSlide(sid, dir) {
    var sorted = slideState.slides.slice().sort(function (a, b) {
      return (a.default_position || 0) - (b.default_position || 0);
    });
    var i = sorted.findIndex(function (s) { return s.id === sid; });
    if (i < 0) return;
    var j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= sorted.length) return;
    var a = sorted[i], b = sorted[j];

    var aRes = await supa.from('footwear_slides').update({ default_position: b.default_position }).eq('id', a.id);
    if (aRes.error) { toast(prettyDbError(aRes.error, 'Reorder failed.'), 'error'); return; }
    var bRes = await supa.from('footwear_slides').update({ default_position: a.default_position }).eq('id', b.id);
    if (bRes.error) { toast(prettyDbError(bRes.error, 'Reorder failed.'), 'error'); return; }
    await renderSlides();
  }

  async function toggleSlideActive(sid, active) {
    var res = await supa.from('footwear_slides').update({ is_active: active }).eq('id', sid);
    if (res.error) { toast(prettyDbError(res.error, 'Update failed.'), 'error'); return; }
    await renderSlides();
  }

  // ── DELETE SLIDE ───────────────────────────────────────────────────────────
  function showDeleteSlideModal(sid) {
    var s = slideById2(sid);
    if (!s) return;
    openModal(''
      + '<h3>Delete slide?</h3>'
      + '<p>Delete slide <b>' + escapeHtml(s.title) + '</b>? This cannot be undone. Any rules referencing this slide will also be removed.</p>'
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      +   '<button class="btn btn-danger" data-fw-action="commitDeleteSlide" data-id="' + escapeAttr(sid) + '">Delete</button>'
      + '</div>');
  }

  async function commitDeleteSlide(sid) {
    var res = await supa.from('footwear_slides').delete().eq('id', sid);
    closeModal();
    if (res.error) { toast(prettyDbError(res.error, 'Delete failed.'), 'error'); return; }
    toast('Slide deleted.', 'success');
    await renderSlides();
  }

  // ── TEMPLATE PICKER ────────────────────────────────────────────────────────
  function showTemplatePickerModal() {
    if (slideState.templates.length === 0) {
      toast('No active slide templates. Engineering needs to seed at least one row in slide_templates.', 'error');
      return;
    }
    var cards = slideState.templates.map(function (t) {
      var img = t.preview_image_url
        ? '<img class="tpl-card-img" src="' + escapeAttr(t.preview_image_url) + '" alt="">'
        : '<div class="tpl-card-img tpl-card-img-empty">no preview</div>';
      return ''
        + '<button class="tpl-card" data-fw-action="pickTemplate" data-key="' + escapeAttr(t.template_key) + '">'
        +   img
        +   '<div class="tpl-card-name">' + escapeHtml(t.display_name) + '</div>'
        +   '<div class="tpl-card-desc">' + escapeHtml(t.description || '') + '</div>'
        +   '<div class="tpl-card-key">' + escapeHtml(t.template_key) + '</div>'
        + '</button>';
    }).join('');

    openModal(''
      + '<h3>Pick a template</h3>'
      + '<p>Templates are coded by engineering and define what content slots a slide accepts. The template you pick is locked for the slide\'s lifetime.</p>'
      + '<div class="tpl-gallery">' + cards + '</div>'
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      + '</div>');
  }

  function pickTemplate(templateKey) {
    var tmpl = templateByKey(templateKey);
    if (!tmpl) { toast('Template not found.', 'error'); return; }

    // Pre-generate slide id so media uploads can target slides/{id}/...
    // before the row exists in the DB. If the admin abandons, the bucket
    // ends up with orphaned files at that path; cleanup is a separate task.
    var newSlideId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : fallbackUuid();

    slideState.editor = {
      isNew:          true,
      slideId:        newSlideId,
      template:       tmpl,
      content:        defaultsForSchema(tmpl.content_schema || {}),
      common: {
        title:            '',
        slide_key:        '',
        default_position: nextSlidePosition(),
        is_active:        true,
      },
      productCache:     {},  // id -> { id, sku, name }
      pendingUploads:   {},  // path string -> bool (currently uploading)
      slideProducts:    [],  // ordered array of product_ids attached to this slide (Phase 3)
    };
    slideState.view = { type: 'edit', isNew: true, slideId: newSlideId };
    closeModal();
    renderSlides();
  }

  function nextSlidePosition() {
    var max = 0;
    for (var i = 0; i < slideState.slides.length; i++) {
      if (slideState.slides[i].default_position > max) max = slideState.slides[i].default_position;
    }
    return max + 10; // 10-step gap so manual reorders have room
  }

  function fallbackUuid() {
    // RFC4122 v4 fallback for browsers without crypto.randomUUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Walk a JSON Schema and produce a content object that matches its
  // structure with empty / sensible defaults. Used to seed a new slide.
  function defaultsForSchema(schema) {
    if (!schema || schema.type !== 'object') return {};
    var out = {};
    var props = schema.properties || {};
    var required = (schema.required || []);
    for (var name in props) {
      if (required.indexOf(name) >= 0) {
        var s = props[name];
        if (s.type === 'string')      out[name] = (s.enum && s.enum[0]) || '';
        else if (s.type === 'number') out[name] = 0;
        else if (s.type === 'integer') out[name] = 0;
        else if (s.type === 'boolean') out[name] = false;
        else if (s.type === 'array')  out[name] = [];
        else if (s.type === 'object') out[name] = defaultsForSchema(s);
      }
    }
    return out;
  }

  // ── ENTER EDITOR FOR EXISTING SLIDE ────────────────────────────────────────
  async function enterSlideEditor(sid) {
    var s = slideById2(sid);
    if (!s) { toast('Slide not found.', 'error'); return; }
    var tmpl = templateByKey(s.template_key);
    if (!tmpl) {
      toast('The template for this slide is no longer active. Editing is disabled.', 'error');
      return;
    }
    slideState.editor = {
      isNew:    false,
      slideId:  s.id,
      template: tmpl,
      content:  JSON.parse(JSON.stringify(s.content || {})),
      common: {
        title:            s.title || '',
        slide_key:        s.slide_key,
        default_position: s.default_position || 0,
        is_active:        !!s.is_active,
      },
      productCache:   {},
      pendingUploads: {},
      slideProducts:  [],   // populated below from footwear_slide_products
    };

    // Load slide-level product attachments (Phase 3). The junction is the
    // source of truth; cart.renderProductCard etc. expect `name` and
    // `sizes` aliases so we set those here too.
    var spRes = await supa.from('footwear_slide_products')
                          .select('product_id, display_order')
                          .eq('slide_id', s.id)
                          .order('display_order', { ascending: true });
    if (!spRes.error && spRes.data) {
      slideState.editor.slideProducts = spRes.data.map(function (r) { return r.product_id; });
    }

    // Prefetch product info (sku, name) for the chips in the slide-level
    // Products card. We use the slide-level list as the source of truth.
    var ids = (slideState.editor.slideProducts || []).slice();
    if (ids.length > 0) {
      var prodRes = await supa.from('products').select('id, sku, name:product_name').in('id', ids);
      if (!prodRes.error && prodRes.data) {
        prodRes.data.forEach(function (p) { slideState.editor.productCache[p.id] = p; });
      }
    }

    slideState.view = { type: 'edit', isNew: false, slideId: s.id };
    renderSlides();
  }

  // ── EDITOR VIEW ────────────────────────────────────────────────────────────
  function renderSlideEditor() {
    var ed = slideState.editor;
    if (!ed) { slideState.view = { type: 'list' }; return renderSlideList(); }

    var schema = ed.template.content_schema || {};

    panelSlides().innerHTML = ''
      + '<div class="qn-back">'
      +   '<button class="btn btn-outline btn-sm" data-fw-action="backToSlideList">&larr; Back to slides</button>'
      + '</div>'

      + '<div class="slide-editor-grid">'
      +   '<div class="slide-editor-form">'

      // Common fields card
      +     '<div class="qn-card">'
      +       '<div class="qn-card-title">' + (ed.isNew ? 'New slide' : 'Slide settings') + '</div>'
      +       '<div class="qn-key-line">Template: <code>' + escapeHtml(ed.template.template_key) + '</code> '
      +         '<span class="qn-locked-tag">(locked after creation)</span></div>'
      +       renderCommonFieldsForm(ed.common, ed.isNew)
      +     '</div>'

      // Schema-driven content card
      +     '<div class="qn-card">'
      +       '<div class="qn-card-title">Content</div>'
      +       '<div class="qn-card-sub">Fields are generated from the template\'s content schema. Required slots are marked with a red dot.</div>'
      +       '<div class="slide-content-form">'
      +         renderSchemaForm(schema, ed.content, [])
      +       '</div>'
      +     '</div>'

      // Products card (Phase 3): slide-level product attachments. Independent
      // of the template; whatever is attached here renders in the customer-
      // facing strip drawer in the order shown.
      +     renderSlideProductsCard()

      // Action bar
      +     '<div class="qn-card">'
      +       '<div class="slide-editor-actions">'
      +         '<button class="btn btn-primary" data-fw-action="saveSlide">' + (ed.isNew ? 'Create slide' : 'Save slide') + '</button> '
      +         '<button class="btn btn-outline" data-fw-action="backToSlideList">Cancel</button>'
      +       '</div>'
      +     '</div>'

      +   '</div>'

      // Preview pane (placeholder until Section 4 templates land)
      +   '<aside class="slide-editor-preview">'
      +     '<div class="qn-card-title">Preview</div>'
      +     '<div class="slide-preview-placeholder">'
      +       '<div class="slide-preview-icon">[preview]</div>'
      +       '<p>Live preview becomes available once the customer-facing template modules ship in Section 4.</p>'
      +       '<p>For now, save the slide to verify it lands correctly in the database. Content is validated against the template schema on save; missing or malformed slots are rejected with a clear error.</p>'
      +     '</div>'
      +   '</aside>'

      + '</div>';

    wireSlideEditorListeners();
  }

  function renderCommonFieldsForm(c, isNew) {
    return ''
      + '<div class="qn-form">'
      +   '<label>Title<input type="text" data-fw-common="title" value="' + escapeAttr(c.title) + '" maxlength="200"></label>'
      +   '<label>Slide key' + (isNew ? '' : ' <span class="qn-locked-tag">(locked)</span>')
      +     '<input type="text" data-fw-common="slide_key" value="' + escapeAttr(c.slide_key) + '" maxlength="80"' + (isNew ? '' : ' disabled') + '>'
      +   '</label>'
      +   '<label>Default position'
      +     '<input type="number" data-fw-common="default_position" value="' + (c.default_position || 0) + '">'
      +   '</label>'
      +   '<label class="qn-active-line">'
      +     '<input type="checkbox" data-fw-common="is_active"' + (c.is_active ? ' checked' : '') + '>'
      +     ' Active'
      +   '</label>'
      + '</div>';
  }

  // ── SCHEMA FORM GENERATOR ─────────────────────────────────────────────────
  // Walks a JSON Schema (object root) and renders the matching form. The
  // value at each leaf is read from `value` argument and lives at the
  // path prefix passed in. The slot's data-fw-path attribute is the
  // JSON-stringified array path; on input we update editor.content[path].

  function renderSchemaForm(schema, value, path) {
    if (!schema || !schema.properties) return '<div class="qn-card-sub">Template has no content slots.</div>';

    var required = schema.required || [];
    var html = '';
    var props = schema.properties;
    for (var name in props) {
      var sub = props[name];
      var subValue = value ? value[name] : undefined;
      var subPath = path.concat([name]);
      var isRequired = required.indexOf(name) >= 0;
      html += renderFieldBlock(name, sub, subValue, subPath, isRequired);
    }
    return html;
  }

  function renderFieldBlock(name, schema, value, path, isRequired) {
    var kind = detectFieldKind(name, schema);

    // Phase 3 retires the schema-driven product slot UI in favour of the
    // slide-level Products card below the content. The content_schema
    // entries can still exist (we leave them alone for now; Phase 5
    // cleans them up), and the value in ed.content is preserved on save
    // so we don't corrupt template_content. We just don't render an
    // editor surface for these slots any more.
    if (kind === 'product_id' || kind === 'product_ids') return '';

    var label = humanLabel(name) + (isRequired ? ' <span class="slot-required" title="Required">*</span>' : '');
    var pathAttr = escapeAttr(JSON.stringify(path));

    var inner;
    if      (kind === 'enum')          inner = renderEnumField(schema, value, pathAttr);
    else if (kind === 'media_url')     inner = renderMediaField(value, pathAttr);
    else if (kind === 'cta')           inner = renderCtaField(schema, value || {}, path);
    else if (kind === 'object')        inner = '<div class="slot-object">' + renderSchemaForm(schema, value || {}, path) + '</div>';
    else if (kind === 'array_objects') inner = renderArrayObjectsField(schema, value || [], path);
    else if (kind === 'text_block')    inner = renderTextBlockField(schema, value, pathAttr);
    else if (kind === 'number')        inner = renderNumberField(schema, value, pathAttr);
    else if (kind === 'boolean')       inner = renderBooleanField(value, pathAttr);
    else                                inner = renderTextField(schema, value, pathAttr);

    return ''
      + '<div class="slot-block slot-' + kind + '">'
      +   '<div class="slot-label">' + label + '</div>'
      +   inner
      + '</div>';
  }

  // Property-name + schema-based heuristic. The seed templates lean on
  // these conventions; if a future template needs an explicit hint we can
  // add an x-fieldType keyword to the schema and check it here first.
  function detectFieldKind(name, schema) {
    if (!schema) return 'text';
    if (schema['x-fieldType']) return schema['x-fieldType'];

    if (schema.type === 'string') {
      if (Array.isArray(schema.enum)) return 'enum';
      if (/_url$/.test(name) || name === 'url') return 'media_url';
      if (name === 'product_id' || /_product_id$/.test(name)) return 'product_id';
      if (!schema.maxLength || schema.maxLength > 250) return 'text_block';
      return 'text';
    }
    if (schema.type === 'array') {
      if ((name === 'product_ids' || /_product_ids$/.test(name))
          && schema.items && schema.items.type === 'string') return 'product_ids';
      if (schema.items && schema.items.type === 'object') return 'array_objects';
      return 'text';
    }
    if (schema.type === 'object') {
      var keys = Object.keys(schema.properties || {});
      if (keys.length === 2 && keys.indexOf('label') >= 0 && keys.indexOf('target') >= 0) return 'cta';
      return 'object';
    }
    if (schema.type === 'integer' || schema.type === 'number') return 'number';
    if (schema.type === 'boolean') return 'boolean';
    return 'text';
  }

  function humanLabel(name) {
    return escapeHtml(String(name).replace(/_/g, ' ').replace(/\b./g, function (c) { return c.toUpperCase(); }));
  }

  // ── INDIVIDUAL FIELD RENDERERS ─────────────────────────────────────────────
  function renderTextField(schema, value, pathAttr) {
    var v = (value === undefined || value === null) ? '' : String(value);
    var max = schema.maxLength ? ' maxlength="' + schema.maxLength + '"' : '';
    return '<input type="text" class="slot-input" data-fw-path="' + pathAttr + '" value="' + escapeAttr(v) + '"' + max + '>';
  }

  function renderTextBlockField(schema, value, pathAttr) {
    var v = (value === undefined || value === null) ? '' : String(value);
    var max = schema.maxLength ? ' maxlength="' + schema.maxLength + '"' : '';
    var counter = schema.maxLength ? '<div class="slot-counter">' + v.length + ' / ' + schema.maxLength + '</div>' : '';
    return '<textarea class="slot-input slot-textarea" rows="4" data-fw-path="' + pathAttr + '"' + max + '>' + escapeHtml(v) + '</textarea>' + counter;
  }

  function renderEnumField(schema, value, pathAttr) {
    var opts = (schema.enum || []).map(function (e) {
      var sel = (value === e) ? ' selected' : '';
      return '<option value="' + escapeAttr(e) + '"' + sel + '>' + escapeHtml(e) + '</option>';
    }).join('');
    return '<select class="slot-input" data-fw-path="' + pathAttr + '">' + opts + '</select>';
  }

  function renderNumberField(schema, value, pathAttr) {
    var v = (value === undefined || value === null) ? '' : String(value);
    return '<input type="number" class="slot-input" data-fw-path="' + pathAttr + '" value="' + escapeAttr(v) + '">';
  }

  function renderBooleanField(value, pathAttr) {
    return '<label><input type="checkbox" data-fw-path="' + pathAttr + '"' + (value ? ' checked' : '') + '> Yes</label>';
  }

  // ── MEDIA SLOT ─────────────────────────────────────────────────────────────
  function renderMediaField(value, pathAttr) {
    var hasValue = !!value;
    var preview = hasValue
      ? '<div class="slot-media-preview"><img src="' + escapeAttr(value) + '" alt=""></div>'
      : '<div class="slot-media-empty">No file uploaded yet.</div>';
    var url = hasValue
      ? '<input type="text" class="slot-input" data-fw-path="' + pathAttr + '" value="' + escapeAttr(value) + '" placeholder="Paste a URL or upload a file">'
      : '<input type="text" class="slot-input" data-fw-path="' + pathAttr + '" value="" placeholder="Paste a URL or upload a file">';
    return ''
      + '<div class="slot-media">'
      +   preview
      +   '<div class="slot-media-controls">'
      +     '<label class="btn btn-outline btn-sm" style="cursor:pointer;">Upload file'
      +       '<input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" style="display:none" data-fw-action="uploadMedia" data-fw-path="' + pathAttr + '">'
      +     '</label>'
      +     (hasValue ? ' <button class="btn btn-outline btn-sm" data-fw-action="clearMedia" data-fw-path="' + pathAttr + '">Clear</button>' : '')
      +   '</div>'
      +   url
      + '</div>';
  }

  // Translate a Supabase storage error into a message that points at the
  // most likely fix. The raw error text is appended in parens so we never
  // hide what the storage layer actually said.
  function prettyUploadError(err) {
    var msg  = (err && err.message) || 'Upload failed.';
    var stat = err && (err.statusCode || err.status);
    if (/violates row-level security/i.test(msg) || /not authorized/i.test(msg) || stat === 401 || stat === 403 || stat === '401' || stat === '403') {
      return 'Upload blocked by storage permissions. The footwear-media bucket\'s RLS calls public.is_admin(); update that function to match your admin auth pattern (it likely needs to query salespeople rather than read a JWT claim). Raw error: ' + msg;
    }
    if (/bucket not found/i.test(msg) || /not found/i.test(msg) || stat === 404 || stat === '404') {
      return 'The footwear-media bucket does not exist on this database. Apply migration 0007_storage_bucket.sql. Raw error: ' + msg;
    }
    if (/mime type/i.test(msg) || /content[- ]?type/i.test(msg)) {
      return 'The bucket rejected the file type. The footwear-media bucket only accepts JPEG, PNG, WebP, MP4, and WebM. Raw error: ' + msg;
    }
    if (/exceeded|too large|size/i.test(msg)) {
      return 'The file is over the bucket\'s size limit (50 MB). Raw error: ' + msg;
    }
    if (/duplicate/i.test(msg)) {
      return 'A file with that path already exists. Try renaming the file. Raw error: ' + msg;
    }
    return 'Upload failed: ' + msg;
  }

  async function uploadMediaForSlot(file, path) {
    var ed = slideState.editor;
    if (!ed) return;
    var allowed = ['image/jpeg','image/png','image/webp','video/mp4','video/webm'];
    if (allowed.indexOf(file.type) < 0) {
      toast('Unsupported file type. Use JPEG, PNG, WebP, MP4, or WebM.', 'error');
      return;
    }
    var maxBytes = 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      toast('File is larger than the 50 MB bucket limit.', 'error');
      return;
    }

    // Build a safe filename: slugify base name, keep extension.
    var clean = String(file.name || 'upload')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120);
    if (!clean) clean = 'upload';
    var key = 'slides/' + ed.slideId + '/' + Date.now() + '_' + clean;

    toast('Uploading ' + file.name + '...', 'info');
    var upRes = await supa.storage.from('footwear-media').upload(key, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type,
    });
    if (upRes.error) {
      toast(prettyUploadError(upRes.error), 'error');
      return;
    }
    var pubRes = supa.storage.from('footwear-media').getPublicUrl(key);
    var url = pubRes.data && pubRes.data.publicUrl;
    if (!url) {
      toast('Could not resolve public URL after upload.', 'error');
      return;
    }
    setValueAtPath(ed.content, path, url);
    toast('Uploaded.', 'success');
    renderSlideEditor();
  }

  // ── PRODUCT PICKER (single + multi) ────────────────────────────────────────
  function renderProductIdField(value, pathAttr, multi) {
    var ed = slideState.editor;
    var ids = multi ? (Array.isArray(value) ? value : []) : (value ? [value] : []);
    var chips = ids.map(function (pid, i) {
      var prod = ed && ed.productCache[pid];
      var label = prod ? (prod.sku + ' ' + (prod.name || '')) : pid;
      var moveBtns = multi ? (''
        + ' <button class="btn btn-outline btn-sm" data-fw-action="moveProduct" data-fw-path="' + pathAttr + '" data-idx="' + i + '" data-dir="up"' + (i === 0 ? ' disabled style="opacity:0.4;"' : '') + '>&uarr;</button>'
        + ' <button class="btn btn-outline btn-sm" data-fw-action="moveProduct" data-fw-path="' + pathAttr + '" data-idx="' + i + '" data-dir="down"' + (i === ids.length - 1 ? ' disabled style="opacity:0.4;"' : '') + '>&darr;</button>'
      ) : '';
      return ''
        + '<li class="product-chip">'
        +   '<span class="product-chip-label">' + escapeHtml(label) + '</span>'
        +   moveBtns
        +   ' <button class="btn btn-danger btn-sm" data-fw-action="removeProduct" data-fw-path="' + pathAttr + '" data-idx="' + i + '">Remove</button>'
        + '</li>';
    }).join('');

    var ctaText = multi ? '+ Add product' : (ids.length > 0 ? 'Replace product' : '+ Pick product');
    return ''
      + '<div class="slot-products">'
      +   (chips ? '<ul class="product-chips">' + chips + '</ul>' : '<div class="qn-card-sub">No products selected.</div>')
      +   '<button class="btn btn-outline btn-sm" data-fw-action="openProductPicker" data-fw-path="' + pathAttr + '" data-multi="' + (multi ? '1' : '0') + '">' + ctaText + '</button>'
      + '</div>';
  }

  function showProductPickerModal(pathAttr, multi) {
    openModal(''
      + '<h3>' + (multi ? 'Add product' : 'Pick product') + '</h3>'
      + '<p>Search by SKU or name. Only footwear products appear.</p>'
      + '<input type="text" class="slot-input" id="product-search" placeholder="Type to search...">'
      + '<div id="product-results" class="product-picker-results"><div class="qn-card-sub">Type at least 2 characters.</div></div>'
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      + '</div>');

    var input = document.getElementById('product-search');
    var debounceTimer;
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var q = input.value.trim();
      if (q.length < 2) {
        document.getElementById('product-results').innerHTML = '<div class="qn-card-sub">Type at least 2 characters.</div>';
        return;
      }
      debounceTimer = setTimeout(function () { runProductSearch(q, pathAttr, multi); }, 200);
    });
    input.focus();
  }

  async function runProductSearch(q, pathAttr, multi) {
    var resBox = document.getElementById('product-results');
    if (!resBox) return;
    resBox.innerHTML = '<div class="qn-card-sub">Searching...</div>';
    var pattern = '%' + q.replace(/[%_]/g, '') + '%';
    // The products table column is `product_name` (matches the apparel
    // schema); alias it as `name` here so the rest of this module can
    // keep reading r.name.
    var res = await supa.from('products')
                        .select('id, sku, name:product_name')
                        .eq('category', 'footwear')
                        .or('sku.ilike.' + pattern + ',product_name.ilike.' + pattern)
                        .limit(50);
    if (res.error) {
      resBox.innerHTML = '<div class="qn-card-sub">Search failed: ' + escapeHtml(res.error.message || '') + '</div>';
      return;
    }
    var rows = res.data || [];
    if (rows.length === 0) {
      resBox.innerHTML = '<div class="qn-card-sub">No matches.</div>';
      return;
    }
    var ed = slideState.editor;
    if (ed) {
      rows.forEach(function (r) { ed.productCache[r.id] = r; });
    }
    // pathAttr arrived from el.dataset.fwPath which the browser already
    // un-escaped (e.g. &quot; -> "). Re-escape it before embedding into
    // a fresh HTML attribute, otherwise the embedded quotes break the
    // attribute and pickProduct's JSON.parse(el.dataset.fwPath) throws.
    var pathAttrSafe = escapeAttr(pathAttr);
    resBox.innerHTML = rows.map(function (r) {
      return ''
        + '<button class="product-result" data-fw-action="pickProduct" data-fw-path="' + pathAttrSafe + '" data-multi="' + (multi ? '1' : '0') + '" data-id="' + escapeAttr(r.id) + '">'
        +   '<span class="product-result-sku">' + escapeHtml(r.sku) + '</span>'
        +   '<span class="product-result-name">' + escapeHtml(r.name || '') + '</span>'
        + '</button>';
    }).join('');
  }

  function pickProduct(pathStr, multi, productId) {
    var ed = slideState.editor;
    if (!ed) return;
    var path = JSON.parse(pathStr);
    var current = getValueAtPath(ed.content, path);
    if (multi) {
      var arr = Array.isArray(current) ? current.slice() : [];
      if (arr.indexOf(productId) >= 0) {
        toast('Already added.', 'info');
        return;
      }
      arr.push(productId);
      setValueAtPath(ed.content, path, arr);
    } else {
      setValueAtPath(ed.content, path, productId);
    }
    closeModal();
    renderSlideEditor();
  }

  function removeProductAt(pathStr, idx) {
    var ed = slideState.editor;
    if (!ed) return;
    var path = JSON.parse(pathStr);
    var current = getValueAtPath(ed.content, path);
    if (Array.isArray(current)) {
      var arr = current.slice();
      arr.splice(idx, 1);
      setValueAtPath(ed.content, path, arr);
    } else {
      setValueAtPath(ed.content, path, undefined);
    }
    renderSlideEditor();
  }

  function moveProductAt(pathStr, idx, dir) {
    var ed = slideState.editor;
    if (!ed) return;
    var path = JSON.parse(pathStr);
    var current = getValueAtPath(ed.content, path);
    if (!Array.isArray(current)) return;
    var j = dir === 'up' ? idx - 1 : idx + 1;
    if (j < 0 || j >= current.length) return;
    var arr = current.slice();
    var tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
    setValueAtPath(ed.content, path, arr);
    renderSlideEditor();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE-LEVEL PRODUCTS CARD (Phase 3)
  // ═══════════════════════════════════════════════════════════════════════════
  // Independent of the template's content_schema. Authors attach up to 12
  // footwear products to any slide; the customer-facing strip drawer renders
  // them in the order shown here. Save path calls the set_slide_products RPC
  // which atomically rewrites footwear_slide_products inside a single
  // transaction.
  // ═══════════════════════════════════════════════════════════════════════════

  var SLIDE_PRODUCTS_CAP = 12;

  function renderSlideProductsCard() {
    var ed = slideState.editor;
    if (!ed) return '';

    var products = (ed.slideProducts || []).slice();
    var atCap = products.length >= SLIDE_PRODUCTS_CAP;

    var chipsHtml = products.map(function (pid, i) {
      var prod  = ed.productCache[pid];
      var label = prod ? (prod.sku + ' ' + (prod.name || '')) : pid;
      var atTop = i === 0;
      var atEnd = i === products.length - 1;
      return ''
        + '<li class="product-chip">'
        +   '<span class="product-chip-label">' + escapeHtml(label) + '</span>'
        +   ' <button class="btn btn-outline btn-sm" data-fw-action="moveSlideProduct" data-idx="' + i + '" data-dir="up"' + (atTop ? ' disabled style="opacity:0.4;"' : '') + '>&uarr;</button>'
        +   ' <button class="btn btn-outline btn-sm" data-fw-action="moveSlideProduct" data-idx="' + i + '" data-dir="down"' + (atEnd ? ' disabled style="opacity:0.4;"' : '') + '>&darr;</button>'
        +   ' <button class="btn btn-danger btn-sm" data-fw-action="removeSlideProduct" data-idx="' + i + '">Remove</button>'
        + '</li>';
    }).join('');

    var listHtml = chipsHtml
      ? '<ul class="product-chips">' + chipsHtml + '</ul>'
      : '<div class="qn-card-sub">No products attached yet.</div>';

    var capMessage = atCap
      ? '<div class="qn-card-sub" style="color:#C0272D;margin-top:8px;">'
      +   'Maximum ' + SLIDE_PRODUCTS_CAP + ' products per slide. Remove one to add another.'
      + '</div>'
      : '';

    return ''
      + '<div class="qn-card">'
      +   '<div class="qn-card-title">Products on this slide '
      +     '<span class="qn-card-sub" style="font-weight:normal;">(' + products.length + ' / ' + SLIDE_PRODUCTS_CAP + ')</span>'
      +   '</div>'
      +   '<div class="qn-card-sub">'
      +     'Attach up to ' + SLIDE_PRODUCTS_CAP + ' footwear products. They render in the customer-facing slide drawer in the order shown here.'
      +   '</div>'
      +   listHtml
      +   '<button class="btn btn-outline btn-sm" data-fw-action="openSlideProductPicker"' + (atCap ? ' disabled' : '') + '>'
      +     (products.length === 0 ? '+ Add first product' : '+ Add product')
      +   '</button>'
      +   capMessage
      + '</div>';
  }

  function showSlideProductPickerModal() {
    openModal(''
      + '<h3>Attach product to slide</h3>'
      + '<p>Search by SKU or name. Only footwear products appear.</p>'
      + '<input type="text" class="slot-input" id="slide-product-search" placeholder="Type to search...">'
      + '<div id="slide-product-results" class="product-picker-results"><div class="qn-card-sub">Type at least 2 characters.</div></div>'
      + '<div class="modal-actions">'
      +   '<button class="btn btn-outline" data-action="closeModal">Cancel</button>'
      + '</div>');

    var input = document.getElementById('slide-product-search');
    var debounceTimer;
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var q = input.value.trim();
      if (q.length < 2) {
        document.getElementById('slide-product-results').innerHTML = '<div class="qn-card-sub">Type at least 2 characters.</div>';
        return;
      }
      debounceTimer = setTimeout(function () { runSlideProductSearch(q); }, 250);
    });
    input.focus();
  }

  async function runSlideProductSearch(q) {
    var resBox = document.getElementById('slide-product-results');
    if (!resBox) return;
    resBox.innerHTML = '<div class="qn-card-sub">Searching...</div>';
    var pattern = '%' + q.replace(/[%_]/g, '') + '%';
    var res = await supa.from('products')
                        .select('id, sku, name:product_name')
                        .eq('category', 'footwear')
                        .or('sku.ilike.' + pattern + ',product_name.ilike.' + pattern)
                        .limit(50);
    if (res.error) {
      resBox.innerHTML = '<div class="qn-card-sub">Search failed: ' + escapeHtml(res.error.message || '') + '</div>';
      return;
    }
    var rows = res.data || [];
    if (rows.length === 0) {
      resBox.innerHTML = '<div class="qn-card-sub">No matches.</div>';
      return;
    }
    var ed = slideState.editor;
    if (ed) {
      rows.forEach(function (r) { ed.productCache[r.id] = r; });
    }
    // Mark products already on the slide so the author cannot duplicate.
    var alreadyOn = {};
    if (ed && ed.slideProducts) {
      ed.slideProducts.forEach(function (id) { alreadyOn[id] = true; });
    }
    resBox.innerHTML = rows.map(function (r) {
      var disabled = alreadyOn[r.id] ? ' disabled style="opacity:0.45;cursor:not-allowed;"' : '';
      var note     = alreadyOn[r.id] ? ' <span class="qn-card-sub">(already attached)</span>' : '';
      return ''
        + '<button class="product-result" data-fw-action="pickSlideProduct" data-id="' + escapeAttr(r.id) + '"' + disabled + '>'
        +   '<span class="product-result-sku">' + escapeHtml(r.sku) + '</span>'
        +   '<span class="product-result-name">' + escapeHtml(r.name || '') + '</span>'
        +   note
        + '</button>';
    }).join('');
  }

  function pickSlideProduct(productId) {
    var ed = slideState.editor;
    if (!ed) return;
    ed.slideProducts = ed.slideProducts || [];
    if (ed.slideProducts.indexOf(productId) >= 0) {
      toast('Already attached to this slide.', 'info');
      return;
    }
    if (ed.slideProducts.length >= SLIDE_PRODUCTS_CAP) {
      toast('Maximum ' + SLIDE_PRODUCTS_CAP + ' products per slide.', 'error');
      return;
    }
    ed.slideProducts.push(productId);
    closeModal();
    renderSlideEditor();
  }

  function removeSlideProductAt(idx) {
    var ed = slideState.editor;
    if (!ed || !Array.isArray(ed.slideProducts)) return;
    if (idx < 0 || idx >= ed.slideProducts.length) return;
    ed.slideProducts.splice(idx, 1);
    renderSlideEditor();
  }

  function moveSlideProductAt(idx, dir) {
    var ed = slideState.editor;
    if (!ed || !Array.isArray(ed.slideProducts)) return;
    var j = dir === 'up' ? idx - 1 : idx + 1;
    if (j < 0 || j >= ed.slideProducts.length) return;
    var arr = ed.slideProducts.slice();
    var tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
    ed.slideProducts = arr;
    renderSlideEditor();
  }

  // ── ARRAY OF OBJECTS ─ sub-form list with add / remove / reorder ──────────
  function renderArrayObjectsField(schema, value, path) {
    var items = Array.isArray(value) ? value : [];
    var itemSchema = schema.items || { type: 'object', properties: {} };
    var maxItems = schema.maxItems;
    var canAddMore = !maxItems || items.length < maxItems;

    var subFormsHtml = items.map(function (item, i) {
      var atTop    = i === 0;
      var atBottom = i === items.length - 1;
      return ''
        + '<div class="array-item">'
        +   '<div class="array-item-header">'
        +     '<span class="array-item-label">Item ' + (i + 1) + '</span>'
        +     '<div class="array-item-controls">'
        +       '<button class="btn btn-outline btn-sm" data-fw-action="moveArrayItem" data-fw-path="' + escapeAttr(JSON.stringify(path)) + '" data-idx="' + i + '" data-dir="up"' + (atTop ? ' disabled style="opacity:0.4;"' : '') + '>&uarr;</button> '
        +       '<button class="btn btn-outline btn-sm" data-fw-action="moveArrayItem" data-fw-path="' + escapeAttr(JSON.stringify(path)) + '" data-idx="' + i + '" data-dir="down"' + (atBottom ? ' disabled style="opacity:0.4;"' : '') + '>&darr;</button> '
        +       '<button class="btn btn-danger btn-sm" data-fw-action="removeArrayItem" data-fw-path="' + escapeAttr(JSON.stringify(path)) + '" data-idx="' + i + '">Remove</button>'
        +     '</div>'
        +   '</div>'
        +   renderSchemaForm(itemSchema, item, path.concat([i]))
        + '</div>';
    }).join('');

    var addBtn = canAddMore
      ? '<button class="btn btn-primary btn-sm" data-fw-action="addArrayItem" data-fw-path="' + escapeAttr(JSON.stringify(path)) + '">+ Add item</button>'
      : '<div class="qn-card-sub">Maximum items reached.</div>';

    return '<div class="slot-array">' + (subFormsHtml || '<div class="qn-card-sub">No items yet.</div>') + '<div class="slot-array-actions">' + addBtn + '</div></div>';
  }

  function addArrayItem(pathStr) {
    var ed = slideState.editor;
    if (!ed) return;
    var path = JSON.parse(pathStr);
    // Look up the items schema from the template
    var schemaAt = walkSchema(ed.template.content_schema, path);
    var itemSchema = (schemaAt && schemaAt.items) || { type: 'object' };
    var current = getValueAtPath(ed.content, path);
    var arr = Array.isArray(current) ? current.slice() : [];
    arr.push(defaultsForSchema(itemSchema));
    setValueAtPath(ed.content, path, arr);
    renderSlideEditor();
  }

  function removeArrayItem(pathStr, idx) {
    var ed = slideState.editor;
    if (!ed) return;
    var path = JSON.parse(pathStr);
    var current = getValueAtPath(ed.content, path);
    if (!Array.isArray(current)) return;
    var arr = current.slice();
    arr.splice(idx, 1);
    setValueAtPath(ed.content, path, arr);
    renderSlideEditor();
  }

  function moveArrayItem(pathStr, idx, dir) {
    var ed = slideState.editor;
    if (!ed) return;
    var path = JSON.parse(pathStr);
    var current = getValueAtPath(ed.content, path);
    if (!Array.isArray(current)) return;
    var j = dir === 'up' ? idx - 1 : idx + 1;
    if (j < 0 || j >= current.length) return;
    var arr = current.slice();
    var tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
    setValueAtPath(ed.content, path, arr);
    renderSlideEditor();
  }

  // Walk a schema down a path of property names / array indices.
  function walkSchema(schema, path) {
    var cur = schema;
    for (var i = 0; i < path.length; i++) {
      if (!cur) return null;
      var k = path[i];
      if (typeof k === 'number') {
        cur = cur.items;
      } else {
        cur = (cur.properties || {})[k];
      }
    }
    return cur;
  }

  // ── CTA EDITOR ─────────────────────────────────────────────────────────────
  function renderCtaField(schema, value, path) {
    var labelPath  = escapeAttr(JSON.stringify(path.concat(['label'])));
    var targetPath = escapeAttr(JSON.stringify(path.concat(['target'])));
    var lab = (value && value.label)  || '';
    var tgt = (value && value.target) || '';
    return ''
      + '<div class="slot-cta">'
      +   '<label>Label<input type="text" class="slot-input" data-fw-path="' + labelPath + '" value="' + escapeAttr(lab) + '"></label>'
      +   '<label>Target<input type="text" class="slot-input" data-fw-path="' + targetPath + '" value="' + escapeAttr(tgt) + '" placeholder="https://... or add_to_cart:{product_id}"></label>'
      + '</div>';
  }

  // ── PATH HELPERS ───────────────────────────────────────────────────────────
  function getValueAtPath(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }

  function setValueAtPath(obj, path, value) {
    if (path.length === 0) return;
    var cur = obj;
    for (var i = 0; i < path.length - 1; i++) {
      var k = path[i];
      if (cur[k] === null || cur[k] === undefined) {
        // Create scaffold based on next key (number -> array, else object)
        cur[k] = (typeof path[i + 1] === 'number') ? [] : {};
      }
      cur = cur[k];
    }
    cur[path[path.length - 1]] = value;
  }

  // ── EDITOR INPUT WIRING ────────────────────────────────────────────────────
  // Attach 'input' / 'change' listeners to every slot input so text typing
  // updates editor.content in place without a full re-render (focus stays
  // in the input).
  function wireSlideEditorListeners() {
    var ed = slideState.editor;
    if (!ed) return;
    var panel = panelSlides();

    // Common fields
    panel.querySelectorAll('[data-fw-common]').forEach(function (el) {
      el.addEventListener('input', function () {
        applyCommonFieldChange(el);
      });
      el.addEventListener('change', function () {
        applyCommonFieldChange(el);
      });
    });

    // Slot inputs
    panel.querySelectorAll('[data-fw-path]').forEach(function (el) {
      // Skip elements that have an action (file input, picker buttons).
      if (el.dataset.fwAction) return;
      el.addEventListener('input', function () {
        applySlotInput(el);
      });
      el.addEventListener('change', function () {
        applySlotInput(el);
      });
    });
  }

  function applyCommonFieldChange(el) {
    var ed = slideState.editor;
    if (!ed) return;
    var key = el.dataset.fwCommon;
    if (key === 'is_active') ed.common.is_active = !!el.checked;
    else if (key === 'default_position') ed.common.default_position = parseInt(el.value, 10) || 0;
    else ed.common[key] = el.value;
  }

  function applySlotInput(el) {
    var ed = slideState.editor;
    if (!ed) return;
    var path = JSON.parse(el.dataset.fwPath);
    var value;
    if (el.type === 'checkbox')      value = el.checked;
    else if (el.type === 'number')   value = el.value === '' ? null : Number(el.value);
    else                              value = el.value;
    setValueAtPath(ed.content, path, value);

    // Update the live char counter for textareas with maxLength
    if (el.tagName === 'TEXTAREA' && el.maxLength > 0) {
      var counter = el.parentElement.querySelector('.slot-counter');
      if (counter) counter.textContent = el.value.length + ' / ' + el.maxLength;
    }
  }

  // ── CLEAR MEDIA ────────────────────────────────────────────────────────────
  function clearMediaSlot(pathStr) {
    var ed = slideState.editor;
    if (!ed) return;
    var path = JSON.parse(pathStr);
    setValueAtPath(ed.content, path, '');
    renderSlideEditor();
  }

  // ── CLIENT-SIDE CONTENT VALIDATION ─────────────────────────────────────────
  // Walk the template's content_schema and surface specific missing /
  // malformed fields before we hit the DB trigger. The trigger is still
  // the source of truth, but reaching it with a clear toast like
  // "tabs[0].hero_url is required" beats the generic "JSON Schema
  // validation failed" the trigger would otherwise raise.
  function validateContentForSave(schema, content) {
    var errors = [];

    function labelFor(pathLabel, key) {
      return pathLabel ? pathLabel + '.' + key : key;
    }

    function walk(schemaPart, value, pathLabel) {
      if (!schemaPart) return;

      if (schemaPart.type === 'object') {
        var props    = schemaPart.properties || {};
        var required = schemaPart.required   || [];
        for (var i = 0; i < required.length; i++) {
          var key = required[i];
          var v   = value ? value[key] : undefined;
          if (v === undefined || v === null || v === '') {
            errors.push(labelFor(pathLabel, key) + ' is required');
            continue;
          }
          walk(props[key], v, labelFor(pathLabel, key));
        }
        // Also walk through provided non-required fields so we catch
        // length / pattern / enum errors on optional fields.
        for (var k in (value || {})) {
          if (required.indexOf(k) >= 0) continue;
          if (props[k]) walk(props[k], value[k], labelFor(pathLabel, k));
        }
        return;
      }

      if (schemaPart.type === 'array') {
        var name = pathLabel || 'content';
        if (schemaPart.minItems && (!Array.isArray(value) || value.length < schemaPart.minItems)) {
          errors.push(name + ' needs at least ' + schemaPart.minItems + ' item' + (schemaPart.minItems === 1 ? '' : 's'));
          return;
        }
        if (schemaPart.maxItems && Array.isArray(value) && value.length > schemaPart.maxItems) {
          errors.push(name + ' has more than ' + schemaPart.maxItems + ' items allowed');
        }
        if (Array.isArray(value)) {
          for (var ii = 0; ii < value.length; ii++) {
            walk(schemaPart.items, value[ii], name + '[' + (ii + 1) + ']');
          }
        }
        return;
      }

      if (schemaPart.type === 'string') {
        if (typeof value !== 'string') return;
        var n = pathLabel || 'value';
        if (schemaPart.minLength && value.length < schemaPart.minLength) {
          errors.push(n + (value.length === 0 ? ' is required' : ' is too short (minimum ' + schemaPart.minLength + ' characters)'));
        }
        if (schemaPart.maxLength && value.length > schemaPart.maxLength) {
          errors.push(n + ' is too long (max ' + schemaPart.maxLength + ' characters)');
        }
        if (Array.isArray(schemaPart.enum) && value !== '' && schemaPart.enum.indexOf(value) < 0) {
          errors.push(n + ' must be one of: ' + schemaPart.enum.join(', '));
        }
        if (schemaPart.pattern && value) {
          try {
            if (!new RegExp(schemaPart.pattern).test(value)) {
              errors.push(n + ' does not match the expected format');
            }
          } catch (e) { /* malformed pattern; let the DB catch it */ }
        }
      }
    }

    walk(schema || {}, content || {}, '');
    return errors;
  }

  // ── SAVE ───────────────────────────────────────────────────────────────────
  async function saveSlide() {
    var ed = slideState.editor;
    if (!ed) return;
    var c  = ed.common;

    if (!c.title.trim()) { toast('Title is required.', 'error'); return; }
    if (ed.isNew) {
      // Slugify on save (see commitAddQuestion). The user typed whatever
      // they typed; we normalise it to a stable identifier.
      var cleanSlideKey = slugifyKey(c.slide_key);
      if (!cleanSlideKey) {
        toast('Slide key is required (use letters, numbers, or underscores).', 'error');
        return;
      }
      c.slide_key = cleanSlideKey;
    }

    // Catch missing required fields, length issues, and enum mismatches
    // client-side so the admin sees the specific field that needs fixing
    // instead of the generic schema error from the DB trigger.
    var schemaErrors = validateContentForSave(ed.template.content_schema || {}, ed.content);
    if (schemaErrors.length > 0) {
      var shown = schemaErrors.slice(0, 3).join('; ');
      var more  = schemaErrors.length > 3 ? ' (+' + (schemaErrors.length - 3) + ' more)' : '';
      toast('Cannot save: ' + shown + more, 'error');
      return;
    }

    var payload = {
      slide_key:        c.slide_key.trim(),
      title:            c.title.trim(),
      template_key:     ed.template.template_key,
      content:          ed.content,
      default_position: c.default_position || 0,
      is_active:        !!c.is_active,
    };

    var saveRes;
    if (ed.isNew) {
      payload.id = ed.slideId;
      saveRes = await supa.from('footwear_slides').insert(payload).select().single();
    } else {
      saveRes = await supa.from('footwear_slides').update(payload).eq('id', ed.slideId).select().single();
    }
    if (saveRes.error) {
      toast(prettyDbError(saveRes.error, 'Save failed.'), 'error');
      return;
    }

    // Phase 3: persist slide-level products via the set_slide_products RPC.
    // The RPC wraps delete + bulk insert in a single transaction, so a
    // failure mid-write can no longer leave the junction empty. The
    // template-content -> junction sync that lived here pre-Phase-3 is
    // gone; products are now exclusively driven by the slide-level
    // Products card (ed.slideProducts).
    var slideId = saveRes.data.id;
    var spRes = await supa.rpc('set_slide_products', {
      p_slide_id:    slideId,
      p_product_ids: (ed.slideProducts || [])
    });
    if (spRes.error) {
      toast('Slide saved, but updating products failed: ' + (spRes.error.message || spRes.error), 'error');
      return;
    }

    toast('Slide saved.', 'success');
    slideState.editor = null;
    slideState.view   = { type: 'list' };
    await renderSlides();
  }

  // Walk a schema and pull every product id (or product_ids array) value
  // out of the matching content. Used to sync the join table on save.
  function collectProductIds(schema, content) {
    var out = [];
    function walk(schemaPart, value, name) {
      if (!schemaPart) return;
      var kind = detectFieldKind(name || '', schemaPart);
      if (kind === 'product_id') {
        if (typeof value === 'string' && value) out.push(value);
        return;
      }
      if (kind === 'product_ids') {
        if (Array.isArray(value)) {
          value.forEach(function (v) { if (typeof v === 'string' && v) out.push(v); });
        }
        return;
      }
      if (schemaPart.type === 'object' && schemaPart.properties) {
        for (var k in schemaPart.properties) {
          walk(schemaPart.properties[k], value ? value[k] : undefined, k);
        }
      } else if (schemaPart.type === 'array' && schemaPart.items) {
        if (Array.isArray(value)) {
          value.forEach(function (v) { walk(schemaPart.items, v, name); });
        }
      }
    }
    walk(schema || {}, content || {}, '');
    // dedupe while preserving order
    var seen = {};
    return out.filter(function (id) { if (seen[id]) return false; seen[id] = true; return true; });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT DELEGATION (questionnaire + slides)
  // ═══════════════════════════════════════════════════════════════════════════
  // One click handler at the document level so we never use inline onclick.
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-fw-action]');
    if (!el) return;
    var a = el.dataset.fwAction;

    if      (a === 'addQuestion')         showAddQuestionModal();
    else if (a === 'commitAddQuestion')   commitAddQuestion();
    else if (a === 'openQuestion')        { state.view = { type: 'detail', questionId: el.dataset.id }; render(); }
    else if (a === 'backToList')          { state.view = { type: 'list' }; render(); }
    else if (a === 'saveQuestion')        saveQuestion(el.dataset.id);
    else if (a === 'archiveQuestion')     archiveQuestion(el.dataset.id);
    else if (a === 'moveQuestion')        moveQuestion(el.dataset.id, el.dataset.dir);

    else if (a === 'addOption')           showAddOptionModal(el.dataset.questionId);
    else if (a === 'commitAddOption')     commitAddOption(el.dataset.questionId);
    else if (a === 'editOption')          showEditOptionModal(el.dataset.id);
    else if (a === 'commitEditOption')    commitEditOption(el.dataset.id);
    else if (a === 'deleteOption')        showDeleteOptionModal(el.dataset.id);
    else if (a === 'commitDeleteOption')  commitDeleteOption(el.dataset.id);
    else if (a === 'moveOption')          moveOption(el.dataset.id, el.dataset.dir);

    else if (a === 'addRule')             showAddRuleModal(el.dataset.questionId);
    else if (a === 'commitAddRule')       commitAddRule(el.dataset.questionId);
    else if (a === 'deleteRule')          showDeleteRuleModal(el.dataset.id);
    else if (a === 'commitDeleteRule')    commitDeleteRule(el.dataset.id);

    // ── slides ──
    else if (a === 'newSlide')            showTemplatePickerModal();
    else if (a === 'pickTemplate')        pickTemplate(el.dataset.key);
    else if (a === 'editSlide')           enterSlideEditor(el.dataset.id);
    else if (a === 'backToSlideList')     { slideState.view = { type: 'list' }; slideState.editor = null; renderSlides(); }
    else if (a === 'moveSlide')           moveSlide(el.dataset.id, el.dataset.dir);
    else if (a === 'deleteSlide')         showDeleteSlideModal(el.dataset.id);
    else if (a === 'commitDeleteSlide')   commitDeleteSlide(el.dataset.id);
    else if (a === 'saveSlide')           saveSlide();
    else if (a === 'clearMedia')          clearMediaSlot(el.dataset.fwPath);
    else if (a === 'openProductPicker')   showProductPickerModal(el.dataset.fwPath, el.dataset.multi === '1');
    else if (a === 'pickProduct')         pickProduct(el.dataset.fwPath, el.dataset.multi === '1', el.dataset.id);
    else if (a === 'removeProduct')       removeProductAt(el.dataset.fwPath, parseInt(el.dataset.idx, 10));
    else if (a === 'moveProduct')         moveProductAt(el.dataset.fwPath, parseInt(el.dataset.idx, 10), el.dataset.dir);

    // ── slide-level Products card (Phase 3) ──
    else if (a === 'openSlideProductPicker') showSlideProductPickerModal();
    else if (a === 'pickSlideProduct')       pickSlideProduct(el.dataset.id);
    else if (a === 'removeSlideProduct')     removeSlideProductAt(parseInt(el.dataset.idx, 10));
    else if (a === 'moveSlideProduct')       moveSlideProductAt(parseInt(el.dataset.idx, 10), el.dataset.dir);
    else if (a === 'addArrayItem')        addArrayItem(el.dataset.fwPath);
    else if (a === 'removeArrayItem')     removeArrayItem(el.dataset.fwPath, parseInt(el.dataset.idx, 10));
    else if (a === 'moveArrayItem')       moveArrayItem(el.dataset.fwPath, parseInt(el.dataset.idx, 10), el.dataset.dir);
  });

  // change handlers (checkboxes, file inputs, selects).
  document.addEventListener('change', function (ev) {
    var el = ev.target.closest('[data-fw-action]');
    if (el) {
      var a = el.dataset.fwAction;
      if (a === 'toggleQuestionActive') toggleQuestionActive(el.dataset.id, el.checked);
      else if (a === 'toggleSlideActive') toggleSlideActive(el.dataset.id, el.checked);
      else if (a === 'uploadMedia') {
        var f = el.files && el.files[0];
        if (f) {
          var path = JSON.parse(el.dataset.fwPath);
          uploadMediaForSlot(f, path);
          el.value = '';
        }
      }
    }
  });

  // ── PUBLIC API ────────────────────────────────────────────────────────────
  // admin.js's activateTab() looks up window.curateFootwear[tab] and calls
  // it when the tab is selected. The function is responsible for filling
  // its own panel.
  window.curateFootwear = window.curateFootwear || {};
  window.curateFootwear.questionnaire = render;
  window.curateFootwear.slides        = renderSlides;
})();
