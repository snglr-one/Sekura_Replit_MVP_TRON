/* server.js — SEKURA MVP (TRON)
 * Full Express server: static hosting + wallet check API.
 * Supports GET/POST on /api/check and /check (same handler).
 */

const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // npm i node-fetch@2
const app = express();

const PORT = process.env.PORT || 3000;
const TRONGRID = process.env.TRONGRID_BASE || 'https://api.trongrid.io';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '';
const TRONSCAN = process.env.TRONSCAN_BASE || 'https://apilist.tronscanapi.com';
const TRONSCAN_API_KEY = process.env.TRONSCAN_API_KEY || '';

// USDT (TRC20) mainnet contract
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// Simple address sanity (TRON base58 starts with T and len ~34)
const isLikelyTronAddress = (s) => typeof s === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s);

// Utilities
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static site
app.use(express.static(path.join(__dirname, 'public')));

// CORS for local dev if needed (Replit normally OK)
// app.use((req,res,next)=>{res.set('Access-Control-Allow-Origin','*');next();});

/* ---------------- Core chain helpers ---------------- */

// Base58 -> hex is cumbersome without lib; TronGrid can take owner_address as base58 when visible=true.
// For function param we must supply 32-byte hex of the *hex form of the address without 0x41 prefix*
// TronScan “read contract” uses base58 and handles conversion; TronGrid trigger requires hex param.
// Easiest: call /wallet/validateaddress to get hex, then pad.
async function toHexAddress(addr) {
  const url = `${TRONGRID}/wallet/validateaddress`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      ...(TRONGRID_API_KEY ? {'TRON-PRO-API-KEY': TRONGRID_API_KEY} : {})
    },
    body: JSON.stringify({ address: addr, visible: true })
  });
  const j = await res.json();
  if (!j || !j.result || !j.address) throw new Error(`Address validation failed: ${JSON.stringify(j)}`);
  // j.address is hex with 0x41... prefix (without 0x). We need 20 bytes (drop the first byte 0x41)
  const hex = j.address.toLowerCase().replace(/^0x/,'');
  if (!hex.startsWith('41') || hex.length !== 42) throw new Error(`Unexpected hex form: ${j.address}`);
  const without41 = hex.slice(2); // 20 bytes (40 hex chars)
  return without41.padStart(64, '0');
}

async function isBlacklisted(addr) {
  const paramHex = await toHexAddress(addr);
  const payload = {
    owner_address: addr,              // base58 accepted with visible:true
    contract_address: USDT_CONTRACT,  // base58 accepted with visible:true
    function_selector: 'isBlackListed(address)',
    parameter: paramHex,
    visible: true
  };

  const res = await fetch(`${TRONGRID}/wallet/triggerconstantcontract`, {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      ...(TRONGRID_API_KEY ? {'TRON-PRO-API-KEY': TRONGRID_API_KEY} : {})
    },
    body: JSON.stringify(payload)
  });
  const j = await res.json();

  if (!j || !j.result) throw new Error(`Bad isBlackListed response: ${JSON.stringify(j)}`);
  if (j.result.message && j.result.message.includes('REVERT')) {
    // Contract revert usually means missing arg/selector issues; but USDT returns boolean normally
    throw new Error(`Contract REVERT: ${j.result.message}`);
  }
  const arr = j.constant_result || [];
  if (!arr.length) return false; // default false if nothing returned
  // USDT returns 0...01 for true / 0...00 for false
  const hex = (arr[0] || '').replace(/^0x/,'').toLowerCase();
  return hex.endsWith('1');
}

async function getAccount(addr) {
  const res = await fetch(`${TRONGRID}/v1/accounts/${addr}`, {
    headers: {
      'Accept':'application/json',
      ...(TRONGRID_API_KEY ? {'TRON-PRO-API-KEY': TRONGRID_API_KEY} : {})
    }
  });
  const j = await res.json();
  if (!j || !j.success || !j.data || !j.data.length) return {};
  const a = j.data[0];

  const balances = [];
  // TRX
  if (typeof a.balance === 'number') {
    balances.push({ symbol:'TRX', name:'TRON', balance: a.balance / 1e6, usd: null, tokenType:'TRC10' });
  }
  // TRC20 array with contract address keys and amounts as strings
  if (Array.isArray(a.trc20)) {
    for (const entry of a.trc20) {
      const key = Object.keys(entry)[0];
      const raw = entry[key];
      if (key === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t') {
        const amt = Number(raw)/1e6;
        balances.push({ symbol:'USDT', name:'Tether USD', balance: amt, usd: amt, tokenType:'TRC20' });
      }
    }
  }

  return {
    createdAt: a.create_time || null,
    recentUsdtTransfers: 0, // we’ll fill from logs below
    balances
  };
}

async function getRecentUsdtTransfers(addr, limit=5) {
  // TronGrid transfer event logs filter
  const url = `${TRONGRID}/v1/contracts/${USDT_CONTRACT}/events?event_name=Transfer&only_confirmed=true&limit=${limit}&sort=-block_timestamp&filters=to,from&address=${addr}`;
  const res = await fetch(url, {
    headers: {
      'Accept':'application/json',
      ...(TRONGRID_API_KEY ? {'TRON-PRO-API-KEY': TRONGRID_API_KEY} : {})
    }
  });
  const j = await res.json();
  if (!j || !j.success) return [];
  const out = [];
  for (const ev of j.data || []) {
    // event parameters: from, to, value
    const to = (ev.result && ev.result.to) || '';
    const from = (ev.result && ev.result.from) || '';
    const value = (ev.result && ev.result.value) ? Number(ev.result.value)/1e6 : null;
    const dir = to && to.toLowerCase().includes(addr.slice(1,6).toLowerCase()) ? 'in' : (from ? 'out' : '');
    out.push({
      time: ev.block_timestamp || null,
      dir,
      token: 'USDT',
      amount: value,
      hash: ev.transaction_id || ''
    });
  }
  return out;
}

/* Compose response */
async function buildResponse(address) {
  const blk = await isBlacklisted(address);
  const account = await getAccount(address);
  const txs = await getRecentUsdtTransfers(address, 5);

  const usdt = (account.balances || []).find(b => b.symbol === 'USDT');
  const trx  = (account.balances || []).find(b => b.symbol === 'TRX');

  const totalUsd = (usdt?.usd || 0); // simplistic — only USDT valued

  // Risk score heuristic: blacklisted -> 100, else small if recent in/out, else 0
  let risk = blk ? 100 : 0;
  if (!blk && txs.length > 0) risk = Math.min(40 + txs.length*5, 70);

  const status = blk ? 'Blacklisted' : (risk >= 60 ? 'Needs Review' : 'Safe');

  return {
    status,
    riskScore: risk,
    isBlacklisted: blk,
    reason: blk ? 'USDT contract reports this address is blacklisted' : '',
    blacklistTimestamp: null, // USDT contract does not expose timestamp
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

/* --------------- Unified handler & routes --------------- */

async function handleCheck(req, res) {
  try {
    const address = (req.method === 'GET' ? req.query.address : (req.body && req.body.address)) || '';
    if (!isLikelyTronAddress(address)) {
      return res.status(400).json({ error: 'Invalid TRON address' });
    }
    const data = await buildResponse(address);
    res.json(data);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

// Support both paths & verbs to avoid 404s in the client
app.get('/api/check', handleCheck);
app.post('/api/check', handleCheck);
app.get('/check', handleCheck);
app.post('/check', handleCheck);

// Health
app.get('/health', (req,res)=> res.json({ ok:true }));

// Fallback: let frontend router handle non-API routes
app.get('*', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
app.listen(PORT, () => {
  console.log(`SEKURA – MVP (TRON) server running on http://localhost:${PORT}`);
  console.log(`TRON_API: ${TRONGRID}`);
});
