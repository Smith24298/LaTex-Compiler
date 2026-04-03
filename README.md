## Self-Hosted LaTeX Compilation Service for Reliable PDF Generation

This implementation is a fully self-contained LaTeX compilation microservice in one custom Docker image. It does not call any external LaTeX API at runtime.

## 1. Architecture Goal

Single-container architecture:

```text
[Custom Docker Image]
|-- TeX Live (installed at build time)
|-- Node.js API server (server.js)
`-- Isolated temp workspace per request
```

Request flow:

```text
Client -> POST /compile -> API writes .tex -> API runs pdflatex -> API returns PDF binary
```

## 2. Custom Dockerfile

Complete Dockerfile:

```dockerfile
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dumb-init \
        nodejs \
        npm \
        texlive-latex-base \
        texlive-latex-recommended \
        texlive-latex-extra \
        texlive-fonts-recommended \
        texlive-plain-generic \
        texlive-pictures \
        texlive-science \
        lmodern \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

RUN groupadd --gid 10001 appgroup \
    && useradd --uid 10001 --gid appgroup --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appgroup /app

USER appuser

ENV PORT=3000 \
    MAX_LATEX_CHARS=200000 \
    COMPILE_TIMEOUT_MS=15000 \
    RATE_LIMIT_WINDOW_MS=60000 \
    RATE_LIMIT_MAX_REQUESTS=30

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
```

Notes:

- Base image is generic Debian (not a LaTeX API image).
- TeX Live is installed at build time via apt-get.
- API runs as non-root user `appuser`.

## 3. API Server Code

Complete API server (`server.js`):

```javascript
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_LATEX_CHARS = Number(process.env.MAX_LATEX_CHARS || 200000);
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 15000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX_REQUESTS = Number(
  process.env.RATE_LIMIT_MAX_REQUESTS || 30,
);

app.use(express.json({ limit: "512kb" }));

const rateLimiterStore = new Map();

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = rateLimiterStore.get(ip);

  if (!bucket || now >= bucket.expiresAt) {
    rateLimiterStore.set(ip, {
      count: 1,
      expiresAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return next();
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.ceil((bucket.expiresAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    return res.status(429).json({
      error: "Rate limit exceeded",
      retryAfterSeconds: retryAfterSec,
    });
  }

  bucket.count += 1;
  return next();
}

function compileLatex(texFilePath, workDir) {
  return new Promise((resolve, reject) => {
    const args = [
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      "-output-directory",
      workDir,
      texFilePath,
    ];

    const child = spawn("pdflatex", args, {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject({
        status: 408,
        error: "Compilation timed out",
        logs: `${stdout}\n${stderr}`.trim(),
      });
    }, COMPILE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject({
        status: 500,
        error: "Failed to start pdflatex process",
        logs: err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject({
          status: 422,
          error: "LaTeX compilation failed",
          logs: `${stdout}\n${stderr}`.trim(),
        });
      }
    });
  });
}

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "latex-compiler-api",
    engine: "pdflatex",
  });
});

app.post("/compile", rateLimit, async (req, res) => {
  const latex = req.body?.latex;

  if (typeof latex !== "string" || latex.trim().length === 0) {
    return res.status(400).json({
      error: 'Invalid payload. Expected JSON: { "latex": "<source>" }',
    });
  }

  if (latex.length > MAX_LATEX_CHARS) {
    return res.status(413).json({
      error: `Input too large. Max allowed is ${MAX_LATEX_CHARS} characters`,
    });
  }

  const requestId = crypto.randomUUID();
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `latex-${requestId}-`),
  );
  const texPath = path.join(workDir, "document.tex");
  const pdfPath = path.join(workDir, "document.pdf");

  try {
    await fs.writeFile(texPath, latex, "utf8");
    await compileLatex(texPath, workDir);

    const pdfBuffer = await fs.readFile(pdfPath);

    return res
      .status(200)
      .setHeader("Content-Type", "application/pdf")
      .setHeader("Content-Disposition", 'inline; filename="output.pdf"')
      .setHeader("X-Request-Id", requestId)
      .send(pdfBuffer);
  } catch (err) {
    const status = Number(err?.status) || 500;
    const error = err?.error || "Internal server error";
    const logs = typeof err?.logs === "string" ? err.logs : "No logs available";

    return res.status(status).json({
      error,
      requestId,
      logs,
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }

  return res.status(500).json({
    error: "Unexpected error",
    details: err?.message || "Unknown error",
  });
});

app.listen(PORT, () => {
  console.log(`LaTeX Compiler API listening on port ${PORT}`);
});
```

## 4. Build and Run Instructions

Build image:

```bash
docker build -t my-latex-api .
```

Run container:

```bash
docker run -d -p 3000:3000 --name latex-service my-latex-api
```

Health check:

```bash
curl http://localhost:3000/health
```

After build, runtime has no external API dependency. The service runs from your local image.

## 5. Test the API

Minimal compile test:

```bash
curl -X POST http://localhost:3000/compile \
  -H "Content-Type: application/json" \
  -d '{"latex":"\\documentclass{article}\\begin{document}Hello from self-hosted LaTeX!\\end{document}"}' \
  --output output.pdf
```

## 6. Security and Production Hardening

Implemented controls:

- Input size limits: JSON body limit (`512kb`) and max LaTeX chars (`MAX_LATEX_CHARS`).
- Compilation timeout: kills `pdflatex` after `COMPILE_TIMEOUT_MS`.
- Temp directory isolation: unique `mkdtemp` directory per request.
- Rate limiting: fixed-window in-memory limiter by client IP.
- Non-root runtime: container process runs as user `appuser`.

Recommended additions for high traffic:

- Place behind an API gateway/reverse proxy with global rate limits.
- Add request queueing for compile burst smoothing.
- Add structured logs and metrics (success/fail/timeout counters).

## 7. Optional Docker Compose Setup

Example compose file (LaTeX service internal only, not public):

```yaml
version: "3.9"

services:
  frontend:
    build:
      context: ../frontend
    depends_on:
      - backend
    ports:
      - "5173:5173"
    networks:
      - app-net

  backend:
    build:
      context: ../backend
    environment:
      - LATEX_API_URL=http://latex-api:3000/compile
    depends_on:
      - latex-api
    ports:
      - "4000:4000"
    networks:
      - app-net

  latex-api:
    build:
      context: .
    environment:
      - PORT=3000
      - COMPILE_TIMEOUT_MS=15000
      - MAX_LATEX_CHARS=200000
      - RATE_LIMIT_WINDOW_MS=60000
      - RATE_LIMIT_MAX_REQUESTS=30
    expose:
      - "3000"
    networks:
      - app-net

networks:
  app-net:
    driver: bridge
```

`latex-api` uses `expose` only, so it is reachable internally by backend but not mapped to host ports.
