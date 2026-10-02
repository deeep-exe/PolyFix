import { useEffect, useRef, useState } from "react";
import { createRun, getRun } from "../api/client";

const FINISHED = ["done", "failed", "cancelled"];

export function useRun() {
  const [run, setRun] = useState<any>(null);
  const timer = useRef<number | undefined>(undefined);

  const start = async (file: File) => {
    const { id } = await createRun(file);
    setRun({ id, status: "queued", progress: 0 });

    timer.current = window.setInterval(async () => {
      const latest = await getRun(id);
      setRun(latest);

      if (FINISHED.includes(latest.status)) {
        window.clearInterval(timer.current); // stop asking once finished
      }
    }, 1000);
  };

  // cleanup: stop the timer if the page is closed
  useEffect(() => () => window.clearInterval(timer.current), []);

  return { run, start };
}