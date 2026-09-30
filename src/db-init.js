'use strict';
// 独立的数据库初始化脚本：node src/db-init.js
const path = require('path');
const { open, initSchema, close } = require('./db');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
open(DB_PATH);
initSchema();
console.log(`数据库已初始化: ${DB_PATH}`);
close();
