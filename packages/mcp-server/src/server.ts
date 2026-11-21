import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { createProjectTools } from './tools.js';

export function createOpenDirectorMcpServer(projectDir: string): Server {
  const root = resolve(projectDir);
  const tools = createProjectTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: 'open-director', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool "${req.params.name}"` }],
      };
    }
    try {
      const result = await tool.run((req.params.arguments ?? {}) as Record<string, unknown>, root);
      return {
        isError: result.isError,
        content: result.content.map((c) =>
          c.type === 'image'
            ? { type: 'image' as const, data: c.data ?? '', mimeType: c.mimeType ?? 'image/png' }
            : { type: 'text' as const, text: c.text ?? '' },
        ),
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: (err as Error).message }],
      };
    }
  });

  return server;
}

export async function runMcpStdioServer(projectDir: string): Promise<void> {
  const server = createOpenDirectorMcpServer(projectDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
