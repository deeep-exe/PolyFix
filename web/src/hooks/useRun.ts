import { useCallback, useEffect, useRef, useState } from "react";
import { cancelRun, createRun, getRunStatus, type ParameterValue } from "../api/client";

export type RunStatus = "idle" | "starting" | "processing" | "completed" | "failed";
export type Run = {
  id: string;
  status: RunStatus;
  progress: number;
  error?: string | null;
};
const DEFAULT_RUN_ERROR = "Generation could not be completed. Check your settings and try again.";

function friendlyRunError(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message || /^(failed to fetch|networkerror|internal server error|http \d+|bad gateway|service unavailable)$/i.test(message)) {
    return error instanceof TypeError
      ? "Could not reach the backend. Check your connection and try again."
      : DEFAULT_RUN_ERROR;
  }
  return message;
}

export function useRun() {
  const [run, setRun] = useState<Run | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const runToken = useRef(0);
  const [startError, setStartError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const clearRun = useCallback(() => {
    runToken.current += 1;
    window.clearInterval(timer.current);
    timer.current = undefined;
    setRun({ id: "", status: "idle", progress: 0 });
    setStartError(null);
    setIsStarting(false);
  }, []);

  const normalizeStatus = (status: string): RunStatus => {
    if (status === "done" || status === "completed") return "completed";
    if (status === "failed" || status === "cancelled") return "failed";
    if (status === "running" || status === "processing") return "processing";
    return "starting";
  };

  const startRun = async (extensionId: string, imageFile: File, params: Record<string, ParameterValue>) => {
    window.clearInterval(timer.current);
    timer.current = undefined;
    const token = ++runToken.current;
    setRun({ id: "", status: "starting", progress: 0 });
    setStartError(null);
    setIsStarting(true);

    try {
      const created = await createRun(extensionId, imageFile, params);
      if (token !== runToken.current) return;

      setRun({
        id: created.id,
        status: "starting",
        progress: 0,
      });

      timer.current = window.setInterval(async () => {
        try {
          const latest = await getRunStatus(created.id);
          if (token !== runToken.current) return;
          const status = normalizeStatus(latest.status);
          setRun({
            id: latest.id || created.id,
            status,
            progress: Math.max(0, Math.min(100, Number(latest.progress) || 0)),
            error: latest.error,
          });

          if (status === "completed" || status === "failed") {
            window.clearInterval(timer.current);
            timer.current = undefined;
          }
        } catch (error) {
          if (token !== runToken.current) return;
          window.clearInterval(timer.current);
          timer.current = undefined;
          setRun((current) => current ? {
            ...current,
            status: "failed",
            error: friendlyRunError(error),
          } : null);
        }
      }, 1500);
    } catch (error) {
      if (token === runToken.current) {
        const message = friendlyRunError(error);
        setStartError(message || DEFAULT_RUN_ERROR);
        setRun({ id: "", status: "failed", progress: 0, error: message || DEFAULT_RUN_ERROR });
      }
    } finally {
      if (token === runToken.current) setIsStarting(false);
    }
  };

  const stop = async () => {
    if (!run?.id) return;
    const token = ++runToken.current;
    window.clearInterval(timer.current);
    timer.current = undefined;
    setRun((current) => current ? { ...current, status: "idle", progress: 0, error: null } : current);
    await cancelRun(run.id).catch(() => undefined);
    if (token !== runToken.current) return;
  };

  useEffect(() => () => {
    runToken.current += 1;
    window.clearInterval(timer.current);
  }, []);

  return { run, startRun, start: startRun, stop, clearRun, startError, isStarting };
}
