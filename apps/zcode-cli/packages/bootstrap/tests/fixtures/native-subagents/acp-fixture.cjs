// 受控 ACP 进程：按 FIXTURE_FRAMES 中的真实形状帧回放原生子智能体流程。
// 步骤：{ update, sessionId? } 发送 session/update；{ permission } 发送请求并等待应答；
// { waitCancel } 等待客户端对该子会话的 session/cancel。所有收到的客户端消息写入 FIXTURE_LOG。
const fs = require("node:fs");
const readline = require("node:readline");
const frames = JSON.parse(fs.readFileSync(process.env.FIXTURE_FRAMES, "utf8"));
const main = frames.mainSessionId;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const log = (value) => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(value) + "\n");
const waiters = new Map();
let nextId = 9000;

function wait(key) {
  return new Promise((resolve) => waiters.set(key, resolve));
}
async function play(steps) {
  for (const step of steps) {
    if (step.update)
      send({ method: "session/update", params: { sessionId: step.sessionId ?? main, update: step.update } });
    else if (step.permission) {
      const id = nextId++;
      const answered = wait(`response:${id}`);
      send({ id, method: "session/request_permission", params: step.permission });
      await answered;
    } else if (step.waitCancel) await wait(`cancel:${step.waitCancel}`);
  }
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === undefined && message.id !== undefined) {
    waiters.get(`response:${message.id}`)?.(message);
    return;
  }
  if (message.method === "initialize")
    send({
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: main } });
  else if (message.method === "session/load") {
    await play(frames.load ?? []);
    send({ id: message.id, result: {} });
  } else if (message.method === "session/cancel") waiters.get(`cancel:${message.params.sessionId}`)?.();
  else if (message.method === "session/prompt") {
    await play(frames.prompt ?? []);
    send({ id: message.id, result: { stopReason: "end_turn" } });
  }
});
