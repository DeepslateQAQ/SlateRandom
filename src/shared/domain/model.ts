/** Persisted v1 class data. IDs stay normalized decimal strings for old backups. */
export type StudentId = string;
export type Mode = 'normal' | 'direction' | 'time';
export type RecordMode = Mode | 'friend';
export type RenderStyle = 'normal' | 'overview';
export type Direction = 'up' | 'right' | 'down' | 'left';
export type TimeSource = 'time' | 'date' | 'datetime';
export type TimeSelection = 'random' | 'fixed';
export type ThemePreference = 'classic' | 'light' | 'dark' | 'system';

export interface Student {
  id: StudentId;
  /** Missing in old backups means provided; only generated IDs use auto. */
  idSource?: 'auto' | 'provided';
  name: string;
  row: number;
  col: number;
  active: boolean;
  friendTargets?: StudentId[];
}

export interface Settings {
  strategy: 'auto' | 'manual';
  manualMode: Mode;
  modes: Mode[];
  renderStyle: RenderStyle;
  cooldown: number;
  strength: number;
  direction: Direction | 'auto';
  /** Legacy direct callers may still use a fixed count; normalization uses random. */
  directionRounds: 'random' | number;
  directionMin: number;
  directionMax: number;
  directionCooldownMin: number;
  directionCooldownMax: number;
  directionChance: number;
  timeChance: number;
  friendEnabled: boolean;
  friendChance: number;
  endJumpEnabled: boolean;
  endJumpChance: number;
  timeSource: TimeSource;
  timeSelection: TimeSelection;
  positions: string;
  voice: boolean;
  theme: ThemePreference;
  accent: string;
  radius: number;
  customCss: string;
  customCssEnabled: boolean;
  backgroundTint: boolean;
  /** Missing on older data, where settings() normalizes it to true; only a brand-new state is false. */
  onboardingCompleted: boolean;
}

export interface FairnessStats {
  draws: number;
  positionSum: number;
  positionSamples: number;
}

export interface DirectionLock {
  direction: Direction;
  remaining: number;
}

export interface ExtractedNumber {
  digits: string;
  positions: number[];
  picked: string;
  number: number;
}

export interface TimeRule extends ExtractedNumber {
  /** Optional only for backups made before time-source metadata was added. */
  source?: TimeSource;
  selection?: TimeSelection;
  replacedPositions?: string;
}

export interface UndoSnapshot {
  rngState: number;
  lock: DirectionLock | null;
  lastId: StudentId | null;
  round: number;
  count: number;
  lastSeen: number;
  directionCooldownRemaining: number;
  cycleBefore?: StudentId[];
  cycleAdded?: boolean;
  fairnessStats?: FairnessStats | null;
}

export interface EndJump {
  kind: 'back' | 'continue';
  initialStudentId: StudentId;
  initialDirection: Direction | null;
  initialTimeRule: TimeRule | null;
  previousTimeRule?: TimeRule;
}

interface DrawRecordBase {
  round: number;
  studentId: StudentId;
  name: string;
  row: number;
  col: number;
  direction: Direction | null;
  fallback: boolean;
  timeRule: TimeRule | null;
  reason: string;
  time: string;
  fairnessPosition?: number;
  before: UndoSnapshot | null;
  directionCooldownStarted?: number;
  endJump?: EndJump;
  animationOrder?: StudentId[];
  switchedFrom?: RecordMode;
}

export interface OrdinaryDrawRecord extends DrawRecordBase {
  mode: Mode;
  friendSourceId?: never;
  friendTargetIds?: never;
}

export interface FriendDrawRecord extends DrawRecordBase {
  mode: 'friend';
  friendSourceId: StudentId;
  friendTargetIds: StudentId[];
}

export type DrawRecord = OrdinaryDrawRecord | FriendDrawRecord;

export interface ClassState {
  version: 1;
  className: string;
  demo: boolean;
  students: Student[];
  cols: number;
  /** Explicit classroom height; omitted by older backups that infer occupied rows. */
  seatRows?: number;
  settings: Settings;
  rngState: number;
  counts: Partial<Record<StudentId, number>>;
  lastSeen: Partial<Record<StudentId, number>>;
  fairnessStats: Partial<Record<StudentId, FairnessStats>>;
  cycleSeen: StudentId[];
  round: number;
  lastId: StudentId | null;
  lock: DirectionLock | null;
  directionCooldownRemaining: number;
  history: DrawRecord[];
}

export interface CandidateProbability {
  student: Student;
  probability: number;
}

export interface TimeOption {
  rule: TimeRule;
  student: Student;
}

export interface FriendOptions {
  source: Student | null;
  candidates: Student[];
}

export interface VisionRoster {
  students: Student[];
  cols: number;
  warnings: string[];
}

/** Boundary to the single, separately tested UMD engine implementation. */
export interface DomainEngine {
  MODES: readonly Mode[];
  RECORD_MODES: readonly RecordMode[];
  DIRECTIONS: Record<Direction, readonly [number, number, string]>;
  DEFAULTS: Omit<Settings, 'renderStyle'> & Partial<Pick<Settings, 'renderStyle'>>;
  clone<T>(value: T): T;
  createState(students: unknown, initialSeed?: number): ClassState;
  createEmptyState(initialSeed?: number): ClassState;
  settings(input?: unknown): Settings;
  modeChances(state: ClassState): Record<Mode, number>;
  random(state: ClassState): number;
  normalizeStudents(input: unknown): Student[];
  replaceStudents(state: ClassState, students: unknown, identityMap?: Record<StudentId, StudentId>): ClassState;
  probabilities(state: ClassState): CandidateProbability[];
  adjacent(state: ClassState, previous: Student | null | undefined, direction: Direction | 'auto'): Student | null;
  dateDigits(date: Date, source: TimeSource): string;
  extractNumber(date: Date, source: TimeSource, positions: string): ExtractedNumber;
  timeOptions(state: ClassState, date: Date, distribution?: CandidateProbability[]): TimeOption[];
  friendOptions(state: ClassState, distribution?: CandidateProbability[]): FriendOptions;
  previewMode(state: ClassState, date?: Date): RecordMode;
  draw(state: ClassState, date?: Date, options?: { endJump?: boolean }): DrawRecord;
  undo(state: ClassState): DrawRecord | null;
  reset(state: ClassState): void;
  endDirection(state: ClassState): number;
  parseRoster(text: string, cols?: number): Student[];
  parseVision(text: string): VisionRoster;
  restoreState(input: unknown): ClassState;
}
