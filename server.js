// SEKURA – MVP (TRON)
// Minimal Express server that proxies TronScan API and assembles a wallet summary.

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TRONSCAN_BASE = 'https://apilist.tronscanapi.com';

function apiHeaders() {
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
    headers: apiHeaders(),
    timeout: 15000
  });
  return res.data;
}

// Healthcheck
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Simple address format guard (Base58 starts with T)
function looksLikeTronAddress(addr) {
  return (
    typeof addr === 'string' &&
    addr.length >= 26 &&
    addr.length <= 36 &&
    addr.startsWith('T')
  );
}

app.get('/api/address/:address/summary', async (req, res) => {
  try {
    const address = (req.params.address || '').trim();
    if (!looksLikeTronAddress(address)) {
      return res
        .status(400)
        .json({ error: 'Invalid TRON address format (must start with T...)' });
    }

    // Parallel fetches from TronScan
    const [accountDetail, tokenList, tokenOverview, securityAccount, trc20Transfers] =
      await Promise.all([
        tronscanGet('/api/accountv2', { address }),
        tronscanGet('/api/account/tokens', {
          address,
          start: 0,
          limit: 200,
          hidden: 0,
          show: 0,
          sortType: 0,
          sortBy: 0
        }),
        tronscanGet('/api/account/token_asset_overview', { address }),
        tronscanGet('/api/security/account/data', { address }),
        tronscanGet('/api/transfer/trc20', {
          address,
          start: 0,
          limit: 20,
          direction: 0,
          reverse: 'true',
          db_version: 1
        })
      ]);

    const trxBalanceSun = accountDetail?.balance ?? 0;
    const trxBalance = Number(trxBalanceSun) / 1e6;

    // Flatten token holdings
    const tokens = (tokenList?.data || []).map((t) => ({
      tokenId: t.tokenId,
      tokenAddress: t.tokenId, // for TRC20 this is the contract address
      tokenName: t.tokenName,
      tokenAbbr: t.tokenAbbr,
      tokenDecimal: t.tokenDecimal,
      tokenType: t.tokenType,
      balance: t.balance, // raw
      balanceFormatted:
        Number(t.balance) / Math.pow(10, Number(t.tokenDecimal || 0)),
      priceInUsd: t.tokenPriceInUsd || null,
      assetInUsd: t.assetInUsd || null
    }));

    // Totals (USD/TRX) from overview when available
    const totals = {
      totalAssetInUsd: tokenOverview?.totalAssetInUsd ?? null,
      totalAssetInTrx: tokenOverview?.totalAssetInTrx ?? null
    };

    // Recent TRC20 transfers (normalize a bit)
    const recentTransfers = (trc20Transfers?.token_transfers || []).map((x) => ({
      txHash: x.transaction_id,
      timestamp: x.block_ts,
      tokenName: x.tokenName || x.symbol,
      tokenAbbr: x.symbol || x.tokenAbbr,
      contract: x.contract_address,
      from: x.from_address,
      to: x.to_address,
      value: x.quant, // raw
      decimals: x.decimals,
      valueFormatted: Number(x.quant) / Math.pow(10, Number(x.decimals || 0)),
      direction:
        x.to_address === address ? 'in' : x.from_address === address ? 'out' : 'other'
    }));

    // Very basic risk scoring (MVP)
    const f = securityAccount || {};
    let score = 0;
    const reasons = [];
    if (f.is_black_list) {
      score += 70;
      reasons.push('Address in stablecoin blacklist');
    }
    if (f.has_fraud_transaction) {
      score += 40;
      reasons.push('History of fraud-flagged transactions');
    }
    if (f.send_ad_by_memo) {
      score += 10;
      reasons.push('Sent frequent advertising memos');
    }
    if (f.fraud_token_creator) {
      score += 20;
      reasons.push('Creator of suspicious tokens');
    }
    const latestOp = accountDetail?.latest_operation_time || 0;
    const txCount = accountDetail?.totalTransactionCount || 0;
    if (txCount < 3) {
      score += 5;
      reasons.push('Low activity');
    }
    score = Math.max(0, Math.min(100, score));

    res.json({
      address,
      trxBalanceSun,
      trxBalance,
      totals,
      tokens,
      recentTransfers,
      risk: { score, reasons, tronscanFlags: f },
      meta: { totalTransactionCount: txCount, latestOperationTime: latestOp }
    });
  } catch (err) {
    console.error(
      'Error in /api/address/:address/summary',
      err?.response?.data || err.message
    );
    res.status(500).json({
      error: 'Failed to fetch data from TronScan',
      details: err?.response?.data || err.message
    });
  }
});

// Root serves the UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SEKURA – MVP (TRON) server running on http://localhost:${PORT}`);
});
