// server.js (root)
// Cloud Run-ready Express server:
// - Serves your static UIs: / (storefront), /apps/dealer, /apps/admin
// - Google Sheets as DB (one spreadsheet, dealer-per-tab model)
// - GCS signed upload URLs to bucket samplemedia1 (env MEDIA_BUCKET)
// - Admin + Dealer auth via Cloud Run env vars + passcode hashes

const express = require("express");
const path = require("path");
const crypto = require("crypto");

// Google APIs
const { google } = require("googleapis");

// GCS
const { Storage } = require("@google-cloud/storage");

const app = express();

// ---------- Env ----------
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "adminpytch");
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "123456");

const JWT_SECRET = String(process.env.JWT_SECRET || "dev-secret-change-me");
const GOOGLE_SHEET_ID = String(process.env.GOOGLE_SHEET_ID || ""); // REQUIRED for sheets features
const MEDIA_BUCKET = String(process.env.MEDIA_BUCKET || "samplemedia1");
const GCS_PUBLIC_BASE = String(process.env.GCS_PUBLIC_BASE || "https://storage.googleapis.com");

// Dealer sheet layout
const DEALER_LEADS_START_ROW = Number(process.env.DEALER_LEADS_START_ROW || 2000); // keep leads far below vehicles
const ADMIN_SHEET_TITLE = String(process.env.ADMIN_SHEET_TITLE || "ADMIN");

// ---------- Middleware ----------
app.disable("x-powered-by");

// Avoid Chrome/Accept-CH weirdness
app.use((req, res, next) => {
  res.removeHeader("Accept-CH");
  res.removeHeader("Critical-CH");
  next();
});

app.use(express.json({ limit: "2mb" }));

// Serve static files from repo root
app.use(express.static(ROOT, { extensions: ["html"] }));

// ---------- Static routing (no redirects; works with/without trailing slash) ----------
function serveAppIndex(appName) {
  return (req, res) => res.sendFile(path.join(ROOT, "apps", appName, "index.html"));
}

app.get("/", serveAppIndex("storefront"));
app.get(["/storefront", "/storefront/"], serveAppIndex("storefront"));
app.get(["/dealer", "/dealer/"], serveAppIndex("dealer"));
app.get(["/admin", "/admin/"], serveAppIndex("admin"));

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- JWT (no external deps) ----------
function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function signJwt(payload, expiresInSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now };
  if (expiresInSeconds) body.exp = now + expiresInSeconds;

  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(body));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(data).digest();
  return `${data}.${base64url(sig)}`;
}
function verifyJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("bad token");
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const expected = base64url(crypto.createHmac("sha256", JWT_SECRET).update(data).digest());
  if (!timingSafeEqual(expected, s)) throw new Error("bad signature");
  const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) throw new Error("expired");
  return payload;
}
function timingSafeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Missing token" });
  try {
    req.user = verifyJwt(token);
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ ok: false, error: "Forbidden" });
  next();
}
function requireDealer(req, res, next) {
  if (!req.user || req.user.role !== "dealer") return res.status(403).json({ ok: false, error: "Forbidden" });
  next();
}

// ---------- Password / passcode hashing ----------
function hashPasscode(passcode, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(passcode), s, 120000, 32, "sha256").toString("hex");
  return `${s}$${hash}`;
}
function verifyPasscode(passcode, stored) {
  if (!stored || !stored.includes("$")) return false;
  const [salt, hash] = stored.split("$");
  const test = crypto.pbkdf2Sync(String(passcode), salt, 120000, 32, "sha256").toString("hex");
  return timingSafeEqual(test, hash);
}
function gen6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function nowIso() {
  return new Date().toISOString();
}
function safeDealerTabName(dealerId) {
  // sheet tab titles: avoid slashes/brackets, keep short
  return String(dealerId || "")
    .trim()
    .replace(/[^\w\- ]+/g, "_")
    .slice(0, 80);
}

// ---------- Google Sheets client ----------
async function getSheetsClient() {
  if (!GOOGLE_SHEET_ID) throw new Error("Missing GOOGLE_SHEET_ID env var");
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function getSpreadsheetMeta(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    fields: "sheets(properties(sheetId,title))",
  });
  const tabs = meta.data.sheets || [];
  const byTitle = new Map();
  for (const t of tabs) byTitle.set(t.properties.title, t.properties.sheetId);
  return { tabs, byTitle };
}

async function ensureTab(sheets, title) {
  const { byTitle } = await getSpreadsheetMeta(sheets);
  if (byTitle.has(title)) return byTitle.get(title);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title } } }],
    },
  });

  const meta2 = await getSpreadsheetMeta(sheets);
  return meta2.byTitle.get(title);
}

async function ensureAdminSheet(sheets) {
  await ensureTab(sheets, ADMIN_SHEET_TITLE);

  // Ensure headers exist in ADMIN!A1:H1
  const headers = [
    "dealerId",
    "name",
    "status",
    "passcodeHash",
    "whatsapp",
    "logoUrl",
    "createdAt",
    "updatedAt",
  ];

  const range = `${ADMIN_SHEET_TITLE}!A1:H1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
  });

  const row = (existing.data.values && existing.data.values[0]) || [];
  if (row.join("|") !== headers.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
  }
}

async function ensureDealerTabLayout(sheets, dealerId) {
  const title = safeDealerTabName(dealerId);
  await ensureTab(sheets, title);

  // Vehicles header row at A1:K1
  const vehHeaders = [
    "vehicleId",
    "title",
    "make",
    "model",
    "year",
    "price",
    "status",
    "notes",
    "heroImage",
    "imagesJson",
    "updatedAt",
  ];

  const vehRange = `${title}!A1:K1`;
  const existingVeh = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: vehRange,
  });
  const rowVeh = (existingVeh.data.values && existingVeh.data.values[0]) || [];
  if (rowVeh.join("|") !== vehHeaders.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: vehRange,
      valueInputOption: "RAW",
      requestBody: { values: [vehHeaders] },
    });
  }

  // Leads header row far below
  const leadHeaders = [
    "createdAt",
    "leadId",
    "vehicleId",
    "type",
    "name",
    "phone",
    "email",
    "preferredDate",
    "preferredTime",
    "notes",
    "source",
    "status",
  ];
  const leadRow = DEALER_LEADS_START_ROW; // 2000 by default
  const leadRange = `${title}!A${leadRow}:L${leadRow}`;
  const existingLead = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: leadRange,
  });
  const rowLead = (existingLead.data.values && existingLead.data.values[0]) || [];
  if (rowLead.join("|") !== leadHeaders.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: leadRange,
      valueInputOption: "RAW",
      requestBody: { values: [leadHeaders] },
    });
  }
}

async function adminListDealers(sheets) {
  await ensureAdminSheet(sheets);

  const range = `${ADMIN_SHEET_TITLE}!A2:H`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  const rows = res.data.values || [];
  return rows.map((r) => ({
    dealerId: r[0] || "",
    name: r[1] || "",
    status: (r[2] || "active").toLowerCase(),
    passcodeHash: r[3] || "",
    whatsapp: r[4] || "",
    logoUrl: r[5] || "",
    createdAt: r[6] || "",
    updatedAt: r[7] || "",
  }));
}

async function adminUpsertDealer(sheets, dealer) {
  await ensureAdminSheet(sheets);

  const dealers = await adminListDealers(sheets);
  const idx = dealers.findIndex((d) => d.dealerId === dealer.dealerId);

  const rowValues = [
    dealer.dealerId,
    dealer.name,
    dealer.status || "active",
    dealer.passcodeHash || "",
    dealer.whatsapp || "",
    dealer.logoUrl || "",
    dealer.createdAt || nowIso(),
    dealer.updatedAt || nowIso(),
  ];

  if (idx === -1) {
    // append
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${ADMIN_SHEET_TITLE}!A:H`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowValues] },
    });
  } else {
    // update row (idx + 2 because header row + 1-based)
    const rowNum = idx + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${ADMIN_SHEET_TITLE}!A${rowNum}:H${rowNum}`,
      valueInputOption: "RAW",
      requestBody: { values: [rowValues] },
    });
  }
}

async function adminGetDealer(sheets, dealerId) {
  const dealers = await adminListDealers(sheets);
  return dealers.find((d) => d.dealerId === dealerId) || null;
}

// Vehicles live at top (A2:K...)
async function dealerListVehicles(sheets, dealerId) {
  const tab = safeDealerTabName(dealerId);
  await ensureDealerTabLayout(sheets, dealerId);

  const range = `${tab}!A2:K`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  const rows = res.data.values || [];
  return rows
    .filter((r) => (r[0] || "").trim())
    .map((r) => ({
      vehicleId: r[0] || "",
      title: r[1] || "",
      make: r[2] || "",
      model: r[3] || "",
      year: r[4] ? Number(r[4]) : null,
      price: r[5] ? Number(r[5]) : 0,
      status: r[6] || "",
      notes: r[7] || "",
      heroImage: r[8] || "",
      images: safeParseJsonArray(r[9]),
      updatedAt: r[10] || "",
      dealerId,
    }));
}

function safeParseJsonArray(v) {
  try {
    const x = JSON.parse(v || "[]");
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

async function dealerUpsertVehicle(sheets, dealerId, vehicle) {
  const tab = safeDealerTabName(dealerId);
  await ensureDealerTabLayout(sheets, dealerId);

  // Find existing by vehicleId
  const range = `${tab}!A2:K`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  const rows = res.data.values || [];

  let foundRowNum = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || "").trim() === vehicle.vehicleId) {
      foundRowNum = i + 2; // A2 is row 2
      break;
    }
  }

  const rowValues = [
    vehicle.vehicleId,
    vehicle.title || "",
    vehicle.make || "",
    vehicle.model || "",
    vehicle.year ? String(vehicle.year) : "",
    vehicle.price ? String(vehicle.price) : "",
    vehicle.status || "available",
    vehicle.notes || "",
    vehicle.heroImage || "",
    JSON.stringify(vehicle.images || []),
    nowIso(),
  ];

  if (foundRowNum === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${tab}!A:K`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowValues] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${tab}!A${foundRowNum}:K${foundRowNum}`,
      valueInputOption: "RAW",
      requestBody: { values: [rowValues] },
    });
  }

  return { ...vehicle, updatedAt: nowIso(), dealerId };
}

async function dealerAppendLead(sheets, dealerId, lead) {
  const tab = safeDealerTabName(dealerId);
  await ensureDealerTabLayout(sheets, dealerId);

  const leadId = lead.leadId || ("lead_" + crypto.randomBytes(6).toString("hex"));
  const values = [[
    nowIso(),
    leadId,
    lead.vehicleId || "",
    lead.type || "video",
    lead.name || "",
    lead.phone || "",
    lead.email || "",
    lead.preferredDate || "",
    lead.preferredTime || "",
    lead.notes || "",
    lead.source || "storefront",
    lead.status || "new",
  ]];

  // Append starting after lead header row (startRow+1)
  const appendRange = `${tab}!A${DEALER_LEADS_START_ROW + 1}:L`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: appendRange,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return { ...lead, leadId, createdAt: nowIso(), status: lead.status || "new" };
}

// ---------- GCS (Signed upload URLs) ----------
const storage = new Storage();
const bucket = storage.bucket(MEDIA_BUCKET);

function sanitizeFilename(name) {
  return String(name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 140);
}

async function signUpload({ dealerId, vehicleId, type, filename, contentType }) {
  if (!["image", "video"].includes(type)) throw new Error("type must be image or video");
  const safeName = sanitizeFilename(filename);
  const folder = type === "image" ? "images/original" : "videos/original";
  const objectKey = `dealers/${dealerId}/vehicles/${vehicleId}/${folder}/${Date.now()}_${safeName}`;

  const file = bucket.file(objectKey);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    contentType,
  });

  const publicUrl = `${GCS_PUBLIC_BASE}/${MEDIA_BUCKET}/${objectKey}`;
  return { url, objectKey, publicUrl };
}

// =========================
// API ROUTES
// =========================

// ----- ADMIN -----
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: "username and password required" });

  if (String(username) !== ADMIN_USERNAME || String(password) !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  }

  const token = signJwt({ role: "admin", username: ADMIN_USERNAME }, 8 * 3600);
  return res.json({ ok: true, token });
});

app.get("/api/admin/dealers", requireAuth, requireAdmin, async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const dealers = await adminListDealers(sheets);

    // compute vehicle counts quickly (demo-friendly; can be optimized later)
    const withCounts = await Promise.all(dealers.map(async d => {
      try {
        const vehicles = await dealerListVehicles(sheets, d.dealerId);
        return { ...publicDealer(d), vehicleCount: vehicles.length };
      } catch {
        return { ...publicDealer(d), vehicleCount: 0 };
      }
    }));

    res.json({ ok: true, dealers: withCounts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to list dealers" });
  }
});

app.post("/api/admin/dealers", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { dealerId, name, status, whatsapp, logoUrl, op } = req.body || {};
    if (!dealerId || !name) return res.status(400).json({ ok: false, error: "dealerId and name required" });

    const sheets = await getSheetsClient();

    const existing = await adminGetDealer(sheets, dealerId);
    const isNew = !existing;

    let passcode = null;
    let passcodeHash = existing?.passcodeHash || "";

    // If creating new dealer, generate passcode
    if (isNew) {
      passcode = gen6();
      passcodeHash = hashPasscode(passcode);
    }

    const record = {
      dealerId,
      name,
      status: (status || existing?.status || "active").toLowerCase(),
      passcodeHash,
      whatsapp: digitsOnly(whatsapp || existing?.whatsapp || ""),
      logoUrl: String(logoUrl || existing?.logoUrl || ""),
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };

    await adminUpsertDealer(sheets, record);
    await ensureDealerTabLayout(sheets, dealerId);

    res.json({ ok: true, dealer: publicDealer(record), passcode: passcode || undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to create dealer" });
  }
});

app.post("/api/admin/reset-passcode", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { dealerId } = req.body || {};
    if (!dealerId) return res.status(400).json({ ok: false, error: "dealerId required" });

    const sheets = await getSheetsClient();
    const existing = await adminGetDealer(sheets, dealerId);
    if (!existing) return res.status(404).json({ ok: false, error: "Dealer not found" });

    const newPass = gen6();
    const updated = {
      ...existing,
      passcodeHash: hashPasscode(newPass),
      updatedAt: nowIso(),
    };

    await adminUpsertDealer(sheets, updated);
    res.json({ ok: true, dealerId, passcode: newPass });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to reset passcode" });
  }
});

// Optional: admin inventory rollup
app.get("/api/admin/inventory", requireAuth, requireAdmin, async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const dealers = await adminListDealers(sheets);

    const all = [];
    for (const d of dealers) {
      try {
        const vehicles = await dealerListVehicles(sheets, d.dealerId);
        all.push(...vehicles);
      } catch {}
    }

    res.json({ ok: true, vehicles: all });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load inventory" });
  }
});

// (stub) admin requests rollup (from dealer leads section)
app.get("/api/admin/requests", requireAuth, requireAdmin, async (req, res) => {
  try {
    // For v1, keep this light: requests are stored per dealer tab; you can add full rollup later.
    // We'll return empty for now so UI doesn't break.
    res.json({ ok: true, requests: [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load requests" });
  }
});

// ----- DEALER -----
app.post("/api/dealer/login", async (req, res) => {
  try {
    const { dealerId, passcode } = req.body || {};
    if (!dealerId || !passcode) return res.status(400).json({ ok: false, error: "dealerId and passcode required" });

    const sheets = await getSheetsClient();
    const dealer = await adminGetDealer(sheets, dealerId);
    if (!dealer) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    if (!verifyPasscode(passcode, dealer.passcodeHash)) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const token = signJwt({ role: "dealer", dealerId }, 8 * 3600);
    res.json({ ok: true, token, dealerName: dealer.name, dealerId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Login failed" });
  }
});

app.get("/api/dealer/vehicles", requireAuth, requireDealer, async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const vehicles = await dealerListVehicles(sheets, req.user.dealerId);
    res.json({ ok: true, vehicles });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load vehicles" });
  }
});

app.post("/api/dealer/vehicles", requireAuth, requireDealer, async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const dealerId = req.user.dealerId;

    const body = req.body || {};
    const vehicleId = String(body.vehicleId || "").trim() || makeVehicleId();

    const vehicle = {
      vehicleId,
      title: String(body.title || "").trim(),
      make: String(body.make || "").trim(),
      model: String(body.model || "").trim(),
      year: body.year ? Number(body.year) : null,
      price: body.price ? Number(body.price) : 0,
      status: String(body.status || "available").trim(),
      notes: String(body.notes || "").trim(),
      heroImage: String(body.heroImage || "").trim(),
      images: Array.isArray(body.images) ? body.images : [],
    };

    if (!vehicle.make || !vehicle.model) {
      return res.status(400).json({ ok: false, error: "make and model required" });
    }

    const saved = await dealerUpsertVehicle(sheets, dealerId, vehicle);
    res.json({ ok: true, vehicle: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to save vehicle" });
  }
});

// Signed upload URL for dealer
app.post("/api/dealer/uploads/sign", requireAuth, requireDealer, async (req, res) => {
  try {
    const dealerId = req.user.dealerId;
    const { vehicleId, type, filename, contentType } = req.body || {};
    if (!vehicleId || !type || !filename || !contentType) {
      return res.status(400).json({ ok: false, error: "vehicleId, type, filename, contentType required" });
    }

    const out = await signUpload({ dealerId, vehicleId, type, filename, contentType });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to sign upload" });
  }
});

// Back-compat route you used earlier (dealerId in URL)
app.post("/api/dealers/:dealerId/vehicles/:vehicleId/uploads/sign", requireAuth, async (req, res) => {
  try {
    const dealerId = req.params.dealerId;
    const vehicleId = req.params.vehicleId;

    // allow admin or the same dealer
    if (req.user?.role === "dealer" && req.user.dealerId !== dealerId) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    if (req.user?.role !== "dealer" && req.user?.role !== "admin") {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const { type, filename, contentType } = req.body || {};
    if (!type || !filename || !contentType) {
      return res.status(400).json({ ok: false, error: "type, filename, contentType required" });
    }

    const out = await signUpload({ dealerId, vehicleId, type, filename, contentType });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to sign upload" });
  }
});

// ----- PUBLIC (Storefront) -----
app.get("/api/public/vehicles", async (req, res) => {
  try {
    const { dealerId } = req.query || {};
    const sheets = await getSheetsClient();

    if (dealerId) {
      const vehicles = await dealerListVehicles(sheets, dealerId);
      return res.json({ vehicles: filterPublicVehicles(vehicles) });
    }

    // If dealerId not provided, we aggregate all dealers (can be slower with many dealers)
    const dealers = await adminListDealers(sheets);
    const all = [];
    for (const d of dealers) {
      try {
        const vehicles = await dealerListVehicles(sheets, d.dealerId);
        all.push(...vehicles);
      } catch {}
    }
    res.json({ vehicles: filterPublicVehicles(all) });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to load public vehicles" });
  }
});

app.post("/api/public/leads", async (req, res) => {
  try {
    const body = req.body || {};
    const dealerId = String(body.dealerId || "").trim();
    if (!dealerId) return res.status(400).json({ ok: false, error: "dealerId required" });

    const lead = {
      dealerId,
      vehicleId: String(body.vehicleId || "").trim(),
      type: String(body.type || "video").trim(),
      name: String(body.name || "").trim(),
      phone: String(body.phone || "").trim(),
      email: String(body.email || "").trim(),
      preferredDate: String(body.preferredDate || "").trim(),
      preferredTime: String(body.preferredTime || "").trim(),
      notes: String(body.notes || "").trim(),
      source: String(body.source || "storefront").trim(),
      status: "new",
    };

    if (!lead.name || !lead.phone) return res.status(400).json({ ok: false, error: "name and phone required" });

    const sheets = await getSheetsClient();
    await ensureDealerTabLayout(sheets, dealerId);
    const saved = await dealerAppendLead(sheets, dealerId, lead);

    res.json({ ok: true, lead: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to save lead" });
  }
});

// ---------- Helpers ----------
function publicDealer(d) {
  return {
    dealerId: d.dealerId,
    name: d.name,
    status: d.status,
    whatsapp: d.whatsapp,
    logoUrl: d.logoUrl,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
function digitsOnly(s) {
  return String(s || "").replace(/\D+/g, "");
}
function makeVehicleId() {
  return "VEH-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}
function filterPublicVehicles(list) {
  return (list || []).filter((v) => {
    const s = String(v.status || "").toLowerCase();
    // storefront shows vehicles that are basically "for sale"
    return ["published", "available", "in_stock", "instock"].includes(s);
  });
}

// ---------- 404 ----------
app.use((req, res) => res.status(404).send("Not Found"));

// ---------- Start server (Cloud Run expects 0.0.0.0 and PORT) ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`carsalesweblink running on :${PORT}`);
  console.log(`MEDIA_BUCKET=${MEDIA_BUCKET}`);
  console.log(`GOOGLE_SHEET_ID=${GOOGLE_SHEET_ID ? "set" : "missing"}`);
});
