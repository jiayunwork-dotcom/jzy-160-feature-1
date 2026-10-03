import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AppendBatchDto, CreateMaterialDto, CreateTrackDto, SubmitJobDto } from './dto';
import { MaterialService } from '../material/material.service';
import { JobService } from '../job/job.service';
import { TrackService } from '../track/track.service';

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

/**
 * 长期服役监测的「跟踪通道」：开通道后按客户端序号分批追加
 * (time, strain, temperature) 采样，服务记住整段加载史并增量推进。
 */
@Controller('tracks')
export class TrackController {
  constructor(private readonly trackService: TrackService) {}

  /** 开通道：指定已有材料档，从静止状态起步，可选初始应变瞬时施加。 */
  @Post()
  async create(@Body() dto: CreateTrackDto) {
    return this.trackService.createChannel({
      materialName: dto.materialName,
      initialStrain: dto.initialStrain,
    });
  }

  /** 追加一批采样（时间紧接上一批末尾），返回逐点应力与平移因子。 */
  @Post(':id/batches')
  async append(@Param('id') id: string, @Body() dto: AppendBatchDto) {
    return this.trackService.appendBatch(id, {
      sequence: dto.sequence,
      samples: dto.samples,
    });
  }

  /** 查通道当前状态（时刻/应变/温度/支路内变量/最后序号）。 */
  @Get(':id')
  async status(@Param('id') id: string) {
    return this.trackService.getChannel(id);
  }

  /** 已处理批次列表（按序号升序）。 */
  @Get(':id/batches')
  async batches(@Param('id') id: string) {
    return this.trackService.listBatches(id);
  }

  /** 取某一已处理批次的完整逐点结果（重放查询）。 */
  @Get(':id/batches/:sequence')
  async batch(@Param('id') id: string, @Param('sequence') sequence: string) {
    return this.trackService.getBatch(id, Number(sequence));
  }
}
