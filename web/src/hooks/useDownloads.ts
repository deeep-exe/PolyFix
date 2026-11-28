import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelDownloadTask,
  getDownloadTasks,
  installExtension,
  type ExtensionDownloadTask,
} from "../api/client";

export function useDownloads(onCompleted?: (task: ExtensionDownloadTask) => void) {
  const [downloadTasks, setDownloadTasks] = useState<ExtensionDownloadTask[]>([]);
  const [error, setError] = useState("");
  const completedRef = useRef(new Set<string>());
  const timeoutRef = useRef<number | undefined>(undefined);
  const unmountedRef = useRef(false);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  const poll = useCallback(async () => {
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
    try {
      const tasks = await getDownloadTasks();
      if (unmountedRef.current) return null;
      setDownloadTasks(tasks);
      tasks.forEach((task) => {
        if (task.status === "completed" && !completedRef.current.has(task.task_id)) {
          completedRef.current.add(task.task_id);
          onCompletedRef.current?.(task);
        }
      });
      setError("");
      if (tasks.some((task) => task.status === "downloading")) {
        timeoutRef.current = window.setTimeout(() => {
          void poll();
        }, 1500);
      }
      return tasks;
    } catch (e) {
      if (!unmountedRef.current) {
        setError(e instanceof Error ? e.message : "Could not read download tasks.");
      }
      return null;
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    void poll();
    return () => {
      unmountedRef.current = true;
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    };
  }, [poll]);

  const startInstall = useCallback(async (url: string) => {
    setError("");
    try {
      const result = await installExtension(url);
      await poll();
      return result.task_id;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not start the download.";
      setError(message);
      throw e;
    }
  }, [poll]);

  const cancelInstall = useCallback(async (taskId: string) => {
    await cancelDownloadTask(taskId);
    await poll();
  }, [poll]);

  return {
    downloadTasks,
    isDownloading: downloadTasks.some((task) => task.status === "downloading"),
    error,
    startInstall,
    cancelInstall,
    refreshDownloads: poll,
  };
}
