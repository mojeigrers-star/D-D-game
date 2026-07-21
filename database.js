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

    // Server-side persistence for character appearance, stats, and inventory.
    // Previously these lived only in each browser's localStorage, so progress
    // was lost whenever someone switched devices or cleared their browser data.
    db.run(`
        CREATE TABLE IF NOT EXISTS player_data (
            username TEXT PRIMARY KEY,
            character_json TEXT,
            stats_json TEXT,
            inventory_json TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (username) REFERENCES users(username)
        )
    `, (err) => {
        if (err) console.error('Error creating player_data table:', err);
        else console.log('Player data table ready');
    });
});

module.exports = db;