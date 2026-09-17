# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录和复测记录。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/appointments`（调校预约，必填 `watchmaker`）
- `GET /clocks/:id/appointments`（该钟表的历史预约）
- `POST /clocks/:id/retests`（复测，自动绑定最近一次预约）
- `GET /clocks/:id/latest-retest`
- `GET /appointments?clockId=&status=`（历史预约查询）
- `GET /appointments/:id`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 预约与复测规则

- 一只钟表同一时间只能有一位师傅调校：同一钟表存在**待复测且未失效**的预约时再次预约，返回 `409` 并保留原预约，本次请求不写入任何数据；不同钟表可同时预约。
- 预约状态为 `awaiting_retest`（待复测）/ `retested`（已复测）/ `expired`（满两小时未复测自动失效），创建时记录 `expiresAt = createdAt + 2h`。
- 复测只能对应**最近一次预约**：无预约、预约已复测、预约已失效（满两小时）均返回 `409`。成功时复测记录与预约状态在同一次原子写入中更新。
- 并发写请求在服务内串行化（全局异步锁），配合临时文件 `rename` 原子落盘：竞争请求只有一个成功，失败请求不产生半成品数据。
- 历史预约只增不删，随时可通过 history / appointments 接口查询。

## 闭环示例

```bash
# 预约调校（师傅送修进入调校）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/appointments \
  -H 'Content-Type: application/json' \
  -d '{"watchmaker":"陈师傅","note":"二进宫，继续调慢"}'

# 同一钟表重复预约 -> 409，原预约保留
# 不同钟表同时预约 -> 各自成功

# 两小时内复测（自动绑定最近一次预约）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'

# 查询历史预约
curl http://127.0.0.1:3021/clocks/clock_demo/history
```
