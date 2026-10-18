<script setup lang="ts">
import brandingBanner from '../../../resources/branding/banner.svg?inline';
import secrandomLogo from '../../../resources/friends/secrandom.png?inline';
import iccLogo from '../../../resources/friends/icc.png?inline';
import type { ApplicationActions } from '../application/controller.js';

withDefaults(defineProps<{
  actions?: ApplicationActions;
  busy?: boolean;
  recoveryRequired?: boolean;
}>(), { actions: undefined, busy: false, recoveryRequired: false });

const desktop = Boolean(window.slateDesktop);

// The build embeds package.json metadata; the plain development page has none.
const version = ((): string => {
  try {
    const metadata = JSON.parse(document.getElementById('buildMetadata')?.textContent || 'null');
    return typeof metadata?.appVersion === 'string' ? metadata.appVersion : '1.0.0';
  } catch {
    return '1.0.0';
  }
})();
</script>

<template>
  <section id="view-about" class="view" aria-label="关于 SlateRandom 岩选">
    <img class="about-banner" :src="brandingBanner" alt="">
    <div class="about-brand"><span class="material-icon" aria-hidden="true">shuffle</span><div><h2>SlateRandom 岩选 <span class="edition-badge" v-if="!desktop">LITE</span></h2><p>更好玩好用的随机抽选</p></div></div>
    <dl class="about-details"><div><dt>版本</dt><dd>{{ version }}</dd></div><div><dt>作者</dt><dd><a href="https://github.com/DeepslateQAQ" target="_blank" rel="noopener noreferrer">DeepslateQAQ</a></dd></div><div><dt>开源许可</dt><dd>GPL-3.0-or-later</dd></div><div><dt>应用框架</dt><dd>{{ desktop ? 'Vue · TypeScript · Electron' : 'Vue · TypeScript' }}</dd></div></dl>
    <article class="settings-info-section about-friends">
      <h3>友情链接</h3>
      <p>如果对岩选不够满意，您也可以尝试：</p>
      <ul class="about-friend-links">
        <li>
          <img class="about-friend-logo" :src="secrandomLogo" alt="" width="32" height="32">
          <strong>SecRandom</strong>
          <span class="about-friend-actions">
            <a href="https://github.com/SECTL/SecRandom" target="_blank" rel="noopener noreferrer" aria-label="SecRandom GitHub 仓库" title="GitHub 仓库"><svg class="about-friend-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#aboutGithubIcon"/></svg></a>
            <a href="https://secrandom.sectl.cn" target="_blank" rel="noopener noreferrer" aria-label="SecRandom 官网" title="SecRandom 官网"><svg class="about-friend-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#aboutGlobeIcon"/></svg></a>
          </span>
        </li>
        <li>
          <img class="about-friend-logo" :src="iccLogo" alt="" width="32" height="32">
          <strong>ICC-CE</strong>
          <span class="about-friend-actions">
            <a href="https://github.com/InkCanvasForClass/community" target="_blank" rel="noopener noreferrer" aria-label="ICC-CE GitHub 仓库" title="GitHub 仓库"><svg class="about-friend-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#aboutGithubIcon"/></svg></a>
            <a href="https://iccce.ink" target="_blank" rel="noopener noreferrer" aria-label="ICC-CE 官网" title="ICC-CE 官网"><svg class="about-friend-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#aboutGlobeIcon"/></svg></a>
          </span>
        </li>
      </ul>
      <svg class="about-friend-symbols" aria-hidden="true" width="0" height="0">
        <symbol id="aboutGithubIcon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></symbol>
        <symbol id="aboutGlobeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></symbol>
      </svg>
    </article>
    <article class="settings-info-section"><h3>首次引导</h3><p>重新查看外观、名单和概率设置。</p>
      <button id="rerunOnboardingBtn" class="btn btn-plain onboarding-rerun" :disabled="busy || recoveryRequired || !actions"
        @click="actions?.restartOnboarding()">重新运行首次引导</button></article>
    <article class="settings-info-section"><h3>关于随机与公平</h3><p>使用有状态伪随机数与动态权重，结合未抽优先、近期冷却和跨会话统计，让机会逐渐趋于平均。座位、学号与模式规则会影响单次抽取的候选范围。</p></article>
    <article class="settings-info-section"><h3>开源与致谢</h3><p>Copyright © 2026 DeepslateQAQ。项目原创代码以 GNU GPL 第 3 版或更新版本许可发布，可按许可条款修改与再分发，不提供担保。发行目录包含完整 LICENSE；Lite 单文件内嵌 projectLicense 许可文本块。图标使用 Google Material Symbols，表格导入使用 SheetJS；第三方组件保留各自许可与版权声明，相应说明随程序一同提供。</p></article>
  </section>
</template>
