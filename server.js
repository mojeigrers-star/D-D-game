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
// rooms[code] = { host, players: [{username, socketId}], started, maxPlayers, readyPlayers: Set, mapSeed: number,
//                 pendingRequests: { username -> socketId },
//                 denyCounts: { username -> number },
//                 banned: Set<username> }

const rooms = {};

// ===== SESSIONS (in-memory) =====
// sessions[username] = { code, host }
// Stored when a player successfully joins or hosts; cleared on intentional leave.
// Allows "Rejoin Last Session" without a database.

const sessions = {};

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
        let code;
        do { code = generateCode(); } while (rooms[code]);

        rooms[code] = {
            host: username,
            players: [{ username, socketId: socket.id }],
            started: false,
            maxPlayers,
            readyPlayers: new Set(),
            mapSeed: null,
            pendingRequests: {},
            denyCounts: {},
            banned: new Set()
        };

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.username = username;

        // Save session for the host
        sessions[username] = { code, host: username };

        socket.emit('room-created', safeRoomInfo(code));
        console.log(`Room ${code} created by ${username}`);
    });

    // --- JOIN REQUEST: joiner asks host for entry (replaces instant join-room) ---
    socket.on('join-room', ({ username, code }) => {
        const room = rooms[code];

        if (!room)
            return socket.emit('join-error', 'Room not found. Check the code and try again.');

        // If the game has started, only allow back in if they have a saved session for this room
        if (room.started) {
            const session = sessions[username];
            const wasInRoom = room.players.find(p => p.username === username)
                           || (session && session.code === code);
            if (wasInRoom) {
                // Treat this as a rejoin — promote directly without host approval
                const existing = room.players.find(p => p.username === username);
                if (existing) {
                    existing.socketId = socket.id;
                } else {
                    room.players.push({ username, socketId: socket.id });
                }
                socket.join(code);
                socket.data.roomCode = code;
                socket.data.username = username;
                sessions[username] = { code, host: room.host };

                const readyList = Array.from(room.readyPlayers || []);
                socket.emit('rejoined', {
                    ...safeRoomInfo(code),
                    readyPlayers: readyList,
                    mapSeed: room.mapSeed || null
                });
                io.to(code).emit('player-list-updated', safeRoomInfo(code));
                console.log(`${username} auto-rejoined started room ${code} via join-room`);
                return;
            }
            return socket.emit('join-error', 'This realm has already begun its quest.');
        }

        if (room.players.length >= room.maxPlayers)
            return socket.emit('join-error', 'The realm is full. No more adventurers may enter.');
        if (room.players.find(p => p.username === username))
            return socket.emit('join-error', 'An adventurer with that name is already in this realm.');
        if (room.banned && room.banned.has(username))
            return socket.emit('join-error', 'You are Banished from this Realm.');

        // Queue a pending request
        room.pendingRequests[username] = socket.id;
        socket.data.pendingCode = code;
        socket.data.username = username;

        // Tell the joiner to wait
        socket.emit('join-pending', { code });

        // Tell the host someone is knocking
        const hostPlayer = room.players.find(p => p.username === room.host);
        if (hostPlayer && hostPlayer.socketId) {
            io.to(hostPlayer.socketId).emit('join-request', { username, code });
        }

        console.log(`${username} requested to join room ${code}`);
    });

    // --- HOST: accept a pending join request ---
    socket.on('accept-request', ({ username }) => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room || room.host !== socket.data.username) return;

        const joinerSocketId = room.pendingRequests[username];
        if (!joinerSocketId) return;

        delete room.pendingRequests[username];
        // Reset deny count on successful join
        if (room.denyCounts) room.denyCounts[username] = 0;

        // Check capacity again (race condition guard)
        if (room.players.length >= room.maxPlayers) {
            io.to(joinerSocketId).emit('join-error', 'The realm filled while you were waiting.');
            return;
        }

        room.players.push({ username, socketId: joinerSocketId });

        const joinerSocket = io.sockets.sockets.get(joinerSocketId);
        if (joinerSocket) {
            joinerSocket.join(code);
            joinerSocket.data.roomCode = code;
            joinerSocket.data.username = username;
        }

        // Save session for the joiner
        sessions[username] = { code, host: room.host };

        io.to(joinerSocketId).emit('room-joined', safeRoomInfo(code));
        io.to(code).emit('player-list-updated', safeRoomInfo(code));
        console.log(`${username} accepted into room ${code}`);
    });

    // --- HOST: deny a pending join request ---
    socket.on('deny-request', ({ username }) => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room || room.host !== socket.data.username) return;

        const joinerSocketId = room.pendingRequests[username];
        if (!joinerSocketId) return;

        delete room.pendingRequests[username];

        if (!room.denyCounts) room.denyCounts = {};
        room.denyCounts[username] = (room.denyCounts[username] || 0) + 1;

        const count = room.denyCounts[username];

        if (count >= 3) {
            // Banish after 3 consecutive denials
            if (!room.banned) room.banned = new Set();
            room.banned.add(username);
            io.to(joinerSocketId).emit('join-denied', {
                message: 'You are Banished from this Realm.',
                banished: true,
                count
            });
            console.log(`${username} banished from room ${code} after ${count} denials`);
        } else {
            io.to(joinerSocketId).emit('join-denied', {
                message: `The host has denied your entry. (${count}/3 — banished at 3)`,
                banished: false,
                count
            });
            console.log(`${username} denied from room ${code} (${count}/3)`);
        }
    });

    // --- REJOIN: reconnect after page navigation ---
    socket.on('rejoin-room', ({ username, code }) => {
        const room = rooms[code];
        if (!room) return;

        const existing = room.players.find(p => p.username === username);
        if (existing) {
            existing.socketId = socket.id;
        } else {
            room.players.push({ username, socketId: socket.id });
        }

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.username = username;

        // Refresh session
        sessions[username] = { code, host: room.host };

        const readyList = Array.from(room.readyPlayers || []);
        socket.emit('rejoined', {
            ...safeRoomInfo(code),
            readyPlayers: readyList,
            mapSeed: room.mapSeed || null
        });

        io.to(code).emit('player-list-updated', safeRoomInfo(code));

        socket.emit('ready-update', {
            readyCount: room.readyPlayers.size,
            totalCount: room.players.length,
            readyPlayers: readyList
        });

        console.log(`${username} rejoined room ${code}`);
    });

    // --- READY UP ---
    socket.on('player-ready', ({ username: payloadUser, code: payloadCode } = {}) => {
        const code = socket.data.roomCode || payloadCode;
        const username = socket.data.username || payloadUser;
        const room = rooms[code];
        if (!room || !username) return;

        if (!socket.data.roomCode) {
            socket.data.roomCode = code;
            socket.data.username = username;
            socket.join(code);
        }

        if (!room.readyPlayers) room.readyPlayers = new Set();
        room.readyPlayers.add(username);

        const readyList = Array.from(room.readyPlayers);
        const readyCount = room.readyPlayers.size;
        const totalCount = room.players.length;

        io.to(code).emit('ready-update', { readyCount, totalCount, readyPlayers: readyList });
        console.log(`${username} is ready in room ${code} (${readyCount}/${totalCount})`);

        if (readyCount >= totalCount && totalCount >= 1) {
            room.started = true;
            io.to(code).emit('all-ready');
            console.log(`Room ${code} — all players ready, entering game`);
        }
    });

    // --- HOST: kick a player ---
    socket.on('kick-player', ({ targetUsername }) => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room || room.host !== socket.data.username) return;

        const target = room.players.find(p => p.username === targetUsername);
        if (!target) return;

        room.players = room.players.filter(p => p.username !== targetUsername);
        if (room.readyPlayers) room.readyPlayers.delete(targetUsername);

        // Clear their session so rejoin doesn't bring them back
        delete sessions[targetUsername];

        io.to(target.socketId).emit('kicked', { reason: 'The Host has removed you from the realm.' });
        io.to(code).emit('player-list-updated', safeRoomInfo(code));
    });

    // --- HOST: start the game ---
    socket.on('start-game', () => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room || room.host !== socket.data.username) return;
        if (room.players.length < 1) return;

        room.started = true;
        room.readyPlayers = new Set();

        io.to(code).emit('game-started', safeRoomInfo(code));
        console.log(`Room ${code} game started`);
    });

    // --- HOST: broadcast map seed to all players ---
    socket.on('map-seed', ({ seed }) => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room || room.host !== socket.data.username) return;
        room.mapSeed = seed;
        socket.to(code).emit('map-seed', { seed });
        console.log(`Room ${code} map seed set: ${seed}`);
    });

    // --- Lobby chat ---
    socket.on('lobby-chat', ({ message }) => {
        const code = socket.data.roomCode;
        if (!code || !rooms[code]) return;
        const username = socket.data.username;
        const safe = String(message).slice(0, 200).replace(/</g, '&lt;');
        io.to(code).emit('lobby-chat', { username, message: safe, ts: Date.now() });
    });

    // --- In-game party chat ---
    socket.on('party-chat', ({ message }) => {
        const code = socket.data.roomCode;
        if (!code || !rooms[code]) return;
        const username = socket.data.username;
        const safe = String(message).slice(0, 200).replace(/</g, '&lt;');
        socket.to(code).emit('party-chat', { username, message: safe, ts: Date.now() });
    });

    // --- Intentional leave (leave button clicked) ---
    socket.on('leave-room', () => {
        const code = socket.data.roomCode;
        const username = socket.data.username;
        if (!code || !rooms[code]) return;

        const room = rooms[code];
        room.players = room.players.filter(p => p.username !== username);
        if (room.readyPlayers) room.readyPlayers.delete(username);

        // Clear session on intentional leave
        delete sessions[username];

        if (room.players.length === 0) {
            delete rooms[code];
            console.log(`Room ${code} deleted (empty)`);
        } else {
            if (room.host === username) {
                room.host = room.players[0].username;
                io.to(code).emit('host-changed', { newHost: room.host });
            }
            io.to(code).emit('player-list-updated', safeRoomInfo(code));
        }

        socket.leave(code);
        socket.data.roomCode = null;
        console.log(`${username} intentionally left room ${code}`);
    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
        const code = socket.data.roomCode;
        const username = socket.data.username;

        // Clean up any pending join request if the joiner disconnects while waiting
        if (socket.data.pendingCode && !code) {
            const pendingRoom = rooms[socket.data.pendingCode];
            if (pendingRoom && pendingRoom.pendingRequests[username]) {
                delete pendingRoom.pendingRequests[username];
                console.log(`${username} disconnected while pending in room ${socket.data.pendingCode}`);
            }
            return;
        }

        if (!code || !rooms[code]) return;

        const room = rooms[code];

        if (room.started) {
            const existing = room.players.find(p => p.username === username);
            if (existing) existing.socketId = null;

            io.to(code).emit('player-list-updated', safeRoomInfo(code));

            setTimeout(() => {
                const r = rooms[code];
                if (!r) return;
                const p = r.players.find(p => p.username === username);
                if (p && p.socketId === null) {
                    r.players = r.players.filter(p => p.username !== username);
                    if (r.readyPlayers) r.readyPlayers.delete(username);
                    delete sessions[username];
                    if (r.players.length === 0) {
                        delete rooms[code];
                        console.log(`Room ${code} deleted (empty after grace period)`);
                    } else {
                        io.to(code).emit('player-list-updated', safeRoomInfo(code));
                        console.log(`${username} permanently removed from room ${code} after grace period`);
                    }
                }
            }, 30000);

            console.log(`${username} disconnected from started room ${code} — grace period started`);
            return;
        }

        room.players = room.players.filter(p => p.socketId !== socket.id);
        if (room.readyPlayers) room.readyPlayers.delete(username);

        if (room.players.length === 0) {
            delete rooms[code];
            console.log(`Room ${code} deleted (empty)`);
        } else if (room.host === username) {
            room.host = room.players[0].username;
            io.to(code).emit('host-changed', { newHost: room.host });
            io.to(code).emit('player-list-updated', safeRoomInfo(code));
        } else {
            io.to(code).emit('player-list-updated', safeRoomInfo(code));
        }
        console.log(`${username} disconnected from room ${code}`);
    });
});

const path = require('path');

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'signin.html'));
});

httpServer.listen(PORT, () => {
    console.log(`⚔  D&D Server running at http://localhost:${PORT}`);
});