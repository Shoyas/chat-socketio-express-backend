import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { nanoid } from "nanoid";
import { z } from "zod";

type Message = {
  id: string;
  from: string;
  to: string;
  text: string;
  ts: number;
  deliveredTo: string[];
  readBy: string[];
};

type Contact = { id: string; name: string };

type ThreadSummary = {
  otherId: string;
  otherName: string;
  lastText: string;
  lastTs: number;
  unread: number;
};

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

const contacts: Contact[] = [
  { id: "nasir", name: "Nasir" },
  { id: "samin", name: "Samin" },
  { id: "jamil", name: "Jamil" },
  { id: "tauhid", name: "Tauhid" },
  { id: "me", name: "You" },
];

const messages: Message[] = [];

/** Presence tracking */
const presence = new Map<
  string,
  { sockets: Set<string>; lastSeen: number | null }
>();

/** lastRead[userId][otherId] = timestamp */
const lastRead: Record<string, Record<string, number>> = {};

const getRoomId = (a: string, b: string) => [a, b].sort().join(":");

const ensurePresence = (userId: string) => {
  if (!presence.has(userId)) presence.set(userId, { sockets: new Set(), lastSeen: null });
  return presence.get(userId)!;
};

const sendSchema = z.object({
  tempId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  text: z.string().trim().min(1).max(2000),
});

app.get("/api/contacts", (_req, res) => res.json(contacts));

/** Paginated messages between A and B: ?before=<ts>&limit=<n> */
app.get("/api/messages/:userA/:userB", (req, res) => {
  const { userA, userB } = req.params;
  const before = Number(req.query.before ?? Date.now() + 1);
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50)));
  const thread = messages
    .filter(
      (m) =>
        ((m.from === userA && m.to === userB) || (m.from === userB && m.to === userA)) &&
        m.ts < before
    )
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .sort((a, b) => a.ts - b.ts);
  res.json(thread);
});

/** User's threads with unread counts */
app.get("/api/threads/:userId", (req, res) => {
  const { userId } = req.params;
  const involved = messages.filter((m) => m.from === userId || m.to === userId);
  const groups: Record<string, Message[]> = {};
  for (const m of involved) {
    const otherId = m.from === userId ? m.to : m.from;
    (groups[otherId] ||= []).push(m);
  }
  const summaries: ThreadSummary[] = Object.entries(groups).map(([otherId, group]) => {
    group.sort((a, b) => b.ts - a.ts);
    const last = group[0];
    const other = contacts.find((c) => c.id === otherId);
    const lastReadAt = (lastRead[userId] && lastRead[userId][otherId]) || 0;
    const unread = group.filter((m) => m.to === userId && m.ts > lastReadAt).length;
    return {
      otherId,
      otherName: other?.name ?? otherId,
      lastText: last?.text ?? "",
      lastTs: last?.ts ?? 0,
      unread,
    };
  });
  summaries.sort((a, b) => b.lastTs - a.lastTs);
  res.json(summaries);
});

/** Mark all from otherId -> userId as read */
app.post("/api/threads/:userId/read/:otherId", (req, res) => {
  const { userId, otherId } = req.params;
  lastRead[userId] ||= {};
  lastRead[userId][otherId] = Date.now();

  // Also update internal message state and notify sender of 'read'
  for (const m of messages) {
    if (m.from === otherId && m.to === userId) {
      if (!m.readBy.includes(userId)) m.readBy.push(userId);
      io.to(otherId).emit("message:read", { id: m.id, by: userId });
    }
  }
  res.json({ ok: true });
});

/** Presence API */
app.get("/api/presence/:userId", (req, res) => {
  const { userId } = req.params;
  const p = presence.get(userId);
  res.json({
    online: !!(p && p.sockets.size > 0),
    lastSeen: p?.lastSeen ?? null,
  });
});

/** Socket layer */
io.on("connection", (socket) => {
  let activeRoom: string | null = null;

  socket.on("join", (payload: { userId: string; otherId?: string }) => {
    const { userId, otherId } = payload;
    socket.data.userId = userId;

    // Presence
    const p = ensurePresence(userId);
    p.sockets.add(socket.id);
    io.emit("presence:update", { userId, online: true });

    // Personal room for presence/DM notifications
    socket.join(userId);

    // Thread room subscription (leave previous thread to avoid noise)
    if (activeRoom) socket.leave(activeRoom);
    if (otherId) {
      activeRoom = getRoomId(userId, otherId);
      socket.join(activeRoom);
      socket.data.activeRoom = activeRoom;
    } else {
      activeRoom = null;
      socket.data.activeRoom = null;
    }
  });

  /** Typing indicator (to thread only) */
  socket.on("typing", (payload: { room: string; from: string; isTyping: boolean }) => {
    if (!payload?.room || !payload?.from) return;
    socket.to(payload.room).emit("typing", payload);
  });

  /** Send message with ack */
  socket.on("message:send", (raw) => {
    const parsed = sendSchema.safeParse(raw);
    if (!parsed.success) {
      socket.emit("message:error", { tempId: raw?.tempId, error: "Invalid payload" });
      return;
    }
    const { tempId, from, to, text } = parsed.data;

    const id = nanoid();
    const ts = Date.now();
    const msg: Message = {
      id,
      from,
      to,
      text,
      ts,
      deliveredTo: [],
      readBy: [],
    };
    messages.push(msg);

    // Ack back to sender to replace temp message
    socket.emit("message:ack", { tempId, id, ts });

    // Broadcast to thread room ONLY to avoid duplicates
    const room = getRoomId(from, to);
    io.to(room).emit("message:new", msg);
  });

  /** Recipient confirms receipt (delivery) */
  socket.on("message:received", (payload: { id: string; by: string }) => {
    const { id, by } = payload || {};
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    if (!msg.deliveredTo.includes(by)) msg.deliveredTo.push(by);
    // Notify sender (sender listens in their personal room)
    io.to(msg.from).emit("message:delivered", { id, by });
  });

  /** Recipient read */
  socket.on("message:read", (payload: { id: string; by: string }) => {
    const { id, by } = payload || {};
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    if (!msg.readBy.includes(by)) msg.readBy.push(by);
    io.to(msg.from).emit("message:read", { id, by });
  });

  socket.on("disconnect", () => {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;
    const p = ensurePresence(userId);
    p.sockets.delete(socket.id);
    if (p.sockets.size === 0) {
      p.lastSeen = Date.now();
      io.emit("presence:update", { userId, online: false, lastSeen: p.lastSeen });
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on http://10.0.30.40:${PORT}`);
});
