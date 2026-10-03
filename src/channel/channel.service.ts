import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ViscoError } from '../common/errors';
import { MaterialService } from '../material/material.service';
import { wlfShiftFactor } from '../wlf/wlf.service';
import {
  advanceChannel,
  ChannelMaterialSnapshot,
  ChannelRuntimeState,
  ChannelSample,
  ChannelSampleResult,
  initialChannelState,
  validateSamples,
} from './channel.model';
import { ChannelDocument, ChannelDocumentDefinition } from '../persistence/channel.schema';

export interface CreateChannelInput {
  materialName: string;
  description?: string;
  /** t=0 瞬时施加的初始应变；缺省 0（静止起步） */
  initialStrain?: number;
  /** 初始温度；材料带 WLF 且首批采样晚于 t=0 时必填 */
  initialTemperature?: number;
}

export interface AppendBatchInput {
  seq: number;
  samples: ChannelSample[];
}

export interface ChannelStateView {
  id: string;
  materialName: string;
  description?: string;
  initialStrain: number;
  initialTemperature: number | null;
  initialized: boolean;
  currentTime: number;
  lastStrain: number;
  lastTemperature: number | null;
  reducedTime: number;
  /** 下一个期望批次序号 */
  nextSeq: number;
  /** 已处理批次数 */
  batchCount: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface BatchSummary {
  seq: number;
  receivedAt: Date;
  sampleCount: number;
  startTime: number;
  endTime: number;
}

export interface AppendBatchOutput {
  channelId: string;
  seq: number;
  /** true 表示本次为重发（内容相同），直接返回上次结果、通道未推进 */
  duplicate: boolean;
  state: ChannelStateView;
  results: ChannelSampleResult[];
}

function materialSnapshot(doc: ChannelDocument): ChannelMaterialSnapshot {
  // 注意：wlf 是 Mongoose 内嵌文档，不能用展开（{...doc.material.wlf} 会带上 $__ 等内部键、
  // 丢掉自有字段），必须逐字段取值。
  return {
    name: doc.material.name,
    eInf: doc.material.eInf,
    branches: doc.material.branches.map((b) => ({ modulus: b.modulus, tau: b.tau })),
    wlf: doc.material.wlf
      ? { tRef: doc.material.wlf.tRef, c1: doc.material.wlf.c1, c2: doc.material.wlf.c2 }
      : null,
  };
}

function runtimeState(doc: ChannelDocument): ChannelRuntimeState {
  return {
    initialized: doc.initialized,
    currentTime: doc.currentTime,
    lastStrain: doc.lastStrain,
    lastTemperature: doc.lastTemperature ?? null,
    reducedTime: doc.reducedTime,
    z: doc.z.slice(),
  };
}

function stateView(doc: ChannelDocument): ChannelStateView {
  const batches = doc.batches ?? [];
  return {
    id: doc.id,
    materialName: doc.materialName,
    description: doc.description,
    initialStrain: doc.initialStrain,
    initialTemperature: doc.initialTemperature ?? null,
    initialized: doc.initialized,
    currentTime: doc.currentTime,
    lastStrain: doc.lastStrain,
    lastTemperature: doc.lastTemperature ?? null,
    reducedTime: doc.reducedTime,
    nextSeq: doc.nextSeq,
    batchCount: batches.length,
    createdAt: doc.get('createdAt') as Date | undefined,
    updatedAt: doc.get('updatedAt') as Date | undefined,
  };
}

function samplesEqual(a: ChannelSample[], b: ChannelSample[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].time !== b[i].time || a[i].strain !== b[i].strain || a[i].temperature !== b[i].temperature) {
      return false;
    }
  }
  return true;
}

@Injectable()
export class ChannelService {
  /**
   * 序号缺口的有限等待（毫秒）。连续序号的批次并发/乱序到达时在此等待先到的批次落库；
   * 真跳号（缺的序号永远不会来）在宽限期过后按 CHANNEL_SEQ_GAP 拒绝。
   * 可用环境变量 CHANNEL_GRACE_MS 调整（默认 250ms）。每次读取，便于测试覆盖。
   */
  private get gapGraceMs(): number {
    return Number(process.env.CHANNEL_GRACE_MS ?? 250);
  }
  private readonly gapPollMs = 5;

  /**
   * 本进程内“在途追加”的序号登记表（通道 → 序号 → 完成承诺）。
   * 乱序/并发到达时，缺口请求先等缺失序号进入在途（宽限内登记），再 await
   * 该序号完成承诺：前序一落库即被唤醒。多实例部署时该表不共享，
   * 跨进程互斥仍由落库 CAS 保证；跨进程乱序在宽限期内靠轮询 DB 观察到前序落库。
   */
  private readonly inFlight = new Map<string, Map<number, { done: Promise<void>; settle: () => void }>>();

  constructor(
    @InjectModel(ChannelDocumentDefinition.name)
    private readonly channelModel: Model<ChannelDocument>,
    private readonly materialService: MaterialService,
  ) {}

  async create(input: CreateChannelInput): Promise<ChannelStateView> {
    const initialStrain = input.initialStrain ?? 0;
    if (!Number.isFinite(initialStrain)) {
      throw new ViscoError('INVALID_PAYLOAD', '初始应变 initialStrain 必须是有限数值');
    }
    let initialTemperature: number | null = null;
    if (input.initialTemperature !== undefined) {
      if (!Number.isFinite(input.initialTemperature)) {
        throw new ViscoError('INVALID_PAYLOAD', '初始温度 initialTemperature 必须是有限数值');
      }
      initialTemperature = input.initialTemperature;
    }

    const material = await this.materialService.findByName(input.materialName);
    const materialId = await this.materialService.findIdByName(input.materialName);

    // 带 WLF 时开通道即验证初始温度在适用范围内（分母非正），fail fast。
    if (material.wlf && initialTemperature !== null) {
      wlfShiftFactor(initialTemperature, material.wlf);
    }

    const init = initialChannelState(material.branches.length, initialStrain, initialTemperature);
    const doc = await this.channelModel.create({
      materialId: new Types.ObjectId(materialId),
      materialName: material.name,
      material: {
        name: material.name,
        eInf: material.eInf,
        branches: material.branches.map((b) => ({ modulus: b.modulus, tau: b.tau })),
        wlf: material.wlf ?? undefined,
      },
      description: input.description,
      initialStrain,
      initialTemperature,
      initialized: init.initialized,
      currentTime: init.currentTime,
      lastStrain: init.lastStrain,
      lastTemperature: init.lastTemperature,
      reducedTime: init.reducedTime,
      z: init.z,
      nextSeq: 1,
      batches: [],
    });
    return stateView(doc);
  }

  async getState(channelId: string): Promise<ChannelStateView> {
    const doc = await this.requireChannel(channelId);
    return stateView(doc);
  }

  async listBatches(channelId: string): Promise<BatchSummary[]> {
    const doc = await this.requireChannel(channelId);
    return doc.batches.map((b) => ({
      seq: b.seq,
      receivedAt: b.receivedAt,
      sampleCount: b.samples.length,
      startTime: b.samples[0].time,
      endTime: b.samples[b.samples.length - 1].time,
    }));
  }

  async getBatch(
    channelId: string,
    seq: number,
  ): Promise<{ seq: number; receivedAt: Date; samples: ChannelSample[]; results: ChannelSampleResult[] }> {
    const doc = await this.requireChannel(channelId);
    const batch = doc.batches.find((b) => b.seq === seq);
    if (!batch) {
      throw new ViscoError('CHANNEL_BATCH_NOT_FOUND', `通道 ${channelId} 不存在序号 ${seq} 的批次`);
    }
    return {
      seq: batch.seq,
      receivedAt: batch.receivedAt,
      samples: batch.samples.map((s) => ({ time: s.time, strain: s.strain, temperature: s.temperature })),
      results: batch.results.map((r) => ({
        time: r.time,
        strain: r.strain,
        temperature: r.temperature,
        stress: r.stress,
        shiftFactor: r.shiftFactor,
        reducedTime: r.reducedTime,
      })),
    };
  }

  /**
   * 追加一批采样。
   *
   * 语义：
   * - seq 必须为 ≥1 的整数；批次非空、时间严格递增（纯结构校验先于一切状态操作）。
   * - seq < nextSeq：重发。内容与存档逐字段相同 ⇒ 原样返回上次结果、不推进；
   *   内容不同 ⇒ CHANNEL_BATCH_CONFLICT，通道状态不变。
   * - seq > nextSeq：序号缺口。缺口序号当前在本进程在途（并发/乱序）时有限等待；
   *   宽限期后仍缺 ⇒ CHANNEL_SEQ_GAP，通道状态不变。
   * - seq === nextSeq：内核推进 + 条件更新原子落库（filter 带 nextSeq / currentTime 旧值，
   *   配合 __v 乐观锁）。两个进程不可能基于同一旧状态同时推进。
   */
  async append(channelId: string, input: AppendBatchInput): Promise<AppendBatchOutput> {
    if (!Number.isInteger(input.seq) || input.seq < 1) {
      throw new ViscoError('INVALID_PAYLOAD', `批次序号 seq 必须是不小于 1 的整数，收到 ${String(input.seq)}`);
    }
    validateSamples(input.samples);
    const samples: ChannelSample[] = input.samples.map((s) => ({ ...s }));

    const arrival = this.markInFlight(channelId, input.seq);
    try {
      const grace = this.gapGraceMs;
      // 单一截止时刻：从进入开始算，阶段一等缺失序号“在途登记”，阶段二等其落库，
      // 总等待有界——真跳号最多挂起 grace 毫秒即被拒绝；乱序/并发在宽限内到达则被放行。
      const deadline = Date.now() + grace;

      // 阶段一：等待前序缺口都已“在途”（容忍先到 seq=k、晚几毫秒才提交 seq=k−1 的乱序）。
      for (;;) {
        let doc = await this.requireChannel(channelId);
        if (input.seq <= doc.nextSeq || this.areMissingInFlight(channelId, doc.nextSeq, input.seq)) {
          break;
        }
        if (Date.now() >= deadline) {
          throw new ViscoError(
            'CHANNEL_SEQ_GAP',
            `批次序号跳号：期望下一个序号 ${doc.nextSeq}，收到 ${input.seq}（${grace}ms 内未见前序批次到达），已拒绝且通道状态不变`,
          );
        }
        const wait = Math.min(this.gapPollMs, deadline - Date.now());
        await this.sleep(wait);
      }

      for (;;) {
        let doc = await this.requireChannel(channelId);

        // 1) 重发路径
        if (input.seq < doc.nextSeq) {
          const stored = doc.batches.find((b) => b.seq === input.seq);
          if (!stored) {
            // 理论上不会发生（nextSeq 只随批次压入而推进），防御性报错。
            throw new ViscoError('CHANNEL_BATCH_NOT_FOUND', `通道缺少序号 ${input.seq} 的历史批次存档`);
          }
          if (!samplesEqual(samples, stored.samples)) {
            throw new ViscoError(
              'CHANNEL_BATCH_CONFLICT',
              `序号 ${input.seq} 的批次已处理过，但本次内容与存档不一致（重发必须逐字段相同），已拒绝且通道状态不变`,
            );
          }
          const fresh = await this.requireChannel(channelId);
          return {
            channelId,
            seq: input.seq,
            duplicate: true,
            state: stateView(fresh),
            results: stored.results.map((r) => ({
              time: r.time,
              strain: r.strain,
              temperature: r.temperature,
              stress: r.stress,
              shiftFactor: r.shiftFactor,
              reducedTime: r.reducedTime,
            })),
          };
        }

        // 2) 缺口路径：等所有缺失序号落库。缺失序号在本进程在途就等其完成承诺；
        //    否则（跨进程乱序等）轮询数据库；超过截止时刻仍缺 ⇒ 真跳号，拒绝且状态不变。
        if (input.seq > doc.nextSeq) {
          if (Date.now() >= deadline) {
            throw new ViscoError(
              'CHANNEL_SEQ_GAP',
              `批次序号跳号：期望下一个序号 ${doc.nextSeq}，收到 ${input.seq}（${grace}ms 内前序批次未落库），已拒绝且通道状态不变`,
            );
          }
          const awaitable = this.nextMissingInFlight(channelId, doc.nextSeq);
          if (awaitable) {
            await Promise.race([
              awaitable.done,
              this.sleep(Math.max(1, deadline - Date.now())),
            ]);
          } else {
            await this.sleep(Math.min(this.gapPollMs, Math.max(1, deadline - Date.now())));
          }
          continue;
        }

        // 3) 正常推进路径（seq === nextSeq）
        const material = materialSnapshot(doc);
        const stateBefore = runtimeState(doc);
        const { results, newState } = advanceChannel({ material, state: stateBefore, samples });

        const updated = await this.channelModel.findOneAndUpdate(
          {
            _id: doc._id,
            __v: doc.__v,
            nextSeq: input.seq,
            currentTime: stateBefore.currentTime,
          },
          {
            $set: {
              initialized: newState.initialized,
              currentTime: newState.currentTime,
              lastStrain: newState.lastStrain,
              lastTemperature: newState.lastTemperature,
              reducedTime: newState.reducedTime,
              z: newState.z,
              nextSeq: input.seq + 1,
            },
            $inc: { __v: 1 },
            $push: {
              batches: {
                seq: input.seq,
                receivedAt: new Date(),
                samples,
                results,
              },
            },
          },
          { new: true },
        );

        if (!updated) {
          // 通道在计算期间被其它请求推进：重读后按新状态走重发/缺口/推进分支。
          continue;
        }
        const after = await this.requireChannel(channelId);
        return {
          channelId,
          seq: input.seq,
          duplicate: false,
          state: stateView(after),
          results: results.map((r) => ({ ...r })),
        };
      }
    } finally {
      arrival.settle();
      this.clearInFlight(channelId, input.seq);
    }
  }

  private async requireChannel(channelId: string): Promise<ChannelDocument> {
    if (!Types.ObjectId.isValid(channelId)) {
      throw new ViscoError('CHANNEL_NOT_FOUND', `通道不存在：${channelId}`);
    }
    const doc = await this.channelModel.findById(channelId).exec();
    if (!doc) {
      throw new ViscoError('CHANNEL_NOT_FOUND', `通道不存在：${channelId}`);
    }
    return doc;
  }

  private markInFlight(
    channelId: string,
    seq: number,
  ): { done: Promise<void>; settle: () => void } {
    let map = this.inFlight.get(channelId);
    if (!map) {
      map = new Map();
      this.inFlight.set(channelId, map);
    }
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry = { done, settle };
    map.set(seq, entry);
    return entry;
  }

  private clearInFlight(channelId: string, seq: number): void {
    const map = this.inFlight.get(channelId);
    if (map) {
      map.delete(seq);
      if (map.size === 0) this.inFlight.delete(channelId);
    }
  }

  /** 缺口 [fromSeq, toSeq) 是否都已在本进程登记在途。 */
  private areMissingInFlight(channelId: string, fromSeq: number, toSeq: number): boolean {
    const map = this.inFlight.get(channelId);
    if (!map) return false;
    for (let s = fromSeq; s < toSeq; s++) {
      if (!map.has(s)) return false;
    }
    return true;
  }

  /** 取缺口里第一个在本进程在途的序号的完成承诺（没有则 null，调用方轮询数据库）。 */
  private nextMissingInFlight(
    channelId: string,
    fromSeq: number,
  ): { done: Promise<void>; settle: () => void } | null {
    const map = this.inFlight.get(channelId);
    if (!map) return null;
    return map.get(fromSeq) ?? null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
