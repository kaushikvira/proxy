import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface RelayPlaneProxyConfigFile {
  routing?: {
    complexity?: {
      enabled?: boolean;
      simple?: string;
      moderate?: string;
      complex?: string;
    };
    cascade?: {
      enabled?: boolean;
      models?: string[];
    };
  };
}

export function getProxyConfig(): RelayPlaneProxyConfigFile {
  const configPath = path.join(os.homedir(), '.kv-local-proxy', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Return empty config if file doesn't exist or is invalid
    return {};
  }
}