import { useState, useEffect, useRef } from "react";

// ─── Config ────────────────────────────────────────────────────────
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

// Retry-capable fetch wrapper
async function apiFetch(body, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify(body),
      });
      if (res.status === 529 || res.status === 503 || res.status === 429) {
        // Overloaded or rate-limited — wait and retry
        if (i < retries) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; }
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (i < retries) { await new Promise(r => setTimeout(r, 1000 * (i + 1))); continue; }
        throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json();
      if (!data.content || !data.content[0]) {
        if (i < retries) { await new Promise(r => setTimeout(r, 1000)); continue; }
        throw new Error("Empty API response");
      }
      return data.content[0].text;
    } catch (e) {
      if (i < retries && (e.message.includes("fetch") || e.message.includes("network") || e.message.includes("Failed"))) {
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function callClaude(sys, msgs, maxTokens = 2048) {
  return apiFetch({ model: MODEL, max_tokens: maxTokens, system: sys, messages: msgs });
}

async function callClaudeMultimodal(sys, userContent, maxTokens = 2048) {
  return apiFetch({ model: MODEL, max_tokens: maxTokens, system: sys, messages: [{ role: "user", content: userContent }] });
}

function parseJSON(text) {
  if (!text) return null;
  // Strip common wrapping issues
  let cleaned = text.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  // Try direct parse
  try { return JSON.parse(cleaned); } catch {}
  // Try extracting JSON object or array
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  // Prefer array if prompt expects array, object otherwise
  for (const m of [objMatch, arrMatch]) {
    if (m) try { return JSON.parse(m[0]); } catch {}
  }
  // Try fixing common issues: trailing commas
  if (objMatch) {
    try { return JSON.parse(objMatch[0].replace(/,\s*([}\]])/g, "$1")); } catch {}
  }
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0].replace(/,\s*([}\]])/g, "$1")); } catch {}
  }
  return null;
}

// ─── Storage ───────────────────────────────────────────────────────
async function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.error(e); } }
async function load(key) { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch { return null; } }

// Read file as base64 data URL
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

// Read file as text
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsText(file);
  });
}

// ─── Prompts ───────────────────────────────────────────────────────
const PROFILE_SYS = `You are the profiling advisor for AURA, a Swiss private banking AI portfolio platform.
Respond ONLY with valid JSON (no markdown, no backticks).
For each question return:
{"message":"short intro","question":"the question","type":"mcq"|"slider"|"multi_select"|"open","options":[...],"min":N,"max":N,"step":N,"labels":{"min":"..","max":".."},"allow_custom":bool,"step_number":N,"total_steps":9}
Order:
1. Risk tolerance — slider min=1 max=10
2. Investment horizon — mcq ["Short-term (< 2 years)","Medium-term (2-7 years)","Long-term (7+ years)"]
3. Financial goals — multi_select ["Retirement","Buy a home","Education fund","Wealth building","Financial independence","Travel & lifestyle","Emergency fund"], allow_custom true
4. Job & industry — open
5. Region — mcq ["Switzerland","Germany","USA","UK","France","Other"], allow_custom true
6. ESG — mcq ["Basic exclusions only","ESG-integrated investing","Full impact investing","No ESG preference"], allow_custom true
7. Sectors — multi_select ["Technology","Healthcare","Clean Energy","Finance","Real Estate","Consumer Goods","Industrials","Crypto & DeFi"], allow_custom true
8. Monthly income & expenses — open. Ask: "What is your approximate monthly net income and your estimated monthly expenses (rent, bills, living costs)? This helps us calculate a realistic investment budget." Example: "Income: CHF 8,000 / Expenses: CHF 5,500"
9. Existing portfolio — open. Ask: "Do you already have investments or a portfolio? If so, briefly describe what you hold (stocks, ETFs, funds, crypto, real estate, etc.). If not, just say 'No existing portfolio'."
When all 9 done: {"type":"complete","message":"Based on your income and expenses, I recommend investing approximately CHF X per month. Here is your complete profile.","profile":{"riskScore":N,"horizon":"..","goals":"..","jobIndustry":"..","region":"..","esgPreferences":"..","sectors":[".."],"monthlyBudget":"CHF X (recommended based on income/expenses)","goalTarget":"..","incomeExpenses":"income: X, expenses: Y","existingPortfolio":"description or none"}}
IMPORTANT: For monthlyBudget, calculate a specific recommended amount based on their income minus expenses, suggesting they invest 20-40% of their disposable income depending on their risk tolerance and goals. Be specific with a number.
Output ONLY JSON. Adapt based on prior answers.`;

const SIG_SYS = (p) => `You are AURA's signal analyzer for a Swiss private banking client. Profile: ${JSON.stringify(p)}
Analyze the provided content (text, image, or document) and return ONLY valid JSON:
{"title":"professional headline","summary":"2-3 sentences","alignment":"ALIGN"|"CONFLICT","confidence":0-100,"relevantFactors":[".."],"actionableInsight":"1 sentence recommendation"}
If the content is an image or document, describe what you see and analyze its investment implications.
IMPORTANT: If the content references defunct companies (Credit Suisse, FTX, Lehman Brothers, Wirecard, etc.), note this in your analysis and do NOT recommend investing in them. Always ground your analysis in current market reality.`;

const PORT_SYS = `You are AURA's portfolio strategist at a Swiss private bank. Hyper-personalized allocation beyond standard risk/return/ESG.
Consider: job concentration risk, region, goals, values, signals, AND any existing portfolio the client holds.

If the client has an existing portfolio, your strategy should:
- Analyze what they already hold and identify gaps, concentration risks, or misalignments with their profile
- Recommend adjustments: what to keep, what to reduce, what to add
- The 5 themes should represent the TARGET allocation (what they should move toward), not just new additions
- Reference their existing holdings in the rationale where relevant

If the client also uploads their portfolio as a document/image, incorporate that analysis.

CRITICAL GUARDRAILS — you MUST follow these:
- ONLY recommend instruments that currently exist and are actively traded as of 2025. NEVER recommend defunct, bankrupt, or delisted companies.
- BANNED examples: Credit Suisse (acquired by UBS in 2023), FTX, Lehman Brothers, Wirecard, Silicon Valley Bank, TerraLuna, Celsius Network, BlockFi — these no longer exist.
- For Swiss clients, prefer instruments available on SIX Swiss Exchange or major European exchanges.
- Use well-known, liquid ETFs and blue-chip stocks. Avoid penny stocks, micro-caps, or speculative instruments unless the client has explicitly high risk tolerance AND requests alternatives.
- For ETFs, prefer established providers: iShares, Vanguard, SPDR, Xtrackers, UBS ETF, Amundi.
- Double-check: if you're unsure whether a company still exists or is still publicly traded, do NOT include it. Choose a safer, known alternative.
- Do NOT recommend investing more than the client's stated budget allows.

Return ONLY valid JSON array of 5 themes:
[{"theme":"name","rationale":"2-3 sentences referencing existing holdings if applicable","alignment":0-100,"riskLevel":"low"|"moderate"|"high","instruments":[{"ticker":"X","name":"Name","type":"ETF|Stock|Bond"}],"allocation":N,"timeHorizon":"short"|"medium"|"long","esgScore":0-100,"personalFit":"why this fits them specifically, referencing existing portfolio if relevant"}]
Allocations sum to 100.`;

const CHAT_SYS = (p, s) => `You are AURA's private banking assistant. Profile: ${JSON.stringify(p)}
Signals: ${s.map(x => x.title).join(", ")}
If user wants profile updates: {"type":"profile_update","changes":{"field":"value"},"message":"confirmation"}
Otherwise: {"type":"chat","message":"response"}
Return ONLY valid JSON.`;

// ─── Icons ─────────────────────────────────────────────────────────
const I = {
  Send: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
  Sparkle: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/></svg>,
  User: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Signal: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>,
  Portfolio: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>,
  Chat: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  Target: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
  Clock: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Check: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  Plus: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Trash: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  ArrowR: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  ArrowL: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  Leaf: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 2 8 0 5.5-4.78 10-10 10Z"/></svg>,
  Pie: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>,
  Upload: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  File: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
  LogOut: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  Menu: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  X: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  ChevR: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>,
  ChevD: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,
  AlertTri: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Shield: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Book: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
  Eye: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  EyeOff: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
};

const COLORS = ["#1a4d8f","#2d6a4f","#7c3aed","#b45309","#be185d","#0e7490","#6d28d9"];
const RISK_DESC = {1:"Ultra-conservative",2:"Very conservative",3:"Conservative",4:"Moderately conservative",5:"Balanced",6:"Moderately aggressive",7:"Aggressive",8:"Very aggressive",9:"Highly aggressive",10:"Maximum risk"};

// ─── Banking-Style CSS ─────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#f7f6f3;--bg2:#fffefa;--card:#ffffff;--card2:#fafaf7;
  --brd:#e0ddd5;--brd2:#c9c5bb;
  --t1:#1a1a18;--t2:#5c5a52;--t3:#8a877e;
  --acc:#1a4d8f;--acc2:#143d72;--accS:rgba(26,77,143,.08);--accG:rgba(26,77,143,.15);
  --grn:#2d6a4f;--grnS:rgba(45,106,79,.08);
  --org:#b45309;--orgS:rgba(180,83,9,.08);
  --red:#9b2c2c;--redS:rgba(155,44,44,.08);
  --prp:#5b21b6;--prpS:rgba(91,33,182,.08);
  --gold:#8b7520;--goldS:rgba(139,117,32,.08);
  --serif:'EB Garamond',Georgia,serif;--sans:'DM Sans',-apple-system,sans-serif;--mono:ui-monospace,monospace;
  --r:8px;--r2:12px;
}
body,#root{font-family:var(--sans);background:var(--bg);color:var(--t1);min-height:100vh;-webkit-font-smoothing:antialiased}

/* Layout */
.app{display:flex;min-height:100vh}
.sidebar{width:260px;background:var(--card);border-right:1px solid var(--brd);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100}
.main{flex:1;margin-left:260px;min-height:100vh;display:flex;flex-direction:column;background:var(--bg)}

/* Sidebar */
.sb-head{padding:24px 24px 20px;border-bottom:1px solid var(--brd)}
.sb-brand{font-family:var(--serif);font-size:22px;font-weight:700;color:var(--acc);letter-spacing:1px}
.sb-sub{font-size:11px;color:var(--t3);margin-top:2px;letter-spacing:.3px}
.sb-nav{flex:1;padding:16px 12px;display:flex;flex-direction:column;gap:2px}
.sb-item{display:flex;align-items:center;gap:10px;padding:11px 16px;border-radius:var(--r);font-size:13px;font-weight:500;color:var(--t2);cursor:pointer;transition:all .15s;border:none;background:none;width:100%;text-align:left;font-family:var(--sans)}
.sb-item:hover{background:var(--accS);color:var(--t1)}
.sb-item.on{background:var(--accS);color:var(--acc);font-weight:600}
.sb-item .badge{margin-left:auto;background:var(--accS);color:var(--acc);font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600}
.sb-foot{padding:16px;border-top:1px solid var(--brd)}
.sb-user{padding:10px 12px;border-radius:var(--r);background:var(--card2);margin-bottom:8px}
.sb-user-name{font-size:13px;font-weight:600;color:var(--t1)}
.sb-user-id{font-family:var(--mono);font-size:10px;color:var(--t3);margin-top:1px}
.mob-btn{position:fixed;top:14px;left:14px;z-index:101;background:var(--card);border:1px solid var(--brd);border-radius:var(--r);padding:8px;cursor:pointer;display:none;color:var(--t1)}
.mob-ov{position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:99;display:none}
@media(max-width:768px){.sidebar{transform:translateX(-260px);transition:transform .25s}.sidebar.mo{transform:translateX(0)}.main{margin-left:0!important}.mob-btn{display:flex}.mob-ov.show{display:block}}

/* Auth */
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg)}
.auth-card{background:var(--card);border:1px solid var(--brd);border-radius:var(--r2);padding:48px;max-width:420px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.auth-brand{font-family:var(--serif);font-size:28px;font-weight:700;color:var(--acc);letter-spacing:1px;margin-bottom:2px}
.auth-sub{font-size:13px;color:var(--t2);margin-bottom:32px;line-height:1.5}
.auth-tabs{display:flex;gap:0;margin-bottom:28px;border-bottom:1px solid var(--brd)}
.auth-tab{flex:1;padding:10px;text-align:center;font-size:13px;font-weight:600;color:var(--t3);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;background:none;border-top:none;border-left:none;border-right:none;font-family:var(--sans)}
.auth-tab.on{color:var(--acc);border-bottom-color:var(--acc)}
.field{margin-bottom:16px}
.field label{display:block;font-size:12px;font-weight:600;color:var(--t2);margin-bottom:5px;letter-spacing:.3px}
.inp{width:100%;padding:11px 14px;background:var(--bg);border:1px solid var(--brd);border-radius:var(--r);color:var(--t1);font-family:var(--sans);font-size:13px;outline:none;transition:border .2s}
.inp:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--accS)}
.inp::placeholder{color:var(--t3)}
.inp-pw{position:relative}
.inp-pw input{padding-right:40px}
.inp-pw button{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--t3);cursor:pointer;padding:2px}
.err-box{color:var(--red);font-size:12px;padding:8px 12px;background:var(--redS);border-radius:var(--r);margin-bottom:12px}

/* Buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 20px;border-radius:var(--r);font-family:var(--sans);font-size:13px;font-weight:600;border:none;cursor:pointer;transition:all .15s;outline:none}
.btn:disabled{opacity:.4;cursor:not-allowed}
.bp{background:var(--acc);color:#fff}
.bp:hover:not(:disabled){background:var(--acc2)}
.bg{background:var(--card);color:var(--t2);border:1px solid var(--brd)}
.bg:hover:not(:disabled){background:var(--card2);color:var(--t1)}
.bf{width:100%}.bl{padding:12px 24px;font-size:14px}

/* Page */
.ph{padding:28px 36px 0}
.ph h1{font-family:var(--serif);font-size:24px;font-weight:700;color:var(--t1);margin-bottom:4px}
.ph p{color:var(--t2);font-size:13px}
.pb{padding:20px 36px 36px;flex:1}

/* Cards */
.card{background:var(--card);border:1px solid var(--brd);border-radius:var(--r2);padding:24px}

/* Wizard */
.wbar{display:flex;gap:4px;margin-bottom:24px}
.wd{flex:1;height:3px;border-radius:2px;background:var(--brd);transition:background .3s}
.wd.done{background:var(--acc)}
.wd.now{background:var(--acc)}
.wm{font-size:13px;color:var(--t2);margin-bottom:6px;line-height:1.5}
.wq{font-family:var(--serif);font-size:20px;font-weight:600;margin-bottom:20px;line-height:1.3}
.wo{display:flex;flex-direction:column;gap:6px}
.wopt{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--bg);border:1px solid var(--brd);border-radius:var(--r);cursor:pointer;transition:all .15s;font-family:var(--sans);font-size:13px;color:var(--t1);text-align:left;width:100%}
.wopt:hover{border-color:var(--acc);background:var(--accS)}
.wopt.s{border-color:var(--acc);background:var(--accS)}
.wr{width:16px;height:16px;border-radius:50%;border:2px solid var(--brd2);flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s}
.wopt.s .wr{border-color:var(--acc);background:var(--acc)}.wopt.s .wr::after{content:'';width:5px;height:5px;background:#fff;border-radius:50%}
.wc{width:16px;height:16px;border-radius:3px;border:2px solid var(--brd2);flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s}
.wopt.s .wc{border-color:var(--acc);background:var(--acc);color:#fff}
.wgr{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.wor{display:flex;align-items:center;gap:10px;margin:10px 0 4px;color:var(--t3);font-size:11px;font-weight:500}
.wor::before,.wor::after{content:'';flex:1;height:1px;background:var(--brd)}
.wsv{text-align:center;font-size:52px;font-weight:700;font-family:var(--serif);color:var(--acc);line-height:1;margin-bottom:4px}
.wsd{text-align:center;font-size:12px;color:var(--t2);margin-bottom:24px}
.wsl{-webkit-appearance:none;width:100%;height:4px;background:var(--brd);border-radius:2px;outline:none;cursor:pointer}
.wsl::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;background:var(--acc);border-radius:50%;cursor:pointer;border:3px solid var(--card)}
.wsl::-moz-range-thumb{width:22px;height:22px;background:var(--acc);border-radius:50%;cursor:pointer;border:3px solid var(--card)}
.wsll{display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:var(--t3)}
.wf{display:flex;justify-content:flex-end;gap:8px;padding-top:20px}

/* Profile summary */
.pg{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.pi{display:flex;align-items:center;gap:12px;padding:16px;background:var(--card);border:1px solid var(--brd);border-radius:var(--r)}
.pic{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.pil{font-size:10px;color:var(--t3);font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.piv{font-size:15px;font-weight:600;margin-top:1px}

/* Signals */
.sc{background:var(--card);border:1px solid var(--brd);border-radius:var(--r2);padding:18px;margin-bottom:10px;transition:all .15s}
.si{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.si.a{background:var(--grnS);color:var(--grn)}.si.c{background:var(--orgS);color:var(--org)}
.sbdg{padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600}
.sbdg.a{background:var(--grnS);color:var(--grn)}.sbdg.c{background:var(--orgS);color:var(--org)}
.sins{font-size:11px;color:var(--acc);padding:6px 10px;background:var(--accS);border-radius:6px;margin-top:8px}
.stg{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.stgi{font-size:10px;padding:2px 7px;background:var(--prpS);color:var(--prp);border-radius:4px;font-weight:500}
.srm{background:none;border:none;color:var(--t3);cursor:pointer;padding:4px;border-radius:6px;flex-shrink:0}
.srm:hover{color:var(--red);background:var(--redS)}
.sic{background:var(--card);border:1px solid var(--brd);border-radius:var(--r2);padding:24px;margin-bottom:20px}
.sic label{font-size:13px;font-weight:600;margin-bottom:10px;display:block;color:var(--t1)}
.sta{width:100%;min-height:100px;padding:12px 14px;background:var(--bg);border:1px solid var(--brd);border-radius:var(--r);color:var(--t1);font-family:var(--sans);font-size:13px;outline:none;resize:vertical;line-height:1.6;transition:border .2s}
.sta:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--accS)}.sta::placeholder{color:var(--t3)}
.sup{display:flex;align-items:center;gap:8px;padding:12px 16px;background:var(--bg);border:1.5px dashed var(--brd);border-radius:var(--r);cursor:pointer;color:var(--t2);font-size:12px;transition:all .15s;margin-top:10px}
.sup:hover{border-color:var(--acc);color:var(--acc)}
.sfp{display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--bg);border:1px solid var(--brd);border-radius:var(--r);font-size:12px;color:var(--t2);margin-top:8px}
.sa{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}

/* Portfolio */
.ab{display:flex;border-radius:6px;overflow:hidden;height:28px;margin-bottom:12px}
.aseg{display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#fff;min-width:24px}
.al{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:24px}
.ali{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--t2)}
.ald{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.ic{background:var(--card);border:1px solid var(--brd);border-radius:var(--r2);cursor:pointer;overflow:hidden;margin-bottom:8px;transition:all .15s}
.ic:hover{border-color:var(--brd2);box-shadow:0 1px 4px rgba(0,0,0,.04)}
.ih{padding:16px 20px;display:flex;align-items:center;gap:14px}
.icl{width:4px;height:36px;border-radius:2px;flex-shrink:0}
.iinf{flex:1;min-width:0}
.ith{font-size:14px;font-weight:600}
.isub{font-size:11px;color:var(--t2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ibd{display:flex;gap:6px;flex-shrink:0}
.ib{padding:3px 10px;border-radius:6px;font-size:10px;font-weight:600;text-transform:capitalize}
.ib.h{background:var(--prpS);color:var(--prp)}.ib.rl{background:var(--grnS);color:var(--grn)}.ib.rm{background:var(--orgS);color:var(--org)}.ib.rh{background:var(--redS);color:var(--red)}
.ial{font-size:15px;font-weight:700;color:var(--acc);flex-shrink:0;min-width:36px;text-align:right}
.iex{padding:0 20px 20px;animation:fi .2s}
@keyframes fi{from{opacity:0}to{opacity:1}}
.idg{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px}
.im{padding:10px;background:var(--bg);border:1px solid var(--brd);border-radius:var(--r)}
.iml{font-size:10px;color:var(--t3);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.3px}
.imv{font-size:18px;font-weight:700;font-family:var(--serif)}
.ibr{width:100%;height:3px;background:var(--brd);border-radius:2px;margin-top:6px;overflow:hidden}
.ibrf{height:100%;border-radius:2px;transition:width .6s}
.iins{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.iin{padding:6px 12px;background:var(--bg);border:1px solid var(--brd);border-radius:6px;font-size:11px;font-weight:500;display:flex;align-items:center;gap:4px}
.iit{font-size:9px;color:var(--t3);padding:1px 5px;background:var(--card2);border-radius:3px}
.ift{font-size:11px;color:var(--grn);padding:8px 12px;background:var(--grnS);border-radius:var(--r);display:flex;align-items:center;gap:6px}

/* Chat */
.cha{flex:1;overflow-y:auto;padding:16px 0;display:flex;flex-direction:column;gap:12px}
.cm{max-width:80%;padding:12px 16px;border-radius:var(--r2);font-size:13px;line-height:1.6;white-space:pre-wrap}
.cm.u{align-self:flex-end;background:var(--acc);color:#fff;border-bottom-right-radius:4px}
.cm.a{align-self:flex-start;background:var(--card);border:1px solid var(--brd);color:var(--t1);border-bottom-left-radius:4px}
.cb{display:flex;gap:8px;padding:12px 0}
.ci{flex:1}
.cs{padding:10px 16px;background:var(--acc);border:none;border-radius:var(--r);color:#fff;cursor:pointer;display:flex;align-items:center;gap:5px;font-family:var(--sans);font-size:12px;font-weight:600}
.cs:hover:not(:disabled){background:var(--acc2)}.cs:disabled{opacity:.4;cursor:not-allowed}

/* Misc */
.dots{display:flex;gap:5px;padding:12px 16px;background:var(--card);border:1px solid var(--brd);border-radius:var(--r2);align-self:flex-start}
.dot{width:6px;height:6px;background:var(--acc);border-radius:50%;animation:pu 1.2s ease infinite}
.dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}
@keyframes pu{0%,80%,100%{opacity:.3;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
.spin{width:36px;height:36px;border:2px solid var(--brd);border-top-color:var(--acc);border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
/* Landing page */
.land{min-height:100vh;background:var(--bg)}
.land-nav{display:flex;align-items:center;justify-content:space-between;padding:20px 40px;max-width:1200px;margin:0 auto}
.land-brand{font-family:var(--serif);font-size:22px;font-weight:700;color:var(--acc);letter-spacing:1px}
.land-nav-links{display:flex;gap:8px}
.land-hero{max-width:900px;margin:0 auto;padding:80px 40px 60px;text-align:center}
.land-hero h1{font-family:var(--serif);font-size:48px;font-weight:700;color:var(--t1);line-height:1.15;margin-bottom:16px}
.land-hero h1 span{color:var(--acc)}
.land-hero p{font-size:17px;color:var(--t2);line-height:1.6;max-width:600px;margin:0 auto 36px}
.land-hero-btns{display:flex;gap:12px;justify-content:center}
.land-features{max-width:1000px;margin:0 auto;padding:40px 40px 80px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.land-feat{background:var(--card);border:1px solid var(--brd);border-radius:var(--r2);padding:28px;text-align:left}
.land-feat-icon{width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:14px}
.land-feat h3{font-family:var(--serif);font-size:17px;font-weight:600;margin-bottom:6px}
.land-feat p{font-size:13px;color:var(--t2);line-height:1.6}
.land-how{max-width:900px;margin:0 auto;padding:40px 40px 80px}
.land-how h2{font-family:var(--serif);font-size:28px;font-weight:700;text-align:center;margin-bottom:40px}
.land-steps{display:flex;gap:20px}
.land-step{flex:1;text-align:center;padding:20px}
.land-step-num{width:36px;height:36px;border-radius:50%;background:var(--accS);color:var(--acc);font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px}
.land-step h4{font-size:14px;font-weight:600;margin-bottom:4px}
.land-step p{font-size:12px;color:var(--t2);line-height:1.5}
.land-cta{text-align:center;padding:60px 40px 80px;max-width:700px;margin:0 auto}
.land-cta h2{font-family:var(--serif);font-size:28px;font-weight:700;margin-bottom:10px}
.land-cta p{font-size:14px;color:var(--t2);margin-bottom:28px;line-height:1.6}
.land-footer{text-align:center;padding:20px;border-top:1px solid var(--brd);font-size:11px;color:var(--t3)}

/* Education */
.edu-hero{padding:32px 0 16px}
.edu-hero h1{font-family:var(--serif);font-size:24px;font-weight:700;margin-bottom:4px}
.edu-cards{display:flex;flex-direction:column;gap:12px}
.edu-card{background:var(--card);border:1px solid var(--brd);border-radius:var(--r2);overflow:hidden;transition:all .15s}
.edu-card:hover{border-color:var(--brd2)}
.edu-card-head{padding:18px 22px;display:flex;align-items:center;gap:14px;cursor:pointer}
.edu-card-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.edu-card-info{flex:1}
.edu-card-title{font-size:15px;font-weight:600}
.edu-card-sub{font-size:12px;color:var(--t2);margin-top:2px}
.edu-card-body{padding:0 22px 22px;font-size:13px;color:var(--t2);line-height:1.7;animation:fi .2s}
.edu-card-body h4{font-size:14px;font-weight:600;color:var(--t1);margin:12px 0 6px}
.edu-card-body h4:first-child{margin-top:0}
.edu-card-body ul{margin:6px 0 6px 18px}
.edu-card-body li{margin-bottom:4px}
.edu-card-body .edu-tip{background:var(--accS);border:1px solid rgba(26,77,143,.08);border-radius:var(--r);padding:10px 14px;font-size:12px;color:var(--acc);margin-top:10px}

@media(max-width:768px){
  .land-hero h1{font-size:32px}
  .land-features{grid-template-columns:1fr}
  .land-steps{flex-direction:column}
  .land-nav{padding:16px 20px}
  .land-hero{padding:40px 20px 40px}
  .land-hero-btns{flex-direction:column;align-items:center}
}
.disc{text-align:center;padding:24px;color:var(--t3);font-size:11px;border-top:1px solid var(--brd);margin-top:32px;line-height:1.5}
@media(max-width:640px){.ph{padding:20px 16px 0}.pb{padding:12px 16px 24px}.pg{grid-template-columns:1fr 1fr}.idg{grid-template-columns:1fr}.wgr{grid-template-columns:1fr}}
`;

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState("landing"); // landing | auth | app
  const [authTab, setAuthTab] = useState("login");
  const [user, setUser] = useState(null);
  const [data, setData] = useState({ profile: null, signals: [], investments: [] });
  const [page, setPage] = useState("profile");
  const [mob, setMob] = useState(false);

  useEffect(() => { if (user) save(`app:${user.id}`, { user, data }); }, [data]);

  function upd(p) { setData(d => ({ ...d, ...p })); }

  async function handleAuth(u, d) {
    setUser(u);
    setData(d || { profile: null, signals: [], investments: [] });
    setPage(d?.profile ? "portfolio" : "profile");
    setScreen("app");
  }

  function logout() { setUser(null); setData({ profile: null, signals: [], investments: [] }); setScreen("landing"); }
  function goAuth(tab) { setAuthTab(tab); setScreen("auth"); }

  // ── Landing Page ──
  if (screen === "landing") return <><style>{css}</style><LandingPage onSignIn={() => goAuth("login")} onGetStarted={() => goAuth("register")} /></>;

  // ── Auth Screen ──
  if (screen === "auth" || !user) return <><style>{css}</style><AuthScreen initialTab={authTab} onAuth={handleAuth} onBack={() => setScreen("landing")} /></>;

  const nav = [
    { id: "profile", label: "Investor Profile", icon: <I.User />, badge: data.profile ? null : "Setup" },
    { id: "signals", label: "Market Signals", icon: <I.Signal />, badge: data.signals.length || null },
    { id: "portfolio", label: "Portfolio", icon: <I.Portfolio /> },
    { id: "chat", label: "Advisor Chat", icon: <I.Chat /> },
    { id: "education", label: "Education", icon: <I.Book /> },
  ];

  return (
    <><style>{css}</style>
      <div className="app">
        <button className="mob-btn" onClick={() => setMob(!mob)}>{mob ? <I.X /> : <I.Menu />}</button>
        <div className={`mob-ov ${mob ? "show" : ""}`} onClick={() => setMob(false)} />
        <aside className={`sidebar ${mob ? "mo" : ""}`}>
          <div className="sb-head"><div className="sb-brand">AURA</div><div className="sb-sub">Private Wealth Intelligence</div></div>
          <nav className="sb-nav">
            {nav.map(n => <button key={n.id} className={`sb-item ${page === n.id ? "on" : ""}`} onClick={() => { setPage(n.id); setMob(false); }}>{n.icon} {n.label}{n.badge && <span className="badge">{n.badge}</span>}</button>)}
          </nav>
          <div className="sb-foot">
            <div className="sb-user"><div className="sb-user-name">{user.name}</div><div className="sb-user-id">{user.id}</div></div>
            <button className="sb-item" onClick={logout}><I.LogOut /> Sign out</button>
          </div>
        </aside>
        <main className="main">
          {page === "profile" && <ProfilePage data={data} upd={upd} go={setPage} />}
          {page === "signals" && <SignalsPage data={data} upd={upd} go={setPage} />}
          {page === "portfolio" && <PortfolioPage data={data} upd={upd} go={setPage} />}
          {page === "chat" && <ChatPage data={data} upd={upd} />}
          {page === "education" && <EducationPage />}
        </main>
      </div>
    </>
  );
}

// ═══════════ AUTH ═══════════
function AuthScreen({ onAuth, initialTab, onBack }) {
  const [tab, setTab] = useState(initialTab || "login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pwShow, setPwShow] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister() {
    if (!name.trim()) { setErr("Please enter your full name."); return; }
    if (!email.trim()) { setErr("Please enter your email."); return; }
    if (pw.length < 4) { setErr("Password must be at least 4 characters."); return; }
    setLoading(true); setErr("");
    const id = "AURA-" + Math.random().toString(36).substr(2, 8).toUpperCase();
    const u = { name: name.trim(), email: email.trim().toLowerCase(), id, pw };
    await save(`app:${id}`, { user: u, data: { profile: null, signals: [], investments: [] } });
    // Also index by email for login
    await save(`email:${u.email}`, id);
    setLoading(false);
    onAuth(u, null);
  }

  async function handleLogin() {
    if (!email.trim()) { setErr("Please enter your email."); return; }
    if (!pw) { setErr("Please enter your password."); return; }
    setLoading(true); setErr("");
    // Look up ID by email
    const idResult = await load(`email:${email.trim().toLowerCase()}`);
    if (!idResult) { setErr("No account found with this email."); setLoading(false); return; }
    const record = await load(`app:${idResult}`);
    if (!record || !record.user) { setErr("Account data not found."); setLoading(false); return; }
    if (record.user.pw !== pw) { setErr("Incorrect password."); setLoading(false); return; }
    setLoading(false);
    onAuth(record.user, record.data);
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        {onBack && <button className="btn bg" onClick={onBack} style={{ marginBottom: 20, padding: "6px 14px", fontSize: 12 }}><I.ArrowL /> Back</button>}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <I.Shield />
          <div className="auth-brand">AURA</div>
        </div>
        <p className="auth-sub">Private Wealth Intelligence — your hyper-personalized portfolio advisor powered by AI.</p>

        <div className="auth-tabs">
          <button className={`auth-tab ${tab === "login" ? "on" : ""}`} onClick={() => { setTab("login"); setErr(""); }}>Sign In</button>
          <button className={`auth-tab ${tab === "register" ? "on" : ""}`} onClick={() => { setTab("register"); setErr(""); }}>Create Account</button>
        </div>

        {err && <div className="err-box">{err}</div>}

        {tab === "register" && (
          <div className="field">
            <label>Full Name</label>
            <input className="inp" placeholder="John Doe" value={name} onChange={e => setName(e.target.value)} />
          </div>
        )}

        <div className="field">
          <label>Email Address</label>
          <input className="inp" type="email" placeholder="john@example.com" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && (tab === "login" ? handleLogin() : handleRegister())} />
        </div>

        <div className="field">
          <label>Password</label>
          <div className="inp-pw">
            <input className="inp" type={pwShow ? "text" : "password"} placeholder="Enter password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && (tab === "login" ? handleLogin() : handleRegister())} />
            <button onClick={() => setPwShow(!pwShow)}>{pwShow ? <I.EyeOff /> : <I.Eye />}</button>
          </div>
        </div>

        <button className="btn bp bf bl" style={{ marginTop: 8 }} onClick={tab === "login" ? handleLogin : handleRegister} disabled={loading}>
          {loading ? "Please wait..." : tab === "login" ? "Sign In" : "Create Account"}
        </button>

        {tab === "register" && (
          <p style={{ fontSize: 11, color: "var(--t3)", marginTop: 16, textAlign: "center", lineHeight: 1.5 }}>
            Your data is stored securely with your unique Client ID. Use your email and password to sign in from any device.
          </p>
        )}
      </div>
    </div>
  );
}

// ═══════════ LANDING PAGE ═══════════
function LandingPage({ onSignIn, onGetStarted }) {
  return (
    <div className="land">
      {/* Navigation */}
      <nav className="land-nav">
        <div className="land-brand">AURA</div>
        <div className="land-nav-links">
          <button className="btn bg" onClick={onSignIn}>Sign In</button>
          <button className="btn bp" onClick={onGetStarted}>Get Started</button>
        </div>
      </nav>

      {/* Hero */}
      <div className="land-hero">
        <h1>Your Wealth, <span>Hyper-Personalized</span> by AI</h1>
        <p>
          AURA goes beyond generic risk-return portfolios. We analyze your career, region, values, goals, 
          and real-time market signals to build an investment strategy that is truly yours.
        </p>
        <div className="land-hero-btns">
          <button className="btn bp bl" onClick={onGetStarted} style={{ padding: "14px 36px" }}>
            <I.Sparkle /> Start Your Profile
          </button>
          <button className="btn bg bl" onClick={onSignIn}>
            Already a client? Sign In
          </button>
        </div>
      </div>

      {/* Features */}
      <div className="land-features">
        <div className="land-feat">
          <div className="land-feat-icon" style={{ background: "var(--accS)", color: "var(--acc)" }}><I.User /></div>
          <h3>Deep Investor Profiling</h3>
          <p>We don't just ask your risk tolerance. AURA understands your job, industry, region, income, expenses, ESG values, and life goals to build a complete financial DNA.</p>
        </div>
        <div className="land-feat">
          <div className="land-feat-icon" style={{ background: "var(--grnS)", color: "var(--grn)" }}><I.Signal /></div>
          <h3>Real-Time Signal Analysis</h3>
          <p>Upload articles, screenshots, PDFs, or your own investment theses. AURA's AI analyzes each signal against your personal profile to determine alignment or conflict.</p>
        </div>
        <div className="land-feat">
          <div className="land-feat-icon" style={{ background: "var(--prpS)", color: "var(--prp)" }}><I.Portfolio /></div>
          <h3>Hyper-Personalized Portfolio</h3>
          <p>Not a cookie-cutter allocation. Your portfolio considers your industry concentration risk, existing holdings, regional factors, and a precise budget based on your actual finances.</p>
        </div>
        <div className="land-feat">
          <div className="land-feat-icon" style={{ background: "var(--orgS)", color: "var(--org)" }}><I.Upload /></div>
          <h3>Existing Portfolio Review</h3>
          <p>Already investing? Upload your current portfolio and AURA will identify gaps, concentration risks, and misalignments — then recommend what to keep, reduce, or add.</p>
        </div>
        <div className="land-feat">
          <div className="land-feat-icon" style={{ background: "var(--goldS)", color: "var(--gold)" }}><I.Chat /></div>
          <h3>AI Advisor Chat</h3>
          <p>Update your profile, ask questions, or get explanations — all through natural conversation with your private AI advisor. Your data updates in real time.</p>
        </div>
        <div className="land-feat">
          <div className="land-feat-icon" style={{ background: "var(--grnS)", color: "var(--grn)" }}><I.Book /></div>
          <h3>Financial Education</h3>
          <p>New to investing? AURA includes a built-in education center covering key concepts from diversification to ESG, so you can make informed decisions with confidence.</p>
        </div>
      </div>

      {/* How it works */}
      <div className="land-how">
        <h2>How It Works</h2>
        <div className="land-steps">
          <div className="land-step">
            <div className="land-step-num">1</div>
            <h4>Build Your Profile</h4>
            <p>Answer guided questions about your risk tolerance, goals, career, income, values, and more. AI adapts each question to your previous answers.</p>
          </div>
          <div className="land-step">
            <div className="land-step-num">2</div>
            <h4>Feed Market Signals</h4>
            <p>Upload articles, news, screenshots, or PDFs. AURA analyzes each against your profile, telling you if it aligns or conflicts with your strategy.</p>
          </div>
          <div className="land-step">
            <div className="land-step-num">3</div>
            <h4>Get Your Strategy</h4>
            <p>Receive a hyper-personalized portfolio with specific instruments, allocations, ESG scores, and explanations tailored to your unique situation.</p>
          </div>
          <div className="land-step">
            <div className="land-step-num">4</div>
            <h4>Iterate & Evolve</h4>
            <p>Add new signals anytime, update your profile via chat, upload your existing holdings. Your strategy evolves as your life does.</p>
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="land-cta">
        <h2>Ready to Take Control of Your Wealth?</h2>
        <p>Join AURA and experience what hyper-personalized portfolio management looks like — powered by the latest AI, built for real people.</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <button className="btn bp bl" onClick={onGetStarted} style={{ padding: "14px 36px" }}>Create Your Account</button>
        </div>
      </div>

      <div className="land-footer">
        AURA — Built for the ZHAW Innovation Weekend, Challenge 4: Hyper-Personalized Portfolio.
        Powered by Claude AI. This is a prototype for educational purposes.
      </div>
    </div>
  );
}

// ═══════════ EDUCATION PAGE ═══════════
function EducationPage() {
  const [open, setOpen] = useState(null);

  const topics = [
    {
      id: "diversification",
      title: "Diversification",
      subtitle: "Don't put all your eggs in one basket",
      color: "--accS", iconColor: "--acc", icon: <I.Pie />,
      content: <>
        <h4>What is diversification?</h4>
        <p>Diversification means spreading your investments across different asset classes, sectors, and regions to reduce risk. When one investment drops, others may hold steady or rise, cushioning the blow.</p>
        <h4>Why it matters</h4>
        <ul>
          <li><strong>Reduces volatility</strong> — a diversified portfolio tends to have smoother returns over time</li>
          <li><strong>Protects against the unexpected</strong> — no single event wipes out your entire portfolio</li>
          <li><strong>Captures more opportunities</strong> — exposure to different sectors means you benefit from growth wherever it happens</li>
        </ul>
        <h4>AURA's approach</h4>
        <p>AURA considers your job industry when diversifying. If you work in tech, for example, your salary already depends on the tech sector — so AURA may recommend less tech exposure in your portfolio to avoid concentration risk.</p>
        <div className="edu-tip">Tip: True diversification isn't just owning many stocks — it's owning assets that behave differently from each other.</div>
      </>
    },
    {
      id: "risk-return",
      title: "Risk & Return",
      subtitle: "Understanding the fundamental tradeoff",
      color: "--orgS", iconColor: "--org", icon: <I.Signal />,
      content: <>
        <h4>The core principle</h4>
        <p>Higher potential returns come with higher risk. A savings account is safe but grows slowly. Stocks can grow fast but can also lose value quickly. Understanding where you fall on this spectrum is crucial.</p>
        <h4>Types of risk</h4>
        <ul>
          <li><strong>Market risk</strong> — the overall market drops (affects nearly everything)</li>
          <li><strong>Concentration risk</strong> — too much in one stock or sector</li>
          <li><strong>Inflation risk</strong> — your returns don't keep up with rising prices</li>
          <li><strong>Liquidity risk</strong> — you can't sell when you need to</li>
          <li><strong>Currency risk</strong> — exchange rates move against you</li>
        </ul>
        <h4>How AURA handles risk</h4>
        <p>Your risk score (1-10) directly influences your portfolio allocation. But AURA goes further — it considers your job stability, income buffer, time horizon, and goals to calibrate risk precisely for your situation.</p>
        <div className="edu-tip">Tip: Risk tolerance isn't just about personality — it's about your financial capacity to absorb losses. A young professional with stable income can usually afford more risk than a retiree.</div>
      </>
    },
    {
      id: "esg",
      title: "ESG Investing",
      subtitle: "Environmental, Social & Governance criteria",
      color: "--grnS", iconColor: "--grn", icon: <I.Leaf />,
      content: <>
        <h4>What is ESG?</h4>
        <p>ESG stands for Environmental, Social, and Governance — three pillars used to evaluate how responsibly a company operates, beyond just financial performance.</p>
        <h4>The three pillars</h4>
        <ul>
          <li><strong>Environmental</strong> — carbon emissions, renewable energy use, waste management, climate impact</li>
          <li><strong>Social</strong> — labor practices, diversity, community impact, data privacy, human rights</li>
          <li><strong>Governance</strong> — board diversity, executive compensation, transparency, anti-corruption</li>
        </ul>
        <h4>ESG investing approaches</h4>
        <ul>
          <li><strong>Exclusion</strong> — removing companies in tobacco, weapons, fossil fuels, etc.</li>
          <li><strong>ESG integration</strong> — using ESG scores alongside financial analysis</li>
          <li><strong>Impact investing</strong> — actively seeking companies that create positive change</li>
        </ul>
        <div className="edu-tip">Tip: ESG investing doesn't mean sacrificing returns. Many studies show ESG-focused companies perform at least as well as their peers over the long term, with lower downside risk.</div>
      </>
    },
    {
      id: "asset-classes",
      title: "Asset Classes",
      subtitle: "Stocks, bonds, ETFs, and more explained",
      color: "--prpS", iconColor: "--prp", icon: <I.Portfolio />,
      content: <>
        <h4>Main asset classes</h4>
        <ul>
          <li><strong>Stocks (Equities)</strong> — ownership shares in companies. Higher risk, higher potential return. You profit from price increases and dividends.</li>
          <li><strong>Bonds (Fixed Income)</strong> — loans to governments or companies. Lower risk, steady income through interest payments. Prices move inversely to interest rates.</li>
          <li><strong>ETFs</strong> — Exchange-Traded Funds bundle many stocks or bonds into one product. They offer instant diversification at low cost. An S&P 500 ETF, for example, gives you exposure to 500 US companies.</li>
          <li><strong>Cash & Money Market</strong> — very safe, very low return. Good for emergency funds and short-term needs.</li>
          <li><strong>Real Estate</strong> — property investments or REITs (Real Estate Investment Trusts). Provides income and inflation protection.</li>
          <li><strong>Alternatives</strong> — crypto, commodities, private equity, hedge funds. Often less correlated with traditional markets but higher risk and complexity.</li>
        </ul>
        <div className="edu-tip">Tip: For most private investors, a mix of stock and bond ETFs forms an excellent foundation. AURA recommends specific instruments based on your profile.</div>
      </>
    },
    {
      id: "compound",
      title: "Compound Interest",
      subtitle: "The eighth wonder of the world",
      color: "--goldS", iconColor: "--gold", icon: <I.Sparkle />,
      content: <>
        <h4>How compounding works</h4>
        <p>Compound interest means earning returns on your returns. If you invest CHF 1,000 at 7% annual return, after year one you have CHF 1,070. In year two, you earn 7% on CHF 1,070 — not just the original 1,000. Over time, this snowball effect is transformative.</p>
        <h4>The power of time</h4>
        <ul>
          <li><strong>CHF 500/month at 7% for 10 years</strong> = ~CHF 86,000 (CHF 60,000 invested, CHF 26,000 in gains)</li>
          <li><strong>CHF 500/month at 7% for 20 years</strong> = ~CHF 260,000 (CHF 120,000 invested, CHF 140,000 in gains)</li>
          <li><strong>CHF 500/month at 7% for 30 years</strong> = ~CHF 610,000 (CHF 180,000 invested, CHF 430,000 in gains)</li>
        </ul>
        <p>Notice how the gains dwarf the contributions over long periods. This is why starting early matters so much.</p>
        <div className="edu-tip">Tip: This is exactly why AURA asks about your income and expenses — to recommend a specific, sustainable monthly investment amount that lets compounding work for you over your chosen time horizon.</div>
      </>
    },
    {
      id: "sharpe",
      title: "The Sharpe Ratio",
      subtitle: "Measuring risk-adjusted returns",
      color: "--accS", iconColor: "--acc", icon: <I.Target />,
      content: <>
        <h4>What is the Sharpe Ratio?</h4>
        <p>The Sharpe Ratio measures how much excess return you get per unit of risk taken. It's calculated as: (Portfolio Return - Risk-Free Rate) / Portfolio Standard Deviation.</p>
        <h4>Why it matters</h4>
        <p>A portfolio returning 12% with wild swings might be worse than one returning 9% with smooth growth. The Sharpe Ratio helps you compare apples to apples.</p>
        <ul>
          <li><strong>Sharpe {'<'} 1.0</strong> — suboptimal risk-adjusted returns</li>
          <li><strong>Sharpe 1.0-2.0</strong> — good risk-adjusted returns</li>
          <li><strong>Sharpe {'>'} 2.0</strong> — excellent (rare for sustained periods)</li>
        </ul>
        <h4>AURA's approach</h4>
        <p>Traditional portfolio optimization just maximizes the Sharpe Ratio — but that gives everyone the same portfolio. AURA goes beyond by incorporating your personal factors (job, region, values) while still aiming for the best risk-adjusted returns within your personalized constraints.</p>
        <div className="edu-tip">Tip: A high-Sharpe portfolio isn't always the right portfolio. If it contradicts your values or creates concentration risk with your career, the "optimal" math answer might not be the optimal life answer.</div>
      </>
    },
  ];

  return (
    <>
      <div className="ph">
        <div className="edu-hero">
          <h1>Financial Education</h1>
          <p style={{ color: "var(--t2)", fontSize: 14 }}>Key investing concepts to help you make informed decisions. Tap any topic to learn more.</p>
        </div>
      </div>
      <div className="pb">
        <div className="edu-cards">
          {topics.map(t => (
            <div key={t.id} className="edu-card">
              <div className="edu-card-head" onClick={() => setOpen(open === t.id ? null : t.id)}>
                <div className="edu-card-icon" style={{ background: `var(${t.color})`, color: `var(${t.iconColor})` }}>{t.icon}</div>
                <div className="edu-card-info">
                  <div className="edu-card-title">{t.title}</div>
                  <div className="edu-card-sub">{t.subtitle}</div>
                </div>
                {open === t.id ? <I.ChevD /> : <I.ChevR />}
              </div>
              {open === t.id && <div className="edu-card-body">{t.content}</div>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ═══════════ PROFILE ═══════════
function ProfilePage({ data, upd, go }) {
  const { profile } = data;
  if (!profile) return <Wizard onDone={p => upd({ profile: p })} />;
  return (<>
    <div className="ph"><h1>Investor Profile</h1><p>Your personalized investment parameters</p></div>
    <div className="pb">
      <div className="pg">
        {[["Risk Score", `${profile.riskScore}/10`, <I.Target />, "--accS", "--acc"],
          ["Horizon", profile.horizon, <I.Clock />, "--accS", "--acc"],
          ["ESG", profile.esgPreferences, <I.Leaf />, "--grnS", "--grn"],
          ["Budget", profile.monthlyBudget, <I.Portfolio />, "--prpS", "--prp"],
        ].map(([l, v, ic, bg, col]) => (
          <div key={l} className="pi"><div className="pic" style={{ background: `var(${bg})`, color: `var(${col})` }}>{ic}</div><div><div className="pil">{l}</div><div className="piv" style={{ textTransform: "capitalize", fontSize: l === "ESG" ? 12 : 15 }}>{v}</div></div></div>
        ))}
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {[["Goals", profile.goals], ["Industry", profile.jobIndustry], ["Region", profile.region], ["Sectors", Array.isArray(profile.sectors) ? profile.sectors.join(", ") : profile.sectors], ["Target", profile.goalTarget || "—"], ["Income/Expenses", profile.incomeExpenses || "—"], ["Existing Portfolio", profile.existingPortfolio || "None"]].map(([k, v]) => (
            <div key={k}><div className="pil">{k}</div><div style={{ fontSize: 13, fontWeight: 500, marginTop: 2 }}>{v || "—"}</div></div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn bg" onClick={() => upd({ profile: null })}><I.ArrowL /> Redo Profile</button>
        <button className="btn bp" onClick={() => go("signals")}>Market Signals <I.ArrowR /></button>
      </div>
    </div>
  </>);
}

// ═══════════ WIZARD ═══════════
function Wizard({ onDone }) {
  const [hist, setHist] = useState([]);
  const [q, setQ] = useState(null);
  const [ld, setLd] = useState(true);
  const [sel, setSel] = useState([]);
  const [slv, setSlv] = useState(5);
  const [cust, setCust] = useState("");
  const [opn, setOpn] = useState("");
  const [err, setErr] = useState("");

  async function ask(h, attempt = 0) {
    setLd(true); setErr("");
    try {
      const r = await callClaude(PROFILE_SYS, h);
      const p = parseJSON(r);
      if (!p) {
        if (attempt < 2) {
          // Auto-retry silently
          await new Promise(res => setTimeout(res, 500));
          return ask(h, attempt + 1);
        }
        setErr("Unexpected response. Please click Next again."); setLd(false); return;
      }
      if (p.type === "complete" && p.profile) { onDone(p.profile); return; }
      setQ(p); setSel([]); setCust(""); setOpn(""); setSlv(p.type === "slider" ? Math.round(((p.min||1)+(p.max||10))/2) : 5);
      setHist([...h, { role: "assistant", content: r }]);
    } catch (e) { console.error(e); setErr("Connection error — please try again."); }
    setLd(false);
  }

  useEffect(() => { const i = [{ role: "user", content: "Start profiling." }]; setHist(i); ask(i); }, []);

  function submit() {
    let a = "";
    if (q.type === "slider") a = `${slv}`;
    else if (q.type === "mcq") a = cust.trim() || sel[0] || "";
    else if (q.type === "multi_select") { const p = [...sel]; if (cust.trim()) p.push(cust.trim()); a = p.join(", "); }
    else a = opn.trim();
    if (!a) return;
    const h = [...hist, { role: "user", content: a }]; setHist(h); ask(h);
  }

  function tog(o) { if (q?.type === "mcq") { setSel([o]); setCust(""); } else setSel(p => p.includes(o) ? p.filter(x => x !== o) : [...p, o]); }
  const ok = () => { if (!q) return false; if (q.type === "slider") return true; if (q.type === "mcq") return sel.length > 0 || cust.trim(); if (q.type === "multi_select") return sel.length > 0 || cust.trim(); return opn.trim().length > 0; };
  const tot = q?.total_steps || 8, sn = q?.step_number || 1;

  if (ld && !q) return (<div className="ph"><h1>Investor Profile Setup</h1><p>Preparing your questionnaire...</p><div style={{ display: "flex", justifyContent: "center", paddingTop: 60 }}><div className="spin" /></div></div>);

  return (<>
    <div className="ph"><h1>Investor Profile Setup</h1><p>Question {sn} of {tot}</p></div>
    <div className="pb">
      <div className="wbar">{Array.from({ length: tot }).map((_, i) => <div key={i} className={`wd ${i < sn - 1 ? "done" : i === sn - 1 ? "now" : ""}`} />)}</div>
      {err && <div className="err-box">{err}</div>}
      {q && <div className="card" key={sn} style={{ animation: "fi .2s" }}>
        {q.message && <p className="wm">{q.message}</p>}
        <h2 className="wq">{q.question}</h2>
        {q.type === "slider" && <div><div className="wsv">{slv}</div><div className="wsd">{RISK_DESC[slv]||""}</div><input type="range" className="wsl" min={q.min||1} max={q.max||10} step={q.step||1} value={slv} onChange={e => setSlv(+e.target.value)} /><div className="wsll"><span>{q.labels?.min||"Low"}</span><span>{q.labels?.max||"High"}</span></div></div>}
        {q.type === "mcq" && <div className="wo">{(q.options||[]).map((o,i) => <button key={i} className={`wopt ${sel.includes(o)?"s":""}`} onClick={() => tog(o)}><div className="wr" />{o}</button>)}{q.allow_custom && <><div className="wor">or type your own</div><input className="inp" placeholder="Custom answer..." value={cust} onChange={e => { setCust(e.target.value); setSel([]); }} /></>}</div>}
        {q.type === "multi_select" && <div className="wo"><div className="wgr">{(q.options||[]).map((o,i) => <button key={i} className={`wopt ${sel.includes(o)?"s":""}`} onClick={() => tog(o)}><div className="wc">{sel.includes(o) && <I.Check />}</div>{o}</button>)}</div>{q.allow_custom && <><div className="wor">or add your own</div><input className="inp" placeholder="Custom option..." value={cust} onChange={e => setCust(e.target.value)} /></>}</div>}
        {q.type === "open" && <textarea className="sta" placeholder="Type your answer..." value={opn} onChange={e => setOpn(e.target.value)} />}
      </div>}
      <div className="wf"><button className="btn bp bl" onClick={submit} disabled={!ok()||ld} style={{ minWidth: 160 }}>{ld ? <><div className="dot"/><div className="dot"/><div className="dot"/></> : sn >= tot ? <><I.Check /> Complete</> : <>Next <I.ArrowR /></>}</button></div>
    </div>
  </>);
}

// ═══════════ SIGNALS ═══════════
function SignalsPage({ data, upd, go }) {
  const { profile, signals } = data;
  const [txt, setTxt] = useState("");
  const [fileData, setFileData] = useState(null); // {name, type, base64}
  const [ld, setLd] = useState(false);
  const [err, setErr] = useState("");
  const fref = useRef(null);

  async function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr("");
    try {
      if (f.type.startsWith("image/") || f.type === "application/pdf") {
        const dataUrl = await readFileAsDataURL(f);
        const base64 = dataUrl.split(",")[1];
        setFileData({ name: f.name, type: f.type, base64 });
      } else {
        // Text file
        const text = await readFileAsText(f);
        setFileData({ name: f.name, type: "text/plain", text });
      }
    } catch (ex) {
      console.error("File read error:", ex);
      setErr("Could not read file. Please try again.");
    }
    // Reset input so same file can be re-selected
    if (fref.current) fref.current.value = "";
  }

  async function analyze() {
    if (!txt.trim() && !fileData) return;
    if (!profile) { setErr("Build your profile first."); return; }
    setLd(true); setErr("");
    try {
      const contentParts = [];

      if (fileData) {
        if (fileData.type.startsWith("image/")) {
          contentParts.push({ type: "image", source: { type: "base64", media_type: fileData.type, data: fileData.base64 } });
          contentParts.push({ type: "text", text: `Analyze this image as a market signal for my portfolio.${txt ? "\n\nAdditional context: " + txt : ""}` });
        } else if (fileData.type === "application/pdf") {
          contentParts.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: fileData.base64 } });
          contentParts.push({ type: "text", text: `Analyze this PDF document as a market signal.${txt ? "\n\nAdditional context: " + txt : ""}` });
        } else if (fileData.text) {
          contentParts.push({ type: "text", text: `Analyze this content as a market signal:\n\n${fileData.text}${txt ? "\n\nAdditional context: " + txt : ""}` });
        }
      } else {
        contentParts.push({ type: "text", text: `Analyze this as a market signal:\n\n${txt}` });
      }

      const reply = await callClaudeMultimodal(SIG_SYS(profile), contentParts);
      let parsed = parseJSON(reply);

      // Auto-retry once if parsing fails
      if (!parsed || !parsed.title) {
        await new Promise(r => setTimeout(r, 800));
        const retry = await callClaudeMultimodal(SIG_SYS(profile), contentParts);
        parsed = parseJSON(retry);
      }

      if (parsed && parsed.title) {
        const newSig = {
          id: Date.now().toString(),
          title: parsed.title,
          summary: parsed.summary,
          alignment: parsed.alignment,
          confidence: parsed.confidence || 75,
          relevantFactors: parsed.relevantFactors || [],
          actionableInsight: parsed.actionableInsight || "",
          fileName: fileData?.name || null,
          content: txt,
        };
        upd({ signals: [...signals, newSig] });
        setTxt(""); setFileData(null);
      } else {
        setErr("Could not parse analysis. Please try again.");
      }
    } catch (e) {
      console.error("Signal analysis error:", e);
      setErr(`Analysis failed: ${e.message}`);
    }
    setLd(false);
  }

  return (<>
    <div className="ph"><h1>Market Signals</h1><p>Add articles, screenshots, PDFs, or notes — each is analyzed against your profile</p></div>
    <div className="pb">
      {!profile && <div className="err-box" style={{ marginBottom: 16 }}>Please complete your investor profile first.</div>}
      <div className="sic">
        <label>Paste an article, thesis, or investment idea</label>
        <textarea className="sta" value={txt} onChange={e => setTxt(e.target.value)} placeholder="e.g. 'ECB expected to cut rates by 25bp in Q2, benefiting European equities...'" disabled={ld} />
        <div className="sup" onClick={() => fref.current?.click()}>
          <I.Upload /> Upload a file (PDF, image, screenshot, text document)
          <input ref={fref} type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.md,.doc" onChange={handleFile} style={{ display: "none" }} />
        </div>
        {fileData && (
          <div className="sfp">
            <I.File /> {fileData.name}
            <span style={{ marginLeft: 4, fontSize: 10, color: "var(--t3)" }}>({fileData.type.startsWith("image/") ? "Image" : fileData.type === "application/pdf" ? "PDF" : "Text"})</span>
            <button style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", marginLeft: "auto", padding: 2 }} onClick={() => setFileData(null)}><I.X /></button>
          </div>
        )}
        {err && <div className="err-box" style={{ marginTop: 10 }}>{err}</div>}
        <div className="sa">
          <button className="btn bp" onClick={analyze} disabled={ld || (!txt.trim() && !fileData) || !profile}>
            {ld ? <><div className="dot"/><div className="dot"/><div className="dot"/></> : <><I.Plus /> Analyze Signal</>}
          </button>
        </div>
      </div>
      {signals.length > 0 && <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Analyzed Signals ({signals.length})</div>
        {signals.map(s => (
          <div key={s.id} className="sc">
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div className={`si ${s.alignment === "ALIGN" ? "a" : "c"}`}>{s.alignment === "ALIGN" ? <I.Signal /> : <I.AlertTri />}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{s.title}</div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className={`sbdg ${s.alignment === "ALIGN" ? "a" : "c"}`}>{s.alignment}</span>
                    <button className="srm" onClick={() => upd({ signals: signals.filter(x => x.id !== s.id), investments: [] })}><I.Trash /></button>
                  </div>
                </div>
                <p style={{ fontSize: 12, color: "var(--t2)", lineHeight: 1.5, marginTop: 4 }}>{s.summary}</p>
                {s.actionableInsight && <div className="sins">{s.actionableInsight}</div>}
                {s.relevantFactors?.length > 0 && <div className="stg">{s.relevantFactors.map((f,i) => <span key={i} className="stgi">{f}</span>)}</div>}
                {s.fileName && <div style={{ fontSize: 11, color: "var(--t3)", display: "flex", alignItems: "center", gap: 4, marginTop: 6 }}><I.File /> {s.fileName}</div>}
              </div>
            </div>
          </div>
        ))}
        <div style={{ marginTop: 20, padding: 20, background: "var(--accS)", borderRadius: "var(--r2)", border: "1px solid rgba(26,77,143,.12)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--acc)" }}>Ready to generate your portfolio?</div>
            <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 2 }}>{signals.length} signal{signals.length !== 1 ? "s" : ""} will be factored into your allocation strategy</div>
          </div>
          <button className="btn bp bl" onClick={() => go("portfolio")} style={{ flexShrink: 0 }}>
            View Portfolio <I.ArrowR />
          </button>
        </div>
      </div>}
    </div>
  </>);
}

// ═══════════ PORTFOLIO ═══════════
function PortfolioPage({ data, upd, go }) {
  const { profile, signals, investments } = data;
  const [ld, setLd] = useState(false);
  const [err, setErr] = useState("");
  const [exp, setExp] = useState(null);
  const [portFile, setPortFile] = useState(null); // {name, type, base64 or text}
  const [portDesc, setPortDesc] = useState("");
  const pfref = useRef(null);

  async function handlePortFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      if (f.type.startsWith("image/") || f.type === "application/pdf") {
        const dataUrl = await readFileAsDataURL(f);
        setPortFile({ name: f.name, type: f.type, base64: dataUrl.split(",")[1] });
      } else {
        const text = await readFileAsText(f);
        setPortFile({ name: f.name, type: "text/plain", text });
      }
    } catch { setErr("Could not read file."); }
    if (pfref.current) pfref.current.value = "";
  }

  async function gen() {
    if (!profile) return;
    setLd(true); setErr("");
    try {
      // Build the content parts
      const contentParts = [];
      
      // If there's an uploaded portfolio file, include it
      if (portFile) {
        if (portFile.type.startsWith("image/")) {
          contentParts.push({ type: "image", source: { type: "base64", media_type: portFile.type, data: portFile.base64 } });
        } else if (portFile.type === "application/pdf") {
          contentParts.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: portFile.base64 } });
        }
      }

      let textMsg = `Investor Profile:\n${JSON.stringify(profile, null, 2)}\n\n`;
      textMsg += `Market Signals (${signals.length}):\n${signals.map(s => `- ${s.title}: ${s.summary} [${s.alignment}]`).join("\n")}\n\n`;
      
      if (profile.existingPortfolio && profile.existingPortfolio !== "none" && profile.existingPortfolio !== "No existing portfolio") {
        textMsg += `Existing Portfolio (from profile): ${profile.existingPortfolio}\n\n`;
      }
      if (portDesc.trim()) {
        textMsg += `Additional portfolio details: ${portDesc}\n\n`;
      }
      if (portFile) {
        textMsg += `The client has also uploaded their current portfolio ${portFile.type === "application/pdf" ? "as a PDF document" : portFile.type.startsWith("image/") ? "as a screenshot/image" : "as a text file"}. Analyze it and incorporate it into the strategy.\n\n`;
      }
      
      textMsg += `Generate 5 hyper-personalized investment themes as a JSON array.`;
      contentParts.push({ type: "text", text: textMsg });

      const reply = await callClaudeMultimodal(PORT_SYS, contentParts, 4096);
      let p = parseJSON(reply);
      
      // Auto-retry once if parsing fails
      if (!Array.isArray(p)) {
        await new Promise(r => setTimeout(r, 800));
        const retry = await callClaudeMultimodal(PORT_SYS, contentParts, 4096);
        p = parseJSON(retry);
      }

      if (Array.isArray(p)) upd({ investments: p }); else setErr("Could not generate portfolio. Please try again.");
    } catch (e) { console.error(e); setErr(`Generation failed: ${e.message}`); }
    setLd(false);
  }

  if (!profile) return (<><div className="ph"><h1>Portfolio</h1><p>Complete your profile first</p></div><div className="pb"><button className="btn bp bl" onClick={() => go("profile")}><I.User /> Setup Profile</button></div></>);
  if (ld) return (<div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 16 }}><div className="spin" /><div style={{ fontWeight: 600 }}>Constructing your portfolio strategy...</div><div style={{ fontSize: 13, color: "var(--t2)" }}>Analyzing profile, signals, existing holdings & market conditions</div></div>);

  return (<>
    <div className="ph"><h1>Portfolio Allocation</h1><p>Tailored for {profile.jobIndustry || "your industry"} in {profile.region || "your region"} — {signals.length} signal{signals.length !== 1 ? "s" : ""} incorporated</p></div>
    <div className="pb">
      {err && <div className="err-box">{err}</div>}

      {/* Existing portfolio upload section */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Your Current Holdings</div>
        <p style={{ fontSize: 12, color: "var(--t2)", marginBottom: 14, lineHeight: 1.5 }}>
          Already investing? Upload your portfolio (screenshot, PDF, or CSV) or describe it below. AURA will analyze your holdings and recommend a strategy to optimize your allocation.
        </p>
        <textarea className="sta" style={{ minHeight: 60 }} value={portDesc} onChange={e => setPortDesc(e.target.value)} placeholder="e.g. 'I hold 40% MSCI World ETF, 20% Swiss bonds, 15% Apple stock, 15% Bitcoin, 10% cash'" />
        <div className="sup" onClick={() => pfref.current?.click()}>
          <I.Upload /> Upload portfolio statement (PDF, screenshot, CSV)
          <input ref={pfref} type="file" accept=".pdf,.png,.jpg,.jpeg,.csv,.txt,.xlsx" onChange={handlePortFile} style={{ display: "none" }} />
        </div>
        {portFile && (
          <div className="sfp">
            <I.File /> {portFile.name}
            <button style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", marginLeft: "auto", padding: 2 }} onClick={() => setPortFile(null)}><I.X /></button>
          </div>
        )}
        {profile.existingPortfolio && profile.existingPortfolio !== "none" && profile.existingPortfolio !== "No existing portfolio" && (
          <div style={{ marginTop: 10, padding: 10, background: "var(--bg)", borderRadius: "var(--r)", border: "1px solid var(--brd)", fontSize: 12, color: "var(--t2)" }}>
            <span style={{ fontWeight: 600, color: "var(--t1)" }}>From profile:</span> {profile.existingPortfolio}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button className="btn bp bl" onClick={gen}><I.Sparkle /> {investments.length ? "Regenerate Strategy" : "Generate Portfolio Strategy"}</button>
        {!signals.length && <button className="btn bg" onClick={() => go("signals")}><I.Plus /> Add Signals First</button>}
      </div>

      {investments.length > 0 && <>
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, display: "flex", alignItems: "center", gap: 6 }}><I.Pie /> Target Allocation</div>
          <div className="ab">{investments.map((v, i) => <div key={i} className="aseg" style={{ width: `${v.allocation||20}%`, background: COLORS[i%COLORS.length] }}>{(v.allocation||20) >= 12 ? `${v.allocation||20}%` : ""}</div>)}</div>
          <div className="al">{investments.map((v, i) => <div key={i} className="ali"><div className="ald" style={{ background: COLORS[i%COLORS.length] }} />{v.theme} ({v.allocation||20}%)</div>)}</div>
        </div>
        {investments.map((v, i) => (
          <div key={i} className="ic" onClick={() => setExp(exp === i ? null : i)}>
            <div className="ih">
              <div className="icl" style={{ background: COLORS[i%COLORS.length] }} />
              <div className="iinf"><div className="ith">{v.theme}</div>{exp !== i && <div className="isub">{v.rationale?.split(".")[0]}.</div>}</div>
              <div className="ibd"><span className="ib h">{v.timeHorizon}</span><span className={`ib r${(v.riskLevel||"moderate")[0]}`}>{v.riskLevel||"moderate"}</span></div>
              <div className="ial">{v.allocation||20}%</div>
              {exp === i ? <I.ChevD /> : <I.ChevR />}
            </div>
            {exp === i && <div className="iex" onClick={e => e.stopPropagation()}>
              <p style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.6, marginBottom: 16 }}>{v.rationale}</p>
              <div className="idg">
                <div className="im"><div className="iml">Alignment</div><div className="imv">{v.alignment}%</div><div className="ibr"><div className="ibrf" style={{ width: `${v.alignment}%`, background: "var(--acc)" }} /></div></div>
                <div className="im"><div className="iml">ESG Score</div><div className="imv">{v.esgScore||"—"}</div><div className="ibr"><div className="ibrf" style={{ width: `${v.esgScore||0}%`, background: "var(--grn)" }} /></div></div>
                <div className="im"><div className="iml">Weight</div><div className="imv">{v.allocation||20}%</div><div className="ibr"><div className="ibrf" style={{ width: `${v.allocation||20}%`, background: COLORS[i%COLORS.length] }} /></div></div>
              </div>
              <div className="iins">{(v.instruments||[]).map((inst,j) => { const t = typeof inst === "string" ? inst : inst.ticker; const n = typeof inst === "string" ? "" : inst.name; const tp = typeof inst === "string" ? "" : inst.type; return <div key={j} className="iin"><strong>{t}</strong>{n && <span style={{ color: "var(--t2)" }}>{n}</span>}{tp && <span className="iit">{tp}</span>}</div>; })}</div>
              {v.personalFit && <div className="ift"><I.Sparkle /> {v.personalFit}</div>}
            </div>}
          </div>
        ))}
        <div className="disc">AURA Private Wealth Intelligence — AI-generated portfolio strategy. Always consult a qualified financial advisor.</div>
      </>}
    </div>
  </>);
}

// ═══════════ CHAT ═══════════
function ChatPage({ data, upd }) {
  const { profile, signals } = data;
  const [msgs, setMsgs] = useState([{ role: "assistant", content: "Welcome to your private advisor. I can help you:\n\n• Update your profile — \"Change my risk to 8\"\n• Adjust preferences — \"Add real estate to sectors\"\n• Explain recommendations — \"Why clean energy?\"\n• Answer questions about your portfolio" }]);
  const [inp, setInp] = useState("");
  const [ld, setLd] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, ld]);

  async function send() {
    if (!inp.trim() || ld) return;
    const t = inp; setInp(""); setLd(true);
    const u = [...msgs, { role: "user", content: t }]; setMsgs(u);
    try {
      const r = await callClaude(CHAT_SYS(profile, signals), u.map(m => ({ role: m.role, content: m.content })));
      const p = parseJSON(r);
      if (p?.type === "profile_update" && p.changes && profile) { upd({ profile: { ...profile, ...p.changes }, investments: [] }); setMsgs([...u, { role: "assistant", content: p.message || "Profile updated." }]); }
      else if (p?.message) setMsgs([...u, { role: "assistant", content: p.message }]);
      else setMsgs([...u, { role: "assistant", content: r }]);
    } catch { setMsgs([...u, { role: "assistant", content: "Something went wrong. Please try again." }]); }
    setLd(false);
  }

  return (<>
    <div className="ph"><h1>Advisor Chat</h1><p>Update your profile or ask questions about your portfolio</p></div>
    <div className="pb" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <div className="cha">
        {msgs.map((m, i) => <div key={i} className={`cm ${m.role === "user" ? "u" : "a"}`}>{m.content}</div>)}
        {ld && <div className="dots"><div className="dot"/><div className="dot"/><div className="dot"/></div>}
        <div ref={endRef} />
      </div>
      <div className="cb">
        <input className="inp ci" value={inp} onChange={e => setInp(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder={profile ? "Ask a question or update your profile..." : "Complete profile first..."} disabled={ld || !profile} />
        <button className="cs" onClick={send} disabled={ld || !inp.trim() || !profile}><I.Send /> Send</button>
      </div>
    </div>
  </>);
}
