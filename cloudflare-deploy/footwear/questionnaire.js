// ─── Questionnaire view ─────────────────────────────────────────────────────
//
// Customer-facing questionnaire. Loads active footwear_questions plus
// their options, renders questions one at a time with conditional reveal
// (next question appears after the current one is answered), and on
// Continue runs the rule engine, persists a footwear_drafts row, and
// hands off to the reorder view.
//
// Section 4.2 of the AW27 footwear brief.

(function () {
  'use strict';

  window.fwApp       = window.fwApp || {};
  window.fwApp.views = window.fwApp.views || {};

  // View-local state. Reset on each render() entry.
  var localState = {
    questions:         [],   // active rows from footwear_questions, ordered
    optionsByQuestion: {},   // question_id -> options[]
    revealedCount:     1,    // how many questions are visible right now
  };

  async function renderQuestionnaire() {
    var c     = window.fwApp;
    var supa  = c.supa;
    var panel = document.getElementById('view-questionnaire');

    panel.innerHTML = '<div class="qx-empty">Loading...</div>';

    var qRes = await supa.from('footwear_questions')
                          .select('*')
                          .eq('is_active', true)
                          .order('display_order', { ascending: true });
    var oRes = await supa.from('footwear_question_options')
                          .select('*')
                          .order('display_order', { ascending: true });

    if (qRes.error || oRes.error) {
      panel.innerHTML = '<div class="qx-empty">Could not load questionnaire. Please refresh and try again.</div>';
      return;
    }

    localState.questions         = qRes.data || [];
    localState.optionsByQuestion = {};
    (oRes.data || []).forEach(function (o) {
      if (!localState.optionsByQuestion[o.question_id]) {
        localState.optionsByQuestion[o.question_id] = [];
      }
      localState.optionsByQuestion[o.question_id].push(o);
    });

    // Pre-populate from state.questionnaireAnswers when present (rep
    // following a #draft={token} resume link from Section 5). If empty,
    // start fresh at question 1.
    if (!c.state.questionnaireAnswers) c.state.questionnaireAnswers = {};
    localState.revealedCount = computeRevealCountFromAnswers();

    // Load the customer list once. The picker section above the questions
    // depends on it.
    if (!c.state.reviewMode && c.loadCustomers) {
      await c.loadCustomers();
    }

    if (localState.questions.length === 0) {
      panel.innerHTML = ''
        + '<div class="qx-empty">'
        +   '<p style="margin-bottom:14px;">No questionnaire is configured yet. Continue straight to the deck.</p>'
        +   '<button class="btn btn-primary" id="qx-skip-empty">Continue</button>'
        + '</div>';
      var skipBtn = document.getElementById('qx-skip-empty');
      if (skipBtn) skipBtn.addEventListener('click', onContinueEmpty);
      return;
    }

    paint();
  }

  function paint() {
    var c     = window.fwApp;
    var panel = document.getElementById('view-questionnaire');

    // Build the structural shell once. The customer section re-renders
    // independently of the questions so typing in the autocomplete
    // input does not lose focus when an option elsewhere is clicked.
    panel.innerHTML = ''
      + '<div class="qx-customer-section" id="qx-customer-section"></div>'
      + '<div class="qx-intro">'
      +   '<div class="qx-intro-eyebrow">AW27 Footwear</div>'
      +   '<div class="qx-intro-title">Tell us about this account</div>'
      +   '<div class="qx-intro-body">Answer a few quick questions and we will tailor the deck to fit. You can always edit your selections in the next step.</div>'
      + '</div>'
      + '<div class="qx-list" id="qx-list"></div>'
      + '<div class="qx-actions" id="qx-actions"></div>';

    paintCustomerSection();
    paintQuestions();
  }

  // Re-paint just the question cards + Continue button without touching
  // the customer section. Called by every option change.
  function paintQuestions() {
    var c     = window.fwApp;
    var listEl    = document.getElementById('qx-list');
    var actionsEl = document.getElementById('qx-actions');
    if (!listEl || !actionsEl) return;

    var qs = localState.questions.slice(0, localState.revealedCount);
    var cardsHtml = qs.map(function (q, idx) {
      var opts        = localState.optionsByQuestion[q.id] || [];
      var isAnswered  = isQuestionAnswered(q);
      var isActive    = idx === qs.length - 1;
      var typeLabel   = q.question_type === 'multi_select' ? 'Pick one or more' : 'Pick one';

      var optsHtml = opts.map(function (o) {
        var inputType = q.question_type === 'multi_select' ? 'checkbox' : 'radio';
        var inputName = 'q-' + c.escapeAttr(q.id);
        var selectedOptionIds = c.state.questionnaireAnswers[q.question_key] || [];
        var isSelected = selectedOptionIds.indexOf(o.id) >= 0;
        return ''
          + '<label class="qx-option' + (isSelected ? ' qx-option-selected' : '') + '">'
          +   '<input class="qx-option-input" type="' + inputType + '" name="' + inputName + '"'
          +        ' data-q-key="'     + c.escapeAttr(q.question_key) + '"'
          +        ' data-option-id="' + c.escapeAttr(o.id)            + '"'
          +        (isSelected ? ' checked' : '') + '>'
          +   '<span class="qx-option-label">' + c.escapeHtml(o.label) + '</span>'
          + '</label>';
      }).join('');

      var cardClass = 'qx-card qx-card-revealed';
      if (isAnswered) cardClass += ' qx-card-answered';
      if (isActive)   cardClass += ' qx-card-active';

      return ''
        + '<div class="' + cardClass + '" data-q-id="' + c.escapeAttr(q.id) + '">'
        +   '<div class="qx-card-prompt">' + c.escapeHtml(q.prompt) + '</div>'
        +   '<div class="qx-card-meta">'   + typeLabel              + '</div>'
        +   '<div class="qx-options">'     + optsHtml               + '</div>'
        + '</div>';
    }).join('');

    listEl.innerHTML = cardsHtml;

    var enabled = canContinue();
    actionsEl.innerHTML = ''
      + '<button class="btn qx-continue" id="qx-continue"' + (enabled ? '' : ' disabled') + '>Continue</button>';

    listEl.querySelectorAll('.qx-option-input').forEach(function (input) {
      input.addEventListener('change', onOptionChange);
    });
    var contBtn = document.getElementById('qx-continue');
    if (contBtn) contBtn.addEventListener('click', onContinue);
  }

  function canContinue() {
    var c = window.fwApp;
    if (!c.state.customer) return false;
    if (localState.questions.length === 0) return true;
    return localState.revealedCount === localState.questions.length
        && localState.questions.every(isQuestionAnswered);
  }

  // ── Customer picker (top of questionnaire) ─────────────────────────────
  // Mirrors the apparel autocomplete: type into the Customer field, see
  // a dropdown of matches, click one to populate Account Manager. The
  // current selection lives on c.state.customer and is persisted to
  // footwear_drafts.customer_data on every change.

  function paintCustomerSection() {
    var c       = window.fwApp;
    var section = document.getElementById('qx-customer-section');
    if (!section) return;

    var picked = c.state.customer || null;
    var customerName    = picked ? (picked.account_name || '') : '';
    var accountManager  = picked ? (picked.account_manager || '') : '';
    var picksAvailable  = Array.isArray(c.state.customers);

    section.innerHTML = ''
      + '<div class="qx-customer-card">'
      +   '<div class="qx-customer-eyebrow">Step 1</div>'
      +   '<div class="qx-customer-title">Who is this for?</div>'
      +   '<div class="qx-customer-grid">'
      +     '<label class="qx-customer-field">'
      +       '<span class="qx-customer-label">Customer</span>'
      +       '<input type="text" class="qx-customer-input" id="qx-customer-input"'
      +              ' placeholder="' + (picksAvailable ? 'Type a customer name, code or city' : 'Loading customers...') + '"'
      +              ' value="' + c.escapeAttr(customerName) + '"'
      +              ' autocomplete="off"'
      +              (picksAvailable ? '' : ' disabled') + '>'
      +       '<ul class="qx-customer-dropdown" id="qx-customer-dropdown"></ul>'
      +       (picked
            ? '<div class="qx-customer-meta">' + c.escapeHtml(picked.city || '') + (picked.state ? ', ' + c.escapeHtml(picked.state) : '') + '</div>'
            : '')
      +     '</label>'
      +     '<label class="qx-customer-field">'
      +       '<span class="qx-customer-label">Account Manager</span>'
      +       '<input type="text" class="qx-customer-input qx-customer-input-readonly" id="qx-account-manager-input"'
      +              ' value="' + c.escapeAttr(accountManager) + '" readonly placeholder="Auto-filled from customer">'
      +     '</label>'
      +   '</div>'
      + '</div>';

    wireCustomerSection();
  }

  function wireCustomerSection() {
    var c      = window.fwApp;
    var input  = document.getElementById('qx-customer-input');
    var dropdown = document.getElementById('qx-customer-dropdown');
    if (!input || !dropdown) return;

    function showMatches(query) {
      var matches = (c.filterCustomers ? c.filterCustomers(query, 12) : []);
      if (matches.length === 0) {
        dropdown.classList.remove('open');
        dropdown.innerHTML = '';
        return;
      }
      dropdown.innerHTML = matches.map(function (m) {
        var subtitle = (m.city ? m.city : '') + (m.state ? (m.city ? ', ' : '') + m.state : '');
        return '<li class="qx-customer-option" data-account-code="' + c.escapeAttr(m.account_code) + '">'
             +    '<div class="qx-customer-option-name">' + c.escapeHtml(m.account_name || m.account_code) + '</div>'
             +    '<div class="qx-customer-option-sub">' + c.escapeHtml(subtitle || m.account_code) + '</div>'
             + '</li>';
      }).join('');
      dropdown.classList.add('open');
    }

    input.addEventListener('input', function () {
      // Typing clears the locked selection so the rep can change customer.
      if (c.state.customer && input.value !== c.state.customer.account_name) {
        c.state.customer = null;
        var amInput = document.getElementById('qx-account-manager-input');
        if (amInput) amInput.value = '';
        // Update Continue button state since customer is now empty.
        paintQuestions();
      }
      showMatches(input.value);
    });

    input.addEventListener('focus', function () { showMatches(input.value); });
    input.addEventListener('blur', function () {
      // Slight delay so a click inside the dropdown registers first.
      setTimeout(function () { dropdown.classList.remove('open'); }, 180);
    });

    dropdown.addEventListener('mousedown', function (ev) {
      // mousedown (not click) so we beat the input's blur event.
      var li = ev.target.closest('.qx-customer-option');
      if (!li) return;
      ev.preventDefault();
      selectCustomerByCode(li.dataset.accountCode);
    });
  }

  function selectCustomerByCode(accountCode) {
    var c = window.fwApp;
    if (!Array.isArray(c.state.customers)) return;
    var picked = null;
    for (var i = 0; i < c.state.customers.length; i++) {
      if (c.state.customers[i].account_code === accountCode) { picked = c.state.customers[i]; break; }
    }
    if (!picked) return;
    c.state.customer = picked;
    paintCustomerSection();
    paintQuestions();
    scheduleCustomerPersist();
  }

  // Persist customer_data to the draft on every change (debounced).
  // Skipped in review mode; the customer is fixed there.
  var customerPersistTimer = null;
  function scheduleCustomerPersist() {
    var c = window.fwApp;
    if (c.state.reviewMode) return;
    if (customerPersistTimer) clearTimeout(customerPersistTimer);
    customerPersistTimer = setTimeout(persistCustomerNow, 300);
  }
  async function persistCustomerNow() {
    customerPersistTimer = null;
    var c = window.fwApp;
    var saveRes = await c.persistDraft({ customer_data: c.state.customer });
    if (saveRes.error) {
      c.toast('Could not save customer: ' + (saveRes.error.message || 'unknown error'), 'error');
    }
  }

  function onOptionChange(ev) {
    var c        = window.fwApp;
    var input    = ev.target;
    var qKey     = input.dataset.qKey;
    var optionId = input.dataset.optionId;
    var question = localState.questions.find(function (q) { return q.question_key === qKey; });
    if (!question) return;

    var answers = c.state.questionnaireAnswers;
    if (question.question_type === 'multi_select') {
      var arr = answers[qKey] ? answers[qKey].slice() : [];
      if (input.checked) {
        if (arr.indexOf(optionId) < 0) arr.push(optionId);
      } else {
        arr = arr.filter(function (id) { return id !== optionId; });
      }
      answers[qKey] = arr;
    } else {
      answers[qKey] = input.checked ? [optionId] : [];
    }

    // Reveal the next question only when the current last-revealed one has
    // gained at least one answer for the first time.
    var qIndex          = localState.questions.findIndex(function (q) { return q.question_key === qKey; });
    var isLastRevealed  = qIndex === localState.revealedCount - 1;
    var nowAnswered     = answers[qKey] && answers[qKey].length > 0;
    var willReveal      = isLastRevealed && nowAnswered && localState.revealedCount < localState.questions.length;

    if (willReveal) localState.revealedCount++;

    paint();
    scheduleAnswerPersist();

    if (willReveal) {
      // After a new card was added, scroll it into view.
      window.requestAnimationFrame(function () {
        var newest = document.querySelector('.qx-card-active');
        if (newest) newest.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  function isQuestionAnswered(q) {
    var ans = window.fwApp.state.questionnaireAnswers[q.question_key];
    return Array.isArray(ans) && ans.length > 0;
  }

  // Section 5: when the rep follows a #draft={token} link, state.questionnaire-
  // Answers is pre-populated. Reveal up to and including the first unanswered
  // question so the rep can pick up where they left off.
  function computeRevealCountFromAnswers() {
    var answers = window.fwApp.state.questionnaireAnswers || {};
    var any = Object.keys(answers).some(function (k) {
      return Array.isArray(answers[k]) && answers[k].length > 0;
    });
    if (!any) return 1;
    var revealed = 1;
    for (var i = 0; i < localState.questions.length; i++) {
      var q = localState.questions[i];
      var a = answers[q.question_key];
      if (Array.isArray(a) && a.length > 0) {
        revealed = Math.min(i + 2, localState.questions.length);
      } else {
        break;
      }
    }
    return revealed;
  }

  // Section 5: persist questionnaire_answers on every change (debounced) so
  // the brief's "saves on every meaningful state change" guarantee holds.
  // Skipped in review mode where the customer cannot modify anything.
  var answerPersistTimer = null;
  function scheduleAnswerPersist() {
    var c = window.fwApp;
    if (c.state.reviewMode) return;
    if (answerPersistTimer) clearTimeout(answerPersistTimer);
    answerPersistTimer = setTimeout(persistAnswersNow, 400);
  }

  async function persistAnswersNow() {
    answerPersistTimer = null;
    var c = window.fwApp;
    var saveRes = await c.persistDraft({
      questionnaire_answers: c.state.questionnaireAnswers,
    });
    if (saveRes.error) {
      c.toast('Could not save your answers: ' + (saveRes.error.message || 'unknown error'), 'error');
    }
  }

  async function onContinue() {
    var c   = window.fwApp;
    var btn = document.getElementById('qx-continue');
    btn.disabled    = true;
    btn.textContent = 'Saving...';

    // Cancel any pending debounced answer save; the Continue save below
    // covers the same payload plus slide_order and excluded_slide_ids.
    if (answerPersistTimer) { clearTimeout(answerPersistTimer); answerPersistTimer = null; }

    var deck = await evaluateRules(c.state.questionnaireAnswers);
    if (!deck) {
      btn.disabled    = false;
      btn.textContent = 'Continue';
      return;
    }
    c.state.slideOrder       = deck.slideOrder;
    c.state.excludedSlideIds = deck.excludedSlideIds;

    var saveRes = await c.persistDraft({
      questionnaire_answers: c.state.questionnaireAnswers,
      slide_order:           c.state.slideOrder,
      excluded_slide_ids:    c.state.excludedSlideIds,
    });
    if (saveRes.error) {
      c.toast('Could not save your progress: ' + (saveRes.error.message || 'unknown error'), 'error');
      btn.disabled    = false;
      btn.textContent = 'Continue';
      return;
    }

    c.toast('Saved.', 'success');
    c.setView('reorder');
  }

  async function onContinueEmpty() {
    var c   = window.fwApp;
    // No questions configured -> all active slides go straight through.
    var supa = c.supa;
    var slidesRes = await supa.from('footwear_slides')
                              .select('id')
                              .eq('is_active', true)
                              .order('default_position', { ascending: true });
    if (slidesRes.error) {
      c.toast('Could not load slides. ' + (slidesRes.error.message || ''), 'error');
      return;
    }
    c.state.slideOrder       = (slidesRes.data || []).map(function (s) { return s.id; });
    c.state.excludedSlideIds = [];

    var saveRes = await c.persistDraft({
      questionnaire_answers: {},
      slide_order:           c.state.slideOrder,
      excluded_slide_ids:    [],
    });
    if (saveRes.error) {
      c.toast('Could not save your progress: ' + (saveRes.error.message || 'unknown error'), 'error');
      return;
    }
    c.setView('reorder');
  }

  // ── Rule engine ─────────────────────────────────────────────────────────
  // 1. Start with all active slides ordered by default_position.
  // 2. For every selected option, fetch matching footwear_question_rules.
  // 3. Apply exclude_slide actions (remove from list).
  //    include_slide is only relevant when a slide is excluded by default;
  //    today every is_active slide is implicitly included unless excluded.
  async function evaluateRules(answers) {
    var c    = window.fwApp;
    var supa = c.supa;

    var slidesRes = await supa.from('footwear_slides')
                              .select('id, slide_key, title, default_position')
                              .eq('is_active', true)
                              .order('default_position', { ascending: true });
    if (slidesRes.error) {
      c.toast('Could not load slides. ' + (slidesRes.error.message || ''), 'error');
      return null;
    }
    var slides = slidesRes.data || [];

    var optionIds = [];
    for (var key in answers) {
      var arr = answers[key] || [];
      for (var i = 0; i < arr.length; i++) optionIds.push(arr[i]);
    }

    var excluded = new Set();
    if (optionIds.length > 0) {
      var rulesRes = await supa.from('footwear_question_rules')
                                .select('action, slide_id')
                                .in('option_id', optionIds);
      if (rulesRes.error) {
        c.toast('Could not load rules. ' + (rulesRes.error.message || ''), 'error');
        return null;
      }
      (rulesRes.data || []).forEach(function (r) {
        if (r.action === 'exclude_slide') excluded.add(r.slide_id);
      });
    }

    var resolved = slides.filter(function (s) { return !excluded.has(s.id); });
    return {
      slideOrder:       resolved.map(function (s) { return s.id; }),
      excludedSlideIds: Array.from(excluded),
    };
  }

  window.fwApp.views.questionnaire = renderQuestionnaire;
})();
