import type { ClassRepository, FilePort, FullscreenPort } from '../platform/ports';
import type { Mode, Settings } from '../../shared/domain/model';
import type { DesktopSettings } from '../desktop/types';
import type { AppStore, ConfigView } from './store';

export type DetailMode = Mode | 'friend' | 'general';
export interface ApplicationActions {
  setView(view: ConfigView): void;
  openSettings(mode?: DetailMode): void;
  exitChain(): void;
  toggleMode(mode: Exclude<Mode, 'normal'> | 'friend' | 'endJump', enabled: boolean): boolean;
  changeChance(mode: Exclude<Mode, 'normal'> | 'friend' | 'endJump', value: number): boolean;
  strategy(value: 'auto' | 'manual'): void;
  manualMode(value: Mode): boolean;
  updateAppearance(patch: Partial<Pick<Settings, 'theme' | 'accent' | 'radius' | 'customCss' | 'customCssEnabled' | 'backgroundTint'>>): boolean;
  openRosterImport(): void;
  restoreAllFile(file: File): Promise<void>;
  restoreRosterFile(file: File): Promise<void>;
  restoreSettingsFile(file: File): Promise<void>;
  finishOnboarding(desktopPatch?: Partial<DesktopSettings>): Promise<boolean>;
  skipOnboarding(): boolean;
  restartOnboarding(): Promise<boolean>;
  dismissOnboardingForSession(): void;
}
export interface ControllerDependencies {
  store: AppStore;
  repository: ClassRepository;
  filePort: FilePort;
  fullscreenPort: FullscreenPort;
}
export function mountController(dependencies: ControllerDependencies): ApplicationActions;
