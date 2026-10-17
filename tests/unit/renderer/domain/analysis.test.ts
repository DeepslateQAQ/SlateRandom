import assert from 'node:assert/strict';
import { test } from 'node:test';
import engine from '../../../../src/shared/domain/engine.js';
import { buildAnalysisReport, type AnalysisEnvironment } from '../../../../src/renderer/domain/analysis';
import type { ClassState } from '../../../../src/shared/domain/model';

const environment: AnalysisEnvironment = {
  appVersion: '1.0.0',
  edition: 'lite',
  build: { framework: 'Vue 3', appVersion: '1.0.0' },
  userAgent: 'test-browser',
  platform: 'test-platform',
  language: 'zh-CN',
  timezone: 'Asia/Shanghai',
  screen: { width: 1280, height: 720, pixelRatio: 1 },
  desktop: null
};

function configured(): ClassState {
  const students = [
    { id: '9001', name: '张三', row: 1, col: 1 },
    { id: '9002', name: '李四', row: 1, col: 2 }
  ];
  const state = engine.createState(students, 20261018);
  state.className = '高一二班';
  state.students[0].friendTargets = ['9002'];
  Object.assign(state.settings, {
    customCss: '.secret { background: url(https://example.com/private.png) }',
    customCssEnabled: true, backgroundTint: true
  });
  for (let count = 0; count < 3; count++) engine.draw(state);
  state.history.at(-1)!.reason = '友尽：张三 → 李四';
  return state;
}

test('分析报告移除姓名、学号、班级、抽取说明与 CSS 内容', () => {
  const state = configured();
  const report = buildAnalysisReport(state, environment);
  const text = JSON.stringify(report);
  for (const secret of ['张三', '李四', '9001', '9002', '高一二班', '友尽：张三', 'https://example.com/private.png']) {
    assert.equal(text.includes(secret), false, 'report must not contain ' + secret);
  }
  assert.equal(text.includes('customCss'), true);
  assert.equal((report.settings as Record<string, unknown>).customCss, undefined);
  assert.equal((report.settings as Record<string, unknown>).customCssChars, state.settings.customCss.length);
});

test('分析报告用稳定匿名键保留学生统计、友尽关系与历史', () => {
  const state = configured();
  const report = buildAnalysisReport(state, environment);
  const students = report.students as Array<Record<string, unknown>>;
  assert.deepEqual(students.map(student => student.key), ['S01', 'S02']);
  assert.deepEqual(students.map(student => student.label), ['同学 01', '同学 02']);
  assert.deepEqual(students[0].friendTargets, ['S02']);
  assert.equal((report.class as Record<string, unknown>).students, 2);
  assert.equal((report.lifetime as Record<string, unknown>).totalDraws, 3);
  const history = report.history as Array<Record<string, unknown>>;
  assert.equal(history.length, 3);
  assert.equal(history.every(record => record.reason === undefined), true);
  assert.equal(history.every(record => typeof record.student === 'string'), true);
});

test('分析报告限制历史条数但保留总数', () => {
  const state = configured();
  const report = buildAnalysisReport(state, environment, { historyLimit: 2 });
  assert.equal((report.history as unknown[]).length, 2);
  assert.equal((report.class as Record<string, unknown>).historyTotal, 3);
  assert.equal((report.class as Record<string, unknown>).historyIncluded, 2);
});
