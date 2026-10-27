'use strict';
const express = require('express');
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { Server } = require('socket.io');
const path = require('node:path');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '30m' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/ice', (_req, res) => {
  // Optional ICE_SERVERS_JSON: [{"urls":"turn:...","username":"...","credential":"..."}]
  try {
    const custom = JSON.parse(process.env.ICE_SERVERS_JSON || 'null');
    if (Array.isArray(custom) && custom.length <= 6) return res.json({ iceServers: custom });
  } catch (_) {}
  res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
});
const server = createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 24_000,
  cors: { origin: false },
  pingTimeout: 25000
});

const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomIdPattern = /^[A-HJ-NP-Z2-9]{7,10}$/;
function createId() {
  let id;
  do { id = Array.from(randomBytes(8), n => alphabet[n % alphabet.length]).join(''); }
  while (rooms.has(id));
  return id;
}
function createRoom(id) {
  return {
    id, members: new Map(), chat: [], shareOwner: null,
    media: { kind: 'none', url: '', videoId: '', title: '', position: 0, playing: false, updatedAt: Date.now(), revision: 0 },
    touched: Date.now()
  };
}
function mediaSnapshot(room) {
  const m = room.media;
  const now = Date.now();
  return { ...m, position: m.playing ? m.position + (now - m.updatedAt) / 1000 : m.position, updatedAt: now };
}
function publicState(room) {
  return {
    id: room.id,
    members: [...room.members].map(([id, value]) => ({ id, name: value.name })),
    media: mediaSnapshot(room),
    shareOwner: room.shareOwner,
    chat: room.chat
  };
}
function notifyState(room) {
  io.to(room.id).emit('room:state', publicState(room));
}
function validMedia(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.kind === 'youtube' && typeof data.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(data.videoId)) {
    return { kind: 'youtube', videoId: data.videoId, url: `https://www.youtube.com/watch?v=${data.videoId}`, title: 'YouTube' };
  }
  if (data.kind === 'vimeo' && typeof data.videoId === 'string' && /^[0-9]{6,14}$/.test(data.videoId)) {
    return { kind: 'vimeo', videoId: data.videoId, url: `https://vimeo.com/${data.videoId}`, title: 'Vimeo' };
  }
  if (data.kind === 'direct' && typeof data.url === 'string' && data.url.length <= 2000) {
    try {
      const parsed = new URL(data.url);
      if (!['https:', 'http:'].includes(parsed.protocol)) return null;
      if (!/\.(mp4|webm|ogg|m3u8)(?:$|[?#])/i.test(parsed.href)) return null;
      return { kind: 'direct', videoId: '', url: parsed.href, title: 'Видео по ссылке' };
    } catch { return null; }
  }
  return null;
}
function stopShare(room) {
  if (!room.shareOwner) return;
  io.to(room.shareOwner).emit('share:forced-stop');
  room.shareOwner = null;
}

app.post('/api/rooms', (_req, res) => {
  const id = createId();
  rooms.set(id, createRoom(id));
  res.status(201).json({ id });
});

io.on('connection', socket => {
  let roomId = null;
  let lastChatAt = 0;
  function currentRoom() { return roomId ? rooms.get(roomId) : null; }
  function cleanLeave() {
    const room = currentRoom();
    if (!room) { roomId = null; return; }
    room.members.delete(socket.id);
    socket.leave(room.id);
    if (room.shareOwner === socket.id) {
      room.shareOwner = null;
      room.media = { kind: 'none', url: '', videoId: '', title: '', position: 0, playing: false, updatedAt: Date.now(), revision: room.media.revision + 1 };
      socket.to(room.id).emit('share:ended');
    }
    socket.to(room.id).emit('rtc:peer-left', { peerId: socket.id });
    room.touched = Date.now();
    notifyState(room);
    roomId = null;
  }
  socket.on('room:join', (data, respond = () => {}) => {
    const rawId = String(data?.roomId || '').toUpperCase().trim();
    const name = String(data?.name || '').trim().slice(0, 28);
    if (!roomIdPattern.test(rawId) || !name) return respond({ ok: false, error: 'Неверная комната или имя.' });
    if (roomId) cleanLeave();
    let room = rooms.get(rawId);
    if (!room) { room = createRoom(rawId); rooms.set(rawId, room); }
    if (room.members.size >= 8) return respond({ ok: false, error: 'В комнате уже 8 человек.' });
    roomId = rawId;
    room.members.set(socket.id, { name });
    room.touched = Date.now();
    socket.join(rawId);
    respond({ ok: true, state: publicState(room), you: socket.id });
    notifyState(room);
    if (room.shareOwner) io.to(room.shareOwner).emit('rtc:viewer-ready', { viewerId: socket.id });
  });
  socket.on('media:set', (payload, respond = () => {}) => {
    const room = currentRoom();
    if (!room) return respond({ ok: false, error: 'Сначала войдите в комнату.' });
    const media = validMedia(payload);
    if (!media) return respond({ ok: false, error: 'Нужна ссылка YouTube, Vimeo либо прямая ссылка MP4, WebM, OGG, M3U8.' });
    stopShare(room);
    room.media = { ...media, position: 0, playing: false, updatedAt: Date.now(), revision: room.media.revision + 1 };
    room.touched = Date.now();
    notifyState(room);
    respond({ ok: true });
  });
  socket.on('media:control', payload => {
    const room = currentRoom();
    if (!room || !['youtube', 'vimeo', 'direct'].includes(room.media.kind)) return;
    if (!payload || !['play', 'pause', 'seek'].includes(payload.action)) return;
    if (payload.revision !== room.media.revision) return;
    const n = Number(payload.position);
    if (!Number.isFinite(n) || n < 0 || n > 60 * 60 * 48) return;
    room.media.position = n;
    room.media.playing = payload.action === 'play' ? true : payload.action === 'pause' ? false : room.media.playing;
    room.media.updatedAt = Date.now();
    room.touched = Date.now();
    io.to(room.id).emit('media:sync', mediaSnapshot(room));
  });
  // Round-trip clock calibration keeps devices with different local clocks in sync.
  socket.on('sync:clock', (_data, respond = () => {}) => respond({ serverNow: Date.now() }));
  socket.on('media:get', () => {
    const room = currentRoom();
    if (room) socket.emit('media:sync', mediaSnapshot(room));
  });
  let lastReactionAt = 0;
  socket.on('reaction:send', payload => {
    const room = currentRoom();
    if (!room || Date.now() - lastReactionAt < 450) return;
    const emoji = String(payload?.emoji || '');
    if (!['❤️', '😂', '😮', '🔥'].includes(emoji)) return;
    lastReactionAt = Date.now();
    io.to(room.id).emit('reaction:new', { emoji, at: Date.now() });
  });
  socket.on('chat:send', payload => {
    const room = currentRoom();
    if (!room || Date.now() - lastChatAt < 400) return;
    const body = String(payload?.body || '').trim().slice(0, 800);
    if (!body) return;
    lastChatAt = Date.now();
    const msg = { id: randomBytes(8).toString('hex'), senderId: socket.id, name: room.members.get(socket.id)?.name || 'Гость', body, at: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 80) room.chat.shift();
    room.touched = Date.now();
    io.to(room.id).emit('chat:new', msg);
  });
  socket.on('share:start', (respond = () => {}) => {
    const room = currentRoom();
    if (!room) return respond({ ok: false, error: 'Нет комнаты.' });
    stopShare(room);
    room.shareOwner = socket.id;
    room.media = { kind: 'screen', videoId: '', url: '', title: 'Трансляция экрана', position: 0, playing: true, updatedAt: Date.now(), revision: room.media.revision + 1 };
    room.touched = Date.now();
    notifyState(room);
    respond({ ok: true });
  });
  socket.on('share:stop', () => {
    const room = currentRoom();
    if (!room || room.shareOwner !== socket.id) return;
    room.shareOwner = null;
    room.media = { kind: 'none', url: '', videoId: '', title: '', position: 0, playing: false, updatedAt: Date.now(), revision: room.media.revision + 1 };
    room.touched = Date.now();
    socket.to(room.id).emit('share:ended');
    notifyState(room);
  });
  socket.on('rtc:viewer-ready', () => {
    const room = currentRoom();
    if (room?.shareOwner && room.shareOwner !== socket.id) {
      io.to(room.shareOwner).emit('rtc:viewer-ready', { viewerId: socket.id });
    }
  });
  socket.on('rtc:signal', ({ target, data } = {}) => {
    const room = currentRoom();
    if (!room || typeof target !== 'string' || !room.members.has(target)) return;
    if (room.shareOwner !== socket.id && room.shareOwner !== target) return;
    if (!data || !['offer', 'answer', 'candidate'].includes(data.type)) return;
    if (JSON.stringify(data).length > 16000) return;
    io.to(target).emit('rtc:signal', { from: socket.id, data });
  });
  socket.on('disconnect', cleanLeave);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (!room.members.size && now - room.touched > 2 * 60 * 60 * 1000) rooms.delete(id);
  }
}, 30 * 60 * 1000).unref();

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Together Watch: http://localhost:${port}`));
}
module.exports = { app, server, io, validMedia, createId };
