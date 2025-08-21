const addrInput = document.getElementById("addr");
const checkBtn = document.getElementById("checkBtn");
const result = document.getElementById("result");
const errEl = document.getElementById("error");
const themeToggle = document.getElementById("themeToggle");

themeToggle.addEventListener("click", () => {
  const html = document.documentElement;
  const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  localStorage.setItem("sekura-theme", next);
});

(function initTheme() {
  const saved = localStorage.getItem("sekura-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
})();

checkBtn.addEventListener("click", async () => {
  const address = addrInput.value.trim();
  errEl.classList.add("hidden");
  result.classList.add("hidden");
  result.innerHTML = "";

  if (!address || !address.startsWith("T")) {
    showErr("Please enter a valid TRON address (starts with T).");
    return;
  }

  try {
    const res = await fetch(`/api/wallet/${address}/summary`);
    if (!res.ok) {
      const msg = await res.json().catch(() => ({}));
      throw new Error(msg?.error || "Request failed");
    }
    const data = await res.json();
    renderCard(data);
  } catch (e) {
    showErr(e.message || "Something went wrong");
  }
});

function showErr(msg) {
  errEl.textContent = msg;
  errEl.classList.remove("hidden");
}

function badge(status) {
  const map = {
    "Safe": "badge green",
    "Needs Review": "badge yellow",
    "Blacklisted": "badge red"
  };
  return `<span class="${map[status] || "badge"}">${status}</span>`;
}

function upgradeCTA(text) {
  return `
    <div class="upgrade">
      <p>${text}</p>
      <a href="/pricing" class="btn primary">Upgrade Now</a>
    </div>
  `;
}

function renderCard(d) {
  const statusNote =
    d.status === "Safe" ? `<p class="muted">This wallet appears safe to transact with.</p>` :
    d.status === "Needs Review" ? upgradeCTA(`This wallet has suspicious activity. Get tailored recommendations on how to stay compliant and avoid future blacklisting by upgrading to the Paid Plan.`) :
    upgradeCTA(`This wallet is blacklisted. The full report reveals which contaminated wallets caused this. Unlock the full investigation in the Paid Plan.`);

  const tokensTable = d.tokens.map(t => `
    <tr>
      <td>${t.symbol}</td>
      <td class="muted">${t.name}</td>
      <td>${t.balance?.toLocaleString(undefined, {maximumFractionDigits: 6})}</td>
      <td>${t.usd != null ? `$${t.usd.toLocaleString(undefined, {maximumFractionDigits: 2})}` : "—"}</td>
    </tr>
  `).join("");

  const txRows = (d.transactions?.trc20_recent || []).map(tx => {
    const dir = tx.to === d.address ? "in" : (tx.from === d.address ? "out" : "other");
    const ts = tx.block_timestamp ? new Date(tx.block_timestamp).toLocaleString() : "—";
    const val = tx.value ? Number(tx.value) / (10 ** (tx.token_info?.decimals ?? 6)) : (tx.value_raw ? Number(tx.value_raw) : 0);
    return `
      <tr>
        <td>${ts}</td>
        <td>${dir}</td>
        <td>${(tx.token_info?.symbol || "USDT")}</td>
        <td>${val.toLocaleString(undefined, {maximumFractionDigits: 6})}</td>
        <td class="mono">${(tx.transaction_id || tx.txID || "").slice(0,8)}…</td>
      </tr>
    `;
  }).join("");

  const created = d.meta?.created_at ? new Date(d.meta.created_at).toLocaleString() : "—";

  result.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>${badge(d.status)} Wallet report</h2>
        <div class="score">
          <div class="ring">
            <span>${d.risk?.score ?? 0}</span>
          </div>
          <div class="muted">Risk Score</div>
        </div>
      </div>

      ${statusNote}

      <div class="grid">
        <div>
          <div class="label">Wallet Address</div>
          <div class="mono">${d.address}</div>
        </div>
        <div>
          <div class="label">Network</div>
          <div>TRON</div>
        </div>
        <div>
          <div class="label">Total Balance (USD)</div>
          <div>${d.totals?.usd != null ? `$${d.totals.usd.toLocaleString(undefined, {maximumFractionDigits: 2})}` : "—"}</div>
        </div>
        <div>
          <div class="label">Reason</div>
          <div class="muted">${(d.risk?.reasons || []).join("; ") || "—"}</div>
        </div>
        <div>
          <div class="label">Transaction Count (returned)</div>
          <div>${d.transactions?.count_returned ?? 0}</div>
        </div>
        <div>
          <div class="label">Wallet Creation</div>
          <div>${created}</div>
        </div>
        <div>
          <div class="label">Blacklist Timestamp</div>
          <div>${d.blacklist_timestamp ? new Date(d.blacklist_timestamp).toLocaleString() : "—"}</div>
        </div>
      </div>

      <h3>Token Balances</h3>
      <table class="table">
        <thead><tr><th>Symbol</th><th>Name</th><th>Balance</th><th>USD</th></tr></thead>
        <tbody>${tokensTable}</tbody>
      </table>

      <h3>Recent TRC-20 Transactions (USDT)</h3>
      <table class="table">
        <thead><tr><th>Time</th><th>Dir</th><th>Token</th><th>Amount</th><th>Tx</th></tr></thead>
        <tbody>${txRows || `<tr><td colspan="5" class="muted">No recent USDT transfers</td></tr>`}</tbody>
      </table>

      <div class="actions">
        <button class="btn" disabled title="Paid feature">Save Report</button>
        <button class="btn" disabled title="Paid feature">Export Report</button>
      </div>
    </div>
  `;
  result.classList.remove("hidden");
}
