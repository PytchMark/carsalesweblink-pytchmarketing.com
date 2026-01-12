// server.js (root)
// Cloud Run-ready Express server:
// - Serves static UIs: / (storefront), /dealer, /admin
// - Google Sheets as DB (one spreadsheet, dealer-per-tab model)
// - OPTIONAL: GCS signed upload URLs (env MEDIA_BUCKET) [kept for back-compat]
// - Admin + Dealer auth via Cloud Run env vars + passcode hashes
//
// ✅ Fixes included:
// 1) Auto-expands dealer tabs so A2000:L2000 DOES NOT exceed grid limits
// 2) Fix passcode hash parsing (supports both "$$" and legacy "$" formats)
// 3) Adds /api/public/config to expose Cloudinary env config to frontends
// 4) Adds small request logger for /api/* errors (helps debugging Cloud Run)
// 5) Adds an error-handler to log stack traces in Cloud Run logs
// 6) Makes GCS signing optional (won't crash if bucket perms are missing and you don't use it)
// 7) Adds SIGNED Cloudinary upload signer: POST /api/dealer/cloudinary/sign
// 8) OPTIONAL: Cloudinary folder listing endpoint (server-side Admin API) if ENABLE_CLOUDINARY_LIST=true

"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

// Google APIs
const { google } = require("googleapis");

// GCS (optional/back-compat)
let Storage;
try {
  ({ Storage } = require("@google-cloud/storage"));
} catch {
  Storage = null;
}

const app = express();

// ---------- Env ----------
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "adminpytch");
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "123456");

const JWT_SECRET = String(process.env.JWT_SECRET || "dev-secret-change-me");
const GOOGLE_SHEET_ID = String(process.env.GOOGLE_SHEET_ID || "");

// GCS settings (optional)
const MEDIA_BUCKET = String(process.env.MEDIA_BUCKET || "samplemedia1");
const GCS_PUBLIC_BASE = String(process.env.GCS_PUBLIC_BASE || "https://storage.googleapis.com");

// Cloudinary
const CLOUDINARY_CLOUD_NAME = String(process.env.CLOUDINARY_CLOUD_NAME || "");
const CLOUDINARY_UPLOAD_PRESET = String(process.env.CLOUDINARY_UPLOAD_PRESET || ""); // optional fallback
const CLOUDINARY_BASE_FOLDER = String(process.env.CLOUDINARY_BASE_FOLDER || "mediaexclusive");

// Signed Cloudinary uploads (recommended)
const CLOUDINARY_API_KEY = String(process.env.CLOUDINARY_API_KEY || "");
const CLOUDINARY_API_SECRET = String(process.env.CLOUDINARY_API_SECRET || "");

// Optional: allow server-side folder listing
const ENABLE_CLOUDINARY_LIST = String(process.env.ENABLE_CLOUDINARY_LIST || "").toLowerCase() === "true";

// Dealer sheet layout
const DEALER_LEADS_START_ROW = Number(process.env.DEALER_LEADS_START_ROW || 2000);
const ADMIN_SHEET_TITLE = String(process.env.ADMIN_SHEET_TITLE || "ADMIN");
const SETTINGS_SHEET_TITLE = String(process.env.SETTINGS_SHEET_TITLE || "SETTINGS");
const DEALER_MIN_ROWS = Number(process.env.DEALER_MIN_ROWS || Math.max(1200, DEALER_LEADS_START_ROW + 300));

// ---------- Middleware ----------
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.removeHeader("Accept-CH");
  res.removeHeader("Critical-CH");
  next();
});

app.use(express.json({ limit: "2mb" }));

// Simple API request logger (helps debug 401/500 in Cloud Run logs)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      console.log(`[API] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
    });
  }
  next();
});

// Serve static files from repo root
app.use(express.static(ROOT, { extensions: ["html"] }));

// ---------- Static routing ----------
function serveAppIndex(appName) {
  return (_req, res) => res.sendFile(path.join(ROOT, "apps", appName, "index.html"));
}
app.get("/", serveAppIndex("storefront"));
app.get(["/storefront", "/storefront/", "/storefront/:dealerId"], serveAppIndex("storefront"));
app.get("/d/:dealerId", serveAppIndex("storefront"));
app.get(["/dealer", "/dealer/"], serveAppIndex("dealer"));
app.get(["/admin", "/admin/"], serveAppIndex("admin"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- JWT (no external deps) ----------
function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
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
  } catch (_e) {
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
  return `${s}$$${hash}`;
}
function parseStoredHash(stored) {
  const v = String(stored || "");
  if (v.includes("$$")) {
    const parts = v.split("$$");
    if (parts.length === 2) return { salt: parts[0], hash: parts[1] };
  }
  if (v.includes("$")) {
    const parts = v.split("$").filter((x) => x !== "");
    if (parts.length >= 2) return { salt: parts[0], hash: parts[1] };
  }
  if (v.includes(":")) {
    const parts = v.split(":");
    if (parts.length === 2) return { salt: parts[0], hash: parts[1] };
  }
  return null;
}
function verifyPasscode(passcode, stored) {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const test = crypto.pbkdf2Sync(String(passcode), parsed.salt, 120000, 32, "sha256").toString("hex");
  return timingSafeEqual(test, parsed.hash);
}

// ---------- Helpers ----------
function gen6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function nowIso() {
  return new Date().toISOString();
}
function normalizeDealerId(dealerId) {
  return String(dealerId || "").trim().toUpperCase();
}
function safeDealerTabName(dealerId) {
  return normalizeDealerId(dealerId)
    .trim()
    .replace(/[^\w\- ]+/g, "_")
    .slice(0, 80);
}
function digitsOnly(s) {
  return String(s || "").replace(/\D+/g, "");
}
function isValidDealerId(dealerId) {
  return /^[A-Za-z]{2}\d{3}$/.test(String(dealerId || "").trim());
}
function makeVehicleId() {
  return "VEH-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}
function safeParseJsonArray(v) {
  try {
    const x = JSON.parse(v || "[]");
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}
function publicDealer(d) {
  return {
    dealerId: d.dealerId,
    name: d.name,
    status: d.status,
    passcode: d.passcode || "",
    whatsapp: d.whatsapp,
    logoUrl: d.logoUrl,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
function filterPublicVehicles(list) {
  return (list || []).filter((v) => {
    const s = String(v.status || "").toLowerCase();
    return ["published", "available", "in_stock", "instock"].includes(s);
  });
}
function isHttpUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
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
    fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
  });
  const tabs = meta.data.sheets || [];
  const byTitle = new Map();
  for (const t of tabs) byTitle.set(t.properties.title, t.properties);
  return { tabs, byTitle };
}
async function ensureRows(sheets, sheetId, neededRowCount) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { rowCount: neededRowCount } },
            fields: "gridProperties.rowCount",
          },
        },
      ],
    },
  });
}
async function ensureTab(sheets, title, minRows = 1000) {
  const meta = await getSpreadsheetMeta(sheets);

  if (meta.byTitle.has(title)) {
    const props = meta.byTitle.get(title);
    const currentRows = props.gridProperties?.rowCount || 1000;
    if (currentRows < minRows) {
      await ensureRows(sheets, props.sheetId, minRows);
      const meta2 = await getSpreadsheetMeta(sheets);
      return meta2.byTitle.get(title);
    }
    return props;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });

  const meta2 = await getSpreadsheetMeta(sheets);
  const props2 = meta2.byTitle.get(title);

  const currentRows2 = props2.gridProperties?.rowCount || 1000;
  if (currentRows2 < minRows) {
    await ensureRows(sheets, props2.sheetId, minRows);
    const meta3 = await getSpreadsheetMeta(sheets);
    return meta3.byTitle.get(title);
  }

  return props2;
}
async function ensureAdminSheet(sheets) {
  await ensureTab(sheets, ADMIN_SHEET_TITLE, 200);

  const headers = [
    "dealerId",
    "name",
    "status",
    "passcodeHash",
    "passcode",
    "whatsapp",
    "logoUrl",
    "createdAt",
    "updatedAt",
  ];
  const range = `${ADMIN_SHEET_TITLE}!A1:I1`;

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
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

  // ✅ ensure enough rows for A2000:L2000
  await ensureTab(sheets, title, DEALER_MIN_ROWS);

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
    "heroVideo",
    "imagesJson",
    "updatedAt",
  ];

  const vehRange = `${title}!A1:L1`;
  const existingVeh = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: vehRange });
  const rowVeh = (existingVeh.data.values && existingVeh.data.values[0]) || [];
  if (rowVeh.join("|") !== vehHeaders.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: vehRange,
      valueInputOption: "RAW",
      requestBody: { values: [vehHeaders] },
    });
  }

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

  const leadRow = DEALER_LEADS_START_ROW;
  const leadRange = `${title}!A${leadRow}:L${leadRow}`;

  const existingLead = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: leadRange });
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
async function ensureSettingsSheet(sheets) {
  await ensureTab(sheets, SETTINGS_SHEET_TITLE, 50);
  const headers = ["key", "value", "updatedAt"];
  const range = `${SETTINGS_SHEET_TITLE}!A1:C1`;
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
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
const SETTINGS_KEYS = ["storefrontLogoUrl", "storefrontHeroVideoUrl"];
async function getSettings(sheets) {
  await ensureSettingsSheet(sheets);
  const range = `${SETTINGS_SHEET_TITLE}!A2:C`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  const rows = res.data.values || [];
  const settings = {};
  rows.forEach((r) => {
    const key = String(r[0] || "").trim();
    if (key && SETTINGS_KEYS.includes(key)) {
      settings[key] = String(r[1] || "").trim();
    }
  });
  SETTINGS_KEYS.forEach((k) => {
    if (!Object.prototype.hasOwnProperty.call(settings, k)) settings[k] = "";
  });
  return settings;
}
async function updateSettings(sheets, updates) {
  await ensureSettingsSheet(sheets);
  const range = `${SETTINGS_SHEET_TITLE}!A2:C`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  const rows = res.data.values || [];
  const rowMap = new Map();
  rows.forEach((r, idx) => {
    const key = String(r[0] || "").trim();
    if (key) rowMap.set(key, idx + 2);
  });

  const updatesArr = Object.entries(updates || {}).filter(([k]) => SETTINGS_KEYS.includes(k));
  for (const [key, value] of updatesArr) {
    const rowNum = rowMap.get(key);
    const values = [[key, String(value || "").trim(), nowIso()]];
    if (rowNum) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${SETTINGS_SHEET_TITLE}!A${rowNum}:C${rowNum}`,
        valueInputOption: "RAW",
        requestBody: { values },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${SETTINGS_SHEET_TITLE}!A:C`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      });
    }
  }
  return getSettings(sheets);
}
async function adminListDealers(sheets) {
  await ensureAdminSheet(sheets);
  const range = `${ADMIN_SHEET_TITLE}!A2:I`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  const rows = res.data.values || [];
  return rows.map((r) => {
    const hasPasscodeColumn = r.length >= 9;
    return {
      dealerId: r[0] || "",
      name: r[1] || "",
      status: (r[2] || "active").toLowerCase(),
      passcodeHash: r[3] || "",
      passcode: hasPasscodeColumn ? r[4] || "" : "",
      whatsapp: hasPasscodeColumn ? r[5] || "" : r[4] || "",
      logoUrl: hasPasscodeColumn ? r[6] || "" : r[5] || "",
      createdAt: hasPasscodeColumn ? r[7] || "" : r[6] || "",
      updatedAt: hasPasscodeColumn ? r[8] || "" : r[7] || "",
    };
  });
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
    dealer.passcode || "",
    dealer.whatsapp || "",
    dealer.logoUrl || "",
    dealer.createdAt || nowIso(),
    dealer.updatedAt || nowIso(),
  ];

  if (idx === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${ADMIN_SHEET_TITLE}!A:I`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowValues] },
    });
  } else {
    const rowNum = idx + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${ADMIN_SHEET_TITLE}!A${rowNum}:I${rowNum}`,
      valueInputOption: "RAW",
      requestBody: { values: [rowValues] },
    });
  }
}
async function adminGetDealer(sheets, dealerId) {
  const dealers = await adminListDealers(sheets);
  const normalized = normalizeDealerId(dealerId);
  return dealers.find((d) => normalizeDealerId(d.dealerId) === normalized) || null;
}
async function dealerListVehicles(sheets, dealerId) {
  const normalized = normalizeDealerId(dealerId);
  const tab = safeDealerTabName(normalized);
  await ensureDealerTabLayout(sheets, normalized);

  const range = `${tab}!A2:L`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  const rows = res.data.values || [];
  return rows
    .filter((r) => (r[0] || "").trim())
    .map((r) => ({
      ...(r.length >= 12
        ? {
            vehicleId: r[0] || "",
            title: r[1] || "",
            make: r[2] || "",
            model: r[3] || "",
            year: r[4] ? Number(r[4]) : null,
            price: r[5] ? Number(r[5]) : 0,
            status: r[6] || "",
            notes: r[7] || "",
            heroImage: r[8] || "",
            heroVideo: r[9] || "",
            images: safeParseJsonArray(r[10]),
            updatedAt: r[11] || "",
          }
        : {
            vehicleId: r[0] || "",
            title: r[1] || "",
            make: r[2] || "",
            model: r[3] || "",
            year: r[4] ? Number(r[4]) : null,
            price: r[5] ? Number(r[5]) : 0,
            status: r[6] || "",
            notes: r[7] || "",
            heroImage: r[8] || "",
            heroVideo: "",
            images: safeParseJsonArray(r[9]),
            updatedAt: r[10] || "",
          }),
      dealerId,
    }));
}
async function dealerUpsertVehicle(sheets, dealerId, vehicle) {
  const normalized = normalizeDealerId(dealerId);
  const tab = safeDealerTabName(normalized);
  await ensureDealerTabLayout(sheets, normalized);

  const range = `${tab}!A2:L`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  const rows = res.data.values || [];

  let foundRowNum = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || "").trim() === vehicle.vehicleId) {
      foundRowNum = i + 2;
      break;
    }
  }

  const updatedAt = nowIso();
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
    vehicle.heroVideo || "",
    JSON.stringify(vehicle.images || []),
    updatedAt,
  ];

  if (foundRowNum === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${tab}!A:L`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowValues] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${tab}!A${foundRowNum}:L${foundRowNum}`,
      valueInputOption: "RAW",
      requestBody: { values: [rowValues] },
    });
  }

  return { ...vehicle, updatedAt, dealerId: normalized };
}
async function dealerListLeads(sheets, dealerId) {
  const normalized = normalizeDealerId(dealerId);
  const tab = safeDealerTabName(normalized);
  await ensureDealerTabLayout(sheets, normalized);

  const start = DEALER_LEADS_START_ROW + 1;
  const range = `${tab}!A${start}:L`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  const rows = res.data.values || [];

  return rows
    .map((r, idx) => ({
      createdAt: r[0] || "",
      leadId: r[1] || "",
      vehicleId: r[2] || "",
      type: r[3] || "",
      name: r[4] || "",
      phone: r[5] || "",
      email: r[6] || "",
      preferredDate: r[7] || "",
      preferredTime: r[8] || "",
      notes: r[9] || "",
      source: r[10] || "",
      status: r[11] || "new",
      dealerId: normalized,
      rowNum: start + idx,
    }))
    .filter((l) => (l.leadId || "").trim());
}
async function dealerUpdateLeadStatus(sheets, dealerId, leadId, status) {
  const normalized = normalizeDealerId(dealerId);
  const leads = await dealerListLeads(sheets, normalized);
  const lead = leads.find((l) => l.leadId === leadId);
  if (!lead) return null;

  const tab = safeDealerTabName(normalized);
  const range = `${tab}!L${lead.rowNum}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });

  return { ...lead, status };
}
async function dealerAppendLead(sheets, dealerId, lead) {
  const normalized = normalizeDealerId(dealerId);
  const tab = safeDealerTabName(normalized);
  await ensureDealerTabLayout(sheets, normalized);

  const leadId = lead.leadId || "lead_" + crypto.randomBytes(6).toString("hex");
  const createdAt = nowIso();

  const values = [
    [
      createdAt,
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
    ],
  ];

  const appendRange = `${tab}!A${DEALER_LEADS_START_ROW + 1}:L`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: appendRange,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return { ...lead, dealerId: normalized, leadId, createdAt, status: lead.status || "new" };
}

// ---------- GCS (Signed upload URLs) - OPTIONAL/BACK-COMPAT ----------
const gcs = {
  enabled: Boolean(Storage),
  storage: null,
  bucket: null,
};

if (Storage) {
  try {
    gcs.storage = new Storage();
    gcs.bucket = gcs.storage.bucket(MEDIA_BUCKET);
  } catch (e) {
    console.warn("[GCS] Disabled: could not init Storage:", e?.message || e);
    gcs.enabled = false;
  }
} else {
  console.warn("[GCS] @google-cloud/storage not installed. GCS signing disabled.");
}

function sanitizeFilename(name) {
  return String(name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 140);
}
async function signUpload({ dealerId, vehicleId, type, filename, contentType }) {
  if (!gcs.enabled || !gcs.bucket) throw new Error("GCS signing disabled");
  if (!["image", "video"].includes(type)) throw new Error("type must be image or video");

  const safeName = sanitizeFilename(filename);
  const folder = type === "image" ? "images/original" : "videos/original";
  const objectKey = `dealers/${dealerId}/vehicles/${vehicleId}/${folder}/${Date.now()}_${safeName}`;

  const file = gcs.bucket.file(objectKey);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 10 * 60 * 1000,
    contentType,
  });

  const publicUrl = `${GCS_PUBLIC_BASE}/${MEDIA_BUCKET}/${objectKey}`;
  return { url, objectKey, publicUrl };
}

// =========================
// Cloudinary: SIGNED upload signature endpoint
// =========================

// Cloudinary signature rules: sign a sorted param string, append api_secret, sha1 hex.
// We only sign what we need: folder + timestamp (you can add more later if you want).
function cloudinarySignature(params, apiSecret) {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "");
  keys.sort();
  const toSign = keys.map((k) => `${k}=${params[k]}`).join("&") + apiSecret;
  return crypto.createHash("sha1").update(toSign).digest("hex");
}

// Dealer-only signer
app.post("/api/dealer/cloudinary/sign", requireAuth, requireDealer, async (req, res) => {
  try {
    if (!CLOUDINARY_CLOUD_NAME) return res.status(400).json({ ok: false, error: "CLOUDINARY_CLOUD_NAME missing" });
    if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(400).json({ ok: false, error: "CLOUDINARY_API_KEY/SECRET missing (required for signed uploads)" });
    }

    const body = req.body || {};
    const folder = String(body.folder || "").trim();

    if (!folder) return res.status(400).json({ ok: false, error: "folder required" });

    // simple safety: enforce uploads under your base folder
    if (CLOUDINARY_BASE_FOLDER && !folder.startsWith(CLOUDINARY_BASE_FOLDER)) {
      return res.status(400).json({ ok: false, error: "folder must be under CLOUDINARY_BASE_FOLDER" });
    }

    const timestamp = Math.floor(Date.now() / 1000);

    const signature = cloudinarySignature(
      {
        folder,
        timestamp,
      },
      CLOUDINARY_API_SECRET
    );

    return res.json({
      ok: true,
      mode: "signed",
      apiKey: CLOUDINARY_API_KEY,
      timestamp,
      signature,
      folder,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Failed to sign Cloudinary upload" });
  }
});

// =========================
// OPTIONAL: Cloudinary folder listing (Admin API)
// =========================

function httpsJson({ hostname, path, method, headers }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: method || "GET", headers: headers || {} },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const json = (() => {
            try { return JSON.parse(data || "{}"); } catch { return null; }
          })();
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
          const msg = json?.error?.message || `Cloudinary API error (${res.statusCode})`;
          reject(new Error(msg));
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Public listing endpoint (use only if ENABLE_CLOUDINARY_LIST=true)
app.get("/api/public/cloudinary/list", async (req, res) => {
  try {
    if (!ENABLE_CLOUDINARY_LIST) return res.status(404).send("Not Found");
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(400).json({ ok: false, error: "Cloudinary admin creds missing" });
    }

    // You can list per dealer, or per vehicle
    const dealerId = String(req.query.dealerId || "").trim();
    const vehicleId = String(req.query.vehicleId || "").trim();
    const cursor = String(req.query.cursor || "").trim();
    const maxResults = Math.min(100, Math.max(1, Number(req.query.limit || 50)));

    if (!dealerId) return res.status(400).json({ ok: false, error: "dealerId required" });

    let prefix = `${CLOUDINARY_BASE_FOLDER}/dealers/${dealerId}`;
    if (vehicleId) prefix = `${prefix}/vehicles/${vehicleId}`;

    const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString("base64");

    // Admin API: list image resources by prefix
    // GET /v1_1/<cloud>/resources/image/upload?prefix=...&max_results=...&next_cursor=...
    const qs = new URLSearchParams();
    qs.set("prefix", prefix);
    qs.set("max_results", String(maxResults));
    if (cursor) qs.set("next_cursor", cursor);

    const json = await httpsJson({
      hostname: "api.cloudinary.com",
      path: `/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/resources/image/upload?${qs.toString()}`,
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
    });

    const resources = Array.isArray(json?.resources) ? json.resources : [];
    const urls = resources.map((r) => r.secure_url).filter(Boolean);

    res.json({
      ok: true,
      prefix,
      urls,
      nextCursor: json?.next_cursor || "",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to list Cloudinary folder" });
  }
});

// =========================
// API ROUTES
// =========================

// PUBLIC CONFIG
app.get("/api/public/config", async (_req, res) => {
  try {
    const sheets = await getSheetsClient();
    const settings = await getSettings(sheets);
    res.json({
      ok: true,
      cloudinary: {
        cloudName: CLOUDINARY_CLOUD_NAME,
        uploadPreset: CLOUDINARY_UPLOAD_PRESET, // optional fallback only
        baseFolder: CLOUDINARY_BASE_FOLDER,
      },
      settings,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load config" });
  }
});

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

app.get("/api/admin/settings", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const sheets = await getSheetsClient();
    const settings = await getSettings(sheets);
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load settings" });
  }
});

app.post("/api/admin/settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const updates = req.body?.settings || {};
    const sheets = await getSheetsClient();
    const settings = await updateSettings(sheets, updates);
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to update settings" });
  }
});

app.get("/api/admin/dealers", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const sheets = await getSheetsClient();
    const dealers = await adminListDealers(sheets);

    const withCounts = await Promise.all(
      dealers.map(async (d) => {
        try {
          const vehicles = await dealerListVehicles(sheets, d.dealerId);
          return { ...publicDealer(d), vehicleCount: vehicles.length };
        } catch {
          return { ...publicDealer(d), vehicleCount: 0 };
        }
      })
    );

    res.json({ ok: true, dealers: withCounts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to list dealers" });
  }
});

app.post("/api/admin/dealers", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { dealerId, name, status, whatsapp, logoUrl } = req.body || {};
    if (!dealerId || !name) return res.status(400).json({ ok: false, error: "dealerId and name required" });
    if (!isValidDealerId(dealerId)) {
      return res.status(400).json({ ok: false, error: "dealerId must be two letters followed by three numbers" });
    }

    const sheets = await getSheetsClient();
    const normalizedDealerId = normalizeDealerId(dealerId);

    const existing = await adminGetDealer(sheets, normalizedDealerId);
    const isNew = !existing;

    let passcode = String(req.body?.passcode || "").trim();
    let passcodeHash = existing?.passcodeHash || "";

    if (!passcode && isNew) passcode = gen6();
    if (passcode) passcodeHash = hashPasscode(passcode);

    const record = {
      dealerId: normalizedDealerId,
      name,
      status: String(status || existing?.status || "active").toLowerCase(),
      passcodeHash,
      passcode: passcode || existing?.passcode || "",
      whatsapp: digitsOnly(whatsapp || existing?.whatsapp || ""),
      logoUrl: String(logoUrl || existing?.logoUrl || ""),
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };

    await adminUpsertDealer(sheets, record);
    await ensureDealerTabLayout(sheets, normalizedDealerId);

    res.json({ ok: true, dealer: publicDealer(record), passcode: passcode || undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to create dealer" });
  }
});

app.post("/api/admin/reset-passcode", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { dealerId } = req.body || {};
    if (!dealerId) return res.status(400).json({ ok: false, error: "dealerId required" });
    if (!isValidDealerId(dealerId)) {
      return res.status(400).json({ ok: false, error: "dealerId must be two letters followed by three numbers" });
    }

    const sheets = await getSheetsClient();
    const normalized = normalizeDealerId(dealerId);
    const existing = await adminGetDealer(sheets, normalized);
    if (!existing) return res.status(404).json({ ok: false, error: "Dealer not found" });

    const newPass = gen6();
    const updated = {
      ...existing,
      passcodeHash: hashPasscode(newPass),
      passcode: newPass,
      updatedAt: nowIso(),
    };

    await adminUpsertDealer(sheets, updated);
    res.json({ ok: true, dealerId: normalized, passcode: newPass });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to reset passcode" });
  }
});

app.get("/api/admin/inventory", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const sheets = await getSheetsClient();
    const dealers = await adminListDealers(sheets);

    const results = await Promise.allSettled(
      dealers.map(async (d) => {
        const vehicles = await dealerListVehicles(sheets, d.dealerId);
        return vehicles;
      })
    );
    const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    res.json({ ok: true, vehicles: all });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load inventory" });
  }
});

app.get("/api/admin/requests", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const sheets = await getSheetsClient();
    const dealers = await adminListDealers(sheets);

    const results = await Promise.allSettled(
      dealers.map(async (d) => {
        const leads = await dealerListLeads(sheets, d.dealerId);
        return leads;
      })
    );
    const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    res.json({ ok: true, requests: all });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load requests" });
  }
});

app.get("/api/admin/dealer/:dealerId/vehicles", requireAuth, requireAdmin, async (req, res) => {
  try {
    const dealerId = String(req.params.dealerId || "").trim();
    if (!dealerId) return res.status(400).json({ ok: false, error: "dealerId required" });
    if (!isValidDealerId(dealerId)) {
      return res.status(400).json({ ok: false, error: "dealerId must be two letters followed by three numbers" });
    }
    const sheets = await getSheetsClient();
    const vehicles = await dealerListVehicles(sheets, normalizeDealerId(dealerId));
    res.json({ ok: true, vehicles });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load dealer inventory" });
  }
});

app.get("/api/admin/dealer/:dealerId/leads", requireAuth, requireAdmin, async (req, res) => {
  try {
    const dealerId = String(req.params.dealerId || "").trim();
    if (!dealerId) return res.status(400).json({ ok: false, error: "dealerId required" });
    if (!isValidDealerId(dealerId)) {
      return res.status(400).json({ ok: false, error: "dealerId must be two letters followed by three numbers" });
    }
    const sheets = await getSheetsClient();
    const leads = await dealerListLeads(sheets, normalizeDealerId(dealerId));
    res.json({ ok: true, leads });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load dealer leads" });
  }
});

app.post("/api/admin/dealer/:dealerId/leads/status", requireAuth, requireAdmin, async (req, res) => {
  try {
    const dealerId = String(req.params.dealerId || "").trim();
    const { leadId, status } = req.body || {};
    if (!dealerId || !leadId || !status) {
      return res.status(400).json({ ok: false, error: "dealerId, leadId, status required" });
    }
    if (!isValidDealerId(dealerId)) {
      return res.status(400).json({ ok: false, error: "dealerId must be two letters followed by three numbers" });
    }
    const sheets = await getSheetsClient();
    const updated = await dealerUpdateLeadStatus(sheets, normalizeDealerId(dealerId), String(leadId), String(status));
    if (!updated) return res.status(404).json({ ok: false, error: "Lead not found" });
    res.json({ ok: true, lead: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to update lead status" });
  }
});

// ----- DEALER -----
app.post("/api/dealer/login", async (req, res) => {
  try {
    const { dealerId, passcode } = req.body || {};
    if (!dealerId || !passcode) return res.status(400).json({ ok: false, error: "dealerId and passcode required" });
    if (!isValidDealerId(dealerId)) {
      return res.status(400).json({ ok: false, error: "dealerId must be two letters followed by three numbers" });
    }

    const sheets = await getSheetsClient();
    const normalized = normalizeDealerId(dealerId);
    const dealer = await adminGetDealer(sheets, normalized);
    if (!dealer) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    if (!verifyPasscode(passcode, dealer.passcodeHash)) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    await ensureDealerTabLayout(sheets, normalized);

    const token = signJwt({ role: "dealer", dealerId: normalized }, 8 * 3600);
    res.json({ ok: true, token, dealerName: dealer.name, dealerId: normalized });
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
      year: body.year != null && body.year !== "" ? Number(body.year) : null,
      price: body.price != null && body.price !== "" ? Number(body.price) : 0,
      status: String(body.status || "available").trim(),
      notes: String(body.notes || "").trim(),
      heroImage: String(body.heroImage || "").trim(),
      heroVideo: String(body.heroVideo || "").trim(),
      images: Array.isArray(body.images) ? body.images : [],
    };

    if (!vehicle.make || !vehicle.model) {
      return res.status(400).json({ ok: false, error: "make and model required" });
    }

    // Keep only URL-like strings
    if (vehicle.heroImage && !isHttpUrl(vehicle.heroImage)) vehicle.heroImage = "";
    if (vehicle.heroVideo && !isHttpUrl(vehicle.heroVideo)) vehicle.heroVideo = "";
    vehicle.images = (vehicle.images || []).filter(isHttpUrl);
    vehicle.images = vehicle.images.slice(0, 7);

    // Auto-hero: if hero missing but images exist
    if (!vehicle.heroImage && vehicle.images.length) vehicle.heroImage = vehicle.images[0];

    const saved = await dealerUpsertVehicle(sheets, dealerId, vehicle);
    res.json({ ok: true, vehicle: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to save vehicle" });
  }
});

app.get("/api/dealer/leads", requireAuth, requireDealer, async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const leads = await dealerListLeads(sheets, req.user.dealerId);
    res.json({ ok: true, leads });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load leads" });
  }
});

app.post("/api/dealer/leads/status", requireAuth, requireDealer, async (req, res) => {
  try {
    const { leadId, status } = req.body || {};
    if (!leadId || !status) return res.status(400).json({ ok: false, error: "leadId and status required" });
    const sheets = await getSheetsClient();
    const updated = await dealerUpdateLeadStatus(sheets, req.user.dealerId, String(leadId), String(status));
    if (!updated) return res.status(404).json({ ok: false, error: "Lead not found" });
    res.json({ ok: true, lead: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to update lead status" });
  }
});

// OPTIONAL/BACK-COMPAT: Signed upload URL for GCS
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

// OPTIONAL/BACK-COMPAT: dealerId in URL
app.post("/api/dealers/:dealerId/vehicles/:vehicleId/uploads/sign", requireAuth, async (req, res) => {
  try {
    const dealerId = req.params.dealerId;
    const vehicleId = req.params.vehicleId;

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
// ✅ Storefront reads URLs stored in Sheets (Cloudinary secure_url).
app.get("/api/public/vehicles", async (req, res) => {
  try {
    const { dealerId } = req.query || {};
    const sheets = await getSheetsClient();

    if (!dealerId) {
      return res.status(400).json({ error: "dealerId required" });
    }
    if (!isValidDealerId(dealerId)) {
      return res.status(400).json({ error: "dealerId must be two letters followed by three numbers" });
    }

    const normalized = normalizeDealerId(dealerId);
    const vehicles = await dealerListVehicles(sheets, normalized);
    return res.json({ vehicles: filterPublicVehicles(vehicles) });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to load public vehicles" });
  }
});

app.get("/api/public/dealer", async (req, res) => {
  try {
    const dealerId = String(req.query.dealerId || "").trim();
    if (!dealerId) return res.status(400).json({ ok: false, error: "dealerId required" });
    if (!isValidDealerId(dealerId)) {
      return res.status(400).json({ ok: false, error: "dealerId must be two letters followed by three numbers" });
    }
    const sheets = await getSheetsClient();
    const dealer = await adminGetDealer(sheets, normalizeDealerId(dealerId));
    if (!dealer) return res.status(404).json({ ok: false, error: "Dealer not found" });
    res.json({
      ok: true,
      dealer: {
        dealerId: dealer.dealerId,
        name: dealer.name,
        logoUrl: dealer.logoUrl,
        whatsapp: dealer.whatsapp,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to load dealer" });
  }
});

app.post("/api/public/leads", async (req, res) => {
  try {
    const body = req.body || {};
    const dealerId = String(body.dealerId || "").trim();
    if (!dealerId) return res.status(400).json({ ok: false, error: "dealerId required" });
    if (!isValidDealerId(dealerId)) {
      return res.status(400).json({ ok: false, error: "dealerId must be two letters followed by three numbers" });
    }

    const lead = {
      dealerId: normalizeDealerId(dealerId),
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
    await ensureDealerTabLayout(sheets, lead.dealerId);
    const saved = await dealerAppendLead(sheets, lead.dealerId, lead);

    res.json({ ok: true, lead: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Failed to save lead" });
  }
});

// ---------- 404 ----------
app.use((_req, res) => res.status(404).send("Not Found"));

// ---------- Error handler ----------
app.use((err, req, res, _next) => {
  console.error("[ERR]", req.method, req.path, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: "Internal Server Error" });
});

// ---------- Start server ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`carsalesweblink running on :${PORT}`);
  console.log(`GOOGLE_SHEET_ID=${GOOGLE_SHEET_ID ? "set" : "missing"}`);
  console.log(`DEALER_LEADS_START_ROW=${DEALER_LEADS_START_ROW}`);
  console.log(`DEALER_MIN_ROWS=${DEALER_MIN_ROWS}`);

  console.log(`CLOUDINARY_CLOUD_NAME=${CLOUDINARY_CLOUD_NAME ? "set" : "missing"}`);
  console.log(`CLOUDINARY_BASE_FOLDER=${CLOUDINARY_BASE_FOLDER}`);
  console.log(`CLOUDINARY_UPLOAD_PRESET=${CLOUDINARY_UPLOAD_PRESET ? "set" : "missing (ok)"} (unsigned fallback only)`);
  console.log(`CLOUDINARY_API_KEY=${CLOUDINARY_API_KEY ? "set" : "missing"} (signed uploads)`);
  console.log(`CLOUDINARY_API_SECRET=${CLOUDINARY_API_SECRET ? "set" : "missing"} (signed uploads)`);
  console.log(`ENABLE_CLOUDINARY_LIST=${ENABLE_CLOUDINARY_LIST}`);

  console.log(`MEDIA_BUCKET=${MEDIA_BUCKET} (optional)`);
});
