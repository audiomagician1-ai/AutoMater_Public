const Database = require('better-sqlite3');
const db = new Database('C:\\Users\\yongsheng.gu\\AppData\\Roaming\\Electron\\data\\automater.db');
const projects = db.prepare('SELECT id, name, status FROM projects').all();
console.log('Projects:', JSON.stringify(projects, null, 2));
