// SEKURA – MVP (TRON) - Server
import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import TronWeb from "tronweb";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TRONGRID_API = process.env.TRONGRID_API || "https://api.trongrid.io";
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || "";
const tronHeaders = TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {};

const tronWeb = new TronWeb({ fullHost: TRONGRID_API, headers: tronHeaders });
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// Helpers
function isTronBase58(addr){ return typeof addr === "string" && addr.startsWith("T") && addr.length >= 26 && addr.length <= 36; }
function to20ByteHexFromBase58(addr){
  const hexWith41 = tronWeb.address.toHex(addr);
  if (!hexWith41 || !hexWith41.startsWith("41") || hexWith41.length !== 42) throw new Error("Invalid TRON address");
  return hexWith41.slice(2);
}
function pad64(hex){ return hex.padStart(64, "0"); }

async function triggerConstant({ contract, selector, paramHex64, ownerBase58 }){
  const { data } = await axios.post(
    `${TRONGRID_API}/wallet/triggerconstantcontract`,
    { owner_address: ownerBase58, contract_address: contract, function_selector: selector, parameter: paramHex64, visible: true },
    { headers: { "Content-Type": "application/json", ...tronHeaders } }
  );
  return data;
}
async function callBool(selector, owner, contract, addr){
  const a20 = to20ByteHexFromBase58(addr);
  const out = await triggerConstant({ contract, selector, paramHex64: pad64(a20), ownerBase58: owner });
  const r = out?.constant_result?.[0] || "";
  if (!r) return null;
  return r.endsWith("1");
}
async function callUint(selector, owner, contract, addr){
  const a20 = to20ByteHexFromBase58(addr);
  const out = await triggerConstant({ contract, selector, paramHex64: pad64(a20), ownerBase58: owner });
  const r = out?.constant_result?.[0] || "";
  if (!r) return 0n;
  return BigInt("0x" + r);
}
async function getDecimals(){
  try{
    const { data } = await axios.post(
      `${TRONGRID_API}/wallet/triggerconstantcontract`,
      { owner_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", contract_address: USDT, function_selector: "decimals()", visible: true },
      { headers: { "Content-Type": "application/json", ...tronHeaders } }
    );
    const r = data?.constant_result?.[0] || "000...006";
    return Number(BigInt("0x" + r));
  } catch { return 6; }
}
async function getAccount(address){
  const { data } = await axios.get(`${TRONGRID_API}/v1/accounts/${address}`, { headers: tronHeaders });
  return data?.data?.[0] || null;
}
async function getRecentTRC20(address, limit=10){
  const url = `${TRONGRID_API}/v1/accounts/${address}/transactions/trc20?limit=${limit}&contract_address=${USDT}&order_by=block_timestamp,desc`;
  const { data } = await axios.get(url, { headers: tronHeaders });
  return data?.data || [];
}

// API
app.get("/api/health", (req,res)=> res.json({ ok:true, TRONGRID_API, usdt_contract: USDT }));

app.get("/api/wallet/:address/summary", async (req,res)=>{
  try{
    const address = req.params.address.trim();
    if(!isTronBase58(address)) return res.status(400).json({ error: "Invalid TRON address (must start with T)" });

    let blacklisted = await callBool("isBlackListed(address)", address, USDT, address);
    if (blacklisted === null) blacklisted = await callBool("getBlackListStatus(address)", address, USDT, address);

    const decimals = await getDecimals();
    const raw = await callUint("balanceOf(address)", address, USDT, address);
    const usdtBalance = Number(raw) / 10 ** decimals;

    const acct = await getAccount(address);
    const createdAt = acct?.create_time || null;
    const trxSun = acct?.balance || 0;
    const trxBalance = Number(trxSun) / 1e6;

    const recent = await getRecentTRC20(address, 10);

    let status = "Safe", riskScore = 5;
    const reasons = [];
    if (blacklisted) {
      status = "Blacklisted"; riskScore = 100;
      reasons.push("USDT contract reports this address is blacklisted");
    } else if (usdtBalance > 0 && recent.length >= 10) {
      status = "Needs Review"; riskScore = 60;
      reasons.push("Frequent recent USDT transfers suggest elevated risk");
    } else {
      reasons.push("No blacklist flags detected; low recent activity");
    }

    res.json({
      address,
      network: "TRON",
      status,
      risk: { score: riskScore, reasons },
      totals: { usd: usdtBalance },
      tokens: [
        { symbol: "USDT", name: "Tether USD", contract: USDT, decimals, balance: usdtBalance, usd: usdtBalance },
        { symbol: "TRX", name: "TRON", contract: "_", decimals: 6, balance: trxBalance, usd: null }
      ],
      blacklisted,
      blacklist_timestamp: null,
      transactions: { trc20_recent: recent, count_returned: recent.length },
      meta: { created_at: createdAt, source: "TronGrid" }
    });
  }catch(e){
    console.error("summary error", e?.response?.data || e.message);
    res.status(500).json({ error: "Failed wallet summary", details: e?.response?.data || e.message });
  }
});

// Pages
app.get("/", (req,res)=> res.sendFile(path.join(__dirname,"public","index.html")));
app.get("/pricing", (req,res)=> res.sendFile(path.join(__dirname,"public","pricing.html"))); // optional
app.get("/auth", (req,res)=> res.sendFile(path.join(__dirname,"public","auth.html")));
app.get("/app", (req,res)=> res.sendFile(path.join(__dirname,"public","dashboard.html")));

const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT,"0.0.0.0",()=> console.log(`SEKURA running on http://localhost:${PORT}`));
