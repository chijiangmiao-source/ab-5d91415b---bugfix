// test/analyze.test.mjs — 视图模型：诊断对摘要与证据连续性核验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.mjs';

const FINITE_NORMAL_PATH = `
loc S
loc F
loc D1
loc D2
loc E
init S
trans tf S F F a
trans fb F F N b
trans n1 S D1 N a
trans n2 D1 D2 N b
trans n3 D2 E N b
`;

test('有限正常路径：可诊断、无伪装证据、给出有限诊断对摘要', () => {
  const r = analyze(FINITE_NORMAL_PATH);
  assert.equal(r.ok, true);
  assert.equal(r.diagnosable, true);
  assert.equal(r.witness, undefined);
  assert.ok(Array.isArray(r.checkedPairs));
  assert.ok(r.checkedPairs.length >= 1);
  for (const pair of r.checkedPairs) {
    assert.notEqual(pair.verdict, 'ambiguous');
  }
});

const SILENT_DOUBLE_LOOP = `
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 1 N a
trans h1 0 3 N a
trans h2 3 0 N a
`;

test('真实双环证据通过连续性核验（逐步衔接 + 闭环回入口）', () => {
  const r = analyze(SILENT_DOUBLE_LOOP);
  assert.equal(r.diagnosable, false);
  assert.equal(r.witness.sequencesIdentical, true);
  assert.equal(r.witness.continuityValid, true);
  assert.deepEqual(r.witness.integrityProblems, []);
});

test('静默路径有效伪装不被遗漏（N_SILENT 参与的无限双环仍判不可诊断）', () => {
  const r = analyze(`
loc 0
loc 1
loc 2
loc 3
loc 4
init 0
trans f1 0 1 F SILENT
trans fa 1 2 N a
trans floop 2 2 N a
trans ne 0 3 N SILENT
trans na 3 4 N a
trans nloop 4 4 N a
`);
  assert.equal(r.diagnosable, false);
  assert.equal(r.witness.continuityValid, true);
});

test('有限同回执前缀：仅前缀相同、无无限环 ⇒ 可诊断', () => {
  const r = analyze(`
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F a
trans f2 1 2 N b
trans n1 0 3 N a
`);
  assert.equal(r.diagnosable, true);
});
