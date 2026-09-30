'use strict';
// 演示数据：node src/seed.js（仅空库可重复执行；服务启动时默认自动调用）
const path = require('path');
const { open, initSchema, getDb, close } = require('./db');

function seedDemo() {
  const d = getDb();
  d.transaction(() => {
    const addMat = d.prepare(`INSERT INTO material(name, kind, note) VALUES (?,?,?)`);
    const addEdge = d.prepare(`INSERT INTO source_edge(source_id, target_id, relation) VALUES (?,?,?)`);
    const addAuth = d.prepare(`INSERT INTO authorization
      (material_id, licensor, medium, region, start_date, end_date, revoked, document)
      VALUES (?,?,?,?,?,?,?,?)`);

    // 素材（id 自增，空库时从 1 开始）
    addMat.run('数字化互动展项《城与人》', '互动展项', '展览包主体，引用了照片与配乐');          // 1
    addMat.run('馆藏油画《晨街》数字化件', '图像', '馆藏作品高精度扫描');                       // 2
    addMat.run('历史照片《市集》', '摄影', '家属捐赠，署名继承人为授权方');                     // 3
    addMat.run('配乐《晨间旋律》', '音频', '第三方音乐公司提供');                               // 4
    addMat.run('展厅导览片', '视频', null);                                                    // 5

    // 来源关系（source 被 target 使用）
    addEdge.run(2, 1, '展项内嵌图像');   // 油画扫描 -> 互动展项
    addEdge.run(3, 1, '展项内嵌照片');   // 历史照片 -> 互动展项
    addEdge.run(4, 1, '展项背景音乐');   // 配乐     -> 互动展项
    addEdge.run(3, 5, '导览片引用照片'); // 历史照片 -> 导览片

    // 授权
    // 展项本体：展厅大屏，全球，长期
    addAuth.run(1, '本馆', '展厅大屏', '*', '2025-01-01', '2030-12-31', 0, '内部立项书 2025-01');
    // 油画扫描：全媒介
    addAuth.run(2, '本馆（馆藏）', '*', '*', '2025-01-01', '2030-12-31', 0, '馆藏数字化授权');
    // 历史照片：展厅大屏，中国大陆
    addAuth.run(3, '张某（继承人）', '展厅大屏', '中国大陆', '2025-01-01', '2028-12-31', 0, '授权函-2025-张');
    // 历史照片：网站媒介的授权已撤销（演示撤销状态）
    addAuth.run(3, '张某（继承人）', '网站', '中国大陆', '2025-01-01', '2028-12-31', 1, '已撤销：邮件 2025-06');
    // 配乐：展厅大屏，中国大陆 —— 有效期只到 2026-06-30，无法覆盖下半年展览
    addAuth.run(4, '某音乐版权公司', '展厅大屏', '中国大陆', '2025-03-01', '2026-06-30', 0, 'LIC-MUS-2025');
    // 导览片：展厅大屏，中国大陆，长期
    addAuth.run(5, '本馆', '展厅大屏', '中国大陆', '2025-01-01', '2030-12-31', 0, '导览片立项');

    // 草稿展览包：2026 全年展（配乐授权只到 6 月 → 核验不合格）
    const pkgId = d.prepare(`INSERT INTO exhibition_package(name, medium, region, start_date, end_date)
      VALUES (?,?,?,?,?)`)
      .run('《城与人》常设展（草稿）', '展厅大屏', '中国大陆', '2026-01-01', '2026-12-31').lastInsertRowid;
    const ins = d.prepare(`INSERT INTO package_material(package_id, material_id) VALUES (?,?)`);
    ins.run(pkgId, 1);
    ins.run(pkgId, 5);
  })();
}

if (require.main === module) {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
  open(DB_PATH);
  initSchema();
  const n = getDb().prepare(`SELECT COUNT(*) c FROM material`).get().c;
  if (n > 0) {
    console.log('数据库非空，跳过演示数据。');
  } else {
    seedDemo();
    console.log('演示数据已写入。');
  }
  close();
}

module.exports = { seedDemo };
