/**
 * 每张桌子一个 actor，所有操作排队串行执行
 * 防止两个客户端同时发动作导致状态错乱
 */
export class TableActor {
  constructor(tableId) {
    this.tableId = tableId;
    this.queue = Promise.resolve();
  }

  /**
   * 把 fn 排进队列，前一个执行完才轮到它
   * @template T
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    const next = this.queue.then(fn, fn);
    // 吞掉错误，避免队列被打断
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}