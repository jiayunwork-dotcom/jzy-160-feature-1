import {
  initialTrackState,
  processSamples,
  TrackMaterialSpec,
  TrackSample,
} from './track-kernel';
import { resolveHistory, StrainHistorySpec } from '../history/history.model';
import { runPronyKernel } from '../prony/prony-kernel.service';
import { wlfShiftFactor } from '../wlf/wlf.service';
import { ViscoError } from '../common/errors';

const wlf = { tRef: 20, c1: 17.44, c2: 51.6 };

function mat(wlfSpec: TrackMaterialSpec['wlf'] = null): TrackMaterialSpec {
  return {
    eInf: 3,
    branches: [
      { modulus: 4, tau: 0.3 },
      { modulus: 6, tau: 7 },
    ],
    wlf: wlfSpec,
  };
}

/** 用作业接口（一次性完整历程）计算同一组分段线性采样点上的应力。 */
function jobStresses(
  material: TrackMaterialSpec,
  times: number[],
  strains: number[],
  temperature?: number,
): number[] {
  const stored = {
    name: 'm',
    eInf: material.eInf,
    branches: material.branches,
    wlf: material.wlf,
    e0: material.eInf + material.branches.reduce((s, b) => s + b.modulus, 0),
  };
  const spec: StrainHistorySpec = {
    segments: [{ type: 'linear', times: times.slice(), strains: strains.slice() }],
    temperature,
    output: { kind: 'points', times: times.slice() },
  };
  const history = resolveHistory(spec);
  return runPronyKernel({ material: stored, history }).stresses;
}

/** 把采样序列按给定的“每批点数”切批，顺序追加，收集逐点应力。 */
function appendChunks(
  material: TrackMaterialSpec,
  samples: TrackSample[],
  chunkSizes: number[],
  repeatBoundary: boolean,
): { stresses: number[]; shiftFactors: number[] } {
  let state = initialTrackState(material, samples[0].strain);
  const stresses: number[] = [];
  const shiftFactors: number[] = [];
  let cursor = 0;
  let seq = 1;
  for (const size of chunkSizes) {
    const end = Math.min(cursor + size, samples.length);
    let chunk = samples.slice(cursor, end);
    if (repeatBoundary && cursor > 0) {
      chunk = [samples[cursor - 1], ...chunk];
    }
    const out = processSamples(material, state, chunk, {
      initialStrain: samples[0].strain,
    });
    state = out.state;
    const emitted = repeatBoundary && seq > 1 ? out.results.slice(1) : out.results;
    for (const r of emitted) {
      stresses.push(r.stress);
      shiftFactors.push(r.shiftFactor);
    }
    cursor = end;
    seq++;
    if (cursor >= samples.length) break;
  }
  return { stresses, shiftFactors };
}

function checkClose(actual: number[], expected: number[], tol = 1e-9): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((a, i) => {
    const e = expected[i];
    const diff = Math.abs(a - e);
    const scale = Math.max(1, Math.abs(e));
    if (!(diff <= tol * scale || diff <= tol)) {
      throw new Error(`位置 ${i}: 实际 ${a} 与期望 ${e} 之差 ${diff} 超过容差`);
    }
  });
}

describe('跟踪通道内核：与作业接口恒温一致性（验收 1、2）', () => {
  const times = [0, 0.4, 1.1, 2.0, 3.3, 5.0, 7.2, 9.0, 10];
  const strains = [0.1, 0.14, 0.09, -0.02, 0.04, 0.12, 0.0, 0.03, 0.03];

  function samplesAt(t: number): TrackSample[] {
    return times.map((time, i) => ({ time, strain: strains[i], temperature: t }));
  }

  test('无 WLF 材料：分批追加（边界点重复）与作业接口逐点一致，相对误差 < 1e-9', () => {
    const m = mat();
    const expected = jobStresses(m, times, strains);
    const chunks = [2, 1, 3, 2, 1]; // 切批方式 A
    const { stresses } = appendChunks(m, samplesAt(20), chunks, true);
    checkClose(stresses, expected, 1e-9);
  });

  test('无 WLF 材料：换一种切批方式（不重复边界、跨批桥接）结果不变', () => {
    const m = mat();
    const expected = jobStresses(m, times, strains);
    const a = appendChunks(m, samplesAt(20), [2, 1, 3, 2, 1], true).stresses;
    const b = appendChunks(m, samplesAt(25), [3, 2, 4], false).stresses;
    const c = appendChunks(m, samplesAt(-5), [9], false).stresses;
    checkClose(a, expected);
    checkClose(b, expected);
    checkClose(c, expected);
  });

  test('带 WLF：恒温 Tref 与去掉 WLF 的同参数材料相同（验收 2）', () => {
    const mRef = mat(wlf);
    const mNoWlf = mat(null);
    const samples = samplesAt(20);
    const a = appendChunks(mRef, samples, [3, 3, 3], true);
    const b = appendChunks(mNoWlf, samples, [4, 5], false);
    checkClose(a.stresses, b.stresses);
    a.shiftFactors.forEach((s) => expect(s).toBeCloseTo(1, 12));
  });

  test('带 WLF：恒温 T=40°C 与作业接口指定 temperature=40 一致（验收 2）', () => {
    const m = mat(wlf);
    const T = 40;
    const expected = jobStresses(m, times, strains, T);
    const got = appendChunks(m, samplesAt(T), [2, 4, 3], true);
    checkClose(got.stresses, expected);
    got.shiftFactors.forEach((s) =>
      expect(s).toBeCloseTo(wlfShiftFactor(T, wlf), 12),
    );
  });

  test('无 WLF 材料：温度只记录、不参与计算（不同温度序列应力完全相同）', () => {
    const m = mat();
    const a = appendChunks(m, samplesAt(20), [9], false).stresses;
    const b = appendChunks(
      m,
      times.map((t, i) => ({ time: t, strain: strains[i], temperature: -200 + 50 * i })),
      [2, 3, 4],
      true,
    ).stresses;
    checkClose(a, b);
  });
});

describe('跟踪通道内核：变温 WLF（左端点温度保持，验收 3）', () => {
  const m = mat(wlf);
  const eps0 = 0.1;

  test('先 Tref 推进、再升温保持：升温前与 Tref 对照逐点相同，升温后更快靠拢 E∞·ε', () => {
    // 0..5s 在 20°C，t=10 起温度为 60°C（区间 [5,10] 仍按左端点 20°C）。
    const hotSamples: TrackSample[] = [
      { time: 0, strain: eps0, temperature: 20 },
      { time: 1, strain: eps0, temperature: 20 },
      { time: 3, strain: eps0, temperature: 20 },
      { time: 5, strain: eps0, temperature: 20 },
      { time: 10, strain: eps0, temperature: 60 },
      { time: 11, strain: eps0, temperature: 60 },
      { time: 14, strain: eps0, temperature: 60 },
      { time: 20, strain: eps0, temperature: 60 },
    ];
    const refSamples = hotSamples.map((s) => ({ ...s, temperature: 20 }));

    const hot = appendChunks(m, hotSamples, [4, 4], true);
    const ref = appendChunks(m, refSamples, [8], false);

    // 升温前（前 4 个点，t≤5）逐点相同
    for (let i = 0; i < 4; i++) {
      expect(hot.stresses[i]).toBeCloseTo(ref.stresses[i], 12);
    }
    // t=10 点本身：区间 [5,10] 两边都按 20°C 折时，应力仍相同
    expect(hot.stresses[4]).toBeCloseTo(ref.stresses[4], 12);
    // 升温后：高温应力更小，更快向 E∞·ε0 = 0.3 靠拢
    expect(hot.stresses[5]).toBeLessThan(ref.stresses[5]);
    expect(hot.stresses[6]).toBeLessThan(ref.stresses[6]);
    expect(hot.stresses[7]).toBeLessThan(ref.stresses[7]);
    const eq = 3 * eps0;
    expect(Math.abs(hot.stresses[7] - eq)).toBeLessThan(
      Math.abs(ref.stresses[7] - eq),
    );
  });

  test('区间折时取左端点温度：冷段后突然升温，新区间立即采用新温度', () => {
    // 单支路可手算：[0,1] 低温 0°C（a>1，几乎不松弛），t=1 测点温度切到 60°C，
    // 于是区间 [1,2] 立即按高温折时（左端点温度保持约定）。
    const single: TrackMaterialSpec = { eInf: 3, branches: [{ modulus: 7, tau: 2 }], wlf };
    const out = processSamples(
      single,
      initialTrackState(single, 0.1),
      [
        { time: 0, strain: 0.1, temperature: 0 },
        { time: 1, strain: 0.1, temperature: 60 },
        { time: 2, strain: 0.1, temperature: 60 },
      ],
      { initialStrain: 0.1 },
    );
    const aCold = wlfShiftFactor(0, wlf);
    const aHot = wlfShiftFactor(60, wlf);
    // z(1) = 0.1 exp(-1/(aCold·2))；z(2) = z(1) exp(-1/(aHot·2))
    const z1 = 0.1 * Math.exp(-1 / (aCold * 2));
    const z2 = z1 * Math.exp(-1 / (aHot * 2));
    expect(out.results[1].stress).toBeCloseTo(3 * 0.1 + 7 * z1, 12);
    expect(out.results[2].stress).toBeCloseTo(3 * 0.1 + 7 * z2, 12);
    // 返回的平移因子取各采样点自身温度：t=1 起为高温 aHot
    expect(out.results[1].shiftFactor).toBeCloseTo(aHot, 12);
  });
});

describe('跟踪通道内核：校验（验收 7）', () => {
  const m = mat(wlf);

  test('空批次 → 错误', () => {
    const state = initialTrackState(m, 0);
    expect(() => processSamples(m, state, [])).toThrow(ViscoError);
    expect(() => processSamples(m, state, [])).toThrow(/至少/);
  });

  test('采样时间不严格递增 → 错误', () => {
    const state = initialTrackState(m, 0.1);
    expect(() =>
      processSamples(m, state, [
        { time: 0, strain: 0.1, temperature: 20 },
        { time: 1, strain: 0.1, temperature: 20 },
        { time: 1, strain: 0.1, temperature: 20 },
      ], { initialStrain: 0.1 }),
    ).toThrow(/严格递增/);
  });

  test('采样字段含 NaN/Infinity → 错误', () => {
    const state = initialTrackState(m, 0.1);
    expect(() =>
      processSamples(m, state, [
        { time: 0, strain: 0.1, temperature: 20 },
        { time: 1, strain: Number.NaN, temperature: 20 },
      ], { initialStrain: 0.1 }),
    ).toThrow(ViscoError);
  });

  test('某温度让 WLF 分母非正 → 错误，且不改动传入状态', () => {
    const state = initialTrackState(m, 0.1);
    const snapshot = JSON.stringify(state);
    expect(() =>
      processSamples(m, state, [
        { time: 0, strain: 0.1, temperature: 20 },
        { time: 1, strain: 0.1, temperature: -100 }, // 20-51.6=-31.6 即失效
      ], { initialStrain: 0.1 }),
    ).toThrow(/WLF 分母/);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  test('后续批次起点早于通道当前时刻（时间倒退）→ 错误', () => {
    const state = processSamples(
      m,
      initialTrackState(m, 0.1),
      [
        { time: 0, strain: 0.1, temperature: 20 },
        { time: 2, strain: 0.1, temperature: 20 },
      ],
      { initialStrain: 0.1 },
    ).state;
    expect(() =>
      processSamples(m, state, [
        { time: 1.5, strain: 0.1, temperature: 20 },
        { time: 3, strain: 0.1, temperature: 20 },
      ]),
    ).toThrow(/早于通道当前时刻/);
  });

  test('后续批次重复边界点但应变不一致 → 拒绝（应变间断）', () => {
    const state = processSamples(
      m,
      initialTrackState(m, 0.1),
      [{ time: 0, strain: 0.1, temperature: 20 }],
      { initialStrain: 0.1 },
    ).state;
    expect(() =>
      processSamples(m, state, [
        { time: 0, strain: 0.2, temperature: 20 },
        { time: 1, strain: 0.2, temperature: 20 },
      ]),
    ).toThrow(/应变/);
  });

  test('首批锚点应变与开通道初始应变不一致 → 拒绝', () => {
    const state = initialTrackState(m, 0.1);
    expect(() =>
      processSamples(
        m,
        state,
        [{ time: 0, strain: 0.2, temperature: 20 }],
        { initialStrain: 0.1 },
      ),
    ).toThrow(/初始应变/);
  });
});

describe('跟踪通道内核：纯函数性与状态语义', () => {
  const m = mat();

  test('推进不修改入参状态与入参数组', () => {
    const state = initialTrackState(m, 0.1);
    const stateSnap = JSON.stringify(state);
    const batch: TrackSample[] = [
      { time: 0, strain: 0.1, temperature: 20 },
      { time: 1, strain: 0.12, temperature: 20 },
    ];
    const batchSnap = JSON.stringify(batch);
    processSamples(m, state, batch, { initialStrain: 0.1 });
    expect(JSON.stringify(state)).toBe(stateSnap);
    expect(JSON.stringify(batch)).toBe(batchSnap);
  });

  test('无支路材料：σ=E∞·ε，内变量数组为空也能跨批推进', () => {
    const elastic: TrackMaterialSpec = { eInf: 5, branches: [], wlf: null };
    let state = initialTrackState(elastic, 0.2);
    const out1 = processSamples(
      elastic,
      state,
      [
        { time: 0, strain: 0.2, temperature: 20 },
        { time: 1, strain: 0.4, temperature: 20 },
      ],
      { initialStrain: 0.2 },
    );
    state = out1.state;
    expect(out1.results[1].stress).toBeCloseTo(2, 12);
    const out2 = processSamples(elastic, state, [
      { time: 1, strain: 0.4, temperature: 20 },
      { time: 2, strain: 0.1, temperature: 20 },
    ]);
    expect(out2.results[1].stress).toBeCloseTo(0.5, 12);
  });

  test('首批第一个采样点为锚点：瞬时施加，σ=E0·ε，温度被锚定', () => {
    const state = initialTrackState(m, 0.1);
    const out = processSamples(
      m,
      state,
      [{ time: 5, strain: 0.1, temperature: 30 }],
      { initialStrain: 0.1 },
    );
    expect(out.state.anchored).toBe(true);
    expect(out.state.time).toBe(5);
    expect(out.state.temperature).toBe(30);
    // E0 = 3+4+6 = 13, σ(0+)=13·0.1
    expect(out.results[0].stress).toBeCloseTo(1.3, 12);
  });
});
