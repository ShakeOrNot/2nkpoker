export const ActionError = Object.freeze({
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_ACTION: 'INVALID_ACTION',
  INSUFFICIENT_CHIPS: 'INSUFFICIENT_CHIPS',
  HAND_NOT_ACTIVE: 'HAND_NOT_ACTIVE',
  SEAT_INVALID: 'SEAT_INVALID',
});

/**
 * @param {any} state
 * @param {number} seat
 * @returns {Array<'fold'|'check'|'call'|'bet'|'raise'|'all_in'>}
 */
export function legalActions(state, seat) {
  const s = findSeat(state, seat);
  if (!s) return [];
  if (s.folded || s.allIn || s.sittingOut) return [];
  if (state.currentTurnSeat !== seat) return [];

  const toCall = Math.max(0, state.currentBet - s.betThisStreet);
  const canCheck = toCall === 0;
  const canCall = toCall > 0 && s.chips > 0;
  const canBet = state.currentBet === 0 && s.chips > 0;
  const canRaise = state.currentBet > 0 && s.chips > toCall;

  /** @type {Array<'fold'|'check'|'call'|'bet'|'raise'|'all_in'>} */
  const out = ['fold'];
  if (canCheck) out.push('check');
  if (canCall) out.push('call');
  if (canBet) out.push('bet');
  if (canRaise) out.push('raise');
  if (s.chips > 0) out.push('all_in');
  return out;
}

/**
 * @param {any} state
 * @param {number} seat
 * @param {{ type: string, amount?: number }} action
 * @returns {{ pay: number, isRaise: boolean, isAllIn: boolean }}
 */
export function validateAction(state, seat, action) {
  const s = findSeat(state, seat);
  if (!s) throw new Error(ActionError.SEAT_INVALID);
  if (s.folded || s.allIn || s.sittingOut) throw new Error(ActionError.INVALID_ACTION);
  if (state.currentTurnSeat !== seat) throw new Error(ActionError.NOT_YOUR_TURN);

  const toCall = Math.max(0, state.currentBet - s.betThisStreet);

  switch (action.type) {
    case 'fold':
      return { pay: 0, isRaise: false, isAllIn: false };

    case 'check':
      if (toCall !== 0) throw new Error(ActionError.INVALID_ACTION);
      return { pay: 0, isRaise: false, isAllIn: false };

    case 'call': {
      if (toCall === 0) throw new Error(ActionError.INVALID_ACTION);
      const pay = Math.min(toCall, s.chips);
      return { pay, isRaise: false, isAllIn: pay === s.chips };
    }

    case 'bet': {
      if (state.currentBet !== 0) throw new Error(ActionError.INVALID_ACTION);
      const amount = num(action.amount);
      if (amount < state.bigBlind) throw new Error(ActionError.INVALID_ACTION);
      if (amount > s.chips) throw new Error(ActionError.INSUFFICIENT_CHIPS);
      return { pay: amount, isRaise: true, isAllIn: amount === s.chips };
    }

    case 'raise': {
      if (state.currentBet === 0) throw new Error(ActionError.INVALID_ACTION);
      const target = num(action.amount);
      if (target < state.currentBet + state.minRaise) {
        throw new Error(ActionError.INVALID_ACTION);
      }
      const pay = target - s.betThisStreet;
      if (pay > s.chips) throw new Error(ActionError.INSUFFICIENT_CHIPS);
      return { pay, isRaise: true, isAllIn: pay === s.chips };
    }

    case 'all_in': {
      if (s.chips <= 0) throw new Error(ActionError.INVALID_ACTION);
      const pay = s.chips;
      const isRaise = s.betThisStreet + pay > state.currentBet;
      return { pay, isRaise, isAllIn: true };
    }

    default:
      throw new Error(ActionError.INVALID_ACTION);
  }
}

function findSeat(state, seat) {
  return state.seats.find((x) => x.seat === seat) ?? null;
}

function num(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(ActionError.INVALID_ACTION);
  }
  return Math.floor(v);
}