'use strict';
// 服务入口：启动即建库建表（幂等），挂载 API 与前端静态页面
const path = require('path');
const fs = require('fs');
const express = require('express');
const { open, initSchema } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
const SEED_DEMO = process.env.SEED_DEMO !== '0'; // 默认写入演示数据，仅在空库时

open(DB_PATH);
initSchema();

// 空库时写入演示数据（可用 SEED_DEMO=0 关闭）
if (SEED_DEMO) {
  try {
    const { getDb } = require('./db');
    const n = getDb().prepare(`SELECT COUNT(*) c FROM material`).get().c;
    if (n === 0) require('./seed').seedDemo();
  } catch (e) {
    console.warn('演示数据初始化跳过：', e.message);
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', require('./routes'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: true, errors: [err.message || '服务器内部错误'] });
});

app.listen(PORT, HOST, () => {
  console.log(`展馆授权核验系统已启动: http://localhost:${PORT}`);
  console.log(`数据库: ${DB_PATH}`);
});
