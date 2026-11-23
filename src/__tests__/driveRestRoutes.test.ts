// src/__tests__/driveRestRoutes.test.ts
// Drives every descriptor in DRIVE_WRITE_ROUTES against a stubbed client: what
// reaches Drive, the status, and the answer. A route's success path cannot be
// reached through supertest, because gaxios does not use the global fetch, so
// this is where it is covered; the safeParse branch is in restRoutes.googleWrites.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { DRIVE_WRITE_ROUTES, writeArgs } from '../google-drive/restRoutes.js';
import type { DriveWriteRoute } from '../google-drive/restRoutes.js';
import { REST_CATALOG } from '../restCatalog.js';

function mockClients(files: Record<string, any> = {}, docs: Record<string, any> = {}) {
  return {
    googleDrive: {
      files: {
        get: mock.fn(async () => ({ data: { name: 'Plan', parents: ['old-parent'] } })),
        create: mock.fn(async () => ({ data: { id: 'folder-1', name: 'New', parents: ['p1'], webViewLink: 'l' } })),
        copy: mock.fn(async () => ({ data: { id: 'copy-1', name: 'Copy', webViewLink: 'l' } })),
        update: mock.fn(async () => ({ data: { id: 'file-1', name: 'Plan', trashed: true } })),
        ...files,
      },
      permissions: {
        create: mock.fn(async () => ({ data: { id: 'perm-1', type: 'user', role: 'reader' } })),
      },
    },
    googleDocs: {
      documents: {
        batchUpdate: mock.fn(async () => ({
          data: { replies: [{ replaceAllText: { occurrencesChanged: 3 } }, { replaceAllText: {} }] },
        })),
        ...docs,
      },
    },
  } as any;
}

function routeFor(tool: string): DriveWriteRoute {
  const route = DRIVE_WRITE_ROUTES.find((r) => r.tool === tool);
  assert.ok(route, `no route for ${tool}`);
  return route;
}

async function call(tool: string, params: Record<string, string>, body: unknown, clients = mockClients()) {
  const route = routeFor(tool);
  const parsed = route.schema.parse(writeArgs(route, { params, body }));
  return { ...(await route.run(clients, parsed)), clients };
}

describe('DRIVE_WRITE_ROUTES', () => {
  it('has one catalog entry per descriptor', () => {
    for (const route of DRIVE_WRITE_ROUTES) {
      const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
      const entry = REST_CATALOG.find((e) => e.method === 'POST' && e.path === path);
      assert.ok(entry, `no catalog entry for ${route.path}`);
      assert.equal(entry.mcpToolName, route.tool);
      assert.equal(entry.status, 'live');
    }
  });

  it('takes the file from the URL, not a mismatched body key', () => {
    const route = routeFor('renameFile');
    assert.deepEqual(
      writeArgs(route, { params: { fileId: 'path' }, body: { fileId: 'body', newName: 'N' } }),
      { fileId: 'path', newName: 'N' },
    );
  });

  it('treats a non-object body as empty', () => {
    const route = routeFor('deleteFile');
    assert.deepEqual(writeArgs(route, { params: { fileId: 'f' }, body: ['x'] }), { fileId: 'f' });
    assert.deepEqual(writeArgs(route, { params: { fileId: 'f' } }), { fileId: 'f' });
  });
});

describe('the legacy routes keep their status and keys', () => {
  it('createFolder answers 200 with the folder', async () => {
    const { status, body, clients } = await call('createFolder', {}, { name: 'New', parentFolderId: 'p1' });
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'folder-1', name: 'New', parents: ['p1'], webViewLink: 'l' });
    const req = clients.googleDrive.files.create.mock.calls[0].arguments[0];
    assert.equal(req.requestBody.mimeType, 'application/vnd.google-apps.folder');
    assert.deepEqual(req.requestBody.parents, ['p1']);
  });

  it('copyFile answers 200 with the copy, placed beside the original by default', async () => {
    const { status, body, clients } = await call('copyFile', { fileId: 'file-1' }, {});
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'copy-1', name: 'Copy', webViewLink: 'l' });
    const req = clients.googleDrive.files.copy.mock.calls[0].arguments[0];
    assert.equal(req.fileId, 'file-1');
    assert.deepEqual(req.requestBody, { name: 'Copy of Plan', parents: ['old-parent'] });
  });
});

describe('move', () => {
  it('moves with removeFromAllParents: 200, action moved, old parents removed', async () => {
    const update = mock.fn(async () => ({ data: { id: 'file-1', name: 'Plan', parents: ['dest'] } }));
    const { status, body, clients } = await call(
      'moveFile', { fileId: 'file-1' }, { newParentId: 'dest', removeFromAllParents: true }, mockClients({ update }),
    );
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'file-1', name: 'Plan', parents: ['dest'], action: 'moved' });
    const req = clients.googleDrive.files.update.mock.calls[0].arguments[0];
    assert.equal(req.addParents, 'dest');
    assert.equal(req.removeParents, 'old-parent');
  });

  it('copies by default: 201, action copied, the original untouched', async () => {
    const { status, body, clients } = await call('moveFile', { fileId: 'file-1' }, { newParentId: 'dest' });
    assert.equal(status, 201);
    assert.equal((body as any).action, 'copied');
    assert.equal(clients.googleDrive.files.update.mock.callCount(), 0);
    assert.deepEqual(clients.googleDrive.files.copy.mock.calls[0].arguments[0].requestBody, { parents: ['dest'] });
  });
});

describe('rename', () => {
  it('sends only the new name and answers 200 with the file', async () => {
    const update = mock.fn(async () => ({ data: { id: 'file-1', name: 'Renamed', webViewLink: 'l' } }));
    const { status, body, clients } = await call('renameFile', { fileId: 'file-1' }, { newName: 'Renamed' }, mockClients({ update }));
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'file-1', name: 'Renamed', webViewLink: 'l' });
    assert.deepEqual(clients.googleDrive.files.update.mock.calls[0].arguments[0].requestBody, { name: 'Renamed' });
  });
});

describe('trash', () => {
  it('trashes, never deletes, and reports what Drive confirmed', async () => {
    const { status, body, clients } = await call('deleteFile', { fileId: 'file-1' }, {});
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'file-1', name: 'Plan', trashed: true });
    const req = clients.googleDrive.files.update.mock.calls[0].arguments[0];
    assert.deepEqual(req.requestBody, { trashed: true });
    assert.match(req.fields, /trashed/);
  });

  it('answers 502, not success, when Drive does not report the file trashed', async () => {
    const update = mock.fn(async () => ({ data: { id: 'file-1', name: 'Plan', trashed: false } }));
    const { status, body } = await call('deleteFile', { fileId: 'file-1' }, {}, mockClients({ update }));
    assert.equal(status, 502);
    assert.match((body as any).error, /not in the trash/);
  });

  it('refuses skipTrash rather than dropping it', () => {
    const route = routeFor('deleteFile');
    const parsed = route.schema.safeParse(writeArgs(route, { params: { fileId: 'f' }, body: { skipTrash: true } }));
    assert.equal(parsed.success, false);
    assert.ok((parsed as any).error.flatten().fieldErrors.skipTrash);
    assert.equal(route.schema.safeParse({ fileId: 'f', skipTrash: false }).success, true);
  });
});

describe('createFromTemplate', () => {
  it('answers 201 with the document and each placeholder count', async () => {
    const { status, body, clients } = await call(
      'createFromTemplate', { templateId: 'tpl' }, { newTitle: 'Offer', replacements: { '{{NAME}}': 'Ada', '{{GONE}}': 'x' } },
    );
    assert.equal(status, 201);
    assert.deepEqual(body, {
      id: 'copy-1', name: 'Copy', webViewLink: 'l',
      replacements: { applied: true, occurrencesChanged: { '{{NAME}}': 3, '{{GONE}}': 0 } },
    });
    assert.equal(clients.googleDrive.files.copy.mock.calls[0].arguments[0].fileId, 'tpl');
    const requests = clients.googleDocs.documents.batchUpdate.mock.calls[0].arguments[0].requestBody.requests;
    assert.deepEqual(requests[0], { replaceAllText: { containsText: { text: '{{NAME}}', matchCase: false }, replaceText: 'Ada' } });
  });

  it('reports replacements null and skips Docs when none were sent', async () => {
    const { body, clients } = await call('createFromTemplate', { templateId: 'tpl' }, { newTitle: 'Offer' });
    assert.equal((body as any).replacements, null);
    assert.equal(clients.googleDocs.documents.batchUpdate.mock.callCount(), 0);
  });

  it('still answers 201 when the replacements fail, saying so', async () => {
    const batchUpdate = mock.fn(async () => { throw new Error('Docs said no'); });
    const { status, body } = await call(
      'createFromTemplate', { templateId: 'tpl' }, { newTitle: 'Offer', replacements: { a: 'b' } }, mockClients({}, { batchUpdate }),
    );
    assert.equal(status, 201);
    assert.deepEqual((body as any).replacements, { applied: false, error: 'Docs said no' });
  });
});

describe('share', () => {
  it('creates the permission, emails by default, and answers 201', async () => {
    const { status, body, clients } = await call(
      'shareDriveFile', { fileId: 'file-1' }, { role: 'reader', type: 'user', emailAddress: 'a@b.c' },
    );
    assert.equal(status, 201);
    assert.deepEqual(body, { permission: { id: 'perm-1', type: 'user', role: 'reader' }, file: { name: 'Plan', parents: ['old-parent'] } });
    const req = clients.googleDrive.permissions.create.mock.calls[0].arguments[0];
    assert.equal(req.fileId, 'file-1');
    assert.deepEqual(req.requestBody, { role: 'reader', type: 'user', emailAddress: 'a@b.c' });
    assert.equal(req.sendNotificationEmail, true);
  });

  it('sends no notification flag for a public link', async () => {
    const { clients } = await call('shareDriveFile', { fileId: 'file-1' }, { role: 'reader', type: 'anyone' });
    const req = clients.googleDrive.permissions.create.mock.calls[0].arguments[0];
    assert.equal('sendNotificationEmail' in req, false);
  });

  it('refuses a user share with no emailAddress before reaching Drive', () => {
    const route = routeFor('shareDriveFile');
    const parsed = route.schema.safeParse(writeArgs(route, { params: { fileId: 'f' }, body: { role: 'reader', type: 'user' } }));
    assert.equal(parsed.success, false);
    assert.ok((parsed as any).error.flatten().fieldErrors.emailAddress);
  });
});

describe('Drive errors keep their status for the route to map', () => {
  it('lets a Drive 404 through untouched', async () => {
    const err: any = Object.assign(new Error('File not found'), { code: 404 });
    const get = mock.fn(async () => { throw err; });
    await assert.rejects(call('copyFile', { fileId: 'nope' }, {}, mockClients({ get })), (e: any) => e.code === 404);
  });
});
