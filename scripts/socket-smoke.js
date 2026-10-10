import { io } from 'socket.io-client';

const socket = io('http://localhost:3001/game', {
  auth: { token: 'bad_token' },
});

socket.on('connect', () => {
  console.log('connected (unexpected)');
  process.exit(1);
});

socket.on('connect_error', (err) => {
  console.log('expected error:', err.message);
  process.exit(0);
});

setTimeout(() => {
  console.log('timeout, no response');
  process.exit(1);
}, 5000);