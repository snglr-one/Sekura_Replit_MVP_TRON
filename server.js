// server.js — SEKURA MVP (TRON) — ESM
import express from 'express';
import path, { dirname } from 'path';
import fetch from 'node-fetch';     // v2
import TronWeb from 'tronweb';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

// Tron endpoints / keys
const TRONGRID         = process.env.TRONGRID_BASE || 'https://api.trongrid.io';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '';
const USDT_CONTRACT    = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS (optional)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// static site
app.use(express.static(path.join(__dirname, 'public')));

// helpers
const isLikelyTronAddress = (s) =>
  typeof s === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s);

// Convert base58 -> 32-byte hex (no 0x, left‑padded) for ABI
function toHexAddressPadded(addr) {
  const hex41 = TronWeb.address.toHex(addr); // "41" + 40 hex chars
  if (!hex41 || !/^41[0-9a-fA-F]{40}$/.test(hex41)) {
    throw new Error(`Invalid TRON address (toHex failed): ${addr}`);
  }
  const without41 = hex41.slice(2).toLowerCase();
  return without41.padStart(64, '0');
}

// Call USDT.isBlackListed(address)
async function isBlacklisted(addr) {
  const parameter = toHexAddressPadded(addr);
  const payload = {
    owner_address: addr,              // base58 ok with visible=true
    contract_address: USDT_CONTRACT,  // base58 ok with visible=true
    function_selector: 'isBlackListed(address)',
    parameter,
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

  if (!j || !j.result) throw new Error(`Bad isBlackListed response: ${JSON.stringify(j)}`);
  if (j.result.message && j.result.message.includes('REVERT')) {
    throw new Error(`Contract REVERT: ${j.result.message}`);
  }

  const arr = j.constant_result || [];
  if (!arr.length) return false;

  const hex = (arr[0] || '').replace(/^0x/, '').toLowerCase();
  return hex.endsWith('1');
}

// Simple account snapshot (TRX + USDT)
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
    balances
  };
}

// Minimal recent USDT transfers
async function getRecentUsdtTransfers(addr, limit = 5) {
  const url = `${TRONGRID}/v1/contracts/${USDT_CONTRACT}/events?event_name=Transfer&only_confirmed=true&limit=${limit}&sort=-block_timestamp`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      ...(TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {})
    }
  });
  const j = await res.json();
  if (!j || !j.success) return [];

  // crude filter: include if address string shows up in from/to
  const out = [];
  for (const ev of j.data || []) {
    const to   = ev.result?.to   || '';
    const from = ev.result?.from || '';
    if (![to, from].some(v => typeof v === 'string' && v.includes(addr.slice(1, 8)))) continue;

    out.push({
      time: ev.block_timestamp || null,
      dir: (to && to.includes(addr.slice(1, 8))) ? 'in' : 'out',
      token: 'USDT',
      amount: ev.result?.value ? Number(ev.result.value) / 1e6 : null,
      hash: ev.transaction_id || ''
    });
  }
  return out.slice(0, limit);
}

// Compose response
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

// shared handler
async function handleCheck(req, res) {
  try {
    const address = req.method === 'GET'
      ? (req.query.address || '')
      : (req.body?.address || '');

    if (!isLikelyTronAddress(address)) {
      return res.status(400).json({ error: 'Invalid TRON address' });
    }

    const payload = await buildResponse(address);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

// routes
app.post('/check', handleCheck);
app.post('/api/check', handleCheck);
app.get('/health', (req, res) => res.json({ ok: true }));

// fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// start
app.listen(PORT, () => {
  console.log(`SEKURA – MVP (TRON) server running on http://localhost:${PORT}`);
  console.log(`TRON_API: ${TRONGRID}`);
});
