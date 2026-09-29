'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 初始化/升级表结构
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

/** 读取全局核验依据版本 */
function getBasisVersion() {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'basis_version'`).get();
  return row ? parseInt(row.value, 10) : 1;
}

/** 核验依据（素材结构、来源关系、授权）发生变更：版本 +1 */
function bumpBasisVersion(tx) {
  const runner = tx || db;
  runner.prepare(
    `UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'basis_version'`
  ).run();
  return runner.prepare(`SELECT value FROM meta WHERE key = 'basis_version'`).get().value;
}

module.exports = { db, getBasisVersion, bumpBasisVersion, DB_PATH };

// 直接执行 `node src/db.js` 时仅初始化数据库
if (require.main === module) {
  const v = getBasisVersion();
  console.log(`数据库已初始化: ${DB_PATH}（basis_version=${v}）`);
}
