import { McpServer } from "@modelcontextprotocol/server";

import type { ToolExecutionContext } from "../tools/common.js";
import { runTool } from "../tools/common.js";
import { toolDefinitions } from "../tools/index.js";

export function createMcpServer(ctx: ToolExecutionContext): McpServer {
  const server = new McpServer({
    name: "freshsales-mcp-server",
    version: "1.0.0"
  });

  for (const tool of toolDefinitions) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      async args => {
        const result = await runTool(tool, args, ctx);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result.payload)
            }
          ],
          structuredContent: result.payload,
          isError: result.isError
        };
      }
    );
  }

  return server;
}
