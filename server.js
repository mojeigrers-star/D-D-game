const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const cors = require('cors');
const bodyParser = require('body-parser');
const db = require('./database');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// ===== AUTH ROUTES =====

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(
            'INSERT INTO users (username, password_hash) VALUES (?, ?)',
            [username, hashedPassword],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE'))
                        return res.status(409).json({ error: 'Username already exists' });
                    return res.status(500).json({ error: 'Database error' });
                }
                res.status(201).json({ message: 'Account created successfully', userId: this.lastID });
            }
        );
    } catch {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'Username and password required' });

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(401).json({ error: 'Invalid username or password' });

        try {
            const match = await bcrypt.compare(password, user.password_hash);
            if (match) {
                res.json({ message: 'Login successful', username: user.username });
            } else {
                res.status(401).json({ error: 'Invalid username or password' });
            }
        } catch {
            res.status(500).json({ error: 'Server error' });
        }
    });
});

// ===== ROOMS (in-memory) =====
// rooms[code] = { host, players: [{username, socketId}], started, maxPlayers }

const rooms = {};

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function safeRoomInfo(code) {
    const r = rooms[code];
    if (!r) return null;
    return {
        code,
        host: r.host,
        players: r.players.map(p => p.username),
        started: r.started,
        maxPlayers: r.maxPlayers
    };
}

// ===== SOCKET.IO =====

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // --- HOST: create a new room ---
    socket.on('host-room', ({ username, maxPlayers = 4 }) => {
        // Generate unique code
        let code;
        do { code = generateCode(); } while (rooms[code]);

        rooms[code] = {
            host: username,
            players: [{ username, socketId: socket.id }],
            started: false,
            maxPlayers
        };

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.username = username;

        socket.emit('room-created', safeRoomInfo(code));
        console.log(`Room ${code} created by ${username}`);
    });

    // --- JOIN: enter an existing room by code ---
    socket.on('join-room', ({ username, code }) => {
        const room = rooms[code];

        if (!room)
            return socket.emit('join-error', 'Room not found. Check the code and try again.');
        if (room.started)
            return socket.emit('join-error', 'This realm has already begun its quest.');
        if (room.players.length >= room.maxPlayers)
            return socket.emit('join-error', 'The realm is full. No more adventurers may enter.');
        if (room.players.find(p => p.username === username))
            return socket.emit('join-error', 'An adventurer with that name is already in this realm.');

        room.players.push({ username, socketId: socket.id });
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.username = username;

        // Tell the new joiner they succeeded
        socket.emit('room-joined', safeRoomInfo(code));

        // Tell everyone in the room (including host) the roster updated
        io.to(code).emit('player-list-updated', safeRoomInfo(code));
        console.log(`${username} joined room ${code}`);
    });

    // --- HOST: kick a player ---
    socket.on('kick-player', ({ targetUsername }) => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room || room.host !== socket.data.username) return;

        const target = room.players.find(p => p.username === targetUsername);
        if (!target) return;

        room.players = room.players.filter(p => p.username !== targetUsername);

        // Tell kicked player
        io.to(target.socketId).emit('kicked', { reason: 'The Host has removed you from the realm.' });

        // Update everyone else
        io.to(code).emit('player-list-updated', safeRoomInfo(code));
    });

    // --- HOST: start the game ---
    socket.on('start-game', () => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room || room.host !== socket.data.username) return;
        if (room.players.length < 1) return;

        room.started = true;
        io.to(code).emit('game-started', safeRoomInfo(code));
        console.log(`Room ${code} game started`);
    });

    // --- Chat message inside lobby ---
    socket.on('lobby-chat', ({ message }) => {
        const code = socket.data.roomCode;
        if (!code || !rooms[code]) return;
        const username = socket.data.username;
        const safe = String(message).slice(0, 200).replace(/</g, '&lt;');
        io.to(code).emit('lobby-chat', { username, message: safe, ts: Date.now() });
    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
        const code = socket.data.roomCode;
        const username = socket.data.username;
        if (!code || !rooms[code]) return;

        const room = rooms[code];
        room.players = room.players.filter(p => p.socketId !== socket.id);

        if (room.players.length === 0) {
            // Empty room — clean up
            delete rooms[code];
            console.log(`Room ${code} deleted (empty)`);
        } else if (room.host === username) {
            // Host left — promote next player
            room.host = room.players[0].username;
            io.to(code).emit('host-changed', { newHost: room.host });
            io.to(code).emit('player-list-updated', safeRoomInfo(code));
            console.log(`Room ${code} new host: ${room.host}`);
        } else {
            io.to(code).emit('player-list-updated', safeRoomInfo(code));
        }
        console.log(`${username} disconnected from room ${code}`);
    });
});

httpServer.listen(PORT, () => {
    console.log(`⚔  D&D Server running at http://localhost:${PORT}`);
});