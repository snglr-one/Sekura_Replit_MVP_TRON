# SEKURA — MVP (TRON)

A tiny proof‑of‑concept web app that analyzes a TRON wallet (TRC‑20 focus) using **TronScan** public APIs. No private keys required.

## Quick Start (Replit or local)

1) Add your TronScan API key (optional but recommended for rate limits).  
   Header name: `TRON-PRO-API-KEY`

2) Replit:
- Create/import this repo
- In **Tools → Secrets**, add `TRONSCAN_API_KEY`
- Click **Run**

Local:
```bash
npm install
cp .env.sample .env   # put TRONSCAN_API_KEY if you have one
npm start
