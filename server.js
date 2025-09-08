// server.js — live-mode, robust save + debug endpoints
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());

// ------------ Config ------------
const PORT = process.env.PORT || 5000;
const FB_APP_ID = process.env.FB_APP_ID;                 // required
const FB_APP_SECRET = process.env.FB_APP_SECRET;         // required
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const DATA_DIR = process.env.DATA_DIR || '/tmp';         // App Runner writable path

app.use(cors({ origin: CORS_ORIGIN, methods: ['GET', 'POST'] }));

function requireEnv(name, val) {
  if (!val) {
    console.error(`[CONFIG] Missing ${name}. Set it as an environment variable.`);
    process.exit(1);
  }
}
requireEnv('FB_APP_ID', FB_APP_ID);
requireEnv('FB_APP_SECRET', FB_APP_SECRET);

// Build public base URL from request (behind App Runner proxies)
function buildBaseUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

// ------------ Storage helpers ------------
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'scheduleData.json');

function loadJSON(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const txt = fs.readFileSync(file, 'utf-8');
    return txt ? JSON.parse(txt) : {};
  } catch (e) {
    console.error('loadJSON error:', e);
    return {};
  }
}
function saveJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    console.log(`Wrote ${file} (bytes: ${Buffer.byteLength(JSON.stringify(data))})`);
  } catch (e) {
    console.error(`saveJSON error for ${file}:`, e);
  }
}

// Ensure files exist (best-effort)
try { if (!fs.existsSync(ACCOUNTS_FILE)) saveJSON(ACCOUNTS_FILE, {}); } catch {}
try { if (!fs.existsSync(SCHEDULE_FILE)) saveJSON(SCHEDULE_FILE, { times: [] }); } catch {}

// ------------ Health ------------
app.get('/', (req, res) => res.send('root ok'));
app.get('/healthz', (req, res) => res.send('ok'));

// ------------ OAuth start ------------
app.get('/auth/instagram', (req, res) => {
  const REDIRECT_URI = `${buildBaseUrl(req)}/auth/instagram/callback`;
  const scopes = [
    'instagram_basic',
    'instagram_content_publish',
    'pages_show_list'
  ].join(',');

  const url =
    'https://www.facebook.com/v17.0/dialog/oauth' +
    `?client_id=${encodeURIComponent(FB_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    '&response_type=code';

  return res.redirect(url);
});

// ------------ OAuth callback ------------
app.get('/auth/instagram/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code returned');

  const REDIRECT_URI = `${buildBaseUrl(req)}/auth/instagram/callback`;

  try {
    console.log('[OAuth] code:', String(code).slice(0, 8) + '...');

    // 1) Short-lived token
    const shortRes = await axios.get('https://graph.facebook.com/v17.0/oauth/access_token', {
      params: {
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code
      }
    });
    const shortToken = shortRes.data.access_token;
    console.log('[OAuth] short token ok');

    // 2) Long-lived token
    const longRes = await axios.get('https://graph.facebook.com/v17.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: shortToken
      }
    });
    const longToken = longRes.data.access_token;
    console.log('[OAuth] long token ok');

    // 3) Find IG business account via multiple paths (robust)
    let igAccountId = null;

    // Path 1: /me/accounts (requires pages_show_list + user selected Page)
    try {
      const pagesRes = await axios.get('https://graph.facebook.com/v17.0/me/accounts', {
        params: { access_token: longToken }
      });
      const pages = pagesRes.data?.data || [];
      console.log('[OAuth] /me/accounts pages:', pages.length);
      for (const p of pages) {
        try {
          const igRes = await axios.get(`https://graph.facebook.com/v17.0/${p.id}`, {
            params: { fields: 'instagram_business_account', access_token: longToken }
          });
          const id = igRes.data?.instagram_business_account?.id;
          if (id) { igAccountId = id; break; }
        } catch {}
      }
    } catch (e) {
      console.log('[OAuth] /me/accounts failed:', e.response?.data || e.message);
    }

    // Path 2: /me?fields=instagram_business_accounts
    if (!igAccountId) {
      try {
        const meRes = await axios.get('https://graph.facebook.com/v17.0/me', {
          params: { fields: 'instagram_business_accounts{id,username}', access_token: longToken }
        });
        const igList = meRes.data?.instagram_business_accounts?.data || [];
        console.log('[OAuth] /me instagram_business_accounts:', igList.length);
        if (igList.length) igAccountId = igList[0].id;
      } catch (e) {
        console.log('[OAuth] /me?fields=instagram_business_accounts failed:', e.response?.data || e.message);
      }
    }

    // Path 3: /me?fields=accounts{instagram_business_account}
    if (!igAccountId) {
      try {
        const meAccRes = await axios.get('https://graph.facebook.com/v17.0/me', {
          params: { fields: 'accounts{id,name,instagram_business_account}', access_token: longToken }
        });
        const accs = meAccRes.data?.accounts?.data || [];
        console.log('[OAuth] /me accounts w/IG field:', accs.length);
        for (const a of accs) {
          const id = a?.instagram_business_account?.id;
          if (id) { igAccountId = id; break; }
        }
      } catch (e) {
        console.log('[OAuth] /me?fields=accounts{instagram_business_account} failed:', e.response?.data || e.message);
      }
    }

    if (!igAccountId) {
      throw new Error('No Instagram Business account found. On the consent screen, click "Choose what you allow" and select your Page and Instagram account; also ensure IG is linked to the Page.');
    }

    console.log('[OAuth] IG ok:', igAccountId);

    // 4) Save
    const accounts = loadJSON(ACCOUNTS_FILE);
    accounts[igAccountId] = {
      accessToken: longToken, // (stored for MVP; rotate to DB later)
      username: `Instagram-${igAccountId}`,
      buckets: []
    };
    saveJSON(ACCOUNTS_FILE, accounts);
    console.log('[OAuth] saved account:', igAccountId, '->', ACCOUNTS_FILE);

    // 5) Confirmation page
    res.send(`
      <html>
        <body style="font-family:sans-serif; text-align:center; margin-top:48px">
          <h2>Account connected!</h2>
          <p>You can close this tab and return to the app.</p>
        </body>
      </html>
    `);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[OAuth] error:', detail);
    res
      .status(500)
      .send(`<pre>OAuth error:\n${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}</pre>`);
  }
});

// ------------ Minimal APIs ------------
app.get('/accounts', (req, res) => {
  const accounts = loadJSON(ACCOUNTS_FILE);
  const list = Object.entries(accounts).map(([accountId, acc]) => ({
    accountId,
    username: acc.username
  }));
  res.json(list);
});

app.get('/buckets', (req, res) => res.json(loadJSON(ACCOUNTS_FILE)));
app.post('/buckets', (req, res) => {
  const { accountId, buckets } = req.body || {};
  const accounts = loadJSON(ACCOUNTS_FILE);
  if (!accounts[accountId]) return res.status(400).send('Account not found');
  accounts[accountId].buckets = buckets || [];
  saveJSON(ACCOUNTS_FILE, accounts);
  res.json({ status: 'ok' });
});

app.get('/schedule', (req, res) => res.json(loadJSON(SCHEDULE_FILE).times || []));
app.post('/schedule', (req, res) => {
  const times = (req.body && req.body.schedule) || [];
  saveJSON(SCHEDULE_FILE, { times });
  res.json({ status: 'ok' });
});

// ------------ Debug (safe) ------------
app.get('/debug/files', (req, res) => {
  try {
    const aExists = fs.existsSync(ACCOUNTS_FILE);
    const sExists = fs.existsSync(SCHEDULE_FILE);
    res.json({
      accountsPath: ACCOUNTS_FILE,
      accountsExists: aExists,
      accountsBytes: aExists ? fs.statSync(ACCOUNTS_FILE).size : 0,
      schedulePath: SCHEDULE_FILE,
      scheduleExists: sExists,
      scheduleBytes: sExists ? fs.statSync(SCHEDULE_FILE).size : 0
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/debug/read-accounts', (req, res) => {
  try {
    const acc = loadJSON(ACCOUNTS_FILE);
    // mask tokens
    for (const k of Object.keys(acc)) {
      if (acc[k].accessToken) acc[k].accessToken = `***len:${acc[k].accessToken.length}`;
    }
    res.json(acc);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ------------ Start ------------
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`[CONFIG] FB_APP_ID=${FB_APP_ID}`);
  console.log(`[CONFIG] DATA_DIR=${DATA_DIR}`);
  console.log(`[CONFIG] CORS_ORIGIN=${CORS_ORIGIN}`);
});
