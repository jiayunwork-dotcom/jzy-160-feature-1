import { INestApplication, ValidationPipe } from '@nestjs/common';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MaterialService } from '../material/material.service';
import { ChannelService } from './channel.service';
import { MaterialDocumentDefinition, MaterialSchema } from '../persistence/material.schema';
import { ChannelDocumentDefinition, ChannelSchema } from '../persistence/channel.schema';
import { ChannelSample } from './channel.model';
import { StoredMaterial } from '../material/material.model';
import { resolveHistory } from '../history/history.model';
import { runPronyKernel } from '../prony/prony-kernel.service';

/**
 * 跟踪通道服务集成测试：内存 MongoDB + 真实 Mongoose 模型。
 * 覆盖验收 1（服务级与作业接口对照）、4（重发/冲突/跳号/倒退、状态逐字段不变）、
 * 5（并发与乱序等价串行）、6（重启续算）、7（各种输入错误）。
 */
describe('ChannelService（内存 MongoDB 集成）', () => {
  let mongod: MongoMemoryServer;
  let app: INestApplication;
  let materialService: MaterialService;
  let channelService: ChannelService;
  let conn: Connection;

  const WLF = { tRef: 20, c1: 17.44, c2: 51.6 };

  // 内存 mongod 首次启动较慢，放宽钩子超时
  jest.setTimeout(60000);
  // 乱序到达时在途批次的等待宽限（测试里调小，避免真跳号用例空等）
  const originalGrace = process.env.CHANNEL_GRACE_MS;
  process.env.CHANNEL_GRACE_MS = '60';

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      binary: {
        version: '7.0.14',
        os: { os: 'linux', dist: 'ubuntu', release: '22.04' },
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongod.getUri()),
        MongooseModule.forFeature([
          { name: MaterialDocumentDefinition.name, schema: MaterialSchema },
          { name: ChannelDocumentDefinition.name, schema: ChannelSchema },
        ]),
      ],
      providers: [MaterialService, ChannelService],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    materialService = app.get(MaterialService);
    channelService = app.get(ChannelService);
    conn = app.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await app?.close();
    await mongod?.stop();
    if (originalGrace === undefined) delete process.env.CHANNEL_GRACE_MS;
    else process.env.CHANNEL_GRACE_MS = originalGrace;
  });

  beforeEach(async () => {
    await conn.collection('materials').deleteMany({});
    await conn.collection('channels').deleteMany({});
  });

  async function setupMaterial(name = 'nitrile', withWlf = false): Promise<StoredMaterial> {
    await materialService.create({
      name,
      eInf: 3,
      branches: [
        { modulus: 4, tau: 0.5 },
        { modulus: 6, tau: 10 },
      ],
      ...(withWlf ? { wlf: { ...WLF } } : {}),
    });
    return materialService.findByName(name);
  }

  const pts = (pairs: Array<[number, number]>, temp = 20): ChannelSample[] =>
    pairs.map(([t, e]) => ({ time: t, strain: e, temperature: temp }));

  /** 作业接口参考结果（分段线性，输出点取全部控制点）。 */
  function jobReference(mat: StoredMaterial, pairs: Array<[number, number]>, temperature?: number) {
    const history = resolveHistory({
      segments: [
        { type: 'linear', times: pairs.map((p) => p[0]), strains: pairs.map((p) => p[1]) },
      ],
      ...(temperature !== undefined ? { temperature } : {}),
      output: { kind: 'points', times: pairs.map((p) => p[0]) },
    });
    return runPronyKernel({ material: mat, history });
  }

  /** 与通道状态推进无关的字段快照（逐字段比对报错前后）。 */
  async function snapshotState(channelId: string) {
    const s = await channelService.getState(channelId);
    const raw = await conn.collection('channels').findOne({ _id: new Types.ObjectId(channelId) });
    return {
      initialized: s.initialized,
      currentTime: s.currentTime,
      lastStrain: s.lastStrain,
      lastTemperature: s.lastTemperature,
      reducedTime: s.reducedTime,
      nextSeq: s.nextSeq,
      batchCount: s.batchCount,
      z: Array.from(raw!.z as number[]),
    };
  }

  test('开通道引用不存在的材料档 → MATERIAL_NOT_FOUND', async () => {
    await expect(
      channelService.create({ materialName: 'ghost' }),
    ).rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND' });
  });

  test('开通道固化初始应变：静止起步与初始瞬时应变', async () => {
    await setupMaterial();
    const c0 = await channelService.create({ materialName: 'nitrile' });
    expect(c0.initialized).toBe(false);
    expect(c0.lastStrain).toBe(0);
    expect(c0.nextSeq).toBe(1);

    const c1 = await channelService.create({ materialName: 'nitrile', initialStrain: 0.1, initialTemperature: 20 });
    expect(c1.lastStrain).toBe(0.1);
    expect(c1.initialTemperature).toBe(20);
  });

  test('带 WLF 开通道给了让分母非正的初始温度 → 拒绝且无通道落库', async () => {
    await setupMaterial('wlf', true);
    await expect(
      channelService.create({ materialName: 'wlf', initialStrain: 0.1, initialTemperature: -100 }),
    ).rejects.toMatchObject({ code: 'WLF_DENOMINATOR_NONPOSITIVE' });
    expect(await conn.collection('channels').countDocuments()).toBe(0);
  });

  test('验收1：分段线性历程按两种切批方式追加，与作业接口逐点一致（rel<1e-9，近零绝对误差）', async () => {
    const mat = await setupMaterial();
    const pairs: Array<[number, number]> = [
      [0, 0.1],
      [1, 0.2],
      [3, 0.05],
      [7, -0.1],
      [10, 0.15],
      [13, 0.15],
      [16, 0],
    ];
    const ref = jobReference(mat, pairs);

    async function runSplit(splitAt: number[]) {
      const channel = await channelService.create({ materialName: 'nitrile', initialStrain: pairs[0][1] });
      const stresses: number[] = [];
      let from = 0;
      let seq = 1;
      const chunks: Array<[number, number]>[] = [];
      for (const cut of splitAt) {
        chunks.push(pairs.slice(from, cut));
        from = cut;
      }
      chunks.push(pairs.slice(from));
      for (const chunkPairs of chunks) {
        if (chunkPairs.length === 0) continue;
        const out = await channelService.append(channel.id, { seq: seq++, samples: pts(chunkPairs) });
        stresses.push(...out.results.map((r) => r.stress));
      }
      return { channelId: channel.id, stresses };
    }

    const a = await runSplit([2, 4]);
    const b = await runSplit([3]);
    expect(a.stresses).toHaveLength(pairs.length);
    expect(b.stresses).toHaveLength(pairs.length);
    pairs.forEach(([,], i) => {
      const expected = ref.stresses[i];
      const tol = Math.abs(expected) < 1e-12 ? 1e-12 : 1e-9 * Math.max(1, Math.abs(expected));
      expect(Math.abs(a.stresses[i] - expected)).toBeLessThan(tol);
      expect(Math.abs(b.stresses[i] - expected)).toBeLessThan(tol);
      expect(a.stresses[i]).toBe(b.stresses[i]); // 切批方式不影响结果
    });

    // t=0 处 σ=E0·ε0=13×0.1=1.3
    expect(a.stresses[0]).toBeCloseTo(1.3, 12);
    const finalState = await channelService.getState(a.channelId);
    expect(finalState.currentTime).toBe(16);
    expect(finalState.lastStrain).toBe(0);
    expect(finalState.batchCount).toBe(3);
  });

  test('验收2（服务级）：恒温 T=60 的 WLF 通道与作业接口指定温度 60 一致', async () => {
    const mat = await setupMaterial('wlf', true);
    const pairs: Array<[number, number]> = [
      [0, 0.1],
      [2, 0.2],
      [5, 0],
      [9, -0.05],
      [12, 0.1],
    ];
    const ref = jobReference(mat, pairs, 60);
    const channel = await channelService.create({
      materialName: 'wlf',
      initialStrain: 0.1,
      initialTemperature: 60,
    });
    const out1 = await channelService.append(channel.id, {
      seq: 1,
      samples: pts(pairs.slice(0, 3), 60),
    });
    const out2 = await channelService.append(channel.id, {
      seq: 2,
      samples: pts(pairs.slice(3), 60),
    });
    const got = [...out1.results, ...out2.results].map((r) => r.stress);
    ref.stresses.forEach((s, i) => {
      expect(Math.abs(got[i] - s)).toBeLessThan(1e-9 * Math.max(1, Math.abs(s)));
    });
  });

  test('验收4a：同序号同内容重发原样返回、duplicate=true、通道当前时刻不变', async () => {
    await setupMaterial();
    const channel = await channelService.create({ materialName: 'nitrile', initialStrain: 0.1 });
    const samples = pts([
      [0, 0.1],
      [2, 0.1],
    ]);
    const first = await channelService.append(channel.id, { seq: 1, samples });
    expect(first.duplicate).toBe(false);
    const stateAfterFirst = await snapshotState(channel.id);

    const resent = await channelService.append(channel.id, { seq: 1, samples: samples.map((s) => ({ ...s })) });
    expect(resent.duplicate).toBe(true);
    expect(resent.results).toEqual(first.results);
    const stateAfterResend = await snapshotState(channel.id);
    expect(stateAfterResend).toEqual(stateAfterFirst);
  });

  test('验收4b：同序号不同内容 → CONFLICT，通道状态逐字段不变', async () => {
    await setupMaterial();
    const channel = await channelService.create({ materialName: 'nitrile', initialStrain: 0.1 });
    await channelService.append(channel.id, { seq: 1, samples: pts([[0, 0.1], [2, 0.1]]) });
    const before = await snapshotState(channel.id);

    await expect(
      channelService.append(channel.id, { seq: 1, samples: pts([[0, 0.1], [2, 0.12]]) }),
    ).rejects.toMatchObject({ code: 'CHANNEL_BATCH_CONFLICT' });

    expect(await snapshotState(channel.id)).toEqual(before);
  });

  test('验收4c：跳号 → CHANNEL_SEQ_GAP，通道状态不变', async () => {
    await setupMaterial();
    const channel = await channelService.create({ materialName: 'nitrile', initialStrain: 0.1 });
    await channelService.append(channel.id, { seq: 1, samples: pts([[0, 0.1]]) });
    const before = await snapshotState(channel.id);

    await expect(
      channelService.append(channel.id, { seq: 3, samples: pts([[2, 0.1]]) }),
    ).rejects.toMatchObject({ code: 'CHANNEL_SEQ_GAP' });

    expect(await snapshotState(channel.id)).toEqual(before);
  });

  test('验收4d：批次起点早于通道当前时刻 → CHANNEL_BATCH_TIME_REGRESSION，状态不变', async () => {
    await setupMaterial();
    const channel = await channelService.create({ materialName: 'nitrile', initialStrain: 0.1 });
    await channelService.append(channel.id, { seq: 1, samples: pts([[0, 0.1], [5, 0.1]]) });
    const before = await snapshotState(channel.id);

    await expect(
      channelService.append(channel.id, { seq: 2, samples: pts([[5, 0.1], [6, 0.1]]) }), // 边界重复
    ).rejects.toMatchObject({ code: 'CHANNEL_BATCH_TIME_REGRESSION' });
    await expect(
      channelService.append(channel.id, { seq: 2, samples: pts([[4, 0.1]]) }), // 倒退
    ).rejects.toMatchObject({ code: 'CHANNEL_BATCH_TIME_REGRESSION' });

    expect(await snapshotState(channel.id)).toEqual(before);
    // 正确的下一批仍可正常推进
    const ok = await channelService.append(channel.id, { seq: 2, samples: pts([[6, 0.1]]) });
    expect(ok.state.currentTime).toBe(6);
  });

  test('验收5（乱序）：先发 seq=2 再发 seq=1，两批都生效，结果与串行一致', async () => {
    await setupMaterial();
    const channel = await channelService.create({ materialName: 'nitrile', initialStrain: 0.1 });
    const b1 = pts([
      [0, 0.1],
      [1, 0.1],
    ]);
    const b2 = pts([
      [2, 0.2],
      [3, 0.2],
    ]);

    // 先构造 seq=2 的 Promise（在途登记后开始等缺口），随后立刻发 seq=1
    const p2 = channelService.append(channel.id, { seq: 2, samples: b2 });
    await new Promise((r) => setTimeout(r, 20));
    const p1 = channelService.append(channel.id, { seq: 1, samples: b1 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(false);

    // 与串行通道对照
    const serial = await channelService.create({ materialName: 'nitrile', initialStrain: 0.1 });
    const s1 = await channelService.append(serial.id, { seq: 1, samples: b1 });
    const s2 = channelService.append(serial.id, { seq: 2, samples: b2 });
    expect(r1.results).toEqual(s1.results);
    expect(r2.results).toEqual((await s2).results);
    expect((await channelService.getState(channel.id)).currentTime).toBe(3);
  }, 20000);

  test('验收5（并发）：同通道多批连续序号并发追加，完成后与串行逐点一致', async () => {
    await setupMaterial();
    const allPairs: Array<[number, number]> = [];
    for (let t = 0; t <= 20; t++) allPairs.push([t, 0.05 * Math.sin(t / 3) + 0.05]);
    const batches: ChannelSample[][] = [];
    // seq1 含 t=0（与初始应变一致），其余每 5 点一批，批间不共享边界
    batches.push(pts(allPairs.slice(0, 5)));
    batches.push(pts(allPairs.slice(5, 10)));
    batches.push(pts(allPairs.slice(10, 15)));
    batches.push(pts(allPairs.slice(15)));

    const concurrent = await channelService.create({
      materialName: 'nitrile',
      initialStrain: allPairs[0][1],
    });
    const results = await Promise.all(
      batches.map((samples, i) => channelService.append(concurrent.id, { seq: i + 1, samples })),
    );
    results.forEach((r) => expect(r.duplicate).toBe(false));

    const serial = await channelService.create({ materialName: 'nitrile', initialStrain: allPairs[0][1] });
    for (let i = 0; i < batches.length; i++) {
      const out = await channelService.append(serial.id, { seq: i + 1, samples: batches[i] });
      expect(out.results).toEqual(results[i].results);
    }
    const stC = await channelService.getState(concurrent.id);
    const stS = await channelService.getState(serial.id);
    expect(stC.currentTime).toBe(stS.currentTime);
    expect(stC.reducedTime).toBe(stS.reducedTime);
    expect(stC.batchCount).toBe(4);
  }, 20000);

  test('验收6：状态落库后用新应用实例读出继续追加，与不重启完全相同', async () => {
    await setupMaterial();
    const pairs: Array<[number, number]> = [];
    for (let t = 0; t <= 24; t++) pairs.push([t, 0.1 * Math.cos(t / 4)]);
    const chunk = (lo: number, hi: number) => pts(pairs.slice(lo, hi));

    // 不重启通道：一次性串行全部
    const noRestart = await channelService.create({
      materialName: 'nitrile',
      initialStrain: pairs[0][1],
    });
    await channelService.append(noRestart.id, { seq: 1, samples: chunk(0, 8) });
    await channelService.append(noRestart.id, { seq: 2, samples: chunk(8, 16) });
    await channelService.append(noRestart.id, { seq: 3, samples: chunk(16, 25) });

    // 重启通道：前两批在 app1，第三批在“重启后”的新实例 app2
    const restarted = await channelService.create({
      materialName: 'nitrile',
      initialStrain: pairs[0][1],
    });
    await channelService.append(restarted.id, { seq: 1, samples: chunk(0, 8) });
    await channelService.append(restarted.id, { seq: 2, samples: chunk(8, 16) });

    const moduleRef2 = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongod.getUri()),
        MongooseModule.forFeature([
          { name: MaterialDocumentDefinition.name, schema: MaterialSchema },
          { name: ChannelDocumentDefinition.name, schema: ChannelSchema },
        ]),
      ],
      providers: [MaterialService, ChannelService],
    }).compile();
    const app2 = moduleRef2.createNestApplication();
    await app2.init();
    try {
      const channelService2 = app2.get(ChannelService);
      // 重启后先查状态，再追加
      const state = await channelService2.getState(restarted.id);
      expect(state.nextSeq).toBe(3);
      expect(state.currentTime).toBe(15);
      const outAfterRestart = await channelService2.append(restarted.id, {
        seq: 3,
        samples: chunk(16, 25),
      });

      // 重启后重发旧批次也应幂等
      const dup = await channelService2.append(restarted.id, { seq: 1, samples: chunk(0, 8) });
      expect(dup.duplicate).toBe(true);

      const refBatch3 = await channelService.getBatch(noRestart.id, 3);
      expect(outAfterRestart.results).toEqual(refBatch3.results);

      const stA = await channelService.getState(restarted.id);
      const stB = await channelService.getState(noRestart.id);
      expect(stA.currentTime).toBe(stB.currentTime);
      expect(stA.lastStrain).toBe(stB.lastStrain);
      expect(stA.reducedTime).toBe(stB.reducedTime);
      expect(stA.batchCount).toBe(stB.batchCount);

      const rawA = await conn.collection('channels').findOne({ _id: new Types.ObjectId(restarted.id) });
      const rawB = await conn.collection('channels').findOne({ _id: new Types.ObjectId(noRestart.id) });
      expect(rawA!.z).toEqual(rawB!.z);
    } finally {
      await app2.close();
    }
  }, 30000);

  test('批次列表与单批查询', async () => {
    await setupMaterial();
    const channel = await channelService.create({ materialName: 'nitrile', initialStrain: 0.1 });
    await channelService.append(channel.id, { seq: 1, samples: pts([[0, 0.1], [1, 0.1]]) });
    await channelService.append(channel.id, { seq: 2, samples: pts([[2, 0.2]]) });

    const list = await channelService.listBatches(channel.id);
    expect(list.map((b) => b.seq)).toEqual([1, 2]);
    expect(list[0]).toMatchObject({ sampleCount: 2, startTime: 0, endTime: 1 });
    expect(list[1]).toMatchObject({ sampleCount: 1, startTime: 2, endTime: 2 });

    const one = await channelService.getBatch(channel.id, 2);
    expect(one.samples).toHaveLength(1);
    expect(one.results[0].stress).toBeGreaterThan(0);

    await expect(channelService.getBatch(channel.id, 9)).rejects.toMatchObject({
      code: 'CHANNEL_BATCH_NOT_FOUND',
    });
  });

  test('查询不存在的通道 → CHANNEL_NOT_FOUND（非法 id 同样）', async () => {
    await expect(channelService.getState(new Types.ObjectId().toString())).rejects.toMatchObject({
      code: 'CHANNEL_NOT_FOUND',
    });
    await expect(channelService.getState('not-an-objectid')).rejects.toMatchObject({
      code: 'CHANNEL_NOT_FOUND',
    });
  });

  describe('验收7：非法批次一律拒绝且通道不变', () => {
    let channelId: string;
    let before: Awaited<ReturnType<typeof snapshotState>>;

    beforeEach(async () => {
      await setupMaterial('wlf', true);
      const channel = await channelService.create({
        materialName: 'wlf',
        initialStrain: 0.1,
        initialTemperature: 20,
      });
      channelId = channel.id;
      await channelService.append(channelId, {
        seq: 1,
        samples: pts([[0, 0.1], [1, 0.1]], 20),
      });
      before = await snapshotState(channelId);
    });

    async function expectRejected(call: Promise<unknown>, code?: string) {
      if (code) await expect(call).rejects.toMatchObject({ code });
      else await expect(call).rejects.toBeTruthy();
      expect(await snapshotState(channelId)).toEqual(await before);
    }

    test('空批次', async () => {
      await expectRejected(
        channelService.append(channelId, { seq: 2, samples: [] }),
        'CHANNEL_BATCH_EMPTY',
      );
    });

    test('采样时间不严格递增', async () => {
      await expectRejected(
        channelService.append(channelId, {
          seq: 2,
          samples: [
            { time: 2, strain: 0.1, temperature: 20 },
            { time: 2, strain: 0.1, temperature: 20 },
          ],
        }),
        'TIME_NOT_STRICTLY_INCREASING',
      );
    });

    test('时间倒退（早于当前时刻）', async () => {
      await expectRejected(
        channelService.append(channelId, {
          seq: 2,
          samples: [{ time: 0.5, strain: 0.1, temperature: 20 }],
        }),
        'CHANNEL_BATCH_TIME_REGRESSION',
      );
    });

    test('温度让 WLF 分母非正', async () => {
      await expectRejected(
        channelService.append(channelId, {
          seq: 2,
          samples: [{ time: 2, strain: 0.1, temperature: -100 }],
        }),
        'WLF_DENOMINATOR_NONPOSITIVE',
      );
    });

    test('字段缺失/非数值', async () => {
      await expectRejected(
        channelService.append(channelId, {
          seq: 2,
          samples: [{ time: 2, strain: 0.1 } as unknown as ChannelSample],
        }),
        'INVALID_PAYLOAD',
      );
    });

    test('非法序号（0、负数、小数）', async () => {
      for (const seq of [0, -1, 1.5]) {
        await expect(
          channelService.append(channelId, {
            seq: seq as number,
            samples: pts([[2, 0.1]], 20),
          }),
        ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
      }
      expect(await snapshotState(channelId)).toEqual(await before);
    });
  });
});
