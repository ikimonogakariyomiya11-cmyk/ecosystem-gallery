/**
 * 生態系ピラミッド ギャラリーサーバー
 * 依存なし（Node.js標準ライブラリのみ）
 * 
 * 起動: node server.js
 * アクセス: http://[あなたのIPアドレス]:3000
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ── インメモリ状態 ─────────────────────────────────────────────
const clients  = new Map(); // socketKey → { socket, name }
const pyramids = new Map(); // name → { name, counts, savedAt }

// ── HTTPサーバー ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end();
});

// ── WebSocket ハンドシェイク（手書き実装） ────────────────────
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  const socketKey = crypto.randomBytes(8).toString('hex');
  clients.set(socketKey, { socket, name: null });

  // ── WebSocket フレームのデコード ──────────────────────────
  let buf = Buffer.alloc(0);

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin    = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let payloadLen = buf[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buf.length < 4) break;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) break;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + payloadLen) break;

      if (opcode === 0x8) { // close
        socket.destroy();
        break;
      }

      if (opcode === 0x1 || opcode === 0x2) { // text or binary
        let payload = buf.slice(offset + maskLen, offset + maskLen + payloadLen);
        if (masked) {
          const mask = buf.slice(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }
        try {
          handleMessage(socketKey, JSON.parse(payload.toString('utf8')));
        } catch {}
      }

      buf = buf.slice(offset + maskLen + payloadLen);
    }
  });

  socket.on('close', () => {
    const client = clients.get(socketKey);
    clients.delete(socketKey);
    if (client?.name) {
      console.log(`👋 ${client.name} が退出`);
      broadcastGallery();
    }
  });

  socket.on('error', () => {
    clients.delete(socketKey);
  });

  // 接続直後に現在のギャラリーを送信
  sendTo(socketKey, { type: 'gallery', data: galleryArray() });
});

// ── メッセージ処理 ─────────────────────────────────────────────
function handleMessage(socketKey, msg) {
  const client = clients.get(socketKey);
  if (!client) return;

  if (msg.type === 'join') {
    const name = String(msg.name || '').trim().slice(0, 20);
    if (!name) return;
    client.name = name;
    clients.set(socketKey, client);
    console.log(`✅ ${name} が参加 (接続数: ${clients.size})`);
    sendTo(socketKey, { type: 'joined', name });
    broadcastGallery();
  }

  if (msg.type === 'save') {
    if (!client.name) return;
    pyramids.set(client.name, {
      name: client.name,
      counts: msg.counts,
      savedAt: Date.now(),
    });
    console.log(`💾 ${client.name} が保存: 🐺${msg.counts.wolves} 🦌${msg.counts.deer} 🌿${msg.counts.grass}`);
    broadcastGallery();
  }
}

// ── ブロードキャスト ───────────────────────────────────────────
function galleryArray() {
  return [...pyramids.values()].sort((a, b) => b.savedAt - a.savedAt);
}

function broadcastGallery() {
  const msg = { type: 'gallery', data: galleryArray() };
  clients.forEach((_, key) => sendTo(key, msg));
}

function sendTo(socketKey, obj) {
  const client = clients.get(socketKey);
  if (!client?.socket?.writable) return;
  try {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const frame = encodeFrame(payload);
    client.socket.write(frame);
  } catch {}
}

function encodeFrame(payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// ── 起動 ───────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🌿 生態系ピラミッド ギャラリーサーバー 起動');
  console.log('─'.repeat(45));
  console.log(`📡 ローカル:   http://localhost:${PORT}`);
  console.log('');
  console.log('同じWi-Fiの端末からは:');
  console.log(`  http://[このPCのIPアドレス]:${PORT}`);
  console.log('');
  console.log('IPアドレスの確認方法:');
  console.log('  Mac:     ifconfig | grep "inet " ');
  console.log('  Windows: ipconfig');
  console.log('─'.repeat(45));
  console.log('Ctrl+C で終了');
  console.log('');
});
