import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const temporaryDir = join(root, '.animation-output');
const jobs = new Map();
const port = Number(globalThis.process?.env?.PORT || 3000);
await mkdir(temporaryDir, { recursive: true });

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (body.length > 100_000) reject(new Error('Request is too large.')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}

function cleanup(job) {
  jobs.delete(job.id);
  return rm(job.outputPath, { force: true }).catch(() => {});
}

function cancel(job) {
  if (job.cancelled) return;
  job.cancelled = true;
  job.ffmpeg.stdin.destroy();
  job.ffmpeg.kill('SIGTERM');
  cleanup(job);
}

function createJob({ fps, width, height }) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 60 || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new Error('Invalid animation dimensions or frame rate.');
  }
  const id = randomUUID();
  const outputPath = join(temporaryDir, `${id}.mp4`);
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    // H.264's yuv420p format requires even dimensions. Padding preserves the
    // drawing unchanged and only adds a one-pixel edge when needed.
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  const job = { id, ffmpeg, outputPath, expectedFrame: 0, cancelled: false, complete: false, error: '' };
  ffmpeg.stderr.on('data', chunk => { job.error += chunk; });
  ffmpeg.on('error', error => { job.error = error.message; });
  // FFmpeg may close its input after a decoding error. Consume the resulting
  // EPIPE so a failed export reports an API error instead of taking down Node.
  ffmpeg.stdin.on('error', error => { job.error ||= error.message; });
  jobs.set(id, job);
  return job;
}

function writeFrame(req, job) {
  return new Promise((resolve, reject) => {
    const fail = error => reject(new Error(job.error || error.message || 'FFmpeg stopped accepting frames.'));
    req.on('error', reject);
    job.ffmpeg.stdin.once('error', fail);
    req.on('data', chunk => {
      if (job.cancelled) return;
      if (job.ffmpeg.exitCode !== null || job.ffmpeg.stdin.destroyed) {
        req.pause();
        return fail(new Error('FFmpeg stopped accepting frames.'));
      }
      if (!job.ffmpeg.stdin.write(chunk)) {
        req.pause();
        job.ffmpeg.stdin.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      job.ffmpeg.stdin.removeListener('error', fail);
      resolve();
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/animation-exports') {
      const job = createJob(await readJson(req));
      return sendJson(res, 201, { id: job.id });
    }

    const frameMatch = url.pathname.match(/^\/api\/animation-exports\/([\w-]+)\/frames\/(\d+)$/);
    if (req.method === 'PUT' && frameMatch) {
      const job = jobs.get(frameMatch[1]);
      const index = Number(frameMatch[2]);
      if (!job || job.cancelled) return sendJson(res, 404, { error: 'Animation export not found.' });
      if (index !== job.expectedFrame) return sendJson(res, 409, { error: 'Frames must arrive in order.' });
      try {
        await writeFrame(req, job);
      } catch (error) {
        cancel(job);
        throw error;
      }
      job.expectedFrame++;
      return sendJson(res, 200, { received: index });
    }

    const finishMatch = url.pathname.match(/^\/api\/animation-exports\/([\w-]+)\/finish$/);
    if (req.method === 'POST' && finishMatch) {
      const job = jobs.get(finishMatch[1]);
      if (!job || job.cancelled) return sendJson(res, 404, { error: 'Animation export not found.' });
      const code = await new Promise(resolve => { job.ffmpeg.once('close', resolve); job.ffmpeg.stdin.end(); });
      if (code !== 0 || !existsSync(job.outputPath)) {
        const error = job.error.trim() || 'FFmpeg could not create the video.';
        await cleanup(job);
        return sendJson(res, 500, { error });
      }
      job.complete = true;
      return sendJson(res, 200, { downloadUrl: `/api/animation-exports/${job.id}/download` });
    }

    const cancelMatch = url.pathname.match(/^\/api\/animation-exports\/([\w-]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (job) cancel(job);
      return sendJson(res, 200, { cancelled: true });
    }

    const downloadMatch = url.pathname.match(/^\/api\/animation-exports\/([\w-]+)\/download$/);
    if (req.method === 'GET' && downloadMatch) {
      const job = jobs.get(downloadMatch[1]);
      if (!job?.complete || !existsSync(job.outputPath)) return sendJson(res, 404, { error: 'Video is no longer available.' });
      const size = (await stat(job.outputPath)).size;
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="image-field-lines.mp4"', 'Content-Length': String(size) });
      const stream = createReadStream(job.outputPath);
      stream.pipe(res);
      res.on('finish', () => cleanup(job));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
    const pathname = normalize(url.pathname === '/' ? '/drawing.html' : url.pathname).replace(/^\/+/, '');
    const filePath = join(root, pathname);
    if (!filePath.startsWith(root) || !existsSync(filePath)) return sendJson(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath).pipe(res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Server error.' });
  }
});

server.listen(port, () => console.log(`Image Field Lines is running at http://localhost:${port}`));
