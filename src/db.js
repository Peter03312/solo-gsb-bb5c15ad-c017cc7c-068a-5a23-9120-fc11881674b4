'use strict';
// 数据库连接与建表（幂等，可重复执行）
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

function open(dbPath) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 open()');
  return db;
}

// 建表 + 版本触发器。
// basis_version：核验依据版本号。素材/来源关系/授权的任何变更都会使其 +1，
// 前端“先核验、再发布”期间若有他人编辑，发布时 basisVersion 对不上则拒绝并提示重试。
function initSchema() {
  const d = getDb();
  d.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO meta(key, value) VALUES ('basis_version', '0');

  CREATE TABLE IF NOT EXISTS material (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    kind       TEXT,
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 来源关系：source_id 的内容被 target_id 使用（target 派生/引用 source）
  CREATE TABLE IF NOT EXISTS source_edge (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id  INTEGER NOT NULL REFERENCES material(id) ON DELETE RESTRICT,
    target_id  INTEGER NOT NULL REFERENCES material(id) ON DELETE RESTRICT,
    relation   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, target_id),
    CHECK(source_id <> target_id)
  );

  CREATE TABLE IF NOT EXISTS authorization (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES material(id) ON DELETE RESTRICT,
    licensor    TEXT NOT NULL,                 -- 授权方
    medium      TEXT NOT NULL,                 -- 媒介；'*' 表示全媒介
    region      TEXT NOT NULL,                 -- 地区；'*' 表示全球
    start_date  TEXT NOT NULL,                 -- YYYY-MM-DD
    end_date    TEXT NOT NULL,                 -- YYYY-MM-DD
    revoked     INTEGER NOT NULL DEFAULT 0,    -- 是否撤销
    document    TEXT,                          -- 授权文件备注/编号
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(start_date <= end_date)
  );

  CREATE TABLE IF NOT EXISTS exhibition_package (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','needs_review')),
    medium     TEXT,
    region     TEXT,
    start_date TEXT,
    end_date   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS package_material (
    package_id  INTEGER NOT NULL REFERENCES exhibition_package(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES material(id) ON DELETE RESTRICT,
    PRIMARY KEY(package_id, material_id)
  );

  -- 发布快照：每次发布插入一条，永不修改（应用层不提供 update/delete）
  CREATE TABLE IF NOT EXISTS verification_snapshot (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL REFERENCES exhibition_package(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    basis_version     INTEGER NOT NULL,
    medium     TEXT NOT NULL,
    region     TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    qualified  INTEGER NOT NULL,
    payload    TEXT NOT NULL    -- 完整核验结果 JSON（节点判定、失败原因、来源路径、素材清单）
  );
  CREATE INDEX IF NOT EXISTS idx_snapshot_package ON verification_snapshot(package_id, id);

  -- 核验依据变更（素材/来源关系/授权增删改）→ 版本号 +1
  CREATE TRIGGER IF NOT EXISTS trg_mat_bu  AFTER UPDATE ON material
    BEGIN UPDATE meta SET value = value + 1 WHERE key = 'basis_version'; END;
  CREATE TRIGGER IF NOT EXISTS trg_mat_ai  AFTER INSERT ON material
    BEGIN UPDATE meta SET value = value + 1 WHERE key = 'basis_version'; END;
  CREATE TRIGGER IF NOT EXISTS trg_mat_ad  AFTER DELETE ON material
    BEGIN UPDATE meta SET value = value + 1 WHERE key = 'basis_version'; END;
  CREATE TRIGGER IF NOT EXISTS trg_edge_bu AFTER UPDATE ON source_edge
    BEGIN UPDATE meta SET value = value + 1 WHERE key = 'basis_version'; END;
  CREATE TRIGGER IF NOT EXISTS trg_edge_ai AFTER INSERT ON source_edge
    BEGIN UPDATE meta SET value = value + 1 WHERE key = 'basis_version'; END;
  CREATE TRIGGER IF NOT EXISTS trg_edge_ad AFTER DELETE ON source_edge
    BEGIN UPDATE meta SET value = value + 1 WHERE key = 'basis_version'; END;
  CREATE TRIGGER IF NOT EXISTS trg_auth_bu AFTER UPDATE ON authorization
    BEGIN UPDATE meta SET value = value + 1 WHERE key = 'basis_version'; END;
  CREATE TRIGGER IF NOT EXISTS trg_auth_ai AFTER INSERT ON authorization
    BEGIN UPDATE meta SET value = value + 1 WHERE key = 'basis_version'; END;
  CREATE TRIGGER IF NOT EXISTS trg_auth_ad AFTER DELETE ON authorization
    BEGIN UPDATE meta SET value = value + 1 WHERE key = 'basis_version'; END;
  `);
  return db;
}

function getBasisVersion() {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key='basis_version'`).get();
  return Number(row.value);
}

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = { open, getDb, initSchema, getBasisVersion, close };
