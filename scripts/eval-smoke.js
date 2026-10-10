import { evaluate7, compareHands, Category } from '@2nkpoker/poker-engine';

const nameOf = ['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺','皇家同花顺'];

const hands = [
  'As Ks Qs Js Ts 2h 3d',  // 皇家同花顺
  '9h 8h 7h 6h 5h Kc 2s',  // 同花顺
  'As Ah Ad Ac Kd Qc 2s',  // 四条
  'As Ah Ad Kc Kd Qc 2s',  // 葫芦
  'As Ks Qs Js 9s 2h 3d',  // 同花
  '9h 8s 7d 6c 5h Kd 2s',  // 顺子
  'As Ah Ad Kc Qd Js 2h',  // 三条
  'As Ah Kc Kd Qs Jd 2h',  // 两对
  'As Ah Kc Qd Js 9h 2s',  // 一对
  'As Kh Qd Jc 9s 7h 2c',  // 高牌
];

for (const s of hands) {
  const v = evaluate7(s.split(' '));
  console.log(nameOf[v.category].padEnd(6), '|', s);
}