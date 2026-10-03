import { ViscoError } from '../common/errors';
import { linearAdvance } from '../prony/prony-kernel.service';
import { wlfShiftFactor } from '../wlf/wlf.service';

/**
 * 跟踪通道递推内核（分段线性应变 + 逐点温度，WLF 时温等效增量累积）。
 *
 * 与一次性作业内核共用同一套 Prony 支路内变量：
 *   ż_i + z_i/τ_i = ε̇，   σ = E∞·ε + Σ E_i z_i
 * 差别只在于：
 * 1. 温度随采样点变化（T_n 与 (t_n, ε_n) 一起给出）；
 * 2. 状态 (z, t, ε, T) 每次推进后交给上层落库，下一批接着推。
 *
 * 变温下的处理约定（左端点温度保持 / sample-and-hold）
 * ----------------------------------------------------
 * 区间 [t_{n-1}, t_n] 内温度视为常数，取左端点温度 T_{n-1}（区间起点那个
 * 采样点测到的温度），平移因子 a(T_{n-1}) 全程作用于该区间；应变在区间内
 * 仍按相邻采样点线性插值。
 *
 * 引入约化（参考温度）时间 ξ，dξ = dt / a(T)。WLF 等效原理给出
 *   dz_i/dξ + z_i/τ_i = dε/dξ，
 * 即与恒温参考温度下完全相同的方程。在左端点保持约定下，整个区间 a 为常数，
 * 且 ε 随 t 线性 ⇒ ε 随 ξ 线性，因此可直接套用作业内核的“分段线性一步精确
 * 积分”，只需把物理时间步长换成区间折合约化时间
 *   Δξ = Δt / a(T_{n-1})，   f_i = exp(−Δξ/τ_i)。
 * 实现中直接写 f_i = exp(−Δt / (a·τ_i))，与恒温作业内核逐运算一致：
 * 恒温 T（含 T=Tref 与无 WLF）时，这里的结果与作业接口逐位相同。
 *
 * 该约定等价于对 ∫ dt/a(T) 做左端点矩形积分。温度在单个采样区间内线性
 * 变化时，矩形积分与梯形积分都只有 O(Δt) 的离散误差（前者系数随 a 的
 * 曲率增长，见 README 误差讨论）；在采样点之间发生的温度突跳只可能发生
 * 在区间边界（下一个区间立刻采用新温度），不存在跨区间的涂抹，符合
 * “采样时刻测到什么温度，之后那一段就按什么温度松弛”的监测语义。
 */

/** 计算所需的材料快照（开通道时从材料档固化，材料档日后变更不影响已开通道）。 */
export interface TrackMaterialSpec {
  eInf: number;
  branches: Array<{ modulus: number; tau: number }>;
  wlf: { tRef: number; c1: number; c2: number } | null;
}

export interface TrackSample {
  time: number;
  strain: number;
  temperature: number;
}

/** 通道推进到某一点后的完整续算状态；落库后重启可读回继续。 */
export interface TrackState {
  /** 当前（最后一个已处理）采样时刻 */
  time: number;
  /** 当前应变 */
  strain: number;
  /** 当前温度（第一个批次锚定之前为 null） */
  temperature: number | null;
  /** 各 Prony 支路内变量 z_i */
  internal: number[];
  /** 通道是否已被第一个批次锚定（锚定前状态为创建时的静止/初始应变状态） */
  anchored: boolean;
}

export interface BatchSampleResult {
  time: number;
  strain: number;
  temperature: number;
  /** 该采样时刻的应力 σ */
  stress: number;
  /** 该采样时刻温度对应的 WLF 平移因子 a_T（无 WLF 材料恒为 1） */
  shiftFactor: number;
}

export interface ProcessBatchResult {
  /** 每个输入采样点对应的应力与平移因子（顺序、长度与输入一致） */
  results: BatchSampleResult[];
  /** 本批处理完后的通道续算状态 */
  state: TrackState;
}

/** 通道起步：从未加载静止状态创建，可在 t=0 瞬时施加初始应变。 */
export function initialTrackState(
  material: TrackMaterialSpec,
  initialStrain: number,
): TrackState {
  // 阶跃应变瞬时施加：静止过去 ε=0，z_i(0+)=ε0（与作业内核首点处理一致）。
  return {
    time: 0,
    strain: initialStrain,
    temperature: null,
    internal: material.branches.map(() => initialStrain),
    anchored: false,
  };
}

const TIME_TOL_FACTOR = 1e-9;

function timeTol(t: number): number {
  return TIME_TOL_FACTOR * Math.max(1, Math.abs(t));
}

/** 应力：σ = E∞·ε + Σ E_i·z_i。 */
export function stressOf(
  material: TrackMaterialSpec,
  strain: number,
  internal: number[],
): number {
  let s = material.eInf * strain;
  for (let i = 0; i < material.branches.length; i++) {
    s += material.branches[i].modulus * internal[i];
  }
  return s;
}

/**
 * 把一批采样点推进到通道上（纯函数：输入旧状态，返回逐点结果与新状态，
 * 不修改入参状态）。所有序号/重发层面的判断由服务层完成；这里负责：
 * 批次内容校验、与通道当前状态的时间/应变/温度衔接校验、WLF 校验与逐步递推。
 *
 * 首批第一个采样点为通道锚点：其 (t, ε, T) 定义通道的起始时刻与初始温度。
 * 后续批次的第一个采样点必须与通道当前点时刻、应变、温度三者一致
 * （重发边界点的标准做法；不重复该点也允许，见下）。
 * 若首个采样点时刻严格大于通道当前时刻，则视为该点是“新的一点”，
 * 用通道当前温度对桥接区间做推进；时刻早于当前时刻一律拒绝。
 */
export function processSamples(
  material: TrackMaterialSpec,
  state: TrackState,
  samples: TrackSample[],
  options: { initialStrain?: number } = {},
): ProcessBatchResult {
  validateSamples(samples);

  const nBranch = material.branches.length;
  let z = state.internal.slice();
  let tPrev = state.time;
  let epsPrev = state.strain;
  let tempPrev = state.temperature;
  let anchored = state.anchored;

  // 预校验：所有采样点的 WLF 都必须在公式适用范围内，
  // 任何一点越界都整批拒绝、状态不变（在任何状态推进之前完成）。
  if (material.wlf) {
    for (const s of samples) wlfShiftFactor(s.temperature, material.wlf);
  }

  const results: BatchSampleResult[] = [];
  let startIndex = 0;

  if (!anchored) {
    // —— 第一个批次：锚点 ——
    const anchor = samples[0];
    if (options.initialStrain !== undefined && anchor.strain !== options.initialStrain) {
      throw new ViscoError(
        'TRACK_STRAIN_DISCONTINUITY',
        `首批锚点应变 ${anchor.strain} 与开通道指定的初始应变 ${options.initialStrain} 不一致`,
      );
    }
    // 锚定：阶跃瞬时施加 ε_anchor，静止过去 ⇒ z_i = ε_anchor。
    z = new Array<number>(nBranch).fill(anchor.strain);
    tPrev = anchor.time;
    epsPrev = anchor.strain;
    tempPrev = anchor.temperature;
    anchored = true;
    results.push({
      time: anchor.time,
      strain: anchor.strain,
      temperature: anchor.temperature,
      stress: stressOf(material, anchor.strain, z),
      shiftFactor: material.wlf ? wlfShiftFactor(anchor.temperature, material.wlf) : 1,
    });
    startIndex = 1;
  } else if (samples.length > 0 && Math.abs(samples[0].time - state.time) <= timeTol(state.time)) {
    // —— 后续批次重复了边界点：必须与通道当前点完全一致 ——
    const first = samples[0];
    if (first.strain !== state.strain) {
      throw new ViscoError(
        'TRACK_STRAIN_DISCONTINUITY',
        `批次起点应变 ${first.strain} 与通道当前应变 ${state.strain} 不一致，应变历史不连续`,
      );
    }
    if (first.temperature !== state.temperature) {
      throw new ViscoError(
        'TRACK_TEMPERATURE_DISCONTINUITY',
        `批次起点温度 ${first.temperature} 与通道当前温度 ${state.temperature} 不一致，边界点温度必须相接`,
      );
    }
    // 边界点原样回算返回，不推进。
    results.push({
      time: state.time,
      strain: state.strain,
      temperature: state.temperature as number,
      stress: stressOf(material, state.strain, z),
      shiftFactor: material.wlf
        ? wlfShiftFactor(state.temperature as number, material.wlf)
        : 1,
    });
    startIndex = 1;
  } else if (samples.length > 0 && samples[0].time < state.time - timeTol(state.time)) {
    throw new ViscoError(
      'TRACK_BATCH_NOT_CONTIGUOUS',
      `批次起点时刻 ${samples[0].time} 早于通道当前时刻 ${state.time}，时间倒退`,
    );
  }

  for (let k = startIndex; k < samples.length; k++) {
    const s = samples[k];
    const dt = s.time - tPrev;
    if (!(dt > 0)) {
      throw new ViscoError(
        'TIME_NOT_STRICTLY_INCREASING',
        `批次内采样时间必须严格递增（${tPrev} → ${s.time}）`,
      );
    }

    let zNext: number[];
    if (nBranch === 0) {
      zNext = z;
    } else {
      // 左端点温度保持：区间 [tPrev, s.time] 用 tPrev 处温度 T_prev 折时。
      let lambdaI = material.branches.map((b) => b.tau);
      if (material.wlf) {
        const aLeft = wlfShiftFactor(tempPrev as number, material.wlf);
        lambdaI = lambdaI.map((lam) => aLeft * lam);
      }
      zNext = linearAdvance(z, epsPrev, s.strain, dt, lambdaI);
    }

    z = zNext;
    tPrev = s.time;
    epsPrev = s.strain;
    tempPrev = s.temperature;

    results.push({
      time: s.time,
      strain: s.strain,
      temperature: s.temperature,
      stress: stressOf(material, s.strain, z),
      shiftFactor: material.wlf ? wlfShiftFactor(s.temperature, material.wlf) : 1,
    });
  }

  return {
    results,
    state: {
      time: tPrev,
      strain: epsPrev,
      temperature: tempPrev,
      internal: z,
      anchored,
    },
  };
}

/** 批次内容校验：非空、每点字段有限、时间严格递增。 */
export function validateSamples(samples: TrackSample[]): void {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new ViscoError('TRACK_BATCH_EMPTY', '批次至少要包含一个采样点');
  }
  for (const [i, s] of samples.entries()) {
    if (
      !s ||
      typeof s !== 'object' ||
      !Number.isFinite(s.time) ||
      !Number.isFinite(s.strain) ||
      !Number.isFinite(s.temperature)
    ) {
      throw new ViscoError(
        'TRACK_SAMPLE_INVALID',
        `第 ${i + 1} 个采样点的 time/strain/temperature 必须全部为有限数值`,
      );
    }
  }
  for (let k = 1; k < samples.length; k++) {
    if (!(samples[k].time > samples[k - 1].time)) {
      throw new ViscoError(
        'TIME_NOT_STRICTLY_INCREASING',
        `批次内采样时间必须严格递增（位置 ${k}：${samples[k - 1].time} → ${samples[k].time}）`,
      );
    }
  }
}
