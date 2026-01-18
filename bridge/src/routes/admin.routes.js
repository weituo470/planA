const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function registerAdminRoutes(app, ctx) {
  // NOTE: temporary with(ctx) to match existing routing pattern.
  with (ctx) {
    const tokenTtlSeconds = 7 * 24 * 60 * 60;
    let secretCache = null;

    function getTokenSecret() {
      if (secretCache) return secretCache;
      const env =
        String(process.env.PLANA_ADMIN_TOKEN_SECRET || process.env.PLANADB_ADMIN_TOKEN_SECRET || '').trim();
      if (env && env.length >= 16) {
        secretCache = env;
        return secretCache;
      }
      secretCache = crypto.randomBytes(32).toString('hex');
      console.warn('[admin] token secret not set; sessions reset on restart');
      return secretCache;
    }

    function toBase64Url(value) {
      return Buffer.from(value, 'utf8')
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    }

    function fromBase64Url(value) {
      const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
      const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
      return Buffer.from(`${normalized}${pad}`, 'base64').toString('utf8');
    }

    function signToken(payload) {
      const body = toBase64Url(JSON.stringify(payload));
      const secret = getTokenSecret();
      const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
      return `${body}.${sig}`;
    }

    function verifyToken(token) {
      const raw = String(token || '').trim();
      const parts = raw.split('.');
      if (parts.length !== 2) return null;
      const [body, sig] = parts;
      const secret = getTokenSecret();
      const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length) return null;
      if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
      let payload;
      try {
        payload = JSON.parse(fromBase64Url(body));
      } catch {
        return null;
      }
      if (payload?.exp && Date.now() / 1000 > Number(payload.exp)) return null;
      if (!payload?.sub) return null;
      return payload;
    }

    async function ensureAdminSeed() {
      if (!db?.isReady || !db.isReady()) return;
      if (db.hasAdminSeedAttempted()) return;
      db.markAdminSeedAttempted();
      try {
        const count = await db.countAdmins();
        if (count > 0) return;
        const username =
          String(process.env.PLANA_ADMIN_USER || process.env.PLANADB_ADMIN_USER || '').trim();
        const password =
          String(process.env.PLANA_ADMIN_PASSWORD || process.env.PLANADB_ADMIN_PASSWORD || '').trim();
        if (!username || !password) {
          console.warn('[admin] no default admin created; set PLANA_ADMIN_USER/PLANA_ADMIN_PASSWORD');
          return;
        }
        const hash = await bcrypt.hash(password, 10);
        await db.createAdmin(username, hash);
        console.log(`[admin] default admin created: ${username}`);
      } catch (error) {
        console.error('[admin] seed failed:', error?.message || error);
      }
    }

    async function requireAdminAuth(req, res, next) {
      if (!db?.isReady || !db.isReady()) {
        return res.status(503).json({ error: 'db not ready' });
      }
      const header = String(req.headers?.authorization || '');
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const payload = verifyToken(token);
      if (!payload) return res.status(401).json({ error: 'unauthorized' });
      const admin = await db.getAdminByUsername(payload.sub);
      if (!admin) return res.status(401).json({ error: 'unauthorized' });
      req.admin = { username: admin.username };
      return next();
    }

    function normalizeLimit(value, fallback = 200, max = 500) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(1, Math.floor(parsed)));
    }

    function normalizeOffset(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.floor(parsed));
    }

    app.post('/api/admin/login', async (req, res) => {
      await ensureAdminSeed();
      if (!db?.isReady || !db.isReady()) {
        return res.status(503).json({ error: 'db not ready' });
      }
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!username || !password) {
        return res.status(400).json({ error: 'username and password required' });
      }
      const admin = await db.getAdminByUsername(username);
      if (!admin) return res.status(401).json({ error: 'invalid credentials' });
      const ok = await bcrypt.compare(password, admin.password_hash);
      if (!ok) return res.status(401).json({ error: 'invalid credentials' });
      const now = Math.floor(Date.now() / 1000);
      const token = signToken({ sub: admin.username, iat: now, exp: now + tokenTtlSeconds });
      await db.updateAdminLogin(admin.username);
      return res.json({ ok: true, token, username: admin.username, expiresIn: tokenTtlSeconds });
    });

    app.get('/api/admin/me', requireAdminAuth, (req, res) => {
      res.json({ ok: true, username: req.admin?.username || null });
    });

    app.get('/api/admin/specs', requireAdminAuth, async (req, res) => {
      const pool = db.getPool();
      const q = String(req.query?.q || '').trim();
      const limit = normalizeLimit(req.query?.limit, 200, 500);
      const offset = normalizeOffset(req.query?.offset);
      const where = q ? 'WHERE spec_id LIKE ?' : '';
      const params = q ? [`%${q}%`, limit, offset] : [limit, offset];
      const [rows] = await pool.query(
        `SELECT spec_id, created_at, updated_at FROM specs ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        params,
      );
      res.json({ ok: true, items: rows || [] });
    });

    app.get('/api/admin/specs/:id', requireAdminAuth, async (req, res) => {
      const specId = sanitizeSpecName(req.params?.id);
      if (!specId) return res.status(400).json({ error: 'invalid specId' });
      const pool = db.getPool();
      const [rows] = await pool.query(
        'SELECT spec_id, prompt_text, status_json, created_at, updated_at FROM specs WHERE spec_id = ? LIMIT 1',
        [specId],
      );
      const item = rows && rows[0] ? rows[0] : null;
      if (!item) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, item });
    });

    app.get('/api/admin/specs/:id/stages', requireAdminAuth, async (req, res) => {
      const specId = sanitizeSpecName(req.params?.id);
      if (!specId) return res.status(400).json({ error: 'invalid specId' });
      const pool = db.getPool();
      const limit = normalizeLimit(req.query?.limit, 200, 500);
      const [rows] = await pool.query(
        `SELECT id, stage_key, status, started_at, ended_at, duration_ms, error_message, error_context, created_at
         FROM stages WHERE spec_id = ? ORDER BY id DESC LIMIT ?`,
        [specId, limit],
      );
      res.json({ ok: true, items: rows || [] });
    });

    app.get('/api/admin/specs/:id/artifacts', requireAdminAuth, async (req, res) => {
      const specId = sanitizeSpecName(req.params?.id);
      if (!specId) return res.status(400).json({ error: 'invalid specId' });
      const pool = db.getPool();
      const limit = normalizeLimit(req.query?.limit, 200, 500);
      const [rows] = await pool.query(
        `SELECT id, artifact_type, version, created_at
         FROM artifacts WHERE spec_id = ? ORDER BY artifact_type ASC, version DESC LIMIT ?`,
        [specId, limit],
      );
      res.json({ ok: true, items: rows || [] });
    });

    app.get('/api/admin/specs/:id/artifacts/:type', requireAdminAuth, async (req, res) => {
      const specId = sanitizeSpecName(req.params?.id);
      const type = String(req.params?.type || '').trim();
      if (!specId || !type) return res.status(400).json({ error: 'invalid specId or type' });
      const pool = db.getPool();
      const version = req.query?.version ? Number(req.query.version) : null;
      if (Number.isFinite(version)) {
        const [rows] = await pool.query(
          `SELECT id, artifact_type, version, content, created_at
           FROM artifacts WHERE spec_id = ? AND artifact_type = ? AND version = ? LIMIT 1`,
          [specId, type, Math.floor(version)],
        );
        const item = rows && rows[0] ? rows[0] : null;
        if (!item) return res.status(404).json({ error: 'not found' });
        return res.json({ ok: true, item });
      }
      const [rows] = await pool.query(
        `SELECT id, artifact_type, version, content, created_at
         FROM artifacts WHERE spec_id = ? AND artifact_type = ? ORDER BY version DESC LIMIT 1`,
        [specId, type],
      );
      const item = rows && rows[0] ? rows[0] : null;
      if (!item) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true, item });
    });

    app.get('/api/admin/specs/:id/prompts', requireAdminAuth, async (req, res) => {
      const specId = sanitizeSpecName(req.params?.id);
      if (!specId) return res.status(400).json({ error: 'invalid specId' });
      const pool = db.getPool();
      const limit = normalizeLimit(req.query?.limit, 200, 500);
      const [rows] = await pool.query(
        `SELECT id, stage_key, model, provider_id, prompt_text, created_at
         FROM prompts_final WHERE spec_id = ? ORDER BY id DESC LIMIT ?`,
        [specId, limit],
      );
      res.json({ ok: true, items: rows || [] });
    });

    app.get('/api/admin/specs/:id/llm', requireAdminAuth, async (req, res) => {
      const specId = sanitizeSpecName(req.params?.id);
      if (!specId) return res.status(400).json({ error: 'invalid specId' });
      const pool = db.getPool();
      const limit = normalizeLimit(req.query?.limit, 200, 500);
      const [rows] = await pool.query(
        `SELECT id, stage_key, model, provider_id, status, started_at, ended_at, duration_ms
         FROM llm_conversations WHERE spec_id = ? ORDER BY id DESC LIMIT ?`,
        [specId, limit],
      );
      res.json({ ok: true, items: rows || [] });
    });

    app.get('/api/admin/llm/:id', requireAdminAuth, async (req, res) => {
      const id = Number(req.params?.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
      const pool = db.getPool();
      const [rows] = await pool.query(
        `SELECT id, spec_id, stage_key, model, provider_id, request_text, response_text, response_content,
                usage_json, status, error_message, started_at, ended_at, duration_ms, created_at
         FROM llm_conversations WHERE id = ? LIMIT 1`,
        [Math.floor(id)],
      );
      const item = rows && rows[0] ? rows[0] : null;
      if (!item) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, item });
    });

    app.get('/api/admin/specs/:id/events', requireAdminAuth, async (req, res) => {
      const specId = sanitizeSpecName(req.params?.id);
      if (!specId) return res.status(400).json({ error: 'invalid specId' });
      const pool = db.getPool();
      const limit = normalizeLimit(req.query?.limit, 200, 500);
      const [rows] = await pool.query(
        `SELECT id, event_type, payload_text, created_at
         FROM events WHERE spec_id = ? ORDER BY id DESC LIMIT ?`,
        [specId, limit],
      );
      res.json({ ok: true, items: rows || [] });
    });

    app.get('/api/admin/mvp5/plans', requireAdminAuth, async (req, res) => {
      const pool = db.getPool();
      const specId = req.query?.specId ? sanitizeSpecName(req.query.specId) : null;
      const limit = normalizeLimit(req.query?.limit, 200, 500);
      const params = specId ? [specId, limit] : [limit];
      const where = specId ? 'WHERE spec_id = ?' : '';
      const [rows] = await pool.query(
        `SELECT id, plan_id, spec_id, payload_text, created_at
         FROM mvp5_plans ${where} ORDER BY id DESC LIMIT ?`,
        params,
      );
      res.json({ ok: true, items: rows || [] });
    });

    app.get('/api/admin/mvp5/executions', requireAdminAuth, async (req, res) => {
      const pool = db.getPool();
      const specId = req.query?.specId ? sanitizeSpecName(req.query.specId) : null;
      const limit = normalizeLimit(req.query?.limit, 200, 500);
      const params = specId ? [specId, limit] : [limit];
      const where = specId ? 'WHERE spec_id = ?' : '';
      const [rows] = await pool.query(
        `SELECT id, execution_id, spec_id, status, payload_text, created_at, updated_at
         FROM mvp5_executions ${where} ORDER BY id DESC LIMIT ?`,
        params,
      );
      res.json({ ok: true, items: rows || [] });
    });
  }
}

module.exports = { registerAdminRoutes };
