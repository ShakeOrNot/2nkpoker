import './helpers/env.js';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
process.env.STREET_DELAY_MS='5'; process.env.SETTLE_HOLD_MS='150';
const {initDb,closeDb}=await import('../src/users/db.js');
const {registerAuthRoutes}=await import('../src/routes/auth.route.js');
const {registerStickerRoutes}=await import('../src/routes/stickers.route.js');
const {registerGameNamespace}=await import('../src/ws/game.namespace.js');
const {closeTable,getTable}=await import('../src/state/tableManager.js');
const {clearActionTimer,clearNextHandTimer,clearStreetTimer}=await import('../src/state/actionTimer.js');
const {cancelPendingDisconnect}=await import('../src/state/disconnectManager.js');
initDb(':memory:'); const app=Fastify({logger:false}); registerAuthRoutes(app); registerStickerRoutes(app);
const server=new Server(app.server); registerGameNamespace(server);
const clients=[],sessions=[],latest=[],results=[[],[],[]]; const tableId='experience';
const request=(s,e,p)=>s.timeout(3000).emitWithAck(e,p);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(test) { const end=Date.now()+5000; while(!test()){if(Date.now()>end)throw new Error('集成状态等待超时');await pause(5);} }
try {
  const url=await app.listen({port:0,host:'127.0.0.1'});
  for(let i=0;i<3;i++){
    const session=(await app.inject({method:'POST',url:'/auth/register',payload:{nickname:`集成玩家${i}`,password:'poker-2026'}})).json(); sessions.push(session);
    await app.inject({method:'PATCH',url:'/auth/me/avatar',headers:{authorization:`Bearer ${session.accessToken}`},payload:{avatarId:['lion','fox','cat'][i]}});
    const s=io(`${url}/game`,{auth:{token:session.accessToken},transports:['websocket'],autoConnect:false}); clients.push(s);
    s.on('table:snapshot',value=>{
      for(const row of value.hand?.seats??[])if(row.seat!==i)assert.equal(row.holeCards?.length??0,0,'未结算时不能泄露对手底牌');
      latest[i]=value;
    });
    s.on('game:result',value=>results[i].push(value));
    await new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('connect_error',reject);s.connect();});
    assert.equal((await request(s,'table:join',{tableId})).ok,true);
    assert.equal((await request(s,'table:sit',{tableId,seat:i,buyIn:2000*(i+1)})).ok,true);
  }
  assert.deepEqual(latest[0].seats.filter(s=>s.userId).map(s=>s.avatarId),['lion','fox','cat']);
  const text=await request(clients[0],'chat:send',{tableId,text:'整体验收开始',clientId:'integrated_text_1'}); assert.equal(text.ok,true);
  for(const s of clients)assert.equal((await request(s,'table:ready',{tableId,ready:true})).ok,true);
  let reconnected=false;
  for(let step=0;step<100&&results[0].length<2;step++){
    await wait(()=>results[0].length>=2||latest.some(v=>v?.hand&&!v.hand.settled&&!v.hand.pendingStreetAdvance&&v.hand.currentTurnSeat!=null));
    if(results[0].length>=2)break;
    const source=latest.find(v=>v?.hand&&!v.hand.settled&&!v.hand.pendingStreetAdvance&&v.hand.currentTurnSeat!=null);
    const hand=source.hand;
    if(hand.street==='FLOP'&&!reconnected){
      clients[0].disconnect();
      assert.equal((await request(clients[1],'chat:send',{tableId,stickerId:'nice',clientId:'integrated_emote_1'})).ok,true);
      await new Promise((resolve,reject)=>{clients[0].once('connect',resolve);clients[0].once('connect_error',reject);clients[0].connect();});
      assert.equal((await request(clients[0],'table:join',{tableId})).restored,true);
      const history=await request(clients[0],'chat:history',{tableId}); assert.equal(history.messages.length,2); assert.equal(history.messages[1].sticker.id,'nice');
      reconnected=true; continue;
    }
    const seat=hand.currentTurnSeat; const mine=hand.seats.find(s=>s.seat===seat);
    const action=results[0].length===1?{type:'all_in'}:{type:hand.currentBet>mine.betThisStreet?'call':'check'};
    const accepted=await request(clients[seat],'game:action',{tableId,handId:hand.handId,expectedVersion:hand.version,action});
    assert.equal(accepted.ok,true,accepted.code);
    await pause(8);
  }
  await wait(()=>results.every(rows=>rows.length>=2));
  assert.equal(reconnected,true);
  for(let hand=0;hand<2;hand++){
    assert.equal(results[0][hand].board.length,5);
    for(const rows of results)assert.deepEqual(rows[hand].result.payouts,results[0][hand].result.payouts);
  }
  assert.ok(results[0][1].result.pots.length>=2,'不同筹码全下应产生边池');
  await wait(()=>latest[0]?.hand==null);
  assert.equal(latest[0].seats.reduce((sum,s)=>sum+s.chips,0),12000,'多手与边池结算后筹码守恒');
  console.log('整体验收通过：三人两手、所有街道、私有底牌、头像、聊天、表情、局中重连、自动下一手、全下边池、结算一致与筹码守恒');
} finally {
  const table=getTable(tableId); if(table)for(const seat of table.seats.values())seat.ready=false;
  clearActionTimer(tableId); clearNextHandTimer(tableId); clearStreetTimer(tableId);
  for(const s of clients)s.disconnect(); await new Promise(resolve=>server.close(resolve));
  for(const s of sessions)cancelPendingDisconnect(s.user.id);
  clearActionTimer(tableId); clearNextHandTimer(tableId); clearStreetTimer(tableId);
  closeTable(tableId); await app.close(); closeDb();
}
