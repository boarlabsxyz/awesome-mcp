import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  taskUpdateFields, listUpdateFields, createDocFields,
  createPageFields, editPageFields, insertImageFields,
} from '../clickup/restWrites.js';
import {
  createDocumentFields, updateDocumentFields, moveDocumentFields,
  createCollectionFields, updateCollectionFields, addCommentFields,
} from '../outline/restOps.js';
import {
  navigateFields, actFields, observeFields, extractFields,
} from '../browserbase/schemas.js';

// The REST write plane and the MCP tools must not drift on what is valid. The
// mechanism is that each write's camelCase fields are declared ONCE, in
// restWrites.ts / restOps.ts, and both surfaces compose that one object. These
// tests guard the two ways that mechanism can silently rot:
//
//   1. someone re-adds a field to the tool's inline z.object instead of the
//      shared group, so the REST route quietly stops accepting it; or
//   2. the extraction loses a `.describe()`, which is what the LLM reads — an
//      invisible regression, since nothing fails.

/** Field groups, with the exact keys each is expected to carry. */
const GROUPS: Record<string, [Record<string, z.ZodTypeAny>, string[]]> = {
  taskUpdateFields: [taskUpdateFields as any, [
    'name', 'description', 'markdownContent', 'status', 'priority', 'dueDate', 'startDate',
    'addAssignees', 'removeAssignees', 'timeEstimate', 'archived', 'taskTypeId', 'parentTaskId',
  ]],
  listUpdateFields: [listUpdateFields as any, ['name', 'content', 'dueDate', 'priority']],
  createDocFields: [createDocFields as any, ['name', 'content', 'parentId', 'parentType']],
  createPageFields: [createPageFields as any, ['name', 'content', 'parentPageId']],
  editPageFields: [editPageFields as any, ['name', 'content', 'editMode']],
  insertImageFields: [insertImageFields as any, [
    'imageUrl', 'imageBase64', 'fileName', 'altText', 'editMode', 'skipRehost',
  ]],
  createDocumentFields: [createDocumentFields as any, [
    'title', 'collectionId', 'text', 'parentDocumentId', 'publish', 'template', 'icon',
  ]],
  updateDocumentFields: [updateDocumentFields as any, ['title', 'text', 'append', 'template', 'icon']],
  moveDocumentFields: [moveDocumentFields as any, ['collectionId', 'parentDocumentId']],
  createCollectionFields: [createCollectionFields as any, ['name', 'description', 'color']],
  updateCollectionFields: [updateCollectionFields as any, ['name', 'description', 'color']],
  addCommentFields: [addCommentFields as any, ['text', 'parentCommentId']],
  // Browserbase. These groups deliberately do NOT include sessionId: the MCP
  // tool takes it as a parameter and the REST route reads it from the path, so
  // a sessionId appearing here would let a URL and a body disagree about which
  // browser to drive. actFields has no REST sibling at all (act is MCP-only by
  // design) but is declared the same way so the four read alike.
  navigateFields: [navigateFields as any, ['url']],
  actFields: [actFields as any, ['action']],
  observeFields: [observeFields as any, ['instruction']],
  extractFields: [extractFields as any, ['instruction']],
};

/** A Zod description, looking through optional/default/nullable wrappers. */
function describeOf(schema: z.ZodTypeAny): string | undefined {
  let cur: any = schema;
  for (let depth = 0; cur && depth < 8; depth += 1) {
    if (cur._def?.description) return cur._def.description;
    cur = cur._def?.innerType ?? cur._def?.schema ?? cur._def?.type;
  }
  return undefined;
}

describe('REST write schema sharing', () => {
  for (const [label, [group, expected]] of Object.entries(GROUPS)) {
    it(`${label} carries exactly its documented fields`, () => {
      assert.deepEqual(Object.keys(group).sort(), [...expected].sort());
    });

    it(`${label} keeps a description on every field`, () => {
      // Descriptions are the LLM-facing half of a tool parameter. Losing one
      // during a refactor changes nothing observable in a test that only checks
      // shapes, which is why this assertion exists separately.
      const undescribed = Object.keys(group).filter((k) => !describeOf(group[k]));
      assert.deepEqual(undescribed, [], `fields with no .describe(): ${undescribed.join(', ')}`);
    });
  }

  it('composes into a tool schema that still validates a realistic body', () => {
    // Spreading a field group into z.object must behave exactly like declaring
    // the fields inline — this is the one runtime property the whole mechanism
    // rests on.
    const toolSchema = z.object({ taskId: z.string(), ...taskUpdateFields });
    const parsed = toolSchema.safeParse({
      taskId: 't1', name: 'N', priority: null, addAssignees: [1], taskTypeId: 0,
    });
    assert.equal(parsed.success, true);
    assert.equal(toolSchema.safeParse({ taskId: 't1', priority: 9 }).success, false);
    // taskId is the tool's own parameter, not part of the shared body group.
    assert.equal(Object.keys(taskUpdateFields).includes('taskId'), false);
  });

  it('keeps each route own path params out of its shared body group', () => {
    // A group that also declared the id its route takes from the path would let a
    // caller contradict the URL. The check is PER ROUTE, not against a global list
    // of id-shaped names: collectionId is a path param for the collection update
    // but a legitimate body field for document create and move, where the
    // collection is the destination rather than the addressed resource.
    const PATH_PARAMS: Record<string, string[]> = {
      taskUpdateFields: ['taskId'],
      listUpdateFields: ['listId'],
      createDocFields: ['workspaceId'],
      createPageFields: ['workspaceId', 'docId'],
      editPageFields: ['workspaceId', 'docId', 'pageId'],
      insertImageFields: ['workspaceId', 'docId', 'pageId'],
      createDocumentFields: [],
      updateDocumentFields: ['documentId'],
      moveDocumentFields: ['documentId'],
      createCollectionFields: [],
      updateCollectionFields: ['collectionId'],
      addCommentFields: ['documentId'],
      // Browserbase addresses a browser by sessionId in the path. A body field
      // of the same name would let a URL and a body name different browsers —
      // and on this connector that is not a cosmetic conflict: the whole
      // session contract is that the id identifies which browser to drive.
      // actFields has no REST route, but the id is a path param on the MCP side
      // all the same, so the same rule applies.
      navigateFields: ['sessionId'],
      actFields: ['sessionId'],
      observeFields: ['sessionId'],
      extractFields: ['sessionId'],
    };
    assert.deepEqual(
      Object.keys(PATH_PARAMS).sort(), Object.keys(GROUPS).sort(),
      'every field group needs its route path params listed here',
    );
    for (const [label, [group]] of Object.entries(GROUPS)) {
      const leaked = Object.keys(group).filter((k) => PATH_PARAMS[label].includes(k));
      assert.deepEqual(leaked, [], `${label} must not declare its own path params: ${leaked.join(', ')}`);
    }
  });
});
