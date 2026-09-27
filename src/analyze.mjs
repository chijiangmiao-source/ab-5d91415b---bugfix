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
  const identical = seqF.join('') === seqN.join('');

  // 逐步连续性核验：把每一步还原成自动机里的真实游走。某一步不移动的一侧
  // 停留原地，移动一侧的源位置必须等于上一步的目标位置；前缀必须抵达入口，
  // 闭环走完一圈后两侧都必须回到入口（闭环才可无限重复）。
  const continuity = checkContinuity(model.init, w.prefix, w.loop, w.entry);

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
      continuityValid: continuity.valid,
      continuityError: continuity.error,
    },
    checkedPairs: result.checkedPairs,
  };
}

// 逐步核验证据两侧迁移能否连续衔接：从初态出发，前缀必须抵达 entry，
// 闭环从 entry 出发走一圈必须回到 entry；任意一步移动侧的源位置须与
// 上一步目标位置相同。任何不一致都说明证据是伪造的（如按位置签名合并
// 位置后产生的假自环），而不是真实可重复的双侧无限执行。
function checkContinuity(init, prefix, loop, entry) {
  const apply = (pos, s) => {
    const next = { f: pos.f, n: pos.n };
    const f = s.faultySide;
    if (f && f.transId) {
      if (f.from !== pos.f) {
        return { error: `故障侧迁移 ${f.transId} 从 ${f.from} 出发，但上一步停在 ${pos.f}` };
      }
      next.f = f.to;
    }
    const n = s.normalSide;
    if (n && n.transId) {
      if (n.from !== pos.n) {
        return { error: `正常侧迁移 ${n.transId} 从 ${n.from} 出发，但上一步停在 ${pos.n}` };
      }
      next.n = n.to;
    }
    return { next };
  };

  let pos = { f: init, n: init };
  for (const s of prefix) {
    const r = apply(pos, s);
    if (r.error) return { valid: false, error: r.error };
    pos = r.next;
  }
  if (pos.f !== entry.p || pos.n !== entry.q) {
    return {
      valid: false,
      error: `前缀终点 (${pos.f}, ${pos.n}) 与入口 (${entry.p}, ${entry.q}) 不一致`,
    };
  }
  for (const s of loop) {
    const r = apply(pos, s);
    if (r.error) return { valid: false, error: r.error };
    pos = r.next;
  }
  if (pos.f !== entry.p || pos.n !== entry.q) {
    return {
      valid: false,
      error: `闭环未回到入口：终点 (${pos.f}, ${pos.n})，入口 (${entry.p}, ${entry.q})`,
    };
  }
  return { valid: true, error: null };
}
