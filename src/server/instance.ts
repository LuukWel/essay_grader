// ID of this server process. Cached on globalThis so it survives hot reload; changes on restart.
// The client uses it to detect restarts, and pipeline runs use it to find interrupted runs.

const g = globalThis as unknown as { __ESSAY_GRADER_INSTANCE_ID__?: string };
g.__ESSAY_GRADER_INSTANCE_ID__ ??= `${process.pid}-${Date.now()}`;

export const INSTANCE_ID: string = g.__ESSAY_GRADER_INSTANCE_ID__;
