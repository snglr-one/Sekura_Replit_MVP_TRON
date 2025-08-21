// SEKURA – MVP (TRON)
// Minimal backend for: USDT blacklisted check + wallet summary

import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import TronWeb from "tronweb";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TRONGRID_API = process.env.TRONGRID_API || "https://api.trongrid.io";
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || "";
const tronHeaders = TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {};

const tronWeb = new TronWeb({ fullHost: TRONGRID_API, headers: tronHeaders });

// USDT TRC-20 contract (mainnet)
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// Helpers
function isTronBase58(addr) {
  return typeof addr === "string" && addr.length >= 26 && addr.length <= 36 && addr.startsWith("T");
}

function to20ByteHexFromBase58(addr) {
  // TronWeb adds "41" prefix for hex form; strip it for 20-byte ABI param
  const hexWith41 = tronWeb.address.toHex(addr); // e.g., 41... (21 bytes)
  if (!hexWith41 || !hexWith41.startsWith("41") || hexWith41.length !== 42) {
    throw new Error("Invalid TRON address (hex)");
  }
  return hexWith41.slice(2); // 20 bytes (40 hex chars)
}

function pad64(hex) {
  return hex.padStart(64, "0");
}

async function triggerConstant({ contract, selector, paramHex64, ownerBase58 }) {
  // Use function_selector + parameter with visible:true (Base58 in body)
  const body = {
    owner_address: ownerBase58,
    contract_address: contract,
    function_selector: selector,
    parameter: paramHex64,
    visible: true,
    call_value: 0
  };
  const { data } = await axios.post(
    `${TRONGRID_API}/wallet/triggerconstantcontract`,
    body,
    { headers: { "Content-Type": "application/json", ...tronHeaders } }
  );
  return data;
}

async function callBool(selector, ownerBase58, contractBase58, addressBase58) {
  const a20 = to20ByteHexFromBase58(addressBase58);
  const param = pad64(a20);
  const out = await triggerConstant({
    contract: contractBase58,
    selector,
    paramHex64: param,
    ownerBase58
  });
  const r = out?.constant_result?.[0] || "";
  if (!r) return null;
  // last bit of 32-byte word
  return r.endsWith("1");
}

async function callUint(selector, ownerBase58, contractBase58, addressBase58) {
  const a20 = to20ByteHexFromBase58(addressBase58);
  const param = pad64(a20);
  const out = await triggerConstant({
    contract: contractBase58,
    selector,
    paramHex64: param,
    ownerBase58
  });
  const r = out?.constant_result?.[0] || "";
  if (!r) return 0n;
  return BigInt("0x" + r);
}

async function getDecimals() {
  try {
    const { data } = await axios.post(
      `${TRONGRID_API}/wallet/triggerconstantcontract`,
      {
        owner_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
        contract_address: USDT,
        function_selector: "decimals()",
        visible: true
      },
      { headers: { "Content-Type": "application/json", ...tronHeaders } }
    );
    const r = data?.constant_result?.[0] || "0000000000000000000000000000000000000000000000000000000000000006";
    return Number(BigInt("0x" + r));
  } catch {
    return 6;
  }
}

async function getAccount(address) {
  const { data } = await axios.get(`${TRONGRID_API}/v1/accounts/${address}`, {
    headers: tronHeaders
  });
  return data?.data?.[0] || null;
}

async function getRecentTRC20(address, limit = 10) {
  const url = `${TRONGRID_API}/v1/accounts/${address}/transactions/trc20?limit=${limit}&contract_address=${USDT}&order_by=block_timestamp,desc`;
  const { data } = await axios.get(url, { headers: tronHeaders });
  return data?.data || [];
}

// Health
app.get("/api/health", (req, res) => {
  res.json({ ok: true, TRONGRID_API: TRONGRID_API, usdt_contract: USDT });
});

// Core: wallet summary
app.get("/api/wallet/:address/summary", async (req, res) => {
  try {
    const address = req.params.address.trim();
    if (!isTronBase58(address)) {
      return res.status(400).json({ error: "Invalid TRON address (must start with T...)" });
    }

    // 1) USDT blacklist (on-chain)
    let blacklisted = await callBool("isBlackListed(address)", address, USDT, address);
    if (blacklisted === null) {
      // try alias if ABI name differs
      blacklisted = await callBool("getBlackListStatus(address)", address, USDT, address);
    }

    // 2) USDT balance (on-chain)
    const decimals = await getDecimals(); // expect 6
    const rawBal = await callUint("balanceOf(address)", address, USDT, address);
    const usdtBalance = Number(rawBal) / 10 ** decimals;

    // 3) Account snapshot (tx counts, created_at, TRC20 list)
    const acct = await getAccount(address);
    const createdAt = acct?.create_time || null;
    const trxSun = acct?.balance || 0;
    const trxBalance = Number(trxSun) / 1e6;

    // 4) Recent transfers (USDT only)
    const recent = await getRecentTRC20(address, 10);

    // 5) Risk score + status label
    // Simple, transparent heuristic for MVP:
    // - Blacklisted => 100 (Blacklisted)
    // - Else if usdtBalance > 0 and recent >= 10 => 60 (Needs Review)
    // - Else => 5 (Safe)
    let riskScore = 5;
    const reasons = [];
    let status = "Safe";
    if (blacklisted === true) {
      riskScore = 100;
      status = "Blacklisted";
      reasons.push("USDT contract reports this address is blacklisted");
    } else {
      if (usdtBalance > 0 && recent.length >= 10) {
        riskScore = 60;
        status = "Needs Review";
        reasons.push("Active USDT usage with frequent recent transfers");
      } else {
        reasons.push("No blacklist flags detected; low recent activity");
      }
    }

    // 6) Total USD (MVP: USDT + small TRX approximation)
    const totalUsd = usdtBalance + 0; // TRX ignored for USD here; tiny vs USDT

    // 7) Token balances list (MVP: include USDT + TRX only)
    const tokens = [
      { symbol: "USDT", name: "Tether USD", contract: USDT, decimals, balance: usdtBalance, usd: usdtBalance },
      { symbol: "TRX", name: "TRON", contract: "_", decimals: 6, balance: trxBalance, usd: null }
    ];

    // 8) “blacklisted timestamp” – USDT contract doesn’t expose historical timestamp.
    // Leave null for MVP (we can infer from first revert block later if needed).
    const blacklistTimestamp = blacklisted ? null : null;

    res.json({
      address,
      network: "TRON",
      status, // Safe | Needs Review | Blacklisted
      risk: { score: riskScore, reasons },
      totals: { usd: totalUsd },
      tokens,
      blacklisted,
      blacklist_timestamp: blacklistTimestamp,
      transactions: {
        trc20_recent: recent,
        count_returned: recent.length
      },
      meta: {
        created_at: createdAt,
        source: "TronGrid",
        note: "Totals are conservative; only USDT counted for USD"
      }
    });
  } catch (e) {
    console.error("summary error", e?.response?.data || e.message);
    res.status(500).json({ error: "Failed wallet summary", details: e?.response?.data || e.message });
  }
});

// UI root -> index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Pricing page
app.get("/pricing", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pricing.html"));
});

// Start
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`SEKURA – MVP running on http://localhost:${PORT}`);
});
