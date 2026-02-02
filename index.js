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
  FREE: {
    dailyQueries: 25,
    advancedDaily: 0,
    monthlyCostCap: 3
  },
  PLUS: {
    dailyQueries: 300,
    advancedDaily: 0,
    monthlyCostCap: 120
  },
  PRO: {
    dailyQueries: 1500,
    advancedDaily: 60,
    monthlyCostCap: 450
  },
  PREMIUM: {
    dailyQueries: 5000,
    advancedDaily: 250,
    monthlyCostCap: 1500
  }
};

/* =========================
   HELPERS
   ========================= */
async function getOrCreateUser(email) {
  const res = await pool.query(
    "SELECT * FROM users WHERE email=$1",
    [email]
  );

  if (res.rows.length > 0) return res.rows[0];

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

  if (res.rows.length > 0) return res.rows[0];

  const created = await pool.query(
    "INSERT INTO usage_daily(user_id, date) VALUES($1, $2) RETURNING *",
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

  if (res.rows.length > 0) return res.rows[0];

  const created = await pool.query(
    "INSERT INTO usage_monthly(user_id, month) VALUES($1, $2) RETURNING *",
    [userId, month]
  );

  return created.rows[0];
}

/* =========================
   CORE CHECK API
   ========================= */
app.post("/check-query", async (req, res) => {
  const { email, isAdvanced = false, estimatedCost = 0 } = req.body;

  const user = await getOrCreateUser(email);
  const tier = TIERS[user.tier];

  const daily = await getTodayUsage(user.id);
  const monthly = await getMonthlyUsage(user.id);

  // DAILY TOTAL LIMIT
  if (daily.queries_used >= tier.dailyQueries) {
    return res.json({
      allowed: false,
      reason: "DAILY_LIMIT_REACHED"
    });
  }

  // ADVANCED LIMIT
  if (isAdvanced && daily.advanced_used >= tier.advancedDaily) {
    return res.json({
      allowed: true,
      forceBasic: true,
      reason: "ADVANCED_QUOTA_EXHAUSTED"
    });
  }

  // MONTHLY COST HARD CAP
  if (Number(monthly.cost_rupees) + estimatedCost >= tier.monthlyCostCap) {
    return res.json({
      allowed: true,
      forceCheapest: true,
      reason: "MONTHLY_COST_CAP_REACHED"
    });
  }

  return res.json({
    allowed: true
  });
});

/* =========================
   USAGE UPDATE API
   ========================= */
app.post("/record-usage", async (req, res) => {
  const { email, isAdvanced = false, cost = 0 } = req.body;

  const user = await getOrCreateUser(email);
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  await pool.query(
    `UPDATE usage_daily
     SET queries_used = queries_used + 1,
         advanced_used = advanced_used + $1
     WHERE user_id=$2 AND date=$3`,
    [isAdvanced ? 1 : 0, user.id, today]
  );

  await pool.query(
    `UPDATE usage_monthly
     SET cost_rupees = cost_rupees + $1
     WHERE user_id=$2 AND month=$3`,
    [cost, user.id, month]
  );

  res.json({ status: "RECORDED" });
});

/* =========================
   HEALTH
   ========================= */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Phase 3 active: Tier + quota logic live 🛡️"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
