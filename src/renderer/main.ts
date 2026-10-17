import { createApp } from 'vue';
import App from './App.vue';
import engine from './domain/engine';
import './scene/runtime.js';
import './styles/styles.css';
import './styles/icons.css';
import './styles/seat-transitions.css';
import './styles/time-transitions.css';
import './styles/providers.css';
import './styles/dialog-transitions.css';
import './styles/friend-transitions.css';
import './styles/friend-seat-config.css';
import './styles/render-style-ui.css';
import './styles/speech-providers.css';
import './styles/settings-layout.css';
import './styles/mode-settings.css';
import './styles/lifetime-stats.css';
import './styles/appearance.css';
import './styles/theme.css';
import { APPEARANCE_DEFAULT, applyAppearance, readAppearanceMirror } from './application/appearance';

// Read-only diagnostic compatibility for deterministic browser regression fixtures.
Object.defineProperty(window, 'DrawCore', { value: engine, configurable: false, writable: false });
applyAppearance(readAppearanceMirror() ?? APPEARANCE_DEFAULT, { mirror: false });
createApp(App).mount('#app');
