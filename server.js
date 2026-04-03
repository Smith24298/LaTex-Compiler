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
