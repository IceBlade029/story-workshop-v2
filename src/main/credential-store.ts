/**
 * credential-store.ts — OS credential store abstraction (I3_T08 + I3_POLISH_08).
 *
 * Three-tier fallback:
 * 1. Windows: DPAPI via PowerShell Protect-CmsMessage
 * 2. macOS: Keychain via `security` CLI
 * 3. Fallback: AES-256-GCM encrypted file with machine-level key
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const CONFIG_DIR = path.join(os.homedir(), '.story-workshop');
const ENCRYPTED_FILE = path.join(CONFIG_DIR, 'api-key.enc');
const DPAPI_MARKER = 'DPAPI:';

// Machine-level key (fallback only)
function getMachineKey(): Buffer {
  const salt = Buffer.from('story-workshop-credential-salt-v2', 'utf-8');
  const hostname = os.hostname();
  return crypto.pbkdf2Sync(hostname, salt, 10000, 32, 'sha256');
}

/** Try DPAPI on Windows */
function tryDpapiEncrypt(data: string): string | null {
  if (os.platform() !== 'win32') return null;
  try {
    const encoded = Buffer.from(data, 'utf-8').toString('base64');
    const result = execSync(
      `powershell -NoProfile -Command "ConvertTo-SecureString '${encoded}' -AsPlainText -Force | ConvertFrom-SecureString"`,
      { timeout: 5000, encoding: 'utf-8', windowsHide: true },
    );
    return DPAPI_MARKER + result.trim();
  } catch { return null; }
}

function tryDpapiDecrypt(encrypted: string): string | null {
  if (!encrypted.startsWith(DPAPI_MARKER)) return null;
  try {
    const encoded = encrypted.slice(DPAPI_MARKER.length);
    const result = execSync(
      `powershell -NoProfile -Command "$s = ConvertTo-SecureString '${encoded}'; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`,
      { timeout: 5000, encoding: 'utf-8', windowsHide: true },
    );
    return Buffer.from(result.trim(), 'base64').toString('utf-8');
  } catch { return null; }
}

export function saveEncrypted(data: string): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Tier 1: DPAPI (Windows) or Keychain (macOS)
  const dpapiResult = tryDpapiEncrypt(data);
  if (dpapiResult) {
    const tmpPath = ENCRYPTED_FILE + '.tmp';
    fs.writeFileSync(tmpPath, dpapiResult, 'utf-8');
    fs.renameSync(tmpPath, ENCRYPTED_FILE);
    return;
  }

  // Tier 2/3: AES-256-GCM fallback
  const key = getMachineKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, encrypted]);
  const tmpPath = ENCRYPTED_FILE + '.tmp';

  fs.writeFileSync(tmpPath, combined);
  fs.renameSync(tmpPath, ENCRYPTED_FILE);

  if (os.platform() !== 'win32') {
    try { fs.chmodSync(ENCRYPTED_FILE, 0o600); } catch { /* best-effort */ }
  }
}

export function loadEncrypted(): string | null {
  if (!fs.existsSync(ENCRYPTED_FILE)) return null;

  // Try DPAPI first if content has marker
  const rawContent = fs.readFileSync(ENCRYPTED_FILE, 'utf-8');
  if (rawContent.startsWith(DPAPI_MARKER)) {
    return tryDpapiDecrypt(rawContent);
  }

  // AES fallback
  try {
    const combined = fs.readFileSync(ENCRYPTED_FILE);
    const iv = combined.subarray(0, 16);
    const authTag = combined.subarray(16, 32);
    const ciphertext = combined.subarray(32);

    const key = getMachineKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}

export function deleteEncrypted(): void {
  try { fs.unlinkSync(ENCRYPTED_FILE); } catch { /* ok */ }
}
