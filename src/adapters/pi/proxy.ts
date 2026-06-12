import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';

const PROXY_PORT = 11451;

// Shared mutable state — Router writes, proxy reads
export let targetModel: string = 'deepseek-v4-flash';
let currentThinking: string | undefined;

export function setTargetModel(model: string, thinking?: string): void {
  targetModel = model;
  currentThinking = thinking;
}

function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY || '';
}

let server: http.Server | null = null;

/**
 * Proxy an OpenAI-compatible streaming request to DeepSeek.
 * Uses node:https directly (not fetch) to avoid undici's strict header validation.
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/v1/chat/completions') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const model = targetModel;

      // Flash: strip thinking params
      if (model === 'deepseek-v4-flash') {
        delete body.reasoning_effort;
        body.thinking = { type: 'disabled' };
      }

      // Pro: apply thinking if set
      if (model === 'deepseek-v4-pro' && currentThinking) {
        body.reasoning_effort = currentThinking;
        body.thinking = { type: 'enabled' };
      }

      // Override model
      body.model = model;

      const apiKey = getApiKey();
      if (!apiKey || apiKey.trim() === '') {
        console.error('[ModelRouter] DEEPSEEK_API_KEY 环境变量为空！');
        console.error('请在启动 Pi 前设置: export DEEPSEEK_API_KEY="sk-478264fc0ad44f8eab4f2521584d64ea"');
        console.error('或添加到 ~/.zshrc: echo \'export DEEPSEEK_API_KEY="sk-478264fc0ad44f8eab4f2521584d64ea"\' >> ~/.zshrc');
        res.writeHead(500);
        res.end('DEEPSEEK_API_KEY not set');
        return;
      }

      const postData = JSON.stringify(body);

      // Use node:https instead of fetch to avoid undici header validation issues
      const upstreamReq = https.request(
        'https://api.deepseek.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(postData).toString(),
          },
        },
        (upstreamRes) => {
          // Forward status and headers
          const statusCode = upstreamRes.statusCode || 500;
          const statusMsg = upstreamRes.statusMessage || '';
          // Only forward safe headers (skip transfer-encoding, connection, etc.)
          const safeHeaders: Record<string, string | string[]> = {};
          for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
            const key = upstreamRes.rawHeaders[i].toLowerCase();
            const val = upstreamRes.rawHeaders[i + 1];
            if (['transfer-encoding', 'connection', 'keep-alive', 'content-length'].includes(key)) continue;
            if (safeHeaders[key]) {
              if (Array.isArray(safeHeaders[key])) {
                (safeHeaders[key] as string[]).push(val);
              } else {
                safeHeaders[key] = [safeHeaders[key] as string, val];
              }
            } else {
              safeHeaders[key] = val;
            }
          }
          res.writeHead(statusCode, statusMsg, safeHeaders);

          // Pipe upstream response to client
          upstreamRes.pipe(res);
        },
      );

      upstreamReq.on('error', (err) => {
        console.error('[ModelRouter Proxy] Request error:', err);
        if (!res.headersSent) {
          res.writeHead(502);
        }
        res.end(JSON.stringify({ error: err.message }));
      });

      upstreamReq.write(postData);
      upstreamReq.end();
    } catch (err) {
      console.error('[ModelRouter Proxy] Error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}

export function startProxy(): void {
  if (server) return;
  server = http.createServer(handleRequest);
  server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[ModelRouter] Proxy listening on 127.0.0.1:${PROXY_PORT}`);
  });
  server.unref();
}

export function stopProxy(): void {
  if (server) {
    server.close();
    server = null;
  }
}
