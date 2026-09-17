const http = require("http");
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");
// 预约后两小时内必须复测，否则自动失效
const APPOINTMENT_TTL_MS = Number(process.env.APPOINTMENT_TTL_MS) || 2 * 60 * 60 * 1000;

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
      adjustmentId: "adjustment_demo",
      appointmentId: null,
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  appointments: []
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
  "GET /adjustments?clockId=",
  "GET /appointments?clockId=",
  "GET /retests?clockId=&qualified="
];

let initPromise = null;
async function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await mkdir(path.dirname(DB_FILE), { recursive: true });
      try {
        JSON.parse(await readFile(DB_FILE, "utf8"));
      } catch {
        await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
      }
    })();
  }
  return initPromise;
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  // 兼容旧数据文件
  db.clocks ||= [];
  db.adjustments ||= [];
  db.retests ||= [];
  db.appointments ||= [];
  return db;
}

// 同目录临时文件 + rename，保证落盘要么是旧文件要么是新文件，不会出现半成品
async function writeDb(data) {
  const tmp = `${DB_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, DB_FILE);
}

// 所有“读-校验-改-写”事务在单进程内串行提交：
// 同一只表的并发预约第二个一定能看到第一个已提交的预约并得到 409；
// 不同钟表的事务只是排队提交，互不冲突、都能成功。
let txChain = Promise.resolve();
function withTransaction(fn) {
  const result = txChain.then(fn, fn);
  txChain = result.then(
    () => {},
    () => {}
  );
  return result;
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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseTime(value, field) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw httpError(400, `${field}必须是合法时间`);
  return t;
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

// 待复测预约满两小时未复测即自动失效（惰性判定，不改数据也能体现失效）
function effectiveStatus(appointment, now = Date.now()) {
  if (appointment.status === "pending" && new Date(appointment.expiresAt).getTime() <= now) {
    return "expired";
  }
  return appointment.status;
}

const STATUS_TEXT = {
  pending: "待复测",
  completed: "已复测",
  expired: "已失效"
};

function presentAppointment(appointment, now = Date.now()) {
  if (!appointment) return null;
  const status = effectiveStatus(appointment, now);
  return { ...appointment, status, statusText: STATUS_TEXT[status] || status };
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    latestAppointment: presentAppointment(latestAppointment(db, clock.id)),
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
    const clock = await withTransaction(async () => {
      const live = await readDb();
      const record = {
        id: makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      live.clocks.push(record);
      await writeDb(live);
      return record;
    });
    const fresh = await readDb();
    return send(res, 201, { data: clockSummary(fresh, clock) });
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
      .map((item) => presentAppointment(item));
    return send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        appointments,
        latestRetest: latestRetest(db, clock.id),
        latestAppointment: presentAppointment(latestAppointment(db, clock.id))
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clockId = adjustmentMatch[1];
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = await withTransaction(async () => {
      const live = await readDb();
      findClock(live, clockId);
      const record = {
        id: makeId("adjustment"),
        clockId,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      live.adjustments.push(record);
      await writeDb(live);
      return record;
    });
    return send(res, 201, { data: adjustment });
  }

  const appointmentMatch = pathname.match(/^\/clocks\/([^/]+)\/appointments$/);
  if (appointmentMatch && req.method === "POST") {
    const clockId = appointmentMatch[1];
    const body = await parseBody(req);
    const now = Date.now();
    const createdAt = body.createdAt === undefined ? now : parseTime(body.createdAt, "createdAt");

    const outcome = await withTransaction(async () => {
      const live = await readDb();
      findClock(live, clockId);

      // 同一只表已有待复测预约（未失效）：拒绝并保留原预约，失败路径不做任何写入
      const active = live.appointments.find(
        (item) => item.clockId === clockId && effectiveStatus(item, now) === "pending"
      );
      if (active) {
        return { conflict: true, appointment: presentAppointment(active, now) };
      }

      // 顺带把已到期的待复测预约落为“已失效”，与新预约一次性原子提交
      for (const item of live.appointments) {
        if (item.clockId === clockId && effectiveStatus(item, now) === "expired") {
          item.status = "expired";
        }
      }

      const appointment = {
        id: makeId("appointment"),
        clockId,
        watchmaker: body.watchmaker || "",
        note: body.note || "",
        status: "pending",
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + APPOINTMENT_TTL_MS).toISOString(),
        retestId: null
      };
      live.appointments.push(appointment);
      await writeDb(live);
      return { conflict: false, appointment: presentAppointment(appointment, now) };
    });

    if (outcome.conflict) {
      return send(res, 409, {
        error: "该钟表已有待复测的调校预约，请在两小时内完成复测后再预约",
        data: outcome.appointment
      });
    }
    return send(res, 201, { data: outcome.appointment });
  }

  if (appointmentMatch && req.method === "GET") {
    const clock = findClock(db, appointmentMatch[1]);
    const data = db.appointments
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((item) => presentAppointment(item));
    return send(res, 200, { data });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clockId = retestMatch[1];
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const now = Date.now();
    const testedAt = body.testedAt === undefined ? now : parseTime(body.testedAt, "testedAt");

    const result = await withTransaction(async () => {
      const live = await readDb();
      const clock = findClock(live, clockId);

      // 复测只能对应最近一次预约
      const appointment = latestAppointment(live, clockId);
      if (!appointment) {
        throw httpError(409, "该钟表尚无调校预约，无法复测");
      }
      const status = effectiveStatus(appointment, now);
      if (status === "expired") {
        throw httpError(409, "最近一次调校预约已满两小时未复测，已自动失效，不能继续复测");
      }
      if (status === "completed") {
        throw httpError(409, "最近一次调校预约已完成复测，如需再次调校请重新预约");
      }
      if (body.appointmentId && body.appointmentId !== appointment.id) {
        throw httpError(409, "复测只能对应最近一次预约");
      }
      if (testedAt < new Date(appointment.createdAt).getTime()) {
        throw httpError(400, "复测时间不能早于预约时间");
      }
      if (testedAt > new Date(appointment.expiresAt).getTime()) {
        throw httpError(400, "复测时间已超出预约的两小时有效期");
      }

      const adjustmentId = body.adjustmentId || latestAdjustment(live, clockId)?.id || null;
      const qualified = body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);

      const retest = {
        id: makeId("retest"),
        clockId,
        adjustmentId,
        appointmentId: appointment.id,
        testedAt: new Date(testedAt).toISOString(),
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };

      // 复测记录与预约完成状态一次性原子提交，失败不会留下半成品
      live.retests.push(retest);
      appointment.status = "completed";
      appointment.retestId = retest.id;
      await writeDb(live);
      return { retest, clockId };
    });

    const fresh = await readDb();
    const clock = findClock(fresh, result.clockId);
    return send(res, 201, { data: result.retest, clock: clockSummary(fresh, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/appointments") {
    const clockId = url.searchParams.get("clockId");
    const status = url.searchParams.get("status");
    const data = db.appointments
      .filter((item) => !clockId || item.clockId === clockId)
      .map((item) => presentAppointment(item))
      .filter((item) => !status || item.status === status)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return send(res, 200, { data });
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
