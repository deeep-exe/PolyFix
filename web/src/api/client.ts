const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
export async function createRun(file: File) {
const form = new FormData();
form.append("image", file); // "image" must match the parameter name in FastAPI
const res = await fetch(`${BASE}/runs`, { method: "POST", body: form });
if (!res.ok) throw new Error(await res.text());
return res.json() as Promise<{ id: string; status: string }>;
}
export const getRun = (id: string) =>
fetch(`${BASE}/runs/${id}`).then((r) => r.json());
export const cancelRun = (id: string) =>
fetch(`${BASE}/runs/${id}`, { method: "DELETE" });
export const resultUrl = (id: string) => `${BASE}/runs/${id}/result`;