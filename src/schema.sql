-- 数字展品授权核验系统 数据库结构
-- 来源关系构成有向无环图 (DAG)：parent_id（被引用/上游素材） -> child_id（引用/下游素材）
-- 授权随素材节点生效；核验时沿全部来源链检查每个节点。

PRAGMA foreign_keys = ON;

-- 素材
CREATE TABLE IF NOT EXISTS materials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 来源关系（边：parent 是 child 的来源/上游）
CREATE TABLE IF NOT EXISTS source_relations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER NOT NULL REFERENCES materials(id),
  child_id    INTEGER NOT NULL REFERENCES materials(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parent_id, child_id),
  CHECK (parent_id <> child_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_child ON source_relations(child_id);
CREATE INDEX IF NOT EXISTS idx_rel_parent ON source_relations(parent_id);

-- 授权：每条授权挂在一个素材节点上
CREATE TABLE IF NOT EXISTS authorizations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  medium      TEXT NOT NULL,                 -- 授权媒介；'*' 表示不限媒介
  region      TEXT NOT NULL,                 -- 授权地区；'*' 表示不限地区
  valid_from  TEXT NOT NULL,                 -- YYYY-MM-DD（含）
  valid_to    TEXT NOT NULL,                 -- YYYY-MM-DD（含）
  revoked     INTEGER NOT NULL DEFAULT 0,    -- 1 = 已撤销
  licensor    TEXT NOT NULL DEFAULT '',      -- 授权方/凭证备注
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (valid_from <= valid_to)
);
CREATE INDEX IF NOT EXISTS idx_auth_material ON authorizations(material_id);

-- 展览包
CREATE TABLE IF NOT EXISTS packages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  medium        TEXT NOT NULL,               -- 展示媒介
  region        TEXT NOT NULL,               -- 展示地区
  start_date    TEXT NOT NULL,               -- 展期起 YYYY-MM-DD
  end_date      TEXT NOT NULL,               -- 展期止 YYYY-MM-DD
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'needs_review')),
  revision      INTEGER NOT NULL DEFAULT 0,  -- 包内容/参数版本（乐观核验依据之一）
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT
  -- 日期合法性/先后顺序由核验引擎校验（草稿允许保存待修正日期）
);

-- 展览包包含的素材（仅登记直接入选素材；来源链上其余节点由系统展开）
CREATE TABLE IF NOT EXISTS package_items (
  package_id   INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  material_id  INTEGER NOT NULL REFERENCES materials(id),
  PRIMARY KEY (package_id, material_id)
);

-- 核验快照（只追加，永不更新/删除）——发布时的不可变核验依据与素材清单
CREATE TABLE IF NOT EXISTS snapshots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id         INTEGER NOT NULL REFERENCES packages(id),
  package_revision   INTEGER NOT NULL,      -- 发布时包版本
  basis_version      INTEGER NOT NULL,       -- 发布时全局核验依据版本
  verification_json  TEXT NOT NULL,          -- 完整核验结果（含全部节点/路径/授权判定）
  items_json         TEXT NOT NULL,          -- 发布时素材清单（含来源链节点）
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshot_package ON snapshots(package_id);

-- 全局元数据（核验依据版本号 basis_version：素材关系/授权每次变更 +1）
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT OR IGNORE INTO meta(key, value) VALUES ('basis_version', '1');
