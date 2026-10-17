/** Scene behavior extracted without changing its draw or animation algorithms. */
export function createCamera(context) {
  const box = element => ({ left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight });
  function transform(map, value) { if (map.style.transform !== value) map.style.transform = value; }
  function cameraSafeArea(resting = false) {
      const viewport = context.$('liveSeatScroll'), rect = viewport.getBoundingClientRect();
      const mode = context.drawingMode || context.state.history.at(-1)?.mode;
      let centerX = viewport.clientWidth / 2, centerY = viewport.clientHeight / 2;
      const top = mode === 'direction' || (mode === 'friend' && context.sceneActive) ? 88 : 16;
      let bottom = viewport.clientHeight - 16;
      if (resting || !context.sceneActive) {
          for (const element of [context.$('drawStage'), document.querySelector('.home-actions')]) {
              if (!element.hidden && element.getClientRects().length)
                  bottom = Math.min(bottom, element.getBoundingClientRect().top - rect.top - 12);
          }
      }
      viewport.dataset.cameraCenterX = centerX;
      viewport.dataset.cameraCenterY = centerY;
      viewport.dataset.safeTop = top;
      viewport.dataset.safeBottom = bottom;
      return { centerX, centerY, top, bottom, left: 0, right: viewport.clientWidth };
  }

  function cameraOverview(entry = false) {
      const viewport = context.$('liveSeatScroll'), map = context.$('liveSeatMap'), rect = viewport.getBoundingClientRect();
      const bounds = box(map);
      if (!bounds.width || !bounds.height)
          return;
      let left = 14, right = viewport.clientWidth - 14, top = context.isOverview() ? 78 : 14;
      let bottom = viewport.clientHeight - (innerWidth <= 600 ? 132 : 80);
      if (entry && !context.isOverview())
          bottom = viewport.clientHeight - 14;
      bottom = Math.max(top + 24, bottom);
      const scale = Math.max(.01, Math.min(entry ? 1 : 1.8, (right - left) / bounds.width, (bottom - top) / bounds.height));
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      context.cameraTarget = null;
      context.cameraAnchor = null;
      context.friendCameraGroup = null;
      context.cameraScale = scale;
      delete viewport.dataset.focusStudent;
      delete viewport.dataset.focusGroup;
      viewport.dataset.cameraCenterX = cx;
      viewport.dataset.cameraCenterY = cy;
      viewport.dataset.safeTop = top;
      viewport.dataset.safeBottom = bottom;
      viewport.scrollTo(0, 0);
      transform(map, 'translate(' + (cx - bounds.left - bounds.width * scale / 2).toFixed(2) + 'px,' + (cy - bounds.top - bounds.height * scale / 2).toFixed(2) + 'px) scale(' + scale.toFixed(4) + ')');
  }

  function directionZoom(student) {
      const seat = context.liveSeat(student.id);
      if (!seat)
          return 1;
      const viewport = context.$('liveSeatScroll'), style = getComputedStyle(context.$('liveSeats'));
      const gx = parseFloat(style.columnGap) || 0, gy = parseFloat(style.rowGap) || 0;
      const safe = cameraSafeArea(), height = 2 * Math.max(1, Math.min(safe.centerY - safe.top, safe.bottom - safe.centerY));
      return Math.max(.1, Math.min(3.4, (safe.right - safe.left - 36) / (seat.offsetWidth * 3 + gx * 2), height / (seat.offsetHeight * 3 + gy * 2)));
  }

  function cameraTo(student, scale = 1.6, anchor = null) {
      if (context.isOverview()) {
          cameraOverview();
          return;
      }
      if (!student)
          return;
      const seat = context.liveSeat(student.id);
      if (!seat)
          return;
      const map = context.$('liveSeatMap'), viewport = context.$('liveSeatScroll');
      const from = anchor && context.liveSeat(anchor.id);
      // Snapshot all local coordinates before publishing camera attributes or
      // transforms. Focus changes do not interleave style writes and layout reads.
      const bounds = box(seat), origin = box(map), fromBounds = from && box(from);
      const safe = cameraSafeArea(), padding = 16;
      const cx = bounds.left + bounds.width / 2, cy = bounds.top + bounds.height / 2;
      let radiusX = bounds.width / 2, radiusY = bounds.height / 2;
      if (from) {
          const left = Math.min(bounds.left, fromBounds.left), right = Math.max(bounds.left + bounds.width, fromBounds.left + fromBounds.width);
          const upper = Math.min(bounds.top, fromBounds.top), lower = Math.max(bounds.top + bounds.height, fromBounds.top + fromBounds.height);
          const combinedX = Math.max(cx - left, right - cx), combinedY = Math.max(cy - upper, lower - cy);
          const pairScale = Math.min((Math.min(safe.centerX - safe.left, safe.right - safe.centerX) - padding) / combinedX, Math.min(safe.centerY - safe.top, safe.bottom - safe.centerY) / combinedY);
          // UI may cover peripheral seats. Preserve a readable focus instead of
          // shrinking it solely to keep a covered previous seat inside the frame.
          if (context.sceneActive || pairScale >= Math.min(1, scale)) {
              radiusX = combinedX;
              radiusY = combinedY;
          }
      }
      // Retain the focus at the viewport's exact center. Fit a nearby anchor by
      // adjusting zoom, rather than shifting the camera away from its target.
      scale = Math.max(.1, Math.min(scale, Math.max(1, Math.min(safe.centerX - safe.left, safe.right - safe.centerX) - padding) / radiusX, Math.max(1, Math.min(safe.centerY - safe.top, safe.bottom - safe.centerY)) / radiusY));
      const x = safe.centerX - origin.left - scale * cx;
      const y = safe.centerY - origin.top - scale * cy;
      context.cameraTarget = student;
      context.cameraAnchor = anchor;
      context.cameraScale = scale;
      viewport.dataset.focusStudent = student.id;
      viewport.scrollTo(0, 0);
      transform(map, 'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px) scale(' + scale.toFixed(4) + ')');
  }

  function showVisualCandidate(student, follow = true) {
      const apply = () => {
          const seat = student && context.liveSeat(student.id);
          if (seat && follow) {
              context.friendCameraGroup = null;
              delete context.$('liveSeatScroll').dataset.focusGroup;
              cameraTo(student);
          }
          context.$$('#liveSeats .candidate').forEach(el => el.classList.remove('candidate'));
          if (!seat)
              return;
          seat.classList.add('candidate');
          context.$('stageName').textContent = student.name;
      };
      apply();
      return Promise.resolve();
  }

  function cameraFitFriendGroup(students) {
      if (context.isOverview()) {
          cameraOverview();
          return;
      }
      const seats = students.map(student => context.liveSeat(student.id)).filter(Boolean);
      if (!seats.length)
          return;
      context.friendCameraGroup = students;
      const viewport = context.$('liveSeatScroll'), map = context.$('liveSeatMap'), rect = viewport.getBoundingClientRect();
      const bounds = seats.map(box), origin = box(map);
      const left = Math.min(...bounds.map(seat => seat.left)), right = Math.max(...bounds.map(seat => seat.left + seat.width));
      const upper = Math.min(...bounds.map(seat => seat.top)), lower = Math.max(...bounds.map(seat => seat.top + seat.height));
      const top = Math.min(88, viewport.clientHeight / 3), controls = document.querySelector('.home-actions').getBoundingClientRect();
      const bottom = Math.max(top + 32, Math.min(viewport.clientHeight - 16, controls.top - rect.top - 16));
      const scale = Math.max(.05, Math.min(3.4, (viewport.clientWidth - 48) / Math.max(1, right - left), (bottom - top) / Math.max(1, lower - upper)));
      const centerX = viewport.clientWidth / 2, centerY = (top + bottom) / 2;
      const x = centerX - origin.left - scale * (left + right) / 2;
      const y = centerY - origin.top - scale * (upper + lower) / 2;
      context.cameraTarget = null;
      context.cameraAnchor = null;
      context.cameraScale = scale;
      delete viewport.dataset.focusStudent;
      viewport.dataset.focusGroup = students.map(student => student.id).join(',');
      viewport.dataset.cameraCenterX = centerX;
      viewport.dataset.cameraCenterY = centerY;
      viewport.dataset.safeTop = top;
      viewport.dataset.safeBottom = bottom;
      viewport.scrollTo(0, 0);
      transform(map, 'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px) scale(' + scale.toFixed(4) + ')');
  }

  function focusFriendStudent(student) {
      const apply = () => { context.friendCameraGroup = null; delete context.$('liveSeatScroll').dataset.focusGroup; cameraTo(student, 2.6); };
      apply();
      return Promise.resolve();
  }

  function frameFriendGroup(students) {
      cameraFitFriendGroup(students);
      return Promise.resolve();
  }

  return { cameraSafeArea, cameraOverview, directionZoom, cameraTo, showVisualCandidate, cameraFitFriendGroup, focusFriendStudent, frameFriendGroup };
}
