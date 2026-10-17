import type { ClassState, RecordMode, Settings } from '../../shared/domain/model';
import { aggregateStatistics } from './statistics';

export interface AnalysisEnvironment {
  appVersion: string;
  edition: 'desktop' | 'lite';
  build: Record<string, unknown> | null;
  userAgent: string;
  platform: string;
  language: string;
  timezone: string;
  screen: { width: number; height: number; pixelRatio: number };
  desktop: {
    runtime: { elevated: boolean; uiAccess: boolean; autostart: boolean; status: string; requiresRestart: boolean };
    settings: { uac: boolean; uiAccess: boolean; autostart: boolean; showFloatingBall: boolean };
  } | null;
}

export interface AnalysisOptions {
  historyLimit?: number;
}

const APP_SETTING_KEYS = [
  'strategy', 'manualMode', 'modes', 'renderStyle', 'cooldown', 'strength',
  'direction', 'directionRounds', 'directionMin', 'directionMax',
  'directionCooldownMin', 'directionCooldownMax', 'directionChance', 'timeChance',
  'friendEnabled', 'friendChance', 'endJumpEnabled', 'endJumpChance',
  'timeSource', 'timeSelection', 'positions', 'voice', 'theme', 'accent',
  'radius', 'customCssEnabled', 'backgroundTint'
] as const satisfies readonly (keyof Settings)[];

const MODE_LABELS: Record<RecordMode, string> = {
  normal: '普通随机', direction: '方向接力', time: '时间学号', friend: '友尽模式'
};

function studentKeys(state: ClassState): { key: (id: string) => string | null; label: (key: string) => string } {
  const ordered = state.students.slice().sort((a, b) => a.id.localeCompare(b.id, 'zh-CN', { numeric: true }));
  const keys = new Map(ordered.map((student, index) => [student.id, 'S' + String(index + 1).padStart(2, '0')]));
  return {
    key: id => keys.get(id) ?? null,
    label: key => '同学 ' + key.slice(1)
  };
}

/**
 * Build a support report from the live class. Names, student IDs, class names,
 * friend-target identities, draw reasons, CSS content, credentials and local
 * paths never enter the payload; stable anonymous keys preserve relationships.
 */
export function buildAnalysisReport(state: ClassState, environment: AnalysisEnvironment,
  options: AnalysisOptions = {}): Record<string, unknown> {
  const keys = studentKeys(state);
  const lifetime = aggregateStatistics(state);
  const historyLimit = Math.max(0, Math.min(2000, Math.floor(options.historyLimit ?? 200)));
  const history = state.history.slice(-historyLimit).map(record => {
    const friend = record as typeof record & { friendSourceId?: string; friendTargetIds?: string[] };
    return {
      round: record.round,
      student: keys.key(record.studentId),
      mode: record.mode,
      modeLabel: MODE_LABELS[record.mode],
      row: record.row,
      col: record.col,
      time: record.time,
      fallback: record.fallback,
      direction: record.direction,
      timeRule: record.timeRule ? {
        source: record.timeRule.source ?? null,
        selection: record.timeRule.selection ?? null,
        positions: record.timeRule.positions,
        picked: record.timeRule.picked
      } : null,
      friendSource: friend.friendSourceId ? keys.key(friend.friendSourceId) : null,
      friendTargets: friend.friendTargetIds?.map(id => keys.key(id)).filter(Boolean) ?? []
    };
  });
  const settings = Object.fromEntries(APP_SETTING_KEYS.map(key => [key, state.settings[key]]));
  return {
    format: 'SlateRandom.analysis',
    version: 1,
    createdAt: new Date().toISOString(),
    privacy: {
      anonymized: ['姓名', '学号', '班级名称', '友尽目标姓名', '抽取说明', '自定义 CSS', '密钥', '凭据', '文件路径'],
      note: '学生使用稳定的匿名键 S01、S02……保留统计关系；不包含任何可恢复数据或凭据。'
    },
    application: {
      version: environment.appVersion,
      edition: environment.edition,
      build: environment.build
    },
    environment: {
      userAgent: environment.userAgent,
      platform: environment.platform,
      language: environment.language,
      timezone: environment.timezone,
      screen: environment.screen,
      desktop: environment.desktop
    },
    class: {
      students: state.students.length,
      activeStudents: state.students.filter(student => student.active).length,
      cols: state.cols,
      seatRows: state.seatRows,
      round: state.round,
      historyTotal: state.history.length,
      historyIncluded: history.length
    },
    settings: {
      ...settings,
      customCssChars: state.settings.customCss.length
    },
    lifetime: {
      participants: lifetime.participants,
      activeParticipants: lifetime.activeParticipants,
      totalDraws: lifetime.totalDraws,
      covered: lifetime.covered,
      positionSamples: lifetime.positionSamples,
      positionSum: lifetime.positionSum,
      sessionRound: lifetime.sessionRound,
      sessionDraws: lifetime.sessionDraws,
      cycleCovered: lifetime.cycleCovered,
      retainedRecords: lifetime.retainedRecords,
      cooldownWindow: lifetime.cooldownWindow,
      directionCooldownRemaining: lifetime.directionCooldownRemaining
    },
    students: lifetime.rows.map(row => {
      const student = state.students.find(item => item.id === row.id)!;
      return {
        key: keys.key(row.id),
        label: keys.label(keys.key(row.id)!),
        active: row.active,
        row: row.row,
        col: row.col,
        friendTargets: student.friendTargets?.map(id => keys.key(id)).filter(Boolean) ?? [],
        draws: row.draws,
        sessionDraws: row.sessionDraws,
        positionSamples: row.positionSamples,
        positionSum: row.positionSum,
        meanPosition: row.meanPosition,
        cycleSeen: row.cycleSeen,
        lastSeen: row.lastSeen,
        roundsWaiting: row.roundsWaiting,
        cooling: row.cooling,
        eligible: row.eligible,
        probability: row.probability
      };
    }),
    history
  };
}
