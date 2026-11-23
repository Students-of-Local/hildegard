// SPDX-License-Identifier: AGPL-3.0-only
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Hildegard's MCP server on stdio. stdout carries the protocol; anything for people goes to stderr.
 * skills: a folder to serve with list_skills and read_skill instead of Hildegard's own (`hildegard mcp --skills`).
 */
export async function runStdio(defaultUrl: string, skills?: string) {
  const server = createMcpServer(
    new HildegardClient(process.env.HILDEGARD_URL ?? defaultUrl),
    skills === undefined ? {} : { skillsDir: skills },
  );
  await server.connect(new StdioServerTransport());
  console.error('Hildegard MCP server ready on stdio.');
}
