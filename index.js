const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================
   TIER CONFIG (LOCKED)
   ========================= */
const TIERS = {
  FREE: { dailyQueries: 25, advancedDaily: 0, monthlyCostCap: 3 },
  PLUS: { dailyQueries: 300, advancedDaily: 0, monthlyCostCap: 120 },
  PRO: { dailyQueries: 1500, advancedDaily: 60, monthlyCostCap: 450 },
  PREMIUM: { dailyQueries: 5000, advancedDaily: 250, monthlyCostCap: 1500 }
};

/* =========================
   BASIC MODEL MAP
   ========================= */
const BASIC_MODEL = "gemini-flash";

/* =========================
   HELPERS (same as before)
   ========================= */
async function getOrCreateUser(email) {
  const res = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
  if (res.rows.length) return res.rows[0];
  const created = await pool.query(
    "INSERT INTO users(email) VALUES($1) RETURNING *",
    [email]
  );
  return created.rows[0];
}

async function getTodayUsage(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await pool.query(
    "SELECT * FROM usage_daily WHERE user_id=$1 AND date=$2",
    [userId, today]
  );
  if (res.rows.length) return res.rows[0];
  const created = await pool.query(
    "INSERT INTO usage_daily(user_id, date) VALUES($1,$2) RETURNING *",
    [userId, today]
  );
  return created.rows[0];
}

async function getMonthlyUsage(userId) {
  const month = new Date().toISOString().slice(0, 7);
  const res = await pool.query(
    "SELECT * FROM usage_monthly WHERE user_id=$1 AND month=$2",
    [userId, month]
  );
  if (res.rows.length) return res.rows[0];
  const created = await pool.query(
    "INSERT INTO usage_monthly(user_id, month) VALUES($1,$2) RETURNING *",
    [userId, month]
  );
  return created.rows[0];
}

/* =========================
   SMART ROUTER (LAYER 1)
   ========================= */
function layer1Router(query) {
  if (!query || query.length < 15) {
    return { model: BASIC_MODEL, reason: "SHORT_QUERY" };
  }
  return null;
}

/* =========================
   SMART ROUTER (MAIN)
   ========================= */
app.post("/route", async (req, res) => {
  const { email, query } = req.body;

  const user = await getOrCreateUser(email);
  const tier = TIERS[user.tier];
  const daily = await getTodayUsage(user.id);
  const monthly = await getMonthlyUsage(user.id);

  // DAILY LIMIT
  if (daily.queries_used >= tier.dailyQueries) {
    return res.json({ allowed: false, reason: "DAILY_LIMIT_REACHED" });
  }

  // LAYER 1
  const l1 = layer1Router(query);
  if (l1) {
    return res.json({
      allowed: true,
      model: l1.model,
      forced: true,
      reason: l1.reason
    });
  }

  // DEFAULT (Layer 2 placeholder)
  return res.json({
    allowed: true,
    model: BASIC_MODEL,
    forced: false,
    reason: "LAYER2_PENDING"
  });
});

/* =========================
   HEALTH
   ========================= */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Phase 4 active: Smart Router Layer 1 live 🧠"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
