const path = require('path');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const http = require('http');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
});

const PORT = process.env.PORT || 3000;

const sessions = new Map();

function newToken(n = 16) {
  return crypto.randomBytes(n).toString('hex');
}

function newSessionId() {
  return crypto.randomBytes(6).toString('hex');
}

function getLanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const HOST = process.env.HOST || getLanIP();
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || null; // e.g. https://xxx.trycloudflare.com

app.use(express.json());
app.use('/assets', express.static(path.join(__dirname), {
  setHeaders: (res, file) => {
    if (file.endsWith('.glb')) res.setHeader('Content-Type', 'model/gltf-binary');
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/session', async (req, res) => {
  const id = newSessionId();
  const token = newToken();
  sessions.set(id, { id, token, createdAt: Date.now(), desktop: null, mobile: null });

  const baseUrl = PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
  const mobileUrl = `${baseUrl}/m.html?s=${id}&t=${token}`;
  const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
    margin: 1,
    width: 480,
    color: { dark: '#0a0908', light: '#f6efe1' },
  });

  res.json({ sessionId: id, token, mobileUrl, qrDataUrl, baseUrl });
});

app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  res.json({ id: s.id, hasDesktop: !!s.desktop, hasMobile: !!s.mobile });
});

io.on('connection', (socket) => {
  const { sessionId, token, role } = socket.handshake.auth || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token) {
    socket.emit('error_msg', 'invalid_session');
    socket.disconnect(true);
    return;
  }

  socket.join(sessionId);
  if (role === 'desktop') s.desktop = socket.id;
  else if (role === 'mobile') s.mobile = socket.id;

  io.to(sessionId).emit('connectionStatus', {
    desktop: !!s.desktop,
    mobile: !!s.mobile,
    role,
    event: 'join',
  });

  socket.on('orientationUpdate', (payload) => {
    socket.to(sessionId).emit('orientationUpdate', payload);
  });

  socket.on('armPitch', (payload) => {
    socket.to(sessionId).emit('armPitch', payload);
  });

  socket.on('armZoom', (payload) => {
    socket.to(sessionId).emit('armZoom', payload);
  });

  socket.on('watchSelect', (payload) => {
    socket.to(sessionId).emit('watchSelect', payload);
  });

  socket.on('calibrationData', (payload) => {
    socket.to(sessionId).emit('calibrationData', payload);
  });

  socket.on('controlMode', (payload) => {
    socket.to(sessionId).emit('controlMode', payload);
  });

  socket.on('ping_t', (t) => socket.emit('pong_t', t));

  socket.on('disconnect', () => {
    if (s.desktop === socket.id) s.desktop = null;
    if (s.mobile === socket.id) s.mobile = null;
    io.to(sessionId).emit('connectionStatus', {
      desktop: !!s.desktop,
      mobile: !!s.mobile,
      role,
      event: 'leave',
    });
    if (!s.desktop && !s.mobile) {
      setTimeout(() => {
        const cur = sessions.get(sessionId);
        if (cur && !cur.desktop && !cur.mobile) sessions.delete(sessionId);
      }, 60_000);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Cyberpunk watch pairing running:`);
  console.log(`    Desktop:  http://${HOST}:${PORT}/`);
  console.log(`    (also)    http://localhost:${PORT}/`);
  console.log(`\n  Open the desktop URL on your large screen, then scan the QR with a phone.\n`);
});
