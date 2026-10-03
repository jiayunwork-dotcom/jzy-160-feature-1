import { INestApplication, ValidationPipe } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ViscoModule } from '../visco.module';
import { ViscoExceptionFilter } from './visco-exception.filter';

/**
 * 跟踪通道 HTTP 端到端冒烟：真实 HTTP → 管道 → 控制器 → ChannelService → Mongoose。
 * 覆盖开通道、分批追加、重发幂等、冲突/跳号错误结构、状态与批次查询。
 */
describe('HTTP 跟踪通道端到端（内存 MongoDB）', () => {
  jest.setTimeout(60000);
  let mongod: MongoMemoryServer;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      binary: {
        version: '7.0.14',
        os: { os: 'linux', dist: 'ubuntu', release: '22.04' },
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(mongod.getUri()), ViscoModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new ViscoExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await mongod?.stop();
  });

  async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async function get(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: await res.json() };
  }

  test('开通道 → 分批追加（变温）→ 重发幂等 → 状态/批次查询', async () => {
    // 材料档（带 WLF）
    const mat = await post('/materials', {
      name: 'track-nitrile',
      eInf: 3,
      branches: [
        { modulus: 4, tau: 0.5 },
        { modulus: 6, tau: 10 },
      ],
      wlf: { tRef: 20, c1: 17.44, c2: 51.6 },
    });
    expect(mat.status).toBe(201);

    const created = await post('/channels', {
      materialName: 'track-nitrile',
      description: '橡胶隔振垫长期监测 A 点',
      initialStrain: 0.1,
      initialTemperature: 20,
    });
    expect(created.status).toBe(201);
    expect(created.body.initialized).toBe(false);
    expect(created.body.nextSeq).toBe(1);
    const channelId = created.body.id;

    const b1 = await post(`/channels/${channelId}/batches`, {
      seq: 1,
      samples: [
        { time: 0, strain: 0.1, temperature: 20 },
        { time: 1, strain: 0.1, temperature: 20 },
        { time: 2, strain: 0.12, temperature: 30 },
      ],
    });
    expect(b1.status).toBe(201);
    expect(b1.body.duplicate).toBe(false);
    expect(b1.body.results).toHaveLength(3);
    // σ(0)=E0·ε0=13×0.1
    expect(b1.body.results[0].stress).toBeCloseTo(1.3, 12);
    expect(b1.body.results[0].shiftFactor).toBe(1);
    expect(b1.body.results[2].shiftFactor).toBeLessThan(1); // 30°C 加速
    expect(b1.body.state.currentTime).toBe(2);
    expect(b1.body.state.lastTemperature).toBe(30);

    // 同序号同内容重发：200/201 均可，但 duplicate=true、结果相同、时刻不变
    const dup = await post(`/channels/${channelId}/batches`, {
      seq: 1,
      samples: [
        { time: 0, strain: 0.1, temperature: 20 },
        { time: 1, strain: 0.1, temperature: 20 },
        { time: 2, strain: 0.12, temperature: 30 },
      ],
    });
    expect(dup.body.duplicate).toBe(true);
    expect(dup.body.results).toEqual(b1.body.results);
    expect(dup.body.state.currentTime).toBe(2);

    // 下一批
    const b2 = await post(`/channels/${channelId}/batches`, {
      seq: 2,
      samples: [{ time: 3, strain: 0.12, temperature: 40 }],
    });
    expect(b2.status).toBe(201);
    expect(b2.body.results).toHaveLength(1);
    expect(b2.body.state.currentTime).toBe(3);

    // 状态查询
    const st = await get(`/channels/${channelId}`);
    expect(st.status).toBe(200);
    expect(st.body.nextSeq).toBe(3);
    expect(st.body.batchCount).toBe(2);
    expect(st.body.lastStrain).toBeCloseTo(0.12, 12);

    // 批次列表 + 单批
    const list = await get(`/channels/${channelId}/batches`);
    expect(list.body.map((b: any) => b.seq)).toEqual([1, 2]);
    const one = await get(`/channels/${channelId}/batches/1`);
    expect(one.body.results).toHaveLength(3);
  });

  test('引用不存在材料档 → 404', async () => {
    const r = await post('/channels', { materialName: 'ghost' });
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe('MATERIAL_NOT_FOUND');
  });

  test('查询不存在通道 → 404', async () => {
    const r = await get('/channels/0123456789abcdef01234567');
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe('CHANNEL_NOT_FOUND');
  });

  test('同序号不同内容 → 409 CHANNEL_BATCH_CONFLICT；跳号 → 409 CHANNEL_SEQ_GAP', async () => {
    await post('/materials', { name: 'm2', eInf: 1, branches: [] });
    const ch = await post('/channels', { materialName: 'm2', initialStrain: 0.1 });
    await post(`/channels/${ch.body.id}/batches`, {
      seq: 1,
      samples: [{ time: 0, strain: 0.1, temperature: 20 }],
    });

    const conflict = await post(`/channels/${ch.body.id}/batches`, {
      seq: 1,
      samples: [{ time: 0, strain: 0.2, temperature: 20 }],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.errorCode).toBe('CHANNEL_BATCH_CONFLICT');

    const gap = await post(`/channels/${ch.body.id}/batches`, {
      seq: 5,
      samples: [{ time: 1, strain: 0.1, temperature: 20 }],
    });
    expect(gap.status).toBe(409);
    expect(gap.body.errorCode).toBe('CHANNEL_SEQ_GAP');
  });

  test('空批次 / 采样时间不递增 / WLF 分母非正 → 带原因的错误，且不推进', async () => {
    await post('/materials', {
      name: 'm3',
      eInf: 1,
      branches: [],
      wlf: { tRef: 20, c1: 17.44, c2: 51.6 },
    });
    const ch = await post('/channels', {
      materialName: 'm3',
      initialStrain: 0.1,
      initialTemperature: 20,
    });
    const id = ch.body.id;
    await post(`/channels/${id}/batches`, {
      seq: 1,
      samples: [{ time: 0, strain: 0.1, temperature: 20 }],
    });

    const empty = await post(`/channels/${id}/batches`, { seq: 2, samples: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.errorCode).toBe('CHANNEL_BATCH_EMPTY');

    const nonInc = await post(`/channels/${id}/batches`, {
      seq: 2,
      samples: [
        { time: 2, strain: 0.1, temperature: 20 },
        { time: 2, strain: 0.1, temperature: 20 },
      ],
    });
    expect(nonInc.status).toBe(422);
    expect(nonInc.body.errorCode).toBe('TIME_NOT_STRICTLY_INCREASING');

    const wlfBad = await post(`/channels/${id}/batches`, {
      seq: 2,
      samples: [{ time: 2, strain: 0.1, temperature: -100 }],
    });
    expect(wlfBad.status).toBe(422);
    expect(wlfBad.body.errorCode).toBe('WLF_DENOMINATOR_NONPOSITIVE');

    // 通道仍停在 seq1
    const st = await get(`/channels/${id}`);
    expect(st.body.nextSeq).toBe(2);
    expect(st.body.currentTime).toBe(0);
  });

  test('请求体缺字段被 ValidationPipe 拦截为 400', async () => {
    const r = await post('/channels', { description: '缺 materialName' });
    expect(r.status).toBe(400);
  });
});
