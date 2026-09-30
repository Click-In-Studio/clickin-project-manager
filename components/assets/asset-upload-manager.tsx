"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import type { MountType } from "@/lib/node/mount";
import type { UploadResult } from "@/lib/asset/upload-types";

export type UploadTaskStatus =
  | "queued"
  | "uploading"
  | "processing"
  | "binding"
  | "complete"
  | "failed"
  | "cancelled";

export type UploadTaskTarget =
  | { kind: "asset" }
  | {
      kind: "mount";
      mountType: MountType;
      mountId: string;
      mountAuxId?: string | null;
      label: string;
    }
  | { kind: "expense"; expenseId: string; documentKind: "invoice" | "receipt" | "other" };

export type UploadTask = {
  id: string;
  productionId: string;
  fileName: string;
  target: UploadTaskTarget;
  status: UploadTaskStatus;
  progress: number | null;
  transferMode: "direct" | "relay";
  result: UploadResult | null;
  error: string | null;
  updatedAt: number;
};

export type UploadTaskControl = {
  signal: AbortSignal;
  setProgress: (progress: number | null) => void;
  setTransferMode: (mode: "direct" | "relay") => void;
  setProcessing: () => void;
};

export type UploadTaskExecutor = (control: UploadTaskControl) => Promise<UploadResult>;

export type UploadOutcome =
  | { ok: true; result: UploadResult }
  | { ok: false; error: string; cancelled: boolean };

type Runtime = {
  controller: AbortController;
  executor: UploadTaskExecutor;
  outcome: Promise<UploadOutcome>;
  resolve: (outcome: UploadOutcome) => void;
};

type StartTask = (input: {
  productionId: string;
  fileName: string;
  target?: UploadTaskTarget;
  executor: UploadTaskExecutor;
}) => { id: string; outcome: Promise<UploadOutcome> };

type UploadManager = {
  tasks: UploadTask[];
  startTask: StartTask;
  cancelTask: (id: string) => void;
  retryTask: (id: string) => void;
  dismissTask: (id: string) => void;
};

const UploadManagerContext = createContext<UploadManager | null>(null);

function taskId(): string {
  return `upload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error ?? fallback;
}

async function bindResult(task: UploadTask, result: UploadResult, signal: AbortSignal): Promise<void> {
  if (task.target.kind === "asset") return;
  if (task.target.kind === "mount") {
    const response = await fetch(
      `${BASE_PATH}/api/production/${task.productionId}/assets/${result.assetId}/mounts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mountType: task.target.mountType,
          mountId: task.target.mountId,
          mountAuxId: task.target.mountAuxId ?? null,
        }),
        signal,
      },
    );
    if (!response.ok) throw new Error(await responseError(response, "文件已上传，但挂载失败"));
    return;
  }

  const response = await fetch(
    `${BASE_PATH}/api/production/${task.productionId}/finance/expenses/${task.target.expenseId}/documents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetFileId: result.fileId, kind: task.target.documentKind }),
      signal,
    },
  );
  if (!response.ok) throw new Error(await responseError(response, "凭证已上传，但关联报销失败"));
}

function active(status: UploadTaskStatus): boolean {
  return status === "queued" || status === "uploading" || status === "processing" || status === "binding";
}

export function AssetUploadManagerProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const tasksRef = useRef(tasks);
  const runtimes = useRef(new Map<string, Runtime>());
  tasksRef.current = tasks;

  const patchTask = useCallback((id: string, patch: Partial<UploadTask>) => {
    setTasks(current => current.map(task => task.id === id
      ? { ...task, ...patch, updatedAt: Date.now() }
      : task));
  }, []);

  const execute = useCallback(async (id: string, bindingOnly = false) => {
    const runtime = runtimes.current.get(id);
    const task = tasksRef.current.find(item => item.id === id);
    if (!runtime || !task) return;

    runtime.controller = new AbortController();
    patchTask(id, {
      status: bindingOnly ? "binding" : "uploading",
      error: null,
      progress: bindingOnly ? 100 : 0,
    });

    try {
      const result = bindingOnly && task.result
        ? task.result
        : await runtime.executor({
            signal: runtime.controller.signal,
            setProgress: progress => patchTask(id, { progress, status: "uploading" }),
            setTransferMode: transferMode => patchTask(id, { transferMode }),
            setProcessing: () => patchTask(id, { status: "processing", progress: 100 }),
          });

      patchTask(id, { result, status: task.target.kind === "asset" ? "processing" : "binding", progress: 100 });
      const current = { ...task, result };
      await bindResult(current, result, runtime.controller.signal);
      patchTask(id, { result, status: "complete", progress: 100, error: null });
      runtime.resolve({ ok: true, result });
      router.refresh();
      window.dispatchEvent(new CustomEvent("asset-upload-complete", {
        detail: { taskId: id, productionId: task.productionId, result },
      }));
      window.setTimeout(() => {
        setTasks(items => items.filter(item => item.id !== id || item.status !== "complete"));
        runtimes.current.delete(id);
      }, 6000);
    } catch (error) {
      const cancelled = runtime.controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      const message = cancelled ? "已取消上传" : error instanceof Error ? error.message : String(error);
      patchTask(id, { status: cancelled ? "cancelled" : "failed", error: message });
      runtime.resolve({ ok: false, error: message, cancelled });
    }
  }, [patchTask, router]);

  const startTask = useCallback<StartTask>(({ productionId, fileName, target = { kind: "asset" }, executor }) => {
    const id = taskId();
    let resolve!: Runtime["resolve"];
    const outcome = new Promise<UploadOutcome>(done => { resolve = done; });
    const controller = new AbortController();
    runtimes.current.set(id, { controller, executor, outcome, resolve });
    const task: UploadTask = {
      id, productionId, fileName, target,
      status: "queued", progress: 0, transferMode: "direct",
      result: null, error: null, updatedAt: Date.now(),
    };
    tasksRef.current = [...tasksRef.current, task];
    setTasks(current => [...current, task]);
    queueMicrotask(() => void execute(id));
    return { id, outcome };
  }, [execute]);

  const cancelTask = useCallback((id: string) => {
    runtimes.current.get(id)?.controller.abort();
  }, []);

  const retryTask = useCallback((id: string) => {
    const task = tasksRef.current.find(item => item.id === id);
    if (!task || task.status !== "failed") return;
    void execute(id, !!task.result);
  }, [execute]);

  const dismissTask = useCallback((id: string) => {
    const task = tasksRef.current.find(item => item.id === id);
    if (!task) return;
    if (active(task.status)) runtimes.current.get(id)?.controller.abort();
    if ((task.status === "failed" || task.status === "cancelled")
        && task.target.kind === "expense" && task.result) {
      void fetch(
        `${BASE_PATH}/api/production/${task.productionId}/finance/expense-documents/${task.result.assetId}`,
        { method: "DELETE" },
      ).catch(() => {});
    }
    setTasks(current => current.filter(item => item.id !== id));
    runtimes.current.delete(id);
  }, []);

  useEffect(() => {
    if (!tasks.some(task => active(task.status))) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [tasks]);

  const value = useMemo<UploadManager>(() => ({
    tasks, startTask, cancelTask, retryTask, dismissTask,
  }), [cancelTask, dismissTask, retryTask, startTask, tasks]);

  return (
    <UploadManagerContext.Provider value={value}>
      {children}
      <UploadTray />
    </UploadManagerContext.Provider>
  );
}

export function useAssetUploadManager(): UploadManager | null {
  return useContext(UploadManagerContext);
}

function statusLabel(task: UploadTask): string {
  if (task.status === "queued") return "等待上传";
  if (task.status === "uploading") return task.transferMode === "relay" ? "服务器中转中" : "上传中";
  if (task.status === "processing") return "处理中";
  if (task.status === "binding") return task.target.kind === "mount" ? "正在挂载" : "正在关联";
  if (task.status === "complete") return "已完成";
  if (task.status === "cancelled") return "已取消";
  return "失败";
}

function UploadTray() {
  const manager = useContext(UploadManagerContext);
  const [expanded, setExpanded] = useState(true);
  if (!manager || manager.tasks.length === 0) return null;
  const activeCount = manager.tasks.filter(task => active(task.status)).length;

  return (
    <section className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-3 z-[80] w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl lg:bottom-4 lg:right-4"
      aria-label="上传任务">
      <button type="button" onClick={() => setExpanded(value => !value)}
        className="flex w-full items-center justify-between gap-3 bg-zinc-800 px-3 py-2 text-left text-xs font-medium text-white">
        <span>{activeCount > 0 ? `正在处理 ${activeCount} 个文件` : "上传任务"}</span>
        <span aria-hidden>{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="max-h-72 overflow-y-auto p-2">
          {manager.tasks.map(task => (
            <div key={task.id} className="mb-1.5 rounded-lg bg-zinc-50 px-2.5 py-2 last:mb-0">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-zinc-700" title={task.fileName}>{task.fileName}</p>
                  <p className={`mt-0.5 text-[10px] ${task.status === "failed" ? "text-red-600" : "text-zinc-400"}`}>
                    {task.error ?? statusLabel(task)}
                  </p>
                </div>
                {task.status === "failed" && (
                  <button type="button" onClick={() => manager.retryTask(task.id)} className="text-[10px] text-zinc-600">重试</button>
                )}
                {active(task.status) ? (
                  <button type="button" onClick={() => manager.cancelTask(task.id)} className="text-[10px] text-zinc-400">取消</button>
                ) : (
                  <button type="button" onClick={() => manager.dismissTask(task.id)} aria-label={`移除${task.fileName}`}
                    className="text-xs text-zinc-400">×</button>
                )}
              </div>
              {active(task.status) && task.progress !== null && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200">
                  <div className="h-full rounded-full bg-zinc-700 transition-[width] duration-150"
                    style={{ width: `${task.progress}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
