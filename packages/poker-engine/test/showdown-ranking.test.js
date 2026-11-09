import { describe, it, expect } from 'vitest';
import { startHand, applyAction } from '../src/index.js';

function showdown(board, weaker, stronger) {
  let {state}=startHand({handId:'ranking',buttonSeat:0,smallBlind:10,bigBlind:20,players:[{seat:0,chips:1000},{seat:1,chips:1000}]});
  state.street='RIVER'; state.board=board; state.currentBet=0; state.currentTurnSeat=0;
  for(const seat of state.seats)Object.assign(seat,{chips:980,totalCommitted:20,betThisStreet:0,hasActedThisStreet:false,holeCards:seat.seat===0?weaker:stronger});
  state=applyAction(state,0,{type:'check'}).state;
  return applyAction(state,1,{type:'check'}).state;
}
describe('摊牌派彩按完整牌型排序',()=>{
  const cases=[
    ['一对胜高牌',['5d','Ah','Js','2c','6h'],['Kh','4s'],['8s','8c']],
    ['两对胜一对',['Ah','Kd','7c','4d','2s'],['Ac','Qs'],['Ks','7h']],
    ['三条胜两对',['Ah','Ad','Kc','7d','2s'],['Ks','Qh'],['Ac','9h']],
    ['顺子胜三条',['2h','3d','4c','8s','8h'],['8d','Kh'],['5d','6s']],
    ['同花胜顺子',['2h','3h','4h','8c','Kd'],['5s','6c'],['9h','Jh']],
    ['葫芦胜同花',['Ah','Kh','7h','7d','2s'],['3h','4h'],['7s','2c']],
    ['四条胜葫芦',['Ah','Ad','7h','7d','2s'],['As','2c'],['7s','7c']],
    ['同花顺胜四条',['5h','6h','7h','7d','7s'],['7c','Ah'],['8h','9h']],
    ['同牌型按踢脚牌比较',['Ac','3d','7h','9s','Jc'],['Ah','Qd'],['As','Kd']],
  ];
  for(const [name,board,weaker,stronger]of cases)it(name,()=>{
    const state=showdown(board,weaker,stronger);
    expect(state.settled).toBe(true); expect(state.result.payouts[1]).toBe(40); expect(state.result.payouts[0]??0).toBe(0);
    expect(state.seats.reduce((sum,s)=>sum+s.chips,0)).toBe(2000);
  });
  it('相同最佳五张牌平分底池',()=>{
    const state=showdown(['Ts','Jh','Qd','Kc','As'],['2c','3c'],['4c','5c']);
    expect(state.result.payouts).toEqual({0:20,1:20});
  });
});
