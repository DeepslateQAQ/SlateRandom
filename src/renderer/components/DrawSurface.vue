<!-- Imperative scene island: camera and FLIP never compete with Vue. -->
<script setup lang="ts">
import MainCloseButton from './MainCloseButton.vue';
</script>
<template>
<svg xmlns="http://www.w3.org/2000/svg" class="sprite" aria-hidden="true">
  <symbol id="i-shuffle" viewBox="0 0 24 24"><path d="M3 6h3c5 0 7 12 12 12h3M17 14l4 4-4 4M3 18h3c2 0 3-2 4-4m4-4c1-2 2-4 4-4h3M17 2l4 4-4 4"/></symbol>
  <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></symbol>
  <symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M17 15a5 5 0 0 1 4 5"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
  <symbol id="i-help" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .5-1.5 1-1.5 2M12 17h.01"/></symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="i-compass" viewBox="0 0 24 24"><path d="M12 2v20M2 12h20M9 5l3-3 3 3M19 9l3 3-3 3M9 19l3 3 3-3M5 9l-3 3 3 3"/></symbol>
  <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 16V3M7 8l5-5 5 5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/></symbol>
  <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3v13M7 11l5 5 5-5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/></symbol>
  <symbol id="i-expand" viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/></symbol>
  <symbol id="i-settings" viewBox="0 0 24 24"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12l4 4L19 6"/></symbol>
  <symbol id="i-close" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></symbol>
  <symbol id="i-undo" viewBox="0 0 24 24"><path d="M3 10h10a7 7 0 1 1-6 11M7 5l-5 5 5 5"/></symbol>
  <symbol id="i-spark" viewBox="0 0 24 24"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></symbol>
  <symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 3-5 6 6"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/></symbol>
</svg>
<main class="draw-screen" aria-label="随机抽人">
  <section id="liveBoard" class="live-board" aria-label="座位表与抽取过程" hidden>
    <div id="drawVisual" class="draw-visual" hidden>
      <div id="directionVisual" class="direction-visual" hidden><span id="directionSpinner" class="direction-spinner material-icon" aria-hidden="true">arrow_upward</span><span id="directionCaption"><span id="directionCaptionText"></span><span id="directionRemainder" hidden> · 还剩 <strong id="chainRemaining" hidden></strong> 轮</span></span></div>
      <div id="timeVisual" class="time-visual" hidden><div class="time-reveal-row"><div id="timeDigits" class="time-digits" aria-label="用于抽取的日期或时间"></div><div id="timeMatchName" class="time-match-name"></div></div><p id="timeCaption"></p></div>
    </div>
    <div id="liveSeatScroll" class="live-seat-scroll"><div id="liveSeatMap" class="live-seat-map"><div id="liveSeats" class="seat-grid live-seats"></div><svg id="seatArrow" class="seat-arrow" aria-hidden="true" hidden><defs><marker id="seatArrowHead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7Z"/></marker></defs><path id="seatArrowPath" marker-end="url(#seatArrowHead)"/></svg></div></div>
  </section>
  <div id="drawStage" class="draw-stage" hidden>
    <div id="stageName" class="stage-name" aria-hidden="true"></div>
    <span id="stageId" class="stage-id" aria-hidden="true"></span>
  </div>
  <div class="home-actions"><MainCloseButton /><button id="resetDrawBtn" aria-keyshortcuts="R" class="reset-draw-btn" title="长按 500 ms 重置，保留名单与设置" aria-describedby="resetInstructions" hidden aria-label="重置抽取"><span class="icon material-icon" aria-hidden="true">restart_alt</span><span class="action-label">重置</span></button><button id="drawBtn" aria-keyshortcuts="Space Enter" class="draw-button" aria-describedby="drawInstructions" aria-haspopup="dialog" aria-controls="configDialog" aria-expanded="false"><span class="icon material-icon" aria-hidden="true">shuffle</span><span id="drawButtonText">抽人</span></button><button id="exitChainBtn" aria-keyshortcuts="Q" class="exit-chain" hidden aria-label="退出连坐" title="退出连坐"><span class="icon material-icon" aria-hidden="true">link_off</span><span class="action-label">退出连坐</span></button></div>
  <p id="resetInstructions" class="sr-only">长按 500 ms，清空本轮记录、重置后次数与连坐状态；保留名单、设置和长期公平统计。提前松开或移动取消。</p>
  <p id="drawInstructions" class="sr-only">短按抽人。按住 500 ms 打开配置菜单，按钮背景表示长按进度；按住不足 200 ms 松手抽人，200～500 ms 松手只撤回进度。支持触屏、鼠标、空格键与回车键。</p>
</main>
</template>
