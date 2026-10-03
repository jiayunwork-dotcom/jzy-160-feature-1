import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** 开通道时固化的材料参数快照（与 track-batches 分开存放于通道文档）。 */
@Schema({ _id: false })
export class TrackBranchSnapshotModel {
  @Prop({ required: true })
  modulus!: number;

  @Prop({ required: true })
  tau!: number;
}

@Schema({ _id: false })
export class TrackWlfSnapshotModel {
  @Prop({ required: true })
  tRef!: number;

  @Prop({ required: true })
  c1!: number;

  @Prop({ required: true })
  c2!: number;
}

@Schema({ _id: false })
export class TrackMaterialRefModel {
  @Prop({ type: Types.ObjectId, required: true })
  id!: Types.ObjectId;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  eInf!: number;

  @Prop({ type: [TrackBranchSnapshotModel], default: [] })
  branches!: TrackBranchSnapshotModel[];

  @Prop({ type: TrackWlfSnapshotModel, required: false, _id: false })
  wlf?: TrackWlfSnapshotModel | null;
}

/** 单采样点结果（时间、应变、温度、应力、平移因子）。 */
@Schema({ _id: false })
export class TrackSampleResultModel {
  @Prop({ required: true })
  time!: number;

  @Prop({ required: true })
  strain!: number;

  @Prop({ required: true })
  temperature!: number;

  @Prop({ required: true })
  stress!: number;

  @Prop({ required: true })
  shiftFactor!: number;
}

const TrackSampleResultSchema = SchemaFactory.createForClass(TrackSampleResultModel);

/**
 * 跟踪通道文档。
 *
 * 续算状态（time/strain/temperature/internal/anchored）即“下一批能直接接着
 * 算所需的全部状态”，随每批原子推进；lastSequence 为最后已提交批次的客户端
 * 序号。状态推进采用带版本条件的更新（见 TrackService），保证两个采集进程
 * 并发追加时等价于按序号逐批串行。
 */
@Schema({ timestamps: true, collection: 'trackchannels' })
export class TrackChannelDefinition {
  @Prop({ type: TrackMaterialRefModel, required: true, _id: false })
  material!: TrackMaterialRefModel;

  /** 开通道时给定的初始应变；未给定为 null（首批锚点应变即为初始应变） */
  @Prop({ type: Number, required: false })
  initialStrain?: number | null;

  @Prop({ required: true, default: 0 })
  time!: number;

  @Prop({ required: true, default: 0 })
  strain!: number;

  @Prop({ type: Number, required: false })
  temperature?: number | null;

  /** Prony 支路内变量 z_i */
  @Prop({ type: [Number], default: [] })
  internal!: number[];

  @Prop({ required: true, default: false })
  anchored!: boolean;

  /** 最后已提交批次的序号；通道未锚定（首批未到）时为 null */
  @Prop({ type: Number, required: false })
  lastSequence?: number | null;

  /** 乐观并发版本：每次状态推进 +1 */
  @Prop({ required: true, default: 0 })
  stateVersion!: number;
}

export type TrackChannelDocument = HydratedDocument<TrackChannelDefinition>;
export const TrackChannelSchema = SchemaFactory.createForClass(TrackChannelDefinition);

/**
 * 已处理批次文档。序号在通道内唯一（(channelId, sequence) 复合唯一索引），
 * 重发同序号批次时据此原样返回。逐点结果随文档持久化。
 */
@Schema({ timestamps: true, collection: 'trackbatches' })
export class TrackBatchDefinition {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  channelId!: Types.ObjectId;

  @Prop({ required: true })
  sequence!: number;

  /** 原始入参（用于重发内容比对） */
  @Prop({ type: [Object], required: true })
  samples!: Record<string, unknown>[];

  /** 逐点结果 */
  @Prop({ type: [TrackSampleResultSchema], required: true })
  results!: TrackSampleResultModel[];

  /** 本批提交后通道推进到的状态（便于对账/诊断） */
  @Prop({ type: Object, required: true })
  endState!: {
    time: number;
    strain: number;
    temperature: number | null;
    internal: number[];
    anchored: boolean;
  };
}

export type TrackBatchDocument = HydratedDocument<TrackBatchDefinition>;
export const TrackBatchSchema = SchemaFactory.createForClass(TrackBatchDefinition);

// 同通道内序号唯一：重发落同一文档，不同内容由服务层比对拒绝。
TrackBatchSchema.index({ channelId: 1, sequence: 1 }, { unique: true });
