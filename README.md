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
- `GET /clocks/:id/history`（含全部调校、复测、预约历史）
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/appointments` — 调校预约
- `GET /clocks/:id/appointments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /appointments?clockId=&status=pending|completed|expired`
- `GET /retests?clockId=&qualified=`

## 预约与复测规则

- 同一只表同一时间只能有一位师傅调校：存在**待复测（pending）**预约时再次预约返回 `409`，响应中携带原预约且不改动任何数据；不同钟表的预约互不阻塞。
- 预约即进入 **2 小时**复测窗口（`expiresAt`，可用环境变量 `APPOINTMENT_TTL_MS` 调整）。满 2 小时未复测，预约自动失效（expired），不能继续复测。
- 复测只能对应**最近一次预约**：无预约、最近预约已完成或已失效、指定了非最近预约，均返回 `409`。
- 复测成功后最近预约变为 **已复测（completed）**，复测记录与状态变更原子落盘，之后可重新预约。
- 并发安全：写操作在单进程内串行提交（读-校验-改-写事务），同表并发预约只有一次 `201`，其余 `409`；文件采用临时文件 + rename 原子写入，失败请求不会留下半成品。
- 历史预约（含已完成、已失效）始终保留，可通过 `GET /clocks/:id/history` 与 `GET /appointments` 查询。

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
# 预约调校（返回 expiresAt，两小时内有效）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/appointments \
  -H 'Content-Type: application/json' \
  -d '{"watchmaker":"王师傅","note":"快慢针微调"}'
# 两小时内复测
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
```
