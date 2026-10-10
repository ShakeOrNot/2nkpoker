import 'dotenv/config';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET;
const issuer = process.env.JWT_ISSUER;
const audience = process.env.JWT_AUDIENCE;

const sub = process.argv[2] || 'user_001';
const nickname = process.argv[3] || sub;

const token = jwt.sign(
  { nickname, role: 'user' },
  secret,
  { subject: sub, issuer, audience, expiresIn: '15m' },
);

const socket = io('http://localhost:3001/game', {
  auth: { token },
});

socket.on('connect', () => {
  console.log('connected as', sub);
  socket.emit('table:join', { tableId: 't1' }, (res) => {
    console.log('table:join ack:', res);
  });
});

socket.on('table:snapshot', (s) => {
  console.log('snapshot:', JSON.stringify(s, null, 2));
});

socket.on('connect_error', (err) => {
  console.log('connect_error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  socket.close();
  process.exit(0);
}, 5000);