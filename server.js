// ============================================================
// ManifestTools — Key Server (PostgreSQL)
// Rocket Way // 20.05.2026
// Login: Manifest / mama22112012
// ============================================================

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// БД
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'reseller',
      limit_keys INTEGER DEFAULT 50,
      active     INTEGER DEFAULT 1,
      created    BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS keys (
      id        SERIAL PRIMARY KEY,
      key_value TEXT UNIQUE NOT NULL,
      duration  TEXT NOT NULL,
      tier      TEXT NOT NULL DEFAULT 'vip',
      owner     TEXT NOT NULL,
      created   BIGINT NOT NULL,
      used      INTEGER DEFAULT 0
    );
  `);

  const r = await pool.query("SELECT * FROM users WHERE role='admin'");
  if (r.rows.length === 0) {
    await pool.query(
      `INSERT INTO users (username, password, role, limit_keys, active, created)
       VALUES ($1, $2, 'admin', 999999, 1, $3)`,
      ['Manifest', 'mama22112012', Date.now()]
    );
    console.log('[INIT] Admin: Manifest / mama22112012');
  }
}

initDB().catch(e => console.error('[DB INIT ERROR]', e));

// ============================================================
// AUTH
// ============================================================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Введите данные' });

    const r = await pool.query(
      'SELECT * FROM users WHERE username=$1 AND password=$2 AND active=1',
      [username, password]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Неверный логин или пароль' });

    const u = r.rows[0];
    res.json({ user: u.username, role: u.role, limit: u.limit_keys });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
// ГЕНЕРАЦИЯ
// ============================================================
function cleanPrefix(p) {
  if (!p) return 'MT';
  let s = String(p).replace(/[^A-Za-z0-9_\-]/g, '');
  if (s.length === 0) s = 'MT';
  if (s.length > 20) s = s.slice(0, 20);
  return s;
}

function randomKey(prefix) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const s = () => Array.from({ length: 5 }, () =>
    c[Math.floor(Math.random() * c.length)]).join('');
  return `${prefix}-${s()}-${s()}-${s()}`;
}

app.post('/api/generate', async (req, res) => {
  try {
    const { username, count, duration, tier, prefix } = req.body || {};
    const ur = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (ur.rows.length === 0) return res.status(401).json({ error: 'Нет доступа' });
    const user = ur.rows[0];

    const cnt = Math.max(1, Math.min(200, +count || 1));
    const okD = ['1 день', '3 дня', '7 дней', '14 дней', '30 дней'];
    const dur = okD.includes(duration) ? duration : '7 дней';
    const tr  = ['basic', 'pro', 'vip'].includes(tier) ? tier : 'vip';
    const pfx = cleanPrefix(prefix);

    if (user.role === 'reseller') {
      const cr = await pool.query('SELECT COUNT(*) AS c FROM keys WHERE owner=$1', [username]);
      const mine = +cr.rows[0].c;
      if (mine + cnt > user.limit_keys) {
        return res.status(400).json({ error: `Лимит исчерпан. У вас ${mine}/${user.limit_keys}.` });
      }
    }

    const out = [];
    for (let i = 0; i < cnt; i++) {
      let k, ok = false, tries = 0;
      while (!ok && tries < 20) {
        k = randomKey(pfx);
        const chk = await pool.query('SELECT id FROM keys WHERE key_value=$1', [k]);
        if (chk.rows.length === 0) ok = true;
        tries++;
      }
      await pool.query(
        'INSERT INTO keys (key_value, duration, tier, owner, created) VALUES ($1,$2,$3,$4,$5)',
        [k, dur, tr, username, Date.now()]
      );
      out.push(k);
    }

    res.json({ keys: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка генерации' });
  }
});

// ============================================================
// КЛЮЧИ
// ============================================================
app.get('/api/keys', async (req, res) => {
  try {
    const { username } = req.query;
    const ur = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (ur.rows.length === 0) return res.status(401).json({ error: 'Нет доступа' });
    const user = ur.rows[0];

    const rows = user.role === 'admin'
      ? (await pool.query('SELECT * FROM keys ORDER BY created DESC')).rows
      : (await pool.query('SELECT * FROM keys WHERE owner=$1 ORDER BY created DESC', [username])).rows;

    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
// СТАТИСТИКА
// ============================================================
app.get('/api/stats', async (req, res) => {
  try {
    const { username } = req.query;
    const ur = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (ur.rows.length === 0) return res.status(401).json({ error: 'Нет доступа' });
    const user = ur.rows[0];

    if (user.role === 'admin') {
      const total     = +(await pool.query('SELECT COUNT(*) AS c FROM keys')).rows[0].c;
      const active    = +(await pool.query('SELECT COUNT(*) AS c FROM keys WHERE used=0')).rows[0].c;
      const used      = +(await pool.query('SELECT COUNT(*) AS c FROM keys WHERE used=1')).rows[0].c;
      const resellers = +(await pool.query("SELECT COUNT(*) AS c FROM users WHERE role='reseller'")).rows[0].c;

      const byOwner = (await pool.query(`
        SELECT owner,
               COUNT(*)::int AS count,
               SUM(CASE WHEN used=0 THEN 1 ELSE 0 END)::int AS active,
               SUM(CASE WHEN used=1 THEN 1 ELSE 0 END)::int AS used
        FROM keys GROUP BY owner ORDER BY count DESC
      `)).rows;

      return res.json({ total, active, used, resellers, byOwner });
    }

    const total  = +(await pool.query('SELECT COUNT(*) AS c FROM keys WHERE owner=$1', [username])).rows[0].c;
    const active = +(await pool.query('SELECT COUNT(*) AS c FROM keys WHERE owner=$1 AND used=0', [username])).rows[0].c;
    const used   = +(await pool.query('SELECT COUNT(*) AS c FROM keys WHERE owner=$1 AND used=1', [username])).rows[0].c;
    res.json({ total, active, used, resellers: 0, byOwner: [] });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
// РЕСЕЛЛЕРЫ
// ============================================================
app.get('/api/resellers', async (req, res) => {
  try {
    const { username } = req.query;
    const a = (await pool.query('SELECT * FROM users WHERE username=$1', [username])).rows[0];
    if (!a || a.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });

    const list = (await pool.query(`
      SELECT u.username, u.password, u.limit_keys, u.active, u.created,
             (SELECT COUNT(*)::int FROM keys WHERE owner=u.username) AS key_count
      FROM users u WHERE u.role='reseller' ORDER BY u.created DESC
    `)).rows;

    res.json(list);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/resellers', async (req, res) => {
  try {
    const { adminUser, resellerUser, resellerPass, limit } = req.body || {};
    const a = (await pool.query('SELECT * FROM users WHERE username=$1', [adminUser])).rows[0];
    if (!a || a.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
    if (!resellerUser || !resellerPass) return res.status(400).json({ error: 'Заполни логин и пароль' });

    const ex = await pool.query('SELECT id FROM users WHERE username=$1', [resellerUser]);
    if (ex.rows.length > 0) return res.status(400).json({ error: 'Логин занят' });

    await pool.query(
      `INSERT INTO users (username, password, role, limit_keys, active, created)
       VALUES ($1, $2, 'reseller', $3, 1, $4)`,
      [resellerUser, resellerPass, +limit || 50, Date.now()]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/resellers/toggle', async (req, res) => {
  try {
    const { adminUser, target } = req.body || {};
    const a = (await pool.query('SELECT * FROM users WHERE username=$1', [adminUser])).rows[0];
    if (!a || a.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });

    const r = (await pool.query("SELECT * FROM users WHERE username=$1 AND role='reseller'", [target])).rows[0];
    if (!r) return res.status(404).json({ error: 'Не найден' });

    await pool.query('UPDATE users SET active=$1 WHERE username=$2', [r.active ? 0 : 1, target]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/resellers/delete', async (req, res) => {
  try {
    const { adminUser, target } = req.body || {};
    const a = (await pool.query('SELECT * FROM users WHERE username=$1', [adminUser])).rows[0];
    if (!a || a.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });

    await pool.query("DELETE FROM users WHERE username=$1 AND role='reseller'", [target]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
app.listen(PORT, () => {
  console.log(`[ManifestTools] http://localhost:${PORT}`);
});
