import { INestApplication, ValidationPipe } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ViscoModule } from '../visco.module';
import { ViscoExceptionFilter } from './visco-exception.filter';

/**
 * 跟踪通道 HTTP 端到端：建档 → 开通道 → 分批追加 → 重发幂等 →
 * 冲突/跳号/倒退带原因拒绝 → 查状态与批次列表。
 */
describe('跟踪通道 HTTP 端到端（内存 MongoDB）', () => {
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

  const jsonPost = (path: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('完整生命周期：开通道、分批追加、幂等重发、冲突/跳号/倒退拒绝、查询', async () => {
    // 建档（带 WLF）
    expect((await jsonPost('/materials', {
      name: 'nitrile-track',
      eInf: 3,
      branches: [{ modulus: 7, tau: 2 }],
      wlf: { tRef: 20, c1: 17.44, c2: 51.6 },
    })).status).toBe(201);

    // 引用不存在的材料档 → 404
    const badCreate = await jsonPost('/tracks', { materialName: 'ghost' });
    expect(badCreate.status).toBe(404);
    expect((await badCreate.json()).errorCode).toBe('MATERIAL_NOT_FOUND');

    // 开通道（初始应变瞬时施加）
    const created = await (await jsonPost('/tracks', {
      materialName: 'nitrile-track',
      initialStrain: 0.1,
    })).json();
    const channelId: string = created.id;
    expect(created.anchored).toBe(false);

    // 空批次 → 400（DTO @ArrayMinSize 拦截）
    const empty = await jsonPost(`/tracks/${channelId}/batches`, {
      sequence: 1,
      samples: [],
    });
    expect(empty.status).toBe(400);
    // 统一错误结构带原因
    expect(await empty.json()).toHaveProperty('message');

    // 第 1 批：锚点 + 两个点（Tref）
    const batch1Body = {
      sequence: 1,
      samples: [
        { time: 0, strain: 0.1, temperature: 20 },
        { time: 1, strain: 0.1, temperature: 20 },
        { time: 2, strain: 0.1, temperature: 20 },
      ],
    };
    const b1 = await (await jsonPost(`/tracks/${channelId}/batches`, batch1Body)).json();
    expect(b1.results).toHaveLength(3);
    expect(b1.results[0].stress).toBeCloseTo(1, 10); // E0·ε = 10·0.1
    expect(b1.results[0].shiftFactor).toBeCloseTo(1, 10);
    expect(b1.replayed).toBe(false);

    // 同序号同内容重发 → 相同结果、replayed=true
    const b1replay = await (await jsonPost(`/tracks/${channelId}/batches`, batch1Body)).json();
    expect(b1replay.replayed).toBe(true);
    expect(b1replay.results).toEqual(b1.results);

    // 同序号不同内容 → 409 冲突
    const conflict = await jsonPost(`/tracks/${channelId}/batches`, {
      sequence: 1,
      samples: [
        { time: 0, strain: 0.1, temperature: 20 },
        { time: 1, strain: 0.11, temperature: 20 },
      ],
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).errorCode).toBe('TRACK_SEQUENCE_CONFLICT');

    // 跳号（送 3）→ 409
    const gap = await jsonPost(`/tracks/${channelId}/batches`, {
      sequence: 3,
      samples: [
        { time: 2, strain: 0.1, temperature: 60 },
        { time: 3, strain: 0.1, temperature: 60 },
      ],
    });
    expect(gap.status).toBe(409);
    expect((await gap.json()).errorCode).toBe('TRACK_SEQUENCE_GAP');

    // 时间倒退（序号 2 正确，但起点早于当前时刻 2）→ 422/409
    const backwards = await jsonPost(`/tracks/${channelId}/batches`, {
      sequence: 2,
      samples: [
        { time: 1, strain: 0.1, temperature: 20 },
        { time: 3, strain: 0.1, temperature: 20 },
      ],
    });
    const bwBody = await backwards.json();
    expect([409, 422]).toContain(backwards.status);
    expect(bwBody.message).toMatch(/早于|倒退/);

    // WLF 分母非正温度 → 422 且不推进
    const wlfBad = await jsonPost(`/tracks/${channelId}/batches`, {
      sequence: 2,
      samples: [
        { time: 2, strain: 0.1, temperature: 20 },
        { time: 3, strain: 0.1, temperature: -100 },
      ],
    });
    expect(wlfBad.status).toBe(422);
    expect((await wlfBad.json()).errorCode).toBe('WLF_DENOMINATOR_NONPOSITIVE');

    // 合法第 2 批：升温到 60°C，重复边界点 t=2
    const b2 = await (await jsonPost(`/tracks/${channelId}/batches`, {
      sequence: 2,
      samples: [
        { time: 2, strain: 0.1, temperature: 20 },
        { time: 3, strain: 0.1, temperature: 60 },
        { time: 4, strain: 0.1, temperature: 60 },
      ],
    })).json();
    expect(b2.results).toHaveLength(3);
    expect(b2.results[0].stress).toBeCloseTo(b1.results[2].stress, 12);
    expect(b2.results[1].shiftFactor).toBeLessThan(1);
    // 高温加速松弛：t=4 比恒温 20°C 对照更接近 E∞·ε=0.3
    const refStressAt4 = 0.1 * (3 + 7 * Math.exp(-4 / 2));
    expect(b2.results[2].stress).toBeLessThan(refStressAt4);
    expect(b2.channel.currentTime).toBe(4);
    expect(b2.channel.currentTemperature).toBe(60);
    expect(b2.channel.lastSequence).toBe(2);

    // 查状态
    const status = await (await fetch(`${baseUrl}/tracks/${channelId}`)).json();
    expect(status.currentTime).toBe(4);
    expect(status.internalVariables).toHaveLength(1);

    // 批次列表
    const list = await (await fetch(`${baseUrl}/tracks/${channelId}/batches`)).json();
    expect(list.map((b: { sequence: number }) => b.sequence)).toEqual([1, 2]);

    // 取单批结果
    const one = await (await fetch(`${baseUrl}/tracks/${channelId}/batches/2`)).json();
    expect(one.results).toHaveLength(3);

    // 查询不存在的通道 → 404
    expect((await fetch(`${baseUrl}/tracks/0123456789abcdef01234567`)).status).toBe(404);

    // DTO：缺 samples → 400
    const malformed = await jsonPost(`/tracks/${channelId}/batches`, { sequence: 3 });
    expect(malformed.status).toBe(400);
    // DTO：序号非整数 → 400
    const badSeq = await jsonPost(`/tracks/${channelId}/batches`, {
      sequence: 1.5,
      samples: [{ time: 4, strain: 0.1, temperature: 60 }],
    });
    expect(badSeq.status).toBe(400);
  });
});
