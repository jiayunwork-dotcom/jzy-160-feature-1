import { ViscoError } from '../common/errors';
import { ChannelScheduler } from './track.service';

/**
 * ChannelScheduler 的并发不变量（不依赖 Mongo）：
 * - 临界区互斥（同时只有一个任务在跑）；
 * - 序号小但晚到的任务让路，最终执行顺序严格等于序号顺序；
 * - 前驱迟迟不到会在超时后抛 TRACK_PREDECESSOR_TIMEOUT，且不阻塞后续无关任务。
 */
describe('ChannelScheduler（FIFO 互斥 + 序号让路）', () => {
  test('乱序到达的任务按序号顺序执行，临界区从不重叠', async () => {
    const sched = new ChannelScheduler();
    const order: number[] = [];
    let inCritical = 0;
    let overlap = false;

    const makeTask = (seq: number, delay: number) => async (): Promise<number> => {
      overlap = overlap || inCritical !== 0;
      inCritical++;
      await new Promise((r) => setTimeout(r, delay));
      order.push(seq);
      inCritical--;
      return seq;
    };

    // 4,2,1,3 的启动顺序；期望完成/执行顺序 1,2,3,4
    const results = await Promise.all([
      sched.run(4, makeTask(4, 5)),
      sched.run(2, makeTask(2, 15)),
      sched.run(1, makeTask(1, 10)),
      sched.run(3, makeTask(3, 8)),
    ]);
    expect(results).toEqual([4, 2, 1, 3]); // 各请求拿到自己的结果
    expect(order).toEqual([1, 2, 3, 4]); // 执行顺序按序号
    expect(overlap).toBe(false);
  });

  test('任务的业务失败只影响自己，不中断后续任务', async () => {
    const sched = new ChannelScheduler();
    const boom = sched.run(1, async () => {
      throw new ViscoError('TRACK_BATCH_EMPTY', 'x');
    });
    await expect(boom).rejects.toMatchObject({ code: 'TRACK_BATCH_EMPTY' });
    const ok = await sched.run(2, async () => 42);
    expect(ok).toBe(42);
  });

  test('更小序号的在途请求始终不结束时，后继在超时后报 TRACK_PREDECESSOR_TIMEOUT', async () => {
    const sched = new ChannelScheduler();
    // 序号 1 的请求挂住永不结束（模拟进程崩溃但未清理在途标记——生产中
    // 请求一旦结束 finally 必清理标记，这里手动制造极端场景）。
    const hung = new Promise<never>(() => {});
    const p1 = sched.run(1, () => hung);
    const p2 = sched.run(2, async () => 'should-not-run');
    await expect(p2).rejects.toMatchObject({
      code: 'TRACK_PREDECESSOR_TIMEOUT',
    });
    // p1 仍 pending（避免未处理 rejection）
    expect(typeof p1.then).toBe('function');
  }, 40000);
});
