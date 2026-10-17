import engine from './engine';
import type { ClassState, Student, StudentId } from '../../shared/domain/model';

interface ImportedStudent {
  id: StudentId | null;
  name: string;
  row?: number;
  col?: number;
  active?: boolean;
  friendTargets?: StudentId[];
  idSource?: 'auto' | 'provided';
}
export interface ImportRosterStudent extends Omit<Student, 'row' | 'col'> { row?: number; col?: number }
interface ImportPlanBase {
  warnings: string[];
  /** Old IDs to the IDs assigned to the same, explicitly matched person. */
  identityMap: Record<StudentId, StudentId>;
}
export interface ReadyImportPlan extends ImportPlanBase {
  kind: 'ready'; students: Student[]; rows: number; cols: number;
}
export interface LayoutImportPlan extends ImportPlanBase {
  kind: 'layout'; roster: ImportRosterStudent[];
}
export type ImportPlan = ReadyImportPlan | LayoutImportPlan;
export interface ImportOptions { trimEmptyAxes?: boolean }

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function positiveInteger(value: unknown, max: number, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(label + '应为 1～' + max + ' 的整数。');
  return number;
}
function readId(value: unknown, label: string): StudentId | null {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d{1,12}$/.test(text) || Number(text) < 1) throw new Error(label + '应为 1～12 位正整数。');
  return String(Number(text));
}
function readStudent(value: unknown, index: number): ImportedStudent {
  if (!isObject(value)) throw new Error('第 ' + (index + 1) + ' 位学生格式无效。');
  const name = String(value.name ?? '').trim();
  if (!name || name.length > 64 || /[\u0000-\u001F]/.test(name)) throw new Error('第 ' + (index + 1) + ' 位学生的姓名为空或格式无效。');
  const hasRow = value.row != null && String(value.row).trim() !== '';
  const hasCol = value.col != null && String(value.col).trim() !== '';
  if (hasRow !== hasCol) throw new Error(name + ' 的行列坐标不完整，请同时提供 row、col 或同时省略。');
  const student: ImportedStudent = { id: readId(value.id, name + ' 的学号'), name };
  if (hasRow) { student.row = positiveInteger(value.row, 50, name + ' 的行号'); student.col = positiveInteger(value.col, 20, name + ' 的列号'); }
  if (value.active != null) student.active = value.active !== false;
  if (value.idSource === 'auto' || value.idSource === 'provided') student.idSource = value.idSource;
  if (value.friendTargets != null) {
    if (!Array.isArray(value.friendTargets)) throw new Error(name + ' 的友尽目标应为数组。');
    student.friendTargets = value.friendTargets.map(target => {
      const id = readId(target, name + ' 的友尽目标');
      if (!id) throw new Error(name + ' 的友尽目标学号为空。');
      return id;
    });
  }
  return student;
}

export function parseImportJson(text: string): unknown {
  const source = String(text).trim(), fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try { return JSON.parse(fenced ? fenced[1]!.trim() : source); }
  catch { throw new Error('识别结果不是有效 JSON，请保留完整的对象或数组。'); }
}

/** No ID or seat is inferred by the model; these deterministic steps run locally. */
export function prepareImport(input: unknown, state: ClassState, options: ImportOptions = {}): ImportPlan {
  const document = isObject(input) ? input : {};
  const values = Array.isArray(input) ? input : document.students ?? document.seats;
  if (!Array.isArray(values) || !values.length || values.length > 500) throw new Error('识别结果应包含 1～500 位学生的 students 数组。');
  const raw = values.map(readStudent);
  const warnings = Array.isArray(document.uncertain) ? document.uncertain.slice(0, 50).map(String) : [];
  values.forEach(value => {
    if (!isObject(value)) return;
    if (value.sourceId != null && String(value.sourceId).length > 2) warnings.push(String(value.name ?? '待核对').slice(0, 64) + '：原学号 ' + String(value.sourceId).slice(0, 40) + ' → 候选 ' + String(value.id ?? '未确定').slice(0, 12) + '，请核对。');
    if (Array.isArray(value.idCandidates) && value.idCandidates.length) warnings.push(String(value.name ?? '待核对').slice(0, 64) + ' 的可能学号：' + value.idCandidates.slice(0, 10).map(String).join('、') + '。');
  });
  const oldNames = new Map<string, Student[]>(), newNames = new Map<string, number>();
  state.students.forEach(student => oldNames.set(student.name, [...oldNames.get(student.name) ?? [], student]));
  raw.forEach(student => newNames.set(student.name, (newNames.get(student.name) ?? 0) + 1));
  const matched = raw.map(student => {
    const old = oldNames.get(student.name) ?? [];
    if (old.length === 1 && newNames.get(student.name) === 1) return old[0];
    // An actual supplied ID can disambiguate equal names; generated IDs cannot.
    const exact = student.idSource !== 'auto' && student.id ? old.find(item => item.id === student.id && item.idSource !== 'auto') : undefined;
    if (exact) return exact;
    if (old.length > 1 || (newNames.get(student.name) ?? 0) > 1) warnings.push(student.name + ' 存在重名，未自动沿用旧学号、座位或统计，请核对。');
    return undefined;
  });
  const roster: ImportRosterStudent[] = raw.map((student, index) => {
    const old = matched[index];
    const supplied = student.id != null;
    const retained = !supplied && old && old.idSource !== 'auto';
    return {
      id: supplied ? student.id! : retained ? old.id : '', name: student.name,
      idSource: supplied ? student.idSource ?? 'provided' : retained ? old.idSource ?? 'provided' : 'auto',
      active: student.active ?? old?.active ?? true,
      ...(student.row != null ? { row: student.row, col: student.col } : {}),
      ...(student.friendTargets ? { friendTargets: student.friendTargets } : {})
    };
  });
  const reserved = new Set<StudentId>();
  roster.forEach(student => {
    if (!student.id) return;
    if (reserved.has(student.id)) throw new Error('学号 ' + student.id + ' 重复，请核对识别结果，不能将两位同学合并。');
    reserved.add(student.id);
  });
  const hasCoordinates = raw.every(student => student.row != null && student.col != null);
  if (!hasCoordinates && raw.some(student => student.row != null)) throw new Error('识别结果只有部分学生带座位坐标，请补全坐标或省略全部坐标。');
  const hasMatchedSeats = !hasCoordinates && matched.every(Boolean);
  if (hasMatchedSeats) roster.forEach((student, index) => { student.row = matched[index]!.row; student.col = matched[index]!.col; });
  let next = 1, generated = 0, retained = 0;
  roster.map((student, index) => ({ student, index })).sort((a, b) => (a.student.row ?? 0) - (b.student.row ?? 0) || (a.student.col ?? 0) - (b.student.col ?? 0) || a.index - b.index).forEach(({ student, index }) => {
    if (!raw[index]!.id && matched[index]?.idSource !== 'auto' && matched[index]) retained++;
    if (student.id) return;
    while (reserved.has(String(next))) next++;
    student.id = String(next++); reserved.add(student.id); generated++;
  });
  if (retained) warnings.push(retained + ' 位未提供学号的同学已按姓名沿用已确认的旧学号。');
  if (generated) warnings.push(generated + ' 位未识别学号的同学已按座位从左上逐行自动编号，单个空座不占号；请核对。');
  const identityMap: Record<StudentId, StudentId> = {};
  matched.forEach((old, index) => { if (old) identityMap[old.id] = roster[index]!.id; });
  // Partial updates cannot take the confirmed ID of an omitted classmate.
  if (Object.keys(identityMap).length) roster.forEach(student => {
    if (student.idSource === 'auto') return;
    const owner = state.students.find(old => old.id === student.id);
    if (owner && owner.name !== student.name && owner.idSource !== 'auto' && !identityMap[owner.id]) throw new Error('新学号 ' + student.id + ' 已属于 ' + owner.name + '，请核对并同时提供其更新后的学号。');
  });
  const base = { warnings: [...new Set(warnings)], identityMap };
  if (!hasCoordinates && !hasMatchedSeats) return { ...base, kind: 'layout', roster };
  if (hasMatchedSeats) return readyPlan(roster, state.cols, base, state.seatRows);
  const rows = [...new Set(roster.map(student => student.row!))].sort((a, b) => a - b);
  const cols = [...new Set(roster.map(student => student.col!))].sort((a, b) => a - b);
  const sourceRows = document.rows == null ? rows.at(-1)! : positiveInteger(document.rows, 50, '座位行数');
  const sourceCols = document.cols == null ? cols.at(-1)! : positiveInteger(document.cols, 20, '座位列数');
  if (sourceRows < rows.at(-1)! || sourceCols < cols.at(-1)!) throw new Error('座位尺寸小于学生坐标，请核对行列数。');
  if (options.trimEmptyAxes !== false) {
    const rowMap = new Map(rows.map((row, index) => [row, index + 1])), colMap = new Map(cols.map((col, index) => [col, index + 1]));
    roster.forEach(student => { student.row = rowMap.get(student.row!)!; student.col = colMap.get(student.col!)!; });
    if (sourceRows > rows.length || sourceCols > cols.length) base.warnings.push('已移除 ' + (sourceRows - rows.length) + ' 个全空行和 ' + (sourceCols - cols.length) + ' 个全空列，单个空座保留。');
  }
  const orientation = document.orientation;
  if (isObject(orientation) && (orientation.normalized === false || orientation.podiumSideInImage === 'unknown')) base.warnings.push('讲台方向未能确定，请核对预览中的前后与左右方向。');
  return readyPlan(roster, options.trimEmptyAxes === false ? sourceCols : cols.length, base);
}

function readyPlan(roster: ImportRosterStudent[], cols: number, base: ImportPlanBase, seatRows = 0): ReadyImportPlan {
  const students = engine.normalizeStudents(roster);
  return { ...base, kind: 'ready', students, rows: Math.max(seatRows, ...students.map(student => student.row)), cols };
}

export function completeImportLayout(plan: LayoutImportPlan, dimensions: { rows: number; cols: number }): ReadyImportPlan {
  const rows = positiveInteger(dimensions.rows, 50, '座位行数'), cols = positiveInteger(dimensions.cols, 20, '座位列数');
  if (rows * cols < plan.roster.length) throw new Error('座位容量 ' + rows * cols + ' 小于名单人数 ' + plan.roster.length + '，请增加行数或列数。');
  const roster = [...plan.roster].sort((a, b) => Number(a.id) - Number(b.id)).map((student, index) => ({ ...student, row: Math.floor(index / cols) + 1, col: index % cols + 1 }));
  return { ...readyPlan(roster, cols, { warnings: plan.warnings, identityMap: plan.identityMap }), rows };
}

/** Text names retain quick import; supplied IDs use the same identity/seat rules. */
export function prepareTextImport(text: string, state: ClassState, cols: number): ImportPlan {
  const parsed = engine.parseRoster(text, cols);
  if (parsed.every(student => student.idSource === 'auto')) return prepareImport({ students: parsed.map(student => ({ ...student, id: null })), cols }, state, { trimEmptyAxes: false });
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter((line, index) => index !== 0 || !/^(?:学号|id|student.?id)[,，\t]/i.test(line));
  const explicitSeats = lines.every(line => {
    // Quoted delimiters never count as column separators.
    let quoted = false, count = 1;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (character === '"') { if (quoted && line[index + 1] === '"') index++; else quoted = !quoted; }
      else if (!quoted && /[,，\t]/.test(character!)) count++;
    }
    return count === 4;
  });
  return prepareImport({ students: parsed.map(student => ({ ...student, id: student.idSource === 'auto' ? null : student.id,
    row: explicitSeats ? student.row : undefined, col: explicitSeats ? student.col : undefined })) }, state, { trimEmptyAxes: false });
}
