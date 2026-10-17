/** Scene behavior extracted without changing its draw or animation algorithms. */
import C from "../domain/engine";

export function createDrawSequence(context) {
  function shuffleVisual(students) {
      const list = students.slice();
      for (let i = list.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [list[i], list[j]] = [list[j], list[i]];
      }
      // Avoid an accidentally linear presentation of a tiny roster.
      if (list.length > 2 && list.every((s, i) => s.id === students[i].id))
          [list[0], list[2]] = [list[2], list[0]];
      return list;
  }

  function liveSeat(id) { return context.$('liveSeats').querySelector('[data-live-student="' + id + '"]'); }

  function candidatePause(ms) { return context.delay(ms); }

  async function animateNormal(pool, record, extraJump, follow = true) {
      let order = record.animationOrder ? record.animationOrder.map(id => context.state.students.find(s => s.id === id)) : shuffleVisual(pool), lastId = null;
      const times = [100, 130, 160, 200, 240, 300, 350];
      for (let i = 0; i < times.length; i++) {
          if (!follow && !document.querySelector('.draw-screen').classList.contains('is-friend'))
              return;
          if (!record.animationOrder && i && i % order.length === 0) {
              order = shuffleVisual(pool);
              if (order.length > 1 && order[0].id === lastId)
                  [order[0], order[1]] = [order[1], order[0]];
          }
          const student = order[i % order.length];
          await context.showVisualCandidate(student, follow);
          lastId = student.id;
          await candidatePause(times[i]);
      }
      if (extraJump) {
          if (!follow && !document.querySelector('.draw-screen').classList.contains('is-friend'))
              return;
          await context.showVisualCandidate(context.state.students.find(s => s.id === record.endJump.initialStudentId), follow);
          await candidatePause(280);
          if (!follow && !document.querySelector('.draw-screen').classList.contains('is-friend'))
              return;
          context.$('drawStage').classList.add('last-jump');
          await context.showVisualCandidate(context.state.students.find(s => s.id === record.studentId), follow);
          await candidatePause(350);
          context.$('drawStage').classList.remove('last-jump');
      }
      if (!follow && !document.querySelector('.draw-screen').classList.contains('is-friend'))
          return;
      await context.showVisualCandidate(context.state.students.find(s => s.id === record.studentId), follow);
      await candidatePause(220);
  }

  async function animateDirection(previous, record, extraJump) {
      const anchor = liveSeat(previous.id), map = context.$('liveSeatMap'), scroll = context.$('liveSeatScroll');
      if (!anchor)
          return;
      const seats = new Map(context.state.students.map(s => [s.row + ':' + s.col, s]));
      context.state.students.forEach(s => {
          const cell = liveSeat(s.id);
          cell?.classList.toggle('in-neighborhood', Math.abs(s.row - previous.row) <= 1 && Math.abs(s.col - previous.col) <= 1);
      });
      anchor.classList.add('anchor');
      const zoom = context.directionZoom(previous);
      context.cameraTo(previous, zoom);
      const svg = context.$('seatArrow'), path = context.$('seatArrowPath'), spinner = context.$('directionSpinner');
      svg.classList.add('spinning-arrow');
      svg.removeAttribute('hidden');
      spinner.style.animation = 'none';
      const axes = ['up', 'right', 'down', 'left'], target = axes.indexOf(record.endJump?.initialDirection || record.direction) * 90;
      const neighbors = [[-1, 0, '上'], [-1, 1, '右上'], [0, 1, '右'], [1, 1, '右下'], [1, 0, '下'], [1, -1, '左下'], [0, -1, '左'], [-1, -1, '左上']];
      let lastDirection = null;
      // Rotation changes SVG coordinates, not the underlying grid geometry.
      // Measure once per layout revision, before any frame's DOM writes.
      let geometry = null, geometryDirty = true;
      const invalidateGeometry = () => { geometryDirty = true; };
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(invalidateGeometry) : null;
      observer?.observe(map); observer?.observe(context.$('liveSeats'));
      window.addEventListener('resize', invalidateGeometry);
      window.visualViewport?.addEventListener('resize', invalidateGeometry);
      const measureGeometry = () => {
          const layout = getComputedStyle(context.$('liveSeats'));
          const width = anchor.offsetWidth, height = anchor.offsetHeight;
          geometry = { gx: parseFloat(layout.columnGap) || 0, gy: parseFloat(layout.rowGap) || 0,
              width, height, cx: anchor.offsetLeft + width / 2, cy: anchor.offsetTop + height / 2,
              mapWidth: map.offsetWidth, mapHeight: map.offsetHeight };
          geometryDirty = false;
          svg.setAttribute('viewBox', '0 0 ' + geometry.mapWidth + ' ' + geometry.mapHeight);
      };
      const pointAt = angle => {
          if (geometryDirty) measureGeometry();
          const { gx, gy, width, height, cx, cy } = geometry;
          const a = angle * Math.PI / 180, magnitude = Math.max(Math.abs(Math.sin(a)), Math.abs(Math.cos(a)));
          const dx = Math.sin(a) / magnitude, dy = -Math.cos(a) / magnitude;
          const x1 = cx + dx * (width / 2 - 2), y1 = cy + dy * (height / 2 - 2);
          const x2 = cx + dx * (width / 2 + gx - 2), y2 = cy + dy * (height / 2 + gy - 2);
          path.setAttribute('d', 'M' + x1.toFixed(3) + ' ' + y1.toFixed(3) + 'L' + x2.toFixed(3) + ' ' + y2.toFixed(3));
          spinner.style.transform = 'rotate(' + angle + 'deg)';
          const direction = Math.round(angle / 45) % 8;
          if (direction !== lastDirection) {
              lastDirection = direction;
              const [dr, dc, name] = neighbors[direction], student = seats.get((previous.row + dr) + ':' + (previous.col + dc));
              const seen = student && context.state.cycleSeen.includes(student.id) && student.id !== record.studentId;
              context.showVisualCandidate(student?.active && !seen ? student : null, false);
              context.$('directionCaptionText').textContent = '向' + name + ' · ' + (student ? student.name + (!student.active ? '（暂停）' : seen ? '（已抽过）' : '') : '空座／边界');
          }
      };
      try {
      await new Promise(resolve => {
          const started = performance.now(), duration = context.motionDuration(1900);
          let frame, finished = false;
          const complete = () => { if (finished)
              return; finished = true; cancelAnimationFrame(frame); clearTimeout(deadline); pointAt(720 + target); resolve(); };
          const tick = now => {
              const t = Math.min(1, (now - started) / duration);
              pointAt((720 + target) * (1 - Math.pow(1 - t, 3)));
              if (t >= 1)
                  complete();
              else
                  frame = requestAnimationFrame(tick);
          };
          const deadline = setTimeout(complete, duration + 100);
          frame = requestAnimationFrame(tick);
      });
      if (extraJump) {
          context.$('drawStage').classList.add('last-jump');
          const destination = axes.indexOf(record.direction) * 90;
          const delta = record.endJump.kind === 'back' ? -((target - destination + 360) % 360) : (destination - target + 360) % 360;
          await new Promise(resolve => { const started = performance.now(), duration = context.motionDuration(380), tick = now => { const t = Math.min(1, (now - started) / duration); pointAt(720 + target + delta * (1 - Math.pow(1 - t, 3))); if (t < 1)
              requestAnimationFrame(tick);
          else
              resolve(); }; requestAnimationFrame(tick); });
          context.$('drawStage').classList.remove('last-jump');
      }
      } finally {
          observer?.disconnect();
          window.removeEventListener('resize', invalidateGeometry);
          window.visualViewport?.removeEventListener('resize', invalidateGeometry);
      }
      svg.classList.remove('spinning-arrow');
      spinner.classList.remove('spinning');
      context.showVisualCandidate(context.state.students.find(s => s.id === record.studentId), false);
      const winner = context.state.students.find(s => s.id === record.studentId);
      context.cameraTo(winner, context.directionZoom(previous), previous);
      context.$('directionCaptionText').textContent = '向' + C.DIRECTIONS[record.direction][2] + ' · ' + record.name;
      await context.delay(240);
  }

  async function scanLiveTime(extraJump) {
      let lastPositions = '', holdTeaser = false, lastCameraId = null, lastPickedCount = null;
      let eligibilityRevision = [], distribution = [], cachedDigits = null, options = [];
      const digitNodes = context.$$('#timeDigits [data-time-position]');
      const caption = context.$('timeCaption'), digitsElement = context.$('timeDigits');
      const captionText = value => { if (caption.textContent !== value) caption.textContent = value; };
      const tick = (advance = true) => {
          const state = context.state, settings = state.settings;
          const now = new Date(), digits = C.dateDigits(now, settings.timeSource);
          // Commands replace these collections or advance the round when
          // eligibility changes. Clock ticks alone must not recalculate the
          // fairness pool, restart the camera or invalidate unchanged glyphs.
          const revision = [state, state.students, state.round, state.lastId,
              state.counts, state.lastSeen, state.fairnessStats, state.cycleSeen,
              state.history, settings, settings.cooldown, settings.strength,
              settings.timeSource, settings.timeSelection, settings.positions];
          const eligibilityChanged = revision.some((value, i) => value !== eligibilityRevision[i]);
          if (eligibilityChanged) {
              eligibilityRevision = revision;
              distribution = C.probabilities(state);
          }
          const digitsChanged = digits !== cachedDigits;
          if (digitsChanged) {
              for (const el of digitNodes) {
                  const digit = digits[Number(el.dataset.timePosition) - 1];
                  if (el.textContent !== digit) el.textContent = digit;
              }
          }
          if (eligibilityChanged || digitsChanged) {
              options = C.timeOptions(state, now, distribution);
              cachedDigits = digits;
          } else if (!advance) return;
          const fresh = options.filter(option => option.rule.positions.join(',') !== lastPositions);
          const held = (holdTeaser || !advance) && options.find(option => option.rule.positions.join(',') === lastPositions);
          const choices = held ? [held] : fresh.length ? fresh : options;
          if (!choices.length) {
              if (lastPositions) context.highlightTime([]);
              lastPositions = '';
              lastCameraId = null;
              captionText('当前时刻无可用取位，准备切换模式…');
              return;
          }
          const { rule, student } = choices[Math.floor(Math.random() * choices.length)];
          const positions = rule.positions.join(',');
          if (positions !== lastPositions) {
              context.highlightTime(rule.positions);
              lastPositions = positions;
          }
          if (context.followCamera && student.id !== lastCameraId) {
              context.cameraTo(student, 1);
              lastCameraId = student.id;
          }
          if (rule.positions.length !== lastPickedCount) {
              digitsElement.style.setProperty('--picked-count', rule.positions.length);
              lastPickedCount = rule.positions.length;
          }
          captionText((rule.replacedPositions ? '指定取位不可用 · ' : '') + '正在选取' + (rule.selection === 'fixed' ? '指定数字' : '有效连续两位') + '…');
      };
      tick();
      // The scan decelerates independently of the real clock. Clock refreshes
      // also replace a selected position immediately if it becomes invalid.
      const began = performance.now();
      let scan;
      const scheduleScan = () => {
          const progress = Math.min(1, (performance.now() - began) / context.motionDuration(1500));
          scan = setTimeout(() => { tick(); scheduleScan(); }, context.motionDuration(60 + 220 * progress * progress));
      };
      scheduleScan();
      const clock = setInterval(() => tick(false), 110);
      try {
          await context.delay(1500);
          if (extraJump && C.timeOptions(context.state, new Date()).length > 1) {
              context.$('drawStage').classList.add('last-jump');
              tick();
              holdTeaser = true;
              await context.delay(400);
          }
      }
      finally {
          clearTimeout(scan);
          clearInterval(clock);
          context.$('drawStage').classList.remove('last-jump');
      }
  }

  async function animateTime(record) {
      const rule = record.timeRule, visual = context.$('timeVisual');
      if (context.followCamera)
          context.cameraTo(context.state.students.find(s => s.id === record.studentId), 1);
      if (record.endJump) {
          if (record.endJump.previousTimeRule) {
              context.highlightTime(record.endJump.previousTimeRule.positions);
              await context.delay(160);
          }
          context.highlightTime(record.endJump.initialTimeRule.positions);
          context.$('timeCaption').textContent = '选中 ' + record.endJump.initialTimeRule.picked + ' 号…';
          await context.delay(280);
          context.$('drawStage').classList.add('last-jump');
          context.highlightTime(rule.positions);
          await context.delay(240);
          context.$('drawStage').classList.remove('last-jump');
      }
      context.highlightTime(rule.positions);
      context.$('timeCaption').textContent = '选中 ' + rule.picked + ' 号' + (rule.replacedPositions ? ' · 已自动更换取位' : '');
      await window.TimeDigitsTransitions.pair(rule.positions);
      context.$('timeMatchName').textContent = record.name;
      await window.TimeDigitsTransitions.name(rule.positions);
      await context.delay(220);
      visual.classList.add('is-fading');
      await context.delay(450);
  }

  async function returnToOverview(record) {
      const screen = document.querySelector('.draw-screen');
      context.sceneActive = false;
      context.settling = true;
      screen.classList.add('is-settling');
      screen.classList.remove('is-animating');
      context.$('seatArrow').classList.remove('spinning-arrow');
      context.$('drawStage').classList.remove('drawing', 'last-jump');
      context.$('drawStage').classList.add('reveal');
      context.render();
      context.syncLiveLayout();
      await context.delay(720);
      context.settling = false;
      screen.classList.remove('is-settling');
      delete screen.dataset.animation;
      context.syncLiveLayout();
  }

  async function startDraw() {
      if (!context.available() || context.$$('dialog[open]').length)
          return;
      if (!context.state.students.length) {
          context.setView('roster');
          context.drawButton.setAttribute('aria-expanded', 'true');
          context.$('announcement').textContent = '尚未配置名单，请先导入同学名单或座位表。';
          await window.DialogTransitions.open(context.$('configDialog'));
          return;
      }
      window.SpeechProviders.stop();
      window.FriendSeatConfig.hide();
      const entering = !context.hasSeatBoard(), active = context.state.students.filter(s => s.active);
      const newCycle = active.length > 0 && active.every(s => context.state.cycleSeen.includes(s.id));
      const pool = C.probabilities(context.state).map(p => p.student);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let startedAt = new Date();
      let record, mode;
      try {
          mode = C.previewMode(context.state, startedAt);
      }
      catch (error) {
          context.toast(error.message);
          return;
      }
      context.drawingMode = mode;
      context.drawCommitted = false;
      context.busy = true;
      context.resultVisible = true;
      context.render(false);
      context.$('drawStage').hidden = false;
      context.$('liveBoard').hidden = false;
      document.querySelector('.draw-screen').classList.add('has-result');
      context.$('seatArrow').setAttribute('hidden', '');
      context.$('drawStage').classList.add('drawing');
      context.$('drawStage').classList.remove('reveal');
      context.$('stageName').textContent = '…';
      context.$('stageName').className = 'stage-name';
      context.$('stageId').textContent = '';
      context.$('resultReason').textContent = '正在揭晓本轮结果…';
      const screen = document.querySelector('.draw-screen');
      try {
          if (entering)
              context.$('liveSeatMap').style.opacity = '0';
          context.syncLiveLayout();
          if (entering || newCycle) {
              context.sceneActive = true;
              screen.classList.add('is-lifecycle');
              context.$('drawVisual').hidden = true;
              if (newCycle)
                  await window.SeatTransitions.exit();
              // Clear only the visual cycle. The engine retains it until its single
              // draw commit, preserving the previous seat and exact undo snapshot.
              context.renderSeats(newCycle);
              context.$('liveSeatMap').style.opacity = '0';
              context.fitLiveSeats(true);
              context.cameraOverview(true);
              await context.nextPaint();
              await context.delay(reduced ? 0 : 210);
              const entrance = window.SeatTransitions.enter();
              context.$('liveSeatMap').style.removeProperty('opacity');
              await entrance;
              screen.classList.remove('is-lifecycle');
              context.sceneActive = false;
              startedAt = new Date();
              mode = C.previewMode(context.state, startedAt);
              context.drawingMode = mode;
          }
          if (!reduced && mode === 'time') {
              const now = new Date(), option = C.timeOptions(context.state, now)[0];
              const timeRule = option?.rule || { digits: C.dateDigits(now, context.state.settings.timeSource), positions: [], source: context.state.settings.timeSource, selection: context.state.settings.timeSelection };
              context.renderVisual({ mode: 'time', timeRule, name: '' }, true);
              screen.dataset.animation = 'time';
              context.sceneActive = true;
              screen.classList.add('is-animating');
              context.$('liveSeatScroll').scrollTo(0, 0);
              await context.nextPaint();
              await scanLiveTime(false);
          }
          // Commit once, using the time at the end of the live scan. This also
          // rechecks mode availability when a second/minute/day boundary is crossed.
          record = C.draw(context.state, !reduced && mode === 'time' ? new Date() : startedAt, { endJump: true });
          context.drawingMode = record.mode;
          context.drawCommitted = true;
          context.save();
          context.render(false);
          context.renderVisual(record, !reduced);
          const extraJump = !!record.endJump;
          context.fitLiveSeats(true);
          if (reduced)
              await context.delay(80);
          else {
              const previous = record.before?.lastId && context.state.students.find(s => s.id === record.before.lastId);
              const direction = record.mode === 'direction' && previous?.active && record.direction && !record.fallback && C.adjacent(context.state, previous, record.direction)?.id === record.studentId;
              if (record.mode === 'direction' && !direction) {
                  context.$('directionSpinner').classList.remove('spinning');
                  context.$('directionCaptionText').textContent = record.fallback ? '连坐结束 · 均衡抽取' : '正在选取连坐起点…';
              }
              screen.dataset.animation = record.mode === 'friend' ? 'friend' : record.mode === 'time' && record.timeRule ? 'time' : direction ? 'direction' : 'normal';
              context.sceneActive = true;
              screen.classList.add('is-animating');
              context.$('liveSeatScroll').scrollTo(0, 0);
              await context.nextPaint();
              if (record.mode === 'friend') {
                  const source = context.state.students.find(student => student.id === record.friendSourceId);
                  const targets = record.friendTargetIds.map(id => context.state.students.find(student => student.id === id)).filter(Boolean);
                  await window.FriendTransitions.play({ record, source, targets, showCandidate: student => context.showVisualCandidate(student, false), cameraFocus: context.focusFriendStudent, cameraFit: context.frameFriendGroup, animateNormal: () => animateNormal(targets, record, extraJump, false), delay: context.delay });
              }
              else if (screen.dataset.animation === 'time')
                  await animateTime(record);
              else if (direction)
                  await animateDirection(previous, record, extraJump);
              else
                  await animateNormal(pool, record, extraJump);
              await returnToOverview(record);
          }
      }
      catch (error) {
          console.error('Draw animation:', error);
          if (!record) {
              try {
                  record = C.draw(context.state, new Date(), { endJump: true });
                  context.drawCommitted = true;
                  context.save();
              }
              catch (drawError) {
                  context.resultVisible = context.state.history.length > 0;
                  context.toast(drawError.message);
              }
          }
          if (record)
              context.toast('动画未能播放，已直接显示抽取结果。');
      }
      finally {
          window.SeatTransitions.clear();
          window.TimeDigitsTransitions.clear();
          window.FriendTransitions.clear();
          context.$('liveSeatMap').style.removeProperty('opacity');
          context.friendCameraGroup = null;
          delete context.$('liveSeatScroll').dataset.focusGroup;
          context.sceneActive = false;
          context.settling = false;
          context.busy = false;
          context.drawCommitted = false;
          context.drawingMode = null;
          screen.classList.remove('is-animating', 'is-settling', 'is-lifecycle');
          delete screen.dataset.animation;
          context.$('seatArrow').classList.remove('spinning-arrow');
          context.$('drawStage').classList.remove('drawing', 'last-jump');
          context.$('drawStage').classList.add('reveal');
          context.render();
          context.syncLiveLayout();
          if (record) {
              context.$('announcement').textContent = '第 ' + record.round + ' 轮，抽中 ' + record.name + '，学号 ' + record.studentId + '。' + record.reason;
              context.speak(record.name);
          }
      }
  }

  async function resetDraw() {
      if (!context.available())
          return;
      window.SpeechProviders.stop();
      context.cancelPendingDraw();
      context.pointerRelease = null;
      context.finishHold(true);
      const screen = document.querySelector('.draw-screen');
      context.busy = true;
      context.sceneActive = true;
      context.render(false);
      screen.classList.add('is-lifecycle');
      context.$('drawVisual').hidden = true;
      if (context.$('configDialog').open)
          await window.DialogTransitions.close(context.$('configDialog'));
      try {
          if (context.hasSeatBoard()) {
              await window.SeatTransitions.exit();
              context.$('liveSeatMap').style.opacity = '0';
          }
      }
      catch (_) {
          context.toast('退场动画未能播放，已完成重置。');
      }
      finally {
          window.SeatTransitions.clear();
          screen.classList.remove('is-lifecycle');
      }
      C.reset(context.state);
      context.busy = false;
      context.resultVisible = false;
      context.historyPage = 0;
      context.swapFirst = null;
      context.cameraTarget = null;
      context.cameraAnchor = null;
      context.cameraScale = 1;
      context.sceneActive = false;
      context.settling = false;
      context.followCamera = false;
      document.querySelector('.draw-screen').classList.remove('is-following');
      delete context.$('liveSeatScroll').dataset.layout;
      delete context.$('liveSeatScroll').dataset.focusStudent;
      context.$('liveSeatMap').style.transform = 'translate(0px,0px) scale(1)';
      context.$('seatArrow').setAttribute('hidden', '');
      context.$('seatArrow').classList.remove('spinning-arrow');
      context.$('drawStage').classList.remove('reveal', 'drawing', 'last-jump');
      if (context.isOverview()) {
          context.busy = true;
          context.sceneActive = true;
          screen.classList.add('is-lifecycle');
          context.render(false);
          context.renderStage();
          context.fitLiveSeats(true);
          context.cameraOverview();
          try {
              await context.nextPaint();
              const entrance = window.SeatTransitions.enter();
              context.$('liveSeatMap').style.removeProperty('opacity');
              await entrance;
          }
          finally {
              window.SeatTransitions.clear();
              screen.classList.remove('is-lifecycle');
              context.busy = false;
              context.sceneActive = false;
          }
      }
      context.$('liveSeatMap').style.removeProperty('opacity');
      const saved = context.save();
      context.render();
      context.drawButton.focus({ preventScroll: true });
      if (!saved) return;
      context.$('announcement').textContent = '抽取已重置，名单、座位、设置与长期公平统计保留。';
      context.toast('已重置本轮记录，长期公平统计继续保留。');
  }

  return { shuffleVisual, liveSeat, candidatePause, animateNormal, animateDirection, scanLiveTime, animateTime, returnToOverview, startDraw, resetDraw };
}
