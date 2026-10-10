import { makeDeck, shuffle, draw } from '@2nkpoker/poker-engine';

const deck = shuffle(makeDeck());
const [p1, rest1] = draw(deck, 2);
const [p2, rest2] = draw(rest1, 2);
const [board] = draw(rest2, 5);

console.log('P1:', p1.join(' '));
console.log('P2:', p2.join(' '));
console.log('Board:', board.join(' '));