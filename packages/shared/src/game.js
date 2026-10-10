/**
 * @typedef {'WAITING'|'PREFLOP'|'FLOP'|'TURN'|'RIVER'|'SHOWDOWN'|'SETTLED'} Street
 *
 * @typedef {(
 *   | { type: 'fold' }
 *   | { type: 'check' }
 *   | { type: 'call' }
 *   | { type: 'bet', amount: number }
 *   | { type: 'raise', amount: number }
 *   | { type: 'all_in' }
 * )} PlayerAction
 *
 * @typedef {Object} Pot
 * @property {number} amount
 * @property {number[]} eligibleSeats
 *
 * @typedef {Object} SeatState
 * @property {number} seat
 * @property {string|null} userId
 * @property {string} nickname
 * @property {number} chips
 * @property {number} betThisStreet
 * @property {boolean} folded
 * @property {boolean} allIn
 * @property {boolean} sittingOut
 * @property {import('./cards.js').Card[]} [holeCards]
 *
 * @typedef {Object} TableSnapshot
 * @property {string} tableId
 * @property {number} version
 * @property {Street} street
 * @property {string|null} handId
 * @property {number} buttonSeat
 * @property {number} smallBlind
 * @property {number} bigBlind
 * @property {import('./cards.js').Card[]} board
 * @property {Pot[]} pots
 * @property {SeatState[]} seats
 * @property {number|null} currentTurnSeat
 * @property {number|null} actionDeadline
 */

export {};