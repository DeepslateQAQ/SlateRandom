import engine from '../domain/engine';
import type { ClassState } from '../../shared/domain/model';
import { demoStudents } from './demo';

/** Only the exact roster inserted by old releases is an automatic demo. */
export function migrateAutomaticDemo(state: ClassState): ClassState {
  if (!state.demo || state.students.length !== demoStudents.length) return state;
  const expected = new Map(demoStudents.map(student => [student.id, student]));
  if (!state.students.every(student => {
    const old = expected.get(student.id);
    return old && student.name === old.name && student.row === old.row && student.col === old.col;
  })) return state;
  const empty = engine.createEmptyState(state.rngState);
  empty.settings = engine.clone(state.settings);
  empty.cols = state.cols;
  return empty;
}
