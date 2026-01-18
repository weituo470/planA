const mysql = require('mysql2/promise');

const DEFAULT_DB_HOST = '127.0.0.1';
const DEFAULT_DB_PORT = 3306;
const DEFAULT_DB_NAME = 'plana';
const DEFAULT_DB_USER = 'root';

let pool = null;
let ready = false;
let lastError = null;
let adminSeedAttempted = false;

function getDbConfig() {
  if (String(process.env.PLANADB_DISABLED || '').trim() === '1') return null;
  const host = String(process.env.PLANADB_HOST || DEFAULT_DB_HOST).trim();
  const port = Number.parseInt(String(process.env.PLANADB_PORT || DEFAULT_DB_PORT), 10);
  const user = String(process.env.PLANADB_USER || DEFAULT_DB_USER).trim();
  const password = String(process.env.PLANADB_PASSWORD || '').trim();
  const database = String(process.env.PLANADB_NAME || DEFAULT_DB_NAME).trim();
  if (!host || !user || !database) return null;
  return {
    host,
    port: Number.isFinite(port) ? port : DEFAULT_DB_PORT,
    user,
    password,
    database,
  };
}

function isReady() {
  return ready && Boolean(pool);
}

function getLastError() {
  return lastError;
}

function getPool() {
  return pool;
}

async function ensureDatabaseExists(config) {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    multipleStatements: false,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end();
  }
}

async function createTables(conn) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS specs (
      spec_id VARCHAR(120) PRIMARY KEY,
      prompt_text LONGTEXT,
      status_json LONGTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS stages (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      spec_id VARCHAR(120) NOT NULL,
      stage_key VARCHAR(40) NOT NULL,
      status VARCHAR(20) NOT NULL,
      started_at DATETIME,
      ended_at DATETIME,
      duration_ms INT,
      error_message TEXT,
      error_context LONGTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_stages_spec (spec_id),
      INDEX idx_stages_key (spec_id, stage_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS artifacts (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      spec_id VARCHAR(120) NOT NULL,
      artifact_type VARCHAR(40) NOT NULL,
      version INT NOT NULL,
      content LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_artifacts_spec (spec_id, artifact_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS prompts_final (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      spec_id VARCHAR(120),
      stage_key VARCHAR(40),
      model VARCHAR(120),
      provider_id VARCHAR(80),
      prompt_text LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_prompts_spec (spec_id),
      INDEX idx_prompts_stage (spec_id, stage_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS llm_conversations (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      spec_id VARCHAR(120),
      stage_key VARCHAR(40),
      model VARCHAR(120),
      provider_id VARCHAR(80),
      request_text LONGTEXT NOT NULL,
      response_text LONGTEXT,
      response_content LONGTEXT,
      usage_json LONGTEXT,
      status VARCHAR(20) NOT NULL,
      error_message TEXT,
      started_at DATETIME,
      ended_at DATETIME,
      duration_ms INT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_llm_spec (spec_id),
      INDEX idx_llm_stage (spec_id, stage_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS events (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      spec_id VARCHAR(120),
      event_type VARCHAR(80) NOT NULL,
      payload_text LONGTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_events_spec (spec_id),
      INDEX idx_events_type (event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS mvp5_plans (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      plan_id VARCHAR(120) NOT NULL,
      spec_id VARCHAR(120),
      payload_text LONGTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_mvp5_plan (plan_id),
      INDEX idx_mvp5_plans_spec (spec_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS mvp5_executions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      execution_id VARCHAR(120) NOT NULL,
      spec_id VARCHAR(120),
      status VARCHAR(40),
      payload_text LONGTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_mvp5_exec (execution_id),
      INDEX idx_mvp5_exec_spec (spec_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS admins (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(80) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of tables) {
    await conn.query(sql);
  }

  // Best-effort unique indexes for upserts.
  const indexStatements = [
    'ALTER TABLE mvp5_plans ADD UNIQUE KEY uniq_mvp5_plan (plan_id)',
    'ALTER TABLE mvp5_executions ADD UNIQUE KEY uniq_mvp5_exec (execution_id)',
  ];
  for (const sql of indexStatements) {
    try {
      await conn.query(sql);
    } catch (error) {
      // Ignore if the index already exists or cannot be added on existing data.
      if (error?.code === 'ER_DUP_KEYNAME' || error?.code === 'ER_DUP_KEY') continue;
      if (error?.code === 'ER_CANT_DROP_FIELD_OR_KEY') continue;
      console.warn('[db] index ensure failed:', error?.message || error);
    }
  }
}

async function initDb() {
  const config = getDbConfig();
  if (!config) {
    ready = false;
    return { ok: false, error: 'DB config missing' };
  }
  try {
    await ensureDatabaseExists(config);
    pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
    await createTables(pool);
    ready = true;
    lastError = null;
    return { ok: true };
  } catch (error) {
    ready = false;
    lastError = error;
    return { ok: false, error: error?.message || String(error) };
  }
}

function toJson(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function countAdmins() {
  if (!isReady()) return 0;
  const [rows] = await pool.query('SELECT COUNT(*) AS cnt FROM admins');
  return rows && rows[0] ? Number(rows[0].cnt) : 0;
}

async function getAdminByUsername(username) {
  if (!isReady() || !username) return null;
  const [rows] = await pool.query(
    'SELECT id, username, password_hash, created_at, last_login_at FROM admins WHERE username = ? LIMIT 1',
    [username],
  );
  return rows && rows[0] ? rows[0] : null;
}

async function createAdmin(username, passwordHash) {
  if (!isReady() || !username || !passwordHash) return null;
  const [result] = await pool.query(
    'INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, NOW())',
    [username, passwordHash],
  );
  return result?.insertId || null;
}

async function updateAdminLogin(username) {
  if (!isReady() || !username) return;
  await pool.query(
    'UPDATE admins SET last_login_at = NOW() WHERE username = ?',
    [username],
  );
}

function markAdminSeedAttempted() {
  adminSeedAttempted = true;
}

function hasAdminSeedAttempted() {
  return adminSeedAttempted;
}

async function ensureSpec(specId) {
  if (!isReady() || !specId) return;
  await pool.query(
    'INSERT IGNORE INTO specs (spec_id, created_at, updated_at) VALUES (?, NOW(), NOW())',
    [specId],
  );
}

async function upsertSpec(specId, payload) {
  if (!isReady() || !specId) return;
  const promptText =
    typeof payload?.promptText === 'string' ? payload.promptText : null;
  const statusJson = payload?.status ? toJson(payload.status) : null;
  await pool.query(
    `INSERT INTO specs (spec_id, prompt_text, status_json, created_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
      prompt_text = COALESCE(VALUES(prompt_text), prompt_text),
      status_json = COALESCE(VALUES(status_json), status_json),
      updated_at = NOW()`,
    [specId, promptText, statusJson],
  );
}

async function insertStageAttempt(specId, stageKey, attempt) {
  if (!isReady() || !specId || !stageKey) return;
  const status = attempt?.error ? 'error' : 'ok';
  const startedAt = attempt?.startedAt ? new Date(attempt.startedAt) : null;
  const endedAt = attempt?.endedAt ? new Date(attempt.endedAt) : null;
  const durationMs = Number.isFinite(Number(attempt?.durationMs))
    ? Math.floor(Number(attempt.durationMs))
    : null;
  const errorMessage = attempt?.error?.message ? String(attempt.error.message) : null;
  const errorContext = attempt?.error?.context ? toJson(attempt.error.context) : null;
  await pool.query(
    `INSERT INTO stages
      (spec_id, stage_key, status, started_at, ended_at, duration_ms, error_message, error_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [specId, stageKey, status, startedAt, endedAt, durationMs, errorMessage, errorContext],
  );
}

async function insertArtifact(specId, artifactType, content) {
  if (!isReady() || !specId || !artifactType) return;
  const text = typeof content === 'string' ? content : String(content ?? '');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS nextVersion FROM artifacts WHERE spec_id = ? AND artifact_type = ? FOR UPDATE',
      [specId, artifactType],
    );
    const nextVersion = rows && rows[0] ? Number(rows[0].nextVersion) : 1;
    await conn.query(
      'INSERT INTO artifacts (spec_id, artifact_type, version, content) VALUES (?, ?, ?, ?)',
      [specId, artifactType, nextVersion, text],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function insertPromptFinal(specId, stageKey, model, providerId, promptText) {
  if (!isReady() || !promptText) return;
  await pool.query(
    'INSERT INTO prompts_final (spec_id, stage_key, model, provider_id, prompt_text) VALUES (?, ?, ?, ?, ?)',
    [specId || null, stageKey || null, model || null, providerId || null, promptText],
  );
}

async function insertLlmConversationStart(payload) {
  if (!isReady()) return null;
  const {
    specId,
    stageKey,
    model,
    providerId,
    requestText,
    promptText,
    startedAt,
  } = payload || {};
  const status = 'running';
  const [result] = await pool.query(
    `INSERT INTO llm_conversations
      (spec_id, stage_key, model, provider_id, request_text, response_text, response_content, usage_json, status, error_message, started_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?)`,
    [
      specId || null,
      stageKey || null,
      model || null,
      providerId || null,
      requestText || '',
      status,
      startedAt ? new Date(startedAt) : new Date(),
    ],
  );
  if (promptText) {
    await insertPromptFinal(specId, stageKey, model, providerId, promptText);
  }
  return result?.insertId || null;
}

async function finishLlmConversation(id, payload) {
  if (!isReady() || !id) return;
  const {
    responseText,
    responseContent,
    usage,
    status,
    errorMessage,
    endedAt,
    durationMs,
  } = payload || {};
  await pool.query(
    `UPDATE llm_conversations
     SET response_text = ?, response_content = ?, usage_json = ?, status = ?, error_message = ?, ended_at = ?, duration_ms = ?
     WHERE id = ?`,
    [
      responseText != null ? String(responseText) : null,
      responseContent != null ? String(responseContent) : null,
      usage ? toJson(usage) : null,
      status || 'ok',
      errorMessage ? String(errorMessage) : null,
      endedAt ? new Date(endedAt) : new Date(),
      Number.isFinite(Number(durationMs)) ? Math.floor(Number(durationMs)) : null,
      id,
    ],
  );
}

async function insertEvent(specId, eventType, payload) {
  if (!isReady() || !eventType) return;
  await pool.query(
    'INSERT INTO events (spec_id, event_type, payload_text) VALUES (?, ?, ?)',
    [specId || null, eventType, toJson(payload)],
  );
}

async function insertMvp5Plan(specId, planId, payload) {
  if (!isReady() || !planId) return;
  await pool.query(
    'INSERT INTO mvp5_plans (plan_id, spec_id, payload_text) VALUES (?, ?, ?)',
    [planId, specId || null, toJson(payload)],
  );
}

async function upsertMvp5Execution(specId, executionId, status, payload) {
  if (!isReady() || !executionId) return;
  await pool.query(
    `INSERT INTO mvp5_executions (execution_id, spec_id, status, payload_text)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       payload_text = COALESCE(VALUES(payload_text), payload_text),
       updated_at = NOW()`,
    [executionId, specId || null, status || null, payload ? toJson(payload) : null],
  );
}

module.exports = {
  initDb,
  isReady,
  getLastError,
  ensureSpec,
  upsertSpec,
  insertStageAttempt,
  insertArtifact,
  insertPromptFinal,
  insertLlmConversationStart,
  finishLlmConversation,
  insertEvent,
  insertMvp5Plan,
  upsertMvp5Execution,
  getPool,
  countAdmins,
  getAdminByUsername,
  createAdmin,
  updateAdminLogin,
  markAdminSeedAttempted,
  hasAdminSeedAttempted,
};
