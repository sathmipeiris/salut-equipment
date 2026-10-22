'use strict';
(function () {
  const { h, api, ApiError, uuid, fmtDate, ago, addDays, toast } = U;
  const app = document.getElementById('app');
  const ID_IN_TEXT = /\b([A-Za-z]{1,4}-\d{3,4})\b/;

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(`salut.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`salut.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const qs = new URLSearchParams(location.search);
  if (qs.has('kiosk')) LS.set('kiosk', qs.get('kiosk') !== '0');
  const KIOSK = LS.get('kiosk', false);

  const blankDetails = () => ({ employee: '', project: '', requester: '', site: '', location: '', due: '' });
  const S = {
    data: null, byId: new Map(), view: 'home', mode: null,
    cart: new Set(), problems: new Set(), cat: 'all', q: '', showNA: false, mine: false,
    d: Object.assign(blankDetails(), LS.get('details', {}), { due: '' }),
    detailsOpen: true, notes: '', last: null, busy: false, sheet: false, sheetErr: null, attempt: null,
    queue: LS.get('queue', []), failed: LS.get('failed', []), online: navigator.onLine, el: {}, kioskTimer: null,
  };
  if (KIOSK) { S.d.employee = ''; S.d.project = ''; S.d.requester = ''; S.d.site = ''; }

  /* ================= data ================= */
  async function load() {
    try { applyData(await api('/api/bootstrap')); setNet(navigator.onLine); }
    catch (e) { if (e.offline) setNet(false); else if (!S.data) app.replaceChildren(h('div', { class: 'banner bad' }, 'Could not load equipment. Check the connection and refresh.')); }
  }
  function overlayQueue() { // show this device's not-yet-synced transactions as if applied
    for (const q of S.queue) for (const it of q.items) {
      const e = S.byId.get(it.id); if (!e) continue;
      if (q.kind === 'out') Object.assign(e, { status: 'out', holder: q.employee, project_name: q.project_name || q.project_code });
      else Object.assign(e, { status: it.condition === 'issue' ? 'maintenance' : 'available', holder: null });
    }
  }
  function applyData(d) {
    S.data = d; S.byId = new Map(d.equipment.map((e) => [e.id, e])); overlayQueue();
    document.getElementById('dl-emps').replaceChildren(...d.employees.map((n) => h('option', { value: n })));
    document.getElementById('dl-projects').replaceChildren(...d.projects.map((p) => h('option', { value: `${p.code} — ${p.name}` })));
    // drop cart items whose state changed under us (someone else took it, etc.)
    for (const id of [...S.cart]) {
      const e = S.byId.get(id); const ok = e && (S.mode === 'out' ? e.status === 'available' : e.status === 'out');
      if (!ok) { S.cart.delete(id); S.problems.delete(id); toast(e && e.status === 'out' && S.mode === 'out' ? `${id} was just signed out by ${e.holder} — removed from your list` : `${id} changed and was removed from your list`, 'bad'); }
    }
    persistCart(); refresh();
  }
  function refresh() {
    if (S.view === 'home') renderHome();
    else if (S.view === 'flow') { renderChips(); renderGrid(); renderTray(); if (S.sheet) renderSheet(); }
  }
  function setNet(on) {
    S.online = on; const n = document.getElementById('net'); if (!n) return;
    const w = S.queue.length; n.textContent = on ? (w ? `Syncing ${w}…` : 'Online') : `Offline${w ? ` · ${w} saved` : ''}`; n.className = `net ${on && !w ? '' : 'off'}`;
  }
  const persistCart = () => LS.set('cart', { mode: S.mode, ids: [...S.cart] });
  const persistDetails = () => { const { employee, project, requester, site, location } = S.d; LS.set('details', KIOSK ? { location } : { employee, project, requester, site, location }); };

  /* ================= offline queue ================= */
  let flushing = false;
  async function flushQueue() {
    if (flushing || !S.queue.length) return; flushing = true;
    try {
      for (const q of [...S.queue]) {
        try { await api('/api/transactions', { method: 'POST', body: q }); S.queue = S.queue.filter((x) => x.idem_key !== q.idem_key); }
        catch (e) {
          if (e.offline) break;
          S.queue = S.queue.filter((x) => x.idem_key !== q.idem_key);
          S.failed.push({ at: new Date().toISOString(), kind: q.kind, employee: q.employee, items: q.items.map((i) => i.id), why: (e.body && e.body.conflicts ? e.body.conflicts.map((c) => c.message).join(' ') : e.message) });
        }
      }
    } finally { flushing = false; LS.set('queue', S.queue); LS.set('failed', S.failed); setNet(navigator.onLine); await load(); }
  }

  /* ================= selection helpers ================= */
  function startMode(mode, opts = {}) {
    if (S.mode !== mode) { S.cart.clear(); S.problems.clear(); }
    S.mode = mode; S.view = 'flow'; S.cat = 'all'; S.q = ''; S.showNA = false; S.sheet = false; S.notes = '';
    S.mine = !!(opts.mine && S.d.employee.trim());
    S.detailsOpen = !detailsComplete(); persistCart(); render(); window.scrollTo(0, 0);
  }
  function stateFor(id) { const e = S.byId.get(id); return e ? e.status : null; }
  function addById(id, quiet) {
    id = id.toUpperCase(); const e = S.byId.get(id);
    if (!e) { if (!quiet) toast(`${id} isn't in the inventory`, 'bad'); return false; }
    const want = e.status === 'available' ? 'out' : e.status === 'out' ? 'in' : null;
    if (!want) { if (!quiet) toast(`${id} is in maintenance — see an administrator`, 'bad'); return false; }
    if (S.cart.size && S.mode !== want) { if (!quiet) toast(want === 'in' ? `${id} is already signed out. Finish this sign-out first, then do a return.` : `${id} is available. Finish this return first, then sign it out.`, 'bad'); return false; }
    if (S.view !== 'flow' || S.mode !== want) startMode(want);
    S.cart.add(id); persistCart();
    if (!quiet) { toast(`Added ${id} · ${e.name}`, 'ok'); renderChips(); renderGrid(); renderTray(); }
    return true;
  }
  function parseIds(text) {
    const out = []; const bad = [];
    for (const tok of text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
      const m = tok.match(/^([A-Za-z]{1,4})[- ]?(\d{1,4})(?:\s*(?:\.\.|–|—|to|-)\s*(?:[A-Za-z]{1,4}[- ]?)?(\d{1,4}))?$/i);
      if (!m) { bad.push(tok); continue; }
      const a = +m[2]; const b = m[3] ? +m[3] : a; if (b < a || b - a > 100) { bad.push(tok); continue; }
      for (let n = a; n <= b; n++) out.push(`${m[1].toUpperCase()}-${String(n).padStart(3, '0')}`);
    }
    return { ids: out, bad };
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches = (e, q) => { if (!q) return true; const n = norm(q); return norm(e.id).includes(n) || norm(e.name).includes(n) || norm(e.serial).includes(n) || norm(e.category).includes(n) || norm(e.project_name).includes(n) || norm(e.holder).includes(n); };
  const hue = (i) => `hsl(${(i * 47 + 210) % 360} 58% 42%)`;
  const label = (e) => (e ? `${e.id} · ${e.name}` : '');

  /* ================= details ================= */
  const detailsError = () => {
    if (S.d.employee.trim().length < 2) return { field: 'f-emp', msg: 'Please choose or type your name.' };
    if (S.mode === 'out' && !S.d.project.trim()) return { field: 'f-proj', msg: 'Please enter the project.' };
    if (!S.d.location) return { field: 'f-loc', msg: 'Please choose a location.' };
    return null;
  };
  const detailsComplete = () => !detailsError();
  function resolveProject() {
    const t = S.d.project.trim().toLowerCase();
    const p = S.data && S.data.projects.find((x) => `${x.code} — ${x.name}`.toLowerCase() === t || x.code.toLowerCase() === t);
    return p ? { code: p.code, name: p.name, site: p.site } : { code: '', name: S.d.project.trim(), site: '' };
  }

  function renderDetails() {
    const box = S.el.details; if (!box) return;
    const out = S.mode === 'out';
    if (!S.detailsOpen && detailsComplete()) {
      const kv = (k, v) => h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
      box.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'summary' },
        h('span', { class: 'step done' }, '✓'),
        h('div', { class: 'row grow', style: 'gap:22px' }, kv('Who', S.d.employee), out && kv('Project', S.d.project), kv(out ? 'From' : 'Returning to', S.d.location), out && S.d.due && kv('Back by', fmtDate(S.d.due))),
        h('button', { class: 'link', onclick: () => { S.detailsOpen = true; renderDetails(); } }, 'Edit'))));
      return;
    }
    let okBtn; const sync = () => { if (okBtn) okBtn.disabled = !detailsComplete(); };
    const field = (id, lab, el, hint) => h('div', { class: 'field' }, h('label', { class: 'f', for: id }, lab), el, h('div', { class: 'err', id: `${id}-err`, hidden: true }));
    const emp = h('input', { type: 'text', id: 'f-emp', list: 'dl-emps', autocomplete: 'off', autocapitalize: 'words', placeholder: 'Start typing your name', value: S.d.employee, oninput: (e) => { S.d.employee = e.target.value; clearErr('f-emp'); sync(); } });
    const proj = h('input', { type: 'text', id: 'f-proj', list: 'dl-projects', autocomplete: 'off', placeholder: 'Project number or name', value: S.d.project, oninput: (e) => { S.d.project = e.target.value; clearErr('f-proj'); autoSite(); sync(); } });
    const loc = h('select', { id: 'f-loc', onchange: (e) => { S.d.location = e.target.value; clearErr('f-loc'); sync(); } },
      h('option', { value: '' }, 'Choose location…'), ...S.data.locations.map((l) => h('option', { value: l.name, selected: l.name === S.d.location }, l.name)));
    const recent = LS.get('recentProjects', []).filter((r) => S.data.projects.some((p) => `${p.code} — ${p.name}` === r)).slice(0, 3);
    const dueIn = h('input', { type: 'date', id: 'f-due', min: S.data.today, value: S.d.due, onchange: (e) => { S.d.due = e.target.value; renderDetails(); } });
    const dueChip = (txt, v) => h('button', { type: 'button', class: `chip ${S.d.due === v ? 'on' : ''}`, onclick: () => { S.d.due = v; renderDetails(); } }, txt);
    const siteIn = h('input', { type: 'text', id: 'f-site', placeholder: 'Filled in from the project, or type an address', value: S.d.site, oninput: (e) => { S.d.site = e.target.value; S.d.siteAuto = false; } });
    const reqIn = h('input', { type: 'text', id: 'f-req', placeholder: 'Project manager / client contact', value: S.d.requester, oninput: (e) => { S.d.requester = e.target.value; } });
    function autoSite() { const p = resolveProject(); if (p.code && (!S.d.site || S.d.siteAuto)) { S.d.site = p.site; S.d.siteAuto = true; siteIn.value = p.site; } }

    box.replaceChildren(h('div', { class: 'card' },
      h('h2', null, h('span', { class: 'step' }, '1'), 'Who and where'),
      h('div', { class: out ? 'grid2' : '' }, field('f-emp', 'Your name', emp), out && field('f-proj', 'Project', proj)),
      out && recent.length ? h('div', { class: 'chips', style: 'margin:-4px 0 12px' }, ...recent.map((r) => h('button', { type: 'button', class: 'chip', onclick: () => { S.d.project = r; autoSite(); renderDetails(); } }, r.split(' — ')[0]))) : null,
      field('f-loc', out ? 'Signing out from' : 'Returning to', loc),
      out && h('div', { class: 'field' }, h('label', { class: 'f' }, 'Expected back'),
        h('div', { class: 'chips', style: 'margin-bottom:8px' }, dueChip('Today', addDays(0)), dueChip('1 week', addDays(7)), dueChip('2 weeks', addDays(14)), dueChip('1 month', addDays(30)), dueChip('Not sure', '')), dueIn),
      out && h('details', { class: 'more' }, h('summary', null, 'More details (optional)'), h('div', { class: 'grid2' }, field('f-req', 'Requested by', reqIn), field('f-site', 'Site address', siteIn))),
      (okBtn = h('button', { class: 'btn small', disabled: detailsComplete() ? null : true, onclick: () => { S.detailsOpen = false; renderDetails(); } }, 'Looks good ✓'))));
  }
  function clearErr(id) { const i = document.getElementById(id); if (i) i.classList.remove('invalid'); const e = document.getElementById(`${id}-err`); if (e) e.hidden = true; }
  function showErr(err) {
    S.detailsOpen = true; renderDetails();
    const i = document.getElementById(err.field); if (!i) return; i.classList.add('invalid'); i.scrollIntoView({ block: 'center', behavior: 'smooth' }); i.focus();
    const e = document.getElementById(`${err.field}-err`); if (e) { e.textContent = err.msg; e.hidden = false; }
  }

  /* ================= picker ================= */
  function renderPicker() {
    const out = S.mode === 'out';
    const search = h('input', { type: 'search', id: 'f-q', placeholder: out ? 'Search by ID or name…' : 'Search by ID, name or project…', value: S.q, autocomplete: 'off', oninput: (e) => { S.q = e.target.value; renderGrid(); } });
    const quick = h('input', { type: 'text', id: 'f-quick', placeholder: 'e.g. FN-1..8, DH-2, AS-3', autocapitalize: 'characters', autocomplete: 'off', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); doQuick(); } } });
    function doQuick() {
      const { ids, bad } = parseIds(quick.value); if (!ids.length && !bad.length) return;
      let added = 0; const skipped = [];
      for (const id of ids) { if (addById(id, true)) added++; else skipped.push(id); }
      quick.value = ''; renderChips(); renderGrid(); renderTray();
      toast(`${added} added${skipped.length ? ` · skipped ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''} (${out ? 'not available' : 'not signed out'})` : ''}${bad.length ? ` · couldn’t read “${bad[0]}”` : ''}`, skipped.length || bad.length ? 'bad' : 'ok');
    }
    S.el.chips = h('div', { class: 'chips', style: 'margin:12px 0' }); S.el.grid = h('div');
    S.el.picker.replaceChildren(h('div', { class: 'card' },
      h('h2', null, h('span', { class: 'step' }, '2'), out ? 'Pick equipment' : 'What are you returning?'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, search), h('button', { class: 'btn green small', onclick: openScanner, 'aria-label': 'Scan QR labels with the camera' }, '📷 Scan')),
      h('details', { class: 'more' }, h('summary', null, 'Type IDs instead'), h('div', { class: 'row' }, h('div', { class: 'grow' }, quick), h('button', { class: 'btn small', onclick: doQuick }, 'Add'))),
      S.el.chips, S.el.grid));
    renderChips(); renderGrid();
  }
  function renderChips() {
    if (!S.el.chips || !S.data) return;
    const out = S.mode === 'out';
    if (out) {
      const avail = S.data.equipment.filter((e) => e.status === 'available');
      const chip = (id, txt, n) => h('button', { class: `chip ${S.cat === id ? 'on' : ''}`, onclick: () => { S.cat = id; renderChips(); renderGrid(); } }, txt, h('span', { class: 'n' }, n));
      S.el.chips.replaceChildren(chip('all', 'All', avail.length), ...S.data.categories.map((c) => chip(c.id, c.name, avail.filter((e) => e.category_id === c.id).length)));
    } else {
      const mineN = S.data.equipment.filter((e) => e.status === 'out' && sameName(e.holder, S.d.employee)).length;
      const allN = S.data.equipment.filter((e) => e.status === 'out').length;
      S.el.chips.replaceChildren(
        h('button', { class: `chip ${S.mine ? 'on' : ''}`, onclick: () => { S.mine = true; renderChips(); renderGrid(); } }, 'Signed out to me', h('span', { class: 'n' }, mineN)),
        h('button', { class: `chip ${!S.mine ? 'on' : ''}`, onclick: () => { S.mine = false; renderChips(); renderGrid(); } }, 'Everything signed out', h('span', { class: 'n' }, allN)));
    }
  }
  const sameName = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();

  function renderGrid() {
    if (!S.el.grid || !S.data) return;
    S.mode === 'out' ? gridOut() : gridIn();
  }
  function gridOut() {
    const catIdx = new Map(S.data.categories.map((c, i) => [c.id, i]));
    const list = S.data.equipment.filter((e) => (S.cat === 'all' || e.category_id === S.cat) && matches(e, S.q));
    const avail = list.filter((e) => e.status === 'available'); const na = list.filter((e) => e.status !== 'available');
    const shown = S.showNA ? list : avail;
    const tile = (e) => {
      const sel = S.cart.has(e.id); const ok = e.status === 'available';
      return h('button', { class: `tile ${sel ? 'sel' : ''} ${ok ? '' : 'na'}`, style: `--cat:${hue(catIdx.get(e.category_id) || 0)}`, 'aria-pressed': ok ? String(sel) : null, id: `t-${e.id}`,
        onclick: () => {
          if (!ok) return toast(e.status === 'out' ? `${e.id} is signed out to ${e.holder}${e.project_name ? ` (${e.project_name})` : ''}. If it's back, use Return.` : `${e.id} is in maintenance${e.issue ? `: ${e.issue}` : ''}.`, 'bad');
          sel ? S.cart.delete(e.id) : S.cart.add(e.id); persistCart(); renderGrid(); renderTray();
        } },
        h('span', { class: 'id' }, e.id), h('span', { class: 'nm' }, e.name),
        h('span', { class: 'tag' }, ok ? (sel ? 'SELECTED' : e.location ? `at ${e.location.replace(/^Warehouse – /, '')}` : 'Available') : e.status === 'out' ? `OUT · ${(e.holder || '').split(' ')[0]}` : 'MAINTENANCE'));
    };
    const canAll = (S.q || S.cat !== 'all') && avail.length > 1 && avail.length <= 60 && avail.some((e) => !S.cart.has(e.id));
    S.el.grid.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'muted grow' }, `${avail.length} available`),
        canAll ? h('button', { class: 'link', onclick: () => { avail.forEach((e) => S.cart.add(e.id)); persistCart(); renderGrid(); renderTray(); } }, `Select all ${avail.length}`) : null,
        na.length ? h('button', { class: 'link', onclick: () => { S.showNA = !S.showNA; renderGrid(); } }, S.showNA ? 'Hide unavailable' : `Show ${na.length} unavailable`) : null),
      shown.length ? h('div', { class: 'tiles' }, ...shown.map(tile)) : h('p', { class: 'muted' }, S.q ? 'Nothing matches that search.' : 'Nothing available in this category right now.'));
  }
  function gridIn() {
    let list = S.data.equipment.filter((e) => e.status === 'out' && matches(e, S.q));
    if (S.mine && S.d.employee.trim()) list = list.filter((e) => sameName(e.holder, S.d.employee));
    const groups = new Map();
    for (const e of list) { const k = e.project_name ? `${e.project_code ? `${e.project_code} — ` : ''}${e.project_name}` : 'No project'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
    const row = (e) => {
      const sel = S.cart.has(e.id); const late = e.due_date && e.due_date < S.data.today;
      return h('button', { class: `item ${sel ? 'sel' : ''}`, 'aria-pressed': String(sel), onclick: () => { sel ? S.cart.delete(e.id) : S.cart.add(e.id); S.problems.delete(e.id); persistCart(); renderGrid(); renderTray(); } },
        h('span', { class: 'box' }), h('span', { class: 'id' }, e.id),
        h('span', { class: 'grow' }, h('div', { style: 'font-weight:700' }, e.name), h('div', { class: 'meta' }, `${e.holder || ''} · out ${ago(e.out_at)}${e.due_date ? ` · due ${fmtDate(e.due_date)}` : ''}`)),
        late ? h('span', { class: 'badge late' }, 'OVERDUE') : null);
    };
    S.el.grid.replaceChildren(...(groups.size ? [...groups].map(([k, items]) => {
      const all = items.every((e) => S.cart.has(e.id));
      return h('div', { class: 'group' }, h('div', { class: 'ghead' }, h('h3', null, `${k} `, h('span', { class: 'muted' }, `(${items.length})`)),
        h('button', { class: 'link', onclick: () => { items.forEach((e) => (all ? S.cart.delete(e.id) : S.cart.add(e.id))); persistCart(); renderGrid(); renderTray(); } }, all ? 'Clear' : `Select all ${items.length}`)), ...items.map(row));
    }) : [h('div', { class: 'banner info' }, S.mine ? 'Nothing is signed out under that name. Tap “Everything signed out” to see all equipment that’s out.' : 'Nothing matches — no equipment is currently signed out.')]));
  }

  function renderTray() {
    if (!S.el.tray) return;
    const n = S.cart.size; const ids = [...S.cart];
    S.el.tray.replaceChildren(h('div', { class: 'in' },
      h('div', { class: 'count' }, n ? `${n} selected` : 'None selected'),
      h('div', { class: 'ids' }, n ? ids.join(' · ') : 'Tap equipment to add it'),
      n ? h('button', { class: 'btn ghost small', onclick: () => { S.cart.clear(); S.problems.clear(); persistCart(); renderGrid(); renderTray(); } }, 'Clear') : null,
      h('button', { class: `btn ${S.mode === 'out' ? '' : 'green'}`, disabled: n ? null : true, onclick: openReview }, S.mode === 'out' ? 'Review & sign out →' : 'Review & return →')));
  }

  /* ================= review sheet & submit ================= */
  function openReview() {
    const err = detailsError(); if (err) { showErr(err); return toast(err.msg, 'bad'); }
    if (!S.cart.size) return;
    S.sheet = true; S.sheetErr = null; renderSheet();
  }
  function closeSheet() { S.sheet = false; const s = document.getElementById('sheet'); if (s) s.remove(); }
  function buildPayload() {
    const p = S.mode === 'out' ? resolveProject() : { code: '', name: '', site: '' };
    const payload = {
      kind: S.mode, employee: S.d.employee.trim(), project_code: p.code, project_name: p.name, requester: S.d.requester, site: (S.mode === 'out' ? (S.d.site || p.site) : ''),
      location: S.d.location, due_date: S.mode === 'out' ? S.d.due : '', notes: S.notes, client_time: new Date().toISOString(),
      items: [...S.cart].map((id) => ({ id, condition: S.problems.has(id) ? 'issue' : 'ok' })),
    };
    const sig = JSON.stringify({ ...payload, client_time: 0 });
    if (!S.attempt || S.attempt.sig !== sig) S.attempt = { sig, key: uuid() };
    payload.idem_key = S.attempt.key; // same content → same key → a retry can never double-book
    return payload;
  }
  function renderSheet() {
    document.getElementById('sheet')?.remove();
    const out = S.mode === 'out'; const p = out ? resolveProject() : null; const n = S.cart.size;
    const anyProblem = [...S.cart].some((id) => S.problems.has(id));
    const kv = (k, v) => v ? [h('div', { class: 'k' }, k), h('div', null, v)] : [];
    const notes = h('textarea', { id: 'f-notes', placeholder: anyProblem ? 'What’s wrong with it? (required)' : 'Anything the office should know? (optional)', oninput: (e) => { S.notes = e.target.value; }, class: S.sheetErr && S.sheetErr.field === 'notes' ? 'invalid' : '' }, S.notes);
    const sheet = h('div', { class: 'scrim', id: 'sheet', onclick: (e) => { if (e.target.classList.contains('scrim')) closeSheet(); } },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Confirm' },
        h('h2', null, out ? `Sign out ${n} item${n > 1 ? 's' : ''}` : `Return ${n} item${n > 1 ? 's' : ''}`),
        h('div', { class: 'kv' }, ...kv('Who', S.d.employee), ...kv('Project', out ? (p.code ? `${p.code} — ${p.name}` : p.name) : ''), ...kv(out ? 'From' : 'Returning to', S.d.location), ...kv('Site', out ? (S.d.site || p.site) : ''), ...kv('Back by', out && S.d.due ? fmtDate(S.d.due) : out ? 'Not set' : '')),
        h('div', null, ...[...S.cart].map((id) => { const e = S.byId.get(id); return h('div', { class: 'li' }, h('span', { class: 'id' }, id), h('span', { class: 'grow' }, e ? e.name : ''),
          out ? null : h('label', { class: 'prob' }, h('input', { type: 'checkbox', checked: S.problems.has(id), onchange: (ev) => { ev.target.checked ? S.problems.add(id) : S.problems.delete(id); renderSheet(); } }), 'Problem'),
          h('button', { class: 'x', 'aria-label': `Remove ${id}`, onclick: () => { S.cart.delete(id); S.problems.delete(id); persistCart(); renderGrid(); renderTray(); S.cart.size ? renderSheet() : closeSheet(); } }, '✕')); })),
        h('div', { class: 'field', style: 'margin-top:12px' }, h('label', { class: 'f', for: 'f-notes' }, anyProblem ? 'Describe the problem' : 'Notes'), notes),
        S.sheetErr ? h('div', { class: 'banner bad' }, h('div', null, S.sheetErr.msg, ...(S.sheetErr.list || []).map((m) => h('div', { style: 'font-weight:500' }, `• ${m}`)))) : null,
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'btn ghost', onclick: closeSheet, disabled: S.busy ? true : null }, 'Back'),
          h('button', { class: `btn grow ${out ? '' : 'green'}`, onclick: submit, disabled: S.busy ? true : null }, S.busy ? 'Saving…' : out ? `Confirm sign-out (${n})` : `Confirm return (${n})`))));
    document.body.append(sheet);
  }
  async function submit() {
    if (S.busy) return;
    if (S.mode === 'in' && [...S.cart].some((id) => S.problems.has(id)) && S.notes.trim().length < 3) { S.sheetErr = { msg: 'Please describe the problem so maintenance knows what to look for.', field: 'notes' }; renderSheet(); return; }
    S.busy = true; S.sheetErr = null; renderSheet();
    const payload = buildPayload();
    try {
      const r = await api('/api/transactions', { method: 'POST', body: payload });
      success(payload, r.txn, r.undo_token, false);
    } catch (e) {
      if (e.offline) { S.queue.push(payload); LS.set('queue', S.queue); setNet(false); overlayQueue(); success(payload, { items: payload.items.map((i) => ({ id: i.id, name: (S.byId.get(i.id) || {}).name || '' })) }, null, true); }
      else if (e instanceof ApiError && e.status === 409 && e.body.conflicts) {
        const bad = e.body.conflicts.map((c) => c.id); bad.forEach((id) => { S.cart.delete(id); S.problems.delete(id); }); persistCart();
        S.sheetErr = { msg: 'Some items just changed, so they were removed. Nothing has been saved yet — check the rest and confirm again.', list: e.body.conflicts.map((c) => c.message) };
        S.busy = false; await load(); S.cart.size ? renderSheet() : (closeSheet(), toast(e.body.conflicts[0].message, 'bad')); return;
      } else { S.sheetErr = { msg: e.message || 'Could not save. Please try again.', field: e.body && e.body.field }; if (S.sheetErr.field && S.sheetErr.field !== 'notes') { S.busy = false; closeSheet(); showErr({ field: { employee: 'f-emp', project: 'f-proj', location: 'f-loc' }[S.sheetErr.field] || 'f-emp', msg: e.message }); return; } }
    }
    S.busy = false; if (S.sheet) renderSheet();
  }
  function success(payload, txn, undoToken, queued) {
    closeSheet(); S.busy = false;
    S.last = { mode: payload.kind, txn, undoToken, queued, at: Date.now(), n: payload.items.length };
    if (payload.kind === 'out' && payload.project_code) { const lbl = `${payload.project_code} — ${payload.project_name}`; LS.set('recentProjects', [lbl, ...LS.get('recentProjects', []).filter((x) => x !== lbl)].slice(0, 5)); }
    persistDetails(); S.cart.clear(); S.problems.clear(); S.notes = ''; S.attempt = null; persistCart();
    S.view = 'done'; render(); window.scrollTo(0, 0);
    if (!queued) load();
    if (KIOSK) { clearTimeout(S.kioskTimer); S.kioskTimer = setTimeout(goHome, 12000); }
  }

  /* ================= views ================= */
  function goHome() {
    clearTimeout(S.kioskTimer); closeSheet();
    if (KIOSK) { S.d = Object.assign(blankDetails(), { location: S.d.location }); }
    S.view = 'home'; S.mode = S.cart.size ? S.mode : null; render(); window.scrollTo(0, 0);
  }
  function render() {
    if (S.view !== 'flow') { S.el.tray?.remove(); S.el.tray = null; }
    if (!S.data) return;
    if (S.view === 'home') renderHome(); else if (S.view === 'flow') renderFlow(); else renderDone();
  }
  function renderHome() {
    const eq = S.data.equipment; const n = (s) => eq.filter((e) => e.status === s).length;
    const late = eq.filter((e) => e.status === 'out' && e.due_date && e.due_date < S.data.today).length;
    const mine = S.d.employee ? eq.filter((e) => e.status === 'out' && sameName(e.holder, S.d.employee)).length : 0;
    const bits = [];
    if (S.queue.length) bits.push(h('div', { class: 'banner warn' }, `⏳ ${S.queue.length} transaction${S.queue.length > 1 ? 's' : ''} saved on this device — uploading when you’re back online.`, h('button', { class: 'btn small ghost', onclick: flushQueue }, 'Retry now')));
    if (S.failed.length) bits.push(h('div', { class: 'banner bad' }, h('div', { class: 'grow' }, `${S.failed.length} saved transaction${S.failed.length > 1 ? 's' : ''} couldn’t be applied after reconnecting. Please tell an administrator.`, ...S.failed.slice(0, 3).map((f) => h('div', { style: 'font-weight:500;font-size:.9rem' }, `• ${f.kind === 'out' ? 'Sign-out' : 'Return'} ${f.items.slice(0, 5).join(', ')}: ${f.why}`))), h('button', { class: 'btn small ghost', onclick: () => { S.failed = []; LS.set('failed', []); renderHome(); } }, 'Dismiss')));
    if (S.cart.size) bits.push(h('div', { class: 'banner info' }, h('span', { class: 'grow' }, `You have ${S.cart.size} item${S.cart.size > 1 ? 's' : ''} selected for ${S.mode === 'out' ? 'sign-out' : 'return'}.`), h('button', { class: 'btn small', onclick: () => startMode(S.mode) }, 'Continue')));
    else if (mine) bits.push(h('div', { class: 'banner info' }, h('span', { class: 'grow' }, `${S.d.employee.split(' ')[0]}, you have ${mine} item${mine > 1 ? 's' : ''} signed out.`), h('button', { class: 'btn small green', onclick: () => startMode('in', { mine: true }) }, 'Return them')));
    app.replaceChildren(...bits,
      h('div', { class: 'hero' },
        h('button', { class: 'big out', onclick: () => startMode('out') }, h('span', { class: 'ic' }, '📤'), h('span', null, h('div', { class: 't' }, 'Sign out'), h('div', { class: 's' }, 'Taking equipment to a site'))),
        h('button', { class: 'big in', onclick: () => startMode('in', { mine: true }) }, h('span', { class: 'ic' }, '📥'), h('span', null, h('div', { class: 't' }, 'Return'), h('div', { class: 's' }, 'Bringing equipment back')))),
      h('div', { class: 'pills' }, h('span', { class: 'pill ok' }, h('b', null, n('available')), ' available'), h('span', { class: 'pill out' }, h('b', null, n('out')), ' signed out'),
        late ? h('span', { class: 'pill warn' }, h('b', null, late), ' overdue') : null, n('maintenance') ? h('span', { class: 'pill' }, h('b', null, n('maintenance')), ' in repair') : null),
      h('button', { class: 'btn ghost', style: 'width:100%', onclick: openScanner }, '📷  Scan a QR label to start'),
      h('p', { class: 'muted', style: 'text-align:center;margin-top:18px;font-size:.9rem' }, 'No login needed. Tip: scanning a label with your phone’s camera also adds that item.'));
  }
  function renderFlow() {
    S.el.details = h('div'); S.el.picker = h('div');
    if (!S.el.tray) { S.el.tray = h('div', { class: 'tray' }); document.body.append(S.el.tray); }
    app.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'btn ghost small', onclick: goHome }, '← Back'), h('h1', { style: 'font-size:1.45rem' }, S.mode === 'out' ? 'Sign out equipment' : 'Return equipment')),
      S.el.details, S.el.picker);
    renderDetails(); renderPicker(); renderTray();
  }
  function renderDone() {
    const L = S.last; const out = L.mode === 'out'; let armed = false; let timer;
    const undo = h('button', { class: 'btn ghost', onclick: async () => {
      if (!armed) { armed = true; undo.textContent = 'Tap again to undo'; undo.className = 'btn red'; timer = setTimeout(() => { armed = false; undo.textContent = 'Undo this'; undo.className = 'btn ghost'; }, 4000); return; }
      clearTimeout(timer); undo.disabled = true;
      try { await api('/api/undo', { method: 'POST', body: { public_id: L.txn.public_id, undo_token: L.undoToken } }); toast('Undone — everything is back as it was', 'ok'); await load(); goHome(); }
      catch (e) { undo.disabled = false; toast(e.message, 'bad'); }
    } }, 'Undo this');
    app.replaceChildren(h('div', { class: `card done ${L.queued ? 'queued' : ''}` },
      h('div', { class: 'check' }, L.queued ? '⏳' : '✓'),
      h('h1', null, L.queued ? 'Saved on this device' : out ? `Signed out ${L.n} item${L.n > 1 ? 's' : ''}` : `Returned ${L.n} item${L.n > 1 ? 's' : ''}`),
      h('p', { class: 'muted' }, L.queued ? 'No signal right now. It will upload automatically when you’re back online — nothing more to do.' : 'Recorded. You’re all set.'),
      h('div', { class: 'chips', style: 'justify-content:center;margin:14px 0 20px' }, ...L.txn.items.slice(0, 24).map((i) => h('span', { class: 'chip' }, i.id)), L.txn.items.length > 24 ? h('span', { class: 'chip' }, `+${L.txn.items.length - 24}`) : null),
      h('div', { class: 'row', style: 'justify-content:center' },
        h('button', { class: `btn ${out ? '' : 'green'}`, onclick: goHome }, 'Done'),
        h('button', { class: 'btn ghost', onclick: () => startMode(L.mode) }, out ? 'Sign out more' : 'Return more'),
        L.undoToken && !L.queued ? undo : null),
      KIOSK ? h('p', { class: 'muted', style: 'margin-top:16px' }, 'Returning to the start screen in a few seconds…') : null));
  }

  /* ================= QR scanner ================= */
  const loadScript = (src) => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = h('script', { src }); s.onload = res; s.onerror = rej; document.head.append(s); });
  async function openScanner() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('In-app scanning needs a secure (HTTPS) connection. You can scan the label with your phone’s normal camera app instead.', 'bad');
    const video = h('video', { playsinline: true, muted: true, autoplay: true });
    const msg = h('div', { class: 'msg' }, 'Point the camera at a QR label…');
    let stopped = false; let stream; let last = ''; let lastAt = 0;
    const close = () => { stopped = true; if (stream) stream.getTracks().forEach((t) => t.stop()); ov.remove(); };
    const ov = h('div', { class: 'scan' }, video, h('div', { class: 'frame' }), h('div', { class: 'bar' }, msg, h('button', { class: 'btn', onclick: close }, 'Done')));
    document.body.append(ov);
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false }); }
    catch { close(); return toast('Camera access was blocked. Allow it in your browser settings, or scan with your phone’s camera app.', 'bad'); }
    video.srcObject = stream; try { await video.play(); } catch { /* autoplay policy */ }
    const native = 'BarcodeDetector' in window; const det = native ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    if (!native) { try { await loadScript('/vendor/jsQR.js'); } catch { close(); return toast('Could not load the scanner.', 'bad'); } }
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (stopped) return;
      try {
        let raw = null;
        if (video.readyState >= 2) {
          if (det) { const r = await det.detect(video); raw = r[0] && r[0].rawValue; }
          else { const sc = Math.min(1, 640 / video.videoWidth); canvas.width = video.videoWidth * sc; canvas.height = video.videoHeight * sc; ctx.drawImage(video, 0, 0, canvas.width, canvas.height); const img = ctx.getImageData(0, 0, canvas.width, canvas.height); const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }); raw = r && r.data; }
        }
        const m = raw && raw.match(ID_IN_TEXT);
        if (m) { const id = m[1].toUpperCase(); const now = Date.now(); if (id !== last || now - lastAt > 2500) { last = id; lastAt = now; const ok = addById(id); msg.textContent = ok ? `✓ ${id} added — keep scanning or tap Done` : `${id} — not added`; if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]); } }
      } catch { /* a bad frame is fine */ }
      setTimeout(() => requestAnimationFrame(tick), 180);
    };
    tick();
  }

  /* ================= boot ================= */
  function deepLink() {
    const m = location.pathname.match(/^\/e\/([A-Za-z0-9-]+)/) || (qs.get('e') ? [null, qs.get('e')] : null);
    if (!m) return;
    history.replaceState(null, '', '/');
    const id = m[1].toUpperCase(); const e = S.byId.get(id);
    if (!e) return toast(`${id} isn't in the inventory`, 'bad');
    addById(id);
  }
  let idle; const bumpIdle = () => { if (!KIOSK) return; clearTimeout(idle); idle = setTimeout(() => { if (S.view !== 'home') { S.cart.clear(); persistCart(); goHome(); } }, 180000); };
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sheet && !S.busy) closeSheet(); });
  window.addEventListener('online', () => { setNet(true); flushQueue(); });
  window.addEventListener('offline', () => setNet(false));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { load(); flushQueue(); } });
  setInterval(() => { if (document.visibilityState === 'visible' && !S.busy && !S.sheet) { load(); flushQueue(); } }, 20000);

  (async function boot() {
    await load(); if (!S.data) return;
    const saved = LS.get('cart', null);
    if (saved && saved.ids && saved.ids.length) { S.mode = saved.mode; saved.ids.forEach((id) => { const e = S.byId.get(id); if (e && (saved.mode === 'out' ? e.status === 'available' : e.status === 'out')) S.cart.add(id); }); if (!S.cart.size) S.mode = null; }
    render(); setNet(navigator.onLine); deepLink(); flushQueue();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
  })();
})();
