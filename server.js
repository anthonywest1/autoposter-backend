// server.js — robust IG lookup using Page access tokens (App Runner friendly)
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
const DATA_DIR = process.env.DATA_DIR || '/tmp';         // writable on App Runner

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
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(file, json);
    console.log(`Wrote ${file} (bytes: ${Buffer.byteLength(json)})`);
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
  // Include pages_show_list; pages_read_engagement helps page field reads for some setups
  const scopes = [
    'instagram_basic',
    'instagram_content_publish',
    'pages_show_list',
    'pages_read_engagement'
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

    // 2) Long-lived user token
    const longRes = await axios.get('https://graph.facebook.com/v17.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: shortToken
      }
    });
    const userToken = longRes.data.access_token;
    console.log('[OAuth] long token ok');

    // 3) Get Pages with Page access tokens (IMPORTANT: use page token to query page fields)
    // We ask for id,name,access_token so we can call the page node using its own token.
    let pages = [];
    try {
      const pagesRes = await axios.get('https://graph.facebook.com/v17.0/me/accounts', {
        params: { access_token: userToken, fields: 'id,name,access_token' }
      });
      pages = pagesRes.data?.data || [];
      console.log('[OAuth] /me/accounts pages:', pages.length, pages.map(p => `${p.name}(${p.id})`).join(', '));
    } catch (e) {
      console.log('[OAuth] /me/accounts failed:', e.response?.data || e.message);
    }

    if (!pages.length) {
      throw new Error('No Facebook Pages found for this user (ensure you selected the Page on the consent screen).');
    }

    // 4) Scan pages for linked IG account, using each page's access_token
    let igAccountId = null;
    let foundOnPage = null;
    for (const p of pages) {
      if (!p.access_token) continue; // sometimes missing; skip
      try {
        const igRes = await axios.get(`https://graph.facebook.com/v17.0/${p.id}`, {
          params: { fields: 'instagram_business_account', access_token: p.access_token }
        });
        const id = igRes.data?.instagram_business_account?.id;
        if (id) {
          igAccountId = id;
          foundOnPage = p;
          break;
        }
      } catch (e) {
        // keep trying other pages
      }
    }

    if (!igAccountId) {
      throw new Error('No Instagram Business account linked to any of the selected Pages. Make sure your IG is BUSINESS and linked to the Page you checked during consent (Page Settings → Linked Accounts).');
    }

    console.log('[OAuth] IG ok:', igAccountId, 'on Page:', `${foundOnPage?.name}(${foundOnPage?.id})`);

    // 5) (Optional) Fetch IG username to store a friendly label
    let igUsername = `Instagram-${igAccountId}`;
    try {
      const igInfo = await axios.get(`https://graph.facebook.com/v17.0/${igAccountId}`, {
        params: { fields: 'username', access_token: foundOnPage.access_token }
      });
      if (igInfo.data?.username) igUsername = igInfo.data.username;
    } catch {}

    // 6) Save to accounts.json
    const accounts = loadJSON(ACCOUNTS_FILE);
    accounts[igAccountId] = {
      accessToken: userToken,   // long-lived user token; sufficient for publishing with page token exchange later
      pageId: foundOnPage.id,
      pageName: foundOnPage.name,
      igUsername,
      buckets: []
    };
    saveJSON(ACCOUNTS_FILE, accounts);
    console.log('[OAuth] saved account:', igAccountId, '->', ACCOUNTS_FILE);

    // 7) Confirmation page
    res.send(`
      <html>
        <body style="font-family:sans-serif; text-align:center; margin-top:48px">
          <h2>Account connected!</h2>
          <p>Linked IG: <b>${igUsername}</b> via Page <b>${foundOnPage.name}</b>.</p>
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
    username: acc.igUsername || acc.username || `Instagram-${accountId}`,
    pageId: acc.pageId,
    pageName: acc.pageName
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

// ------------ Debug ------------
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
    // mask tokens if present
    for (const k of Object.keys(acc)) {
      if (acc[k].accessToken) acc[k].accessToken = `***len:${String(acc[k].accessToken).length}`;
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
