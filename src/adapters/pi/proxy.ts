import http from 'node:http';

const PROXY_PORT = 11451;
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

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
 * Injects targetModel into the request body.
 * Strips thinking params for Flash (non-reasoning model).
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Only accept /v1/chat/completions
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

      // Flash: strip thinking/reasoning params, force non-thinking mode
      if (model === 'deepseek-v4-flash') {
        delete body.reasoning_effort;
        body.thinking = { type: 'disabled' };
      }

      // Pro: apply thinking if set
      if (model === 'deepseek-v4-pro' && currentThinking) {
        body.reasoning_effort = currentThinking;
        body.thinking = { type: 'enabled' };
      }

      // Override model in the request
      body.model = model;

      const apiKey = getApiKey();
      if (!apiKey) {
        res.writeHead(500);
        res.end('DEEPSEEK_API_KEY not set');
        return;
      }

      const upstreamUrl = `${DEEPSEEK_BASE}/chat/completions`;
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      // Forward response headers
      const status = response.status;
      for (const [key, value] of response.headers) {
        if (key.toLowerCase() !== 'transfer-encoding') {
          res.setHeader(key, value);
        }
      }
      res.writeHead(status);

      // Pipe streaming response or forward body
      if (response.body) {
        const reader = response.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        pump().catch(err => {
          console.error('[ModelRouter Proxy] Stream error:', err);
          res.end();
        });
      } else {
        const text = await response.text();
        res.end(text);
      }
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
  // Allow process to exit even if proxy is listening
  server.unref();
}

export function stopProxy(): void {
  if (server) {
    server.close();
    server = null;
  }
}
