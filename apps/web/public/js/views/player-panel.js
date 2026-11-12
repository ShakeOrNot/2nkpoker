import { button, node, setText, tag } from './base.js';
import { percent, ago } from '../core/format.js';

/**
 * 玩家面板：战绩概览 / 成就 / LuckyHands，各模块可折叠。
 * 大厅「我的战绩」和牌桌点玩家名共用这一个弹窗。
 */
export class PlayerPanel {
  /** @param {any} store */
  constructor(store) {
    this.store = store;
    this.requestId = 0;
    this.build();
    document.body.appendChild(this.overlay);
  }

  build() {
    this.overlay = node('modal-overlay player-panel-overlay');
    const card = node('modal-card player-panel');
    card.appendChild(tag('h3', 'modal-title', '玩家面板'));
    this.title = card.querySelector('.modal-title');
    this.hint = tag('p', 'modal-hint', '加载中…');
    card.appendChild(this.hint);
    this.sections = node('pp-sections');
    card.appendChild(this.sections);

    const actions = node('modal-actions');
    actions.appendChild(
      button({ label: '刷新', className: 'btn-ghost', onClick: () => void this.reload() }),
    );
    actions.appendChild(
      button({ label: '关闭', className: 'btn-primary', onClick: () => this.close() }),
    );
    card.appendChild(actions);

    this.overlay.appendChild(card);
    this.overlay.addEventListener('click', (ev) => {
      if (ev.target === this.overlay) this.close();
    });
    this.userId = '';
    this.nickname = '';
  }

  /**
   * @param {string} userId
   * @param {string} [nickname]
   */
  async open(userId, nickname = '') {
    if (!userId) return;
    this.userId = userId;
    this.nickname = nickname;
    this.overlay.classList.add('visible');
    setText(this.title, nickname || '玩家面板');
    setText(this.hint, '加载中…');
    this.sections.replaceChildren();
    await this.load();
  }

  close() {
    this.requestId += 1;
    this.overlay.classList.remove('visible');
  }

  reload() {
    if (this.userId) void this.load();
  }

  async load() {
    const rid = ++this.requestId;
    const res = await this.store.playerStats(this.userId);
    if (rid !== this.requestId) return;
    if (!res.ok) {
      setText(this.hint, res.message || '加载战绩失败');
      return;
    }
    this.render(res.user ?? { nickname: this.nickname }, res.stats);
  }

  /**
   * @param {{ nickname?: string }} user
   * @param {any} stats
   */
  render(user, stats) {
    setText(this.title, user?.nickname || this.nickname || '玩家面板');
    if (!stats || !stats.hands) {
      setText(this.hint, '还没有打过牌');
      this.sections.replaceChildren();
      return;
    }
    const net = Number(stats.net ?? 0);
    const profit = Number(stats.profit ?? 0);
    const last = stats.lastPlayedAt ? ` · 最近 ${ago(Number(stats.lastPlayedAt))}` : '';
    setText(
      this.hint,
      `共 ${stats.hands} 手 · 净 ${net >= 0 ? '+' : ''}${net} · 累计盈利 +${profit}${last}`,
    );

    this.sections.replaceChildren(
      this.section('战绩', true, this.overview(stats)),
      this.section('成就', false, this.achievements(stats.achievements)),
      this.section('LuckyHands / UnluckyHands', false, this.luck(stats.luck)),
    );
  }

  /**
   * @param {string} title
   * @param {boolean} open
   * @param {HTMLElement} body
   */
  section(title, open, body) {
    const box = document.createElement('details');
    box.className = 'pp-section';
    box.open = open;
    box.appendChild(tag('summary', 'pp-summary', title));
    const content = node('pp-body');
    content.appendChild(body);
    box.appendChild(content);
    return box;
  }

  /** @param {any} stats */
  overview(stats) {
    const grid = node('stats-grid');
    const items = [
      ['入池率', percent(stats.vpipRate, stats.hands), `${stats.vpipHands ?? 0} 手主动入池`],
      ['胜率', percent(stats.winRate, stats.hands), `${stats.wins ?? 0} 手净赢`],
      ['摊牌率', percent(stats.showdownRate, stats.hands), `${stats.showdowns ?? 0} 手亮牌`],
      [
        '摊牌胜率',
        percent(stats.showdownWinRate, stats.showdowns),
        `${stats.showdownWins ?? 0}/${stats.showdowns ?? 0} 亮牌局`,
      ],
    ];
    for (const [label, value, sub] of items) {
      const cell = node('stats-item');
      cell.appendChild(tag('div', 'stats-label', label));
      cell.appendChild(tag('div', 'stats-value', value));
      cell.appendChild(tag('div', 'stats-sub', sub));
      grid.appendChild(cell);
    }
    return grid;
  }

  /** @param {any} achievements */
  achievements(achievements) {
    const list = node('achievements');
    if (!achievements) return list;
    for (const item of achievements.series ?? []) list.appendChild(this.achievementRow(item, item.unit));
    list.appendChild(tag('div', 'ach-subtitle', '牌型收集（摊牌亮出的最终牌型）'));
    for (const item of achievements.handTypes ?? []) list.appendChild(this.achievementRow(item, '次'));
    return list;
  }

  /** @param {any} item @param {string} unit */
  achievementRow(item, unit) {
    const row = node('ach-row');
    row.title = item.desc || item.name;
    row.appendChild(tag('span', 'ach-name', item.name));
    row.appendChild(
      tag('span', `ach-level${item.level ? ' ach-unlocked' : ''}`, item.levelName || '未解锁'),
    );
    const progress =
      item.next == null ? '已满级' : `${item.value ?? 0} / ${item.next} ${unit}`.trim();
    row.appendChild(tag('span', 'ach-progress', progress));
    return row;
  }

  /** @param {any} luck */
  luck(luck) {
    const wrap = node('luck-lists');
    if (!luck) return wrap;
    wrap.appendChild(this.luckBlock('LuckyHands', luck.lucky));
    wrap.appendChild(this.luckBlock('UnluckyHands', luck.unlucky));
    return wrap;
  }

  /** @param {string} title @param {any[]} [items] */
  luckBlock(title, items) {
    const block = node('luck-block');
    block.appendChild(tag('div', 'luck-title', title));
    if (!items?.length) {
      block.appendChild(tag('div', 'luck-empty', '样本不足，继续打牌'));
      return block;
    }
    for (const item of items) {
      const row = node('luck-row');
      row.appendChild(tag('span', 'luck-kind', item.title));
      const cards = String(item.holeCards ?? '').replace(/(.{2})/g, '$1 ').trim();
      row.appendChild(tag('span', 'luck-hand', `${item.handClass ?? ''}${cards ? ` ${cards}` : ''}`));
      row.appendChild(tag('span', 'luck-detail', this.luckDetail(item)));
      block.appendChild(row);
    }
    return block;
  }

  /** @param {any} item */
  luckDetail(item) {
    if (item.kind === 'runout') {
      const d = Number(item.deviation ?? 0);
      return `实际 ${item.actual} / 期望 ${item.expected}（Δ ${d >= 0 ? '+' : ''}${d}）`;
    }
    const z = Number(item.z ?? 0).toFixed(2);
    if (item.kind === 'winrate') {
      return `实际 ${percent(item.actual, 1)} / 期望 ${percent(item.expected, 1)} · z ${z}（n=${item.n}）`;
    }
    return `实均 ${Number(item.actual).toFixed(2)} / 期望 ${Number(item.expected).toFixed(2)} · z ${z}（n=${item.n}）`;
  }
}
