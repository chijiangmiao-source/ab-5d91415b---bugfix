// scripts/verify.mjs — Compose verify 服务入口
// 依次执行：语法/构建检查 → 单元测试 → 随机交叉验证 → HTTP 冒烟；
// 任一步失败立即以非零退出码退出（Compose 会显示 exited(1)）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...opts.env },
    });
    p.on('error', (err) => {
      console.error(`无法启动 ${cmd}: ${err.message}`);
      resolve(-1);
    });
    p.on('checkExit', () => {});
    p.on('exit', (code) => {
      if (!opts.softFail) console.log(`\n[verify] ${cmd} ${args.join(' ')} → exit ${code}`);
      resolve(code ?? -1);
    });
  });
}

async function smoke() {
  console.log('\n[verify] === HTTP 冒烟 ===');
  const remote = process.env.BASE_URL || '';
  let server = null;
  let cancelJob = null;
  let base;
  if (remote) {
    base = remote.replace(/\/$/, '');
    console.log(`[verify] 目标：${base}（Compose web 服务）`);
  } else {
    const PORT = '8911';
    ({ server, cancelJob } = await import('../server.js'));
    await new Promise((r) => server.listen(Number(PORT), '127.0.0.1', r));
    base = `http://127.0.0.1:${PORT}`;
    console.log(`[verify] 目标：${base}（进程内临时服务）`);
  }
  let failures = 0;
  const expect = (cond, msg) => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
    if (!cond) failures++;
  };

  // 1) 健康检查
  let r = await fetch(`${base}/healthz`);
  expect(r.status === 200, '健康检查 200');
  expect((await r.json()).status === 'ok', '健康检查内容 ok');

  // 2) 静默双环 ⇒ 不可诊断
  const silentCase = `loc 0
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
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-1', spec: silentCase }),
  });
  let payload = await r.json();
  expect(r.status === 200, '静默双环 API 200');
  expect(payload.result?.diagnosable === false, '静默双环判为不可诊断');
  expect(
    payload.result?.witness?.prefixReceiptLength === 0,
    '静默双环前缀无回执（不得以位置名称比较代替）');
  const loop = payload.result?.witness?.loop;
  expect(Array.isArray(loop) && loop.every((x) => x.receipt === 'a' || x.receipt === null),
    '闭环回执全部为 a 或 ε');
  expect(loop?.some((x) => x.faultySide.transId) && loop.some((x) => x.normalSide),
    '闭环内两侧都移动（都是无限执行）');
  expect(payload.result?.witness?.continuityValid === true,
    '静默双环证据两侧迁移逐步连续衔接');

  // 3) 可诊断回执 ⇒ 可诊断
  const diagCase = `loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`;
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-2', spec: diagCase }),
  });
  payload = await r.json();
  expect(r.status === 200, '可诊断例 API 200');
  expect(payload.result?.diagnosable === true, '可诊断例判为可诊断');
  expect(payload.result?.witness == null, '可诊断例无伪装证据');

  // 3b) 深海采集站：故障侧无限 b、正常侧经 D1,D2 止于汇点 E（有限正常路径）。
  //     必须判可诊断，且无伪装闭环，仅给诊断对停滞摘要。
  const deepSeaCase = `loc S
loc F
loc D1
loc D2
loc E
init S
trans fa S F F a
trans fb F F N b
trans d1 S D1 N a
trans d2 D1 D2 N b
trans d3 D2 E N b
`;
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-deepsea', spec: deepSeaCase }),
  });
  payload = await r.json();
  expect(r.status === 200, '深海有限正常路径 API 200');
  expect(payload.result?.diagnosable === true, '深海有限正常路径判为可诊断');
  expect(payload.result?.witness == null, '深海例不得给出伪装闭环');
  const pairs = payload.result?.checkedPairs ?? [];
  expect(Array.isArray(pairs) && pairs.length > 0, '深海例给出已检查诊断对摘要');
  expect(pairs.every((x) => x.verdict !== 'ambiguous'), '深海例诊断对无一双侧无限');
  expect(pairs.some((x) => x.p === 'F' && x.q === 'E'), '摘要记录正常侧停滞于汇点 E');

  // 3c) 有限同回执前缀：共享 a,b 后正常侧结束 ⇒ 可诊断
  const finitePrefix = `loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F a
trans f2 1 1 N b
trans n1 0 2 N a
trans n2 2 3 N b
`;
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-finite', spec: finitePrefix }),
  });
  payload = await r.json();
  expect(payload.result?.diagnosable === true, '有限同回执前缀判为可诊断');

  // 3d) 输入重排：先 init、迁移倒序、位置倒序，裁决不得改变
  const reordered = ['init S',
    'trans d3 D2 E N b', 'trans d2 D1 D2 N b', 'trans d1 S D1 N a',
    'trans fb F F N b', 'trans fa S F F a',
    'loc E', 'loc D2', 'loc D1', 'loc F', 'loc S'].join('\n') + '\n';
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-reorder', spec: reordered }),
  });
  payload = await r.json();
  expect(payload.result?.diagnosable === true, '重排录入顺序后裁决稳定（仍可诊断）');
  expect(payload.result?.witness == null, '重排后仍无伪装闭环');

  // 3e) 正常侧需经静默迁移的有效伪装 ⇒ 仍须判不可诊断（不漏判）
  const silentPathCase = `loc 0
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
`;
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-nsilent', spec: silentPathCase }),
  });
  payload = await r.json();
  expect(payload.result?.diagnosable === false, '正常侧静默路径伪装仍判不可诊断');
  expect(payload.result?.witness?.continuityValid === true, '静默路径证据逐步连续');

  // 4) 非法输入：悬空目标定位 + 不产出结论
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-3', spec: 'loc 0\ninit 0\ntrans t1 0 ZZ N ok\n' }),
  });
  payload = await r.json();
  expect(payload.result?.ok === false, '非法规程 ok=false');
  const dangling = payload.result?.errors?.find((e) => e.message.includes('悬空目标'));
  expect(Boolean(dangling) && dangling.line === 3 && dangling.column === 12,
    '悬空目标定位到第 3 行第 12 列');

  // 5) 静态页面与资源
  r = await fetch(`${base}/`);
  expect(r.status === 200 && (await r.text()).includes('故障闭环审计'), '页面可访问');
  r = await fetch(`${base}/app.js`);
  expect(r.status === 200, 'app.js 可访问');
  r = await fetch(`${base}/styles.css`);
  expect(r.status === 200, 'styles.css 可访问');

  // 6) 取消/过期任务：启动后立即 DELETE；其 promise reject(409)，
  //    随后的新任务结果必须正常，且服务器不残留活动任务
  const big = silentCase; // 当前实现很快，主要验证取消路径不击穿服务
  const [r1] = await Promise.all([
    fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'cancel-me', spec: big }),
    }).then(async (x) => ({ status: x.status, body: await x.text() })).catch((e) => ({ error: String(e) })),
    (async () => {
      await new Promise((r) => setTimeout(r, 5));
      const dr = await fetch(`${base}/api/jobs/cancel-me`, { method: 'DELETE' });
      return dr.json();
    })(),
  ]);
  // 快任务可能在 5ms 内已完成——两种结局都可接受，但后续健康检查必须 activeJobs=0
  expect(r1.status === 200 || r1.status === 409 || r1.error, '取消竞速不产生 5xx');
  r = await fetch(`${base}/healthz`);
  const h = await r.json();
  expect(h.activeJobs === 0, '取消/完成后无残留任务');

  cancelJob?.('not-a-job'); // 覆盖取消不存在任务的路径
  if (server) await new Promise((r) => server.close(r));
  console.log(failures === 0 ? '\n[verify] HTTP 冒烟全部通过' : `\n[verify] HTTP 冒烟失败 ${failures} 处`);
  return failures === 0 ? 0 : 1;
}

async function main() {
  console.log('[verify] 1/4 构建检查（node --check 所有源文件）');
  const files = [
    'server.js', 'src/parser.mjs', 'src/diagnoser.mjs',
    'src/analyze.mjs', 'src/worker.mjs', 'public/app.js',
    'scripts/fuzz.mjs', 'scripts/verify.mjs',
  ];
  for (const f of files) {
    const code = await run('node', ['--check', f]);
    if (code !== 0) process.exit(1);
  }

  console.log('\n[verify] 2/4 单元测试');
  if ((await run('node', ['--test', 'test/'])) !== 0) process.exit(1);

  console.log('\n[verify] 3/4 随机模型交叉验证（2000 例）');
  if ((await run('node', ['scripts/fuzz.mjs', '777', '2000'])) !== 0) process.exit(1);

  console.log('\n[verify] 4/4 HTTP 冒烟');
  if ((await smoke()) !== 0) process.exit(1);

  console.log('\n[verify] ✅ 全部检查通过，verify 正常退出（exit 0）');
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify] 异常退出:', err);
  process.exit(1);
});
