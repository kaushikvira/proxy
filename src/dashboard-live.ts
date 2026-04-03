/**
 * Live Session Dashboard — serves the session viewer HTML from assets/sessions.html.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

let _cachedHTML: string | null = null;

export function getLiveSessionHTML(): string {
  if (!_cachedHTML) {
    const htmlPath = path.join(__dirname, '..', 'assets', 'sessions.html');
    _cachedHTML = fs.readFileSync(htmlPath, 'utf-8');
  }
  return _cachedHTML;
}

/** Clear cache (for development/hot reload) */
export function clearDashboardCache(): void {
  _cachedHTML = null;
}
