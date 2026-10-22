'use strict';
(function () {
  const { h, api, ApiError, fmtDate, fmtDateTime, ago, toast } = U;
  const root = document.getElementById('root');
  const TABS = [['overview', 'Overview'], ['inventory', 'Inventory'], ['activity', 'Activity'], ['labels', 'QR labels'], ['lists', 'People & projects'], ['settings', 'Settings']];
  const S = { actor: '', tab: 'overview' };
  let content;

  const badge = (status) => h('span', { class: `badge ${{ available: 'ok', out: 'out', maintenance: 'warn', retired: '' }[status] || ''}` }, { available: 'Available', out: 'Signed out', maintenance: 'Maintenance', retired: 'Retired' }[status] || status);
  const fail = (e) => toast(e instanceof ApiError || e.message ? e.message : 'Something went wrong', 'bad');
  const field = (lab, el) => h('div', { class: 'field' }, h('label', { class: 'f' }, lab), el);

  function modal(title, body, actions) {
    const m = h('div', { class: 'scrim', onclick: (e) => { if (e.target === m) m.remove(); } },
      h('div', { class: 'sheet modal-sheet', role: 'dialog', 'aria-modal': 'true' }, h('h2', null, title), body, h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn ghost', onclick: () => m.remove() }, 'Cancel'), ...actions(() => m.remove()))));
    document.body.append(m); const f = m.querySelector('input,select,textarea'); if (f) f.focus(); return m;
  }

  /* ---------- login / shell ---------- */
  function loginView() {
    const pin = h('input', { type: 'password', id: 'pin', autocomplete: 'current-password', placeholder: 'Admin PIN' });
    const name = h('input', { type: 'text', placeholder: 'Your name (for the audit trail)', autocomplete: 'name' });
    const err = h('div', { class: 'err', hidden: true });
    const go = async () => { try { const r = await api('/api/admin/login', { method: 'POST', body: { pin: pin.value, name: name.value } }); S.actor = r.actor; shell(); } catch (e) { err.hidden = false; err.textContent = e.message; pin.select(); } };
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }); name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    root.replaceChildren(h('header', { class: 'top' }, h('div', { class: 'brand' }, 'Equipment Admin', h('small', null, 'Authorized staff only')), h('a', { href: '/' }, '← Staff page')),
      h('div', { class: 'card login' }, h('h2', { style: 'margin-bottom:14px' }, 'Administrator sign-in'), field('PIN', pin), field('Name', name), err, h('button', { class: 'btn', style: 'width:100%', onclick: go }, 'Sign in')));
    pin.focus();
  }
  function shell() {
    content = h('div', { class: 'a-wrap' });
    root.replaceChildren(
      h('header', { class: 'top' }, h('div', { class: 'brand' }, 'Equipment Admin', h('small', null, `Signed in as ${S.actor}`)), h('a', { href: '/' }, 'Staff page'), h('button', { onclick: async () => { await api('/api/admin/logout', { method: 'POST', body: {} }); loginView(); } }, 'Sign out')),
      h('nav', { class: 'tabs no-print', id: 'tabs' }), content);
    show(location.hash.slice(1) || 'overview');
  }
  function show(tab) {
    if (!TABS.some(([k]) => k === tab)) tab = 'overview'; S.tab = tab; location.hash = tab;
    document.getElementById('tabs').replaceChildren(...TABS.map(([k, l]) => h('button', { class: `tab ${k === tab ? 'on' : ''}`, onclick: () => show(k) }, l)));
    content.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    ({ overview, inventory, activity, labels, lists, settings }[tab])().catch((e) => { if (e.status === 401) loginView(); else { content.replaceChildren(h('div', { class: 'banner bad' }, e.message)); } });
  }

  /* ---------- overview ---------- */
  async function overview() {
    const o = await api('/api/admin/overview');
    const kpi = (cls, n, l) => h('div', { class: `kpi ${cls}` }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
    const loc = (e) => `${e.project_code ? `${e.project_code} · ` : ''}${e.project_name || ''}`;
    const tbl = (cols, rows) => h('div', { class: 'scroll' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ...cols.map((c) => h('th', null, c)))), h('tbody', null, ...rows)));
    const attn = o.attention.map((e) => h('tr', null, h('td', null, h('b', null, e.id)), h('td', null, e.name), h('td', null, e.issue || '—'), h('td', null, h('button', { class: 'btn xs', onclick: () => statusModal(e, 'available') }, 'Mark repaired'))));
    content.replaceChildren(
      h('div', { class: 'kpis' }, kpi('', o.totals.total, 'Total equipment'), kpi('ok', o.totals.available, 'Available'), kpi('out', o.totals.out, 'Signed out'), kpi('warn', o.totals.maintenance, 'In maintenance')),
      o.selfAdded ? h('div', { class: 'banner info' }, `${o.selfAdded} name${o.selfAdded > 1 ? 's were' : ' was'} typed in by staff and not yet reviewed.`, h('button', { class: 'btn xs', onclick: () => show('lists') }, 'Review names')) : null,
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h2', null, `Overdue (${o.overdue.length})`), o.overdue.length ? tbl(['ID', 'Item', 'Holder', 'Project', 'Due'], o.overdue.map((e) => h('tr', null, h('td', null, h('b', null, e.id)), h('td', null, e.name), h('td', null, e.holder), h('td', null, loc(e)), h('td', null, h('span', { class: 'badge late' }, fmtDate(e.due_date)))))) : h('p', { class: 'muted' }, 'Nothing is overdue. 🎉')),
        h('div', { class: 'card' }, h('h2', null, `Needs attention (${o.attention.length})`), o.attention.length ? tbl(['ID', 'Item', 'Reported problem', ''], attn) : h('p', { class: 'muted' }, 'No equipment is waiting for repair.'))),
      h('div', { class: 'card' }, h('h2', null, 'By category'), tbl(['Category', 'Total', 'Available', 'Out', 'Maint.', ''], o.byCategory.map((c) => h('tr', null, h('td', null, c.name), h('td', null, c.total), h('td', null, c.available || 0), h('td', null, c.out || 0), h('td', null, c.maintenance || 0),
        h('td', { style: 'width:34%' }, h('div', { class: 'bar' }, h('i', { class: 'b-out', style: `width:${(100 * (c.out || 0)) / (c.total || 1)}%` }), h('i', { class: 'b-m', style: `width:${(100 * (c.maintenance || 0)) / (c.total || 1)}%` }), h('i', { class: 'b-a', style: `width:${(100 * (c.available || 0)) / (c.total || 1)}%` })))))),
        h('p', { class: 'muted', style: 'margin:10px 0 0;font-size:.85rem' }, 'Bar: blue = signed out · amber = maintenance · green = available')),
      h('div', { class: 'card' }, h('h2', null, `Currently signed out (${o.out.length})`), o.out.length ? tbl(['ID', 'Item', 'Holder', 'Project / site', 'Since', 'Due'], o.out.map((e) => h('tr', null, h('td', null, h('b', null, e.id)), h('td', null, e.name), h('td', null, e.holder), h('td', null, loc(e), e.site ? h('div', { class: 'muted' }, e.site) : null), h('td', null, ago(e.out_at)), h('td', null, e.due_date ? h('span', { class: `badge ${e.due_date < o.today ? 'late' : ''}` }, fmtDate(e.due_date)) : '—')))) : h('p', { class: 'muted' }, 'Everything is in.')));
  }

  /* ---------- inventory ---------- */
  async function inventory() {
    const d = await api('/api/admin/equipment');
    const st = { q: '', cat: '', status: '' }; const body = h('tbody'); const count = h('span', { class: 'muted' });
    const draw = () => {
      const q = st.q.toLowerCase();
      const rows = d.equipment.filter((e) => (!st.cat || e.category_id === +st.cat) && (!st.status || e.status === st.status) && (!q || `${e.id} ${e.name} ${e.serial} ${e.holder || ''} ${e.project_name || ''}`.toLowerCase().includes(q)));
      count.textContent = `${rows.length} of ${d.equipment.length}`;
      body.replaceChildren(...rows.map((e) => h('tr', null, h('td', null, h('b', null, e.id)), h('td', null, e.name, e.serial ? h('div', { class: 'muted' }, e.serial) : null), h('td', null, e.category), h('td', null, badge(e.status), e.issue ? h('div', { class: 'muted' }, e.issue) : null),
        h('td', null, e.holder ? `${e.holder}` : '', e.project_name ? h('div', { class: 'muted' }, e.project_name) : null), h('td', null, e.location || ''), h('td', null, e.due_date ? fmtDate(e.due_date) : ''),
        h('td', { style: 'white-space:nowrap' }, h('button', { class: 'btn xs ghost', onclick: () => editModal(e) }, 'Edit'), ' ', e.status !== 'retired' ? h('button', { class: 'btn xs ghost', onclick: () => statusModal(e) }, 'Set status') : null))));
    };
    const inp = (ph, key) => h('input', { type: 'search', placeholder: ph, class: 'grow', oninput: (e) => { st[key] = e.target.value; draw(); } });
    const cat = h('select', { onchange: (e) => { st.cat = e.target.value; draw(); } }, h('option', { value: '' }, 'All categories'), ...d.categories.map((c) => h('option', { value: c.id }, c.name)));
    const sts = h('select', { onchange: (e) => { st.status = e.target.value; draw(); } }, h('option', { value: '' }, 'Any status'), ...['available', 'out', 'maintenance', 'retired'].map((s) => h('option', { value: s }, s)));
    content.replaceChildren(
      h('div', { class: 'toolbar' }, inp('Search ID, name, serial, holder, project…', 'q'), cat, sts, count, h('a', { class: 'btn small ghost', href: '#', onclick: (e) => { e.preventDefault(); addModal(d); } , style: 'text-decoration:none;display:inline-flex;align-items:center' }, '＋ Add equipment')),
      h('div', { class: 'card scroll' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ...['ID', 'Item', 'Category', 'Status', 'Held by / project', 'Location', 'Due', ''].map((c) => h('th', null, c)))), body)));
    draw();
  }
  function addModal(d) {
    const cat = h('select', null, ...d.categories.map((c) => h('option', { value: c.id }, `${c.name} (${c.prefix})`)));
    const name = h('input', { type: 'text', placeholder: 'e.g. HEPA Air Scrubber 2000 CFM' }); const serial = h('input', { type: 'text', placeholder: 'Optional (single item only)' });
    const count = h('input', { type: 'text', value: '1', inputmode: 'numeric' }); const loc = h('select', null, h('option', { value: '' }, '—'), ...d.locations.filter((l) => l.active).map((l) => h('option', { value: l.name }, l.name)));
    modal('Add equipment', h('div', null, field('Category', cat), field('Name / model', name), h('div', { class: 'grid2' }, field('How many? (bulk add, IDs auto-numbered)', count), field('Stored at', loc)), field('Serial number', serial), h('p', { class: 'muted' }, 'After adding, print QR labels from the “QR labels” tab.')),
      (close) => [h('button', { class: 'btn grow', onclick: async () => { try { const r = await api('/api/admin/equipment', { method: 'POST', body: { category_id: cat.value, name: name.value, count: count.value, serial: +count.value > 1 ? '' : serial.value, location: loc.value } }); toast(`Added ${r.ids[0]}${r.ids.length > 1 ? ` – ${r.ids[r.ids.length - 1]}` : ''}`, 'ok'); close(); show('inventory'); } catch (e) { fail(e); } } }, 'Add')]);
  }
  function editModal(e) {
    const name = h('input', { type: 'text', value: e.name }); const serial = h('input', { type: 'text', value: e.serial }); const notes = h('textarea', null, e.notes);
    modal(`Edit ${e.id}`, h('div', null, field('Name / model', name), field('Serial number', serial), field('Notes', notes)),
      (close) => [h('button', { class: 'btn grow', onclick: async () => { try { await api(`/api/admin/equipment/${e.id}`, { method: 'PUT', body: { name: name.value, serial: serial.value, notes: notes.value } }); close(); show('inventory'); } catch (x) { fail(x); } } }, 'Save')]);
  }
  async function statusModal(e, preset) {
    const locs = (await api('/api/admin/locations')).rows.filter((l) => l.active);
    const status = h('select', null, ...['available', 'maintenance', 'retired'].filter((s) => s !== e.status).map((s) => h('option', { value: s, selected: s === preset }, { available: 'Available (in stock)', maintenance: 'In maintenance', retired: 'Retired (remove from use)' }[s])));
    const reason = h('input', { type: 'text', placeholder: preset === 'available' ? 'e.g. Repaired — new drain pump fitted' : 'Why? (kept in the audit log)' });
    const loc = h('select', null, h('option', { value: '' }, 'Keep current'), ...locs.map((l) => h('option', { value: l.name }, l.name)));
    modal(`${e.id} — change status`, h('div', null, e.status === 'out' ? h('div', { class: 'banner warn' }, `Currently signed out to ${e.holder}. This records a manual force-return.`) : null, field('New status', status), field('Reason (required)', reason), field('Location', loc)),
      (close) => [h('button', { class: 'btn grow', onclick: async () => { try { await api(`/api/admin/equipment/${e.id}/status`, { method: 'POST', body: { status: status.value, reason: reason.value, location: loc.value } }); toast('Updated', 'ok'); close(); show(S.tab); } catch (x) { fail(x); } } }, 'Save correction')]);
  }

  /* ---------- activity ---------- */
  async function activity() {
    let q = ''; const body = h('tbody'); let timer;
    const draw = async () => {
      const { transactions } = await api(`/api/admin/transactions?limit=200&q=${encodeURIComponent(q)}`);
      body.replaceChildren(...transactions.map((t) => h('tr', { class: t.voided_at ? 'void' : '' },
        h('td', { style: 'white-space:nowrap' }, fmtDateTime(t.created_at)), h('td', null, h('span', { class: `badge ${{ out: 'out', in: 'ok', adjust: 'warn' }[t.kind]}` }, { out: 'Sign-out', in: 'Return', adjust: 'Correction' }[t.kind])),
        h('td', null, t.employee), h('td', null, [t.project_code, t.project_name].filter(Boolean).join(' · ')), h('td', null, h('span', { class: 'mono' }, t.n > 8 ? `${t.items.split(', ').slice(0, 8).join(', ')} … (+${t.n - 8})` : t.items)),
        h('td', null, t.location || ''), h('td', null, t.notes || ''),
        h('td', null, t.voided_at ? h('span', { class: 'badge' }, `Reversed by ${t.voided_by}${t.void_reason ? `: ${t.void_reason}` : ''}`) : h('button', { class: 'btn xs ghost', onclick: () => voidModal(t, draw) }, 'Reverse')))));
    };
    content.replaceChildren(h('div', { class: 'toolbar' }, h('input', { type: 'search', class: 'grow', placeholder: 'Search person, project, item ID, location…', oninput: (e) => { q = e.target.value; clearTimeout(timer); timer = setTimeout(draw, 250); } }),
      h('a', { class: 'btn small ghost', href: '/api/feed/transactions.csv', style: 'text-decoration:none;display:inline-flex;align-items:center' }, '⬇ CSV')),
      h('div', { class: 'card scroll' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ...['When', 'Type', 'Who', 'Project', 'Items', 'Location', 'Notes', ''].map((c) => h('th', null, c)))), body)));
    await draw();
  }
  function voidModal(t, done) {
    const reason = h('input', { type: 'text', placeholder: 'e.g. Wrong item scanned / duplicate entry' });
    modal(`Reverse transaction #${t.id}?`, h('div', null, h('p', null, `${t.kind === 'out' ? 'Sign-out' : t.kind === 'in' ? 'Return' : 'Correction'} by ${t.employee} — ${t.n} item${t.n > 1 ? 's' : ''}. Equipment goes back to exactly how it was before. The original entry stays in the record, marked as reversed.`), field('Reason (required)', reason)),
      (close) => [h('button', { class: 'btn red grow', onclick: async () => { try { await api(`/api/admin/transactions/${t.id}/void`, { method: 'POST', body: { reason: reason.value } }); toast('Reversed', 'ok'); close(); done(); } catch (e) { fail(e); } } }, 'Reverse it')]);
  }

  /* ---------- QR labels ---------- */
  async function labels() {
    const d = await api('/api/admin/equipment'); const base = h('input', { type: 'text', value: localStorage.getItem('salut.qrbase') || location.origin });
    const catSel = h('select', null, h('option', { value: '' }, 'All categories'), ...d.categories.map((c) => h('option', { value: c.id }, c.name)));
    const size = h('select', null, h('option', { value: '' }, 'Standard (3 across)'), h('option', { value: 'two' }, 'Large (2 across)'));
    const sheet = h('div', { class: 'labels' });
    const draw = () => {
      try { localStorage.setItem('salut.qrbase', base.value); } catch { /* ignore */ }
      const b = base.value.replace(/\/+$/, ''); sheet.className = `labels ${size.value}`;
      const rows = d.equipment.filter((e) => e.status !== 'retired' && (!catSel.value || e.category_id === +catSel.value));
      sheet.replaceChildren(...rows.map((e) => {
        const qr = qrcode(0, 'M'); qr.addData(`${b}/e/${e.id}`); qr.make();
        const svg = new DOMParser().parseFromString(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), 'image/svg+xml').documentElement;
        return h('div', { class: 'label' }, document.importNode(svg, true), h('div', null, h('div', { class: 'lid' }, e.id), h('div', { class: 'lnm' }, e.name), h('div', { class: 'lsc' }, 'Scan to sign out / return')));
      }));
      count.textContent = `${rows.length} labels`;
    };
    const count = h('span', { class: 'muted' });
    [base, catSel, size].forEach((el) => el.addEventListener('change', draw));
    content.replaceChildren(h('div', { class: 'card no-print' }, h('h2', null, 'Print QR labels'), h('p', { class: 'muted' }, 'Each QR code opens the sign-out page with that item pre-selected — it works with any phone’s built-in camera, no app needed. Use your final website address below before printing, so the labels keep working.'),
      h('div', { class: 'grid3' }, field('Website address in the QR code', base), field('Category', catSel), field('Size', size)), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print'), count)),
      h('div', { class: 'card print-card' }, sheet));
    draw();
  }

  /* ---------- lists ---------- */
  const LISTS = {
    employees: { title: 'People', cols: [['name', 'Name']], toggle: true, fields: [['name', 'Full name', 'text']], extra: (r) => (r.self_added ? h('span', { class: 'badge warn' }, 'typed in by staff') : null) },
    projects: { title: 'Projects', cols: [['code', 'Code'], ['name', 'Name'], ['client', 'Client'], ['site', 'Site']], toggle: true, fields: [['code', 'Project number', 'text'], ['name', 'Project name', 'text'], ['client', 'Client / requester', 'text'], ['site', 'Site address', 'text']] },
    locations: { title: 'Locations', cols: [['name', 'Name'], ['kind', 'Type'], ['sort', 'Order']], toggle: true, fields: [['name', 'Name', 'text'], ['kind', 'Type (warehouse / site / vehicle / other)', 'text'], ['sort', 'Order', 'text']] },
    categories: { title: 'Categories', cols: [['name', 'Name'], ['prefix', 'ID prefix'], ['sort', 'Order']], toggle: false, fields: [['name', 'Name', 'text'], ['prefix', 'ID prefix (1–4 letters, cannot change later)', 'text'], ['sort', 'Order', 'text']], lockCreateOnly: ['prefix'] },
  };
  async function lists() {
    let cur = sessionStorage.getItem('salut.list') || 'employees'; const wrap = h('div');
    const draw = async () => {
      sessionStorage.setItem('salut.list', cur); const L = LISTS[cur]; const { rows } = await api(`/api/admin/${cur}`);
      wrap.replaceChildren(
        h('div', { class: 'toolbar' }, ...Object.entries(LISTS).map(([k, v]) => h('button', { class: `chip ${k === cur ? 'on' : ''}`, onclick: () => { cur = k; draw(); } }, v.title)), h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => formModal(null) }, '＋ Add')),
        h('div', { class: 'card scroll' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ...L.cols.map(([, l]) => h('th', null, l)), L.toggle ? h('th', null, 'Status') : null, h('th', null, ''))),
          h('tbody', null, ...rows.map((r) => h('tr', { style: L.toggle && !r.active ? 'opacity:.55' : '' }, ...L.cols.map(([k]) => h('td', null, r[k], k === 'name' && L.extra ? [' ', L.extra(r)] : null)),
            L.toggle ? h('td', null, h('span', { class: `badge ${r.active ? 'ok' : ''}` }, r.active ? 'Active' : 'Hidden')) : null,
            h('td', { style: 'white-space:nowrap' }, h('button', { class: 'btn xs ghost', onclick: () => formModal(r) }, 'Edit'), ' ', L.toggle ? h('button', { class: 'btn xs ghost', onclick: async () => { try { await api(`/api/admin/${cur}/${r.id}`, { method: 'PUT', body: { active: !r.active } }); draw(); } catch (e) { fail(e); } } }, r.active ? 'Hide' : 'Show') : null)))))),
        cur === 'employees' ? h('p', { class: 'muted' }, 'Names that staff type in themselves are added automatically. Hide duplicates or typos here — past records keep the name they were saved with.') : null);
    };
    function formModal(row) {
      const L = LISTS[cur]; const inputs = L.fields.map(([k, lab]) => [k, h('input', { type: 'text', value: row ? row[k] : '', disabled: row && L.lockCreateOnly && L.lockCreateOnly.includes(k) ? true : null })]);
      modal(row ? `Edit ${L.title.toLowerCase()}` : `Add to ${L.title.toLowerCase()}`, h('div', null, ...inputs.map(([k, el], i) => field(L.fields[i][1], el))),
        (close) => [h('button', { class: 'btn grow', onclick: async () => { const body = Object.fromEntries(inputs.map(([k, el]) => [k, el.value])); try { await api(row ? `/api/admin/${cur}/${row.id}` : `/api/admin/${cur}`, { method: row ? 'PUT' : 'POST', body: row ? body : { ...body, active: true } }); close(); draw(); } catch (e) { fail(e); } } }, 'Save')]);
    }
    content.replaceChildren(wrap); await draw();
  }

  /* ---------- settings ---------- */
  async function settings() {
    const { feed_token: token } = await api('/api/admin/settings'); const { audit } = await api('/api/admin/audit'); const o = location.origin;
    const feeds = [['Equipment status (CSV) — for Excel / Power BI', `${o}/api/feed/equipment.csv?token=${token}`], ['Equipment status (JSON)', `${o}/api/feed/equipment.json?token=${token}`], ['Transactions (CSV, latest 500)', `${o}/api/feed/transactions.csv?token=${token}`]];
    const cur = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Current PIN' }); const nxt = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New PIN (6+ characters)' });
    content.replaceChildren(
      h('div', { class: 'card' }, h('h2', null, 'Dashboard connection'), h('p', { class: 'muted' }, 'Read-only links for an equipment-status dashboard. In Excel or Power BI use Get Data → From Web and paste a link; set the refresh schedule there. Anyone with the link can read equipment status, so treat it like a password.'),
        ...feeds.map(([l, u]) => h('div', null, h('label', { class: 'f' }, l), h('div', { class: 'feed' }, h('code', { class: 'mono' }, u), h('button', { class: 'btn xs ghost', onclick: () => { navigator.clipboard?.writeText(u).then(() => toast('Link copied', 'ok'), () => toast('Select and copy the link manually', 'bad')); } }, 'Copy')))),
        h('button', { class: 'btn small ghost', onclick: async () => { if (!confirm('Create a new link? Existing dashboard connections will stop working until updated.')) return; await api('/api/admin/settings/rotate-feed-token', { method: 'POST', body: {} }); settings(); } }, 'Make a new link')),
      h('div', { class: 'card' }, h('h2', null, 'Change admin PIN'), h('div', { class: 'grid2' }, field('Current', cur), field('New', nxt)),
        h('button', { class: 'btn small', onclick: async () => { try { await api('/api/admin/settings/pin', { method: 'POST', body: { current: cur.value, next: nxt.value } }); toast('PIN changed. Other sessions were signed out.', 'ok'); cur.value = nxt.value = ''; } catch (e) { fail(e); } } }, 'Change PIN')),
      h('div', { class: 'card scroll' }, h('h2', null, 'Audit log (latest 200)'), h('table', { class: 't' }, h('thead', null, h('tr', null, ...['When', 'Who', 'Action', 'Detail'].map((c) => h('th', null, c)))), h('tbody', null, ...audit.map((a) => h('tr', null, h('td', { style: 'white-space:nowrap' }, fmtDateTime(a.at)), h('td', null, a.actor), h('td', null, a.action), h('td', null, a.detail || '')))))));
  }

  /* ---------- boot ---------- */
  window.addEventListener('hashchange', () => { if (content && location.hash.slice(1) !== S.tab) show(location.hash.slice(1)); });
  api('/api/admin/me').then((m) => { S.actor = m.actor; shell(); }).catch(loginView);
})();
