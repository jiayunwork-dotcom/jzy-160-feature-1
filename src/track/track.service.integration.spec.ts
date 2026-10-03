import { INestApplication, ValidationPipe } from '@nestjs/common';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MaterialService } from '../material/material.service';
import { TrackService } from './track.service';
import { TrackSample } from './track-kernel';
import {
  TrackBatchDefinition,
  TrackBatchSchema,
  TrackChannelDefinition,
  TrackChannelSchema,
} from '../persistence/track.schema';
import { MaterialDocumentDefinition, MaterialSchema } from '../persistence/material.schema';
import { resolveHistory, StrainHistorySpec } from '../history/history.model';
import { runPronyKernel } from '../prony/prony-kernel.service';

/**
 * 跟踪通道集成测试：内存 MongoDB + 真实 Mongoose 模型。
 * 逐条覆盖验收：恒温一致（1）、WLF 恒温（2）、变温升温（3）、
 * 重发/冲突/跳号/倒退且状态不变（4）、并发按序（5）、重启续算（6）、
 * 各种非法输入（7）。
 */
describe('TrackService（内存 MongoDB 集成）', () => {
  let mongod: MongoMemoryServer;
  let app: INestApplication;
  let materialService: MaterialService;
  let track: TrackService;
  let conn: Connection;

  const WLF = { tRef: 20, c1: 17.44, c2: 51.6 };

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
          { name: TrackChannelDefinition.name, schema: TrackChannelSchema },
          { name: TrackBatchDefinition.name, schema: TrackBatchSchema },
        ]),
      ],
      providers: [MaterialService, TrackService],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    materialService = app.get(MaterialService);
    track = app.get(TrackService);
    conn = app.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await app?.close();
    await mongod?.stop();
  });

  beforeEach(async () => {
    await conn.collection('materials').deleteMany({});
    await conn.collection('trackchannels').deleteMany({});
    await conn.collection('trackbatches').deleteMany({});
  });

  // ===== 夹具 =====

  const times = [0, 0.4, 1.1, 2.0, 3.3, 5.0, 7.2, 9.0, 10];
  const strains = [0.1, 0.14, 0.09, -0.02, 0.04, 0.12, 0.0, 0.03, 0.03];

  async function ensureMaterial(
    name = 'nitrile',
    wlf: typeof WLF | null = null,
  ): Promise<void> {
    await materialService.create({
      name,
      eInf: 3,
      branches: [
        { modulus: 4, tau: 0.3 },
        { modulus: 6, tau: 7 },
      ],
      ...(wlf ? { wlf } : {}),
    });
  }

  const samplesAt = (t: number): TrackSample[] =>
    times.map((time, i) => ({ time, strain: strains[i], temperature: t }));

  function sliceSamples(all: TrackSample[], from: number, to: number): TrackSample[] {
    // 重复上一批末尾点作为新批边界点
    const start = from > 0 ? from - 1 : from;
    return all.slice(start, to);
  }

  async function appendInChunks(
    channelId: string,
    all: TrackSample[],
    boundaries: number[],
    seqStart = 1,
  ) {
    let from = 0;
    let seq = seqStart;
    const collected: number[] = [];
    for (const to of boundaries) {
      const res = await track.appendBatch(channelId, {
        sequence: seq,
        samples: sliceSamples(all, from, to),
      });
      // 首批含锚点；之后去掉重复边界点
      const emitted = seq === seqStart ? res.results : res.results.slice(1);
      collected.push(...emitted.map((r) => r.stress));
      from = to;
      seq++;
    }
    return collected;
  }

  function expectedJobStresses(temperature?: number): number[] {
    const spec: StrainHistorySpec = {
      segments: [{ type: 'linear', times: times.slice(), strains: strains.slice() }],
      temperature,
      output: { kind: 'points', times: times.slice() },
    };
    const material = {
      name: 'nitrile',
      eInf: 3,
      branches: [
        { modulus: 4, tau: 0.3 },
        { modulus: 6, tau: 7 },
      ],
      wlf: WLF,
      e0: 13,
    };
    return runPronyKernel({ material, history: resolveHistory(spec) }).stresses;
  }

  function expectedJobStressesNoWlf(): number[] {
    const spec: StrainHistorySpec = {
      segments: [{ type: 'linear', times: times.slice(), strains: strains.slice() }],
      output: { kind: 'points', times: times.slice() },
    };
    const material = {
      name: 'nitrile',
      eInf: 3,
      branches: [
        { modulus: 4, tau: 0.3 },
        { modulus: 6, tau: 7 },
      ],
      wlf: null,
      e0: 13,
    };
    return runPronyKernel({ material, history: resolveHistory(spec) }).stresses;
  }

  function expectClose(actual: number[], expected: number[], tol = 1e-9): void {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((a, i) => {
      const e = expected[i];
      const diff = Math.abs(a - e);
      if (!(diff <= tol * Math.max(1, Math.abs(e)) || diff <= tol)) {
        throw new Error(`位置 ${i}: 实际 ${a} 期望 ${e} 差 ${diff}`);
      }
    });
  }

  // ===== 开通道 =====

  test('开通道：引用不存在的材料档 → 错误（验收 7）', async () => {
    await expect(
      track.createChannel({ materialName: 'ghost' }),
    ).rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND' });
  });

  test('开通道后为未锚定静止状态；可查当前状态', async () => {
    await ensureMaterial('nitrile');
    const ch = await track.createChannel({ materialName: 'nitrile' });
    expect(ch.anchored).toBe(false);
    expect(ch.currentTime).toBeNull();
    expect(ch.lastSequence).toBeNull();
    const got = await track.getChannel(ch.id);
    expect(got.materialName).toBe('nitrile');
    expect(got.internalVariables).toEqual([0, 0]);
    await expect(track.getChannel('0123456789abcdef01234567')).rejects.toMatchObject({
      code: 'TRACK_NOT_FOUND',
    });
  });

  test('带初始应变速开通道：未锚定状态的内变量已反映瞬时阶跃', async () => {
    await ensureMaterial('nitrile');
    const ch = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    expect(ch.initialStrain).toBe(0.1);
    expect(ch.internalVariables).toEqual([0.1, 0.1]);
  });

  // ===== 验收 1：与作业接口一致，切批不变 =====

  test('验收1：分段线性历程拆批恒温追加，应力与作业接口一致（<1e-9），换切批不变', async () => {
    await ensureMaterial();
    const all = samplesAt(20);

    const chA = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    const stressesA = await appendInChunks(chA.id, all, [2, 3, 6, 9]);

    const chB = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    const stressesB = await appendInChunks(chB.id, all, [4, 5, 9]);

    // 不重复边界点的切批方式（跨批桥接）
    const chC = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    let cursor = 0;
    let seq = 1;
    const stressesC: number[] = [];
    for (const to of [3, 7, 9]) {
      const chunk = all.slice(cursor, to);
      const res = await track.appendBatch(chC.id, { sequence: seq, samples: chunk });
      stressesC.push(...res.results.map((r) => r.stress));
      cursor = to;
      seq++;
    }

    const expected = expectedJobStressesNoWlf();
    expectClose(stressesA, expected);
    expectClose(stressesB, expected);
    expectClose(stressesC, expected);
  });

  // ===== 验收 2：WLF 恒温 =====

  test('验收2：恒温 Tref 与去 WLF 同参数一致；恒温 40°C 与作业接口指定 40°C 一致', async () => {
    await ensureMaterial('nitrile', WLF);
    const all20 = samplesAt(20);
    const chRef = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    const stressesRef = await appendInChunks(chRef.id, all20, [3, 6, 9]);
    expectClose(stressesRef, expectedJobStressesNoWlf());

    const all40 = samplesAt(40);
    const chHot = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    const stressesHot = await appendInChunks(chHot.id, all40, [2, 5, 9]);
    expectClose(stressesHot, expectedJobStresses(40));

    // 每点返回的平移因子均为 a_T(40)
    const lastBatch = await track.getBatch(chHot.id, 3);
    lastBatch.results.forEach((r) => expect(r.shiftFactor).toBeLessThan(1));
  });

  // ===== 验收 3：变温升温 =====

  test('验收3：Tref 推进后升温，升温前与对照逐点相同，升温后更快靠拢 E∞·ε', async () => {
    await ensureMaterial('nitrile', WLF);
    const eps0 = 0.1;
    const hot: TrackSample[] = [
      { time: 0, strain: eps0, temperature: 20 },
      { time: 1, strain: eps0, temperature: 20 },
      { time: 3, strain: eps0, temperature: 20 },
      { time: 5, strain: eps0, temperature: 20 },
      { time: 10, strain: eps0, temperature: 60 },
      { time: 11, strain: eps0, temperature: 60 },
      { time: 14, strain: eps0, temperature: 60 },
      { time: 20, strain: eps0, temperature: 60 },
    ];
    const ref = hot.map((s) => ({ ...s, temperature: 20 }));

    const chHot = await track.createChannel({ materialName: 'nitrile', initialStrain: eps0 });
    const rHot1 = await track.appendBatch(chHot.id, { sequence: 1, samples: hot.slice(0, 4) });
    const rHot2 = await track.appendBatch(chHot.id, {
      sequence: 2,
      samples: [hot[3], ...hot.slice(4)],
    });
    const hotStress = [...rHot1.results.map((r) => r.stress), ...rHot2.results.slice(1).map((r) => r.stress)];

    const chRef = await track.createChannel({ materialName: 'nitrile', initialStrain: eps0 });
    const rRef = await track.appendBatch(chRef.id, { sequence: 1, samples: ref });
    const refStress = rRef.results.map((r) => r.stress);

    for (let i = 0; i <= 4; i++) {
      expect(hotStress[i]).toBeCloseTo(refStress[i], 12);
    }
    for (let i = 5; i < 8; i++) {
      expect(hotStress[i]).toBeLessThan(refStress[i]);
    }
    const eq = 3 * eps0;
    expect(Math.abs(hotStress[7] - eq)).toBeLessThan(Math.abs(refStress[7] - eq));
  });

  // ===== 验收 4：重发、冲突、跳号、倒退 =====

  test('验收4：同序号同内容重发原样返回且不推进；不同内容拒绝；跳号/倒退拒绝且状态不变', async () => {
    await ensureMaterial();
    const all = samplesAt(20);
    const ch = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });

    const first = await track.appendBatch(ch.id, { sequence: 1, samples: all.slice(0, 3) });
    expect(first.replayed).toBe(false);
    const snapshot = JSON.stringify(await track.getChannel(ch.id));

    // 同序号同内容重发：相同结果、replayed=true、通道不变
    const replay = await track.appendBatch(ch.id, { sequence: 1, samples: all.slice(0, 3) });
    expect(replay.replayed).toBe(true);
    expect(replay.results).toEqual(first.results);
    expect(JSON.stringify(await track.getChannel(ch.id))).toBe(snapshot);

    // 同序号不同内容：冲突拒绝
    const mutated = all.slice(0, 3).map((s, i) =>
      i === 1 ? { ...s, strain: s.strain + 0.001 } : s,
    );
    await expect(
      track.appendBatch(ch.id, { sequence: 1, samples: mutated }),
    ).rejects.toMatchObject({ code: 'TRACK_SEQUENCE_CONFLICT' });
    expect(JSON.stringify(await track.getChannel(ch.id))).toBe(snapshot);

    // 跳号：1 已处理，直接送 3
    await expect(
      track.appendBatch(ch.id, { sequence: 3, samples: [all[2], ...all.slice(3, 5)] }),
    ).rejects.toMatchObject({ code: 'TRACK_SEQUENCE_GAP' });
    expect(JSON.stringify(await track.getChannel(ch.id))).toBe(snapshot);

    // 序号倒退：再送 0
    await expect(
      track.appendBatch(ch.id, { sequence: 0, samples: all.slice(0, 3) }),
    ).rejects.toMatchObject({ code: 'TRACK_OUT_OF_ORDER' });
    expect(JSON.stringify(await track.getChannel(ch.id))).toBe(snapshot);

    // 时间倒退：序号正确（2），但起点早于通道当前时刻
    await expect(
      track.appendBatch(ch.id, {
        sequence: 2,
        samples: [{ ...all[1] }, { ...all[2] }], // 起点 t=0.4 < 当前 t=1.1
      }),
    ).rejects.toThrow(/早于通道当前时刻/);
    expect(JSON.stringify(await track.getChannel(ch.id))).toBe(snapshot);

    // 合法的第 2 批仍可正常推进
    const second = await track.appendBatch(ch.id, {
      sequence: 2,
      samples: [all[2], ...all.slice(3, 6)],
    });
    expect(second.replayed).toBe(false);
    expect(second.channel.lastSequence).toBe(2);
    expect(second.channel.currentTime).toBe(5);
  });

  test('批次列表可查，按序号升序，含点数与首尾时刻', async () => {
    await ensureMaterial();
    const all = samplesAt(20);
    const ch = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    await track.appendBatch(ch.id, { sequence: 1, samples: all.slice(0, 3) });
    await track.appendBatch(ch.id, { sequence: 2, samples: [all[2], ...all.slice(3, 6)] });
    const list = await track.listBatches(ch.id);
    expect(list.map((b) => b.sequence)).toEqual([1, 2]);
    expect(list[0].sampleCount).toBe(3);
    expect(list[0].firstTime).toBe(0);
    expect(list[0].lastTime).toBe(1.1);
    expect(list[1].lastTime).toBe(5);
  });

  // ===== 验收 5：并发 =====

  test('验收5：多批序号连续并发追加，结果与串行一致', async () => {
    await ensureMaterial();
    const all = samplesAt(20);

    // 按 [0..2), [2..5), [5..7), [7..9) 切 4 批，边界点重复；打乱到达顺序并发提交
    const ranges: Array<[number, number]> = [
      [0, 2],
      [2, 5],
      [5, 7],
      [7, 9],
    ];
    const batches = ranges.map(([from, to], i) => ({
      sequence: i + 1,
      samples: i === 0 ? all.slice(from, to) : [all[from - 1], ...all.slice(from, to)],
    }));

    const ch = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    const shuffled = [batches[3], batches[1], batches[0], batches[2]];
    const responses = await Promise.all(
      shuffled.map((b) => track.appendBatch(ch.id, b)),
    );
    // 每个请求都成功（无一因乱序被拒）
    expect(responses).toHaveLength(4);
    responses.forEach((r) => expect(r.results.length).toBeGreaterThan(0));

    // 通道最后状态
    const status = await track.getChannel(ch.id);
    expect(status.lastSequence).toBe(4);
    expect(status.currentTime).toBe(10);

    // 重组逐点应力，与串行通道对比
    const bySeq = new Map(responses.map((r) => [r.sequence, r]));
    const concurrentStresses: number[] = [];
    for (let s = 1; s <= 4; s++) {
      const r = bySeq.get(s)!;
      const emitted = s === 1 ? r.results : r.results.slice(1);
      concurrentStresses.push(...emitted.map((x) => x.stress));
    }

    const chSerial = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    const serialStresses: number[] = [];
    for (const b of batches) {
      const r = await track.appendBatch(chSerial.id, b);
      const emitted = b.sequence === 1 ? r.results : r.results.slice(1);
      serialStresses.push(...emitted.map((x) => x.stress));
    }
    expectClose(concurrentStresses, serialStresses);
    // 并与作业接口对照
    expectClose(concurrentStresses, expectedJobStressesNoWlf());
  }, 30000);

  test('验收5b：8 批严格逆序并发 + 每批重发一次，最终与串行一致且无重复推进', async () => {
    await ensureMaterial();
    const all = samplesAt(20);
    // 每批 1 个新点（批间重复边界点）
    const batches = Array.from({ length: 8 }, (_, i) => ({
      sequence: i + 1,
      samples: i === 0 ? all.slice(0, 2) : [all[i], all[i + 1]],
    }));

    const ch = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    // 逆序发起；同时给每批再发一个完全相同的并发副本（同序号同内容）
    const calls: Array<Promise<unknown>> = [];
    for (let i = batches.length - 1; i >= 0; i--) {
      calls.push(track.appendBatch(ch.id, batches[i]).catch((e) => e));
      calls.push(track.appendBatch(ch.id, batches[i]).catch((e) => e));
    }
    const outcomes = await Promise.all(calls);
    const errors = outcomes.filter((o) => o instanceof Error);
    // 允许的错误只有：并发下副本先到时的冲突重试类错误（这里同内容不应冲突），
    // 因此全部都应成功
    expect(errors).toHaveLength(0);

    const status = await track.getChannel(ch.id);
    expect(status.lastSequence).toBe(8);
    expect(status.currentTime).toBe(10);

    // 批次集合恰好 8 条（重发不产生重复批次）
    expect(await conn.collection('trackbatches').countDocuments()).toBe(8);

    // 串行对照
    const chSerial = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    const serial: number[] = [];
    for (let i = 0; i < batches.length; i++) {
      const r = await track.appendBatch(chSerial.id, batches[i]);
      const emitted = i === 0 ? r.results : r.results.slice(1);
      serial.push(...emitted.map((x) => x.stress));
    }
    const concurrent: number[] = [];
    for (let s = 1; s <= 8; s++) {
      const r = await track.getBatch(ch.id, s);
      const emitted = s === 1 ? r.results : r.results.slice(1);
      concurrent.push(...emitted.map((x) => x.stress));
    }
    expectClose(concurrent, serial);
  }, 30000);

  // ===== 验收 6：重启续算 =====

  test('验收6：状态落库后用全新服务实例读回继续，结果与不重启完全相同', async () => {
    await ensureMaterial('nitrile', WLF);
    const all: TrackSample[] = [
      ...samplesAt(20).slice(0, 5), // 0..3.3s 恒温 Tref
      { time: 5, strain: 0.12, temperature: 50 },
      { time: 6.5, strain: 0.1, temperature: 50 },
      { time: 8, strain: 0.05, temperature: 50 },
      { time: 10, strain: 0.05, temperature: 50 },
    ];

    // 通道 A：不重启，全程串行
    const chA = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    await track.appendBatch(chA.id, { sequence: 1, samples: all.slice(0, 3) });
    await track.appendBatch(chA.id, { sequence: 2, samples: [all[2], ...all.slice(3, 6)] });
    const tailA3 = await track.appendBatch(chA.id, {
      sequence: 3,
      samples: [all[5], ...all.slice(6)],
    });
    const endA = await track.getChannel(chA.id);

    // 通道 B：推进 2 批后“重启”——新建 Nest 容器/服务实例，从同一 Mongo 读回
    const chB = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    await track.appendBatch(chB.id, { sequence: 1, samples: all.slice(0, 3) });
    await track.appendBatch(chB.id, { sequence: 2, samples: [all[2], ...all.slice(3, 6)] });

    const track2 = await freshTrackService(mongod.getUri());
    try {
      // 重启后先重发第 2 批：应原样回放
      const replay = await track2.appendBatch(chB.id, {
        sequence: 2,
        samples: [all[2], ...all.slice(3, 6)],
      });
      expect(replay.replayed).toBe(true);
      // 再追加第 3 批
      const tailB3 = await track2.appendBatch(chB.id, {
        sequence: 3,
        samples: [all[5], ...all.slice(6)],
      });
      expect(tailB3.results).toEqual(tailA3.results);
      const endB = await track2.getChannel(chB.id);
      expect(endB.currentTime).toBeCloseTo(endA.currentTime ?? 0, 12);
      expect(endB.currentStrain).toBeCloseTo(endA.currentStrain ?? 0, 12);
      expect(endB.internalVariables).toEqual(endA.internalVariables);
      expect(endB.lastSequence).toBe(endA.lastSequence);
      expect(endB.stateVersion).toBe(endA.stateVersion);
    } finally {
      await track2.close();
    }
  }, 30000);

  test('验收6b：批次已落库、通道未推进（模拟提交中途崩溃），重启后下批自动补齐且结果等价串行', async () => {
    await ensureMaterial();
    const all = samplesAt(20);
    const ch = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    await track.appendBatch(ch.id, { sequence: 1, samples: all.slice(0, 3) });

    // 手工插入一个“已提交但通道状态未推进”的第 2 批（模拟两步提交之间崩溃）：
    // 直接插批次集合，通道 lastSequence 仍为 1。
    const stateBefore = await track.getChannel(ch.id);
    const channelDoc = await conn
      .collection('trackchannels')
      .findOne({});
    // 用内核算出第 2 批的结果（仅用于构造悬挂批次内容）
    const { processSamples } = await import('./track-kernel');
    const spec = {
      eInf: 3,
      branches: [
        { modulus: 4, tau: 0.3 },
        { modulus: 6, tau: 7 },
      ],
      wlf: null,
    };
    const computed = processSamples(
      spec,
      {
        time: stateBefore.currentTime as number,
        strain: stateBefore.currentStrain as number,
        temperature: 20,
        internal: stateBefore.internalVariables,
        anchored: true,
      },
      [all[2], ...all.slice(3, 6)],
    );
    await conn.collection('trackbatches').insertOne({
      channelId: channelDoc!._id,
      sequence: 2,
      samples: [all[2], ...all.slice(3, 6)],
      results: computed.results,
      endState: computed.state,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 新实例读回
    const track2 = await freshTrackService(mongod.getUri());
    try {
      // 追加第 3 批前，恢复逻辑应先把第 2 批补进通道状态
      const r3 = await track2.appendBatch(ch.id, {
        sequence: 3,
        samples: [all[5], ...all.slice(6)],
      });
      const status = await track2.getChannel(ch.id);
      expect(status.lastSequence).toBe(3);
      expect(status.currentTime).toBe(10);

      // 与全程串行的对照通道逐点一致
      const ref = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
      await track.appendBatch(ref.id, { sequence: 1, samples: all.slice(0, 3) });
      const r2 = await track.appendBatch(ref.id, {
        sequence: 2,
        samples: [all[2], ...all.slice(3, 6)],
      });
      const r3ref = await track.appendBatch(ref.id, {
        sequence: 3,
        samples: [all[5], ...all.slice(6)],
      });
      const replay2 = await track.getBatch(ch.id, 2);
      expect(replay2.results).toEqual(r2.results);
      expect(r3.results).toEqual(r3ref.results);
    } finally {
      await track2.close();
    }
  }, 30000);

  // ===== 验收 7：非法输入 =====

  test('验收7：空批次、时间不递增、WLF 分母非正，均报错且不改动通道', async () => {
    await ensureMaterial('nitrile', WLF);
    const ch = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    const snap = JSON.stringify(await track.getChannel(ch.id));
    const channelCount0 = await conn.collection('trackchannels').countDocuments();
    const batchCount0 = await conn.collection('trackbatches').countDocuments();

    await expect(
      track.appendBatch(ch.id, { sequence: 1, samples: [] }),
    ).rejects.toMatchObject({ code: 'TRACK_BATCH_EMPTY' });

    await expect(
      track.appendBatch(ch.id, {
        sequence: 1,
        samples: [
          { time: 0, strain: 0.1, temperature: 20 },
          { time: 1, strain: 0.1, temperature: 20 },
          { time: 1, strain: 0.1, temperature: 20 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TIME_NOT_STRICTLY_INCREASING' });

    await expect(
      track.appendBatch(ch.id, {
        sequence: 1,
        samples: [
          { time: 0, strain: 0.1, temperature: 20 },
          { time: 1, strain: 0.1, temperature: -100 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'WLF_DENOMINATOR_NONPOSITIVE' });

    await expect(
      track.appendBatch(ch.id, {
        sequence: 1,
        samples: [{ time: 0, strain: 0.1, temperature: Number.NaN }],
      }),
    ).rejects.toMatchObject({ code: 'TRACK_SAMPLE_INVALID' });

    // 通道逐字段不变，批次集合没有新增
    expect(JSON.stringify(await track.getChannel(ch.id))).toBe(snap);
    expect(await conn.collection('trackchannels').countDocuments()).toBe(channelCount0);
    expect(await conn.collection('trackbatches').countDocuments()).toBe(batchCount0);
  });

  test('序号必须是非负整数', async () => {
    await ensureMaterial();
    const ch = await track.createChannel({ materialName: 'nitrile', initialStrain: 0.1 });
    for (const seq of [-1, 1.5, Number.NaN]) {
      await expect(
        track.appendBatch(ch.id, {
          sequence: seq as number,
          samples: samplesAt(20).slice(0, 2),
        }),
      ).rejects.toMatchObject({ code: 'TRACK_SAMPLE_INVALID' });
    }
  });

  // ===== 辅助：构造“重启后”的全新服务实例 =====

  async function freshTrackService(
    uri: string,
  ): Promise<TrackService & { close: () => Promise<void> }> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: MaterialDocumentDefinition.name, schema: MaterialSchema },
          { name: TrackChannelDefinition.name, schema: TrackChannelSchema },
          { name: TrackBatchDefinition.name, schema: TrackBatchSchema },
        ]),
      ],
      providers: [MaterialService, TrackService],
    }).compile();
    const freshApp = moduleRef.createNestApplication();
    await freshApp.init();
    const service = freshApp.get(TrackService) as TrackService & {
      close: () => Promise<void>;
    };
    service.close = () => freshApp.close();
    return service;
  }
});
