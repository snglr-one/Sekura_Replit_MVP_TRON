// SEKURA — MVP (TRON)
// Express server that aggregates TronScan data and adds on‑chain blacklist checks via TronWeb.

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const TronWeb = require('tronweb');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------- Config --------------------
const TRONSCAN_BASE = 'https://apilist.tronscanapi.com';

// TronGrid / Full node (for on‑chain contract calls)
const TRON_API = process.env.TRON_API || 'https://api.trongrid.io';
const tronHeaders = {};
if (process.env.TRONGRID_API_KEY) {
  tronHeaders['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
}
const tronWeb = new TronWeb({ fullHost: TRON_API, headers: tronHeaders });

// Prefer TronScan API key if provided (better limits on explorer endpoints)
function tronscanHeaders() {
  const key =
    process.env.TRONSCAN_API_KEY ||
    process.env.TRON_PRO_API_KEY ||
    process.env['TRON-PRO-API-KEY'];
  return key ? { 'TRON-PRO-API-KEY': key } : {};
}

async function tronscanGet(endpoint, params = {}) {
  const url = `${TRONSCAN_BASE}${endpoint}`;
  const res = await axios.get(url, {
    params,
    headers: tronscanHeaders(),
    timeout: 15000
  });
  return res.data;
}

// -------------------- Helpers --------------------
function looksLikeTronAddress(addr) {
  return typeof addr === 'string' && addr.length >= 26 && addr.length <= 36 && addr.startsWith('T');
}

// Normalize any boolean-like value: true/1/'1'/'true'/'yes'
function isTrue(v) {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

// Flatten TronScan security flags and synthesize common aliases
function normalizeSecurityFlags(sec) {
  const f = {};
  if (!sec || typeof sec !== 'object') return f;

  for (const [k, v] of Object.entries(sec)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [kk, vv] of Object.entries(v)) {
        f[`${k}.${kk}`] = isTrue(vv);
      }
    } else {
      f[k] = isTrue(v);
    }
  }

  // High-level aliases commonly seen
  f.is_black_list = f.is_black_list || f.is_blacklist || f['stablecoin_blacklist'] || false;

  // Token-specific (USDT/USDC) — cover a few likely shapes
  f.usdt_blacklisted =
    f['usdt_blacklisted'] ||
    f['usdt.is_black_list'] ||
    f['USDT'] ||
    f['Tether'] ||
    false;

  f.usdc_blacklisted =
    f['usdc_blacklisted'] ||
    f['usdc.is_black_list'] ||
    f['USDC'] ||
    false;

  return f;
}

// ---------- Robust on‑chain USDT blacklist check (no ABI needed) ----------
const USDT_TRON_CONTRACT = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj'; // USDT (TRC‑20)

// Set a harmless default address so TronWeb can build constant calls
try { tronWeb.setAddress('TQ5D7rjv3Z5Q3oS8j1gGq2Dq2wZJd2iQ7T'); } catch {}

async function isUSDTBlacklistedOnChain(address) {
  const contractHex = tronWeb.address.toHex(USDT_TRON_CONTRACT);

  // Raw constant call for a given signature and single 'address' param
  async function trySig(signature) {
    try {
      const res = await tronWeb.transactionBuilder.triggerSmartContract(
        contractHex,
        signature,          // e.g. 'isBlackListed(address)'
        { callValue: 0 },
        [{ type: 'address', value: address }]
      );
      const hex = res?.constant_result?.[0];
      if (!hex) return null;
      const [val] = tronWeb.utils.abi.decodeParams(['bool'], '0x' + hex);
      return !!val;
    } catch {
      return null;
    }
  }

  const signatures = [
    'isBlackListed(address)',
    'isBlacklisted(address)',
    'getBlackListStatus(address)',
    'isBlackList(address)'
  ];

  for (const sig of signatures) {
    const out = await trySig(sig);
    if (out !== null) return out;
  }
  return false; // unknown/missing method -> assume not blacklisted
}

// -------------------- Routes --------------------
app.get('/api/health', (req, res) => res.json({ ok: true, tron_api: TRON_API }));

// Main wallet summary
app.get('/api/address/:address/summary', async (req, res) => {
  try {
    const address = (req.params.address || '').trim();
    if (!looksLikeTronAddress(address)) {
      return res.status(400).json({ error: 'Invalid TRON address format (must start with T...)' });
    }

    // Pull core data from TronScan in parallel
    const [
      accountDetail,
      tokenList,
      tokenOverview,
      securityAccount,
      trc20Transfers
    ] = await Promise.all([
      tronscanGet('/api/accountv2', { address }),
      tronscanGet('/api/account/tokens', {
        address, start: 0, limit: 200, hidden: 0, show: 0, sortType: 0, sortBy: 0
      }),
      tronscanGet('/api/account/token_asset_overview', { address }),
      tronscanGet('/api/security/account/data', { address }),
      tronscanGet('/api/transfer/trc20', {
        address, start: 0, limit: 20, direction: 0, reverse: 'true', db_version: 1
      })
    ]);

    // Balances
    const trxBalanceSun = accountDetail?.balance ?? 0;
    const trxBalance = Number(trxBalanceSun) / 1e6;

    // Tokens
    const tokens = (tokenList?.data || []).map(t => ({
      tokenId: t.tokenId,
      tokenAddress: t.tokenId,       // TRC‑20: contract address
      tokenName: t.tokenName,
      tokenAbbr: t.tokenAbbr,
      tokenDecimal: t.tokenDecimal,
      tokenType: t.tokenType,        // trc10 / trc20
      balance: t.balance,            // raw string
      balanceFormatted: Number(t.balance) / Math.pow(10, Number(t.tokenDecimal || 0)),
      priceInUsd: t.tokenPriceInUsd || null,
      assetInUsd: t.assetInUsd || null
    }));

    // Totals
    const totals = {
      totalAssetInUsd: tokenOverview?.totalAssetInUsd ?? null,
      totalAssetInTrx: tokenOverview?.totalAssetInTrx ?? null
    };

    // Recent transfers
    const recentTransfers = (trc20Transfers?.token_transfers || []).map(x => ({
      txHash: x.transaction_id,
      timestamp: x.block_ts,
      tokenName: x.tokenName || x.symbol,
      tokenAbbr: x.symbol || x.tokenAbbr,
      contract: x.contract_address,
      from: x.from_address,
      to: x.to_address,
      value: x.quant,
      decimals: x.decimals,
      valueFormatted: Number(x.quant) / Math.pow(10, Number(x.decimals || 0)),
      direction:
        x.to_address === address ? 'in' :
        x.from_address === address ? 'out' : 'other'
    }));

    // ---------- Risk scoring (improved) ----------
    const flags = normalizeSecurityFlags(securityAccount);
    let score = 0;
    const reasons = [];

    // Global/explorer blacklist
    if (flags.is_black_list) {
      score += 70;
      reasons.push('Address appears on a TronScan blacklist');
    }

    // Token‑specific blacklists from explorer
    const tokenBlacklists = [];
    if (flags.usdt_blacklisted) tokenBlacklists.push('USDT');
    if (flags.usdc_blacklisted) tokenBlacklists.push('USDC');
    if (tokenBlacklists.length) {
      score += 70;
      reasons.push(`Blacklisted in stablecoin(s): ${tokenBlacklists.join(', ')}`);
    }

    // On‑chain USDT blacklist (fallback if explorer didn’t show it)
    if (!tokenBlacklists.includes('USDT')) {
      const usdtOnChain = await isUSDTBlacklistedOnChain(address);
      if (usdtOnChain) {
        score += 70;
        reasons.push('USDT contract reports address is blacklisted (on‑chain check)');
      }
    }

    // Other TronScan heuristics
    if (flags.has_fraud_transaction) {
      score += 40; reasons.push('History of fraud‑flagged transactions');
    }
    if (flags.send_ad_by_memo) {
      score += 10; reasons.push('Sent frequent advertising memos');
    }
    if (flags.fraud_token_creator) {
      score += 20; reasons.push('Creator of suspicious tokens');
    }

    // Activity heuristics
    const latestOp = accountDetail?.latest_operation_time || 0;
    const txCount = accountDetail?.totalTransactionCount || 0;
    if (txCount < 3) { score += 5; reasons.push('Low activity'); }

    // Clamp 0..100
    score = Math.max(0, Math.min(100, score));
    // ---------- End risk scoring ----------

    res.json({
      address,
      trxBalanceSun,
      trxBalance,
      totals,
      tokens,
      recentTransfers,
      risk: { score, reasons, tronscanFlags: flags },
      meta: { totalTransactionCount: txCount, latestOperationTime: latestOp }
    });
  } catch (err) {
    console.error('Error in /api/address/:address/summary', err?.response?.data || err.message);
    res.status(500).json({
      error: 'Failed to fetch wallet summary',
      details: err?.response?.data || err.message
    });
  }
});

// Debug endpoint: shows exactly what we detect
app.get('/api/debug/blacklist/:address', async (req, res) => {
  const address = (req.params.address || '').trim();
  if (!looksLikeTronAddress(address)) {
    return res.status(400).json({ error: 'Invalid TRON address' });
  }
  try {
    const securityAccount = await tronscanGet('/api/security/account/data', { address });
    const flags = normalizeSecurityFlags(securityAccount);
    const usdtOnChain = await isUSDTBlacklistedOnChain(address);

    res.json({
      address,
      tronscan_security_raw: securityAccount,
      tronscan_flags_normalized: flags,
      usdt_onchain_blacklisted: usdtOnChain
    });
  } catch (e) {
    res.status(500).json({ error: 'debug failed', details: e?.response?.data || e.message });
  }
});

// UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SEKURA — MVP (TRON) server running on http://localhost:${PORT}`);
  console.log(`TRON_API: ${TRON_API}`);
});
