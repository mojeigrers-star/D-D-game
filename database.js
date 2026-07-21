const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'users.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Connected to SQLite database');
    }
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('Error creating table:', err);
        } else {
            console.log('Users table ready');
        }

        // Migration: add security question/answer columns for existing databases.
        // SQLite has no "ADD COLUMN IF NOT EXISTS", so we check pragma first.
        db.all(`PRAGMA table_info(users)`, (err, columns) => {
            if (err) return console.error('Error reading table info:', err);
            const names = columns.map(c => c.name);
            if (!names.includes('security_question')) {
                db.run(`ALTER TABLE users ADD COLUMN security_question TEXT`);
            }
            if (!names.includes('security_answer_hash')) {
                db.run(`ALTER TABLE users ADD COLUMN security_answer_hash TEXT`);
            }
        });
    });
});

module.exports = db;