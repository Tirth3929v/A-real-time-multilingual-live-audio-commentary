require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const WebSocket = require('ws');
const { translateCommentary } = require('./src/services/translationService');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3001;

// Apply automated security header fortification
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "ws://localhost:3001", "http://localhost:8000", "https://*.openrouter.ai", "https://*.googleapis.com", "wss://*.onrender.com", "https://*.onrender.com", "http://127.0.0.1:8000"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: [],
    },
  },
}));

// Restrict spam configurations to elevate security posture
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 100, // Limit each IP to 100 requests per window
  message: 'Too many requests engineered from this IP, please defer execution.',
});
app.use('/api/', limiter);
// Also apply to internal route for safety
app.use('/internal/', limiter);

app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
    res.status(200).send('🟢 Node.js Orchestration Layer is Live.');
});

app.post('/internal/stream-update', (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || !payload.languageRoom) {
    return res.status(400).json({ error: 'Malformated or structurally deficient payload structure.' });
  }

  // Deep Sanitization Layer: reject payloads with XSS vectors
  const xssPattern = /<[^>]*>?/gm;
  if (payload.originalText && xssPattern.test(payload.originalText)) {
    return res.status(400).json({ error: 'Payload contains illegal anomalous symbols.' });
  }

  const { languageRoom, sequenceId, originalText } = payload;
  console.log(`📡 Received stream update for room: ${languageRoom} (Seq: ${sequenceId}): "${originalText}"`);
  
  if (!languageRoom) {
    console.error('❌ Error: Missing languageRoom in payload');
    return res.status(400).send('Missing languageRoom');
  }

  if (rooms.has(languageRoom)) {
    const clients = rooms.get(languageRoom);
    console.log(`👥 Broadcasting to ${clients.size} client(s) in room ${languageRoom}`);
    if (clients.size > 0) {
      const message = JSON.stringify(payload);
      clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  } else {
    console.log(`ℹ️ No clients currently subscribed to room: ${languageRoom}`);
  }
  res.send('OK');
});


// Room management
const rooms = new Map();

wss.on('connection', (ws) => {
  console.log('New client connected');
  ws.room = null; // Track which room the client is in

  // Send a welcome message
  ws.send(JSON.stringify({ 
    type: 'text', 
    payload: 'Welcome to the live commentary feed.',
    seqId: Date.now()
  }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'join_room') {
        const { language } = data;
        
        // Remove from old room if exists
        if (ws.room && rooms.has(ws.room)) {
          rooms.get(ws.room).delete(ws);
        }
        
        // Add to new room
        ws.room = language;
        if (!rooms.has(language)) {
          rooms.set(language, new Set());
        }
        rooms.get(language).add(ws);
        
        console.log(`Client joined room: ${language}`);
        
        ws.send(JSON.stringify({
          type: 'text',
          payload: `Joined ${language.toUpperCase()} commentary stream.`,
          seqId: Date.now()
        }));
      } else if (data.type === 'TRANSCRIPTION_READY') {
        // 1. Trigger the OpenRouter translation
        console.log(`📝 Received TRANSCRIPTION_READY: "${data.text}"`);
        const translatedText = await translateCommentary(data.text, 'Hindi');
        console.log(`🤖 Translated via OpenRouter: "${translatedText}"`);

        // 2. Broadcast the translation directly back to the fan's frontend
        ws.send(JSON.stringify({
          type: 'TRANSLATION_BURST',
          text: translatedText
        }));
      }
    } catch (e) {
      console.error('Failed to process message from client', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (ws.room && rooms.has(ws.room)) {
      rooms.get(ws.room).delete(ws);
    }
  });
});


if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Node.js orchestration server listening on port ${PORT}`);
  });
}

module.exports = { app, server };
