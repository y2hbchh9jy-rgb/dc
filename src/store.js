// Kalıcı durum (SQLite, Node'un yerleşik node:sqlite modülü — ek bağımlılık yok).
// Ayarlar, whitelist, olaylar, kanal/rol anlık görüntüleri, karantina ve onay istekleri.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULTS = {
  monitor: true, // İzleme modu: yalnızca logla, ceza verme
  graded: true, // Kademeli ceza: tekil ihlalde ban yerine karantina
  dual: true, // Zayıflatıcı işlemler için ikinci Master Admin onayı
  raid: true,
  raidJoins: 10,
  raidWindowSec: 60,
  minAccountAgeDays: 0,
  logChannelId: null,
  lockdown: null,
  raidState: null,
  lastAuditId: null,
  lastReportAt: null,
};

export const SCOPES = {
  all: 'Tam yetki',
  channels: 'Kanal yönetimi',
  roles: 'Rol yönetimi',
  members: 'Üye yönetimi (ban/kick)',
  integrations: 'Bot & webhook',
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (guild_id TEXT, key TEXT, value TEXT, PRIMARY KEY (guild_id, key));
CREATE TABLE IF NOT EXISTS whitelist (guild_id TEXT, user_id TEXT, scopes TEXT, added_by TEXT, added_at INTEGER, expires_at INTEGER, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS revoked (guild_id TEXT, user_id TEXT, at INTEGER, reason TEXT, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, t INTEGER, type TEXT, executor_id TEXT, target_id TEXT, detail TEXT, result TEXT);
CREATE INDEX IF NOT EXISTS incidents_guild_t ON incidents (guild_id, t);
CREATE TABLE IF NOT EXISTS snapshots (guild_id TEXT, kind TEXT, id TEXT, data TEXT, updated_at INTEGER, deleted_at INTEGER, deleted_by TEXT, restored_id TEXT, PRIMARY KEY (guild_id, kind, id));
CREATE TABLE IF NOT EXISTS quarantine (guild_id TEXT, user_id TEXT, roles TEXT, at INTEGER, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, action TEXT, payload TEXT, requested_by TEXT, expires_at INTEGER);
`;

export class Store {
  #stmts = new Map();
  #settings = new Map();

  constructor(file = ':memory:') {
    if (file !== ':memory:') {
      file = path.resolve(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  #q(sql) {
    let s = this.#stmts.get(sql);
    if (!s) this.#stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }
  #run(sql, ...p) {
    return this.#q(sql).run(...p);
  }
  #get(sql, ...p) {
    return this.#q(sql).get(...p);
  }
  #all(sql, ...p) {
    return this.#q(sql).all(...p);
  }

  // --- Ayarlar ---
  settings(gid) {
    let s = this.#settings.get(gid);
    if (!s) {
      s = { ...DEFAULTS };
      for (const r of this.#all('SELECT key, value FROM settings WHERE guild_id = ?', gid)) s[r.key] = JSON.parse(r.value);
      this.#settings.set(gid, s);
    }
    return s;
  }
  get(gid, key) {
    return this.settings(gid)[key];
  }
  set(gid, key, value) {
    this.settings(gid)[key] = value;
    this.#run(
      'INSERT INTO settings VALUES (?, ?, ?) ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value',
      gid,
      key,
      JSON.stringify(value),
    );
  }

  // --- Whitelist (kapsamlı ve süreli) ---
  whitelistEntry(gid, uid) {
    const r = this.#get('SELECT * FROM whitelist WHERE guild_id = ? AND user_id = ?', gid, uid);
    if (!r) return null;
    if (r.expires_at && r.expires_at <= Date.now()) {
      this.removeWhitelist(gid, uid);
      return null;
    }
    return { id: r.user_id, scopes: r.scopes.split(','), addedBy: r.added_by, addedAt: r.added_at, expiresAt: r.expires_at };
  }
  /** scope verilmezse herhangi bir kayıt yeterlidir (panel erişimi için). */
  isWhitelisted(gid, uid, scope) {
    const e = this.whitelistEntry(gid, uid);
    return Boolean(e) && (!scope || e.scopes.includes('all') || e.scopes.includes(scope));
  }
  listWhitelist(gid) {
    this.#run('DELETE FROM whitelist WHERE guild_id = ? AND expires_at IS NOT NULL AND expires_at <= ?', gid, Date.now());
    return this.#all('SELECT * FROM whitelist WHERE guild_id = ? ORDER BY added_at', gid).map((r) => ({
      id: r.user_id,
      scopes: r.scopes.split(','),
      addedBy: r.added_by,
      addedAt: r.added_at,
      expiresAt: r.expires_at,
    }));
  }
  addWhitelist(gid, uid, addedBy, { scopes = ['all'], expiresAt = null } = {}) {
    const existed = Boolean(this.whitelistEntry(gid, uid));
    this.#run('INSERT OR REPLACE INTO whitelist VALUES (?, ?, ?, ?, ?, ?)', gid, uid, scopes.join(','), addedBy, Date.now(), expiresAt);
    return !existed;
  }
  removeWhitelist(gid, uid) {
    return this.#run('DELETE FROM whitelist WHERE guild_id = ? AND user_id = ?', gid, uid).changes > 0;
  }
  /** Devre kesici: kaydı siler ve yeniden eklenmesini kalıcı olarak engeller. */
  revoke(gid, uid, reason) {
    const was = this.removeWhitelist(gid, uid);
    this.#run('INSERT OR REPLACE INTO revoked VALUES (?, ?, ?, ?)', gid, uid, Date.now(), reason);
    return was;
  }
  isRevoked(gid, uid) {
    return Boolean(this.#get('SELECT 1 FROM revoked WHERE guild_id = ? AND user_id = ?', gid, uid));
  }

  // --- Olaylar ---
  addIncident(gid, { type, executorId = null, targetId = null, detail = null, result = null }) {
    this.#run(
      'INSERT INTO incidents (guild_id, t, type, executor_id, target_id, detail, result) VALUES (?, ?, ?, ?, ?, ?, ?)',
      gid,
      Date.now(),
      type,
      executorId,
      targetId,
      detail,
      result,
    );
  }
  recentIncidents(gid, n = 5) {
    return this.#all('SELECT * FROM incidents WHERE guild_id = ? ORDER BY id DESC LIMIT ?', gid, n).map((r) => ({
      t: r.t,
      type: r.type,
      executorId: r.executor_id,
      targetId: r.target_id,
      detail: r.detail,
      result: r.result,
    }));
  }
  incidentStats(gid, since) {
    return {
      total: this.#get('SELECT COUNT(*) AS n FROM incidents WHERE guild_id = ? AND t >= ?', gid, since).n,
      byType: this.#all(
        'SELECT type, COUNT(*) AS n FROM incidents WHERE guild_id = ? AND t >= ? GROUP BY type ORDER BY n DESC LIMIT 10',
        gid,
        since,
      ),
      top: this.#all(
        'SELECT executor_id AS id, COUNT(*) AS n FROM incidents WHERE guild_id = ? AND t >= ? AND executor_id IS NOT NULL GROUP BY executor_id ORDER BY n DESC LIMIT 5',
        gid,
        since,
      ),
    };
  }

  // --- Kanal / rol anlık görüntüleri ---
  upsertSnapshot(gid, kind, id, data) {
    this.#run(
      `INSERT INTO snapshots (guild_id, kind, id, data, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE deleted_at IS NULL`,
      gid,
      kind,
      id,
      JSON.stringify(data),
      Date.now(),
    );
  }
  liveSnapshotIds(gid, kind) {
    return this.#all('SELECT id FROM snapshots WHERE guild_id = ? AND kind = ? AND deleted_at IS NULL', gid, kind).map((r) => r.id);
  }
  markDeleted(gid, kind, id, by = null) {
    this.#run(
      'UPDATE snapshots SET deleted_at = COALESCE(deleted_at, ?), deleted_by = COALESCE(?, deleted_by) WHERE guild_id = ? AND kind = ? AND id = ?',
      Date.now(),
      by,
      gid,
      kind,
      id,
    );
  }
  patchSnapshot(gid, kind, id, patch) {
    const r = this.#get('SELECT data FROM snapshots WHERE guild_id = ? AND kind = ? AND id = ?', gid, kind, id);
    if (!r) return;
    this.#run(
      'UPDATE snapshots SET data = ? WHERE guild_id = ? AND kind = ? AND id = ?',
      JSON.stringify({ ...JSON.parse(r.data), ...patch }),
      gid,
      kind,
      id,
    );
  }
  listRestorable(gid, by, since) {
    return this.#all(
      'SELECT kind, id, data FROM snapshots WHERE guild_id = ? AND deleted_by = ? AND deleted_at >= ? AND restored_id IS NULL',
      gid,
      by,
      since,
    ).map((r) => ({ kind: r.kind, id: r.id, data: JSON.parse(r.data) }));
  }
  countRestorable(gid, by, since) {
    return this.#get(
      'SELECT COUNT(*) AS n FROM snapshots WHERE guild_id = ? AND deleted_by = ? AND deleted_at >= ? AND restored_id IS NULL',
      gid,
      by,
      since,
    ).n;
  }
  setRestored(gid, kind, id, newId) {
    this.#run('UPDATE snapshots SET restored_id = ? WHERE guild_id = ? AND kind = ? AND id = ?', newId, gid, kind, id);
  }
  restoredMap(gid) {
    return new Map(
      this.#all('SELECT id, restored_id FROM snapshots WHERE guild_id = ? AND restored_id IS NOT NULL', gid).map((r) => [r.id, r.restored_id]),
    );
  }

  // --- Karantina ---
  saveQuarantine(gid, uid, roles) {
    this.#run('INSERT OR IGNORE INTO quarantine VALUES (?, ?, ?, ?)', gid, uid, JSON.stringify(roles), Date.now());
  }
  getQuarantine(gid, uid) {
    const r = this.#get('SELECT roles, at FROM quarantine WHERE guild_id = ? AND user_id = ?', gid, uid);
    return r ? { roles: JSON.parse(r.roles), at: r.at } : null;
  }
  deleteQuarantine(gid, uid) {
    this.#run('DELETE FROM quarantine WHERE guild_id = ? AND user_id = ?', gid, uid);
  }

  // --- Çift onay istekleri ---
  addApproval(gid, action, payload, requestedBy, ttlMs) {
    return Number(
      this.#run(
        'INSERT INTO approvals (guild_id, action, payload, requested_by, expires_at) VALUES (?, ?, ?, ?, ?)',
        gid,
        action,
        JSON.stringify(payload),
        requestedBy,
        Date.now() + ttlMs,
      ).lastInsertRowid,
    );
  }
  getApproval(gid, id) {
    const r = this.#get('SELECT * FROM approvals WHERE id = ? AND guild_id = ?', id, gid);
    if (!r || r.expires_at <= Date.now()) return null;
    return { id: r.id, action: r.action, payload: JSON.parse(r.payload), requestedBy: r.requested_by };
  }
  deleteApproval(id) {
    this.#run('DELETE FROM approvals WHERE id = ?', id);
  }

  /** Eski kayıtların temizliği (günde bir çağrılır). */
  prune(now = Date.now()) {
    const day = 86_400_000;
    this.#run('DELETE FROM incidents WHERE t < ?', now - 90 * day);
    this.#run('DELETE FROM snapshots WHERE deleted_at IS NOT NULL AND deleted_at < ?', now - 7 * day);
    this.#run('DELETE FROM approvals WHERE expires_at < ?', now);
  }
}
