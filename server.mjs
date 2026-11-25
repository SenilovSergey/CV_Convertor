import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/resume-ai.js", ["resume-ai.js", "text/javascript; charset=utf-8"]],
  ["/template.b64.txt", ["template.b64.txt", "text/plain; charset=utf-8"]],
  ["/lib/jszip.min.js", ["lib/jszip.min.js", "text/javascript; charset=utf-8"]],
  ["/lib/pdf.min.mjs", ["lib/pdf.min.mjs", "text/javascript; charset=utf-8"]],
  ["/lib/pdf.worker.min.mjs", ["lib/pdf.worker.min.mjs", "text/javascript; charset=utf-8"]],
]);

export function createApp() {
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const hosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!hosts.includes(req.headers.host)) {
      res.writeHead(403).end("Откройте адрес, который показан в окне конвертера.");
      return;
    }

    const file = files.get(req.url?.split("?")[0]);
    if (!file) {
      res.writeHead(404).end("Страница не найдена.");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end("Метод не поддерживается.");
      return;
    }

    try {
      const bytes = await readFile(new URL(file[0], import.meta.url));
      res.writeHead(200, { "Content-Type": file[1], "Content-Length": bytes.length });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      res.writeHead(500).end("Файл приложения недоступен. Распакуйте архив целиком.");
    }
  });
}

function openInWindows(url) {
  const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
  browser.on("error", () => console.log(`Open this address in your browser: ${url}`));
  browser.unref();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let port = Number(process.env.PORT || 8789);
  const server = createApp();
  server.on("error", error => {
    if (error.code === "EADDRINUSE" && port) {
      port = 0;
      server.listen(port, "127.0.0.1");
      return;
    }
    console.error(error.message);
    process.exitCode = 1;
  });
  server.once("listening", () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`CV Convertor: ${url}`);
    console.log("Keep this window open while using the app.");
    if (process.argv.includes("--open") && process.platform === "win32") openInWindows(url);
  });
  server.listen(port, "127.0.0.1");
}
