import { env, pipeline } from '@huggingface/transformers';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const MODEL_NAME = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const MODEL_CACHE_DIR = join(process.env.HOME || '~', '.model-router', 'models');

export interface SemanticEngine {
  ready: boolean;
  loadModel(modelPath?: string): Promise<void>;
  encode(text: string): Promise<Float32Array>;
  similarity(a: Float32Array, b: Float32Array): number;
  dispose(): void;
}

export class DefaultSemanticEngine implements SemanticEngine {
  private pipe: any = null;
  ready = false;

  async loadModel(modelPath?: string): Promise<void> {
    // Ensure cache directory exists
    if (!existsSync(MODEL_CACHE_DIR)) {
      mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    }

    // v3 API: env.cacheDir (not env.localModelPath)
    env.cacheDir = modelPath || MODEL_CACHE_DIR;
    env.allowRemoteModels = true;

    // Load the feature extraction pipeline (quantized ONNX)
    // @ts-expect-error - quantized/dtype options exist at runtime but not in v3 types
    this.pipe = await pipeline('feature-extraction', MODEL_NAME, { quantized: true, dtype: 'fp32' });
    this.ready = true;
  }

  async encode(text: string): Promise<Float32Array> {
    if (!this.ready || !this.pipe) {
      throw new Error('SemanticEngine not loaded');
    }
    const output = await this.pipe(text, { pooling: 'mean', normalize: true });
    return output.data as Float32Array;
  }

  similarity(a: Float32Array, b: Float32Array): number {
    // Cosine similarity (vectors are L2-normalized by the model)
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return Math.max(-1, Math.min(1, dot));
  }

  dispose(): void {
    this.pipe = null;
    this.ready = false;
  }
}

// ─── Singleton + lazy init (race-condition safe) ───

let engine: SemanticEngine | null = null;
let loadPromise: Promise<void> | null = null;

export function getEngine(): SemanticEngine {
  if (!engine) {
    engine = new DefaultSemanticEngine();
  }
  return engine;
}

/**
 * Ensure the engine is loaded. Safe for concurrent callers:
 * - First caller kicks off load, subsequent callers await the same promise.
 * - On failure, loadPromise is reset so retry is possible on next call.
 * - Already-awaiting callers receive the rejection and should retry.
 */
export function ensureEngineLoaded(modelPath?: string): Promise<void> {
  if (loadPromise) {
    return loadPromise;
  }

  const eng = getEngine();
  loadPromise = eng.loadModel(modelPath).catch((e) => {
    loadPromise = null; // reset so next call retries
    throw e;
  });

  return loadPromise;
}
