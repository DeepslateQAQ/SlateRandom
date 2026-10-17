/** Scene behavior extracted without changing its draw or animation algorithms. */
import C from "../domain/engine";

export function createStage(context) {
  let seatStructure = '', seatNodes = new Map();
  function setStyle(element, name, value) {
      const next = String(value);
      if (element.style.getPropertyValue(name) !== next) element.style.setProperty(name, next);
  }
  function emptyBoard() {
      const screen = document.querySelector('.draw-screen'), grid = context.$('liveSeats'), map = context.$('liveSeatMap'), scroll = context.$('liveSeatScroll');
      screen.classList.add('has-no-roster');
      screen.classList.remove('is-following');
      grid.innerHTML = '';
      seatStructure = '';
      seatNodes.clear();
      grid.style.setProperty('--cols', '1');
      grid.style.removeProperty('--live-row-height');
      grid.style.removeProperty('grid-auto-rows');
      map.style.setProperty('--cols', '1');
      map.style.setProperty('--rows', '1');
      map.style.width = '100%';
      map.style.transform = 'translate(0px,0px) scale(1)';
      map.hidden = true;
      context.followCamera = false;
      context.cameraTarget = null;
      context.cameraAnchor = null;
      context.cameraScale = 1;
      context.friendCameraGroup = null;
      delete scroll.dataset.focusStudent;
      delete scroll.dataset.focusGroup;
      scroll.dataset.layout = 'empty';
      scroll.dataset.cameraCenterX = scroll.clientWidth / 2;
      scroll.dataset.cameraCenterY = scroll.clientHeight / 2;
      scroll.dataset.safeTop = '0';
      scroll.dataset.safeBottom = String(scroll.clientHeight);
      context.$('seatArrow').setAttribute('hidden', '');
      context.$('seatArrow').classList.remove('spinning-arrow');
      context.$('seatArrowPath').removeAttribute('d');
      context.$('drawVisual').hidden = true;
      let notice = context.$('liveBoardEmptyNotice');
      if (!notice) {
          notice = document.createElement('div');
          notice.id = 'liveBoardEmptyNotice';
          notice.className = 'live-board-empty-notice';
          notice.setAttribute('role', 'status');
          notice.innerHTML = '<strong>名单不可用</strong><p>点击抽人按钮，先导入同学名单或座位表。</p>';
          context.$('liveBoard').append(notice);
      }
      notice.hidden = false;
  }

  function renderStage() {
      const r = context.state.history[context.state.history.length - 1];
      if (!r)
          context.resultVisible = false;
      const visible = context.resultVisible && !!r;
      document.querySelector('.draw-screen').classList.toggle('has-result', visible || context.isOverview());
      context.$('liveBoard').hidden = !visible && !context.isOverview();
      context.$('drawStage').hidden = !visible;
      context.$('stageName').textContent = visible ? r.name : '';
      context.$('stageName').className = 'stage-name' + (visible && r.name.length > 6 ? ' long-name' : '');
      context.$('stageId').textContent = visible ? context.displayId(r.studentId) + ' 号' : '';
      context.$('resultReason').textContent = r ? r.reason : context.state.students.length ? '短按首页按钮开始抽取。' : '尚未配置名单，请先导入同学名单或座位表。';
      context.$('stageMode').textContent = r ? context.MODE_NAMES[r.mode] + (r.fallback ? ' · 均衡接续' : '') : context.state.settings.strategy === 'auto' ? context.state.settings.modes.length + ' 种模式混合' : context.MODE_NAMES[context.state.settings.manualMode];
      renderVisual(r, false);
      if (visible || context.isOverview())
          requestAnimationFrame(() => syncLiveLayout());
  }

  function renderSeats(clearCycle = false) {
      if (!context.state.students.length) {
          emptyBoard();
          context.$('seatCountLabel').textContent = '尚未配置名单';
          window.FriendSeatConfig.sync();
          return;
      }
      document.querySelector('.draw-screen').classList.remove('has-no-roster');
      context.$('liveSeatMap').hidden = false;
      const emptyNotice = context.$('liveBoardEmptyNotice');
      if (emptyNotice) emptyNotice.hidden = true;
      const map = new Map(context.state.students.map(s => [s.row + ':' + s.col, s]));
      const rows = Math.max(context.state.seatRows || 0, ...context.state.students.map(s => s.row)), cols = Math.max(context.state.cols, ...context.state.students.map(s => s.col));
      const pending = context.busy && context.drawCommitted && !context.settling;
      const shown = context.state.history[context.state.history.length - (pending ? 2 : 1)];
      const currentId = clearCycle ? null : shown?.studentId, pendingId = pending ? context.state.lastId : null;
      const slots = [];
      for (let row = 1; row <= rows; row++)
          for (let col = 1; col <= cols; col++) slots.push(map.get(row + ':' + col));
      const grid = context.$('liveSeats');
      const structure = rows + ':' + cols + ':' + slots.map(student => student?.id || '').join(',');
      // A draw changes seat state, not the seat topology. Keep existing nodes
      // and measured layout until a roster moves or its dimensions change.
      if (structure !== seatStructure || grid.children.length !== slots.length) {
          grid.innerHTML = slots.map(student => student
              ? '<div class="live-seat" data-live-student="' + student.id + '"><span class="seat-name"></span><span class="seat-id"></span></div>'
              : '<div class="live-seat empty" aria-label="空座"></div>').join('');
          seatNodes = new Map();
          slots.forEach((student, index) => {
              if (!student) return;
              const seat = grid.children[index];
              seatNodes.set(student.id, { seat, name: seat.querySelector('.seat-name'), number: seat.querySelector('.seat-id') });
          });
          seatStructure = structure;
      }
      const seenIds = new Set(clearCycle ? [] : context.state.cycleSeen);
      for (const s of context.state.students) {
          const node = seatNodes.get(s.id);
          if (!node) continue;
          const seen = seenIds.has(s.id) && !(pendingId === s.id && context.state.history.at(-1)?.before?.cycleAdded);
          const cls = !s.active ? ' paused' : currentId === s.id ? ' current' : seen ? ' seen' : '';
          const className = 'live-seat' + cls;
          // Restore the complete class list: replacing the old subtree used to
          // discard candidate, anchor, neighborhood, friend and lifecycle marks.
          if (node.seat.className !== className) node.seat.className = className;
          const title = s.name + ' · ' + context.displayId(s.id) + ' 号';
          const aria = s.name + '，学号 ' + s.id + (currentId === s.id ? '，当前抽中' : seen ? '，已抽到' : '');
          if (node.seat.title !== title) node.seat.title = title;
          if (node.seat.getAttribute('aria-label') !== aria) node.seat.setAttribute('aria-label', aria);
          if (node.name.textContent !== s.name) node.name.textContent = s.name;
          const number = context.displayId(s.id);
          if (node.number.textContent !== number) node.number.textContent = number;
      }
      setStyle(grid, '--cols', cols);
      setStyle(context.$('liveSeatMap'), '--cols', cols);
      setStyle(context.$('liveSeatMap'), '--rows', rows);
      if (!context.busy && context.resultVisible)
          requestAnimationFrame(renderSeatArrow);
      context.$('seatCountLabel').textContent = context.state.students.length + ' 位同学';
      window.FriendSeatConfig.sync();
  }

  function scrollCurrentSeat() {
      if (context.followCamera)
          return;
      const seat = context.$('liveSeats').querySelector('.current');
      if (!seat)
          return;
      const scroll = context.$('liveSeatScroll'), viewport = scroll.getBoundingClientRect(), boxes = [seat.getBoundingClientRect()];
      const r = context.state.history.at(-1);
      if (r?.mode === 'direction' && !r.fallback && r.before?.lastId) {
          const previous = context.$('liveSeats').querySelector('[data-live-student="' + r.before.lastId + '"]');
          if (previous)
              boxes.push(previous.getBoundingClientRect());
      }
      const left = Math.min(...boxes.map(b => b.left)) - 8, right = Math.max(...boxes.map(b => b.right)) + 8;
      const top = Math.min(...boxes.map(b => b.top)) - 8, bottom = Math.max(...boxes.map(b => b.bottom)) + 8;
      const dx = right > viewport.right ? right - viewport.right : left < viewport.left ? left - viewport.left : 0;
      const dy = bottom > viewport.bottom ? bottom - viewport.bottom : top < viewport.top ? top - viewport.top : 0;
      scroll.scrollTo({ left: scroll.scrollLeft + dx, top: scroll.scrollTop + dy, behavior: 'instant' });
  }

  function fitLiveSeats(force = false) {
      if (!context.state.students.length) { emptyBoard(); return; }
      const scroll = context.$('liveSeatScroll');
      if (!context.hasSeatBoard() || (context.sceneActive && !force) || scroll.clientHeight < 1)
          return;
      const screen = document.querySelector('.draw-screen'), grid = context.$('liveSeats');
      const rows = Math.max(context.state.seatRows || 0, ...context.state.students.map(s => s.row)), cols = Math.max(context.state.cols, ...context.state.students.map(s => s.col));
      const css = getComputedStyle(screen), value = name => parseFloat(css.getPropertyValue(name)) || 0;
      const paddingX = value('--seat-padding') * 2, paddingY = paddingX;
      // The world may extend behind the overlays. Keep focus decisions based on
      // the unobscured region, rather than reserving empty space below the grid.
      const available = Math.max(1, scroll.clientHeight - paddingY - 2), availableWidth = Math.max(1, Math.min(1180, scroll.clientWidth - paddingX - 2));
      const gap = innerWidth < 360 ? 5 : innerWidth <= 700 ? 6 : 8;
      const fitHeight = (available - gap * (rows - 1)) / rows, fitWidth = (availableWidth - gap * (cols - 1)) / cols;
      const safe = context.cameraSafeArea(true), safeHeight = 2 * Math.max(1, Math.min(safe.centerY - safe.top, safe.bottom - safe.centerY));
      const overviewHeight = ((context.isOverview() ? scroll.clientHeight - 78 - (innerWidth <= 600 ? 132 : 80) : safeHeight) - gap * (rows - 1)) / rows;
      context.followCamera = !context.isOverview() && (overviewHeight < 48 || fitWidth < 56);
      screen.classList.toggle('is-following', context.followCamera);
      scroll.dataset.layout = context.followCamera ? 'follow' : 'overview';
      const height = Math.max(48, Math.min(104, context.followCamera ? fitHeight : Math.min(fitHeight, overviewHeight)));
      setStyle(context.$('liveSeatMap'), 'width', Math.max(availableWidth, cols * 56 + gap * (cols - 1)) + 'px');
      setStyle(grid, 'column-gap', gap + 'px');
      setStyle(grid, 'row-gap', gap + 'px');
      setStyle(grid, 'grid-auto-rows', height + 'px');
      setStyle(grid, '--live-row-height', height + 'px');
  }

  function syncLiveLayout(force = false) {
      if (!context.state.students.length) { emptyBoard(); return; }
      if (!context.hasSeatBoard())
          return;
      fitLiveSeats(force);
      const scroll = context.$('liveSeatScroll'), map = context.$('liveSeatMap');
      if (context.isOverview()) {
          context.cameraOverview();
          if (!context.$('seatArrow').classList.contains('spinning-arrow'))
              renderSeatArrow();
          return;
      }
      if (context.sceneActive) {
          if (context.friendCameraGroup?.length)
              context.cameraFitFriendGroup(context.friendCameraGroup);
          else if (context.cameraTarget)
              context.cameraTo(context.cameraTarget, context.$('seatArrow').classList.contains('spinning-arrow') ? context.directionZoom(context.cameraTarget) : context.cameraScale, context.cameraAnchor);
          return;
      }
      if (context.followCamera) {
          scroll.scrollTo(0, 0);
          const record = context.state.history.at(-1), current = context.state.students.find(s => s.id === record?.studentId);
          const previous = record?.mode === 'direction' && record.direction && context.state.students.find(s => s.id === record.before?.lastId && s.active);
          if (current)
              context.cameraTo(current, 1, previous || null);
      }
      else {
          context.cameraTarget = null;
          context.cameraAnchor = null;
          context.cameraScale = 1;
          delete scroll.dataset.focusStudent;
          map.style.transform = 'translate(0px,0px) scale(1)';
          scrollCurrentSeat();
      }
      renderSeatArrow();
  }

  function renderSeatArrow() {
      const r = context.state.history.at(-1), svg = context.$('seatArrow');
      svg.setAttribute('hidden', '');
      if ((context.busy && !context.settling) || !context.resultVisible || r?.mode !== 'direction' || r.fallback || !r.direction || !r.before?.lastId)
          return;
      const previous = context.state.students.find(s => s.id === r.before.lastId), current = context.state.students.find(s => s.id === r.studentId);
      if (!previous?.active || !current || Math.abs(previous.row - current.row) + Math.abs(previous.col - current.col) !== 1)
          return;
      const from = context.$('liveSeats').querySelector('[data-live-student="' + previous.id + '"]'), to = context.$('liveSeats').querySelector('[data-live-student="' + current.id + '"]');
      if (!from || !to)
          return;
      const dx = Math.sign(to.offsetLeft - from.offsetLeft), dy = Math.sign(to.offsetTop - from.offsetTop);
      const x1 = from.offsetLeft + from.offsetWidth / 2 + dx * (from.offsetWidth / 2 - 2), y1 = from.offsetTop + from.offsetHeight / 2 + dy * (from.offsetHeight / 2 - 2);
      const x2 = to.offsetLeft + to.offsetWidth / 2 - dx * (to.offsetWidth / 2 + 2), y2 = to.offsetTop + to.offsetHeight / 2 - dy * (to.offsetHeight / 2 + 2);
      svg.setAttribute('viewBox', '0 0 ' + context.$('liveSeatMap').offsetWidth + ' ' + context.$('liveSeatMap').offsetHeight);
      context.$('seatArrowPath').setAttribute('d', 'M' + x1 + ' ' + y1 + 'L' + x2 + ' ' + y2);
      svg.removeAttribute('hidden');
  }

  function renderVisual(record, animating) {
      const direction = record?.mode === 'direction', time = record?.mode === 'time' && !!record.timeRule;
      context.$('drawVisual').hidden = !context.resultVisible || (!direction && !(time && animating));
      context.$('directionVisual').hidden = !direction;
      context.$('timeVisual').hidden = !time || !animating;
      context.$('chainRemaining').hidden = context.$('directionRemainder').hidden = !direction || !context.state.lock;
      if (direction && context.state.lock)
          context.$('chainRemaining').textContent = context.state.lock.remaining;
      if (direction) {
          const spinner = context.$('directionSpinner');
          spinner.classList.toggle('spinning', animating);
          spinner.style.removeProperty('animation');
          spinner.style.removeProperty('transform');
          spinner.style.setProperty('--angle', ({ up: 0, right: 90, down: 180, left: 270 }[record.direction] || 0) + 'deg');
          context.$('directionCaptionText').textContent = animating ? '正在选取方向…' : record.fallback ? '连坐结束 · 均衡随机' : !C.DIRECTIONS[record.direction] ? '无可用方向 · 本轮结束' : '向' + C.DIRECTIONS[record.direction][2] + '连坐' + (context.state.lock ? '' : ' · 本轮结束');
      }
      if (time) {
          if (animating)
              context.$('timeVisual').className = 'time-visual';
          context.$('timeMatchName').textContent = record.name;
          const rule = record.timeRule, source = rule.source || context.state.settings.timeSource;
          context.$('timeDigits').style.setProperty('--picked-count', rule.positions.length);
          context.$('timeDigits').innerHTML = rule.digits.split('').map((digit, i) => {
              const split = source === 'time' ? [2, 4].includes(i) : source === 'date' ? [4, 6].includes(i) : [4, 6, 8, 10, 12].includes(i);
              const delimiter = source === 'time' || (source === 'datetime' && i > 8) ? ':' : i === 8 ? ' ' : '/';
              return (split ? '<i aria-hidden="true">' + delimiter + '</i>' : '') + '<span data-time-position="' + (i + 1) + '" class="time-digit' + (!animating && rule.positions.includes(i + 1) ? ' chosen' : '') + '">' + digit + '</span>';
          }).join('');
          context.$('timeCaption').textContent = animating ? '正在选取' + (rule.selection === 'fixed' ? '指定数字' : '连续两位') + '…' : '第 ' + rule.positions.join('、') + ' 位 → ' + rule.picked + (record.fallback ? ' · 无可用对应学号，均衡接续' : ' 号');
      }
      manageDirectionNotice(record, animating);
  }

  function clearDirectionNotice() {
      clearTimeout(context.directionNoticeTimer);
      clearTimeout(context.directionNoticeHideTimer);
      context.directionNotice = null;
      context.$('directionVisual').classList.remove('is-notice-fading');
  }

  function manageDirectionNotice(record, animating) {
      if (record?.mode !== 'direction' || context.state.lock || context.busy || animating) {
          clearDirectionNotice();
          return;
      }
      const key = record.round + ':' + record.studentId + ':' + record.time;
      if (context.directionNotice?.key === key) {
          if (context.directionNotice.phase === 'hidden') {
              context.$('directionVisual').hidden = true;
              context.$('drawVisual').hidden = true;
          }
          return;
      }
      clearDirectionNotice();
      context.directionNotice = { key, phase: 'waiting' };
      context.directionNoticeTimer = setTimeout(() => {
          if (context.directionNotice?.key !== key || context.busy)
              return;
          context.directionNotice.phase = 'fading';
          context.$('directionVisual').classList.add('is-notice-fading');
          context.directionNoticeHideTimer = setTimeout(() => {
              if (context.directionNotice?.key !== key || context.busy)
                  return;
              context.directionNotice.phase = 'hidden';
              context.$('directionVisual').hidden = true;
              context.$('drawVisual').hidden = true;
          }, 600);
      }, 3000);
  }

  function highlightTime(positions) {
      context.$$('#timeDigits [data-time-position]').forEach(el => el.classList.toggle('chosen', positions.includes(Number(el.dataset.timePosition))));
  }

  return { renderStage, renderSeats, scrollCurrentSeat, fitLiveSeats, syncLiveLayout, renderSeatArrow, renderVisual, clearDirectionNotice, manageDirectionNotice, highlightTime };
}
