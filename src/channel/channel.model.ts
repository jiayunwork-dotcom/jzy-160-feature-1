import { ViscoError } from '../common/errors';
import { WlfParams } from '../material/material.model';
import { wlfShiftFactor } from '../wlf/wlf.service';

/**
 * 跟踪通道（长期服役监测）域模型与变温递推内核（纯函数，不依赖控制器/数据库）。
 *
 * 与作业接口的区别：作业一次收下完整历程、单遍算完；通道从静止状态起步，
 * 客户端按批次（每批一串紧接的采样点：时间、应变、温度）持续追加，
 * 内核状态（每支路内变量 z_i、当前时刻/应变/温度、累计约化时间）可落库、可恢复。
 *
 * 本构（与作业内核相同的广义 Maxwell / Prony 松弛表示）：
 *   ż_i + z_i/τ_i = ε̇,   σ(t) = E∞·ε(t) + Σ E_i z_i(t)
 *
 * 变温与约化时间（材料档带 WLF 时）：
 *   定义约化时间 ξ，dξ/dt = 1/a_T(T(t))，即 dτ_eff = a_T·dt = dξ·τ（参考温）。
 *   支路方程改写为  dz_i/dξ + z_i/τ_i = dε/dξ。
 *   采样点之间温度视为线性变化；区间 [ta,tb] 的约化时间增量用**梯形公式**
 *     Δξ = (tb − ta) · (1/a_T(Ta) + 1/a_T(Tb)) / 2
 *   应变在该区间按约化时间线性（割线率 rξ = (εb − εa)/Δξ），一步精确积分：
 *     z_i^b = f_i z_i^a + rξ·τ_i·(1 − f_i),  f_i = exp(−Δξ/τ_i)
 *   恒温时 Δξ = Δt/a_T、rξ = a_T·r_t，上式与作业内核的恒温推进
 *     z' = f z + r_t·(a_T τ)·(1 − f) 逐项恒等（见 channel-kernel.spec）。
 */

/** 开通道时随通道固化的材料快照（材料档日后改动不影响在役通道，重启续算也无需回查）。 */
export interface ChannelMaterialSnapshot {
  name: string;
  eInf: number;
  branches: Array<{ modulus: number; tau: number }>;
  wlf?: WlfParams | null;
}

/** 一个采样点（物理时间、应变、当时温度）。 */
export interface ChannelSample {
  time: number;
  strain: number;
  temperature: number;
}

/** 一个采样点的计算结果。 */
export interface ChannelSampleResult {
  time: number;
  strain: number;
  temperature: number;
  /** 该采样时刻的应力 σ */
  stress: number;
  /** 该采样时刻的 WLF 平移因子 a_T（材料档无 WLF 时恒为 1） */
  shiftFactor: number;
  /** 推进到该采样时刻后累计的约化时间 ξ（无 WLF 时等于物理时间） */
  reducedTime: number;
}

/**
 * 通道的完整推进状态：下一批“接着算”所需的全部信息。
 * initialized=false 表示还没有任何采样点，z 按初始瞬时应变预置（静止起步时为 0）。
 */
export interface ChannelRuntimeState {
  initialized: boolean;
  /** 通道已推进到的物理时刻 */
  currentTime: number;
  /** 末尾采样点的应变（未初始化时为开通道时瞬时施加的初始应变） */
  lastStrain: number;
  /** 末尾采样点的温度（未初始化且未给初始温度时为 null） */
  lastTemperature: number | null;
  /** 累计约化时间 ξ */
  reducedTime: number;
  /** 各 Prony 支路内变量 */
  z: number[];
}

export interface AdvanceChannelInput {
  material: ChannelMaterialSnapshot;
  state: ChannelRuntimeState;
  samples: ChannelSample[];
}

export interface AdvanceChannelResult {
  /** 每个输入采样点对应的结果（等长、同序） */
  results: ChannelSampleResult[];
  /** 推进到本批末尾后的新通道状态 */
  newState: ChannelRuntimeState;
}

/** 通道创建时的静止/初始瞬时加载状态。 */
export function initialChannelState(
  branchCount: number,
  initialStrain: number,
  initialTemperature: number | null,
): ChannelRuntimeState {
  // 静止过去 ε=0；初始应变在 t=0 瞬时施加 ⇒ z_i(0+)=ε0（与作业内核初始化一致）。
  return {
    initialized: false,
    currentTime: 0,
    lastStrain: initialStrain,
    lastTemperature: initialTemperature,
    reducedTime: 0,
    z: new Array(branchCount).fill(initialStrain),
  };
}

/**
 * 校验并推进一批采样。纯函数：不修改输入 state，返回新状态。
 * 调用方（服务层）负责序号/批次衔接/落库；本函数只保证：
 * - 批次非空、字段有限、时间严格递增；
 * - 未初始化通道首个 t=0 采样点应变必须等于初始瞬时应变（不允许加载间断）；
 * - 已初始化通道首批时间必须严格晚于当前时刻（批次边界不共用点、不倒退）；
 * - 带 WLF 时区间两端温度必须已知且落在 WLF 适用范围（分母 > 0）。
 */
export function advanceChannel(input: AdvanceChannelInput): AdvanceChannelResult {
  const { material, state, samples } = input;
  validateSamples(samples);

  const moduli = material.branches.map((b) => b.modulus);
  const taus = material.branches.map((b) => b.tau);
  const results: ChannelSampleResult[] = [];

  let z = state.z.slice();
  let currentTime = state.currentTime;
  let lastStrain = state.lastStrain;
  let lastTemperature = state.lastTemperature;
  let reducedTime = state.reducedTime;
  let initialized = state.initialized;

  for (let k = 0; k < samples.length; k++) {
    const sample = samples[k];

    if (!initialized) {
      // 通道的第一个采样点：t=0 与初始瞬时加载对齐（允许 t0>0：在初始温度下保持到 t0）。
      if (sample.time < 0) {
        throw new ViscoError(
          'CHANNEL_BATCH_TIME_REGRESSION',
          `首个采样点时间不能为负（收到 ${sample.time}），通道从 t=0 起步`,
        );
      }
      if (sample.time === 0) {
        if (sample.strain !== lastStrain) {
          throw new ViscoError(
            'CHANNEL_STRAIN_DISCONTINUITY',
            `首个采样点应变 ${sample.strain} 与开通道时瞬时施加的初始应变 ${lastStrain} 不一致，通道不允许在 t=0 处出现加载间断`,
          );
        }
      }
      if (sample.time > 0) {
        if (material.wlf && lastTemperature === null) {
          throw new ViscoError(
            'CHANNEL_INITIAL_TEMPERATURE_REQUIRED',
            '材料档带 WLF 参数且首个采样点晚于 t=0 时，开通道必须指定初始温度 initialTemperature，才能计算 t=0 到首个采样点之间的松弛',
          );
        }
        // 初始应变瞬时施加后、在初始温度（无 WLF 时温度不参与）下保持到首个采样点。
        const advance = integrateInterval({
          taus,
          wlf: material.wlf ?? null,
          tA: 0,
          tB: sample.time,
          tempA: lastTemperature,
          tempB: sample.temperature,
          strainA: lastStrain,
          strainB: sample.strain,
          z,
          reducedTime,
        });
        z = advance.z;
        reducedTime = advance.reducedTimeB;
      }
      const aT = material.wlf ? wlfShiftFactor(sample.temperature, material.wlf) : 1;
      const stress = material.eInf * sample.strain + branchStress(moduli, z);
      results.push({
        time: sample.time,
        strain: sample.strain,
        temperature: sample.temperature,
        stress,
        shiftFactor: aT,
        reducedTime,
      });
      initialized = true;
      currentTime = sample.time;
      lastStrain = sample.strain;
      lastTemperature = sample.temperature;
      continue;
    }

    // 已初始化：每个采样点都是“当前时刻 → 该采样时刻”的一段。
    if (!(sample.time > currentTime)) {
      throw new ViscoError(
        'CHANNEL_BATCH_TIME_REGRESSION',
        `采样时间 ${sample.time} 必须严格晚于通道当前时刻 ${currentTime}（批次间不允许重复/倒退边界点）`,
      );
    }
    if (material.wlf && lastTemperature === null) {
      // 正常流程到不了：初始化时温度必然已经记录；防御性检查。
      throw new ViscoError(
        'CHANNEL_INITIAL_TEMPERATURE_REQUIRED',
        '通道缺少上一时刻温度，无法计算变温松弛（请确认首个批次带有温度）',
      );
    }
    const advance = integrateInterval({
      taus,
      wlf: material.wlf ?? null,
      tA: currentTime,
      tB: sample.time,
      tempA: lastTemperature,
      tempB: sample.temperature,
      strainA: lastStrain,
      strainB: sample.strain,
      z,
      reducedTime,
    });
    z = advance.z;
    reducedTime = advance.reducedTimeB;

    const aT = material.wlf ? wlfShiftFactor(sample.temperature, material.wlf) : 1;
    const stress = material.eInf * sample.strain + branchStress(moduli, z);
    results.push({
      time: sample.time,
      strain: sample.strain,
      temperature: sample.temperature,
      stress,
      shiftFactor: aT,
      reducedTime,
    });
    currentTime = sample.time;
    lastStrain = sample.strain;
    lastTemperature = sample.temperature;
  }

  return {
    results,
    newState: {
      initialized,
      currentTime,
      lastStrain,
      lastTemperature,
      reducedTime,
      z,
    },
  };
}

interface IntervalInput {
  taus: number[];
  wlf: WlfParams | null;
  tA: number;
  tB: number;
  tempA: number | null;
  tempB: number;
  strainA: number;
  strainB: number;
  z: number[];
  reducedTime: number;
}

/**
 * 推进一个采样区间 [tA,tB]。
 *
 * 温度在区间内线性：1/a_T(T(t)) 用两端梯形平均；
 * 应变在约化时间上线性（割线率），支路一步精确积分（同作业内核线性段公式）。
 * 无 WLF 时 a_T≡1，Δξ=Δt，即恒温参考温度的普通递推。
 */
function integrateInterval(input: IntervalInput): { z: number[]; reducedTimeB: number } {
  const { taus, wlf, tA, tB, tempA, tempB, strainA, strainB, z, reducedTime } = input;
  const dt = tB - tA;

  let invA = 1;
  let invB = 1;
  let aTb = 1;
  if (wlf) {
    // tempA===null 在调用前已拦截（首个点 t>0 必须有初始温度）。
    const aTa = wlfShiftFactor(tempA as number, wlf);
    aTb = wlfShiftFactor(tempB, wlf);
    invA = 1 / aTa;
    invB = 1 / aTb;
  }
  const dXi = dt * 0.5 * (invA + invB);
  const rateXi = (strainB - strainA) / dXi;

  const result = new Array<number>(z.length);
  for (let i = 0; i < z.length; i++) {
    const f = Math.exp(-dXi / taus[i]);
    result[i] = f * z[i] + rateXi * taus[i] * (1 - f);
  }
  return { z: result, reducedTimeB: reducedTime + dXi };
}

function branchStress(moduli: number[], z: number[]): number {
  let s = 0;
  for (let i = 0; i < z.length; i++) s += moduli[i] * z[i];
  return s;
}

/** 批次结构与逐点校验（时间严格递增、全部有限）。 */
export function validateSamples(samples: unknown): asserts samples is ChannelSample[] {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new ViscoError('CHANNEL_BATCH_EMPTY', '批次必须包含至少一个采样点');
  }
  for (let k = 0; k < samples.length; k++) {
    const s: unknown = samples[k];
    if (!s || typeof s !== 'object') {
      throw new ViscoError('INVALID_PAYLOAD', `第 ${k + 1} 个采样点必须是对象 {time, strain, temperature}`);
    }
    const point = s as Partial<ChannelSample>;
    if (
      typeof point.time !== 'number' ||
      typeof point.strain !== 'number' ||
      typeof point.temperature !== 'number' ||
      ![point.time, point.strain, point.temperature].every(Number.isFinite)
    ) {
      throw new ViscoError('INVALID_PAYLOAD', `第 ${k + 1} 个采样点的 time/strain/temperature 必须是有限数值`);
    }
    if (k > 0) {
      const prevTime = (samples[k - 1] as ChannelSample).time;
      if (!(point.time > prevTime)) {
        throw new ViscoError(
          'TIME_NOT_STRICTLY_INCREASING',
          `批次内采样时间必须严格递增（位置 ${k + 1}：${prevTime} → ${point.time}）`,
        );
      }
    }
  }
}
