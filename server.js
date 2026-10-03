// ============================================================
// ManifestTools — Key Server (PostgreSQL)
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

  // ⭐ НОВОЕ: Конфиги пользователей
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_configs (
      hwid     TEXT PRIMARY KEY,
      config   JSONB NOT NULL,
      updated  BIGINT NOT NULL
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
// КЛЮЧИ (список)
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
        SELECT owner, COUNT(*)::int AS count,
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
// ⭐ USER CONFIG — СОХРАНЕНИЕ И ЗАГРУЗКА НАСТРОЕК
// ============================================================

// Дефолтный конфиг (используется если у юзера ещё нет настроек)
const DEFAULT_CONFIG = {
  aimbot:        false,
  instant_hit:   false,
  no_recoil:     true,
  no_spread:     true,
  shoot_bullet:  false,
  calc_shoot:    false,
  grenade:       false,
  fov:           90,       // от 1 до 180
  smooth:        30,       // от 1 до 100
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
  ipad:          100,      // от 70 до 150
  aim_bone:      'head',   // head / neck / spine / pelvis
  aim_key:       0         // 0 = всегда, иначе код клавиши
};

// Сохранить настройки
app.post('/api/config/save', async (req, res) => {
  try {
    const { hwid, config } = req.body || {};
    if (!hwid || !config) return res.status(400).json({ error: 'hwid и config обязательны' });

    // Валидация FOV
    if (typeof config.fov === 'number') {
      config.fov = Math.max(1, Math.min(180, config.fov));
    }
    // Валидация Smooth
    if (typeof config.smooth === 'number') {
      config.smooth = Math.max(1, Math.min(100, config.smooth));
    }
    // Валидация iPad View
    if (typeof config.ipad === 'number') {
      config.ipad = Math.max(70, Math.min(150, config.ipad));
    }

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

// Загрузить настройки
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

// Сброс настроек на дефолт
app.post('/api/config/reset', async (req, res) => {
  try {
    const { hwid } = req.body || {};
    if (!hwid) return res.status(400).json({ error: 'hwid обязателен' });

    await pool.query('DELETE FROM user_configs WHERE hwid=$1', [hwid]);
    res.json({ ok: true, config: DEFAULT_CONFIG });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
app.listen(PORT, () => {
  console.log(`[ManifestTools] http://localhost:${PORT}`);
});
