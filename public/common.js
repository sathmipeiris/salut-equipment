'use strict';
// Shared helpers for the staff app and the admin console. No framework, no build step.
// All DOM is built with h() + textContent, never innerHTML, so user-entered text can't inject markup.
(function () {
  // The DOM turns a null/false argument into the literal text "null"/"false". Our render code uses `cond ? el : null`
  // freely, so make replaceChildren skip empty values instead of printing them.
  const nativeReplace = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...kids) { return nativeReplace.apply(this, kids.filter((k) => k != null && k !== false)); };

  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    return el;
  };

  class ApiError extends Error { constructor(status, body) { super(body && body.error ? body.error : `Error ${status}`); this.status = status; this.body = body || {}; } }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
    } catch (e) { const err = new Error('offline'); err.offline = true; throw err; }
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  }

  // crypto.randomUUID needs HTTPS; kiosks on a plain-HTTP LAN still need unique ids.
  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  };

  const fmtDate = (d) => { if (!d) return ''; const [y, m, day] = d.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const ago = (iso) => {
    if (!iso) return ''; const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    const d = Math.round(s / 86400); return d === 1 ? 'yesterday' : `${d} days ago`;
  };
  const todayStr = () => new Date().toLocaleDateString('en-CA');
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

  let toastTimer;
  function toast(msg, kind) {
    let t = document.getElementById('toast');
    if (!t) { t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
    t.textContent = msg; t.className = `show ${kind || ''}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3200);
  }

  window.U = { h, api, ApiError, uuid, fmtDate, fmtDateTime, ago, todayStr, addDays, toast };
})();
