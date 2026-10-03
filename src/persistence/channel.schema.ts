import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { WlfParamsModel } from './material.schema';

/** 开通道时固化的材料参数快照（保证重启续算与材料档后续改动无关）。 */
@Schema({ _id: false })
export class ChannelMaterialModel {
  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  eInf!: number;

  @Prop({
    type: [
      {
        modulus: { type: Number, required: true },
        tau: { type: Number, required: true },
      },
    ],
    _id: false,
    default: [],
  })
  branches!: { modulus: number; tau: number }[];

  @Prop({ type: WlfParamsModel, required: false, _id: false })
  wlf?: WlfParamsModel | null;
}

const ChannelMaterialSchema = SchemaFactory.createForClass(ChannelMaterialModel);

/** 已处理批次的存档：重发原样返回的依据。 */
@Schema({ _id: false })
export class ChannelBatchModel {
  /** 客户端编制的连续序号（从 1 开始） */
  @Prop({ required: true })
  seq!: number;

  /** 收到并落库的时间 */
  @Prop({ required: true })
  receivedAt!: Date;

  @Prop({
    type: [
      {
        time: { type: Number, required: true },
        strain: { type: Number, required: true },
        temperature: { type: Number, required: true },
      },
    ],
    _id: false,
    default: [],
  })
  samples!: { time: number; strain: number; temperature: number }[];

  @Prop({
    type: [
      {
        time: Number,
        strain: Number,
        temperature: Number,
        stress: Number,
        shiftFactor: Number,
        reducedTime: Number,
      },
    ],
    _id: false,
    default: [],
  })
  results!: {
    time: number;
    strain: number;
    temperature: number;
    stress: number;
    shiftFactor: number;
    reducedTime: number;
  }[];
}

const ChannelBatchSchema = SchemaFactory.createForClass(ChannelBatchModel);

@Schema({ timestamps: true, collection: 'channels' })
export class ChannelDocumentDefinition {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  materialId!: Types.ObjectId;

  @Prop({ required: true })
  materialName!: string;

  /** 固化的材料快照 */
  @Prop({ type: ChannelMaterialSchema, required: true, _id: false })
  material!: ChannelMaterialModel;

  @Prop()
  description?: string;

  /** 开通道时在 t=0 瞬时施加的初始应变（静止起步为 0） */
  @Prop({ required: true, default: 0 })
  initialStrain!: number;

  /** 初始温度（首个采样点晚于 t=0 且材料带 WLF 时必填） */
  @Prop({ type: Number, required: false })
  initialTemperature?: number | null;

  // ---- 推进状态（下一批接着算所需的全部信息）----

  @Prop({ required: true, default: false })
  initialized!: boolean;

  @Prop({ required: true, default: 0 })
  currentTime!: number;

  @Prop({ required: true, default: 0 })
  lastStrain!: number;

  @Prop({ type: Number, required: false })
  lastTemperature?: number | null;

  @Prop({ required: true, default: 0 })
  reducedTime!: number;

  @Prop({ type: [Number], default: [] })
  z!: number[];

  /** 下一个期望收到的批次序号（1 起）。乐观锁条件字段。 */
  @Prop({ required: true, default: 1 })
  nextSeq!: number;

  /** 已处理批次存档（按 seq 升序，仅在 seq===nextSeq 时原子压入）。 */
  @Prop({ type: [ChannelBatchSchema], default: [] })
  batches!: ChannelBatchModel[];
}

export type ChannelDocument = HydratedDocument<ChannelDocumentDefinition>;
export const ChannelSchema = SchemaFactory.createForClass(ChannelDocumentDefinition);
