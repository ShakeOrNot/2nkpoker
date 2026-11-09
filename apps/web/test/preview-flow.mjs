// 仅供本地美术预览使用；正式对局推进由服务器决定。
export function collectionGuard(hand) {
  if (!hand || hand.settled) return { ok: false, message: '请先发手牌，再演示收筹码。' };
  const seats = hand.seats ?? [];
  const total = seats.reduce((sum, seat) => sum + Math.max(0, Number(seat.betThisStreet ?? 0)), 0);
  if (!total) return { ok: false, message: '本轮没有下注，无需收筹码。' };
  const maximum = Math.max(...seats.map(seat => Number(seat.betThisStreet ?? 0)));
  const pending = seats.some(seat => !seat.folded && !seat.allIn && Number(seat.betThisStreet ?? 0) < maximum);
  if (pending) return { ok: false, message: '请先跟齐下注，再收筹码。' };
  const next = { PREFLOP: 'flop', FLOP: 'turn', TURN: 'river' }[hand.street];
  if (!next) return { ok: false, message: '河牌后请使用结算预览。' };
  return { ok: true, next, total, message: '本轮筹码已收向底池。' };
}
