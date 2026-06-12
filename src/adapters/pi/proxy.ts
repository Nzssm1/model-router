import http from 'node:http';
import https from 'node:https';

const PROXY_PORT = 11451;

// Shared mutable state — Router writes, proxy reads
export let targetModel: string = 'deepseek-v4-flash';
let currentThinking: string | undefined;
let requestCount = 0;

export function setTargetModel(model: string, thinking?: string): void {
  const old = targetModel;
  targetModel = model;
  currentThinking = thinking;
  if (old !== model) {
    console.log(`[ModelRouter] 🎯 targetModel: ${old} → ${model}${thinking ? ` (thinking:${thinking})` : ''}`);
  }
}

function getApiKey(): string {
  const key = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (key && key.length !== 35) {
    console.warn(`[ModelRouter] ⚠️ DEEPSEEK_API_KEY length=${key.length} (expected 35), may be malformed`);
  }
  return key;
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

  const reqId = ++requestCount;
  console.log(`[ModelRouter] ← request #${reqId} received, targetModel=${targetModel}`);

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const model = targetModel;

      console.log(`[ModelRouter] → request #${reqId} routing to: ${model}`);

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

      // Override model in request body
      body.model = model;

      const apiKey = getApiKey();
      if (!apiKey) {
        console.error('[ModelRouter] ❌ DEEPSEEK_API_KEY not set');
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' }));
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
          console.log(`[ModelRouter] ← upstream response for #${reqId}: ${upstreamRes.statusCode}, model-in-response: ${model}`);

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
        console.error(`[ModelRouter] ❌ upstream error for #${reqId}:`, err.message);
        if (!res.headersSent) {
          res.writeHead(502);
        }
        res.end(JSON.stringify({ error: err.message }));
      });

      upstreamReq.write(postData);
      upstreamReq.end();
    } catch (err) {
      console.error('[ModelRouter] ❌ proxy error:', err);
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
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[ModelRouter] ❌ Port ${PROXY_PORT} in use — kill old process: lsof -ti :${PROXY_PORT} | xargs kill`);
    } else {
      console.error('[ModelRouter] ❌ Proxy server error:', err.message);
    }
  });
  server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[ModelRouter] 🟢 Proxy listening on 127.0.0.1:${PROXY_PORT}`);
  });
  server.unref();
}

export function stopProxy(): void {
  if (server) {
    console.log('[ModelRouter] 🔴 Proxy shutting down');
    server.close();
    server = null;
  }
}
