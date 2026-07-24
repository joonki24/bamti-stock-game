const express = require('express');
const fs = require('fs');
const path = require('path');

const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const DB_PATH = path.join(BASE_DIR, 'db.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

function initDB() {
  const teams = {};
  config.teams.forEach((name, i) => {
    const id = 't' + (i + 1);
    teams[id] = {
      id, name,
      balance: config.initialCapital,
      holdings: {},        // companyId -> shares
      cost: {},            // companyId -> total BT invested (for avg cost / P&L)
      infoCards: [],        // {companyId, day, level, source, headline, body}
      log: [],
    };
  });

  const stocks = {};
  config.companies.forEach(c => {
    stocks[c.id] = {
      id: c.id, name: c.name, price: c.basePrice, prevPrice: c.basePrice,
      merged: false, mergedInto: null,
    };
  });

  const db = {
    day: 0,
    merged: false,
    teams,
    stocks,
    mergedCompany: null,   // filled in when merge happens
    boothAttempts: {},     // teamId -> day -> {1:used,2:used,3:used} (pooled across all booths/companies)
    groupGameDone: {},     // day -> true once batch reward submitted
  };
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  return db;
}

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return initDB();
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (!db.boothAttempts) db.boothAttempts = {};
  if (!db.groupGameDone) db.groupGameDone = {};
  Object.values(db.teams).forEach(t => { if (!t.cost) t.cost = {}; });
  return db;
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function activeCompanies(db) {
  const list = config.companies.filter(c => !db.stocks[c.id].merged).map(c => db.stocks[c.id]);
  if (db.merged && db.mergedCompany) list.push(db.mergedCompany);
  return list;
}

function teamHoldingsValue(db, team) {
  let v = 0;
  for (const [cid, qty] of Object.entries(team.holdings)) {
    if (qty <= 0) continue;
    const stock = db.stocks[cid] || (db.mergedCompany && db.mergedCompany.id === cid ? db.mergedCompany : null);
    if (stock) v += stock.price * qty;
  }
  return v;
}

function teamSummary(db, team) {
  const totalValue = team.balance + teamHoldingsValue(db, team);
  const returnPct = Math.round(((totalValue - config.initialCapital) / config.initialCapital) * 1000) / 10;
  return { id: team.id, name: team.name, balance: team.balance, totalValue, returnPct };
}

function companyByIdAnyDay(cid) {
  return config.companies.find(c => c.id === cid) || null;
}

function getScenarioEntry(cid, day) {
  // day is 1-based
  if (cid === 'cM') return config.merge.scenario[day - 1] || null;
  const c = companyByIdAnyDay(cid);
  if (!c) return null;
  return c.scenario[day - 1] || null;
}

const app = express();
app.use(express.json());

// prevent mobile browsers from caching API responses (fixes stale/late updates)
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const BLOCKED_FILES = ['/server.js', '/package.json', '/package-lock.json', '/db.json', '/config.json', '/build_config.js', '/.gitignore'];
app.use((req, res, next) => {
  if (BLOCKED_FILES.includes(req.path)) return res.status(404).send('Not found');
  next();
});

// ---------- read endpoints ----------
app.get('/api/state', (req, res) => {
  const db = loadDB();
  res.json({ day: db.day, totalDays: config.totalDays, merged: db.merged, isGroupGameDay: config.groupGame.days.includes(db.day) });
});

function logoFor(companyId) {
  const fname = `logo-${companyId}.png`;
  return fs.existsSync(path.join(BASE_DIR, fname)) ? '/' + fname : null;
}

app.get('/api/companies', (req, res) => {
  const db = loadDB();
  const list = activeCompanies(db).map(s => {
    const changePct = s.prevPrice ? Math.round(((s.price - s.prevPrice) / s.prevPrice) * 1000) / 10 : 0;
    return { id: s.id, name: s.name, price: s.price, changePct, merged: s.merged || false, logo: logoFor(s.id) };
  });
  const mergedOut = config.companies.filter(c => db.stocks[c.id].merged).map(c => ({
    id: c.id, name: c.name, price: db.stocks[c.id].price, merged: true, mergedInto: db.stocks[c.id].mergedInto, logo: logoFor(c.id),
  }));
  res.json([...list, ...mergedOut]);
});

app.get('/api/teams', (req, res) => {
  const db = loadDB();
  const list = Object.values(db.teams).map(t => teamSummary(db, t))
    .sort((a, b) => b.returnPct - a.returnPct);
  res.json(list);
});

app.get('/api/team/:id', (req, res) => {
  const db = loadDB();
  const team = db.teams[req.params.id];
  if (!team) return res.status(404).json({ error: '조를 찾을 수 없습니다' });
  const holdings = Object.entries(team.holdings).filter(([, q]) => q > 0).map(([cid, qty]) => {
    const stock = db.stocks[cid] || (db.mergedCompany && db.mergedCompany.id === cid ? db.mergedCompany : null);
    const price = stock ? stock.price : 0;
    const value = price * qty;
    const invested = team.cost[cid] || 0;
    const avgCost = qty > 0 ? invested / qty : 0;
    const profitBT = value - invested;
    const profitPct = invested > 0 ? Math.round((profitBT / invested) * 1000) / 10 : 0;
    return { companyId: cid, name: stock ? stock.name : cid, qty, price, value, avgCost, invested, profitBT, profitPct, logo: logoFor(cid) };
  });
  res.json({ ...teamSummary(db, team), holdings, infoCards: team.infoCards, log: team.log.slice(-20).reverse() });
});

// ---------- trade ----------
app.post('/api/trade', (req, res) => {
  const db = loadDB();
  const { teamId, companyId, action, qty } = req.body;
  const team = db.teams[teamId];
  if (!team) return res.status(400).json({ error: '조를 찾을 수 없습니다' });
  if (db.day < 1) return res.status(400).json({ error: '아직 거래가 시작되지 않았습니다' });
  if (db.day > config.totalDays) return res.status(400).json({ error: '게임이 종료되어 더 이상 거래할 수 없습니다' });
  const stock = db.stocks[companyId] || (db.mergedCompany && db.mergedCompany.id === companyId ? db.mergedCompany : null);
  if (!stock) return res.status(400).json({ error: '종목을 찾을 수 없습니다' });
  if (stock.merged) return res.status(400).json({ error: '합병되어 더 이상 거래할 수 없는 종목입니다' });
  const n = Number(qty);
  if (!n || n <= 0) return res.status(400).json({ error: '수량을 확인해주세요' });

  if (action === 'buy') {
    const cost = stock.price * n;
    if (cost > team.balance) return res.status(400).json({ error: '잔액이 부족합니다' });
    team.balance -= cost;
    team.holdings[companyId] = (team.holdings[companyId] || 0) + n;
    team.cost[companyId] = (team.cost[companyId] || 0) + cost;
    team.log.push({ type: 'buy', companyId, name: stock.name, qty: n, price: stock.price, day: db.day });
  } else if (action === 'sell') {
    const have = team.holdings[companyId] || 0;
    if (n > have) return res.status(400).json({ error: '보유 수량보다 많이 팔 수 없습니다' });
    const costPerShare = have > 0 ? (team.cost[companyId] || 0) / have : 0;
    team.holdings[companyId] = have - n;
    team.cost[companyId] = Math.max(0, (team.cost[companyId] || 0) - costPerShare * n);
    team.balance += stock.price * n;
    team.log.push({ type: 'sell', companyId, name: stock.name, qty: n, price: stock.price, day: db.day });
  } else {
    return res.status(400).json({ error: 'action은 buy 또는 sell 이어야 합니다' });
  }
  saveDB(db);
  res.json({ ok: true, team: teamSummary(db, team) });
});

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
function imgExists(fname) { return fs.existsSync(path.join(BASE_DIR, fname)) ? '/' + fname : null; }
function findCardImage(companyId, day, level) {
  // prefer the exact level, then fall back to lower levels, then legacy day-only image
  const lv = level || 1;
  for (let l = lv; l >= 1; l--) {
    for (const ext of IMAGE_EXTS) {
      const hit = imgExists(`img-${companyId}-${day}-${l}.${ext}`);
      if (hit) return hit;
    }
  }
  for (const ext of IMAGE_EXTS) {
    const hit = imgExists(`img-${companyId}-${day}.${ext}`);
    if (hit) return hit;
  }
  return null;
}

function buildCard(entry, level, source, companyId, day) {
  const c = companyId === 'cM' ? { name: config.merge.newName } : companyByIdAnyDay(companyId);
  // each level has its own self-contained line (l1/l2/l3); fall back to legacy headline/body
  let headline = entry['l' + level] || entry.headline || '';
  let image = findCardImage(companyId, day, level);
  // display mode per level: 'text' = 텍스트만 / 'image' = 이미지만(텍스트 숨김) / 없음 = 둘 다(이미지 있으면)
  const mode = entry['mode' + level];
  if (mode === 'text') image = null;
  if (mode === 'image' && image) headline = '';
  const body = '';
  return { companyId, companyName: c.name, day, level, source, headline, body, image, logo: logoFor(companyId) };
}

// ---------- booth: level clear -> flat BT reward + level info, limited attempts/day (pooled across booths) ----------
app.get('/api/booth/attempts/:teamId', (req, res) => {
  const db = loadDB();
  const team = db.teams[req.params.teamId];
  if (!team) return res.status(400).json({ error: '조를 찾을 수 없습니다' });
  const used = (db.boothAttempts[req.params.teamId] || {})[db.day] || {};
  const remaining = {};
  [1, 2, 3].forEach(l => { remaining[l] = Math.max(0, config.boothLimits[l] - (used[l] || 0)); });
  res.json({ day: db.day, remaining, limits: config.boothLimits, isGroupGameDay: config.groupGame.days.includes(db.day) });
});

app.post('/api/booth/attempt', (req, res) => {
  const db = loadDB();
  const { teamId, companyId, level, success } = req.body;
  const team = db.teams[teamId];
  if (!team) return res.status(400).json({ error: '조를 찾을 수 없습니다' });
  if (db.day < 1) return res.status(400).json({ error: '거래일이 아직 시작되지 않았습니다' });
  if (db.day > config.totalDays) return res.status(400).json({ error: '게임이 종료되어 더 이상 진행할 수 없습니다' });
  if (config.groupGame.days.includes(db.day)) return res.status(400).json({ error: '오늘은 단체 게임으로 진행되는 날입니다' });
  const stockCheck = db.stocks[companyId] || (db.mergedCompany && db.mergedCompany.id === companyId ? db.mergedCompany : null);
  if (stockCheck && stockCheck.merged) return res.status(400).json({ error: '합병되어 더 이상 정보가 제공되지 않는 종목입니다' });
  const lvl = Number(level);
  if (![1, 2, 3].includes(lvl)) return res.status(400).json({ error: '레벨은 1~3 중 하나여야 합니다' });

  if (!db.boothAttempts[teamId]) db.boothAttempts[teamId] = {};
  if (!db.boothAttempts[teamId][db.day]) db.boothAttempts[teamId][db.day] = { 1: 0, 2: 0, 3: 0 };
  const used = db.boothAttempts[teamId][db.day][lvl] || 0;
  const limit = config.boothLimits[lvl];
  if (used >= limit) return res.status(400).json({ error: `오늘 ${lvl}단계 시도 횟수를 모두 사용했습니다 (최대 ${limit}회)` });

  if (success) {
    const entry = getScenarioEntry(companyId, db.day);
    if (!entry) return res.status(400).json({ error: '오늘은 이 종목의 정보가 없습니다' });
    db.boothAttempts[teamId][db.day][lvl] = used + 1;
    const card = buildCard(entry, lvl, 'booth', companyId, db.day);
    team.infoCards.push(card);
    team.balance += config.boothReward;
    team.log.push({ type: 'booth_success', companyId, level: lvl, bt: config.boothReward, day: db.day });
    saveDB(db);
    return res.json({ ok: true, success: true, card, bt: config.boothReward, remaining: limit - (used + 1) });
  } else {
    db.boothAttempts[teamId][db.day][lvl] = used + 1;
    team.log.push({ type: 'booth_fail', companyId, level: lvl, day: db.day });
    saveDB(db);
    return res.json({ ok: true, success: false, card: null, remaining: limit - (used + 1) });
  }
});

// ---------- staff: manual BT adjustment (optional, situational, no team-facing alert) ----------
app.post('/api/team/adjust', (req, res) => {
  const db = loadDB();
  const { teamId, amount } = req.body;
  const team = db.teams[teamId];
  if (!team) return res.status(400).json({ error: '조를 찾을 수 없습니다' });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: '금액을 입력해주세요' });
  team.balance = Math.max(0, team.balance + amt);
  team.log.push({ type: 'adjust', amount: amt, day: db.day });
  saveDB(db);
  res.json({ ok: true, team: teamSummary(db, team) });
});

// ---------- day 4~5: 단체 게임 순위 보상 (일괄 지급) ----------
app.get('/api/groupgame/status', (req, res) => {
  const db = loadDB();
  res.json({
    day: db.day,
    isGroupGameDay: config.groupGame.days.includes(db.day),
    done: !!db.groupGameDone[db.day],
    tiers: config.groupGame.tiers,
  });
});

app.post('/api/groupgame/reward', (req, res) => {
  const db = loadDB();
  if (!config.groupGame.days.includes(db.day)) return res.status(400).json({ error: '오늘은 단체 게임 날이 아닙니다' });
  if (db.groupGameDone[db.day]) return res.status(400).json({ error: db.day + '거래일 단체 게임 보상은 이미 지급되었습니다' });
  const { entries } = req.body; // [{teamId, rank, companyId}]
  if (!Array.isArray(entries) || entries.length !== config.teams.length) {
    return res.status(400).json({ error: '모든 조의 순위를 입력해주세요' });
  }
  const ranks = entries.map(e => Number(e.rank));
  const rankSet = new Set(ranks);
  if (rankSet.size !== entries.length || ranks.some(r => r < 1 || r > entries.length)) {
    return res.status(400).json({ error: '순위가 중복되었거나 올바르지 않습니다' });
  }
  for (const e of entries) {
    if (!db.teams[e.teamId]) return res.status(400).json({ error: '조를 찾을 수 없습니다: ' + e.teamId });
    const stockCheck = db.stocks[e.companyId] || (db.mergedCompany && db.mergedCompany.id === e.companyId ? db.mergedCompany : null);
    if (!stockCheck || stockCheck.merged) return res.status(400).json({ error: '유효하지 않은 종목입니다' });
    if (!getScenarioEntry(e.companyId, db.day)) return res.status(400).json({ error: '오늘은 이 종목의 정보가 없습니다' });
  }
  const results = [];
  for (const e of entries) {
    const team = db.teams[e.teamId];
    const tier = config.groupGame.tiers.find(t => t.rank === Number(e.rank));
    const entry = getScenarioEntry(e.companyId, db.day);
    const card = buildCard(entry, tier.level, 'groupgame', e.companyId, db.day);
    team.infoCards.push(card);
    team.balance += tier.bt;
    team.log.push({ type: 'groupgame', rank: tier.rank, companyId: e.companyId, level: tier.level, bt: tier.bt, day: db.day });
    results.push({ teamId: e.teamId, rank: tier.rank, bt: tier.bt, level: tier.level });
  }
  db.groupGameDone[db.day] = true;
  saveDB(db);
  res.json({ ok: true, results });
});

// ---------- day advance: auto-applies pre-scripted scenario, triggers merge ----------
app.post('/api/day/advance', (req, res) => {
  const db = loadDB();
  if (db.day > config.totalDays) return res.status(400).json({ error: '이미 게임이 종료되었습니다' });

  // day 0 -> 1: just starts trading at the base price, nothing to reveal yet
  if (db.day === 0) {
    db.day = 1;
    saveDB(db);
    return res.json({ ok: true, day: db.day, revealed: false });
  }

  const revealDay = db.day; // the round that is now closing

  // 1. reveal this round's scripted price for every active (non-merged) company
  config.companies.forEach(c => {
    if (db.stocks[c.id].merged) return;
    const entry = c.scenario[revealDay - 1];
    if (entry) {
      db.stocks[c.id].prevPrice = db.stocks[c.id].price;
      db.stocks[c.id].price = entry.price;
    }
  });
  if (db.merged && db.mergedCompany) {
    const entry = config.merge.scenario[revealDay - 1];
    if (entry) {
      db.mergedCompany.prevPrice = db.mergedCompany.price;
      db.mergedCompany.price = entry.price;
    }
  }

  // 2. merge trigger: happens right as the configured day closes, using the price just revealed above
  if (revealDay === config.merge.afterDay && !db.merged) {
    const [srcA, srcB] = config.merge.sourceIds;
    const priceA = db.stocks[srcA].price, priceB = db.stocks[srcB].price;
    const newPrice = priceA + priceB;
    db.mergedCompany = { id: config.merge.newId, name: config.merge.newName, price: newPrice, prevPrice: newPrice, merged: false };
    Object.values(db.teams).forEach(team => {
      const qtyA = team.holdings[srcA] || 0, qtyB = team.holdings[srcB] || 0;
      const combinedValue = qtyA * priceA + qtyB * priceB;
      if (combinedValue > 0) {
        team.holdings[config.merge.newId] = (team.holdings[config.merge.newId] || 0) + combinedValue / newPrice;
        team.cost[config.merge.newId] = (team.cost[config.merge.newId] || 0) + combinedValue;
      }
      team.holdings[srcA] = 0; team.cost[srcA] = 0;
      team.holdings[srcB] = 0; team.cost[srcB] = 0;
    });
    db.stocks[srcA].merged = true; db.stocks[srcA].mergedInto = config.merge.newName;
    db.stocks[srcB].merged = true; db.stocks[srcB].mergedInto = config.merge.newName;
    db.merged = true;
  }

  // 3. move to the next round
  db.day = revealDay + 1;
  saveDB(db);
  res.json({ ok: true, day: db.day, revealed: true, revealedDay: revealDay });
});

app.post('/api/reset', (req, res) => {
  const db = initDB();
  res.json({ ok: true, day: db.day });
});

app.get('/api/config', (req, res) => {
  res.json({
    initialCapital: config.initialCapital,
    totalDays: config.totalDays,
    teams: config.teams,
    booths: config.booths,
    boothLimits: config.boothLimits,
    boothReward: config.boothReward,
    groupGame: config.groupGame,
  });
});

// always serve fresh HTML so every device runs the latest code (no stale cached pages)
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') res.set('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(BASE_DIR));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('밤티코인 서버 실행 중: http://localhost:' + PORT);
});
