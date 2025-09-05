// server.js (env-driven, deploy-ready)
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());

// ---------- Config from environment ----------
const PORT = process.env.PORT || 5000;
const FB_APP_ID = process.env.FB_APP_ID;                 // required
const FB_APP_SECRET = process.env.FB_APP_SECRET;         // required
const BASE_URL = process.env.BASE_URL;                   // required: e.g. https://<your-apprunner>.awsapprunner.com
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const DATA_DIR = process.env.DATA_DIR || __dirname;      // on AWS App Runner use /tmp

app.use(cors({ origin: CORS_ORIGIN, methods: ['GET', 'POST'] }));

// Derived
function requireEnv(name, val) {
  if (!val) {
    console.error(`[CONFIG] Missing ${name}. Set it as an environment variable.`);
    process.exit(1);
  }
}
requireEnv('FB_APP_ID', FB_APP_ID);
requireEnv('FB_APP_SECRET', FB_APP_SECRET);
requireEnv('BASE_URL', BASE_URL);

const REDIRECT_URI = `${BASE_URL.replace(/\/$/, '')}/auth/instagram/callback`;

// ---------- Storage (JSON files) ----------
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
    console.log(`Wrote ${file}`);
  } catch (e) {
    console.error(`saveJSON error for ${file}:`, e);
  }
}

// ---------- Health checks ----------
app.get('/', (req, res) => res.send('root ok'));
app.get('/healthz', (req, res) => res.send('ok'));

// ---------- OAuth ----------
app.get('/auth/instagram', (req, res) => {
  const url =
    'https://www.facebook.com/v17.0/dialog/oauth?' +
    `client_id=${encodeURIComponent(FB_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    '&scope=instagram_basic,instagram_content_publish' +
    '&response_type=code';
  return res.redirect(url);
});

app.get('/auth/instagram/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code returned');

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

    // 3) Get FB Pages
    const pages = await axios.get('https://graph.facebook.com/v17.0/me/accounts', {
      params: { access_token: longToken }
    });
    const pageList = pages.data?.data || [];
    if (!pageList.length) throw new Error('No Facebook Pages found for this user');
    const pageId = pageList[0].id;
    console.log('[OAuth] page ok:', pageId);

    // 4) From Page → Instagram Business account
    const ig = await axios.get(`https://graph.facebook.com/v17.0/${pageId}`, {
      params: { fields: 'instagram_business_account', access_token: longToken }
    });
    const igAccountId = ig.data?.instagram_business_account?.id;
    if (!igAccountId) throw new Error('No Instagram Business account linked to this Page');
    console.log('[OAuth] IG ok:', igAccountId);

    // 5) Save account
    const accounts = loadJSON(ACCOUNTS_FILE);
    accounts[igAccountId] = {
      accessToken: longToken,
      username: `Instagram-${igAccountId}`,
      buckets: []
    };
    saveJSON(ACCOUNTS_FILE, accounts);
    console.log('[OAuth] saved account:', igAccountId);

    // 6) Friendly confirmation page
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
    res.status(500).send(`OAuth error: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
});

// ---------- Minimal APIs your frontend uses ----------
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

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`[CONFIG] FB_APP_ID=${FB_APP_ID}`);
  console.log(`[CONFIG] BASE_URL=${BASE_URL}`);
  console.log(`[CONFIG] DATA_DIR=${DATA_DIR}`);
  console.log(`[CONFIG] CORS_ORIGIN=${CORS_ORIGIN}`);
});