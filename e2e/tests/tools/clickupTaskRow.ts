// The listing checks look for the fixture task among others, so a needle or
// list ID anywhere in the reply proves little: another task could carry it.
// This narrows the assertion to the task's own row (formatTask in
// src/clickup/formatHelpers.ts: "Task: <name>" then indented fields).

/** Why the fixture row is wrong, or undefined when it is right. */
export function checkFixtureTaskRow(body: string, { taskId, listId, needle }: { taskId: string; listId: string; needle: string }): string | undefined {
  const row = body.split(/\n(?=Task: )/).find((block) => block.includes(`\n  ID: ${taskId}\n`));
  if (!row) return `no task row has ID ${taskId}`;
  const name = row.split('\n', 1)[0];
  if (!name.includes(needle)) return `task ${taskId} is named ${JSON.stringify(name)}, which does not contain ${JSON.stringify(needle)}`;
  if (!row.includes(`(${listId})`)) return `task ${taskId}'s row does not name its home list ${listId}`;
  return undefined;
}
