// server.js — SEKURA MVP (stable restore)
// ESM syntax; works with "type": "module" in package.json

import express from "express";
import path, { dirname } from "path";
import TronWeb from "tronweb";
import fetch from "node-fetch"; // v2
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SEKURA server running on http://localhost:${PORT}`);
});

// TronGrid setup
const TRONGRID         = process.env.TRONGRID_BASE || "https://api.trongrid.io";
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || "";
const USDT_CONTRACT    = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS (simple, permissive)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// Serve the front-end
app.use(express.static(path.join(__dirname, "public")));

// Helpers
const isLikelyTron = (s) => typeof s === "string" && /^T[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s);

// Convert base58 to 32-byte hex (no 0x), padded to 64 chars for ABI
function toHexAddressPadded(address) {
  const hex41 = TronWeb.address.toHex(address); // "41" + 40 chars
  if (!hex41 || !/^41[0-9a-fA-F]{40}$/.test(hex41)) {
    throw new Error("Invalid TRON address");
  }
  return hex41.slice(2).toLowerCase().padStart(64, "0");
}

// Call USDT.isBlackListed(address)
async function isBlacklisted(address) {
  const parameter = toHexAddressPadded(address);
  const payload = {
    owner_address: address,             // base58 ok with visible=true
    contract_address: USDT_CONTRACT,    // base58 ok with visible=true
    function_selector: "isBlackListed(address)",
    parameter,
    visible: true
  };

  const res = await fetch(`${TRONGRID}/wallet/triggerconstantcontract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {})
    },
    body: JSON.stringify(payload)
  });
  const j = await res.json();

  if (!j || !j.result) throw new Error(`USDT call failed: ${JSON.stringify(j)}`);
  if (j.result.message && j.result.message.includes("REVERT")) {
    throw new Error(`Contract REVERT: ${j.result.message}`);
  }
  const out = (j.constant_result || [])[0] || "0".repeat(64);
  const hex = out.replace(/^0x/, "").toLowerCase();
  return hex.endsWith("1"); // bool packed in last byte
}

// Basic account snapshot (TRX + USDT)
async function getAccountSnapshot(address) {
  const res = await fetch(`${TRONGRID}/v1/accounts/${address}`, {
    headers: {
      "Accept": "application/json",
      ...(TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {})
    }
  });
  const j = await res.json();
  if (!j?.success || !j?.data?.length) return { createdAt: null, balances: [] };

  const a = j.data[0];
  const balances = [];

  if (typeof a.balance === "number") {
    balances.push({ symbol: "TRX", name: "TRON", balance: a.balance / 1e6, usd: null, tokenType: "TRC10" });
  }
  if (Array.isArray(a.trc20)) {
    for (const entry of a.trc20) {
      const k = Object.keys(entry)[0];
      if (k === USDT_CONTRACT) {
        const amt = Number(entry[k]) / 1e6;
        balances.push({ symbol: "USDT", name: "Tether USD", balance: amt, usd: amt, tokenType: "TRC20" });
      }
    }
  }

  return { createdAt: a.create_time || null, balances };
}

// Minimal recent USDT transfers
async function getRecentUsdtTransfers(address, limit = 5) {
  const url = `${TRONGRID}/v1/contracts/${USDT_CONTRACT}/events?event_name=Transfer&only_confirmed=true&limit=${limit}&sort=-block_timestamp`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      ...(TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {})
    }
  });
  const j = await res.json();
  if (!j?.success) return [];

  const out = [];
  for (const ev of j.data || []) {
    const to   = ev.result?.to || "";
    const from = ev.result?.from || "";
    // simple match (we don’t expand base58->hex here for speed; works for demo)
    if (!to.includes(address.slice(1, 8)) && !from.includes(address.slice(1, 8))) continue;

    out.push({
      time: ev.block_timestamp || null,
      dir: to.includes(address.slice(1, 8)) ? "in" : "out",
      token: "USDT",
      amount: ev.result?.value ? Number(ev.result.value) / 1e6 : null,
      hash: ev.transaction_id || ""
    });
  }
  return out.slice(0, limit);
}

// Build response used by the front-end card
async function buildResult(address) {
  const blacklisted = await isBlacklisted(address);
  const account     = await getAccountSnapshot(address);
  const txs         = await getRecentUsdtTransfers(address, 5);

  const usdt = account.balances.find(b => b.symbol === "USDT");
  const trx  = account.balances.find(b => b.symbol === "TRX");
  const totalUsd = usdt?.usd || 0;

  let risk = blacklisted ? 100 : 0;
  if (!blacklisted && txs.length) risk = Math.min(40 + txs.length * 5, 70);

  const status = blacklisted ? "Blacklisted" : (risk >= 60 ? "Needs Review" : "Safe");

  return {
    status,
    riskScore: risk,
    isBlacklisted: blacklisted,
    reason: blacklisted ? "USDT contract reports this address is blacklisted" : "",
    blacklistTimestamp: null,
    address,
    network: "TRON",
    totalUsd,
    createdAt: account.createdAt,
    recentUsdtTransfers: txs.length,
    tokenBalances: [
      ...(usdt ? [usdt] : []),
      ...(trx  ? [trx]  : [])
    ],
    recentTrc20: txs
  };
}

// Shared handler
async function handleCheck(req, res) {
  try {
    const address = req.method === "GET"
      ? (req.query.address || "")
      : (req.body?.address || "");

    if (!isLikelyTron(address)) {
      return res.status(400).json({ error: "Invalid TRON address" });
    }
    const result = await buildResult(address);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

// Support both old/new routes + methods
app.get("/check", handleCheck);
app.post("/check", handleCheck);
app.get("/api/check", handleCheck);
app.post("/api/check", handleCheck);

app.get("/health", (req, res) => res.json({ ok: true }));

// Fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`SEKURA server running on http://localhost:${PORT}`);
  console.log(`TRON_API: ${TRONGRID}`);
});
