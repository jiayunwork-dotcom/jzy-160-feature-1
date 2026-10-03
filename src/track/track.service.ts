import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ViscoError } from '../common/errors';
import { MaterialService } from '../material/material.service';
import {
  TrackBatchDefinition,
  TrackBatchDocument,
  TrackChannelDefinition,
  TrackChannelDocument,
} from '../persistence/track.schema';
import {
  initialTrackState,
  processSamples,
  TrackMaterialSpec,
  TrackSample,
  TrackState,
  validateSamples,
} from './track-kernel';

/** 追加批次入参。 */
export interface AppendBatchInput {
  sequence: number;
  samples: TrackSample[];
}

export interface ChannelStatus {
  id: string;
  materialId: string;
  materialName: string;
  initialStrain: number | null;
  anchored: boolean;
  /** 通道当前推进到的时刻（首批锚定前为 null） */
  currentTime: number | null;
  currentStrain: number | null;
  currentTemperature: number | null;
  /** 续算所需的各支路内变量 z_i */
  internalVariables: number[];
  lastSequence: number | null;
  stateVersion: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface BatchSampleResultDto {
  time: number;
  strain: number;
  temperature: number;
  stress: number;
  shiftFactor: number;
}

export interface AppendBatchResponse {
  channelId: string;
  sequence: number;
  /** 本次（或重发时原样回放的）逐点结果 */
  results: BatchSampleResultDto[];
  channel: ChannelStatus;
  /** true 表示该序号批次此前已提交过，本次为幂等回放，未推进状态 */
  replayed: boolean;
}

export interface BatchSummary {
  sequence: number;
  sampleCount: number;
  firstTime: number;
  lastTime: number;
  createdAt?: Date;
}

/** 并发等待前驱批次的最长时间（前驱进程崩溃的兜底，正常并发远小于此）。 */
const PREDECESSOR_TIMEOUT_MS = 30_000;
/** 跨实例状态版本冲突时的提交重试上限。 */
const COMMIT_RETRY_LIMIT = 6;

/**
 * 单通道调度器：FIFO 票队列 + 序号门闩。
 *
 * 每个请求在到达的同一同步时刻领一张票并登记序号门闩，然后等待两个条件：
 * 1) 轮到自己（FIFO，前一张票的请求已“进门”——无论它之后是否因等前驱而
 *    停在门内，都不堵后面的票进门）；
 * 2) 所有序号更小的在途请求都已结束（门闩释放）。
 * 因此 4,2,1,3 乱序到达时：进门顺序即到达顺序，但执行顺序严格为 1,2,3,4；
 * 前驱永不结束时后继在超时后带 TRACK_PREDECESSOR_TIMEOUT 失败，不影响他人；
 * 任务业务错误只影响自身。临界区由序号条件本身保证互斥（前驱不结束，后继
 * 不开工），不需要额外的锁。
 */
class Gate {
  private waiters: Array<() => void> = [];
  private released = false;
  wait(): Promise<void> {
    if (this.released) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    const ws = this.waiters;
    this.waiters = [];
    ws.forEach((w) => w());
  }
}

export class ChannelScheduler {
  private gates = new Map<number, Gate>();
  /** FIFO 进门链：每个票位在自身“进门”时释放下一位的等待。 */
  private admission: Promise<void> = Promise.resolve();

  run<T>(seq: number, task: () => Promise<T>): Promise<T> {
    this.gates.set(seq, new Gate());
    const deadline = Date.now() + PREDECESSOR_TIMEOUT_MS;

    // 同步地把本票挂到 FIFO 尾部，拿到“前一位已进门”的信号。
    const previousAdmission = this.admission;
    let admit: () => void = () => {};
    this.admission = new Promise<void>((resolve) => {
      admit = resolve;
    });

    const execute = async (): Promise<T> => {
      await previousAdmission.catch(() => {});
      admit(); // 本票已进门，立即允许下一位进门（不等前驱、不持锁）

      // 等所有更小序号的在途前驱结束，带超时。
      while (true) {
        const earlier = [...this.gates.keys()].filter((s) => s < seq);
        if (earlier.length === 0) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new ViscoError(
            'TRACK_PREDECESSOR_TIMEOUT',
            `序号 ${seq} 等待更小序号的前驱批次超过 ${PREDECESSOR_TIMEOUT_MS / 1000}s，前驱可能已丢失`,
          );
        }
        await Promise.race([
          Promise.all(earlier.map((s) => this.gates.get(s)!.wait())),
          new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 25))),
        ]);
      }
      return task();
    };

    return execute().finally(() => {
      const gate = this.gates.get(seq);
      gate?.release();
      this.gates.delete(seq);
    });
  }

  get idle(): boolean {
    return this.gates.size === 0;
  }
}

@Injectable()
export class TrackService {
  private readonly schedulers = new Map<string, ChannelScheduler>();

  constructor(
    @InjectModel(TrackChannelDefinition.name)
    private readonly channelModel: Model<TrackChannelDocument>,
    @InjectModel(TrackBatchDefinition.name)
    private readonly batchModel: Model<TrackBatchDocument>,
    private readonly materialService: MaterialService,
  ) {}

  /** 开通道：引用材料档必须存在；材料参数快照固化，从静止状态起步。 */
  async createChannel(input: {
    materialName: string;
    initialStrain?: number;
  }): Promise<ChannelStatus> {
    const material = await this.materialService.findByName(input.materialName);
    const materialId = await this.materialService.findIdByName(input.materialName);
    const spec: TrackMaterialSpec = {
      eInf: material.eInf,
      branches: material.branches.map((b) => ({ modulus: b.modulus, tau: b.tau })),
      wlf: material.wlf ? { ...material.wlf } : null,
    };
    const initialStrain = input.initialStrain ?? null;
    const state0 = initialTrackState(spec, initialStrain ?? 0);
    const doc = await this.channelModel.create({
      material: {
        id: new Types.ObjectId(materialId),
        name: material.name,
        eInf: spec.eInf,
        branches: spec.branches,
        wlf: spec.wlf,
      },
      initialStrain,
      time: state0.time,
      strain: state0.strain,
      temperature: null,
      internal: state0.internal,
      anchored: false,
      lastSequence: null,
      stateVersion: 0,
    });
    return this.toStatus(doc);
  }

  /** 追加一批采样：幂等、序号检查、并发按序串行、状态原子落库。 */
  async appendBatch(
    channelId: string,
    input: AppendBatchInput,
  ): Promise<AppendBatchResponse> {
    if (!Types.ObjectId.isValid(channelId)) {
      throw new ViscoError('TRACK_NOT_FOUND', `跟踪通道不存在：${channelId}`);
    }
    const sequence = input.sequence;
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
      throw new ViscoError(
        'TRACK_SAMPLE_INVALID',
        `批次序号 sequence 必须是非负整数，收到 ${String(sequence)}`,
      );
    }
    const samples = input.samples as TrackSample[];
    // 结构性错误在排队之前快速失败，不影响通道也不占并发次序。
    validateSamples(samples);

    // 同通道的所有追加走同一调度器（按通道隔离；通道数量即调度器数量，
    // 与通道文档同生命周期，进程重启后随状态从 MongoDB 读回而自然重建）。
    return this.schedulerFor(channelId).run(sequence, () =>
      this.processAppend(channelId, sequence, samples),
    );
  }

  async getChannel(channelId: string): Promise<ChannelStatus> {
    if (!Types.ObjectId.isValid(channelId)) {
      throw new ViscoError('TRACK_NOT_FOUND', `跟踪通道不存在：${channelId}`);
    }
    const doc = await this.channelModel.findById(channelId).exec();
    if (!doc) {
      throw new ViscoError('TRACK_NOT_FOUND', `跟踪通道不存在：${channelId}`);
    }
    return this.toStatus(doc);
  }

  async listBatches(channelId: string): Promise<BatchSummary[]> {
    if (!Types.ObjectId.isValid(channelId)) {
      throw new ViscoError('TRACK_NOT_FOUND', `跟踪通道不存在：${channelId}`);
    }
    const channel = await this.channelModel.findById(channelId).exec();
    if (!channel) {
      throw new ViscoError('TRACK_NOT_FOUND', `跟踪通道不存在：${channelId}`);
    }
    const docs = await this.batchModel
      .find({ channelId: channel._id })
      .sort({ sequence: 1 })
      .exec();
    return docs.map((d) => ({
      sequence: d.sequence,
      sampleCount: d.results.length,
      firstTime: d.results[0]?.time,
      lastTime: d.results[d.results.length - 1]?.time,
      createdAt: d.get('createdAt') as Date | undefined,
    }));
  }

  async getBatch(
    channelId: string,
    sequence: number,
  ): Promise<AppendBatchResponse> {
    const status = await this.getChannel(channelId);
    const doc = await this.batchModel
      .findOne({ channelId: new Types.ObjectId(channelId), sequence })
      .exec();
    if (!doc) {
      throw new ViscoError(
        'TRACK_BATCH_NOT_FOUND',
        `通道 ${channelId} 不存在序号 ${sequence} 的已处理批次`,
      );
    }
    const plain = doc.toObject();
    return {
      channelId,
      sequence: plain.sequence,
      results: plain.results.map((r) => ({ ...r })),
      channel: status,
      replayed: true,
    };
  }

  // ---- 内部实现 ----------------------------------------------------------

  /**
   * 串行临界区：处理一批。整个流程对“状态未被改动”有严格要求——
   * 任何校验失败都在任何写入之前抛出。
   */
  private async processAppend(
    channelId: string,
    sequence: number,
    samples: TrackSample[],
  ): Promise<AppendBatchResponse> {
    for (let attempt = 0; attempt <= COMMIT_RETRY_LIMIT; attempt++) {
      await this.recoverDangling(channelId);
      let channel = await this.channelModel.findById(channelId).exec();
      if (!channel) {
        throw new ViscoError('TRACK_NOT_FOUND', `跟踪通道不存在：${channelId}`);
      }

      // 幂等：同序号重发。
      const existing = await this.batchModel
        .findOne({ channelId: channel._id, sequence })
        .exec();
      if (existing) {
        if (!this.samePayload(existing.samples, samples)) {
          throw new ViscoError(
            'TRACK_SEQUENCE_CONFLICT',
            `序号 ${sequence} 的批次已提交过且内容不同：拒绝覆盖（请检查采集端重发数据）`,
          );
        }
        return {
          channelId,
          sequence,
          results: this.toResultDtos(existing.toObject().results),
          channel: await this.getChannel(channelId),
          replayed: true,
        };
      }

      // 序号次序：首批任意序号；之后必须恰好 lastSequence+1。
      if (channel.lastSequence !== null && channel.lastSequence !== undefined) {
        const expected = channel.lastSequence + 1;
        if (sequence < expected) {
          throw new ViscoError(
            'TRACK_OUT_OF_ORDER',
            `批次序号 ${sequence} 已落后：通道最后处理序号为 ${channel.lastSequence}，期望 ${expected}`,
          );
        }
        if (sequence > expected) {
          throw new ViscoError(
            'TRACK_SEQUENCE_GAP',
            `批次序号跳号：收到 ${sequence}，通道下一个期望序号 ${expected}`,
          );
        }
      }

      const spec = this.materialSpecOf(channel);
      const state: TrackState = {
        time: channel.time,
        strain: channel.strain,
        temperature: channel.temperature ?? null,
        internal: channel.internal.slice(),
        anchored: channel.anchored,
      };

      // 纯函数计算：衔接校验、WLF 分母校验、逐步递推都在这里；
      // 抛错则不写任何数据，通道状态保持原样。
      const computed = processSamples(spec, state, samples, {
        initialStrain: channel.initialStrain ?? undefined,
      });

      // 提交：先插批次文档，再用 stateVersion 做条件更新推进通道。
      // 两步之间崩溃会留下“悬挂批次”，由下次追加时 recoverDangling 补推进，
      // 因此不需要多文档事务（compose 单实例 mongo 也不依赖副本集）。
      try {
        await this.batchModel.create({
          channelId: channel._id,
          sequence,
          samples: samples.map((s) => ({ ...s })),
          results: this.toResultDtos(computed.results),
          endState: computed.state,
        });
      } catch (err) {
        if (this.isDuplicateKey(err)) {
          // 另一个实例抢先插入：转为幂等比对。
          const winner = await this.batchModel
            .findOne({ channelId: channel._id, sequence })
            .exec();
          if (winner && this.samePayload(winner.samples, samples)) {
            return {
              channelId,
              sequence,
              results: this.toResultDtos(winner.toObject().results),
              channel: await this.getChannel(channelId),
              replayed: true,
            };
          }
          throw new ViscoError(
            'TRACK_SEQUENCE_CONFLICT',
            `序号 ${sequence} 的批次已被不同内容的请求提交`,
          );
        }
        throw err;
      }

      const update = await this.channelModel
        .updateOne(
          { _id: channel._id, stateVersion: channel.stateVersion },
          {
            $set: {
              time: computed.state.time,
              strain: computed.state.strain,
              temperature: computed.state.temperature,
              internal: computed.state.internal,
              anchored: computed.state.anchored,
              lastSequence: sequence,
              updatedAt: new Date(),
            },
            $inc: { stateVersion: 1 },
          },
        )
        .exec();

      if (update.matchedCount === 1) {
        return {
          channelId,
          sequence,
          results: this.toResultDtos(computed.results),
          channel: await this.getChannel(channelId),
          replayed: false,
        };
      }
      // 版本失配：另一实例推进过通道，本批成为悬挂批次；整轮重来，
      // recoverDangling 会按序号决定补推进还是与已有数据冲突。
    }
    throw new ViscoError(
      'INVALID_PAYLOAD',
      `序号 ${sequence} 的批次多次提交仍与并发写入冲突，请重发`,
    );
  }

  /**
   * 崩溃对账：把“批次文档存在、通道尚未推进到”的连续批次按序号补推进。
   * 通道未锚定时取序号最小的悬挂批次作为首批锚点。
   *
   * 补推进时不信任批次文档里存的 endState（它可能基于落后状态算出，例如
   * 跨实例竞争落榜），而是用存档的 samples 从通道当前状态重新递推，
   * 保证结果严格等价于按序号串行追加。
   */
  private async recoverDangling(channelId: string): Promise<void> {
    let channel = await this.channelModel.findById(channelId).exec();
    if (!channel) return;
    for (;;) {
      let nextSequence: number;
      if (channel.lastSequence === null || channel.lastSequence === undefined) {
        const first = await this.batchModel
          .findOne({ channelId: channel._id })
          .sort({ sequence: 1 })
          .exec();
        if (!first) return;
        nextSequence = first.sequence;
      } else {
        nextSequence = channel.lastSequence + 1;
      }
      const batch = await this.batchModel
        .findOne({ channelId: channel._id, sequence: nextSequence })
        .exec();
      if (!batch) return;

      const spec = this.materialSpecOf(channel);
      const state: TrackState = {
        time: channel.time,
        strain: channel.strain,
        temperature: channel.temperature ?? null,
        internal: channel.internal.slice(),
        anchored: channel.anchored,
      };
      const samples = (batch.samples as unknown as TrackSample[]).map((s) => ({ ...s }));
      const computed = processSamples(spec, state, samples, {
        initialStrain: channel.initialStrain ?? undefined,
      });
      batch.endState = computed.state;
      batch.set('results', this.toResultDtos(computed.results));
      await batch.save();

      await this.channelModel
        .updateOne(
          { _id: channel._id, stateVersion: channel.stateVersion },
          {
            $set: {
              time: computed.state.time,
              strain: computed.state.strain,
              temperature: computed.state.temperature,
              internal: computed.state.internal,
              anchored: computed.state.anchored,
              lastSequence: batch.sequence,
              updatedAt: new Date(),
            },
            $inc: { stateVersion: 1 },
          },
        )
        .exec();
      const reloaded = await this.channelModel.findById(channelId).exec();
      if (!reloaded) return;
      channel = reloaded;
    }
  }

  private schedulerFor(channelId: string): ChannelScheduler {
    let scheduler = this.schedulers.get(channelId);
    if (!scheduler) {
      scheduler = new ChannelScheduler();
      this.schedulers.set(channelId, scheduler);
    }
    return scheduler;
  }

  private materialSpecOf(channel: TrackChannelDocument): TrackMaterialSpec {
    const m = channel.material;
    return {
      eInf: m.eInf,
      branches: m.branches.map((b) => ({ modulus: b.modulus, tau: b.tau })),
      wlf: m.wlf ? { tRef: m.wlf.tRef, c1: m.wlf.c1, c2: m.wlf.c2 } : null,
    };
  }

  private toResultDtos(
    results: ReadonlyArray<{
      time: number;
      strain: number;
      temperature: number;
      stress: number;
      shiftFactor: number;
    }>,
  ): BatchSampleResultDto[] {
    return results.map((r) => ({
      time: r.time,
      strain: r.strain,
      temperature: r.temperature,
      stress: r.stress,
      shiftFactor: r.shiftFactor,
    }));
  }

  private samePayload(
    stored: Record<string, unknown>[],
    incoming: TrackSample[],
  ): boolean {
    if (stored.length !== incoming.length) return false;
    return stored.every((raw, i) => {
      const s = raw as unknown as TrackSample;
      const q = incoming[i];
      return (
        s.time === q.time && s.strain === q.strain && s.temperature === q.temperature
      );
    });
  }

  private isDuplicateKey(err: unknown): boolean {
    return Boolean(
      err && typeof err === 'object' && (err as { code?: number }).code === 11000,
    );
  }

  private toStatus(doc: TrackChannelDocument): ChannelStatus {
    return {
      id: doc.id,
      materialId: doc.material.id.toString(),
      materialName: doc.material.name,
      initialStrain: doc.initialStrain ?? null,
      anchored: doc.anchored,
      currentTime: doc.anchored ? doc.time : null,
      currentStrain: doc.anchored ? doc.strain : null,
      currentTemperature: doc.anchored ? doc.temperature ?? null : null,
      internalVariables: doc.anchored ? doc.internal.slice() : doc.internal.slice(),
      lastSequence: doc.lastSequence ?? null,
      stateVersion: doc.stateVersion,
      createdAt: doc.get('createdAt') as Date | undefined,
      updatedAt: doc.get('updatedAt') as Date | undefined,
    };
  }
}
