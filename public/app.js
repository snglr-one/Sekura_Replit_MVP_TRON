async function submitCheck(address) {
  const out = document.getElementById("output");
  out.textContent = "Checking...";
  try {
    const res = await fetch("/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    out.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    out.textContent = `Error: ${e.message}`;
  }
}

document.getElementById("checkBtn")?.addEventListener("click", () => {
  const addr = document.getElementById("addr").value.trim();
  submitCheck(addr);
});
