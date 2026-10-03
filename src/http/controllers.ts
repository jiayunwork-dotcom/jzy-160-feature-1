import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  AppendBatchDto,
  CreateChannelDto,
  CreateMaterialDto,
  SubmitJobDto,
} from './dto';
import { MaterialService } from '../material/material.service';
import { JobService } from '../job/job.service';
import { ChannelService } from '../channel/channel.service';

@Controller('materials')
export class MaterialController {
  constructor(private readonly materialService: MaterialService) {}

  /** 建立材料档；响应回显计算出的瞬时模量 E0。 */
  @Post()
  async create(@Body() dto: CreateMaterialDto) {
    return this.materialService.create(dto);
  }

  @Get()
  async list() {
    return this.materialService.list();
  }

  @Get(':name')
  async get(@Param('name') name: string) {
    return this.materialService.findByName(name);
  }
}

@Controller('jobs')
export class JobController {
  constructor(private readonly jobService: JobService) {}

  /** 提交作业，异步执行，立即返回作业号。 */
  @Post()
  async submit(@Body() dto: SubmitJobDto) {
    // DTO 的段为宽联合，经领域层 resolveHistory 做判别式严校验
    return this.jobService.submit(dto as unknown as Parameters<JobService['submit']>[0]);
  }

  /** 查询作业进度与各历程状态。 */
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.jobService.getStatus(id);
  }

  /** 取完整结果（含应力/模量曲线）。 */
  @Get(':id/detail')
  async detail(@Param('id') id: string) {
    return this.jobService.getDetail(id);
  }

  /** 按材料档检索历史作业：GET /jobs?materialName=xxx */
  @Get()
  async byMaterial(@Query('materialName') materialName: string) {
    return this.jobService.findByMaterial(materialName);
  }
}

@Controller('channels')
export class ChannelController {
  constructor(private readonly channelService: ChannelService) {}

  /** 开跟踪通道：指定已有材料档，静止起步（可给 t=0 瞬时施加的初始应变/初始温度）。 */
  @Post()
  async create(@Body() dto: CreateChannelDto) {
    return this.channelService.create(dto);
  }

  /** 追加一批采样（客户端连续序号），返回本批每点应力与平移因子并推进通道。 */
  @Post(':id/batches')
  async append(@Param('id') id: string, @Body() dto: AppendBatchDto) {
    return this.channelService.append(id, dto);
  }

  /** 通道当前状态（当前时刻、末尾应变/温度、约化时间、下一个序号等）。 */
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.channelService.getState(id);
  }

  /** 已处理批次列表（序号、点数、起止时间，不含曲线数组）。 */
  @Get(':id/batches')
  async batches(@Param('id') id: string) {
    return this.channelService.listBatches(id);
  }

  /** 取某一已处理批次的完整内容与结果（重发对账用）。 */
  @Get(':id/batches/:seq')
  async batch(@Param('id') id: string, @Param('seq') seq: string) {
    const seqNum = Number(seq);
    // 非法序号交给服务层统一抛 CHANNEL_BATCH_NOT_FOUND
    return this.channelService.getBatch(id, seqNum);
  }
}
