const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

test("serves h2c POST requests as HTTP/1.1", async () => {
  const originalCreateServer = http.createServer;
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");

  const server = http.createServer(async (req, res) => {
    assert.equal(globalThis[Symbol.for("9router.studio.transport")].snapshot().activeCount, 1);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.upgrade, undefined);
    assert.equal(req.headers["http2-settings"], undefined);
    assert.equal(req.headers.connection, "close");
    const body = [];
    for await (const chunk of req) body.push(chunk);
    assert.equal(Buffer.concat(body).toString("utf8"), '{"model":"test","stream":true}');
    res.setHeader("Content-Type", "text/event-stream");
    res.end("data: [DONE]\n\n");
  });
  server.on("upgrade", (_req, socket) => socket.destroy());

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;

    const response = await new Promise((resolve, reject) => {
      const chunks = [];
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        const body = '{"model":"test","stream":true}';
        socket.write([
          "POST /v1/chat/completions HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade, HTTP2-Settings",
          "Upgrade: h2c",
          "HTTP2-Settings: AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Content-Type: application/json",
          "",
          "",
        ].join("\r\n"));
        setImmediate(() => socket.write(body));
      });
      socket.setTimeout(2_000, () => {
        socket.destroy();
        reject(new Error("h2c fallback response timed out"));
      });
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.on("error", reject);
    });

    assert.match(response, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(response, /\r\nContent-Type: text\/event-stream\r\n/i);
    assert.match(response, /\r\nConnection: close\r\n/i);
    assert.match(response, /\r\n\r\ndata: \[DONE\]\n\n$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    http.createServer = originalCreateServer;
  }
});

test("tracks h2c uploads until disconnect even before the request body arrives", async () => {
  const originalCreateServer = http.createServer;
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");
  const tracker = globalThis[Symbol.for("9router.studio.transport")];
  const server = http.createServer(req => req.resume());
  let socket;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    socket = net.createConnection({ host: "127.0.0.1", port: server.address().port });
    await new Promise(resolve => socket.once("connect", resolve));
    socket.write("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: h2c\r\nContent-Length: 100\r\n\r\n");
    for (let i = 0; i < 100 && tracker.snapshot().activeCount === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(tracker.snapshot().activeCount, 1);
    socket.destroy();
    for (let i = 0; i < 100 && tracker.snapshot().activeCount !== 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(tracker.snapshot().activeCount, 0);
  } finally {
    socket?.destroy();
    await new Promise(resolve => server.close(resolve));
    http.createServer = originalCreateServer;
  }
});
