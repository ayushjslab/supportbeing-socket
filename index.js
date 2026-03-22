const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();


const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || process.env.SOCKET_PORT || 3001;

const ALLOWED_ORIGINS = "*"; // Allow all — widget is embedded on any customer website


// Mini Schema for Agent
const agentSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    websiteId: mongoose.Schema.Types.ObjectId,
    status: { type: String, enum: ['online', 'offline'], default: 'offline' }
});

const Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);

const server = http.createServer();
const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ["GET", "POST"]
    }
});

mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Socket Server: Connected to MongoDB'))
    .catch(err => console.error('❌ Socket Server: MongoDB Error:', err));

const socketToEntity = new Map(); // socket.id -> { type: 'agent'|'visitor', data }
const onlineVisitors = new Map(); // webUserId -> { websiteId, count, data }

io.on('connection', (socket) => {
    console.log('👤 New connection:', socket.id);

    // --- AGENT AUTHENTICATION ---
    socket.on('authenticate', async ({ userId, websiteId }) => {
        if (!userId || !websiteId) return;
        const uid = String(userId);
        const wsid = String(websiteId);

        console.log(`🔐 Agent Authenticated: User ${uid} on Website ${wsid}`);
        socketToEntity.set(socket.id, { type: 'agent', data: { userId: uid, websiteId: wsid } });

        socket.join(`website:${wsid}`);

        try {
            await Agent.findOneAndUpdate({ userId: uid, websiteId: wsid }, { status: 'online' });
            io.to(`website:${wsid}`).emit('status_update', { userId: uid, status: 'online' });

            // Send current online visitors for this site
            const visitors = [];
            for (const [vid, info] of onlineVisitors.entries()) {
                if (String(info.websiteId) === wsid) visitors.push(vid);
            }
            socket.emit('initial_visitor_presence', { webUserIds: visitors });

            console.log(`🟢 Agent ${uid} is ONLINE`);
        } catch (err) { console.error(err); }
    });

    // --- VISITOR AUTHENTICATION ---
    socket.on('visitor_authenticate', ({ webUserId, websiteId, sessionId }) => {
        if (!webUserId || !websiteId) return;
        const wuid = String(webUserId);
        const wsid = String(websiteId);

        socketToEntity.set(socket.id, { type: 'visitor', data: { webUserId: wuid, websiteId: wsid, sessionId } });
        socket.join(`website:${wsid}`);
        if (sessionId) socket.join(`session:${sessionId}`);

        // Update global online status with ref counting
        if (!onlineVisitors.has(wuid)) {
            onlineVisitors.set(wuid, { websiteId: wsid, count: 1 });
            console.log(`🔌 Visitor ${wuid} (NEW) connected to ${wsid}`);
            io.to(`website:${wsid}`).emit('visitor_status_update', { webUserId: wuid, status: 'online' });
        } else {
            const info = onlineVisitors.get(wuid);
            info.count++;
            console.log(`🔌 Visitor ${wuid} (TAB ${info.count}) connected`);
        }
    });

    socket.on('disconnect', async () => {
        const entity = socketToEntity.get(socket.id);
        if (!entity) return;

        if (entity.type === 'agent') {
            const { userId, websiteId } = entity.data;
            console.log(`🔴 Agent ${userId} disconnected`);
            try {
                await Agent.findOneAndUpdate({ userId, websiteId }, { status: 'offline' });
                io.to(`website:${websiteId}`).emit('status_update', { userId, status: 'offline' });
            } catch (err) { console.error(err); }
        } else if (entity.type === 'visitor') {
            const { webUserId, websiteId } = entity.data;
            const info = onlineVisitors.get(webUserId);
            if (info) {
                info.count--;
                if (info.count <= 0) {
                    onlineVisitors.delete(webUserId);
                    console.log(`👋 Visitor ${webUserId} fully DISCONNECTED`);
                    io.to(`website:${websiteId}`).emit('visitor_status_update', { webUserId, status: 'offline' });
                } else {
                    console.log(`👋 Visitor ${webUserId} closed one tab (${info.count} remaining)`);
                }
            }
        }

        socketToEntity.delete(socket.id);
    });

    // --- SESSION ROOM MANAGEMENT ---
    socket.on('join_session', ({ sessionId }) => {
        if (!sessionId) return;
        socket.join(`session:${sessionId}`);
        console.log(`📡 Socket ${socket.id} joined session ${sessionId}`);
    });

    socket.on('leave_session', ({ sessionId }) => {
        if (!sessionId) return;
        socket.leave(`session:${sessionId}`);
        console.log(`📡 Socket ${socket.id} left session ${sessionId}`);
    });

    // --- SESSION UPDATES (e.g. agent assignment, status change) ---
    socket.on('session_update', (data) => {
        const { sessionId, update } = data;
        if (!sessionId || !update) return;

        console.log(`✨ Session update for ${sessionId}:`, Object.keys(update));
        io.to(`session:${sessionId}`).emit('session_updated', { sessionId, update });
    });

    // --- MESSAGE BROADCASTING ---
    socket.on('send_message', (data) => {
        const { sessionId, websiteId, message } = data;
        if (!sessionId || !websiteId || !message) return;

        console.log(`💬 Message in session ${sessionId}`);

        // Broadcast to everyone in the session (Visitor + Assigned Agent)
        io.to(`session:${sessionId}`).emit('new_message', { sessionId, message });

        // Broadcast to the website room (for Dashboard/Chats list updates)
        io.to(`website:${websiteId}`).emit('session_activity', { sessionId, lastMessage: message });
    });

    // --- SESSION NOTIFICATIONS ---
    socket.on('new_session_started', ({ websiteId, session }) => {
        if (!websiteId || !session) return;
        console.log(`✨ New session started for website ${websiteId}`);
        io.to(`website:${websiteId}`).emit('new_session', { session });
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Socket Server running on port ${PORT}`);
});
