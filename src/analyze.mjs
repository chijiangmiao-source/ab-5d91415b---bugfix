// analyze.mjs — 解析 + 判定 + 视图模型
import { parseSpec } from './parser.mjs';
import { diagnose } from './diagnoser.mjs';

export function analyze(specText) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const result = diagnose(model);

  if (result.diagnosable) {
    return {
      ok: true,
      diagnosable: true,
      stats: {
        locations: model.locations.length,
        transitions: model.transitions.length,
        faultyTransitions: model.transitions.filter((t) => t.faulty).length,
        verifierStates: result.verifierStateCount,
      },
      checkedPairs: result.checkedPairs,
    };
  }

  const w = result.witness;
  const obsOf = (steps) =>
    steps.map((s) => s.receipt).filter((r) => r !== null);
  const prefixObs = obsOf(w.prefix);
  const loopObs = obsOf(w.loop);

  // 校验两侧可观察序列逐元素相同（理论上构造保证，此处再断言式核验）
  const seqF = [];
  const seqN = [];
  for (const s of [...w.prefix, ...w.loop]) {
    if (s.faultySide && !s.faultySide.silent && s.receipt !== null) seqF.push(s.receipt);
    if (s.normalSide && !s.normalSide.silent && s.receipt !== null) seqN.push(s.receipt);
  }
  const sep = '';
  const identical = seqF.join(sep) === seqN.join(sep);

  // 连续性核验：任意一侧若在某步移动，迁移必须从该侧上一步实际所在位置
  // 出发。这是对 verifier 构造的独立防线——按局部轮廓合并位置一类的缺陷
  // 会虚构“从不存在的位置出发”的伪装迁移，在此必然暴露而不会被当成证据。
  // 前缀走完须终止于入口对；闭环再走一圈后两侧都必须回到入口位置。
  const problems = [];
  const chain = (steps, sideKey, label, startLoc) => {
    let cur = startLoc;
    for (const [i, s] of steps.entries()) {
      const side = s[sideKey];
      if (!side || !side.transId) continue;
      if (side.from !== cur) {
        problems.push(`${label}第 ${i + 1} 步迁移 ${side.transId} 从 ${side.from} 出发，但该侧实际位于 ${cur}`);
      }
      cur = side.to;
    }
    return cur;
  };
  const prefixEndF = chain(w.prefix, 'faultySide', '故障侧前缀', model.init);
  const prefixEndN = chain(w.prefix, 'normalSide', '正常侧前缀', model.init);
  if (w.prefix.length && (prefixEndF !== w.entry.p || prefixEndN !== w.entry.q)) {
    problems.push(`前缀终止于 (${prefixEndF}, ${prefixEndN})，与入口 (${w.entry.p}, ${w.entry.q}) 不一致`);
  }
  const loopStartF = w.prefix.length ? prefixEndF : w.entry.p;
  const loopStartN = w.prefix.length ? prefixEndN : w.entry.q;
  const loopEndF = chain(w.loop, 'faultySide', '故障侧闭环', loopStartF);
  const loopEndN = chain(w.loop, 'normalSide', '正常侧闭环', loopStartN);
  if (loopEndF !== w.entry.p || loopEndN !== w.entry.q) {
    problems.push(`闭环终止于 (${loopEndF}, ${loopEndN})，未回到入口 (${w.entry.p}, ${w.entry.q})`);
  }
  if (w.loop.length === 0) problems.push('闭环为空，不可重复');
  if (!w.loop.some((s) => s.faultySide?.transId)) problems.push('闭环未移动故障侧');
  if (!w.loop.some((s) => s.normalSide?.transId)) problems.push('闭环未移动正常侧');
  if (w.loop.some((s) => s.normalSide?.faulty)) problems.push('正常侧证据中出现 F 迁移');
  if (!identical) problems.push('两侧可观察回执序列不一致');
  const integrityOk = problems.length === 0;
  if (!integrityOk) {
    // 证据未通过独立连续性核验：绝不能把伪装证据交给页面。
    throw new Error(`内部错误：判定证据未通过连续性核验：${problems.join('；')}`);
  }

  return {
    ok: true,
    diagnosable: false,
    stats: {
      locations: model.locations.length,
      transitions: model.transitions.length,
      faultyTransitions: model.transitions.filter((t) => t.faulty).length,
      verifierStates: result.verifierStateCount,
    },
    witness: {
      entry: w.entry,
      prefix: w.prefix,
      loop: w.loop,
      prefixObservable: prefixObs,
      loopObservable: loopObs,
      prefixReceiptLength: prefixObs.length,
      loopReceiptLength: loopObs.length,
      faultySideObservable: seqF,
      normalSideObservable: seqN,
      sequencesIdentical: identical,
      continuityValid: integrityOk,
      integrityProblems: problems,
    },
    checkedPairs: result.checkedPairs,
  };
}
