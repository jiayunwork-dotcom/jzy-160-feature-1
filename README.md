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

### 跟踪通道的变温累积（时温等效增量积分）

作业接口只支持整条历程恒温；**跟踪通道**的温度随每个采样点变化。
引入参考温度下的约化时间 ξ：

```
dξ = dt / a(T(t)),    dz_i/dξ + z_i/τ_i = dε/dξ
```

两个相邻采样点 [t_{n-1}, t_n] 之间采用 **左端点温度保持（sample-and-hold）**
约定：整段按区间起点（上一个采样点）测得的温度 T_{n-1} 折算，

```
Δξ_n = Δt_n / a_T(T_{n-1}),    f_i = exp(−Δξ_n/τ_i) = exp(−Δt_n / (a_T(T_{n-1})·τ_i))
```

应变在区间内仍按相邻采样点线性插值，因此一步精确积分公式与作业内核逐运算
完全相同（只是把 Δt 换成 Δξ）。返回的每个采样点的 `shiftFactor` 是**该点
自身温度**的 a_T；而它对松弛的作用体现在以它为左端点的下一区间上。

- **为什么选左端点保持**：监测语义是“测到一个温度后，直到下一次测量之前
  材料就处于这个温度”；传感器上报是离散事件，温度在采样时刻之间没有更细
  的信息，零阶保持是最直接的解释。它只需要左端点值即可闭合递推，与 Prony
  内变量“只依赖上一步”的增量结构天然匹配；区间边界处的温度突跳不会被涂抹
  到相邻区间（下一个区间立即采用新温度）。恒温（含 T=Tref）时
  Δξ=Δt/a_T，与作业接口指定同一温度的结果**逐位一致**。
- **另一种合理选择**：在两点温度间做线性插值并对 1/a_T 梯形（或解析）积分。
  当温度本身在区间内近似线性时，梯形积分是二阶精度 O(Δt²)，而左端点矩形是
  一阶 O(Δt)。本服务未采用它，因为它隐含“区间内温度线性变化”这一监测链路
  通常不成立的假设，且对快速波动会给出介于两测点之间的虚假平滑；要达到同样
  的精度，推荐的做法是在温度变化剧烈处**加密采样**——两种方案都随 Δt→0
  收敛到同一真解。
- **温度变化剧烈时的误差**：左端点保持把区间内的真实温度一律近似成起点值，
  区间折合时间的误差为 O(Δt)，系数随 1/a_T(T) 在该区间的变化幅度增大
  （低温侧 C2+T−Tref→0⁺ 时 a_T 对温度极敏感，误差被放大）。升温段会略微
  低估折合时间（松弛算慢一点），降温段相反；误差只作用于该区间，不会跨区间
  累积成状态漂移之外的系统偏差。任何采样点温度使 C2+T−Tref≤0 时整批拒绝。
- 材料档**不带 WLF 参数**时，温度只随采样记录和回显，`shiftFactor` 恒为 1，
  不参与任何计算。

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
| `src/track` | 跟踪通道：分批追加、幂等/按序并发、续算状态落库、变温 WLF 增量累积 |
| `src/persistence` | Mongoose schema（materials / jobs / trackchannels / trackbatches） |
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

### 跟踪通道（长期服役监测，增量追加）

开通道时引用一个已有材料档（材料参数在开通道时**快照固化**，日后修改材料档
不影响已开通道），通道从未加载静止状态起步；可给 `initialStrain` 表示在起始
时刻瞬时施加的应变。之后按客户端自己编的**连续整数序号**分批追加
`(time, strain, temperature)` 采样，服务返回这批每个采样时刻的应力与平移因子，
并把续算状态落库。

```bash
# 开通道（可带初始应变）
curl -X POST http://localhost:3000/tracks \
  -H 'Content-Type: application/json' \
  -d '{"materialName": "nitrile-70", "initialStrain": 0.1}'
# {"id": "660...", "anchored": false, "currentTime": null, ...}

# 第 1 批：第一个采样点是通道锚点（其 time 为历程起点；strain 必须等于 initialStrain）
curl -X POST http://localhost:3000/tracks/660.../batches \
  -H 'Content-Type: application/json' \
  -d '{
    "sequence": 1,
    "samples": [
      {"time": 0,    "strain": 0.1, "temperature": 20},
      {"time": 0.5,  "strain": 0.1, "temperature": 20},
      {"time": 1.0,  "strain": 0.1, "temperature": 20}
    ]
  }'
# {"sequence":1,"replayed":false,
#  "results":[{"time":0,"strain":0.1,"temperature":20,"stress":1.3,"shiftFactor":1}, ...],
#  "channel":{"currentTime":1,"currentStrain":0.1,"currentTemperature":20,"lastSequence":1, ...}}

# 下一批：时间紧接上批末尾。允许重复上批末点作为边界点（此时 strain/temperature
# 必须与通道当前点一致，该点原样返回、不重复推进）；也允许不重复（起点时刻严格
# 大于当前时刻），桥接区间按通道当前温度折时、应变在两点间线性处理。
# t=1.5 测点温度切到 60：区间 [1,1.5] 仍按左端点 20°C，[1.5,…] 起按 60°C 快速松弛
curl -X POST http://localhost:3000/tracks/660.../batches \
  -H 'Content-Type: application/json' \
  -d '{
    "sequence": 2,
    "samples": [
      {"time": 1.0, "strain": 0.1, "temperature": 20},
      {"time": 1.5, "strain": 0.1, "temperature": 60}
    ]
  }'

GET /tracks/:id              # 通道当前状态（时刻/应变/温度/支路内变量/最后序号/状态版本）
GET /tracks/:id/batches      # 已处理批次列表（按序号升序：点数、首尾时刻）
GET /tracks/:id/batches/:seq # 某批的完整逐点结果
```

续算所需的全部状态（当前时刻、应变、温度、每个 Prony 支路的内变量 z_i、
锚定标记）都在 `trackchannels` 文档里；每批原始采样与逐点结果存于
`trackbatches`（通道内序号唯一）。**应用重启后直接追加下一批即可**，
结果与不重启完全相同（见第 7 节手动复现）。

**重发、乱序、并发的语义**：

- 同序号批次再次送达且内容相同 → 原样返回上次结果（`replayed:true`），
  状态不推进；内容不同 → `409 TRACK_SEQUENCE_CONFLICT` 拒绝，通道不变。
- 序号必须连续：首批任意，之后必须恰好为 `lastSequence+1`；跳号
  → `409 TRACK_SEQUENCE_GAP`，倒退 → `409 TRACK_OUT_OF_ORDER`。
- 批次起点早于通道当前时刻 → 拒绝（`TRACK_BATCH_NOT_CONTIGUOUS`），
  通道状态逐字段不变。
- 同一通道被多个采集进程并发追加时，服务对通道做 FIFO 串行并让“序号更小
  但晚到”的批次让路重排，最终等价于按序号逐批处理：不会两批基于同一旧状态
  推进，也不会丢批。
- 状态推进采用“先写批次文档、再用状态版本号条件更新通道”，两步之间崩溃会
  留下悬挂批次，下次追加时按存档采样自动重新递推补齐，不依赖多文档事务。

---

## 5. 校验规则（均返回说明原因的错误）

- `τ_i ≤ 0`、`E_i < 0`、`E∞ < 0`
- 控制点时间不严格递增；拼接点应变间断；后续拼接段不连续
- 正弦频率 ≤ 0、周期数 ≤ 0；第一段不是线性段
- WLF 分母 `C2+T−Tref ≤ 0`
- 输出网格为空、不严格递增、超出历程时间范围
- 作业为空、引用不存在的材料档
- 跟踪通道：引用不存在的材料档；批次为空；序号不是非负整数；批内时间不严格
  递增；同序号内容冲突；序号跳号/倒退；批次起点早于通道当前时刻；边界点应变
  或温度不连续；某个采样温度使 WLF 分母非正

错误响应统一为 `{statusCode, errorCode, message}`。
任何被拒绝的批次都不会写入或改动通道状态（先全部校验/递推，再提交）。

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

### 跟踪通道（Jest，逐条覆盖验收）

- 分段线性历程按采样点拆成多批恒温追加，应力与作业接口同一时刻一致
  （相对误差 < 1e-9，近零处看绝对误差）；换切批方式（边界点重复/不重复、
  不同批大小）结果不变
- 恒温 Tref 与去掉 WLF 的同参数材料相同；恒温 T 与作业接口指定温度 T 相同
- 先 Tref 推进再升温：升温前与 Tref 对照通道逐点相同，升温后向 E∞·ε 靠拢
  明显更快；左端点温度保持的区间折时可手算复算
- 同序号同内容重发返回相同结果、当前时刻不变；同序号不同内容（409）、跳号、
  序号倒退、时间倒退都带原因拒绝，报错后通道状态逐字段相同
- 多批序号连续但乱序并发追加，全部成功且结果与串行逐批追加一致
- 推进若干批后用全新 Nest 服务实例从同一 MongoDB 读回继续，逐点结果与状态与
  不重启完全相同；另模拟“批次已落库、通道未推进”的提交中途崩溃，重启后
  下一批自动补齐且等价串行
- 引用不存在材料档、批内时间不严格递增、空批次、WLF 分母非正温度均带原因
  报错且通道与批次集合不被改动

---

## 7. 在 compose 环境手动复现“重启续算”

不需要新增任何服务（沿用现有 app + mongo 两个容器与命名卷）：

```bash
docker compose up --build -d

# 1) 建档 + 开通道 + 追加两批
curl -s -X POST localhost:3000/materials -H 'Content-Type: application/json' \
  -d '{"name":"nitrile-70","eInf":3,
       "branches":[{"modulus":4,"tau":0.3},{"modulus":6,"tau":7}],
       "wlf":{"tRef":20,"c1":17.44,"c2":51.6}}'

CH=$(curl -s -X POST localhost:3000/tracks -H 'Content-Type: application/json' \
  -d '{"materialName":"nitrile-70","initialStrain":0.1}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

curl -s -X POST localhost:3000/tracks/$CH/batches -H 'Content-Type: application/json' \
  -d '{"sequence":1,"samples":[
       {"time":0,"strain":0.1,"temperature":20},
       {"time":1,"strain":0.1,"temperature":20},
       {"time":2,"strain":0.1,"temperature":20}]}'

# t=3 测点温度切到 60：区间 [2,3] 仍按左端点 t=2 的 20°C 折时，
# 60°C 的快速松弛从下一个区间 [3,4] 开始生效
curl -s -X POST localhost:3000/tracks/$CH/batches -H 'Content-Type: application/json' \
  -d '{"sequence":2,"samples":[
       {"time":2,"strain":0.1,"temperature":20},
       {"time":3,"strain":0.1,"temperature":60}]}'

# 2) 记下当前状态与第 2 批结果
curl -s localhost:3000/tracks/$CH | python3 -m json.tool

# 3) 只重启应用容器（mongo 与数据卷不动）
docker compose restart app
sleep 3

# 4) 重发第 2 批：replayed=true、结果与重启前相同；再追加第 3 批照常推进，
#    升温段的应力继续按已累积的加载史计算
curl -s -X POST localhost:3000/tracks/$CH/batches -H 'Content-Type: application/json' \
  -d '{"sequence":2,"samples":[
       {"time":2,"strain":0.1,"temperature":23},
       {"time":3,"strain":0.1,"temperature":60}]}'
curl -s -X POST localhost:3000/tracks/$CH/batches -H 'Content-Type: application/json' \
  -d '{"sequence":3,"samples":[
       {"time":3,"strain":0.1,"temperature":60},
       {"time":4,"strain":0.1,"temperature":60}]}'
curl -s localhost:3000/tracks/$CH | python3 -m json.tool
```

自动化测试中“重启”以**销毁并新建应用容器/服务实例、从同一 MongoDB 把状态
读回**来代替（`track.service.integration.spec.ts` 中的验收 6 / 6b）。
