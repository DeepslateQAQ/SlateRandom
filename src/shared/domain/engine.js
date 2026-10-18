(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DrawCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MODES = ['normal', 'direction', 'time'];
  const RECORD_MODES = MODES.concat('friend');
  const DIRECTIONS = { up: [-1, 0, '上'], right: [0, 1, '右'], down: [1, 0, '下'], left: [0, -1, '左'] };
  const DEFAULTS = { strategy: 'auto', manualMode: 'normal', modes: MODES, cooldown: 3, strength: 1.6, direction: 'auto', directionRounds: 'random', directionMin: 3, directionMax: 5, directionCooldownMin: 3, directionCooldownMax: 5, directionChance: 33, timeChance: 33, friendEnabled: true, friendChance: 20, endJumpEnabled: true, endJumpChance: 30, timeSource: 'time', timeSelection: 'random', positions: '5,6', voice: false, theme: 'system', accent: '#65dc99', radius: 8, customCss: '', customCssEnabled: false, backgroundTint: false, onboardingCompleted: true };
  const clone = value => JSON.parse(JSON.stringify(value));
  const integer = (value, min, max, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(label + '应为 ' + min + '～' + max + ' 的整数');
    return n;
  };
  function seed() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
    return (Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0;
  }
  function random(state) {
    state.rngState = (state.rngState + 0x6D2B79F5) >>> 0;
    let t = state.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function normalizeStudents(input) {
    if (!Array.isArray(input) || !input.length || input.length > 500) throw new Error('名单需要包含 1～500 位学生');
    const ids = new Set(), seats = new Set();
    const normalized = input.map((student, index) => {
      if (!student || typeof student !== 'object') throw new Error('第 ' + (index + 1) + ' 位学生格式无效');
      const rawId = String(student.id == null ? '' : student.id).trim();
      if (!/^\d{1,12}$/.test(rawId) || Number(rawId) < 1) throw new Error('第 ' + (index + 1) + ' 位学生的学号应为 1～12 位正整数');
      const id = String(Number(rawId)), name = String(student.name || '').trim();
      if (!name || name.length > 64 || /[\u0000-\u001F]/.test(name)) throw new Error('学号 ' + id + ' 的姓名为空或格式无效');
      if (ids.has(id)) throw new Error('学号 ' + id + ' 重复；姓名相同可以，学号必须唯一');
      const row = integer(student.row, 1, 50, '学号 ' + id + ' 的行号');
      const col = integer(student.col, 1, 20, '学号 ' + id + ' 的列号');
      const seat = row + ':' + col;
      if (seats.has(seat)) throw new Error('第 ' + row + ' 行第 ' + col + ' 列安排了多个人');
      ids.add(id); seats.add(seat);
      const result = { id, name, row, col, active: student.active !== false };
      if (student.idSource != null) {
        if (!['auto', 'provided'].includes(student.idSource)) throw new Error('学号 ' + id + ' 的学号来源无效');
        result.idSource = student.idSource;
      }
      return result;
    });
    normalized.forEach((student, index) => {
      if (!Object.hasOwn(input[index], 'friendTargets')) return;
      const raw = input[index].friendTargets;
      if (!Array.isArray(raw) || raw.length > normalized.length) throw new Error('学号 ' + student.id + ' 的友尽目标应为学号数组');
      const targets = raw.map(value => {
        if (!['string', 'number'].includes(typeof value) || !/^\d{1,12}$/.test(String(value).trim()) || Number(value) < 1) throw new Error('学号 ' + student.id + ' 的友尽目标学号无效');
        return String(Number(value));
      });
      if (targets.some(id => id === student.id)) throw new Error('学号 ' + student.id + ' 不能将自己设为友尽目标');
      if (new Set(targets).size !== targets.length) throw new Error('学号 ' + student.id + ' 的友尽目标重复');
      if (targets.some(id => !ids.has(id))) throw new Error('学号 ' + student.id + ' 的友尽目标包含名单外学号');
      if (targets.length) student.friendTargets = targets;
    });
    return normalized;
  }
  function settings(input) {
    const s = Object.assign({}, DEFAULTS, input || {});
    s.modes = Array.isArray(s.modes) ? MODES.filter(m => s.modes.includes(m)) : MODES.slice();
    if (!s.modes.length) s.modes = ['normal'];
    s.strategy = s.strategy === 'manual' ? 'manual' : 'auto';
    s.manualMode = MODES.includes(s.manualMode) ? s.manualMode : 'normal';
    // Retired cinema/cinematic values from old sessions and backups become normal.
    s.renderStyle = s.renderStyle === 'overview' ? 'overview' : 'normal';
    s.cooldown = Math.max(1, Math.min(20, Math.round(Number(s.cooldown) || 3)));
    s.strength = Math.max(0.5, Math.min(3, Number(s.strength) || 1.6));
    s.direction = Object.hasOwn(DIRECTIONS, s.direction) ? s.direction : 'auto';
    const hasRange = input && (Object.hasOwn(input, 'directionMin') || Object.hasOwn(input, 'directionMax'));
    const fixed = s.directionRounds === 'random' ? null : Math.max(1, Math.min(50, Math.round(Number(s.directionRounds) || 3)));
    s.directionMin = !hasRange && fixed != null ? fixed : Math.max(1, Math.min(50, Math.round(Number(s.directionMin) || 3)));
    s.directionMax = !hasRange && fixed != null ? fixed : Math.max(s.directionMin, Math.max(1, Math.min(50, Math.round(Number(s.directionMax) || 5))));
    s.directionRounds = 'random';
    s.directionCooldownMin = integer(s.directionCooldownMin, 0, 50, '连坐最少冷却轮数');
    s.directionCooldownMax = integer(s.directionCooldownMax, 0, 50, '连坐最多冷却轮数');
    if (s.directionCooldownMin > s.directionCooldownMax) throw new Error('连坐最少冷却轮数不能大于最多冷却轮数');
    s.directionChance = integer(s.directionChance, 0, 100, '连坐触发概率');
    s.timeChance = integer(s.timeChance, 0, 100, '时间触发概率');
    s.friendEnabled = s.friendEnabled === true;
    s.friendChance = integer(s.friendChance, 0, 100, '友尽触发概率');
    s.endJumpEnabled = s.endJumpEnabled === true;
    s.endJumpChance = integer(s.endJumpChance, 0, 100, '末尾改选概率');
    if (s.directionChance + s.timeChance > 100) throw new Error('连坐与时间触发概率合计不能超过 100%');
    s.timeSource = ['date', 'time', 'datetime'].includes(s.timeSource) ? s.timeSource : 'time';
    s.timeSelection = s.timeSelection === 'fixed' ? 'fixed' : 'random';
    s.positions = typeof s.positions === 'string' ? s.positions.trim() : '5,6';
    s.voice = s.voice === true;
    // Appearance defaults stay in sync with src/renderer/application/appearance.ts
    // (system / #65dc99 / 8px) and the 16384-char CUSTOM_CSS_LIMIT there.
    s.theme = ['classic', 'light', 'dark', 'system'].includes(s.theme) ? s.theme : 'system';
    const accent = String(s.accent == null ? '' : s.accent).trim().toLowerCase();
    s.accent = /^#[0-9a-f]{3}$/.test(accent)
      ? '#' + accent[1] + accent[1] + accent[2] + accent[2] + accent[3] + accent[3]
      : /^#[0-9a-f]{6}$/.test(accent) ? accent : '#65dc99';
    const numericRadius = Number(s.radius);
    // Keep a deliberate 0 radius: only null/blank/non-numeric input falls back to 8.
    s.radius = s.radius == null || s.radius === '' || !Number.isFinite(numericRadius)
      ? 8 : Math.max(0, Math.min(16, Math.round(numericRadius)));
    s.customCss = typeof s.customCss === 'string'
      ? s.customCss.replace(/\u0000/g, '').slice(0, 16384) : '';
    s.customCssEnabled = s.customCssEnabled === true;
    s.backgroundTint = s.backgroundTint === true;
    // Older saves, legacy profiles and backups never stored this flag; they are
    // already configured, so only an explicit false keeps the first-run flow alive.
    s.onboardingCompleted = s.onboardingCompleted !== false;
    return s;
  }
  function createState(students, initialSeed) {
    const list = normalizeStudents(students);
    return { version: 1, className: '演示班级', demo: true, students: list, cols: Math.max(...list.map(s => s.col)), settings: settings(), rngState: initialSeed == null ? seed() : initialSeed >>> 0, counts: {}, lastSeen: {}, fairnessStats: {}, cycleSeen: [], round: 0, lastId: null, lock: null, directionCooldownRemaining: 0, history: [] };
  }
  function createEmptyState(initialSeed) {
    const state = { version: 1, className: '尚未配置名单', demo: false, students: [], cols: 8, settings: settings(), rngState: initialSeed == null ? seed() : initialSeed >>> 0, counts: {}, lastSeen: {}, fairnessStats: {}, cycleSeen: [], round: 0, lastId: null, lock: null, directionCooldownRemaining: 0, history: [] };
    // The only state that starts the first-run flow; every other path uses the
    // already-configured default from settings() or copies the current settings.
    state.settings.onboardingCompleted = false;
    return state;
  }
  function recentIds(state, activeCount) {
    const window = Math.min(state.settings.cooldown, Math.max(0, activeCount - 1));
    if (!window) return new Set();
    const recent = state.history.slice(-window).map(r => r.studentId);
    if (state.lastId && recent[recent.length - 1] !== state.lastId) recent.push(state.lastId);
    return new Set(recent.slice(-window));
  }
  const count = (state, id) => Number(state.counts[id]) || 0;
  const fairness = (state, id) => state.fairnessStats && state.fairnessStats[id] || { draws: count(state, id), positionSum: 0, positionSamples: 0 };
  function probabilities(state) {
    const active = state.students.filter(s => s.active);
    if (!active.length) return [];
    const recent = recentIds(state, active.length);
    let pool = active.filter(s => !recent.has(s.id));
    const seen = new Set(state.cycleSeen || []), unseen = active.filter(s => !seen.has(s.id));
    if (unseen.length) { const cooled = unseen.filter(s => !recent.has(s.id)); pool = cooled.length ? cooled : unseen; }
    const min = Math.min(...active.map(s => count(state, s.id)));
    const balanced = pool.filter(s => count(state, s.id) <= min + 1);
    if (balanced.length) pool = balanced;
    const poolMin = Math.min(...pool.map(s => count(state, s.id)));
    const meanDraws = active.reduce((sum, student) => sum + fairness(state, student.id).draws, 0) / active.length;
    const weights = pool.map(s => {
      const age = state.round - (state.lastSeen[s.id] || 0);
      const recovery = 1 + Math.min(1, Math.max(0, age) / Math.max(1, active.length));
      const stats = fairness(state, s.id);
      // A neutral four-cycle prior smooths order feedback. Centered, bounded lifetime
      // count feedback survives reset without allowing old absences to starve others.
      const meanPosition = (stats.positionSum + 2) / (stats.positionSamples + 4);
      const lifetimeGap = Math.max(-3, Math.min(3, (meanDraws - stats.draws) / Math.sqrt(1 + meanDraws)));
      const lifetimeWeight = Math.exp(state.settings.strength * 0.35 * lifetimeGap);
      const orderWeight = Math.exp(state.settings.strength * 1.2 * (meanPosition - 0.5));
      return { student: s, weight: Math.exp(-state.settings.strength * Math.min(30, count(state, s.id) - poolMin)) * recovery * lifetimeWeight * orderWeight };
    });
    const sum = weights.reduce((total, item) => total + item.weight, 0);
    return weights.map(item => ({ student: item.student, probability: item.weight / sum }));
  }
  function weightedPick(state, distribution) {
    const p = random(state);
    let cumulative = 0;
    for (const item of distribution) { cumulative += item.probability; if (p < cumulative) return item.student; }
    return distribution[distribution.length - 1].student;
  }
  function weightedCandidate(state, candidates, weight) {
    if (candidates.length === 1) return candidates[0];
    const weights = candidates.map(candidate => ({ student: candidate, probability: weight(candidate) }));
    const total = weights.reduce((sum, candidate) => sum + candidate.probability, 0);
    return weightedPick(state, weights.map(candidate => ({ student: candidate.student, probability: candidate.probability / total })));
  }
  function directionRounds(state) {
    // Honor code using the old fixed field; normalized UI and restored settings
    // always use the new inclusive range instead.
    const fixed = state.settings.directionRounds;
    if (fixed != null && fixed !== 'random') return Math.max(1, Math.min(50, Math.round(Number(fixed) || 3)));
    const min = state.settings.directionMin, max = state.settings.directionMax;
    return min === max ? min : min + Math.floor(random(state) * (max - min + 1));
  }
  function startDirectionCooldown(state) {
    const min = state.settings.directionCooldownMin ?? DEFAULTS.directionCooldownMin;
    const max = state.settings.directionCooldownMax ?? DEFAULTS.directionCooldownMax;
    state.directionCooldownRemaining = min === max ? min : min + Math.floor(random(state) * (max - min + 1));
    return state.directionCooldownRemaining;
  }
  function endDirection(state) {
    if (!state.lock) return state.directionCooldownRemaining || 0;
    state.lock = null;
    // An existing cooldown is never restarted, including an inconsistent live
    // state containing both a lock and a cooldown. Restored backups reject it.
    return state.directionCooldownRemaining > 0 ? state.directionCooldownRemaining : startDirectionCooldown(state);
  }
  function adjacent(state, previous, direction) {
    if (!previous || !Object.hasOwn(DIRECTIONS, direction)) return null;
    const [dr, dc] = DIRECTIONS[direction];
    return state.students.find(s => s.active && s.row === previous.row + dr && s.col === previous.col + dc) || null;
  }
  function dateDigits(date, source) {
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) throw new Error('日期或时间无效');
    const pad = n => String(n).padStart(2, '0');
    const day = String(date.getFullYear()).padStart(4, '0') + pad(date.getMonth() + 1) + pad(date.getDate());
    const time = pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
    return source === 'date' ? day : source === 'datetime' ? day + time : time;
  }
  function extractNumber(date, source, positions) {
    const digits = dateDigits(date, source);
    const parts = String(positions).trim().split(/[,，\s]+/);
    if (!parts.length || parts.some(p => !/^\d+$/.test(p))) throw new Error('请填写从 1 开始的取位序号，例如 5,6');
    if (parts.length > 12) throw new Error('最多选取 12 位');
    const indices = parts.map(p => integer(p, 1, digits.length, '取位序号'));
    if (new Set(indices).size !== indices.length) throw new Error('取位序号不能重复');
    const picked = indices.map(p => digits[p - 1]).join('');
    return { digits, positions: indices, picked, number: Number(picked) };
  }
  function timeOptions(state, date, distribution = probabilities(state)) {
    const source = state.settings.timeSource, digits = dateDigits(date, source);
    const eligible = new Map(distribution.map(item => [Number(item.student.id), item.student]));
    const option = (positions, selection) => {
      const rule = extractNumber(date, source, positions), student = eligible.get(rule.number);
      if (!student) return null;
      Object.assign(rule, { source, selection });
      return { rule, student };
    };
    if (state.settings.timeSelection === 'fixed') {
      try { const fixed = option(state.settings.positions, 'fixed'); if (fixed) return [fixed]; } catch (_) { /* Try other positions before changing modes. */ }
    }
    const available = [];
    for (let first = 1; first < digits.length; first++) {
      const candidate = option(first + ',' + (first + 1), 'random');
      if (candidate) {
        if (state.settings.timeSelection === 'fixed') candidate.rule.replacedPositions = state.settings.positions;
        available.push(candidate);
      }
    }
    return available;
  }
  function directionOptions(state, distribution) {
    const seats = new Map(distribution.map(item => [item.student.row + ':' + item.student.col, item.student]));
    const next = (previous, direction) => {
      if (!previous || !Object.hasOwn(DIRECTIONS, direction)) return null;
      const [dr, dc] = DIRECTIONS[direction];
      return seats.get((previous.row + dr) + ':' + (previous.col + dc)) || null;
    };
    const candidates = state.settings.direction === 'auto' ? Object.keys(DIRECTIONS) : [state.settings.direction];
    const directionsFor = previous => candidates.filter(d => next(previous, d));
    const previous = state.students.find(s => s.id === state.lastId && s.active);
    return { previous, directions: previous ? directionsFor(previous) : [], origins: previous ? [] : distribution.filter(item => directionsFor(item.student).length), directionsFor, next };
  }
  function modeChances(state) {
    const direction = !(state.directionCooldownRemaining > 0) && state.settings.modes.includes('direction') ? state.settings.directionChance : 0;
    const time = state.settings.modes.includes('time') ? state.settings.timeChance : 0;
    return { normal: 100 - direction - time, direction, time };
  }
  function friendOptions(state, distribution = probabilities(state)) {
    const source = state.students.find(student => student.active && student.id === state.lastId) || null;
    const targets = new Set(source && source.friendTargets || []);
    const candidates = distribution.filter(item => targets.has(item.student.id) && item.student.id !== source.id).map(item => item.student);
    return { source, candidates };
  }
  function chooseMode(state, date, distribution) {
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) throw new Error('日期或时间无效');
    // This preflight is independent of the ordinary mode percentages and of an
    // existing direction lock. Disabled mode, missing/blocked targets and the
    // 0/100 endpoints consume no probability roll. An absent flag preserves
    // enabled behavior for callers still using old settings directly.
    if (state.settings.friendEnabled !== false) {
      const friend = friendOptions(state, distribution), friendChance = state.settings.friendChance ?? DEFAULTS.friendChance;
      if (friend.source && friend.candidates.length && friendChance > 0 && (friendChance >= 100 || random(state) < friendChance / 100)) return { mode: 'friend', requested: 'friend', friend };
    }
    const chances = modeChances(state), selectMode = modes => weightedCandidate(state, modes, mode => chances[mode]);
    const requested = state.lock ? 'direction' : state.settings.strategy === 'manual' ? state.settings.manualMode : selectMode(MODES.filter(mode => chances[mode] > 0));
    let time, direction;
    const available = mode => {
      if (mode === 'normal') return true;
      if (mode === 'time') {
        if (!time) time = timeOptions(state, date, distribution);
        return time.length > 0;
      }
      if (mode !== 'direction' || state.directionCooldownRemaining > 0) return false;
      if (!direction) direction = directionOptions(state, distribution);
      return !!(direction.directions.length || direction.origins.length);
    };
    let mode = requested;
    if (!available(mode)) {
      const alternatives = state.settings.strategy === 'auto' ? MODES.filter(m => m !== requested && chances[m] > 0 && available(m)) : state.settings.modes.filter(m => m !== requested && available(m));
      mode = alternatives.length ? state.settings.strategy === 'auto' ? selectMode(alternatives) : alternatives[alternatives.length === 1 ? 0 : Math.floor(random(state) * alternatives.length)] : 'normal';
    }
    return { mode, requested, time, direction };
  }
  function previewMode(state, date = new Date()) {
    const distribution = probabilities(state);
    if (!distribution.length) throw new Error('当前没有可参与抽取的学生，请先导入名单或取消暂停');
    return chooseMode(Object.assign({}, state, { rngState: state.rngState }), date, distribution).mode;
  }
  function draw(state, date, options = {}) {
    const distribution = probabilities(state);
    if (!distribution.length) throw new Error('当前没有可参与抽取的学生，请先导入名单或取消暂停');
    const now = date || new Date();
    const before = { rngState: state.rngState, lock: clone(state.lock), lastId: state.lastId, round: state.round, directionCooldownRemaining: state.directionCooldownRemaining || 0 };
    const cycleSeen = state.cycleSeen || [], seen = new Set(cycleSeen);
    if (state.students.filter(s => s.active).every(s => seen.has(s.id))) before.cycleBefore = cycleSeen.slice();
    const plan = chooseMode(state, now, distribution), mode = plan.mode;
    let selected, reason = '', direction = null, timeRule = null, fallback = false;
    if (mode !== 'direction') state.lock = null;
    if (mode === 'direction') {
      const previous = plan.direction.previous;
      const remaining = state.lock ? state.lock.remaining : directionRounds(state);
      if (previous) {
        const valid = plan.direction.directions;
        const chance = new Map(distribution.map(item => [item.student.id, item.probability]));
        direction = weightedCandidate(state, valid, candidate => chance.get(plan.direction.next(previous, candidate).id));
        selected = plan.direction.next(previous, direction);
        reason = '从 ' + previous.name + ' 向' + DIRECTIONS[direction][2] + '，抽取紧邻座位';
      } else {
        const origins = plan.direction.origins, sum = origins.reduce((total, item) => total + item.probability, 0);
        selected = weightedPick(state, origins.map(item => ({ student: item.student, probability: item.probability / sum })));
        const valid = plan.direction.directionsFor(selected);
        const chance = new Map(distribution.map(item => [item.student.id, item.probability]));
        direction = weightedCandidate(state, valid, candidate => chance.get(plan.direction.next(selected, candidate).id));
        reason = remaining > 1 ? '先选取接力起点，接下来' + (state.settings.direction === 'auto' ? '每轮随机方向' : '向' + DIRECTIONS[direction][2]) + '继续 ' + (remaining - 1) + ' 轮' : '选取接力起点，本次单轮连坐已完成';
      }
      state.lock = remaining > 1 ? { direction, remaining: remaining - 1 } : null;
    } else if (mode === 'friend') {
      const chance = new Map(distribution.map(item => [item.student.id, item.probability]));
      selected = weightedCandidate(state, plan.friend.candidates, student => chance.get(student.id));
      reason = plan.friend.source.name + ' 的友尽目标中按公平权重抽取';
    } else if (mode === 'time') {
      const chance = new Map(distribution.map(item => [item.student.id, item.probability])), matches = new Map();
      plan.time.forEach(option => { if (!matches.has(option.student.id)) matches.set(option.student.id, []); matches.get(option.student.id).push(option); });
      const positions = weightedCandidate(state, Array.from(matches.values()), candidates => chance.get(candidates[0].student.id));
      const option = positions.length === 1 ? positions[0] : positions[Math.floor(random(state) * positions.length)];
      selected = option.student; timeRule = option.rule;
      reason = (timeRule.replacedPositions ? '指定取位无可用学号，改选有效连续两位；' : '') + timeRule.digits + ' 的第 ' + timeRule.positions.join('、') + ' 位 → 学号 ' + timeRule.picked;
    }
    if (!selected) selected = weightedPick(state, distribution);
    let endJump = null, animationOrder = null;
    if (options.endJump && state.settings.endJumpEnabled !== false && state.settings.endJumpChance > 0) {
      const chance = new Map(distribution.map(item => [item.student.id, item.probability]));
      let candidates;
      if (mode === 'friend') candidates = plan.friend.candidates;
      else if (mode === 'time') candidates = Array.from(new Map(plan.time.map(option => [option.student.id, option.student])).values());
      else if (mode === 'direction') candidates = plan.direction.previous ? plan.direction.directions.map(d => plan.direction.next(plan.direction.previous, d)) : plan.direction.origins.map(item => item.student);
      else candidates = distribution.map(item => item.student);
      const others = candidates.filter(student => student.id !== selected.id);
      if (others.length && random(state) < state.settings.endJumpChance / 100) {
        endJump = { kind: random(state) < .5 ? 'back' : 'continue', initialStudentId: selected.id, initialDirection: direction, initialTimeRule: clone(timeRule) };
        let target;
        if (mode === 'direction' && plan.direction.previous && endJump.kind === 'back') {
          const axes = ['up', 'right', 'down', 'left'], start = axes.indexOf(direction);
          const prior = [1, 2, 3].map(step => axes[(start - step + 4) % 4]).find(d => plan.direction.directions.includes(d));
          target = plan.direction.next(plan.direction.previous, prior);
        } else if (mode === 'normal' || mode === 'friend' || (mode === 'direction' && !plan.direction.previous)) {
          const order = others.slice();
          for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random(state) * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
          animationOrder = Array.from({ length: 7 }, (_, i) => order[i % order.length].id);
          if (endJump.kind === 'back') target = order[6 % order.length];
        }
        if (!target) target = weightedCandidate(state, others, student => chance.get(student.id));
        // Keep the initial weighted distribution stationary through the extra step.
        // Excluding the initial person otherwise reverses fairness with two candidates.
        const initialWeight = chance.get(selected.id), targetWeight = chance.get(target.id);
        let acceptance;
        if (mode === 'direction' && plan.direction.previous && endJump.kind === 'back') {
          acceptance = Math.min(...candidates.map(student => chance.get(student.id))) / initialWeight;
        } else if (endJump.kind === 'back' && (mode === 'normal' || mode === 'friend' || (mode === 'direction' && !plan.direction.previous))) {
          acceptance = Math.min(1, targetWeight / initialWeight);
        } else {
          const total = candidates.reduce((sum, student) => sum + chance.get(student.id), 0);
          acceptance = Math.min(1, (total - initialWeight) / (total - targetWeight));
        }
        if (acceptance < 1 && random(state) >= acceptance) {
          endJump = null; animationOrder = null;
        } else {
          selected = target;
          if (mode === 'time') {
            const rules = plan.time.filter(option => option.student.id === selected.id);
            const rule = rules.length === 1 ? rules[0].rule : rules[Math.floor(random(state) * rules.length)].rule;
            if (endJump.kind === 'back') endJump.previousTimeRule = clone(rule);
            timeRule = rule; reason = rule.digits + ' 的第 ' + rule.positions.join('、') + ' 位 → 学号 ' + rule.picked;
          } else if (mode === 'direction') {
            direction = plan.direction.previous ? plan.direction.directions.find(d => plan.direction.next(plan.direction.previous, d).id === selected.id) : weightedCandidate(state, plan.direction.directionsFor(selected), d => chance.get(plan.direction.next(selected, d).id));
            if (state.lock) state.lock.direction = direction;
            reason = plan.direction.previous ? '从 ' + plan.direction.previous.name + ' 向' + DIRECTIONS[direction][2] + '，抽取紧邻座位' : '末尾改选新的连坐起点，下一轮重新选择方向';
          }
        }
      }
    }
    if (!reason) reason = distribution.length === 1 && state.students.filter(s => s.active).length === 1 ? '目前只有一位学生参与抽取' : '根据累计抽中次数、历次先后位置与等待轮数动态分配权重，近期抽中过的学生暂时冷却';
    if (endJump) reason += endJump.kind === 'back' ? '；末尾回选前一个有效焦点' : '；末尾继续随机改选';
    if (mode !== plan.requested) reason = (plan.requested === 'time' ? '所有取位均无符合公平规则的学号' : before.directionCooldownRemaining > 0 ? '连坐仍在冷却，还剩 ' + before.directionCooldownRemaining + ' 轮' : '没有符合方向与公平规则的紧邻座位，连坐结束') + '；改用' + ({ normal: '普通随机', direction: '方向抽取', time: '日期／时间抽取' }[mode]) + '。' + reason;
    before.count = count(state, selected.id); before.lastSeen = state.lastSeen[selected.id] || 0;
    if (!state.fairnessStats) state.fairnessStats = {};
    before.fairnessStats = Object.hasOwn(state.fairnessStats, selected.id) ? clone(state.fairnessStats[selected.id]) : null;
    const previousFairness = fairness(state, selected.id), active = state.students.filter(student => student.active);
    const cyclePosition = before.cycleBefore ? 0 : active.filter(student => seen.has(student.id)).length;
    const position = active.length > 1 ? Math.min(cyclePosition, active.length - 1) / (active.length - 1) : 0.5;
    state.fairnessStats[selected.id] = { draws: previousFairness.draws + 1, positionSum: previousFairness.positionSum + position, positionSamples: previousFairness.positionSamples + 1 };
    before.cycleAdded = !!before.cycleBefore || !seen.has(selected.id);
    state.cycleSeen = before.cycleBefore ? [] : cycleSeen.slice();
    if (!state.cycleSeen.includes(selected.id)) state.cycleSeen.push(selected.id);
    state.round += 1; state.counts[selected.id] = before.count + 1; state.lastSeen[selected.id] = state.round; state.lastId = selected.id;
    const endedDirection = !state.lock && (mode === 'direction' || !!before.lock);
    let directionCooldownStarted;
    if (endedDirection && before.directionCooldownRemaining === 0) {
      directionCooldownStarted = startDirectionCooldown(state);
      if (directionCooldownStarted > 0) reason += '；连坐结束，进入 ' + directionCooldownStarted + ' 轮冷却';
    } else state.directionCooldownRemaining = Math.max(0, before.directionCooldownRemaining - 1);
    const record = { round: state.round, studentId: selected.id, name: selected.name, row: selected.row, col: selected.col, mode, direction, fallback, timeRule, reason, time: now.toISOString(), fairnessPosition: position, before };
    if (mode === 'friend') { record.friendSourceId = plan.friend.source.id; record.friendTargetIds = plan.friend.candidates.map(student => student.id); }
    if (directionCooldownStarted != null) record.directionCooldownStarted = directionCooldownStarted;
    if (endJump) { record.endJump = endJump; if (animationOrder) record.animationOrder = animationOrder; }
    if (mode !== plan.requested) record.switchedFrom = plan.requested;
    state.history.push(record);
    if (state.history.length > 2000) state.history.splice(0, state.history.length - 2000);
    return record;
  }
  function undo(state) {
    const record = state.history.pop();
    if (!record) return null;
    const before = record.before;
    if (!before) { state.history.push(record); throw new Error('这条导入记录不支持撤销'); }
    state.rngState = before.rngState; state.lock = clone(before.lock); state.lastId = before.lastId; state.round = before.round; state.directionCooldownRemaining = before.directionCooldownRemaining || 0;
    state.counts[record.studentId] = before.count; state.lastSeen[record.studentId] = before.lastSeen;
    if (Object.hasOwn(before, 'fairnessStats')) {
      if (before.fairnessStats == null) delete state.fairnessStats[record.studentId];
      else state.fairnessStats[record.studentId] = clone(before.fairnessStats);
    }
    if (Array.isArray(before.cycleBefore)) state.cycleSeen = before.cycleBefore.slice();
    else if (before.cycleAdded !== false) state.cycleSeen = (state.cycleSeen || []).filter(id => id !== record.studentId);
    return record;
  }
  function reset(state) { state.history = []; state.counts = {}; state.lastSeen = {}; state.cycleSeen = []; state.round = 0; state.lastId = null; state.lock = null; state.directionCooldownRemaining = 0; }
  function csvRow(line) {
    const fields = []; let field = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (quoted && line[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
      else if (!quoted && /[,，\t]/.test(c)) { fields.push(field.trim()); field = ''; }
      else field += c;
    }
    if (quoted) throw new Error('存在没有闭合的引号');
    fields.push(field.trim()); return fields;
  }
  function fillIds(raw) {
    const reserved = new Set(raw.filter(s => s.id != null && String(s.id).trim()).map(s => String(Number(s.id))));
    let next = 1;
    const generated = new Map();
    raw.map((s, index) => ({ s, index })).sort((a, b) => Number(a.s.row) - Number(b.s.row) || Number(a.s.col) - Number(b.s.col) || a.index - b.index).forEach(({ s, index }) => {
      if (s.id != null && String(s.id).trim()) return;
      while (reserved.has(String(next))) next++;
      const id = String(next++); reserved.add(id); generated.set(index, id);
    });
    return raw.map((s, index) => Object.assign({}, s, generated.has(index) ? { id: generated.get(index), idSource: 'auto' } : { idSource: s.idSource || 'provided' }));
  }
  /** Preserve identity through a roster/ID change, then validate the complete snapshot. */
  function replaceStudents(state, input, identityMap) {
    const students = normalizeStudents(input), next = clone(state), ids = new Set(students.map(s => s.id));
    const mapping = new Map();
    if (identityMap != null) {
      if (!identityMap || typeof identityMap !== 'object' || Array.isArray(identityMap)) throw new Error('名单身份映射格式无效');
      for (const [oldId, newId] of Object.entries(identityMap)) {
        if (!state.students.some(student => student.id === oldId) || typeof newId !== 'string' || !ids.has(newId) || Array.from(mapping.values()).includes(newId)) throw new Error('名单身份映射包含无效或重复学生');
        mapping.set(oldId, newId);
      }
    } else {
      const oldNames = new Map(), newNames = new Map();
      state.students.forEach(student => oldNames.set(student.name, (oldNames.get(student.name) || []).concat(student)));
      students.forEach(student => newNames.set(student.name, (newNames.get(student.name) || []).concat(student)));
      for (const student of students) {
        const old = oldNames.get(student.name);
        if (old?.length === 1 && newNames.get(student.name).length === 1) mapping.set(old[0].id, student.id);
        else {
          const exact = state.students.find(item => item.id === student.id && item.name === student.name && item.idSource !== 'auto');
          if (exact) mapping.set(exact.id, student.id);
        }
      }
    }
    const remap = id => mapping.get(id) || null;
    const remapList = list => Array.from(new Set((list || []).map(remap).filter(Boolean)));
    const remapStats = source => Object.fromEntries(Object.entries(source || {}).filter(([id]) => mapping.has(id)).map(([id, value]) => [mapping.get(id), clone(value)]));
    next.counts = remapStats(state.counts);
    next.lastSeen = remapStats(state.lastSeen);
    next.fairnessStats = remapStats(state.fairnessStats);
    next.cycleSeen = remapList(state.cycleSeen);
    next.lastId = remap(state.lastId);
    if (!next.lastId) next.lock = null;
    const oldForNew = new Map(Array.from(mapping, ([oldId, newId]) => [newId, state.students.find(student => student.id === oldId)]));
    next.students = normalizeStudents(students.map(student => {
      const old = oldForNew.get(student.id);
      return old ? Object.assign({}, student, { friendTargets: remapList(old.friendTargets).filter(id => id !== student.id) }) : student;
    }));
    next.cols = Math.max(1, state.cols || 0, ...students.map(student => student.col));
    if (Object.hasOwn(state, 'seatRows')) next.seatRows = Math.max(state.seatRows, ...students.map(student => student.row));
    next.history = [];
    let undoBoundary = false;
    for (let i = state.history.length - 1; i >= 0; i--) {
      const record = state.history[i], studentId = remap(record.studentId);
      if (!studentId || (record.mode === 'friend' && !remap(record.friendSourceId))) { undoBoundary = true; continue; }
      const copy = clone(record), student = students.find(item => item.id === studentId);
      copy.studentId = studentId; copy.name = student.name; copy.row = student.row; copy.col = student.col;
      if (copy.mode === 'friend') {
        copy.friendSourceId = remap(copy.friendSourceId);
        copy.friendTargetIds = remapList(copy.friendTargetIds).filter(id => id !== copy.friendSourceId);
        if (!copy.friendTargetIds.includes(studentId)) { undoBoundary = true; continue; }
      }
      // A missing round makes every older snapshot unsafe, even if its winner survives.
      if (undoBoundary) copy.before = null;
      else if (copy.before) {
        copy.before.lastId = remap(copy.before.lastId);
        if (!copy.before.lastId) copy.before.lock = null;
        if (copy.before.cycleBefore) copy.before.cycleBefore = remapList(copy.before.cycleBefore);
      }
      if (copy.endJump) {
        const initial = remap(copy.endJump.initialStudentId);
        if (initial) copy.endJump.initialStudentId = initial;
        else { delete copy.endJump; delete copy.animationOrder; }
      }
      if (copy.animationOrder) {
        const order = copy.animationOrder.map(remap);
        if (order.some(id => !id)) delete copy.animationOrder;
        else copy.animationOrder = order;
      }
      next.history.push(copy);
    }
    next.history.reverse();
    return restoreState(next);
  }
  function parseRoster(text, cols) {
    cols = integer(cols || 8, 1, 20, '每行座位数');
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const raw = [];
    lines.forEach((line, index) => {
      let parts = /[,，\t]/.test(line) ? csvRow(line) : /^\d+\s+\S/.test(line) ? line.split(/\s+/) : [line];
      if (index === 0 && /^(学号|id|student.?id)$/i.test(parts[0]) && /^(姓名|name)$/i.test(parts[1] || '')) return;
      const seat = { row: Math.floor(raw.length / cols) + 1, col: raw.length % cols + 1 };
      if (parts.length === 1) raw.push(Object.assign(seat, { name: parts[0] }));
      else if (parts.length === 2) raw.push(Object.assign(seat, { id: parts[0], name: parts[1] }));
      else if (parts.length === 4) raw.push({ id: parts[0], name: parts[1], row: parts[2], col: parts[3] });
      else throw new Error('第 ' + (index + 1) + ' 行格式无效，请使用“姓名”或“学号,姓名”或“学号,姓名,行,列”');
    });
    return normalizeStudents(fillIds(raw));
  }
  function parseVision(text) {
    let source = String(text).trim();
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) source = fenced[1].trim();
    let data;
    try { data = JSON.parse(source); } catch (_) { throw new Error('识别结果不是有效 JSON，请保留完整的对象或数组'); }
    const raw = Array.isArray(data) ? data : data && (data.students || data.seats);
    if (!Array.isArray(raw)) throw new Error('识别结果应包含 students 数组，每人有 id、name、row、col');
    const warnings = Array.isArray(data.uncertain) ? data.uncertain.map(String).slice(0, 50) : [];
    if (raw.some(s => s && (s.id == null || String(s.id).trim() === ''))) warnings.push('部分学号未识别，已自动编号；请在预览中核对。');
    raw.forEach(s => { if (!s) return; if (s.sourceId != null && String(s.sourceId).length > 2) warnings.push(String(s.name || '待核对').slice(0, 64) + '：原学号 ' + String(s.sourceId).slice(0, 40) + ' → 候选 ' + String(s.id || '未确定').slice(0, 12) + '，请核对。'); if (Array.isArray(s.idCandidates) && s.idCandidates.length) warnings.push(String(s.name || '待核对').slice(0, 64) + ' 的可能学号：' + s.idCandidates.slice(0, 10).map(String).join('、') + '。'); });
    const students = normalizeStudents(fillIds(raw));
    const usedRows = Array.from(new Set(students.map(s => s.row))).sort((a, b) => a - b);
    const usedCols = Array.from(new Set(students.map(s => s.col))).sort((a, b) => a - b);
    const sourceRows = !Array.isArray(data) && data.rows != null ? integer(data.rows, usedRows.at(-1), 50, '座位行数') : usedRows.at(-1);
    const sourceCols = !Array.isArray(data) && data.cols != null ? integer(data.cols, usedCols.at(-1), 20, '座位列数') : usedCols.at(-1);
    const rowMap = new Map(usedRows.map((value, i) => [value, i + 1])), colMap = new Map(usedCols.map((value, i) => [value, i + 1]));
    if (sourceRows > usedRows.length || sourceCols > usedCols.length) warnings.push('已移除 ' + (sourceRows - usedRows.length) + ' 个全空行和 ' + (sourceCols - usedCols.length) + ' 个全空列，单个空座保留。');
    if (data.orientation?.normalized === false || data.orientation?.podiumSideInImage === 'unknown') warnings.push('讲台方向未能确定，请核对预览中的前后与左右方向。');
    return { students: students.map(s => Object.assign({}, s, { row: rowMap.get(s.row), col: colMap.get(s.col) })), cols: usedCols.length, warnings };
  }
  function restoreState(input) {
    if (!input || input.version !== 1) throw new Error('备份版本无效');
    if (Array.isArray(input.students) && input.students.length === 0) {
      const empty = createEmptyState(integer(input.rngState, 0, 4294967295, '随机种子'));
      const isEmptyStats = value => value == null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
      if (input.demo === true || integer(input.round, 0, 1000000000, '抽取轮数') !== 0 || input.lastId != null || input.lock != null || !Array.isArray(input.history) || input.history.length || !isEmptyStats(input.counts) || !isEmptyStats(input.lastSeen) || !isEmptyStats(input.fairnessStats) || (input.cycleSeen != null && (!Array.isArray(input.cycleSeen) || input.cycleSeen.length)) || (input.directionCooldownRemaining != null && input.directionCooldownRemaining !== 0)) throw new Error('未配置名单的备份不能包含学生记录、统计或连坐状态');
      if (input.settings && (Object.hasOwn(input.settings, 'directionMin') || Object.hasOwn(input.settings, 'directionMax'))) {
        const min = integer(input.settings.directionMin, 1, 50, '连坐最少轮数'), max = integer(input.settings.directionMax, 1, 50, '连坐最多轮数');
        if (min > max) throw new Error('连坐最少轮数不能大于最多轮数');
      }
      empty.cols = input.cols == null ? 8 : integer(input.cols, 1, 20, '座位列数');
      if (Object.hasOwn(input, 'seatRows')) empty.seatRows = integer(input.seatRows, 1, 50, '座位行数');
      empty.className = String(input.className || '尚未配置名单').slice(0, 40);
      empty.settings = settings(input.settings);
      return empty;
    }
    const state = createState(input.students, integer(input.rngState, 0, 4294967295, '随机种子'));
    state.className = String(input.className || '我的班级').slice(0, 40); state.demo = input.demo === true;
    state.cols = integer(input.cols, Math.max(...state.students.map(s => s.col)), 20, '座位列数');
    if (Object.hasOwn(input, 'seatRows')) state.seatRows = integer(input.seatRows, Math.max(...state.students.map(s => s.row)), 50, '座位行数');
    if (input.settings && (Object.hasOwn(input.settings, 'directionMin') || Object.hasOwn(input.settings, 'directionMax'))) {
      const min = integer(input.settings.directionMin, 1, 50, '连坐最少轮数'), max = integer(input.settings.directionMax, 1, 50, '连坐最多轮数');
      if (min > max) throw new Error('连坐最少轮数不能大于最多轮数');
    }
    state.settings = settings(input.settings); state.round = integer(input.round, 0, 1000000000, '抽取轮数');
    const readStats = obj => { const out = {}; for (const s of state.students) if (obj && obj[s.id] != null) out[s.id] = integer(obj[s.id], 0, 1000000000, '学号 ' + s.id + ' 的统计'); return out; };
    const readFairness = (value, id) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['draws', 'positionSum', 'positionSamples'].includes(key)) || !Number.isInteger(value.draws) || value.draws < 0 || value.draws > 1000000000 || !Number.isInteger(value.positionSamples) || value.positionSamples < 0 || value.positionSamples > value.draws || typeof value.positionSum !== 'number' || !Number.isFinite(value.positionSum) || value.positionSum < 0 || value.positionSum > value.positionSamples) throw new Error('学号 ' + id + ' 的长期公平统计无效');
      return { draws: value.draws, positionSum: value.positionSum, positionSamples: value.positionSamples };
    };
    const readLock = lock => lock && Object.hasOwn(DIRECTIONS, lock.direction) ? { direction: lock.direction, remaining: integer(lock.remaining, 1, 50, '接力剩余轮数') } : null;
    const readDirectionCooldown = (value, label) => {
      if (!Number.isInteger(value)) throw new Error(label + '应为 0～50 的整数');
      return integer(value, 0, 50, label);
    };
    state.counts = readStats(input.counts); state.lastSeen = readStats(input.lastSeen);
    const legacyFairness = !Object.hasOwn(input, 'fairnessStats');
    if (!legacyFairness) {
      if (!input.fairnessStats || typeof input.fairnessStats !== 'object' || Array.isArray(input.fairnessStats)) throw new Error('备份中的长期公平统计格式无效');
      for (const [id, value] of Object.entries(input.fairnessStats)) {
        if (!state.students.some(student => student.id === id)) throw new Error('备份中的长期公平统计包含名单外学号');
        state.fairnessStats[id] = readFairness(value, id);
      }
    }
    const readCycle = ids => { if (!Array.isArray(ids) || ids.length > state.students.length || ids.some(id => typeof id !== 'string' || !state.students.some(s => s.id === id)) || new Set(ids).size !== ids.length) throw new Error('备份中的已抽中状态无效'); return ids.slice(); };
    state.cycleSeen = input.cycleSeen == null ? state.students.filter(s => state.counts[s.id] > 0).map(s => s.id) : readCycle(input.cycleSeen);
    state.lastId = state.students.some(s => s.id === input.lastId) ? input.lastId : null; state.lock = readLock(input.lock);
    state.directionCooldownRemaining = Object.hasOwn(input, 'directionCooldownRemaining') ? readDirectionCooldown(input.directionCooldownRemaining, '连坐剩余冷却轮数') : 0;
    if (state.lock && state.directionCooldownRemaining > 0) throw new Error('备份中的连坐锁定与冷却状态冲突');
    if (!Array.isArray(input.history) || input.history.length > 2000) throw new Error('备份抽取记录格式无效');
    state.history = input.history.map(record => {
      if (!record || !state.students.some(s => s.id === record.studentId) || !RECORD_MODES.includes(record.mode) || Number.isNaN(Date.parse(record.time))) throw new Error('备份中存在无效抽取记录');
      if (record.mode === 'friend') {
        const sourceId = record.friendSourceId, targets = record.friendTargetIds;
        if (typeof sourceId !== 'string' || !state.students.some(student => student.id === sourceId) || !Array.isArray(targets) || !targets.length || targets.length >= state.students.length || targets.some(id => typeof id !== 'string' || id === sourceId || !state.students.some(student => student.id === id)) || new Set(targets).size !== targets.length || !targets.includes(record.studentId)) throw new Error('备份中的友尽来源或目标快照无效');
        if (record.animationOrder != null && (!Array.isArray(record.animationOrder) || record.animationOrder.some(id => !targets.includes(id)))) throw new Error('备份中的友尽动画包含目标外学号');
        if (record.endJump && !targets.includes(record.endJump.initialStudentId)) throw new Error('备份中的友尽改选包含目标外学号');
      } else if (Object.hasOwn(record, 'friendSourceId') || Object.hasOwn(record, 'friendTargetIds')) throw new Error('备份中的友尽记录方式无效');
      if (record.direction != null && (typeof record.direction !== 'string' || !Object.hasOwn(DIRECTIONS, record.direction))) throw new Error('备份中方向记录无效');
      if (record.animationOrder != null && (!Array.isArray(record.animationOrder) || record.animationOrder.length !== 7 || record.animationOrder.some(id => !state.students.some(s => s.id === id)))) throw new Error('备份中的动画聚焦顺序无效');
      if (record.endJump != null) {
        const j = record.endJump;
        if (!j || !['back', 'continue'].includes(j.kind) || !state.students.some(s => s.id === j.initialStudentId) || j.initialStudentId === record.studentId || (j.initialDirection != null && !Object.hasOwn(DIRECTIONS, j.initialDirection))) throw new Error('备份中的末尾改选记录无效');
        for (const t of [j.initialTimeRule, j.previousTimeRule].filter(Boolean)) if (typeof t.digits !== 'string' || !/^(?:\d{6}|\d{8}|\d{14})$/.test(t.digits) || !Array.isArray(t.positions) || !t.positions.length || t.positions.length > 12 || t.positions.some(p => !Number.isInteger(p) || p < 1 || p > t.digits.length) || new Set(t.positions).size !== t.positions.length || t.picked !== t.positions.map(p => t.digits[p - 1]).join('') || t.number !== Number(t.picked)) throw new Error('备份中的末尾时间取位无效');
      }
      if (record.timeRule != null) {
        const t = record.timeRule;
        if (!t || typeof t.digits !== 'string' || !/^(?:\d{6}|\d{8}|\d{14})$/.test(t.digits) || !Array.isArray(t.positions) || !t.positions.length || t.positions.length > 12 || t.positions.some(p => !Number.isInteger(p) || p < 1 || p > t.digits.length) || new Set(t.positions).size !== t.positions.length || t.picked !== t.positions.map(p => t.digits[p - 1]).join('') || t.number !== Number(t.picked)) throw new Error('备份中日期／时间取位记录无效');
        if (t.source != null && (!['time', 'date', 'datetime'].includes(t.source) || t.digits.length !== { time: 6, date: 8, datetime: 14 }[t.source])) throw new Error('备份中日期／时间来源无效');
      }
      const r = Object.assign({}, record, { name: String(record.name || '').slice(0, 64), reason: String(record.reason || '').slice(0, 500), round: integer(record.round, 1, state.round, '记录轮数') });
      if (Object.hasOwn(record, 'directionCooldownStarted')) r.directionCooldownStarted = readDirectionCooldown(record.directionCooldownStarted, '记录中的连坐冷却轮数');
      if (record.fairnessPosition != null && (typeof record.fairnessPosition !== 'number' || !Number.isFinite(record.fairnessPosition) || record.fairnessPosition < 0 || record.fairnessPosition > 1)) throw new Error('备份中的周期先后位置无效');
      if (record.before) {
        r.before = { rngState: integer(record.before.rngState, 0, 4294967295, '历史随机种子'), lock: readLock(record.before.lock), lastId: state.students.some(s => s.id === record.before.lastId) ? record.before.lastId : null, round: integer(record.before.round, 0, state.round, '历史轮数'), count: integer(record.before.count, 0, 1000000000, '历史次数'), lastSeen: integer(record.before.lastSeen, 0, state.round, '历史等待轮数'), directionCooldownRemaining: Object.hasOwn(record.before, 'directionCooldownRemaining') ? readDirectionCooldown(record.before.directionCooldownRemaining, '历史连坐剩余冷却轮数') : 0 };
        if (r.before.lock && r.before.directionCooldownRemaining > 0) throw new Error('备份中的历史连坐锁定与冷却状态冲突');
        if (record.before.cycleAdded != null) r.before.cycleAdded = record.before.cycleAdded === true;
        if (record.before.cycleBefore != null) r.before.cycleBefore = readCycle(record.before.cycleBefore);
        if (Object.hasOwn(record.before, 'fairnessStats')) r.before.fairnessStats = record.before.fairnessStats === null ? null : readFairness(record.before.fairnessStats, record.studentId);
      }
      else r.before = null;
      if (r.mode === 'friend' && r.before && r.before.lastId !== r.friendSourceId) throw new Error('备份中的友尽来源与历史焦点不一致');
      return r;
    });
    if (legacyFairness) {
      const occurrences = {};
      state.history.forEach(record => { occurrences[record.studentId] = (occurrences[record.studentId] || 0) + 1; });
      state.students.forEach(student => {
        const draws = Math.max(count(state, student.id), occurrences[student.id] || 0);
        if (draws) state.fairnessStats[student.id] = { draws, positionSum: 0, positionSamples: 0 };
      });
    }
    // Old records have no order metadata. Reconstruct only their reliable draw
    // totals, so undo does not invent early/late observations during migration.
    const cursor = clone(state.fairnessStats);
    for (let i = state.history.length - 1; i >= 0; i--) {
      const record = state.history[i], current = cursor[record.studentId];
      if (record.before && !Object.hasOwn(record.before, 'fairnessStats')) {
        const draws = Math.max(0, (current ? current.draws : 0) - 1);
        const knownPosition = !legacyFairness && record.fairnessPosition != null && current && current.positionSamples > 0 && current.positionSum >= record.fairnessPosition;
        record.before.fairnessStats = { draws, positionSum: knownPosition ? current.positionSum - record.fairnessPosition : current ? current.positionSum : 0, positionSamples: knownPosition ? current.positionSamples - 1 : current ? current.positionSamples : 0 };
        readFairness(record.before.fairnessStats, record.studentId);
      }
      if (record.before && Object.hasOwn(record.before, 'fairnessStats')) {
        if (record.before.fairnessStats === null) delete cursor[record.studentId];
        else cursor[record.studentId] = clone(record.before.fairnessStats);
      }
    }
    return state;
  }
  return { MODES, RECORD_MODES, DIRECTIONS, DEFAULTS, clone, createState, createEmptyState, settings, modeChances, random, normalizeStudents, replaceStudents, probabilities, adjacent, dateDigits, extractNumber, timeOptions, friendOptions, previewMode, draw, undo, reset, endDirection, parseRoster, parseVision, restoreState };
});
