# 粘弹核算服务（Prony / 广义 Maxwell）

密封件与减振橡胶 CAE 组的粘弹性后端作业服务。输入试验室给出的 **Prony 级数参数**
（平衡模量 E∞ 加若干支路 (E_i, τ_i)，可选 WLF 时温等效参数），对任意分段线性 +
正弦拼接的应变历程，在给定输出时间网格上计算应力 σ(t)，并输出松弛模量 E(t)
与正弦稳态储能/损耗模量。

- 框架：NestJS（TypeScript, Node.js 20）
- 数据库：MongoDB 7（Mongoose）
- 内核：每支路一个内变量，逐步递推，分段线性/正弦段一步精确积分，计算量随步数**线性**增长

---

## 1. 本构与内核

松弛模量

```
E(t) = E∞ + Σ_i E_i exp(−t/τ_i),        E0 = E∞ + Σ_i E_i
```

引入应变型支路内变量

```
ż_i + z_i/τ_i = ε̇,        σ(t) = E∞·ε(t) + Σ_i E_i z_i(t)
```

- 静止过去 ε=0，阶跃 ε0 在 t₀ 瞬时施加：z_i(t₀+)=ε0，保持段 z_i=ε0·e^{−t/τ_i}，
  因此 **σ(t)=E(t)·ε0**，t≫max τ 时趋于 **E∞·ε0**。
- 分段线性段（ε̇=r 为常数）一步精确积分：
  `z_i^{n+1} = f_i z_i^n + r·τ_i·(1−f_i)`，`f_i=e^{−Δt/τ_i}`，只依赖上一步。
- 正弦段 ε=b+A sin ωt 给出闭合形式一步积分（见 `src/prony/prony-kernel.service.ts`）。
- 不做全历史卷积求和，长历程单遍推进；输出时刻与控制点合并为统一断点。

### 动态模量（解析）

```
E′(ω) = E∞ + Σ E_i (ωτ_i)²/(1+(ωτ_i)²)
E″(ω) =      Σ E_i  ωτ_i  /(1+(ωτ_i)²)
tan δ  = E″/E′
```

### WLF 时温等效

```
log10 a_T = −C1 (T−Tref) / (C2 + T−Tref),        τ(T) = a_T·τ
```

T>Tref（C1,C2>0）时 a_T<1，松弛更快；C2+T−Tref≤0 返回错误。

---

## 2. 模块划分

| 目录 | 职责 |
|---|---|
| `src/material` | 材料档域模型、校验（E∞、E_i、τ_i）、E0 回显、材料服务 |
| `src/history` | 历程解析：分段线性控制点 + 正弦段拼接、输出网格、全部历程校验 |
| `src/prony` | Prony 递推内核（**不依赖控制器/数据库**） |
| `src/dynamic` | E′/E″/tanδ 解析动态模量 |
| `src/wlf` | WLF 平移因子 |
| `src/job` | 作业异步调度、单条失败隔离、进度、按材料检索 |
| `src/channel` | 跟踪通道：分批追加、变温约化时间递推内核、幂等/乱序/并发、状态落库续算 |
| `src/persistence` | Mongoose schema（materials / jobs / channels） |
| `src/http` | DTO、控制器、异常过滤器 |

---

## 3. 快速开始

### Docker Compose（app + mongo:7，命名卷）

```bash
docker compose up --build
# 应用 http://localhost:3000 ，mongo 端口 27017，数据卷 visco-cae-mongo-data
```

### 本地开发

```bash
npm ci
npm run test          # Jest 单元 + 内存 MongoDB 集成测试
npm run start:dev     # 需要本机/ compose 的 mongo（见 .env.example）
```

---

## 4. HTTP API

### 材料档

```bash
curl -X POST http://localhost:3000/materials \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "nitrile-70",
    "description": "丁腈胶 70 邵氏",
    "eInf": 3.0,
    "branches": [
      {"modulus": 4.0, "tau": 0.1},
      {"modulus": 6.0, "tau": 10.0}
    ],
    "wlf": {"tRef": 20, "c1": 17.44, "c2": 51.6}
  }'
# 响应回显 "e0": 13.0
```

`GET /materials`、`GET /materials/:name`。

### 提交作业（异步，返回作业号）

```bash
curl -X POST http://localhost:3000/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "materialName": "nitrile-70",
    "histories": [
      {
        "name": "阶跃压缩后保持",
        "segments": [
          {"type": "linear", "times": [0, 100], "strains": [0.1, 0.1]}
        ],
        "temperature": 20,
        "output": {"kind": "uniform", "start": 0, "stop": 100, "count": 1001}
      },
      {
        "name": "斜坡 + 正弦往复",
        "segments": [
          {"type": "linear", "times": [0, 1], "strains": [0, 0.05]},
          {"type": "sine", "amplitude": 0.02, "frequency": 2, "cycles": 20, "preload": 0.05}
        ],
        "output": {"kind": "uniform", "start": 0, "stop": 11, "count": 2201}
      }
    ]
  }'
# {"jobId": "65f..."}
```

输出网格也可给显式时刻：`{"kind":"points","times":[0,1,2,5]}`。

### 查询进度 / 取结果 / 按材料检索

```bash
GET /jobs/:id            # 进度与每条历程状态（失败附 errorCode/errorMessage）
GET /jobs/:id/detail     # 完整结果：times/strains/stresses/relaxationModulus/dynamics
GET /jobs?materialName=nitrile-70
```

单条历程失败不影响其余：失败行 `status:"failed"` 并带 `errorCode`、`errorMessage`。

---

## 4a. 跟踪通道（长期服役监测，分批追加）

作业接口一次收齐完整历程、算完即结束；**跟踪通道**面向隔振垫这类数月起步、一直往后延伸的
在线监测：开通道后按批次追加采样（每批是紧接上一批末尾的一串 `时间/应变/温度`），
服务记住整段加载史的推进状态并落库，应用重启后接着算，结果与没重启完全一致。

通道的完整可续算状态：当前物理时刻、末尾应变/温度、累计约化时间、每个 Prony 支路的内变量
`z_i`、下一个期望批次序号，以及已处理批次（原始采样 + 结果）的存档，全部存在 MongoDB 的
`channels` 集合。开通道时把材料参数**固化成快照**，材料档日后改动不影响在役通道。

### 开通道

```bash
curl -X POST http://localhost:3000/channels \
  -H 'Content-Type: application/json' \
  -d '{
    "materialName": "nitrile-70",
    "description": "隔振垫测点A",
    "initialStrain": 0.0,
    "initialTemperature": 23
  }'
# 初始应变缺省 0（从未加载的静止状态起步）；给非零值表示在 t=0 瞬时施加。
# 材料带 WLF 且首批采样晚于 t=0 时，必须给 initialTemperature。
```

### 追加批次

```bash
curl -X POST http://localhost:3000/channels/<channelId>/batches \
  -H 'Content-Type: application/json' \
  -d '{
    "seq": 1,
    "samples": [
      {"time": 0,   "strain": 0.01, "temperature": 23},
      {"time": 60,  "strain": 0.02, "temperature": 24},
      {"time": 120, "strain": 0.02, "temperature": 27}
    ]
  }'
```

返回每个采样点的 `time/strain/temperature/stress/shiftFactor/reducedTime`，以及推进后的通道状态
`state`（当前时刻、末尾应变/温度、约化时间、`nextSeq`、批次数）。下一批 `seq=2`，首点时间必须
**严格晚于**本批末点（批次边界不共用同一个点）。

### 查询

```bash
GET /channels/<id>                # 当前状态
GET /channels/<id>/batches        # 已处理批次列表（序号/点数/起止时间）
GET /channels/<id>/batches/:seq   # 某批次的原始采样与结果（对账用）
```

### 重发、乱序、并发语义

- **重发幂等**：同一 `seq` 再次送来，采样逐字段相同 ⇒ 原样返回上次结果，`duplicate:true`，
  通道不再推进；内容不同 ⇒ `409 CHANNEL_BATCH_CONFLICT`，通道状态逐字段不变。
- **跳号**：缺少前序序号 ⇒ 有限宽限期（默认 250ms，`CHANNEL_GRACE_MS` 可调）内等待前序；
  过期仍缺 ⇒ `409 CHANNEL_SEQ_GAP`，通道状态不变。
- **乱序**：连续序号的批次（如先到 seq=2、后到 seq=1）在宽限期内自动按序号串好处理，
  两批都生效，结果等价于按序提交。
- **并发**：同一通道两批并发追加，落库是带序号/版本/时刻条件的原子更新（CAS + `__v`），
  只有一方能基于旧状态推进成功，另一方重读后串行跟进，
  **最终状态严格等价于按序号逐批处理**，不会两批基于同一旧状态、不会丢批。

### 重启续算

所有续算所需状态都在 MongoDB；应用容器重启后直接追加下一批即可，无需重放历史。
compose 下手动复现见 §7。

---

## 4b. 通道里的变温松弛：约化时间与两点间的温度处理

材料档带 WLF 时，通道温度随采样变化，按**时温等效原理**在约化时间（参考温度时钟）上累积：

```
dξ/dt = 1/a_T(T(t)),   支路方程改写为  dz_i/dξ + z_i/τ_i = dε/dξ
```

相邻采样点 A→B 之间的处理约定（本服务的选择）：

1. **温度在区间内视为线性变化**，约化时间增量用两端 `1/a_T` 的**梯形公式**：

   ```
   Δξ = (tB − tA) · ( 1/a_T(TA) + 1/a_T(TB) ) / 2
   ```

2. **应变在该区间按约化时间线性**（割线率 `rξ = (εB−εA)/Δξ`），支路一步精确积分，
   公式与作业内核的分段线性段完全相同：
   `z_i^B = f_i z_i^A + rξ·τ_i·(1−f_i)`，`f_i = exp(−Δξ/τ_i)`。

**为什么选梯形 + 约化时间线性**：梯形公式是 `dξ/dt=1/a_T(T)` 对线性温度剖面的二阶近似，
只用区间两端已有的量、无需额外求值或迭代，单步代价与恒温完全相同；它在恒温时退化为
`Δξ=Δt/a_T`、且 `rξ=a_T·r_t`，此时本通道推进与作业内核的恒温 WLF 递推**逐项运算恒等**
（浮点结果一致，验收 1/2 的 1e-9 对照由此保证）。材料档没有 WLF 参数时 `a_T≡1`、
`ξ=t`，温度只记录、不参与计算。

**温度变化剧烈时的误差**：`1/a_T(T)` 在 WLF 适用区间内是凸函数，温度剧烈单调变化时，
梯形对 `1/a_T` 的积分是**高估**的（凸函数的弦在函数上方），即该区间累计的约化时间偏长、
松弛被估得偏快；快速升温段会轻微偏向更早趋于 E∞·ε。误差量级为
`O((ΔT)²·|(1/a_T)″|/8)·Δt`，随单区间温差的平方下降——把采样加密（让相邻两点温差变小）
即可收敛；若一个区间内温度先升后降，梯形误差会部分自相抵消。另外，区间内实际应变路径的
曲率也被忽略（与作业内核分段线性的假设一致）。端点温度若使 WLF 分母
`C2+T−Tref ≤ 0`，该批直接返回 `WLF_DENOMINATOR_NONPOSITIVE` 且通道不推进。



## 5. 校验规则（均返回说明原因的错误）

- `τ_i ≤ 0`、`E_i < 0`、`E∞ < 0`
- 控制点时间不严格递增；拼接点应变间断；后续拼接段不连续
- 正弦频率 ≤ 0、周期数 ≤ 0；第一段不是线性段
- WLF 分母 `C2+T−Tref ≤ 0`
- 输出网格为空、不严格递增、超出历程时间范围
- 作业为空、引用不存在的材料档

跟踪通道额外的校验（全部返回带原因的错误，且**通道状态逐字段不变**）：

- 开通道引用不存在的材料档；初始应变/初始温度非有限值；初始温度让 WLF 分母非正
- 批次为空、`seq` 非 ≥1 的整数；采样点字段缺失/非有限值；批次内采样时间不严格递增
- 批次首点时间 ≤ 通道当前时刻（倒退或边界重复）
- 重发同序号但采样内容不同（`CHANNEL_BATCH_CONFLICT`）；序号跳号且宽限期内前序未到（`CHANNEL_SEQ_GAP`）
- 任一区间端点温度使 WLF 分母 `C2+T−Tref ≤ 0`（`WLF_DENOMINATOR_NONPOSITIVE`）
- 材料带 WLF、首批采样晚于 t=0，但开通道时未给初始温度

错误响应统一为 `{statusCode, errorCode, message}`。

---

## 6. 已测试的性质（Jest）

- 可手算的单支路阶跃算例：E∞=3、E1=7、τ=2、ε0=0.1，σ(0)=1、σ(2)=0.1(3+7/e)、σ→0.3
- σ(t)=E(t)·ε0；t≫τ 趋于 E∞·ε0
- 无支路退化为线弹性 σ=E∞·ε
- 应变叠加 ⇒ 应力叠加；时间平移不变；τ 与时间轴同乘 k 的时间缩放不变
- 单支路 t=τ 时支路贡献剩初值 e⁻¹
- 输出网格加密一倍，同一时刻应力变化 ≤ 容差
- 正弦稳态内核拟合的 E′/E″ 与解析 E′(ω)/E″(ω) 一致
- 升温 a_T<1、同历程松弛更快，且等价于 τ→a_T·τ
- 全部错误条件；作业异步执行、单条失败隔离、按材料档检索（内存 MongoDB 集成测试）

跟踪通道（内核纯函数测试 + 内存 MongoDB 服务集成 + HTTP e2e）：

- **一致性**：分段线性历程按采样点拆成多批恒温追加，逐点与作业接口一致
  （相对误差 < 1e-9；应力接近零处看绝对误差 < 1e-12）；换切批方式结果逐位相同
- **WLF 等价**：恒温 Tref 与去掉 WLF 的同参数材料完全相同；恒温 T 与作业接口指定
  温度 T 的结果一致；约化时间 ξ=t/a_T
- **升温**：先在 Tref 推进再升温保持，升温前与 Tref 对照通道逐点相同，升温后明显更快向 E∞·ε 靠拢
- **幂等/冲突**：同序号同内容重发返回相同结果、`duplicate:true`、通道时刻不变；
  同序号不同内容、跳号、时间倒退都返回带原因错误，且报错后通道状态与报错前逐字段相同
- **并发/乱序**：对同一通道并发追加多批连续序号，全部完成后与串行逐批结果一致；
  乱序（seq=2 先到）最终等价按序处理
- **重启续算**：若干批后用全新应用实例（同一 MongoDB）读回状态继续追加，结果与不重启完全相同
- 全部通道错误条件不改动通道（见 §5 通道部分）

---

## 7. compose 环境下重启续算手动复现

不新增任何服务，沿用现有编排；数据在命名卷 `visco-cae-mongo-data` 上，重启 app 容器不丢状态。

```bash
docker compose up --build
# 1) 建档（带 WLF）
curl -s -X POST localhost:3000/materials -H 'Content-Type: application/json' -d '{
  "name":"nitrile-70","eInf":3,
  "branches":[{"modulus":4,"tau":0.5},{"modulus":6,"tau":10}],
  "wlf":{"tRef":20,"c1":17.44,"c2":51.6}}'

# 2) 开通道（记录返回的 id）
CID=$(curl -s -X POST localhost:3000/channels -H 'Content-Type: application/json' \
  -d '{"materialName":"nitrile-70","initialStrain":0.1,"initialTemperature":20}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo $CID

# 3) 追加前两批
curl -s -X POST localhost:3000/channels/$CID/batches -H 'Content-Type: application/json' \
  -d '{"seq":1,"samples":[{"time":0,"strain":0.1,"temperature":20},{"time":30,"strain":0.1,"temperature":20}]}'
curl -s -X POST localhost:3000/channels/$CID/batches -H 'Content-Type: application/json' \
  -d '{"seq":2,"samples":[{"time":60,"strain":0.1,"temperature":40}]}'

# 4) 只重启应用容器（mongo 与数据卷不动）
docker compose restart app
sleep 3

# 5) 查状态：nextSeq=3、currentTime=60，接着追加 seq=3，结果与不重启完全一致
curl -s localhost:3000/channels/$CID
curl -s -X POST localhost:3000/channels/$CID/batches -H 'Content-Type: application/json' \
  -d '{"seq":3,"samples":[{"time":120,"strain":0.1,"temperature":40}]}'

# 6) 重发 seq=2：duplicate=true、原样返回、时刻仍是 120
curl -s -X POST localhost:3000/channels/$CID/batches -H 'Content-Type: application/json' \
  -d '{"seq":2,"samples":[{"time":60,"strain":0.1,"temperature":40}]}'
```

