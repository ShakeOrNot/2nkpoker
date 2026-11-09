import { describe, it, expect } from 'vitest';
import { Store } from '../public/js/store.js';

function fixture() {
  const store = new Store(); store.state.phase = 'table'; store.state.session = {userId:'me'};
  const seats = [{seat:0,userId:'me',nickname:'我',chips:1000,betThisStreet:0,totalCommitted:0,holeCards:['Ah','Kd']}, {seat:1,userId:'other',chips:1000,betThisStreet:0,totalCommitted:0,holeCards:[]}];
  const hand = {handId:'h1',version:3,street:'FLOP',currentTurnSeat:0,currentBet:0,minRaise:20,bigBlind:20,board:['2c','3d','4h'],seats};
  store.state.room = {...store.state.room,tableId:'room',snapshot:{tableId:'room',seats,hand}};
  return {store,hand,seats};
}
const request = {handId:'h1',version:3,seat:0,legalActions:['check'],deadline:Date.now()+60000};
describe('行动请求生命周期', () => {
  it('换街等待立即清理旧请求与代打计时器', () => {
    const {store,hand,seats}=fixture(); store.applyActionRequest({...request});
    expect(store.deadlineTimer).toBeTruthy();
    store.applySnapshot({tableId:'room',seats,hand:{...hand,version:4,currentTurnSeat:null,pendingStreetAdvance:true}});
    expect(store.deadlineTimer).toBeNull(); expect(store.pendingRequest).toBeNull();
    expect(store.actionContext().isMyTurn).toBe(false); expect(store.actionContext().legal).toEqual([]);
  });
  it('旧请求不能重新激活操作，也不能在新的同座位轮次代打', async () => {
    const {store,hand}=fixture(); hand.version=5;
    store.applyActionRequest({...request}); expect(store.state.room.actionRequest).toBeNull();
    let acted=0; store.act=async()=>{acted++;}; await store.autoAction({...request}); expect(acted).toBe(0);
    store.state.room.actionRequest={...request}; expect(store.actionContext().request).toBeNull();
  });
  it('行动确认晚于下一轮请求时，不清除新请求', async () => {
    const {store,hand}=fixture(); const old={...request}; store.applyActionRequest(old);
    let confirm; store.ensureSocket=async()=>({ok:true}); store.socket={request:()=>new Promise(resolve=>{confirm=resolve;})};
    const sending=store.act({type:'check'}); await Promise.resolve(); await Promise.resolve();
    hand.version=5; const next={...request,version:5}; store.applyActionRequest(next);
    confirm({ok:true}); await sending;
    expect(store.state.room.actionRequest).toBe(next); expect(store.pendingRequest).toBe(next);
    store.clearActionRequest();
  });
});
