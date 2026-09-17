const http = require("http");
const { readFile, writeFile, mkdir, rename, rm } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");

// 预约满两小时未复测即自动失效
const APPOINTMENT_TTL_MS = 2 * 60 * 60 * 1000;

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      appointmentId: "appointment_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  appointments: [
    {
      id: "appointment_demo",
      clockId: "clock_demo",
      watchmaker: "陈师傅",
      note: "初次送修",
      status: "retested",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + APPOINTMENT_TTL_MS).toISOString(),
      retestedAt: new Date().toISOString(),
      retestId: "retest_demo"
    }
  ]
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/appointments",
  "GET /clocks/:id/appointments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /appointments",
  "GET /appointments/:id",
  "GET /adjustments",
  "GET /retests"
];

// 单进程内串行化所有“读-判断-写”流程，保证并发请求只有一个能成功落盘
let writeChain = Promise.resolve();
function withLock(task) {
  const result = writeChain.then(task, task);
  writeChain = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  // 兼容旧数据文件：补齐预约集合，缺失的集合一律补空数组
  for (const key of ["clocks", "adjustments", "retests", "appointments"]) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}

async function writeDb(data) {
  // 临时文件 + 同目录 rename，保证要么完整写入新内容，要么保留旧文件，不留半成品
  const tmp = `${DB_FILE}.${process.pid}.${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  try {
    await rename(tmp, DB_FILE);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function parseDate(value, field) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    const error = new Error(`${field}必须是合法时间`);
    error.status = 400;
    throw error;
  }
  return new Date(time);
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function latestAppointment(db, clockId) {
  return db.appointments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

// 预约状态：awaiting_retest（待复测）/ retested（已复测）/ expired（满两小时未复测自动失效）
function effectiveAppointmentStatus(appointment, now = Date.now()) {
  if (
    appointment.status === "awaiting_retest" &&
    new Date(appointment.expiresAt).getTime() <= now
  ) {
    return "expired";
  }
  return appointment.status;
}

function appointmentView(appointment, now = Date.now()) {
  if (!appointment) return null;
  return { ...appointment, status: effectiveAppointmentStatus(appointment, now) };
}

function activeAppointment(db, clockId, now = Date.now()) {
  return (
    db.appointments
      .filter(
        (item) =>
          item.clockId === clockId && effectiveAppointmentStatus(item, now) === "awaiting_retest"
      )
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null
  );
}

// 把已到两小时仍未复测的预约惰性标记为失效（仅在持锁写入流程内调用）
function sweepExpiredAppointments(db, now = Date.now()) {
  for (const appointment of db.appointments) {
    if (
      appointment.status === "awaiting_retest" &&
      new Date(appointment.expiresAt).getTime() <= now
    ) {
      appointment.status = "expired";
    }
  }
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    activeAppointment: appointmentView(activeAppointment(db, clock.id)),
    qualified: retest ? retest.qualified : false
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    return withLock(async () => {
      const lockedDb = await readDb();
      const clock = {
        id: makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      lockedDb.clocks.push(clock);
      await writeDb(lockedDb);
      return send(res, 201, { data: clockSummary(lockedDb, clock) });
    });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    const appointments = db.appointments
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((item) => appointmentView(item));
    return send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        appointments,
        latestRetest: latestRetest(db, clock.id)
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    return withLock(async () => {
      const lockedDb = await readDb();
      const clock = findClock(lockedDb, adjustmentMatch[1]);
      const adjustment = {
        id: makeId("adjustment"),
        clockId: clock.id,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      lockedDb.adjustments.push(adjustment);
      await writeDb(lockedDb);
      return send(res, 201, { data: adjustment });
    });
  }

  const appointmentMatch = pathname.match(/^\/clocks\/([^/]+)\/appointments$/);
  if (appointmentMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["watchmaker"]);
    const createdAt =
      body.createdAt === undefined ? new Date() : parseDate(body.createdAt, "createdAt");
    return withLock(async () => {
      const lockedDb = await readDb();
      const clock = findClock(lockedDb, appointmentMatch[1]);
      sweepExpiredAppointments(lockedDb);

      // 同一钟表已有待复测预约：返回 409 并保留原预约，本次请求不写入任何内容
      const existing = activeAppointment(lockedDb, clock.id);
      if (existing) {
        return send(res, 409, {
          error: "该钟表已有待复测预约，同一钟表不能同时被两位师傅调校",
          data: appointmentView(existing)
        });
      }

      const appointment = {
        id: makeId("appointment"),
        clockId: clock.id,
        watchmaker: String(body.watchmaker),
        note: body.note || "",
        status: "awaiting_retest",
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + APPOINTMENT_TTL_MS).toISOString(),
        retestedAt: null,
        retestId: null
      };
      lockedDb.appointments.push(appointment);
      await writeDb(lockedDb);
      return send(res, 201, { data: appointmentView(appointment), clock: clockSummary(lockedDb, clock) });
    });
  }

  if (appointmentMatch && req.method === "GET") {
    const clock = findClock(db, appointmentMatch[1]);
    const data = db.appointments
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((item) => appointmentView(item));
    return send(res, 200, { data });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    return withLock(async () => {
      const lockedDb = await readDb();
      const clock = findClock(lockedDb, retestMatch[1]);
      sweepExpiredAppointments(lockedDb);

      // 复测只能对应最近一次预约，且预约必须仍有效
      const appointment = latestAppointment(lockedDb, clock.id);
      if (!appointment) {
        const error = new Error("该钟表暂无调校预约，不能复测");
        error.status = 409;
        throw error;
      }
      if (body.appointmentId && body.appointmentId !== appointment.id) {
        const error = new Error("复测只能对应最近一次预约");
        error.status = 409;
        throw error;
      }
      if (appointment.status === "retested") {
        const error = new Error("最近一次预约已完成复测，不能重复复测");
        error.status = 409;
        throw error;
      }
      if (effectiveAppointmentStatus(appointment) === "expired") {
        const error = new Error("预约已满两小时未复测，已自动失效，不能继续复测");
        error.status = 409;
        throw error;
      }

      const testedAt =
        body.testedAt === undefined
          ? new Date().toISOString()
          : parseDate(body.testedAt, "testedAt").toISOString();
      const adjustmentId = body.adjustmentId || latestAdjustment(lockedDb, clock.id)?.id || null;
      const qualified =
        body.qualified !== undefined
          ? Boolean(body.qualified)
          : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: makeId("retest"),
        clockId: clock.id,
        appointmentId: appointment.id,
        adjustmentId,
        testedAt,
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };

      // 复测记录与预约状态在同一次写入中落盘，失败则整体不生效
      lockedDb.retests.push(retest);
      appointment.status = "retested";
      appointment.retestedAt = testedAt;
      appointment.retestId = retest.id;
      await writeDb(lockedDb);
      return send(res, 201, {
        data: retest,
        appointment: appointmentView(appointment),
        clock: clockSummary(lockedDb, clock)
      });
    });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/appointments") {
    const clockId = url.searchParams.get("clockId");
    const status = url.searchParams.get("status");
    let data = db.appointments
      .map((item) => appointmentView(item))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (clockId) data = data.filter((item) => item.clockId === clockId);
    if (status) data = data.filter((item) => item.status === status);
    return send(res, 200, { data });
  }

  const appointmentItemMatch = pathname.match(/^\/appointments\/([^/]+)$/);
  if (appointmentItemMatch && req.method === "GET") {
    const appointment = db.appointments.find((item) => item.id === appointmentItemMatch[1]);
    if (!appointment) {
      const error = new Error("预约不存在");
      error.status = 404;
      throw error;
    }
    return send(res, 200, { data: appointmentView(appointment) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
