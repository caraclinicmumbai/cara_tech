"use server";

// The personal calendar's writes (lib/calendar/service.ts holds the rules). Every action
// re-reads the session: server functions are reachable by direct POST.
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/authz";
import { logger } from "@/lib/logger";
import { createBlock, createTask, deleteTask, removeBlock, setTaskDone } from "@/lib/calendar/service";

type Result = { ok: boolean; error?: string; info?: string };

async function run(label: string, fn: () => Promise<Result>): Promise<Result> {
  try {
    const res = await fn();
    if (res.ok) revalidatePath("/calendar");
    return res;
  } catch (err) {
    logger.error(`calendar ${label} failed: ${String(err)}`);
    return { ok: false, error: "Something went wrong — please try again" };
  }
}

export async function addTask(input: {
  assigneeId: string;
  title: string;
  notes?: string;
  date: string;
  time?: string;
  repeat?: string;
  repeatUntil?: string;
}): Promise<Result> {
  const user = await requireUser();
  return run("addTask", () => createTask(user, input));
}

export async function tickTask(taskId: string, occurrence: string, done: boolean): Promise<Result> {
  const user = await requireUser();
  return run("tickTask", () => setTaskDone(user, taskId, occurrence, done));
}

export async function removeTask(taskId: string): Promise<Result> {
  const user = await requireUser();
  return run("removeTask", () => deleteTask(user, taskId));
}

export async function blockTime(input: { userId?: string; startAt: string; endAt: string; kind: string; note?: string }): Promise<Result> {
  const user = await requireUser();
  const res = await run("blockTime", () => createBlock(user, input));
  if (res.ok) revalidatePath("/appointments");
  return res;
}

export async function unblockTime(blockId: string): Promise<Result> {
  const user = await requireUser();
  const res = await run("unblockTime", () => removeBlock(user, blockId));
  if (res.ok) revalidatePath("/appointments");
  return res;
}
