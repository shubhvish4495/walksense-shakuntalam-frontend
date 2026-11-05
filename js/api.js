// WalkSense API client. Shared by admin.html and the delivery-agent pages.
// Endpoints are described in backend/openapi.yaml.
(() => {
  // Production API host. The pages are on Netlify (HTTPS), so this must be HTTPS too.
  const DEFAULT_API = 'https://walksense.backend.splitriz.com';
  const KEY = 'walksenseApi';
  const local = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  // Resolution order: ?api= (remembered), saved override, DEFAULT_API, localhost dev server.
  function base() {
    try {
      const q = new URLSearchParams(location.search).get('api');
      if (q) localStorage.setItem(KEY, q.replace(/\/+$/, ''));
      const s = localStorage.getItem(KEY);
      if (s) return s;
    } catch (_) {}
    return DEFAULT_API || (local ? 'http://localhost:8080' : '');
  }
  function setBase(url) {
    url = String(url || '').trim().replace(/\/+$/, '');
    try { if (url) localStorage.setItem(KEY, url); else localStorage.removeItem(KEY); } catch (_) {}
    return base();
  }

  async function req(method, path, body) {
    const b = base();
    if (!b) throw new Error('No API URL set.');
    // Browsers block an HTTPS page from calling a plain-HTTP API (mixed content), without telling the page why.
    if (location.protocol === 'https:' && b.startsWith('http:')) throw new Error(`This page is HTTPS, so the API must be too (got ${b}).`);
    let res;
    try {
      res = await fetch(b + path, {
        method, cache: 'no-store',
        headers: body === undefined ? {} : {'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (_) { throw new Error(`Can't reach the API at ${b}.`); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || text.trim() || `HTTP ${res.status}`);
    return data;
  }

  // Route steps on the wire are ["s", n] / ["t", "L"|"R"]; in the pages they are {t:'s', n} / {t:'t', d}.
  const fromWire = r => (r || []).map(a => a[0] === 's' ? {t:'s', n:a[1]} : {t:'t', d:a[1]});
  const toWire = r => r.map(x => x.t === 's' ? ['s', x.n] : ['t', x.d]);

  window.WalkAPI = {
    base, setBase, fromWire, toWire,
    getFlats: () => req('GET', '/api/flats'),
    putFlats: doc => req('PUT', '/api/flats', doc),
    putSegment: (seg, route) => req('PUT', `/api/flats/${encodeURIComponent(seg)}`, toWire(route)),
    deleteSegment: seg => req('DELETE', `/api/flats/${encodeURIComponent(seg)}`),
  };
})();
