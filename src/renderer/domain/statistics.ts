import engine from './engine';
import type { ClassState, DomainEngine, StudentId } from '../../shared/domain/model';

export interface StudentStatistics {
  id: StudentId;
  name: string;
  row: number;
  col: number;
  active: boolean;
  draws: number;
  sessionDraws: number;
  positionSum: number;
  positionSamples: number;
  meanPosition: number | null;
  cycleSeen: boolean;
  lastSeen: number | null;
  roundsWaiting: number | null;
  cooling: boolean;
  probability: number;
  eligible: boolean;
  hasLifetimeStats: boolean;
}

export interface LifetimeStatistics {
  rows: StudentStatistics[];
  participants: number;
  activeParticipants: number;
  totalDraws: number;
  covered: number;
  positionSamples: number;
  positionSum: number;
  sessionRound: number;
  sessionDraws: number;
  cycleCovered: number;
  retainedRecords: number;
  cooldownWindow: number;
  directionCooldownRemaining: number;
}

/** Read retained totals; history is a capped log and must not become a total. */
export function aggregateStatistics(state: ClassState, core: Pick<DomainEngine, 'probabilities'> = engine): LifetimeStatistics {
  const active = state.students.filter(student => student.active);
  const seen = new Set(state.cycleSeen);
  const cooldownWindow = Math.min(state.settings.cooldown, Math.max(0, active.length - 1));
  const recent = cooldownWindow > 0 ? state.history.slice(-cooldownWindow).map(record => record.studentId) : [];
  if (cooldownWindow > 0 && state.lastId && recent.at(-1) !== state.lastId) recent.push(state.lastId);
  const cooling = new Set(cooldownWindow > 0 ? recent.slice(-cooldownWindow) : []);
  const probability = new Map(core.probabilities(state).map(item => [item.student.id, item.probability]));
  const rows = state.students.map((student): StudentStatistics => {
    const stored = state.fairnessStats[student.id];
    const sessionDraws = state.counts[student.id] ?? 0;
    const draws = stored?.draws ?? sessionDraws;
    const positionSum = stored?.positionSum ?? 0;
    const positionSamples = stored?.positionSamples ?? 0;
    const lastSeen = state.lastSeen[student.id] ?? null;
    return {
      id: student.id, name: student.name, row: student.row, col: student.col,
      active: student.active, draws, sessionDraws, positionSum, positionSamples,
      meanPosition: positionSamples > 0 ? positionSum / positionSamples : null,
      cycleSeen: seen.has(student.id), lastSeen,
      roundsWaiting: lastSeen !== null && lastSeen > 0 ? Math.max(0, state.round - lastSeen) : null,
      cooling: cooling.has(student.id), probability: probability.get(student.id) ?? 0,
      eligible: probability.has(student.id), hasLifetimeStats: stored !== undefined
    };
  });
  return {
    rows, participants: rows.length, activeParticipants: active.length,
    totalDraws: rows.reduce((sum, row) => sum + row.draws, 0),
    covered: rows.filter(row => row.draws > 0).length,
    positionSamples: rows.reduce((sum, row) => sum + row.positionSamples, 0),
    positionSum: rows.reduce((sum, row) => sum + row.positionSum, 0),
    sessionRound: state.round, sessionDraws: rows.reduce((sum, row) => sum + row.sessionDraws, 0),
    cycleCovered: rows.filter(row => row.active && row.cycleSeen).length,
    retainedRecords: state.history.length, cooldownWindow,
    directionCooldownRemaining: state.directionCooldownRemaining
  };
}
