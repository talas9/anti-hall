'use strict';
// Preload (node -r) that makes the child report process.platform === 'win32', so
// the Windows no-op branches of the companion scripts run on any CI host.
Object.defineProperty(process, 'platform', { value: 'win32' });
