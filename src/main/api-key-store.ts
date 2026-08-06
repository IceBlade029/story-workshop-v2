import * as path from 'path';
import * as os from 'os';
import { maskApiKey } from '../shared/llm-types';
import type { LLMProvider, ApiKeyEntry } from '../shared/llm-types';
import { saveEncrypted, loadEncrypted, deleteEncrypted } from './credential-store';

const CONFIG_DIR = path.join(os.homedir(), '.story-workshop');

// In-memory cache of loaded keys (never exposed via IPC)
const keyCache: Record<string, string> = {};

export function saveApiKey(provider: LLMProvider, key: string): void {
  // Store encrypted on disk
  const data = JSON.stringify({ provider, key });
  saveEncrypted(data);
  // Also cache in memory for this process
  keyCache[provider] = key;
}

/**
 * Load the FULL API key (main process internal use only).
 * NEVER expose this via IPC — the renderer should use loadApiKeyEntry() instead.
 */
export function loadApiKey(provider: LLMProvider): string | null {
  // Check memory cache first
  if (keyCache[provider]) return keyCache[provider];

  // Load from encrypted store
  const raw = loadEncrypted();
  if (!raw) return null;

  try {
    const data = JSON.parse(raw) as { provider: string; key: string };
    if (data.provider === provider) {
      keyCache[provider] = data.key;
      return data.key;
    }
  } catch { /* corrupt data */ }
  return null;
}

/**
 * Load API key entry for IPC (MASKED only — never returns full key).
 * This is the ONLY function that should be called from IPC handlers.
 */
export function loadApiKeyEntry(provider: LLMProvider): ApiKeyEntry | null {
  const key = loadApiKey(provider);
  if (!key) return null;
  return {
    provider,
    key: '',              // NEVER return full key via IPC
    maskedKey: maskApiKey(key),
    lastUpdated: 'unknown',
  };
}

export function deleteApiKey(provider: LLMProvider): void {
  delete keyCache[provider];
  deleteEncrypted();
}

export function hasApiKey(provider: LLMProvider): boolean {
  return loadApiKey(provider) !== null;
}

export function getConfigPath(): string {
  return CONFIG_DIR;
}
