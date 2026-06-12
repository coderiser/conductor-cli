import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.conductor.workbench',
  productName: 'Conductor',
  directories: {
    output: 'release',
    buildResources: 'build'
  },
  files: [
    'dist/**/*',
    'out/**/*',
    'agents.json'
  ],
  // node-pty is used by the daemon (separate Node.js process), not Electron.
  // Skip electron-builder's native rebuild — it would try to compile node-pty
  // against Electron's Node headers, which fails with MSBuild errors.
  npmRebuild: false,
  win: {
    target: ['nsis', 'portable'],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  }
};

export default config;
