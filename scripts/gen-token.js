import 'dotenv/config';
import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET || 'dev_secret_change_me';
const issuer = process.env.JWT_ISSUER || '2nkpoker';
const audience = process.env.JWT_AUDIENCE || '2nkpoker-web';

const sub = process.argv[2] || `user_${Math.floor(Math.random() * 10000)}`;
const nickname = process.argv[3] || sub;

const token = jwt.sign(
  { nickname, role: 'user' },
  secret,
  { subject: sub, issuer, audience, expiresIn: '15m' },
);

console.log(token);