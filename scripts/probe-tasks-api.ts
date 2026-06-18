// T002 throwaway probe: verify MCP Tasks API surface + taskSupport:'optional' fallback.
// Deleted in T024.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

// Server capabilities for tasks: declare that THIS server supports task creation for tools/call.
// registerToolTask does NOT auto-declare this — it must be in server options.capabilities.
const TASKS_CAP = { tasks: { requests: { tools: { call: {} } } } } as const;

function server() {
  const s = new McpServer(
    { name: "probe", version: "0.0.0" },
    { taskStore: new InMemoryTaskStore(), capabilities: TASKS_CAP }
  );
  s.experimental.tasks.registerToolTask(
    "compute",
    {
      description: "probe tool",
      inputSchema: { n: z.number() },
      execution: { taskSupport: "optional" },
    },
    {
      createTask: async (_args, extra) => {
        const task = await extra.taskStore.createTask({ ttl: 60000 });
        setTimeout(async () => {
          await extra.taskStore.storeTaskResult(
            task.taskId, "completed",
            { content: [{ type: "text", text: "async-result" }] }
          );
        }, 10);
        return { task };
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) => extra.taskStore.getTaskResult(extra.taskId),
    }
  );
  return s;
}

async function main() {
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server().connect(sT);
  // Client must also advertise tasks.requests.tools.call.
  const client = new Client(
    { name: "probe-client", version: "0.0.0" },
    { capabilities: TASKS_CAP }
  );
  await client.connect(cT);

  // CASE A: non-augmented call -> MUST return blocking CallToolResult (FR-008)
  const resA = await client.callTool({ name: "compute", arguments: { n: 1 } });
  const hasTaskA = !!(resA as any).task;
  console.error("[probe] CASE A (no task param): isCallToolResult=", !hasTaskA && !!resA.content, " hasTaskField=", hasTaskA);
  console.error("[probe] CASE A content:", JSON.stringify(resA.content));

  // CASE B: task-augmented call -> MUST return CreateTaskResult
  const resB = await client.request(
    { method: "tools/call", params: { name: "compute", arguments: { n: 2 }, task: { ttl: 60000 } } },
    z.any()
  );
  console.error("[probe] CASE B (task param): hasTaskField=", !!resB.task, " taskId=", resB.task?.taskId, " status=", resB.task?.status);

  let resultOk = false;
  if (resB.task?.taskId) {
    await new Promise((r) => setTimeout(r, 50));
    const result = await client.request(
      { method: "tasks/result", params: { taskId: resB.task.taskId } },
      z.any()
    );
    console.error("[probe] CASE B tasks/result content:", JSON.stringify(result?.content));
    resultOk = JSON.stringify(result?.content)?.includes("async-result");
  }

  const ok = !hasTaskA && !!resA.content && !!resB.task && resultOk;
  console.error(ok ? "\n[probe] PASS — optional falls back to blocking AND supports tasks" : "\n[probe] FAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("[probe] ERROR", e); process.exit(2); });
