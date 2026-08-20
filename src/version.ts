import packageJson from '../package.json' with { type: 'json' };

/** Public package version advertised by the CLI and MCP server. */
export const APHRODITE_VERSION = packageJson.version;
