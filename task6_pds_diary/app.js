// Plan-Do-See 다이어리 — 정적 화면 + Supabase(PostgREST RPC).
// 모든 사용자 문자열은 textContent/DOM 노드로만 그린다(innerHTML 미사용) → 스크립트 문자열은 텍스트로 보인다.
(() => {
  'use strict';

  const cfg = window.PDS_CONFIG || {};
  const PRIORITY = { 1: '1 높음', 2: '2 보통', 3: '3 낮음' };
  const SORTS = {
    due: { label: '마감일 빠른 순 → 같으면 우선순위 높은 순 → 등록 순 → ID 순', keys: [['due_date', 1], ['priority', 1], ['created_at', 1], ['id', 1]] },
    priority: { label: '우선순위 높은 순 → 같으면 마감일 빠른 순 → 등록 순 → ID 순', keys: [['priority', 1], ['due_date', 1], ['created_at', 1], ['id', 1]] },
    estimate: { label: '예상 시간 긴 순 → 같으면 마감일 빠른 순 → 등록 순 → ID 순', keys: [['estimated_minutes', -1], ['due_date', 1], ['created_at', 1], ['id', 1]] },
    created: { label: '등록 순 → 같으면 ID 순', keys: [['created_at', 1], ['id', 1]] },
  };

  const state = {
    snap: null,
    planId: null,
    editingTodoId: null,
    planFormMode: null, // 'create' | 'edit'
    sourceReviewId: null,
    todoEvidence: null, // { label, ids:Set }
    execEvidence: null,
    completeKeys: new Map(), // todoId -> idempotency key (같은 의도의 재전송·연속 클릭은 같은 키)
    todoShowAll: loadTodoShowAll(), // 남은 일/완료한 일 "더 보기" 펼침 상태(이 브라우저 탭에서만 유지)
    execShowAll: false,
    busy: 0,
  };

  // ───────── 보기 설정(이 탭에서만, 저장 실패해도 화면은 정상) ─────────
  function loadTodoShowAll() {
    try { return Object.assign({ open: false, done: false }, JSON.parse(sessionStorage.getItem('pds-todo-show-all') || '{}')); }
    catch { return { open: false, done: false }; }
  }
  function saveTodoShowAll() {
    try { sessionStorage.setItem('pds-todo-show-all', JSON.stringify(state.todoShowAll)); } catch { /* 무시 */ }
  }

  // ───────── DOM helpers ─────────
  const $ = (sel) => document.querySelector(sel);
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  function setStatus(text, kind = '') {
    const el = $('#status');
    el.textContent = text;
    el.className = `status ${kind}`;
  }

  // ───────── 시간 표시 (서울) ─────────
  const fmtTs = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // 서울 시각을 "YYYY-MM-DD HH:mm" 한 덩어리로 표시(줄바꿈이 어색하게 끊기지 않게)
  const ts = (iso) => {
    if (!iso) return '-';
    const p = Object.fromEntries(fmtTs.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  };
  // 설명 표시: 저장된 문자열은 그대로 두고, "일정:" 뒤 쉼표 목록만 항목으로 나눠 보여 준다.
  function describe(text) {
    const at = text.indexOf('일정:');
    if (at < 0) return h('p', { class: 'desc', 'data-field': 'description' }, text);
    const lead = text.slice(0, at).trim();
    const items = text.slice(at + 3).split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    return h('div', { class: 'desc', 'data-field': 'description' },
      lead ? h('p', {}, lead) : null,
      h('div', { class: 'callout-label' }, '일정'),
      h('ul', { class: 'schedule' }, items.map((s) => h('li', {}, s))));
  }
  const min = (n) => `${Number(n).toLocaleString('ko-KR')}분`;
  const seoulLocalToIso = (v) => (v ? `${v}:00+09:00` : null); // datetime-local 값을 서울 시각으로 해석

  // ───────── API ─────────
  async function rpc(fn, body = {}) {
    if (!cfg.supabaseUrl || !cfg.publishableKey || cfg.publishableKey.startsWith('__')) {
      throw new Error('서버 연결 설정(config.js)이 비어 있습니다');
    }
    let res;
    try {
      res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (e) {
      throw new Error('서버에 연결하지 못했습니다(네트워크)');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && data.message) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  async function mutate(label, fn) {
    state.busy++;
    setStatus(`${label} 저장 중…`);
    try {
      const out = await fn();
      await load(false);
      setStatus(`${label} 저장됨 (서버 DB)`, 'ok');
      return out;
    } catch (e) {
      setStatus(`${label} 실패: ${e.message}`, 'error');
      throw e;
    } finally {
      state.busy--;
    }
  }

  async function load(announce = true) {
    if (announce) setStatus('서버에서 불러오는 중…');
    try {
      state.snap = await rpc('pds_snapshot');
    } catch (e) {
      setStatus(`불러오기 실패: ${e.message} — 저장된 데이터를 표시하지 못했습니다`, 'error');
      throw e;
    }
    const plans = state.snap.plans;
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('plan');
    if (!plans.some((p) => p.id === state.planId)) {
      // 주소에 계획이 없으면 할 일이 가장 많은 계획(같으면 최근 등록)을 먼저 보여 준다.
      const busiest = plans.reduce((best, p) => (!best || p.stats.planned_count >= best.stats.planned_count ? p : best), null);
      state.planId = plans.some((p) => p.id === fromHash) ? fromHash : (busiest ? busiest.id : null);
    }
    render();
    if (!state.fitted) { state.fitted = true; fitTodosToFirstScreen(); }
    if (announce) setStatus(`불러옴 · 서버 기준 오늘 ${state.snap.seoul_today} (서울)`, 'ok');
  }

  // ───────── 파생 데이터 ─────────
  const curPlan = () => state.snap?.plans.find((p) => p.id === state.planId) || null;
  const planTodos = (all = false) => state.snap.todos.filter((t) => t.plan_id === state.planId && (all || !t.deleted_at));
  const todoById = (id) => state.snap.todos.find((t) => t.id === id);
  const isOverdue = (t) => t.status === 'open' && t.due_date < state.snap.seoul_today;

  function cmp(a, b, keys) {
    for (const [k, dir] of keys) {
      const x = a[k], y = b[k];
      if (x === y) continue;
      return (x < y ? -1 : 1) * dir;
    }
    return 0;
  }

  // ───────── 렌더링 ─────────
  function render() {
    renderPlanSelect();
    renderPlanDetail();
    renderRevisions();
    renderTagFilter();
    renderTodos();
    renderExecForm();
    renderExecs();
    renderStats();
    renderReviews();
    const has = !!curPlan();
    for (const id of ['#todo-add', '#exec-add', '#review-form']) $(id).classList.toggle('hidden', !has);
    if (!has && state.planFormMode !== 'edit') openPlanForm('create');
  }

  function renderPlanSelect() {
    const sel = clear($('#plan-select'));
    if (!state.snap.plans.length) sel.append(h('option', { value: '' }, '(등록된 계획 없음)'));
    for (const p of state.snap.plans) {
      sel.append(h('option', { value: p.id, selected: p.id === state.planId }, `${p.title} (${p.start_date} ~ ${p.end_date})`));
    }
  }

  function renderPlanDetail() {
    const box = clear($('#plan-detail'));
    const p = curPlan();
    if (!p) { box.append(h('p', { class: 'hint' }, '아직 계획이 없습니다. 실제로 진행 중인 일을 계획으로 등록하세요.')); return; }
    const srcReview = p.source_review_id ? state.snap.reviews.find((r) => r.id === p.source_review_id) : null;
    const srcPlan = srcReview ? state.snap.plans.find((x) => x.id === srcReview.plan_id) : null;
    const days = Math.round((Date.parse(p.end_date) - Date.parse(p.start_date)) / 86400000) + 1;
    // 핵심 정보 칸: 라벨 / 값 / 보조 값. 날짜는 덩어리째 줄바꿈되도록 nowrap 조각으로 나눈다.
    const fact = (label, field, valueNodes, sub) => h('div', { class: 'fact' },
      h('span', { class: 'fact-label' }, label),
      h('span', { class: 'fact-value', 'data-field': field }, ...valueNodes),
      sub ? h('span', { class: 'fact-sub' }, sub) : null);
    const nw = (t) => h('span', { class: 'nw' }, t);
    box.append(...[
      h('h3', { class: 'plan-title', 'data-field': 'title' }, p.title),
      h('div', { class: 'facts' },
        fact('기간', 'period', [nw(p.start_date), ' ~ ', nw(p.end_date)], `${days}일`),
        fact('우선순위', 'priority', [nw(PRIORITY[p.priority])]),
        fact('예상 시간', 'estimated_minutes', [nw(min(p.estimated_minutes))], `약 ${Math.round(p.estimated_minutes / 6) / 10}시간`)),
      h('div', { class: 'callout criteria' },
        h('div', { class: 'callout-label' }, '성공 기준'),
        h('p', { 'data-field': 'success_criteria' }, p.success_criteria)),
      p.applied_improvement ? h('div', { class: 'callout improve', 'data-field': 'applied_improvement' },
        h('div', { class: 'callout-label' }, '반영한 회고 개선점'),
        h('p', {}, p.applied_improvement),
        srcPlan ? h('button', { type: 'button', class: 'link', onclick: () => selectPlan(srcPlan.id, 'review-section') }, `"${srcPlan.title}" 회고 보기`) : null) : null,
      // 긴 설명·계획 ID·시각은 기본 화면에서 접어 두고 필요할 때 펼쳐 본다(내보내기에도 그대로 포함).
      h('details', { class: 'fold boxed', id: 'plan-more' },
        h('summary', {}, '상세 정보 (설명·일정·계획 ID)'),
        p.description ? describe(p.description) : null,
        h('dl', { class: 'plan' },
          h('dt', {}, '계획 ID'), h('dd', { 'data-field': 'id', class: 'mono' }, p.id),
          h('dt', {}, '등록'), h('dd', {}, ts(p.created_at)),
          h('dt', {}, '마지막 수정'), h('dd', {}, ts(p.updated_at)))),
      h('div', { class: 'plan-actions' },
        h('span', { class: 'hint', 'data-field': 'version' }, nw(`현재 버전 v${p.version}`), ' · ', nw(`마지막 수정 ${ts(p.updated_at)}`)),
        h('button', { type: 'button', id: 'edit-plan-btn', onclick: () => openPlanForm('edit') }, '계획 수정')),
    ].filter(Boolean)); // 개선점이 없는 계획에서 null 이 글자로 찍히지 않게
  }

  function renderRevisions() {
    const box = clear($('#revision-list'));
    const revs = state.snap.plan_revisions.filter((r) => r.plan_id === state.planId).sort((a, b) => a.version - b.version);
    $('#revisions').querySelector('summary').textContent = `수정 이력 (${revs.length}개 버전, 최초 계획 보존)`;
    for (const r of revs) {
      box.append(h('div', { class: 'item', 'data-version': r.version },
        h('div', { class: 'title-line' }, `v${r.version}${r.version === 1 ? ' · 최초 계획' : ''} — ${r.title}`),
        h('div', { class: 'meta' },
          h('span', {}, `기간 ${r.start_date} ~ ${r.end_date}`), h('span', {}, `우선순위 ${PRIORITY[r.priority]}`),
          h('span', {}, `예상 ${min(r.estimated_minutes)}`), h('span', {}, `기록 ${ts(r.recorded_at)}`)),
        h('div', { class: 'memo' }, `성공 기준: ${r.success_criteria}`),
        r.change_note ? h('div', { class: 'memo muted' }, `수정 사유: ${r.change_note}`) : null,
      ));
    }
  }

  function renderTagFilter() {
    const sel = $('#todo-filter-tag');
    const prev = sel.value;
    const tags = [...new Set(planTodos().flatMap((t) => t.tags))].sort((a, b) => a.localeCompare(b, 'ko'));
    clear(sel).append(h('option', { value: 'all' }, '전체'), ...tags.map((t) => h('option', { value: t }, t)));
    sel.value = tags.includes(prev) ? prev : 'all';
  }

  function visibleTodos() {
    let list = planTodos();
    if (state.todoEvidence) {
      list = list.filter((t) => state.todoEvidence.ids.has(t.id));
    } else {
      const q = $('#todo-search').value.trim().toLowerCase();
      const st = $('#todo-filter-status').value;
      const pr = $('#todo-filter-priority').value;
      const tg = $('#todo-filter-tag').value;
      list = list.filter((t) =>
        (!q || [t.title, t.memo, ...t.tags].some((s) => s.toLowerCase().includes(q))) &&
        (st === 'all' || (st === 'overdue' ? isOverdue(t) : t.status === st)) &&
        (pr === 'all' || String(t.priority) === pr) &&
        (tg === 'all' || t.tags.includes(tg)));
    }
    const sort = SORTS[$('#todo-sort').value];
    return list.slice().sort((a, b) => cmp(a, b, sort.keys));
  }

  // 첫 화면에 남은 일과 완료한 일이 함께 보이도록 각 묶음을 몇 건만 먼저 보여 준다.
  const TODO_LIMIT = { open: 3, done: 2 };
  function renderTodos() {
    TODO_LIMIT.open = state.openLimit || 3;
    const sort = SORTS[$('#todo-sort').value];
    // 정렬 기준: 단계 덩어리 사이에서만 줄바꿈되게 나눠 그린다(텍스트 내용은 그대로).
    const steps = sort.label.split(' → ');
    clear($('#sort-note')).append('정렬 기준: ',
      ...steps.flatMap((s, i) => [i ? h('span', { class: 'arrow' }, ' → ') : null, h('span', { class: 'nw step' }, s)]).filter(Boolean));
    renderEvidenceChip('#todo-evidence', state.todoEvidence, () => { state.todoEvidence = null; renderTodos(); });
    // 남은 일과 완료한 일을 나눠 보여 준다. 각 묶음 안의 순서는 화면에 표시한 정렬 기준을 따른다.
    const openUl = clear($('#todo-open-list'));
    const doneUl = clear($('#todo-done-list'));
    const list = visibleTodos();
    const groups = { open: list.filter((t) => t.status !== 'done'), done: list.filter((t) => t.status === 'done') };
    $('#todo-open-count').textContent = String(groups.open.length);
    $('#todo-done-count').textContent = String(groups.done.length);
    const emptyMsg = state.todoEvidence ? '근거 기록이 없습니다(0건).' : '조건에 맞는 할 일이 없습니다.';
    for (const [key, ul] of [['open', openUl], ['done', doneUl]]) {
      const items = groups[key];
      if (!items.length) ul.append(h('li', { class: 'hint' }, emptyMsg));
      const showAll = state.todoEvidence || state.todoShowAll[key];
      items.forEach((t, i) => ul.append(todoItem(t, !showAll && i >= TODO_LIMIT[key])));
      if (!state.todoEvidence && items.length > TODO_LIMIT[key]) {
        const rest = items.length - TODO_LIMIT[key];
        ul.append(h('li', { class: 'more-row' }, h('button', { type: 'button', class: 'more-btn', id: `todo-${key}-more`,
          onclick: () => { state.todoShowAll[key] = !state.todoShowAll[key]; saveTodoShowAll(); renderTodos(); } },
          state.todoShowAll[key] ? '접기' : `${key === 'open' ? '남은 일' : '완료한 일'} ${rest}건 더 보기`)));
      }
    }
  }

  function todoItem(t, hidden) {
    const execs = state.snap.executions.filter((e) => e.todo_id === t.id);
    const actual = execs.reduce((s, e) => s + e.actual_minutes, 0);
    const done = t.status === 'done';
    return h('li', { class: `item${state.todoEvidence ? ' highlight' : ''}${done ? ' compact' : ''}${hidden ? ' hidden' : ''}`, id: `todo-${t.id}`, 'data-todo-id': t.id },
      h('div', { class: 'item-head' },
        h('span', { class: `badge ${done ? 'done' : isOverdue(t) ? 'late' : ''}`, 'data-field': 'status' }, done ? '완료' : isOverdue(t) ? '지연' : '진행 중'),
        h('div', { class: `title-line${done ? ' done-title' : ''}`, 'data-field': 'title' }, t.title)),
      t.memo ? h('div', { class: 'memo', 'data-field': 'memo' }, t.memo) : null,
      h('div', { class: 'meta' },
        h('span', { 'data-field': 'due_date' }, `마감 ${t.due_date}`),
        h('span', { 'data-field': 'priority' }, `우선순위 ${PRIORITY[t.priority]}`),
        h('span', { 'data-field': 'estimated_minutes' }, `예상 ${min(t.estimated_minutes)}`),
        h('span', {}, `실제 ${min(actual)} (${execs.length}건)`),
        done ? h('span', {}, `완료 ${ts(t.completed_at)}`) : null,
        t.tags.length ? h('span', { class: 'tags', 'data-field': 'tags' }, ...t.tags.map((g) => h('span', { class: 'badge tag' }, `#${g}`))) : null),
      h('div', { class: 'actions' },
        done
          ? h('button', { type: 'button', 'data-action': 'reopen', onclick: () => reopenTodo(t.id) }, '완료 취소')
          : h('button', { type: 'button', class: 'primary', 'data-action': 'complete', onclick: () => completeTodo(t.id) }, '완료'),
        h('button', { type: 'button', 'data-action': 'edit', onclick: () => editTodo(t.id) }, '수정'),
        h('button', { type: 'button', 'data-action': 'log', onclick: () => startExecFor(t.id) }, '실행 기록 추가'),
        execs.length ? h('button', { type: 'button', 'data-action': 'show-execs', onclick: () => showExecEvidence(`할 일 "${t.title}"의 실행 기록`, execs.map((e) => e.id)) }, '실행 기록 보기') : null,
        h('button', { type: 'button', class: 'danger', 'data-action': 'delete', onclick: () => deleteTodo(t.id, t.title) }, '삭제'),
      ));
  }

  function renderEvidenceChip(sel, ev, onClear) {
    const el = clear($(sel));
    el.classList.toggle('hidden', !ev);
    if (!ev) return;
    el.append(h('strong', {}, `근거: ${ev.label}`), h('span', {}, `${ev.ids.size}건 표시 중`),
      h('button', { type: 'button', class: 'link', onclick: onClear }, '근거 표시 해제'));
  }

  function renderExecForm() {
    const sel = $('#exec-form [name=todo_id]');
    const prev = sel.value;
    const todos = planTodos().slice().sort((a, b) => cmp(a, b, SORTS.created.keys));
    clear(sel).append(h('option', { value: '' }, '할 일 선택'), ...todos.map((t) => h('option', { value: t.id }, t.title)));
    if (todos.some((t) => t.id === prev)) sel.value = prev;
  }

  function renderExecs() {
    renderEvidenceChip('#exec-evidence', state.execEvidence, () => { state.execEvidence = null; renderExecs(); });
    const ul = clear($('#exec-list'));
    const ids = new Set(planTodos(true).map((t) => t.id));
    const all = state.snap.executions.filter((e) => ids.has(e.todo_id));
    // 요약 칸: 기록 수·합계·막힘
    const sum = all.reduce((s, e) => s + e.actual_minutes, 0);
    const blocked = all.filter((e) => e.blocker).length;
    clear($('#exec-summary')).append(
      h('div', { class: 'mini' }, h('span', { class: 'mini-num' }, String(all.length)), h('span', { class: 'mini-lbl' }, '실행 기록')),
      h('div', { class: 'mini' }, h('span', { class: 'mini-num' }, min(sum)), h('span', { class: 'mini-lbl' }, '실제 시간 합계')),
      h('div', { class: `mini${blocked ? ' warn' : ''}` }, h('span', { class: 'mini-num' }, String(blocked)), h('span', { class: 'mini-lbl' }, '막힘 있었던 기록')));
    let list = all;
    if (state.execEvidence) list = list.filter((e) => state.execEvidence.ids.has(e.id));
    list.sort((a, b) => cmp(a, b, [['started_at', -1], ['id', 1]]));
    if (!list.length) ul.append(h('li', { class: 'hint' }, state.execEvidence ? '근거 기록이 없습니다(0건).' : '아직 실행 기록이 없습니다.'));
    // 기본은 최근 3건만 보여 주고 나머지는 "더 보기"로 펼친다(근거 표시 중에는 전부 표시).
    const SHOW = 3;
    const folded = !state.execEvidence && !state.execShowAll && list.length > SHOW;
    list.forEach((e, i) => {
      const t = todoById(e.todo_id);
      ul.append(h('li', { class: `item exec${e.blocker ? ' has-blocker' : ''}${state.execEvidence ? ' highlight' : ''}${folded && i >= SHOW ? ' hidden' : ''}`, id: `exec-${e.id}`, 'data-exec-id': e.id },
        h('div', { class: 'exec-time' },
          h('span', { class: 'nw', 'data-field': 'started_at' }, `시작 ${ts(e.started_at)}`),
          h('span', { class: 'nw', 'data-field': 'ended_at' }, `종료 ${ts(e.ended_at)}`),
          h('span', { class: 'pill nw', 'data-field': 'actual_minutes' }, `실제 ${min(e.actual_minutes)}`)),
        h('div', { class: 'title-line' }, h('span', { class: 'sub-label' }, '연결된 할 일: '),
          t.deleted_at ? h('span', {}, `${t.title} (삭제된 할 일)`)
            : h('a', { href: `#todo-${t.id}`, onclick: (ev) => { ev.preventDefault(); showTodoEvidence(`실행 기록의 할 일`, [t.id]); } }, t.title)),
        e.note ? h('div', { class: 'memo' }, `메모: ${e.note}`) : null,
        h('div', { class: e.blocker ? 'blocker' : 'meta', 'data-field': 'blocker' }, e.blocker ? `막힘 사유: ${e.blocker}` : '막힘 없음')));
    });
    if (!state.execEvidence && list.length > SHOW) {
      ul.append(h('li', { class: 'more-row' }, h('button', { type: 'button', class: 'more-btn', id: 'exec-more-btn',
        onclick: () => { state.execShowAll = !state.execShowAll; renderExecs(); } },
        state.execShowAll ? '최근 3건만 보기' : `이전 실행 기록 ${list.length - SHOW}건 더 보기`)));
    }
  }

  function renderStats() {
    const box = clear($('#stats'));
    const p = curPlan();
    const cap = clear($('#stats-caption'));
    if (!p) return;
    const s = p.stats;
    cap.append(h('span', { class: 'nw' }, '선택한 계획의 삭제되지 않은 할 일 기준'), ' · ',
      h('span', { class: 'nw' }, `지연 기준일 ${s.seoul_today}(서울)`), ' · ',
      h('span', { class: 'nw' }, '숫자를 누르면 근거 기록으로 이동'));
    const tone = { done: s.done_count > 0 ? 'good' : '', overdue: s.overdue_count > 0 ? 'bad' : '', blocked: s.blocked_count > 0 ? 'warn' : '', diff: s.diff_minutes > 0 ? 'bad' : '' };
    const card = (key, label, value, onClick) => h('button', { type: 'button', class: `stat ${tone[key] || ''}`, 'data-stat': key, onclick: onClick },
      h('span', { class: 'num' }, value), h('span', { class: 'lbl' }, label));
    const todoEv = (label, ids) => () => showTodoEvidence(label, ids);
    const pct = s.planned_count ? Math.round((s.done_count / s.planned_count) * 100) : 0;
    // 표시 비율은 실제 값 그대로(100% 초과 가능), 막대 너비만 100%로 제한한다. 예상 0분이면 0%.
    const timePct = s.estimated_minutes ? Math.round((s.actual_minutes / s.estimated_minutes) * 100) : 0;
    box.append(
      h('div', { class: 'subpanel progress' },
        h('div', { class: 'subpanel-head' }, h('h3', {}, '진행'), h('span', { class: 'subpanel-note' }, `완료율 ${pct}%`)),
        h('div', { class: 'bar', role: 'img', 'aria-label': `완료율 ${pct}%` }, barFill(pct)),
        h('div', { class: 'stat-grid' },
          card('planned', '계획 수(할 일)', s.planned_count, todoEv('계획 수', s.planned_todo_ids)),
          card('done', '완료 수', s.done_count, todoEv('완료 수', s.done_todo_ids)),
          card('overdue', '지연 수', s.overdue_count, todoEv('지연 수', s.overdue_todo_ids)),
          card('blocked', '막힘 수', s.blocked_count, todoEv('막힘 수', s.blocked_todo_ids)))),
      h('div', { class: 'subpanel time' },
        h('div', { class: 'subpanel-head' }, h('h3', {}, '시간'), h('span', { class: 'subpanel-note', 'data-field': 'time-pct' }, `예상 대비 실제 ${timePct}%`)),
        h('div', { class: `bar${timePct > 100 ? ' over' : ''}`, role: 'img', 'aria-label': `예상 대비 실제 ${timePct}%` }, barFill(Math.min(100, timePct))),
        h('div', { class: 'stat-grid three' },
          card('estimated', '예상 시간', min(s.estimated_minutes), todoEv('예상 시간(할 일 예상 합계)', s.planned_todo_ids)),
          card('actual', '실제 시간', min(s.actual_minutes), () => showExecEvidence('실제 시간(실행 기록 합계)', s.execution_ids)),
          card('diff', '차이(실제−예상)', `${s.diff_minutes > 0 ? '+' : ''}${min(s.diff_minutes)}`, () => {
            showTodoEvidence('차이 계산 대상 할 일', s.planned_todo_ids, false);
            showExecEvidence('차이 계산 대상 실행 기록', s.execution_ids);
          }))),
    );
  }

  // CSP(style-src 'self')는 style 속성 문자열을 막으므로 CSSOM 으로 너비를 지정한다.
  function barFill(pct) {
    const el = h('span', {});
    el.style.width = `${pct}%`;
    return el;
  }

  function renderReviews() {
    const ul = clear($('#review-list'));
    const list = state.snap.reviews.filter((r) => r.plan_id === state.planId).sort((a, b) => cmp(b, a, [['created_at', 1], ['id', 1]]));
    if (!list.length) ul.append(h('li', { class: 'hint' }, '아직 저장한 회고가 없습니다.'));
    for (const r of list) {
      const next = state.snap.plans.filter((p) => p.source_review_id === r.id);
      const st = r.stats;
      ul.append(h('li', { class: 'item', 'data-review-id': r.id },
        h('div', { class: 'title-line' }, `개선점: ${r.improvement}`),
        h('div', { class: 'meta' }, h('span', {}, `회고일 ${r.seoul_date}`), h('span', {}, '당시 집계:'),
          h('span', {}, `계획 ${st.planned_count}`), h('span', {}, `완료 ${st.done_count}`), h('span', {}, `지연 ${st.overdue_count}`),
          h('span', {}, `막힘 ${st.blocked_count}`), h('span', {}, `예상 ${min(st.estimated_minutes)}`), h('span', {}, `실제 ${min(st.actual_minutes)}`)),
        h('div', { class: 'actions' },
          next.length
            ? next.map((p) => h('button', { type: 'button', class: 'link', 'data-action': 'open-next', onclick: () => selectPlan(p.id, 'plan-section') }, `반영된 다음 계획: ${p.title}`))
            : h('button', { type: 'button', class: 'primary', 'data-action': 'make-next', onclick: () => openPlanForm('create', r) }, '이 개선점으로 다음 계획 만들기'))));
    }
  }

  // 데스크톱 2열에서 처음 열었을 때 완료한 일 첫 항목까지 첫 화면에 들어오도록 남은 일 표시 수를 줄인다.
  function fitTodosToFirstScreen() {
    if (window.innerWidth < 960 || state.todoShowAll.open || state.todoEvidence || window.scrollY > 0) return;
    for (let n = 3; n >= 1; n--) {
      state.openLimit = n;
      renderTodos();
      // 완료한 일 첫 항목의 제목 줄까지 보이면 충분하다.
      const firstDone = document.querySelector('#todo-done-list li.item:not(.hidden) .item-head') || $('#todo-done-title');
      if (firstDone.getBoundingClientRect().bottom <= window.innerHeight - 8) return;
    }
  }

  // ───────── 근거 이동 ─────────
  function showTodoEvidence(label, ids, scroll = true) {
    state.todoEvidence = { label, ids: new Set(ids) };
    renderTodos();
    if (scroll) $('#todo-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function showExecEvidence(label, ids) {
    state.execEvidence = { label, ids: new Set(ids) };
    renderExecs();
    $('#exec-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function selectPlan(id, sectionId) {
    state.planId = id;
    state.todoEvidence = state.execEvidence = null;
    history.replaceState(null, '', `#plan=${id}`);
    closePlanForm();
    render();
    if (sectionId) document.getElementById(sectionId).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ───────── 계획 폼 ─────────
  function openPlanForm(mode, review = null) {
    const f = $('#plan-form');
    state.planFormMode = mode;
    state.sourceReviewId = review ? review.id : null;
    f.reset();
    f.classList.remove('hidden');
    f.querySelector('.edit-only').classList.toggle('hidden', mode !== 'edit');
    $('#plan-form-title').textContent = mode === 'edit' ? '계획 수정 (이전 내용은 이력에 보존)' : review ? '회고 개선점을 반영한 다음 계획' : '새 계획 등록';
    const imp = $('#plan-form-improvement');
    imp.classList.toggle('hidden', !review);
    imp.textContent = review ? `반영할 개선점: ${review.improvement}` : '';
    if (mode === 'edit') {
      const p = curPlan();
      for (const k of ['title', 'description', 'start_date', 'end_date', 'priority', 'success_criteria', 'estimated_minutes']) f.elements[k].value = p[k];
    }
    f.elements.title.focus();
  }
  function closePlanForm() { $('#plan-form').classList.add('hidden'); state.planFormMode = null; state.sourceReviewId = null; }

  async function submitPlan(ev) {
    ev.preventDefault();
    const f = ev.target;
    const v = (k) => f.elements[k].value;
    const body = {
      p_title: v('title'), p_description: v('description'), p_start_date: v('start_date'), p_end_date: v('end_date'),
      p_priority: Number(v('priority')), p_success_criteria: v('success_criteria'), p_estimated_minutes: Number(v('estimated_minutes')),
    };
    if (state.planFormMode === 'edit') {
      const p = curPlan();
      await mutate('계획 수정', () => rpc('pds_update_plan', { p_plan_id: p.id, p_expected_version: p.version, ...body, p_change_note: v('change_note') })).catch(() => null);
      if (!$('#status').classList.contains('error')) closePlanForm(), render();
    } else {
      if (state.sourceReviewId) body.p_source_review_id = state.sourceReviewId;
      const id = await mutate('계획 등록', () => rpc('pds_create_plan', body)).catch(() => null);
      if (id) selectPlan(id, 'plan-section');
    }
  }

  // ───────── 할 일 ─────────
  function editTodo(id) {
    const t = todoById(id);
    const f = $('#todo-form');
    state.editingTodoId = id;
    f.elements.title.value = t.title;
    f.elements.memo.value = t.memo;
    f.elements.due_date.value = t.due_date;
    f.elements.priority.value = String(t.priority);
    f.elements.tags.value = t.tags.join(', ');
    f.elements.estimated_minutes.value = t.estimated_minutes;
    $('#todo-form-title').textContent = '할 일 수정';
    f.querySelector('[data-cancel]').classList.remove('hidden');
    $('#todo-add').open = true;
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.elements.title.focus();
  }
  function resetTodoForm() {
    const f = $('#todo-form');
    f.reset();
    state.editingTodoId = null;
    $('#todo-form-title').textContent = '할 일 추가';
    f.querySelector('[data-cancel]').classList.add('hidden');
  }
  async function submitTodo(ev) {
    ev.preventDefault();
    const f = ev.target;
    const body = {
      p_title: f.elements.title.value, p_memo: f.elements.memo.value, p_due_date: f.elements.due_date.value || null,
      p_priority: Number(f.elements.priority.value), p_estimated_minutes: Number(f.elements.estimated_minutes.value),
      p_tags: f.elements.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
    };
    try {
      if (state.editingTodoId) await mutate('할 일 수정', () => rpc('pds_update_todo', { p_todo_id: state.editingTodoId, ...body }));
      else await mutate('할 일 추가', () => rpc('pds_create_todo', { p_plan_id: state.planId, ...body }));
      resetTodoForm();
    } catch { /* 상태 표시줄에 오류 표시됨 */ }
  }
  async function completeTodo(id) {
    // 같은 할 일의 완료 의도는 하나의 멱등성 키를 공유한다. 연속 클릭·재전송에도 서버가 1건만 기록한다.
    if (!state.completeKeys.has(id)) state.completeKeys.set(id, crypto.randomUUID());
    const key = state.completeKeys.get(id);
    const r = await mutate('완료 처리', () => rpc('pds_complete_todo', { p_todo_id: id, p_idempotency_key: key })).catch(() => null);
    if (r && !r.created) setStatus(`완료 요청이 중복되어 새 기록을 만들지 않았습니다 (${r.reason})`, 'ok');
  }
  async function reopenTodo(id) {
    await mutate('완료 취소', () => rpc('pds_reopen_todo', { p_todo_id: id })).catch(() => null);
    state.completeKeys.delete(id); // 다시 완료하면 새 의도 → 새 키
  }
  async function deleteTodo(id, title) {
    if (!window.confirm(`"${title}" 할 일을 삭제할까요? (실행 기록은 보존되고 회고 집계에서 제외됩니다)`)) return;
    await mutate('할 일 삭제', () => rpc('pds_delete_todo', { p_todo_id: id })).catch(() => null);
  }

  // ───────── 실행 기록 ─────────
  function startExecFor(id) {
    const f = $('#exec-form');
    $('#exec-add').open = true;
    f.elements.todo_id.value = id;
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.elements.started_at.focus();
  }
  function suggestMinutes() {
    const f = $('#exec-form');
    const s = f.elements.started_at.value, e = f.elements.ended_at.value;
    if (!s || !e) return;
    const span = Math.ceil((Date.parse(seoulLocalToIso(e)) - Date.parse(seoulLocalToIso(s))) / 60000);
    if (span > 0 && (!f.elements.actual_minutes.value || f.elements.actual_minutes.dataset.auto === '1')) {
      f.elements.actual_minutes.value = span;
      f.elements.actual_minutes.dataset.auto = '1';
    }
  }
  async function submitExec(ev) {
    ev.preventDefault();
    const f = ev.target;
    try {
      await mutate('실행 기록', () => rpc('pds_add_execution', {
        p_todo_id: f.elements.todo_id.value, p_started_at: seoulLocalToIso(f.elements.started_at.value),
        p_ended_at: seoulLocalToIso(f.elements.ended_at.value), p_actual_minutes: Number(f.elements.actual_minutes.value),
        p_blocker: f.elements.blocker.value, p_note: f.elements.note.value,
      }));
      const keep = f.elements.todo_id.value;
      f.reset();
      f.elements.todo_id.value = keep;
      delete f.elements.actual_minutes.dataset.auto;
    } catch { /* 상태 표시줄 */ }
  }

  // ───────── 회고 ─────────
  async function submitReview(ev) {
    ev.preventDefault();
    const f = ev.target;
    try {
      await mutate('회고', () => rpc('pds_create_review', { p_plan_id: state.planId, p_improvement: f.elements.improvement.value }));
      f.reset();
    } catch { /* 상태 표시줄 */ }
  }

  // ───────── 내보내기 ─────────
  async function exportAll() {
    setStatus('내보내기 준비 중…');
    try {
      const data = await rpc('pds_snapshot');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const stamp = String(data.generated_at).replace(/[-:]/g, '').slice(0, 13);
      const a = h('a', { href: URL.createObjectURL(blob), download: `pds-export-${stamp}.json` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      setStatus(`내보냄: 계획 ${data.plans.length} · 할 일 ${data.todos.length} · 실행 ${data.executions.length} · 회고 ${data.reviews.length}`, 'ok');
    } catch (e) {
      setStatus(`내보내기 실패: ${e.message}`, 'error');
    }
  }

  // ───────── 이벤트 연결 ─────────
  $('#plan-select').addEventListener('change', (e) => selectPlan(e.target.value));
  $('#new-plan-btn').addEventListener('click', () => openPlanForm('create'));
  $('#plan-form').addEventListener('submit', submitPlan);
  $('#plan-form [data-cancel]').addEventListener('click', closePlanForm);
  $('#todo-form').addEventListener('submit', submitTodo);
  $('#todo-form [data-cancel]').addEventListener('click', resetTodoForm);
  for (const id of ['#todo-search', '#todo-filter-status', '#todo-filter-priority', '#todo-filter-tag', '#todo-sort']) {
    $(id).addEventListener('input', () => { state.todoEvidence = null; renderTodos(); });
  }
  $('#exec-form').addEventListener('submit', submitExec);
  $('#exec-form [name=started_at]').addEventListener('change', suggestMinutes);
  $('#exec-form [name=ended_at]').addEventListener('change', suggestMinutes);
  $('#exec-form [name=actual_minutes]').addEventListener('input', (e) => { delete e.target.dataset.auto; });
  $('#review-form').addEventListener('submit', submitReview);
  $('#export-btn').addEventListener('click', exportAll);
  $('#reload-btn').addEventListener('click', () => load().catch(() => null));

  load().catch(() => null);
})();
