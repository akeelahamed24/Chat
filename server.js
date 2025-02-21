const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Security Middleware
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket Server
const wss = new WebSocket.Server({ server, clientTracking: true });
const rooms = new Map();

// Utility Functions
function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function broadcastToRoom(roomCode, message, excludeWs = null) {
  const room = rooms.get(roomCode);
  if (room) {
    room.forEach(client => {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
}

// WebSocket Connection Handler
wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  let currentRoom = null;
  let username = null;

  // Heartbeat check
  let isAlive = true;
  ws.on('pong', () => { isAlive = true; });

  // Message Handler
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Validate message structure
      if (!data.type) {
        throw new Error('Invalid message format');
      }

      switch (data.type) {
        case 'create-room':
          if (!data.username) throw new Error('Username required');
          const roomCode = generateRoomCode();
          username = data.username;
          rooms.set(roomCode, new Set([ws]));
          currentRoom = roomCode;
          ws.send(JSON.stringify({ 
            type: 'room-created', 
            code: roomCode 
          }));
          break;

        case 'join-room':
          if (!data.username || !data.code) {
            throw new Error('Username and room code required');
          }
          const room = rooms.get(data.code.toUpperCase());
          if (!room) {
            throw new Error('Invalid room code');
          }
          username = data.username;
          currentRoom = data.code.toUpperCase();
          room.add(ws);
          ws.send(JSON.stringify({ type: 'room-joined' }));
          broadcastToRoom(currentRoom, {
            type: 'user-joined',
            username: username
          }, ws);
          break;

        case 'message':
          if (!data.text || !currentRoom) {
            throw new Error('Invalid message');
          }
          broadcastToRoom(currentRoom, {
            type: 'message',
            text: data.text,
            sender: username,
            timestamp: new Date().toISOString()
          });
          break;

        default:
          throw new Error('Unknown message type');
      }
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message
      }));
      console.error(`Client ${clientId} error:`, error.message);
    }
  });

  // Connection Close Handler
  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.delete(ws);
      if (room.size === 0) {
        rooms.delete(currentRoom);
      } else {
        broadcastToRoom(currentRoom, {
          type: 'user-left',
          username: username
        });
      }
    }
  });

  // Error Handler
  ws.on('error', (error) => {
    console.error(`Client ${clientId} error:`, error);
    ws.close();
  });
});

// Heartbeat Check
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(null, false, true);
  });
}, 30000);

// Cleanup on server close
server.on('close', () => {
  clearInterval(interval);
  wss.clients.forEach((ws) => ws.close());
  wss.close();
});

// Handle all routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Handle process termination
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});