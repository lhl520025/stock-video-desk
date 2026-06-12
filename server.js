const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const PORT = Number(process.env.PORT || 5173);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret";
let dbPool = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const files = {
    "stocks.json": [],
    "summaries.json": [],
    "uploads.json": [],
  };

  for (const [name, fallback] of Object.entries(files)) {
    const file = path.join(DATA_DIR, name);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    }
  }
}

function safeFilename(name) {
  return String(name || "upload.bin")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 160);
}

function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const Busboy = require("busboy");
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    });
    const fields = {};
    const files = [];
    const writes = [];

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (fieldName, file, info) => {
      const originalName = info.filename || "upload.bin";
      const id = `upload-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
      const storedName = `${id}-${safeFilename(originalName)}`;
      const relativePath = `uploads/${storedName}`;
      const absolutePath = path.join(DATA_DIR, relativePath);
      let size = 0;
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      const writeStream = fs.createWriteStream(absolutePath);
      file.on("data", (chunk) => {
        size += chunk.length;
      });
      file.pipe(writeStream);
      writes.push(
        new Promise((writeResolve, writeReject) => {
          writeStream.on("finish", () => {
            files.push({
              id,
              fieldName,
              originalName,
              storedName,
              path: relativePath,
              mimeType: info.mimeType || "application/octet-stream",
              size,
            });
            writeResolve();
          });
          writeStream.on("error", writeReject);
          file.on("error", writeReject);
        }),
      );
    });

    busboy.on("finish", async () => {
      try {
        await Promise.all(writes);
        resolve({ fields, files });
      } catch (error) {
        reject(error);
      }
    });
    busboy.on("error", reject);
    req.pipe(busboy);
  });
}

function readJson(name) {
  const file = path.join(DATA_DIR, name);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(name, value) {
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

async function initDatabase() {
  if (!process.env.DB_HOST) return;
  const mysql = require("mysql2/promise");
  dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 5,
    charset: "utf8mb4",
  });

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS app_documents (
      name VARCHAR(64) PRIMARY KEY,
      data JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const name of ["stocks.json", "summaries.json", "uploads.json"]) {
    const [rows] = await dbPool.execute("SELECT name FROM app_documents WHERE name = ?", [name]);
    if (!rows.length) {
      await dbPool.execute("INSERT INTO app_documents (name, data) VALUES (?, CAST(? AS JSON))", [
        name,
        JSON.stringify(readJson(name)),
      ]);
    }
  }
}

async function readData(name) {
  if (!dbPool) return readJson(name);
  const [rows] = await dbPool.execute("SELECT data FROM app_documents WHERE name = ?", [name]);
  if (!rows.length) return [];
  return typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
}

async function writeData(name, value) {
  writeJson(name, value);
  if (!dbPool) return;
  await dbPool.execute(
    "INSERT INTO app_documents (name, data) VALUES (?, CAST(? AS JSON)) ON DUPLICATE KEY UPDATE data = VALUES(data)",
    [name, JSON.stringify(value)],
  );
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function signSession(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isAuthenticated(req) {
  if (!ADMIN_PASSWORD) return true;
  const cookie = parseCookies(req).stock_desk_session || "";
  const [value, signature] = cookie.split(".");
  if (value !== "authenticated" || !signature) return false;
  return timingSafeEqualText(signature, signSession(value));
}

function setSessionCookie(res) {
  const value = "authenticated";
  const cookie = `${value}.${signSession(value)}`;
  res.setHeader("Set-Cookie", `stock_desk_session=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "stock_desk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function requireAgentToken(req, res) {
  const expected = process.env.LOCAL_AGENT_TOKEN;
  if (!expected) return true;
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (token === expected) return true;
  sendJson(res, 401, { error: "Unauthorized" });
  return false;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, value) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(value);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function stockToSecid(stock) {
  const code = String(stock.code || "").trim();
  if (!code) return "";
  if (stock.market === "SH" || code.startsWith("6")) return `1.${code}`;
  if (stock.market === "SZ" || code.startsWith("0") || code.startsWith("3")) return `0.${code}`;
  if (stock.market === "BJ" || code.startsWith("8") || code.startsWith("4")) return `0.${code}`;
  return `0.${code}`;
}

function normalizeEastMoney(item) {
  return {
    code: item.f12,
    name: item.f14,
    price: item.f2,
    changePct: item.f3,
    change: item.f4,
    volume: item.f5,
    amount: item.f6,
    high: item.f15,
    low: item.f16,
    open: item.f17,
    previousClose: item.f18,
    turnoverRate: item.f8,
    pe: item.f9,
    marketCap: item.f20,
    updatedAt: new Date().toISOString(),
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? require("https") : require("http");
    const req = lib.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
  });
}

async function refreshQuotes() {
  const stocks = await readData("stocks.json");
  const secids = stocks.map(stockToSecid).filter(Boolean);
  if (!secids.length) return [];

  const fields = [
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f8",
    "f9",
    "f12",
    "f14",
    "f15",
    "f16",
    "f17",
    "f18",
    "f20",
  ].join(",");

  const quoteMap = new Map();
  const errors = [];
  for (let index = 0; index < secids.length; index += 12) {
    const batch = secids.slice(index, index + 12).join(",");
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${fields}&secids=${encodeURIComponent(batch)}`;
    try {
      const payload = await fetchJson(url);
      for (const item of payload.data?.diff || []) {
        quoteMap.set(String(item.f12), normalizeEastMoney(item));
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  const nextStocks = stocks.map((stock) => ({
    ...stock,
    quote: quoteMap.get(String(stock.code)) || stock.quote || null,
  }));
  await writeData("stocks.json", nextStocks);
  return { stocks: nextStocks, refreshed: quoteMap.size, errors };
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    const type = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/login" && req.method === "POST") {
    const payload = await readBody(req);
    if (!ADMIN_PASSWORD || timingSafeEqualText(payload.password || "", ADMIN_PASSWORD)) {
      setSessionCookie(res);
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 401, { error: "密码错误" });
    }
    return;
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/session" && req.method === "GET") {
    sendJson(res, 200, { authenticated: isAuthenticated(req) });
    return;
  }

  if (pathname === "/api/import-analysis" && req.method === "POST") {
    if (!requireAgentToken(req, res)) return;
    const payload = await readBody(req);
    const now = new Date().toISOString();
    const stocks = await readData("stocks.json");
    const summaries = await readData("summaries.json");

    const summary = {
      id: payload.id || `analysis-${payload.date || now.slice(0, 10)}-${Date.now()}`,
      date: payload.date || now.slice(0, 10),
      title: payload.title || payload.source || "本机分析结果",
      source: payload.source || "",
      status: "已导入",
      marketView: payload.marketView || payload.summary || "",
      keyPoints: payload.keyPoints || "",
      actionItems: payload.actionItems || "",
      mentionedStocks: Array.isArray(payload.stocks) ? payload.stocks.map((stock) => String(stock.code || "")) : [],
      createdAt: now,
      updatedAt: now,
    };
    summaries.unshift(summary);

    for (const stock of payload.stocks || []) {
      const code = String(stock.code || "").trim();
      if (!code) continue;
      const next = {
        id: stock.id || `agent-${code}`,
        code,
        name: stock.name || "",
        market: stock.market || (code.startsWith("6") ? "SH" : "SZ"),
        sector: stock.sector || "",
        reason: stock.reason || "",
        buyZone: stock.buyZone || "",
        stopLoss: stock.stopLoss || "",
        target: stock.target || "",
        positionPlan: stock.positionPlan || "",
        risk: stock.risk || "",
        status: stock.status || "观察",
        source: payload.source || stock.source || "",
        sourceDate: payload.date || stock.sourceDate || "",
        createdAt: stock.createdAt || now,
        updatedAt: now,
        quote: stock.quote || null,
      };
      const index = stocks.findIndex((item) => item.code === code);
      if (index >= 0) stocks[index] = { ...stocks[index], ...next, quote: stocks[index].quote || null };
      else stocks.unshift(next);
    }

    await writeData("summaries.json", summaries);
    await writeData("stocks.json", stocks);
    sendJson(res, 200, { ok: true, summary, stocks: payload.stocks?.length || 0 });
    return;
  }

  if (!isAuthenticated(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (pathname === "/api/data" && req.method === "GET") {
    sendJson(res, 200, {
      stocks: await readData("stocks.json"),
      summaries: await readData("summaries.json"),
    });
    return;
  }

  if (pathname === "/api/stocks" && req.method === "POST") {
    const stock = await readBody(req);
    const stocks = await readData("stocks.json");
    const now = new Date().toISOString();
    const next = {
      id: stock.id || `${stock.code}-${Date.now()}`,
      code: String(stock.code || "").trim(),
      name: String(stock.name || "").trim(),
      market: stock.market || "SZ",
      sector: stock.sector || "",
      reason: stock.reason || "",
      buyZone: stock.buyZone || "",
      stopLoss: stock.stopLoss || "",
      target: stock.target || "",
      positionPlan: stock.positionPlan || "",
      risk: stock.risk || "",
      status: stock.status || "观察",
      createdAt: stock.createdAt || now,
      updatedAt: now,
      quote: stock.quote || null,
    };
    const index = stocks.findIndex((item) => item.id === next.id || item.code === next.code);
    if (index >= 0) stocks[index] = { ...stocks[index], ...next };
    else stocks.unshift(next);
    await writeData("stocks.json", stocks);
    sendJson(res, 200, next);
    return;
  }

  if (pathname.startsWith("/api/stocks/") && req.method === "DELETE") {
    const id = decodeURIComponent(pathname.split("/").pop());
    const stocks = (await readData("stocks.json")).filter((stock) => stock.id !== id);
    await writeData("stocks.json", stocks);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/summaries" && req.method === "POST") {
    const summary = await readBody(req);
    const summaries = await readData("summaries.json");
    const now = new Date().toISOString();
    const next = {
      id: summary.id || `video-${Date.now()}`,
      date: summary.date || now.slice(0, 10),
      title: summary.title || "未命名视频",
      source: summary.source || "",
      status: summary.status || "待整理",
      marketView: summary.marketView || "",
      keyPoints: summary.keyPoints || "",
      actionItems: summary.actionItems || "",
      mentionedStocks: Array.isArray(summary.mentionedStocks) ? summary.mentionedStocks : [],
      createdAt: summary.createdAt || now,
      updatedAt: now,
    };
    const index = summaries.findIndex((item) => item.id === next.id);
    if (index >= 0) summaries[index] = { ...summaries[index], ...next };
    else summaries.unshift(next);
    await writeData("summaries.json", summaries);
    sendJson(res, 200, next);
    return;
  }

  if (pathname === "/api/uploads" && req.method === "GET") {
    sendJson(res, 200, { uploads: await readData("uploads.json") });
    return;
  }

  if (pathname === "/api/uploads" && req.method === "POST") {
    const { fields, files } = await parseUpload(req);
    const uploads = await readData("uploads.json");
    const now = new Date().toISOString();
    const nextUploads = files.map((file) => ({
      ...file,
      title: fields.title || file.originalName,
      note: fields.note || "",
      status: "待本机分析",
      createdAt: now,
      updatedAt: now,
    }));
    uploads.unshift(...nextUploads);
    await writeData("uploads.json", uploads);
    sendJson(res, 200, { ok: true, uploads: nextUploads });
    return;
  }

  if (pathname === "/api/quotes/refresh" && req.method === "POST") {
    try {
      const result = await refreshQuotes();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 200, { stocks: await readData("stocks.json"), refreshed: 0, errors: [error.message] });
    }
    return;
  }

  sendJson(res, 404, { error: "API not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    if (!isAuthenticated(req) && url.pathname !== "/login.html") {
      redirect(res, "/login.html");
      return;
    }
    if (isAuthenticated(req) && url.pathname === "/login.html") {
      redirect(res, "/");
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

async function start() {
  ensureDataFiles();
  await initDatabase();
  server.listen(PORT, () => {
    console.log(`Stock video desk running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
