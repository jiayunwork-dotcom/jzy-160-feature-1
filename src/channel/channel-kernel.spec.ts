import {
  advanceChannel,
  ChannelMaterialSnapshot,
  ChannelRuntimeState,
  ChannelSample,
  initialChannelState,
} from './channel.model';
import { StoredMaterial } from '../material/material.model';
import { resolveHistory, StrainHistorySpec } from '../history/history.model';
import { runPronyKernel } from '../prony/prony-kernel.service';
import { ViscoError } from '../common/errors';

/**
 * 跟踪通道内核（变温约化时间递推）的纯函数测试。
 * 对应验收条目 1/2/3 的数值一致性，以及条目 7 中与落库无关的内核侧校验。
 */

const WLF = { tRef: 20, c1: 17.44, c2: 51.6 };

function snapshot(mat: StoredMaterial): ChannelMaterialSnapshot {
  return { name: mat.name, eInf: mat.eInf, branches: mat.branches.map((b) => ({ ...b })), wlf: mat.wlf ?? null };
}

function material(withWlf = false, eInf = 3): StoredMaterial {
  return {
    name: 'nitrile',
    eInf,
    e0: eInf + 4 + 6,
    branches: [
      { modulus: 4, tau: 0.5 },
      { modulus: 6, tau: 10 },
    ],
    wlf: withWlf ? { ...WLF } : null,
  };
}

/** 用作业接口计算同一组分段线性控制点、输出网格取全部控制点时刻。 */
function jobReference(
  mat: StoredMaterial,
  points: Array<[number, number]>,
  temperature: number | undefined,
) {
  const spec: StrainHistorySpec = {
    segments: [
      { type: 'linear', times: points.map((p) => p[0]), strains: points.map((p) => p[1]) },
    ],
    temperature,
    output: { kind: 'points', times: points.map((p) => p[0]) },
  };
  const history = resolveHistory(spec);
  return runPronyKernel({ material: mat, history });
}

function appendBatches(
  mat: StoredMaterial,
  batches: ChannelSample[][],
  initialStrain = 0,
  initialTemperature: number | null = null,
) {
  let state: ChannelRuntimeState = initialChannelState(
    mat.branches.length,
    initialStrain,
    initialTemperature,
  );
  const all: ReturnType<typeof advanceChannel>['results'] = [];
  for (const samples of batches) {
    const out = advanceChannel({ material: snapshot(mat), state, samples });
    state = out.newState;
    all.push(...out.results);
  }
  return { state, results: all };
}

/** 相对误差（应力接近零处看绝对误差，阈值 absFloor）。 */
function relOrAbsError(actual: number, expected: number, absFloor = 1e-12): number {
  const denom = Math.max(Math.abs(expected), 1);
  // 期望接近 0 时改用绝对误差
  if (Math.abs(expected) < absFloor) return Math.abs(actual - expected);
  return Math.abs(actual - expected) / denom;
}

describe('通道内核：与作业接口的数值一致性（验收 1）', () => {
  const points: Array<[number, number]> = [
    [0, 0.1],
    [1, 0.2],
    [3, 0.05],
    [7, -0.1],
    [10, 0.15],
    [13, 0.15],
  ];
  const mat = material();

  test('恒温（Tref、无 WLF）：分批追加与作业接口逐点一致，相对误差 < 1e-9', () => {
    const ref = jobReference(mat, points, undefined);

    const toSamples = (pts: Array<[number, number]>): ChannelSample[] =>
      pts.map(([t, e]) => ({ time: t, strain: e, temperature: 20 }));

    // 切批方式 A：[0,1] / [3,7] / [10,13]
    const a = appendBatches(mat, [
      toSamples([points[0], points[1]]),
      toSamples([points[2], points[3]]),
      toSamples([points[4], points[5]]),
    ], points[0][1]);

    // 切批方式 B：[0,1,3] / [7,10,13]
    const b = appendBatches(mat, [
      toSamples([points[0], points[1], points[2]]),
      toSamples([points[3], points[4], points[5]]),
    ], points[0][1]);

    for (let i = 0; i < points.length; i++) {
      expect(a.results[i].time).toBe(points[i][0]);
      expect(relOrAbsError(a.results[i].stress, ref.stresses[i])).toBeLessThan(1e-9);
      expect(relOrAbsError(b.results[i].stress, ref.stresses[i])).toBeLessThan(1e-9);
      // 换切批方式结果不变（同一条单遍递推）
      expect(a.results[i].stress).toBe(b.results[i].stress);
    }
  });

  test('应力过零附近使用绝对误差：含正负应变的斜坡与作业接口一致', () => {
    const zeroPoints: Array<[number, number]> = [
      [0, 0.1],
      [2, -0.1],
      [4, 0.08],
      [6, -0.02],
      [8, 0],
    ];
    const ref = jobReference(mat, zeroPoints, undefined);
    const out = appendBatches(
      mat,
      [
        zeroPoints.slice(0, 2).map(([t, e]) => ({ time: t, strain: e, temperature: 20 })),
        zeroPoints.slice(2).map(([t, e]) => ({ time: t, strain: e, temperature: 20 })),
      ],
      0.1,
    );
    ref.stresses.forEach((s, i) => {
      expect(Math.abs(out.results[i].stress - s)).toBeLessThan(1e-12);
    });
  });
});

describe('通道内核：WLF 恒温等价性（验收 2）', () => {
  const points: Array<[number, number]> = [
    [0, 0.1],
    [2, 0.2],
    [5, 0.0],
    [9, -0.05],
    [12, 0.1],
  ];

  test('恒温等于 Tref：与去掉 WLF 的同参数材料完全相同', () => {
    const noWlf = material(false);
    const wlf = material(true);
    const refNoWlf = jobReference(noWlf, points, undefined);

    const out = appendBatches(
      wlf,
      [points.map(([t, e]) => ({ time: t, strain: e, temperature: 20 }))],
      0.1,
      20,
    );
    refNoWlf.stresses.forEach((s, i) => {
      expect(out.results[i].stress).toBe(s);
      expect(out.results[i].shiftFactor).toBe(1);
      expect(out.results[i].reducedTime).toBe(points[i][0]);
    });
  });

  test('恒温 T≠Tref：与作业接口指定温度 T 的结果一致（相对误差 < 1e-9）', () => {
    const wlf = material(true);
    const T = 60;
    const ref = jobReference(wlf, points, T);
    const out = appendBatches(
      wlf,
      [
        points.slice(0, 3).map(([t, e]) => ({ time: t, strain: e, temperature: T })),
        points.slice(3).map(([t, e]) => ({ time: t, strain: e, temperature: T })),
      ],
      0.1,
      T,
    );
    ref.stresses.forEach((s, i) => {
      expect(relOrAbsError(out.results[i].stress, s)).toBeLessThan(1e-9);
      expect(out.results[i].shiftFactor).toBeCloseTo(ref.shiftFactor, 12);
    });
    // 约化时间 = 物理时间 / a_T（绝对值近 5e8，用相对误差比较）
    const aT = ref.shiftFactor;
    points.forEach(([t], i) => {
      if (i === 0) {
        expect(out.results[i].reducedTime).toBe(0);
        return;
      }
      expect(Math.abs(out.results[i].reducedTime - t / aT) / (t / aT)).toBeLessThan(1e-12);
    });
  });

  test('低温 T<Tref：松弛更慢，同物理时刻支路应力高于 Tref 对照', () => {
    const wlf = material(true);
    const ctrl = appendBatches(wlf, [[{ time: 0, strain: 0.1, temperature: 20 }], [{ time: 5, strain: 0.1, temperature: 20 }]], 0.1, 20);
    const cold = appendBatches(wlf, [[{ time: 0, strain: 0.1, temperature: 0 }], [{ time: 5, strain: 0.1, temperature: 0 }]], 0.1, 0);
    expect(cold.results[1].shiftFactor).toBeGreaterThan(1);
    expect(cold.results[1].stress).toBeGreaterThan(ctrl.results[1].stress);
  });

  test('材料无 WLF：温度只记录，不参与计算（任意温度序列与 20°C 完全相同，a_T≡1）', () => {
    const noWlf = material(false);
    const varying = appendBatches(
      noWlf,
      [
        [
          { time: 0, strain: 0.1, temperature: 120 },
          { time: 1, strain: 0.1, temperature: -200 },
        ],
        [{ time: 3, strain: 0.2, temperature: 999 }],
      ],
      0.1,
      120,
    );
    const plain = appendBatches(
      noWlf,
      [
        [
          { time: 0, strain: 0.1, temperature: 20 },
          { time: 1, strain: 0.1, temperature: 20 },
        ],
        [{ time: 3, strain: 0.2, temperature: 20 }],
      ],
      0.1,
      20,
    );
    varying.results.forEach((r, i) => {
      expect(r.stress).toBe(plain.results[i].stress);
      expect(r.shiftFactor).toBe(1);
      expect(r.reducedTime).toBe(r.time);
    });
  });
});

describe('通道内核：先 Tref 后升温（验收 3）', () => {
  test('升温前逐点与 Tref 对照相同；升温后向 E∞·ε 靠拢明显更快', () => {
    // 长支路 τ=100：60 个时间单位内对照通道基本没松弛，升温通道则快速松弛
    const slow: StoredMaterial = {
      name: 'slow',
      eInf: 3,
      e0: 9,
      branches: [{ modulus: 6, tau: 100 }],
      wlf: { ...WLF },
    };
    const eps0 = 0.1;

    // 0~10 在 Tref=20，之后升温到 80 继续保持到 60
    const gridPre = [0, 2, 4, 6, 8, 10];
    const gridPost = [12, 15, 20, 30, 45, 60];
    const ctrl = appendBatches(
      slow,
      [
        gridPre.map((t) => ({ time: t, strain: eps0, temperature: 20 })),
        gridPost.map((t) => ({ time: t, strain: eps0, temperature: 20 })),
      ],
      eps0,
      20,
    );
    const hot = appendBatches(
      slow,
      [
        gridPre.map((t) => ({ time: t, strain: eps0, temperature: 20 })),
        gridPost.map((t) => ({ time: t, strain: eps0, temperature: 80 })),
      ],
      eps0,
      20,
    );

    // 升温前（前 6 个点）逐点相同
    for (let i = 0; i < gridPre.length; i++) {
      expect(hot.results[i].stress).toBe(ctrl.results[i].stress);
    }
    // 升温后：热通道更快向 E∞·ε0 = 0.3 收敛
    const equilibrium = 3 * eps0;
    for (let i = gridPre.length; i < hot.results.length; i++) {
      const dHot = Math.abs(hot.results[i].stress - equilibrium);
      const dCtrl = Math.abs(ctrl.results[i].stress - equilibrium);
      expect(dHot).toBeLessThan(dCtrl);
    }
    // 热通道末点已很接近平衡；对照通道仍有可观非平衡支路应力
    expect(Math.abs(hot.results.at(-1)!.stress - equilibrium)).toBeLessThan(0.02);
    expect(Math.abs(ctrl.results.at(-1)!.stress - equilibrium)).toBeGreaterThan(0.05);
    // 升温后约化时间增长快于物理时间
    expect(hot.results.at(-1)!.reducedTime).toBeGreaterThan(60);
  });
});

describe('通道内核：梯形约化时间的数值性质', () => {
  const wlf = material(true);

  test('恒温区间 Δξ=Δt/a_T（梯形两端相同）', () => {
    const state = initialChannelState(wlf.branches.length, 0.1, 60);
    const out = advanceChannel({
      material: snapshot(wlf),
      state,
      samples: [{ time: 10, strain: 0.1, temperature: 60 }],
    });
    const aT = out.results[0].shiftFactor;
    expect(out.newState.reducedTime).toBeCloseTo(10 / aT, 12);
  });

  test('变温区间的 Δξ 是两端 1/a_T 的梯形平均，且结果可复现', () => {
    const state = initialChannelState(wlf.branches.length, 0.1, 20);
    const samples: ChannelSample[] = [
      { time: 0, strain: 0.1, temperature: 20 },
      { time: 10, strain: 0.1, temperature: 60 },
    ];
    const out1 = advanceChannel({ material: snapshot(wlf), state, samples });
    const out2 = advanceChannel({ material: snapshot(wlf), state, samples });
    expect(out1.newState.z).toEqual(out2.newState.z);

    const { wlfShiftFactor } = require('../wlf/wlf.service');
    const invCold = 1 / wlfShiftFactor(20, WLF); // =1
    const invHot = 1 / wlfShiftFactor(60, WLF);
    const expectedXi = 10 * 0.5 * (invCold + invHot);
    expect(out1.newState.reducedTime).toBeCloseTo(expectedXi, 6);
    // 梯形严格落在两端恒温折合量之间
    expect(out1.newState.reducedTime).toBeGreaterThan(10 * invCold);
    expect(out1.newState.reducedTime).toBeLessThan(10 * invHot);
  });
});

describe('通道内核：校验与状态保护（验收 7 的内核侧）', () => {
  const mat = material(true);

  function expectStateUnchangedAfterThrow(state: ChannelRuntimeState, samples: ChannelSample[]) {
    const clone: ChannelRuntimeState = {
      ...state,
      z: state.z.slice(),
      lastTemperature: state.lastTemperature,
    };
    expect(() =>
      advanceChannel({ material: snapshot(mat), state: clone, samples }),
    ).toThrow(ViscoError);
    expect(clone).toEqual(state);
  }

  test('空批次拒绝', () => {
    const state = initialChannelState(2, 0, 20);
    expectStateUnchangedAfterThrow(state, []);
  });

  test('批次内时间不严格递增拒绝且状态不变', () => {
    const state = initialChannelState(2, 0.1, 20);
    expectStateUnchangedAfterThrow(state, [
      { time: 0, strain: 0.1, temperature: 20 },
      { time: 1, strain: 0.1, temperature: 20 },
      { time: 1, strain: 0.1, temperature: 20 },
    ]);
  });

  test('采样时间倒退（早于当前时刻）拒绝且状态不变', () => {
    let state = initialChannelState(2, 0.1, 20);
    state = advanceChannel({
      material: snapshot(mat),
      state,
      samples: [{ time: 0, strain: 0.1, temperature: 20 }, { time: 5, strain: 0.1, temperature: 20 }],
    }).newState;
    expectStateUnchangedAfterThrow(state, [
      { time: 4.9, strain: 0.1, temperature: 20 },
    ]);
  });

  test('首个 t=0 采样点应变与初始瞬时应变不一致拒绝', () => {
    const state = initialChannelState(2, 0.1, 20);
    expectStateUnchangedAfterThrow(state, [
      { time: 0, strain: 0.2, temperature: 20 },
    ]);
  });

  test('温度让 WLF 分母非正时拒绝（采样点温度与区间端点温度都查）', () => {
    const state = initialChannelState(2, 0.1, 20);
    expectStateUnchangedAfterThrow(state, [
      { time: 0, strain: 0.1, temperature: -100 },
    ]);
    let advanced = advanceChannel({
      material: snapshot(mat),
      state,
      samples: [{ time: 0, strain: 0.1, temperature: 20 }, { time: 1, strain: 0.1, temperature: 20 }],
    }).newState;
    expect(() =>
      advanceChannel({
        material: snapshot(mat),
        state: advanced,
        samples: [{ time: 2, strain: 0.1, temperature: -100 }],
      }),
    ).toThrow(/WLF 分母/);
    advanced = advanceChannel({
      material: snapshot(mat),
      state: initialChannelState(2, 0.1, 20),
      samples: [{ time: 0, strain: 0.1, temperature: 20 }],
    }).newState;
    expect(advanced.initialized).toBe(true);
  });

  test('带 WLF 且首批晚于 t=0 但未给初始温度 → 拒绝', () => {
    const state = initialChannelState(2, 0.1, null);
    expectStateUnchangedAfterThrow(state, [
      { time: 1, strain: 0.1, temperature: 20 },
    ]);
  });

  test('非有限数值拒绝', () => {
    const state = initialChannelState(2, 0, 20);
    expectStateUnchangedAfterThrow(state, [
      { time: 0, strain: Number.NaN, temperature: 20 },
    ]);
  });
});
