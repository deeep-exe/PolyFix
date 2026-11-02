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
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  const poll = useCallback(async () => {
    try {
      const tasks = await getDownloadTasks();
      setDownloadTasks(tasks);
      tasks.forEach((task) => {
        if (task.status === "completed" && !completedRef.current.has(task.task_id)) {
          completedRef.current.add(task.task_id);
          onCompletedRef.current?.(task);
        }
      });
      setError("");
      return tasks;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read download tasks.");
      return null;
    }
  }, []);

  useEffect(() => {
    let unmounted = false;

    const check = async () => {
      const tasks = await poll();
      if (unmounted) return;

      if (tasks?.some((task) => task.status === "downloading")) {
        timeoutRef.current = window.setTimeout(() => {
          void check();
        }, 2000);
      } else {
        timeoutRef.current = undefined;
      }
    };

    void check();
    return () => {
      unmounted = true;
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    };
  }, []);

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
  };
}
