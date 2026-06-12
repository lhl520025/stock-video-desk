let state = {
  stocks: [],
  summaries: [],
  uploads: [],
};

const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

function formatAmount(value) {
  if (value === undefined || value === null || value === "-" || Number.isNaN(Number(value))) return "--";
  const number = Number(value);
  if (number >= 100000000) return `${money.format(number / 100000000)}亿`;
  if (number >= 10000) return `${money.format(number / 10000)}万`;
  return money.format(number);
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (number >= 1024 * 1024 * 1024) return `${money.format(number / 1024 / 1024 / 1024)} GB`;
  if (number >= 1024 * 1024) return `${money.format(number / 1024 / 1024)} MB`;
  if (number >= 1024) return `${money.format(number / 1024)} KB`;
  return `${number} B`;
}

function formatValue(value, suffix = "") {
  if (value === undefined || value === null || value === "-") return "--";
  return `${value}${suffix}`;
}

function guessMarket(code) {
  if (String(code).startsWith("6")) return "SH";
  if (String(code).startsWith("8") || String(code).startsWith("4")) return "BJ";
  return "SZ";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (response.status === 401) {
    window.location.href = "/login.html";
    throw new Error("请先登录");
  }
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function renderMetrics() {
  $("#stockCount").textContent = state.stocks.length;
  $("#pendingCount").textContent = state.summaries.filter((item) => item.status !== "已完成").length;
  const quoteTimes = state.stocks.map((item) => item.quote?.updatedAt).filter(Boolean).sort();
  $("#lastUpdated").textContent = quoteTimes.length ? new Date(quoteTimes.at(-1)).toLocaleTimeString("zh-CN") : "--";
  $("#summaryStatus").textContent = `${state.summaries.length} 条记录`;
  $("#uploadCount").textContent = `${state.uploads.length} 个文件`;
  $("#uploadCountInline").textContent = `${state.uploads.length} 个文件`;
}

function renderSummaries() {
  const list = $("#summaryList");
  const template = $("#summaryTemplate");
  list.replaceChildren();

  if (!state.summaries.length) {
    list.innerHTML = '<p class="muted">还没有视频摘要。</p>';
    return;
  }

  for (const summary of state.summaries) {
    const node = template.content.cloneNode(true);
    node.querySelector("h3").textContent = `${summary.date} ${summary.title}`;
    node.querySelector(".source").textContent = summary.source || "未填写来源";
    node.querySelector(".badge").textContent = summary.status || "待整理";
    node.querySelector(".market").textContent = summary.marketView || "待补充";
    node.querySelector(".points").textContent = summary.keyPoints || "待补充";
    node.querySelector(".actions-text").textContent = summary.actionItems || "待补充";
    list.appendChild(node);
  }
}

function renderUploads() {
  const list = $("#uploadList");
  list.replaceChildren();

  if (!state.uploads.length) {
    list.innerHTML = '<p class="muted">还没有上传资料。</p>';
    return;
  }

  for (const upload of state.uploads) {
    const item = document.createElement("article");
    item.className = "upload-item";
    item.innerHTML = `
      <strong>${upload.title || upload.originalName}</strong>
      <div class="upload-meta">
        <span>${upload.originalName || ""}</span>
        <span>${formatBytes(upload.size)}</span>
        <span>${upload.mimeType || "unknown"}</span>
        <span>${upload.status || "待处理"}</span>
      </div>
      <p class="muted">${upload.note || "上传后等待本机 Agent 分析并同步结果。"}</p>
    `;
    list.appendChild(item);
  }
}

function setActiveNav(sectionId) {
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.section === sectionId);
  });
}

function setupNavigation() {
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => setActiveNav(link.dataset.section));
  });

  const sections = ["overview", "uploads", "summaries", "watchlist", "stockForm"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setActiveNav(visible.target.id);
    },
    { rootMargin: "-20% 0px -65% 0px", threshold: [0.1, 0.35, 0.6] },
  );

  sections.forEach((section) => observer.observe(section));
}

function renderStocks() {
  const rows = $("#stockRows");
  rows.replaceChildren();

  if (!state.stocks.length) {
    rows.innerHTML = '<tr><td colspan="11" class="muted">股票池为空。</td></tr>';
    return;
  }

  for (const stock of state.stocks) {
    const quote = stock.quote || {};
    const changeClass = Number(quote.changePct) > 0 ? "up" : Number(quote.changePct) < 0 ? "down" : "";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${stock.code}</strong><span class="muted">${stock.market || guessMarket(stock.code)}</span></td>
      <td><strong>${stock.name}</strong><span class="muted">${stock.sector || ""}</span></td>
      <td>${formatValue(quote.price)}</td>
      <td class="${changeClass}">${formatValue(quote.changePct, "%")}</td>
      <td>${formatAmount(quote.amount)}</td>
      <td>${formatValue(quote.turnoverRate, "%")}</td>
      <td>${stock.buyZone || "--"}</td>
      <td>${stock.stopLoss || "--"}</td>
      <td>${stock.target || "--"}</td>
      <td>${stock.status || "观察"}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-edit="${stock.id}">编辑</button>
          <button type="button" data-delete="${stock.id}">删除</button>
        </div>
      </td>
    `;
    rows.appendChild(row);
  }
}

function render() {
  renderMetrics();
  renderSummaries();
  renderUploads();
  renderStocks();
}

async function loadData() {
  const payload = await api("/api/data");
  const uploadsPayload = await api("/api/uploads");
  state = { ...payload, uploads: uploadsPayload.uploads || [] };
  render();
}

function formToObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function fillStockForm(stock) {
  const form = $("#stockForm");
  for (const element of form.elements) {
    if (!element.name) continue;
    element.value = stock[element.name] || "";
  }
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.addEventListener("click", async (event) => {
  const editId = event.target.dataset?.edit;
  const deleteId = event.target.dataset?.delete;

  if (editId) {
    const stock = state.stocks.find((item) => item.id === editId);
    if (stock) fillStockForm(stock);
  }

  if (deleteId && confirm("确认从股票池删除？")) {
    await api(`/api/stocks/${encodeURIComponent(deleteId)}`, { method: "DELETE" });
    await loadData();
  }
});

$("#uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $("#uploadMessage");
  const button = form.querySelector("button");
  message.textContent = "正在上传...";
  button.disabled = true;
  try {
    const response = await fetch("/api/uploads", { method: "POST", body: new FormData(form) });
    if (response.status === 401) {
      window.location.href = "/login.html";
      return;
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "上传失败");
    form.reset();
    message.textContent = "上传成功，已加入资料库。";
    await loadData();
  } catch (error) {
    message.textContent = `上传失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$("#stockForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const stock = formToObject(form);
  stock.market = stock.market || guessMarket(stock.code);
  await api("/api/stocks", { method: "POST", body: JSON.stringify(stock) });
  form.reset();
  await loadData();
});

$("#summaryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const summary = formToObject(form);
  summary.status = "已记录";
  summary.mentionedStocks = Array.from(new Set(`${summary.keyPoints} ${summary.actionItems}`.match(/\b\d{6}\b/g) || []));
  await api("/api/summaries", { method: "POST", body: JSON.stringify(summary) });
  form.reset();
  await loadData();
});

$("#refreshQuotes").addEventListener("click", async () => {
  const button = $("#refreshQuotes");
  const message = $("#quoteMessage");
  button.disabled = true;
  button.textContent = "刷新中";
  message.textContent = "正在请求实时行情...";
  try {
    const payload = await api("/api/quotes/refresh", { method: "POST" });
    state.stocks = payload.stocks;
    message.textContent = payload.refreshed
      ? `行情已刷新：${payload.refreshed} 只`
      : `行情源暂时不可用，已保留本地数据${payload.errors?.[0] ? `：${payload.errors[0]}` : ""}`;
    render();
  } catch (error) {
    message.textContent = `刷新失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "刷新行情";
  }
});

$("#reloadData").addEventListener("click", loadData);

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

setupNavigation();

loadData().catch((error) => {
  document.body.innerHTML = `<main><section class="panel"><h1>加载失败</h1><p>${error.message}</p></section></main>`;
});
