// ============================================================
// ManifestTools — Key Server + Bot API (PostgreSQL)
// Rocket Way // 20.05.2026
// Login: Manifest / mama22112012
// ============================================================

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// КОНСТАНТЫ БОТА
// ============================================================
const BOT_SECRET = process.env.BOT_SECRET || 'Manifest_tools_key_1120';
const PRICES = {
  '1 день':  50,
  '3 дня':   100,
  '7 дней':  170,
  '14 дней': 280,
  '30 дней': 500
};

// ============================================================
// БАЗА
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  // Пользователи
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

  // Ключи
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
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS hwid TEXT;`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS expires BIGINT;`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS used_by TEXT;`);
  await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS used_at BIGINT;`);

  // Оффсеты
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offsets (
      id       SERIAL PRIMARY KEY,
      version  TEXT NOT NULL,
      server   TEXT NOT NULL,
      arch     TEXT NOT NULL,
      name     TEXT NOT NULL,
      value    TEXT NOT NULL,
      updated  BIGINT NOT NULL,
      UNIQUE(version, server, arch, name)
    );
  `);

  // Конфиги юзеров
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_configs (
      hwid     TEXT PRIMARY KEY,
      config   JSONB NOT NULL,
      updated  BIGINT NOT NULL
    );
  `);

  // Заказы бота
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      tg_id       BIGINT NOT NULL,
      tg_username TEXT,
      duration    TEXT NOT NULL,
      price       INTEGER NOT NULL,
      key_value   TEXT,
      status      TEXT DEFAULT 'pending',
      created     BIGINT NOT NULL,
      paid_at     BIGINT
    );
  `);

  // Отзывы
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id          SERIAL PRIMARY KEY,
      tg_id       BIGINT NOT NULL,
      tg_username TEXT,
      text        TEXT NOT NULL,
      rating      INTEGER DEFAULT 5,
      created     BIGINT NOT NULL
    );
  `);

  // Админ
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
// ГЕНЕРАЦИЯ КЛЮЧЕЙ
// ============================================================
const DURATION_CODE = {
  '1 день':   '1d',
  '3 дня':    '3d',
  '7 дней':   '7d',
  '14 дней':  '14d',
  '30 дней':  '30d'
};

function randomPart(len) {
  const c = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: len }, () =>
    c[Math.floor(Math.random() * c.length)]).join('');
}

function makeKeyByDuration(duration) {
  const code = DURATION_CODE[duration] || '7d';
  return `MT-${code}-${randomPart(10)}`;
}

function cleanCustomKey(k) {
  if (!k) return null;
  let s = String(k).trim();
  if (s.length === 0) return null;
  s = s.replace(/[^A-Za-z0-9_\-@.]/g, '');
  if (s.length === 0) return null;
  if (s.length > 60) s = s.slice(0, 60);
  return s;
}

app.post('/api/generate', async (req, res) => {
  try {
    const { username, count, duration, tier, mode, customKey } = req.body || {};
    const ur = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (ur.rows.length === 0) return res.status(401).json({ error: 'Нет доступа' });
    const user = ur.rows[0];

    const cnt = Math.max(1, Math.min(200, +count || 1));
    const okD = ['1 день', '3 дня', '7 дней', '14 дней', '30 дней'];
    const dur = okD.includes(duration) ? duration : '7 дней';
    const tr  = ['basic', 'pro', 'vip'].includes(tier) ? tier : 'vip';

    if (user.role === 'reseller') {
      const cr = await pool.query('SELECT COUNT(*) AS c FROM keys WHERE owner=$1', [username]);
      const mine = +cr.rows[0].c;
      if (mine + cnt > user.limit_keys) {
        return res.status(400).json({ error: `Лимит исчерпан. У вас ${mine}/${user.limit_keys}.` });
      }
    }

    const out = [];

    if (mode === 'custom') {
      const base = cleanCustomKey(customKey);
      if (!base) return res.status(400).json({ error: 'Введи свой ключ' });
      if (cnt > 1) return res.status(400).json({ error: 'Свой ключ — только 1 штука' });

      const chk = await pool.query('SELECT id FROM keys WHERE key_value=$1', [base]);
      if (chk.rows.length > 0) return res.status(400).json({ error: 'Такой ключ уже существует' });

      await pool.query(
        'INSERT INTO keys (key_value, duration, tier, owner, created) VALUES ($1,$2,$3,$4,$5)',
        [base, dur, tr, username, Date.now()]
      );
      out.push(base);
    } else {
      for (let i = 0; i < cnt; i++) {
        let k, ok = false, tries = 0;
        while (!ok && tries < 20) {
          k = makeKeyByDuration(dur);
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
    }

    res.json({ keys: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка генерации' });
  }
});

// ============================================================
// ПРОВЕРКА КЛЮЧА (для чита)
// ============================================================
app.post('/api/check', async (req, res) => {
  try {
    const { key, hwid } = req.body || {};
    if (!key) return res.json({ ok: false, error: 'Ключ не указан' });

    const r = await pool.query('SELECT * FROM keys WHERE key_value=$1', [key]);
    if (r.rows.length === 0) return res.json({ ok: false, error: 'Ключ не найден' });

    const k = r.rows[0];
    const now = Date.now();

    if (k.used === 1) {
      if (k.hwid && hwid && k.hwid === hwid) {
        if (k.expires && now > k.expires) {
          return res.json({ ok: false, error: 'Срок ключа истёк' });
        }
        return res.json({
          ok: true, tier: k.tier, duration: k.duration,
          expires: k.expires, message: 'Добро пожаловать'
        });
      }
      return res.json({ ok: false, error: 'Ключ привязан к другому устройству' });
    }

    const durMap = {
      '1 день':   1  * 86400000,
      '3 дня':    3  * 86400000,
      '7 дней':   7  * 86400000,
      '14 дней':  14 * 86400000,
      '30 дней':  30 * 86400000
    };
    const expires = durMap[k.duration] ? now + durMap[k.duration] : null;

    await pool.query(
      `UPDATE keys SET used=1, used_by=$1, used_at=$2, hwid=$3, expires=$4
       WHERE key_value=$5`,
      [hwid || 'unknown', now, hwid || 'unknown', expires, key]
    );

    res.json({
      ok: true, tier: k.tier, duration: k.duration,
      expires, message: 'Ключ активирован'
    });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, error: 'Ошибка сервера' });
  }
});

// ============================================================
// КЛЮЧИ (с фильтром)
// ============================================================
app.get('/api/keys', async (req, res) => {
  try {
    const { username, filter } = req.query;
    const ur = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (ur.rows.length === 0) return res.status(401).json({ error: 'Нет доступа' });
    const user = ur.rows[0];

    let query, params;

    if (user.role === 'admin') {
      if (filter === 'mine') {
        query = 'SELECT * FROM keys WHERE owner=$1 ORDER BY created DESC';
        params = [username];
      } else if (filter === 'bot') {
        query = "SELECT * FROM keys WHERE owner='BOT' ORDER BY created DESC";
        params = [];
      } else if (filter === 'resellers') {
        query = "SELECT * FROM keys WHERE owner!='BOT' AND owner!=$1 ORDER BY created DESC";
        params = [username];
      } else {
        query = 'SELECT * FROM keys ORDER BY created DESC';
        params = [];
      }
    } else {
      query = 'SELECT * FROM keys WHERE owner=$1 ORDER BY created DESC';
      params = [username];
    }

    const rows = await pool.query(query, params);
    res.json(rows.rows);
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
      const botKeys   = +(await pool.query("SELECT COUNT(*) AS c FROM keys WHERE owner='BOT'")).rows[0].c;

      const byOwner = (await pool.query(`
        SELECT owner, COUNT(*)::int AS count,
               SUM(CASE WHEN used=0 THEN 1 ELSE 0 END)::int AS active,
               SUM(CASE WHEN used=1 THEN 1 ELSE 0 END)::int AS used
        FROM keys GROUP BY owner ORDER BY count DESC
      `)).rows;

      return res.json({ total, active, used, resellers, botKeys, byOwner });
    }

    const total  = +(await pool.query('SELECT COUNT(*) AS c FROM keys WHERE owner=$1', [username])).rows[0].c;
    const active = +(await pool.query('SELECT COUNT(*) AS c FROM keys WHERE owner=$1 AND used=0', [username])).rows[0].c;
    const used   = +(await pool.query('SELECT COUNT(*) AS c FROM keys WHERE owner=$1 AND used=1', [username])).rows[0].c;
    res.json({ total, active, used, resellers: 0, botKeys: 0, byOwner: [] });
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
// СМЕНА ПАРОЛЯ
// ============================================================
app.post('/api/change-password', async (req, res) => {
  try {
    const { username, oldPass, newPass } = req.body || {};
    const u = (await pool.query('SELECT * FROM users WHERE username=$1 AND password=$2', [username, oldPass])).rows[0];
    if (!u) return res.status(401).json({ error: 'Неверный старый пароль' });
    if (!newPass || newPass.length < 4) return res.status(400).json({ error: 'Мин 4 символа' });

    await pool.query('UPDATE users SET password=$1 WHERE username=$2', [newPass, username]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
// OFFSETS — GITHUB SYNC
// ============================================================
const GITHUB_OFFSETS_URL = process.env.GITHUB_OFFSETS_URL ||
  'https://raw.githubusercontent.com/DmitryNagievh/manifest-offsets/main/offsets.json';

function fetchGithubOffsets() {
  return new Promise((resolve, reject) => {
    https.get(GITHUB_OFFSETS_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function syncOffsetsFromGithub() {
  try {
    const data = await fetchGithubOffsets();
    let count = 0;

    for (const version in data) {
      for (const server in data[version]) {
        for (const arch in data[version][server]) {
          const offsets = data[version][server][arch];
          for (const name in offsets) {
            const value = String(offsets[name]);
            await pool.query(`
              INSERT INTO offsets (version, server, arch, name, value, updated)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (version, server, arch, name)
              DO UPDATE SET value = $5, updated = $6
            `, [version, server, arch, name, value, Date.now()]);
            count++;
          }
        }
      }
    }

    console.log(`[OFFSETS] Синхронизировано: ${count} записей`);
  } catch (e) {
    console.error('[OFFSETS] Ошибка:', e.message);
  }
}

setInterval(syncOffsetsFromGithub, 5 * 60 * 1000);
setTimeout(syncOffsetsFromGithub, 10000);

// ============================================================
// OFFSETS — API
// ============================================================
app.get('/api/offsets', async (req, res) => {
  try {
    const { version, server, arch } = req.query;
    if (!version || !server || !arch) {
      return res.status(400).json({ error: 'Укажи version, server, arch' });
    }

    const rows = await pool.query(
      'SELECT name, value FROM offsets WHERE version=$1 AND server=$2 AND arch=$3',
      [version, server, arch]
    );

    const offsets = {};
    rows.rows.forEach(r => offsets[r.name] = r.value);

    res.json({
      version, server, arch,
      offsets,
      count: rows.rows.length,
      updated: Date.now()
    });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/offsets/list', async (req, res) => {
  try {
    const { adminUser } = req.query;
    const a = (await pool.query('SELECT * FROM users WHERE username=$1', [adminUser])).rows[0];
    if (!a || a.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });

    const rows = await pool.query('SELECT * FROM offsets ORDER BY version, server, arch, name');
    res.json(rows.rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/offsets/set', async (req, res) => {
  try {
    const { adminUser, version, server, arch, name, value } = req.body || {};
    const a = (await pool.query('SELECT * FROM users WHERE username=$1', [adminUser])).rows[0];
    if (!a || a.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });

    await pool.query(`
      INSERT INTO offsets (version, server, arch, name, value, updated)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (version, server, arch, name)
      DO UPDATE SET value = $5, updated = $6
    `, [version, server, arch, name, String(value), Date.now()]);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/offsets/sync', async (req, res) => {
  try {
    const { adminUser } = req.body || {};
    const a = (await pool.query('SELECT * FROM users WHERE username=$1', [adminUser])).rows[0];
    if (!a || a.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });

    await syncOffsetsFromGithub();
    res.json({ ok: true, message: 'Синхронизировано' });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
// USER CONFIG
// ============================================================
const DEFAULT_CONFIG = {
  aimbot:        false,
  instant_hit:   false,
  no_recoil:     true,
  no_spread:     true,
  shoot_bullet:  false,
  calc_shoot:    false,
  grenade:       false,
  fov:           90,
  smooth:        30,
  ignore_knocked: true,
  ignore_bot:    true,
  esp_line:      false,
  esp_text:      false,
  esp_texture:   false,
  w2s:           false,
  bone_pos:      false,
  bone_name:     false,
  los:           false,
  distance:      false,
  muzzle:        false,
  fps120:        false,
  no_grass:      false,
  ipad:          100,
  aim_bone:      'head',
  aim_key:       0
};

app.post('/api/config/save', async (req, res) => {
  try {
    const { hwid, config } = req.body || {};
    if (!hwid || !config) return res.status(400).json({ error: 'hwid и config обязательны' });

    if (typeof config.fov === 'number') config.fov = Math.max(1, Math.min(180, config.fov));
    if (typeof config.smooth === 'number') config.smooth = Math.max(1, Math.min(100, config.smooth));
    if (typeof config.ipad === 'number') config.ipad = Math.max(70, Math.min(150, config.ipad));

    await pool.query(`
      INSERT INTO user_configs (hwid, config, updated)
      VALUES ($1, $2, $3)
      ON CONFLICT (hwid) DO UPDATE SET config = $2, updated = $3
    `, [hwid, JSON.stringify(config), Date.now()]);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/config/load', async (req, res) => {
  try {
    const { hwid } = req.query;
    if (!hwid) return res.status(400).json({ error: 'hwid обязателен' });

    const r = await pool.query('SELECT config FROM user_configs WHERE hwid=$1', [hwid]);
    if (r.rows.length === 0) {
      return res.json({ ok: true, config: DEFAULT_CONFIG, is_default: true });
    }

    res.json({ ok: true, config: r.rows[0].config, is_default: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/config/reset', async (req, res) => {
  try {
    const { hwid } = req.body || {};
    if (!hwid) return res.status(400).json({ error: 'hwid обязателен' });

    await pool.query('DELETE FROM user_configs WHERE hwid=$1', [hwid]);
    res.json({ ok: true, config: DEFAULT_CONFIG });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
// BOT API
// ============================================================

// Генерация ключа от бота (owner="BOT")
app.post('/api/bot/generate', async (req, res) => {
  try {
    const { secret, tgId, tgUsername, duration } = req.body || {};
    if (secret !== BOT_SECRET) return res.status(403).json({ error: 'Invalid secret' });
    if (!duration || !PRICES[duration]) return res.status(400).json({ error: 'Invalid duration' });

    const code = DURATION_CODE[duration] || '7d';
    let key, ok = false, tries = 0;
    while (!ok && tries < 20) {
      key = `MT-${code}-${randomPart(10)}`;
      const chk = await pool.query('SELECT id FROM keys WHERE key_value=$1', [key]);
      if (chk.rows.length === 0) ok = true;
      tries++;
    }

    await pool.query(
      'INSERT INTO keys (key_value, duration, tier, owner, created) VALUES ($1,$2,$3,$4,$5)',
      [key, duration, 'bot', 'BOT', Date.now()]
    );

    await pool.query(`
      INSERT INTO orders (tg_id, tg_username, duration, price, key_value, status, created, paid_at)
      VALUES ($1, $2, $3, $4, $5, 'paid', $6, $6)
    `, [tgId, tgUsername || '', duration, PRICES[duration], key, Date.now()]);

    res.json({ ok: true, key });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Создать заказ (до оплаты)
app.post('/api/bot/order', async (req, res) => {
  try {
    const { secret, tgId, tgUsername, duration } = req.body || {};
    if (secret !== BOT_SECRET) return res.status(403).json({ error: 'Invalid secret' });
    if (!duration || !PRICES[duration]) return res.status(400).json({ error: 'Invalid duration' });

    const r = await pool.query(`
      INSERT INTO orders (tg_id, tg_username, duration, price, status, created)
      VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id
    `, [tgId, tgUsername || '', duration, PRICES[duration], Date.now()]);

    res.json({ ok: true, orderId: r.rows[0].id, price: PRICES[duration] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Одобрить заказ
app.post('/api/bot/order/:id/approve', async (req, res) => {
  try {
    const { secret, key } = req.body || {};
    if (secret !== BOT_SECRET) return res.status(403).json({ error: 'Invalid secret' });

    await pool.query(
      "UPDATE orders SET status='paid', key_value=$1, paid_at=$2 WHERE id=$3",
      [key, Date.now(), req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Сохранить отзыв
app.post('/api/bot/review', async (req, res) => {
  try {
    const { secret, tgId, tgUsername, text, rating } = req.body || {};
    if (secret !== BOT_SECRET) return res.status(403).json({ error: 'Invalid secret' });
    if (!text) return res.status(400).json({ error: 'Пустой отзыв' });

    await pool.query(`
      INSERT INTO reviews (tg_id, tg_username, text, rating, created)
      VALUES ($1, $2, $3, $4, $5)
    `, [tgId, tgUsername || '', text, rating || 5, Date.now()]);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Список отзывов
app.get('/api/bot/reviews', async (req, res) => {
  try {
    const { secret } = req.query;
    if (secret !== BOT_SECRET) return res.status(403).json({ error: 'Invalid secret' });

    const r = await pool.query('SELECT tg_username, text, rating, created FROM reviews ORDER BY created DESC LIMIT 20');
    res.json({ ok: true, reviews: r.rows });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Статистика бота
app.get('/api/bot/stats', async (req, res) => {
  try {
    const { secret } = req.query;
    if (secret !== BOT_SECRET) return res.status(403).json({ error: 'Invalid secret' });

    const total   = +(await pool.query("SELECT COUNT(*) AS c FROM orders WHERE status='paid'")).rows[0].c;
    const pending = +(await pool.query("SELECT COUNT(*) AS c FROM orders WHERE status='pending'")).rows[0].c;
    const revenue = +(await pool.query("SELECT COALESCE(SUM(price),0) AS s FROM orders WHERE status='paid'")).rows[0].s;
    const botKeys = +(await pool.query("SELECT COUNT(*) AS c FROM keys WHERE owner='BOT'")).rows[0].c;

    res.json({ ok: true, total, pending, revenue, botKeys });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Список заказов
app.get('/api/bot/orders', async (req, res) => {
  try {
    const { secret } = req.query;
    if (secret !== BOT_SECRET) return res.status(403).json({ error: 'Invalid secret' });

    const r = await pool.query('SELECT * FROM orders ORDER BY created DESC LIMIT 50');
    res.json({ ok: true, orders: r.rows });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ⭐ МОИ КЛЮЧИ (по tg_id)
app.get('/api/bot/mykeys', async (req, res) => {
  try {
    const { secret, tgId } = req.query;
    if (secret !== BOT_SECRET) return res.status(403).json({ error: 'Invalid secret' });
    if (!tgId) return res.status(400).json({ error: 'tgId обязателен' });

    const r = await pool.query(`
      SELECT o.id, o.duration, o.price, o.key_value, o.status, o.created, o.paid_at,
             k.used, k.expires, k.hwid
      FROM orders o
      LEFT JOIN keys k ON k.key_value = o.key_value
      WHERE o.tg_id = $1 AND o.status = 'paid'
      ORDER BY o.paid_at DESC
      LIMIT 50
    `, [tgId]);

    res.json({ ok: true, keys: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
app.listen(PORT, () => {
  console.log(`[ManifestTools] http://localhost:${PORT}`);
  console.log(`[ManifestTools] Bot API ready`);
});
