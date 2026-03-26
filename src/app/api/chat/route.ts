import type { FileNode } from "@/lib/file-system";
import { VirtualFileSystem } from "@/lib/file-system";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { buildStrReplaceTool } from "@/lib/tools/str-replace";
import { buildFileManagerTool } from "@/lib/tools/file-manager";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { getLanguageModel } from "@/lib/provider";
import { generationPrompt } from "@/lib/prompts/generation";

export async function POST(req: Request) {
  try {
  const body = await req.json();
  console.log("[/api/chat] received body keys:", Object.keys(body));
  console.log("[/api/chat] messages count:", body.messages?.length);
  console.log("[/api/chat] first message:", JSON.stringify(body.messages?.[0]));
  const {
    messages,
    files,
    projectId,
  }: { messages: any[]; files: Record<string, FileNode>; projectId?: string } = body;

  // Reconstruct the VirtualFileSystem from serialized data
  const fileSystem = new VirtualFileSystem();
  fileSystem.deserializeFromNodes(files);

  // Convert UIMessages (sent by client) to ModelMessages (expected by streamText)
  const modelMessages = await convertToModelMessages(messages);
  console.log("[/api/chat] converted messages count:", modelMessages.length);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getLanguageModel() as any;
  // Use fewer steps for mock provider to prevent repetition
  const isMockProvider = !process.env.ANTHROPIC_API_KEY;
  const result = streamText({
    model,
    system: generationPrompt,
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
    messages: modelMessages,
    maxOutputTokens: 10_000,
    stopWhen: stepCountIs(isMockProvider ? 4 : 40),
    onError: (err: any) => {
      console.error(err);
    },
    tools: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      str_replace_editor: buildStrReplaceTool(fileSystem) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      file_manager: buildFileManagerTool(fileSystem) as any,
    },
    onFinish: async () => {
      // Save file system state to project if authenticated
      if (projectId) {
        try {
          const session = await getSession();
          if (!session) return;

          await prisma.project.update({
            where: { id: projectId, userId: session.userId },
            data: { data: JSON.stringify(fileSystem.serialize()) },
          });
        } catch (error) {
          console.error("Failed to save project data:", error);
        }
      }
    },
  });

  return result.toUIMessageStreamResponse();
  } catch (err: any) {
    console.error("[/api/chat] CAUGHT ERROR:", err);
    return new Response(err?.message ?? String(err), { status: 500 });
  }
}

export const maxDuration = 120;
