import { createStage } from "../scene/stage.js";
import { createCamera } from "../scene/camera.js";
import { createDrawSequence } from "../scene/draw-sequence.js";
import { createImports } from "../scene/imports.js";
import C from "../domain/engine";
import { nextTick } from "vue";
import { referenceMarkup } from "../scene/reference-markup.js";
import { HOLD_MS, pressIntent } from './press-intent';
import { migrateAutomaticDemo } from './initial-state';
import { findExternalCssResources, summarizeCssResources } from './appearance';
import { BACKUP_LIMIT, encodeBackup, readBackup, rosterSnapshot, applyRosterBackup, applySettingsBackup, verifyCurrentDataForRestore } from '../domain/backup';
import { buildAnalysisReport } from '../domain/analysis';
export function mountController({ store, repository, filePort, fullscreenPort }) {
  const $ = id => document.getElementById(id), $$ = selector => Array.from(document.querySelectorAll(selector));
  const MODE_NAMES = { normal: '普通随机', direction: '方向接力', time: '时间学号', friend: '友尽模式' };
  const VIEW_NAMES = { general: '通用', dashboard: '功能', roster: '名单', data: '数据', help: '帮助', about: '关于' };
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON_NAMES = { shuffle: 'shuffle', grid: 'grid_view', users: 'groups', clock: 'schedule', help: 'help_outline', arrow: 'arrow_forward', compass: 'open_with', upload: 'upload', download: 'download', expand: 'fullscreen', settings: 'tune', check: 'check', close: 'close', undo: 'undo', spark: 'auto_awesome', image: 'image', search: 'search', lock: 'lock' };
  const icon = name => '<span class="icon material-icon" aria-hidden="true">' + (ICON_NAMES[name] || 'help_outline') + '</span>';
  const displayId = id => String(id).padStart(2, '0');
  let modeError = '', validationRevision = 0;
  let state = C.createEmptyState(), busy = false, view = 'dashboard', swapMode = false, swapFirst = null, editingId = null;
  let activeImportTab = 'text', previewStudents = null, previewCols = 8, imageData = null, imageReadVersion = 0;
  let referenceSheets = [], referenceReadVersion = 0, referenceLoading = false;
  let recognitionController = null, recognitionBusy = false, historyPage = 0, confirmAction = null, toastTimer = null, toastHost = null;
  let loadWarning = '', saveError = '', recoveryRequired = false, resultVisible = false, drawCommitted = false, drawingMode = null, settling = false, sceneActive = false, followCamera = false, cameraTarget = null, cameraAnchor = null, cameraScale = 1;
  // The first-run flow belongs to the finished window, never to a handoff preview.
  const preview = window.slateDesktop?.data?.preview === true;
  let booted = false, onboardingDismissed = false, onboardingSuppressed = false;
  let directionNotice = null, directionNoticeTimer = null, directionNoticeHideTimer = null;
  let friendCameraGroup = null;
  $('imageFileLabel').insertAdjacentHTML('afterend', referenceMarkup);
  const loaded = repository.load(state); state = loaded.state; loadWarning = loaded.warning;
  const loadedSaveError = loaded.saveError || '';
  saveError = loadedSaveError || loaded.warning || ''; recoveryRequired = !!loaded.recoveryRequired;
  const initial = recoveryRequired ? state : migrateAutomaticDemo(state);
  if (initial !== state) {
    state = initial;
    try { repository.save(state); }
    catch (error) { saveError = error.message || '演示名单已移除，请导入实际名单；本机存储暂不可用。'; loadWarning = saveError; }
  }
  // A read or write problem means the flag cannot be trusted yet: show the
  // existing save warning instead of asking for a first-run configuration.
  onboardingSuppressed = Boolean(loadWarning || loadedSaveError);
  booted = true;
  resultVisible = state.history.length > 0;
  function toast(message) {
    const host = window.DialogTransitions.topModal()?.querySelector('[data-toast-host]') || $('toast');
    if (toastHost && toastHost !== host) { toastHost.textContent = ''; toastHost.hidden = true; }
    toastHost = host; host.textContent = message; host.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { host.textContent = ''; host.hidden = true; }, 4200);
  }
  function syncSaveStatus() {
    $('saveStatus').textContent = saveError ? (recoveryRequired ? '需要恢复：' : '尚未保存：') + saveError
      : nativeData() ? '记录自动保存在程序 data 目录' : '记录自动保存在本机';
  }
  function save() {
    if (recoveryRequired) { toast(saveError || '数据尚未完成恢复，请先恢复全部数据。'); return false; }
    try { repository.save(state); saveError = ''; syncSaveStatus(); publish(); return true; }
    catch (error) {
      saveError = error.message || '本机存储不可用或空间不足，请导出备份保存本次记录。';
      syncSaveStatus(); publish(); toast(saveError); return false;
    }
  }
  function persistOnboarding(value) {
    const previous = state.settings;
    state.settings = C.settings({ ...state.settings, onboardingCompleted: value });
    try { repository.save(state); saveError = ''; syncSaveStatus(); return true; }
    catch (error) {
      state.settings = previous;
      saveError = error.message || '本机存储不可用或空间不足，请导出备份保存本次记录。';
      syncSaveStatus(); publish(); toast(saveError); return false;
    }
  }
  function readOnlyAvailable() {
    if (!busy) return true;
    toast('正在处理数据或揭晓结果，请稍等片刻。'); return false;
  }

  function available({ allowRecovery = false } = {}) {
    if (!readOnlyAvailable()) return false;
    if (!recoveryRequired || allowRecovery) return true;
    toast('数据尚未完成恢复，请在「数据」页恢复全部数据后再修改或抽取。'); return false;
  }
  function isOverview() { return state.settings.renderStyle === 'overview'; }
  function hasSeatBoard() { return resultVisible || isOverview(); }
  function applyRenderStyle() {
    const screen = document.querySelector('.draw-screen');
    if (screen.dataset.renderStyle !== state.settings.renderStyle) screen.dataset.renderStyle = state.settings.renderStyle;
    window.RenderStyleUI.sync();
  }
  function motionDuration(ms) { return ms; }
  const sceneContext = {
    get $() { return $; },
    get $$() { return $$; },
    get activeImportTab() { return activeImportTab; },
    set activeImportTab(value) { activeImportTab = value; },
    get available() { return available; },
    get requestConfirm() { return requestConfirm; },
    get busy() { return busy; },
    set busy(value) { busy = value; },
    get cameraAnchor() { return cameraAnchor; },
    set cameraAnchor(value) { cameraAnchor = value; },
    get cameraFitFriendGroup() { return cameraFitFriendGroup; },
    get cameraOverview() { return cameraOverview; },
    get cameraSafeArea() { return cameraSafeArea; },
    get cameraScale() { return cameraScale; },
    set cameraScale(value) { cameraScale = value; },
    get cameraTarget() { return cameraTarget; },
    set cameraTarget(value) { cameraTarget = value; },
    get cameraTo() { return cameraTo; },
    get cancelPendingDraw() { return cancelPendingDraw; },
    get delay() { return delay; },
    get directionNotice() { return directionNotice; },
    set directionNotice(value) { directionNotice = value; },
    get directionNoticeHideTimer() { return directionNoticeHideTimer; },
    set directionNoticeHideTimer(value) { directionNoticeHideTimer = value; },
    get directionNoticeTimer() { return directionNoticeTimer; },
    set directionNoticeTimer(value) { directionNoticeTimer = value; },
    get directionZoom() { return directionZoom; },
    get displayId() { return displayId; },
    get drawButton() { return drawButton; },
    get drawCommitted() { return drawCommitted; },
    set drawCommitted(value) { drawCommitted = value; },
    get drawingMode() { return drawingMode; },
    set drawingMode(value) { drawingMode = value; },
    get escape() { return escape; },
    get finishHold() { return finishHold; },
    get fitLiveSeats() { return fitLiveSeats; },
    get focusFriendStudent() { return focusFriendStudent; },
    get followCamera() { return followCamera; },
    set followCamera(value) { followCamera = value; },
    get frameFriendGroup() { return frameFriendGroup; },
    get friendCameraGroup() { return friendCameraGroup; },
    set friendCameraGroup(value) { friendCameraGroup = value; },
    get hasSeatBoard() { return hasSeatBoard; },
    get highlightTime() { return highlightTime; },
    get historyPage() { return historyPage; },
    set historyPage(value) { historyPage = value; },
    get imageData() { return imageData; },
    set imageData(value) { imageData = value; },
    get imageReadVersion() { return imageReadVersion; },
    set imageReadVersion(value) { imageReadVersion = value; },
    get isOverview() { return isOverview; },
    get liveSeat() { return liveSeat; },
    get MODE_NAMES() { return MODE_NAMES; },
    get motionDuration() { return motionDuration; },
    get nextPaint() { return nextPaint; },
    get pointerRelease() { return pointerRelease; },
    set pointerRelease(value) { pointerRelease = value; },
    get previewCols() { return previewCols; },
    set previewCols(value) { previewCols = value; },
    get previewStudents() { return previewStudents; },
    set previewStudents(value) { previewStudents = value; },
    get recognitionBusy() { return recognitionBusy; },
    set recognitionBusy(value) { recognitionBusy = value; },
    get recognitionController() { return recognitionController; },
    set recognitionController(value) { recognitionController = value; },
    get recoveryRequired() { return recoveryRequired; },
    get referenceLoading() { return referenceLoading; },
    set referenceLoading(value) { referenceLoading = value; },
    get referenceReadVersion() { return referenceReadVersion; },
    set referenceReadVersion(value) { referenceReadVersion = value; },
    get referenceSheets() { return referenceSheets; },
    set referenceSheets(value) { referenceSheets = value; },
    get render() { return render; },
    get renderSeats() { return renderSeats; },
    get renderStage() { return renderStage; },
    get renderVisual() { return renderVisual; },
    get resultVisible() { return resultVisible; },
    set resultVisible(value) { resultVisible = value; },
    get save() { return save; },
    get saveError() { return saveError; },
    get sceneActive() { return sceneActive; },
    set sceneActive(value) { sceneActive = value; },
    get settling() { return settling; },
    set settling(value) { settling = value; },
    get setView() { return setView; },
    get show() { return show; },
    get showVisualCandidate() { return showVisualCandidate; },
    get speak() { return speak; },
    get state() { return state; },
    set state(value) { state = value; },
    get swapFirst() { return swapFirst; },
    set swapFirst(value) { swapFirst = value; },
    get swapMode() { return swapMode; },
    set swapMode(value) { swapMode = value; },
    get syncLiveLayout() { return syncLiveLayout; },
    get toast() { return toast; },
  };
  const { renderStage, renderSeats, scrollCurrentSeat, fitLiveSeats, syncLiveLayout, renderSeatArrow, renderVisual, clearDirectionNotice, manageDirectionNotice, highlightTime } = createStage(sceneContext);
  const { cameraSafeArea, cameraOverview, directionZoom, cameraTo, showVisualCandidate, cameraFitFriendGroup, focusFriendStudent, frameFriendGroup } = createCamera(sceneContext);
  const { shuffleVisual, liveSeat, candidatePause, animateNormal, animateDirection, scanLiveTime, animateTime, returnToOverview, startDraw, resetDraw } = createDrawSequence(sceneContext);
  const { switchImportTab, openImport, showImportPreview, previewImport, applyImport, visionPrompt, clearReferenceSheets, readReferenceFiles, readImage, recognizeImage, cancelRecognition, invalidatePendingReads, refreshRecognitionAvailability } = createImports(sceneContext);
  window.DialogTransitions.init();
  function commitModeSettings(patch) {
    if (!available()) return false;
    try { state.settings = C.settings(Object.assign({}, state.settings, patch)); modeError = ''; validationRevision++; const saved = save(); render(); return saved; }
    catch (error) { modeError = error.message; validationRevision++; publish(); toast(error.message); return false; }
  }
  window.VisionProviders.init({ mount: $('providerSettingsMount'), toast, canWrite: () => available() });
  window.SpeechProviders.init({ mount: $('speechProviderMount'), toast, canWrite: () => available() });
  window.RenderStyleUI.init({ getStyle: () => state.settings.renderStyle, isBusy: () => busy || recoveryRequired, onChange: changeRenderStyle });
  async function changeRenderStyle(style) {
    if (!available() || !['normal', 'overview'].includes(style) || style === state.settings.renderStyle) return false;
    const entering = !resultVisible && style === 'overview', exiting = !resultVisible && isOverview();
    if (!entering && !exiting) { state.settings.renderStyle = style; const saved = save(); render(); syncLiveLayout(true); return saved; }
    const screen = document.querySelector('.draw-screen');
    let applied = false, saved = false;
    busy = true; sceneActive = true; render(false); screen.classList.add('is-lifecycle');
    try {
      if (exiting) await window.SeatTransitions.exit();
      state.settings.renderStyle = style; applied = true; saved = save(); renderStage(); applyRenderStyle();
      if (entering) {
        $('liveSeatMap').style.opacity = '0'; fitLiveSeats(true); cameraOverview(); await nextPaint();
        const entrance = window.SeatTransitions.enter(); $('liveSeatMap').style.removeProperty('opacity'); await entrance;
      }
    } catch (error) {
      if (!applied) { state.settings.renderStyle = style; saved = save(); }
      if (saved) toast('已切换显示风格。');
    }
    finally {
      window.SeatTransitions.clear(); screen.classList.remove('is-lifecycle');
      $('liveSeatMap').style.removeProperty('opacity');
      busy = false; sceneActive = false; render(); syncLiveLayout(true);
    }
    return saved;
  }
  window.FriendSeatConfig.init({ getState: () => state, isBusy: () => busy || recoveryRequired, onSettings: openStudent, toast, commitTargets: (sourceId, targetIds) => {
    if (!available()) return false;
    const students = C.normalizeStudents(state.students.map(student => student.id === sourceId ? Object.assign({}, student, { friendTargets: targetIds }) : student));
    state.students = students; const saved = save(); render();
    if (saved) toast('已保存友尽目标，共 ' + targetIds.length + ' 位。');
    return saved;
  } });
  window.DialogTransitions.register($('configDialog'), { onEscape: () => window.FriendSeatConfig.dismiss() });
  function show(dialog, { allowRecovery = false } = {}) { if (available({ allowRecovery })) return window.DialogTransitions.open(dialog); }
  function requestConfirm(title, text, label, action, { allowRecovery = false } = {}) {
    if (!available({ allowRecovery })) return;
    $('confirmTitle').textContent = title; $('confirmText').textContent = text; $('confirmActionBtn').textContent = label;
    confirmAction = { action, allowRecovery }; show($('confirmDialog'), { allowRecovery });
  }
  function setView(next) {
    if (next === 'history') next = 'data';
    if (!(next in VIEW_NAMES)) return;
    window.FriendSeatConfig.hide(); view = next; publish();
    if (next === 'data') void refreshDataInfo();
  }
  function renderModes() {
    $('exitChainBtn').hidden = !resultVisible || (!state.lock && !(busy && state.history.at(-1)?.mode === 'direction'));
    $('exitChainBtn').disabled = busy || recoveryRequired;
    $('resetDrawBtn').hidden = !state.students.length || !isOverview() && (!resultVisible || !state.history.length);
    $('resetDrawBtn').disabled = busy || recoveryRequired;
  }
  function onboardingActive() {
    return booted && !preview && !recoveryRequired && !onboardingDismissed
      && !onboardingSuppressed
      && state.settings.onboardingCompleted === false;
  }
  function publish() {
    store.publish({ state, busy, view, swapMode, swapFirst, modeError, validationRevision, saveError, recoveryRequired, booted, onboarding: onboardingActive() });
    void nextTick(() => window.FriendSeatConfig.sync());
  }
  
  
  
  
  
  
  
  
  
  
  let layoutFrame = null, layoutForce = false;
  const refreshLiveLayout = (force = false) => {
    if (!hasSeatBoard()) return;
    layoutForce = layoutForce || force;
    if (layoutFrame != null) return;
    layoutFrame = requestAnimationFrame(() => { const pendingForce = layoutForce; layoutForce = false; layoutFrame = null; syncLiveLayout(pendingForce); });
  };
  window.addEventListener('resize', () => refreshLiveLayout(true));
  if ('ResizeObserver' in window) new ResizeObserver(() => refreshLiveLayout()).observe($('liveSeatScroll'));
  function renderRoster() { publish(); }
  function renderHistory() { publish(); }
  function render(updateStage = true) {
    applyRenderStyle(); syncSaveStatus(); publish();
    $('drawBtn').setAttribute('aria-busy', String(busy)); $('drawButtonText').textContent = busy ? '抽取中' : '抽人';
    renderModes(); renderSeats();
    if (updateStage) renderStage();
  }
  function speak(name) {
    if (!state.settings.voice) return;
    void window.SpeechProviders.speak(name);
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, motionDuration(ms)));
  const nextPaint = () => new Promise(resolve => {
    const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
    const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 100);
  });
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  function settingsPanel(mode) {
    const next = ['normal', 'direction', 'time', 'friend', 'general', 'all'].includes(mode) ? mode : 'general';
    $('settingsDialog').dataset.settingsContext = next;
    $$('[data-settings-panel]').forEach(panel => panel.hidden = next !== 'all' && panel.dataset.settingsPanel !== next);
    $$('[data-settings-tab]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.settingsTab === next)));
    $('settingsTitle').textContent = { normal: '普通模式 · 公平设置', direction: '连坐模式 · 附加设置', time: '时间模式 · 附加设置', friend: '友尽模式 · 目标设置', general: '朗读设置', all: '抽取规则' }[next];
  }
  function openSettings(mode = 'general') {
    if (!available()) return;
    const s = state.settings;
    $('cooldownInput').value = s.cooldown; $('directionMinInput').value = s.directionMin; $('directionMaxInput').value = s.directionMax; $('directionInput').value = s.direction;
    $('directionCooldownMinInput').value = s.directionCooldownMin; $('directionCooldownMaxInput').value = s.directionCooldownMax;
    $('directionCooldownHint').textContent = (state.directionCooldownRemaining > 0 ? '当前还剩 ' + state.directionCooldownRemaining + ' 轮冷却。' : '') + '连坐结束后在此范围随机冷却；冷却期间不进入连坐。两项都为 0 时关闭，修改范围从下次连坐结束生效。';
    $('strengthInput').value = s.strength; $('strengthValue').textContent = s.strength.toFixed(1);
    $('timeSourceInput').value = s.timeSource; $('timeSelectionInput').value = s.timeSelection; $('positionsInput').value = s.positions; $('voiceInput').checked = s.voice;
    $('friendDetailSummary').textContent = '已配置 ' + state.students.filter(student => student.friendTargets?.length).length + ' 位同学的友尽目标；概率与功能开关在抽选设置页即时保存。';
    $('settingsError').textContent = ''; updateDigitPreview(); settingsPanel(mode); show($('settingsDialog'));
  }
  let digitNodes = [], digitCount = 0;
  function updateDigitPreview() {
    const source = $('timeSourceInput').value, positions = $('positionsInput').value, digits = C.dateDigits(new Date(), source);
    const automatic = $('timeSelectionInput').value === 'random';
    $('positionsInput').disabled = automatic; $('positionsInput').required = !automatic;
    const selected = automatic ? [] : positions.split(/[,，\s]+/).filter(Boolean).map(Number);
    const focusedPosition = document.activeElement?.closest('[data-digit]')?.dataset.digit;
    if (digitCount !== digits.length) {
      $('digitButtons').innerHTML = digits.split('').map((d, i) => '<button type="button" class="digit-button" data-digit="' + (i + 1) + '"><span data-digit-value>' + d + '</span><small>' + (i + 1) + '</small></button>').join('');
      digitNodes = $$('#digitButtons [data-digit]'); digitCount = digits.length;
      if (focusedPosition) digitNodes[Math.min(Number(focusedPosition), digitCount) - 1]?.focus({ preventScroll: true });
    }
    digitNodes.forEach((button, index) => {
      const value = button.querySelector('[data-digit-value]'), chosen = selected.includes(index + 1);
      if (value.textContent !== digits[index]) value.textContent = digits[index];
      button.classList.toggle('chosen', chosen);
      button.setAttribute('aria-label', '第 ' + (index + 1) + ' 位数字 ' + digits[index]);
      button.setAttribute('aria-pressed', String(chosen));
    });
    if (automatic) { $('digitResult').textContent = '从能匹配可抽学生的连续两位中随机选择；全部不可用时切换模式。以揭晓时刻与绿色高亮为准。'; return; }
    try { const result = C.extractNumber(new Date(), source, positions); $('digitResult').textContent = '当前取位：' + result.picked + ' → 学号 ' + result.number + '。揭晓时核对，无效则改选其他连续两位，全部不可用时切换模式。'; }
    catch (error) { $('digitResult').textContent = error.message; }
  }
  function openStudent(id) {
    if (!available()) return;
    const s = state.students.find(s => s.id === id); if (!s) return;
    if (swapMode && view === 'roster') {
      if (!swapFirst) { swapFirst = id; renderSeats(); renderRoster(); return; }
      if (swapFirst === id) { swapFirst = null; renderSeats(); renderRoster(); return; }
      const first = state.students.find(s => s.id === swapFirst);
      const position = [first.row, first.col]; first.row = s.row; first.col = s.col; s.row = position[0]; s.col = position[1];
      swapFirst = null; C.endDirection(state); const saved = save(); render(); if (saved) toast('两位同学的座位已交换。'); return;
    }
    editingId = id; $('studentIdInput').value = s.id; $('studentNameInput').value = s.name; $('studentRowInput').value = s.row; $('studentColInput').value = s.col; $('studentActiveInput').checked = s.active; $('studentError').textContent = ''; show($('studentDialog'));
  }
  
  
  
  
  
  
  
  
  
  
  
  function download(name, content, type) { return filePort.save({ name, text: content, mime: type }); }
  function safeFilename(value) { return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 50) || '点到'; }
  function desktopBridge() {
    const bridge = window.slateDesktop;
    return bridge?.role === 'main' && !bridge.data.preview ? bridge : null;
  }
  function nativeData() { return desktopBridge()?.data || null; }
  function dataStatus(message) { if ($('backupDataStatus')) $('backupDataStatus').textContent = message; }
  async function refreshDataInfo() {
    if (!$('dataDirectoryText')) return;
    const native = nativeData();
    if (!native) {
      if (window.slateDesktop) $('dataDirectoryText').textContent = '当前为预览窗口，数据保存在预览浏览器中，未使用正式便携数据目录。';
      return;
    }
    try { const info = await native.info(); $('dataDirectoryText').textContent = info.directory; }
    catch (error) { $('dataDirectoryText').textContent = '无法读取数据目录：' + error.message; }
  }
  async function credentialsSnapshot(includeSecrets = false) {
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => window.VisionProviders.exportSettings({ includeSecrets })),
      Promise.resolve().then(() => window.SpeechProviders.exportSettings({ includeSecrets }))
    ]);
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return { vision: settled[0].value, speech: settled[1].value };
  }
  async function prepareCredentials(incoming = {}, current = null) {
    if (!current) current = await credentialsSnapshot(true);
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => incoming.vision === undefined ? current.vision : window.VisionProviders.prepareSettings(incoming.vision)),
      Promise.resolve().then(() => incoming.speech === undefined ? current.speech : window.SpeechProviders.prepareSettings(incoming.speech))
    ]);
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return { vision: settled[0].value, speech: settled[1].value };
  }
  async function inspectCredentialRepair(incoming = {}) {
    if (!nativeData()) return null;
    const providers = { vision: window.VisionProviders, speech: window.SpeechProviders };
    const scopes = Object.keys(providers);
    const existing = await Promise.allSettled(scopes.map(scope => Promise.resolve().then(() => providers[scope].exportSettings({ includeSecrets: true }))));
    if (existing.every(result => result.status === 'fulfilled')) return null;
    const prepared = await Promise.allSettled(scopes.map(async (scope, index) => {
      const current = existing[index], unreadable = current.status === 'rejected';
      if (!unreadable && incoming[scope] === undefined) return [scope, current.value];
      const payload = incoming[scope] === undefined ? { active: providers[scope].presets[0].id, records: [] } : incoming[scope];
      return [scope, await providers[scope].prepareSettings(payload, { preserveKeys: !unreadable, allowUnavailable: unreadable })];
    }));
    const failure = prepared.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return Object.fromEntries(prepared.map(result => result.value));
  }
  async function desktopSnapshot() { const bridge = desktopBridge(); return bridge ? (await bridge.state()).settings : null; }
  function buildMetadata() {
    try { return JSON.parse($('buildMetadata')?.textContent || 'null'); }
    catch { return null; }
  }
  async function analysisEnvironment() {
    const metadata = buildMetadata();
    let desktop = null;
    const bridge = desktopBridge();
    if (bridge) {
      const snapshot = await bridge.state(), runtime = snapshot.runtime || {}, desktopSettings = snapshot.settings || {};
      desktop = {
        runtime: {
          elevated: runtime.elevated === true,
          uiAccess: runtime.uiAccess === true,
          autostart: runtime.autostart === true,
          status: String(runtime.status || ''),
          requiresRestart: runtime.requiresRestart === true
        },
        settings: {
          uac: desktopSettings.uac === true,
          uiAccess: desktopSettings.uiAccess === true,
          autostart: desktopSettings.autostart === true,
          showFloatingBall: desktopSettings.showFloatingBall !== false
        }
      };
    }
    let timezone = '';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
    const nav = globalThis.navigator || {}, viewport = globalThis.screen || {};
    return {
      appVersion: metadata?.appVersion || '1.0.0',
      edition: bridge ? 'desktop' : 'lite',
      build: metadata,
      userAgent: nav.userAgent || '',
      platform: nav.platform || '',
      language: nav.language || '',
      timezone,
      screen: { width: Number(viewport.width) || 0, height: Number(viewport.height) || 0, pixelRatio: Number(globalThis.devicePixelRatio) || 1 },
      desktop
    };
  }
  async function exportAnalysis() {
    const createdAt = new Date().toISOString(), stamp = createdAt.slice(0, 19).replace(/[:T]/g, '-');
    const report = buildAnalysisReport(state, await analysisEnvironment());
    await download('SlateRandom-analysis-' + stamp + '.json', JSON.stringify(report, null, 2), 'application/json;charset=utf-8');
    dataStatus('分析报告已导出；姓名、学号与班级已匿名化。');
    toast('分析报告已导出，姓名与学号已匿名化。');
  }
  async function runDataAction(action, { allowRecovery = false, readOnly = false } = {}) {
    if (!(readOnly ? readOnlyAvailable() : available({ allowRecovery }))) return;
    busy = true; render(false); dataStatus('正在处理数据…');
    try { await action(); }
    catch (error) { dataStatus('操作失败：' + error.message); toast(error.message || '数据操作失败，请保留备份并检查数据状态。'); }
    finally { busy = false; refreshRecognitionAvailability(); render(); }
  }
  async function exportData(kind) {
    const createdAt = new Date().toISOString(), stamp = createdAt.slice(0, 19).replace(/[:T]/g, '-');
    const name = safeFilename(state.className) + '-SlateRandom-' + kind + '-' + stamp;
    if (kind === 'roster') {
      const payload = { format: 'SlateRandom.backup', version: 1, kind, createdAt, roster: rosterSnapshot(state) };
      await download(name + '.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    } else {
      const credentials = await credentialsSnapshot($('includeSecretsToggle').checked), desktopSettings = await desktopSnapshot();
      if (kind === 'all') {
        const bytes = await encodeBackup({ format: 'SlateRandomBackup', version: 1, kind, createdAt, state: C.clone(state), credentials, desktop: desktopSettings });
        await filePort.save({ name: name + '.slate', bytes, mime: 'application/octet-stream' });
      } else {
        await download(name + '.json', JSON.stringify({ format: 'SlateRandom.backup', version: 1, kind, createdAt, settings: C.clone(state.settings), credentials, desktopSettings }, null, 2), 'application/json;charset=utf-8');
      }
    }
    const message = { roster: '名单已导出，未包含累计公平统计。', settings: '设置已导出，名单和累计公平统计未改变。', all: '全部数据已导出为带完整性校验的便携备份。' }[kind];
    dataStatus(message); toast(message);
  }
  function acceptRestoredData(next) {
    state = next; resultVisible = next.history.length > 0; swapMode = false; swapFirst = null; historyPage = 0;
    window.FriendSeatConfig.hide(); render();
    void refreshDataInfo();
  }
  function stopRestoreActivities() {
    invalidatePendingReads();
    cancelPendingDraw(); pointerRelease = null; finishHold(true);
    window.SpeechProviders.stop();
  }
  function requireRecovery(message, next = state) {
    recoveryRequired = true; saveError = message;
    try { stopRestoreActivities(); }
    catch (error) { saveError += ' ' + (error.message || '朗读未能停止，请关闭程序。'); }
    acceptRestoredData(next);
    return new Error(saveError);
  }
  async function commitRestoredData(next, incoming, fullRestore = false, repairCredentials = null) {
    const native = nativeData();
    if (native) {
      verifyCurrentDataForRestore(() => native.loadClass(), fullRestore);
      const credentials = repairCredentials || await prepareCredentials(incoming);
      // Either outcome confirms that the transaction journal has committed.
      const outcome = await native.restoreAll({ state: next, credentials });
      try {
        C.restoreState(await native.loadClass());
        const info = await native.info();
        if (info.error) throw new Error(info.error);
        if (info.generation !== outcome.generation) throw new Error('恢复后的数据与备份不一致。');
        const reloaded = await Promise.allSettled([
          Promise.resolve().then(() => window.VisionProviders.reloadSettings()),
          Promise.resolve().then(() => window.SpeechProviders.reloadSettings())
        ]);
        const failures = reloaded.filter(result => result.status === 'rejected');
        if (failures.length) throw new Error(failures.map(result => result.reason?.message || String(result.reason)).join('；'));
        stopRestoreActivities();
      } catch (error) {
        throw requireRecovery('备份已写入，但读取时遇到问题。请保留备份并重新恢复全部数据。' + error.message, next);
      }
    } else {
      const previous = repository.load(state);
      if (previous.recovery?.saved === false || (!previous.fromStorage && previous.warning && !previous.recovery?.saved)
        || (previous.recoveryRequired && !previous.recovery?.saved)) {
        throw new Error('无法安全恢复：原班级数据未能读取或保存恢复副本。请先保留原始数据，再恢复全部数据。' + (previous.warning || ''));
      }
      const oldCredentials = await credentialsSnapshot(true);
      const credentials = await prepareCredentials(incoming, oldCredentials);
      const providers = { vision: window.VisionProviders, speech: window.SpeechProviders };
      const attempted = new Set();
      let committed = false;
      try {
        for (const scope of ['vision', 'speech']) {
          // A rejected import may already have persisted and refreshed its cache.
          attempted.add(scope);
          await providers[scope].importSettings(credentials[scope], { preserveKeys: false });
        }
        repository.save(next);
        committed = true;
        const reloaded = await Promise.allSettled([
          Promise.resolve().then(() => {
            const result = repository.load(next);
            if (!result.fromStorage || result.warning || result.recovery || result.recoveryRequired) {
              throw new Error(result.warning || '恢复后的班级数据无法从存储中完整读回。');
            }
            return result.state;
          }),
          Promise.resolve().then(() => window.VisionProviders.reloadSettings()),
          Promise.resolve().then(() => window.SpeechProviders.reloadSettings())
        ]);
        const failures = reloaded.filter(result => result.status === 'rejected');
        if (failures.length) throw new Error(failures.map(result => result.reason?.message || String(result.reason)).join('；'));
        stopRestoreActivities();
      } catch (error) {
        if (committed) {
          throw requireRecovery('备份已写入，但读取时遇到问题。请保留备份并重新恢复全部数据。' + error.message, next);
        }
        const compensated = await Promise.allSettled(Array.from(attempted, scope =>
          Promise.resolve().then(() => providers[scope].importSettings(oldCredentials[scope], { preserveKeys: false }))));
        const failures = compensated.filter(result => result.status === 'rejected');
        if (failures.length) {
          throw requireRecovery('恢复失败，原班级数据仍在，但识别或朗读设置未能还原。请重新恢复全部数据。'
            + error.message + '；' + failures.map(result => result.reason?.message || String(result.reason)).join('；'));
        }
        throw error;
      }
    }
    saveError = ''; recoveryRequired = false;
    acceptRestoredData(next);
  }
  async function applyDesktopBackup(settings) {
    const bridge = desktopBridge(); if (!settings || !bridge) return;
    try {
      const current = (await bridge.state()).settings;
      const patch = Object.fromEntries(Object.entries(settings).filter(([key, value]) => current[key] !== value));
      if (Object.keys(patch).length) {
        const updated = await bridge.updateSettings(patch);
        if (updated.runtime?.error) throw new Error(updated.runtime.error);
      }
    } catch (error) {
      const message = '数据已恢复；桌面设置未能应用：' + error.message; dataStatus(message); toast(message);
    }
  }
  async function restoreData(parsed) {
    invalidatePendingReads();
    const next = parsed.kind === 'all' ? C.restoreState(parsed.state) : parsed.kind === 'settings' ? applySettingsBackup(state, parsed.settings) : applyRosterBackup(state, parsed.roster);
    // A full or settings backup brings the user's own configuration, which ends a
    // first run; a roster-only backup is just a roster, so the flow keeps going.
    if (parsed.kind !== 'roster') next.settings.onboardingCompleted = true;
    if (parsed.kind === 'roster') {
      // A roster-only import never writes credentials or resets matched statistics.
      acceptRestoredData(next);
      if (!save()) { dataStatus(saveError); render(); return; }
      render();
    } else await commitRestoredData(next, parsed.credentials, parsed.kind === 'all', parsed.repairCredentials);
    const message = { all: '全部数据已恢复，抽取进度与累计公平统计已恢复。', settings: '设置已导入，名单与累计公平统计保持原样。', roster: '名单已导入，同名同学的累计公平统计已保留。' }[parsed.kind];
    dataStatus(message); toast(message); setView('data');
    // UAC/UIAccess may restart the process, so apply desktop changes last.
    if (parsed.kind !== 'roster') await applyDesktopBackup(parsed.desktopSettings);
  }
  async function importBackupFile(file, kind) {
    const allowRecovery = kind === 'all';
    if (!file || !available({ allowRecovery })) return;
    try {
      if (file.size > BACKUP_LIMIT * 2) throw new Error('备份文件超过 64 MB。');
      const parsed = await readBackup(await file.arrayBuffer(), kind);
      if (kind === 'all') parsed.repairCredentials = await inspectCredentialRepair(parsed.credentials);
      const title = { all: '恢复全部数据', settings: '导入设置', roster: '导入名单' }[kind];
      const description = kind === 'all' ? '将恢复「' + parsed.state.className + '」的 ' + parsed.state.students.length + ' 位同学、' + parsed.state.round + ' 轮进度及其累计公平统计，替换当前数据。'
        : kind === 'settings' ? '将替换外观、抽选规则、概率与提供商配置。名单、累计公平统计与当前进度保留。'
        : '将导入「' + parsed.roster.className + '」的 ' + parsed.roster.students.length + ' 位同学及座位、友尽目标。同名同学的累计公平统计保留。';
      dataStatus('备份核对完成，等待确认。');
      const repairWarning = parsed.repairCredentials ? ' 原提供商配置无法读取，将使用备份中的配置；未备份的密钥需要重新填写。' : '';
      const keyNotice = kind === 'roster' ? '' : ' 备份未包含的密钥仅在提供商及接口地址均未改变时沿用；接口改变后需重新填写。桌面系统设置将在数据恢复后单独应用。';
      const incomingSettings = kind === 'all' ? parsed.state.settings
        : kind === 'settings' ? parsed.settings : null;
      const externalCss = incomingSettings?.customCssEnabled
        ? findExternalCssResources(incomingSettings.customCss) : [];
      const cssWarning = externalCss.length
        ? ' 备份中的自定义 CSS 会加载外部资源（' + summarizeCssResources(externalCss)
          + '），可能向对应服务器发送请求。仅在信任来源时继续。'
        : '';
      requestConfirm(title, description + repairWarning + keyNotice + cssWarning, kind === 'all' ? '恢复全部' : '确认导入',
        () => runDataAction(() => restoreData(parsed), { allowRecovery }), { allowRecovery });
    } catch (error) { dataStatus('无法读取备份：' + error.message); toast(error.message); }
  }
  function installBackupImport(buttonId, inputId, kind) {
    const allowRecovery = kind === 'all';
    $(buttonId).addEventListener('click', () => { if (available({ allowRecovery })) $(inputId).click(); });
    $(inputId).addEventListener('change', async event => {
      const file = event.target.files[0]; event.target.value = '';
      await importBackupFile(file, kind);
    });
  }
  async function exportHistory() {
    if (!readOnlyAvailable()) return;
    const cell = value => { let str = String(value == null ? '' : value); if (/^\s*[=+\-@]/.test(str)) str = "'" + str; return '"' + str.replace(/"/g, '""') + '"'; };
    const rows = [['轮次', '学号', '姓名', '座位行', '座位列', '模式', '本地时间', '抽取说明']].concat(state.history.map(r => [r.round, r.studentId, r.name, r.row, r.col, MODE_NAMES[r.mode], new Date(r.time).toLocaleString('zh-CN', { hour12: false }), r.reason]));
    try { await download(safeFilename(state.className) + '-抽取记录.csv', '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8'); }
    catch (error) { toast(error.message || '抽取记录导出失败。'); }
  }
  document.addEventListener('click', event => {
    const importer = event.target.closest('[data-import]'); if (importer) { openImport(); return; }
    const close = event.target.closest('[data-close]'); if (close) { const dialog = close.closest('dialog'); if (dialog) window.DialogTransitions.close(dialog); return; }
    const student = event.target.closest('[data-student]'); if (student) {
      if (student.closest('#rosterSeats') && !swapMode) window.FriendSeatConfig.select(student.dataset.student, student);
      else openStudent(student.dataset.student);
      return;
    }
    const toggle = event.target.closest('[data-toggle-student]');
    if (toggle && available()) { const s = state.students.find(s => s.id === toggle.dataset.toggleStudent); s.active = !s.active; save(); render(); return; }
    const tab = event.target.closest('[data-import-tab]'); if (tab) { switchImportTab(tab.dataset.importTab); return; }
    const digit = event.target.closest('[data-digit]');
    if (digit) {
      $('timeSelectionInput').value = 'fixed';
      const n = Number(digit.dataset.digit), current = $('positionsInput').value.split(/[,，\s]+/).filter(Boolean).map(Number).filter(Number.isInteger);
      $('positionsInput').value = (current.includes(n) ? current.filter(x => x !== n) : current.concat(n)).join(','); updateDigitPreview();
    }
  });
  // One control: release before 500 ms to draw; hold to configure.
  const drawButton = $('drawBtn');
  const progressReleases = new WeakMap();
  let hold = null, pointerRelease = null, pendingDrawTimer = null, suppressPointerClick = false;
  function cancelPendingDraw() { clearTimeout(pendingDrawTimer); pendingDrawTimer = null; }
  function clearProgressRelease(button) {
    const previous = progressReleases.get(button); if (previous) clearTimeout(previous.timer);
    progressReleases.delete(button); button.removeAttribute('data-hold-releasing');
    button.style.removeProperty('--hold-progress'); button.style.removeProperty('--hold-release-duration');
  }
  function retractProgress(button, holdingAttribute) {
    const transform = getComputedStyle(button, '::before').transform;
    const fraction = Math.max(0, Math.min(1, transform === 'none' ? 0 : new DOMMatrix(transform).a));
    clearProgressRelease(button); button.removeAttribute(holdingAttribute);
    const duration = Math.round(fraction * HOLD_MS);
    if (!duration) return 0;
    button.style.setProperty('--hold-progress', fraction);
    button.style.setProperty('--hold-release-duration', duration + 'ms');
    button.setAttribute('data-hold-releasing', '');
    const release = { timer: setTimeout(() => { if (progressReleases.get(button) === release) clearProgressRelease(button); }, duration) };
    progressReleases.set(button, release); return duration;
  }
  function drawAfterRelease(current) {
    cancelPendingDraw();
    if (current && pressIntent(current.elapsedMs, current.cancelled, current.fired) !== 'draw') return;
    if (current?.releaseMs) pendingDrawTimer = setTimeout(() => { pendingDrawTimer = null; startDraw(); }, current.releaseMs);
    else startDraw();
  }
  function openConfig(next = 'dashboard') {
    if (busy || $$('dialog[open]').length) return;
    setView(next); render(); window.DialogTransitions.open($('configDialog'));
    drawButton.setAttribute('aria-expanded', 'true');
  }
  document.addEventListener('slate:open-settings', () => {
    if (!readOnlyAvailable()) return;
    // The first-run flow owns the window; the tray must not stack settings on it.
    if (onboardingActive()) return;
    if ($('configDialog').open) { setView('general'); return; }
    openConfig('general');
  });
  function beginHold(kind, id, x = 0, y = 0) {
    if (hold || busy || quitConfirming() || $$('dialog[open]').length) return;
    cancelPendingDraw(); clearProgressRelease(drawButton); pointerRelease = null;
    const current = { kind, id, x, y, startedAt: performance.now(), fired: false, timer: null };
    hold = current;
    drawButton.setAttribute('data-holding', '');
    current.timer = setTimeout(() => {
      if (hold !== current) return;
      current.fired = true; suppressPointerClick = kind === 'pointer';
      // Keep the filled background until release, behind the open menu.
      openConfig();
    }, HOLD_MS);
  }
  function finishHold(cancelled = false) {
    if (!hold) return null;
    const current = hold; hold = null;
    current.elapsedMs = performance.now() - current.startedAt;
    clearTimeout(current.timer); current.releaseMs = retractProgress(drawButton, 'data-holding');
    current.cancelled = cancelled;
    if (current.kind === 'pointer') {
      suppressPointerClick = current.fired || cancelled;
      if (drawButton.hasPointerCapture(current.id)) drawButton.releasePointerCapture(current.id);
    }
    return current;
  }
  drawButton.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    if (busy || $$('dialog[open]').length) { suppressPointerClick = true; return; }
    suppressPointerClick = false;
    beginHold('pointer', event.pointerId, event.clientX, event.clientY);
    if (hold?.kind === 'pointer' && hold.id === event.pointerId) drawButton.setPointerCapture(event.pointerId);
  });
  drawButton.addEventListener('pointermove', event => {
    if (hold?.kind !== 'pointer' || hold.id !== event.pointerId || hold.fired) return;
    const rect = drawButton.getBoundingClientRect();
    if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 14 || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) finishHold(true);
  });
  drawButton.addEventListener('pointerup', event => {
    if (hold?.kind === 'pointer' && hold.id === event.pointerId) pointerRelease = finishHold();
  });
  ['pointercancel', 'lostpointercapture'].forEach(type => drawButton.addEventListener(type, event => {
    if (hold?.kind === 'pointer' && hold.id === event.pointerId) finishHold(true);
  }));
  drawButton.addEventListener('contextmenu', event => event.preventDefault());
  drawButton.addEventListener('click', event => {
    if (suppressPointerClick && (event.detail > 0 || pointerRelease)) { event.preventDefault(); suppressPointerClick = false; pointerRelease = null; return; }
    const released = pointerRelease; pointerRelease = null; drawAfterRelease(released);
  });
  const quitConfirming = () => !!document.querySelector('[data-main-quit-confirming="true"]');
  const interactiveTarget = target => target.closest('button,a,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="textbox"],[role="combobox"],[role="menuitem"],[role="tab"]');
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || quitConfirming() || !['Space', 'Enter'].includes(event.code) || event.ctrlKey || event.metaKey || event.altKey || $$('dialog[open]').length) return;
    const interactive = interactiveTarget(event.target);
    if (interactive && interactive !== drawButton) return;
    if (event.code === 'Enter' && event.target !== drawButton) return;
    event.preventDefault(); if (!event.repeat) beginHold('keyboard', event.code);
  });
  document.addEventListener('keyup', event => {
    if (hold?.kind !== 'keyboard' || hold.id !== event.code) return;
    const cancelled = event.defaultPrevented || quitConfirming(); event.preventDefault();
    const current = finishHold(cancelled); if (current && !current.fired) drawAfterRelease(current);
  });
  window.addEventListener('blur', () => { cancelPendingDraw(); pointerRelease = null; finishHold(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelPendingDraw(); pointerRelease = null; finishHold(true); } });
  $('configDialog').addEventListener('close', () => {
    window.FriendSeatConfig.hide();
    finishHold(true); cancelPendingDraw(); pointerRelease = null;
    drawButton.setAttribute('aria-expanded', 'false'); drawButton.focus({ preventScroll: true });
  });
  $('undoBtn').addEventListener('click', () => { if (!available()) return; try { C.undo(state); const saved = save(); render(); if (saved) toast('已撤销上一轮，并恢复抽取前的状态。'); } catch (error) { toast(error.message); } });
  function exitChain() { if (!available()) return; C.endDirection(state); if (state.settings.strategy === 'manual' && state.settings.manualMode === 'direction') state.settings.manualMode = 'normal'; const saved = save(); render(); if (saved) toast(state.directionCooldownRemaining > 0 ? '已退出连坐，接下来 ' + state.directionCooldownRemaining + ' 轮冷却。' : '已退出连坐。'); }
  $('exitChainBtn').addEventListener('click', exitChain);
  $('helpSettingsBtn').addEventListener('click', () => setView('dashboard'));
  $$('[data-settings-tab]').forEach(button => button.addEventListener('click', () => settingsPanel(button.dataset.settingsTab)));
  $('friendManageTargetsBtn').addEventListener('click', async () => { await window.DialogTransitions.close($('settingsDialog')); setView('roster'); });
  $('strengthInput').addEventListener('input', () => $('strengthValue').textContent = Number($('strengthInput').value).toFixed(1));
  $('positionsInput').addEventListener('input', updateDigitPreview);
  $('timeSelectionInput').addEventListener('change', updateDigitPreview);
  $('timeSourceInput').addEventListener('change', () => { $('positionsInput').value = { time: '5,6', date: '7,8', datetime: '13,14' }[$('timeSourceInput').value]; updateDigitPreview(); });
  $('settingsForm').addEventListener('submit', event => {
    event.preventDefault(); if (!available()) return;
    const invalid = $('settingsForm').querySelector('input:invalid, select:invalid, textarea:invalid');
    if (invalid) {
      const panel = invalid.closest('[data-settings-panel]');
      if (panel) settingsPanel(panel.dataset.settingsPanel);
      invalid.focus({ preventScroll: true }); invalid.reportValidity(); return;
    }
    try {
      if ($('timeSelectionInput').value === 'fixed') C.extractNumber(new Date(), $('timeSourceInput').value, $('positionsInput').value);
      const directionMin = Number($('directionMinInput').value), directionMax = Number($('directionMaxInput').value);
      if (!Number.isInteger(directionMin) || !Number.isInteger(directionMax) || directionMin < 1 || directionMax > 50 || directionMin > directionMax) {
        settingsPanel('direction'); $('directionMinInput').focus({ preventScroll: true });
        throw new Error('连坐轮数需为 1～50 的整数，最少轮数不能大于最多轮数。');
      }
      const directionCooldownMin = Number($('directionCooldownMinInput').value), directionCooldownMax = Number($('directionCooldownMaxInput').value);
      if (!Number.isInteger(directionCooldownMin) || !Number.isInteger(directionCooldownMax) || directionCooldownMin < 0 || directionCooldownMax > 50 || directionCooldownMin > directionCooldownMax) {
        settingsPanel('direction'); $('directionCooldownMinInput').focus({ preventScroll: true });
        throw new Error('连坐冷却需为 0～50 的整数，最少冷却轮数不能大于最多冷却轮数。');
      }
      state.settings = C.settings(Object.assign({}, state.settings, { cooldown: Number($('cooldownInput').value), directionRounds: 'random', directionMin, directionMax, directionCooldownMin, directionCooldownMax, direction: $('directionInput').value, strength: Number($('strengthInput').value), timeSource: $('timeSourceInput').value, timeSelection: $('timeSelectionInput').value, positions: $('positionsInput').value, voice: $('voiceInput').checked }));
      if (!state.settings.voice) window.SpeechProviders.stop();
      const saved = save(); render();
      if (!saved) { $('settingsError').textContent = saveError; return; }
      window.DialogTransitions.close($('settingsDialog')); toast(state.lock ? '规则已保存，方向从下一轮生效，持续轮数在下一次连坐生效。' : '抽取规则已保存。');
    } catch (error) { $('settingsError').textContent = error.message; }
  });
  $('studentForm').addEventListener('submit', event => {
    event.preventDefault(); if (!available()) return;
    try {
      const oldId = editingId;
      const updatedId = String(Number($('studentIdInput').value));
      const students = C.normalizeStudents(state.students.map(student => {
        const updated = student.id === oldId ? Object.assign({}, student, { id: $('studentIdInput').value, idSource: 'provided', name: $('studentNameInput').value, row: $('studentRowInput').value, col: $('studentColInput').value, active: $('studentActiveInput').checked }) : Object.assign({}, student);
        if (updated.friendTargets) updated.friendTargets = updated.friendTargets.map(id => id === oldId ? updatedId : id);
        return updated;
      }));
      const newId = students[state.students.findIndex(s => s.id === oldId)].id;
      if (oldId !== newId) {
        if (state.counts[oldId] != null) { state.counts[newId] = state.counts[oldId]; delete state.counts[oldId]; }
        if (state.lastSeen[oldId] != null) { state.lastSeen[newId] = state.lastSeen[oldId]; delete state.lastSeen[oldId]; }
        if (state.fairnessStats[oldId] != null) { state.fairnessStats[newId] = state.fairnessStats[oldId]; delete state.fairnessStats[oldId]; }
        if (state.lastId === oldId) state.lastId = newId;
        state.cycleSeen = state.cycleSeen.map(id => id === oldId ? newId : id);
        state.history.forEach(r => { if (r.studentId === oldId) r.studentId = newId; if (r.before && r.before.lastId === oldId) r.before.lastId = newId; if (r.before?.cycleBefore) r.before.cycleBefore = r.before.cycleBefore.map(id => id === oldId ? newId : id); if (r.endJump?.initialStudentId === oldId) r.endJump.initialStudentId = newId; if (r.animationOrder) r.animationOrder = r.animationOrder.map(id => id === oldId ? newId : id); if (r.friendSourceId === oldId) r.friendSourceId = newId; if (r.friendTargetIds) r.friendTargetIds = r.friendTargetIds.map(id => id === oldId ? newId : id); });
      }
      state.students = students; editingId = newId; state.cols = Math.max(state.cols, ...students.map(s => s.col));
      if (state.seatRows != null) state.seatRows = Math.max(state.seatRows, ...students.map(s => s.row));
      C.endDirection(state); const saved = save(); render();
      if (!saved) { $('studentError').textContent = saveError; return; }
      window.DialogTransitions.close($('studentDialog')); toast('同学信息已更新。');
    } catch (error) { $('studentError').textContent = error.message; }
  });
  $('classBtn').addEventListener('click', () => { if (!available()) return; $('classNameInput').value = state.className; show($('classDialog')); });
  $('classForm').addEventListener('submit', event => { event.preventDefault(); if (!available()) return; const name = $('classNameInput').value.trim(); if (!name) return; state.className = name; const saved = save(); render(); if (saved) window.DialogTransitions.close($('classDialog')); });
  $('fullscreenBtn').addEventListener('click', async () => { try { await fullscreenPort.toggle(); } catch (_) { toast('全屏未启用，可以使用浏览器的全屏选项。'); } });
  $('swapBtn').addEventListener('click', () => { if (!available()) return; FriendSeatConfig.hide(); swapMode = !swapMode; swapFirst = null; $('rosterMap').hidden = false; $('rosterList').hidden = true; $('seatViewBtn').classList.add('selected'); $('listViewBtn').classList.remove('selected'); $('seatViewBtn').setAttribute('aria-pressed', 'true'); $('listViewBtn').setAttribute('aria-pressed', 'false'); renderSeats(); renderRoster(); });
  function setRosterLayout(map) { if (!readOnlyAvailable()) return; FriendSeatConfig.hide(); $('rosterMap').hidden = !map; $('rosterList').hidden = map; $('seatViewBtn').classList.toggle('selected', map); $('listViewBtn').classList.toggle('selected', !map); $('seatViewBtn').setAttribute('aria-pressed', String(map)); $('listViewBtn').setAttribute('aria-pressed', String(!map)); if (!map) { swapMode = false; swapFirst = null; renderSeats(); renderRoster(); } }
  $('seatViewBtn').addEventListener('click', () => setRosterLayout(true)); $('listViewBtn').addEventListener('click', () => setRosterLayout(false));
  $('reflowBtn').addEventListener('click', () => { if (!available()) return; $('reflowColsInput').value = state.cols; show($('reflowDialog')); });
  $('reflowForm').addEventListener('submit', event => {
    event.preventDefault(); if (!available()) return;
    try {
      const cols = Number($('reflowColsInput').value); if (!Number.isInteger(cols) || cols < 1 || cols > 20) throw new Error('每行座位数需要在 1～20 之间。');
      const students = C.normalizeStudents(state.students.map((s, i) => Object.assign({}, s, { row: Math.floor(i / cols) + 1, col: i % cols + 1 })));
      state.students = students; state.cols = cols; state.seatRows = Math.max(1, Math.ceil(students.length / cols)); C.endDirection(state); swapFirst = null; const saved = save(); render();
      if (!saved) return;
      window.DialogTransitions.close($('reflowDialog')); toast('座位已按名单重新排列。');
    } catch (error) { toast(error.message); }
  });
  $('previewImportBtn').addEventListener('click', previewImport); $('applyImportBtn').addEventListener('click', applyImport);
  $('importBackBtn').addEventListener('click', () => { const tab = activeImportTab; switchImportTab(tab); });
  $('rosterFile').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file || !available()) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('名单文件超过 1 MB，请使用较小的 TXT / CSV 文件。');
      const bytes = await file.arrayBuffer(); let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (available()) { $('rosterText').value = text.replace(/^\uFEFF/, ''); $('importError').textContent = ''; }
    } catch (_) { $('importError').textContent = '无法读取名单，请确认文件小于 1 MB 且采用 UTF-8 编码，也可以直接粘贴姓名。'; }
    event.target.value = '';
  });
  $('imageFile').addEventListener('change', event => { readImage(event.target.files[0]); event.target.value = ''; });
  $('referenceFile').addEventListener('change', event => readReferenceFiles(Array.from(event.target.files)));
  $('clearReferenceBtn').addEventListener('click', clearReferenceSheets);
  $('imageDrop').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('imageFile').click(); } });
  ['dragenter', 'dragover'].forEach(type => $('imageDrop').addEventListener(type, event => { event.preventDefault(); $('imageDrop').classList.add('dragging'); }));
  $('imageDrop').addEventListener('dragleave', () => $('imageDrop').classList.remove('dragging'));
  $('imageDrop').addEventListener('drop', event => { event.preventDefault(); $('imageDrop').classList.remove('dragging'); readImage(event.dataTransfer.files[0]); });
  $('recognizeBtn').addEventListener('click', recognizeImage);
  $('cancelRecognitionBtn').addEventListener('click', cancelRecognition);
  $('copyPromptBtn').addEventListener('click', async () => {
    try { if (!navigator.clipboard) throw new Error(); await navigator.clipboard.writeText(visionPrompt()); toast('识别提示词及所选参考表已复制。未选择图片时可直接发送给模型。'); }
    catch (_) { $('promptFallback').value = visionPrompt(); $('promptFallback').hidden = false; $('promptFallback').focus(); $('promptFallback').select(); toast('提示词与参考表已显示并选中，请复制。'); }
  });
  $('exportSettingsBtn').addEventListener('click', () => runDataAction(() => exportData('settings')));
  $('exportRosterBtn').addEventListener('click', () => runDataAction(() => exportData('roster'), { readOnly: true }));
  $('backupBtn').addEventListener('click', () => runDataAction(() => exportData('all')));
  $('exportAnalysisBtn').addEventListener('click', () => runDataAction(exportAnalysis, { readOnly: true }));
  installBackupImport('importSettingsBtn', 'settingsBackupFile', 'settings');
  installBackupImport('importRosterBtn', 'rosterBackupFile', 'roster');
  installBackupImport('restoreBackupBtn', 'backupFile', 'all');
  $('exportHistoryBtn').addEventListener('click', exportHistory);
  
  function installResetHold(button) {
    button.title = '长按 500 ms 重置抽取，保留名单与设置'; button.setAttribute('aria-describedby', 'resetInstructions');
    let press = null;
    const allowed = () => !busy && !recoveryRequired && !quitConfirming() && !button.disabled && button.getClientRects().length && $$('dialog[open]').every(dialog => button.id === 'resetBtn' && dialog.id === 'configDialog');
    function clearResetHold() {
      const current = press; press = null; if (!current) return null;
      clearTimeout(current.timer); retractProgress(button, 'data-reset-holding');
      if (current.kind === 'pointer' && button.hasPointerCapture(current.id)) button.releasePointerCapture(current.id);
      return current;
    }
    function beginResetHold(kind, id, x = 0, y = 0) {
      if (press || !allowed()) return;
      cancelPendingDraw(); clearProgressRelease(button);
      const current = { kind, id, x, y, fired: false }; press = current;
      button.setAttribute('data-reset-holding', '');
      current.timer = setTimeout(() => {
        if (press !== current) return;
        if (!allowed()) { clearResetHold(); return; }
        current.fired = true; resetDraw();
      }, HOLD_MS);
    }
    button.addEventListener('pointerdown', event => { if (!event.isPrimary || event.button !== 0) return; beginResetHold('pointer', event.pointerId, event.clientX, event.clientY); if (press) button.setPointerCapture(event.pointerId); });
    button.addEventListener('pointermove', event => { if (press?.kind !== 'pointer' || press.id !== event.pointerId || press.fired) return; const r = button.getBoundingClientRect(); if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 14 || event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) clearResetHold(); });
    button.addEventListener('pointerup', event => { if (press?.kind !== 'pointer' || press.id !== event.pointerId) return; const current = clearResetHold(); if (!current.fired) toast('长按重置 500 ms，红色进度填满后清空抽取记录。'); });
    ['pointercancel', 'lostpointercapture'].forEach(type => button.addEventListener(type, clearResetHold));
    button.addEventListener('contextmenu', event => event.preventDefault());
    button.addEventListener('click', event => event.preventDefault());
    button.addEventListener('keydown', event => { if (event.defaultPrevented || !['Space', 'Enter'].includes(event.code)) return; event.preventDefault(); event.stopPropagation(); if (!event.repeat) beginResetHold('keyboard', event.code); });
    button.addEventListener('keyup', event => { if (press?.kind !== 'keyboard' || press.id !== event.code) return; event.preventDefault(); event.stopPropagation(); const current = clearResetHold(); if (!current.fired) toast('长按重置 500 ms，红色进度填满后清空抽取记录。'); });
    window.addEventListener('keyup', event => { if (press?.kind !== 'keyboard' || press.id !== event.code) return; event.preventDefault(); event.stopPropagation(); clearResetHold(); });
    window.addEventListener('blur', clearResetHold);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearResetHold(); });
    return { begin: code => beginResetHold('keyboard', code), cancel: clearResetHold };
  }
  const mainResetHold = installResetHold($('resetDrawBtn')), menuResetHold = installResetHold($('resetBtn'));
  let qHeld = false;
  const editable = event => event.target.closest('input,textarea,select,[contenteditable="true"]');
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || quitConfirming() || !['KeyR', 'KeyQ'].includes(event.code) || event.ctrlKey || event.altKey || event.metaKey || editable(event)) return;
    const dialogs = $$('dialog[open]');
    if (event.code === 'KeyR') {
      if (dialogs.some(dialog => dialog.id !== 'configDialog') || busy || hold || qHeld) return;
      event.preventDefault(); if (!event.repeat) (dialogs.length ? menuResetHold : mainResetHold).begin(event.code);
    } else {
      if (dialogs.length || busy || hold || $('exitChainBtn').hidden || $('exitChainBtn').disabled) return;
      event.preventDefault(); if (!event.repeat) { qHeld = true; $('exitChainBtn').classList.add('is-shortcut-pressed'); }
    }
  });
  const clearQ = () => { qHeld = false; $('exitChainBtn').classList.remove('is-shortcut-pressed'); };
  document.addEventListener('keyup', event => {
    if (event.code !== 'KeyQ' || !qHeld) return;
    event.preventDefault(); clearQ(); if (!quitConfirming() && !busy && !$$('dialog[open]').length) $('exitChainBtn').click();
  });
  window.addEventListener('blur', clearQ); document.addEventListener('visibilitychange', () => { if (document.hidden) clearQ(); });
  // Resolve glow from each button's displayed fill, or its border/text for a
  // transparent button. Custom theme colors therefore follow automatically.
  function buttonGlow(event) {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (event.type === 'pointerover' && event.relatedTarget && button.contains(event.relatedTarget)) return;
    const style = getComputedStyle(button), transparent = color => color === 'transparent' || /rgba\([^)]*,\s*0\s*\)/.test(color);
    let color = style.backgroundColor;
    if (transparent(color)) color = style.borderTopWidth !== '0px' && !transparent(style.borderTopColor) ? style.borderTopColor : style.color;
    button.style.setProperty('--button-glow', color);
  }
  ['pointerover', 'pointerdown', 'focusin'].forEach(type => document.addEventListener(type, buttonGlow));
  $('confirmActionBtn').addEventListener('click', async () => {
    const pending = confirmAction; if (!pending || !available({ allowRecovery: pending.allowRecovery })) return;
    confirmAction = null; await window.DialogTransitions.close($('confirmDialog')); await pending.action();
  });
  render(); setView('dashboard'); setInterval(() => { if ($('settingsDialog').open && $('settingsDialog').dataset.settingsContext === 'time') updateDigitPreview(); }, 1000);
  void refreshDataInfo();
  if (loadWarning) setTimeout(() => toast(loadWarning), 200);

  return {
    setView, openSettings, exitChain,
    toggleMode(mode, enabled) {
      if (mode === 'endJump') return commitModeSettings({ endJumpEnabled: enabled });
      const patch = mode === "friend" ? { friendEnabled: enabled } : { modes: C.MODES.filter(value => value === "normal" || value === mode && enabled || value !== mode && state.settings.modes.includes(value)) };
      return commitModeSettings(patch);
    },
    changeChance(mode, value) { return commitModeSettings({ [{ direction: "directionChance", time: "timeChance", friend: "friendChance", endJump: "endJumpChance" }[mode]]: value }); },
    strategy(value) { if (!available()) return; state.settings.strategy = value; const saved = save(); render(); if (saved && state.lock) toast('当前方向接力会先完成，之后使用新策略。'); },
    manualMode(value) { return commitModeSettings({ manualMode: value }); },
    openRosterImport() { if (available()) openImport(); },
    restoreAllFile(file) { return importBackupFile(file, 'all'); },
    restoreRosterFile(file) { return importBackupFile(file, 'roster'); },
    skipOnboarding() {
      if (!available() || state.settings.onboardingCompleted) return false;
      if (!persistOnboarding(true)) return false;
      render();
      return true;
    },
    async finishOnboarding(desktopPatch) {
      if (!available() || state.settings.onboardingCompleted) return false;
      // The completion flag is written first: a UAC relaunch during the desktop
      // step must come back to a main window that no longer asks for setup.
      if (!persistOnboarding(true)) return false;
      let elevationError = '';
      const bridge = desktopBridge();
      if (bridge && desktopPatch && Object.keys(desktopPatch).length) {
        try {
          const updated = await bridge.updateSettings(desktopPatch);
          elevationError = updated?.runtime?.error || '';
        } catch (error) { elevationError = error.message || '桌面设置保存失败。'; }
      }
      render();
      // The flow closes on the next flush; asking for the host right now would put
      // this warning inside the departing dialog.
      if (elevationError) void nextTick(() => toast('提权设置未生效：' + elevationError));
      return true;
    },
    async restartOnboarding() {
      if (!available()) return false;
      await window.DialogTransitions.close($('configDialog'));
      onboardingDismissed = false;
      onboardingSuppressed = false;
      if (!persistOnboarding(false)) return false;
      render();
      return true;
    },
    dismissOnboardingForSession() { onboardingDismissed = true; render(); },
    updateAppearance(patch) {
      if (!available()) return false;
      const previous = state.settings;
      try {
        state.settings = C.settings({ ...state.settings, ...patch });
        const saved = save();
        render();
        if (!saved) { state.settings = previous; render(); }
        return saved;
      } catch (error) {
        state.settings = previous;
        render();
        toast(error.message);
        return false;
      }
    }
  };
}
