// server.js (ESM) — SEKURA MVP (TRON)

import express from 'express';
import path, { dirname } from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

const TRONGRID          = process.env.TRONGRID_BASE || 'https://api.trongrid.io';
const TRONGRID_API_KEY  = process.env.TRONGRID_API_KEY || '';
const TRONSCAN          = process.env.TRONSCAN_BASE  || 'https://apilist.tronscanapi.com';
const TRONSCAN_API_KEY  = process.env.TRONSCAN_API_KEY || '';

const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const isLikelyTronAddress = (s) => typeof s === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- Chain helpers ---------------- */

async function toHexAddress(addr) {
  const res = await fetch(`${TRONGRID}/wallet/validateaddress`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {})
    },
    body: JSON.stringify({ address: addr, visible: true })
  });
  const j = await res.json();
  if (!j || !j.result || !j.address) {
    throw new Error(`Address validation failed: ${JSON.stringify(j)}`);
  }
  const hex = j.address.toLowerCase().replace(/^0x/, '');
  if (!hex.startsWith('41') || hex.length !== 42) {
    throw new Error(`Unexpected hex form: ${j.address}`);
  }
  const without41 = hex.slice(2);        // 20 bytes (40 hex chars)
  return without41.padStart(64, '0');    // left‑pad to 32 bytes
}

async function isBlacklisted(addr) {
  const paramHex = await toHexAddress(addr);
  const payload = {
    owner_address: addr,
    contract_address: USDT_CONTRACT,
    function_selector: 'isBlackListed(address)',
    parameter: paramHex,
    visible: true
  };

  const res = await fetch(`${TRONGRID}/wallet/triggerconstantcontract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {})
    },
    body: JSON.stringify(payload)
  });
  const j = await res.json();

  if (!j || !j.result) {
    throw new Error(`Bad isBlackListed response: ${JSON.stringify(j)}`);
  }
  if (j.result.message && j.result.message.includes('REVERT')) {
    throw new Error(`Contract REVERT: ${j.result.message}`);
  }

  const arr = j.constant_result || [];
  if (!arr.length) return false;

  const hex = (arr[0] || '').replace(/^0x/, '').toLowerCase();
  return hex.endsWith('1'); // ...01 = true
}

async function getAccount(addr) {
  const res = await fetch(`${TRONGRID}/v1/accounts/${addr}`, {
    headers: {
      'Accept': 'application/json',
      ...(TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {})
    }
  });
  const j = await res.json();
  if (!j || !j.success || !j.data || !j.data.length) return {};

  const a = j.data[0];
  const balances = [];

  if (typeof a.balance === 'number') {
    balances.push({ symbol: 'TRX', name: 'TRON', balance: a.balance / 1e6, usd: null, tokenType: 'TRC10' });
  }
  if (Array.isArray(a.trc20)) {
    for (const entry of a.trc20) {
      const key = Object.keys(entry)[0];
      const raw = entry[key];
      if (key === USDT_CONTRACT) {
        const amt = Number(raw) / 1e6;
        balances.push({ symbol: 'USDT', name: 'Tether USD', balance: amt, usd: amt, tokenType: 'TRC20' });
      }
    }
  }

  return {
    createdAt: a.create_time || null,
    recentUsdtTransfers: 0,
    balances
  };
}

async function getRecentUsdtTransfers(addr, limit = 5) {
  // Filter Transfer events around this address (approximate)
  const url = `${TRONGRID}/v1/contracts/${USDT_CONTRACT}/events?event_name=Transfer&only_confirmed=true&limit=${limit}&sort=-block_timestamp&filters=to,from&address=${addr}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      ...(TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {})
    }
  });
  const j = await res.json();
  if (!j || !j.success) return [];

  const out = [];
  for (const ev of j.data || []) {
    const to   = ev.result?.to   || '';
    const from = ev.result?.from || '';
    const val  = ev.result?.value ? Number(ev.result.value) / 1e6 : null;
    let dir = '';
    if (to   && to.toLowerCase().includes(addr.slice(1,6).toLowerCase())) dir = 'in';
    if (from && from.toLowerCase().includes(addr.slice(1,6).toLowerCase())) dir = 'out';
    out.push({
      time: ev.block_timestamp || null,
      dir,
      token: 'USDT',
      amount: val,
      hash: ev.transaction_id || ''
    });
  }
  return out;
}

async function buildResponse(address) {
  const blk     = await isBlacklisted(address);
  const account = await getAccount(address);
  const txs     = await getRecentUsdtTransfers(address, 5);

  const usdt = (account.balances || []).find(b => b.symbol === 'USDT');
  const trx  = (account.balances || []).find(b => b.symbol === 'TRX');

  const totalUsd = (usdt?.usd || 0);

  let risk = blk ? 100 : 0;
  if (!blk && txs.length > 0) risk = Math.min(40 + txs.length * 5, 70);

  const status = blk ? 'Blacklisted' : (risk >= 60 ? 'Needs Review' : 'Safe');

  return {
    status,
    riskScore: risk,
    isBlacklisted: blk,
    reason: blk ? 'USDT contract reports this address is blacklisted' : '',
    blacklistTimestamp: null,
    address,
    network: 'TRON',
    totalUsd,
    createdAt: account.createdAt || null,
    recentUsdtTransfers: txs.length,
    tokenBalances: [
      ...(usdt ? [usdt] : []),
      ...(trx  ? [trx]  : [])
    ],
    recentTrc20: txs
  };
}

/* ---------------- Routes ---------------- */

async function handleCheck(req, res) {
  try {
    const address = req.method === 'GET' ? (req.query.address || '') : (req.body?.address || '');
    if (!isLikelyTronAddress(address)) {
      return res.status(400).json({ error: 'Invalid TRON address' });
    }
    const data = await buildResponse(address);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

// Support both paths & verbs (so the client never 404s)
app.get('/api/check', handleCheck);
app.post('/api/check', handleCheck);
app.get('/check', handleCheck);
app.post('/check', handleCheck);

// Health
app.get('/health', (req,res)=> res.json({ ok:true }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SEKURA – MVP (TRON) server running on http://localhost:${PORT}`);
  console.log(`TRON_API: ${TRONGRID}`);
});
