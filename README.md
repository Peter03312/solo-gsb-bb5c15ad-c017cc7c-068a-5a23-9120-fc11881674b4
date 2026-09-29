# 数字展品授权核验系统

面向小型展馆的 Web 应用：策展人登记数字素材、来源（衍生/引用）关系与每份授权的
**媒介、地区、有效期、撤销状态**；选取素材组成展览包并指定展示媒介、地区与展期后，
系统沿**全部来源链**核验每个节点至少有一份**未撤销且覆盖整段使用期**的授权，
列出不合格节点及其来源路径。核验不通过或日期不合法时**不得发布**；发布时**原子写入
不可变的核验快照与素材清单**。授权随后变更时自动重算资格，仅不再合格的已发布包转为
“需复核”并保留原快照，待发布包则按最新数据重新核验。

## 功能与业务规则

- **素材与来源关系**
  - 素材登记（名称、备注）；来源关系为“上游素材（来源）→ 下游素材（引用方）”的有向边。
  - **禁止成环**：新增关系时数据库递归 CTE 检查（自环、重复边同样拒绝）。
- **授权登记**：每个素材可挂多份授权，字段为媒介、地区、有效期起止、撤销状态、授权方备注；
  媒介/地区支持 `*` 通配；授权自身起止日期必须合法且起 ≤ 止。
- **展览包核验**（输入展示媒介、地区、起止日期 + 入选素材）
  - 从每个入选素材沿全部上游来源链做 DAG 展开（支持菱形等多重来源，枚举每条来源路径）。
  - 链上**每个节点**必须至少有一份授权同时满足：未撤销、媒介覆盖、地区覆盖、
    `授权起 ≤ 展期起` 且 `授权止 ≥ 展期止`（覆盖**整段**使用，不是仅相交）。
  - 输出：不合格节点清单、每个节点的全部来源路径（入选素材 ↑ … ↑ 问题节点）、
    各条授权的逐条不满足原因（已撤销 / 媒介不覆盖 / 地区不覆盖 / 起始过晚 / 到期过早）。
  - 使用参数严格校验：日期必须是真实日历日（拒绝 `2026-02-30`、`2026-13-40`），起止不得倒置。
- **发布（原子 + 不可变快照）**
  - 发布在**单个 SQLite 事务**内完成：重读包与全局核验依据版本 → 重新核验 →
    合格才追加快照（完整核验结果 JSON + 含全链节点与命中授权 ID 的素材清单 JSON）并置为已发布。
  - 不合格（缺授权、授权不覆盖、日期非法等）一律回滚并返回 422 及核验明细，**不产生快照**。
  - 快照表只追加，无任何更新/删除路径；已发布包锁定编辑与删除。
  - **并发保护**：发布时携带试算时的“核验依据版本（basis_version）”与包版本（revision）；
    若试算后授权/关系或包内容被改过，发布返回 `409 basis_stale / package_revised`，
    前端提示“重新核验后重试”。
- **授权变更后的资格重算**
  - 授权新增/编辑/撤销/删除、来源关系或素材结构的每次变更，都会令全局 `basis_version +1`，
    并在同一请求内重算所有已发布包：**仅不再合格者**转为 `needs_review`（需复核）。
  - 变为需复核不影响历史快照；即使授权恢复合格，包也不会自动回到已发布，
    须人工“执行复核”后“重新发布”，重新发布**追加**一份新快照，原快照保留。
  - 草稿/待发布包不缓存结论，每次核验都按实时数据计算。

## 技术栈

- Node.js 20 + Express（REST API，`src/`）
- SQLite（better-sqlite3，同步事务；表结构见 `src/schema.sql`，库文件在 `data/app.db`）
- 原生浏览器前端（无构建步骤，`public/`：HTML/CSS/JS）

## 一键启动（Docker Compose，推荐）

前置：安装 Docker 与 Docker Compose v2。

```bash
docker compose up --build -d        # 构建镜像、初始化数据库并后台启动
docker compose logs -f app          # 查看日志
docker compose down                 # 停止
```

启动后打开： **http://localhost:3000**

- 首次启动容器会自动创建 SQLite 数据库与全部表（`data/app.db`），并初始化核验依据版本。
- 数据库通过卷 `./data:/app/data` 持久化到宿主机，删容器不丢数据。
- 自定义宿主机端口：`PORT=8080 docker compose up --build -d` → http://localhost:8080

仅用 Docker（不通过 Compose）：

```bash
docker build -t exhibit-auth-checker .
docker run -d -p 3000:3000 -v "$PWD/data:/app/data" --name exhibit-auth-checker exhibit-auth-checker
```

## 本机直接运行（Node.js）

前置：Node.js ≥ 18（开发使用 Node 20）。better-sqlite3 含原生模块，安装时通常直接下载
预编译二进制；若需源码构建，本机需具备 Python 3 + make + g++。

```bash
npm install          # 安装依赖
npm run init-db      # 可选：仅初始化数据库（启动服务时也会自动初始化）
npm start            # 启动 Web 服务
```

打开 **http://localhost:3000** 。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口（容器内固定监听 3000；Compose 用宿主机 `PORT` 改映射） |
| `DATA_DIR` | `./data` | SQLite 数据库所在目录，启动时自动创建 |
| `DB_PATH` | `$DATA_DIR/app.db` | 可直接指定数据库文件完整路径 |
| `NO_PROXY` / 常规代理变量 | — | 服务端不主动发起外联，无需代理配置 |

## 使用流程（Web 界面）

1. **素材与来源**页：登记素材；用“上游 → 下游”表单建立来源关系（成环会被拒绝并提示）。
2. **授权登记**页：为素材录入授权（媒介/地区/起止日期；可随时撤销、恢复、编辑、删除）。
   顶栏的“核验依据版本”在每次授权或关系变更后递增。
3. **展览包**页：新建包并填写展示媒介、地区、展期，勾选入选素材，保存草稿；
   点击列表中的“核验”打开详情：
   - 查看不合格节点与来源路径、逐条授权判定原因；
   - “重新核验（试算）”按最新数据重算（不发布、不改状态）；
   - 核验通过后“发布”原子写入快照；若期间数据被改过会提示重新核验后重试。
4. 授权/关系变更后，失去资格的已发布包自动出现“需复核”标记；
   打开后“执行复核”查看当前结论，重新合格时可“复核通过并重新发布”（追加新快照）。
5. **核验快照**页：选择展览包查看全部历史快照，可展开素材清单与完整核验结果 JSON。

## REST API 摘要

| 方法与路径 | 说明 |
| --- | --- |
| `GET/POST /api/materials`，`PATCH/DELETE /api/materials/:id` | 素材 CRUD |
| `GET/POST /api/relations`，`DELETE /api/relations/:id` | 来源关系（服务端成环检查） |
| `GET/POST /api/authorizations`，`PATCH/DELETE /api/authorizations/:id` | 授权（写操作触发资格重算） |
| `GET/POST /api/packages`，`GET/PATCH/DELETE /api/packages/:id` | 展览包（已发布包锁定） |
| `POST /api/packages/:id/verify` | 实时核验（试算，不落库） |
| `POST /api/packages/:id/publish` | 发布（事务内复验 + 写不可变快照；请求体可带 `basis_version`、`revision`） |
| `POST /api/packages/:id/recheck` | 需复核包的实时复核（保留并列出原快照） |
| `POST /api/packages/:id/republish` | 复核通过后重新发布（追加新快照） |
| `GET /api/packages/:id/snapshots`、`GET /api/snapshots/:id` | 快照历史 |
| `GET /api/meta` | 当前核验依据版本 `basis_version` |

快速试一条（服务已启动）：

```bash
curl -s localhost:3000/api/meta
curl -s -X POST localhost:3000/api/materials -H 'Content-Type: application/json' -d '{"name":"测试短片"}'
```

## 目录结构

```
Dockerfile               # 含依赖安装与数据库初始化（启动即建库）
docker-compose.yml       # 一键启动（端口、卷、健康检查）
package.json
src/
  schema.sql             # 全部表结构（素材/关系/授权/包/清单/不可变快照/元数据）
  db.js                  # SQLite 连接、建库初始化、basis_version 维护
  verify.js              # 核验引擎：DAG 路径展开、授权覆盖判定、成环检查、日期校验
  server.js              # Express 路由、原子发布事务、资格重算
public/                  # 浏览器前端（原生 HTML/CSS/JS，无构建）
data/                    # SQLite 数据（运行时生成，已 gitignore）
```
