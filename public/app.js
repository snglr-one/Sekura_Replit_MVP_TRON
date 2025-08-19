const addrInput = document.getElementById('addr');
const analyzeBtn = document.getElementById('analyze');
const results = document.getElementById('results');
const summaryCard = document.getElementById('summaryCard');
const tokensCard = document.getElementById('tokensCard');
const txCard = document.getElementById('txCard');

function fmt(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

function tsToDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString();
}

async function analyze() {
  const address = addrInput.value.trim();
  if (!address) { alert('Please paste a TRON address'); return; }
  analyzeBtn.disabled = true; analyzeBtn.textContent = 'Analyzing...';
  try {
    const res = await fetch(`/api/address/${encodeURIComponent(address)}/summary`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    render(data);
  } catch (e) {
    alert(e.message);
  } finally {
    analyzeBtn.disabled = false; analyzeBtn.textContent = 'Analyze';
  }
}

function render(data) {
  results.style.display = 'grid';
  // Summary
  const totalUsd = data.totals?.totalAssetInUsd;
  summaryCard.innerHTML = `
    <h3>Summary</h3>
    <div class="muted">${data.address}</div>
    <p><span class="pill">TRX</span> Balance: <b>${fmt(data.trxBalance, 6)}</b></p>
    <p>Total Assets (USD est.): <b>${totalUsd ? '$' + fmt(totalUsd, 2) : '-'}</b></p>
    <p>Tx Count: <b>${fmt(data.meta?.totalTransactionCount || 0, 0)}</b></p>
    <p>Latest Activity: <b>${tsToDate(data.meta?.latestOperationTime)}</b></p>
    <h4>Risk</h4>
    <p>Score: <b>${fmt(data.risk?.score, 0)}/100</b></p>
    <ul>
      ${(data.risk?.reasons || []).map(r => `<li class="${r.toLowerCase().includes('black') ? 'danger':''}">${r}</li>`).join('') || '<li>No obvious risk flags from TronScan</li>'}
    </ul>
    <div class="muted">Powered by TronScan Security flags.</div>
  `;

  // Tokens
  const rows = (data.tokens || []).map(t => `
    <tr>
      <td>${t.tokenAbbr || t.tokenName}</td>
      <td>${fmt(t.balanceFormatted, 6)}</td>
      <td>${t.tokenType.toUpperCase()}</td>
      <td>${t.assetInUsd ? '$' + fmt(t.assetInUsd, 2) : '-'}</td>
    </tr>
  `).join('');
  tokensCard.innerHTML = `
    <h3>Token Holdings</h3>
    <table>
      <thead><tr><th>Token</th><th>Balance</th><th>Type</th><th>USD</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No tokens found</td></tr>'}</tbody>
    </table>
  `;

  // Transfers
  const txRows = (data.recentTransfers || []).map(x => `
    <tr>
      <td><code>${x.txHash.slice(0,10)}...</code></td>
      <td>${tsToDate(x.timestamp)}</td>
      <td>${x.direction}</td>
      <td>${fmt(x.valueFormatted, 6)} ${x.tokenAbbr || ''}</td>
      <td><small>from</small> ${x.from.slice(0,6)}... <small>to</small> ${x.to.slice(0,6)}...</td>
    </tr>
  `).join('');
  txCard.innerHTML = `
    <h3>Recent TRC-20 Transfers</h3>
    <table>
      <thead><tr><th>Tx</th><th>Time</th><th>Dir</th><th>Amount</th><th>Path</th></tr></thead>
      <tbody>${txRows || '<tr><td colspan="5" class="muted">No recent TRC-20 transfers</td></tr>'}</tbody>
    </table>
  `;
}

analyzeBtn.addEventListener('click', analyze);
addrInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });
