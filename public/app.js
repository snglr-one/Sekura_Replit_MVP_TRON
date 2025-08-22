// Theme toggle
const themeToggle = document.getElementById("themeToggle");
function setTheme(mode){
  document.documentElement.setAttribute("data-theme", mode);
  localStorage.setItem("sekura-theme", mode);
  if(!themeToggle) return;
  [...themeToggle.querySelectorAll("button")].forEach(b=>b.classList.toggle("active", b.dataset.mode === mode));
}
(function(){ setTheme(localStorage.getItem("sekura-theme") || "light"); })();
themeToggle?.addEventListener("click", e=>{ const b=e.target.closest("button"); if(b) setTheme(b.dataset.mode); });

// Paywall modal
const paywall = document.getElementById("paywall");
function showPaywall(){ if(paywall) paywall.style.display = "flex"; }
document.getElementById("closePaywall")?.addEventListener("click", ()=> paywall.style.display = "none");
paywall?.addEventListener("click", e=>{ if(e.target===paywall) paywall.style.display="none"; });

// Shared elements
const addrInput = document.getElementById("addr");
const checkBtn  = document.getElementById("checkBtn");
const resultEl  = document.getElementById("result");
const errEl     = document.getElementById("error");

function showErr(msg){ if(!errEl) return; errEl.textContent = msg; errEl.classList.remove("hidden"); }
function clearErr(){ if(!errEl) return; errEl.classList.add("hidden"); errEl.textContent = ""; }

function statusBadge(status){
  const cls = status==="Blacklisted"?"red":status==="Needs Review"?"yellow":"green";
  return `<span class="badge ${cls}">${status}</span>`;
}
function ringColor(status){
  if(status==="Blacklisted") return "var(--red)";
  if(status==="Needs Review") return "var(--yellow)";
  return "var(--green)";
}
function riskRing(score, status){
  const pct = Math.max(0, Math.min(100, Number(score||0)));
  const deg = Math.round((pct/100)*360);
  const col = status==="Blacklisted" ? "var(--red)" : status==="Needs Review" ? "var(--yellow)" : "var(--green)";
  return `
  <div class="score">
    <div class="ring" style="background: conic-gradient(${col} ${deg}deg, transparent ${deg}deg);">
      <span>${pct}</span>
    </div>
    <div class="label">Risk</div>
  </div>`;
}

// New copy blocks
function resultCopy(status){
  if(status==="Blacklisted"){
    return `🚨 This wallet is blacklisted! The full report reveals which contaminated wallets caused this. Unlock the full investigation in a Paid Plan.`;
  }
  if(status==="Needs Review"){
    return `⚠️ This wallet has suspicious activity. Prevent getting Blacklisted by Upgrading and getting tailored recommendations on how to stay compliant.`;
  }
  return `✅ This wallet is Safe to interact with, however, it might not in the future. Protect yourself by upgrading and getting weekly alerts.`;
}

function upgradeBlock(){
  return `<div class="upgrade">
    <div class="muted" style="margin-bottom:8px">Upgrade to access full reports, history, exports, and alerts.</div>
    <a class="btn primary" href="#plans">Upgrade Now</a>
  </div>`;
}

function renderCard(d){
  if(!resultEl) return;

  const tokens = (d.tokens||[]).map(t=>`
    <tr>
      <td>${t.symbol}</td>
      <td class="muted">${t.name}</td>
      <td>${(t.balance??0).toLocaleString(undefined,{maximumFractionDigits:6})}</td>
      <td>${t.usd!=null ? `$${t.usd.toLocaleString(undefined,{maximumFractionDigits:2})}` : "—"}</td>
    </tr>`).join("");

  const txs = (d.transactions?.trc20_recent||[]).map(tx=>{
    const dir = tx.to === d.address ? "in" : (tx.from === d.address ? "out" : "other");
    const ts = tx.block_timestamp ? new Date(tx.block_timestamp).toLocaleString() : "—";
    const val = tx.value ? Number(tx.value)/(10**(tx.token_info?.decimals ?? 6)) : 0;
    return `<tr><td>${ts}</td><td>${dir}</td><td>${tx.token_info?.symbol||"USDT"}</td><td>${val.toLocaleString(undefined,{maximumFractionDigits:6})}</td><td class="mono">${(tx.transaction_id||tx.txID||"").slice(0,8)}…</td></tr>`;
  }).join("");

  const created = d.meta?.created_at ? new Date(d.meta.created_at).toLocaleString() : "—";

  resultEl.innerHTML = `
    <div class="card">
      <div class="card-head">
        ${riskRing(d.risk?.score ?? 0, d.status)}
      </div>

      <div class="status-wrap">
        ${statusBadge(d.status)}
        <div class="status-title">${d.status}</div>
      </div>

      <div class="upgrade">
        <p>${resultCopy(d.status)}</p>
        <a class="btn primary" href="#plans">Upgrade Now</a>
      </div>

      <div class="grid">
        <div><div class="label">Wallet Address</div><div class="mono">${d.address}</div></div>
        <div><div class="label">Network</div><div>TRON</div></div>
        <div><div class="label">Total Balance (USD)</div><div>${d.totals?.usd!=null?`$${d.totals.usd.toLocaleString(undefined,{maximumFractionDigits:2})}`:"—"}</div></div>
        <div><div class="label">Reason</div><div class="muted">${(d.risk?.reasons||[]).join("; ")||"—"}</div></div>
        <div><div class="label">Recent USDT transfers</div><div>${d.transactions?.count_returned ?? 0}</div></div>
        <div><div class="label">Wallet Creation</div><div>${created}</div></div>
        <div><div class="label">Blacklist Timestamp</div><div>${d.blacklist_timestamp?new Date(d.blacklist_timestamp).toLocaleString():"—"}</div></div>
      </div>

      <h3>Token Balances</h3>
      <table class="table">
        <thead><tr><th>Symbol</th><th>Name</th><th>Balance</th><th>USD</th></tr></thead>
        <tbody>${tokens || `<tr><td colspan="4" class="muted">No tokens</td></tr>`}</tbody>
      </table>

      <h3>Recent TRC‑20 Transactions (USDT)</h3>
      <table class="table">
        <thead><tr><th>Time</th><th>Dir</th><th>Token</th><th>Amount</th><th>Tx</th></tr></thead>
        <tbody>${txs || `<tr><td colspan="5" class="muted">No recent USDT transfers</td></tr>`}</tbody>
      </table>

      <div class="actions">
        <button class="btn" onclick="showPaywall()">Save Report</button>
        <button class="btn" onclick="showPaywall()">Export Report</button>
      </div>
    </div>
  `;
  resultEl.classList.remove("hidden");
}

async function runCheck(){
  const address = addrInput?.value.trim();
  if(!address || !address.startsWith("T")){ showErr("Please enter a valid TRON address (starts with T…)"); return; }
  clearErr(); resultEl?.classList.add("hidden"); if(resultEl) resultEl.innerHTML = "";
  try{
    const res = await fetch(`/api/wallet/${address}/summary`);
    if(!res.ok){ const msg = await res.json().catch(()=>({})); throw new Error(msg?.error || "Request failed"); }
    const data = await res.json();
    renderCard(data);
    setTimeout(()=>{ resultEl?.scrollIntoView({behavior:"smooth", block:"start"}); }, 50);
  }catch(e){ showErr(e.message || "Something went wrong"); }
}

checkBtn?.addEventListener("click", runCheck);
addrInput?.addEventListener("keydown", e=>{ if(e.key==="Enter") runCheck(); });

// Expose for sidebar buttons in dashboard
window.showPaywall = showPaywall;
