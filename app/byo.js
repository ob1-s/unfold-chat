// BYO quota connector for unfold-chat hosted demos.
// Free messages run on the host's account until they run out; connecting your
// own Cloudflare account (free, OAuth PKCE) moves inference onto YOUR free
// daily neurons — nothing is ever billed to whoever shared the link.
(function () {
'use strict';

var SS_KEY = 'unfold_byo_session';
var PKCE_KEY = 'unfold_byo_pkce';
var CFG = null;
var SESSION = null;
var banner = null;

function $(id) { return document.getElementById(id); }
function load() {
  try { SESSION = JSON.parse(localStorage.getItem(SS_KEY) || 'null'); } catch (e) { SESSION = null; }
}
function persist() {
  try {
    if (SESSION) localStorage.setItem(SS_KEY, JSON.stringify(SESSION));
    else localStorage.removeItem(SS_KEY);
  } catch (e) {}
}

/* ---------- fetch wrapper: attach the visitor's own bearer to /api/* ---------- */
var nativeFetch = window.fetch.bind(window);
window.fetch = function (url, opt) {
  opt = opt || {};
  var u = String(url);
  if (SESSION && SESSION.accessToken && u.indexOf('/api/') === 0 && u.indexOf('/api/config') !== 0 && u.indexOf('/api/quota') !== 0) {
    opt.headers = Object.assign({}, opt.headers, { Authorization: 'Bearer ' + SESSION.accessToken });
    if (SESSION.accountId) opt.headers['X-CF-Account-Id'] = SESSION.accountId;
  }
  return nativeFetch(u, opt).then(function (res) {
    if (res.status === 402) showBanner('exhausted');
    return res;
  });
};

/* ---------- banner ---------- */
function ensureBanner() {
  if (banner) return banner;
  banner = document.createElement('div');
  banner.className = 'byo-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML =
    '<span class="byo-text"></span>' +
    '<button type="button" class="byo-connect">Connect Cloudflare</button>' +
    '<button type="button" class="byo-close" aria-label="Dismiss">×</button>';
  banner.querySelector('.byo-close').addEventListener('click', function () { banner.classList.remove('on'); });
  banner.querySelector('.byo-connect').addEventListener('click', function () { if (!CFG) return; startOAuth(); });
  document.body.appendChild(banner);
  return banner;
}
function showBanner(kind, detail) {
  var b = ensureBanner();
  var text = b.querySelector('.byo-text');
  var connect = b.querySelector('.byo-connect');
  connect.hidden = false;
  if (kind === 'connected') {
    text.textContent = 'Connected · inference runs on your free daily neurons';
    connect.textContent = 'Disconnect';
    connect.onclick = function () { disconnect(); };
  } else if (kind === 'exhausted') {
    text.innerHTML = (detail && detail.used !=0 ? 'Free demo messages used up (' : '') +
      'Free messages used up (' + ((detail && detail.used) || '?') + '/' + ((detail && detail.limit) || '?') + '). ' +
      (CFG && CFG.byoEnabled
        ? 'Connect your free Cloudflare account to keep going — it runs on <b>your</b> neurons, not ours.'
        : 'Self-host to continue (see README).');
    connect.textContent = CFG && CFG.byoEnabled ? 'Connect Cloudflare' : 'How to self-host';
    connect.onclick = function () {
      if (CFG && CFG.byoEnabled) startOAuth();
      else window.open('https://github.com/ob1-s/unfold-chat', '_blank', 'noopener');
    };
  } else if (kind === 'connecting') {
    text.textContent = 'Connecting your Cloudflare account…';
    connect.hidden = true;
  } else {
    text.textContent = String(detail || 'Something went wrong.');
    connect.textContent = 'Retry';
    connect.onclick = function () { location.reload(); };
  }
  requestAnimationFrame(function () { b.classList.add('on'); });
}
function hideBanner() { if (banner) banner.classList.remove('on'); }

/* ---------- OAuth: authorization code + PKCE, public client ---------- */
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function startOAuth() {
  showBanner('connecting');
  var verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  var challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  var state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier: verifier, state: state }));
  var q = new URLSearchParams({
    response_type: 'code',
    client_id: CFG.clientId,
    redirect_uri: CFG.redirectUri,
    scope: CFG.scopes,
    state: state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  location.assign(CFG.authUrl + '?' + q.toString());
}

async function finishOAuth(params) {
  var saved;
  try { saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || '{}'); } catch (e) { saved = {}; }
  history.replaceState(null, '', '/');
  if (params.get('state') !== saved.state) throw new Error('OAuth state mismatch');
  showBanner('connecting');
  var body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: CFG.redirectUri,
    client_id: CFG.clientId,
    code_verifier: saved.verifier,
  });
  var res = await fetch(CFG.tokenUrl, { method: 'POST', body: body });
  if (!res.ok) throw new Error('token exchange failed: HTTP ' + res.status);
  var tok = await res.json();
  SESSION = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || null,
    accountId: null,
  };
  persist();
  await discoverAccount();
  showBanner('connected');
  setTimeout(hideBanner, 4000);
}

async function discoverAccount() {
  try {
    var res = await nativeFetch('/api/cf?path=' + encodeURIComponent('accounts?per_page=5'), {
      headers: { Authorization: 'Bearer ' + SESSION.accessToken },
    });
    var data = await res.json().catch(function () { return {}; });
    if (res.ok && data.result && data.result.length) {
      SESSION.accountId = data.result[0].id;
    } else {
      SESSION.accountError = 'HTTP ' + res.status + ': ' + JSON.stringify(data.errors || data).slice(0, 160);
    }
  } catch (e) {
    SESSION.accountError = e.message;
  }
  if (!SESSION.accountId) {
    var pasted = prompt(
      'Could not auto-discover your account ID (' + (SESSION.accountError || 'no accounts visible to this token') + ').\n' +
      'Paste your Cloudflare Account ID (dash.cloudflare.com → Workers & Pages):'
    );
    if (pasted) SESSION.accountId = pasted.trim().toLowerCase();
  }

  persist();
}

async function refreshAccessToken() {
  if (!SESSION || !SESSION.refreshToken) return false;
  var body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: SESSION.refreshToken,
    client_id: CFG.clientId,
  });
  try {
    var res = await fetch(CFG.tokenUrl, { method: 'POST', body: body });
    if (!res.ok) return false;
    var tok = await res.json();
    SESSION.accessToken = tok.access_token;
    if (tok.refresh_token) SESSION.refresh_token = tok.refresh_token, SESSION.refreshToken = tok.refresh_token;
    persist();
    return true;
  } catch (e) { return false; }
}

async function disconnect() {
  if (SESSION) {
    try {
      await fetch(CFG.tokenUrl.replace('/token', '/revoke'), {
        method: 'POST',
        body: new URLSearchParams({ token: SESSION.accessToken, client_id: CFG.clientId }),
      });
    } catch (e) {}
  }
  SESSION = null;
  persist();
  location.reload();
}

/* ---------- boot ---------- */
async function boot() {
  load();
  try {
    CFG = await (await nativeFetch('/api/config')).json();
  } catch (e) {
    CFG = { byoEnabled: false };
  }
  var params = new URLSearchParams(location.search);
  if (params.get('code') && params.get('state')) {
    try {
      await finishOAuth(params);
    } catch (e) {
      showBanner('error', e.message);
    }
    return;
  }
  if (SESSION && SESSION.accessToken) {
    if (Math.floor(Date.now() / 1000) > (SESSION.expiresAt || Infinity)) {
      var ok = await refreshAccessToken();
      if (!ok) { SESSION = null; persist(); return; }
    }
    if (SESSION.accountId) showBanner('connected'), setTimeout(hideBanner, 4000);
  }
  window.addEventListener('quota-exhausted', function (ev) {
    showBanner('exhausted', ev.detail || {});
  });
}

boot();
})();
