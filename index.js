const express = require("express");
const fetch = require("node-fetch");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TIERS = {
  FREE: { dailyQueries: 25, advancedDaily: 0, monthlyCostCap: 3 },
  PLUS: { dailyQueries: 300, advancedDaily: 0, monthlyCostCap: 120 },
  PRO: { dailyQueries: 1500, advancedDaily: 60, monthlyCostCap: 450 },
  PREMIUM: { dailyQueries: 5000, advancedDaily: 250, monthlyCostCap: 1500 }
};

async function getOrCreateUser(email) {
  const r = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
  if (r.rows.length) return r.rows[0];
  return (await pool.query(
    "INSERT INTO users(email) VALUES($1) RETURNING *",
    [email]
  )).rows[0];
}

async function getTodayUsage(userId) {
  const d = new Date().toISOString().slice(0,10);
  const r = await pool.query(
    "SELECT * FROM usage_daily WHERE user_id=$1 AND date=$2",[userId,d]
  );
  if (r.rows.length) return r.rows[0];
  return (await pool.query(
    "INSERT INTO usage_daily(user_id,date) VALUES($1,$2) RETURNING *",
    [userId,d]
  )).rows[0];
}

async function getMonthlyUsage(userId) {
  const m = new Date().toISOString().slice(0,7);
  const r = await pool.query(
    "SELECT * FROM usage_monthly WHERE user_id=$1 AND month=$2",[userId,m]
  );
  if (r.rows.length) return r.rows[0];
  return (await pool.query(
    "INSERT INTO usage_monthly(user_id,month) VALUES($1,$2) RETURNING *",
    [userId,m]
  )).rows[0];
}

// -------- LAYER 2: GEMINI ROUTER --------
async function routeWithGemini(query) {
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
      process.env.GEMINI_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text:
`Analyze the query and suggest the cheapest suitable model.
Reply JSON only.
Query: "${query}"
Models: deepseek-chat`
          }]
        }]
      })
    }
  );
  const j = await r.json();
  return { model: "deepseek-chat", estimatedCost: 0.01 };
}

// -------- ACTUAL AI CALL (DeepSeek) --------
async function callDeepSeek(prompt) {
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }]
    })
  });
  const j = await r.json();
  return j.choices[0].message.content;
}

app.post("/ask", async (req, res) => {
  const { email, query } = req.body;

  const user = await getOrCreateUser(email);
  const tier = TIERS[user.tier];
  const daily = await getTodayUsage(user.id);
  const monthly = await getMonthlyUsage(user.id);

  if (daily.queries_used >= tier.dailyQueries)
    return res.json({ error: "DAILY_LIMIT" });

  const decision = await routeWithGemini(query);

  if (monthly.cost_rupees + decision.estimatedCost >= tier.monthlyCostCap) {
    return res.json({
      answer: "Limit reached, please upgrade.",
      model: "forced-basic"
    });
  }

  const answer = await callDeepSeek(query);

  await pool.query(
    "UPDATE usage_daily SET queries_used=queries_used+1 WHERE user_id=$1 AND date=$2",
    [user.id, new Date().toISOString().slice(0,10)]
  );
  await pool.query(
    "UPDATE usage_monthly SET cost_rupees=cost_rupees+$1 WHERE user_id=$2 AND month=$3",
    [decision.estimatedCost, user.id, new Date().toISOString().slice(0,7)]
  );

  res.json({ answer, model: decision.model });
});

app.get("/", (_, res) =>
  res.json({ status: "ok", message: "Phase 5 active: Real AI live 🤖" })
);

app.listen(process.env.PORT || 3000);
