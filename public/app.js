/* THEME TOGGLE */
const root = document.documentElement;
document.getElementById('toggle-light')?.addEventListener('click', ()=>{
  root.setAttribute('data-theme','light');
  document.getElementById('toggle-light').classList.add('active');
  document.getElementById('toggle-dark').classList.remove('active');
});
document.getElementById('toggle-dark')?.addEventListener('click', ()=>{
  root.setAttribute('data-theme','dark');
  document.getElementById('toggle-dark').classList.add('active');
  document.getElementById('toggle-light').classList.remove('active');
});

/* PAYWALL MODAL */
const paywall = document.getElementById('paywall');
document.getElementById('closePaywall')?.addEventListener('click', ()=> paywall.style.display='none');
const openPaywall = ()=> { paywall.style.display='flex'; };

/* MOCK: your server endpoint should fill these fields */
async function checkAddress(addr){
  // Replace fetch with your real endpoint (e.g., /api/check?address=...)
  const res = await fetch(`/api/check?address=${encodeURIComponent(addr)}`);
  if(!res.ok) throw new Error('API error');
  return res.json();
}

/* Helpers */
const fmt = (n)=> new Intl.NumberFormat().format(n);
const tsfmt = (n)=> n ? new Date(n).toLocaleString() : '—';

/* Risk color mapping */
function statusToColors(status){
  if(status==='Blacklisted') return {pill:'red', ring:'#EF4444'};
  if(status==='Needs Review') return {pill:'yellow', ring:'#F5A524'};
  return {pill:'green', ring:'#19C37D'}; // Safe
}

/* Copy per status */
function statusMessage(status){
  if(status==='Blacklisted'){
    return '🚨 This wallet is blacklisted! The full report reveals which contaminated wallets caused this. Unlock the full investigation in a Paid Plan.';
  }
  if(status==='Needs Review'){
    return '⚠️ This wallet has suspicious activity. Prevent getting Blacklisted by Upgrading and getting tailored recommendations on how to stay compliant.';
  }
  return '✅ This wallet is Safe to interact with, however, it might not in the future. Protect yourself by upgrading and getting weekly alerts.';
}

/* Render Result Card (matches your screenshot + tweaks) */
function renderCard(data){
  const { status, riskScore, reason, isBlacklisted, blacklistTimestamp,
          address, network='TRON', totalUsd=0,
          createdAt, recentUsdtTransfers=0, tokenBalances=[], recentTrc20=[] } = data;

  const { pill, ring } = statusToColors(status);

  // Inline style variable for ring color
  const ringStyle = `--ringColor:${ring}`;

  const tokensRows = (tokenBalances || []).map(t => `
    <tr>
      <td>${t.symbol || ''}</td>
      <td>${t.name || ''}</td>
      <td style="text-align:right">${t.balance != null ? fmt(t.balance) : '—'}</td>
      <td style="text-align:right">${t.usd != null ? ('$'+fmt(t.usd)) : '—'}</td>
    </tr>
  `).join('') || `<tr><td colspan="4" class="muted">No tokens</td></tr>`;

  const txRows = (recentTrc20 || []).map(tx => `
    <tr>
      <td>${txfmt(tx.time)}</td>
      <td>${tx.dir || ''}</td>
      <td>${tx.token || ''}</td>
      <td style="text-align:right">${tx.amount != null ? fmt(tx.amount) : '—'}</td>
      <td class="mono">${(tx.hash || '').slice(0,8)}…</td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="muted">No recent USDT transfers</td></tr>`;

  return `
  <div class="card">
    <div class="score" style="${ringStyle}">
      <div class="ring"><span>${riskScore != null ? riskScore : '—'}</span></div>
      <div class="label">Risk Score</div>
    </div>

    <!-- Centered wide pill -->
    <div class="status-wrap">
      <div class="pill ${pill}">${status}</div>
    </div>

    <!-- Callout -->
    <div class="callout">
      <div class="center">
        <div>${statusMessage(status)}</div>
        <a href="#plans" class="btn primary">Upgrade Now</a>
      </div>
    </div>

    <!-- Meta grid -->
    <div class="grid">
      <div>
        <div class="label">Wallet Address</div>
        <div class="mono">${address}</div>

        <div class="label" style="margin-top:10px">Reason</div>
        <div>${reason || (isBlacklisted ? 'USDT contract reports this address is blacklisted' : '—')}</div>

        <div class="label" style="margin-top:10px">Blacklist Timestamp</div>
        <div>${tsfmt(blacklistTimestamp)}</div>
      </div>
      <div>
        <div class="label">Network</div>
        <div>${network}</div>

        <div class="label" style="margin-top:10px">Recent USDT transfers</div>
        <div>${fmt(recentUsdtTransfers || 0)}</div>
      </div>
      <div>
        <div class="label">Total Balance (USD)</div>
        <div>$${fmt(totalUsd || 0)}</div>

        <div class="label" style="margin-top:10px">Wallet Creation</div>
        <div>${tsfmt(createdAt)}</div>
      </div>
    </div>

    <!-- Token balances -->
    <h3 style="text-align:center;margin-top:12px">Token Balances</h3>
    <table class="table">
      <thead><tr><th>Symbol</th><th>Name</th><th>Balance</th><th>USD</th></tr></thead>
      <tbody>${tokensRows}</tbody>
    </table>

    <!-- Recent USDT TRC-20 -->
    <h3 style="text-align:center;margin-top:18px">Recent TRC-20 Transactions (USDT)</h3>
    <table class="table">
      <thead><tr><th>Time</th><th>Dir</th><th>Token</th><th>Amount</th><th>Tx</th></tr></thead>
      <tbody>${txRows}</tbody>
    </table>

    <div class="actions">
      <button id="saveReport" class="btn">Save Report</button>
      <button id="exportReport" class="btn">Export Report</button>
    </div>
  </div>
  `;
}

/* Mount & events */
const resultEl = document.getElementById('result');
document.getElementById('checkBtn')?.addEventListener('click', async ()=>{
  const addr = document.getElementById('addr').value.trim();
  if(!addr){ alert('Enter a wallet address'); return; }
  try{
    const data = await checkAddress(addr);
    resultEl.innerHTML = renderCard(data);

    // Wire paywall buttons
    document.getElementById('saveReport')?.addEventListener('click', openPaywall);
    document.getElementById('exportReport')?.addEventListener('click', openPaywall);
  }catch(e){
    resultEl.innerHTML = `<div class="card"><div class="error">Error: ${e.message}</div></div>`;
  }
});

/* Optional: demo rendering while backend is wired */
if(!window.__NO_DEMO__){
  const demo = {
    status: 'Blacklisted',
    riskScore: 100,
    isBlacklisted: true,
    reason: 'USDT contract reports this address is blacklisted',
    blacklistTimestamp: null,
    address: 'TEe8Jma9irkHGAv77s5LxjmL1AboRnorPJ',
    network: 'TRON',
    totalUsd: 225000,
    recentUsdtTransfers: 2,
    createdAt: 1691768340000, // example
    tokenBalances: [
      { symbol: 'USDT', name:'Tether USD', balance: 225000, usd: 225000 },
      { symbol: 'TRX',  name:'TRON',      balance: 4.679288, usd: null }
    ],
    recentTrc20: [
      { time: 1722944574000, dir:'in', token:'USDT', amount:223000, hash:'8496332b...' },
      { time: 1722943443000, dir:'in', token:'USDT', amount:2000,   hash:'0ed726f8...' }
    ]
  };
  resultEl.innerHTML = renderCard(demo);
  document.getElementById('saveReport')?.addEventListener('click', openPaywall);
  document.getElementById('exportReport')?.addEventListener('click', openPaywall);
}
