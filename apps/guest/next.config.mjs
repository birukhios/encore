import path from 'node:path';
import { fileURLToPath } from 'node:url';
const backend = process.env.ENCORE_BACKEND_URL || 'http://127.0.0.1:8080';
const project = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(project, '../../src');
export default {
  outputFileTracingRoot: path.resolve(project, '../..'),
  experimental: { externalDir: true },
  webpack: (config, { webpack }) => {
    config.resolve.alias['@encore'] = source;
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^react(?:-dom)?(?:\/.*)?$/, resource => {
      if (resource.context.startsWith(source)) resource.request = path.join(project, 'node_modules', resource.request);
    }));
    return config;
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/uploads/:path*', destination: `${backend}/uploads/:path*` },
    ];
  },
};
