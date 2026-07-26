#!/usr/bin/env node
'use strict';
/**
 * MCP stdio server over the notioned workspace. Lets an external agent (Claude
 * Code, etc.) read and write the same directory the Notion loop writes into -
 * this is the "handshake" side of the system.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const workspace = require('../main/workspace');

const server = new McpServer({ name: 'notioned', version: '0.1.0' });

server.tool(
  'workspace_list',
  'List every file the Notion agent loop has produced.',
  {},
  async () => {
    const files = await workspace.list();
    return { content: [{ type: 'text', text: files.join('\n') || '(empty)' }] };
  }
);

server.tool(
  'workspace_read',
  'Read one file from the notioned workspace.',
  { path: z.string().describe('Path relative to workspace/') },
  async ({ path }) => ({
    content: [{ type: 'text', text: await workspace.readFile(path) }],
  })
);

server.tool(
  'workspace_write',
  'Write a file into the notioned workspace.',
  {
    path: z.string().describe('Path relative to workspace/'),
    content: z.string(),
  },
  async ({ path, content }) => {
    const res = await workspace.writeFile(path, content);
    return { content: [{ type: 'text', text: `wrote ${res.rel} (${res.bytes} bytes)` }] };
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
