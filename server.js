// server.js — SEKURA MVP (TRON) — ESM version
// Static hosting + wallet check API with TronGrid and local address hexing via TronWeb.

import express from 'express';
import path, { dirname } from 'path';
import fetch from 'node-fetch';            // v2.x (CommonJS-compatible)
import TronWeb from 'tronweb';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

// ---- Config / Env ----
const TRONGRID          = process.env.TRONGRID_BASE || 'https://api.trongrid.io';
const TRONGRID_API_KEY  = process.env.TRONGRID_API_KEY || '';
const TRONSCAN          = process.env.TRONSCAN_BASE  || 'https://apilist.tronscanapi.com';
const TRONSCAN_API_KEY  = process.env.TRONSCAN_API_KEY || '';

// USDT (TRC20) mainnet contract
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// ---- Middleware ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ---- Helpers ----
const isLikelyTronAddress = (s) =>
  typeof s === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s);

// Convert base58 → 32-byte (64 hex chars) argument for solidity address
function toHexAddressPadded(addr) {
  const hex41 = TronWeb.address.toHex(addr); // "41" + 20-byte hex
  if (!hex41 || !/^41[0-9a-fA-F]{40}$/.test(hex41)) {
    throw new Error(`Invalid TRON address (toHex failed): ${addr}`);
  }
  const without41 = hex41.slice(2).toLowerCase(); // drop leading 0x41 (1 byte)
  return without41.padStart(64, '0'); // 32‑byte left-pad for ABI
}

// Call USDT.isBlackListed(address)
async function isBlacklisted(addr) {
  const paramHex = toHexAddressPadded(addr);
  const payload = {
    owner_address: addr,              // base58 accepted with visible=true
    contract_address: USDT_CONTRACT,  // base58 accepted with visible=true
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

  if (!j || !j.result) throw new Error(`Bad isBlackListed response: ${JSON.stringify(j)}`);
  if (j.result.message && j.result.message.includes('REVERT')) {
    throw new Error(`Contract REVERT: ${j.result.message}`);
  }

  const arr = j.constant_result || [];
  if (!arr.length) return false;

  // USDT returns 0...01 for true / 0...00 for false
  const hex = (arr[0] || '').replace(/^0x/, '').toLowerCase();
  return hex.endsWith('1');
}

// Basic account snapshot (TRX + USDT balances, createdAt)
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

  // TRX
  if (typeof a.balance === 'number') {
    balances.push({ symbol: 'TRX', name: 'TRON', balance: a.balance / 1e6, usd: null, tokenType: 'TRC10' });
  }

  // TRC20 array — we only surface USDT here for USD total
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

// Recent USDT Transfer events touching addr (approx)
async function getRecentUsdtTransfers(addr, limit = 5) {
  // Filter Transfer events around this address (TronGrid supports filters=to,from)
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
    // heuristic to mark direction quickly
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

// Compose API result payload
async function buildResponse(address) {
  const blk     = await isBlacklisted(address);
  const account = await getAccount(address);
  const txs     = await getRecentUsdtTransfers(address, 5);

  const usdt = (account.balances || []).find(b => b.symbol === 'USDT');
  const trx  = (account.balances || []).find(b => b.symbol === 'TRX');

  const totalUsd = (usdt?.usd || 0);

  // Simple risk heuristic for MVP
  let risk = blk ? 100 : 0;
  if (!blk && txs.length > 0) risk = Math.min(40 + txs.length * 5, 70);

  const status = blk ? 'Blacklisted' : (risk >= 60 ? 'Needs Review' : 'Safe');

  return {
    status,
    riskScore: risk,
    isBlacklisted: blk,
    reason: blk ? 'USDT contract reports this address is blacklisted' : '',
    blacklistTimestamp: null, // USDT contract doesn’t expose timestamp
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

// ---- Routes ----
async function handleCheck(req, res) {
  try {
    const address = req.method === 'GET'
      ? (req.query.address || '')
      : (req.body?.address || '');

    if (!isLikelyTronAddress(address)) {
      return res.status(400).json({ error: 'Invalid TRON address' });
    }

    const data = await buildResponse(address);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

// Support both paths & verbs to avoid 404s from the client
app.get('/api/check', handleCheck);
app.post('/api/check', handleCheck);
app.get('/check', handleCheck);
app.post('/check', handleCheck);

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// SPA fallback for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`SEKURA – MVP (TRON) server running on http://localhost:${PORT}`);
  console.log(`TRON_API: ${TRONGRID}`);
});
